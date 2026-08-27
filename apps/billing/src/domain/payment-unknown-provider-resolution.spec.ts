import {
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	BillingPeriod,
	PaymentKind,
	PaymentStatus,
	Plan,
	ProviderOperationKind,
	ProviderOperationStatus,
	SubscriptionStatus
} from '@prisma/billing-client';
import {
	ConflictException,
	ForbiddenException,
	NotFoundException
} from '@nestjs/common';
import { PaymentDomainService } from './payment-domain.service';
import { PaymentSuccessTransaction } from './payment-success.transaction';

const COMMAND_ID = 'c7de40a7-b401-41d5-92ef-2c437180e201';
const PROVIDER_IDEMPOTENCY_KEY = 'provider-command-1';

const command = (overrides: Record<string, unknown> = {}) => ({
	schemaVersion: 1 as const,
	commandId: COMMAND_ID,
	paymentId: 'payment-1',
	resolution: 'PROVIDER_PAYMENT_NOT_FOUND' as const,
	reason: 'Provider payment was not found after manual reconciliation',
	providerReconciliationConfirmed: true as const,
	checkedMetadataPaymentId: 'payment-1',
	checkedProviderIdempotencyKey: PROVIDER_IDEMPOTENCY_KEY,
	...overrides
});

const actor = {
	id: 'dev-1',
	role: 'DEV' as const,
	ip: '203.0.113.7',
	userAgent: 'billing-resolution-test'
};

