import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CrmAssigneeService } from './team-assignee.service';
import {
	AssigneeQueryDto,
	AuthorizeAssigneeDto
} from './team-assignee.dto';
import { CrmAssigneeAuthorizationController } from './team-assignee.controller';

const workspaceId = randomUUID();
const teamId = randomUUID();
const membershipId = randomUUID();
const actor = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [teamId],
	permissions: ['sales:read', 'sales:write']
};
const member = {
	id: randomUUID(),
	subject: 'member',
	membershipId,
	role: 'MANAGER',
	version: 1,
	teams: [{ teamId }]
};
const target = {
	...actor,
	subject: 'member',
	membershipId,
	role: 'MANAGER',
	dataScope: 'OWN'
};
const entry = {
	membershipId,
	subject: 'member',
	workspaceRole: 'MEMBER',
	displayName: 'Legacy name',
	verifiedEmail: 'member@example.test'
};
const query = { workspaceId, page: 1, pageSize: 20 };
const dto = {
	schemaVersion: 1 as const,
	workspaceId,
	purpose: 'SALES_ASSIGNMENT' as const,
	subject: 'member',
	membershipId
};
const setup = (patch = {}) => {
	const prisma = {
		$transaction: jest.fn(),
		crmWorkspaceMember: {
			findMany: jest.fn().mockResolvedValue([member]),
			findFirst: jest.fn().mockResolvedValue({ id: member.id })
		},
		crmEmployeeProfile: {
			findMany: jest.fn().mockResolvedValue([
				{
					subject: 'member',
					firstName: 'Иван',
					lastName: 'Петров',
					middleName: null
				}
			])
		}
	};
	prisma.$transaction.mockImplementation(callback => callback(prisma));
	const auth = {
		authorize: jest.fn().mockResolvedValue({ ...actor, ...patch }),
		assignmentSubject: jest.fn().mockResolvedValue(target)
	};
	const identity = { assignees: jest.fn().mockResolvedValue([entry]) };
	return {
		prisma,
		auth,
		identity,
		service: new CrmAssigneeService(
			prisma as never,
			auth as never,
			identity as never
		)
	};
};

