import {
	AutoRenewalStatus,
	BillingPeriod,
	PaymentKind,
	PaymentStatus,
	Plan,
	ProviderOperationKind,
	ProviderOperationStatus,
	SubscriptionStatus
} from '@prisma/billing-client';
import { BillingProviderWorkerService } from './billing-provider-worker.service';
import { ProviderRequestError } from './yookassa.service';

describe('BillingProviderWorkerService external-call fence', () => {
	const previousClientUrl = process.env.RECAPTCHA_CLIENT_URL;

	beforeAll(() => {
		process.env.RECAPTCHA_CLIENT_URL = 'https://winwidget.ru';
	});

	afterAll(() => {
		if (previousClientUrl === undefined) {
			delete process.env.RECAPTCHA_CLIENT_URL;
		} else {
			process.env.RECAPTCHA_CLIENT_URL = previousClientUrl;
		}
	});

	const operation = () => ({
		id: 'operation-1',
		kind: ProviderOperationKind.CAPTURE_RECURRING,
		status: ProviderOperationStatus.PROCESSING,
		leaseToken: 'lease-1',
		idempotencyKey: 'provider-idempotency-1',
		payment: {
			id: 'payment-1',
			userId: 'user-1'
		}
	});

	const payment = () => ({
		id: 'payment-1',
		userId: 'user-1',
		yookassaId: null,
		kind: PaymentKind.RECURRING,
		status: PaymentStatus.PENDING,
		providerStatus: 'queued',
		amount: '990.00',
		currency: 'RUB',
		plan: Plan.EASY,
		billingPeriod: BillingPeriod.MONTHLY,
		autoRenew: true,
		customerEmail: 'user@example.com',
		customerPhone: null,
		checkoutExpiresAt: new Date('2026-08-12T00:00:00.000Z'),
		recurringAttempt: 0,
		recurringCycleKey: 'renewal-1:2026-08-11T00:00:00.000Z:attempt:0'
	});

	const makeHarness = (
		renewalStatus: AutoRenewalStatus = AutoRenewalStatus.ACTIVE
	) => {
		const providerResponse = {
			id: 'provider-payment-1',
			status: 'pending'
		};
		const provider = {
			createPayment: jest.fn().mockResolvedValue(providerResponse),
			getPayment: jest.fn()
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			providerOperation: {
				findUnique: jest.fn().mockResolvedValue(operation()),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			payment: {
				findUnique: jest.fn().mockResolvedValue(payment()),
				update: jest.fn().mockResolvedValue(payment())
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue({
					userId: 'user-1',
					status: 'ACTIVE',
					deletedAt: null
				})
			},
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue({
					id: 'renewal-1',
					userId: 'user-1',
					status: renewalStatus,
					dispatchPending: true,
					pendingAmount: null,
					paymentMethodCiphertext: 'encrypted-method',
					nextChargeAt: new Date('2026-08-11T00:00:00.000Z'),
					retryAttempt: 0,
					plan: Plan.EASY,
					billingPeriod: BillingPeriod.MONTHLY
				})
			},
			subscription: {
				findUnique: jest.fn().mockResolvedValue({
					status: SubscriptionStatus.ACTIVE,
					expiresAt: new Date('2026-08-11T00:00:00.000Z'),
					plan: Plan.EASY,
					billingPeriod: BillingPeriod.MONTHLY
				})
			}
		};
		const prisma = {
			$transaction: jest.fn(
				async (callback: (client: unknown) => unknown) =>
					callback(transaction)
			)
		};
		const crypto = {
			decrypt: jest.fn().mockReturnValue('provider-method-1')
		};
		const service = new BillingProviderWorkerService(
			prisma as never,
			{} as never,
			provider as never,
			crypto as never,
			{} as never,
			{} as never
		);
		return {
			service,
			transaction,
			provider,
			crypto,
			providerResponse
		};
	};

	const callUnderFence = (service: BillingProviderWorkerService) =>
		(
			service as unknown as {
				createProviderPaymentUnderFence(
					value: ReturnType<typeof operation>
				): Promise<Record<string, unknown> | null>;
			}
		).createProviderPaymentUnderFence(operation());

	it('does not call YooKassa after auto-renewal ownership is revoked', async () => {
		const { service, transaction, provider, crypto } = makeHarness(
			AutoRenewalStatus.REVOKED
		);

		await expect(callUnderFence(service)).resolves.toBeNull();

		expect(provider.createPayment).not.toHaveBeenCalled();
		expect(crypto.decrypt).not.toHaveBeenCalled();
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				status: ProviderOperationStatus.PROCESSING,
				leaseToken: 'lease-1'
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.FAILED,
				lastErrorCode: 'AUTO_RENEWAL_FENCED'
			})
		});
	});

	it('marks the recurring payment in-flight before the external call', async () => {
		const { service, transaction, provider, crypto, providerResponse } =
			makeHarness();

		await expect(callUnderFence(service)).resolves.toEqual(
			providerResponse
		);

		expect(crypto.decrypt).toHaveBeenCalledWith('encrypted-method');
		expect(transaction.payment.update).toHaveBeenCalledWith({
			where: { id: 'payment-1' },
			data: {
				providerStatus: 'creating',
				lastProviderCheckedAt: expect.any(Date)
			}
		});
		expect(provider.createPayment).toHaveBeenCalledWith(
			{
				paymentId: 'payment-1',
				amount: '990.00',
				currency: 'RUB',
				plan: Plan.EASY,
				billingPeriod: BillingPeriod.MONTHLY,
				autoRenew: true,
				customerEmail: 'user@example.com',
				customerPhone: null,
				returnUrl: expect.any(String),
				paymentMethodId: 'provider-method-1',
				kind: 'RECURRING'
			},
			'provider-idempotency-1'
		);
		expect(
			transaction.payment.update.mock.invocationCallOrder[0]
		).toBeLessThan(provider.createPayment.mock.invocationCallOrder[0]);
	});

	it('fences an already closed payment before decrypting credentials', async () => {
		const { service, transaction, provider, crypto } = makeHarness();
		transaction.payment.findUnique.mockResolvedValue({
			...payment(),
			status: PaymentStatus.CANCELLED
		});

		await expect(callUnderFence(service)).resolves.toBeNull();

		expect(provider.createPayment).not.toHaveBeenCalled();
		expect(crypto.decrypt).not.toHaveBeenCalled();
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastErrorCode: 'PAYMENT_OR_IDENTITY_FENCED'
				})
			})
		);
	});
});

