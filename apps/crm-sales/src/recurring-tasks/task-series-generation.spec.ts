import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/crm-sales-client';
import { TaskSeriesGenerationService } from './task-series-generation.service';

const now = new Date('2026-09-08T12:00:00.000Z');
const lease = { jobId: randomUUID(), token: randomUUID() };
function harness() {
	let row: any = {
		id: randomUUID(),
		workspaceId: randomUUID(),
		version: 1,
		creatorSubject: 'owner',
		creatorMembershipId: null,
		title: 'Повтор',
		dealId: null,
		deal: null,
		teamId: null,
		assignedToSubject: 'owner',
		assignedToMembershipId: null,
		frequency: 'DAILY',
		startDate: '2026-09-01',
		localTime: '10:00',
		timeZone: 'Europe/Moscow',
		status: 'ACTIVE',
		nextIndex: 0,
		nextRunAt: new Date('2026-08-31T21:00:00Z'),
		nextCheckAt: now,
		blockedReason: null,
		createdAt: now,
		updatedAt: now
	};
	const tasks: any[] = [],
		occurrences: any[] = [],
		outbox: any[] = [];
	const tx: any = {
		$queryRaw: jest.fn(),
		$executeRaw: jest.fn(),
		taskSeries: {
			findUnique: jest.fn(async () => ({ ...row })),
			updateMany: jest.fn(async ({ where, data }) => {
				if (
					row.version !== where.version ||
					row.nextIndex !== where.nextIndex ||
					row.status !== where.status
				)
					return { count: 0 };
				row = { ...row, ...data };
				return { count: 1 };
			})
		},
		reminderJob: {
			updateMany: jest.fn(async () => ({ count: 1 })),
			create: jest.fn()
		},
		salesTask: {
			create: jest.fn(async ({ data }) => {
				const task = {
					...data,
					version: 1,
					status: 'OPEN',
					completedAt: null,
					createdAt: now,
					updatedAt: now
				};
				tasks.push(task);
				return task;
			})
		},
		taskSeriesOccurrence: {
			create: jest.fn(async ({ data }) => {
				occurrences.push(data);
				return data;
			})
		},
		taskTimeline: { create: jest.fn() },
		reminderOutbox: {
			create: jest.fn(async ({ data }) => {
				outbox.push(data);
				return data;
			})
		},
		deal: { updateMany: jest.fn(async () => ({ count: 1 })) }
	};
	const prisma: any = {
		...tx,
		$transaction: jest.fn(async fn => {
			const prior = { ...row },
				sizes = [tasks.length, occurrences.length, outbox.length];
			try {
				return await fn(tx);
			} catch (error) {
				row = prior;
				tasks.splice(sizes[0]);
				occurrences.splice(sizes[1]);
				outbox.splice(sizes[2]);
				throw error;
			}
		})
	};
	const authority = {
		authorize: jest.fn(async () => ({ allowed: true, reason: null }))
	};
	return {
		service: new TaskSeriesGenerationService(prisma, authority as never),
		tx,
		authority,
		row: () => row,
		set: (patch: any) => {
			row = { ...row, ...patch };
		},
		tasks,
		occurrences,
		outbox
	};
}
describe('durable task series generation', () => {
	it('creates one catch-up task, occurrence, audit and Outbox atomically; stale retry creates no duplicate', async () => {
		const h = harness(),
			stale = h.row();
		await h.service.generate(stale, lease, () => true, now);
		await h.service.generate(stale, lease, () => true, now);
		expect(h.tasks).toHaveLength(1);
		expect(h.occurrences).toHaveLength(1);
		expect(h.outbox).toHaveLength(1);
		expect(h.occurrences[0]).toMatchObject({
			periodIndex: 7,
			seriesVersion: 1
		});
		expect(h.row().nextIndex).toBe(8);
		expect(h.tx.reminderJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: lease.jobId,
					leaseToken: lease.token,
					leaseExpiresAt: { gt: expect.any(Date) }
				})
			})
		);
	});
	it('writes the existing CREATED/full task history contract without series-only fields', async () => {
		const h = harness();
		await h.service.generate(h.row(), lease, () => true, now);
		const history = h.tx.taskTimeline.create.mock.calls[0][0].data;
		expect(history.kind).toBe('CREATED');
		expect(history.before).toBe(Prisma.DbNull);
		expect(history.after).toEqual({
			id: h.tasks[0].id,
			workspaceId: h.row().workspaceId,
			dealId: null,
			version: 1,
			title: h.row().title,
			dueAt: '2026-09-08T07:00:00.000Z',
			status: 'OPEN',
			assignedToSubject: 'owner',
			assignedToMembershipId: null,
			teamId: null,
			completedAt: null,
			createdAt: now.toISOString(),
			updatedAt: now.toISOString()
		});
		expect(h.occurrences[0]).toMatchObject({
			taskId: history.taskId,
			seriesId: h.row().id,
			periodIndex: 7
		});
	});
	it('rolls back task, occurrence and cursor if Outbox creation fails', async () => {
		const h = harness();
		h.tx.reminderOutbox.create.mockRejectedValueOnce(
			new Error('database unavailable')
		);
		await expect(
			h.service.generate(h.row(), lease, () => true, now)
		).rejects.toThrow();
		expect(h.tasks).toHaveLength(0);
		expect(h.occurrences).toHaveLength(0);
		expect(h.row().nextIndex).toBe(0);
	});
	it.each([
		'READ_ONLY',
		'CREATOR_REVOKED',
		'ASSIGNEE_REVOKED',
		'SCOPE_CHANGED'
	])('denies %s without advancing the period cursor', async reason => {
		const h = harness();
		h.authority.authorize.mockResolvedValueOnce({
			allowed: false,
			reason
		} as never);
		await h.service.generate(h.row(), lease, () => true, now);
		expect(h.tasks).toHaveLength(0);
		expect(h.row()).toMatchObject({ nextIndex: 0, blockedReason: reason });
		expect(h.row().nextCheckAt).toEqual(new Date(now.getTime() + 300000));
	});
	it('does not interpret an authority outage as authorization or a consumed period', async () => {
		const h = harness();
		h.authority.authorize.mockRejectedValueOnce(new Error('unavailable'));
		await expect(
			h.service.generate(h.row(), lease, () => true, now)
		).rejects.toThrow();
		expect(h.tasks).toHaveLength(0);
		expect(h.row().nextIndex).toBe(0);
	});
	it('fences paused/cancelled series and a changed version after the authority check', async () => {
		for (const patch of [
			{ status: 'PAUSED' },
			{ status: 'CANCELLED' },
			{ version: 2 }
		]) {
			const h = harness(),
				stale = h.row();
			h.set(patch);
			await h.service.generate(stale, lease, () => true, now);
			expect(h.tasks).toHaveLength(0);
		}
	});
	it('requires a current PostgreSQL lease before creation, not only a local boolean', async () => {
		const h = harness();
		h.tx.reminderJob.updateMany.mockResolvedValueOnce({ count: 0 });
		await expect(
			h.service.generate(h.row(), lease, () => true, now)
		).rejects.toThrow('SERIES_JOB_LEASE_LOST');
		expect(h.tasks).toHaveLength(0);
	});
	it('blocks closed deals and selects the new task when an open deal has no next action', async () => {
		const h = harness(),
			id = randomUUID();
		h.set({
			dealId: id,
			deal: {
				id,
				version: 1,
				status: 'WON',
				archivedAt: null,
				nextTaskId: null,
				assignedToSubject: 'owner',
				teamId: null
			}
		});
		await h.service.generate(h.row(), lease, () => true, now);
		expect(h.tasks).toHaveLength(0);
		expect(h.row().blockedReason).toBe('DEAL_CLOSED');
		h.set({ deal: { ...h.row().deal, status: 'OPEN' } });
		await h.service.generate(h.row(), lease, () => true, now);
		expect(h.tx.deal.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { nextTaskId: h.tasks[0].id, version: { increment: 1 } }
			})
		);
	});
});
