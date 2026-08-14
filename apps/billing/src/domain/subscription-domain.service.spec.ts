import { Plan, SubscriptionStatus } from '@prisma/billing-client';
import { SubscriptionDomainService } from './subscription-domain.service';

describe('SubscriptionDomainService trial concurrency', () => {
	it('serializes trial creation by user and emits one durable state change', async () => {
		let subscription: Record<string, unknown> | null = null;
		let previous = Promise.resolve();
		let releaseCreate: () => void = () => undefined;
		const createGate = new Promise<void>(resolve => {
			releaseCreate = resolve;
		});
		let createStarted: () => void = () => undefined;
		const started = new Promise<void>(resolve => {
			createStarted = resolve;
		});
		const create = jest.fn(async ({ data }: any) => {
			createStarted();
			await createGate;
			const now = new Date('2026-08-14T08:00:00.000Z');
			subscription = {
				id: 'trial-1',
				...data,
				billingPeriod: null,
				periodResetsAt: null,
				leadsThisPeriod: 0,
				createdAt: now,
				updatedAt: now
			};
			return subscription;
		});
		const createMany = jest.fn().mockResolvedValue({ count: 2 });
		const transactionImpl = async (
			callback: (transaction: any) => Promise<unknown>
		) => {
			let release: () => void = () => undefined;
			const claimed = new Promise<void>(resolve => {
				release = resolve;
			});
			const waitForPrevious = previous;
			previous = claimed;
			const transaction = {
				$executeRaw: jest.fn(async () => {
					await waitForPrevious;
					return 1;
				}),
				subscription: {
					findUnique: jest.fn().mockImplementation(() => subscription),
					create
				},
				billingSourceSequence: {
					upsert: jest.fn().mockResolvedValue({ nextValue: 2n })
				},
				outboxEvent: { createMany }
			};
			try {
				return await callback(transaction);
			} finally {
				release();
			}
		};
		const prisma = { $transaction: jest.fn(transactionImpl) };
		const service = new SubscriptionDomainService(
			prisma as never,
			{} as never
		);
		const registeredAt = new Date('2026-08-14T08:00:00.000Z');

		const first = service.ensureTrial('user-1', 7, registeredAt);
		await started;
		const concurrent = service.ensureTrial('user-1', 7, registeredAt);
		releaseCreate();
		const results = await Promise.all([first, concurrent]);

		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({
			id: 'trial-1',
			userId: 'user-1',
			plan: Plan.TRIAL,
			status: SubscriptionStatus.ACTIVE
		});
		expect(results[1]).toBe(results[0]);
		expect(create).toHaveBeenCalledTimes(1);
		expect(createMany).toHaveBeenCalledTimes(1);
	});
});
