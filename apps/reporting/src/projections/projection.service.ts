import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	BillingPaymentState,
	BillingSubscriptionState,
	IdentityUserState,
	InvalidReportingEventError,
	LeadState,
	OperationsNotificationRoutingChangedEvent,
	ReportingProjectionStream,
	ReportingSourceEvent,
	WidgetState,
	parseWidgetAggregateId,
	sourceEventTypeToStream
} from './reporting-event.contract';
import { Injectable } from '@nestjs/common';
import {
	Prisma,
	ProjectionReceiptResult,
	ReportingConsumerFailureStatus,
	ReportingConsumerReceiptStatus
} from '@prisma/reporting-client';
import { createHash } from 'node:crypto';

export interface ConsumerReceiptCompletion {
	eventId: string;
	consumer: string;
	lockToken: string;
}

interface ProjectionIdentity {
	aggregateVersion: Prisma.Decimal;
	stateHash: string | null;
}

export class ProjectionStateConflictError extends InvalidReportingEventError {
	constructor(message: string) {
		super(message);
		this.name = 'ProjectionStateConflictError';
	}
}

export function reportingProjectionStateHash(
	event: Pick<ReportingSourceEvent, 'tombstone' | 'state'>
): string {
	return createHash('sha256')
		.update(
			canonicalJson({
				tombstone: event.tombstone,
				state: event.state
			})
		)
		.digest('hex');
}

export function normalizePaymentAmount(value: string): number | null {
	const amount = Number(value.replace(',', '.'));
	return Number.isFinite(amount) ? amount : null;
}

