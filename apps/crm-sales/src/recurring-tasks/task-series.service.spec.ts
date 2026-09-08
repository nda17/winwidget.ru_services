import {
	ForbiddenException,
	ConflictException,
	BadRequestException,
	ValidationPipe
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SalesAccess } from '../sales/sales-access';
import { CreateTaskSeriesDto, EditTaskSeriesDto } from './task-series.dto';
import { TaskSeriesService } from './task-series.service';

const workspaceId = randomUUID();
const actor: SalesAccess = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['sales:read', 'sales:write']
};
const command: CreateTaskSeriesDto = {
	schemaVersion: 1,
	workspaceId,
	commandId: randomUUID(),
	actorMembershipId: null,
	frequency: 'MONTHLY',
	startDate: '2026-09-30',
	content: {
		title: 'Подготовить отчёт',
		localTime: '09:00',
		timeZone: 'Europe/Moscow',
		assignee: { subject: 'owner', membershipId: null }
	}
};
function harness() {
	let row: any = null;
	const receipts = new Map();
	const tx: any = {
		$executeRaw: jest.fn(),
		$queryRaw: jest.fn(),
		taskSeries: {
			findFirst: jest.fn(async () => row),
			count: jest.fn(async () => 0),
			create: jest.fn(async ({ data }) => (row = { ...data, deal: null })),
			updateMany: jest.fn(async ({ where, data }) => {
				if (!row || row.version !== where.version) return { count: 0 };
				row = { ...row, ...data };
				return { count: 1 };
			})
		},
		taskSeriesCommand: {
			findUnique: jest.fn(
				async ({ where }) => receipts.get(where.commandId) ?? null
			),
			create: jest.fn(async ({ data }) => {
				receipts.set(data.commandId, data);
				return data;
			})
		},
		reminderJob: { createMany: jest.fn(async () => ({ count: 1 })) },
		reminderOutbox: { create: jest.fn(async ({ data }) => data) },
		deal: { findFirst: jest.fn() }
	};
	const prisma: any = { ...tx, $transaction: jest.fn(async fn => fn(tx)) };
	const access = { authorize: jest.fn(async () => actor) };
	const actors = { verify: jest.fn() };
	const authority = {
		authorize: jest.fn(async () => ({ allowed: true, reason: null }))
	};
	return {
		service: new TaskSeriesService(
			prisma,
			access as never,
			actors as never,
			authority as never
		),
		tx,
		access,
		actors,
		authority,
		row: () => row
	};
}
describe('task series commands', () => {
	it('creates only a series with transactional wake-up, never rewrites existing tasks', async () => {
		const h = harness();
		await h.service.create(actor, command, 'Bearer test');
		expect(h.tx.taskSeries.create).toHaveBeenCalledTimes(1);
		expect(h.tx.reminderOutbox.create).toHaveBeenCalledTimes(1);
		expect(h.authority.authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				creatorBinding: { subject: 'owner', membershipId: null },
				assigneeBinding: command.content.assignee
			})
		);
		expect(h.row().nextIndex).toBe(0);
	});
	it('replays exact commands but conflicts on a changed payload', async () => {
		const h = harness();
		const result = await h.service.create(actor, command, 'Bearer test');
		expect(await h.service.create(actor, command, 'Bearer test')).toEqual(
			result
		);
		expect(h.tx.taskSeries.create).toHaveBeenCalledTimes(1);
		await expect(
			h.service.create(
				actor,
				{ ...command, startDate: '2026-10-01' },
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ConflictException);
	});
	it('edits future content, preserving the anchor and already consumed period cursor', async () => {
		const h = harness();
		await h.service.create(actor, command, 'Bearer test');
		h.row().nextIndex = 2;
		await h.service.edit(
			actor,
			h.row().id,
			{
				schemaVersion: 1,
				workspaceId,
				commandId: randomUUID(),
				actorMembershipId: null,
				expectedVersion: 1,
				content: { ...command.content, title: 'Новый отчёт' }
			},
			'Bearer test'
		);
		expect(h.row()).toMatchObject({
			nextIndex: 2,
			frequency: 'MONTHLY',
			startDate: command.startDate,
			title: 'Новый отчёт',
			version: 2
		});
	});
	it('pause and resume preserve the cursor; cancellation cannot be undone', async () => {
		const h = harness();
		await h.service.create(actor, command, 'Bearer test');
		for (const status of ['PAUSED', 'ACTIVE', 'CANCELLED'] as const)
			await h.service.status(
				actor,
				h.row().id,
				{
					schemaVersion: 1,
					workspaceId,
					commandId: randomUUID(),
					actorMembershipId: null,
					expectedVersion: h.row().version,
					status
				},
				'Bearer test'
			);
		expect(h.row().nextIndex).toBe(0);
		await expect(
			h.service.status(
				actor,
				h.row().id,
				{
					schemaVersion: 1,
					workspaceId,
					commandId: randomUUID(),
					actorMembershipId: null,
					expectedVersion: h.row().version,
					status: 'ACTIVE'
				},
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ConflictException);
	});
	it('rejects stale versions and READ_ONLY before creating commands', async () => {
		const h = harness();
		await h.service.create(actor, command, 'Bearer test');
		await expect(
			h.service.status(
				actor,
				h.row().id,
				{
					schemaVersion: 1,
					workspaceId,
					commandId: randomUUID(),
					actorMembershipId: null,
					expectedVersion: 9,
					status: 'PAUSED'
				},
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ConflictException);
		await expect(
			h.service.create(
				{ ...actor, state: 'READ_ONLY' },
				{ ...command, commandId: randomUUID() },
				'Bearer test'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it('requires current write authority and enforces the workspace series bound', async () => {
		const h = harness();
		h.authority.authorize.mockResolvedValueOnce({
			allowed: false,
			reason: 'ASSIGNEE_REVOKED'
		} as never);
		await expect(
			h.service.create(actor, command, 'Bearer test')
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(h.tx.taskSeries.create).not.toHaveBeenCalled();
		h.tx.taskSeries.count.mockResolvedValueOnce(200);
		await expect(
			h.service.create(actor, command, 'Bearer test')
		).rejects.toBeInstanceOf(BadRequestException);
	});
	it('does not accept an edit that reinterprets frequency or start date', async () => {
		const pipe = new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		});
		await expect(
			pipe.transform(
				{
					schemaVersion: 1,
					workspaceId,
					commandId: randomUUID(),
					actorMembershipId: null,
					expectedVersion: 1,
					content: command.content,
					frequency: 'WEEKLY'
				},
				{ type: 'body', metatype: EditTaskSeriesDto }
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
