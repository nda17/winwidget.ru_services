import {
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	DeliveryFailureStatus,
	DeliveryReceiptStatus,
	OutboxStatus,
	PaymentKind,
	PaymentStatus,
	ProviderOperationKind,
	ProviderOperationStatus
} from '@prisma/billing-client';
import type { ConsumeMessage } from 'amqplib';
import { createHash } from 'node:crypto';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from '../domain/billing-legal.constants';
import { SubscriptionDomainService } from '../domain/subscription-domain.service';
import { BillingProjectionService } from '../projections/billing-projection.service';
import {
	BILLING_DEAD_LETTER_EXCHANGE,
	BILLING_EVENT_TYPES,
	BILLING_QUEUE_NAMES,
	BILLING_RETRY_EXCHANGE
} from './billing-messaging.constants';
import { BillingOutboxPublisherService } from './billing-outbox-publisher.service';
import { BillingWorkerService } from './billing-worker.service';

describe('Billing offer v2 scoped sequence contract', () => {
	const content = '<p>exact offer snapshot</p>';
	const payload = {
		schemaVersion: 2,
		eventType: BILLING_EVENT_TYPES.offerChanged,
		eventId: '4c230515-2e4e-4e8c-a655-cdcfb8c3dc2b',
		aggregateId: 'offer',
		aggregateVersion: '42',
		sourceSequenceContractVersion: 2,
		sourceSequenceScope: 'billing.offer:offer',
		sourceSequence: '871',
		occurredAt: '2026-08-24T00:00:00.000Z',
		tombstone: false,
		state: {
			id: 'offer',
			content,
			sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
			updatedAt: '2026-08-24T00:00:00.000Z',
			consentVersion: AUTO_RENEWAL_CONSENT_VERSION,
			consentText: AUTO_RENEWAL_CONSENT_TEXT
		}
	};

	it('accepts only v2 on the v2 queue and rejects the retired v1 envelope', () => {
		const service = new BillingProjectionService({} as never);
		expect(BILLING_QUEUE_NAMES.offer).toBe('winwidget.billing.offer.v2');
		expect(
			service.parse(payload, BILLING_EVENT_TYPES.offerChanged)
		).toMatchObject({
			sourceSequenceContractVersion: 2,
			sourceSequenceScope: 'billing.offer:offer',
			sourceSequence: 871n
		});
		const retired = {
			...payload,
			schemaVersion: 1,
			eventType: 'billing.offer.changed.v1'
		} as Record<string, unknown>;
		delete retired.sourceSequenceContractVersion;
		delete retired.sourceSequenceScope;
		expect(() =>
			service.parse(retired, BILLING_EVENT_TYPES.offerChanged)
		).toThrow('envelope type is invalid');
	});

	it('does not advance the unscoped Billing allocator', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue([]),
			billingOfferProjection: {
				findUnique: jest.fn().mockResolvedValue(null),
				upsert: jest.fn().mockResolvedValue({})
			},
			billingSettings: { upsert: jest.fn().mockResolvedValue({}) },
			billingSourceSequence: {
				findUnique: jest.fn(),
				create: jest.fn(),
				update: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(
				async (work: (client: typeof transaction) => unknown) =>
					work(transaction)
			)
		};
		const service = new BillingProjectionService(prisma as never);

		await expect(
			service.applyOffer(
				service.parse(payload, BILLING_EVENT_TYPES.offerChanged)
			)
		).resolves.toBe('applied');
		expect(
			transaction.billingSourceSequence.findUnique
		).not.toHaveBeenCalled();
		expect(
			transaction.billingSourceSequence.create
		).not.toHaveBeenCalled();
		expect(
			transaction.billingSourceSequence.update
		).not.toHaveBeenCalled();
	});
});

