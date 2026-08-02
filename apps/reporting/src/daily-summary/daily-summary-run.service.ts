import { createReportingCorrelationId } from '../common/reporting-context';
import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import { DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE } from '../messaging/reporting-messaging.constants';
import { NotificationDeliveryOutcomeEvent } from '../projections/reporting-event.contract';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import { DailySummaryReportService } from './daily-summary-report.service';
import { Injectable, Logger } from '@nestjs/common';
import {
	Prisma,
	ReportRun,
	ReportRunStatus,
	ReportingConsumerFailureStatus,
	ReportingConsumerReceiptStatus,
	ReportingOutboxExchange,
	ReportingOutboxStatus
} from '@prisma/reporting-client';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const RUN_LEASE_MS = 5 * 60 * 1000;
const RUN_RENEW_INTERVAL_MS = 60_000;
const MAX_RENDER_ATTEMPTS = 5;

interface ConsumerReceiptCompletion {
	eventId: string;
	consumer: string;
	lockToken: string;
}

type OutcomeApplyResult = 'completed' | 'failed' | 'ignored' | 'duplicate';

@Injectable()
export class DailySummaryRunService {
	private readonly logger = new Logger(DailySummaryRunService.name);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;

	constructor(
		private readonly prisma: ReportingPrismaService,
		private readonly report: DailySummaryReportService,
		private readonly metrics: ReportingMetricsService
	) {}

	async recoverExpiredRuns(): Promise<number> {
		const now = new Date();
		const recovered = await this.prisma.reportRun.updateMany({
			where: {
				status: ReportRunStatus.PROCESSING,
				leaseExpiresAt: { lte: now }
			},
			data: {
				status: ReportRunStatus.PENDING,
				checkpoint: 'RECOVERED_AFTER_EXPIRED_LEASE',
				availableAt: now,
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null
			}
		});
		if (recovered.count) {
			this.metrics.increment(
				'report_runs_recovered_total',
				recovered.count
			);
		}
		return recovered.count;
	}

	async processNextPendingRun(): Promise<boolean> {
		const candidate = await this.prisma.reportRun.findFirst({
			where: {
				status: ReportRunStatus.PENDING,
				availableAt: { lte: new Date() }
			},
			orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
			select: { id: true }
		});
		if (!candidate) return false;
		const run = await this.claim(candidate.id);
		if (!run) return false;
		await this.renderAndDispatch(run);
		return true;
	}

