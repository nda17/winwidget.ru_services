import { MaintenanceSchedulerService } from '@/maintenance/maintenance-scheduler.service';
import type { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import type { PrismaService } from '@/prisma.service';
import type { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import type { ConfigService } from '@nestjs/config';

describe('MaintenanceSchedulerService', () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	const createService = () => {
		const scheduledJobs = {
			recoverExpired: jest
				.fn()
				.mockResolvedValue({ requeued: 0, failed: 0 })
		} as unknown as ScheduledJobsService;
		const tasks = {
			getEventForType: jest.fn(),
			enqueueDailySummary: jest.fn().mockResolvedValue(null),
			enqueueDailyDatabaseBackup: jest.fn().mockResolvedValue(null)
		} as unknown as ScheduledTasksService;
		const prisma = {
			telegramBotSettings: {
				upsert: jest.fn().mockResolvedValue({
					dailySummaryTime: '01:50',
					databaseBackupTime: '23:59'
				})
			}
		} as unknown as PrismaService;
		const service = new MaintenanceSchedulerService(
			{ get: jest.fn() } as unknown as ConfigService,
			scheduledJobs,
			tasks,
			prisma
		);
		return { service, scheduledJobs, tasks };
	};

	it('schedules the previous Moscow calendar day with a stable period key', async () => {
		jest.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
		const { service, tasks } = createService();

		await (service as any).tick();

		expect(tasks.enqueueDailySummary).toHaveBeenCalledWith(
			{
				start: new Date('2026-07-22T21:00:00.000Z'),
				end: new Date('2026-07-23T21:00:00.000Z'),
				key: '2026-07-23'
			},
			new Date('2026-07-23T22:50:00.000Z')
		);
		expect(tasks.enqueueDailyDatabaseBackup).not.toHaveBeenCalled();
	});

	it('does not enqueue the summary before the configured Moscow time', async () => {
		jest.setSystemTime(new Date('2026-07-23T21:30:00.000Z'));
		const { service, tasks } = createService();

		await (service as any).tick();

		expect(tasks.enqueueDailySummary).not.toHaveBeenCalled();
		expect(tasks.enqueueDailyDatabaseBackup).not.toHaveBeenCalled();
	});
});
