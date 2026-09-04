import {
	CrmEntitlementStatus,
	Prisma,
	type CrmEntitlement
} from '@prisma/billing-client';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ActivateCrmTrialCommandDto } from '../http/billing.dto';
import {
	BILLING_EVENTS_EXCHANGE,
	BILLING_EVENT_TYPES
} from '../messaging/billing-messaging.constants';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import {
	assertBillingCommandReceipt,
	billingCommandRequestHash,
	lockBillingCommand
} from './billing-command-idempotency';
import { requireCrmCommercialPolicy } from './crm-commercial-policy.service';

const CRM_PRODUCT_CODE = 'WINCRM';
const CRM_TRIAL_PLAN_CODE = 'TRIAL';
const CRM_TRIAL_PROVISIONING_COMMAND_TYPE = 'ACTIVATE_WINCRM_TRIAL';
const DAY_MS = 24 * 60 * 60 * 1000;

type EffectiveCrmEntitlementStatus =
	| CrmEntitlementStatus
	| 'NOT_ACTIVATED';

export interface CrmEntitlementResponse {
	schemaVersion: 1;
	productCode: string;
	status: EffectiveCrmEntitlementStatus;
	entitlement: {
		id: string;
		workspaceId: string;
		planCode: string;
		seatLimit: number | null;
		policyVersion: number | null;
		graceUntil: string | null;
		trialStartedAt: string | null;
		effectiveFrom: string;
		effectiveUntil: string;
		provisioningCommandId: string;
		provisioningCommandType: string;
		activatedByUserId: string;
		aggregateVersion: string;
		sourceSequence: string;
	} | null;
}

export type CrmTrialActivationResponse = CrmEntitlementResponse & {
	activated: boolean;
};

@Injectable()
export class CrmEntitlementService {
	constructor(private readonly prisma: BillingPrismaService) {}

	async get(workspaceId: string) {
		const entitlement = await this.prisma.crmEntitlement.findUnique({
			where: { workspaceId }
		});
		return this.response(entitlement, new Date());
	}