describe('BillingProviderWorkerService failure classification', () => {
	const makeHarness = () => {
		const prisma = {
			providerOperation: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const payments = {
			markProviderCancelled: jest.fn().mockResolvedValue({})
		};
		const service = new BillingProviderWorkerService(
			prisma as never,
			{} as never,
			{} as never,
			{} as never,
			payments as never,
			{} as never
		);
		return { service, prisma, payments };
	};

	const fail = (
		service: BillingProviderWorkerService,
		kind: ProviderOperationKind,
		error: unknown,
		createdAt = new Date()
	) =>
		(
			service as unknown as {
				handleFailure(operation: unknown, error: unknown): Promise<void>;
			}
		).handleFailure(
			{
				id: 'operation-1',
				paymentId: 'payment-1',
				providerPaymentId: null,
				leaseToken: 'lease-1',
				attempt: 1,
				kind,
				createdAt
			},
			error
		);

	it('retries unexpected local failures with the same provider idempotency key', async () => {
		const { service, prisma, payments } = makeHarness();

		await fail(
			service,
			ProviderOperationKind.CAPTURE_RECURRING,
			new Error('database commit failed')
		);

		expect(prisma.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.PENDING,
					lastErrorCode: 'WORKER_ERROR'
				})
			})
		);
		expect(payments.markProviderCancelled).not.toHaveBeenCalled();
	});

	it('cancels only after a definitive provider rejection of a payment operation', async () => {
		const { service, prisma, payments } = makeHarness();
		const error = new ProviderRequestError(
			'Payment provider rejected the request',
			'PROVIDER_REJECTED',
			false,
			false,
			400
		);

		await fail(service, ProviderOperationKind.CREATE_CHECKOUT, error);

		expect(prisma.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.FAILED,
					lastErrorCode: 'PROVIDER_REJECTED'
				})
			})
		);
		expect(payments.markProviderCancelled).toHaveBeenCalledWith(
			'payment-1',
			null,
			'rejected',
			'PROVIDER_REJECTED'
		);
	});

	it('never cancels a payment because receipt synchronization was rejected', async () => {
		const { service, payments } = makeHarness();
		const error = new ProviderRequestError(
			'Receipt request was rejected',
			'PROVIDER_REJECTED',
			false,
			false,
			400
		);

		await fail(service, ProviderOperationKind.SYNC_RECEIPT, error);

		expect(payments.markProviderCancelled).not.toHaveBeenCalled();
	});

	it('keeps an old receipt sync retryable after a transient provider failure', async () => {
		const { service, prisma, payments } = makeHarness();

		await fail(
			service,
			ProviderOperationKind.SYNC_RECEIPT,
			new ProviderRequestError(
				'Receipt provider is temporarily unavailable',
				'PROVIDER_RETRYABLE',
				true,
				false,
				503
			),
			new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
		);

		expect(prisma.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.PENDING,
					lastErrorCode: 'PROVIDER_RETRYABLE',
					availableAt: expect.any(Date)
				})
			})
		);
		expect(payments.markProviderCancelled).not.toHaveBeenCalled();
	});

	it('keeps an expired ambiguous provider outcome UNKNOWN for manual reconciliation', async () => {
		const { service, prisma, payments } = makeHarness();

		await fail(
			service,
			ProviderOperationKind.CAPTURE_RECURRING,
			new Error('crashed after the provider accepted the request'),
			new Date(Date.now() - 24 * 60 * 60 * 1000)
		);

		expect(prisma.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.UNKNOWN,
					lastErrorCode: 'WORKER_ERROR'
				})
			})
		);
		expect(payments.markProviderCancelled).not.toHaveBeenCalled();
	});
});

