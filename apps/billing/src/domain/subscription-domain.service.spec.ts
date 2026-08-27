import {
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	BillingPeriod,
	PaymentKind,
	PaymentStatus,
	Plan,
	ProviderOperationStatus,
	SubscriptionStatus
} from '@prisma/billing-client';
import { SubscriptionDomainService } from './subscription-domain.service';

function adminCancellationHarness(options: {
	operationStatus?: ProviderOperationStatus;
	operationAttempt?: number;
	yookassaId?: string | null;
	snapshotOperationStatus?: ProviderOperationStatus;
	snapshotOperationAttempt?: number;
	snapshotYookassaId?: string | null;
}) {
	const now = new Date('2026-08-27T10:00:00.000Z');
	const subscription = {
		id: 'subscription-1',
		userId: 'user-1',
		plan: Plan.EASY,
		billingPeriod: BillingPeriod.MONTHLY,
		status: SubscriptionStatus.ACTIVE,
		startsAt: now,
		expiresAt: new Date('2026-09-27T10:00:00.000Z'),
		leadsThisPeriod: 0,
		periodResetsAt: new Date('2026-09-27T10:00:00.000Z'),
		aggregateVersion: 1n,
		sourceSequence: 1n,
		createdAt: now,
		updatedAt: now
	};
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
	const currentPayment = {
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
	const snapshotPayment = {
		...currentPayment,
		yookassaId:
			options.snapshotYookassaId === undefined
				? currentPayment.yookassaId
				: options.snapshotYookassaId
	};
	const currentProviderOperation = options.operationStatus
		? {
				id: 'operation-1',
				status: options.operationStatus,
				attempt: options.operationAttempt ?? 0
			}
		: null;
	const snapshotOperationStatus =
		options.snapshotOperationStatus === undefined
			? options.operationStatus
			: options.snapshotOperationStatus;
	const snapshotProviderOperation = snapshotOperationStatus
		? {
				id: 'operation-1',
				status: snapshotOperationStatus,
				attempt:
					options.snapshotOperationAttempt ?? options.operationAttempt ?? 0
			}
		: null;
	const lockState = {
		payment: false,
		providerOperation: false
	};
	let persistedPayment = currentPayment;
	const transaction = {
		$queryRaw: jest.fn(
			(parts: TemplateStringsArray, ...values: unknown[]) => {
				const sql = parts.join('?').replace(/\s+/g, ' ').trim();
				if (
					sql.includes('FROM billing.payments WHERE id = ? FOR UPDATE') &&
					values.includes(currentPayment.id)
				) {
					lockState.payment = true;
				}
				if (
					sql.includes(
						'FROM billing.provider_operations WHERE payment_id = ?'
					) &&
					values.includes(currentPayment.id)
				) {
					lockState.providerOperation = true;
				}
				return Promise.resolve([]);
			}
		),
		subscription: {
			update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
				Promise.resolve({
					...subscription,
					...data,
					status: SubscriptionStatus.CANCELLED,
					aggregateVersion: 2n,
					sourceSequence: data.sourceSequence,
					updatedAt: new Date('2026-08-27T10:01:00.000Z')
				})
			)
		},
		autoRenewal: {
			findUnique: jest.fn().mockResolvedValue(renewal),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		autoRenewalConsentEvent: {
			create: jest.fn().mockResolvedValue({})
		},
		payment: {
			findMany: jest.fn().mockResolvedValue([snapshotPayment]),
			findUnique: jest.fn(() =>
				Promise.resolve(
					lockState.payment ? currentPayment : snapshotPayment
				)
			),
			updateMany: jest.fn(
				({ data }: { data: Record<string, unknown> }) => {
					persistedPayment = {
						...persistedPayment,
						...data,
						aggregateVersion: persistedPayment.aggregateVersion + 1n,
						sourceSequence: data.sourceSequence as bigint,
						updatedAt: new Date('2026-08-27T10:01:00.000Z')
					};
					return Promise.resolve({ count: 1 });
				}
			),
			findUniqueOrThrow: jest.fn(() => Promise.resolve(persistedPayment))
		},
		providerOperation: {
			findFirst: jest.fn(() =>
				Promise.resolve(
					lockState.providerOperation
						? currentProviderOperation
						: snapshotProviderOperation
				)
			),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		billingSourceSequence: {
			upsert: jest
				.fn()
				.mockResolvedValueOnce({ nextValue: 2n })
				.mockResolvedValueOnce({ nextValue: 3n })
		},
		outboxEvent: {
			create: jest.fn().mockResolvedValue({}),
			createMany: jest.fn().mockResolvedValue({ count: 1 })
		}
	};
	const prisma = {
		subscription: {
			findUnique: jest.fn().mockResolvedValue(subscription)
		},
		$transaction: jest.fn(
			async (work: (client: typeof transaction) => unknown) =>
				work(transaction)
		)
	};
	return {
		lockState,
		payment: currentPayment,
		prisma,
		renewal,
		service: new SubscriptionDomainService(prisma as never, {} as never),
		transaction
	};
}

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

describe('SubscriptionDomainService administrative cancellation safety', () => {
	const actor = {
		id: 'admin-1',
		role: 'ADMIN' as const,
		ip: '127.0.0.1',
		userAgent: 'billing-test'
	};

	it('revokes consent but preserves an attempted PENDING capture for reconciliation', async () => {
		const { service, transaction } = adminCancellationHarness({
			operationStatus: ProviderOperationStatus.PENDING,
			operationAttempt: 1
		});

		await expect(service.cancel('user-1', actor)).resolves.toMatchObject({
			status: SubscriptionStatus.CANCELLED
		});

		expect(transaction.autoRenewal.updateMany).toHaveBeenCalledWith({
			where: { id: 'renewal-1', stateVersion: 4 },
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
				source: 'SUBSCRIPTION_ADMIN_CANCEL'
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
				lastErrorCode: 'RENEWAL_REVOKED_RECONCILIATION_REQUIRED'
			})
		});
		expect(transaction.payment.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: 'payment-1',
				status: PaymentStatus.PENDING,
				yookassaId: null,
				aggregateVersion: 1n
			}),
			data: expect.objectContaining({
				status: PaymentStatus.PENDING,
				providerStatus: 'unknown',
				paymentMethodCiphertext: null,
				cancelledAt: null,
				cancellationReason: null
			})
		});
	});

	it('fails and cancels a never-attempted PENDING capture', async () => {
		const { service, transaction } = adminCancellationHarness({
			operationStatus: ProviderOperationStatus.PENDING,
			operationAttempt: 0
		});

		await expect(service.cancel('user-1', actor)).resolves.toMatchObject({
			status: SubscriptionStatus.CANCELLED
		});

		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				status: ProviderOperationStatus.PENDING,
				attempt: 0
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.FAILED,
				lastErrorCode: 'AUTO_RENEWAL_REVOKED'
			})
		});
		expect(transaction.payment.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: 'payment-1',
				status: PaymentStatus.PENDING,
				yookassaId: null,
				aggregateVersion: 1n
			}),
			data: expect.objectContaining({
				status: PaymentStatus.CANCELLED,
				providerStatus: 'not_sent',
				paymentMethodCiphertext: null,
				cancellationReason:
					'Автопродление отозвано при административной отмене подписки'
			})
		});
	});

	it.each([ProviderOperationStatus.SUCCEEDED, undefined])(
		'preserves a payment with a known provider id when the latest operation is %s',
		async operationStatus => {
			const { service, transaction } = adminCancellationHarness({
				operationStatus,
				operationAttempt: 1,
				yookassaId: 'provider-payment-1'
			});

			await expect(service.cancel('user-1', actor)).resolves.toMatchObject(
				{
					status: SubscriptionStatus.CANCELLED
				}
			);

			expect(
				transaction.providerOperation.updateMany
			).not.toHaveBeenCalled();
			expect(transaction.payment.updateMany).toHaveBeenCalledWith({
				where: expect.objectContaining({
					id: 'payment-1',
					status: PaymentStatus.PENDING,
					yookassaId: 'provider-payment-1',
					aggregateVersion: 1n
				}),
				data: expect.objectContaining({
					status: PaymentStatus.PENDING,
					providerStatus: 'unknown',
					paymentMethodCiphertext: null
				})
			});
		}
	);

	it('uses the locked payment snapshot when a provider id appears after candidate selection', async () => {
		const { lockState, service, transaction } = adminCancellationHarness({
			operationStatus: ProviderOperationStatus.PENDING,
			operationAttempt: 0,
			yookassaId: 'provider-payment-after-snapshot',
			snapshotYookassaId: null
		});

		await expect(service.cancel('user-1', actor)).resolves.toMatchObject({
			status: SubscriptionStatus.CANCELLED
		});

		expect(lockState).toEqual({
			payment: true,
			providerOperation: true
		});
		expect(transaction.providerOperation.updateMany).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				status: ProviderOperationStatus.PENDING,
				attempt: 0
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.UNKNOWN,
				lastErrorCode: 'RENEWAL_REVOKED_RECONCILIATION_REQUIRED'
			})
		});
		expect(transaction.payment.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: 'payment-1',
				yookassaId: 'provider-payment-after-snapshot',
				aggregateVersion: 1n
			}),
			data: expect.objectContaining({
				status: PaymentStatus.PENDING,
				providerStatus: 'unknown',
				paymentMethodCiphertext: null
			})
		});
	});

	it('uses the locked provider operation when an attempt starts after candidate selection', async () => {
		const { lockState, service, transaction } = adminCancellationHarness({
			operationStatus: ProviderOperationStatus.PENDING,
			operationAttempt: 1,
			snapshotOperationStatus: ProviderOperationStatus.PENDING,
			snapshotOperationAttempt: 0,
			yookassaId: null
		});

		await expect(service.cancel('user-1', actor)).resolves.toMatchObject({
			status: SubscriptionStatus.CANCELLED
		});

		expect(lockState).toEqual({
			payment: true,
			providerOperation: true
		});
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
		expect(transaction.payment.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: 'payment-1',
				yookassaId: null,
				aggregateVersion: 1n
			}),
			data: expect.objectContaining({
				status: PaymentStatus.PENDING,
				providerStatus: 'unknown',
				paymentMethodCiphertext: null
			})
		});
	});
});

