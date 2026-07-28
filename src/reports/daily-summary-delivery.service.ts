import { DailySummaryReportService } from '@/reports/daily-summary-report.service';
import { DailySummaryRequestedEventPayload } from '@/messaging/daily-summary-event';
import {
	classifyIntegrationError,
	IntegrationErrorClassification
} from '@/messaging/integration-error-classifier';
import {
	DAILY_SUMMARY_EVENT_TYPE,
	DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	getDeadLetterRoutingKey,
	MESSAGING_ROUTING_KEYS,
	RETRY_DELAYS_MS
} from '@/messaging/messaging.constants';
import { createMessagingHeaders } from '@/messaging/messaging-context';
import {
	DailySummaryTelegramNotificationRequestedEventPayload,
	serializeNotificationDeliveryEvent
} from '@/messaging/notification-delivery-event';
import { PrismaService } from '@/prisma.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import {
	SCHEDULED_JOB_TYPES,
	ScheduledJobOutboxEvent,
	ScheduledJobRunView
} from '@/scheduled-jobs/scheduled-jobs.types';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ScheduledJobRunStatus } from '@prisma/client';
import { hostname } from 'node:os';

export class ScheduledJobDispatchHandledError extends Error {
	constructor(
		readonly state: 'retry_scheduled' | 'failed',
		readonly job: ScheduledJobRunView,
		message: string,
		readonly classification?: IntegrationErrorClassification
	) {
		super(message);
		this.name = ScheduledJobDispatchHandledError.name;
	}
}

export class ScheduledJobDispatchRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = ScheduledJobDispatchRejectedError.name;
	}
}

interface DailySummaryJobInput {
	chatId: string;
	messageThreadId: number;
}

interface DailySummaryCheckpoint {
	text?: string;
	deliveryEventId?: string;
}

const DAILY_SUMMARY_OUTBOX_EVENT: ScheduledJobOutboxEvent = {
	eventType: DAILY_SUMMARY_EVENT_TYPE,
	routingKey: MESSAGING_ROUTING_KEYS['daily-summary-telegram'],
	deadLetterRoutingKey: getDeadLetterRoutingKey('daily-summary-telegram'),
	payload: {
		schemaVersion: 1,
		eventType: DAILY_SUMMARY_EVENT_TYPE
	}
};

@Injectable()
export class DailySummaryDeliveryService {
	private readonly workerId = `daily-summary:${hostname()}:${process.pid}`;

	constructor(
		private readonly prisma: PrismaService,
		private readonly configService: ConfigService,
		private readonly scheduledJobs: ScheduledJobsService,
		private readonly report: DailySummaryReportService
	) {}

