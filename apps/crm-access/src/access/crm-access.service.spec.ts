import {
	ConflictException,
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { CrmAccessLifecycle } from '@prisma/crm-access-client';
import { CrmAccessService } from './crm-access.service';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const INITIAL_COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const PIPELINE_ID = '55555555-5555-4555-8555-555555555555';
const BILLING_ENTITLEMENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROVISIONING_COMMAND_TYPE = 'ACTIVATE_WINCRM_TRIAL';
const TEMPLATE_KEY = 'universal-sales';
const TEMPLATE_VERSION = 1;
const TEMPLATE_FINGERPRINT = 'a'.repeat(64);

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
		id: BILLING_ENTITLEMENT_ID,
		workspaceId: WORKSPACE_A,
		provisioningCommandId: COMMAND_ID,
		provisioningCommandType: PROVISIONING_COMMAND_TYPE,
		activatedByUserId: 'user-1',
		planCode: 'TRIAL',
		seatLimit: null,
		trialStartedAt: '2026-09-02T10:00:00.000Z',
		effectiveFrom: '2026-09-02T10:00:00.000Z',
		effectiveUntil: '2026-09-07T10:00:00.000Z',
		aggregateVersion: '1',
		sourceSequence: '1'
	}
});

const onboardingAccess = () => ({
	lifecycle: CrmAccessLifecycle.ONBOARDING,
	billingEntitlementId: BILLING_ENTITLEMENT_ID,
	provisioningCommandId: COMMAND_ID,
	provisioningCommandType: PROVISIONING_COMMAND_TYPE,
	activatedBySubject: 'user-1',
	onboardingCommandId: null,
	onboardingCompletedAt: null,
	onboardingTemplateKey: null,
	onboardingTemplateVersion: null,
	onboardingTemplateFingerprint: null,
	onboardingPipelineId: null
});

const completedAccess = (
	lifecycle: CrmAccessLifecycle = CrmAccessLifecycle.ACTIVE
) => ({
	lifecycle,
	billingEntitlementId: BILLING_ENTITLEMENT_ID,
	provisioningCommandId: COMMAND_ID,
	provisioningCommandType: PROVISIONING_COMMAND_TYPE,
	activatedBySubject: 'user-1',
	onboardingCommandId: INITIAL_COMMAND_ID,
	onboardingCompletedAt: new Date('2026-09-04T10:00:00.000Z'),
	onboardingTemplateKey: TEMPLATE_KEY,
	onboardingTemplateVersion: TEMPLATE_VERSION,
	onboardingTemplateFingerprint: TEMPLATE_FINGERPRINT,
	onboardingPipelineId: PIPELINE_ID
});

const installation = () => ({
	initialCommandId: INITIAL_COMMAND_ID,
	workspaceId: WORKSPACE_A,
	pipelineId: PIPELINE_ID,
	templateKey: TEMPLATE_KEY,
	templateVersion: TEMPLATE_VERSION,
	templateFingerprint: TEMPLATE_FINGERPRINT
});

