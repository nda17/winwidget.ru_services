import {
	OPERATIONS_NOTIFICATION_ROUTING_EVENT_TYPE,
	REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
} from '../projections/reporting-event.contract';
import { ReportingConsumerRouterService } from './reporting-consumer-router.service';
import type { ConsumeMessage } from 'amqplib';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_EVENT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const LOCK_TOKEN = '44444444-4444-4444-8444-444444444444';

const projectionEvent = {
	schemaVersion: 1 as const,
	eventType: 'identity.user.changed.v1' as const,
	eventId: EVENT_ID,
	aggregateId: 'user-1',
	aggregateVersion: '1',
	sourceSequence: '1',
	occurredAt: '2026-08-30T12:00:00.000Z',
	tombstone: false,
	state: {
		id: 'user-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-08-30T12:00:00.000Z',
		deletedAt: null,
		status: 'ACTIVE' as const,
		roles: ['USER' as const],
		hasEmailIdentity: true,
		hasPhoneIdentity: false,
		hasTelegramIdentity: false,
		loginMethodCount: 1
	}
};

const settingsEvent = {
	schemaVersion: 1 as const,
	eventId: EVENT_ID,
	operationalAlertsThreadId: 2024,
	changedAt: '2026-08-30T12:00:00.000Z'
};

const outcomeEvent = {
	schemaVersion: 1 as const,
	eventType: REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	sourceEventId: SOURCE_EVENT_ID,
	sourceKind: 'daily-summary-delivery-telegram' as const,
	reference: { type: 'daily-summary-job' as const, id: RUN_ID },
	status: 'DELIVERED' as const,
	failure: null,
	occurredAt: '2026-08-30T12:00:00.000Z'
};

function message(input: {
	payload: unknown;
	eventType: string;
	messageId?: string;
	headers?: Record<string, unknown>;
}): ConsumeMessage {
	return {
		content: Buffer.from(JSON.stringify(input.payload)),
		fields: {
			consumerTag: 'reporting-test',
			deliveryTag: 1,
			redelivered: false,
			exchange: 'winwidget.events',
			routingKey: input.eventType
		},
		properties: {
			contentType: 'application/json',
			contentEncoding: 'utf-8',
			headers: input.headers || {},
			deliveryMode: 2,
			priority: undefined,
			correlationId: EVENT_ID,
			replyTo: undefined,
			expiration: undefined,
			messageId: input.messageId || EVENT_ID,
			timestamp: Date.now(),
			type: input.eventType,
			userId: undefined,
			appId: undefined,
			clusterId: undefined
		}
	};
}

describe('ReportingConsumerRouterService', () => {
	const projections = {
		applyEvent: jest.fn(),
		applyOperationsNotificationRouting: jest.fn()
	};
	const dailySummary = { applyOutcome: jest.fn() };
	let service: ReportingConsumerRouterService;

	beforeEach(() => {
		jest.clearAllMocks();
		projections.applyEvent.mockResolvedValue(undefined);
		projections.applyOperationsNotificationRouting.mockResolvedValue(
			undefined
		);
		dailySummary.applyOutcome.mockResolvedValue(undefined);
		service = new ReportingConsumerRouterService(
			projections as never,
			dailySummary as never
		);
	});

	it('parses a projection only through the exact consumer stream contract', () => {
		const projectionMessage = message({
			payload: projectionEvent,
			eventType: projectionEvent.eventType,
			headers: { 'x-retry-attempt': 2, 'x-retry-cycle': 3 }
		});

		expect(service.parse('identityUser', projectionMessage)).toEqual({
			eventId: EVENT_ID,
			eventType: projectionEvent.eventType,
			payload: projectionEvent,
			retryAttempt: 2,
			retryCycle: 3
		});
		expect(() =>
			service.parse('billingPayment', projectionMessage)
		).toThrow('expected payload eventType');
	});

	it('parses Operations routing only with its required aggregate headers', () => {
		const valid = message({
			payload: settingsEvent,
			eventType: OPERATIONS_NOTIFICATION_ROUTING_EVENT_TYPE,
			headers: {
				'x-aggregate-type': 'telegram-bot-settings',
				'x-aggregate-id': 'singleton'
			}
		});
		const invalid = message({
			payload: settingsEvent,
			eventType: OPERATIONS_NOTIFICATION_ROUTING_EVENT_TYPE
		});

		expect(service.parse('reportingSettings', valid).payload).toEqual(
			settingsEvent
		);
		expect(() => service.parse('reportingSettings', invalid)).toThrow(
			'aggregate headers'
		);
	});

	it('parses only the Reporting-owned daily-summary outcome contract', () => {
		const outcomeMessage = message({
			payload: outcomeEvent,
			eventType: REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
		});

		expect(service.parse('deliveryOutcome', outcomeMessage)).toEqual(
			expect.objectContaining({
				eventId: EVENT_ID,
				payload: outcomeEvent
			})
		);
		expect(() => service.parse('identityUser', outcomeMessage)).toThrow();
	});

	it('dispatches a projection with the unchanged receipt completion', async () => {
		const parsed = service.parse(
			'identityUser',
			message({
				payload: projectionEvent,
				eventType: projectionEvent.eventType
			})
		);
		const completion = {
			eventId: EVENT_ID,
			consumer: 'reporting-identity-user-v1',
			lockToken: LOCK_TOKEN
		};

		await service.dispatch('identityUser', parsed, completion);

		expect(projections.applyEvent).toHaveBeenCalledWith(
			projectionEvent,
			completion
		);
		expect(
			projections.applyOperationsNotificationRouting
		).not.toHaveBeenCalled();
		expect(dailySummary.applyOutcome).not.toHaveBeenCalled();
	});

	it('dispatches Operations routing with the unchanged receipt completion', async () => {
		const parsed = service.parse(
			'reportingSettings',
			message({
				payload: settingsEvent,
				eventType: OPERATIONS_NOTIFICATION_ROUTING_EVENT_TYPE,
				headers: {
					'x-aggregate-type': 'telegram-bot-settings',
					'x-aggregate-id': 'singleton'
				}
			})
		);
		const completion = {
			eventId: EVENT_ID,
			consumer: 'reporting-settings-v1',
			lockToken: LOCK_TOKEN
		};

		await service.dispatch('reportingSettings', parsed, completion);

		expect(
			projections.applyOperationsNotificationRouting
		).toHaveBeenCalledWith(settingsEvent, completion);
		expect(projections.applyEvent).not.toHaveBeenCalled();
		expect(dailySummary.applyOutcome).not.toHaveBeenCalled();
	});

	it('dispatches a delivery outcome using the AMQP eventId as outcomeEventId', async () => {
		const parsed = service.parse(
			'deliveryOutcome',
			message({
				payload: outcomeEvent,
				eventType: REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
			})
		);
		const completion = {
			eventId: EVENT_ID,
			consumer: 'reporting-delivery-outcome-v1',
			lockToken: LOCK_TOKEN
		};

		await service.dispatch('deliveryOutcome', parsed, completion);

		expect(dailySummary.applyOutcome).toHaveBeenCalledWith(
			outcomeEvent,
			EVENT_ID,
			completion
		);
		expect(projections.applyEvent).not.toHaveBeenCalled();
		expect(
			projections.applyOperationsNotificationRouting
		).not.toHaveBeenCalled();
	});
});