	async deliver(
		payload: DailySummaryRequestedEventPayload,
		eventId: string
	): Promise<void> {
		if (payload.jobId !== eventId) {
			throw new Error(
				`Daily summary eventId mismatch eventId=${eventId} jobId=${payload.jobId}`
			);
		}
		const claim = await this.scheduledJobs.claim(
			payload.jobId,
			this.workerId,
			this.getLeaseMs(),
			SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY,
			DAILY_SUMMARY_OUTBOX_EVENT
		);
		if (claim.state === 'not_found') {
			throw new ScheduledJobDispatchRejectedError(
				`Daily summary job not found: ${payload.jobId}`
			);
		}
		if (claim.job.jobType !== SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY) {
			throw new ScheduledJobDispatchRejectedError(
				`Unexpected daily summary job type: ${claim.job.jobType}`
			);
		}
		if (claim.state === 'terminal') {
			if (claim.job.status === ScheduledJobRunStatus.FAILED) {
				throw new ScheduledJobDispatchHandledError(
					'failed',
					claim.job,
					claim.job.lastError || 'Daily summary job failed'
				);
			}
			return;
		}
		if (claim.state === 'busy' || claim.state === 'not_due') {
			const checkpoint = this.parseCheckpoint(claim.job.checkpoint);
			if (
				claim.state === 'busy' &&
				checkpoint.deliveryEventId === eventId
			) {
				return;
			}
			throw new ScheduledJobDispatchHandledError(
				'retry_scheduled',
				claim.job,
				`Daily summary job is ${claim.state}`
			);
		}
		if (claim.state !== 'claimed') {
			throw new Error(
				`Daily summary job cannot be claimed: ${claim.state}`
			);
		}

		const lease = this.startLeaseRenewal(claim.job.id, claim.leaseToken);
		try {
			const input = this.parseInput(claim.job.input);
			const checkpoint = this.parseCheckpoint(claim.job.checkpoint);
			const periodStart = this.parsePeriodBoundary(
				claim.job.periodStart,
				'daily summary job periodStart'
			);
			const periodEnd = this.parsePeriodBoundary(
				claim.job.periodEnd,
				'daily summary job periodEnd'
			);
			if (
				periodEnd <= periodStart ||
				periodStart.toISOString() !== payload.periodStart ||
				periodEnd.toISOString() !== payload.periodEnd
			) {
				throw new Error(
					'Daily summary event period does not match the scheduled job'
				);
			}

			let text = checkpoint.text;
			if (!text) {
				text = await this.report.render(periodStart, periodEnd);
				lease.assertOwned();
				const saved = await this.scheduledJobs.saveCheckpoint(
					claim.job.id,
					claim.leaseToken,
					{ text }
				);
				if (!saved) {
					throw new Error(
						'Daily summary lease was lost before checkpoint'
					);
				}
			}

			const renewed = await this.scheduledJobs.renewLease(
				claim.job.id,
				claim.leaseToken,
				this.getLeaseMs()
			);
			if (!renewed) {
				throw new Error(
					'Daily summary lease was lost before Telegram delivery'
				);
			}
			lease.assertOwned();
			const deliveryPayload: DailySummaryTelegramNotificationRequestedEventPayload =
				{
					schemaVersion: 1,
					eventType: DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
					reference: {
						type: 'daily-summary-job',
						id: claim.job.id
					},
					destination: {
						telegramChatId: input.chatId,
						messageThreadId: input.messageThreadId
					},
					content: { text }
				};
			const dispatched = await this.prisma.$transaction(
				async transaction => {
					const job =
						await this.scheduledJobs.awaitExternalDeliveryInTransaction(
							transaction,
							claim.job.id,
							claim.leaseToken,
							eventId,
							{ text, deliveryEventId: eventId }
						);
					if (!job) return null;
					await transaction.outboxEvent.createMany({
						data: {
							messageId: eventId,
							deduplicationKey: `notification-dispatch:${eventId}:daily-summary-delivery-telegram:v1`,
							eventType: DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
							routingKey:
								MESSAGING_ROUTING_KEYS['daily-summary-delivery-telegram'],
							payload: serializeNotificationDeliveryEvent(deliveryPayload),
							headers: createMessagingHeaders({
								messageId: eventId,
								causationId: eventId
							})
						},
						skipDuplicates: true
					});
					return job;
				}
			);
			if (!dispatched) {
				throw new Error(
					'Daily summary lease was lost before notification dispatch'
				);
			}
		} catch (error) {
			lease.stop();
			if (error instanceof ScheduledJobDispatchHandledError) throw error;
			const classification = classifyIntegrationError(
				'daily-summary-telegram',
				error
			);
			const scheduledRetryDelay =
				RETRY_DELAYS_MS[
					Math.min(
						Math.max(claim.job.attempts - 1, 0),
						RETRY_DELAYS_MS.length - 1
					)
				];
			const retryDelay = Math.max(
				scheduledRetryDelay,
				classification.retryDelayMs || 0
			);
			const result = await this.scheduledJobs.releaseOrFail(
				claim.job.id,
				claim.leaseToken,
				error,
				retryDelay,
				DAILY_SUMMARY_OUTBOX_EVENT,
				{
					allowRetry: classification.retryable,
					deadLetterHeaders: {
						'x-error-category': classification.category,
						'x-error-code': classification.normalizedCode,
						'x-safe-reason': classification.safeReason,
						'x-error-retryable': classification.retryable,
						'x-classification-version':
							classification.classificationVersion,
						...(claim.job.startedAt
							? { 'x-first-failed-at': claim.job.startedAt }
							: {})
					}
				}
			);
			if (result.state === 'lost') throw error;
			throw new ScheduledJobDispatchHandledError(
				result.state,
				result.job,
				error instanceof Error ? error.message : String(error),
				classification
			);
		} finally {
			lease.stop();
		}
	}