	async activateTrial(dto: ActivateCrmTrialCommandDto) {
		const commandType = CRM_TRIAL_PROVISIONING_COMMAND_TYPE;
		const payload = {
			schemaVersion: dto.schemaVersion,
			commandId: dto.commandId,
			workspaceId: dto.workspaceId,
			activatedByUserId: dto.activatedByUserId
		};
		const requestHash = billingCommandRequestHash(commandType, payload);

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				return await this.prisma.$transaction(
					async transaction => {
						await lockBillingCommand(transaction, dto.commandId);
						const prior =
							await transaction.billingCommandReceipt.findUnique({
								where: { commandId: dto.commandId }
							});
						if (prior) {
							const priorResult = assertBillingCommandReceipt(
								prior,
								commandType,
								requestHash
							);
							const current = await transaction.crmEntitlement.findUnique({
								where: { workspaceId: dto.workspaceId }
							});
							if (!current) {
								throw new Error(
									'WinCRM entitlement is missing for an accepted activation receipt'
								);
							}
							this.assertAcceptedProvisioningProvenance(
								priorResult,
								current,
								dto,
								commandType
							);
							return {
								...this.response(current, new Date()),
								activated: false
							};
						}

						await transaction.$executeRaw(Prisma.sql`
							SELECT pg_advisory_xact_lock(
								hashtextextended(${`billing-wincrm-entitlement:${dto.workspaceId}`}, 0)
							)
						`);
						const existing = await transaction.crmEntitlement.findUnique({
							where: { workspaceId: dto.workspaceId }
						});
						const now = new Date();
						let result: CrmTrialActivationResponse;

						if (existing) {
							result = {
								...this.response(existing, now),
								activated: false
							};
						} else {
							const policy = await requireCrmCommercialPolicy(transaction);
							const sourceSequence = await this.nextSequence(transaction);
							const entitlement = await transaction.crmEntitlement.create({
								data: {
									workspaceId: dto.workspaceId,
									productCode: CRM_PRODUCT_CODE,
									planCode: CRM_TRIAL_PLAN_CODE,
									status: CrmEntitlementStatus.ACTIVE,
									seatLimit: policy.trialSeatLimit,
									policyVersion: policy.version,
									trialStartedAt: now,
									effectiveFrom: now,
									effectiveUntil: new Date(
										now.getTime() + policy.trialDays * DAY_MS
									),
									graceUntil: new Date(
										now.getTime() +
											(policy.trialDays + policy.graceDays) * DAY_MS
									),
									provisioningCommandId: dto.commandId,
									provisioningCommandType: commandType,
									activatedByUserId: dto.activatedByUserId,
									sourceSequence
								}
							});
							await this.emitChanged(transaction, entitlement);
							result = {
								...this.response(entitlement, now),
								activated: true
							};
						}

						await transaction.billingCommandReceipt.create({
							data: {
								commandId: dto.commandId,
								commandType,
								requestHash,
								requestHashVersion: 1,
								result: result as unknown as Prisma.InputJsonValue
							}
						});
						return result;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 5_000,
						timeout: 30_000
					}
				);
			} catch (error) {
				if (attempt === 3 || !this.retryableTransactionError(error)) {
					throw error;
				}
			}
		}
		throw new Error('WinCRM trial activation retry loop exhausted');
	}

	private response(
		entitlement: CrmEntitlement | null,
		now: Date
	): CrmEntitlementResponse {
		if (!entitlement) {
			return {
				schemaVersion: 1 as const,
				productCode: CRM_PRODUCT_CODE,
				status: 'NOT_ACTIVATED' as EffectiveCrmEntitlementStatus,
				entitlement: null
			};
		}
		const status =
			entitlement.status === CrmEntitlementStatus.ACTIVE &&
			entitlement.effectiveUntil <= now
				? entitlement.graceUntil
					? now < entitlement.graceUntil
						? CrmEntitlementStatus.GRACE
						: CrmEntitlementStatus.READ_ONLY
					: CrmEntitlementStatus.EXPIRED
				: entitlement.status;
		return {
			schemaVersion: 1 as const,
			productCode: CRM_PRODUCT_CODE,
			status: status as EffectiveCrmEntitlementStatus,
			entitlement: {
				id: entitlement.id,
				workspaceId: entitlement.workspaceId,
				planCode: entitlement.planCode,
				seatLimit: entitlement.seatLimit,
				policyVersion: entitlement.policyVersion,
				graceUntil: entitlement.graceUntil?.toISOString() || null,
				trialStartedAt: entitlement.trialStartedAt?.toISOString() || null,
				effectiveFrom: entitlement.effectiveFrom.toISOString(),
				effectiveUntil: entitlement.effectiveUntil.toISOString(),
				provisioningCommandId: entitlement.provisioningCommandId,
				provisioningCommandType: entitlement.provisioningCommandType,
				activatedByUserId: entitlement.activatedByUserId,
				aggregateVersion: entitlement.aggregateVersion.toString(),
				sourceSequence: entitlement.sourceSequence.toString()
			}
		};
	}

	private async emitChanged(
		transaction: Prisma.TransactionClient,
		entitlement: CrmEntitlement
	): Promise<void> {
		const eventId = randomUUID();
		const eventType = BILLING_EVENT_TYPES.crmEntitlementChanged;
		await transaction.outboxEvent.create({
			data: {
				eventId,
				eventType,
				aggregateType: 'billing.crm-entitlement',
				aggregateId: entitlement.id,
				aggregateVersion: entitlement.aggregateVersion,
				sourceSequence: entitlement.sourceSequence,
				exchange: BILLING_EVENTS_EXCHANGE,
				routingKey: eventType,
				payload: {
					schemaVersion: 1,
					eventType,
					eventId,
					aggregateId: entitlement.id,
					aggregateVersion: entitlement.aggregateVersion.toString(),
					sourceSequence: entitlement.sourceSequence.toString(),
					occurredAt: entitlement.updatedAt.toISOString(),
					tombstone: false,
					state: {
						workspaceId: entitlement.workspaceId,
						productCode: entitlement.productCode,
						planCode: entitlement.planCode,
						status: entitlement.status,
						seatLimit: entitlement.seatLimit,
						effectiveFrom: entitlement.effectiveFrom.toISOString(),
						effectiveUntil: entitlement.effectiveUntil.toISOString()
					}
				} as Prisma.InputJsonValue
			}
		});
	}

	private async nextSequence(transaction: Prisma.TransactionClient) {
		const state = await transaction.billingSourceSequence.upsert({
			where: { id: 'billing' },
			create: { id: 'billing', nextValue: 2n },
			update: { nextValue: { increment: 1n } }
		});
		return state.nextValue - 1n;
	}

	private assertAcceptedProvisioningProvenance(
		result: Prisma.JsonValue,
		entitlement: CrmEntitlement,
		dto: ActivateCrmTrialCommandDto,
		commandType: string
	): void {
		if (
			result === null ||
			typeof result !== 'object' ||
			Array.isArray(result) ||
			typeof result.activated !== 'boolean'
		) {
			throw new Error('WinCRM activation receipt has an invalid result');
		}
		if (!result.activated) return;
		if (
			entitlement.provisioningCommandId.toLowerCase() !==
				dto.commandId.toLowerCase() ||
			entitlement.provisioningCommandType !== commandType ||
			entitlement.activatedByUserId !== dto.activatedByUserId
		) {
			throw new Error(
				'WinCRM entitlement provenance does not match its accepted activation receipt'
			);
		}
	}

	private retryableTransactionError(error: unknown): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			(error as { code?: unknown }).code === 'P2034'
		);
	}
}
