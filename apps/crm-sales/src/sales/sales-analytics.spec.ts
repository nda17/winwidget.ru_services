import {
	BadRequestException,
	ForbiddenException,
	ValidationPipe
} from '@nestjs/common';
import { Prisma } from '@prisma/crm-sales-client';
import type { SalesAccess } from './sales-access';
import { SalesAnalyticsQuery } from './sales.dto';
import { SalesService, salesScope } from './sales.service';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const access: SalesAccess = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['sales:read', 'sales:analytics']
};
const period = {
	createdFrom: '2026-09-01T00:00:00.000Z',
	createdTo: '2026-09-08T00:00:00.000Z'
};
const group = {
	status: 'WON',
	_count: { id: 2 },
	_sum: { amountMinor: 10000 }
};
const query: SalesAnalyticsQuery = {
	workspaceId,
	...period,
	details: 'true',
	assigneePage: 1
};
function harness() {
	const groupBy = jest.fn(
		async (args: { by: string[]; skip?: number; where?: unknown }) => {
			if (args.by.length === 1 && args.by[0] === 'status') return [group];
			if (args.skip !== undefined) return [{ assignedToSubject: 'owner' }];
			if (args.by.length === 2)
				return [{ ...group, assignedToSubject: 'owner' }];
			return [{ assignedToSubject: 'owner', _count: { id: 1 } }];
		}
	);
	const transaction = {
		deal: { groupBy, count: jest.fn().mockResolvedValue(5) }
	};
	const prisma = {
		...transaction,
		$transaction: jest.fn(async callback => callback(transaction))
	};
	return {
		prisma,
		transaction,
		service: new SalesService(prisma as never, {} as never)
	};
}

describe('Sales analytics cohorts and workload', () => {
	it('preserves the exact old response for callers without details opt-in', async () => {
		const { service, prisma } = harness();
		expect(await service.analytics(access)).toEqual({
			schemaVersion: 1,
			currency: 'RUB',
			items: [
				{ status: 'OPEN', count: 0, amountMinor: 0 },
				{ status: 'WON', count: 2, amountMinor: 10000 },
				{ status: 'LOST', count: 0, amountMinor: 0 }
			]
		});
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
	it.each(['OWN', 'TEAM', 'ALL'] as const)(
		'keeps %s scope on every aggregate and compares adjacent creation cohorts',
		async dataScope => {
			const { service, prisma, transaction } = harness();
			const scoped = { ...access, dataScope, teamIds: ['team'] };
			const result = await service.analytics(scoped, query);
			expect(result).toMatchObject({
				overview: {
					dateBasis: 'CREATED_AT',
					period,
					previous: {
						period: {
							createdFrom: '2026-08-25T00:00:00.000Z',
							createdTo: period.createdFrom
						}
					},
					assignees: {
						page: 1,
						pageSize: 20,
						hasMore: false,
						items: [{ assignedToSubject: 'owner' }]
					}
				}
			});
			expect(prisma.$transaction).toHaveBeenCalledWith(
				expect.any(Function),
				{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
			);
			const calls = [
				...transaction.deal.groupBy.mock.calls,
				...transaction.deal.count.mock.calls
			];
			for (const [args] of calls) {
				expect(JSON.stringify(args.where)).toContain(
					JSON.stringify(salesScope(scoped))
				);
				expect(JSON.stringify(args.where)).toContain('"archivedAt":null');
			}
			const where = transaction.deal.groupBy.mock.calls[0][0].where;
			expect(JSON.stringify(where)).toContain(
				'"createdAt":{"gte":"2026-09-01T00:00:00.000Z","lt":"2026-09-08T00:00:00.000Z"}'
			);
			expect(JSON.stringify(where)).not.toContain('updatedAt');
		}
	);
	it('counts overdue deals through all active tasks and shares one cutoff, without creation-period filtering', async () => {
		const { service, transaction } = harness();
		const result = await service.analytics(access, query);
		const overview = 'overview' in result ? result.overview : null;
		expect(overview).not.toBeNull();
		const calls = transaction.deal.count.mock.calls;
		expect(calls[1][0].where.AND[1]).toEqual({
			status: 'OPEN',
			tasks: {
				some: {
					status: { in: ['OPEN', 'IN_PROGRESS'] },
					dueAt: { lt: new Date(overview!.asOf) }
				}
			}
		});
		expect(calls[2][0].where.AND[1]).toEqual({
			status: 'OPEN',
			tasks: { none: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }
		});
		for (const [args] of calls)
			expect(JSON.stringify(args)).not.toContain('createdAt');
	});
	it('keeps ANALYST aggregate-only even if sales:read is accidentally advertised', async () => {
		const { service, transaction } = harness();
		const result = await service.analytics(
			{ ...access, role: 'ANALYST', state: 'READ_ONLY' },
			query
		);
		expect(result).toMatchObject({ overview: { assignees: null } });
		expect(
			transaction.deal.groupBy.mock.calls.every(
				([args]) => args.by[0] === 'status'
			)
		).toBe(true);
	});
	it('paginates employee identities before calculating their scoped status and workload aggregates', async () => {
		const { service, transaction } = harness();
		await service.analytics(access, { ...query, assigneePage: 3 });
		expect(transaction.deal.groupBy).toHaveBeenCalledWith({
			by: ['assignedToSubject'],
			where: { AND: [salesScope(access), { archivedAt: null }] },
			skip: 40,
			take: 21,
			orderBy: { assignedToSubject: 'asc' }
		});
	});
	it('does not query PostgreSQL without analytics permission', async () => {
		const { service, prisma } = harness();
		await expect(
			service.analytics({ ...access, permissions: ['sales:read'] }, query)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(prisma.deal.groupBy).not.toHaveBeenCalled();
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
	it.each([
		{ createdFrom: period.createdFrom, createdTo: undefined },
		{ createdFrom: undefined, createdTo: period.createdTo },
		{ createdFrom: period.createdTo, createdTo: period.createdFrom },
		{ createdFrom: period.createdFrom, createdTo: period.createdFrom },
		{
			createdFrom: '2026-02-30T00:00:00.000Z',
			createdTo: period.createdTo
		},
		{
			createdFrom: '2024-01-01T00:00:00.000Z',
			createdTo: period.createdTo
		}
	])(
		'rejects incomplete or invalid date bounds before database access',
		async dates => {
			const { service, prisma } = harness();
			await expect(
				service.analytics(access, { ...query, ...dates })
			).rejects.toBeInstanceOf(BadRequestException);
			expect(prisma.$transaction).not.toHaveBeenCalled();
		}
	);
	it.each([
		{ details: true },
		{ details: 'false' },
		{ assigneePage: '0' },
		{ assigneePage: '1000001' },
		{ createdFrom: '2026-09-01' }
	])('validates optional report fields strictly', async fields => {
		const pipe = new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		});
		await expect(
			pipe.transform(
				{ workspaceId, ...fields },
				{ type: 'query', metatype: SalesAnalyticsQuery }
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
