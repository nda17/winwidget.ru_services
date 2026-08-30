import {
	InvalidReportingEventError,
	OPERATIONS_NOTIFICATION_ROUTING_EVENT_TYPE,
	reportingPayloadHash
} from '../projections/reporting-event.contract';
import { ReportingConsumerFailureFinalizerService } from './reporting-consumer-failure-finalizer.service';
import { ParsedReportingConsumeMessage } from './reporting-consumer-router.service';
import {
	REPORTING_DEAD_LETTER_EXCHANGE,
	getReportingDeadLetterRoutingKey,
	getReportingRetryRoutingKey
} from './reporting-messaging.constants';
import {
	ReportingConsumerFailureStatus,
	ReportingOutboxExchange,
	ReportingOutboxStatus
} from '@prisma/reporting-client';
import type { ConsumeMessage } from 'amqplib';
import { createHash } from 'node:crypto';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const LOCK_TOKEN = '22222222-2222-4222-8222-222222222222';
const CONSUMER = 'reporting-identity-user-v1';

const projectionPayload = {
	schemaVersion: 1 as const,
	eventType: 'identity.user.changed.v1' as const,
	eventId: EVENT_ID,
	aggregateId: 'user-1',
	aggregateVersion: '1',
	sourceSequence: '1',
	occurredAt: NOW.toISOString(),
	tombstone: false,
	state: {
		id: 'user-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: NOW.toISOString(),
		deletedAt: null,
		status: 'ACTIVE' as const,
		roles: ['USER' as const],
		hasEmailIdentity: true,
		hasPhoneIdentity: false,
		hasTelegramIdentity: false,
		loginMethodCount: 1
	}
};

function parsed(
	retryAttempt = 0,
	retryCycle = 0
): ParsedReportingConsumeMessage {
	return {
		eventId: EVENT_ID,
		eventType: projectionPayload.eventType,
		payload: projectionPayload,
		retryAttempt,
		retryCycle
	};
}

function message(input?: {
	messageId?: string;
	correlationId?: string;
	headerCorrelationId?: string;
	content?: Buffer;
}): ConsumeMessage {
	return {
		content:
			input?.content || Buffer.from(JSON.stringify(projectionPayload)),
		fields: {
			consumerTag: 'reporting-test',
			deliveryTag: 1,
			redelivered: false,
			exchange: 'winwidget.events',
			routingKey: projectionPayload.eventType
		},
		properties: {
			contentType: 'application/json',
			contentEncoding: 'utf-8',
			headers: input?.headerCorrelationId
				? { 'x-correlation-id': input.headerCorrelationId }
				: {},
			deliveryMode: 2,
			priority: undefined,
			correlationId: input?.correlationId,
			replyTo: undefined,
			expiration: undefined,
			messageId: input?.messageId ?? EVENT_ID,
			timestamp: Date.now(),
			type: projectionPayload.eventType,
			userId: undefined,
			appId: undefined,
			clusterId: undefined
		}
	};
}

function harness() {
	const transaction = {
		reportingOutboxEvent: {
			create: jest.fn().mockResolvedValue(undefined)
		},
		reportingConsumerFailure: {
			upsert: jest.fn().mockResolvedValue(undefined)
		}
	};
	const prisma = {
		$transaction: jest.fn(
			(callback: (value: typeof transaction) => Promise<void>) =>
				callback(transaction)
		)
	};
	const rabbitMq = { publish: jest.fn().mockResolvedValue(undefined) };
	const receipts = {
		transitionAfterFailure: jest.fn().mockResolvedValue(undefined)
	};
	const metrics = { increment: jest.fn() };
	const service = new ReportingConsumerFailureFinalizerService(
		prisma as never,
		rabbitMq as never,
		receipts as never,
		metrics as never
	);
	return { service, prisma, rabbitMq, receipts, metrics, transaction };
}

