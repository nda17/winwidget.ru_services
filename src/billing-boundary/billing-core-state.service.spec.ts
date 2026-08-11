import { BillingCoreStateService } from './billing-core-state.service';
import type { PrismaService } from '@/prisma.service';
import { BillingCoreOwnership } from '@prisma/client';

describe('BillingCoreStateService', () => {
	const activeState = () => ({
		id: 'singleton',
		ownership: BillingCoreOwnership.BILLING,
		sourceProducersEnabled: false,
		legacyRoutesEnabled: false,
		schedulerEnabled: false,
		legacyConsumerEnabled: false,
		projectionConsumerEnabled: true,
		generation: 1n,
		preparedRevision: 'a'.repeat(40),
		ownershipRevision: 'a'.repeat(40),
		activatedAt: new Date('2026-08-11T00:00:00.000Z'),
		updatedAt: new Date('2026-08-11T00:00:00.000Z')
	});

	const createService = (state: ReturnType<typeof activeState>) =>
		new BillingCoreStateService({
			billingCoreState: {
				findUnique: jest.fn().mockResolvedValue(state)
			}
		} as unknown as PrismaService);

	it('accepts only the exact active Billing ownership fence', async () => {
		await expect(
			createService(activeState()).isBillingOwner()
		).resolves.toBe(true);
	});

	it.each([
		{ generation: 0n },
		{ preparedRevision: null },
		{ ownershipRevision: 'b'.repeat(40) },
		{ sourceProducersEnabled: true },
		{ legacyRoutesEnabled: true },
		{ schedulerEnabled: true },
		{ legacyConsumerEnabled: true },
		{ projectionConsumerEnabled: false },
		{ activatedAt: null }
	])('fails closed for inconsistent active marker %o', async override => {
		await expect(
			createService({ ...activeState(), ...override } as ReturnType<
				typeof activeState
			>).get()
		).rejects.toThrow('Billing ownership marker is inconsistent');
	});
});
