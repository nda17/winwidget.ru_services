import { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import {
	BillingAffiliateState,
	BillingPaymentDetailsState,
	BillingProjectionEventPayload,
	BillingSettingsState,
	BillingSubscriptionDetailsState
} from '@/messaging/billing-events';
import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class BillingReadProjectionService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly state: BillingCoreStateService
	) {}

	async apply(event: BillingProjectionEventPayload): Promise<boolean> {
		await this.state.assertProjectionConsumerEnabled();
		const aggregateVersion = BigInt(event.aggregateVersion);
		const sourceSequence = BigInt(event.sourceSequence);
		const aggregateType = this.getAggregateType(event.eventType);

		return this.prisma.$transaction(async transaction => {
			await transaction.$executeRaw(
				Prisma.sql`
					SELECT pg_advisory_xact_lock(
						hashtextextended(
							${`billing:read:${aggregateType}:${event.aggregateId}`},
							0
						)
					)
				`
			);
			const current =
				await transaction.billingReadProjectionVersion.findUnique({
					where: {
						aggregateType_aggregateId: {
							aggregateType,
							aggregateId: event.aggregateId
						}
					},
					select: { version: true }
				});
			if (current && current.version >= aggregateVersion) return false;

			await this.applyState(transaction, event, {
				aggregateVersion,
				sourceSequence
			});
			await transaction.billingReadProjectionVersion.upsert({
				where: {
					aggregateType_aggregateId: {
						aggregateType,
						aggregateId: event.aggregateId
					}
				},
				update: {
					version: aggregateVersion,
					sourceSequence
				},
				create: {
					aggregateType,
					aggregateId: event.aggregateId,
					version: aggregateVersion,
					sourceSequence
				}
			});
			return true;
		});
	}

	private async applyState(
		transaction: Prisma.TransactionClient,
		event: BillingProjectionEventPayload,
		version: { aggregateVersion: bigint; sourceSequence: bigint }
	): Promise<void> {
		switch (event.eventType) {
			case 'billing.payment.details.changed.v1':
				await this.applyPayment(transaction, event, version);
				return;
			case 'billing.subscription.details.changed.v1':
				await this.applySubscription(transaction, event, version);
				return;
			case 'billing.affiliate.changed.v1':
				await this.applyAffiliate(transaction, event, version);
				return;
			case 'billing.settings.changed.v1':
				await this.applySettings(transaction, event, version);
		}
	}

	private async applyPayment(
		transaction: Prisma.TransactionClient,
		event: BillingProjectionEventPayload & {
			eventType: 'billing.payment.details.changed.v1';
		},
		version: { aggregateVersion: bigint; sourceSequence: bigint }
	): Promise<void> {
		if (event.tombstone) {
			await transaction.billingPaymentReadProjection.deleteMany({
				where: { id: event.aggregateId }
			});
			return;
		}
		const state = event.state as BillingPaymentDetailsState;
		const data = {
			userId: state.userId,
			yookassaId: state.yookassaId,
			status: state.status,
			amount: state.amount,
			plan: state.plan,
			billingPeriod: state.billingPeriod,
			createdAt: new Date(state.createdAt),
			updatedAt: new Date(state.updatedAt),
			sourceVersion: version.aggregateVersion,
			sourceSequence: version.sourceSequence,
			projectedAt: new Date()
		};
		await transaction.billingPaymentReadProjection.upsert({
			where: { id: event.aggregateId },
			update: data,
			create: { id: event.aggregateId, ...data }
		});
	}

	private async applySubscription(
		transaction: Prisma.TransactionClient,
		event: BillingProjectionEventPayload & {
			eventType: 'billing.subscription.details.changed.v1';
		},
		version: { aggregateVersion: bigint; sourceSequence: bigint }
	): Promise<void> {
		if (event.tombstone) {
			await transaction.billingSubscriptionReadProjection.deleteMany({
				where: { id: event.aggregateId }
			});
			return;
		}
		const state = event.state as BillingSubscriptionDetailsState;
		const data = {
			userId: state.userId,
			plan: state.plan,
			billingPeriod: state.billingPeriod,
			status: state.status,
			startsAt: new Date(state.startsAt),
			expiresAt: state.expiresAt ? new Date(state.expiresAt) : null,
			leadsThisPeriod: state.leadsThisPeriod,
			periodResetsAt: state.periodResetsAt
				? new Date(state.periodResetsAt)
				: null,
			createdAt: new Date(state.createdAt),
			updatedAt: new Date(state.updatedAt),
			sourceVersion: version.aggregateVersion,
			sourceSequence: version.sourceSequence,
			projectedAt: new Date()
		};
		await transaction.billingSubscriptionReadProjection.upsert({
			where: { id: event.aggregateId },
			update: data,
			create: { id: event.aggregateId, ...data }
		});
	}

	private async applyAffiliate(
		transaction: Prisma.TransactionClient,
		event: BillingProjectionEventPayload & {
			eventType: 'billing.affiliate.changed.v1';
		},
		version: { aggregateVersion: bigint; sourceSequence: bigint }
	): Promise<void> {
		if (event.tombstone) {
			await transaction.billingAffiliateReadProjection.deleteMany({
				where: { id: event.aggregateId }
			});
			return;
		}
		const state = event.state as BillingAffiliateState;
		const data = {
			referrerId: state.referrerId,
			referredUserId: state.referredUserId,
			firstPaymentId: state.firstPaymentId,
			status: state.status,
			cashbackAmount: state.cashbackAmount,
			availableAt: state.availableAt ? new Date(state.availableAt) : null,
			cancelledAt: state.cancelledAt ? new Date(state.cancelledAt) : null,
			updatedAt: new Date(state.updatedAt),
			sourceVersion: version.aggregateVersion,
			sourceSequence: version.sourceSequence,
			projectedAt: new Date()
		};
		await transaction.billingAffiliateReadProjection.upsert({
			where: { id: event.aggregateId },
			update: data,
			create: { id: event.aggregateId, ...data }
		});
	}

	private async applySettings(
		transaction: Prisma.TransactionClient,
		event: BillingProjectionEventPayload & {
			eventType: 'billing.settings.changed.v1';
		},
		version: { aggregateVersion: bigint; sourceSequence: bigint }
	): Promise<void> {
		if (event.tombstone) {
			await transaction.billingSettingsReadProjection.deleteMany({
				where: { id: event.aggregateId }
			});
			return;
		}
		const state = event.state as BillingSettingsState;
		const data = {
			paymentEnabled: state.paymentEnabled,
			autoRenewalSignupEnabled: state.autoRenewalSignupEnabled,
			autoRenewalChargesEnabled: state.autoRenewalChargesEnabled,
			autoRenewalChargesEnabledAt: new Date(
				state.autoRenewalChargesEnabledAt
			),
			affiliateProgramEnabled: state.affiliateProgramEnabled,
			affiliateCashbackPercent: state.affiliateCashbackPercent,
			updatedAt: new Date(state.updatedAt),
			sourceVersion: version.aggregateVersion,
			sourceSequence: version.sourceSequence,
			projectedAt: new Date()
		};
		await transaction.billingSettingsReadProjection.upsert({
			where: { id: 'singleton' },
			update: data,
			create: { id: 'singleton', ...data }
		});
	}

	private getAggregateType(
		eventType: BillingProjectionEventPayload['eventType']
	): string {
		switch (eventType) {
			case 'billing.payment.details.changed.v1':
				return 'billing.payment-details';
			case 'billing.subscription.details.changed.v1':
				return 'billing.subscription-details';
			case 'billing.affiliate.changed.v1':
				return 'billing.affiliate';
			case 'billing.settings.changed.v1':
				return 'billing.settings';
		}
	}
}
