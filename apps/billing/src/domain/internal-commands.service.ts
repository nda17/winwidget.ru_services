import {
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	PaymentStatus,
	Prisma,
	ProviderOperationStatus
} from '@prisma/billing-client';
import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
	EnsureTrialCommandDto,
	RevokeEntitlementsCommandDto,
	UpdateBillingSettingsCommandDto
} from '../http/billing.dto';
import {
	BILLING_EVENT_TYPES,
	BILLING_EVENTS_EXCHANGE
} from '../messaging/billing-messaging.constants';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import { SubscriptionDomainService } from './subscription-domain.service';
import { TariffAffiliateService } from './tariff-affiliate.service';

@Injectable()
export class InternalCommandsService {
	constructor(
		private readonly prisma: BillingPrismaService,
		private readonly subscriptions: SubscriptionDomainService,
		private readonly tariffAffiliate: TariffAffiliateService
	) {}

	async ensureTrial(dto: EnsureTrialCommandDto) {
		const prior = await this.receipt(dto.commandId, 'ENSURE_TRIAL');
		if (prior) return prior;
		const subscription = await this.subscriptions.ensureTrial(
			dto.userId,
			dto.trialDays || 7,
			new Date(dto.registeredAt)
		);
		const result = {
			ensured: true,
			subscriptionId: subscription.id,
			userId: dto.userId
		};
		await this.saveReceipt(dto.commandId, 'ENSURE_TRIAL', result);
		return result;
	}

