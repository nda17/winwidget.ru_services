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
				teamIds: [teamId],
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
							teamIds: [],
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
