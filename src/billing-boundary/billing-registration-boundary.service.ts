import { BillingInternalClient } from '@/billing-boundary/billing-internal.client';
import { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import {
	BILLING_LIFECYCLE_REPAIR_EVENT_TYPE,
	BILLING_REFERRAL_REQUESTED_EVENT_TYPE,
	BILLING_TRIAL_REQUESTED_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { PrismaService } from '@/prisma.service';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
	BillingCoreOwnership,
	Plan,
	Prisma,
	Role,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';
import * as dayjs from 'dayjs';
import { randomUUID } from 'node:crypto';

export type BillingLifecycleOperation = 'DEACTIVATE' | 'DELETE';

export interface BillingLifecycleRevocation {
	commandId: string;
	remoteApplied: boolean;
	userId: string;
	operation: BillingLifecycleOperation;
	actorId: string;
	actorRole: Role;
	requestedAt: string;
}

@Injectable()
export class BillingRegistrationBoundaryService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly state: BillingCoreStateService,
		private readonly client: BillingInternalClient
	) {}

	async captureReferralInTransaction(
		transaction: Prisma.TransactionClient,
		input: {
			referrerId: string | undefined;
			referredUserId: string;
			requestedAt?: Date;
		}
	): Promise<void> {
		const referrerId = input.referrerId?.trim();
		if (
			!referrerId ||
			referrerId.length > 255 ||
			referrerId === input.referredUserId
		) {
			return;
		}
		const requestedAt = input.requestedAt ?? new Date();
		const ownership = await transaction.billingCoreState.findUnique({
			where: { id: 'singleton' },
			select: { ownership: true, sourceProducersEnabled: true }
		});
		if (!ownership) {
			throw new ServiceUnavailableException(
				'Billing ownership state is unavailable'
			);
		}

		if (
			ownership.ownership === BillingCoreOwnership.CORE &&
			ownership.sourceProducersEnabled
		) {
			await this.createLegacyReferralInTransaction(transaction, {
				referrerId,
				referredUserId: input.referredUserId
			});
			return;
		}
		const referrer = await transaction.user.findFirst({
			where: {
				id: referrerId,
				status: UserStatus.ACTIVE,
				deletedAt: null
			},
			select: { id: true }
		});
		if (!referrer) return;

		await this.recordSourceEvent(transaction, {
			eventType: BILLING_REFERRAL_REQUESTED_EVENT_TYPE,
			aggregateType: 'billing.referral-request',
			aggregateId: input.referredUserId,
			state: {
				referrerId,
				referredUserId: input.referredUserId,
				requestedAt: requestedAt.toISOString()
			}
		});
	}

	async ensureTrial(userId: string, registeredAt: Date): Promise<void> {
		const decision = await this.prisma.$transaction(async transaction => {
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "billing_core_state"
					WHERE "id" = 'singleton'
					FOR SHARE
				`
			);
			const marker = await transaction.billingCoreState.findUnique({
				where: { id: 'singleton' },
				select: { ownership: true, sourceProducersEnabled: true }
			});
			if (!marker) {
				throw new ServiceUnavailableException(
					'Billing ownership state is unavailable'
				);
			}
			if (marker.ownership === BillingCoreOwnership.BILLING) {
				return 'BILLING' as const;
			}
			if (!marker.sourceProducersEnabled) {
				const existingRequest =
					await transaction.billingSourceAggregateVersion.findUnique({
						where: {
							aggregateType_aggregateId: {
								aggregateType: 'billing.trial',
								aggregateId: userId
							}
						},
						select: { aggregateId: true }
					});
				if (!existingRequest) {
					await this.recordSourceEvent(transaction, {
						eventType: BILLING_TRIAL_REQUESTED_EVENT_TYPE,
						aggregateType: 'billing.trial',
						aggregateId: userId,
						state: {
							userId,
							trialDays: 7,
							registeredAt: registeredAt.toISOString()
						}
					});
				}
				return 'SOURCE_EVENT' as const;
			}

			const existing = await transaction.subscription.findUnique({
				where: { userId },
				select: { id: true }
			});
			if (!existing) {
				await transaction.subscription.create({
					data: {
						userId,
						plan: Plan.TRIAL,
						status: SubscriptionStatus.ACTIVE,
						expiresAt: dayjs().add(7, 'day').toDate()
					}
				});
			}
			return 'LEGACY' as const;
		});

		if (decision === 'BILLING') {
			await this.client.ensureTrial({
				commandId: randomUUID(),
				userId,
				registeredAt: registeredAt.toISOString()
			});
		}
	}

	async revokeBeforeLifecycleMutation(input: {
		userId: string;
		operation: BillingLifecycleOperation;
		actorId: string;
		actorRights: Role[];
	}): Promise<BillingLifecycleRevocation> {
		const state = await this.state.get();
		if (
			state.ownership === BillingCoreOwnership.CORE &&
			!state.sourceProducersEnabled
		) {
			throw new ServiceUnavailableException({
				statusCode: 503,
				message: 'Billing ownership migration is in progress',
				error: 'Service Unavailable',
				code: 'billing_migration_in_progress'
			});
		}
		const commandId = randomUUID();
		const remoteApplied = state.ownership === BillingCoreOwnership.BILLING;
		const actorRole = input.actorRights.includes(Role.DEV)
			? Role.DEV
			: Role.ADMIN;
		const requestedAt = new Date().toISOString();
		const revocation: BillingLifecycleRevocation = {
			commandId,
			remoteApplied,
			userId: input.userId,
			operation: input.operation,
			actorId: input.actorId,
			actorRole,
			requestedAt
		};
		if (remoteApplied) {
			try {
				await this.client.revokeEntitlements({
					commandId,
					userId: input.userId,
					reason:
						input.operation === 'DELETE'
							? 'USER_SOFT_DELETE'
							: 'USER_DEACTIVATION',
					actorId: input.actorId,
					actorRole,
					occurredAt: requestedAt
				});
			} catch (error) {
				await this.recordLifecycleRepair(revocation);
				throw error;
			}
		}
		return revocation;
	}

	async recordLifecycleRepair(
		revocation: BillingLifecycleRevocation
	): Promise<void> {
		if (!revocation.remoteApplied) return;
		await this.prisma.$transaction(transaction =>
			this.recordSourceEvent(transaction, {
				eventType: BILLING_LIFECYCLE_REPAIR_EVENT_TYPE,
				aggregateType: 'billing.lifecycle-repair',
				aggregateId: revocation.userId,
				state: {
					commandId: revocation.commandId,
					userId: revocation.userId,
					operation: revocation.operation,
					actorId: revocation.actorId,
					actorRole: revocation.actorRole,
					coreMutationApplied: false,
					requestedAt: revocation.requestedAt
				}
			})
		);
	}

	private async createLegacyReferralInTransaction(
		transaction: Prisma.TransactionClient,
		input: { referrerId: string; referredUserId: string }
	): Promise<void> {
		const settings = await transaction.siteSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
		if (!settings.affiliateProgramEnabled) return;

		const [referrer, existingReferral, existingPaymentCount] =
			await Promise.all([
				transaction.user.findFirst({
					where: {
						id: input.referrerId,
						status: UserStatus.ACTIVE
					},
					select: { id: true }
				}),
				transaction.affiliateReferral.findUnique({
					where: { referredUserId: input.referredUserId },
					select: { id: true }
				}),
				transaction.payment.count({
					where: { userId: input.referredUserId }
				})
			]);
		if (!referrer || existingReferral || existingPaymentCount > 0) return;
		await transaction.affiliateReferral.create({
			data: input
		});
	}

	private async recordSourceEvent(
		transaction: Prisma.TransactionClient,
		input: {
			eventType: string;
			aggregateType: string;
			aggregateId: string;
			state: Prisma.InputJsonObject;
		}
	): Promise<void> {
		const stateJson = JSON.stringify(input.state);
		await transaction.$executeRaw(
			Prisma.sql`
				SELECT "billing_record_source_event"(
					${input.eventType},
					${input.eventType},
					${input.aggregateType},
					${input.aggregateId},
					${stateJson}::jsonb,
					FALSE
				)
			`
		);
	}
}
