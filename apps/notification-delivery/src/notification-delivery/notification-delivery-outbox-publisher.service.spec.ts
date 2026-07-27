import {
	NotificationDeliveryExchange,
	NotificationDeliveryOutboxStatus
} from '@prisma/notification-delivery-client';
import { NotificationDeliveryOutboxPublisherService } from './notification-delivery-outbox-publisher.service';
import type { NotificationDeliveryHeartbeatService } from './notification-delivery-heartbeat.service';
import type { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { ConfigService } from '@nestjs/config';

describe('NotificationDeliveryOutboxPublisherService', () => {
	const createService = () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			notificationDeliveryOutboxEvent: { updateMany }
		} as unknown as NotificationDeliveryPrismaService;
		const rabbitMq = {
			publishOutboxMessage: jest.fn().mockResolvedValue(undefined)
		} as unknown as RabbitMqService;
		const config = { get: jest.fn() } as unknown as ConfigService;
		const heartbeat = {
			markSuccessfulPublish: jest.fn()
		} as unknown as NotificationDeliveryHeartbeatService;
		return {
			service: new NotificationDeliveryOutboxPublisherService(
				prisma,
				rabbitMq,
				config,
				heartbeat
			),
			prisma,
			rabbitMq,
			heartbeat
		};
	};

	const event = {
		id: 'outbox-1',
		messageId: '11111111-1111-4111-8111-111111111111',
		deduplicationKey: 'retry-1',
		exchange: NotificationDeliveryExchange.EVENTS,
		eventType: 'payment.succeeded.v1',
		routingKey: 'manual.payment-email',
		payload: {
			schemaVersion: 1,
			eventType: 'payment.succeeded.v1',
			payment: {
				id: 'payment-1',
				yookassaId: 'yookassa-1',
				amount: '1000',
				plan: 'EASY',
				billingPeriod: 'MONTHLY',
				succeededAt: '2026-07-25T00:00:00.000Z'
			},
			user: {
				id: 'user-1',
				name: null,
				email: 'owner@example.com',
				phone: null
			},
			subscription: {
				expiresAt: '2026-08-25T00:00:00.000Z'
			}
		},
		headers: { 'x-correlation-id': 'correlation-1' },
		status: NotificationDeliveryOutboxStatus.PUBLISHING,
		attempts: 0,
		availableAt: new Date(),
		lockedAt: new Date(),
		lockedBy: 'worker',
		lockToken: '22222222-2222-4222-8222-222222222222',
		leaseExpiresAt: new Date(Date.now() + 60_000),
		publishedAt: null,
		lastError: null,
		createdAt: new Date(),
		updatedAt: new Date()
	};

	it('marks an outbox event published only after RabbitMQ confirm', async () => {
		const { service, prisma, rabbitMq, heartbeat } = createService();

		await (service as any).publish(event);

		expect(rabbitMq.publishOutboxMessage).toHaveBeenCalledWith(
			'winwidget.events',
			'manual.payment-email',
			event.payload,
			expect.objectContaining({
				messageId: event.messageId,
				type: event.eventType,
				correlationId: 'correlation-1'
			})
		);
		expect(heartbeat.markSuccessfulPublish).toHaveBeenCalledTimes(1);
		expect(
			prisma.notificationDeliveryOutboxEvent.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: NotificationDeliveryOutboxStatus.PUBLISHED,
					publishedAt: expect.any(Date),
					lockToken: null
				})
			})
		);
	});

	it('keeps transport failures pending with backoff', async () => {
		const { service, prisma, rabbitMq, heartbeat } = createService();
		(rabbitMq.publishOutboxMessage as jest.Mock).mockRejectedValue(
			new Error('RabbitMQ unavailable')
		);

		await (service as any).publish(event);

		expect(heartbeat.markSuccessfulPublish).not.toHaveBeenCalled();
		expect(
			prisma.notificationDeliveryOutboxEvent.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: NotificationDeliveryOutboxStatus.PENDING,
					attempts: 1,
					availableAt: expect.any(Date),
					lastError: 'RabbitMQ unavailable'
				})
			})
		);
	});

	it('publishes an exact service-owned dead-letter route', async () => {
		const { service, rabbitMq } = createService();
		const deadLetterEvent = {
			...event,
			exchange: NotificationDeliveryExchange.DEAD_LETTER,
			routingKey: 'payment-email.dead-letter',
			payload: { malformed: 'payload preserved for inspection' }
		};

		await (service as any).publish(deadLetterEvent);

		expect(rabbitMq.publishOutboxMessage).toHaveBeenCalledWith(
			'winwidget.dead-letter',
			'payment-email.dead-letter',
			deadLetterEvent.payload,
			expect.objectContaining({
				messageId: event.messageId,
				type: event.eventType
			})
		);
	});

	it.each([
		{
			label: 'a route owned by the legacy worker',
			overrides: { routingKey: 'manual.payment-telegram' },
			reason: 'INVALID_NOTIFICATION_DELIVERY_ROUTE'
		},
		{
			label: 'a non-exact dead-letter route',
			overrides: {
				exchange: NotificationDeliveryExchange.DEAD_LETTER,
				routingKey: 'email.dead-letter.extra'
			},
			reason: 'INVALID_NOTIFICATION_DELIVERY_ROUTE'
		},
		{
			label: 'an invalid owned event contract',
			overrides: {
				payload: {
					schemaVersion: 1,
					eventType: 'payment.succeeded.v1'
				}
			},
			reason: 'INVALID_NOTIFICATION_DELIVERY_CONTRACT'
		}
	])(
		'quarantines $label without publishing or retrying it',
		async ({ overrides, reason }) => {
			const { service, prisma, rabbitMq, heartbeat } = createService();

			await (service as any).publish({ ...event, ...overrides });

			expect(rabbitMq.publishOutboxMessage).not.toHaveBeenCalled();
			expect(heartbeat.markSuccessfulPublish).not.toHaveBeenCalled();
			expect(
				prisma.notificationDeliveryOutboxEvent.updateMany
			).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						id: event.id,
						status: NotificationDeliveryOutboxStatus.PUBLISHING,
						lockToken: event.lockToken
					}),
					data: expect.objectContaining({
						status: NotificationDeliveryOutboxStatus.FAILED,
						attempts: { increment: 1 },
						lockToken: null,
						lastError: reason
					})
				})
			);
		}
	);

	it('does not return terminal failed events to the pending queue', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 0 });
		const transaction = {
			notificationDeliveryOutboxEvent: {
				updateMany,
				findMany: jest.fn().mockResolvedValue([])
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as NotificationDeliveryPrismaService;
		const service = new NotificationDeliveryOutboxPublisherService(
			prisma,
			{} as RabbitMqService,
			{ get: jest.fn() } as unknown as ConfigService,
			{} as NotificationDeliveryHeartbeatService
		);

		await (service as any).claimBatch();

		expect(updateMany).toHaveBeenCalledTimes(1);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: NotificationDeliveryOutboxStatus.PUBLISHING
				})
			})
		);
	});
});
