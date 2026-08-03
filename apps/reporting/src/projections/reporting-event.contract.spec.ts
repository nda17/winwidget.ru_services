import {
	InvalidReportingEventError,
	parseNotificationDeliveryOutcome,
	parseReportingConsumeMessage,
	parseReportingSourceEvent,
	reportingPayloadHash
} from './reporting-event.contract';

const identityEvent = {
	schemaVersion: 1,
	eventType: 'identity.user.changed.v1',
	eventId: '11111111-1111-4111-8111-111111111111',
	aggregateId: 'user-1',
	aggregateVersion: '2',
	sourceSequence: '10',
	occurredAt: '2026-07-31T00:00:00.000Z',
	tombstone: false,
	state: {
		id: 'user-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-31T00:00:00.000Z',
		deletedAt: null,
		status: 'ACTIVE',
		roles: ['USER'],
		hasEmailIdentity: true,
		hasPhoneIdentity: false,
		hasTelegramIdentity: false,
		loginMethodCount: 1
	}
};

describe('reporting source event contract', () => {
	it('accepts the exact minimal non-PII identity state', () => {
		expect(parseReportingSourceEvent(identityEvent)).toEqual(
			identityEvent
		);
	});

	it.each(['email', 'phone', 'ip', 'answers', 'name'])(
		'rejects forbidden or unversioned extra field %s',
		field => {
			expect(() =>
				parseReportingSourceEvent({
					...identityEvent,
					state: { ...identityEvent.state, [field]: 'secret' }
				})
			).toThrow(InvalidReportingEventError);
		}
	);

	it('requires null state for tombstones', () => {
		expect(() =>
			parseReportingSourceEvent({
				...identityEvent,
				tombstone: true
			})
		).toThrow('tombstone event state must be null');
	});

	it('rejects timestamp ordering keys and malformed decimal versions', () => {
		expect(() =>
			parseReportingSourceEvent({
				...identityEvent,
				aggregateVersion: '2026-07-31T00:00:00.000Z'
			})
		).toThrow('aggregateVersion');
	});

	it('rejects zero ordering keys for live events and allows paired zero only for snapshots', () => {
		const zero = {
			...identityEvent,
			aggregateVersion: '0',
			sourceSequence: '0'
		};
		expect(() => parseReportingSourceEvent(zero)).toThrow(
			'must both be positive'
		);
		expect(
			parseReportingSourceEvent(zero, undefined, {
				allowZeroVersion: true
			})
		).toEqual(zero);
		expect(() =>
			parseReportingSourceEvent(
				{ ...zero, sourceSequence: '1' },
				undefined,
				{ allowZeroVersion: true }
			)
		).toThrow('or both zero');
	});

	it.each([' 1 234,50 ', 'not-a-number', '001.50', '1e3'])(
		'accepts bounded historical payment amount %p for legacy normalization',
		amount => {
			expect(
				parseReportingSourceEvent({
					schemaVersion: 1,
					eventType: 'billing.payment.changed.v1',
					eventId: '77777777-7777-4777-8777-777777777777',
					aggregateId: 'payment-1',
					aggregateVersion: '1',
					sourceSequence: '9',
					occurredAt: '2026-07-31T00:00:00.000Z',
					tombstone: false,
					state: {
						id: 'payment-1',
						userId: 'user-1',
						amount,
						status: 'SUCCEEDED',
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-07-31T00:00:00.000Z'
					}
				})
			).toEqual(
				expect.objectContaining({
					eventType: 'billing.payment.changed.v1'
				})
			);
		}
	);

	it('rejects empty, control-bearing and oversized payment amounts', () => {
		for (const amount of ['', '  ', '1\n2', '1'.repeat(129)]) {
			expect(() =>
				parseReportingSourceEvent({
					schemaVersion: 1,
					eventType: 'billing.payment.changed.v1',
					eventId: '77777777-7777-4777-8777-777777777777',
					aggregateId: 'payment-1',
					aggregateVersion: '1',
					sourceSequence: '9',
					occurredAt: '2026-07-31T00:00:00.000Z',
					tombstone: false,
					state: {
						id: 'payment-1',
						userId: 'user-1',
						amount,
						status: 'SUCCEEDED',
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-07-31T00:00:00.000Z'
					}
				})
			).toThrow('state.amount');
		}
	});

	it('requires namespaced widget identities and accepts a state-less tombstone', () => {
		expect(
			parseReportingSourceEvent({
				schemaVersion: 1,
				eventType: 'widgets.lead.changed.v1',
				eventId: '33333333-3333-4333-8333-333333333333',
				aggregateId: 'quiz:raw-lead-id',
				aggregateVersion: '3',
				sourceSequence: '11',
				occurredAt: '2026-07-31T00:00:00.000Z',
				tombstone: true,
				state: null
			})
		).toEqual(
			expect.objectContaining({ aggregateId: 'quiz:raw-lead-id' })
		);
		expect(() =>
			parseReportingSourceEvent({
				schemaVersion: 1,
				eventType: 'widgets.lead.changed.v1',
				eventId: '44444444-4444-4444-8444-444444444444',
				aggregateId: 'raw-lead-id',
				aggregateVersion: '3',
				sourceSequence: '12',
				occurredAt: '2026-07-31T00:00:00.000Z',
				tombstone: true,
				state: null
			})
		).toThrow('namespaced');
	});

	it('requires the singleton aggregate for reporting settings, including tombstones', () => {
		for (const tombstone of [false, true]) {
			expect(() =>
				parseReportingSourceEvent({
					schemaVersion: 1,
					eventType: 'reporting.core-operational-routing.changed.v1',
					eventId: '99999999-9999-4999-8999-999999999999',
					aggregateId: 'other-settings',
					aggregateVersion: '1',
					sourceSequence: '14',
					occurredAt: '2026-07-31T00:00:00.000Z',
					tombstone,
					state: tombstone
						? null
						: {
								id: 'other-settings',
								coreOperationalAlertsDestinationChatId: '',
								coreOperationalAlertsThreadId: null
							}
				})
			).toThrow('aggregateId must equal singleton');
		}
	});

	it('accepts only the explicit post-cutover Core operational route', () => {
		const event = {
			schemaVersion: 1,
			eventType: 'reporting.core-operational-routing.changed.v1',
			eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			aggregateId: 'singleton',
			aggregateVersion: '1',
			sourceSequence: '15',
			occurredAt: '2026-07-31T00:00:00.000Z',
			tombstone: false,
			state: {
				id: 'singleton',
				coreOperationalAlertsDestinationChatId: '-100999',
				coreOperationalAlertsThreadId: 2024
			}
		};
		expect(parseReportingSourceEvent(event)).toEqual(event);
		expect(() =>
			parseReportingSourceEvent({
				...event,
				state: { ...event.state, destinationChatId: '-100legacy' }
			})
		).toThrow(InvalidReportingEventError);
	});

	it('rejects removed updatedAt from the exact minimal widget state', () => {
		expect(() =>
			parseReportingSourceEvent({
				schemaVersion: 1,
				eventType: 'widgets.widget.changed.v1',
				eventId: '88888888-8888-4888-8888-888888888888',
				aggregateId: 'wheel:widget-1',
				aggregateVersion: '1',
				sourceSequence: '13',
				occurredAt: '2026-07-31T00:00:00.000Z',
				tombstone: false,
				state: {
					id: 'widget-1',
					userId: 'user-1',
					widgetType: 'wheel',
					isActive: true,
					hasInstallDomain: true,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-07-31T00:00:00.000Z'
				}
			})
		).toThrow(InvalidReportingEventError);
	});

	it('uses a canonical payload hash independent of JSON object key order', () => {
		expect(reportingPayloadHash(identityEvent)).toBe(
			reportingPayloadHash({
				state: {
					loginMethodCount: 1,
					hasTelegramIdentity: false,
					hasPhoneIdentity: false,
					hasEmailIdentity: true,
					roles: ['USER'],
					status: 'ACTIVE',
					deletedAt: null,
					updatedAt: '2026-07-31T00:00:00.000Z',
					createdAt: '2026-01-01T00:00:00.000Z',
					id: 'user-1'
				},
				tombstone: false,
				occurredAt: '2026-07-31T00:00:00.000Z',
				sourceSequence: '10',
				aggregateVersion: '2',
				aggregateId: 'user-1',
				eventId: '11111111-1111-4111-8111-111111111111',
				eventType: 'identity.user.changed.v1',
				schemaVersion: 1
			})
		);
	});

	it('defaults absent retry headers but rejects malformed or out-of-range values', () => {
		const message = (headers: Record<string, unknown>) =>
			({
				content: Buffer.from(JSON.stringify(identityEvent)),
				properties: {
					messageId: identityEvent.eventId,
					type: identityEvent.eventType,
					headers
				}
			}) as never;

		expect(
			parseReportingConsumeMessage(message({}), 'identity.user.changed.v1')
		).toEqual(expect.objectContaining({ retryAttempt: 0, retryCycle: 0 }));
		for (const headers of [
			{ 'x-retry-attempt': '1' },
			{ 'x-retry-attempt': 4 },
			{ 'x-retry-cycle': -1 },
			{ 'x-retry-cycle': 1_000_001 }
		]) {
			expect(() =>
				parseReportingConsumeMessage(
					message(headers),
					'identity.user.changed.v1'
				)
			).toThrow(InvalidReportingEventError);
		}
	});
});

describe('notification delivery outcome contract', () => {
	it('accepts the self-contained daily-summary outcome', () => {
		const sourceEventId = '22222222-2222-4222-8222-222222222222';
		expect(
			parseNotificationDeliveryOutcome({
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId,
				sourceKind: 'daily-summary-delivery-telegram',
				reference: { type: 'daily-summary-job', id: sourceEventId },
				status: 'DELIVERED',
				failure: null,
				occurredAt: '2026-07-31T00:00:00.000Z'
			})
		).toEqual(expect.objectContaining({ status: 'DELIVERED' }));
	});

	it('accepts a shared subscription-expiry outcome for safe ignore', () => {
		expect(
			parseNotificationDeliveryOutcome({
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId: '55555555-5555-4555-8555-555555555555',
				sourceKind: 'subscription-expiry-email',
				reference: {
					type: 'subscription-expiry-reminder',
					id: '66666666-6666-4666-8666-666666666666'
				},
				status: 'DELIVERED',
				failure: null,
				occurredAt: '2026-07-31T00:00:00.000Z'
			})
		).toEqual(
			expect.objectContaining({ sourceKind: 'subscription-expiry-email' })
		);
	});
});
