import { ConfigService } from '@nestjs/config';
import { WidgetsOutboxExchange } from '@prisma/widgets-client';
import type { ConsumeMessage } from 'amqplib';
import type { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import type { ParsedWidgetsProjectionMessage } from '../projections/widgets-projection.contract';
import type { WidgetsProjectionService } from '../projections/widgets-projection.service';
import type { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';
import { WidgetsProjectionWorkerService } from './widgets-projection-worker.service';
import type { WidgetsRabbitMqService } from './widgets-rabbitmq.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const AVAILABLE_AT = new Date('2099-08-04T12:05:00.000Z');

const parsed: ParsedWidgetsProjectionMessage = {
	event: {
		schemaVersion: 1,
		eventType: 'identity.user.changed.v1',
		eventId: EVENT_ID,
		aggregateId: 'user-1',
		aggregateVersion: '1',
		sourceSequence: '1',
		occurredAt: '2026-08-04T12:00:00.000Z',
		tombstone: false,
		state: {
			id: 'user-1',
			createdAt: '2026-08-04T12:00:00.000Z',
			updatedAt: '2026-08-04T12:00:00.000Z',
			deletedAt: null,
			status: 'ACTIVE',
			roles: ['USER'],
			hasEmailIdentity: true,
			hasPhoneIdentity: false,
			hasTelegramIdentity: false,
			loginMethodCount: 1
		}
	},
	retryAttempt: 0,
	manualRetryCycle: 0
};

const message = {
	properties: {
		correlationId: undefined,
		headers: { 'x-correlation-id': 'projection-correlation-1' }
	}
} as unknown as ConsumeMessage;

describe('WidgetsProjectionWorkerService', () => {
	it('routes active projection recovery through the service-local manual exchange', async () => {
		const create = jest.fn().mockResolvedValue(undefined);
		const prisma = {
			widgetsOutboxEvent: { create }
		} as unknown as WidgetsPrismaService;
		const service = new WidgetsProjectionWorkerService(
			{} as WidgetsRabbitMqService,
			prisma,
			{} as WidgetsProjectionService,
			{ workerEnabled: false } as WidgetsRuntimeService,
			new ConfigService()
		);

		await (
			service as unknown as {
				deferActive(
					kind: 'identity',
					value: ParsedWidgetsProjectionMessage,
					consumer: string,
					availableAt: Date,
					message: ConsumeMessage
				): Promise<void>;
			}
		).deferActive(
			'identity',
			parsed,
			'widgets-owner-projection-v1',
			AVAILABLE_AT,
			message
		);

		expect(create).toHaveBeenCalledWith({
			data: {
				messageId: EVENT_ID,
				deduplicationKey:
					'projection-active-recovery:widgets-owner-projection-v1:11111111-1111-4111-8111-111111111111:0:2099-08-04T12:05:00.000Z',
				exchange: WidgetsOutboxExchange.MANUAL_RETRY,
				eventType: 'identity.user.changed.v1',
				routingKey: 'identity.manual-retry',
				payload: parsed.event,
				headers: {
					'x-correlation-id': 'projection-correlation-1',
					'x-retry-attempt': 0,
					'x-manual-retry-cycle': 0,
					'x-lease-recovery': true
				},
				availableAt: AVAILABLE_AT
			}
		});
	});
});