	async applyOutcome(
		outcome: NotificationDeliveryOutcomeEvent,
		outcomeEventId: string,
		completion: ConsumerReceiptCompletion
	): Promise<void> {
		const result = await this.prisma.$transaction(async transaction => {
			if (
				outcome.sourceKind !== 'daily-summary-delivery-telegram' ||
				outcome.reference.type !== 'daily-summary-job'
			) {
				await this.completeConsumerReceipt(transaction, completion);
				return 'ignored' as const;
			}
			const run = await transaction.reportRun.findFirst({
				where: {
					requestEventId: outcome.sourceEventId,
					id: outcome.reference.id
				}
			});
			if (!run) {
				// During shadow mode the monolith still emits valid outcomes on the
				// shared routing key. They are outside Reporting ownership and are
				// acknowledged without retry or DLQ pollution.
				await this.completeConsumerReceipt(transaction, completion);
				return 'ignored' as const;
			}
			const canApplyDelivered =
				outcome.status === 'DELIVERED' &&
				(run.status === ReportRunStatus.WAITING_DELIVERY ||
					run.status === ReportRunStatus.FAILED);
			const canApplyFailed =
				outcome.status === 'FAILED' &&
				run.status === ReportRunStatus.WAITING_DELIVERY;
			if (!canApplyDelivered && !canApplyFailed) {
				await this.completeConsumerReceipt(transaction, completion);
				return 'duplicate' as const;
			}
			const now = new Date();
			if (outcome.status === 'DELIVERED') {
				const completed = await transaction.reportRun.updateMany({
					where: {
						id: run.id,
						status: {
							in: [
								ReportRunStatus.WAITING_DELIVERY,
								ReportRunStatus.FAILED
							]
						},
						requestEventId: outcome.sourceEventId
					},
					data: {
						status: ReportRunStatus.COMPLETED,
						checkpoint: 'DELIVERY_CONFIRMED',
						outcomeEventId,
						completedAt: now,
						failureCode: null,
						failureReason: null
					}
				});
				if (completed.count !== 1) {
					const current = await transaction.reportRun.findUnique({
						where: { id: run.id },
						select: { status: true }
					});
					if (current?.status === ReportRunStatus.COMPLETED) {
						await this.completeConsumerReceipt(transaction, completion);
						return 'duplicate' as const;
					}
					throw new Error('Report run outcome CAS was lost');
				}
				await transaction.reportingSettings.updateMany({
					where: {
						id: 'daily-summary',
						OR: [
							{ lastSuccessfulPeriodStart: null },
							{ lastSuccessfulPeriodStart: { lte: run.periodStart } }
						]
					},
					data: {
						lastSuccessfulPeriodStart: run.periodStart,
						lastSuccessfulAt: now
					}
				});
				await this.completeConsumerReceipt(transaction, completion);
				return 'completed' as const;
			}
			const code = outcome.failure?.normalizedCode || 'DELIVERY_FAILED';
			const reason = outcome.failure?.safeReason || 'Delivery failed';
			const failed = await transaction.reportRun.updateMany({
				where: {
					id: run.id,
					status: ReportRunStatus.WAITING_DELIVERY,
					requestEventId: outcome.sourceEventId
				},
				data: {
					status: ReportRunStatus.FAILED,
					checkpoint: 'DELIVERY_FAILED',
					outcomeEventId,
					completedAt: now,
					failureCode: code.slice(0, 255),
					failureReason: reason.slice(0, 2000)
				}
			});
			if (failed.count !== 1) {
				const current = await transaction.reportRun.findUnique({
					where: { id: run.id },
					select: { status: true }
				});
				if (
					current?.status === ReportRunStatus.FAILED ||
					current?.status === ReportRunStatus.COMPLETED
				) {
					await this.completeConsumerReceipt(transaction, completion);
					return 'duplicate' as const;
				}
				throw new Error('Report run outcome CAS was lost');
			}
			await transaction.reportingSettings.updateMany({
				where: {
					id: 'daily-summary',
					OR: [
						{ lastFailedPeriodStart: null },
						{ lastFailedPeriodStart: { lte: run.periodStart } }
					]
				},
				data: {
					lastFailedPeriodStart: run.periodStart,
					lastFailedAt: now,
					lastFailureCode: code.slice(0, 255),
					lastFailureReason: reason.slice(0, 2000)
				}
			});
			await this.completeConsumerReceipt(transaction, completion);
			return 'failed' as const;
		});
		this.recordOutcomeMetric(result);
	}

	private async claim(id: string): Promise<ReportRun | null> {
		const now = new Date();
		const lockToken = randomUUID();
		const claimed = await this.prisma.reportRun.updateMany({
			where: {
				id,
				status: ReportRunStatus.PENDING,
				availableAt: { lte: now }
			},
			data: {
				status: ReportRunStatus.PROCESSING,
				checkpoint: 'RENDERING',
				attempts: { increment: 1 },
				lockedAt: now,
				lockedBy: this.workerId,
				lockToken,
				leaseExpiresAt: new Date(now.getTime() + RUN_LEASE_MS)
			}
		});
		if (claimed.count !== 1) return null;
		const run = await this.prisma.reportRun.findUnique({ where: { id } });
		return run?.lockToken === lockToken ? run : null;
	}