describe('ReportingConsumerFailureFinalizerService', () => {
	beforeEach(() => {
		jest.useFakeTimers().setSystemTime(NOW);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('schedules retry receipt and Outbox changes in one transaction', async () => {
		const { service, prisma, receipts, metrics, transaction } = harness();
		const consumed = message({
			headerCorrelationId: 'safe-header-correlation',
			correlationId: 'safe-property-correlation'
		});

		await service.finalize(
			'identityUser',
			parsed(0, 2),
			CONSUMER,
			LOCK_TOKEN,
			new Error('temporary failure'),
			consumed
		);

		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(receipts.transitionAfterFailure).toHaveBeenCalledWith(
			transaction,
			{
				eventId: EVENT_ID,
				consumer: CONSUMER,
				lockToken: LOCK_TOKEN,
				shouldRetry: true,
				nextAttempt: 1,
				errorMessage: 'temporary failure'
			}
		);
		expect(transaction.reportingOutboxEvent.create).toHaveBeenCalledWith({
			data: {
				messageId: EVENT_ID,
				deduplicationKey: `consumer-retry:${CONSUMER}:${EVENT_ID}:2:1`,
				exchange: ReportingOutboxExchange.RETRY,
				eventType: projectionPayload.eventType,
				routingKey: getReportingRetryRoutingKey('identityUser', 0),
				payload: projectionPayload,
				headers: {
					'x-correlation-id': 'safe-header-correlation',
					'x-causation-id': EVENT_ID,
					'x-retry-attempt': 1,
					'x-retry-cycle': 2,
					'x-last-error': 'temporary failure'
				},
				status: ReportingOutboxStatus.PENDING
			}
		});
		expect(
			transaction.reportingConsumerFailure.upsert
		).not.toHaveBeenCalled();
		expect(
			receipts.transitionAfterFailure.mock.invocationCallOrder[0]
		).toBeLessThan(
			transaction.reportingOutboxEvent.create.mock.invocationCallOrder[0]
		);
		expect(metrics.increment).toHaveBeenCalledWith(
			'consumer_retries_scheduled_total'
		);
	});

	it('keeps the exact retry attempt and deduplication key through attempt three', async () => {
		const { service, transaction } = harness();

		await service.finalize(
			'identityUser',
			parsed(2, 7),
			CONSUMER,
			LOCK_TOKEN,
			new Error('third retry'),
			message()
		);

		expect(transaction.reportingOutboxEvent.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					deduplicationKey: `consumer-retry:${CONSUMER}:${EVENT_ID}:7:3`,
					routingKey: getReportingRetryRoutingKey('identityUser', 2),
					headers: expect.objectContaining({
						'x-retry-attempt': 3,
						'x-retry-cycle': 7
					})
				})
			})
		);
	});

	it.each([
		{
			error: new Error('retry budget exhausted'),
			retryAttempt: 3
		},
		{
			error: new InvalidReportingEventError('projection conflict'),
			retryAttempt: 0
		}
	])(
		'dead-letters a terminal failure and persists its operator record',
		async ({ error, retryAttempt }) => {
			const { service, receipts, metrics, transaction } = harness();

			await service.finalize(
				'identityUser',
				parsed(retryAttempt, 4),
				CONSUMER,
				LOCK_TOKEN,
				error,
				message({ correlationId: 'property-correlation' })
			);

			expect(receipts.transitionAfterFailure).toHaveBeenCalledWith(
				transaction,
				expect.objectContaining({
					shouldRetry: false,
					nextAttempt: retryAttempt + 1
				})
			);
			expect(transaction.reportingOutboxEvent.create).toHaveBeenCalledWith(
				{
					data: expect.objectContaining({
						deduplicationKey: `consumer-dead-letter:${CONSUMER}:${EVENT_ID}:4`,
						exchange: ReportingOutboxExchange.DEAD_LETTER,
						routingKey: getReportingDeadLetterRoutingKey('identityUser'),
						headers: expect.objectContaining({
							'x-correlation-id': 'property-correlation',
							'x-retry-attempt': retryAttempt,
							'x-retry-cycle': 4
						}),
						status: ReportingOutboxStatus.PENDING
					})
				}
			);
			expect(
				transaction.reportingConsumerFailure.upsert
			).toHaveBeenCalledWith({
				where: {
					eventId_consumer: { eventId: EVENT_ID, consumer: CONSUMER }
				},
				create: {
					eventId: EVENT_ID,
					consumer: CONSUMER,
					consumerKind: 'identityUser',
					eventType: projectionPayload.eventType,
					payload: projectionPayload,
					payloadHash: reportingPayloadHash(projectionPayload),
					correlationId: 'property-correlation',
					status: ReportingConsumerFailureStatus.OPEN,
					manualRetryCount: 4,
					lastError: error.message
				},
				update: expect.objectContaining({
					consumerKind: 'identityUser',
					status: ReportingConsumerFailureStatus.OPEN,
					lastError: error.message,
					lastFailedAt: NOW,
					retryRequestedAt: null,
					resolvedAt: null
				})
			});
			expect(metrics.increment).toHaveBeenCalledWith(
				'consumer_dead_lettered_total'
			);
		}
	);

	it('preserves Operations aggregate headers on an automatic retry', async () => {
		const { service, transaction } = harness();
		const settingsPayload = {
			schemaVersion: 1 as const,
			eventId: EVENT_ID,
			operationalAlertsThreadId: 2024,
			changedAt: NOW.toISOString()
		};
		const settingsParsed: ParsedReportingConsumeMessage = {
			eventId: EVENT_ID,
			eventType: OPERATIONS_NOTIFICATION_ROUTING_EVENT_TYPE,
			payload: settingsPayload,
			retryAttempt: 0,
			retryCycle: 0
		};

		await service.finalize(
			'reportingSettings',
			settingsParsed,
			'reporting-settings-v1',
			LOCK_TOKEN,
			new Error('temporary routing failure'),
			message()
		);

		expect(transaction.reportingOutboxEvent.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					headers: expect.objectContaining({
						'x-aggregate-type': 'telegram-bot-settings',
						'x-aggregate-id': 'singleton'
					})
				})
			})
		);
	});

	it('does not emit a metric when the transactional finalization fails', async () => {
		const { service, prisma, metrics } = harness();
		prisma.$transaction.mockRejectedValue(new Error('transaction failed'));

		await expect(
			service.finalize(
				'identityUser',
				parsed(),
				CONSUMER,
				LOCK_TOKEN,
				new Error('temporary failure'),
				message()
			)
		).rejects.toThrow('transaction failed');
		expect(metrics.increment).not.toHaveBeenCalled();
	});

	it('publishes a metadata-only poison envelope without acknowledging the source', async () => {
		const { service, rabbitMq, metrics } = harness();
		const content = Buffer.from('{not-json');
		const consumed = message({
			content,
			headerCorrelationId: 'poison-header-correlation',
			correlationId: 'poison-property-correlation'
		});

		await service.publishPoison(
			'identityUser',
			consumed,
			new Error('invalid payload')
		);

		expect(rabbitMq.publish).toHaveBeenCalledWith(
			REPORTING_DEAD_LETTER_EXCHANGE,
			getReportingDeadLetterRoutingKey('identityUser'),
			{
				schemaVersion: 1,
				eventType: 'reporting.poison.v1',
				poisonId: EVENT_ID,
				sourceQueue: projectionPayload.eventType,
				contentSha256: createHash('sha256').update(content).digest('hex'),
				contentBytes: content.length,
				safeReason: 'invalid payload',
				occurredAt: NOW.toISOString()
			},
			{
				messageId: EVENT_ID,
				type: 'reporting.poison.v1',
				correlationId: 'poison-header-correlation',
				headers: { 'x-poison-message': true }
			}
		);
		expect(metrics.increment).toHaveBeenCalledWith(
			'consumer_poison_messages_total'
		);
		expect(rabbitMq).not.toHaveProperty('ack');
		expect(rabbitMq).not.toHaveProperty('nack');
	});

	it('generates a UUID and uses it as correlation fallback for poison without safe IDs', async () => {
		const { service, rabbitMq } = harness();

		await service.publishPoison(
			'identityUser',
			message({ messageId: 'invalid', correlationId: 'unsafe value' }),
			'invalid payload'
		);

		const [, , payload, options] = rabbitMq.publish.mock.calls[0];
		expect(payload.poisonId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);
		expect(options.messageId).toBe(payload.poisonId);
		expect(options.correlationId).toBe(payload.poisonId);
	});

	it('does not count poison before the confirmed publication succeeds', async () => {
		const { service, rabbitMq, metrics } = harness();
		rabbitMq.publish.mockRejectedValue(new Error('mandatory return'));

		await expect(
			service.publishPoison(
				'identityUser',
				message(),
				new Error('invalid payload')
			)
		).rejects.toThrow('mandatory return');
		expect(metrics.increment).not.toHaveBeenCalled();
	});
});
