import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	BillingPaymentState,
	BillingSubscriptionState,
	CoreOperationalRoutingState,
	IdentityUserState,
	InvalidReportingEventError,
	LeadState,
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
	ReportingConsumerReceiptStatus,
	ReportingOwner
} from '@prisma/reporting-client';
import { createHash } from 'node:crypto';

export interface ConsumerReceiptCompletion {
	eventId: string;
	consumer: string;
	lockToken: string;
}

export interface ProjectionApplySummary {
	applied: number;
	duplicate: number;
	stale: number;
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

export function normalizeLegacyPaymentAmount(
	value: string
): number | null {
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
				return applied;
			},
			{ timeout: 30_000 }
		);
		this.recordMetric(result);
		return result;
	}

	async applyBatch(
		events: readonly ReportingSourceEvent[]
	): Promise<ProjectionApplySummary> {
		if (!events.length) return { applied: 0, duplicate: 0, stale: 0 };
		const results = await this.prisma.$transaction(
			async transaction => {
				const aggregateLocks = [
					...new Set(
						events.map(
							event =>
								`reporting:${sourceEventTypeToStream(event.eventType)}:${event.aggregateId}`
						)
					)
				].sort();
				// The batch must own every aggregate before the first event advances a
				// stream watermark. Otherwise a live event can own aggregate B while
				// waiting for the watermark held by this batch, as the batch waits for B.
				for (const lockKey of aggregateLocks) {
					await transaction.$executeRaw`
						SELECT pg_advisory_xact_lock(
							hashtextextended(${lockKey}, 0)
						)
					`;
				}
				const batchResults: ProjectionReceiptResult[] = [];
				for (const event of events) {
					batchResults.push(
						await this.applyInTransaction(transaction, event)
					);
				}
				return batchResults;
			},
			{ timeout: 60_000 }
		);
		const summary: ProjectionApplySummary = {
			applied: 0,
			duplicate: 0,
			stale: 0
		};
		for (const result of results) {
			this.recordMetric(result);
			if (result === ProjectionReceiptResult.APPLIED) summary.applied += 1;
			if (result === ProjectionReceiptResult.DUPLICATE)
				summary.duplicate += 1;
			if (result === ProjectionReceiptResult.STALE) summary.stale += 1;
		}
		return summary;
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
		if (
			event.eventType === 'reporting.core-operational-routing.changed.v1'
		) {
			const current = await transaction.reportingSettings.findUnique({
				where: { id: 'daily-summary' },
				select: {
					coreOperationalRoutingSourceAggregateVersion: true,
					coreOperationalRoutingStateHash: true
				}
			});
			return current?.coreOperationalRoutingSourceAggregateVersion !==
				null &&
				current?.coreOperationalRoutingSourceAggregateVersion !== undefined
				? {
						aggregateVersion:
							current.coreOperationalRoutingSourceAggregateVersion,
						stateHash: current.coreOperationalRoutingStateHash
					}
				: null;
		}
		throw new InvalidReportingEventError(
			'Unsupported reporting settings event type'
		);
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
				? normalizeLegacyPaymentAmount(state.amount)
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
		if (
			event.eventType === 'reporting.core-operational-routing.changed.v1'
		) {
			const state = event.state as CoreOperationalRoutingState | null;
			await transaction.reportingSettings.upsert({
				where: { id: 'daily-summary' },
				create: {
					id: 'daily-summary',
					owner: ReportingOwner.CORE_SHADOW,
					enabled: false
				},
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
					where: { id: 'daily-summary' }
				});
			if (current.owner !== ReportingOwner.REPORTING) {
				throw new ProjectionStateConflictError(
					'Core operational routing events require Reporting ownership'
				);
			}
			await transaction.reportingSettings.update({
				where: { id: 'daily-summary' },
				data: {
					coreOperationalAlertsDestinationChatId:
						state?.coreOperationalAlertsDestinationChatId.trim() || null,
					coreOperationalAlertsThreadId:
						state?.coreOperationalAlertsThreadId ?? null,
					coreOperationalRoutingSourceAggregateVersion: new Prisma.Decimal(
						event.aggregateVersion
					),
					coreOperationalRoutingSourceSequence: new Prisma.Decimal(
						event.sourceSequence
					),
					coreOperationalRoutingStateHash: stateHash
				}
			});
			return ProjectionReceiptResult.APPLIED;
		}
		throw new InvalidReportingEventError(
			'Unsupported reporting settings event type'
		);
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
