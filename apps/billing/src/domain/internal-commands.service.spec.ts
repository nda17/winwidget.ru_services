import { ConflictException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { billingCommandRequestHash } from './billing-command-idempotency';
import { InternalCommandsService } from './internal-commands.service';

const COMMAND_ID = 'c7de40a7-b401-41d5-92ef-2c437180e201';

function ensureTrialCommand(userId = 'user-1') {
	return {
		schemaVersion: 1,
		commandId: COMMAND_ID,
		userId,
		trialDays: 7,
		registeredAt: '2026-08-14T08:00:00.000Z'
	};
}

function commandHarness() {
	const receipts = new Map<string, any>();
	let previous = Promise.resolve();
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
			billingCommandReceipt: {
				findUnique: jest.fn(({ where }: any) =>
					Promise.resolve(receipts.get(where.commandId) || null)
				),
				create: jest.fn(({ data }: any) => {
					receipts.set(data.commandId, data);
					return Promise.resolve(data);
				})
			}
		};
		try {
			return await callback(transaction);
		} finally {
			release();
		}
	};
	const prisma = {
		$transaction: jest.fn(transactionImpl)
	};
	return { prisma, receipts, transactionImpl };
}

describe('InternalCommandsService subscription directory', () => {
	it('returns a stable sorted user-id snapshot with its high-water mark', async () => {
		const prisma = {
			$transaction: jest
				.fn()
				.mockResolvedValue([
					[{ userId: 'user-a' }, { userId: 'user-b' }],
					{ _max: { sourceSequence: 42n } }
				]),
			subscription: {
				findMany: jest.fn().mockReturnValue('rows-query'),
				aggregate: jest.fn().mockReturnValue('high-water-query')
			}
		};
		const service = new InternalCommandsService(
			prisma as never,
			{} as never
		);

		await expect(service.getSubscriptionUserIds()).resolves.toEqual({
			schemaVersion: 1,
			userIds: ['user-a', 'user-b'],
			count: 2,
			sourceSequence: '42'
		});
		expect(prisma.subscription.findMany).toHaveBeenCalledWith({
			orderBy: { userId: 'asc' },
			select: { userId: true }
		});
	});
});

