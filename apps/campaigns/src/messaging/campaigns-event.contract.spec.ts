import {
	assertCampaignsPublishedEvent,
	parseCampaignsMessage
} from './campaigns-event.contract';
import {
	ADMIN_AUDIT_EVENT_TYPE,
	NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
} from './campaigns-messaging.constants';
import type { ConsumeMessage } from 'amqplib';

const EVENT_ID = '05a1256d-d21b-4c11-9193-f23f0e3648d9';
const SOURCE_EVENT_ID = '5ed5f057-bb9c-49e6-9b09-d14d622603dd';
const CAMPAIGN_ID = '1df14a11-3ccc-439d-a89d-cb32a555495d';
const DELIVERY_ID = 'fb406e22-bf71-4ad5-bc82-90be5ed74ef3';

function message(payload: unknown): ConsumeMessage {
	return {
		content: Buffer.from(JSON.stringify(payload)),
		fields: {
			consumerTag: 'test',
			deliveryTag: 1,
			redelivered: false,
			exchange: 'winwidget.events',
			routingKey: NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
		},
		properties: {
			contentType: 'application/json',
			contentEncoding: 'utf-8',
			headers: {},
			deliveryMode: 2,
			priority: undefined,
			correlationId: CAMPAIGN_ID,
			replyTo: undefined,
			expiration: undefined,
			messageId: EVENT_ID,
			timestamp: Date.now(),
			type: NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
			userId: undefined,
			appId: undefined,
			clusterId: undefined
		}
	};
}

function outcome() {
	return {
		schemaVersion: 2,
		eventType: NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
		eventId: EVENT_ID,
		occurredAt: '2026-07-30T12:00:00.000Z',
		correlationId: CAMPAIGN_ID,
		sourceEventId: SOURCE_EVENT_ID,
		sourceKind: 'campaign-email',
		campaignId: CAMPAIGN_ID,
		deliveryId: DELIVERY_ID,
		dispatchGeneration: 2,
		status: 'FAILED',
		failure: {
			normalizedCode: 'SMTP_REJECTED',
			safeReason: 'Provider rejected the message'
		}
	};
}

describe('campaigns event contract', () => {
	it('parses a strict delivery outcome v2', () => {
		const parsed = parseCampaignsMessage('outcome', message(outcome()));
		expect(parsed.eventId).toBe(EVENT_ID);
		expect(parsed.retryAttempt).toBe(0);
		expect(parsed.payload).toEqual(outcome());
	});

	it('rejects unknown keys', () => {
		const payload = { ...outcome(), destination: 'secret@example.com' };
		expect(() =>
			parseCampaignsMessage('outcome', message(payload))
		).toThrow('invalid keys');
	});

	it('rejects an AMQP identity mismatch', () => {
		const invalid = message(outcome());
		invalid.properties.messageId = '9b29f348-dcef-4c60-b789-88b44ef4af24';
		expect(() => parseCampaignsMessage('outcome', invalid)).toThrow(
			'messageId'
		);
	});

	it('accepts only safe exact audit metadata', () => {
		const payload = {
			schemaVersion: 1,
			eventType: ADMIN_AUDIT_EVENT_TYPE,
			eventId: EVENT_ID,
			occurredAt: '2026-07-30T12:00:00.000Z',
			correlationId: CAMPAIGN_ID,
			actorId: 'admin-id',
			action: 'CAMPAIGN_DELIVERY_RETRY',
			target: {
				campaignId: CAMPAIGN_ID,
				deliveryId: DELIVERY_ID
			},
			metadata: {
				channel: 'EMAIL',
				dispatchGeneration: 2
			}
		};
		expect(() =>
			assertCampaignsPublishedEvent(
				payload,
				ADMIN_AUDIT_EVENT_TYPE,
				EVENT_ID
			)
		).not.toThrow();
		expect(() =>
			assertCampaignsPublishedEvent(
				{
					...payload,
					metadata: {
						...payload.metadata,
						destination: 'secret@example.com'
					}
				},
				ADMIN_AUDIT_EVENT_TYPE,
				EVENT_ID
			)
		).toThrow('invalid keys');
	});
});
