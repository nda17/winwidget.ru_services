import { ConfigService } from '@nestjs/config';
import {
	WidgetsOutboxExchange,
	WidgetsOutboxStatus
} from '@prisma/widgets-client';
import type { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import type { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';
import { WidgetsOutboxPublisherService } from './widgets-outbox-publisher.service';
import type { WidgetsRabbitMqService } from './widgets-rabbitmq.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const OUTBOX_ID = '22222222-2222-4222-8222-222222222222';
const LOCK_TOKEN = '33333333-3333-4333-8333-333333333333';

const event = (overrides: Record<string, unknown> = {}) => ({
	id: OUTBOX_ID,
	messageId: EVENT_ID,
	deduplicationKey: 'reporting:wheel:widget-1:version:1',
	exchange: WidgetsOutboxExchange.EVENTS,
	eventType: 'widgets.widget.changed.v1',
	routingKey: 'widgets.widget.changed.v1',
	payload: {
		schemaVersion: 1,
		eventType: 'widgets.widget.changed.v1',
		eventId: EVENT_ID,
		aggregateId: 'wheel:widget-1',
		aggregateVersion: '1',
		sourceSequence: '1',
		occurredAt: '2026-08-04T12:00:00.000Z',
		tombstone: false,
		state: {
			id: 'widget-1',
			userId: 'user-1',
			widgetType: 'wheel',
			isActive: true,
			hasInstallDomain: true,
			createdAt: '2026-08-04T12:00:00.000Z'
		}
	},
	headers: { 'x-correlation-id': 'widget-1' },
	aggregateType: 'widgets.widget.wheel',
	aggregateId: 'wheel:widget-1',
	aggregateVersion: 1n,
	sourceSequence: 1n,
	status: WidgetsOutboxStatus.PUBLISHING,
	attempts: 0,
	availableAt: new Date('2026-08-04T12:00:00.000Z'),
	lockedAt: new Date('2026-08-04T12:00:00.000Z'),
	lockedBy: 'worker-1',
	lockToken: LOCK_TOKEN,
	leaseExpiresAt: new Date('2026-08-04T12:01:00.000Z'),
	publishedAt: null,
	lastError: null,
	createdAt: new Date('2026-08-04T12:00:00.000Z'),
	updatedAt: new Date('2026-08-04T12:00:00.000Z'),
	...overrides
});

const createFixture = () => {
	const prisma = {
		widgetsOutboxEvent: {
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		}
	} as unknown as WidgetsPrismaService;
	const rabbit = {
		publish: jest.fn().mockResolvedValue(undefined)
	} as unknown as WidgetsRabbitMqService;
	const runtime = {
		publisherEnabled: false
	} as WidgetsRuntimeService;
	const service = new WidgetsOutboxPublisherService(
		prisma,
		rabbit,
		runtime,
		new ConfigService()
	);
	return { service, prisma, rabbit };
};

const publish = (service: WidgetsOutboxPublisherService, value: unknown) =>
	(
		service as unknown as {
			publish(input: unknown): Promise<void>;
		}
	).publish(value);

describe('WidgetsOutboxPublisherService', () => {
	it('marks an event published only after confirmed mandatory publish', async () => {
		const fixture = createFixture();

		await publish(fixture.service, event());

		expect(fixture.rabbit.publish).toHaveBeenCalledWith(
			'winwidget.events',
			'widgets.widget.changed.v1',
			event().payload,
			expect.objectContaining({
				messageId: EVENT_ID,
				type: 'widgets.widget.changed.v1',
				headers: expect.objectContaining({
					'x-outbox-event-id': OUTBOX_ID,
					'x-publish-attempt': 1
				})
			})
		);
		expect(
			(fixture.rabbit.publish as jest.Mock).mock.invocationCallOrder[0]
		).toBeLessThan(
			(fixture.prisma.widgetsOutboxEvent.updateMany as jest.Mock).mock
				.invocationCallOrder[0]
		);
		expect(
			fixture.prisma.widgetsOutboxEvent.updateMany
		).toHaveBeenCalledWith({
			where: {
				id: OUTBOX_ID,
				status: WidgetsOutboxStatus.PUBLISHING,
				lockedBy: expect.any(String),
				lockToken: LOCK_TOKEN
			},
			data: expect.objectContaining({
				status: WidgetsOutboxStatus.PUBLISHED,
				attempts: { increment: 1 },
				publishedAt: expect.any(Date),
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				lastError: null
			})
		});
	});

	it('returns transport failures to PENDING without a terminal attempt cap', async () => {
		const fixture = createFixture();
		(fixture.rabbit.publish as jest.Mock).mockRejectedValueOnce(
			new Error('broker unavailable')
		);

		await publish(fixture.service, event({ attempts: 999 }));

		expect(
			fixture.prisma.widgetsOutboxEvent.updateMany
		).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: OUTBOX_ID,
				status: WidgetsOutboxStatus.PUBLISHING,
				lockToken: LOCK_TOKEN
			}),
			data: expect.objectContaining({
				status: WidgetsOutboxStatus.PENDING,
				attempts: 1000,
				availableAt: expect.any(Date),
				lastError: 'broker unavailable'
			})
		});
	});

	it('quarantines a malformed known event before RabbitMQ publication', async () => {
		const fixture = createFixture();

		await publish(
			fixture.service,
			event({
				payload: { eventType: 'widgets.widget.changed.v1' }
			})
		);

		expect(fixture.rabbit.publish).not.toHaveBeenCalled();
		expect(
			fixture.prisma.widgetsOutboxEvent.updateMany
		).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: OUTBOX_ID,
				status: WidgetsOutboxStatus.PUBLISHING,
				lockToken: LOCK_TOKEN
			}),
			data: expect.objectContaining({
				status: WidgetsOutboxStatus.QUARANTINED,
				attempts: { increment: 1 },
				lastError: expect.stringContaining('INVALID_OUTBOX_CONTRACT')
			})
		});
	});

	it('quarantines secret-bearing payloads without logging their values', async () => {
		const fixture = createFixture();

		await publish(
			fixture.service,
			event({
				payload: {
					...event().payload,
					credentials: { token: 'must-not-be-published' }
				}
			})
		);

		expect(fixture.rabbit.publish).not.toHaveBeenCalled();
		const call = (
			fixture.prisma.widgetsOutboxEvent.updateMany as jest.Mock
		).mock.calls[0][0];
		expect(call.data.lastError).toContain('forbidden field token');
		expect(call.data.lastError).not.toContain('must-not-be-published');
	});
});