describe('BillingOutboxPublisherService', () => {
	const event = () => ({
		id: 'outbox-1',
		eventId: '4c230515-2e4e-4e8c-a655-cdcfb8c3dc2b',
		messageId: null,
		eventType: BILLING_EVENT_TYPES.paymentChanged,
		aggregateType: 'billing.payment',
		aggregateId: 'payment-1',
		aggregateVersion: 2n,
		sourceSequence: 9n,
		correlationId: null,
		exchange: 'winwidget.events',
		routingKey: BILLING_EVENT_TYPES.paymentChanged,
		payload: {
			schemaVersion: 1,
			eventType: BILLING_EVENT_TYPES.paymentChanged
		},
		deliveryAttempt: 0,
		status: OutboxStatus.PROCESSING,
		attempt: 1,
		availableAt: new Date(),
		leaseToken: 'lease-1',
		leaseUntil: new Date(Date.now() + 30_000),
		publishedAt: null,
		lastError: null,
		createdAt: new Date(),
		updatedAt: new Date()
	});

	const harness = (publish: jest.Mock) => {
		const value = event();
		const prisma = {
			outboxEvent: {
				findFirst: jest.fn().mockResolvedValue(value),
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				findUniqueOrThrow: jest.fn().mockResolvedValue(value)
			}
		};
		const runtime = {
			outboxPublisherEnabled: true,
			outboxPollIntervalMs: 1000,
			outboxBatchSize: 50
		};
		const service = new BillingOutboxPublisherService(
			prisma as never,
			runtime as never,
			{ publish } as never
		);
		return { service, prisma, value };
	};

	it('marks Outbox PUBLISHED only after the confirmed publication succeeds', async () => {
		const publish = jest.fn().mockResolvedValue(undefined);
		const { service, prisma, value } = harness(publish);

		await expect(service.publishOne()).resolves.toBe(true);

		expect(publish).toHaveBeenCalledWith(
			value.exchange,
			value.routingKey,
			value.payload,
			expect.objectContaining({
				messageId: value.eventId,
				type: value.eventType,
				headers: expect.objectContaining({
					'x-aggregate-version': '2',
					'x-source-sequence': '9'
				})
			})
		);
		expect(prisma.outboxEvent.updateMany).toHaveBeenLastCalledWith({
			where: {
				id: value.id,
				status: OutboxStatus.PROCESSING,
				leaseToken: value.leaseToken
			},
			data: expect.objectContaining({
				status: OutboxStatus.PUBLISHED,
				publishedAt: expect.any(Date)
			})
		});
	});

	it('returns transport failures to PENDING without an irreversible attempt cap', async () => {
		const publish = jest
			.fn()
			.mockRejectedValue(new Error('mandatory publication returned'));
		const { service, prisma, value } = harness(publish);

		await expect(service.publishOne()).resolves.toBe(true);

		expect(prisma.outboxEvent.updateMany).toHaveBeenLastCalledWith({
			where: { id: value.id, leaseToken: value.leaseToken },
			data: expect.objectContaining({
				status: OutboxStatus.PENDING,
				availableAt: expect.any(Date),
				leaseToken: null,
				leaseUntil: null,
				lastError: 'mandatory publication returned'
			})
		});
	});
});

