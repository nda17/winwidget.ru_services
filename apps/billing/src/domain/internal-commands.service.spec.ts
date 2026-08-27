import { ConflictException } from '@nestjs/common';
import {
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	BillingPeriod,
	PaymentKind,
	PaymentStatus,
	Plan,
	ProviderOperationStatus
} from '@prisma/billing-client';
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

function revokeCommand() {
	return {
		schemaVersion: 1,
		commandId: 'd9e3a88c-e82e-4b05-a895-f273a5582545',
		userId: 'user-1',
		reason: 'USER_DEACTIVATION',
		actorId: 'admin-1',
		actorRole: 'ADMIN' as const,
		occurredAt: '2026-08-27T10:00:00.000Z'
	};
}

function revokeHarness(options: {
	operationStatus?: ProviderOperationStatus;
	operationAttempt?: number;
	yookassaId?: string | null;
}) {
	const now = new Date('2026-08-27T09:00:00.000Z');
	const renewal = {
		id: 'renewal-1',
		userId: 'user-1',
		status: AutoRenewalStatus.ACTIVE,
		stateVersion: 4,
		consentVersion: 'v1',
		consentText: 'Recurring payment consent',
		offerSnapshot: 'Offer snapshot',
		offerSha256: 'offer-sha256',
		offerUpdatedAt: new Date('2026-08-01T00:00:00.000Z'),
		plan: Plan.EASY,
		billingPeriod: BillingPeriod.MONTHLY,
		amount: '990.00',
		currency: 'RUB',
		paymentMethodCiphertext: 'encrypted-provider-method'
	};
	const payment = {
		id: 'payment-1',
		userId: 'user-1',
		kind: PaymentKind.RECURRING,
		status: PaymentStatus.PENDING,
		yookassaId: options.yookassaId ?? null,
		providerStatus: 'creating',
		amount: '990.00',
		paymentMethodCiphertext: 'encrypted-provider-method',
		confirmationUrl: null,
		cancelledAt: null,
		cancellationReason: null,
		aggregateVersion: 1n,
		sourceSequence: 1n,
		createdAt: now,
		updatedAt: now
	};
	const providerOperation = options.operationStatus
		? {
				id: 'operation-1',
				status: options.operationStatus,
				attempt: options.operationAttempt ?? 0
			}
		: null;
	const transaction = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		$queryRaw: jest.fn().mockResolvedValue([]),
		billingCommandReceipt: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockResolvedValue({})
		},
		autoRenewal: {
			findUnique: jest.fn().mockResolvedValue(renewal),
			update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
				Promise.resolve({
					...renewal,
					...data,
					stateVersion: 5,
					paymentMethodCiphertext: null
				})
			)
		},
		autoRenewalConsentEvent: {
			create: jest.fn().mockResolvedValue({})
		},
		providerOperation: {
			findFirst: jest.fn().mockResolvedValue(providerOperation),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		payment: {
			findMany: jest.fn().mockResolvedValue([payment]),
			update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
				Promise.resolve({
					...payment,
					...data,
					aggregateVersion: 2n,
					sourceSequence: data.sourceSequence,
					updatedAt: new Date('2026-08-27T10:00:00.000Z')
				})
			)
		},
		billingSourceSequence: {
			upsert: jest.fn().mockResolvedValue({ nextValue: 2n })
		},
		outboxEvent: {
			create: jest.fn().mockResolvedValue({})
		}
	};
	const prisma = {
		$transaction: jest.fn(
			async (work: (client: typeof transaction) => unknown) =>
				work(transaction)
		)
	};
	return {
		payment,
		renewal,
		service: new InternalCommandsService(prisma as never, {} as never),
		transaction
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

describe('InternalCommandsService identity deactivation safety', () => {
	it('revokes consent but preserves an attempted PENDING provider operation for reconciliation', async () => {
		const { service, transaction } = revokeHarness({
			operationStatus: ProviderOperationStatus.PENDING,
			operationAttempt: 1
		});

		await expect(
			service.revokeBeforeDeactivate(revokeCommand())
		).resolves.toMatchObject({
			revoked: true,
			cancelledPayments: 0,
			stateVersion: 5
		});

		expect(transaction.autoRenewal.update).toHaveBeenCalledWith({
			where: { id: 'renewal-1' },
			data: expect.objectContaining({
				status: AutoRenewalStatus.REVOKED,
				paymentMethodCiphertext: null,
				dispatchPending: false
			})
		});
		expect(
			transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				type: AutoRenewalConsentEventType.ADMIN_REVOKED,
				source: 'IDENTITY_LIFECYCLE'
			})
		});
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				status: ProviderOperationStatus.PENDING,
				attempt: 1
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.UNKNOWN,
				lastErrorCode: 'IDENTITY_DEACTIVATION_RECONCILIATION_REQUIRED'
			})
		});
		expect(transaction.payment.update).toHaveBeenCalledWith({
			where: { id: 'payment-1' },
			data: expect.objectContaining({
				status: PaymentStatus.PENDING,
				providerStatus: 'unknown',
				paymentMethodCiphertext: null,
				cancelledAt: null,
				cancellationReason: null
			})
		});
	});

	it('fails and cancels a never-attempted PENDING provider operation', async () => {
		const { service, transaction } = revokeHarness({
			operationStatus: ProviderOperationStatus.PENDING,
			operationAttempt: 0
		});

		await expect(
			service.revokeBeforeDeactivate(revokeCommand())
		).resolves.toMatchObject({
			revoked: true,
			cancelledPayments: 1
		});

		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				status: ProviderOperationStatus.PENDING,
				attempt: 0
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.FAILED,
				lastErrorCode: 'IDENTITY_DEACTIVATION'
			})
		});
		expect(transaction.payment.update).toHaveBeenCalledWith({
			where: { id: 'payment-1' },
			data: expect.objectContaining({
				status: PaymentStatus.CANCELLED,
				providerStatus: 'not_sent',
				paymentMethodCiphertext: null,
				cancellationReason: 'IDENTITY_DEACTIVATION'
			})
		});
	});

	it.each([ProviderOperationStatus.SUCCEEDED, undefined])(
		'preserves a payment with a known provider id when the latest operation is %s',
		async operationStatus => {
			const { service, transaction } = revokeHarness({
				operationStatus,
				operationAttempt: 1,
				yookassaId: 'provider-payment-1'
			});

			await expect(
				service.revokeBeforeDeactivate(revokeCommand())
			).resolves.toMatchObject({
				revoked: true,
				cancelledPayments: 0
			});

			expect(
				transaction.providerOperation.updateMany
			).not.toHaveBeenCalled();
			expect(transaction.payment.update).toHaveBeenCalledWith({
				where: { id: 'payment-1' },
				data: expect.objectContaining({
					status: PaymentStatus.PENDING,
					providerStatus: 'unknown',
					paymentMethodCiphertext: null
				})
			});
		}
	);
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
