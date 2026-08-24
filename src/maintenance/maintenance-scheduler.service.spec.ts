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

	const createService = (databaseBackupTime = '23:59') => {
		const scheduledJobs = {
			recoverExpired: jest
				.fn()
				.mockResolvedValue({ requeued: 0, failed: 0 })
		} as unknown as ScheduledJobsService;
		const tasks = {
			getEventForType: jest.fn(),
			enqueueDailyDatabaseBackups: jest.fn().mockResolvedValue(null)
		} as unknown as ScheduledTasksService;
		const prisma = {
			telegramBotSettings: {
				upsert: jest.fn().mockResolvedValue({
					databaseBackupTime
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

	it('does not enqueue backups before the configured Moscow time', async () => {
		jest.setSystemTime(new Date('2026-07-23T21:30:00.000Z'));
		const { service, tasks } = createService();

		await (service as any).tick();

		expect(tasks.enqueueDailyDatabaseBackups).not.toHaveBeenCalled();
	});

	it('enqueues all daily database jobs through one task boundary', async () => {
		jest.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
		const { service, tasks } = createService('01:45');
		(tasks.enqueueDailyDatabaseBackups as jest.Mock).mockResolvedValue({
			core: {
				created: true,
				job: { id: '11111111-1111-4111-8111-111111111111' }
			},
			notificationDelivery: {
				created: true,
				job: { id: '22222222-2222-4222-8222-222222222222' }
			},
			campaigns: {
				created: true,
				job: { id: '33333333-3333-4333-8333-333333333333' }
			},
			reporting: {
				created: true,
				job: { id: '44444444-4444-4444-8444-444444444444' }
			},
			widgets: {
				created: true,
				job: { id: '55555555-5555-4555-8555-555555555555' }
			},
			billing: {
				created: true,
				job: { id: '66666666-6666-4666-8666-666666666666' }
			},
			identity: {
				created: true,
				job: { id: '77777777-7777-4777-8777-777777777777' }
			},
			platform: {
				created: true,
				job: { id: '88888888-8888-4888-8888-888888888888' }
			},
			support: {
				created: true,
				job: { id: '99999999-9999-4999-8999-999999999999' }
			}
		});

		await (service as any).tick();

		expect(tasks.enqueueDailyDatabaseBackups).toHaveBeenCalledWith(
			{
				start: new Date('2026-07-22T21:00:00.000Z'),
				end: new Date('2026-07-23T21:00:00.000Z'),
				key: '2026-07-23'
			},
			new Date('2026-07-23T22:45:00.000Z')
		);
	});
});
