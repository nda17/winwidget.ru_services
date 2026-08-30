import { ReportingDeliveryFailuresService } from './reporting-delivery-failures.service';
import { reportingPayloadHash } from '../projections/reporting-event.contract';
import {
	ReportingConsumerFailureStatus,
	ReportingConsumerReceiptStatus,
	ReportingOutboxExchange
} from '@prisma/reporting-client';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const FAILURE_ID = '22222222-2222-4222-8222-222222222222';
const PAYLOAD = {
	schemaVersion: 1,
	eventType: 'billing.payment.changed.v1',
	eventId: EVENT_ID,
	aggregateId: 'payment-1',
	aggregateVersion: '2',
	sourceSequence: '10',
	occurredAt: '2026-07-31T00:00:00.000Z',
	tombstone: false,
	state: {
		id: 'payment-1',
		userId: 'user-1',
		amount: '10.00',
		status: 'SUCCEEDED',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-31T00:00:00.000Z'
	}
} as const;
const PAYLOAD_HASH = reportingPayloadHash(PAYLOAD);
const SETTINGS_PAYLOAD = {
	schemaVersion: 1,
	eventId: EVENT_ID,
	operationalAlertsThreadId: 2024,
	changedAt: '2026-07-31T00:00:00.000Z'
} as const;
const SETTINGS_PAYLOAD_HASH = reportingPayloadHash(SETTINGS_PAYLOAD);

interface FailureFixtureInput {
	consumer?: string;
	consumerKind?: string;
	eventType?: string;
	payload?: unknown;
	payloadHash?: string;
}