describe('BillingWorkerService retry and DLQ durability', () => {
	const eventId = '4c230515-2e4e-4e8c-a655-cdcfb8c3dc2b';
	const payload = {
		schemaVersion: 1,
		eventType: BILLING_EVENT_TYPES.trialRequested,
		eventId,
		aggregateId: 'user-1',
		aggregateVersion: '1',
		sourceSequence: '1',
		occurredAt: '2026-08-11T00:00:00.000Z',
		tombstone: false,
		state: {
			userId: 'user-1',
			trialDays: 7,
			registeredAt: '2026-08-11T00:00:00.000Z'
		}
	};

	const message = (attempt: number): ConsumeMessage =>
		({
			content: Buffer.from(JSON.stringify(payload)),
			fields: {
				consumerTag: 'consumer-1',
				deliveryTag: 1,
				redelivered: attempt > 0,
				exchange: 'winwidget.events',
				routingKey: BILLING_EVENT_TYPES.trialRequested
			},
			properties: {
				contentType: 'application/json',
				contentEncoding: 'utf-8',
				headers: { 'x-retry-attempt': attempt },
				deliveryMode: 2,
				priority: undefined,
				correlationId: undefined,
				replyTo: undefined,
				expiration: undefined,
				messageId: eventId,
				timestamp: undefined,
				type: BILLING_EVENT_TYPES.trialRequested,
				userId: undefined,
				appId: undefined,
				clusterId: undefined
			}
		}) as ConsumeMessage;

	const makeHarness = () => {
		const transaction = {
			integrationDeliveryReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({ id: 'outbox-retry-1' })
			},
			integrationDeliveryFailure: {
				upsert: jest.fn().mockResolvedValue({ id: 'failure-1' })
			}
		};
		const prisma = {
			integrationDeliveryReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({ id: 'receipt-1' })
			},
			$transaction: jest.fn(
				async (callback: (client: unknown) => unknown) =>
					callback(transaction)
			)
		};
		const rabbit = {
			ack: jest.fn(),
			nack: jest.fn()
		};
		const projections = {
			parse: jest.fn().mockReturnValue({
				eventId,
				aggregateId: 'user-1',
				tombstone: false,
				state: payload.state
			})
		};
		const commands = {
			ensureTrial: jest
				.fn()
				.mockRejectedValue(new Error('temporary failure'))
		};
		const service = new BillingWorkerService(
			prisma as never,
			{ workerEnabled: true } as never,
			rabbit as never,
			projections as never,
			{} as never,
			{} as never,
			commands as never,
			{} as never
		);
		return { service, transaction, prisma, rabbit, commands };
	};

	const handle = (
		service: BillingWorkerService,
		value: ConsumeMessage
	): Promise<void> =>
		(
			service as unknown as {
				handle(
					kind: 'trial-request',
					message: ConsumeMessage
				): Promise<void>;
			}
		).handle('trial-request', value);

	it('creates retry Outbox and state changes atomically before ACK', async () => {
		const { service, transaction, rabbit } = makeHarness();

		await handle(service, message(0));

		expect(
			transaction.integrationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: DeliveryReceiptStatus.RETRY_SCHEDULED,
					retryAvailableAt: expect.any(Date)
				})
			})
		);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: eventId,
				exchange: BILLING_RETRY_EXCHANGE,
				routingKey: 'trial-request.retry.1',
				deliveryAttempt: 1
			})
		});
		expect(
			transaction.integrationDeliveryFailure.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					status: DeliveryFailureStatus.RETRY_PENDING
				})
			})
		);
		expect(rabbit.ack).toHaveBeenCalledTimes(1);
		expect(rabbit.nack).not.toHaveBeenCalled();
	});

	it('moves the exhausted delivery to the independent DLQ through Outbox', async () => {
		const { service, transaction, rabbit } = makeHarness();

		await handle(service, message(3));

		expect(
			transaction.integrationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: DeliveryReceiptStatus.DEAD_LETTERED,
					retryAvailableAt: null
				})
			})
		);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: eventId,
				exchange: BILLING_DEAD_LETTER_EXCHANGE,
				routingKey: 'trial-request.dead-letter',
				deliveryAttempt: 4
			})
		});
		expect(
			transaction.integrationDeliveryFailure.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					status: DeliveryFailureStatus.OPEN
				})
			})
		);
		expect(rabbit.ack).toHaveBeenCalledTimes(1);
	});
});

describe('BillingWorkerService current consumer startup', () => {
	it('attaches every current consumer immediately for the worker role', async () => {
		const rabbit = {
			consume: jest.fn().mockResolvedValue(undefined)
		};
		const service = new BillingWorkerService(
			{} as never,
			{ workerEnabled: true, prefetch: 10 } as never,
			rabbit as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);

		await service.onModuleInit();

		expect(rabbit.consume.mock.calls.map(call => call[0])).toEqual([
			'identity',
			'offer',
			'notification-routing',
			'trial-request',
			'referral-request',
			'lifecycle-repair',
			'auto-renewal-charge',
			'notification-outcome'
		]);
		expect(service.isReady()).toBe(true);
		service.onApplicationShutdown();
	});
});

