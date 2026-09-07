import {
	DATABASE_BACKUP_DELAY_MINUTES,
	DATABASE_BACKUP_TARGETS,
	type EnqueueScheduledJobInput
} from '../scheduled-jobs/scheduled-jobs.types';
import { MaintenanceSchedulerService } from './maintenance-scheduler.service';

const fixture = (time = '02:00') => {
	const settings = {
		databaseBackupEnabled: true,
		dailySummaryChatId: 'test-backup-channel',
		databaseBackupThreadId: 1,
		databaseBackupTime: time
	};
	const jobs = new Map<string, EnqueueScheduledJobInput>();
	const enqueueUnique = jest.fn(
		async (input: EnqueueScheduledJobInput) => {
			if (!jobs.has(input.scheduleKey)) jobs.set(input.scheduleKey, input);
		}
	);
	const alerts = { resolve: jest.fn(), record: jest.fn() };
	const scheduler = new MaintenanceSchedulerService(
		{ workerEnabled: true } as never,
		{
			telegramBotSettings: { upsert: jest.fn(async () => settings) }
		} as never,
		{ enqueueUnique } as never,
		alerts as never
	);
	return { scheduler, settings, jobs, enqueueUnique, alerts };
};

describe('MaintenanceSchedulerService backup periods', () => {
	it('preserves the nine existing offsets and schedules every target once due', async () => {
		const original = {
			'notification-delivery': 15,
			campaigns: 30,
			reporting: 45,
			widgets: 60,
			billing: 75,
			identity: 90,
			platform: 105,
			support: 120,
			operations: 135
		};
		expect(DATABASE_BACKUP_DELAY_MINUTES).toMatchObject(original);
		expect(DATABASE_BACKUP_TARGETS.slice(0, 9)).toEqual(
			Object.keys(original)
		);
		const { scheduler, jobs } = fixture();
		await scheduler.tick(new Date('2026-09-07T06:00:00.000Z'));
		expect(jobs.size).toBe(DATABASE_BACKUP_TARGETS.length);
		for (const target of DATABASE_BACKUP_TARGETS) {
			const job = jobs.get(`daily:${target}:2026-09-07`)!;
			expect(job.periodStart).toEqual(
				new Date('2026-09-06T21:00:00.000Z')
			);
			expect(job.periodEnd).toEqual(new Date('2026-09-07T21:00:00.000Z'));
			expect(job.scheduledFor.getTime()).toBe(
				job.periodStart!.getTime() +
					(120 + DATABASE_BACKUP_DELAY_MINUTES[target]) * 60_000
			);
			expect(job.availableAt).toEqual(job.scheduledFor);
		}
	});

	it('keeps the previous period key for a backup crossing Moscow midnight', async () => {
		const { scheduler, jobs } = fixture('23:00');
		await scheduler.tick(new Date('2026-09-07T22:15:00.000Z'));
		const job = jobs.get('daily:operations:2026-09-07')!;
		expect(job).toBeDefined();
		expect(job.scheduledFor).toEqual(new Date('2026-09-07T22:15:00.000Z'));
		expect(job.periodStart).toEqual(new Date('2026-09-06T21:00:00.000Z'));
		expect(job.input).toMatchObject({
			target: 'operations',
			periodStart: '2026-09-06T21:00:00.000Z'
		});
		expect(jobs.has('daily:operations:2026-09-08')).toBe(false);
	});

	it('does not enqueue a post-midnight target before its precise due time', async () => {
		const { scheduler, jobs } = fixture('23:00');
		await scheduler.tick(new Date('2026-09-07T22:14:59.999Z'));
		expect(jobs.has('daily:operations:2026-09-07')).toBe(false);
		await scheduler.tick(new Date('2026-09-07T22:15:00.000Z'));
		expect(jobs.has('daily:operations:2026-09-07')).toBe(true);
	});

	it('reuses durable keys on repeat ticks and bounds catch-up to one period per target', async () => {
		const { scheduler, jobs, enqueueUnique } = fixture('23:00');
		const now = new Date('2026-09-07T23:59:00.000Z');
		await scheduler.tick(now);
		const keys = [...jobs.keys()];
		expect(keys.length).toBeLessThanOrEqual(
			DATABASE_BACKUP_TARGETS.length
		);
		await scheduler.tick(now);
		expect([...jobs.keys()]).toEqual(keys);
		for (const [job] of enqueueUnique.mock.calls) {
			expect(job.scheduledFor.getTime()).toBeLessThanOrEqual(
				now.getTime()
			);
			expect(job.scheduledFor.getTime()).toBeGreaterThanOrEqual(
				now.getTime() - 24 * 60 * 60_000
			);
		}
	});

	it('preserves the original date over year and month boundaries', async () => {
		const { scheduler, jobs } = fixture('23:00');
		await scheduler.tick(new Date('2026-12-31T22:15:00.000Z'));
		expect(jobs.get('daily:operations:2026-12-31')?.periodEnd).toEqual(
			new Date('2026-12-31T21:00:00.000Z')
		);
		expect(jobs.has('daily:operations:2027-01-01')).toBe(false);
	});

	it('does not create work while backups are disabled', async () => {
		const { scheduler, settings, enqueueUnique } = fixture();
		settings.databaseBackupEnabled = false;
		await scheduler.tick(new Date('2026-09-07T06:00:00.000Z'));
		expect(enqueueUnique).not.toHaveBeenCalled();
	});
});