describe('SubscriptionDomainService expired recurring dispatch terminal', () => {
	it('does not accept a partially closed payment that still retains ciphertext', async () => {
		const payment = {
			id: 'payment-1',
			userId: 'user-1',
			yookassaId: null,
			providerIdempotencyKey: 'provider-idempotency-1',
			recurringCycleKey: 'renewal-1:2026-08-27T10:00:00.000Z:attempt:0',
			recurringAttempt: 0,
			kind: PaymentKind.RECURRING,
			status: PaymentStatus.CANCELLED,
			providerStatus: 'not_sent',
			paymentMethodCiphertext: 'ciphertext-must-not-survive',
			cancellationReason: 'CHARGE_WINDOW_EXPIRED',
			checkoutExpiresAt: new Date('2026-08-27T11:00:00.000Z')
		};
		const renewal = {
			id: 'renewal-1',
			userId: 'user-1',
			status: AutoRenewalStatus.TECHNICAL_PAUSE,
			dispatchPending: false,
			lastChargeErrorCode: 'CHARGE_WINDOW_EXPIRED'
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			payment: {
				findUnique: jest.fn().mockResolvedValue(payment),
				updateMany: jest.fn()
			},
			autoRenewal: {
				findUnique: jest.fn().mockResolvedValue(renewal),
				updateMany: jest.fn()
			},
			providerOperation: {
				findFirst: jest.fn().mockResolvedValue(null),
				updateMany: jest.fn()
			},
			billingSourceSequence: { upsert: jest.fn() },
			autoRenewalConsentEvent: { create: jest.fn() },
			outboxEvent: { create: jest.fn() }
		};
		const service = new SubscriptionDomainService(
			{} as never,
			{} as never
		);

		await expect(
			service.closeExpiredRecurringDispatch(transaction as never, {
				paymentId: payment.id,
				autoRenewalId: renewal.id,
				cycleKey: payment.recurringCycleKey,
				now: new Date('2026-08-27T12:00:00.000Z'),
				triggerId: 'event-1'
			})
		).resolves.toBe('RECONCILIATION_REQUIRED');
		expect(transaction.payment.updateMany).not.toHaveBeenCalled();
		expect(transaction.autoRenewal.updateMany).not.toHaveBeenCalled();
		expect(
			transaction.autoRenewalConsentEvent.create
		).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
	});
});
