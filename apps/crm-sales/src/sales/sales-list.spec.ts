import {
	BadRequestException,
	ForbiddenException,
	ValidationPipe
} from '@nestjs/common';
import type { Prisma } from '@prisma/crm-sales-client';
import type { SalesAccess } from './sales-access';
import { DealListQuery } from './sales.dto';
import { salesScope, SalesService } from './sales.service';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const pipelineId = '22222222-2222-4222-8222-222222222222';
const stageId = '33333333-3333-4333-8333-333333333333';
const teamId = '44444444-4444-4444-8444-444444444444';
const access: SalesAccess = {
	schemaVersion: 1,
	workspaceId,
	subject: 'actor',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['sales:read']
};
const query: DealListQuery = { workspaceId, page: 2, pageSize: 20 };
const timestamp = new Date('2026-09-07T12:00:00.000Z');
const row = {
	id: '55555555-5555-4555-8555-555555555555',
	workspaceId,
	version: 4,
	title: 'Без следующего действия',
	currency: 'RUB',
	amountMinor: 10000,
	pipelineId,
	stageId,
	status: 'OPEN',
	contactId: '66666666-6666-4666-8666-666666666666',
	contactName: 'Клиент',
	assignedToSubject: access.subject,
	teamId: null,
	archivedAt: null,
	createdAt: timestamp,
	updatedAt: timestamp,
	nextAction: null
};
const filter = {
	status: 'OPEN',
	tasks: { none: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }
};
const base = {
	archivedAt: null,
	pipelineId: undefined,
	stageId: undefined,
	status: undefined
};

function harness() {
	const count = jest
		.fn<Promise<number>, [Prisma.DealCountArgs]>()
		.mockResolvedValue(21);
	const findMany = jest
		.fn<Promise<(typeof row)[]>, [Prisma.DealFindManyArgs]>()
		.mockResolvedValue([row]);
	const prisma = {
		deal: { count, findMany },
		$transaction: jest.fn((operations: Promise<unknown>[]) =>
			Promise.all(operations)
		)
	};
	return {
		prisma,
		count,
		findMany,
		service: new SalesService(prisma as never, {} as never)
	};
}

describe('additive deal list without-next-action filter', () => {
	const pipe = new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		forbidUnknownValues: true,
		transform: true
	});
	const parse = (value: object) =>
		pipe.transform(value, { type: 'query', metatype: DealListQuery });
	it.each([undefined, 'true', 'false'])(
		'accepts only an omitted or exact boolean query string: %s',
		async value => {
			const parsed = await parse({
				workspaceId,
				page: '2',
				pageSize: '20',
				...(value === undefined ? {} : { withoutNextAction: value })
			});
			expect(parsed).toBeInstanceOf(DealListQuery);
			expect(parsed).toMatchObject({ workspaceId, page: 2, pageSize: 20 });
			expect(parsed.withoutNextAction).toBe(value);
		}
	);
	it.each([
		true,
		false,
		null,
		0,
		1,
		'',
		'TRUE',
		'False',
		'0',
		'1',
		' true ',
		['true'],
		['true', 'false'],
		{ value: 'true' }
	])(
		'rejects malformed/ambiguous boolean %p rather than coercing it',
		async value => {
			await expect(
				parse({ workspaceId, withoutNextAction: value })
			).rejects.toBeInstanceOf(BadRequestException);
		}
	);
	it.each([
		{ schemaVersion: 2 },
		{ withoutNextAction: 'true', nextTaskId: null },
		{ withoutNextAction: 'true', page: '0' },
		{ withoutNextAction: 'true', pageSize: '101' },
		{ withoutNextAction: 'true', workspaceId: 'other' }
	])(
		'preserves strict query schema and pagination validation',
		async fields => {
			await expect(
				parse({ workspaceId, ...fields })
			).rejects.toBeInstanceOf(BadRequestException);
		}
	);
	it.each([undefined, 'false'] as const)(
		'preserves the exact existing where when flag is %s',
		async withoutNextAction => {
			const { service, count, findMany } = harness();
			await service.deals(access, { ...query, withoutNextAction });
			expect(count).toHaveBeenCalledWith({
				where: { AND: [salesScope(access), base] }
			});
			expect(findMany.mock.calls[0][0].where).toEqual(
				count.mock.calls[0][0].where
			);
		}
	);
	it.each(['ALL', 'OWN', 'TEAM'] as const)(
		'ANDs relation absence with %s scope, existing search and server pagination',
		async dataScope => {
			const { service, count, findMany, prisma } = harness();
			const scoped = { ...access, dataScope, teamIds: [teamId] };
			const result = await service.deals(scoped, {
				...query,
				withoutNextAction: 'true',
				pipelineId,
				stageId,
				status: 'OPEN',
				search: ' Клиент '
			});
			const where = {
				AND: [
					salesScope(scoped),
					{
						archivedAt: null,
						pipelineId,
						stageId,
						status: 'OPEN',
						OR: [
							{ title: { contains: 'Клиент', mode: 'insensitive' } },
							{ contactName: { contains: 'Клиент', mode: 'insensitive' } }
						]
					},
					filter
				]
			};
			expect(count).toHaveBeenCalledTimes(1);
			expect(count).toHaveBeenCalledWith({ where });
			expect(findMany).toHaveBeenCalledTimes(1);
			expect(findMany).toHaveBeenCalledWith({
				where,
				skip: 20,
				take: 20,
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
				include: { nextAction: true }
			});
			expect(findMany.mock.calls[0][0].where).toBe(
				count.mock.calls[0][0].where
			);
			expect(prisma.$transaction).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({
				schemaVersion: 1,
				page: 2,
				pageSize: 20,
				total: 21,
				items: [{ id: row.id, status: 'OPEN', nextTask: null }]
			});
			// The predicate asks PostgreSQL about the composite-bound tasks relation;
			// no task pointer, ownership, deadline or completed/cancelled task can stand in for it.
			expect(filter.tasks.none.status.in).toEqual(['OPEN', 'IN_PROGRESS']);
			expect(JSON.stringify(where)).not.toContain('nextTaskId');
		}
	);
	it.each(['WON', 'LOST'] as const)(
		'keeps %s AND OPEN contradictory rather than dropping the requested status',
		async status => {
			const { service, count, findMany } = harness();
			count.mockResolvedValue(0);
			findMany.mockResolvedValue([]);
			const parsed = await parse({
				workspaceId,
				status,
				withoutNextAction: 'true'
			});
			expect(await service.deals(access, parsed)).toEqual({
				schemaVersion: 1,
				page: 1,
				pageSize: 20,
				total: 0,
				items: []
			});
			expect(count).toHaveBeenCalledWith({
				where: { AND: [salesScope(access), { ...base, status }, filter] }
			});
		}
	);
	it('permits the filter in READ_ONLY without requiring a write permission', async () => {
		const { service, count } = harness();
		await service.deals(
			{ ...access, state: 'READ_ONLY' },
			{ ...query, withoutNextAction: 'true' }
		);
		expect(count).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ ...access, role: 'ANALYST' as const },
		{ ...access, permissions: [] }
	])(
		'denies unauthorized read before any database access',
		async denied => {
			const { service, count, findMany, prisma } = harness();
			await expect(
				service.deals(denied, { ...query, withoutNextAction: 'true' })
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(count).not.toHaveBeenCalled();
			expect(findMany).not.toHaveBeenCalled();
			expect(prisma.$transaction).not.toHaveBeenCalled();
		}
	);
});
