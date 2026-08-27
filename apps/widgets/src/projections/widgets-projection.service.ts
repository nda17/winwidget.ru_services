import { Injectable } from '@nestjs/common';
import {
	EntitlementBillingPeriod,
	EntitlementPlan,
	EntitlementStatus,
	OwnerStatus,
	Prisma,
	UsageKind,
	UsageOperation
} from '@prisma/widgets-client';
import {
	BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE,
	BillingSubscriptionState,
	IDENTITY_USER_CHANGED_EVENT_TYPE,
	IdentityUserState,
	projectionStateHash,
	WidgetsProjectionEvent
} from './widgets-projection.contract';
import {
	WIDGET_CHANGED_EVENT_TYPE,
	WidgetsReportingSequenceService
} from '../reporting/widgets-reporting-sequence.service';

export type ProjectionApplyResult = 'applied' | 'duplicate' | 'stale';

const PROJECTION_AGGREGATE_TYPES: Record<
	WidgetsProjectionEvent['eventType'],
	string
> = {
	[IDENTITY_USER_CHANGED_EVENT_TYPE]: 'identity.user',
	[BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE]: 'billing.subscription'
};

export class WidgetsProjectionConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WidgetsProjectionConflictError';
	}
}

@Injectable()
export class WidgetsProjectionService {
	constructor(
		private readonly reporting: WidgetsReportingSequenceService
	) {}