describe('BillingProviderWorkerService webhook re-verification', () => {
	const localPayment = {
		id: 'payment-1',
		amount: '990.00',
		currency: 'RUB'
	};
	const operation = {
		id: 'webhook-operation-1',
		kind: ProviderOperationKind.VERIFY_PAYMENT,
		paymentId: null,
		providerPaymentId: 'provider-payment-1',
		payload: {
			providerPaymentId: 'provider-payment-1',
			source: 'webhook'
		}
	};

	function harness(responses: Array<Record<string, unknown>>) {
		const prisma = {
			payment: {
				findUnique: jest.fn().mockResolvedValue(localPayment)
			}
		};
		const provider = {
			getPayment: jest
				.fn()
				.mockImplementation(() => Promise.resolve(responses.shift()))
		};
		const payments = {
			bindProviderState: jest.fn().mockResolvedValue(localPayment),
			markProviderCancelled: jest.fn()
		};
		const success = {
			apply: jest
				.fn()
				.mockResolvedValueOnce({ duplicate: false })
				.mockResolvedValue({ duplicate: true })
		};
		const service = new BillingProviderWorkerService(
			prisma as never,
			{} as never,
			provider as never,
			{ encrypt: jest.fn() } as never,
			payments as never,
			success as never
		);
		const process = (candidate: typeof operation = operation) =>
			(
				service as unknown as {
					process(value: typeof operation): Promise<boolean>;
				}
			).process(candidate);
		return { process, prisma, provider, payments, success };
	}

	function receiptHarness(
		items: Array<Record<string, unknown>>,
		updateCounts: number[] = [],
		localPayment: { id: string; yookassaId: string | null } | null = {
			id: 'payment-1',
			yookassaId: 'provider-payment-1'
		},
		transactionPayment: { id: string } | null = { id: 'payment-1' }
	) {
		const createMany = jest
			.fn()
			.mockResolvedValue({ count: items.length });
		const updateMany = jest.fn().mockImplementation(() =>
			Promise.resolve({
				count: updateCounts.length > 0 ? updateCounts.shift() : 1
			})
		);
		const transaction = {
			$queryRaw: jest
				.fn()
				.mockResolvedValue(transactionPayment ? [transactionPayment] : []),
			paymentReceipt: { createMany, updateMany }
		};
		const prisma = {
			payment: {
				findUnique: jest.fn().mockResolvedValue(localPayment)
			},
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const provider = {
			getReceipts: jest.fn().mockResolvedValue({ items })
		};
		const service = new BillingProviderWorkerService(
			prisma as never,
			{} as never,
			provider as never,
			{} as never,
			{} as never,
			{} as never
		);
		const syncReceipt = (value: Record<string, unknown>) =>
			(
				service as unknown as {
					syncReceipt(value: Record<string, unknown>): Promise<boolean>;
				}
			).syncReceipt(value);
		return {
			createMany,
			prisma,
			provider,
			syncReceipt,
			transaction,
			updateMany
		};
	}

	it('keeps a forged pre-trigger pending hint retryable and applies the later authenticated success once', async () => {
		const value = harness([
			{
				id: 'provider-payment-1',
				status: 'pending',
				amount: { value: '990.00', currency: 'RUB' },
				metadata: { paymentId: 'payment-1' }
			},
			{
				id: 'provider-payment-1',
				status: 'succeeded',
				amount: { value: '990.00', currency: 'RUB' },
				metadata: { paymentId: 'payment-1' },
				payment_method: {}
			}
		]);

		await expect(value.process()).resolves.toBe(false);
		expect(value.success.apply).not.toHaveBeenCalled();
		expect(value.payments.bindProviderState).toHaveBeenCalledWith(
			'payment-1',
			expect.objectContaining({
				providerPaymentId: 'provider-payment-1',
				providerStatus: 'pending'
			})
		);
		expect(
			value.provider.getPayment.mock.invocationCallOrder[0]
		).toBeLessThan(
			value.prisma.payment.findUnique.mock.invocationCallOrder[0]
		);

		await expect(value.process()).resolves.toBe(true);
		expect(value.success.apply).toHaveBeenCalledTimes(1);
		expect(value.success.apply).toHaveBeenCalledWith(
			expect.objectContaining({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		);
	});

	it('requeues a non-terminal authenticated verification instead of marking terminal dedup', async () => {
		let leaseToken: string | null = null;
		const providerOperation = {
			findFirst: jest.fn().mockResolvedValue({
				...operation,
				status: ProviderOperationStatus.PENDING,
				availableAt: new Date(0),
				createdAt: new Date()
			}),
			updateMany: jest.fn().mockImplementation(({ data }: any) => {
				if (typeof data.leaseToken === 'string')
					leaseToken = data.leaseToken;
				return Promise.resolve({ count: 1 });
			}),
			findUniqueOrThrow: jest.fn().mockImplementation(() =>
				Promise.resolve({
					...operation,
					status: ProviderOperationStatus.PROCESSING,
					leaseToken,
					attempt: 1,
					payment: null,
					createdAt: new Date()
				})
			)
		};
		const prisma = {
			providerOperation,
			payment: { findUnique: jest.fn().mockResolvedValue(localPayment) }
		};
		const provider = {
			getPayment: jest.fn().mockResolvedValue({
				id: 'provider-payment-1',
				status: 'pending',
				amount: { value: '990.00', currency: 'RUB' },
				metadata: { paymentId: 'payment-1' }
			})
		};
		const service = new BillingProviderWorkerService(
			prisma as never,
			{} as never,
			provider as never,
			{} as never,
			{ bindProviderState: jest.fn() } as never,
			{} as never
		);

		await expect(service.processOne()).resolves.toBe(true);

		const completion = providerOperation.updateMany.mock.calls.at(-1)?.[0];
		expect(completion).toEqual(
			expect.objectContaining({
				where: expect.objectContaining({
					status: ProviderOperationStatus.PROCESSING,
					leaseToken
				}),
				data: expect.objectContaining({
					status: ProviderOperationStatus.PENDING,
					availableAt: expect.any(Date),
					leaseToken: null
				})
			})
		);
	});

	it('uses authenticated succeeded state after a forged canceled hint and never downgrades the payment', async () => {
		const value = harness([
			{
				id: 'provider-payment-1',
				status: 'succeeded',
				amount: { value: '990.00', currency: 'RUB' },
				metadata: { paymentId: 'payment-1' },
				payment_method: {}
			}
		]);

		await expect(value.process()).resolves.toBe(true);
		expect(value.success.apply).toHaveBeenCalledTimes(1);
		expect(value.payments.markProviderCancelled).not.toHaveBeenCalled();
		expect(operation.payload).not.toHaveProperty('event');
	});

	it('rejects an unbounded provider payment ID before the authenticated provider GET', async () => {
		const value = harness([]);
		const invalidOperation = {
			...operation,
			providerPaymentId: '../invalid-provider-id',
			payload: {
				providerPaymentId: '../invalid-provider-id',
				source: 'webhook'
			}
		};

		await expect(value.process(invalidOperation)).rejects.toMatchObject({
			code: 'PROVIDER_PAYMENT_ID_INVALID',
			retryable: false
		});
		expect(value.provider.getPayment).not.toHaveBeenCalled();
		expect(value.prisma.payment.findUnique).not.toHaveBeenCalled();
	});

	it('rejects an unbounded receipt ID from the authenticated provider response before persistence', async () => {
		const value = receiptHarness([
			{
				id: '../invalid-receipt-id',
				payment_id: 'provider-payment-1',
				status: 'succeeded'
			}
		]);

		await expect(
			value.syncReceipt({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		).rejects.toMatchObject({
			code: 'PROVIDER_OBJECT_ID_INVALID',
			retryable: false
		});
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejects a receipt operation bound to a different local provider payment before the provider GET', async () => {
		const value = receiptHarness([], [], {
			id: 'payment-1',
			yookassaId: 'provider-payment-2'
		});

		await expect(
			value.syncReceipt({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		).rejects.toMatchObject({
			code: 'LOCAL_PAYMENT_PROVIDER_MISMATCH',
			retryable: false
		});
		expect(value.prisma.payment.findUnique).toHaveBeenCalledWith({
			where: { id: 'payment-1' },
			select: { id: true, yookassaId: true }
		});
		expect(value.provider.getReceipts).not.toHaveBeenCalled();
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('keeps an empty authenticated receipt list non-terminal', async () => {
		const value = receiptHarness([]);

		await expect(
			value.syncReceipt({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		).resolves.toBe(false);
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejects a receipt bound to a different provider payment before persistence', async () => {
		const value = receiptHarness([
			{
				id: 'provider-receipt-1',
				payment_id: 'provider-payment-2',
				status: 'succeeded',
				type: 'payment'
			}
		]);

		await expect(
			value.syncReceipt({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		).rejects.toMatchObject({
			code: 'PROVIDER_RECEIPT_PAYMENT_MISMATCH',
			retryable: false
		});
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejects an unsupported provider receipt type before persistence', async () => {
		const value = receiptHarness([
			{
				id: 'provider-receipt-1',
				payment_id: 'provider-payment-1',
				status: 'succeeded',
				type: 'unknown'
			}
		]);

		await expect(
			value.syncReceipt({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		).rejects.toMatchObject({
			code: 'PROVIDER_RECEIPT_TYPE_INVALID',
			retryable: false
		});
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rolls back when the local provider payment binding changes before receipt persistence', async () => {
		const value = receiptHarness(
			[
				{
					id: 'provider-receipt-1',
					payment_id: 'provider-payment-1',
					status: 'succeeded',
					type: 'payment'
				}
			],
			[],
			{ id: 'payment-1', yookassaId: 'provider-payment-1' },
			null
		);

		await expect(
			value.syncReceipt({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		).rejects.toMatchObject({
			code: 'LOCAL_PAYMENT_PROVIDER_MISMATCH',
			retryable: false
		});
		expect(value.transaction.$queryRaw).toHaveBeenCalledTimes(1);
		const [queryParts, lockedPaymentId, lockedProviderPaymentId] =
			value.transaction.$queryRaw.mock.calls[0];
		const query = queryParts.join(' ').replace(/\s+/g, ' ').trim();
		expect(query).toContain('SELECT id FROM billing.payments WHERE id =');
		expect(query).toContain('AND yookassa_id =');
		expect(query).toContain('FOR UPDATE');
		expect(lockedPaymentId).toBe('payment-1');
		expect(lockedProviderPaymentId).toBe('provider-payment-1');
		expect(value.createMany).not.toHaveBeenCalled();
		expect(value.updateMany).not.toHaveBeenCalled();
	});

	it('rolls back when a provider receipt ID belongs to another local payment', async () => {
		const value = receiptHarness(
			[
				{
					id: 'provider-receipt-1',
					payment_id: 'provider-payment-1',
					status: 'succeeded',
					type: 'payment'
				}
			],
			[0]
		);

		await expect(
			value.syncReceipt({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		).rejects.toMatchObject({
			code: 'PROVIDER_RECEIPT_OWNERSHIP_MISMATCH',
			retryable: false
		});
		expect(value.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					paymentId: 'payment-1',
					providerReceiptId: 'provider-receipt-1'
				}
			})
		);
	});

	it('persists pending receipts but keeps their operation non-terminal', async () => {
		const receipt = {
			id: 'provider-receipt-1',
			payment_id: 'provider-payment-1',
			status: 'pending',
			type: 'payment'
		};
		const value = receiptHarness([receipt]);

		await expect(
			value.syncReceipt({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		).resolves.toBe(false);
		expect(value.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [expect.objectContaining({ status: 'pending' })]
			})
		);
		expect(value.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					paymentId: 'payment-1',
					providerReceiptId: 'provider-receipt-1'
				},
				data: expect.objectContaining({ status: 'pending' })
			})
		);
	});

	it('persists every terminal receipt returned by the provider', async () => {
		const value = receiptHarness([
			{
				id: 'provider-receipt-1',
				payment_id: 'provider-payment-1',
				status: 'succeeded',
				type: 'payment'
			},
			{
				id: 'provider-receipt-2',
				payment_id: 'provider-payment-1',
				status: 'canceled',
				type: 'payment'
			},
			{
				id: 'provider-receipt-3',
				payment_id: 'provider-payment-1',
				status: 'succeeded',
				type: 'refund'
			},
			{
				id: 'provider-receipt-4',
				payment_id: 'provider-payment-1',
				status: 'succeeded',
				type: 'payment'
			}
		]);

		await expect(
			value.syncReceipt({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		).resolves.toBe(true);
		expect(value.updateMany).toHaveBeenCalledTimes(4);
		expect(
			value.updateMany.mock.calls.map(
				call => call[0].where.providerReceiptId
			)
		).toEqual([
			'provider-receipt-1',
			'provider-receipt-2',
			'provider-receipt-3',
			'provider-receipt-4'
		]);
	});

	it('normalizes official top-level fiscal fields and ignores undocumented lookalikes', async () => {
		const receipt = {
			id: 'provider-receipt-1',
			payment_id: 'provider-payment-1',
			status: 'succeeded',
			type: 'payment',
			fiscal_document_number: 'fiscal-document-1',
			fiscal_storage_number: 'fiscal-storage-1',
			fiscal_attribute: 'fiscal-attribute-1',
			registered_at: '2026-08-27T10:00:00.000Z',
			receipt_url: 'https://undocumented.example.test/receipt-1',
			fiscal_document: {
				fiscal_document_number: 'wrong-nested-document',
				fiscal_storage_number: 'wrong-nested-storage',
				fiscal_attribute: 'wrong-nested-attribute'
			}
		};
		const value = receiptHarness([receipt]);

		await expect(
			value.syncReceipt({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1'
			})
		).resolves.toBe(true);

		const normalized = {
			status: 'succeeded',
			type: 'payment',
			fiscalDocumentNumber: 'fiscal-document-1',
			fiscalStorageNumber: 'fiscal-storage-1',
			fiscalAttribute: 'fiscal-attribute-1',
			registeredAt: new Date('2026-08-27T10:00:00.000Z'),
			publicUrl: null,
			raw: receipt
		};
		expect(value.createMany).toHaveBeenCalledWith({
			data: [
				{
					paymentId: 'payment-1',
					providerReceiptId: 'provider-receipt-1',
					...normalized
				}
			],
			skipDuplicates: true
		});
		expect(value.updateMany).toHaveBeenCalledWith({
			where: {
				paymentId: 'payment-1',
				providerReceiptId: 'provider-receipt-1'
			},
			data: normalized
		});
	});
});