function canonicalJson(value: unknown, key?: string): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) {
		const items = key === 'roles' ? [...value].sort() : value;
		return `[${items.map(item => canonicalJson(item)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(
				entryKey =>
					`${JSON.stringify(entryKey)}:${canonicalJson(record[entryKey], entryKey)}`
			)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

@Injectable()
export class ProjectionService {
	constructor(
		private readonly prisma: ReportingPrismaService,
		private readonly metrics: ReportingMetricsService
	) {}

	async applyEvent(
		event: ReportingSourceEvent,
		completion?: ConsumerReceiptCompletion
	): Promise<ProjectionReceiptResult> {
		const result = await this.prisma.$transaction(
			async transaction => {
				const applied = await this.applyInTransaction(transaction, event);
				if (completion) {
					await this.completeConsumerReceipt(transaction, completion);
				}
				return applied;
			},
			{ timeout: 30_000 }
		);
		this.recordMetric(result);
		return result;
	}

	async applyOperationsNotificationRouting(
		event: OperationsNotificationRoutingChangedEvent,
		completion: ConsumerReceiptCompletion
	): Promise<void> {
		const changedAt = new Date(event.changedAt);
		const applied = await this.prisma.$transaction(
			async transaction => {
				await transaction.reportingSettings.upsert({
					where: { id: 'daily-summary' },
					create: { id: 'daily-summary' },
					update: {}
				});
				const lockedRows = await transaction.$queryRaw<
					Array<{ id: string }>
				>(
					Prisma.sql`
						SELECT "id"
						FROM reporting."reporting_settings"
						WHERE "id" = 'daily-summary'
						FOR UPDATE
					`
				);
				if (lockedRows.length !== 1) {
					throw new Error('Daily Summary settings row is missing');
				}
				const current =
					await transaction.reportingSettings.findUniqueOrThrow({
						where: { id: 'daily-summary' },
						select: {
							messageThreadId: true,
							operationalAlertsChangedAt: true
						}
					});
				const isNewer =
					current.operationalAlertsChangedAt === null ||
					changedAt.getTime() >
						current.operationalAlertsChangedAt.getTime();
				if (isNewer) {
					if (
						event.operationalAlertsThreadId !== null &&
						event.operationalAlertsThreadId === current.messageThreadId
					) {
						throw new InvalidReportingEventError(
							'Daily Summary and operational alerts require separate Telegram topics'
						);
					}
					await transaction.reportingSettings.update({
						where: { id: 'daily-summary' },
						data: {
							operationalAlertsThreadId: event.operationalAlertsThreadId,
							operationalAlertsChangedAt: changedAt
						}
					});
				}
				await this.completeConsumerReceipt(transaction, completion);
				return isNewer;
			},
			{ timeout: 30_000 }
		);
		this.metrics.increment(
			applied
				? 'projection_events_applied_total'
				: 'projection_events_stale_total'
		);
	}

	private async applyInTransaction(
		transaction: Prisma.TransactionClient,
		event: ReportingSourceEvent
	): Promise<ProjectionReceiptResult> {
		const stream = sourceEventTypeToStream(event.eventType);
		const stateHash = reportingProjectionStateHash(event);
		const existingReceipt = await transaction.projectionReceipt.findUnique(
			{
				where: {
					eventId_projection: {
						eventId: event.eventId,
						projection: stream
					}
				},
				select: { result: true, stateHash: true }
			}
		);
		if (existingReceipt) {
			if (existingReceipt.stateHash !== stateHash) {
				throw new ProjectionStateConflictError(
					`Projection eventId conflict eventId=${event.eventId} projection=${stream}`
				);
			}
			return ProjectionReceiptResult.DUPLICATE;
		}

		// A per-aggregate advisory transaction lock closes the read/create race
		// without introducing a global scheduler or projection lock.
		await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${`reporting:${stream}:${event.aggregateId}`}, 0)
			)
		`;
		const current = await this.currentIdentity(transaction, stream, event);
		const incomingVersion = new Prisma.Decimal(event.aggregateVersion);
		let result: ProjectionReceiptResult;
		if (current && incomingVersion.lt(current.aggregateVersion)) {
			result = ProjectionReceiptResult.STALE;
		} else if (current && incomingVersion.eq(current.aggregateVersion)) {
			if (current.stateHash !== stateHash) {
				throw new ProjectionStateConflictError(
					`Projection aggregateVersion conflict projection=${stream} aggregateId=${event.aggregateId} version=${event.aggregateVersion}`
				);
			}
			result = ProjectionReceiptResult.DUPLICATE;
		} else {
			result = await this.applyNewerEvent(
				transaction,
				stream,
				event,
				stateHash
			);
		}

		await transaction.projectionReceipt.create({
			data: {
				eventId: event.eventId,
				projection: stream,
				eventType: event.eventType,
				aggregateId: event.aggregateId,
				aggregateVersion: incomingVersion,
				sourceSequence: new Prisma.Decimal(event.sourceSequence),
				tombstone: event.tombstone,
				stateHash,
				result
			}
		});
		await this.advanceDiagnosticWatermark(transaction, stream, event);
		return result;
	}

	private async currentIdentity(
		transaction: Prisma.TransactionClient,
		stream: ReportingProjectionStream,
		event: ReportingSourceEvent
	): Promise<ProjectionIdentity | null> {
		const aggregateId = event.aggregateId;
		if (stream === 'identityUser') {
			return (
				(await transaction.identityUserProjection.findUnique({
					where: { id: aggregateId },
					select: { aggregateVersion: true, stateHash: true }
				})) ?? null
			);
		}
		if (stream === 'billingPayment') {
			return (
				(await transaction.billingPaymentFact.findUnique({
					where: { id: aggregateId },
					select: { aggregateVersion: true, stateHash: true }
				})) ?? null
			);
		}
		if (stream === 'billingSubscription') {
			return (
				(await transaction.billingSubscriptionProjection.findUnique({
					where: { id: aggregateId },
					select: { aggregateVersion: true, stateHash: true }
				})) ?? null
			);
		}
		if (stream === 'widget') {
			return (
				(await transaction.widgetProjection.findUnique({
					where: { sourceAggregateId: aggregateId },
					select: { aggregateVersion: true, stateHash: true }
				})) ?? null
			);
		}
		if (stream === 'lead') {
			return (
				(await transaction.leadFact.findUnique({
					where: { sourceAggregateId: aggregateId },
					select: { aggregateVersion: true, stateHash: true }
				})) ?? null
			);
		}
		throw new InvalidReportingEventError('Unsupported projection stream');
	}

	private async applyNewerEvent(
		transaction: Prisma.TransactionClient,
		stream: ReportingProjectionStream,
		event: ReportingSourceEvent,
		stateHash: string
	): Promise<ProjectionReceiptResult> {
		const common = {
			aggregateVersion: new Prisma.Decimal(event.aggregateVersion),
			sourceSequence: new Prisma.Decimal(event.sourceSequence),
			sourceOccurredAt: new Date(event.occurredAt),
			appliedAt: new Date(),
			stateHash
		};
		if (stream === 'identityUser') {
			const state = event.state as IdentityUserState | null;
			await transaction.identityUserProjection.upsert({
				where: { id: event.aggregateId },
				create: {
					id: event.aggregateId,
					createdAt: state ? new Date(state.createdAt) : null,
					sourceUpdatedAt: state ? new Date(state.updatedAt) : null,
					deletedAt: state?.deletedAt ? new Date(state.deletedAt) : null,
					status: state?.status || null,
					roles: state?.roles || [],
					hasEmailIdentity: state?.hasEmailIdentity ?? null,
					hasPhoneIdentity: state?.hasPhoneIdentity ?? null,
					hasTelegramIdentity: state?.hasTelegramIdentity ?? null,
					loginMethodCount: state?.loginMethodCount ?? null,
					tombstoned: event.tombstone,
					...common
				},
				update: {
					createdAt: state ? new Date(state.createdAt) : null,
					sourceUpdatedAt: state ? new Date(state.updatedAt) : null,
					deletedAt: state?.deletedAt ? new Date(state.deletedAt) : null,
					status: state?.status || null,
					roles: state?.roles || [],
					hasEmailIdentity: state?.hasEmailIdentity ?? null,
					hasPhoneIdentity: state?.hasPhoneIdentity ?? null,
					hasTelegramIdentity: state?.hasTelegramIdentity ?? null,
					loginMethodCount: state?.loginMethodCount ?? null,
					tombstoned: event.tombstone,
					...common
				}
			});
			return ProjectionReceiptResult.APPLIED;
		}
		if (stream === 'billingPayment') {
			const state = event.state as BillingPaymentState | null;
			const normalizedAmount = state
				? normalizePaymentAmount(state.amount)
				: null;
			await transaction.billingPaymentFact.upsert({
				where: { id: event.aggregateId },
				create: {
					id: event.aggregateId,
					userId: state?.userId || null,
					amount: state?.amount || null,
					normalizedAmount,
					status: state?.status || null,
					sourceCreatedAt: state ? new Date(state.createdAt) : null,
					sourceUpdatedAt: state ? new Date(state.updatedAt) : null,
					tombstoned: event.tombstone,
					...common
				},
				update: {
					userId: state?.userId || null,
					amount: state?.amount || null,
					normalizedAmount,
					status: state?.status || null,
					sourceCreatedAt: state ? new Date(state.createdAt) : null,
					sourceUpdatedAt: state ? new Date(state.updatedAt) : null,
					tombstoned: event.tombstone,
					...common
				}
			});
			return ProjectionReceiptResult.APPLIED;
		}
		if (stream === 'billingSubscription') {
			const state = event.state as BillingSubscriptionState | null;
			await transaction.billingSubscriptionProjection.upsert({
				where: { id: event.aggregateId },
				create: {
					id: event.aggregateId,
					userId: state?.userId || null,
					plan: state?.plan || null,
					status: state?.status || null,
					expiresAt: state?.expiresAt ? new Date(state.expiresAt) : null,
					sourceCreatedAt: state ? new Date(state.createdAt) : null,
					tombstoned: event.tombstone,
					...common
				},
				update: {
					userId: state?.userId || null,
					plan: state?.plan || null,
					status: state?.status || null,
					expiresAt: state?.expiresAt ? new Date(state.expiresAt) : null,
					sourceCreatedAt: state ? new Date(state.createdAt) : null,
					tombstoned: event.tombstone,
					...common
				}
			});
			return ProjectionReceiptResult.APPLIED;
		}
		if (stream === 'widget') {
			const state = event.state as WidgetState | null;
			const identity = parseWidgetAggregateId(event.aggregateId);
			const current = await transaction.widgetProjection.findUnique({
				where: { sourceAggregateId: event.aggregateId }
			});
			const data = {
				widgetType: state?.widgetType || identity.widgetType,
				id: state?.id || identity.id,
				sourceAggregateId: event.aggregateId,
				userId: state?.userId || null,
				isActive: state?.isActive ?? null,
				hasInstallDomain: state?.hasInstallDomain ?? null,
				sourceCreatedAt: state ? new Date(state.createdAt) : null,
				tombstoned: event.tombstone,
				...common
			};
			if (current) {
				await transaction.widgetProjection.update({
					where: { sourceAggregateId: event.aggregateId },
					data
				});
			} else {
				await transaction.widgetProjection.create({ data });
			}
			return ProjectionReceiptResult.APPLIED;
		}
		if (stream === 'lead') {
			const state = event.state as LeadState | null;
			const identity = parseWidgetAggregateId(event.aggregateId);
			const current = await transaction.leadFact.findUnique({
				where: { sourceAggregateId: event.aggregateId }
			});
			const data = {
				widgetType: state?.widgetType || identity.widgetType,
				id: state?.id || identity.id,
				sourceAggregateId: event.aggregateId,
				widgetId: state?.widgetId || null,
				sourceCreatedAt: state ? new Date(state.createdAt) : null,
				tombstoned: event.tombstone,
				...common
			};
			if (current) {
				await transaction.leadFact.update({
					where: { sourceAggregateId: event.aggregateId },
					data
				});
			} else {
				await transaction.leadFact.create({ data });
			}
			return ProjectionReceiptResult.APPLIED;
		}
		throw new InvalidReportingEventError('Unsupported projection stream');
	}

	private async completeConsumerReceipt(
		transaction: Prisma.TransactionClient,
		completion: ConsumerReceiptCompletion
	): Promise<void> {
		const completedAt = new Date();
		const completed = await transaction.consumerReceipt.updateMany({
			where: {
				eventId: completion.eventId,
				consumer: completion.consumer,
				status: ReportingConsumerReceiptStatus.PROCESSING,
				lockToken: completion.lockToken
			},
			data: {
				status: ReportingConsumerReceiptStatus.DELIVERED,
				deliveredAt: completedAt,
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				retryAttempt: null,
				lastError: null
			}
		});
		if (completed.count !== 1) {
			throw new Error(
				'Consumer receipt lease was lost before projection commit'
			);
		}
		await transaction.reportingConsumerFailure.updateMany({
			where: {
				eventId: completion.eventId,
				consumer: completion.consumer,
				status: ReportingConsumerFailureStatus.RETRY_REQUESTED
			},
			data: {
				status: ReportingConsumerFailureStatus.RESOLVED,
				resolvedAt: completedAt
			}
		});
	}

	private async advanceDiagnosticWatermark(
		transaction: Prisma.TransactionClient,
		stream: ReportingProjectionStream,
		event: ReportingSourceEvent
	): Promise<void> {
		const incoming = new Prisma.Decimal(event.sourceSequence);
		await transaction.$executeRaw`
			INSERT INTO "reporting"."projection_watermarks" (
				"stream",
				"source_sequence",
				"event_id",
				"aggregate_version",
				"occurred_at",
				"updated_at"
			) VALUES (
				${stream},
				${incoming},
				CAST(${event.eventId} AS UUID),
				${new Prisma.Decimal(event.aggregateVersion)},
				${new Date(event.occurredAt)},
				CURRENT_TIMESTAMP
			)
			ON CONFLICT ("stream") DO UPDATE SET
				"source_sequence" = EXCLUDED."source_sequence",
				"event_id" = EXCLUDED."event_id",
				"aggregate_version" = EXCLUDED."aggregate_version",
				"occurred_at" = EXCLUDED."occurred_at",
				"updated_at" = CURRENT_TIMESTAMP
			WHERE "projection_watermarks"."source_sequence"
				< EXCLUDED."source_sequence"
		`;
	}

	private recordMetric(result: ProjectionReceiptResult): void {
		if (result === ProjectionReceiptResult.APPLIED) {
			this.metrics.increment('projection_events_applied_total');
		} else if (result === ProjectionReceiptResult.DUPLICATE) {
			this.metrics.increment('projection_events_duplicate_total');
		} else {
			this.metrics.increment('projection_events_stale_total');
		}
	}
}