	async applyInTransaction(
		transaction: Prisma.TransactionClient,
		event: WidgetsProjectionEvent
	): Promise<ProjectionApplyResult> {
		const aggregateType = this.aggregateType(event.eventType);
		await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended(
					${`widgets-projection:${aggregateType}:${event.aggregateId}`},
					0
				)
			)
		`;
		const incomingVersion = BigInt(event.aggregateVersion);
		const incomingSequence = BigInt(event.sourceSequence);
		const incomingStateHash = projectionStateHash(event);
		const current = await transaction.widgetAggregateVersion.findUnique({
			where: {
				aggregateType_aggregateId: {
					aggregateType,
					aggregateId: event.aggregateId
				}
			}
		});
		if (current) {
			if (incomingVersion < current.version) return 'stale';
			if (incomingVersion === current.version) {
				if (
					incomingSequence !== current.sourceSequence ||
					incomingStateHash !== current.stateHash
				) {
					throw new WidgetsProjectionConflictError(
						'Projection aggregate version was reused with another sequence or state'
					);
				}
				return 'duplicate';
			}
			if (incomingSequence <= current.sourceSequence) {
				throw new WidgetsProjectionConflictError(
					'Projection source sequence must advance with aggregate version'
				);
			}
		}

		if (event.eventType === IDENTITY_USER_CHANGED_EVENT_TYPE) {
			await this.applyOwner(transaction, event);
		} else if (
			event.eventType === BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE
		) {
			await this.applyEntitlement(transaction, event);
		}

		await transaction.widgetAggregateVersion.upsert({
			where: {
				aggregateType_aggregateId: {
					aggregateType,
					aggregateId: event.aggregateId
				}
			},
			create: {
				aggregateType,
				aggregateId: event.aggregateId,
				version: incomingVersion,
				sourceSequence: incomingSequence,
				stateHash: incomingStateHash
			},
			update: {
				version: incomingVersion,
				sourceSequence: incomingSequence,
				stateHash: incomingStateHash
			}
		});
		return 'applied';
	}

	private async applyOwner(
		transaction: Prisma.TransactionClient,
		event: Extract<
			WidgetsProjectionEvent,
			{ eventType: typeof IDENTITY_USER_CHANGED_EVENT_TYPE }
		>
	): Promise<void> {
		const state = event.state as IdentityUserState | null;
		const tombstoned = event.tombstone || state?.deletedAt !== null;
		const status = tombstoned
			? OwnerStatus.DELETED
			: state?.status === 'ACTIVE'
				? OwnerStatus.ACTIVE
				: OwnerStatus.DEACTIVATED;
		await transaction.widgetOwnerProjection.upsert({
			where: { userId: event.aggregateId },
			create: {
				userId: event.aggregateId,
				status,
				deletedAt: tombstoned
					? state?.deletedAt
						? new Date(state.deletedAt)
						: new Date(event.occurredAt)
					: null,
				tombstoned,
				aggregateVersion: BigInt(event.aggregateVersion),
				sourceSequence: BigInt(event.sourceSequence),
				sourceOccurredAt: new Date(event.occurredAt)
			},
			update: {
				status,
				deletedAt: tombstoned
					? state?.deletedAt
						? new Date(state.deletedAt)
						: new Date(event.occurredAt)
					: null,
				tombstoned,
				aggregateVersion: BigInt(event.aggregateVersion),
				sourceSequence: BigInt(event.sourceSequence),
				sourceOccurredAt: new Date(event.occurredAt),
				appliedAt: new Date()
			}
		});

		if (status !== OwnerStatus.ACTIVE) {
			const active = await Promise.all([
				transaction.widget.findMany({
					where: { userId: event.aggregateId, isActive: true }
				}),
				transaction.quiz.findMany({
					where: { userId: event.aggregateId, isActive: true }
				}),
				transaction.callback.findMany({
					where: { userId: event.aggregateId, isActive: true }
				}),
				transaction.countdownTimer.findMany({
					where: { userId: event.aggregateId, isActive: true }
				}),
				transaction.stopOffer.findMany({
					where: { userId: event.aggregateId, isActive: true }
				}),
				transaction.onlineConsultant.findMany({
					where: { userId: event.aggregateId, isActive: true }
				}),
				transaction.calculator.findMany({
					where: { userId: event.aggregateId, isActive: true }
				})
			]);
			await Promise.all([
				transaction.widget.updateMany({
					where: { userId: event.aggregateId, isActive: true },
					data: { isActive: false }
				}),
				transaction.quiz.updateMany({
					where: { userId: event.aggregateId, isActive: true },
					data: { isActive: false }
				}),
				transaction.callback.updateMany({
					where: { userId: event.aggregateId, isActive: true },
					data: { isActive: false }
				}),
				transaction.countdownTimer.updateMany({
					where: { userId: event.aggregateId, isActive: true },
					data: { isActive: false }
				}),
				transaction.stopOffer.updateMany({
					where: { userId: event.aggregateId, isActive: true },
					data: { isActive: false }
				}),
				transaction.onlineConsultant.updateMany({
					where: { userId: event.aggregateId, isActive: true },
					data: { isActive: false }
				}),
				transaction.calculator.updateMany({
					where: { userId: event.aggregateId, isActive: true },
					data: { isActive: false }
				})
			]);
			const kinds = [
				'wheel',
				'quiz',
				'callback',
				'countdownTimer',
				'stopOffer',
				'onlineConsultant',
				'calculator'
			] as const;
			for (let index = 0; index < active.length; index += 1) {
				for (const widget of active[index]) {
					const kind = kinds[index];
					await this.reporting.createEventInTransaction(transaction, {
						eventType: WIDGET_CHANGED_EVENT_TYPE,
						aggregateType: `widgets.widget.${kind}`,
						aggregateId: `${kind}:${widget.id}`,
						tombstone: false,
						correlationId: event.eventId,
						state: {
							id: widget.id,
							userId: widget.userId,
							widgetType: kind,
							isActive: false,
							hasInstallDomain: Boolean(widget.installDomain),
							createdAt: widget.createdAt.toISOString()
						}
					});
				}
			}
		}
	}

	private async applyEntitlement(
		transaction: Prisma.TransactionClient,
		event: Extract<
			WidgetsProjectionEvent,
			{ eventType: typeof BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE }
		>
	): Promise<void> {
		const state = event.state as BillingSubscriptionState | null;
		if (!state) {
			await transaction.widgetEntitlementProjection.updateMany({
				where: { id: event.aggregateId },
				data: {
					tombstoned: true,
					plan: null,
					billingPeriod: null,
					status: null,
					startsAt: null,
					expiresAt: null,
					periodResetsAt: null,
					maxWidgets: null,
					maxLeadsPerPeriod: null,
					unlimited: null,
					aggregateVersion: BigInt(event.aggregateVersion),
					sourceSequence: BigInt(event.sourceSequence),
					sourceOccurredAt: new Date(event.occurredAt),
					appliedAt: new Date()
				}
			});
			return;
		}

		const existingForUser =
			await transaction.widgetEntitlementProjection.findUnique({
				where: { userId: state.userId },
				select: { id: true }
			});
		if (existingForUser && existingForUser.id !== state.id) {
			await transaction.widgetEntitlementProjection.delete({
				where: { id: existingForUser.id }
			});
		}
		await transaction.widgetEntitlementProjection.upsert({
			where: { id: state.id },
			create: {
				id: state.id,
				userId: state.userId,
				plan: state.plan as EntitlementPlan,
				billingPeriod:
					(state.billingPeriod as EntitlementBillingPeriod | null) || null,
				status: state.status as EntitlementStatus,
				startsAt: new Date(state.startsAt),
				expiresAt: state.expiresAt ? new Date(state.expiresAt) : null,
				periodResetsAt: state.periodResetsAt
					? new Date(state.periodResetsAt)
					: null,
				maxWidgets: state.maxWidgets,
				maxLeadsPerPeriod: state.maxLeadsPerPeriod,
				unlimited: state.unlimited,
				tombstoned: false,
				aggregateVersion: BigInt(event.aggregateVersion),
				sourceSequence: BigInt(event.sourceSequence),
				sourceOccurredAt: new Date(event.occurredAt),
				sourceCreatedAt: new Date(state.createdAt)
			},
			update: {
				userId: state.userId,
				plan: state.plan as EntitlementPlan,
				billingPeriod:
					(state.billingPeriod as EntitlementBillingPeriod | null) || null,
				status: state.status as EntitlementStatus,
				startsAt: new Date(state.startsAt),
				expiresAt: state.expiresAt ? new Date(state.expiresAt) : null,
				periodResetsAt: state.periodResetsAt
					? new Date(state.periodResetsAt)
					: null,
				maxWidgets: state.maxWidgets,
				maxLeadsPerPeriod: state.maxLeadsPerPeriod,
				unlimited: state.unlimited,
				tombstoned: false,
				aggregateVersion: BigInt(event.aggregateVersion),
				sourceSequence: BigInt(event.sourceSequence),
				sourceOccurredAt: new Date(event.occurredAt),
				sourceCreatedAt: new Date(state.createdAt),
				appliedAt: new Date()
			}
		});

		const periodEnd = state.periodResetsAt || state.expiresAt;
		const periodKey = periodEnd || `subscription:${state.id}`;
		const counter = await transaction.widgetUsageCounter.findUnique({
			where: { userId: state.userId }
		});
		if (!counter) {
			await transaction.widgetUsageCounter.create({
				data: {
					userId: state.userId,
					leadPeriodKey: periodKey,
					leadPeriodStartsAt: new Date(state.startsAt),
					leadPeriodEndsAt: periodEnd ? new Date(periodEnd) : null,
					entitlementVersion: BigInt(event.aggregateVersion)
				}
			});
			return;
		}
		const periodChanged = counter.leadPeriodKey !== periodKey;
		await transaction.widgetUsageCounter.update({
			where: { userId: state.userId },
			data: {
				leadCount: periodChanged ? 0 : counter.leadCount,
				leadPeriodKey: periodKey,
				leadPeriodStartsAt: periodChanged
					? new Date(event.occurredAt)
					: counter.leadPeriodStartsAt,
				leadPeriodEndsAt: periodEnd ? new Date(periodEnd) : null,
				entitlementVersion: BigInt(event.aggregateVersion)
			}
		});
		if (periodChanged) {
			await transaction.widgetUsageLedgerEntry.createMany({
				data: [
					{
						userId: state.userId,
						kind: UsageKind.LEAD,
						operation: UsageOperation.PERIOD_RESET,
						delta: -counter.leadCount,
						counterAfter: 0,
						periodKey,
						idempotencyKey: `entitlement:${state.id}:version:${event.aggregateVersion}:period-reset`,
						entitlementVersion: BigInt(event.aggregateVersion),
						correlationId: event.eventId
					}
				],
				skipDuplicates: true
			});
		}
	}

	private aggregateType(
		eventType: WidgetsProjectionEvent['eventType']
	): string {
		return PROJECTION_AGGREGATE_TYPES[eventType];
	}
}