const installDto = (workspaceId = WORKSPACE_A) => ({
	schemaVersion: 1 as const,
	commandId: COMMAND_ID,
	workspaceId,
	templateKey: TEMPLATE_KEY,
	templateVersion: TEMPLATE_VERSION
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
	const sales = {
		installTemplate: jest.fn().mockResolvedValue({
			schemaVersion: 1,
			installation: { ...installation(), commandId: COMMAND_ID }
		}),
		getInstallation: jest.fn().mockResolvedValue(null)
	};
	const prisma = {
		crmWorkspaceAccess: {
			findUnique: jest.fn().mockResolvedValue(null),
			updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			upsert: jest.fn().mockResolvedValue(onboardingAccess())
		}
	};
	return {
		service: new CrmAccessService(
			identity as never,
			billing as never,
			sales as never,
			prisma as never
		),
		identity,
		billing,
		sales,
		prisma
	};
}

describe('CrmAccessService bootstrap', () => {
	it('returns workspace selection before any Billing, Sales or CRM database call', async () => {
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
		expect(current.sales.getInstallation).not.toHaveBeenCalled();
		expect(
			current.prisma.crmWorkspaceAccess.findUnique
		).not.toHaveBeenCalled();
	});

	it('forbids an account without an active workspace before dependencies', async () => {
		const current = build(context([]));
		await expect(
			current.service.bootstrap('Bearer token')
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.billing.get).not.toHaveBeenCalled();
		expect(current.sales.getInstallation).not.toHaveBeenCalled();
	});

	it('forbids a supplied workspace outside current memberships before dependencies', async () => {
		const current = build();
		await expect(
			current.service.bootstrap('Bearer token', WORKSPACE_B)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.billing.get).not.toHaveBeenCalled();
		expect(current.sales.getInstallation).not.toHaveBeenCalled();
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

	it('keeps an active entitlement in onboarding when Sales has no installation', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue(
			onboardingAccess()
		);
		await expect(
			current.service.bootstrap('Bearer token')
		).resolves.toMatchObject({
			state: 'ONBOARDING',
			entitlementStatus: 'ACTIVE',
			access: { lifecycle: 'ONBOARDING' }
		});
		expect(current.sales.getInstallation).toHaveBeenCalledWith(
			WORKSPACE_A,
			expect.any(String)
		);
		expect(current.billing.get).toHaveBeenCalledTimes(1);
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).not.toHaveBeenCalled();
	});

	it('starts onboarding for an active entitlement without a local profile', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		const result = await current.service.bootstrap('Bearer token');
		expect(result).toMatchObject({
			state: 'ONBOARDING',
			entitlementStatus: 'ACTIVE',
			access: { lifecycle: 'ONBOARDING' }
		});
		expect(current.prisma.crmWorkspaceAccess.upsert).toHaveBeenCalledTimes(
			1
		);
		expect(current.sales.getInstallation).toHaveBeenCalledTimes(1);
		if (result.state === 'WORKSPACE_SELECTION_REQUIRED') {
			throw new Error('Expected a resolved WinCRM workspace');
		}
		expect(result.entitlement).not.toHaveProperty('provisioningCommandId');
		expect(result.entitlement).not.toHaveProperty('activatedByUserId');
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
			current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue(
				completedAccess(lifecycle)
			);
			await expect(
				current.service.bootstrap('Bearer token')
			).resolves.toMatchObject({
				state: lifecycle
			});
			expect(current.sales.getInstallation).not.toHaveBeenCalled();
		}
	);

	it('fails closed when Billing provenance conflicts with local access', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue({
			...onboardingAccess(),
			provisioningCommandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
		});

		await expect(
			current.service.bootstrap('Bearer token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(current.sales.getInstallation).not.toHaveBeenCalled();
	});

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
		expect(current.sales.getInstallation).not.toHaveBeenCalled();
	});

	it('reconciles a committed Sales installation and confirms entitlement again', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue(
			onboardingAccess()
		);
		current.sales.getInstallation.mockResolvedValue({
			schemaVersion: 1,
			installation: installation()
		});

		await expect(
			current.service.bootstrap('Bearer token')
		).resolves.toMatchObject({
			state: 'ACTIVE',
			entitlementStatus: 'ACTIVE',
			access: { lifecycle: 'ACTIVE' }
		});
		expect(current.billing.get).toHaveBeenCalledTimes(2);
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).toHaveBeenCalledWith({
			where: {
				workspaceId: WORKSPACE_A,
				lifecycle: CrmAccessLifecycle.ONBOARDING
			},
			data: expect.objectContaining({
				lifecycle: CrmAccessLifecycle.ACTIVE,
				onboardingCommandId: INITIAL_COMMAND_ID,
				onboardingTemplateKey: TEMPLATE_KEY,
				onboardingTemplateVersion: TEMPLATE_VERSION,
				onboardingTemplateFingerprint: TEMPLATE_FINGERPRINT,
				onboardingPipelineId: PIPELINE_ID,
				onboardingCompletedAt: expect.any(Date)
			})
		});
	});

	it('does not reconcile when the second entitlement check is no longer ACTIVE', async () => {
		const current = build();
		current.billing.get
			.mockResolvedValueOnce(activeEntitlement())
			.mockResolvedValueOnce({
				...activeEntitlement(),
				status: 'EXPIRED'
			});
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue(
			onboardingAccess()
		);
		current.sales.getInstallation.mockResolvedValue({
			schemaVersion: 1,
			installation: installation()
		});

		await expect(
			current.service.bootstrap('Bearer token')
		).resolves.toMatchObject({
			state: 'EXPIRED',
			entitlementStatus: 'EXPIRED',
			access: { lifecycle: 'ONBOARDING' }
		});
		expect(current.billing.get).toHaveBeenCalledTimes(2);
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).not.toHaveBeenCalled();
	});

	it('fails closed without a CAS write when the bootstrap confirmation is unavailable', async () => {
		const current = build();
		current.billing.get
			.mockResolvedValueOnce(activeEntitlement())
			.mockRejectedValueOnce(
				new ServiceUnavailableException('Billing service is unavailable')
			);
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue(
			onboardingAccess()
		);
		current.sales.getInstallation.mockResolvedValue({
			schemaVersion: 1,
			installation: installation()
		});

		await expect(
			current.service.bootstrap('Bearer token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).not.toHaveBeenCalled();
	});

	it('returns the restrictive lifecycle when reconciliation loses a CAS race', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique
			.mockResolvedValueOnce(onboardingAccess())
			.mockResolvedValueOnce(
				completedAccess(CrmAccessLifecycle.SUSPENDED)
			);
		current.prisma.crmWorkspaceAccess.updateMany.mockResolvedValue({
			count: 0
		});
		current.sales.getInstallation.mockResolvedValue({
			schemaVersion: 1,
			installation: installation()
		});

		await expect(
			current.service.bootstrap('Bearer token')
		).resolves.toMatchObject({
			state: 'SUSPENDED',
			access: { lifecycle: 'SUSPENDED' }
		});
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					workspaceId: WORKSPACE_A,
					lifecycle: CrmAccessLifecycle.ONBOARDING
				}
			})
		);
	});
});

