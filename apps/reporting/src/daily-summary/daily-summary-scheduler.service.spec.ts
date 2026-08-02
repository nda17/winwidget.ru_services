import { DailySummarySchedulerService } from './daily-summary-scheduler.service';

describe('DailySummarySchedulerService handoff safety', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('does not recreate the last period already delivered by Core', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-01T07:00:00.000Z'));
		const prisma = {
			reportRun: { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
		};
		const service = new DailySummarySchedulerService(
			prisma as never,
			{} as never,
			{} as never,
			{ increment: jest.fn() } as never,
			{} as never
		);

		await (
			service as unknown as {
				enqueueCurrentPeriod(settings: {
					destinationChatId: string;
					messageThreadId: number;
					scheduleTime: string;
					timezone: string;
					lastSuccessfulPeriodStart: Date | null;
				}): Promise<void>;
			}
		).enqueueCurrentPeriod({
			destinationChatId: '-100123',
			messageThreadId: 42,
			scheduleTime: '01:50',
			timezone: 'Europe/Moscow',
			lastSuccessfulPeriodStart: new Date('2026-07-30T21:00:00.000Z')
		});

		expect(prisma.reportRun.createMany).not.toHaveBeenCalled();
	});

	it('creates the next period after the projected successful Core period', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-01T07:00:00.000Z'));
		const prisma = {
			reportRun: { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
		};
		const metrics = { increment: jest.fn() };
		const service = new DailySummarySchedulerService(
			prisma as never,
			{} as never,
			{} as never,
			metrics as never,
			{} as never
		);

		await (
			service as unknown as {
				enqueueCurrentPeriod(settings: {
					destinationChatId: string;
					messageThreadId: number;
					scheduleTime: string;
					timezone: string;
					lastSuccessfulPeriodStart: Date | null;
				}): Promise<void>;
			}
		).enqueueCurrentPeriod({
			destinationChatId: '-100123',
			messageThreadId: 42,
			scheduleTime: '01:50',
			timezone: 'Europe/Moscow',
			lastSuccessfulPeriodStart: new Date('2026-07-29T21:00:00.000Z')
		});

		expect(prisma.reportRun.createMany).toHaveBeenCalledWith({
			data: expect.objectContaining({
				periodKey: 'Europe/Moscow:2026-07-31',
				periodStart: new Date('2026-07-30T21:00:00.000Z'),
				periodEnd: new Date('2026-07-31T21:00:00.000Z')
			}),
			skipDuplicates: true
		});
		expect(metrics.increment).toHaveBeenCalledWith(
			'report_runs_created_total'
		);
	});
});
