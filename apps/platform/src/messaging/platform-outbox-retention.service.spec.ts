import { Logger } from '@nestjs/common';
import type { PlatformPrismaService } from '../prisma/platform-prisma.service';
import type { PlatformRuntimeService } from '../runtime/platform-runtime.service';
import {
	deletePublishedPlatformOutbox,
	PlatformOutboxRetentionService
} from './platform-outbox-retention.service';

const flushPromises = () =>
	new Promise<void>(resolve => setImmediate(resolve));

describe('Platform Outbox retention', () => {
	it('deletes one bounded PUBLISHED batch by publishedAt', async () => {
		const executeRaw = jest.fn().mockResolvedValue(3);
		const prisma = {
			$executeRaw: executeRaw
		} as unknown as PlatformPrismaService;

		await expect(
			deletePublishedPlatformOutbox(
				prisma,
				7,
				new Date('2026-08-24T12:00:00.000Z')
			)
		).resolves.toBe(3);

		const query = executeRaw.mock.calls[0][0] as {
			strings: readonly string[];
			values: readonly unknown[];
		};
		const sql = query.strings.join('?');
		expect(sql).toContain(
			`WHERE "status" = 'PUBLISHED'::"platform"."OutboxStatus"`
		);
		expect(sql).toContain('AND "published_at" <');
		expect(sql).toContain('ORDER BY "published_at" ASC, "id" ASC');
		expect(sql).toContain('LIMIT');
		expect(sql).toContain('FOR UPDATE SKIP LOCKED');
		expect(sql).not.toContain("'PENDING'");
		expect(sql).not.toContain("'PROCESSING'");
		expect(query.values).toEqual([
			new Date('2026-08-17T12:00:00.000Z'),
			1_000
		]);
	});

	it.each([
		{ retentionDays: 0 },
		{ retentionDays: 366 },
		{ retentionDays: 1.5 },
		{ retentionDays: 7, now: new Date('invalid') }
	])('rejects unsafe cleanup input %o before SQL', async input => {
		const prisma = {
			$executeRaw: jest.fn()
		} as unknown as PlatformPrismaService;

		await expect(
			deletePublishedPlatformOutbox(prisma, input.retentionDays, input.now)
		).rejects.toThrow();
		expect(prisma.$executeRaw).not.toHaveBeenCalled();
	});

	it('runs only in the outbox-publisher process role', async () => {
		const prisma = {
			$executeRaw: jest.fn().mockResolvedValue(0)
		} as unknown as PlatformPrismaService;
		const publisher = new PlatformOutboxRetentionService(prisma, {
			outboxPublisherEnabled: true,
			outboxRetentionDays: 7
		} as PlatformRuntimeService);
		publisher.onModuleInit();
		await flushPromises();
		expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
		await publisher.beforeApplicationShutdown();

		const api = new PlatformOutboxRetentionService(prisma, {
			outboxPublisherEnabled: false,
			outboxRetentionDays: 7
		} as PlatformRuntimeService);
		api.onModuleInit();
		await flushPromises();
		expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
	});

	it('isolates cleanup errors from the publisher loop and logs no details', async () => {
		const log = jest
			.spyOn(Logger.prototype, 'error')
			.mockImplementation(() => undefined);
		const prisma = {
			$executeRaw: jest
				.fn()
				.mockRejectedValue(
					new Error('database failure containing private detail')
				)
		} as unknown as PlatformPrismaService;
		const service = new PlatformOutboxRetentionService(prisma, {
			outboxPublisherEnabled: true,
			outboxRetentionDays: 7
		} as PlatformRuntimeService);

		service.onModuleInit();
		await flushPromises();

		expect(log).toHaveBeenCalledWith(
			'Platform Outbox retention cleanup failed: Error'
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain('private detail');
		await service.beforeApplicationShutdown();
		log.mockRestore();
	});
});