	private async renderAndDispatch(run: ReportRun): Promise<void> {
		if (!run.lockToken)
			throw new Error('Claimed report run has no lock token');
		let leaseLost = false;
		const renewal = setInterval(() => {
			void this.renew(run.id, run.lockToken!)
				.then(owned => {
					if (!owned) leaseLost = true;
				})
				.catch(error => {
					leaseLost = true;
					this.metrics.increment('report_run_lease_renew_failures_total');
					this.logger.warn(
						`Report run lease renewal failed runId=${run.id}: ${this.error(error)}`
					);
				});
		}, RUN_RENEW_INTERVAL_MS);
		renewal.unref();
		try {
			const text = await this.report.render(
				run.periodStart,
				run.periodEnd
			);
			if (leaseLost)
				throw new Error('Report run lease was lost while rendering');
			const sha256 = createHash('sha256').update(text).digest('hex');
			const eventId = run.id;
			const correlationId = createReportingCorrelationId();
			const payload = {
				schemaVersion: 1,
				eventType: DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE,
				reference: { type: 'daily-summary-job', id: run.id },
				destination: {
					telegramChatId: run.destinationChatId,
					messageThreadId: run.messageThreadId
				},
				content: { text }
			} as const;
			await this.prisma.$transaction(async transaction => {
				const dispatched = await transaction.reportRun.updateMany({
					where: {
						id: run.id,
						status: ReportRunStatus.PROCESSING,
						lockedBy: this.workerId,
						lockToken: run.lockToken
					},
					data: {
						status: ReportRunStatus.WAITING_DELIVERY,
						checkpoint: 'DELIVERY_REQUESTED',
						messageText: text,
						messageSha256: sha256,
						requestEventId: eventId,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null
					}
				});
				if (dispatched.count !== 1) {
					throw new Error('Report run lease was lost before dispatch');
				}
				await transaction.reportingOutboxEvent.create({
					data: {
						messageId: eventId,
						deduplicationKey: `notification-dispatch:${eventId}:daily-summary-delivery-telegram:v1`,
						exchange: ReportingOutboxExchange.EVENTS,
						eventType: DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE,
						routingKey: DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE,
						payload,
						headers: {
							'x-correlation-id': correlationId,
							'x-causation-id': eventId
						},
						status: ReportingOutboxStatus.PENDING
					}
				});
			});
			this.metrics.increment('report_runs_dispatched_total');
		} catch (error) {
			await this.releaseOrFail(run, error);
		} finally {
			clearInterval(renewal);
		}
	}

	private async renew(id: string, lockToken: string): Promise<boolean> {
		const renewed = await this.prisma.reportRun.updateMany({
			where: {
				id,
				status: ReportRunStatus.PROCESSING,
				lockedBy: this.workerId,
				lockToken
			},
			data: { leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS) }
		});
		return renewed.count === 1;
	}

	private async releaseOrFail(
		run: ReportRun,
		error: unknown
	): Promise<void> {
		const terminal = run.attempts >= MAX_RENDER_ATTEMPTS;
		const reason = this.error(error).slice(0, 2000);
		const now = new Date();
		await this.prisma.$transaction(async transaction => {
			const updated = await transaction.reportRun.updateMany({
				where: {
					id: run.id,
					status: ReportRunStatus.PROCESSING,
					lockedBy: this.workerId,
					lockToken: run.lockToken
				},
				data: {
					status: terminal
						? ReportRunStatus.FAILED
						: ReportRunStatus.PENDING,
					checkpoint: terminal ? 'RENDER_FAILED' : 'RENDER_RETRY',
					availableAt: new Date(
						now.getTime() + Math.min(300_000, 30_000 * run.attempts)
					),
					failureCode: terminal ? 'RENDER_FAILED' : null,
					failureReason: terminal ? reason : null,
					completedAt: terminal ? now : null,
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null
				}
			});
			if (updated.count !== 1) return;
			if (terminal) {
				await transaction.reportingSettings.updateMany({
					where: {
						id: 'daily-summary',
						OR: [
							{ lastFailedPeriodStart: null },
							{ lastFailedPeriodStart: { lte: run.periodStart } }
						]
					},
					data: {
						lastFailedPeriodStart: run.periodStart,
						lastFailedAt: now,
						lastFailureCode: 'RENDER_FAILED',
						lastFailureReason: reason
					}
				});
			}
		});
		this.metrics.increment(
			terminal ? 'report_runs_failed_total' : 'report_runs_retried_total'
		);
		this.logger.warn(
			`Daily Summary render ${terminal ? 'failed' : 'rescheduled'} runId=${run.id}: ${reason}`
		);
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
			throw new Error('Outcome consumer receipt lease was lost');
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

	private recordOutcomeMetric(result: OutcomeApplyResult): void {
		this.metrics.increment(`delivery_outcomes_${result}_total`);
	}

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