describe('InternalCommandsService command idempotency', () => {
	it('returns the stored result for an exact duplicate payload', async () => {
		const { prisma, receipts } = commandHarness();
		const subscriptions = {
			ensureTrialInTransaction: jest
				.fn()
				.mockResolvedValue({ id: 'trial-1' })
		};
		const service = new InternalCommandsService(
			prisma as never,
			subscriptions as never
		);

		const first = await service.ensureTrial(ensureTrialCommand());
		const duplicate = await service.ensureTrial(ensureTrialCommand());

		expect(duplicate).toEqual(first);
		expect(subscriptions.ensureTrialInTransaction).toHaveBeenCalledTimes(
			1
		);
		expect(receipts.get(COMMAND_ID)).toMatchObject({
			commandType: 'ENSURE_TRIAL',
			requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			requestHashVersion: 1,
			result: first
		});
	});

	it('rejects the same command ID when its canonical payload changes', async () => {
		const { prisma } = commandHarness();
		const subscriptions = {
			ensureTrialInTransaction: jest
				.fn()
				.mockResolvedValue({ id: 'trial-1' })
		};
		const service = new InternalCommandsService(
			prisma as never,
			subscriptions as never
		);
		await service.ensureTrial(ensureTrialCommand('user-1'));

		await expect(
			service.ensureTrial(ensureTrialCommand('user-2'))
		).rejects.toBeInstanceOf(ConflictException);
		expect(subscriptions.ensureTrialInTransaction).toHaveBeenCalledTimes(
			1
		);
	});

	it('serializes concurrent duplicates and mutates the subscription once', async () => {
		const { prisma } = commandHarness();
		let releaseMutation: () => void = () => undefined;
		const mutationGate = new Promise<void>(resolve => {
			releaseMutation = resolve;
		});
		let mutationStarted: () => void = () => undefined;
		const started = new Promise<void>(resolve => {
			mutationStarted = resolve;
		});
		const subscriptions = {
			ensureTrialInTransaction: jest.fn(async () => {
				mutationStarted();
				await mutationGate;
				return { id: 'trial-1' };
			})
		};
		const service = new InternalCommandsService(
			prisma as never,
			subscriptions as never
		);

		const first = service.ensureTrial(ensureTrialCommand());
		await started;
		const concurrent = service.ensureTrial(ensureTrialCommand());
		releaseMutation();

		await expect(Promise.all([first, concurrent])).resolves.toEqual([
			{ ensured: true, subscriptionId: 'trial-1', userId: 'user-1' },
			{ ensured: true, subscriptionId: 'trial-1', userId: 'user-1' }
		]);
		expect(subscriptions.ensureTrialInTransaction).toHaveBeenCalledTimes(
			1
		);
	});

	it('retries only a transient serializable transaction failure', async () => {
		const { prisma, transactionImpl } = commandHarness();
		prisma.$transaction
			.mockRejectedValueOnce({ code: 'P2034' })
			.mockImplementation(transactionImpl);
		const subscriptions = {
			ensureTrialInTransaction: jest
				.fn()
				.mockResolvedValue({ id: 'trial-1' })
		};
		const service = new InternalCommandsService(
			prisma as never,
			subscriptions as never
		);

		await expect(
			service.ensureTrial(ensureTrialCommand())
		).resolves.toMatchObject({
			subscriptionId: 'trial-1'
		});
		expect(prisma.$transaction).toHaveBeenCalledTimes(2);
		expect(subscriptions.ensureTrialInTransaction).toHaveBeenCalledTimes(
			1
		);
	});

	it('does not retry non-transactional failures', async () => {
		const { prisma } = commandHarness();
		prisma.$transaction.mockRejectedValue({ code: 'P2002' });
		const service = new InternalCommandsService(
			prisma as never,
			{} as never
		);

		await expect(
			service.ensureTrial(ensureTrialCommand())
		).rejects.toEqual({
			code: 'P2002'
		});
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
	});

	it('fails closed when a legacy receipt has no request binding', async () => {
		const { prisma, receipts } = commandHarness();
		receipts.set(COMMAND_ID, {
			commandId: COMMAND_ID,
			commandType: 'ENSURE_TRIAL',
			requestHash: '0'.repeat(64),
			requestHashVersion: 0,
			result: {
				ensured: true,
				subscriptionId: 'legacy-trial',
				userId: 'user-1'
			}
		});
		const subscriptions = {
			ensureTrialInTransaction: jest.fn()
		};
		const service = new InternalCommandsService(
			prisma as never,
			subscriptions as never
		);

		await expect(
			service.ensureTrial(ensureTrialCommand())
		).rejects.toThrow('predates request binding');
		expect(subscriptions.ensureTrialInTransaction).not.toHaveBeenCalled();
	});

	it('hashes object keys canonically while binding the command type', () => {
		expect(
			billingCommandRequestHash('ENSURE_TRIAL', {
				userId: 'user-1',
				trialDays: 7
			})
		).toBe(
			billingCommandRequestHash('ENSURE_TRIAL', {
				trialDays: 7,
				userId: 'user-1'
			})
		);
		expect(
			billingCommandRequestHash('ENSURE_TRIAL', { userId: 'user-1' })
		).not.toBe(
			billingCommandRequestHash('REVOKE_BEFORE_DEACTIVATE', {
				userId: 'user-1'
			})
		);
	});

	it('migrates legacy receipts to an explicit fail-closed hash version', async () => {
		const sql = await readFile(
			join(
				process.cwd(),
				'prisma/migrations/20260814010000_add_billing_command_request_hash/migration.sql'
			),
			'utf8'
		);

		expect(sql).toContain('ADD COLUMN "request_hash" CHAR(64) NOT NULL');
		expect(sql).toContain(
			'ADD COLUMN "request_hash_version" SMALLINT NOT NULL DEFAULT 0'
		);
		expect(sql).toContain(
			"DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'"
		);
		expect(sql).toContain('"request_hash_version" = 1');
		expect(sql).toContain('"request_hash" ~ \'^[0-9a-f]{64}$\'');
	});
});