function resolutionHarness(
	paymentOverrides: Record<string, unknown> = {},
	operationOverrides: Record<string, unknown> = {}
) {
	let payment = {
		id: 'payment-1',
		userId: 'user-1',
		yookassaId: null,
		providerIdempotencyKey: PROVIDER_IDEMPOTENCY_KEY,
		recurringCycleKey: null,
		recurringAttempt: 0,
		kind: PaymentKind.ONE_TIME,
		amount: '990.00',
		currency: 'RUB',
		confirmationUrl: null,
		status: PaymentStatus.PENDING,
		providerStatus: 'creating',
		plan: Plan.EASY,
		billingPeriod: BillingPeriod.MONTHLY,
		autoRenew: false,
		consentVersion: null,
		consentText: null,
		consentedAt: null,
		consentIp: null,
		consentUserAgent: null,
		offerSnapshot: null,
		offerSha256: null,
		offerUpdatedAt: null,
		customerEmail: 'user@example.com',
		customerPhone: null,
		paymentMethodCiphertext: null,
		providerCreatedAt: null,
		checkoutExpiresAt: new Date(Date.now() - 60_000),
		providerExpiresAt: null,
		lastProviderCheckedAt: null,
		succeededAt: null,
		cancelledAt: null,
		cancellationReason: null,
		receiptSyncEligible: true,
		providerSnapshot: null,
		aggregateVersion: 3n,
		sourceSequence: 8n,
		createdAt: new Date('2026-08-27T10:00:00.000Z'),
		updatedAt: new Date('2026-08-27T10:00:00.000Z'),
		...paymentOverrides
	};
	let operation = {
		id: 'operation-1',
		paymentId: 'payment-1',
		providerPaymentId: null,
		idempotencyKey: PROVIDER_IDEMPOTENCY_KEY,
		kind: ProviderOperationKind.CREATE_CHECKOUT,
		status: ProviderOperationStatus.UNKNOWN,
		...operationOverrides
	};
	const receipts = new Map<string, any>();
	const transaction = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		$queryRaw: jest.fn().mockResolvedValue([]),
		billingCommandReceipt: {
			findUnique: jest.fn(({ where }: any) =>
				Promise.resolve(receipts.get(where.commandId) || null)
			),
			create: jest.fn(({ data }: any) => {
				receipts.set(data.commandId, data);
				return Promise.resolve(data);
			})
		},
		payment: {
			findUnique: jest
				.fn()
				.mockImplementation(() => Promise.resolve(payment)),
			findUniqueOrThrow: jest
				.fn()
				.mockImplementation(() => Promise.resolve(payment)),
			updateMany: jest.fn(({ data }: any) => {
				payment = {
					...payment,
					status: data.status,
					providerStatus: data.providerStatus,
					confirmationUrl: data.confirmationUrl,
					paymentMethodCiphertext: data.paymentMethodCiphertext,
					cancelledAt: data.cancelledAt,
					cancellationReason: data.cancellationReason,
					lastProviderCheckedAt: data.lastProviderCheckedAt,
					aggregateVersion: payment.aggregateVersion + 1n,
					sourceSequence: data.sourceSequence,
					updatedAt: data.cancelledAt
				};
				return Promise.resolve({ count: 1 });
			})
		},
		providerOperation: {
			findUnique: jest
				.fn()
				.mockImplementation(() => Promise.resolve(operation)),
			updateMany: jest.fn(({ data }: any) => {
				operation = { ...operation, ...data };
				return Promise.resolve({ count: 1 });
			})
		},
		billingSourceSequence: {
			upsert: jest.fn().mockResolvedValue({ nextValue: 100n })
		},
		autoRenewal: {
			findUnique: jest.fn().mockResolvedValue(null),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		autoRenewalConsentEvent: {
			create: jest.fn().mockResolvedValue({})
		},
		affiliateReferral: {
			findFirst: jest.fn().mockResolvedValue(null)
		},
		outboxEvent: {
			create: jest.fn().mockResolvedValue({})
		}
	};
	const prisma = {
		$transaction: jest.fn(
			async (work: (client: typeof transaction) => unknown) =>
				work(transaction)
		),
		providerOperation: {
			findUnique: jest
				.fn()
				.mockImplementation(({ where }: any) =>
					Promise.resolve(
						where.id === 'verify-operation'
							? { status: ProviderOperationStatus.SUCCEEDED }
							: operation
					)
				),
			upsert: jest.fn().mockResolvedValue({ id: 'verify-operation' }),
			createMany: jest.fn().mockResolvedValue({ count: 1 }),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		payment: {
			findFirst: jest
				.fn()
				.mockImplementation(() => Promise.resolve(payment)),
			findUnique: jest
				.fn()
				.mockImplementation(() => Promise.resolve(payment))
		},
		identityContactProjection: {
			findUnique: jest.fn().mockResolvedValue({
				userId: 'user-1',
				name: 'Test User',
				email: 'user@example.com',
				phone: null
			})
		}
	};
	const service = new PaymentDomainService(prisma as never, {} as never);
	return { service, prisma, transaction, receipts };
}

describe('PaymentDomainService unknown provider resolution', () => {
	it('returns the minimal DEV reconciliation evidence with the exact persisted idempotency key', async () => {
		const { service } = resolutionHarness();

		const evidence =
			await service.unknownProviderPaymentEvidence(' payment-1 ');

		expect(evidence).toEqual({
			schemaVersion: 1,
			paymentId: 'payment-1',
			status: PaymentStatus.PENDING,
			providerStatus: 'creating',
			checkoutExpiresAt: expect.any(String),
			yookassaId: null,
			providerOperation: {
				id: 'operation-1',
				kind: ProviderOperationKind.CREATE_CHECKOUT,
				status: ProviderOperationStatus.UNKNOWN,
				providerPaymentId: null,
				idempotencyKey: PROVIDER_IDEMPOTENCY_KEY
			}
		});
		expect(Object.keys(evidence).sort()).toEqual(
			[
				'schemaVersion',
				'paymentId',
				'status',
				'providerStatus',
				'checkoutExpiresAt',
				'yookassaId',
				'providerOperation'
			].sort()
		);
		expect(JSON.stringify(evidence)).not.toContain('user@example.com');
		expect(JSON.stringify(evidence)).not.toContain('user-1');
	});

	it('returns a provider ID retained only on the UNKNOWN operation as reconciliation evidence', async () => {
		const { service } = resolutionHarness(
			{ yookassaId: null, providerStatus: 'unknown' },
			{ providerPaymentId: 'provider-payment-from-response' }
		);

		await expect(
			service.unknownProviderPaymentEvidence('payment-1')
		).resolves.toMatchObject({
			yookassaId: null,
			providerOperation: {
				status: ProviderOperationStatus.UNKNOWN,
				providerPaymentId: 'provider-payment-from-response'
			}
		});
	});

	it('queues authenticated verification from an observed UNKNOWN operation ID during admin check', async () => {
		const { service, prisma } = resolutionHarness(
			{ yookassaId: null, providerStatus: 'unknown' },
			{ providerPaymentId: 'provider-payment-from-response' }
		);

		await expect(service.adminCheck('payment-1')).resolves.toMatchObject({
			providerStatus: 'unknown'
		});

		expect(prisma.providerOperation.upsert).toHaveBeenCalledWith({
			where: { idempotencyKey: expect.stringMatching(/^verify:/) },
			create: expect.objectContaining({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-from-response',
				kind: ProviderOperationKind.VERIFY_PAYMENT
			}),
			update: {}
		});
	});

	it('returns 404 for missing evidence and 409 for a non-candidate snapshot', async () => {
		const missing = resolutionHarness();
		missing.prisma.payment.findUnique.mockResolvedValueOnce(null);
		await expect(
			missing.service.unknownProviderPaymentEvidence('missing-payment')
		).rejects.toBeInstanceOf(NotFoundException);

		const ineligible = resolutionHarness({
			checkoutExpiresAt: new Date(Date.now() + 60_000)
		});
		await expect(
			ineligible.service.unknownProviderPaymentEvidence('payment-1')
		).rejects.toBeInstanceOf(ConflictException);

		const invalidOperation = resolutionHarness(
			{},
			{ status: ProviderOperationStatus.PROCESSING }
		);
		await expect(
			invalidOperation.service.unknownProviderPaymentEvidence('payment-1')
		).rejects.toBeInstanceOf(ConflictException);
	});

	it('fails closed for a non-DEV actor before opening a transaction', async () => {
		const { service, prisma } = resolutionHarness();

		await expect(
			service.resolveUnknownProviderPayment(command(), {
				...actor,
				role: 'ADMIN'
			})
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejects manual not-found resolution when UNKNOWN retains an observed provider ID', async () => {
		const { service, transaction } = resolutionHarness(
			{},
			{ providerPaymentId: 'provider-payment-from-response' }
		);

		await expect(
			service.resolveUnknownProviderPayment(command(), actor)
		).rejects.toThrow(
			'Платёж с известным provider ID нужно проверить через adminCheck'
		);
		expect(transaction.payment.updateMany).not.toHaveBeenCalled();
	});

	it('atomically closes only the UNKNOWN operation and records Billing and Operations audit', async () => {
		const { service, prisma, transaction, receipts } = resolutionHarness();

		await expect(
			service.resolveUnknownProviderPayment(command(), actor)
		).resolves.toEqual({
			schemaVersion: 1,
			resolved: true,
			commandId: COMMAND_ID,
			paymentId: 'payment-1',
			resolution: 'PROVIDER_PAYMENT_NOT_FOUND',
			status: PaymentStatus.CANCELLED,
			providerStatus: 'not_found',
			resolvedAt: expect.any(String)
		});

		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: 'Serializable' })
		);
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				paymentId: 'payment-1',
				idempotencyKey: PROVIDER_IDEMPOTENCY_KEY,
				status: ProviderOperationStatus.UNKNOWN
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.FAILED,
				lastErrorCode: 'MANUAL_PROVIDER_NOT_FOUND',
				response: expect.objectContaining({
					actorId: 'dev-1',
					reason: command().reason,
					providerReconciliationConfirmed: true,
					providerIdempotencyKeySha256:
						expect.stringMatching(/^[0-9a-f]{64}$/)
				})
			})
		});
		expect(transaction.payment.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: 'payment-1',
				status: PaymentStatus.PENDING,
				yookassaId: null,
				providerStatus: { in: ['creating', 'unknown'] },
				aggregateVersion: 3n
			}),
			data: expect.objectContaining({
				status: PaymentStatus.CANCELLED,
				providerStatus: 'not_found',
				cancellationReason: 'MANUAL_PROVIDER_NOT_FOUND'
			})
		});
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(2);
		const audit = transaction.outboxEvent.create.mock.calls.find(
			([input]: any[]) =>
				input.data.payload.action === 'PAYMENT_UNKNOWN_PROVIDER_RESOLVED'
		)?.[0];
		expect(audit).toEqual({
			data: expect.objectContaining({
				payload: expect.objectContaining({
					actorId: 'dev-1',
					action: 'PAYMENT_UNKNOWN_PROVIDER_RESOLVED',
					metadata: expect.objectContaining({
						paymentId: 'payment-1',
						providerIdempotencyKeySha256:
							expect.stringMatching(/^[0-9a-f]{64}$/)
					})
				})
			})
		});
		expect(JSON.stringify(audit)).not.toContain(PROVIDER_IDEMPOTENCY_KEY);
		expect(receipts.get(COMMAND_ID)).toMatchObject({
			commandType: 'RESOLVE_UNKNOWN_PROVIDER_PAYMENT',
			requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			requestHashVersion: 1
		});
	});

	it('returns one stored result for an exact retry and rejects command reuse with another reason', async () => {
		const { service, transaction } = resolutionHarness();
		const first = await service.resolveUnknownProviderPayment(
			command(),
			actor
		);
		const duplicate = await service.resolveUnknownProviderPayment(
			command(),
			actor
		);

		expect(duplicate).toEqual(first);
		expect(transaction.payment.updateMany).toHaveBeenCalledTimes(1);
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledTimes(
			1
		);
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(2);

		await expect(
			service.resolveUnknownProviderPayment(
				command({ reason: 'A different manual reason' }),
				actor
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(transaction.payment.updateMany).toHaveBeenCalledTimes(1);
	});

	it('resolves a recurring UNKNOWN capture through the same final-state fence', async () => {
		const consentedAt = new Date('2026-08-01T10:00:00.000Z');
		const nextChargeAt = new Date('2026-08-27T10:00:00.000Z');
		const { service, transaction } = resolutionHarness(
			{
				kind: PaymentKind.RECURRING,
				consentedAt,
				recurringCycleKey: 'renewal-1:2026-08-27T10:00:00.000Z:attempt:0'
			},
			{ kind: ProviderOperationKind.CAPTURE_RECURRING }
		);
		transaction.autoRenewal.findUnique.mockResolvedValue({
			id: 'renewal-1',
			userId: 'user-1',
			status: AutoRenewalStatus.ACTIVE,
			nextChargeAt,
			retryStartedAt: null,
			retryAttempt: 0,
			consentedAt,
			consentVersion: 'consent-v1',
			consentText: 'Recurring payment consent',
			offerSnapshot: 'Offer snapshot',
			offerSha256: 'a'.repeat(64),
			offerUpdatedAt: consentedAt,
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			amount: '990.00',
			currency: 'RUB',
			stateVersion: 4
		});

		await expect(
			service.resolveUnknownProviderPayment(command(), actor)
		).resolves.toMatchObject({
			status: PaymentStatus.CANCELLED,
			providerStatus: 'not_found'
		});
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'operation-1',
					status: ProviderOperationStatus.UNKNOWN
				})
			})
		);
		expect(transaction.autoRenewal.findUnique).toHaveBeenCalledWith({
			where: { userId: 'user-1' }
		});
		expect(transaction.autoRenewal.updateMany).toHaveBeenCalledWith({
			where: { id: 'renewal-1', stateVersion: 4 },
			data: expect.objectContaining({
				status: AutoRenewalStatus.TECHNICAL_PAUSE,
				lastChargeErrorCode: 'MANUAL_PROVIDER_NOT_FOUND',
				stateVersion: { increment: 1 }
			})
		});
		expect(
			transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				type: AutoRenewalConsentEventType.TECHNICAL_PAUSED,
				source: 'YOOKASSA',
				reason: 'MANUAL_PROVIDER_NOT_FOUND',
				metadata: expect.objectContaining({ paymentId: 'payment-1' })
			})
		});
	});

	it.each([
		['already succeeded', { status: PaymentStatus.SUCCEEDED }, {}],
		[
			'not expired',
			{ checkoutExpiresAt: new Date(Date.now() + 60_000) },
			{}
		],
		['has provider ID', { yookassaId: 'provider-payment-1' }, {}],
		['is not creating/unknown', { providerStatus: 'pending' }, {}],
		[
			'provider operation is not UNKNOWN',
			{},
			{ status: ProviderOperationStatus.PROCESSING }
		]
	])('rejects when the payment %s', async (_name, payment, operation) => {
		const { service, transaction } = resolutionHarness(
			payment as Record<string, unknown>,
			operation as Record<string, unknown>
		);

		await expect(
			service.resolveUnknownProviderPayment(command(), actor)
		).rejects.toBeInstanceOf(ConflictException);
		expect(transaction.payment.updateMany).not.toHaveBeenCalled();
		expect(
			transaction.billingCommandReceipt.create
		).not.toHaveBeenCalled();
	});

	it('rejects a mismatched metadata ID or provider idempotency key', async () => {
		for (const invalid of [
			command({ checkedMetadataPaymentId: 'payment-2' }),
			command({ checkedProviderIdempotencyKey: 'provider-command-2' })
		]) {
			const { service, transaction } = resolutionHarness();
			await expect(
				service.resolveUnknownProviderPayment(invalid, actor)
			).rejects.toBeInstanceOf(ConflictException);
			expect(transaction.payment.updateMany).not.toHaveBeenCalled();
		}
	});

	it('retries a serializable conflict without weakening the CAS fences', async () => {
		const { service, prisma, transaction } = resolutionHarness();
		prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });

		await expect(
			service.resolveUnknownProviderPayment(command(), actor)
		).resolves.toMatchObject({ resolved: true });
		expect(prisma.$transaction).toHaveBeenCalledTimes(2);
		expect(transaction.payment.updateMany).toHaveBeenCalledTimes(1);
	});
});

