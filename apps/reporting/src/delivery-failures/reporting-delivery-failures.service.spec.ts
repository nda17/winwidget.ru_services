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

describe('ReportingDeliveryFailuresService', () => {
	function harness(
		status: ReportingConsumerFailureStatus = ReportingConsumerFailureStatus.OPEN
	) {
		const failure = {
			id: FAILURE_ID,
			eventId: EVENT_ID,
			consumer: 'reporting-billing-payment-v1',
			consumerKind: 'billingPayment',
			eventType: 'billing.payment.changed.v1',
			payload: PAYLOAD,
			payloadHash: PAYLOAD_HASH,
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
					payloadHash: PAYLOAD_HASH,
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
