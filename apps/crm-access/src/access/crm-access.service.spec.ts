import {
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { CrmAccessLifecycle } from '@prisma/crm-access-client';
import { CrmAccessService } from './crm-access.service';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';

const membership = (
	workspaceId: string,
	role: 'OWNER' | 'MEMBER' = 'OWNER'
) => ({
	membershipId:
		workspaceId === WORKSPACE_A
			? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
			: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
	workspaceId,
	role
});

const context = (memberships = [membership(WORKSPACE_A)]) => ({
	schemaVersion: 1 as const,
	subject: 'user-1',
	sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
	memberships
});

const inactiveEntitlement = () => ({
	schemaVersion: 1 as const,
	productCode: 'WINCRM' as const,
	status: 'NOT_ACTIVATED' as const,
	entitlement: null
});

const activeEntitlement = () => ({
	schemaVersion: 1 as const,
	productCode: 'WINCRM' as const,
	status: 'ACTIVE' as const,
	entitlement: {
		id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
		workspaceId: WORKSPACE_A,
		planCode: 'TRIAL',
		seatLimit: null,
		trialStartedAt: '2026-09-02T10:00:00.000Z',
		effectiveFrom: '2026-09-02T10:00:00.000Z',
		effectiveUntil: '2026-09-07T10:00:00.000Z',
		aggregateVersion: '1',
		sourceSequence: '1'
	}
});

function build(authContext = context()) {
	const identity = {
		authContext: jest.fn().mockResolvedValue(authContext)
	};
	const billing = {
		get: jest.fn().mockResolvedValue(inactiveEntitlement()),
		activateTrial: jest.fn().mockResolvedValue({
			...activeEntitlement(),
			activated: true
		})
	};
	const prisma = {
		crmWorkspaceAccess: {
			findUnique: jest.fn().mockResolvedValue(null),
			upsert: jest.fn().mockResolvedValue({
				lifecycle: CrmAccessLifecycle.ONBOARDING
			})
		}
	};
	return {
		service: new CrmAccessService(
			identity as never,
			billing as never,
			prisma as never
		),
		identity,
		billing,
		prisma
	};
}

describe('CrmAccessService bootstrap', () => {
	it('returns workspace selection before any Billing or CRM database call', async () => {
		const current = build(
			context([membership(WORKSPACE_A), membership(WORKSPACE_B, 'MEMBER')])
		);
		await expect(
			current.service.bootstrap('Bearer token')
		).resolves.toEqual({
			schemaVersion: 1,
			state: 'WORKSPACE_SELECTION_REQUIRED',
			selectedWorkspaceId: null,
			workspaces: [
				membership(WORKSPACE_A),
				membership(WORKSPACE_B, 'MEMBER')
			]
		});
		expect(current.billing.get).not.toHaveBeenCalled();
		expect(
			current.prisma.crmWorkspaceAccess.findUnique
		).not.toHaveBeenCalled();
	});

	it('forbids an account without an active workspace', async () => {
		const current = build(context([]));
		await expect(
			current.service.bootstrap('Bearer token')
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.billing.get).not.toHaveBeenCalled();
	});

	it('forbids a supplied workspace outside current memberships', async () => {
		const current = build();
		await expect(
			current.service.bootstrap('Bearer token', WORKSPACE_B)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.billing.get).not.toHaveBeenCalled();
	});

	it('auto-selects one workspace and trusts explicit Billing NOT_ACTIVATED', async () => {
		const current = build();
		await expect(
			current.service.bootstrap('Bearer token')
		).resolves.toMatchObject({
			state: 'NOT_ACTIVATED',
			selectedWorkspaceId: WORKSPACE_A,
			entitlementStatus: 'NOT_ACTIVATED',
			entitlement: null,
			access: null
		});
		expect(current.billing.get).toHaveBeenCalledWith(
			WORKSPACE_A,
			expect.any(String)
		);
	});

	it('keeps an active entitlement in onboarding while local lifecycle says so', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue({
			lifecycle: CrmAccessLifecycle.ONBOARDING
		});
		await expect(
			current.service.bootstrap('Bearer token')
		).resolves.toMatchObject({
			state: 'ONBOARDING',
			entitlementStatus: 'ACTIVE',
			access: { lifecycle: 'ONBOARDING' }
		});
	});

	it('starts onboarding for an active entitlement without a local profile', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		await expect(
			current.service.bootstrap('Bearer token')
		).resolves.toMatchObject({
			state: 'ONBOARDING',
			entitlementStatus: 'ACTIVE',
			access: null
		});
	});

	it.each([
		CrmAccessLifecycle.ACTIVE,
		CrmAccessLifecycle.READ_ONLY,
		CrmAccessLifecycle.SUSPENDED
	])(
		'honors local %s lifecycle while Billing is ACTIVE',
		async lifecycle => {
			const current = build();
			current.billing.get.mockResolvedValue(activeEntitlement());
			current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue({
				lifecycle
			});
			await expect(
				current.service.bootstrap('Bearer token')
			).resolves.toMatchObject({ state: lifecycle });
		}
	);

	it('preserves GRACE as Billing truth without inventing read-only policy', async () => {
		const current = build();
		current.billing.get.mockResolvedValue({
			...activeEntitlement(),
			status: 'GRACE'
		});
		await expect(
			current.service.bootstrap('Bearer token')
		).resolves.toMatchObject({
			state: 'GRACE',
			entitlementStatus: 'GRACE'
		});
	});
});

