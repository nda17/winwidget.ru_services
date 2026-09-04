import {
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { CrmCommercialPolicyService } from './crm-commercial-policy.service';

const command = {
	schemaVersion: 1 as const,
	commandId: '22222222-2222-4222-8222-222222222222',
	expectedVersion: 1,
	monthlyPriceMinor: 99000,
	yearlyPriceMinor: 990000,
	additionalSeatMonthlyPriceMinor: 29000,
	additionalSeatYearlyPriceMinor: 290000,
	includedSeats: 2,
	trialSeatLimit: 5
};
const initial = {
	version: 1,
	monthlyPriceMinor: 99000,
	yearlyPriceMinor: 990000,
	additionalSeatMonthlyPriceMinor: 29000,
	additionalSeatYearlyPriceMinor: 290000,
	includedSeats: 2,
	trialSeatLimit: 5,
	trialDays: 5,
	graceDays: 3,
	createdByUserId: null,
	createdAt: new Date('2026-09-05T10:00:00.000Z')
};
const context = { actor: { subject: 'dev-1', roles: ['DEV'] } };

function harness() {
	const transaction = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		crmCommercialPolicy: {
			findFirst: jest.fn().mockResolvedValue(initial),
			create: jest.fn(async ({ data }) => ({
				...data,
				createdAt: initial.createdAt
			}))
		},
		billingCommandReceipt: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockResolvedValue({})
		},
		outboxEvent: { create: jest.fn().mockResolvedValue({}) }
	};
	const prisma = {
		...transaction,
		$transaction: jest.fn(async callback => callback(transaction))
	};
	return {
		transaction,
		prisma,
		service: new CrmCommercialPolicyService(prisma as never)
	};
}

describe('CrmCommercialPolicyService', () => {
	it('requires a persisted policy rather than inventing prices on GET', async () => {
		const { transaction, service } = harness();
		transaction.crmCommercialPolicy.findFirst.mockResolvedValueOnce(null);
		await expect(service.get()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		expect(transaction.crmCommercialPolicy.create).not.toHaveBeenCalled();
	});

	it('returns only the public pricing-policy fields, without actor PII', async () => {
		const { service } = harness();
		await expect(service.get()).resolves.toEqual({
			schemaVersion: 1,
			productCode: 'WINCRM',
			version: 1,
			currency: 'RUB',
			monthlyPriceMinor: 99000,
			yearlyPriceMinor: 990000,
			additionalSeatMonthlyPriceMinor: 29000,
			additionalSeatYearlyPriceMinor: 290000,
			includedSeats: 2,
			trialSeatLimit: 5,
			trialDays: 5,
			graceDays: 3,
			createdAt: initial.createdAt.toISOString()
		});
	});

	it('rejects non-DEV writes before opening a transaction', async () => {
		const { service, prisma } = harness();
		await expect(
			service.update(command, {
				actor: { subject: 'admin-1', roles: ['ADMIN'] }
			} as never)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('creates a new immutable revision with receipt and Outbox audit in one transaction', async () => {
		const { service, transaction } = harness();
		const result = await service.update(
			{ ...command, includedSeats: 3 },
			context as never
		);
		expect(result).toMatchObject({
			version: 2,
			includedSeats: 3,
			trialDays: 5,
			graceDays: 3
		});
		expect(transaction.crmCommercialPolicy.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				version: 2,
				includedSeats: 3,
				createdByUserId: 'dev-1'
			})
		});
		expect(transaction.billingCommandReceipt.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				commandId: command.commandId,
				requestHashVersion: 1,
				requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
				result
			})
		});
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				payload: expect.objectContaining({
					action: 'SITE_SETTINGS_UPDATE',
					section: 'SITE_SETTINGS',
					actorId: 'dev-1',
					entity: {
						type: 'crm_commercial_policy',
						id: '2',
						label: 'WinCRM',
						targetUserId: null
					},
					metadata: expect.objectContaining({
						before: expect.objectContaining({
							version: 1,
							includedSeats: 2
						}),
						after: expect.objectContaining({
							version: 2,
							includedSeats: 3
						})
					})
				})
			})
		});
	});

	it('rejects stale expectedVersion without writing a revision, audit or receipt', async () => {
		const { service, transaction } = harness();
		await expect(
			service.update({ ...command, expectedVersion: 2 }, context as never)
		).rejects.toMatchObject({
			response: expect.objectContaining({
				code: 'crm_commercial_policy_version_conflict'
			})
		});
		expect(transaction.crmCommercialPolicy.create).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
		expect(
			transaction.billingCommandReceipt.create
		).not.toHaveBeenCalled();
	});

	it('returns the original result on retry, even after another policy revision', async () => {
		const { service, transaction } = harness();
		const result = await service.update(command, context as never);
		const receipt =
			transaction.billingCommandReceipt.create.mock.calls[0][0].data;
		transaction.billingCommandReceipt.findUnique.mockResolvedValueOnce(
			receipt
		);
		transaction.crmCommercialPolicy.findFirst.mockClear();
		await expect(
			service.update(command, context as never)
		).resolves.toEqual(result);
		expect(
			transaction.crmCommercialPolicy.findFirst
		).not.toHaveBeenCalled();
		expect(transaction.crmCommercialPolicy.create).toHaveBeenCalledTimes(
			1
		);
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
	});

	it.each(['payload', 'actor', 'type', 'legacy'])(
		'rejects mismatched %s when reusing a command ID',
		async mismatch => {
			const { service, transaction } = harness();
			await service.update(command, context as never);
			const receipt =
				transaction.billingCommandReceipt.create.mock.calls[0][0].data;
			transaction.billingCommandReceipt.findUnique.mockResolvedValueOnce({
				...receipt,
				...(mismatch === 'type' ? { commandType: 'OTHER' } : {}),
				...(mismatch === 'legacy' ? { requestHashVersion: 0 } : {})
			});
			await expect(
				service.update(
					{
						...command,
						...(mismatch === 'payload' ? { trialSeatLimit: 6 } : {})
					},
					(mismatch === 'actor'
						? { actor: { subject: 'dev-2', roles: ['DEV'] } }
						: context) as never
				)
			).rejects.toMatchObject({ status: 409 });
			expect(transaction.crmCommercialPolicy.create).toHaveBeenCalledTimes(
				1
			);
		}
	);

	it('retries serializable conflicts with the same command', async () => {
		const { service, prisma } = harness();
		prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });
		await expect(
			service.update(command, context as never)
		).resolves.toMatchObject({ version: 2 });
		expect(prisma.$transaction).toHaveBeenCalledTimes(2);
	});

	it('does not retry an audit write failure or accept a command without audit', async () => {
		const { service, transaction, prisma } = harness();
		transaction.outboxEvent.create.mockRejectedValueOnce(
			new Error('outbox unavailable')
		);
		await expect(
			service.update(command, context as never)
		).rejects.toThrow('outbox unavailable');
		expect(
			transaction.billingCommandReceipt.create
		).not.toHaveBeenCalled();
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
	});
});
