import { BillingRegistrationBoundaryService } from './billing-registration-boundary.service';
import type { BillingCoreStateService } from './billing-core-state.service';
import type { BillingInternalClient } from './billing-internal.client';
import type { PrismaService } from '@/prisma.service';
import { BillingCoreOwnership } from '@prisma/client';

describe('BillingRegistrationBoundaryService', () => {
	const marker = (
		ownership: BillingCoreOwnership,
		sourceProducersEnabled: boolean
	) => ({ ownership, sourceProducersEnabled });

	const createService = () => {
		const transaction = {
			billingCoreState: { findUnique: jest.fn() },
			billingSourceAggregateVersion: { findUnique: jest.fn() },
			siteSettings: { upsert: jest.fn() },
			user: {
				findFirst: jest.fn().mockResolvedValue({ id: 'referrer-1' })
			},
			affiliateReferral: {
				findUnique: jest.fn(),
				create: jest.fn()
			},
			payment: { count: jest.fn() },
			subscription: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({})
			},
			$executeRaw: jest.fn().mockResolvedValue(1),
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'singleton' }])
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const state = {
			get: jest.fn()
		} as unknown as BillingCoreStateService;
		const client = {
			ensureTrial: jest.fn().mockResolvedValue(undefined)
		} as unknown as BillingInternalClient;
		return {
			service: new BillingRegistrationBoundaryService(
				prisma,
				state,
				client
			),
			prisma,
			state,
			client,
			transaction
		};
	};

	it('writes only the legacy referral while Core producers are enabled', async () => {
		const { service, transaction } = createService();
		transaction.billingCoreState.findUnique.mockResolvedValue(
			marker(BillingCoreOwnership.CORE, true)
		);
		transaction.siteSettings.upsert.mockResolvedValue({
			affiliateProgramEnabled: false
		});

		await service.captureReferralInTransaction(transaction as never, {
			referrerId: 'referrer-1',
			referredUserId: 'user-1'
		});

		expect(transaction.siteSettings.upsert).toHaveBeenCalledTimes(1);
		expect(transaction.$executeRaw).not.toHaveBeenCalled();
	});

	it.each([
		[BillingCoreOwnership.CORE, false],
		[BillingCoreOwnership.BILLING, false]
	])(
		'emits only the durable referral request under %s/source=%s',
		async (ownership, producersEnabled) => {
			const { service, transaction } = createService();
			transaction.billingCoreState.findUnique.mockResolvedValue(
				marker(ownership, producersEnabled)
			);

			await service.captureReferralInTransaction(transaction as never, {
				referrerId: 'referrer-1',
				referredUserId: 'user-1',
				requestedAt: new Date('2026-08-11T00:00:00.000Z')
			});

			expect(transaction.siteSettings.upsert).not.toHaveBeenCalled();
			expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
			const statement = transaction.$executeRaw.mock.calls[0][0];
			expect(statement.values.slice(0, 4)).toEqual([
				'billing.referral.requested.v1',
				'billing.referral.requested.v1',
				'billing.referral-request',
				'user-1'
			]);
		}
	);

	it('does not emit an invalid referral request outside legacy ownership', async () => {
		const { service, transaction } = createService();
		transaction.billingCoreState.findUnique.mockResolvedValue(
			marker(BillingCoreOwnership.BILLING, false)
		);
		transaction.user.findFirst.mockResolvedValue(null);

		await service.captureReferralInTransaction(transaction as never, {
			referrerId: 'missing-referrer',
			referredUserId: 'user-1'
		});

		expect(transaction.$executeRaw).not.toHaveBeenCalled();
	});

	it('creates the legacy trial only while Core producers are enabled', async () => {
		const { service, prisma, client, transaction } = createService();
		transaction.billingCoreState.findUnique.mockResolvedValue(
			marker(BillingCoreOwnership.CORE, true)
		);

		await service.ensureTrial('user-1', new Date());

		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(transaction.subscription.create).toHaveBeenCalledTimes(1);
		expect(client.ensureTrial).not.toHaveBeenCalled();
	});

	it('does not duplicate the transactional User trigger event in the frozen window', async () => {
		const { service, prisma, client, transaction } = createService();
		transaction.billingCoreState.findUnique.mockResolvedValue(
			marker(BillingCoreOwnership.CORE, false)
		);
		transaction.billingSourceAggregateVersion.findUnique.mockResolvedValue(
			{
				aggregateId: 'user-1'
			}
		);

		await service.ensureTrial(
			'user-1',
			new Date('2026-08-11T00:00:00.000Z')
		);

		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(transaction.$executeRaw).not.toHaveBeenCalled();
		expect(client.ensureTrial).not.toHaveBeenCalled();
	});

	it('atomically emits the missing trial request when freeze wins the registration race', async () => {
		const { service, transaction, client } = createService();
		const registeredAt = new Date('2026-08-11T00:00:00.000Z');
		transaction.billingCoreState.findUnique.mockResolvedValue(
			marker(BillingCoreOwnership.CORE, false)
		);
		transaction.billingSourceAggregateVersion.findUnique.mockResolvedValue(
			null
		);

		await service.ensureTrial('user-1', registeredAt);

		expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
		expect(transaction.subscription.create).not.toHaveBeenCalled();
		expect(client.ensureTrial).not.toHaveBeenCalled();
		expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
		const statement = transaction.$executeRaw.mock.calls[0][0];
		expect(statement.values.slice(0, 4)).toEqual([
			'billing.trial.requested.v1',
			'billing.trial.requested.v1',
			'billing.trial',
			'user-1'
		]);
		expect(statement.values[4]).toBe(
			JSON.stringify({
				userId: 'user-1',
				trialDays: 7,
				registeredAt: registeredAt.toISOString()
			})
		);
	});

	it('confirms the trial synchronously after Billing ownership', async () => {
		const { service, prisma, client, transaction } = createService();
		const registeredAt = new Date('2026-08-11T00:00:00.000Z');
		transaction.billingCoreState.findUnique.mockResolvedValue(
			marker(BillingCoreOwnership.BILLING, false)
		);

		await service.ensureTrial('user-1', registeredAt);

		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(client.ensureTrial).toHaveBeenCalledWith({
			commandId: expect.any(String),
			userId: 'user-1',
			registeredAt: registeredAt.toISOString()
		});
	});

	it('fails closed on lifecycle mutation while the frozen snapshot is not owned by Billing', async () => {
		const { service, state, client } = createService();
		(state.get as jest.Mock).mockResolvedValue(
			marker(BillingCoreOwnership.CORE, false)
		);

		await expect(
			service.revokeBeforeLifecycleMutation({
				userId: 'user-1',
				operation: 'DEACTIVATE',
				actorId: 'admin-1',
				actorRights: []
			})
		).rejects.toMatchObject({
			response: expect.objectContaining({
				code: 'billing_migration_in_progress'
			})
		});
		expect(client.ensureTrial).not.toHaveBeenCalled();
	});
});