describe('PaymentDomainService late webhook recovery', () => {
	it('treats webhook metadata as untrusted and queues an unbound provider re-verification', async () => {
		const { service, prisma } = resolutionHarness();
		const body = {
			event: 'payment.succeeded',
			object: {
				id: 'provider-payment-1',
				metadata: { paymentId: 'forged-local-payment' }
			}
		};

		await service.webhook(body);

		expect(prisma.providerOperation.createMany).toHaveBeenCalledWith({
			data: {
				paymentId: null,
				providerPaymentId: 'provider-payment-1',
				idempotencyKey: 'webhook:verify:provider-payment-1',
				kind: ProviderOperationKind.VERIFY_PAYMENT,
				payload: {
					providerPaymentId: 'provider-payment-1',
					source: 'webhook'
				}
			},
			skipDuplicates: true
		});
		expect(prisma.payment.findUnique).not.toHaveBeenCalled();
	});

	it('CAS-rearms one provider verification for concurrent duplicate hints regardless of claimed event', async () => {
		const { service, prisma } = resolutionHarness();
		prisma.providerOperation.createMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });

		await Promise.all([
			service.webhook({
				event: 'payment.succeeded',
				object: { id: 'provider-payment-1' }
			}),
			service.webhook({
				event: 'payment.canceled',
				object: { id: 'provider-payment-1' }
			})
		]);

		expect(prisma.providerOperation.createMany).toHaveBeenCalledTimes(2);
		expect(prisma.providerOperation.updateMany).toHaveBeenCalledTimes(1);
		expect(prisma.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				idempotencyKey: 'webhook:verify:provider-payment-1',
				kind: ProviderOperationKind.VERIFY_PAYMENT,
				paymentId: null,
				providerPaymentId: 'provider-payment-1',
				status: {
					in: [
						ProviderOperationStatus.PENDING,
						ProviderOperationStatus.SUCCEEDED,
						ProviderOperationStatus.FAILED,
						ProviderOperationStatus.UNKNOWN
					]
				}
			},
			data: expect.objectContaining({
				paymentId: null,
				status: ProviderOperationStatus.PENDING,
				payload: {
					providerPaymentId: 'provider-payment-1',
					source: 'webhook'
				},
				availableAt: expect.any(Date)
			})
		});
	});

	it('rejects unbounded IDs and ignores unsupported receipt notifications', async () => {
		const { service, prisma } = resolutionHarness();

		await service.webhook({
			event: 'payment.succeeded',
			object: { id: '../invalid-provider-id' }
		});
		await service.webhook({
			event: 'receipt.succeeded',
			object: {
				id: 'provider-receipt-1',
				payment_id: 'provider-payment-1'
			}
		});

		expect(prisma.payment.findUnique).not.toHaveBeenCalled();
		expect(prisma.providerOperation.createMany).not.toHaveBeenCalled();
	});
});

