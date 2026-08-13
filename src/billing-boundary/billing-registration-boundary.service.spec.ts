import type { PrismaService } from '@/prisma.service';
import { Role } from '@prisma/client';
import type { BillingCoreStateService } from './billing-core-state.service';
import type { BillingInternalClient } from './billing-internal.client';
import { BillingRegistrationBoundaryService } from './billing-registration-boundary.service';

describe('BillingRegistrationBoundaryService', () => {
	const createService = () => {
		const transaction = {
			user: {
				findFirst: jest.fn().mockResolvedValue({ id: 'referrer-1' })
			},
			$executeRaw: jest.fn().mockResolvedValue(1)
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const state = {
			assertBillingOwner: jest.fn().mockResolvedValue(undefined)
		} as unknown as BillingCoreStateService;
		const client = {
			ensureTrial: jest.fn().mockResolvedValue(undefined),
			revokeEntitlements: jest.fn().mockResolvedValue(undefined)
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

	it('records a validated referral as a durable Billing source event', async () => {
		const { service, state, transaction } = createService();

		await service.captureReferralInTransaction(transaction as never, {
			referrerId: 'referrer-1',
			referredUserId: 'user-1',
			requestedAt: new Date('2026-08-11T00:00:00.000Z')
		});

		expect(state.assertBillingOwner).toHaveBeenCalledTimes(1);
		expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
		const statement = transaction.$executeRaw.mock.calls[0][0];
		expect(statement.values.slice(0, 4)).toEqual([
			'billing.referral.requested.v1',
			'billing.referral.requested.v1',
			'billing.referral-request',
			'user-1'
		]);
	});

	it('does not emit a referral event for an unavailable referrer', async () => {
		const { service, transaction } = createService();
		transaction.user.findFirst.mockResolvedValue(null);

		await service.captureReferralInTransaction(transaction as never, {
			referrerId: 'missing-referrer',
			referredUserId: 'user-1'
		});

		expect(transaction.$executeRaw).not.toHaveBeenCalled();
	});

	it('confirms a trial synchronously through Billing only', async () => {
		const { service, state, client, prisma } = createService();
		const registeredAt = new Date('2026-08-11T00:00:00.000Z');

		await service.ensureTrial('user-1', registeredAt);

		expect(state.assertBillingOwner).toHaveBeenCalledTimes(1);
		expect(client.ensureTrial).toHaveBeenCalledWith({
			commandId: expect.any(String),
			userId: 'user-1',
			registeredAt: registeredAt.toISOString()
		});
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('revokes Billing entitlements before a Core lifecycle mutation', async () => {
		const { service, state, client } = createService();

		await expect(
			service.revokeBeforeLifecycleMutation({
				userId: 'user-1',
				operation: 'DELETE',
				actorId: 'admin-1',
				actorRights: [Role.ADMIN]
			})
		).resolves.toEqual(
			expect.objectContaining({
				remoteApplied: true,
				userId: 'user-1',
				operation: 'DELETE',
				actorRole: Role.ADMIN
			})
		);
		expect(state.assertBillingOwner).toHaveBeenCalledTimes(1);
		expect(client.revokeEntitlements).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'user-1',
				reason: 'USER_SOFT_DELETE',
				actorId: 'admin-1',
				actorRole: Role.ADMIN
			})
		);
	});
});
