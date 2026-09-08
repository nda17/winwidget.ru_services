import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	NotFoundException,
	ValidationPipe
} from '@nestjs/common';
import type { SalesAccess } from '../sales/sales-access';
import {
	AssignWorkdayTaskDto,
	CreateWorkdayTaskDto,
	EditWorkdayTaskDto,
	SetTaskStatusDto,
	WorkdayQuery
} from './workday.dto';
import { WorkdayService, workdayScope } from './workday.service';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';
const membershipId = '44444444-4444-4444-8444-444444444444';
const teamId = '55555555-5555-4555-8555-555555555555';
const dealId = '66666666-6666-4666-8666-666666666666';
const actor: SalesAccess = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	dataScope: 'ALL',
	state: 'ACTIVE',
	teamIds: [teamId],
	permissions: ['sales:read', 'sales:write']
};
const assignee = { subject: 'owner', membershipId };
const base = { schemaVersion: 1 as const, workspaceId, commandId };
const dueAt = '2026-09-08T09:00:00.000Z';
const create: CreateWorkdayTaskDto = {
	...base,
	title: 'Отчёт',
	dueAt,
	assignee
};
const now = new Date('2026-09-07T09:00:00.000Z');
const original = {
	id: taskId,
	workspaceId,
	dealId: null as string | null,
	version: 1,
	title: 'Отчёт',
	dueAt: new Date(dueAt),
	status: 'OPEN',
	assignedToSubject: 'owner',
	assignedToMembershipId: null as string | null,
	teamId: null as string | null,
	completedAt: null as Date | null,
	createdAt: now,
	updatedAt: now,
	deal: null as Record<string, unknown> | null
};

function harness(access = actor) {
	let row = { ...original };
	const tx = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		$queryRaw: jest.fn().mockResolvedValue([]),
		taskCommandReceipt: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockResolvedValue({})
		},
		taskTimeline: { create: jest.fn().mockResolvedValue({}) },
		deal: {
			findFirst: jest.fn().mockResolvedValue({
				id: dealId,
				workspaceId,
				status: 'OPEN',
				assignedToSubject: 'owner',
				teamId,
				version: 1,
				archivedAt: null,
				nextTaskId: taskId
			}),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		salesTask: {
			findFirst: jest.fn().mockImplementation(async () => ({ ...row })),
			create: jest.fn().mockImplementation(async ({ data }) => {
				row = { ...original, ...data };
				return { ...row };
			}),
			updateMany: jest.fn().mockImplementation(async ({ data }) => {
				row = { ...row, ...data, version: row.version + 1 };
				return { count: 1 };
			}),
			count: jest.fn().mockResolvedValue(4),
			findMany: jest.fn().mockResolvedValue([{ ...row }]),
			groupBy: jest
				.fn()
				.mockResolvedValue([{ status: 'OPEN', _count: { _all: 4 } }])
		}
	};
	const prisma = {
		...tx,
		$transaction: jest.fn(async (callback, options?: unknown) => {
			void options;
			return typeof callback === 'function'
				? callback(tx)
				: Promise.all(callback);
		})
	};
	const auth = { authorize: jest.fn().mockResolvedValue(access) };
	const directory = {
		authorize: jest.fn().mockResolvedValue({
			...assignee,
			role: 'OWNER',
			dataScope: 'ALL',
			teamIds: [teamId]
		})
	};
	return {
		tx,
		prisma,
		auth,
		directory,
		service: new WorkdayService(
			prisma as never,
			auth as never,
			directory as never
		),
		setRow: (patch: Partial<typeof original>) => {
			row = { ...row, ...patch };
		}
	};
}