describe('PaymentDomainService receipt history recovery', () => {
	it('rearms one terminal receipt sync through the shared command', async () => {
		const payment = {
			id: 'payment-1',
			userId: 'user-1',
			yookassaId: 'provider-payment-1',
			status: PaymentStatus.SUCCEEDED,
			kind: PaymentKind.ONE_TIME,
			amount: '990.00',
			currency: 'RUB',
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			autoRenew: false,
			receiptSyncEligible: true,
			receipts: [
				{
					status: 'canceled',
					type: 'payment',
					registeredAt: null,
					publicUrl: null,
					fiscalDocumentNumber: null
				}
			],
			createdAt: new Date('2026-08-27T10:00:00.000Z'),
			succeededAt: new Date('2026-08-27T10:05:00.000Z')
		};
		const findMany = jest.fn().mockResolvedValueOnce([payment]);
		const providerOperationFindUnique = jest.fn().mockResolvedValueOnce({
			id: 'receipt-operation-1',
			paymentId: 'payment-1',
			providerPaymentId: 'provider-payment-1',
			kind: ProviderOperationKind.SYNC_RECEIPT
		});
		const prisma = {
			$transaction: jest.fn(async (operations: Array<Promise<unknown>>) =>
				Promise.all(operations)
			),
			payment: {
				findMany,
				count: jest.fn().mockResolvedValue(1)
			},
			providerOperation: {
				createMany: jest.fn().mockResolvedValue({ count: 0 }),
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				findUnique: providerOperationFindUnique
			}
		};
		const service = new PaymentDomainService(prisma as never, {} as never);
		const awaitProviderOperation = jest
			.spyOn(
				service as unknown as {
					awaitProviderOperation(operationId: string): Promise<unknown>;
				},
				'awaitProviderOperation'
			)
			.mockResolvedValue(undefined);

		await expect(service.history('user-1')).resolves.toMatchObject({
			total: 1,
			items: [
				{
					id: 'payment-1',
					receipt: { status: 'canceled' }
				}
			]
		});

		expect(prisma.providerOperation.createMany).toHaveBeenCalledWith({
			data: {
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1',
				idempotencyKey: 'receipt:payment-1',
				kind: ProviderOperationKind.SYNC_RECEIPT,
				payload: {
					paymentId: 'payment-1',
					providerPaymentId: 'provider-payment-1'
				}
			},
			skipDuplicates: true
		});
		expect(prisma.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				idempotencyKey: 'receipt:payment-1',
				kind: ProviderOperationKind.SYNC_RECEIPT,
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1',
				status: {
					in: [
						ProviderOperationStatus.SUCCEEDED,
						ProviderOperationStatus.FAILED,
						ProviderOperationStatus.UNKNOWN
					]
				}
			},
			data: expect.objectContaining({
				paymentId: 'payment-1',
				status: ProviderOperationStatus.PENDING,
				availableAt: expect.any(Date),
				leaseToken: null,
				leaseUntil: null
			})
		});
		expect(findMany).toHaveBeenCalledTimes(1);
		expect(providerOperationFindUnique).toHaveBeenCalledTimes(1);
		expect(awaitProviderOperation).not.toHaveBeenCalled();
	});

	it('does not rebind a receipt operation owned by another local payment', async () => {
		const prisma = {
			providerOperation: {
				createMany: jest.fn().mockResolvedValue({ count: 0 }),
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
				findUnique: jest.fn().mockResolvedValue({
					id: 'receipt-operation-1',
					paymentId: 'payment-2',
					providerPaymentId: 'provider-payment-1',
					kind: ProviderOperationKind.SYNC_RECEIPT
				})
			}
		};
		const service = new PaymentDomainService(prisma as never, {} as never);

		await expect(
			service.enqueueReceiptSync('payment-1', 'provider-payment-1')
		).rejects.toThrow('Не удалось запланировать синхронизацию чека');
		expect(prisma.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ paymentId: 'payment-1' })
			})
		);
	});
});