	async revokeBeforeDeactivate(dto: RevokeEntitlementsCommandDto) {
		const prior = await this.receipt(
			dto.commandId,
			'REVOKE_BEFORE_DEACTIVATE'
		);
		if (prior) return prior;
		return this.prisma.$transaction(
			async transaction => {
				const inside = await transaction.billingCommandReceipt.findUnique({
					where: { commandId: dto.commandId }
				});
				if (inside) return inside.result;
				await transaction.$queryRaw`
					SELECT user_id FROM billing.identity_contact_projections
					WHERE user_id = ${dto.userId}
					FOR UPDATE
				`;
				await transaction.$queryRaw`
					SELECT id FROM billing.auto_renewals
					WHERE user_id = ${dto.userId}
					FOR UPDATE
				`;
				await transaction.$queryRaw`
					SELECT id FROM billing.payments
					WHERE user_id = ${dto.userId}
					FOR UPDATE
				`;
				await transaction.$queryRaw`
					SELECT operation.id
					FROM billing.provider_operations AS operation
					JOIN billing.payments AS payment
						ON payment.id = operation.payment_id
					WHERE payment.user_id = ${dto.userId}
					FOR UPDATE OF operation
				`;
				const inFlight = await transaction.providerOperation.findFirst({
					where: {
						payment: { userId: dto.userId },
						status: {
							in: [
								ProviderOperationStatus.PROCESSING,
								ProviderOperationStatus.UNKNOWN
							]
						}
					},
					select: { id: true, status: true }
				});
				if (inFlight) {
					throw new ConflictException(
						'Billing provider operation is in flight; deactivation is fenced'
					);
				}
				const renewal = await transaction.autoRenewal.findUnique({
					where: { userId: dto.userId }
				});
				if (renewal) {
					const updated = await transaction.autoRenewal.update({
						where: { id: renewal.id },
						data: {
							status: AutoRenewalStatus.REVOKED,
							disabledAt: new Date(dto.occurredAt),
							disableReason: dto.reason,
							paymentMethodCiphertext: null,
							paymentMethodType: null,
							paymentMethodTitle: null,
							paymentMethodLast4: null,
							paymentMethodSavedAt: null,
							dispatchPending: false,
							stateVersion: { increment: 1 }
						}
					});
					await transaction.autoRenewalConsentEvent.create({
						data: {
							autoRenewalId: updated.id,
							userId: updated.userId,
							type: AutoRenewalConsentEventType.ADMIN_REVOKED,
							actorUserId: dto.actorId,
							actorRole: dto.actorRole,
							source: 'IDENTITY_LIFECYCLE',
							reason: dto.reason,
							consentVersion: updated.consentVersion,
							consentText: updated.consentText,
							offerSnapshot: updated.offerSnapshot,
							offerSha256: updated.offerSha256,
							offerUpdatedAt: updated.offerUpdatedAt,
							plan: updated.plan,
							billingPeriod: updated.billingPeriod,
							amount: updated.amount,
							currency: updated.currency,
							metadata: { commandId: dto.commandId }
						}
					});
				}
				await transaction.providerOperation.updateMany({
					where: {
						payment: { userId: dto.userId },
						status: ProviderOperationStatus.PENDING
					},
					data: {
						status: ProviderOperationStatus.FAILED,
						lastErrorCode: 'IDENTITY_DEACTIVATION',
						lastErrorSafe: 'Cancelled before identity deactivation'
					}
				});
				const pendingPayments = await transaction.payment.findMany({
					where: { userId: dto.userId, status: PaymentStatus.PENDING }
				});
				for (const payment of pendingPayments) {
					const sequence = await this.nextSequence(transaction);
					const updated = await transaction.payment.update({
						where: { id: payment.id },
						data: {
							status: PaymentStatus.CANCELLED,
							cancelledAt: new Date(dto.occurredAt),
							cancellationReason: 'IDENTITY_DEACTIVATION',
							aggregateVersion: { increment: 1n },
							sourceSequence: sequence
						}
					});
					await this.emitPaymentDetails(transaction, updated);
				}
				const result = {
					revoked: true,
					userId: dto.userId,
					cancelledPayments: pendingPayments.length,
					stateVersion: renewal ? renewal.stateVersion + 1 : null
				};
				await transaction.billingCommandReceipt.create({
					data: {
						commandId: dto.commandId,
						commandType: 'REVOKE_BEFORE_DEACTIVATE',
						result
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
	}

	async getSettings() {
		const item = await this.prisma.billingSettings.upsert({
			where: { id: 'singleton' },
			create: { id: 'singleton' },
			update: {}
		});
		return this.serializeSettings(item);
	}

	async updateSettings(dto: UpdateBillingSettingsCommandDto) {
		const prior = await this.receipt(dto.commandId, 'UPDATE_SETTINGS');
		if (prior) return prior;
		return this.prisma.$transaction(
			async transaction => {
				const inside = await transaction.billingCommandReceipt.findUnique({
					where: { commandId: dto.commandId }
				});
				if (inside) return inside.result;
				const current = await transaction.billingSettings.upsert({
					where: { id: 'singleton' },
					create: { id: 'singleton' },
					update: {}
				});
				const sequence = await this.nextSequence(transaction);
				const patch = dto.settings;
				const updated = await transaction.billingSettings.update({
					where: { id: 'singleton' },
					data: {
						paymentEnabled: patch.paymentEnabled ?? current.paymentEnabled,
						autoRenewalSignupEnabled:
							patch.autoRenewalSignupEnabled ??
							current.autoRenewalSignupEnabled,
						autoRenewalChargesEnabled:
							patch.autoRenewalChargesEnabled ??
							current.autoRenewalChargesEnabled,
						autoRenewalChargesEnabledAt:
							patch.autoRenewalChargesEnabled === true &&
							!current.autoRenewalChargesEnabled
								? new Date()
								: current.autoRenewalChargesEnabledAt,
						affiliateProgramEnabled:
							patch.affiliateProgramEnabled ??
							current.affiliateProgramEnabled,
						affiliateCashbackPercent:
							patch.affiliateCashbackPercent ??
							current.affiliateCashbackPercent,
						aggregateVersion: { increment: 1n },
						sourceSequence: sequence
					}
				});
				await this.tariffAffiliate.emitSettings(transaction, updated);
				const result = this.serializeSettings(updated);
				await transaction.billingCommandReceipt.create({
					data: {
						commandId: dto.commandId,
						commandType: 'UPDATE_SETTINGS',
						result: result as Prisma.InputJsonValue
					}
				});
				return result;
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private serializeSettings(item: any) {
		return {
			id: 'singleton',
			paymentEnabled: item.paymentEnabled,
			autoRenewalSignupEnabled: item.autoRenewalSignupEnabled,
			autoRenewalChargesEnabled: item.autoRenewalChargesEnabled,
			autoRenewalChargesEnabledAt:
				item.autoRenewalChargesEnabledAt.toISOString(),
			affiliateProgramEnabled: item.affiliateProgramEnabled,
			affiliateCashbackPercent: item.affiliateCashbackPercent,
			updatedAt: item.updatedAt.toISOString()
		};
	}

	private async emitPaymentDetails(
		transaction: Prisma.TransactionClient,
		item: any
	) {
		for (const [eventType, state] of [
			[
				BILLING_EVENT_TYPES.paymentChanged,
				{
					id: item.id,
					userId: item.userId,
					amount: item.amount,
					status: item.status,
					createdAt: item.createdAt.toISOString(),
					updatedAt: item.updatedAt.toISOString()
				}
			],
			[
				BILLING_EVENT_TYPES.paymentDetailsChanged,
				{
					id: item.id,
					userId: item.userId,
					yookassaId: item.yookassaId,
					status: item.status,
					amount: item.amount,
					plan: item.plan,
					billingPeriod: item.billingPeriod,
					createdAt: item.createdAt.toISOString(),
					updatedAt: item.updatedAt.toISOString()
				}
			]
		] as const) {
			const eventId = randomUUID();
			await transaction.outboxEvent.create({
				data: {
					eventId,
					eventType,
					aggregateType: eventType.replace('.changed.v1', ''),
					aggregateId: item.id,
					aggregateVersion: item.aggregateVersion,
					sourceSequence: item.sourceSequence,
					exchange: BILLING_EVENTS_EXCHANGE,
					routingKey: eventType,
					payload: {
						schemaVersion: 1,
						eventType,
						eventId,
						aggregateId: item.id,
						aggregateVersion: item.aggregateVersion.toString(),
						sourceSequence: item.sourceSequence.toString(),
						occurredAt: item.updatedAt.toISOString(),
						tombstone: false,
						state
					}
				}
			});
		}
	}

	private async receipt(commandId: string, commandType: string) {
		const value = await this.prisma.billingCommandReceipt.findUnique({
			where: { commandId }
		});
		if (value && value.commandType !== commandType) {
			throw new ConflictException(
				'Command ID was used for another command type'
			);
		}
		return value?.result || null;
	}

	private async saveReceipt(
		commandId: string,
		commandType: string,
		result: Record<string, unknown>
	) {
		await this.prisma.billingCommandReceipt.upsert({
			where: { commandId },
			create: {
				commandId,
				commandType,
				result: result as Prisma.InputJsonValue
			},
			update: {}
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
}
