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
import { BILLING_EVENT_TYPES } from '../messaging/billing-messaging.constants';
import { BillingSchedulerService } from './billing-scheduler.service';

describe('BillingSchedulerService auto-renewal safety', () => {
	const dueAt = new Date('2026-08-10T09:00:00.000Z');
	const now = new Date('2026-08-10T09:30:00.000Z');

	beforeEach(() => {
		jest.useFakeTimers().setSystemTime(now);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	const renewal = () => ({
		id: 'renewal-1',
		userId: 'user-1',
		status: AutoRenewalStatus.ACTIVE,
		plan: Plan.EASY,
		billingPeriod: BillingPeriod.MONTHLY,
		amount: '990.00',
		pendingAmount: null,
		priceChangeDetectedAt: null,
		currency: 'RUB',
		paymentMethodCiphertext: 'ciphertext',
		paymentMethodType: 'bank_card',
		paymentMethodTitle: 'Bank card',
		paymentMethodLast4: '4242',
		paymentMethodSavedAt: new Date('2026-07-01T00:00:00.000Z'),
		consentVersion: 'auto-renewal-2026-07-28-v4',
		consentText: 'consent',
		consentedAt: new Date('2026-07-01T00:00:00.000Z'),
		offerSnapshot: '<section>offer</section>',
		offerSha256: 'sha256',
		offerUpdatedAt: new Date('2026-07-01T00:00:00.000Z'),
		nextChargeAt: dueAt,
		retryStartedAt: null,
		retryAttempt: 0,
		nextRetryAt: null,
		dispatchPending: false,
		disabledAt: null,
		disableReason: null,
		lastChargeAttemptAt: null,
		lastChargeErrorCode: null,
		stateVersion: 4,
		createdAt: new Date('2026-07-01T00:00:00.000Z'),
		updatedAt: new Date('2026-07-01T00:00:00.000Z')
	});

	const makeHarness = (options?: {
		chargesEnabledAt?: Date;
		price?: number;
	}) => {
		const currentRenewal = renewal();
		const payment = {
			id: 'payment-1',
			userId: 'user-1',
			yookassaId: null,
			providerIdempotencyKey: 'provider-key-1',
			recurringCycleKey: 'renewal-1:2026-08-10T09:00:00.000Z:attempt:0',
			recurringAttempt: 0,
			kind: PaymentKind.RECURRING,
			amount: '990.00',
			currency: 'RUB',
			status: PaymentStatus.PENDING,
			providerStatus: 'queued',
			plan: Plan.EASY,
			billingPeriod: BillingPeriod.MONTHLY,
			autoRenew: true,
			aggregateVersion: 1n,
			sourceSequence: 11n,
			createdAt: now,
			updatedAt: now
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			billingSettings: {
				upsert: jest.fn().mockResolvedValue({ id: 'singleton' }),
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					id: 'singleton',
					paymentEnabled: true,
					autoRenewalChargesEnabled: true,
					autoRenewalChargesEnabledAt:
						options?.chargesEnabledAt ??
						new Date('2026-08-01T00:00:00.000Z')
				})
			},
			autoRenewal: {
				findUnique: jest
					.fn()
					.mockResolvedValueOnce({ userId: 'user-1' })
					.mockResolvedValueOnce(currentRenewal),
				update: jest.fn().mockResolvedValue(currentRenewal)
			},
			identityContactProjection: {
				findUnique: jest.fn().mockResolvedValue({
					userId: 'user-1',
					status: 'ACTIVE',
					tombstone: false,
					deletedAt: null,
					email: 'user@example.com',
					phone: null
				})
			},
			subscription: {
				findUnique: jest.fn().mockResolvedValue({
					userId: 'user-1',
					status: SubscriptionStatus.ACTIVE,
					plan: Plan.EASY,
					billingPeriod: BillingPeriod.MONTHLY,
					expiresAt: dueAt
				})
			},
			tariffPrice: {
				findUnique: jest.fn().mockResolvedValue({
					amount: options?.price ?? 990
				})
			},
			payment: {
				findUnique: jest.fn().mockResolvedValue(null),
				findFirst: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue(payment)
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 12n })
			},
			outboxEvent: {
				createMany: jest.fn().mockResolvedValue({ count: 3 })
			},
			autoRenewalConsentEvent: {
				create: jest.fn().mockResolvedValue({ id: 'event-1' })
			}
		};
		const prisma = {
			$transaction: jest.fn(
				async (callback: (client: unknown) => unknown) =>
					callback(transaction)
			)
		};
		const service = new BillingSchedulerService(
			prisma as never,
			{} as never,
			{} as never,
			{} as never
		);
		return { service, transaction, payment, currentRenewal };
	};

	const dispatch = (service: BillingSchedulerService) =>
		(
			service as unknown as {
				createRecurringIntent(id: string): Promise<boolean>;
			}
		).createRecurringIntent('renewal-1');

	it('creates one canonical recurring intent and transactional Outbox batch', async () => {
		const { service, transaction, payment } = makeHarness();

		await expect(dispatch(service)).resolves.toBe(true);

		expect(transaction.payment.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				recurringCycleKey: 'renewal-1:2026-08-10T09:00:00.000Z:attempt:0',
				recurringAttempt: 0,
				kind: PaymentKind.RECURRING,
				providerStatus: 'queued',
				paymentMethodCiphertext: 'ciphertext',
				aggregateVersion: 1n,
				sourceSequence: 11n
			})
		});
		const outboxRows = transaction.outboxEvent.createMany.mock.calls[0][0]
			.data as Array<Record<string, unknown>>;
		expect(outboxRows).toHaveLength(2);
		expect(outboxRows.map(row => row.eventType)).toEqual([
			BILLING_EVENT_TYPES.paymentChanged,
			BILLING_EVENT_TYPES.autoRenewalChargeRequested
		]);
		expect(outboxRows[1]).toEqual(
			expect.objectContaining({ aggregateId: payment.id })
		);
		expect(transaction.autoRenewal.update).toHaveBeenLastCalledWith({
			where: { id: 'renewal-1' },
			data: expect.objectContaining({ dispatchPending: true })
		});
	});

	it('fails closed when the due date belongs to the global pause window', async () => {
		const { service, transaction } = makeHarness({
			chargesEnabledAt: new Date('2026-08-10T09:10:00.000Z')
		});

		await expect(dispatch(service)).resolves.toBe(false);

		expect(transaction.payment.create).not.toHaveBeenCalled();
		expect(transaction.autoRenewal.update).toHaveBeenCalledWith({
			where: { id: 'renewal-1' },
			data: expect.objectContaining({
				status: AutoRenewalStatus.TECHNICAL_PAUSE,
				lastChargeErrorCode: 'CHARGE_MISSED_DURING_GLOBAL_PAUSE',
				dispatchPending: false
			})
		});
		expect(
			transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				type: AutoRenewalConsentEventType.TECHNICAL_PAUSED,
				metadata: {
					errorCode: 'CHARGE_MISSED_DURING_GLOBAL_PAUSE'
				}
			})
		});
	});

	it('requires explicit confirmation instead of charging a changed price', async () => {
		const { service, transaction } = makeHarness({ price: 1090 });

		await expect(dispatch(service)).resolves.toBe(false);

		expect(transaction.payment.create).not.toHaveBeenCalled();
		expect(transaction.autoRenewal.update).toHaveBeenCalledWith({
			where: { id: 'renewal-1' },
			data: expect.objectContaining({
				pendingAmount: '1090.00',
				priceChangeDetectedAt: expect.any(Date)
			})
		});
		expect(
			transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				type: AutoRenewalConsentEventType.PRICE_CHANGE_REQUIRED,
				metadata: expect.objectContaining({
					previousAmount: '990.00',
					newAmount: '1090.00'
				})
			})
		});
	});

	it('registers receipt reconciliation as an hourly durable task', async () => {
		const service = new BillingSchedulerService(
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const internal = service as unknown as {
			tick(): Promise<void>;
			runDurable(
				task: string,
				periodKey: string,
				handler: () => Promise<void>
			): Promise<void>;
		};
		const runDurable = jest
			.spyOn(internal, 'runDurable')
			.mockResolvedValue(undefined);

		await internal.tick();

		expect(runDurable).toHaveBeenCalledWith(
			'payment-receipt-reconciliation',
			'2026-08-10T09',
			expect.any(Function)
		);
		expect(runDurable.mock.calls.map(call => call[0])).toEqual([
			'billing-retention',
			'auto-renewal',
			'subscription-expiry',
			'subscription-expiry-reminders',
			'payment-receipt-reconciliation'
		]);
	});

	it('selects only bounded receipt-eligible successes for reconciliation', async () => {
		const findMany = jest.fn().mockResolvedValue([
			{ id: 'payment-1', yookassaId: 'provider-payment-1' },
			{ id: 'payment-2', yookassaId: 'provider-payment-2' }
		]);
		const enqueueReceiptSync = jest.fn().mockResolvedValue('operation-1');
		const service = new BillingSchedulerService(
			{ payment: { findMany } } as never,
			{} as never,
			{} as never,
			{ enqueueReceiptSync } as never
		) as unknown as {
			reconcileMissingPaymentReceipts(): Promise<void>;
		};

		await service.reconcileMissingPaymentReceipts();

		expect(findMany).toHaveBeenCalledWith({
			where: {
				id: { notIn: [] },
				status: PaymentStatus.SUCCEEDED,
				receiptSyncEligible: true,
				yookassaId: { not: null },
				receipts: {
					none: { status: 'succeeded', type: 'payment' }
				},
				providerOperations: {
					none: {
						kind: ProviderOperationKind.SYNC_RECEIPT,
						status: {
							in: [
								ProviderOperationStatus.PENDING,
								ProviderOperationStatus.PROCESSING
							]
						}
					}
				}
			},
			orderBy: [{ succeededAt: 'asc' }, { createdAt: 'asc' }],
			take: 250,
			select: { id: true, yookassaId: true }
		});
		expect(enqueueReceiptSync).toHaveBeenNthCalledWith(
			1,
			'payment-1',
			'provider-payment-1'
		);
		expect(enqueueReceiptSync).toHaveBeenNthCalledWith(
			2,
			'payment-2',
			'provider-payment-2'
		);
	});

	it('isolates one corrupted receipt gap from the remaining reconciliation batch', async () => {
		const findMany = jest.fn().mockResolvedValue([
			{ id: 'payment-1', yookassaId: 'provider-payment-1' },
			{ id: 'payment-2', yookassaId: 'provider-payment-2' }
		]);
		const enqueueReceiptSync = jest
			.fn()
			.mockRejectedValueOnce(new Error('ownership mismatch'))
			.mockResolvedValueOnce('operation-2');
		const service = new BillingSchedulerService(
			{ payment: { findMany } } as never,
			{} as never,
			{} as never,
			{ enqueueReceiptSync } as never
		) as unknown as {
			logger: { error: jest.Mock };
			reconcileMissingPaymentReceipts(): Promise<void>;
		};
		service.logger.error = jest.fn();

		await expect(
			service.reconcileMissingPaymentReceipts()
		).resolves.toBeUndefined();

		expect(enqueueReceiptSync).toHaveBeenCalledTimes(2);
		expect(service.logger.error).toHaveBeenCalledWith(
			expect.stringContaining('payment=payment-1')
		);
	});

	it('continues after the first 250 gaps without selecting them again', async () => {
		const firstBatch = Array.from({ length: 250 }, (_, index) => ({
			id: `payment-${index + 1}`,
			yookassaId: `provider-payment-${index + 1}`
		}));
		const findMany = jest
			.fn()
			.mockResolvedValueOnce(firstBatch)
			.mockResolvedValueOnce([
				{ id: 'payment-251', yookassaId: 'provider-payment-251' }
			]);
		const enqueueReceiptSync = jest.fn().mockResolvedValue('operation-1');
		const service = new BillingSchedulerService(
			{ payment: { findMany } } as never,
			{} as never,
			{} as never,
			{ enqueueReceiptSync } as never
		) as unknown as {
			reconcileMissingPaymentReceipts(): Promise<void>;
		};

		await service.reconcileMissingPaymentReceipts();

		expect(findMany).toHaveBeenCalledTimes(2);
		expect(findMany.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				where: expect.objectContaining({
					id: { notIn: firstBatch.map(payment => payment.id) }
				})
			})
		);
		expect(enqueueReceiptSync).toHaveBeenCalledTimes(251);
	});

	it('uses Moscow calendar days and stable 03:00/15:00 slots', () => {
		const service = new BillingSchedulerService(
			{} as never,
			{} as never,
			{} as never,
			{} as never
		) as unknown as {
			moscowDayRange(
				value: Date,
				days: number
			): {
				start: Date;
				end: Date;
			};
			moscowReminderSlotKey(value: Date): string;
		};

		expect(
			service.moscowDayRange(new Date('2026-08-10T22:30:00.000Z'), 0)
		).toEqual({
			start: new Date('2026-08-10T21:00:00.000Z'),
			end: new Date('2026-08-11T21:00:00.000Z')
		});
		expect(
			service.moscowReminderSlotKey(new Date('2026-08-11T00:10:00.000Z'))
		).toBe('2026-08-11T03:00+03:00');
		expect(
			service.moscowReminderSlotKey(new Date('2026-08-11T12:10:00.000Z'))
		).toBe('2026-08-11T15:00+03:00');
	});

	it('renews a long durable run lease with the same CAS claim', async () => {
		let releaseHandler!: () => void;
		const handler = jest.fn(
			() =>
				new Promise<void>(resolve => {
					releaseHandler = resolve;
				})
		);
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			billingScheduledRun: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({
					id: 'run-1',
					status: 'PROCESSING',
					leaseUntil: new Date(Date.now() + 5 * 60_000)
				}),
				updateMany
			}
		};
		const service = new BillingSchedulerService(
			prisma as never,
			{} as never,
			{} as never,
			{} as never
		) as unknown as {
			runDurable(
				task: string,
				periodKey: string,
				handler: () => Promise<void>
			): Promise<void>;
		};

		const running = service.runDurable('long-task', 'period-1', handler);
		await Promise.resolve();
		await jest.advanceTimersByTimeAsync(60_000);

		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: 'run-1',
				status: 'PROCESSING',
				claimToken: expect.any(String)
			},
			data: { leaseUntil: new Date(Date.now() + 5 * 60_000) }
		});

		releaseHandler();
		await running;
		expect(updateMany).toHaveBeenLastCalledWith({
			where: { id: 'run-1', claimToken: expect.any(String) },
			data: {
				status: 'COMPLETED',
				completedAt: expect.any(Date)
			}
		});
	});
});