describe('CrmAccessService pipeline template onboarding', () => {
	it('rejects an IDOR workspace before Billing, Sales and local database calls', async () => {
		const current = build();
		await expect(
			current.service.installTemplate(
				'Bearer token',
				installDto(WORKSPACE_B)
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.billing.get).not.toHaveBeenCalled();
		expect(current.sales.installTemplate).not.toHaveBeenCalled();
		expect(
			current.prisma.crmWorkspaceAccess.findUnique
		).not.toHaveBeenCalled();
	});

	it('requires OWNER before Billing, Sales and local database calls', async () => {
		const current = build(context([membership(WORKSPACE_A, 'MEMBER')]));
		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.billing.get).not.toHaveBeenCalled();
		expect(current.sales.installTemplate).not.toHaveBeenCalled();
		expect(
			current.prisma.crmWorkspaceAccess.findUnique
		).not.toHaveBeenCalled();
	});

	it.each([
		'NOT_ACTIVATED',
		'GRACE',
		'READ_ONLY',
		'SUSPENDED',
		'EXPIRED',
		'CANCELLED'
	])('rejects Billing %s before calling Sales', async status => {
		const current = build();
		current.billing.get.mockResolvedValue(
			status === 'NOT_ACTIVATED'
				? inactiveEntitlement()
				: { ...activeEntitlement(), status }
		);
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue(
			onboardingAccess()
		);
		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.sales.installTemplate).not.toHaveBeenCalled();
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).not.toHaveBeenCalled();
	});

	it('recreates a missing local onboarding profile from Billing before installing', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).resolves.toMatchObject({ access: { state: 'ACTIVE' } });
		expect(current.prisma.crmWorkspaceAccess.upsert).toHaveBeenCalledTimes(
			1
		);
		expect(current.sales.installTemplate).toHaveBeenCalledTimes(1);
	});

	it.each([CrmAccessLifecycle.READ_ONLY, CrmAccessLifecycle.SUSPENDED])(
		'rejects restrictive local lifecycle %s before calling Sales',
		async lifecycle => {
			const current = build();
			current.billing.get.mockResolvedValue(activeEntitlement());
			current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue({
				...onboardingAccess(),
				lifecycle
			});
			await expect(
				current.service.installTemplate('Bearer token', installDto())
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(current.sales.installTemplate).not.toHaveBeenCalled();
		}
	);

	it('rejects a different template after onboarding is ACTIVE', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue({
			...completedAccess(),
			onboardingTemplateKey: 'support-requests'
		});
		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).rejects.toBeInstanceOf(ConflictException);
		expect(current.sales.installTemplate).not.toHaveBeenCalled();
	});

	it('passes the exact OWNER-derived command and completes only after a second entitlement check', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue(
			onboardingAccess()
		);

		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).resolves.toMatchObject({
			schemaVersion: 1,
			installation: {
				commandId: COMMAND_ID,
				workspaceId: WORKSPACE_A,
				pipelineId: PIPELINE_ID,
				templateKey: TEMPLATE_KEY,
				templateVersion: TEMPLATE_VERSION,
				templateFingerprint: TEMPLATE_FINGERPRINT
			},
			access: { state: 'ACTIVE' }
		});
		expect(current.sales.installTemplate).toHaveBeenCalledWith(
			{
				schemaVersion: 1,
				commandId: COMMAND_ID,
				workspaceId: WORKSPACE_A,
				templateKey: TEMPLATE_KEY,
				templateVersion: TEMPLATE_VERSION,
				installedBySubject: 'user-1'
			},
			expect.any(String)
		);
		expect(current.billing.get).toHaveBeenCalledTimes(2);
		expect(
			current.sales.installTemplate.mock.invocationCallOrder[0]
		).toBeLessThan(current.billing.get.mock.invocationCallOrder[1]);
		expect(current.billing.get.mock.invocationCallOrder[1]).toBeLessThan(
			current.prisma.crmWorkspaceAccess.updateMany.mock
				.invocationCallOrder[0]
		);
	});

	it('does not activate access when the second entitlement check changed', async () => {
		const current = build();
		current.billing.get
			.mockResolvedValueOnce(activeEntitlement())
			.mockResolvedValueOnce({
				...activeEntitlement(),
				status: 'EXPIRED'
			});
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue(
			onboardingAccess()
		);
		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(current.sales.installTemplate).toHaveBeenCalledTimes(1);
		expect(current.billing.get).toHaveBeenCalledTimes(2);
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).not.toHaveBeenCalled();
	});

	it('does not activate access when the second entitlement check is unavailable', async () => {
		const current = build();
		current.billing.get
			.mockResolvedValueOnce(activeEntitlement())
			.mockRejectedValueOnce(
				new ServiceUnavailableException('Billing service is unavailable')
			);
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue(
			onboardingAccess()
		);

		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(current.sales.installTemplate).toHaveBeenCalledTimes(1);
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).not.toHaveBeenCalled();
	});

	it('never overwrites a restrictive lifecycle that wins the completion CAS race', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique
			.mockResolvedValueOnce(onboardingAccess())
			.mockResolvedValueOnce(
				completedAccess(CrmAccessLifecycle.READ_ONLY)
			);
		current.prisma.crmWorkspaceAccess.updateMany.mockResolvedValue({
			count: 0
		});

		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).rejects.toBeInstanceOf(ConflictException);
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					workspaceId: WORKSPACE_A,
					lifecycle: CrmAccessLifecycle.ONBOARDING
				}
			})
		);
		expect(
			current.prisma.crmWorkspaceAccess.upsert
		).not.toHaveBeenCalled();
	});

	it('accepts an idempotent ACTIVE replay only when installation provenance matches', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique
			.mockResolvedValueOnce(completedAccess())
			.mockResolvedValueOnce(completedAccess());
		current.prisma.crmWorkspaceAccess.updateMany.mockResolvedValue({
			count: 0
		});

		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).resolves.toMatchObject({ access: { state: 'ACTIVE' } });
		expect(current.sales.installTemplate).toHaveBeenCalledTimes(1);
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					workspaceId: WORKSPACE_A,
					lifecycle: CrmAccessLifecycle.ONBOARDING
				}
			})
		);
	});

	it('rejects an ACTIVE replay when Sales provenance does not match local access', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique
			.mockResolvedValueOnce(completedAccess())
			.mockResolvedValueOnce({
				...completedAccess(),
				onboardingTemplateFingerprint: 'b'.repeat(64)
			});
		current.prisma.crmWorkspaceAccess.updateMany.mockResolvedValue({
			count: 0
		});

		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).rejects.toBeInstanceOf(ConflictException);
		expect(current.sales.installTemplate).toHaveBeenCalledTimes(1);
	});

	it('does not recheck entitlement or write access when Sales fails', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique.mockResolvedValue(
			onboardingAccess()
		);
		current.sales.installTemplate.mockRejectedValue(
			new ServiceUnavailableException('CRM Sales is unavailable')
		);
		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(current.billing.get).toHaveBeenCalledTimes(1);
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).not.toHaveBeenCalled();
	});

	it('recovers through bootstrap after Sales committed but the Access write failed', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.findUnique
			.mockResolvedValueOnce(onboardingAccess())
			.mockResolvedValueOnce(onboardingAccess());
		current.prisma.crmWorkspaceAccess.updateMany
			.mockRejectedValueOnce(new Error('temporary database failure'))
			.mockResolvedValueOnce({ count: 1 });
		current.sales.getInstallation.mockResolvedValue({
			schemaVersion: 1,
			installation: installation()
		});

		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).rejects.toThrow('temporary database failure');
		await expect(
			current.service.bootstrap('Bearer token', WORKSPACE_A)
		).resolves.toMatchObject({ state: 'ACTIVE' });
		expect(current.sales.installTemplate).toHaveBeenCalledTimes(1);
		expect(current.sales.getInstallation).toHaveBeenCalledTimes(1);
		expect(
			current.prisma.crmWorkspaceAccess.updateMany
		).toHaveBeenCalledTimes(2);
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
		expect(current.prisma.crmWorkspaceAccess.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { workspaceId: WORKSPACE_A },
				create: {
					workspaceId: WORKSPACE_A,
					lifecycle: CrmAccessLifecycle.ONBOARDING,
					billingEntitlementId: BILLING_ENTITLEMENT_ID,
					provisioningCommandId: COMMAND_ID,
					provisioningCommandType: PROVISIONING_COMMAND_TYPE,
					activatedBySubject: 'user-1'
				},
				update: {},
				select: expect.objectContaining({
					lifecycle: true,
					billingEntitlementId: true,
					provisioningCommandId: true
				})
			})
		);
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

	it('recovers after Billing committed Trial but the first local write failed', async () => {
		const current = build();
		current.billing.get.mockResolvedValue(activeEntitlement());
		current.prisma.crmWorkspaceAccess.upsert
			.mockRejectedValueOnce(new Error('temporary database failure'))
			.mockResolvedValue(onboardingAccess());
		current.prisma.crmWorkspaceAccess.findUnique
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValue(onboardingAccess());

		await expect(
			current.service.activateTrial('Bearer token', {
				schemaVersion: 1,
				commandId: COMMAND_ID,
				workspaceId: WORKSPACE_A
			})
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		await expect(
			current.service.bootstrap('Bearer token', WORKSPACE_A)
		).resolves.toMatchObject({
			state: 'ONBOARDING',
			access: { lifecycle: 'ONBOARDING' }
		});
		await expect(
			current.service.installTemplate('Bearer token', installDto())
		).resolves.toMatchObject({ access: { state: 'ACTIVE' } });
		expect(current.billing.activateTrial).toHaveBeenCalledTimes(1);
		expect(current.prisma.crmWorkspaceAccess.upsert).toHaveBeenCalledTimes(
			2
		);
		expect(current.sales.installTemplate).toHaveBeenCalledTimes(1);
	});
});