describe('PaymentSuccessTransaction late manual-resolution recovery', () => {
	function successHarness(options: {
		kind: PaymentKind;
		autoRenew: boolean;
		renewalStatus?: AutoRenewalStatus;
	}) {
		const consentedAt = new Date('2026-08-27T09:00:00.000Z');
		const payment = {
			id: 'payment-1',
			userId: 'user-1',
			yookassaId: null,
			kind: options.kind,
			status: PaymentStatus.PENDING,
			providerStatus: 'creating',
			amount: '990.00',
			currency: 'RUB',
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			autoRenew: options.autoRenew,
			consentedAt: options.autoRenew ? consentedAt : null,
			consentVersion: options.autoRenew ? 'v1' : null,
			consentText: options.autoRenew ? 'Recurring payment consent' : null,
			consentIp: options.autoRenew ? '127.0.0.1' : null,
			consentUserAgent: options.autoRenew ? 'billing-test' : null,
			offerSnapshot: options.autoRenew ? 'Offer snapshot' : null,
			offerSha256: options.autoRenew ? 'offer-sha256' : null,
			offerUpdatedAt: options.autoRenew
				? new Date('2026-08-01T00:00:00.000Z')
				: null,
			providerSnapshot: null,
			confirmationUrl: null,
			paymentMethodCiphertext: null,
			succeededAt: null,
			cancelledAt: null,
			cancellationReason: null,
			lastProviderCheckedAt: null,
			aggregateVersion: 1n,
			sourceSequence: 1n,
			createdAt: new Date('2026-08-27T09:00:00.000Z'),
			updatedAt: new Date('2026-08-27T09:00:00.000Z')
		};
		const currentRenewal = options.renewalStatus
			? {
					id: 'renewal-1',
					userId: 'user-1',
					status: options.renewalStatus,
					stateVersion: 7,
					consentVersion: 'v1',
					consentText: 'Recurring payment consent',
					offerSnapshot: 'Offer snapshot',
					offerSha256: 'offer-sha256',
					offerUpdatedAt: new Date('2026-08-01T00:00:00.000Z'),
					plan: Plan.EASY,
					billingPeriod: BillingPeriod.MONTHLY,
					amount: '990.00',
					currency: 'RUB',
					nextChargeAt: new Date('2026-08-27T09:00:00.000Z'),
					retryStartedAt: null,
					retryAttempt: 0,
					nextRetryAt: null,
					dispatchPending: false,
					lastChargeErrorCode: null,
					disabledAt: new Date('2026-08-27T09:30:00.000Z'),
					disableReason: 'Customer disabled renewal',
					paymentMethodCiphertext: null,
					paymentMethodType: null,
					paymentMethodTitle: null,
					paymentMethodLast4: null
				}
			: null;
		const subscription = {
			id: 'subscription-1',
			userId: 'user-1',
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			status: SubscriptionStatus.ACTIVE,
			startsAt: new Date('2026-08-27T11:00:00.000Z'),
			expiresAt: new Date('2026-09-27T11:00:00.000Z'),
			leadsThisPeriod: 0,
			periodResetsAt: new Date('2026-09-27T11:00:00.000Z'),
			aggregateVersion: 1n,
			sourceSequence: 2n,
			createdAt: new Date('2026-08-27T11:00:00.000Z'),
			updatedAt: new Date('2026-08-27T11:00:00.000Z')
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			$executeRaw: jest.fn().mockResolvedValue(1),
			payment: {
				findUnique: jest.fn().mockResolvedValue(payment),
				findFirst: jest.fn().mockResolvedValue(null),
				update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
					Promise.resolve({ ...payment, ...data })
				)
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue({
					userId: 'user-1',
					name: 'User',
					email: 'user@example.com',
					phone: null
				})
			},
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue(currentRenewal),
				upsert: jest.fn().mockResolvedValue({
					id: 'renewal-1',
					userId: 'user-1'
				}),
				update: jest.fn().mockResolvedValue(currentRenewal)
			},
			autoRenewalConsentEvent: {
				create: jest.fn().mockResolvedValue({})
			},
			subscription: {
				findUnique: jest.fn().mockResolvedValue(null),
				upsert: jest.fn().mockResolvedValue(subscription)
			},
			affiliateReferral: {
				findUnique: jest.fn().mockResolvedValue(null)
			},
			providerOperation: {
				upsert: jest.fn().mockResolvedValue({})
			},
			billingSourceSequence: {
				upsert: jest
					.fn()
					.mockResolvedValueOnce({ nextValue: 2n })
					.mockResolvedValueOnce({ nextValue: 3n })
			},
			notificationRoutingProjection: {
				findUnique: jest.fn().mockResolvedValue(null)
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
			currentRenewal,
			payment,
			service: new PaymentSuccessTransaction(prisma as never),
			transaction
		};
	}

	it('activates AutoRenewal from a successful opted-in checkout with a saved method', async () => {
		const { service, transaction } = successHarness({
			kind: PaymentKind.ONE_TIME,
			autoRenew: true
		});

		await expect(
			service.apply({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1',
				providerAmount: '990.00',
				providerCurrency: 'RUB',
				succeededAt: new Date('2026-08-27T11:00:00.000Z'),
				paymentMethodCiphertext: 'encrypted-provider-method-1',
				paymentMethodType: 'bank_card',
				paymentMethodTitle: 'Bank card *1111',
				paymentMethodLast4: '1111'
			})
		).resolves.toMatchObject({
			status: PaymentStatus.SUCCEEDED,
			duplicate: false
		});

		expect(transaction.autoRenewal.upsert).toHaveBeenCalledWith({
			where: { userId: 'user-1' },
			create: expect.objectContaining({
				status: AutoRenewalStatus.ACTIVE,
				paymentMethodCiphertext: 'encrypted-provider-method-1',
				paymentMethodType: 'bank_card',
				paymentMethodLast4: '1111'
			}),
			update: expect.objectContaining({
				status: AutoRenewalStatus.ACTIVE,
				paymentMethodCiphertext: 'encrypted-provider-method-1'
			})
		});
		expect(
			transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				type: AutoRenewalConsentEventType.CONSENT_GRANTED,
				userId: 'user-1',
				actorUserId: 'user-1',
				metadata: expect.objectContaining({ paymentId: 'payment-1' })
			})
		});
	});

	it('applies a late one-time success after an unsafe cancellation request leaves the payment pending', async () => {
		const { service, transaction } = successHarness({
			kind: PaymentKind.ONE_TIME,
			autoRenew: false
		});
		const succeededAt = new Date('2026-08-27T11:00:00.000Z');

		await expect(
			service.apply({
				paymentId: 'payment-1',
				providerPaymentId: 'provider-payment-1',
				providerAmount: '990.00',
				providerCurrency: 'RUB',
				succeededAt
			})
		).resolves.toMatchObject({
			status: PaymentStatus.SUCCEEDED,
			duplicate: false
		});

		expect(transaction.payment.update).toHaveBeenCalledWith({
			where: { id: 'payment-1' },
			data: expect.objectContaining({
				yookassaId: 'provider-payment-1',
				status: PaymentStatus.SUCCEEDED,
				providerStatus: 'succeeded',
				succeededAt
			})
		});
		expect(transaction.subscription.upsert).toHaveBeenCalledTimes(1);
		expect(transaction.autoRenewal.upsert).not.toHaveBeenCalled();
	});

	it.each([AutoRenewalStatus.USER_DISABLED, AutoRenewalStatus.REVOKED])(
		'never reactivates %s renewal after a late recurring success',
		async renewalStatus => {
			const { currentRenewal, service, transaction } = successHarness({
				kind: PaymentKind.RECURRING,
				autoRenew: true,
				renewalStatus
			});

			await expect(
				service.apply({
					paymentId: 'payment-1',
					providerPaymentId: 'provider-payment-1',
					providerAmount: '990.00',
					providerCurrency: 'RUB',
					succeededAt: new Date('2026-08-27T11:00:00.000Z'),
					paymentMethodCiphertext: 'late-provider-method'
				})
			).resolves.toMatchObject({ status: PaymentStatus.SUCCEEDED });

			expect(transaction.autoRenewal.update).toHaveBeenCalledTimes(1);
			const renewalUpdate =
				transaction.autoRenewal.update.mock.calls[0][0];
			expect(renewalUpdate.where).toEqual({ id: 'renewal-1' });
			expect(renewalUpdate.data).not.toHaveProperty('status');
			expect(renewalUpdate.data).not.toHaveProperty('disabledAt');
			expect(renewalUpdate.data).not.toHaveProperty('disableReason');
			expect(renewalUpdate.data).not.toHaveProperty(
				'paymentMethodCiphertext'
			);
			expect(currentRenewal?.paymentMethodCiphertext).toBeNull();
			expect(transaction.autoRenewal.upsert).not.toHaveBeenCalled();
		}
	);

	it('promotes a manually cancelled payment once and treats a repeated webhook as a duplicate', async () => {
		let payment = {
			id: 'payment-1',
			userId: 'user-1',
			yookassaId: null,
			kind: PaymentKind.ONE_TIME,
			status: PaymentStatus.CANCELLED,
			providerStatus: 'not_found',
			amount: '990.00',
			currency: 'RUB',
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			autoRenew: false,
			consentedAt: null,
			consentVersion: null,
			consentText: null,
			consentIp: null,
			consentUserAgent: null,
			offerSnapshot: null,
			offerSha256: null,
			offerUpdatedAt: null,
			providerSnapshot: null,
			confirmationUrl: null,
			paymentMethodCiphertext: null,
			succeededAt: null,
			cancelledAt: new Date('2026-08-27T10:00:00.000Z'),
			cancellationReason: 'MANUAL_PROVIDER_NOT_FOUND',
			lastProviderCheckedAt: new Date('2026-08-27T10:00:00.000Z'),
			aggregateVersion: 3n,
			sourceSequence: 8n,
			createdAt: new Date('2026-08-27T09:00:00.000Z'),
			updatedAt: new Date('2026-08-27T10:00:00.000Z')
		};
		const subscription = {
			id: 'subscription-1',
			userId: 'user-1',
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			status: SubscriptionStatus.ACTIVE,
			startsAt: new Date('2026-08-27T11:00:00.000Z'),
			expiresAt: new Date('2026-09-27T11:00:00.000Z'),
			leadsThisPeriod: 0,
			periodResetsAt: new Date('2026-09-27T11:00:00.000Z'),
			aggregateVersion: 1n,
			sourceSequence: 2n,
			createdAt: new Date('2026-08-27T11:00:00.000Z'),
			updatedAt: new Date('2026-08-27T11:00:00.000Z')
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			$executeRaw: jest.fn().mockResolvedValue(1),
			payment: {
				findUnique: jest
					.fn()
					.mockImplementation(() => Promise.resolve(payment)),
				findFirst: jest.fn().mockResolvedValue(null),
				update: jest.fn(({ data }: any) => {
					payment = {
						...payment,
						...data,
						updatedAt: data.succeededAt
					};
					return Promise.resolve(payment);
				})
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue({
					userId: 'user-1',
					name: 'User',
					email: 'user@example.com',
					phone: null
				})
			},
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue(null)
			},
			subscription: {
				findUnique: jest.fn().mockResolvedValue(null),
				upsert: jest.fn().mockResolvedValue(subscription)
			},
			affiliateReferral: {
				findUnique: jest.fn().mockResolvedValue(null)
			},
			providerOperation: {
				upsert: jest.fn().mockResolvedValue({})
			},
			billingSourceSequence: {
				upsert: jest
					.fn()
					.mockResolvedValueOnce({ nextValue: 2n })
					.mockResolvedValueOnce({ nextValue: 3n })
			},
			notificationRoutingProjection: {
				findUnique: jest.fn().mockResolvedValue(null)
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
		const service = new PaymentSuccessTransaction(prisma as never);
		const success = {
			paymentId: 'payment-1',
			providerPaymentId: 'provider-payment-1',
			providerAmount: '990.00',
			providerCurrency: 'RUB',
			succeededAt: new Date('2026-08-27T11:00:00.000Z'),
			providerSnapshot: {
				id: 'provider-payment-1',
				status: 'succeeded'
			}
		};

		await expect(service.apply(success)).resolves.toMatchObject({
			paymentId: 'payment-1',
			status: PaymentStatus.SUCCEEDED,
			duplicate: false
		});
		await expect(service.apply(success)).resolves.toEqual({
			paymentId: 'payment-1',
			status: PaymentStatus.SUCCEEDED,
			duplicate: true
		});
		expect(transaction.payment.update).toHaveBeenCalledTimes(1);
		expect(transaction.subscription.upsert).toHaveBeenCalledTimes(1);
		expect(transaction.providerOperation.upsert).toHaveBeenCalledTimes(1);
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(4);
		expect(payment).toMatchObject({
			yookassaId: 'provider-payment-1',
			status: PaymentStatus.SUCCEEDED,
			providerStatus: 'succeeded',
			cancelledAt: null,
			cancellationReason: null
		});
	});
});
