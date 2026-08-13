import { PrismaService } from '@/prisma.service';
import { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CampaignsAudienceExportService } from './campaigns-audience-export.service';

describe('CampaignsAudienceExportService', () => {
	const executeRaw = jest.fn();
	const queryRaw = jest.fn();
	const transaction = {
		$executeRaw: executeRaw,
		$queryRaw: queryRaw
	};
	const prisma = {
		$transaction: jest.fn(
			async (callback: (client: typeof transaction) => Promise<void>) =>
				callback(transaction)
		)
	} as unknown as PrismaService;
	const service = new CampaignsAudienceExportService(prisma);

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('streams a canonical snapshot with a count and SHA-256 trailer', async () => {
		queryRaw.mockResolvedValueOnce([
			{ destination: 'first@example.test' },
			{ destination: 'second@example.test' }
		]);
		const chunks: string[] = [];
		const response = Object.assign(new EventEmitter(), {
			destroyed: false,
			writableEnded: false,
			write: jest.fn((value: string) => {
				chunks.push(value);
				return true;
			})
		}) as unknown as Response;
		const request = { aborted: false } as Request;

		await service.stream(
			{
				schemaVersion: 1,
				channel: 'EMAIL',
				audience: 'ALL'
			},
			request,
			response
		);

		const lines = chunks.map(chunk => JSON.parse(chunk));
		expect(lines[0]).toMatchObject({
			type: 'snapshot',
			schemaVersion: 1,
			criteria: { channel: 'EMAIL', audience: 'ALL' }
		});
		expect(lines.slice(1, -1)).toEqual([
			{ type: 'recipient', destination: 'first@example.test' },
			{ type: 'recipient', destination: 'second@example.test' }
		]);
		expect(lines.at(-1)).toEqual({
			type: 'complete',
			snapshotId: lines[0].snapshotId,
			totalCount: 2,
			sha256: createHash('sha256')
				.update('EMAIL\u0000first@example.test\n', 'utf8')
				.update('EMAIL\u0000second@example.test\n', 'utf8')
				.digest('hex')
		});
		expect(executeRaw).toHaveBeenCalledTimes(1);
		expect((prisma.$transaction as jest.Mock).mock.calls[0][1]).toEqual(
			expect.objectContaining({ isolationLevel: 'RepeatableRead' })
		);
	});

	it('does not emit a completion trailer after a disconnect', async () => {
		queryRaw.mockResolvedValueOnce([
			{ destination: 'first@example.test' }
		]);
		const request = { aborted: false } as Request;
		const chunks: string[] = [];
		const response = Object.assign(new EventEmitter(), {
			destroyed: false,
			writableEnded: false,
			write: jest.fn((value: string) => {
				chunks.push(value);
				if (chunks.length === 1) request.aborted = true;
				return true;
			})
		}) as unknown as Response;

		await expect(
			service.stream(
				{
					schemaVersion: 1,
					channel: 'EMAIL',
					audience: 'ALL'
				},
				request,
				response
			)
		).rejects.toThrow('client disconnected');
		expect(chunks.some(chunk => chunk.includes('"type":"complete"'))).toBe(
			false
		);
	});

	it('releases a backpressured stream when the client closes', async () => {
		queryRaw.mockResolvedValueOnce([]);
		const response = Object.assign(new EventEmitter(), {
			destroyed: false,
			writableEnded: false,
			write: jest.fn(() => false)
		}) as unknown as Response;
		const request = { aborted: false } as Request;

		const streaming = service.stream(
			{
				schemaVersion: 1,
				channel: 'EMAIL',
				audience: 'ALL'
			},
			request,
			response
		);
		queueMicrotask(() => response.emit('close'));

		await expect(streaming).rejects.toThrow('client disconnected');
	});

	it('uses only the Billing subscription projection', async () => {
		queryRaw.mockResolvedValueOnce([]);
		const response = Object.assign(new EventEmitter(), {
			destroyed: false,
			writableEnded: false,
			write: jest.fn(() => true)
		}) as unknown as Response;

		await service.stream(
			{
				schemaVersion: 1,
				channel: 'EMAIL',
				audience: 'ACTIVE_SUBSCRIBERS'
			},
			{ aborted: false } as Request,
			response
		);

		const query = queryRaw.mock.calls[0][0];
		const sql = query.strings.join(' ');
		expect(sql).toContain('billing_subscription_read_projections');
		expect(sql).not.toMatch(/FROM\s+"subscriptions"/);
	});
});