describe('Scoped assignee selection and command authority', () => {
	it('bounds Identity batches and deduplicates an owner also present in a later member batch', async () => {
		const { service, prisma, identity } = setup();
		const members = Array.from({ length: 1001 }, (_, index) => ({
			...member,
			id: randomUUID(),
			membershipId: randomUUID(),
			subject: index === 1000 ? 'owner' : `batch-${index}`
		}));
		prisma.crmWorkspaceMember.findMany.mockResolvedValue(members);
		prisma.crmEmployeeProfile.findMany.mockResolvedValue([]);
		const owner = {
			...entry,
			membershipId: members[1000].membershipId,
			subject: 'owner',
			workspaceRole: 'OWNER'
		};
		identity.assignees.mockImplementation(
			async (_workspace, batch, includeOwner) => [
				...batch.map((item: typeof member) => ({
					...entry,
					subject: item.subject,
					membershipId: item.membershipId,
					workspaceRole: item.subject === 'owner' ? 'OWNER' : 'MEMBER'
				})),
				...(includeOwner &&
				!batch.some((item: typeof member) => item.subject === 'owner')
					? [owner]
					: [])
			]
		);
		const result = await service.options('Bearer test', query);
		expect(result.total).toBe(1001);
		expect(result.items).toHaveLength(20);
		expect(
			identity.assignees.mock.calls.map(call => call[1].length)
		).toEqual([1000, 1]);
		expect(identity.assignees.mock.calls[0][3]).toBe(
			identity.assignees.mock.calls[1][3]
		);
	});
	it('refuses an oversized local roster before any Identity lookup', async () => {
		const { service, prisma, identity } = setup();
		prisma.crmWorkspaceMember.findMany.mockResolvedValue(
			Array.from({ length: 10001 }, () => member)
		);
		await expect(
			service.options('Bearer test', query)
		).rejects.toMatchObject({ status: 503 });
		expect(identity.assignees).not.toHaveBeenCalled();
	});
	it('searches workspace FIO before pagination and resolves selected outside the search', async () => {
		const { service } = setup();
		expect(
			await service.options('Bearer test', {
				...query,
				search: 'ПЕТРОВ иван'
			})
		).toMatchObject({
			total: 1,
			items: [{ displayName: 'Петров Иван', membershipId }],
			selected: null
		});
		expect(
			await service.options('Bearer test', {
				...query,
				search: 'unknown',
				selectedSubject: 'member'
			})
		).toMatchObject({
			total: 0,
			items: [],
			selected: { subject: 'member' }
		});
		expect(
			await service.options('Bearer test', {
				...query,
				page: 2,
				pageSize: 1
			})
		).toMatchObject({ total: 1, items: [] });
	});
	it('keeps legacy names searchable and never guesses membership ID from subject', async () => {
		const { service, prisma } = setup();
		prisma.crmEmployeeProfile.findMany.mockResolvedValue([]);
		expect(
			await service.options('Bearer test', { ...query, search: 'legacy' })
		).toMatchObject({
			total: 1,
			items: [
				{ displayName: 'Legacy name', subject: 'member', membershipId }
			]
		});
	});
	it('includes the actual Identity owner without a local CRM-member row', async () => {
		const { service, prisma, identity } = setup();
		prisma.crmWorkspaceMember.findMany.mockResolvedValue([]);
		identity.assignees.mockResolvedValue([
			{ ...entry, subject: 'new-owner', workspaceRole: 'OWNER' }
		]);
		expect(await service.options('Bearer test', query)).toMatchObject({
			total: 1,
			items: [{ subject: 'new-owner', role: 'OWNER' }]
		});
		expect(identity.assignees).toHaveBeenCalledWith(
			workspaceId,
			[],
			true,
			expect.any(AbortSignal)
		);
	});
	it.each([
		{ role: 'MANAGER', dataScope: 'OWN', subject: 'member' },
		{ role: 'TEAM_LEAD', dataScope: 'TEAM', subject: 'lead' }
	])('applies %s scope before Identity enrichment', async patch => {
		const { service, prisma, identity } = setup(patch);
		await service.options('Bearer test', query);
		const where =
			prisma.crmWorkspaceMember.findMany.mock.calls[0][0].where;
		expect(where).toMatchObject({
			workspaceId,
			disabledAt: null,
			role: { not: 'ANALYST' }
		});
		expect(where.AND[0]).toEqual(
			patch.dataScope === 'OWN'
				? { subject: 'member' }
				: {
						OR: [
							{ subject: 'lead' },
							{
								teams: {
									some: {
										teamId: { in: [teamId] },
										team: { archivedAt: null }
									}
								}
							}
						]
					}
		);
		expect(identity.assignees).toHaveBeenCalledWith(
			workspaceId,
			[member],
			false,
			expect.any(AbortSignal)
		);
	});
	it('does not present revoked bindings as assignable or counted', async () => {
		const { service, identity } = setup();
		identity.assignees.mockResolvedValue([]);
		expect(
			await service.options('Bearer test', {
				...query,
				selectedSubject: 'member'
			})
		).toMatchObject({ total: 0, items: [], selected: null });
	});
	it('does not turn Identity outage into an empty directory', async () => {
		const { service, identity } = setup();
		identity.assignees.mockRejectedValue(new Error('temporary'));
		await expect(service.options('Bearer test', query)).rejects.toThrow(
			'temporary'
		);
	});
	it('rejects changed actor scope and changed local membership before returning names', async () => {
		const a = setup();
		a.auth.authorize
			.mockResolvedValueOnce(actor)
			.mockResolvedValueOnce({ ...actor, teamIds: [] });
		await expect(
			a.service.options('Bearer test', query)
		).rejects.toMatchObject({ status: 403 });
		const b = setup();
		b.prisma.crmWorkspaceMember.findMany
			.mockResolvedValueOnce([member])
			.mockResolvedValueOnce([]);
		await expect(
			b.service.options('Bearer test', query)
		).rejects.toMatchObject({ status: 409 });
		expect(b.prisma.crmEmployeeProfile.findMany).not.toHaveBeenCalled();
	});
	it('allows scoped read-only choices but never a read-only assignment', async () => {
		const { service, auth } = setup({
			state: 'READ_ONLY',
			permissions: ['sales:read']
		});
		expect(await service.options('Bearer test', query)).toMatchObject({
			total: 1
		});
		await expect(
			service.authorize('Bearer test', dto)
		).rejects.toMatchObject({ status: 403 });
		expect(auth.assignmentSubject).not.toHaveBeenCalled();
	});
	it('rejects analyst access and foreign department lookup before reading names', async () => {
		for (const current of [
			setup({ role: 'ANALYST' }),
			setup({ teamIds: [] })
		]) {
			await expect(
				current.service.options('Bearer test', { ...query, teamId })
			).rejects.toMatchObject({ status: 403 });
			expect(
				current.prisma.crmWorkspaceMember.findMany
			).not.toHaveBeenCalled();
		}
	});
	it('validates current target membership and actor twice for assignment', async () => {
		const { service, auth, prisma } = setup();
		expect(
			await service.authorize('Bearer test', { ...dto, teamId })
		).toEqual({
			schemaVersion: 1,
			workspaceId,
			subject: 'owner',
			assignee: {
				subject: 'member',
				membershipId,
				role: 'MANAGER',
				dataScope: 'OWN',
				teamIds: [teamId]
			}
		});
		expect(auth.authorize).toHaveBeenCalledTimes(2);
		expect(auth.assignmentSubject).toHaveBeenCalledWith(
			workspaceId,
			'member'
		);
		expect(prisma.crmWorkspaceMember.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					AND: [
						expect.objectContaining({ workspaceId, disabledAt: null }),
						{ subject: 'member', membershipId, role: 'MANAGER' }
					]
				}
			})
		);
	});
	it('manager may assign only self', async () => {
		const denied = setup({
			role: 'MANAGER',
			dataScope: 'OWN',
			subject: 'other'
		});
		await expect(
			denied.service.authorize('Bearer test', dto)
		).rejects.toMatchObject({ status: 404 });
		expect(denied.auth.assignmentSubject).not.toHaveBeenCalled();
		expect(
			await setup({
				role: 'MANAGER',
				dataScope: 'OWN',
				subject: 'member'
			}).service.authorize('Bearer test', dto)
		).toMatchObject({ subject: 'member' });
	});
	it.each([
		{ membershipId: randomUUID() },
		{ subject: 'foreign' },
		{ workspaceId: randomUUID() },
		{ role: 'ANALYST' }
	])('rejects stale or unbound target %j', async patch => {
		const { service, auth } = setup();
		auth.assignmentSubject.mockResolvedValue({ ...target, ...patch });
		await expect(
			service.authorize('Bearer test', dto)
		).rejects.toMatchObject({ status: 404 });
	});
	it('rejects newer read-only decisions and local disable during authorization', async () => {
		const a = setup();
		a.auth.assignmentSubject.mockResolvedValue({
			...target,
			state: 'READ_ONLY'
		});
		await expect(
			a.service.authorize('Bearer test', dto)
		).rejects.toMatchObject({ status: 403 });
		const b = setup();
		b.prisma.crmWorkspaceMember.findFirst.mockResolvedValue(null);
		await expect(
			b.service.authorize('Bearer test', dto)
		).rejects.toMatchObject({ status: 404 });
		const c = setup();
		c.auth.authorize
			.mockResolvedValueOnce(actor)
			.mockResolvedValueOnce({ ...actor, state: 'READ_ONLY' });
		await expect(
			c.service.authorize('Bearer test', dto)
		).rejects.toMatchObject({ status: 403 });
	});
	it('team lead cannot treat admin capability team IDs as actual department membership', async () => {
		const { service, auth, prisma } = setup({
			role: 'TEAM_LEAD',
			dataScope: 'TEAM',
			subject: 'lead'
		});
		auth.assignmentSubject.mockResolvedValue({
			...target,
			role: 'CRM_ADMIN',
			dataScope: 'ALL',
			teamIds: [teamId]
		});
		prisma.crmWorkspaceMember.findFirst.mockResolvedValue(null);
		await expect(
			service.authorize('Bearer test', dto)
		).rejects.toMatchObject({ status: 404 });
	});
	it('owner assignment needs ALL scope and does not invent a CRM member', async () => {
		const current = setup();
		current.auth.assignmentSubject.mockResolvedValue({
			...target,
			role: 'OWNER',
			dataScope: 'ALL'
		});
		expect(
			await current.service.authorize('Bearer test', dto)
		).toMatchObject({ assignee: { role: 'OWNER' } });
		expect(
			current.prisma.crmWorkspaceMember.findFirst
		).not.toHaveBeenCalled();
		const lead = setup({ role: 'TEAM_LEAD', dataScope: 'TEAM' });
		lead.auth.assignmentSubject.mockResolvedValue({
			...target,
			role: 'OWNER',
			dataScope: 'ALL'
		});
		await expect(
			lead.service.authorize('Bearer test', dto)
		).rejects.toMatchObject({ status: 404 });
	});
	it('rejects out-of-team target and maps denied target to not-found', async () => {
		const current = setup();
		current.auth.assignmentSubject.mockResolvedValue({
			...target,
			teamIds: []
		});
		await expect(
			current.service.authorize('Bearer test', { ...dto, teamId })
		).rejects.toMatchObject({ status: 404 });
		current.auth.assignmentSubject.mockRejectedValue(
			new ForbiddenException()
		);
		await expect(
			current.service.authorize('Bearer test', dto)
		).rejects.toMatchObject({ status: 404 });
	});
	it('limits delegation to Sales and validates query/command bindings', async () => {
		const service = { authorize: jest.fn() };
		const controller = new CrmAssigneeAuthorizationController(
			service as never
		);
		expect(() =>
			controller.authorize('crm-intake', 'Bearer test', dto)
		).toThrow(ForbiddenException);
		expect(service.authorize).not.toHaveBeenCalled();
		const pipe = new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		});
		for (const patch of [
			{ purpose: 'INTAKE_ACCEPT' },
			{ membershipId: undefined },
			{ subject: 'with space' },
			{ extra: true }
		])
			await expect(
				pipe.transform(
					{ ...dto, ...patch },
					{ type: 'body', metatype: AuthorizeAssigneeDto }
				)
			).rejects.toBeDefined();
		for (const patch of [
			{ page: 0 },
			{ pageSize: 101 },
			{ search: 'x'.repeat(201) },
			{ selectedSubject: 'invalid subject' }
		])
			await expect(
				pipe.transform(
					{ ...query, ...patch },
					{ type: 'query', metatype: AssigneeQueryDto }
				)
			).rejects.toBeDefined();
	});
});
