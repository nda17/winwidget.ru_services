import { BillingSourceRepairService } from './billing-source-repair.service';
import { AUTO_RENEWAL_CONSENT_TEXT } from '@/billing-boundary/billing-boundary.constants';
import type { PrismaService } from '@/prisma.service';
import { createHash } from 'node:crypto';

describe('BillingSourceRepairService', () => {
	const repairId = '11111111-1111-4111-8111-111111111111';

	const createService = (
		offer: {
			content: string;
			updatedAt: Date;
		} | null
	) => {
		const executeRaw = jest.fn().mockResolvedValue(1);
		const transaction = {
			integrationDeliveryReceipt: {
				createMany: jest.fn().mockResolvedValue({ count: 1 }),
				update: jest.fn().mockResolvedValue({})
			},
			legalPage: {
				findUnique: jest.fn().mockResolvedValue(offer)
			},
			user: {
				findUnique: jest.fn(),
				findFirst: jest.fn().mockResolvedValue({ id: 'referrer-user' })
			},
			$executeRaw: executeRaw
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		return {
			service: new BillingSourceRepairService(prisma),
			prisma,
			transaction,
			executeRaw
		};
	};

	it('re-emits the exact current offer state transactionally', async () => {
		const updatedAt = new Date('2026-08-11T00:00:00.000Z');
		const { service, transaction, executeRaw } = createService({
			content: '<p>offer</p>',
			updatedAt
		});

		await expect(
			service.repair({
				schemaVersion: 1,
				repairId,
				scopes: ['OFFER']
			})
		).resolves.toEqual({
			schemaVersion: 1,
			repairId,
			accepted: true,
			duplicate: false
		});

		const statement = executeRaw.mock.calls[0][0];
		expect(statement.values.slice(0, 4)).toEqual([
			'billing.offer.changed.v1',
			'billing.offer.changed.v1',
			'billing.offer',
			'offer'
		]);
		expect(JSON.parse(statement.values[4])).toEqual({
			id: 'offer',
			content: '<p>offer</p>',
			sha256: createHash('sha256')
				.update('<p>offer</p>', 'utf8')
				.digest('hex'),
			updatedAt: updatedAt.toISOString(),
			consentVersion: 'auto-renewal-2026-07-28-v4',
			consentText: AUTO_RENEWAL_CONSENT_TEXT
		});
		expect(statement.values[5]).toBe(false);
		expect(transaction.user.findUnique).not.toHaveBeenCalled();
	});

	it('emits an offer tombstone when the legal page is absent', async () => {
		const { service, executeRaw } = createService(null);

		await service.repair({
			schemaVersion: 1,
			repairId,
			scopes: ['OFFER']
		});

		const statement = executeRaw.mock.calls[0][0];
		expect(statement.values[4]).toBeNull();
		expect(statement.values[5]).toBe(true);
	});

	it('rejects mixing OFFER with user repair scopes', async () => {
		const { service, executeRaw } = createService(null);

		await expect(
			service.repair({
				schemaVersion: 1,
				repairId,
				userId: 'user-1',
				scopes: ['IDENTITY', 'OFFER']
			})
		).rejects.toThrow('Billing offer repair must be requested separately');
		expect(executeRaw).not.toHaveBeenCalled();
	});

	it('preserves registration time when repairing a referral request', async () => {
		const createdAt = new Date('2026-07-01T12:30:00.000Z');
		const { service, transaction, executeRaw } = createService(null);
		transaction.user.findUnique.mockResolvedValue({
			id: 'referred-user',
			createdAt
		});

		await service.repair({
			schemaVersion: 1,
			repairId,
			userId: 'referred-user',
			referrerId: 'referrer-user',
			scopes: ['REFERRAL']
		});

		const statement = executeRaw.mock.calls[0][0];
		expect(statement.values.slice(0, 4)).toEqual([
			'billing.referral.requested.v1',
			'billing.referral.requested.v1',
			'billing.referral-request',
			'referred-user'
		]);
		expect(JSON.parse(statement.values[4])).toEqual({
			referrerId: 'referrer-user',
			referredUserId: 'referred-user',
			requestedAt: createdAt.toISOString()
		});
		expect(statement.values[5]).toBe(false);
	});

	it('rejects referral repair when the referred user is absent', async () => {
		const { service, transaction, executeRaw } = createService(null);
		transaction.user.findUnique.mockResolvedValue(null);

		await expect(
			service.repair({
				schemaVersion: 1,
				repairId,
				userId: 'missing-user',
				referrerId: 'referrer-user',
				scopes: ['REFERRAL']
			})
		).rejects.toThrow('Billing referral repair requires an existing user');
		expect(executeRaw).not.toHaveBeenCalled();
	});

	it('rejects referral repair when the referrer is not active', async () => {
		const { service, transaction, executeRaw } = createService(null);
		transaction.user.findUnique.mockResolvedValue({
			id: 'referred-user',
			createdAt: new Date('2026-07-01T12:30:00.000Z')
		});
		transaction.user.findFirst.mockResolvedValue(null);

		await expect(
			service.repair({
				schemaVersion: 1,
				repairId,
				userId: 'referred-user',
				referrerId: 'inactive-referrer',
				scopes: ['REFERRAL']
			})
		).rejects.toThrow(
			'Billing referral repair requires an active referrer'
		);
		expect(executeRaw).not.toHaveBeenCalled();
	});

	it('rolls back the repair claim when source event recording fails', async () => {
		const { service, prisma, transaction, executeRaw } =
			createService(null);
		let receiptPersisted = false;
		transaction.integrationDeliveryReceipt.createMany.mockImplementation(
			() => Promise.resolve({ count: receiptPersisted ? 0 : 1 })
		);
		(prisma.$transaction as jest.Mock).mockImplementation(
			async callback => {
				const previous = receiptPersisted;
				try {
					const result = await callback(transaction);
					receiptPersisted = true;
					return result;
				} catch (error) {
					receiptPersisted = previous;
					throw error;
				}
			}
		);
		executeRaw.mockRejectedValueOnce(new Error('outbox insert failed'));

		await expect(
			service.repair({ schemaVersion: 1, repairId, scopes: ['OFFER'] })
		).rejects.toThrow('outbox insert failed');
		expect(receiptPersisted).toBe(false);
		await expect(
			service.repair({ schemaVersion: 1, repairId, scopes: ['OFFER'] })
		).resolves.toEqual(
			expect.objectContaining({ duplicate: false, accepted: true })
		);
		expect(
			transaction.integrationDeliveryReceipt.createMany
		).toHaveBeenCalledTimes(2);
	});
});