describe('CrmAccessService trial activation', () => {
	it('requires OWNER before calling Billing', async () => {
		const current = build(context([membership(WORKSPACE_A, 'MEMBER')]));
		await expect(
			current.service.activateTrial('Bearer token', {
				schemaVersion: 1,
				commandId: COMMAND_ID,
				workspaceId: WORKSPACE_A
			})
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.billing.activateTrial).not.toHaveBeenCalled();
		expect(
			current.prisma.crmWorkspaceAccess.upsert
		).not.toHaveBeenCalled();
	});

	it('activates in Billing first and then idempotently reconciles local onboarding', async () => {
		const current = build();
		await expect(
			current.service.activateTrial('Bearer token', {
				schemaVersion: 1,
				commandId: COMMAND_ID,
				workspaceId: WORKSPACE_A
			})
		).resolves.toMatchObject({
			state: 'ONBOARDING',
			activated: true,
			entitlementStatus: 'ACTIVE'
		});
		expect(current.billing.activateTrial).toHaveBeenCalledWith(
			{
				schemaVersion: 1,
				commandId: COMMAND_ID,
				workspaceId: WORKSPACE_A,
				activatedByUserId: 'user-1'
			},
			expect.any(String)
		);
		expect(current.prisma.crmWorkspaceAccess.upsert).toHaveBeenCalledWith({
			where: { workspaceId: WORKSPACE_A },
			create: {
				workspaceId: WORKSPACE_A,
				lifecycle: CrmAccessLifecycle.ONBOARDING,
				activatedBySubject: 'user-1',
				trialActivationCommandId: COMMAND_ID
			},
			update: {},
			select: { lifecycle: true }
		});
		expect(
			current.billing.activateTrial.mock.invocationCallOrder[0]
		).toBeLessThan(
			current.prisma.crmWorkspaceAccess.upsert.mock.invocationCallOrder[0]
		);
	});

	it('does not write local state when Billing is unavailable', async () => {
		const current = build();
		current.billing.activateTrial.mockRejectedValue(
			new ServiceUnavailableException('Billing service is unavailable')
		);
		await expect(
			current.service.activateTrial('Bearer token', {
				schemaVersion: 1,
				commandId: COMMAND_ID,
				workspaceId: WORKSPACE_A
			})
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(
			current.prisma.crmWorkspaceAccess.upsert
		).not.toHaveBeenCalled();
	});
});
