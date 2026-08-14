import {
	ConsumerFailureStatus,
	ConsumerReceiptStatus,
	OutboxExchange
} from '@prisma/identity-client';
import { semanticJsonHash } from './destination-worker.service';
import {
	DESTINATION_EVENT,
	DESTINATION_KIND
} from './messaging.constants';
import { IdentityMessagingAdminService } from './messaging-admin.service';

const FAILURE_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = '00000000-0000-4000-8000-000000000002';
const event = {
	schemaVersion: 1 as const,
	eventType: DESTINATION_EVENT,
	sourceEventId: '00000000-0000-4000-8000-000000000003',
	sourceKind: 'telegram',
	destination: { telegramChatId: '777' },
	normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
	occurredAt: '2026-08-14T10:00:00.000Z'
};

function failure(overrides: Record<string, any> = {}) {
	return {
		id: FAILURE_ID,
		eventId: EVENT_ID,
		consumer: 'telegram-destination-unavailable',
		eventType: DESTINATION_EVENT,
		routingKey: DESTINATION_EVENT,
		payload: event,
		headers: {},
		payloadHash: semanticJsonHash(event),
		correlationId: EVENT_ID,
		status: ConsumerFailureStatus.OPEN,
		attempts: 4,
		manualRetryCount: 0,
		lastError: 'chat unavailable',
		lastFailedAt: new Date(),
		retryRequestedAt: null,
		retryRequestedById: null,
		retryToken: null,
		retryLeaseExpiresAt: null,
		resolvedAt: null,
		resolutionComment: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides
	};
}

function createService(current = failure()) {
	const transaction = {
		consumerFailure: {
			findUnique: jest.fn().mockResolvedValue(current),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		consumerReceipt: {
			findUnique: jest.fn().mockResolvedValue({
				id: 'receipt',
				eventId: EVENT_ID,
				consumer: 'telegram-destination-unavailable',
				status: ConsumerReceiptStatus.DEAD_LETTERED,
				payloadHash: semanticJsonHash(event),
				manualRetryCycle: 0
			}),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		outboxEvent: { create: jest.fn() },
		user: { findMany: jest.fn().mockResolvedValue([]) }
	};
	const prisma = {
		$transaction: jest.fn(
			(callback: (tx: typeof transaction) => unknown) =>
				callback(transaction)
		)
	};
	const events = { emitAudit: jest.fn() };
	return {
		service: new IdentityMessagingAdminService(
			prisma as any,
			events as any
		),
		prisma,
		transaction,
		events
	};
}

describe('Identity messaging manual actions', () => {
	it('CAS-claims receipt/failure and creates manual retry through transactional Outbox', async () => {
		const value = createService();
		await expect(
			value.service.retry(FAILURE_ID, 'dev-user')
		).resolves.toMatchObject({
			id: FAILURE_ID,
			eventId: EVENT_ID,
			integration: 'telegram-destination-unavailable',
			retryingAt: expect.any(String)
		});
		expect(
			value.transaction.consumerFailure.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ConsumerFailureStatus.RETRYING,
					manualRetryCount: 1,
					retryToken: expect.any(String)
				})
			})
		);
		expect(
			value.transaction.consumerReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: ConsumerReceiptStatus.DEAD_LETTERED,
					payloadHash: semanticJsonHash(event)
				}),
				data: expect.objectContaining({
					status: ConsumerReceiptStatus.RETRY_SCHEDULED,
					manualRetryCycle: 1,
					lockToken: expect.any(String)
				})
			})
		);
		expect(value.transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				exchange: OutboxExchange.MANUAL_RETRY,
				eventType: DESTINATION_EVENT,
				routingKey: DESTINATION_KIND,
				payload: event,
				headers: expect.objectContaining({
					'x-original-event-id': EVENT_ID,
					'x-delivery-token': expect.any(String),
					'x-manual-retry-cycle': 1
				})
			})
		});
		expect(value.events.emitAudit).toHaveBeenCalledWith(
			value.transaction,
			expect.objectContaining({ action: 'MESSAGING_FAILURE_RETRY' })
		);
	});

	it('closes an open failure and its receipt atomically', async () => {
		const value = createService();
		await expect(
			value.service.close(FAILURE_ID, 'dev-user', 'Destination removed')
		).resolves.toMatchObject({
			id: FAILURE_ID,
			eventId: EVENT_ID,
			integration: 'telegram-destination-unavailable',
			resolvedAt: expect.any(String),
			resolution: 'CLOSED_NO_RETRY'
		});
		expect(
			value.transaction.consumerReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ConsumerReceiptStatus.CLOSED_NO_RETRY
				})
			})
		);
		expect(
			value.transaction.consumerFailure.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: ConsumerFailureStatus.CLOSED_NO_RETRY,
					resolutionComment: 'Destination removed'
				})
			})
		);
		expect(value.events.emitAudit).toHaveBeenCalledWith(
			value.transaction,
			expect.objectContaining({
				action: 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY'
			})
		);
	});
});
