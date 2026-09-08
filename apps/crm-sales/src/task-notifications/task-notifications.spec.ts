import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/crm-sales-client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { type SalesAccess } from '../sales/sales-access';
import {
	TaskNotificationsService,
	taskNotificationVisibility
} from './task-notifications.service';
import {
	TaskNotificationsQuery,
	TaskNotificationReadDto
} from './task-notifications.dto';

const access: SalesAccess = {
	schemaVersion: 1,
	workspaceId: randomUUID(),
	subject: 'owner',
	role: 'OWNER',
	state: 'READ_ONLY',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['sales:read']
};
const sql = (call: any[]) => Prisma.sql(call[0], ...call.slice(1));
const id = randomUUID(),
	taskId = randomUUID(),
	now = new Date('2026-09-08T12:00:00Z');
function fixture() {
	const raw = jest.fn();
	const tx: any = { $queryRaw: raw };
	const prisma: any = { ...tx, $transaction: jest.fn(fn => fn(tx)) };
	const client = { authorize: jest.fn(async () => access) };
	const actors = {
		verify: jest.fn(async (_token, _access, membershipId) => ({
			subject: 'owner',
			membershipId
		}))
	};
	return {
		raw,
		prisma,
		client,
		actors,
		service: new TaskNotificationsService(
			prisma,
			client as never,
			actors as never
		)
	};
}
describe('Sales personal durable notification center', () => {
	it('paginates scoped records and counts on server even READ_ONLY and without external channels', async () => {
		const h = fixture();
		h.raw
			.mockResolvedValueOnce([{ total: 4n, unread: 2n }])
			.mockResolvedValueOnce([
				{
					id,
					taskId,
					kind: 'DUE',
					title: 'Current title',
					dueAt: now,
					createdAt: now,
					readAt: null
				}
			]);
		const result = await h.service.list(
			access,
			Object.assign(new TaskNotificationsQuery(), {
				workspaceId: access.workspaceId,
				page: 2,
				pageSize: 1,
				unreadOnly: 'true'
			}),
			'Bearer fixture'
		);
		expect(result).toMatchObject({
			schemaVersion: 1,
			total: 2,
			unreadCount: 2,
			page: 2,
			items: [
				{
					href: `/planner?task=${taskId}`,
					title: 'Current title',
					readAt: null
				}
			]
		});
		expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({
			isolationLevel: 'RepeatableRead'
		});
		expect(h.actors.verify).toHaveBeenCalledTimes(2);
		expect(sql(h.raw.mock.calls[1]).sql).toContain('n.read_at IS NULL');
		expect(sql(h.raw.mock.calls[1]).values.slice(-2)).toEqual([1, 1]);
	});
	it('uses current binding and epoch, active task and linked deal scope for both rows and count', () => {
		for (const dataScope of ['ALL', 'TEAM', 'OWN'] as const) {
			const fragment = taskNotificationVisibility(
				{ ...access, dataScope, teamIds: [id] },
				id,
				now
			);
			expect(fragment.sql).toContain(
				't.assignment_version=n.assignment_version'
			);
			expect(fragment.sql).toContain(
				'n.recipient_membership_id IS NOT DISTINCT FROM'
			);
			expect(fragment.sql).toContain('d.archived_at IS NULL');
			expect(fragment.sql).toContain('n.cancelled_at IS NULL');
			expect(fragment.sql).not.toContain(access.workspaceId);
			expect(fragment.values).toContain(access.subject);
			if (dataScope === 'TEAM')
				expect(fragment.sql).toContain('d.team_id IN');
			if (dataScope === 'OWN')
				expect(fragment.sql).toContain('d.assigned_to_subject=');
		}
	});
	it.each([
		'foreign-workspace',
		'analyst',
		'no-read',
		'role-change',
		'membership-change',
		'outage'
	])(
		'fails closed on %s before returning any notification',
		async kind => {
			const h = fixture();
			const initial = { ...access };
			if (kind === 'analyst') initial.role = 'ANALYST';
			if (kind === 'no-read') initial.permissions = [];
			if (kind === 'role-change')
				h.client.authorize.mockResolvedValue({
					...access,
					role: 'MANAGER'
				});
			if (kind === 'membership-change')
				h.actors.verify.mockRejectedValue(new ForbiddenException());
			if (kind === 'outage')
				h.client.authorize.mockRejectedValue(new Error('unavailable'));
			await expect(
				h.service.list(
					initial,
					Object.assign(new TaskNotificationsQuery(), {
						workspaceId:
							kind === 'foreign-workspace'
								? randomUUID()
								: access.workspaceId
					}),
					'Bearer fixture'
				)
			).rejects.toThrow();
			expect(h.raw).not.toHaveBeenCalled();
		}
	);
	it('rechecks authority after reading; a revoked actor never receives loaded content', async () => {
		const h = fixture();
		h.raw
			.mockResolvedValueOnce([{ total: 0n, unread: 0n }])
			.mockResolvedValueOnce([]);
		h.actors.verify
			.mockResolvedValueOnce({
				subject: access.subject,
				membershipId: null
			})
			.mockRejectedValueOnce(new ForbiddenException());
		await expect(
			h.service.list(
				access,
				Object.assign(new TaskNotificationsQuery(), {
					workspaceId: access.workspaceId
				}),
				'Bearer fixture'
			)
		).rejects.toThrow(ForbiddenException);
	});
	it('uses an idempotent scoped read preference in READ_ONLY, and returns 404 for hidden/stale IDs', async () => {
		const h = fixture();
		h.raw
			.mockResolvedValueOnce([{ id, readAt: now }])
			.mockResolvedValueOnce([]);
		const dto = {
			workspaceId: access.workspaceId,
			actorMembershipId: null,
			read: true
		};
		expect(
			await h.service.setRead(access, id, dto, 'Bearer fixture')
		).toEqual({
			schemaVersion: 1,
			workspaceId: access.workspaceId,
			id,
			readAt: now.toISOString()
		});
		expect(sql(h.raw.mock.calls[0]).sql).toContain('coalesce(n.read_at,');
		expect(sql(h.raw.mock.calls[0]).sql).toContain(
			't.assignment_version=n.assignment_version'
		);
		await expect(
			h.service.setRead(
				access,
				id,
				{ ...dto, read: false },
				'Bearer fixture'
			)
		).rejects.toThrow(NotFoundException);
	});
	it('validates exact bounded query and explicit boolean read state', async () => {
		for (const patch of [
			{ page: 0 },
			{ pageSize: 101 },
			{ unreadOnly: 'yes' },
			{ actorMembershipId: 'bad' },
			{ recipient: 'other' }
		]) {
			expect(
				(
					await validate(
						plainToInstance(TaskNotificationsQuery, {
							workspaceId: access.workspaceId,
							...patch
						}),
						{ whitelist: true, forbidNonWhitelisted: true }
					)
				).length
			).toBeGreaterThan(0);
		}
		for (const patch of [
			{ read: 'true' },
			{ actorMembershipId: undefined },
			{ read: undefined }
		]) {
			expect(
				(
					await validate(
						plainToInstance(TaskNotificationReadDto, {
							workspaceId: access.workspaceId,
							actorMembershipId: null,
							read: true,
							...patch
						})
					)
				).length
			).toBeGreaterThan(0);
		}
	});
});
