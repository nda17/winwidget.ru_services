import { ConflictException } from '@nestjs/common';
import {
	ConsumerFailureStatus,
	ConsumerReceiptStatus,
	OutboxExchange,
	SupportInboxStatus
} from '@prisma/support-client';
import type { Request } from 'express';
import type { SupportActor } from '../auth/support-request';
import type { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportMessagingAdminService } from './support-messaging-admin.service';

const actor: SupportActor = {
	active: true,
	subject: '11111111-1111-4111-8111-111111111111',
	sessionId: 'support-admin-session',
	roles: ['DEV']
};
const request = {
	ip: '203.0.113.10',
	socket: {},
	get: jest.fn().mockReturnValue('support-admin-spec')
} as unknown as Request;
const poisonFailure = {
	id: '22222222-2222-4222-8222-222222222222',
	eventId: '33333333-3333-4333-8333-333333333333',
	consumer: 'support-telegram-webhook',
	eventType: 'support.poison.v1',
	status: ConsumerFailureStatus.OPEN,
	payload: { schemaVersion: 1, payloadHash: 'a'.repeat(64) },
	manualRetryCount: 0,
	correlationId: '44444444-4444-4444-8444-444444444444'
};
const retryableFailure = {
	...poisonFailure,
	id: '55555555-5555-4555-8555-555555555555',
	eventType: 'support.telegram.webhook-admitted.v1',
	payload: {
		schemaVersion: 1,
		eventType: 'support.telegram.webhook-admitted.v1',
		eventId: poisonFailure.eventId,
		inboxId: '66666666-6666-4666-8666-666666666666',
		updateId: '42',
		bodyHash: 'b'.repeat(64),
		occurredAt: '2026-08-24T00:00:00.000Z'
	},
	manualRetryCount: 2
};

function build(
	failure: typeof poisonFailure | typeof retryableFailure = poisonFailure
) {
	const transaction = {
		consumerFailure: {
			findUnique: jest.fn().mockResolvedValue(failure),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		consumerReceipt: {
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		telegramWebhookInbox: {
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		outboxEvent: {
			create: jest.fn().mockResolvedValue({ id: 'audit-outbox-id' })
		}
	};
	const prisma = {
		$transaction: jest.fn(
			(callback: (value: typeof transaction) => unknown) =>
				callback(transaction)
		)
	} as unknown as SupportPrismaService;
	return {
		service: new SupportMessagingAdminService(prisma),
		transaction
	};
}

describe('SupportMessagingAdminService poison handling', () => {
	it('creates a CAS-bound manual retry and audit in one transaction', async () => {
		const { service, transaction } = build(retryableFailure);

		await expect(
			service.retry(retryableFailure.id, actor, request)
		).resolves.toEqual({
			accepted: true,
			eventId: retryableFailure.eventId
		});
		expect(transaction.consumerFailure.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: retryableFailure.id,
					status: ConsumerFailureStatus.OPEN
				},
				data: expect.objectContaining({
					status: ConsumerFailureStatus.RETRYING,
					manualRetryCount: { increment: 1 },
					retryToken: expect.any(String),
					retryLeaseExpiresAt: expect.any(Date)
				})
			})
		);
		expect(transaction.consumerReceipt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					eventId: retryableFailure.eventId,
					status: ConsumerReceiptStatus.DEAD_LETTERED
				}),
				data: expect.objectContaining({
					status: ConsumerReceiptStatus.RETRY_SCHEDULED,
					manualRetryCycle: { increment: 1 },
					lockToken: expect.any(String)
				})
			})
		);
		expect(
			transaction.telegramWebhookInbox.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: retryableFailure.payload.inboxId,
					status: SupportInboxStatus.DEAD_LETTERED
				},
				data: expect.objectContaining({
					status: SupportInboxStatus.RETRY_SCHEDULED
				})
			})
		);
		expect(transaction.outboxEvent.create).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				data: expect.objectContaining({
					exchange: OutboxExchange.MANUAL_RETRY,
					deduplicationKey: `${retryableFailure.eventId}:manual:3`,
					routingKey: 'support-telegram-webhook'
				})
			})
		);
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(2);
	});

	it('rejects manual retry because a poison payload has no durable inbox', async () => {
		const { service, transaction } = build();

		await expect(
			service.retry(poisonFailure.id, actor, request)
		).rejects.toBeInstanceOf(ConflictException);
		expect(transaction.consumerFailure.updateMany).not.toHaveBeenCalled();
		expect(transaction.consumerReceipt.updateMany).not.toHaveBeenCalled();
		expect(
			transaction.telegramWebhookInbox.updateMany
		).not.toHaveBeenCalled();
	});

	it('closes a poison failure without inventing receipt or inbox state', async () => {
		const { service, transaction } = build();

		await expect(
			service.close(
				poisonFailure.id,
				'investigated poison',
				actor,
				request
			)
		).resolves.toEqual({ closed: true });
		expect(transaction.consumerFailure.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: poisonFailure.id,
					status: ConsumerFailureStatus.OPEN
				}
			})
		);
		expect(transaction.consumerReceipt.updateMany).not.toHaveBeenCalled();
		expect(
			transaction.telegramWebhookInbox.updateMany
		).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
	});
});