describe('workday task commands', () => {
	it.each(['WON', 'LOST'])(
		'reopens and completes an existing task on a %s deal without changing its result',
		async status => {
			const { service, tx, setRow } = harness();
			const deal = {
				id: dealId,
				workspaceId,
				status,
				archivedAt: null,
				version: 5,
				nextTaskId: null
			};
			setRow({ dealId, deal, status: 'COMPLETED', completedAt: now });
			for (const [index, target] of [
				'OPEN',
				'IN_PROGRESS',
				'COMPLETED',
				'IN_PROGRESS'
			].entries()) {
				const result = (await service.status(
					actor,
					taskId,
					{
						...base,
						commandId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
						expectedVersion: index + 1,
						status: target as SetTaskStatusDto['status']
					},
					'Bearer fixture'
				)) as {
					task: {
						status: string;
						version: number;
						completedAt: string | null;
						dueAt: string;
						assignedToSubject: string;
						dealId: string | null;
					};
				};
				expect(result.task.status).toBe(target);
				expect(result.task.version).toBe(index + 2);
				expect(result.task.completedAt === null).toBe(
					target !== 'COMPLETED'
				);
				expect(result.task.dueAt).toBe(dueAt);
				expect(result.task.assignedToSubject).toBe(
					original.assignedToSubject
				);
				expect(result.task.dealId).toBe(dealId);
			}
			expect(tx.deal.updateMany).not.toHaveBeenCalled();
			expect(tx.taskTimeline.create).toHaveBeenCalledTimes(4);
			expect(tx.taskCommandReceipt.create).toHaveBeenCalledTimes(4);
		}
	);
	it('still rejects status changes for archived deals', async () => {
		const { service, tx, setRow } = harness();
		setRow({
			dealId,
			deal: { id: dealId, workspaceId, status: 'WON', archivedAt: now }
		});
		await expect(
			service.status(
				actor,
				taskId,
				{ ...base, expectedVersion: 1, status: 'OPEN' },
				'Bearer fixture'
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(tx.salesTask.updateMany).not.toHaveBeenCalled();
	});
	it('creates a real standalone task with an immutable receipt and audit in the same transaction', async () => {
		const { service, tx, directory } = harness();
		const result = (await service.create(
			actor,
			create,
			'Bearer fixture'
		)) as {
			task: {
				dealId: string | null;
				assignedToMembershipId: string | null;
			};
		};
		expect(result.task.dealId).toBeNull();
		expect(result.task.assignedToMembershipId).toBe(membershipId);
		expect(tx.deal.findFirst).not.toHaveBeenCalled();
		expect(tx.deal.updateMany).not.toHaveBeenCalled();
		expect(directory.authorize).toHaveBeenCalledWith(
			'Bearer fixture',
			actor,
			assignee,
			undefined
		);
		expect(tx.taskTimeline.create).toHaveBeenCalledTimes(1);
		expect(tx.taskCommandReceipt.create).toHaveBeenCalledTimes(1);
		expect(tx.$executeRaw).toHaveBeenLastCalledWith(
			expect.objectContaining({
				strings: expect.arrayContaining([
					expect.stringContaining('SET CONSTRAINTS')
				])
			})
		);
	});
	it.each(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const)(
		'status %s does not change title, due date or assignment',
		async status => {
			const { service, tx, directory } = harness();
			await service.status(
				actor,
				taskId,
				{ ...base, expectedVersion: 1, status },
				'Bearer fixture'
			);
			const data = tx.salesTask.updateMany.mock.calls[0][0].data;
			expect(Object.keys(data).sort()).toEqual([
				'completedAt',
				'status',
				'version'
			]);
			expect(data.status).toBe(status);
			expect(data.completedAt === null).toBe(
				['OPEN', 'IN_PROGRESS'].includes(status)
			);
			expect(directory.authorize).not.toHaveBeenCalled();
		}
	);
	it('edits only title/deadline, preserving a legacy unknown membership', async () => {
		const { service, tx } = harness();
		const result = (await service.edit(
			actor,
			taskId,
			{ ...base, expectedVersion: 1, title: ' Новый отчёт ', dueAt },
			'Bearer fixture'
		)) as {
			task: { title: string; assignedToMembershipId: string | null };
		};
		expect(result.task.title).toBe('Новый отчёт');
		expect(result.task.assignedToMembershipId).toBeNull();
		expect(
			Object.keys(tx.salesTask.updateMany.mock.calls[0][0].data).sort()
		).toEqual(['dueAt', 'title', 'version']);
	});
	it('checks fresh authority and does not modify state after revocation', async () => {
		const { service, auth, tx } = harness();
		auth.authorize.mockResolvedValue({ ...actor, state: 'READ_ONLY' });
		await expect(
			service.create(actor, create, 'Bearer fixture')
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(tx.salesTask.create).not.toHaveBeenCalled();
	});
	it('fails a stale version without checking or changing the assignee', async () => {
		const { service, tx, directory } = harness();
		await expect(
			service.assign(
				actor,
				taskId,
				{ ...base, expectedVersion: 2, assignee },
				'Bearer fixture'
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(tx.salesTask.updateMany).not.toHaveBeenCalled();
		expect(directory.authorize).not.toHaveBeenCalled();
	});
	it('uses a scoped database CAS even after the initial read', async () => {
		const { service, tx } = harness();
		tx.salesTask.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			service.status(
				actor,
				taskId,
				{ ...base, expectedVersion: 1, status: 'IN_PROGRESS' },
				'Bearer fixture'
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(tx.taskCommandReceipt.create).not.toHaveBeenCalled();
		expect(tx.salesTask.updateMany.mock.calls[0][0].where).toEqual({
			AND: [workdayScope(actor), { id: taskId, version: 1 }]
		});
	});
	it('returns immutable replay after a new state but refuses replay after loss of record visibility', async () => {
		const { service, tx } = harness();
		const result = await service.create(actor, create, 'Bearer fixture');
		const prior = tx.taskCommandReceipt.create.mock.calls[0][0].data;
		tx.taskCommandReceipt.findUnique.mockResolvedValue(prior);
		await expect(
			service.create(actor, create, 'Bearer fixture')
		).resolves.toEqual(result);
		expect(tx.salesTask.create).toHaveBeenCalledTimes(1);
		await expect(
			service.create(
				actor,
				{ ...create, title: 'Different' },
				'Bearer fixture'
			)
		).rejects.toBeInstanceOf(ConflictException);
		tx.salesTask.findFirst.mockResolvedValue(null);
		await expect(
			service.create(actor, create, 'Bearer fixture')
		).rejects.toBeInstanceOf(NotFoundException);
	});
	it('refuses cross-workspace commands and analyst/readonly mutations before SQL', async () => {
		const { service, prisma } = harness();
		for (const access of [
			{ ...actor, workspaceId: teamId },
			{ ...actor, role: 'ANALYST' as const },
			{ ...actor, state: 'READ_ONLY' as const }
		]) {
			await expect(
				service.create(access, create, 'Bearer fixture')
			).rejects.toBeInstanceOf(ForbiddenException);
		}
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
	it('does not authorize an unrelated actor returned by Access', async () => {
		const { service, auth } = harness();
		auth.authorize.mockResolvedValue({ ...actor, subject: 'other' });
		await expect(
			service.create(actor, create, 'Bearer fixture')
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it('refuses a linked task when the target cannot read its deal', async () => {
		const { service, tx } = harness();
		tx.deal.findFirst
			.mockResolvedValueOnce({
				id: dealId,
				workspaceId,
				status: 'OPEN',
				teamId,
				version: 1,
				archivedAt: null
			})
			.mockResolvedValueOnce(null);
		await expect(
			service.create(actor, { ...create, dealId }, 'Bearer fixture')
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(tx.salesTask.create).not.toHaveBeenCalled();
	});
	it('does not let a team lead assign an unscoped personal task to someone else', async () => {
		const access: SalesAccess = {
			...actor,
			role: 'TEAM_LEAD',
			dataScope: 'TEAM'
		};
		const { service } = harness(access);
		await expect(
			service.assign(
				access,
				taskId,
				{
					...base,
					expectedVersion: 1,
					assignee: { subject: 'manager', membershipId }
				},
				'Bearer fixture'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it('rejects a non-calendar deadline before insert', async () => {
		const { service, tx } = harness();
		await expect(
			service.create(
				actor,
				{ ...create, dueAt: '2026-02-30T09:00:00.000Z' },
				'Bearer fixture'
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(tx.salesTask.create).not.toHaveBeenCalled();
	});
	it('revalidates authority on serialization retry, not just once per request', async () => {
		const { service, prisma, auth } = harness();
		prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });
		await service.status(
			actor,
			taskId,
			{ ...base, expectedVersion: 1, status: 'IN_PROGRESS' },
			'Bearer fixture'
		);
		expect(auth.authorize).toHaveBeenCalledTimes(2);
	});
});

describe('workday listing', () => {
	it('applies scope, calendar and status before pagination; counts come from the same snapshot', async () => {
		const { service, tx, prisma } = harness();
		const query = Object.assign(new WorkdayQuery(), {
			workspaceId,
			page: 2,
			pageSize: 2,
			period: 'DAY',
			from: '2026-09-07',
			status: 'OPEN'
		});
		const result = await service.list(actor, query);
		expect(result.total).toBe(4);
		expect(result.counts.OPEN).toBe(4);
		expect(result.overdueCount).toBe(4);
		expect(tx.salesTask.findMany.mock.calls[0][0]).toMatchObject({
			skip: 2,
			take: 2
		});
		expect(
			JSON.stringify(tx.salesTask.findMany.mock.calls[0][0].where)
		).toContain('2026-09-06T21:00:00.000Z');
		expect(
			JSON.stringify(tx.salesTask.findMany.mock.calls[0][0].where)
		).toContain('assignedToSubject');
		expect(prisma.$transaction.mock.calls[0][1]).toEqual({
			isolationLevel: 'RepeatableRead'
		});
	});
	it('does not substitute zero counts for SQL unavailability', async () => {
		const { service, prisma } = harness();
		prisma.$transaction.mockRejectedValue(new Error('offline'));
		await expect(
			service.list(
				actor,
				Object.assign(new WorkdayQuery(), { workspaceId })
			)
		).rejects.toThrow('offline');
	});
	it('keeps read-only access while preventing a manager from requesting team/all scope', async () => {
		const { service } = harness();
		await expect(
			service.list(
				{ ...actor, state: 'READ_ONLY' },
				Object.assign(new WorkdayQuery(), { workspaceId })
			)
		).resolves.toBeDefined();
		for (const scope of ['TEAM', 'ALL'])
			await expect(
				service.list(
					{ ...actor, role: 'MANAGER', dataScope: 'OWN' },
					Object.assign(new WorkdayQuery(), { workspaceId, scope })
				)
			).rejects.toBeInstanceOf(ForbiddenException);
	});
});

describe('workday DTO boundaries', () => {
	const pipe = new ValidationPipe({
		transform: true,
		whitelist: true,
		forbidNonWhitelisted: true,
		forbidUnknownValues: true
	});
	it.each([
		[CreateWorkdayTaskDto, { ...create, assignee: null }],
		[
			CreateWorkdayTaskDto,
			{ ...create, assignee: { ...assignee, role: 'OWNER' } }
		],
		[CreateWorkdayTaskDto, { ...create, dealId: null }],
		[
			EditWorkdayTaskDto,
			{ ...base, expectedVersion: 0, title: 'Title', dueAt }
		],
		[
			SetTaskStatusDto,
			{ ...base, expectedVersion: 1, status: 'IN_PROGRESS', dueAt }
		],
		[
			AssignWorkdayTaskDto,
			{
				...base,
				expectedVersion: 1,
				assignee: { subject: 'owner', membershipId: 'bad' }
			}
		],
		[WorkdayQuery, { workspaceId, pageSize: 101 }]
	])('rejects an invalid task command/query', async (metatype, input) => {
		await expect(
			pipe.transform(input, {
				type: 'body',
				metatype: metatype as typeof CreateWorkdayTaskDto
			})
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
