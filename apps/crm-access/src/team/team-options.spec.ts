import {
	ForbiddenException,
	UnauthorizedException,
	ValidationPipe
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/crm-access-client';
import { TeamOptionsQueryDto } from './team.dto';
import { CrmTeamService } from './team.service';

const workspaceId = randomUUID();
const teamId = randomUUID();
const query = { workspaceId, page: 2, pageSize: 10, selectedId: teamId };
const actor = {
	workspaceId,
	subject: 'test-manager',
	role: 'MANAGER',
	state: 'ACTIVE',
	dataScope: 'OWN',
	permissions: ['intake:read'],
	teamIds: [teamId]
};
const setup = (overrides = {}) => {
	const prisma = {
		$transaction: jest.fn(),
		crmTeam: {
			findMany: jest.fn().mockResolvedValue([]),
			count: jest.fn().mockResolvedValue(1),
			findFirst: jest
				.fn()
				.mockResolvedValue({ id: teamId, name: 'Продажи' })
		}
	};
	prisma.$transaction.mockImplementation(callback => callback(prisma));
	const auth = {
		authorize: jest.fn().mockResolvedValue({ ...actor, ...overrides })
	};
	const service = new CrmTeamService(
		prisma as never,
		auth as never,
		{} as never,
		{} as never
	);
	return { service, prisma, auth };
};

describe('CRM intake department options', () => {
	it.each(['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER'])(
		'binds %s lookup to current server authority and a consistent read snapshot',
		async role => {
			const { service, prisma, auth } = setup({ role });
			await expect(service.options('Bearer test', query)).resolves.toEqual(
				{
					schemaVersion: 1,
					workspaceId,
					subject: actor.subject,
					page: 2,
					pageSize: 10,
					total: 1,
					items: [],
					selected: { id: teamId, name: 'Продажи' }
				}
			);
			expect(auth.authorize).toHaveBeenCalledWith(
				'Bearer test',
				workspaceId,
				'crm-intake'
			);
			const where = {
				workspaceId,
				archivedAt: null,
				id: { in: [teamId] }
			};
			expect(prisma.crmTeam.findMany).toHaveBeenCalledWith({
				where,
				select: { id: true, name: true },
				skip: 10,
				take: 10,
				orderBy: [{ name: 'asc' }, { id: 'asc' }]
			});
			expect(prisma.crmTeam.count).toHaveBeenCalledWith({ where });
			expect(prisma.crmTeam.findFirst).toHaveBeenCalledWith({
				where: { ...where, AND: { id: teamId } },
				select: { id: true, name: true }
			});
			expect(prisma.$transaction).toHaveBeenCalledWith(
				expect.any(Function),
				{
					isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
				}
			);
		}
	);
	it('does not upgrade lookup permission into administrative directory access', async () => {
		const { service, prisma } = setup();
		await expect(
			service.teams('Bearer test', query)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
	it('allows safe READ_ONLY names without write permission', async () => {
		const { service } = setup({ state: 'READ_ONLY' });
		await expect(
			service.options('Bearer test', query)
		).resolves.toMatchObject({ total: 1 });
	});
	it('does not disclose a selected ID outside the same scoped filter', async () => {
		const { service, prisma } = setup({ teamIds: [] });
		prisma.crmTeam.findFirst.mockResolvedValue(null);
		prisma.crmTeam.count.mockResolvedValue(0);
		await expect(
			service.options('Bearer test', query)
		).resolves.toMatchObject({ items: [], total: 0, selected: null });
		expect(prisma.crmTeam.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					workspaceId,
					archivedAt: null,
					id: { in: [] },
					AND: { id: teamId }
				}
			})
		);
	});
	it('does not query an unselected item', async () => {
		const { service, prisma } = setup();
		await expect(
			service.options('Bearer test', {
				workspaceId,
				page: 1,
				pageSize: 20
			})
		).resolves.toMatchObject({ selected: null });
		expect(prisma.crmTeam.findFirst).not.toHaveBeenCalled();
	});
	it('denies analytics-only users before querying department names', async () => {
		const { service, prisma } = setup({
			role: 'ANALYST',
			permissions: ['sales:analytics']
		});
		await expect(
			service.options('Bearer test', query)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
	it.each([new UnauthorizedException(), new ForbiddenException()])(
		'does not query after session or membership revocation',
		async error => {
			const { service, prisma, auth } = setup();
			auth.authorize.mockRejectedValue(error);
			await expect(service.options(undefined, query)).rejects.toBe(error);
			expect(prisma.$transaction).not.toHaveBeenCalled();
		}
	);
});

describe('department options public DTO', () => {
	const pipe = new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		forbidUnknownValues: true,
		transform: true
	});
	const parse = (value: unknown) =>
		pipe.transform(value, {
			type: 'query',
			metatype: TeamOptionsQueryDto
		});
	it('transforms bounded pagination with optional selected UUID', async () => {
		await expect(parse({ workspaceId })).resolves.toEqual({
			workspaceId,
			page: 1,
			pageSize: 20
		});
		await expect(
			parse({
				workspaceId,
				page: '2',
				pageSize: '100',
				selectedId: teamId
			})
		).resolves.toEqual({
			workspaceId,
			page: 2,
			pageSize: 100,
			selectedId: teamId
		});
	});
	it.each([
		{ page: '0' },
		{ page: '1000001' },
		{ page: '1.1' },
		{ pageSize: '101' },
		{ selectedId: 'invalid' },
		{ selectedId: [teamId, teamId] },
		{ teamIds: [teamId] },
		{ subject: 'another-user' },
		{ workspaceId: 'invalid' }
	])('rejects invalid or client-supplied authority %j', async patch => {
		await expect(parse({ workspaceId, ...patch })).rejects.toMatchObject({
			status: 400
		});
	});
});