describe('ReportingDeliveryFailuresService', () => {
	function harness(
		status: ReportingConsumerFailureStatus = ReportingConsumerFailureStatus.OPEN,
		input: FailureFixtureInput = {}
	) {
		const payload = input.payload ?? PAYLOAD;
		const payloadHash = input.payloadHash ?? reportingPayloadHash(payload);
		const failure = {
			id: FAILURE_ID,
			eventId: EVENT_ID,
			consumer: input.consumer ?? 'reporting-billing-payment-v1',
			consumerKind: input.consumerKind ?? 'billingPayment',
			eventType: input.eventType ?? 'billing.payment.changed.v1',
			payload,
			payloadHash,
			status,
			manualRetryCount:
				status === ReportingConsumerFailureStatus.RETRY_REQUESTED ? 1 : 0,
			retryRequestedAt:
				status === ReportingConsumerFailureStatus.RETRY_REQUESTED
					? new Date('2026-07-31T10:00:00.000Z')
					: null
		};
		const transaction = {
			reportingConsumerFailure: {
				findUnique: jest.fn().mockResolvedValue(failure),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			consumerReceipt: {
				findUnique: jest.fn().mockResolvedValue({
					id: '33333333-3333-4333-8333-333333333333',
					status: ReportingConsumerReceiptStatus.DEAD_LETTERED,
					payloadHash,
					retryCycle: 0
				}),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			reportingOutboxEvent: {
				create: jest.fn().mockResolvedValue({})
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (value: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		return {
			service: new ReportingDeliveryFailuresService(prisma as never),
			transaction,
			failure
		};
	}

	function settingsHarness(payload: unknown = SETTINGS_PAYLOAD) {
		return harness(ReportingConsumerFailureStatus.OPEN, {
			consumer: 'reporting-settings-v1',
			consumerKind: 'reportingSettings',
			eventType: 'operations.notification-routing.changed.v1',
			payload,
			payloadHash: reportingPayloadHash(payload)
		});
	}

	it('creates the manual retry and audit Outbox rows in one transaction', async () => {
		const { service, transaction } = harness();
		await expect(
			service.retryFailure(EVENT_ID, 'billingPayment', 'admin-1')
		).resolves.toEqual(
			expect.objectContaining({
				eventId: EVENT_ID,
				consumerKind: 'billingPayment',
				status: 'retry-requested',
				manualRetryCount: 1
			})
		);
		expect(transaction.consumerReceipt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
					retryAttempt: 0,
					retryCycle: 1
				})
			})
		);
		expect(transaction.reportingOutboxEvent.create).toHaveBeenCalledTimes(
			2
		);
		expect(
			transaction.reportingOutboxEvent.create
		).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				data: expect.objectContaining({
					exchange: ReportingOutboxExchange.MANUAL_RETRY,
					routingKey: 'manual.billingPayment',
					headers: expect.objectContaining({
						'x-retry-cycle': 1,
						'x-manual-retry': true
					})
				})
			})
		);
		expect(
			transaction.reportingOutboxEvent.create
		).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				data: expect.objectContaining({
					exchange: ReportingOutboxExchange.EVENTS,
					routingKey: 'admin.audit.reporting.v1',
					payload: expect.objectContaining({
						action: 'REPORTING_DELIVERY_RETRY',
						target: {
							eventId: EVENT_ID,
							consumerKind: 'billingPayment'
						},
						metadata: {}
					})
				})
			})
		);
	});

	it('creates a manual retry for an Operations notification routing failure', async () => {
		const { service, transaction } = settingsHarness();

		await expect(
			service.retryFailure(EVENT_ID, 'reportingSettings', 'admin-1')
		).resolves.toEqual(
			expect.objectContaining({
				eventId: EVENT_ID,
				consumerKind: 'reportingSettings',
				status: 'retry-requested',
				manualRetryCount: 1
			})
		);
		expect(
			transaction.reportingConsumerFailure.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ReportingConsumerFailureStatus.RETRY_REQUESTED,
					manualRetryCount: 1
				})
			})
		);
		expect(transaction.consumerReceipt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					payloadHash: SETTINGS_PAYLOAD_HASH,
					retryCycle: 0
				}),
				data: expect.objectContaining({
					status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
					retryCycle: 1
				})
			})
		);
		expect(
			transaction.reportingOutboxEvent.create
		).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				data: expect.objectContaining({
					exchange: ReportingOutboxExchange.MANUAL_RETRY,
					eventType: 'operations.notification-routing.changed.v1',
					routingKey: 'manual.reportingSettings',
					payload: SETTINGS_PAYLOAD,
					headers: expect.objectContaining({
						'x-retry-attempt': 0,
						'x-retry-cycle': 1,
						'x-manual-retry': true
					})
				})
			})
		);
	});

	it('rejects a reporting settings payload with another event identity', async () => {
		const { service, transaction } = settingsHarness({
			...SETTINGS_PAYLOAD,
			eventId: '44444444-4444-4444-8444-444444444444'
		});

		await expect(
			service.retryFailure(EVENT_ID, 'reportingSettings', 'admin-1')
		).rejects.toThrow('payload identity is invalid');
		expect(
			transaction.reportingConsumerFailure.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.reportingOutboxEvent.create).not.toHaveBeenCalled();
	});

	it('is idempotent while the same manual retry is already pending', async () => {
		const { service, transaction } = harness(
			ReportingConsumerFailureStatus.RETRY_REQUESTED
		);
		await expect(
			service.retryFailure(EVENT_ID, 'billingPayment', 'admin-1')
		).resolves.toMatchObject({
			status: 'retry-requested',
			manualRetryCount: 1,
			retryRequestedAt: '2026-07-31T10:00:00.000Z'
		});
		expect(transaction.consumerReceipt.findUnique).not.toHaveBeenCalled();
		expect(transaction.reportingOutboxEvent.create).not.toHaveBeenCalled();
	});

	it('returns the winning concurrent retry after losing the failure claim', async () => {
		const { service, transaction, failure } = harness();
		const retryRequestedAt = new Date('2026-07-31T10:00:00.000Z');
		transaction.reportingConsumerFailure.findUnique
			.mockResolvedValueOnce(failure)
			.mockResolvedValueOnce({
				...failure,
				status: ReportingConsumerFailureStatus.RETRY_REQUESTED,
				manualRetryCount: 1,
				retryRequestedAt
			});
		transaction.reportingConsumerFailure.updateMany.mockResolvedValue({
			count: 0
		});
		transaction.consumerReceipt.findUnique.mockResolvedValue({
			id: '33333333-3333-4333-8333-333333333333',
			status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
			payloadHash: PAYLOAD_HASH,
			retryCycle: 1
		});

		await expect(
			service.retryFailure(EVENT_ID, 'billingPayment', 'admin-1')
		).resolves.toMatchObject({
			status: 'retry-requested',
			manualRetryCount: 1,
			retryRequestedAt: retryRequestedAt.toISOString()
		});
		expect(transaction.consumerReceipt.findUnique).not.toHaveBeenCalled();
		expect(transaction.consumerReceipt.updateMany).not.toHaveBeenCalled();
		expect(transaction.reportingOutboxEvent.create).not.toHaveBeenCalled();
	});

	it('rejects an invalid receipt after claiming the failure', async () => {
		const { service, transaction } = harness();
		transaction.consumerReceipt.findUnique.mockResolvedValue({
			id: '33333333-3333-4333-8333-333333333333',
			status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
			payloadHash: PAYLOAD_HASH,
			retryCycle: 1
		});

		await expect(
			service.retryFailure(EVENT_ID, 'billingPayment', 'admin-1')
		).rejects.toThrow('Reporting delivery receipt is not retryable');
		expect(
			transaction.reportingConsumerFailure.updateMany
		).toHaveBeenCalledTimes(1);
		expect(transaction.consumerReceipt.updateMany).not.toHaveBeenCalled();
		expect(transaction.reportingOutboxEvent.create).not.toHaveBeenCalled();
	});

	it('rejects an unknown consumer before opening a transaction', async () => {
		const { service } = harness();
		await expect(
			service.retryFailure(EVENT_ID, 'unknown', 'admin-1')
		).rejects.toThrow('consumerKind is not a Reporting consumer');
	});

	it('rejects a corrupted durable failure before changing its state', async () => {
		const { service, transaction } = harness();
		transaction.reportingConsumerFailure.findUnique.mockResolvedValue({
			...(await transaction.reportingConsumerFailure.findUnique()),
			payloadHash: '0'.repeat(64)
		});

		await expect(
			service.retryFailure(EVENT_ID, 'billingPayment', 'admin-1')
		).rejects.toThrow('payload identity is invalid');
		expect(
			transaction.reportingConsumerFailure.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.reportingOutboxEvent.create).not.toHaveBeenCalled();
	});
});
