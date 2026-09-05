import {
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { CrmAuthorizationService } from './crm-authorization.service';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const membershipId = '22222222-2222-4222-8222-222222222222';
const teamId = '33333333-3333-4333-8333-333333333333';

function setup(role = 'OWNER', status = 'ACTIVE') {
	const identity = {
		widgetSourceContext: jest.fn().mockResolvedValue({
			schemaVersion: 1,
			workspaceId,
			subject: 'user-1',
			ownerSubject: role === 'OWNER' ? 'user-1' : 'canonical-owner',
			membership: {
				workspaceId,
				membershipId,
				role: role === 'OWNER' ? 'OWNER' : 'MEMBER'
			}
		}),
		sourceContext: jest.fn().mockResolvedValue({
			schemaVersion: 1,
			workspaceId,
			subject: 'user-1',
			membership: {
				workspaceId,
				membershipId,
				role: role === 'OWNER' ? 'OWNER' : 'MEMBER'
			}
		}),
		authContext: jest.fn().mockResolvedValue({
			subject: 'user-1',
			memberships: [
				{
					workspaceId,
					membershipId,
					role: role === 'OWNER' ? 'OWNER' : 'MEMBER'
				}
			]
		})
	};
	const billing = {
		get: jest
			.fn()
			.mockResolvedValue({ status, entitlement: { id: 'billing-id' } })
	};
	const prisma = {
		crmWorkspaceAccess: {
			findUnique: jest.fn().mockResolvedValue({
				lifecycle: 'ACTIVE',
				billingEntitlementId: 'billing-id',
				onboardingCompletedAt: new Date()
			})
		},
		crmWorkspaceMember: {
			findUnique: jest.fn().mockResolvedValue({
				role,
				membershipId,
				teams: [{ teamId }],
				disabledAt: null
			})
		}
	};
	return {
		identity,
		billing,
		prisma,
		service: new CrmAuthorizationService(
			identity as never,
			billing as never,
			prisma as never
		)
	};
}

describe('CRM service authorization', () => {
	it.each(['OWNER', 'CRM_ADMIN'])(
		'binds %s native source authority to fresh canonical Identity owner',
		async role => {
			const current = setup(role, 'GRACE');
			for (let i = 0; i < 2; i++)
				expect(
					await current.service.authorizeWidgetSource(
						workspaceId,
						'user-1'
					)
				).toMatchObject({
					workspaceId,
					subject: 'user-1',
					role,
					state: 'GRACE',
					ownerSubject: role === 'OWNER' ? 'user-1' : 'canonical-owner',
					permissions: expect.arrayContaining(['intake:manage-sources'])
				});
			expect(current.identity.widgetSourceContext).toHaveBeenCalledTimes(
				2
			);
			expect(current.identity.sourceContext).not.toHaveBeenCalled();
			expect(current.identity.authContext).not.toHaveBeenCalled();
			expect(current.billing.get).toHaveBeenCalledTimes(2);
		}
	);
	it.each(['MANAGER', 'TEAM_LEAD', 'ANALYST'])(
		'does not grant widget ownership authority to %s',
		async role => {
			await expect(
				setup(role).service.authorizeWidgetSource(workspaceId, 'user-1')
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	);
	it('denies missing or ambiguous Identity owner before reading Billing or CRM state', async () => {
		const current = setup();
		current.identity.widgetSourceContext.mockResolvedValue({
			schemaVersion: 1,
			workspaceId,
			subject: 'user-1',
			membership: null,
			ownerSubject: null
		});
		await expect(
			current.service.authorizeWidgetSource(workspaceId, 'user-1')
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.billing.get).not.toHaveBeenCalled();
		expect(
			current.prisma.crmWorkspaceAccess.findUnique
		).not.toHaveBeenCalled();
	});
	it('rechecks CRM role and paid/Trial lifecycle for every native source authority', async () => {
		for (const role of ['OWNER', 'CRM_ADMIN'])
			await expect(
				setup(role, 'READ_ONLY').service.authorizeWidgetSource(
					workspaceId,
					'user-1'
				)
			).rejects.toBeInstanceOf(ForbiddenException);
		const current = setup('CRM_ADMIN');
		await current.service.authorizeWidgetSource(workspaceId, 'user-1');
		current.prisma.crmWorkspaceMember.findUnique.mockResolvedValue({
			role: 'CRM_ADMIN',
			membershipId,
			teams: [],
			disabledAt: new Date()
		});
		await expect(
			current.service.authorizeWidgetSource(workspaceId, 'user-1')
		).rejects.toBeInstanceOf(ForbiddenException);
		current.identity.widgetSourceContext.mockRejectedValue(
			new ServiceUnavailableException()
		);
		await expect(
			current.service.authorizeWidgetSource(workspaceId, 'user-1')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
	it.each(['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER'])(
		'authorizes the writable %s acceptance workflow without source-admin semantics',
		async role => {
			const current = setup(role, 'GRACE');
			for (const caller of [
				'crm-intake',
				'crm-customers',
				'crm-sales'
			] as const) {
				const result = await current.service.authorizeWorkflow(
					workspaceId,
					'user-1',
					'INTAKE_ACCEPT',
					caller
				);
				expect(result.role).toBe(role);
				expect(
					result.permissions.every(permission =>
						permission.startsWith(caller.replace('crm-', '') + ':')
					)
				).toBe(true);
			}
			expect(current.identity.sourceContext).toHaveBeenCalledTimes(3);
			expect(current.identity.authContext).not.toHaveBeenCalled();
		}
	);
	it('denies unknown purpose/caller and read-only/analyst workflows', async () => {
		for (const [role, state] of [
			['ANALYST', 'ACTIVE'],
			['MANAGER', 'READ_ONLY']
		])
			await expect(
				setup(role, state).service.authorizeWorkflow(
					workspaceId,
					'user-1',
					'INTAKE_ACCEPT',
					'crm-sales'
				)
			).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			setup().service.authorizeWorkflow(
				workspaceId,
				'user-1',
				'OTHER',
				'crm-sales'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			setup().service.authorizeWorkflow(
				workspaceId,
				'user-1',
				'INTAKE_ACCEPT',
				'widgets' as never
			)
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it.each(['OWNER', 'CRM_ADMIN'])(
		'freshly revalidates the active %s delegated source actor without a user session',
		async role => {
			const current = setup(role, 'GRACE');
			for (let i = 0; i < 2; i++)
				expect(
					await current.service.authorizeSource(workspaceId, 'user-1')
				).toMatchObject({
					subject: 'user-1',
					state: 'GRACE',
					role,
					permissions: expect.arrayContaining(['intake:manage-sources'])
				});
			expect(current.identity.sourceContext).toHaveBeenCalledTimes(2);
			expect(current.identity.authContext).not.toHaveBeenCalled();
			expect(current.billing.get).toHaveBeenCalledTimes(2);
		}
	);
	it.each(['MANAGER', 'TEAM_LEAD', 'ANALYST'])(
		'denies delegated sources after demotion to %s',
		async role => {
			await expect(
				setup(role).service.authorizeSource(workspaceId, 'user-1')
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	);
	it('halts sources after read-only, disabled CRM membership, or missing Identity authority', async () => {
		await expect(
			setup('OWNER', 'READ_ONLY').service.authorizeSource(
				workspaceId,
				'user-1'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		const current = setup('CRM_ADMIN');
		current.prisma.crmWorkspaceMember.findUnique.mockResolvedValue({
			role: 'CRM_ADMIN',
			membershipId,
			teams: [],
			disabledAt: new Date()
		});
		await expect(
			current.service.authorizeSource(workspaceId, 'user-1')
		).rejects.toBeInstanceOf(ForbiddenException);
		current.identity.sourceContext.mockResolvedValue({
			schemaVersion: 1,
			workspaceId,
			subject: 'user-1',
			membership: null
		});
		await expect(
			current.service.authorizeSource(workspaceId, 'user-1')
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it('returns the full advisory permission matrix only for the public user request', async () => {
		const current = setup();
		const result = await current.service.authorize(
			'Bearer user',
			workspaceId
		);
		expect(result.permissions).toEqual(
			expect.arrayContaining([
				'customers:read',
				'sales:read',
				'intake:read',
				'access:manage-team'
			])
		);
		expect(current.identity.authContext).toHaveBeenCalledWith(
			'Bearer user',
			expect.anything()
		);
	});
	it('restricts returned permissions to the authenticated service', async () => {
		const current = setup();
		const result = await current.service.authorize(
			'Bearer user',
			workspaceId,
			'crm-customers'
		);
		expect(result).toMatchObject({
			schemaVersion: 1,
			workspaceId,
			subject: 'user-1',
			role: 'OWNER',
			state: 'ACTIVE',
			dataScope: 'ALL',
			teamIds: []
		});
		expect(result.permissions).toEqual([
			'customers:read',
			'customers:write',
			'customers:merge',
			'customers:export'
		]);
		expect(
			current.prisma.crmWorkspaceMember.findUnique
		).not.toHaveBeenCalled();
	});
	it.each([
		['CRM_ADMIN', 'ALL'],
		['TEAM_LEAD', 'TEAM'],
		['MANAGER', 'OWN']
	])('enforces the %s data scope', async (role, dataScope) => {
		const current = setup(role);
		expect(
			await current.service.authorize(
				'Bearer user',
				workspaceId,
				'crm-sales'
			)
		).toMatchObject({
			role,
			dataScope,
			teamIds: [teamId],
			permissions: expect.arrayContaining(['sales:read', 'sales:write'])
		});
	});
	it('only permits aggregate analytics to an ANALYST', async () => {
		const current = setup('ANALYST');
		expect(
			(
				await current.service.authorize(
					'Bearer user',
					workspaceId,
					'crm-sales'
				)
			).permissions
		).toEqual(['sales:analytics']);
		expect(
			(
				await current.service.authorize(
					'Bearer user',
					workspaceId,
					'crm-customers'
				)
			).permissions
		).toEqual([]);
	});
	it('keeps GRACE writable', async () => {
		const current = setup('OWNER', 'GRACE');
		expect(
			await current.service.authorize(
				'Bearer user',
				workspaceId,
				'crm-sales'
			)
		).toMatchObject({
			state: 'GRACE',
			permissions: expect.arrayContaining(['sales:write'])
		});
	});
	it.each(['billing', 'workspace'])(
		'removes all mutations in %s READ_ONLY, retaining owner export',
		async source => {
			const current = setup(
				'OWNER',
				source === 'billing' ? 'READ_ONLY' : 'ACTIVE'
			);
			if (source === 'workspace')
				current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue({
					lifecycle: 'READ_ONLY',
					billingEntitlementId: 'billing-id',
					onboardingCompletedAt: new Date()
				});
			expect(
				(
					await current.service.authorize(
						'Bearer user',
						workspaceId,
						'crm-customers'
					)
				).permissions
			).toEqual(['customers:read', 'customers:export']);
		}
	);
	it.each(['NOT_ACTIVATED', 'EXPIRED', 'SUSPENDED', 'CANCELLED'])(
		'denies entitlement %s',
		async status => {
			const current = setup('OWNER', status);
			await expect(
				current.service.authorize('Bearer user', workspaceId, 'crm-sales')
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	);
	it('rejects a foreign workspace before consulting Billing or CRM tables', async () => {
		const current = setup();
		await expect(
			current.service.authorize(
				'Bearer user',
				'foreign-workspace',
				'crm-sales'
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.billing.get).not.toHaveBeenCalled();
		expect(
			current.prisma.crmWorkspaceAccess.findUnique
		).not.toHaveBeenCalled();
	});
	it.each(['missing-role', 'disabled', 'old-membership'])(
		'denies %s without granting MEMBER implicit permissions',
		async kind => {
			const current = setup('MANAGER');
			current.prisma.crmWorkspaceMember.findUnique.mockResolvedValue(
				kind === 'missing-role'
					? null
					: {
							role: 'MANAGER',
							membershipId:
								kind === 'old-membership'
									? 'old-membership'
									: membershipId,
							teams: [],
							disabledAt: kind === 'disabled' ? new Date() : null
						}
			);
			await expect(
				current.service.authorize('Bearer user', workspaceId, 'crm-sales')
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	);
	it('never caches a successful authorization after Identity revocation', async () => {
		const current = setup();
		await current.service.authorize(
			'Bearer user',
			workspaceId,
			'crm-sales'
		);
		current.identity.authContext.mockRejectedValue(
			new ForbiddenException('revoked')
		);
		await expect(
			current.service.authorize('Bearer user', workspaceId, 'crm-sales')
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.identity.authContext).toHaveBeenCalledTimes(2);
	});
	it('fails closed if Billing is unavailable', async () => {
		const current = setup();
		current.billing.get.mockRejectedValue(
			new ServiceUnavailableException()
		);
		await expect(
			current.service.authorize('Bearer user', workspaceId, 'crm-sales')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
