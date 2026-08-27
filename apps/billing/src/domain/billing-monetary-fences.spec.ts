import {
	AffiliateReferralStatus,
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
import { ConflictException } from '@nestjs/common';
import { PaymentDomainService } from './payment-domain.service';
import { SubscriptionDomainService } from './subscription-domain.service';
import { TariffAffiliateService } from './tariff-affiliate.service';

describe('Billing monetary operation fences', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	function renewalMutationHarness(
		operationStatus: ProviderOperationStatus,
		operationAttempt = 1,
		paymentYookassaId: string | null = null
	) {
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
			nextChargeAt: new Date('2026-09-27T10:00:00.000Z'),
			paymentMethodCiphertext: 'encrypted-provider-method',
			paymentMethodType: 'bank_card',
			paymentMethodTitle: 'Bank card *1111',
			paymentMethodLast4: '1111',
			paymentMethodSavedAt: new Date('2026-08-27T10:00:00.000Z'),
			retryStartedAt: null,
			retryAttempt: 0,
			nextRetryAt: null,
			dispatchPending: true
		};
		const payment = {
			id: 'payment-1',
			userId: 'user-1',
			kind: PaymentKind.RECURRING,
			status: PaymentStatus.PENDING,
			yookassaId: paymentYookassaId,
			providerStatus: 'creating',
			amount: '990.00',
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			paymentMethodCiphertext: 'encrypted-provider-method',
			cancelledAt: null,
			cancellationReason: null,
			aggregateVersion: 1n,
			sourceSequence: 1n,
			createdAt: new Date('2026-08-27T10:00:00.000Z'),
			updatedAt: new Date('2026-08-27T10:00:00.000Z')
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue(renewal),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			autoRenewalConsentEvent: {
				create: jest.fn().mockResolvedValue({})
			},
			payment: {
				findMany: jest.fn().mockResolvedValue([payment]),
				findUnique: jest.fn().mockResolvedValue(payment),
				update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
					Promise.resolve({
						...payment,
						...data,
						providerStatus: 'unknown',
						paymentMethodCiphertext: null,
						aggregateVersion: 2n,
						sourceSequence: 2n,
						updatedAt: new Date('2026-08-27T10:01:00.000Z')
					})
				)
			},
			providerOperation: {
				findFirst: jest.fn().mockResolvedValue({
					id: 'operation-1',
					status: operationStatus,
					attempt: operationAttempt
				}),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 3n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new PaymentDomainService(prisma as never, {} as never);
		return { payment, prisma, renewal, service, transaction };
	}

	function expiredCheckoutHarness(
		operation: {
			id: string;
			status: ProviderOperationStatus;
			attempt: number;
			createdAt: Date;
		} | null
	) {
		const payment = {
			id: 'payment-expired',
			userId: 'user-1',
			kind: PaymentKind.ONE_TIME,
			status: PaymentStatus.PENDING,
			yookassaId: null,
			providerStatus: 'creating',
			confirmationUrl: null,
			checkoutExpiresAt: new Date('2026-08-27T09:00:00.000Z'),
			amount: '990.00',
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			aggregateVersion: 1n,
			sourceSequence: 1n,
			createdAt: new Date('2026-08-27T08:00:00.000Z'),
			updatedAt: new Date('2026-08-27T08:00:00.000Z')
		};
		const updatedPayment = {
			...payment,
			aggregateVersion: 2n,
			sourceSequence: 2n,
			updatedAt: new Date('2026-08-27T12:00:00.000Z')
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			payment: {
				findUnique: jest.fn().mockResolvedValue(payment),
				findUniqueOrThrow: jest.fn().mockResolvedValue(updatedPayment),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			providerOperation: {
				findFirst: jest.fn().mockResolvedValue(operation),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 3n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			payment: {
				findMany: jest.fn().mockResolvedValue([{ id: payment.id }])
			},
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new PaymentDomainService(prisma as never, {} as never);
		return { payment, prisma, service, transaction };
	}

	function pendingCancellationHarness(
		options: {
			yookassaId?: string | null;
			operation?: {
				id: string;
				status: ProviderOperationStatus;
				attempt: number;
			} | null;
			operationChanged?: number;
		} = {}
	) {
		const payment = {
			id: 'payment-cancel',
			userId: 'user-1',
			yookassaId: options.yookassaId ?? null,
			providerIdempotencyKey: 'provider-key-existing',
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
			paymentMethodCiphertext: null,
			checkoutExpiresAt: new Date('2026-08-27T13:00:00.000Z'),
			cancelledAt: null,
			cancellationReason: null,
			aggregateVersion: 1n,
			sourceSequence: 1n,
			createdAt: new Date('2026-08-27T10:00:00.000Z'),
			updatedAt: new Date('2026-08-27T10:00:00.000Z')
		};
		const operation =
			options.operation === undefined
				? {
						id: 'operation-cancel',
						status: ProviderOperationStatus.PENDING,
						attempt: 0
					}
				: options.operation;
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			payment: {
				findFirst: jest.fn().mockResolvedValue(payment),
				update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
					Promise.resolve({
						...payment,
						...data,
						aggregateVersion: 2n,
						sourceSequence: 2n,
						updatedAt: new Date('2026-08-27T12:00:00.000Z')
					})
				)
			},
			providerOperation: {
				findFirst: jest.fn().mockResolvedValue(operation),
				updateMany: jest
					.fn()
					.mockResolvedValue({ count: options.operationChanged ?? 1 })
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 3n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			billingSettings: {
				upsert: jest.fn().mockResolvedValue({
					paymentEnabled: true,
					autoRenewalSignupEnabled: true
				})
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue({
					userId: 'user-1',
					status: 'ACTIVE',
					deletedAt: null,
					email: 'payer@example.test',
					phone: null
				})
			},
			subscription: { findUnique: jest.fn().mockResolvedValue(null) },
			tariffPrice: {
				upsert: jest.fn().mockResolvedValue({ amount: 990 })
			},
			payment: {
				findMany: jest.fn().mockResolvedValue([]),
				findFirst: jest.fn().mockResolvedValue(payment)
			},
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new PaymentDomainService(prisma as never, {} as never);
		return { operation, payment, prisma, service, transaction };
	}

	it('keeps an empty import target empty during public Billing reads', async () => {
		const tariffMutations = {
			create: jest.fn(),
			update: jest.fn(),
			upsert: jest.fn()
		};
		const settingsMutations = {
			create: jest.fn(),
			update: jest.fn(),
			upsert: jest.fn()
		};
		const prisma = {
			tariffPrice: {
				findMany: jest.fn().mockResolvedValue([]),
				...tariffMutations
			},
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(null),
				...settingsMutations
			}
		};
		const service = new TariffAffiliateService(prisma as never);

		await expect(service.tariffPrices()).resolves.toEqual([]);
		await expect(service.affiliateSettings()).resolves.toEqual({
			enabled: false,
			cashbackPercent: 10
		});

		expect(prisma.tariffPrice.findMany).toHaveBeenCalledWith({
			where: { plan: { in: [Plan.EASY, Plan.HARD] } },
			orderBy: [{ plan: 'asc' }, { billingPeriod: 'asc' }]
		});
		expect(prisma.billingSettings.findUnique).toHaveBeenCalledWith({
			where: { id: 'singleton' },
			select: {
				affiliateProgramEnabled: true,
				affiliateCashbackPercent: true
			}
		});
		for (const mutation of [
			...Object.values(tariffMutations),
			...Object.values(settingsMutations)
		]) {
			expect(mutation).not.toHaveBeenCalled();
		}
	});

	it('returns persisted public Billing values without changing them', async () => {
		const persistedPrices = [
			{
				id: 'price-easy-monthly',
				plan: Plan.EASY,
				billingPeriod: BillingPeriod.MONTHLY,
				amount: 1090,
				createdAt: new Date('2026-08-01T00:00:00.000Z'),
				updatedAt: new Date('2026-08-11T00:00:00.000Z')
			}
		];
		const settings = {
			affiliateProgramEnabled: true,
			affiliateCashbackPercent: 27
		};
		const tariffMutations = {
			create: jest.fn(),
			update: jest.fn(),
			upsert: jest.fn()
		};
		const settingsMutations = {
			create: jest.fn(),
			update: jest.fn(),
			upsert: jest.fn()
		};
		const prisma = {
			tariffPrice: {
				findMany: jest.fn().mockResolvedValue(persistedPrices),
				...tariffMutations
			},
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings),
				...settingsMutations
			}
		};
		const service = new TariffAffiliateService(prisma as never);

		await expect(service.tariffPrices()).resolves.toEqual(persistedPrices);
		await expect(service.affiliateSettings()).resolves.toEqual({
			enabled: true,
			cashbackPercent: 27
		});
		for (const mutation of [
			...Object.values(tariffMutations),
			...Object.values(settingsMutations)
		]) {
			expect(mutation).not.toHaveBeenCalled();
		}
	});

	it('creates a normal one-time checkout and its provider operation in one serializable transaction', async () => {
		const identity = {
			userId: 'user-1',
			status: 'ACTIVE',
			deletedAt: null,
			email: 'payer@example.test',
			phone: null
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue(identity)
			},
			payment: {
				findFirst: jest.fn().mockResolvedValue(null),
				create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
					const createdPayment = {
						...data,
						currency: 'RUB',
						status: PaymentStatus.PENDING,
						yookassaId: null,
						createdAt: new Date('2026-08-27T10:00:00.000Z'),
						updatedAt: new Date('2026-08-27T10:00:00.000Z')
					};
					return Promise.resolve(createdPayment);
				})
			},
			providerOperation: {
				create: jest.fn().mockResolvedValue({ id: 'operation-1' })
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 2n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			billingSettings: {
				upsert: jest.fn().mockResolvedValue({
					paymentEnabled: true,
					autoRenewalSignupEnabled: true,
					offerSnapshot: 'Offer snapshot',
					offerSectionHash: 'offer-sha256',
					offerUpdatedAt: new Date('2026-08-01T00:00:00.000Z')
				})
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue(identity)
			},
			subscription: { findUnique: jest.fn().mockResolvedValue(null) },
			tariffPrice: {
				upsert: jest.fn().mockResolvedValue({ amount: 990 })
			},
			payment: {
				findMany: jest.fn().mockResolvedValue([]),
				findFirst: jest.fn().mockResolvedValue(null)
			},
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new PaymentDomainService(prisma as never, {} as never);
		const internals = service as unknown as {
			awaitCreatedPayment(id: string): Promise<Record<string, unknown>>;
		};
		jest.spyOn(internals, 'awaitCreatedPayment').mockResolvedValue({
			id: 'created-payment',
			confirmationUrl: 'https://provider.example/checkout'
		});

		await expect(
			service.create(
				'user-1',
				{
					plan: Plan.EASY,
					billingPeriod: BillingPeriod.MONTHLY,
					expectedAmount: 990,
					autoRenew: false
				},
				{ ip: '127.0.0.1', userAgent: 'billing-test' }
			)
		).resolves.toMatchObject({ id: 'created-payment' });

		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{
				isolationLevel: 'Serializable',
				maxWait: 5_000,
				timeout: 15_000
			}
		);
		expect(transaction.payment.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				userId: 'user-1',
				kind: PaymentKind.ONE_TIME,
				amount: '990.00',
				plan: Plan.EASY,
				billingPeriod: BillingPeriod.MONTHLY,
				autoRenew: false,
				providerStatus: 'creating',
				customerEmail: 'payer@example.test',
				providerIdempotencyKey: expect.any(String)
			})
		});
		const paymentData = transaction.payment.create.mock.calls[0][0].data;
		const providerOperationData =
			transaction.providerOperation.create.mock.calls[0][0].data;
		expect(providerOperationData).toEqual(
			expect.objectContaining({
				paymentId: paymentData.id,
				idempotencyKey: paymentData.providerIdempotencyKey,
				kind: ProviderOperationKind.CREATE_CHECKOUT,
				payload: expect.objectContaining({
					paymentId: paymentData.id,
					amount: '990.00'
				})
			})
		);
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
		for (const query of [
			prisma.payment.findFirst.mock.calls[0][0],
			transaction.payment.findFirst.mock.calls[0][0]
		]) {
			expect(query).toEqual(
				expect.objectContaining({
					where: expect.objectContaining({
						OR: expect.arrayContaining([
							expect.objectContaining({
								providerOperations: {
									some: {
										OR: expect.arrayContaining([
											{
												status: ProviderOperationStatus.PENDING,
												attempt: { gt: 0 }
											}
										])
									}
								}
							})
						])
					})
				})
			);
		}
	});

	it('reuses the same expired checkout and key when an attempted provider operation is still ambiguous', async () => {
		const existing = {
			id: 'payment-existing',
			kind: PaymentKind.ONE_TIME,
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			amount: '990.00',
			autoRenew: false,
			providerIdempotencyKey: 'existing-provider-key'
		};
		const prisma = {
			billingSettings: {
				upsert: jest.fn().mockResolvedValue({
					paymentEnabled: true,
					autoRenewalSignupEnabled: true
				})
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue({
					userId: 'user-1',
					status: 'ACTIVE',
					deletedAt: null,
					email: 'payer@example.test',
					phone: null
				})
			},
			subscription: { findUnique: jest.fn().mockResolvedValue(null) },
			tariffPrice: {
				upsert: jest.fn().mockResolvedValue({ amount: 990 })
			},
			payment: {
				findMany: jest.fn().mockResolvedValue([]),
				findFirst: jest.fn().mockResolvedValue(existing)
			},
			$transaction: jest.fn()
		};
		const service = new PaymentDomainService(prisma as never, {} as never);
		const internals = service as unknown as {
			awaitCreatedPayment(id: string): Promise<Record<string, unknown>>;
		};
		const awaitCreatedPayment = jest
			.spyOn(internals, 'awaitCreatedPayment')
			.mockResolvedValue({ id: existing.id });

		await expect(
			service.create(
				'user-1',
				{
					plan: Plan.EASY,
					billingPeriod: BillingPeriod.MONTHLY,
					expectedAmount: 990,
					autoRenew: false
				},
				{}
			)
		).resolves.toEqual({ id: existing.id });

		expect(awaitCreatedPayment).toHaveBeenCalledWith(existing.id);
		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(prisma.payment.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({
							providerOperations: {
								some: {
									OR: expect.arrayContaining([
										{
											status: ProviderOperationStatus.PENDING,
											attempt: { gt: 0 }
										}
									])
								}
							}
						})
					])
				})
			})
		);
	});

	it('cancels a one-time checkout only while its provider operation is still PENDING attempt zero', async () => {
		const { service, transaction } = pendingCancellationHarness();

		await expect(
			service.cancelPending('user-1', 'payment-cancel')
		).resolves.toMatchObject({ cancelled: true });

		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-cancel',
				status: ProviderOperationStatus.PENDING,
				attempt: 0
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.FAILED,
				lastErrorCode: 'USER_CANCELLED'
			})
		});
		expect(transaction.payment.update).toHaveBeenCalledWith({
			where: { id: 'payment-cancel' },
			data: expect.objectContaining({
				status: PaymentStatus.CANCELLED,
				providerStatus: 'not_sent',
				cancellationReason: 'user_cancelled'
			})
		});
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			caseName: 'a known provider payment ID',
			options: {
				yookassaId: 'provider-payment-1',
				operation: {
					id: 'operation-cancel',
					status: ProviderOperationStatus.PENDING,
					attempt: 0
				}
			}
		},
		{
			caseName: 'an attempted PENDING operation',
			options: {
				operation: {
					id: 'operation-cancel',
					status: ProviderOperationStatus.PENDING,
					attempt: 1
				}
			}
		},
		{
			caseName: 'a PROCESSING operation',
			options: {
				operation: {
					id: 'operation-cancel',
					status: ProviderOperationStatus.PROCESSING,
					attempt: 1
				}
			}
		},
		{
			caseName: 'an UNKNOWN operation',
			options: {
				operation: {
					id: 'operation-cancel',
					status: ProviderOperationStatus.UNKNOWN,
					attempt: 1
				}
			}
		},
		{
			caseName: 'a completed provider operation',
			options: {
				operation: {
					id: 'operation-cancel',
					status: ProviderOperationStatus.SUCCEEDED,
					attempt: 1
				}
			}
		},
		{
			caseName: 'a missing CREATE_CHECKOUT operation',
			options: { operation: null }
		}
	])(
		'rejects user cancellation without changing state for $caseName',
		async ({ options }) => {
			const { service, transaction } = pendingCancellationHarness(options);

			await expect(
				service.cancelPending('user-1', 'payment-cancel')
			).rejects.toBeInstanceOf(ConflictException);

			expect(
				transaction.providerOperation.updateMany
			).not.toHaveBeenCalled();
			expect(transaction.payment.update).not.toHaveBeenCalled();
			expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
		}
	);

	it('fails closed when the provider operation is claimed during cancellation', async () => {
		const { service, transaction } = pendingCancellationHarness({
			operationChanged: 0
		});

		await expect(
			service.cancelPending('user-1', 'payment-cancel')
		).rejects.toBeInstanceOf(ConflictException);

		expect(transaction.providerOperation.updateMany).toHaveBeenCalledTimes(
			1
		);
		expect(transaction.payment.update).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
	});

	it('maps a serializable claim race to Conflict without changing payment state', async () => {
		const { prisma, service, transaction } = pendingCancellationHarness();
		prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });

		await expect(
			service.cancelPending('user-1', 'payment-cancel')
		).rejects.toBeInstanceOf(ConflictException);

		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.payment.update).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
	});

	it('keeps the same payment and provider key after an unsafe cancellation request', async () => {
		const { payment, prisma, service, transaction } =
			pendingCancellationHarness({
				operation: {
					id: 'operation-cancel',
					status: ProviderOperationStatus.PENDING,
					attempt: 1
				}
			});
		await expect(
			service.cancelPending('user-1', payment.id)
		).rejects.toBeInstanceOf(ConflictException);
		const transactionCountAfterCancel =
			prisma.$transaction.mock.calls.length;
		const internals = service as unknown as {
			awaitCreatedPayment(id: string): Promise<Record<string, unknown>>;
		};
		const awaitCreatedPayment = jest
			.spyOn(internals, 'awaitCreatedPayment')
			.mockResolvedValue({
				id: payment.id,
				providerIdempotencyKey: payment.providerIdempotencyKey
			});

		await expect(
			service.create(
				'user-1',
				{
					plan: Plan.EASY,
					billingPeriod: BillingPeriod.MONTHLY,
					expectedAmount: 990,
					autoRenew: false
				},
				{}
			)
		).resolves.toMatchObject({
			id: payment.id,
			providerIdempotencyKey: 'provider-key-existing'
		});

		expect(awaitCreatedPayment).toHaveBeenCalledWith(payment.id);
		expect(prisma.$transaction).toHaveBeenCalledTimes(
			transactionCountAfterCancel
		);
		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.payment.update).not.toHaveBeenCalled();
	});

	it('re-reads an attempted PENDING operation under lock and preserves it inside the safe window', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
		const { service, transaction } = expiredCheckoutHarness({
			id: 'operation-1',
			status: ProviderOperationStatus.PENDING,
			attempt: 1,
			createdAt: new Date('2026-08-27T10:00:00.000Z')
		});

		await expect(
			(
				service as unknown as {
					cleanupStalePendingForUser(userId: string): Promise<void>;
				}
			).cleanupStalePendingForUser('user-1')
		).resolves.toBeUndefined();

		expect(transaction.providerOperation.findFirst).toHaveBeenCalledWith({
			where: {
				paymentId: 'payment-expired',
				kind: ProviderOperationKind.CREATE_CHECKOUT
			},
			orderBy: { createdAt: 'desc' }
		});
		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.payment.updateMany).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
	});

	it('atomically moves an attempted checkout older than the safe window to UNKNOWN', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
		const { service, transaction } = expiredCheckoutHarness({
			id: 'operation-1',
			status: ProviderOperationStatus.PENDING,
			attempt: 1,
			createdAt: new Date('2026-08-26T12:00:00.000Z')
		});

		await expect(
			(
				service as unknown as {
					cleanupStalePendingForUser(userId: string): Promise<void>;
				}
			).cleanupStalePendingForUser('user-1')
		).resolves.toBeUndefined();

		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				status: ProviderOperationStatus.PENDING,
				attempt: 1
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.UNKNOWN,
				lastErrorCode: 'PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED'
			})
		});
		expect(transaction.payment.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: 'payment-expired',
				status: PaymentStatus.PENDING,
				yookassaId: null
			}),
			data: expect.objectContaining({
				providerStatus: 'unknown',
				lastProviderCheckedAt: new Date('2026-08-27T12:00:00.000Z')
			})
		});
		expect(
			transaction.payment.updateMany.mock.calls[0][0].data
		).not.toHaveProperty('status');
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
	});

	it('fails and expires a checkout that was never attempted', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
		const { service, transaction } = expiredCheckoutHarness({
			id: 'operation-1',
			status: ProviderOperationStatus.PENDING,
			attempt: 0,
			createdAt: new Date('2026-08-27T08:00:00.000Z')
		});

		await expect(
			(
				service as unknown as {
					cleanupStalePendingForUser(userId: string): Promise<void>;
				}
			).cleanupStalePendingForUser('user-1')
		).resolves.toBeUndefined();

		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				status: ProviderOperationStatus.PENDING,
				attempt: 0
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.FAILED,
				lastErrorCode: 'CHECKOUT_EXPIRED'
			})
		});
		expect(transaction.payment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.EXPIRED,
					cancellationReason: 'checkout_expired'
				})
			})
		);
	});

	it('runCleanup also preserves an attempted checkout inside the safe window', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
		const { service, transaction } = expiredCheckoutHarness({
			id: 'operation-1',
			status: ProviderOperationStatus.PENDING,
			attempt: 1,
			createdAt: new Date('2026-08-27T10:00:00.000Z')
		});

		await expect(
			service.runCleanup({
				id: 'admin-1',
				role: 'ADMIN',
				ip: null,
				userAgent: null
			})
		).resolves.toMatchObject({ affectedCount: 0 });

		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.payment.updateMany).not.toHaveBeenCalled();
	});

	it('runCleanup moves an old attempted checkout to UNKNOWN instead of expiring it', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
		const { service, transaction } = expiredCheckoutHarness({
			id: 'operation-1',
			status: ProviderOperationStatus.PENDING,
			attempt: 2,
			createdAt: new Date('2026-08-26T12:00:00.000Z')
		});

		await expect(
			service.runCleanup({
				id: 'admin-1',
				role: 'ADMIN',
				ip: null,
				userAgent: null
			})
		).resolves.toMatchObject({ affectedCount: 1 });

		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ProviderOperationStatus.UNKNOWN
				})
			})
		);
		expect(transaction.payment.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.not.objectContaining({
					status: PaymentStatus.EXPIRED
				})
			})
		);
	});

	it('wipes a recurring method while preserving an ambiguous charge for reconciliation', async () => {
		const payment = {
			id: 'payment-1',
			userId: 'user-1',
			kind: PaymentKind.RECURRING,
			status: PaymentStatus.PENDING,
			yookassaId: null,
			providerStatus: 'creating',
			amount: '990.00',
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			paymentMethodCiphertext: 'encrypted-provider-method',
			cancelledAt: null,
			cancellationReason: null,
			aggregateVersion: 1n,
			sourceSequence: 1n,
			createdAt: new Date('2026-08-27T10:00:00.000Z'),
			updatedAt: new Date('2026-08-27T10:00:00.000Z')
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			payment: {
				findMany: jest.fn().mockResolvedValue([payment]),
				findUnique: jest.fn().mockResolvedValue(payment),
				update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
					Promise.resolve({
						...payment,
						...data,
						providerStatus: 'unknown',
						paymentMethodCiphertext: null,
						aggregateVersion: 2n,
						sourceSequence: 4n,
						updatedAt: new Date('2026-08-27T10:01:00.000Z')
					})
				)
			},
			providerOperation: {
				findFirst: jest.fn().mockResolvedValue({
					id: 'operation-1',
					status: ProviderOperationStatus.PROCESSING
				}),
				updateMany: jest.fn()
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 5n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const service = new PaymentDomainService({} as never, {} as never);

		await expect(
			(
				service as unknown as {
					clearFutureRecurringPayments(
						client: typeof transaction,
						userId: string,
						reason: string
					): Promise<void>;
				}
			).clearFutureRecurringPayments(
				transaction,
				'user-1',
				'user_disabled_before_provider_call'
			)
		).resolves.toBeUndefined();

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
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
	});

	it('moves a previously attempted pending recurring capture to UNKNOWN on disable', async () => {
		const { service, transaction } = renewalMutationHarness(
			ProviderOperationStatus.PENDING,
			1
		);

		await expect(
			(
				service as unknown as {
					clearFutureRecurringPayments(
						client: typeof transaction,
						userId: string,
						reason: string
					): Promise<void>;
				}
			).clearFutureRecurringPayments(
				transaction,
				'user-1',
				'user_disabled_before_provider_call'
			)
		).resolves.toBeUndefined();

		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				status: ProviderOperationStatus.PENDING,
				attempt: 1
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.UNKNOWN,
				lastErrorCode: 'RENEWAL_REVOKED_RECONCILIATION_REQUIRED'
			})
		});
		expect(transaction.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.PENDING,
					providerStatus: 'unknown',
					paymentMethodCiphertext: null
				})
			})
		);
	});

	it('preserves a recurring payment with a known provider ID even when no active operation remains', async () => {
		const { service, transaction } = renewalMutationHarness(
			ProviderOperationStatus.SUCCEEDED,
			1,
			'provider-payment-1'
		);
		transaction.providerOperation.findFirst.mockResolvedValue(null);

		await expect(
			(
				service as unknown as {
					clearFutureRecurringPayments(
						client: typeof transaction,
						userId: string,
						reason: string
					): Promise<void>;
				}
			).clearFutureRecurringPayments(
				transaction,
				'user-1',
				'user_disabled_before_provider_call'
			)
		).resolves.toBeUndefined();

		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.PENDING,
					providerStatus: 'unknown',
					paymentMethodCiphertext: null
				})
			})
		);
	});

	it('re-reads provider ownership after locking instead of cancelling from a stale revoke snapshot', async () => {
		const { payment, service, transaction } = renewalMutationHarness(
			ProviderOperationStatus.SUCCEEDED
		);
		transaction.payment.findUnique.mockResolvedValue({
			...payment,
			yookassaId: 'provider-payment-1',
			providerStatus: 'pending'
		});
		transaction.providerOperation.findFirst.mockResolvedValue(null);

		await expect(
			(
				service as unknown as {
					clearFutureRecurringPayments(
						client: typeof transaction,
						userId: string,
						reason: string
					): Promise<void>;
				}
			).clearFutureRecurringPayments(
				transaction,
				'user-1',
				'user_disabled_before_provider_call'
			)
		).resolves.toBeUndefined();

		expect(transaction.payment.findUnique).toHaveBeenCalledWith({
			where: { id: payment.id }
		});
		expect(transaction.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.PENDING,
					providerStatus: 'unknown',
					paymentMethodCiphertext: null
				})
			})
		);
	});

	it('fails a never-attempted recurring capture and cancels it on disable', async () => {
		const { service, transaction } = renewalMutationHarness(
			ProviderOperationStatus.PENDING,
			0
		);

		await expect(
			(
				service as unknown as {
					clearFutureRecurringPayments(
						client: typeof transaction,
						userId: string,
						reason: string
					): Promise<void>;
				}
			).clearFutureRecurringPayments(
				transaction,
				'user-1',
				'user_disabled_before_provider_call'
			)
		).resolves.toBeUndefined();

		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				status: ProviderOperationStatus.PENDING,
				attempt: 0
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.FAILED,
				lastErrorCode: 'RENEWAL_REVOKED'
			})
		});
		expect(transaction.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.CANCELLED,
					providerStatus: 'not_sent',
					paymentMethodCiphertext: null
				})
			})
		);
	});

	it('persists a user disable immediately while a PROCESSING charge remains for reconciliation', async () => {
		const { service, transaction } = renewalMutationHarness(
			ProviderOperationStatus.PROCESSING
		);
		jest.spyOn(service, 'userAutoRenewal').mockResolvedValue({
			status: AutoRenewalStatus.USER_DISABLED
		} as never);

		await expect(
			service.disableUserAutoRenewal('user-1', {
				ip: '127.0.0.1',
				userAgent: 'billing-test'
			})
		).resolves.toMatchObject({ status: AutoRenewalStatus.USER_DISABLED });

		expect(transaction.autoRenewal.updateMany).toHaveBeenCalledWith({
			where: { id: 'renewal-1', stateVersion: 4 },
			data: expect.objectContaining({
				status: AutoRenewalStatus.USER_DISABLED,
				paymentMethodCiphertext: null,
				paymentMethodType: null,
				paymentMethodTitle: null,
				paymentMethodLast4: null,
				paymentMethodSavedAt: null,
				dispatchPending: false
			})
		});
		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.PENDING,
					providerStatus: 'unknown',
					paymentMethodCiphertext: null
				})
			})
		);
		expect(
			transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					type: AutoRenewalConsentEventType.USER_DISABLED,
					actorUserId: 'user-1'
				})
			})
		);
	});

	it('persists an admin revoke immediately while an UNKNOWN charge remains for reconciliation', async () => {
		const { service, transaction } = renewalMutationHarness(
			ProviderOperationStatus.UNKNOWN
		);
		jest.spyOn(service, 'adminAutoRenewal').mockResolvedValue({
			status: AutoRenewalStatus.REVOKED
		} as never);

		await expect(
			service.adminRenewalAction(
				'user-1',
				'revoke',
				{ reason: 'Customer request' },
				{
					id: 'admin-1',
					role: 'ADMIN',
					ip: '127.0.0.1',
					userAgent: 'billing-test'
				}
			)
		).resolves.toMatchObject({
			message: 'Отзыв согласия зафиксирован.'
		});

		expect(transaction.autoRenewal.updateMany).toHaveBeenCalledWith({
			where: { id: 'renewal-1', stateVersion: 4 },
			data: expect.objectContaining({
				status: AutoRenewalStatus.REVOKED,
				disableReason: 'Customer request',
				paymentMethodCiphertext: null,
				paymentMethodType: null,
				paymentMethodTitle: null,
				paymentMethodLast4: null,
				paymentMethodSavedAt: null,
				dispatchPending: false
			})
		});
		expect(
			transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.payment.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: PaymentStatus.PENDING,
					providerStatus: 'unknown',
					paymentMethodCiphertext: null
				})
			})
		);
		expect(
			transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					type: AutoRenewalConsentEventType.ADMIN_REVOKED,
					actorUserId: 'admin-1'
				})
			})
		);
	});

	it('persists client context in the immutable renewal consent event', async () => {
		const transaction = {
			autoRenewalConsentEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const service = new PaymentDomainService({} as never, {} as never);
		const renewal = {
			id: 'renewal-1',
			userId: 'user-1',
			status: AutoRenewalStatus.ACTIVE,
			consentVersion: 'consent-v1',
			consentText: 'consent text',
			offerSnapshot: '<section>offer</section>',
			offerSha256: 'offer-sha',
			offerUpdatedAt: new Date('2026-08-10T00:00:00.000Z'),
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			amount: '990.00',
			currency: 'RUB'
		};

		await (
			service as unknown as {
				createRenewalEvent(
					client: typeof transaction,
					autoRenewal: typeof renewal,
					type: AutoRenewalConsentEventType,
					actor: {
						id: string;
						role: string;
						ip: string;
						userAgent: string;
					},
					source: string,
					reason: string
				): Promise<void>;
			}
		).createRenewalEvent(
			transaction,
			renewal,
			AutoRenewalConsentEventType.USER_DISABLED,
			{
				id: 'user-1',
				role: 'USER',
				ip: '203.0.113.7',
				userAgent: 'billing-contract-agent'
			},
			'CABINET',
			'Отключено пользователем'
		);

		expect(
			transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				autoRenewalId: 'renewal-1',
				userId: 'user-1',
				type: AutoRenewalConsentEventType.USER_DISABLED,
				actorUserId: 'user-1',
				actorRole: 'USER',
				ip: '203.0.113.7',
				userAgent: 'billing-contract-agent'
			})
		});
	});

	it('keeps indefinite subscriptions in the active audience without using null as an extension base', () => {
		const service = new SubscriptionDomainService(
			{} as never,
			{} as never
		);
		const helpers = service as unknown as {
			isActiveFuture(
				subscription: {
					status: SubscriptionStatus;
					expiresAt: Date | null;
				},
				now: Date
			): boolean;
			isActiveForAudience(
				subscription: {
					status: SubscriptionStatus;
					expiresAt: Date | null;
				},
				now: Date
			): boolean;
		};
		const indefinite = {
			status: SubscriptionStatus.ACTIVE,
			expiresAt: null
		};

		expect(helpers.isActiveForAudience(indefinite, new Date())).toBe(true);
		expect(helpers.isActiveFuture(indefinite, new Date())).toBe(false);
	});

	it('preserves the legacy tariff validation error before starting a transaction', async () => {
		const prisma = { $transaction: jest.fn() };
		const service = new TariffAffiliateService(prisma as never);

		await expect(
			service.updateTariffPrices(
				{
					prices: [
						{
							plan: Plan.EASY,
							billingPeriod: BillingPeriod.MONTHLY,
							amount: 990
						},
						{
							plan: Plan.EASY,
							billingPeriod: BillingPeriod.YEARLY,
							amount: 4680
						},
						{
							plan: Plan.HARD,
							billingPeriod: BillingPeriod.MONTHLY,
							amount: 1690
						},
						{
							plan: Plan.HARD,
							billingPeriod: BillingPeriod.YEARLY,
							amount: 9480
						},
						{
							plan: Plan.TRIAL,
							billingPeriod: BillingPeriod.MONTHLY,
							amount: 1
						}
					]
				} as never,
				{
					id: 'admin-1',
					role: 'ADMIN',
					ip: null,
					userAgent: null
				}
			)
		).rejects.toMatchObject({
			message: 'Можно менять цены только для тарифов Easy и Hard'
		});
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('normalizes the legacy affiliate status filter with surrounding whitespace', async () => {
		const service = new TariffAffiliateService({} as never);
		const affiliateList = jest.fn().mockResolvedValue({ items: [] });
		(
			service as unknown as {
				affiliateList: typeof affiliateList;
			}
		).affiliateList = affiliateList;

		await service.adminReferrals(1, 20, ' registered ');

		expect(affiliateList).toHaveBeenCalledWith(1, 20, {
			status: AffiliateReferralStatus.REGISTERED
		});
	});

	it('rejects a delayed referral request when a payment already existed at request time', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			affiliateReferral: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn()
			},
			billingSettings: {
				upsert: jest
					.fn()
					.mockResolvedValue({ affiliateProgramEnabled: true })
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue({
					status: 'ACTIVE',
					deletedAt: null
				})
			},
			payment: {
				findFirst: jest
					.fn()
					.mockResolvedValueOnce({
						id: 'payment-before-referral',
						createdAt: new Date('2026-08-10T23:59:59.000Z')
					})
					.mockResolvedValueOnce(null)
			},
			billingSourceSequence: { upsert: jest.fn() }
		};
		const prisma = {
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new TariffAffiliateService(prisma as never);

		await expect(
			service.registerReferral(
				'referrer-1',
				'referred-1',
				'2026-08-11T00:00:00.000Z'
			)
		).resolves.toBeNull();
		expect(transaction.affiliateReferral.create).not.toHaveBeenCalled();
		expect(
			transaction.billingSourceSequence.upsert
		).not.toHaveBeenCalled();
	});

	it('retries a referral request until its validated referrer projection arrives', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			affiliateReferral: { findUnique: jest.fn().mockResolvedValue(null) },
			billingSettings: {
				upsert: jest
					.fn()
					.mockResolvedValue({ affiliateProgramEnabled: true })
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue(null)
			},
			payment: {
				findFirst: jest.fn().mockResolvedValue(null)
			}
		};
		const prisma = {
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new TariffAffiliateService(prisma as never);

		await expect(
			service.registerReferral(
				'referrer-1',
				'referred-1',
				'2026-08-11T00:00:00.000Z'
			)
		).rejects.toThrow(
			'Referral referrer identity projection is unavailable'
		);
	});
});
