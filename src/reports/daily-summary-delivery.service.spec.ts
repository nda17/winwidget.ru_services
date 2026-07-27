import {
	DailySummaryDeliveryService,
	ScheduledJobDispatchHandledError
} from '@/reports/daily-summary-delivery.service';
import type { DailySummaryReportService } from '@/reports/daily-summary-report.service';
import type { PrismaService } from '@/prisma.service';
import type { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import {
	TelegramApiError,
	TelegramInfoTransportService
} from '@/telegram-bot/telegram-info-transport.service';
import type { ConfigService } from '@nestjs/config';
import { ScheduledJobRunStatus } from '@prisma/client';

describe('DailySummaryDeliveryService', () => {
	const payload = {
		schemaVersion: 1 as const,
		eventType: 'report.daily-summary.requested.v1' as const,
		jobId: '11111111-1111-4111-8111-111111111111',
		periodStart: '2026-07-22T21:00:00.000Z',
		periodEnd: '2026-07-23T21:00:00.000Z'
	};

	const createService = (checkpoint: Record<string, unknown> = {}) => {
		const job = {
			id: payload.jobId,
			jobType: 'DAILY_TELEGRAM_SUMMARY',
			status: ScheduledJobRunStatus.PROCESSING,
			attempts: 1,
			input: {
				chatId: '-100123',
				messageThreadId: 42
			},
			periodStart: payload.periodStart,
			periodEnd: payload.periodEnd,
			checkpoint
		};
		const scheduledJobs = {
			claim: jest.fn().mockResolvedValue({
				state: 'claimed',
				job,
				leaseToken: '22222222-2222-4222-8222-222222222222'
			}),
			saveCheckpoint: jest.fn().mockResolvedValue(job),
			renewLease: jest.fn().mockResolvedValue(new Date()),
			completeInTransaction: jest
				.fn()
				.mockResolvedValue({ ...job, status: 'SUCCEEDED' }),
			releaseOrFail: jest.fn()
		} as unknown as ScheduledJobsService;
		const report = {
			render: jest.fn().mockResolvedValue('rendered report')
		} as unknown as DailySummaryReportService;
		const telegram = {
			sendMessage: jest.fn().mockResolvedValue(undefined)
		} as unknown as TelegramInfoTransportService;
		const transaction = {
			telegramBotSettings: {
				update: jest.fn().mockResolvedValue({})
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new DailySummaryDeliveryService(
			prisma,
			{ get: jest.fn() } as unknown as ConfigService,
			scheduledJobs,
			report,
			telegram
		);
		return {
			service,
			scheduledJobs,
			report,
			telegram,
			transaction
		};
	};

	it('reuses the persisted report text on retry instead of recalculating it', async () => {
		const { service, report, telegram, scheduledJobs, transaction } =
			createService({ text: 'stable checkpoint' });

		await service.deliver(payload, payload.jobId);

		expect(scheduledJobs.claim).toHaveBeenCalledWith(
			payload.jobId,
			expect.stringMatching(/^daily-summary:/),
			120_000,
			'DAILY_TELEGRAM_SUMMARY',
			expect.objectContaining({
				deadLetterRoutingKey: 'daily-summary-telegram.dead-letter'
			})
		);
		expect(report.render).not.toHaveBeenCalled();
		expect(scheduledJobs.saveCheckpoint).not.toHaveBeenCalled();
		expect(telegram.sendMessage).toHaveBeenCalledWith(
			'-100123',
			'stable checkpoint',
			expect.objectContaining({ messageThreadId: 42 })
		);
		expect(transaction.telegramBotSettings.update).toHaveBeenCalledWith({
			where: { id: 'singleton' },
			data: {
				dailySummaryLastSentPeriodStart: new Date(payload.periodStart),
				dailySummaryLastSentAt: expect.any(Date)
			}
		});
	});

	it('persists a delayed Outbox retry and signals the worker not to duplicate it', async () => {
		const { service, telegram, scheduledJobs } = createService({
			text: 'stable checkpoint'
		});
		(telegram.sendMessage as jest.Mock).mockRejectedValue(
			new Error('Telegram unavailable')
		);
		(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
			state: 'retry_scheduled',
			job: {
				id: payload.jobId,
				attempts: 1
			}
		});

		await expect(service.deliver(payload, payload.jobId)).rejects.toEqual(
			expect.objectContaining({
				name: ScheduledJobDispatchHandledError.name,
				state: 'retry_scheduled'
			})
		);
		expect(scheduledJobs.releaseOrFail).toHaveBeenCalledWith(
			payload.jobId,
			'22222222-2222-4222-8222-222222222222',
			expect.any(Error),
			30_000,
			expect.objectContaining({
				eventType: 'report.daily-summary.requested.v1',
				routingKey: 'report.daily-summary.requested.v1'
			}),
			expect.objectContaining({
				allowRetry: true,
				deadLetterHeaders: expect.objectContaining({
					'x-error-category': 'TRANSIENT',
					'x-error-code': 'UNCLASSIFIED'
				})
			})
		);
	});

	it('uses Telegram Retry-After when it exceeds the scheduled backoff', async () => {
		const { service, telegram, scheduledJobs } = createService({
			text: 'stable checkpoint'
		});
		const telegramError = new TelegramApiError({
			httpStatus: 429,
			description: 'Too Many Requests: retry later',
			parameters: { retry_after: 120 }
		});
		(telegram.sendMessage as jest.Mock).mockRejectedValue(telegramError);
		(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
			state: 'retry_scheduled',
			job: {
				id: payload.jobId,
				attempts: 1
			}
		});

		await expect(service.deliver(payload, payload.jobId)).rejects.toEqual(
			expect.objectContaining({
				name: ScheduledJobDispatchHandledError.name,
				state: 'retry_scheduled',
				classification: expect.objectContaining({
					category: 'RATE_LIMIT',
					normalizedCode: 'TELEGRAM_RATE_LIMIT',
					retryable: true,
					retryDelayMs: 120_000
				})
			})
		);
		expect(scheduledJobs.releaseOrFail).toHaveBeenCalledWith(
			payload.jobId,
			'22222222-2222-4222-8222-222222222222',
			telegramError,
			120_000,
			expect.any(Object),
			expect.objectContaining({
				allowRetry: true,
				deadLetterHeaders: expect.objectContaining({
					'x-error-category': 'RATE_LIMIT',
					'x-error-code': 'TELEGRAM_RATE_LIMIT',
					'x-error-retryable': true
				})
			})
		);
	});

	it.each([
		[
			'PERMANENT',
			'TELEGRAM_CHAT_NOT_FOUND',
			new TelegramApiError({
				httpStatus: 400,
				description: 'Bad Request: chat not found'
			})
		],
		[
			'AUTH_CONFIGURATION',
			'TELEGRAM_BOT_AUTHENTICATION_FAILED',
			new TelegramApiError({
				httpStatus: 401,
				description: 'Unauthorized'
			})
		]
	])(
		'fails the durable job immediately for a %s Telegram error',
		async (category, normalizedCode, telegramError) => {
			const { service, telegram, scheduledJobs } = createService({
				text: 'stable checkpoint'
			});
			(telegram.sendMessage as jest.Mock).mockRejectedValue(telegramError);
			(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
				state: 'failed',
				job: {
					id: payload.jobId,
					attempts: 1
				}
			});

			await expect(
				service.deliver(payload, payload.jobId)
			).rejects.toEqual(
				expect.objectContaining({
					name: ScheduledJobDispatchHandledError.name,
					state: 'failed',
					classification: expect.objectContaining({
						category,
						normalizedCode,
						retryable: false,
						retryDelayMs: null
					})
				})
			);
			expect(scheduledJobs.releaseOrFail).toHaveBeenCalledWith(
				payload.jobId,
				'22222222-2222-4222-8222-222222222222',
				telegramError,
				30_000,
				expect.any(Object),
				expect.objectContaining({
					allowRetry: false,
					deadLetterHeaders: expect.objectContaining({
						'x-error-category': category,
						'x-error-code': normalizedCode,
						'x-error-retryable': false
					})
				})
			);
		}
	);

	it('does not send a terminal job again after RabbitMQ redelivery', async () => {
		const { service, scheduledJobs, report, telegram } = createService();
		(scheduledJobs.claim as jest.Mock).mockResolvedValue({
			state: 'terminal',
			job: {
				id: payload.jobId,
				jobType: 'DAILY_TELEGRAM_SUMMARY',
				status: ScheduledJobRunStatus.SUCCEEDED
			}
		});

		await service.deliver(payload, payload.jobId);

		expect(report.render).not.toHaveBeenCalled();
		expect(telegram.sendMessage).not.toHaveBeenCalled();
		expect(scheduledJobs.releaseOrFail).not.toHaveBeenCalled();
	});

	it('rejects a missing job as a permanent scheduled dispatch error', async () => {
		const { service, scheduledJobs, report, telegram } = createService();
		(scheduledJobs.claim as jest.Mock).mockResolvedValue({
			state: 'not_found'
		});

		await expect(service.deliver(payload, payload.jobId)).rejects.toEqual(
			expect.objectContaining({
				name: 'ScheduledJobDispatchRejectedError'
			})
		);
		expect(report.render).not.toHaveBeenCalled();
		expect(telegram.sendMessage).not.toHaveBeenCalled();
	});

	it('rejects a period that does not match the persisted scheduled job', async () => {
		const { service, scheduledJobs, report, telegram } = createService();
		(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
			state: 'retry_scheduled',
			job: {
				id: payload.jobId,
				attempts: 1
			}
		});

		await expect(
			service.deliver(
				{
					...payload,
					periodStart: '2026-07-21T21:00:00.000Z'
				},
				payload.jobId
			)
		).rejects.toEqual(
			expect.objectContaining({
				name: ScheduledJobDispatchHandledError.name,
				state: 'retry_scheduled'
			})
		);
		expect(report.render).not.toHaveBeenCalled();
		expect(telegram.sendMessage).not.toHaveBeenCalled();
		expect(scheduledJobs.releaseOrFail).toHaveBeenCalledTimes(1);
	});

	it.each(['busy', 'not_due'] as const)(
		'acknowledges a %s duplicate through the handled scheduled-job path',
		async state => {
			const { service, scheduledJobs, report, telegram } = createService();
			(scheduledJobs.claim as jest.Mock).mockResolvedValue({
				state,
				job: {
					id: payload.jobId,
					jobType: 'DAILY_TELEGRAM_SUMMARY',
					status: ScheduledJobRunStatus.PROCESSING,
					attempts: 1
				}
			});

			await expect(
				service.deliver(payload, payload.jobId)
			).rejects.toEqual(
				expect.objectContaining({
					name: ScheduledJobDispatchHandledError.name,
					state: 'retry_scheduled'
				})
			);
			expect(report.render).not.toHaveBeenCalled();
			expect(telegram.sendMessage).not.toHaveBeenCalled();
			expect(scheduledJobs.releaseOrFail).not.toHaveBeenCalled();
		}
	);

	it('renews the lease while a report is still rendering', async () => {
		jest.useFakeTimers();
		try {
			const { service, scheduledJobs, report, telegram } = createService();
			let resolveReport!: (value: string) => void;
			(report.render as jest.Mock).mockReturnValue(
				new Promise<string>(resolve => {
					resolveReport = resolve;
				})
			);

			const delivery = service.deliver(payload, payload.jobId);
			await Promise.resolve();
			await Promise.resolve();
			await jest.advanceTimersByTimeAsync(30_000);

			expect(scheduledJobs.renewLease).toHaveBeenCalledTimes(1);
			resolveReport('rendered after lease heartbeat');
			await delivery;

			expect(scheduledJobs.renewLease).toHaveBeenCalledTimes(2);
			expect(telegram.sendMessage).toHaveBeenCalledWith(
				'-100123',
				'rendered after lease heartbeat',
				expect.objectContaining({
					messageThreadId: 42,
					signal: expect.any(AbortSignal)
				})
			);
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not call Telegram after losing the lease during report rendering', async () => {
		jest.useFakeTimers();
		try {
			const { service, scheduledJobs, report, telegram } = createService();
			let resolveReport!: (value: string) => void;
			(report.render as jest.Mock).mockReturnValue(
				new Promise<string>(resolve => {
					resolveReport = resolve;
				})
			);
			(scheduledJobs.renewLease as jest.Mock).mockResolvedValueOnce(null);
			(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
				state: 'lost'
			});

			const delivery = service.deliver(payload, payload.jobId);
			await Promise.resolve();
			await Promise.resolve();
			await jest.advanceTimersByTimeAsync(30_000);
			resolveReport('must not be sent');

			await expect(delivery).rejects.toThrow(
				'Daily summary lease renewal failed'
			);
			expect(telegram.sendMessage).not.toHaveBeenCalled();
		} finally {
			jest.useRealTimers();
		}
	});
});
