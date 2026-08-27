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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PaymentDomainService } from '../domain/payment-domain.service';
import { SubscriptionDomainService } from '../domain/subscription-domain.service';
import { BillingProviderWorkerService } from './billing-provider-worker.service';
import { ProviderRequestError } from './yookassa.service';

describe('Billing provider snapshot migration', () => {
	it('removes only payment_method.id from all existing JSONB snapshots', () => {
		const migration = readFileSync(
			resolve(
				__dirname,
				'../../prisma/migrations/20260827190000_sanitize_provider_payment_method_snapshot/migration.sql'
			),
			'utf8'
		).trim();

		expect(migration).toBe(`UPDATE billing.payments
SET provider_snapshot = provider_snapshot #- '{payment_method,id}'
WHERE provider_snapshot IS NOT NULL
  AND jsonb_typeof(provider_snapshot -> 'payment_method') = 'object'
  AND (provider_snapshot -> 'payment_method') ? 'id';`);
		expect(migration).not.toMatch(
			/RETURNING|RAISE|NOTICE|provider_method_id/i
		);
	});
});

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

	const operation = (overrides: Record<string, unknown> = {}) => ({
		id: 'operation-1',
		paymentId: 'payment-1',
		providerPaymentId: null,
		kind: ProviderOperationKind.CAPTURE_RECURRING,
		status: ProviderOperationStatus.PROCESSING,
		leaseToken: 'lease-1',
		idempotencyKey: 'provider-idempotency-1',
		attempt: 1,
		createdAt: new Date(),
		payment: {
			id: 'payment-1',
			userId: 'user-1'
		},
		...overrides
	});

	const payment = (overrides: Record<string, unknown> = {}) => ({
		id: 'payment-1',
		userId: 'user-1',
		yookassaId: null,
		providerIdempotencyKey: 'provider-idempotency-1',
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
		paymentMethodCiphertext: 'encrypted-method',
		confirmationUrl: null,
		checkoutExpiresAt: new Date(Date.now() + 60_000),
		lastProviderCheckedAt: null,
		cancelledAt: null,
		cancellationReason: null,
		recurringAttempt: 0,
		recurringCycleKey: 'renewal-1:2026-08-11T00:00:00.000Z:attempt:0',
		aggregateVersion: 1n,
		sourceSequence: 1n,
		createdAt: new Date('2026-08-11T00:00:00.000Z'),
		updatedAt: new Date('2026-08-11T00:00:00.000Z'),
		...overrides
	});

	const makeHarness = (
		renewalStatus: AutoRenewalStatus = AutoRenewalStatus.ACTIVE,
		overrides: {
			operation?: Record<string, unknown>;
			payment?: Record<string, unknown>;
		} = {}
	) => {
		const lockedOperation = operation(overrides.operation);
		const lockedPayment = payment(overrides.payment);
		const lockedRenewal = {
			id: 'renewal-1',
			userId: 'user-1',
			status: renewalStatus,
			dispatchPending: true,
			pendingAmount: null,
			paymentMethodCiphertext: 'encrypted-method',
			nextChargeAt: new Date('2026-08-11T00:00:00.000Z'),
			nextRetryAt: null,
			retryAttempt: 0,
			stateVersion: 3,
			consentVersion: 'consent-v1',
			consentText: 'consent text',
			offerSnapshot: 'offer snapshot',
			offerSha256: 'offer-sha256',
			offerUpdatedAt: new Date('2026-08-01T00:00:00.000Z'),
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			amount: '990.00',
			currency: 'RUB'
		};
		const providerResponse = {
			id: 'provider-payment-1',
			status: 'pending'
		};
		const provider = {
			isConfigured: jest.fn().mockReturnValue(true),
			createPayment: jest.fn().mockResolvedValue(providerResponse),
			getPayment: jest.fn().mockResolvedValue(providerResponse)
		};
		let currentOperation = lockedOperation;
		let currentPayment = lockedPayment;
		let currentRenewal = lockedRenewal;
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			providerOperation: {
				findUnique: jest.fn(() => Promise.resolve(currentOperation)),
				findFirst: jest.fn(() => Promise.resolve(currentOperation)),
				updateMany: jest.fn(({ data }: { data: Record<string, any> }) => {
					currentOperation = {
						...currentOperation,
						...data,
						attempt:
							typeof data.attempt === 'object'
								? currentOperation.attempt +
									(data.attempt.increment || 0) -
									(data.attempt.decrement || 0)
								: (data.attempt ?? currentOperation.attempt)
					};
					return Promise.resolve({ count: 1 });
				})
			},
			payment: {
				findUnique: jest.fn(() => Promise.resolve(currentPayment)),
				findUniqueOrThrow: jest.fn(() => Promise.resolve(currentPayment)),
				update: jest.fn(({ data }: { data: Record<string, any> }) => {
					currentPayment = {
						...currentPayment,
						...data,
						updatedAt: new Date()
					};
					return Promise.resolve(currentPayment);
				}),
				updateMany: jest.fn(({ data }: { data: Record<string, any> }) => {
					currentPayment = {
						...currentPayment,
						...data,
						aggregateVersion:
							typeof data.aggregateVersion === 'object'
								? currentPayment.aggregateVersion +
									(data.aggregateVersion.increment || 0n)
								: (data.aggregateVersion ??
									currentPayment.aggregateVersion),
						updatedAt: new Date()
					};
					return Promise.resolve({ count: 1 });
				})
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue({
					userId: 'user-1',
					status: 'ACTIVE',
					deletedAt: null
				})
			},
			autoRenewal: {
				findUnique: jest.fn(() => Promise.resolve(currentRenewal)),
				updateMany: jest.fn(({ data }: { data: Record<string, any> }) => {
					currentRenewal = {
						...currentRenewal,
						...data,
						stateVersion:
							typeof data.stateVersion === 'object'
								? currentRenewal.stateVersion +
									(data.stateVersion.increment || 0)
								: (data.stateVersion ?? currentRenewal.stateVersion)
					};
					return Promise.resolve({ count: 1 });
				})
			},
			autoRenewalConsentEvent: {
				create: jest.fn().mockResolvedValue({ id: 'consent-event-1' })
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 2n })
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({ id: 'outbox-1' })
			},
			affiliateReferral: {
				findFirst: jest.fn().mockResolvedValue(null)
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
			),
			providerOperation: transaction.providerOperation,
			payment: {
				findUnique: jest.fn(() => Promise.resolve(currentPayment))
			}
		};
		const crypto = {
			decrypt: jest.fn().mockReturnValue('provider-method-1')
		};
		const subscriptions = new SubscriptionDomainService(
			{} as never,
			{} as never
		);
		const payments = new PaymentDomainService(
			prisma as never,
			{} as never
		);
		const service = new BillingProviderWorkerService(
			prisma as never,
			{} as never,
			provider as never,
			crypto as never,
			payments,
			subscriptions,
			{} as never
		);
		return {
			service,
			transaction,
			provider,
			crypto,
			providerResponse,
			lockedOperation,
			prisma
		};
	};

	const callUnderFence = (
		service: BillingProviderWorkerService,
		candidate = operation()
	) =>
		(
			service as unknown as {
				createProviderPaymentUnderFence(
					value: ReturnType<typeof operation>
				): Promise<Record<string, unknown> | null>;
			}
		).createProviderPaymentUnderFence(candidate);

	const processClaim = (
		service: BillingProviderWorkerService,
		candidate: ReturnType<typeof operation>
	) =>
		(
			service as unknown as {
				process(value: ReturnType<typeof operation>): Promise<boolean>;
			}
		).process(candidate);

	const handleFailure = (
		service: BillingProviderWorkerService,
		candidate: ReturnType<typeof operation>,
		error: unknown
	) =>
		(
			service as unknown as {
				handleFailure(
					value: ReturnType<typeof operation>,
					error: unknown
				): Promise<void>;
			}
		).handleFailure(candidate, error);

	afterEach(() => {
		jest.useRealTimers();
	});

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

	it('fences an expired first recurring attempt before decrypt or provider POST', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
		const candidate = operation({
			attempt: 1,
			createdAt: new Date('2026-08-26T12:00:00.000Z')
		});
		const { service, provider, crypto, transaction } = makeHarness(
			AutoRenewalStatus.ACTIVE,
			{
				operation: candidate,
				payment: {
					checkoutExpiresAt: new Date('2026-08-27T11:00:00.000Z')
				}
			}
		);

		await expect(callUnderFence(service, candidate)).resolves.toBeNull();

		expect(crypto.decrypt).not.toHaveBeenCalled();
		expect(provider.createPayment).not.toHaveBeenCalled();
		expect(provider.getPayment).not.toHaveBeenCalled();
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.FAILED,
					lastErrorCode: 'CHARGE_WINDOW_EXPIRED'
				})
			})
		);
		expect(transaction.payment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.CANCELLED,
					providerStatus: 'not_sent',
					paymentMethodCiphertext: null,
					cancellationReason: 'CHARGE_WINDOW_EXPIRED'
				})
			})
		);
		expect(transaction.autoRenewal.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: AutoRenewalStatus.TECHNICAL_PAUSE,
					dispatchPending: false,
					lastChargeErrorCode: 'CHARGE_WINDOW_EXPIRED'
				})
			})
		);
		expect(
			transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				type: 'TECHNICAL_PAUSED',
				source: 'AUTO_RENEWAL_DISPATCH_DEADLINE'
			})
		});
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: 'billing.payment.changed.v1'
			})
		});
	});

	it('closes a first recurring dispatch when the deadline passes during local preparation', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T10:00:00.000Z'));
		const candidate = operation({
			attempt: 1,
			createdAt: new Date('2026-08-27T09:00:00.000Z')
		});
		const { service, provider, crypto, transaction } = makeHarness(
			AutoRenewalStatus.ACTIVE,
			{
				operation: candidate,
				payment: {
					checkoutExpiresAt: new Date('2026-08-27T10:00:01.000Z')
				}
			}
		);
		const updatePayment =
			transaction.payment.update.getMockImplementation()!;
		transaction.payment.update.mockImplementationOnce(async input => {
			const result = await updatePayment(input);
			jest.setSystemTime(new Date('2026-08-27T10:00:02.000Z'));
			return result;
		});

		await expect(callUnderFence(service, candidate)).resolves.toBeNull();

		expect(crypto.decrypt).toHaveBeenCalledWith('encrypted-method');
		expect(provider.createPayment).not.toHaveBeenCalled();
		expect(provider.getPayment).not.toHaveBeenCalled();
		expect(transaction.payment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ providerStatus: 'creating' }),
				data: expect.objectContaining({
					status: PaymentStatus.CANCELLED,
					providerStatus: 'not_sent',
					paymentMethodCiphertext: null
				})
			})
		);
		expect(transaction.autoRenewal.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: AutoRenewalStatus.TECHNICAL_PAUSE,
					dispatchPending: false
				})
			})
		);
	});

	it('moves a reclaimed recurring claim to UNKNOWN when its deadline passes during local preparation', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T10:00:00.000Z'));
		const candidate = operation({
			attempt: 2,
			reclaimedProcessingLease: true,
			createdAt: new Date('2026-08-27T09:00:00.000Z')
		});
		const { service, provider, transaction } = makeHarness(
			AutoRenewalStatus.ACTIVE,
			{
				operation: candidate,
				payment: {
					checkoutExpiresAt: new Date('2026-08-27T10:00:01.000Z')
				}
			}
		);
		const updatePayment =
			transaction.payment.update.getMockImplementation()!;
		transaction.payment.update.mockImplementationOnce(async input => {
			const result = await updatePayment(input);
			jest.setSystemTime(new Date('2026-08-27T10:00:02.000Z'));
			return result;
		});

		await expect(callUnderFence(service, candidate)).resolves.toBeNull();

		expect(provider.createPayment).not.toHaveBeenCalled();
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.UNKNOWN,
					lastErrorCode: 'AUTO_RENEWAL_RECONCILIATION_REQUIRED'
				})
			})
		);
		expect(transaction.payment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ providerStatus: 'unknown' })
			})
		);
		expect(transaction.autoRenewal.updateMany).not.toHaveBeenCalled();
	});

	it.each([
		ProviderOperationKind.CREATE_CHECKOUT,
		ProviderOperationKind.CAPTURE_RECURRING
	])(
		'moves an expired reclaimed %s lease to UNKNOWN without another provider call',
		async kind => {
			jest
				.useFakeTimers()
				.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
			const candidate = operation({
				kind,
				attempt: 2,
				reclaimedProcessingLease: true,
				createdAt: new Date('2026-08-27T10:00:00.000Z')
			});
			const { service, provider, crypto, transaction } = makeHarness(
				AutoRenewalStatus.ACTIVE,
				{
					operation: candidate,
					payment: {
						...(kind === ProviderOperationKind.CREATE_CHECKOUT
							? {
									kind: PaymentKind.ONE_TIME,
									autoRenew: false,
									recurringCycleKey: null
								}
							: {}),
						checkoutExpiresAt: new Date('2026-08-27T11:00:00.000Z')
					}
				}
			);

			await expect(callUnderFence(service, candidate)).resolves.toBeNull();

			expect(provider.createPayment).not.toHaveBeenCalled();
			expect(provider.getPayment).not.toHaveBeenCalled();
			expect(crypto.decrypt).not.toHaveBeenCalled();
			expect(
				transaction.providerOperation.updateMany
			).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						status: ProviderOperationStatus.UNKNOWN,
						lastErrorCode: 'PROVIDER_STALE_CLAIM_RECONCILIATION_REQUIRED'
					})
				})
			);
			expect(transaction.payment.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						aggregateVersion: 1n
					}),
					data: expect.objectContaining({
						providerStatus: 'unknown',
						aggregateVersion: { increment: 1n },
						sourceSequence: 1n
					})
				})
			);
			expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					eventType: 'billing.payment.changed.v1',
					aggregateVersion: 2n,
					sourceSequence: 1n
				})
			});
		}
	);

	it('resets a local preflight failure so a later expired retry cannot issue its first POST', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T10:00:00.000Z'));
		const candidate = operation({
			attempt: 1,
			createdAt: new Date('2026-08-27T09:00:00.000Z')
		});
		const first = makeHarness(AutoRenewalStatus.ACTIVE, {
			operation: candidate,
			payment: {
				checkoutExpiresAt: new Date('2026-08-27T10:00:01.000Z')
			}
		});
		first.provider.isConfigured.mockReturnValue(false);
		let preflightFailure: unknown;
		try {
			await callUnderFence(first.service, candidate);
		} catch (error) {
			preflightFailure = error;
		}
		expect(preflightFailure).toBeDefined();

		await handleFailure(first.service, candidate, preflightFailure);

		expect(
			first.transaction.providerOperation.updateMany
		).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ attempt: 1 }),
				data: expect.objectContaining({
					status: ProviderOperationStatus.PENDING,
					attempt: { decrement: 1 }
				})
			})
		);
		expect(first.provider.createPayment).not.toHaveBeenCalled();

		jest.setSystemTime(new Date('2026-08-27T10:00:02.000Z'));
		const retry = makeHarness(AutoRenewalStatus.ACTIVE, {
			operation: candidate,
			payment: {
				checkoutExpiresAt: new Date('2026-08-27T10:00:01.000Z')
			}
		});
		await expect(
			callUnderFence(retry.service, candidate)
		).resolves.toBeNull();
		expect(retry.provider.createPayment).not.toHaveBeenCalled();
		expect(retry.transaction.payment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.CANCELLED,
					paymentMethodCiphertext: null
				})
			})
		);
	});

	it('atomically fails a definitively rejected operation and cancels its payment with an Outbox event', async () => {
		const candidate = operation({
			kind: ProviderOperationKind.CREATE_CHECKOUT
		});
		const { service, transaction } = makeHarness(
			AutoRenewalStatus.ACTIVE,
			{
				operation: candidate,
				payment: {
					kind: PaymentKind.ONE_TIME,
					autoRenew: false,
					recurringCycleKey: null
				}
			}
		);

		await handleFailure(
			service,
			candidate,
			new ProviderRequestError(
				'Payment provider rejected the request',
				'PROVIDER_REJECTED',
				false,
				false,
				400
			)
		);

		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: ProviderOperationStatus.PROCESSING,
					leaseToken: 'lease-1',
					attempt: 1,
					idempotencyKey: 'provider-idempotency-1'
				}),
				data: expect.objectContaining({
					status: ProviderOperationStatus.FAILED,
					lastErrorCode: 'PROVIDER_REJECTED'
				})
			})
		);
		expect(transaction.payment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ aggregateVersion: 1n }),
				data: expect.objectContaining({
					status: PaymentStatus.CANCELLED,
					providerStatus: 'rejected',
					paymentMethodCiphertext: null,
					aggregateVersion: { increment: 1n },
					sourceSequence: 1n
				})
			})
		);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: 'billing.payment.changed.v1',
				aggregateVersion: 2n,
				sourceSequence: 1n
			})
		});
	});

	it('atomically records a malformed successful create response as UNKNOWN without binding it to the payment', async () => {
		const candidate = operation();
		const { service, provider, transaction } = makeHarness();
		let responseFailure: unknown;
		try {
			await processClaim(service, candidate);
		} catch (error) {
			responseFailure = error;
		}
		expect(responseFailure).toBeDefined();

		await handleFailure(service, candidate, responseFailure);

		expect(provider.createPayment).toHaveBeenCalledTimes(1);
		expect(
			transaction.providerOperation.updateMany
		).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.UNKNOWN,
					providerPaymentId: 'provider-payment-1'
				})
			})
		);
		expect(transaction.payment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					yookassaId: null,
					aggregateVersion: 1n
				}),
				data: expect.objectContaining({
					providerStatus: 'unknown',
					aggregateVersion: { increment: 1n },
					sourceSequence: 1n
				})
			})
		);
		expect(
			transaction.payment.updateMany.mock.calls[0][0].data.status
		).toBeUndefined();
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: 'billing.payment.changed.v1'
			})
		});
	});

	it('keeps a bound provider ID and terminalizes a nonretryable recovery GET failure as UNKNOWN', async () => {
		const boundPayment = payment({
			kind: PaymentKind.ONE_TIME,
			autoRenew: false,
			recurringCycleKey: null,
			yookassaId: 'provider-payment-bound',
			providerStatus: 'pending'
		});
		const candidate = operation({
			kind: ProviderOperationKind.CREATE_CHECKOUT,
			payment: boundPayment
		});
		const { service, provider, transaction } = makeHarness(
			AutoRenewalStatus.ACTIVE,
			{ operation: candidate, payment: boundPayment }
		);
		provider.getPayment.mockRejectedValue(
			new ProviderRequestError(
				'Payment provider rejected the request',
				'PROVIDER_REJECTED',
				false,
				false,
				404
			)
		);
		let getFailure: unknown;
		try {
			await processClaim(service, candidate);
		} catch (error) {
			getFailure = error;
		}

		await handleFailure(service, candidate, getFailure);

		expect(provider.getPayment).toHaveBeenCalledWith(
			'provider-payment-bound'
		);
		expect(provider.createPayment).not.toHaveBeenCalled();
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.UNKNOWN,
					providerPaymentId: 'provider-payment-bound'
				})
			})
		);
		expect(transaction.payment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					yookassaId: 'provider-payment-bound'
				}),
				data: expect.objectContaining({ providerStatus: 'unknown' })
			})
		);
		expect(
			transaction.payment.updateMany.mock.calls[0][0].data.status
		).toBeUndefined();
		expect(transaction.outboxEvent.create).toHaveBeenCalled();
	});

	it('keeps an old retryable known-ID GET failure retryable without a POST or payment mutation', async () => {
		const boundPayment = payment({
			kind: PaymentKind.ONE_TIME,
			autoRenew: false,
			recurringCycleKey: null,
			yookassaId: 'provider-payment-bound',
			providerStatus: 'pending'
		});
		const candidate = operation({
			kind: ProviderOperationKind.CREATE_CHECKOUT,
			createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
			payment: boundPayment
		});
		const { service, provider, transaction } = makeHarness(
			AutoRenewalStatus.ACTIVE,
			{ operation: candidate, payment: boundPayment }
		);
		provider.getPayment.mockRejectedValue(
			new ProviderRequestError(
				'Payment provider is temporarily unavailable',
				'PROVIDER_RETRYABLE',
				true,
				false,
				503
			)
		);
		let getFailure: unknown;
		try {
			await processClaim(service, candidate);
		} catch (error) {
			getFailure = error;
		}

		await handleFailure(service, candidate, getFailure);

		expect(provider.createPayment).not.toHaveBeenCalled();
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.PENDING,
					lastErrorCode: 'PROVIDER_RETRYABLE'
				})
			})
		);
		expect(transaction.payment.updateMany).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
	});

	it('retries an attempted recurring POST with the same key inside the safe window after dispatch expiry', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
		const candidate = operation({
			attempt: 2,
			createdAt: new Date('2026-08-27T10:00:00.000Z')
		});
		const { service, provider, crypto, transaction } = makeHarness(
			AutoRenewalStatus.ACTIVE,
			{
				operation: candidate,
				payment: {
					providerStatus: 'creating',
					checkoutExpiresAt: new Date('2026-08-27T11:00:00.000Z')
				}
			}
		);

		await expect(callUnderFence(service, candidate)).resolves.toEqual({
			id: 'provider-payment-1',
			status: 'pending'
		});

		expect(crypto.decrypt).toHaveBeenCalledWith('encrypted-method');
		expect(provider.createPayment).toHaveBeenCalledWith(
			expect.objectContaining({
				paymentId: 'payment-1',
				kind: 'RECURRING',
				paymentMethodId: 'provider-method-1'
			}),
			'provider-idempotency-1'
		);
		expect(transaction.payment.update).not.toHaveBeenCalled();
		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
	});

	it('replays an ambiguous one-time create with the same key inside the safe window after checkout expiry', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
		const candidate = operation({
			kind: ProviderOperationKind.CREATE_CHECKOUT,
			attempt: 2,
			createdAt: new Date('2026-08-27T10:00:00.000Z')
		});
		const { service, provider, transaction } = makeHarness(
			AutoRenewalStatus.ACTIVE,
			{
				operation: candidate,
				payment: {
					kind: PaymentKind.ONE_TIME,
					providerStatus: 'creating',
					autoRenew: false,
					checkoutExpiresAt: new Date('2026-08-27T11:00:00.000Z'),
					recurringAttempt: 0,
					recurringCycleKey: null
				}
			}
		);

		await expect(callUnderFence(service, candidate)).resolves.toEqual({
			id: 'provider-payment-1',
			status: 'pending'
		});

		expect(provider.createPayment).toHaveBeenCalledWith(
			expect.objectContaining({
				paymentId: 'payment-1',
				kind: 'ONE_TIME',
				paymentMethodId: undefined
			}),
			'provider-idempotency-1'
		);
		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.payment.updateMany).not.toHaveBeenCalled();
	});

	it('keeps a never-attempted expired one-time checkout fenced inside the safe window', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
		const candidate = operation({
			kind: ProviderOperationKind.CREATE_CHECKOUT,
			attempt: 1,
			createdAt: new Date('2026-08-27T10:00:00.000Z')
		});
		const { service, provider, transaction } = makeHarness(
			AutoRenewalStatus.ACTIVE,
			{
				operation: candidate,
				payment: {
					kind: PaymentKind.ONE_TIME,
					providerStatus: 'creating',
					autoRenew: false,
					checkoutExpiresAt: new Date('2026-08-27T11:00:00.000Z'),
					recurringCycleKey: null
				}
			}
		);

		await expect(callUnderFence(service, candidate)).resolves.toBeNull();

		expect(provider.createPayment).not.toHaveBeenCalled();
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.FAILED,
					lastErrorCode: 'CHECKOUT_FENCED'
				})
			})
		);
	});

	it.each([
		ProviderOperationKind.CREATE_CHECKOUT,
		ProviderOperationKind.CAPTURE_RECURRING
	])(
		'moves an old %s operation to UNKNOWN without decrypt or provider calls',
		async kind => {
			jest
				.useFakeTimers()
				.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
			const candidate = operation({
				kind,
				attempt: 2,
				createdAt: new Date('2026-08-26T12:00:00.000Z')
			});
			const { service, provider, crypto, transaction } = makeHarness(
				AutoRenewalStatus.ACTIVE,
				{
					operation: candidate,
					payment:
						kind === ProviderOperationKind.CREATE_CHECKOUT
							? {
									kind: PaymentKind.ONE_TIME,
									providerStatus: 'creating',
									autoRenew: false,
									recurringCycleKey: null
								}
							: {}
				}
			);

			await expect(callUnderFence(service, candidate)).resolves.toBeNull();

			expect(provider.createPayment).not.toHaveBeenCalled();
			expect(provider.getPayment).not.toHaveBeenCalled();
			expect(crypto.decrypt).not.toHaveBeenCalled();
			expect(
				transaction.providerOperation.updateMany
			).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						status: ProviderOperationStatus.UNKNOWN,
						lastErrorCode: 'PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED'
					})
				})
			);
			expect(transaction.payment.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ providerStatus: 'unknown' })
				})
			);
		}
	);

	it('uses authenticated GET instead of POST for an old operation with a known provider ID', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
		const candidate = operation({
			kind: ProviderOperationKind.CREATE_CHECKOUT,
			attempt: 2,
			createdAt: new Date('2026-08-26T12:00:00.000Z')
		});
		const { service, provider, transaction } = makeHarness(
			AutoRenewalStatus.ACTIVE,
			{
				operation: candidate,
				payment: {
					kind: PaymentKind.ONE_TIME,
					yookassaId: 'provider-payment-1',
					providerStatus: 'pending',
					autoRenew: false,
					recurringCycleKey: null
				}
			}
		);

		await expect(callUnderFence(service, candidate)).resolves.toEqual({
			id: 'provider-payment-1',
			status: 'pending'
		});

		expect(provider.getPayment).toHaveBeenCalledWith('provider-payment-1');
		expect(provider.createPayment).not.toHaveBeenCalled();
		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
	});

	it('fences an already closed payment before decrypting credentials', async () => {
		const { service, transaction, provider, crypto } = makeHarness();
		transaction.payment.findUnique.mockResolvedValue({
			...payment(),
			status: PaymentStatus.CANCELLED
		} as never);

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
			settleProviderOperationTerminal: jest.fn().mockResolvedValue({})
		};
		const service = new BillingProviderWorkerService(
			prisma as never,
			{} as never,
			{} as never,
			{} as never,
			payments as never,
			{} as never,
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
		expect(
			payments.settleProviderOperationTerminal
		).not.toHaveBeenCalled();
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

		expect(payments.settleProviderOperationTerminal).toHaveBeenCalledWith(
			expect.objectContaining({
				terminalStatus: ProviderOperationStatus.FAILED,
				errorCode: 'PROVIDER_REJECTED',
				paymentProviderStatus: 'rejected',
				cancellationReason: 'PROVIDER_REJECTED'
			})
		);
		expect(prisma.providerOperation.updateMany).not.toHaveBeenCalled();
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

		expect(
			payments.settleProviderOperationTerminal
		).not.toHaveBeenCalled();
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
		expect(
			payments.settleProviderOperationTerminal
		).not.toHaveBeenCalled();
	});

	it('keeps an expired ambiguous provider outcome UNKNOWN for manual reconciliation', async () => {
		const { service, prisma, payments } = makeHarness();

		await fail(
			service,
			ProviderOperationKind.CAPTURE_RECURRING,
			new Error('crashed after the provider accepted the request'),
			new Date(Date.now() - 24 * 60 * 60 * 1000)
		);

		expect(payments.settleProviderOperationTerminal).toHaveBeenCalledWith(
			expect.objectContaining({
				terminalStatus: ProviderOperationStatus.UNKNOWN,
				errorCode: 'WORKER_ERROR'
			})
		);
		expect(prisma.providerOperation.updateMany).not.toHaveBeenCalled();
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
		const crypto = {
			encrypt: jest.fn().mockReturnValue('encrypted-provider-method-1')
		};
		const service = new BillingProviderWorkerService(
			prisma as never,
			{} as never,
			provider as never,
			crypto as never,
			payments as never,
			{} as never,
			success as never
		);
		const process = (candidate: typeof operation = operation) =>
			(
				service as unknown as {
					process(value: typeof operation): Promise<boolean>;
				}
			).process(candidate);
		return { process, prisma, provider, crypto, payments, success };
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
				metadata: { paymentId: 'payment-1' },
				payment_method: {
					id: 'provider-method-must-not-be-stored',
					saved: false,
					type: 'bank_card'
				}
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
				providerStatus: 'pending',
				providerSnapshot: expect.objectContaining({
					payment_method: {
						saved: false,
						type: 'bank_card'
					}
				})
			})
		);
		expect(
			(value.payments.bindProviderState.mock.calls[0][1] as any)
				.providerSnapshot.payment_method
		).not.toHaveProperty('id');
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
		const successInput = value.success.apply.mock.calls[0][0];
		expect(
			successInput.providerSnapshot.payment_method
		).not.toHaveProperty('id');
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
			{} as never,
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

	it('encrypts a saved provider method before passing it into the success transaction', async () => {
		const value = harness([
			{
				id: 'provider-payment-1',
				status: 'succeeded',
				amount: { value: '990.00', currency: 'RUB' },
				metadata: { paymentId: 'payment-1' },
				payment_method: {
					id: 'provider-method-1',
					saved: true,
					type: 'bank_card',
					title: 'Bank card *1111',
					card: { last4: '1111' }
				}
			}
		]);

		await expect(value.process()).resolves.toBe(true);

		expect(value.crypto.encrypt).toHaveBeenCalledWith('provider-method-1');
		expect(value.success.apply).toHaveBeenCalledWith(
			expect.objectContaining({
				paymentMethodCiphertext: 'encrypted-provider-method-1',
				paymentMethodType: 'bank_card',
				paymentMethodTitle: 'Bank card *1111',
				paymentMethodLast4: '1111'
			})
		);
		const successInput = value.success.apply.mock.calls[0][0];
		expect(
			successInput.providerSnapshot.payment_method
		).not.toHaveProperty('id');
		expect(successInput.providerSnapshot.payment_method).toMatchObject({
			saved: true,
			type: 'bank_card',
			title: 'Bank card *1111'
		});
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
