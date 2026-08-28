import { ConfigService } from '@nestjs/config';
import type { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import type { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';
import {
	parseWidgetsRetentionConfig,
	runWidgetsRetentionCleanup,
	WidgetsRetentionService
} from './widgets-retention.service';

const retentionConfig = (overrides: Record<string, string> = {}) => {
	const values: Record<string, string> = {
		WIDGETS_OUTBOX_RETENTION_DAYS: '7',
		WIDGETS_RECEIPT_RETENTION_DAYS: '90',
		WIDGETS_FAILURE_DETAIL_RETENTION_DAYS: '30',
		...overrides
	};

	return {
		get: (key: string) => values[key]
	} as ConfigService;
};

describe('Widgets retention', () => {
	it('parses all configured retention boundaries', () => {
		expect(
			parseWidgetsRetentionConfig(
				retentionConfig({
					WIDGETS_OUTBOX_RETENTION_DAYS: '365',
					WIDGETS_RECEIPT_RETENTION_DAYS: '730',
					WIDGETS_FAILURE_DETAIL_RETENTION_DAYS: '365'
				})
			)
		).toEqual({
			outboxDays: 365,
			receiptDays: 730,
			failureDetailDays: 365
		});
	});

	it.each([
		['WIDGETS_OUTBOX_RETENTION_DAYS', '0'],
		['WIDGETS_OUTBOX_RETENTION_DAYS', '366'],
		['WIDGETS_OUTBOX_RETENTION_DAYS', '1.5'],
		['WIDGETS_RECEIPT_RETENTION_DAYS', '0'],
		['WIDGETS_RECEIPT_RETENTION_DAYS', '731'],
		['WIDGETS_RECEIPT_RETENTION_DAYS', '1.5'],
		['WIDGETS_FAILURE_DETAIL_RETENTION_DAYS', '0'],
		['WIDGETS_FAILURE_DETAIL_RETENTION_DAYS', '366'],
		['WIDGETS_FAILURE_DETAIL_RETENTION_DAYS', '1.5']
	])('rejects invalid %s=%s', (key, value) => {
		expect(() =>
			parseWidgetsRetentionConfig(retentionConfig({ [key]: value }))
		).toThrow(key);
	});

	it('uses bounded terminal-only SQL and preserves receipt tombstones', async () => {
		const executeRaw = jest.fn().mockResolvedValue(0);
		const prisma = {
			$executeRaw: executeRaw
		} as unknown as WidgetsPrismaService;

		await expect(
			runWidgetsRetentionCleanup(prisma, {
				outboxDays: 7,
				receiptDays: 90,
				failureDetailDays: 30,
				cleanupOutbox: true,
				cleanupWorkerState: true,
				now: new Date('2026-08-06T00:00:00.000Z'),
				batchSize: 10,
				maxBatches: 2
			})
		).resolves.toEqual({
			callbackOtpChallengesDeleted: 0,
			callbackOtpChallengesRedacted: 0,
			callbackOtpRateBucketsDeleted: 0,
			publishedOutboxDeleted: 0,
			credentialSnapshotsDeleted: 0,
			integrationReceiptsCompacted: 0,
			consumerReceiptsCompacted: 0,
			integrationFailureDetailsRedacted: 0,
			consumerFailureDetailsRedacted: 0
		});

		const sql = executeRaw.mock.calls
			.map(([query]) =>
				(query as { strings: readonly string[] }).strings.join('?')
			)
			.join('\n');
		expect(executeRaw).toHaveBeenCalledTimes(7);
		expect(sql).toContain('DELETE FROM "widgets"."outbox_events"');
		expect(sql).toContain('AND "published_at" <');
		expect(sql).toContain(
			'UPDATE "widgets"."integration_delivery_receipts"'
		);
		expect(sql).toContain('UPDATE "widgets"."consumer_receipts"');
		expect(sql).not.toContain(
			'DELETE FROM "widgets"."integration_delivery_receipts"'
		);
		expect(sql).not.toContain('DELETE FROM "widgets"."consumer_receipts"');
		expect(sql).toContain('FOR UPDATE OF snapshot SKIP LOCKED');
		expect(sql).toContain('failure."resolved_at" IS NULL');
		expect(sql).toContain('failure."details_purged_at" IS NULL');
	});

	it.each([
		{ outboxDays: 0 },
		{ receiptDays: 731 },
		{ failureDetailDays: 1.5 },
		{ batchSize: 0 },
		{ maxBatches: 101 }
	])('rejects unsafe direct cleanup input %o', async override => {
		const prisma = {
			$executeRaw: jest.fn()
		} as unknown as WidgetsPrismaService;
		await expect(
			runWidgetsRetentionCleanup(prisma, {
				outboxDays: 7,
				receiptDays: 90,
				failureDetailDays: 30,
				cleanupOutbox: true,
				cleanupWorkerState: true,
				...override
			})
		).rejects.toThrow();
		expect(prisma.$executeRaw).not.toHaveBeenCalled();
	});

	it('runs only the publisher cleanup and exposes a safe health snapshot', async () => {
		const prisma = {
			$executeRaw: jest.fn().mockResolvedValue(0)
		} as unknown as WidgetsPrismaService;
		const runtime = {
			publisherEnabled: true,
			workerEnabled: false
		} as WidgetsRuntimeService;
		const service = new WidgetsRetentionService(
			prisma,
			runtime,
			retentionConfig()
		);

		expect(service.isReady()).toBe(false);
		service.onModuleInit();
		await new Promise(resolve => setImmediate(resolve));

		expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);
		expect(service.isReady()).toBe(true);
		expect(service.status()).toEqual(
			expect.objectContaining({
				enabled: true,
				healthy: true,
				running: false,
				runs: 1,
				consecutiveFailures: 0,
				lastAttemptAt: expect.any(String),
				lastSuccessfulCleanupAt: expect.any(String),
				lastFailureAt: null
			})
		);
		await service.beforeApplicationShutdown();
	});

	it('deletes unconsumed OTP state and redacts expired consumed challenges in bounded batches', async () => {
		const executeRaw = jest.fn().mockResolvedValue(0);
		const prisma = {
			$executeRaw: executeRaw
		} as unknown as WidgetsPrismaService;

		await runWidgetsRetentionCleanup(prisma, {
			outboxDays: 7,
			receiptDays: 90,
			failureDetailDays: 30,
			cleanupOutbox: false,
			cleanupOtpState: true,
			cleanupWorkerState: false,
			now: new Date('2026-08-28T00:00:00.000Z'),
			batchSize: 10,
			maxBatches: 2
		});

		const sql = executeRaw.mock.calls
			.map(([query]) =>
				(query as { strings: readonly string[] }).strings.join('?')
			)
			.join('\n');
		expect(executeRaw).toHaveBeenCalledTimes(3);
		expect(sql).toContain(
			'DELETE FROM "widgets"."callback_otp_challenges"'
		);
		expect(sql).toContain('challenge."consumed_at" IS NULL');
		expect(sql).toContain('challenge."consumed_at" IS NOT NULL');
		expect(sql).toContain('challenge."expires_at" <=');
		expect(sql).toContain('challenge."revoked_at" <');
		expect(sql).toContain('challenge."failed_at" <');
		expect(sql).toContain(
			'lead."verification_challenge_id" = challenge."id"'
		);
		expect(sql).toContain(
			'DELETE FROM "widgets"."callback_otp_rate_buckets"'
		);
		expect(sql).toContain(
			'UPDATE "widgets"."callback_otp_challenges" AS challenge'
		);
		expect(sql).toContain('"destination_hash" =');
		expect(sql).toContain('"ip_hash" =');
		expect(sql).toContain('"code_hash" =');
		expect(sql).toContain('FOR UPDATE OF challenge SKIP LOCKED');
		expect(sql).toContain('FOR UPDATE OF bucket SKIP LOCKED');
	});
});