	private parseInput(value: Prisma.JsonValue): DailySummaryJobInput {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Daily summary job input is invalid');
		}
		const chatId = value.chatId;
		const messageThreadId = value.messageThreadId;
		if (
			typeof chatId !== 'string' ||
			!chatId.trim() ||
			typeof messageThreadId !== 'number' ||
			!Number.isInteger(messageThreadId) ||
			messageThreadId < 1
		) {
			throw new Error('Daily summary Telegram destination is invalid');
		}
		return { chatId: chatId.trim(), messageThreadId };
	}

	private parseCheckpoint(
		value: Prisma.JsonValue
	): DailySummaryCheckpoint {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return {};
		}
		return {
			...(typeof value.text === 'string' && value.text
				? { text: value.text }
				: {}),
			...(typeof value.deliveryEventId === 'string' &&
			value.deliveryEventId
				? { deliveryEventId: value.deliveryEventId }
				: {})
		};
	}

	private parsePeriodBoundary(value: string | null, label: string): Date {
		const date = value ? new Date(value) : null;
		if (!date || Number.isNaN(date.getTime())) {
			throw new Error(`${label} is invalid`);
		}
		return date;
	}

	private startLeaseRenewal(
		jobId: string,
		leaseToken: string
	): {
		signal: AbortSignal;
		assertOwned: () => void;
		stop: () => void;
	} {
		const controller = new AbortController();
		let renewing = false;
		let stopped = false;
		const abort = (error: unknown) => {
			if (stopped || controller.signal.aborted) return;
			controller.abort(
				error instanceof Error ? error : new Error(String(error))
			);
		};
		const timer = setInterval(async () => {
			if (renewing || stopped || controller.signal.aborted) return;
			renewing = true;
			try {
				const renewed = await this.scheduledJobs.renewLease(
					jobId,
					leaseToken,
					this.getLeaseMs()
				);
				if (!renewed) {
					abort(new Error('Daily summary lease renewal failed'));
				}
			} catch (error) {
				abort(error);
			} finally {
				renewing = false;
			}
		}, this.getLeaseRenewInterval());
		timer.unref();
		return {
			signal: controller.signal,
			assertOwned: () => {
				if (!controller.signal.aborted) return;
				throw controller.signal.reason instanceof Error
					? controller.signal.reason
					: new Error('Daily summary lease was lost');
			},
			stop: () => {
				stopped = true;
				clearInterval(timer);
			}
		};
	}

	private getLeaseMs(): number {
		const value = Number(
			this.configService.get<string>('SCHEDULED_JOB_LEASE_MS') || 120_000
		);
		return Number.isInteger(value) && value >= 30_000
			? Math.min(value, 60 * 60 * 1000)
			: 120_000;
	}

	private getLeaseRenewInterval(): number {
		const value = Number(
			this.configService.get<string>(
				'SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS'
			) || 30_000
		);
		const max = Math.max(5_000, Math.floor(this.getLeaseMs() / 2));
		return Number.isInteger(value) && value >= 5_000
			? Math.min(value, max)
			: Math.min(30_000, max);
	}
}
