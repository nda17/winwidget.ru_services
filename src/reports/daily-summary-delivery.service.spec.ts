import {
	DailySummaryDeliveryService,
	ScheduledJobDispatchHandledError
} from '@/reports/daily-summary-delivery.service';
import type { DailySummaryReportService } from '@/reports/daily-summary-report.service';
import type { PrismaService } from '@/prisma.service';
import type { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
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
	const leaseToken = '22222222-2222-4222-8222-222222222222';

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
				leaseToken
			}),
			saveCheckpoint: jest.fn().mockResolvedValue(job),
			renewLease: jest.fn().mockResolvedValue(new Date()),
			awaitExternalDeliveryInTransaction: jest.fn().mockResolvedValue(job),
			releaseOrFail: jest.fn().mockResolvedValue({
				state: 'retry_scheduled',
				job
			})
		} as unknown as ScheduledJobsService;
		const report = {
			render: jest.fn().mockResolvedValue('rendered report')
		} as unknown as DailySummaryReportService;
		const transaction = {
			outboxEvent: {
				createMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new DailySummaryDeliveryService(
			prisma,
			{ get: jest.fn() } as unknown as ConfigService,
			scheduledJobs,
			report
		);

		return {
			service,
			job,
			scheduledJobs,
			report,
			transaction
		};
	};

	it('reuses the report checkpoint and transactionally dispatches physical delivery', async () => {
		const { service, report, scheduledJobs, transaction } = createService({
			text: 'stable checkpoint'
		});

		await service.deliver(payload, payload.jobId);

		expect(report.render).not.toHaveBeenCalled();
		expect(scheduledJobs.saveCheckpoint).not.toHaveBeenCalled();
		expect(
			scheduledJobs.awaitExternalDeliveryInTransaction
		).toHaveBeenCalledWith(
			transaction,
			payload.jobId,
			leaseToken,
			payload.jobId,
			{
				text: 'stable checkpoint',
				deliveryEventId: payload.jobId
			}
		);
		const outbox =
			transaction.outboxEvent.createMany.mock.calls[0][0].data;
		expect(outbox).toEqual(
			expect.objectContaining({
				messageId: payload.jobId,
				eventType: 'notification.daily-summary.telegram.requested.v1',
				routingKey: 'notification.daily-summary.telegram.requested.v1'
			})
		);
		expect(outbox.payload).toEqual({
			schemaVersion: 1,
			eventType: 'notification.daily-summary.telegram.requested.v1',
			reference: {
				type: 'daily-summary-job',
				id: payload.jobId
			},
			destination: {
				telegramChatId: '-100123',
				messageThreadId: 42
			},
			content: { text: 'stable checkpoint' }
		});
	});

	it('renders and persists the report before external dispatch', async () => {
		const { service, report, scheduledJobs } = createService();

		await service.deliver(payload, payload.jobId);

		expect(report.render).toHaveBeenCalledWith(
			new Date(payload.periodStart),
			new Date(payload.periodEnd)
		);
		expect(scheduledJobs.saveCheckpoint).toHaveBeenCalledWith(
			payload.jobId,
			leaseToken,
			{ text: 'rendered report' }
		);
		expect(
			scheduledJobs.awaitExternalDeliveryInTransaction
		).toHaveBeenCalledWith(
			expect.any(Object),
			payload.jobId,
			leaseToken,
			payload.jobId,
			{
				text: 'rendered report',
				deliveryEventId: payload.jobId
			}
		);
	});

	it('acknowledges a duplicate already waiting for the same delivery outcome', async () => {
		const { service, job, scheduledJobs, report } = createService();
		(scheduledJobs.claim as jest.Mock).mockResolvedValue({
			state: 'busy',
			job: {
				...job,
				checkpoint: {
					text: 'stable checkpoint',
					deliveryEventId: payload.jobId
				}
			}
		});

		await expect(
			service.deliver(payload, payload.jobId)
		).resolves.toBeUndefined();
		expect(report.render).not.toHaveBeenCalled();
		expect(
			scheduledJobs.awaitExternalDeliveryInTransaction
		).not.toHaveBeenCalled();
		expect(scheduledJobs.releaseOrFail).not.toHaveBeenCalled();
	});

	it('keeps unrelated busy jobs on the handled retry path', async () => {
		const { service, job, scheduledJobs } = createService();
		(scheduledJobs.claim as jest.Mock).mockResolvedValue({
			state: 'busy',
			job: {
				...job,
				checkpoint: {
					text: 'stable checkpoint',
					deliveryEventId: 'another-event'
				}
			}
		});

		await expect(service.deliver(payload, payload.jobId)).rejects.toEqual(
			expect.objectContaining({
				name: ScheduledJobDispatchHandledError.name,
				state: 'retry_scheduled'
			})
		);
	});

	it('does not dispatch a terminal job again after RabbitMQ redelivery', async () => {
		const { service, job, scheduledJobs, report, transaction } =
			createService();
		(scheduledJobs.claim as jest.Mock).mockResolvedValue({
			state: 'terminal',
			job: {
				...job,
				status: ScheduledJobRunStatus.SUCCEEDED
			}
		});

		await service.deliver(payload, payload.jobId);

		expect(report.render).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.createMany).not.toHaveBeenCalled();
	});

	it('persists a delayed retry when preparation fails before dispatch', async () => {
		const { service, scheduledJobs, report, transaction } =
			createService();
		(report.render as jest.Mock).mockRejectedValue(
			new Error('Report query failed')
		);

		await expect(service.deliver(payload, payload.jobId)).rejects.toEqual(
			expect.objectContaining({
				name: ScheduledJobDispatchHandledError.name,
				state: 'retry_scheduled'
			})
		);
		expect(scheduledJobs.releaseOrFail).toHaveBeenCalledWith(
			payload.jobId,
			leaseToken,
			expect.objectContaining({ message: 'Report query failed' }),
			30_000,
			expect.any(Object),
			expect.objectContaining({
				allowRetry: true
			})
		);
		expect(transaction.outboxEvent.createMany).not.toHaveBeenCalled();
	});

	it('does not enqueue delivery after losing the durable-job lease', async () => {
		const { service, scheduledJobs, transaction } = createService({
			text: 'stable checkpoint'
		});
		(scheduledJobs.renewLease as jest.Mock).mockResolvedValue(null);
		(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
			state: 'lost'
		});

		await expect(service.deliver(payload, payload.jobId)).rejects.toThrow(
			'Daily summary lease was lost before Telegram delivery'
		);
		expect(transaction.outboxEvent.createMany).not.toHaveBeenCalled();
	});
});