describe('BillingWorkerService recurring dispatch deadline', () => {
	const eventId = '4c230515-2e4e-4e8c-a655-cdcfb8c3dc2b';
	const payload = {
		schemaVersion: 1,
		eventType: BILLING_EVENT_TYPES.autoRenewalChargeRequested,
		paymentId: 'payment-1',
		autoRenewalId: 'renewal-1',
		cycleKey: 'renewal-1:2026-08-27T10:00:00.000Z:attempt:0',
		scheduledFor: '2026-08-27T10:00:00.000Z'
	};
	const initialPayment = () => ({
		id: 'payment-1',
		userId: 'user-1',
		yookassaId: null,
		providerIdempotencyKey: 'provider-idempotency-1',
		recurringCycleKey: payload.cycleKey,
		recurringAttempt: 0,
		kind: PaymentKind.RECURRING,
		amount: '990.00',
		status: PaymentStatus.PENDING,
		providerStatus: 'queued',
		plan: 'EASY',
		billingPeriod: 'MONTHLY',
		paymentMethodCiphertext: 'encrypted-provider-method',
		confirmationUrl: null,
		checkoutExpiresAt: new Date('2026-08-27T11:00:00.000Z'),
		cancelledAt: null,
		cancellationReason: null,
		aggregateVersion: 1n,
		sourceSequence: 1n,
		createdAt: new Date('2026-08-27T10:00:00.000Z'),
		updatedAt: new Date('2026-08-27T10:00:00.000Z')
	});
	const initialRenewal = () => ({
		id: 'renewal-1',
		userId: 'user-1',
		status: AutoRenewalStatus.ACTIVE,
		dispatchPending: true,
		retryAttempt: 0,
		nextRetryAt: null,
		nextChargeAt: new Date('2026-08-27T10:00:00.000Z'),
		disabledAt: null,
		disableReason: null,
		lastChargeErrorCode: null,
		stateVersion: 3,
		consentVersion: 'consent-v1',
		consentText: 'consent text',
		offerSnapshot: 'offer snapshot',
		offerSha256: 'offer-sha256',
		offerUpdatedAt: new Date('2026-08-01T00:00:00.000Z'),
		plan: 'EASY',
		billingPeriod: 'MONTHLY',
		amount: '990.00',
		currency: 'RUB',
		paymentMethodCiphertext: 'encrypted-provider-method'
	});
	const initialOperation = (attempt = 0) => ({
		id: 'operation-1',
		paymentId: 'payment-1',
		providerPaymentId: null,
		idempotencyKey: 'provider-idempotency-1',
		kind: ProviderOperationKind.CAPTURE_RECURRING,
		status: ProviderOperationStatus.PENDING,
		attempt,
		createdAt: new Date('2026-08-27T10:30:00.000Z')
	});

	const makeHarness = (
		providerOperation: ReturnType<typeof initialOperation> | null,
		checkoutExpiresAt?: Date
	) => {
		let payment = initialPayment();
		if (checkoutExpiresAt) {
			payment = { ...payment, checkoutExpiresAt };
		}
		let renewal = initialRenewal();
		let operation = providerOperation;
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			payment: {
				findUnique: jest.fn().mockImplementation(() => payment),
				findUniqueOrThrow: jest.fn().mockImplementation(() => payment),
				updateMany: jest.fn().mockImplementation(({ data }) => {
					if (
						payment.status !== PaymentStatus.PENDING ||
						payment.providerStatus !== 'queued'
					) {
						return { count: 0 };
					}
					payment = {
						...payment,
						status: data.status,
						providerStatus: data.providerStatus,
						paymentMethodCiphertext: data.paymentMethodCiphertext,
						confirmationUrl: data.confirmationUrl,
						cancelledAt: data.cancelledAt,
						cancellationReason: data.cancellationReason,
						aggregateVersion: payment.aggregateVersion + 1n,
						sourceSequence: data.sourceSequence,
						updatedAt: new Date()
					};
					return { count: 1 };
				})
			},
			autoRenewal: {
				findUnique: jest.fn().mockImplementation(() => renewal),
				updateMany: jest.fn().mockImplementation(({ data }) => {
					if (
						renewal.status !== AutoRenewalStatus.ACTIVE ||
						!renewal.dispatchPending
					) {
						return { count: 0 };
					}
					renewal = {
						...renewal,
						status: data.status,
						nextRetryAt: data.nextRetryAt,
						dispatchPending: data.dispatchPending,
						disabledAt: data.disabledAt,
						disableReason: data.disableReason,
						lastChargeErrorCode: data.lastChargeErrorCode,
						stateVersion: renewal.stateVersion + 1
					};
					return { count: 1 };
				})
			},
			providerOperation: {
				findFirst: jest.fn().mockImplementation(() => operation),
				upsert: jest.fn(),
				updateMany: jest.fn().mockImplementation(({ data }) => {
					if (
						!operation ||
						operation.status !== ProviderOperationStatus.PENDING ||
						operation.attempt !== 0
					) {
						return { count: 0 };
					}
					operation = { ...operation, ...data };
					return { count: 1 };
				})
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 9n })
			},
			autoRenewalConsentEvent: {
				create: jest.fn().mockResolvedValue({ id: 'consent-event-1' })
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({ id: 'outbox-1' })
			}
		};
		const prisma = {
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			),
			integrationDeliveryReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			integrationDeliveryFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			}
		};
		const rabbit = { ack: jest.fn(), nack: jest.fn() };
		const subscriptions = new SubscriptionDomainService(
			{} as never,
			{} as never
		);
		const service = new BillingWorkerService(
			prisma as never,
			{} as never,
			rabbit as never,
			{} as never,
			subscriptions,
			{} as never,
			{} as never,
			{} as never
		);
		const deliver = () =>
			(
				service as unknown as {
					deliver(
						kind: 'auto-renewal-charge',
						value: typeof payload,
						eventId: string
					): Promise<void>;
				}
			).deliver('auto-renewal-charge', payload, eventId);
		const handle = () =>
			(
				service as unknown as {
					handle(
						kind: 'auto-renewal-charge',
						message: ConsumeMessage
					): Promise<void>;
				}
			).handle('auto-renewal-charge', {
				content: Buffer.from(JSON.stringify(payload)),
				fields: {
					consumerTag: 'consumer-1',
					deliveryTag: 1,
					redelivered: false,
					exchange: 'winwidget.events',
					routingKey: BILLING_EVENT_TYPES.autoRenewalChargeRequested
				},
				properties: {
					contentType: 'application/json',
					contentEncoding: 'utf-8',
					headers: {},
					deliveryMode: 2,
					priority: undefined,
					correlationId: undefined,
					replyTo: undefined,
					expiration: undefined,
					messageId: eventId,
					timestamp: undefined,
					type: BILLING_EVENT_TYPES.autoRenewalChargeRequested,
					userId: undefined,
					appId: undefined,
					clusterId: undefined
				}
			} as ConsumeMessage);

		return {
			deliver,
			handle,
			prisma,
			transaction,
			rabbit,
			getPayment: () => payment,
			getRenewal: () => renewal,
			getOperation: () => operation
		};
	};

	beforeEach(() => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	it('terminally closes an unattempted delayed charge and ACKs it', async () => {
		const value = makeHarness(null);

		await expect(value.handle()).resolves.toBeUndefined();

		expect(value.rabbit.ack).toHaveBeenCalledTimes(1);
		expect(value.rabbit.nack).not.toHaveBeenCalled();
		expect(
			value.prisma.integrationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: DeliveryReceiptStatus.DELIVERED
				})
			})
		);
		expect(
			value.transaction.providerOperation.upsert
		).not.toHaveBeenCalled();
		expect(
			value.transaction.providerOperation.updateMany
		).not.toHaveBeenCalled();
		expect(value.getPayment()).toMatchObject({
			providerIdempotencyKey: 'provider-idempotency-1',
			status: PaymentStatus.CANCELLED,
			providerStatus: 'not_sent',
			paymentMethodCiphertext: null,
			cancellationReason: 'CHARGE_WINDOW_EXPIRED',
			aggregateVersion: 2n,
			sourceSequence: 8n
		});
		expect(value.getRenewal()).toMatchObject({
			status: AutoRenewalStatus.TECHNICAL_PAUSE,
			dispatchPending: false,
			lastChargeErrorCode: 'CHARGE_WINDOW_EXPIRED',
			paymentMethodCiphertext: 'encrypted-provider-method',
			stateVersion: 4
		});
		expect(
			value.transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				type: AutoRenewalConsentEventType.TECHNICAL_PAUSED,
				source: 'AUTO_RENEWAL_DISPATCH_DEADLINE',
				metadata: expect.objectContaining({
					errorCode: 'CHARGE_WINDOW_EXPIRED',
					paymentId: 'payment-1',
					triggerId: eventId
				})
			})
		});
		expect(value.transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: BILLING_EVENT_TYPES.paymentChanged,
				exchange: 'winwidget.events',
				payload: expect.objectContaining({
					eventType: BILLING_EVENT_TYPES.paymentChanged,
					aggregateVersion: '2',
					sourceSequence: '8',
					state: expect.objectContaining({
						id: 'payment-1',
						status: PaymentStatus.CANCELLED
					})
				})
			})
		});
		expect(value.prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: 'Serializable' })
		);
	});

	it('repeats the terminal delivery without duplicate state or events', async () => {
		const value = makeHarness(null);

		await expect(value.deliver()).resolves.toBeUndefined();
		await expect(value.deliver()).resolves.toBeUndefined();

		expect(value.transaction.payment.updateMany).toHaveBeenCalledTimes(1);
		expect(value.transaction.autoRenewal.updateMany).toHaveBeenCalledTimes(
			1
		);
		expect(
			value.transaction.billingSourceSequence.upsert
		).toHaveBeenCalledTimes(1);
		expect(
			value.transaction.autoRenewalConsentEvent.create
		).toHaveBeenCalledTimes(1);
		expect(value.transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
	});

	it('CAS-fails a matching PENDING attempt-zero operation without rearming it', async () => {
		const value = makeHarness(initialOperation());

		await expect(value.deliver()).resolves.toBeUndefined();

		expect(
			value.transaction.providerOperation.upsert
		).not.toHaveBeenCalled();
		expect(
			value.transaction.providerOperation.updateMany
		).toHaveBeenCalledWith({
			where: {
				id: 'operation-1',
				status: ProviderOperationStatus.PENDING,
				attempt: 0,
				providerPaymentId: null
			},
			data: expect.objectContaining({
				status: ProviderOperationStatus.FAILED,
				lastErrorCode: 'CHARGE_WINDOW_EXPIRED'
			})
		});
		expect(value.getOperation()).toMatchObject({
			status: ProviderOperationStatus.FAILED,
			attempt: 0,
			lastErrorCode: 'CHARGE_WINDOW_EXPIRED'
		});
	});

	it('does not terminally close an attempted operation that needs reconciliation', async () => {
		const value = makeHarness(initialOperation(1));

		await expect(value.deliver()).rejects.toThrow(
			'Auto-renewal charge requires provider reconciliation'
		);

		expect(value.transaction.payment.updateMany).not.toHaveBeenCalled();
		expect(
			value.transaction.autoRenewal.updateMany
		).not.toHaveBeenCalled();
		expect(
			value.transaction.autoRenewalConsentEvent.create
		).not.toHaveBeenCalled();
		expect(value.transaction.outboxEvent.create).not.toHaveBeenCalled();
	});

	it('keeps the normal not-expired charge dispatch path unchanged', async () => {
		const value = makeHarness(null, new Date('2026-08-27T13:00:00.000Z'));

		await expect(value.deliver()).resolves.toBeUndefined();

		expect(
			value.transaction.providerOperation.upsert
		).toHaveBeenCalledWith({
			where: { idempotencyKey: 'provider-idempotency-1' },
			create: expect.objectContaining({
				paymentId: 'payment-1',
				idempotencyKey: 'provider-idempotency-1',
				kind: ProviderOperationKind.CAPTURE_RECURRING
			}),
			update: {}
		});
		expect(value.transaction.payment.updateMany).not.toHaveBeenCalled();
		expect(
			value.transaction.autoRenewal.updateMany
		).not.toHaveBeenCalled();
		expect(
			value.transaction.autoRenewalConsentEvent.create
		).not.toHaveBeenCalled();
		expect(value.transaction.outboxEvent.create).not.toHaveBeenCalled();
	});
});
