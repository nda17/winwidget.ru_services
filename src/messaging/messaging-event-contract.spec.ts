import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';
import { AUTO_RENEWAL_CONSENT_TEXT } from '@/billing-boundary/billing-boundary.constants';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';

describe('messaging event contract', () => {
	it('accepts a complete lead integration event', () => {
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 2,
					eventType: 'lead.integration.requested.v2',
					integration: 'webhook',
					source: 'widget',
					entity: { id: 'widget-1', name: 'Колесо' },
					lead: {
						id: 'lead-1',
						createdAt: '2026-07-25T00:00:00.000Z',
						phone: '+79990000000'
					},
					destination: {
						credentialRef: '22222222-2222-4222-8222-222222222222'
					}
				},
				{
					eventType: 'lead.integration.requested.v2',
					routingKey: 'lead.integration.webhook.v2',
					messageId: MESSAGE_ID,
					kind: 'webhook'
				}
			)
		).not.toThrow();
	});

	it('rejects a routing key for another consumer', () => {
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 2,
					eventType: 'lead.limit.reached.email.v2',
					entity: { id: 'widget-1', name: 'Колесо', type: 'widget' },
					limit: 100,
					destination: { email: 'owner@example.com' }
				},
				{
					eventType: 'lead.limit.reached.email.v2',
					routingKey: 'lead.limit.reached.telegram.v2',
					messageId: MESSAGE_ID
				}
			)
		).toThrow('Routing key');
	});

	it('accepts the auto-renewal charge reference without payment secrets', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'payment.auto-renewal.charge.requested.v1',
			paymentId: 'payment-1',
			autoRenewalId: 'renewal-1',
			cycleKey: 'renewal-1:2026-08-28T09:00:00.000Z',
			scheduledFor: '2026-08-28T09:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'auto-renewal'
			})
		).not.toThrow();
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'webhook'
			})
		).toThrow('cannot be consumed by webhook');
	});

	it('rejects the removed legacy mailing contract', () => {
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 1,
					eventType: 'mailing.delivery.requested.v1',
					campaignId: '22222222-2222-4222-8222-222222222222',
					deliveryId: '33333333-3333-4333-8333-333333333333',
					channel: 'EMAIL'
				},
				{
					eventType: 'mailing.delivery.requested.v1',
					routingKey: 'mailing.delivery.email.v1',
					messageId: MESSAGE_ID
				}
			)
		).toThrow('Unsupported messaging event type');
	});

	it('accepts a strict Campaigns audit event without campaign content', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-07-30T12:00:00.000Z',
			correlationId: '22222222-2222-4222-8222-222222222222',
			actorId: 'admin-user-id',
			action: 'CAMPAIGN_CREATE',
			target: {
				campaignId: '33333333-3333-4333-8333-333333333333'
			},
			metadata: {
				channel: 'BOTH',
				audience: 'ACTIVE_SUBSCRIBERS'
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.event.v1',
				messageId: MESSAGE_ID,
				kind: 'campaign-admin-audit'
			})
		).not.toThrow();
	});

	it('rejects mismatched and content-bearing Campaigns audit events', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-07-30T12:00:00.000Z',
			correlationId: '22222222-2222-4222-8222-222222222222',
			actorId: 'admin-user-id',
			action: 'CAMPAIGN_CANCEL',
			target: {
				campaignId: '33333333-3333-4333-8333-333333333333'
			},
			metadata: {
				recipientCount: 42,
				subject: 'must not leave Campaigns'
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.event.v1',
				messageId: MESSAGE_ID,
				kind: 'campaign-admin-audit'
			})
		).toThrow('unexpected fields');
		expect(() =>
			assertMessagingEventContract(
				{
					...payload,
					metadata: { recipientCount: 42 }
				},
				{
					eventType: payload.eventType,
					routingKey: 'admin.audit.event.v1',
					messageId: '44444444-4444-4444-8444-444444444444',
					kind: 'campaign-admin-audit'
				}
			)
		).toThrow('eventId must match');
	});

	it('accepts the strict Reporting settings audit on its isolated route', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-07-31T12:00:00.000Z',
			correlationId: 'request:reporting-settings-42',
			actorId: 'admin-user-id',
			action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
			target: { reportingSettingsId: 'daily-summary' },
			metadata: {
				changedFields: ['destinationChatId', 'enabled', 'timezone']
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.reporting.v1',
				messageId: MESSAGE_ID,
				kind: 'reporting-admin-audit'
			})
		).not.toThrow();
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.event.v1',
				messageId: MESSAGE_ID,
				kind: 'reporting-admin-audit'
			})
		).toThrow('Routing key');
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.reporting.v1',
				messageId: MESSAGE_ID,
				kind: 'campaign-admin-audit'
			})
		).toThrow('cannot be consumed by campaign-admin-audit');
	});

	it('accepts a strict Identity audit with immutable user snapshots', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-08-14T12:00:00.000Z',
			correlationId: 'request:identity-user-update-42',
			actorId: 'admin-user-id',
			actorSnapshot: {
				name: 'Admin',
				email: 'admin@example.com'
			},
			section: 'USERS',
			action: 'USER_UPDATE',
			description: 'Обновлён пользователь',
			entity: {
				type: 'user',
				id: 'owner-1',
				label: 'owner-1',
				targetUserId: 'owner-1',
				targetSnapshot: {
					name: 'Owner',
					email: 'owner@example.com'
				}
			},
			metadata: {
				changedFields: ['name'],
				passwordChanged: false,
				requestIp: '203.0.113.8'
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.identity.v1',
				messageId: MESSAGE_ID,
				kind: 'identity-admin-audit'
			})
		).not.toThrow();
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.billing.v1',
				messageId: MESSAGE_ID,
				kind: 'identity-admin-audit'
			})
		).toThrow('Routing key');
	});

	it('rejects malformed or credential-bearing Identity audits', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-08-14T12:00:00.000Z',
			correlationId: 'request:identity-settings-42',
			actorId: 'admin-user-id',
			actorSnapshot: { name: null, email: null },
			section: 'SITE_SETTINGS',
			action: 'SITE_SETTINGS_UPDATE',
			description: 'Обновлены настройки авторизации',
			entity: {
				type: 'auth-settings',
				id: 'singleton',
				label: null,
				targetUserId: null,
				targetSnapshot: { name: null, email: null }
			},
			metadata: { changedFields: ['recaptchaEnabled'] }
		};
		const assertPayload = (value: unknown) =>
			assertMessagingEventContract(value, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.identity.v1',
				messageId: MESSAGE_ID,
				kind: 'identity-admin-audit'
			});

		expect(() => assertPayload(payload)).not.toThrow();
		expect(() =>
			assertPayload({
				...payload,
				action: 'IDENTITY_AUTH_SETTINGS_UPDATE'
			})
		).toThrow('payload.action is invalid');
		expect(() =>
			assertPayload({
				...payload,
				metadata: { token: 'must-not-cross-the-boundary' }
			})
		).toThrow('forbidden');
	});

	it('accepts the Identity-owned Info_bot webhook audit', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-08-14T12:00:00.000Z',
			correlationId: 'request:identity-info-webhook-42',
			actorId: 'admin-user-id',
			actorSnapshot: { name: 'Admin', email: 'admin@example.com' },
			section: 'TELEGRAM_BOT',
			action: 'TELEGRAM_BOT_WEBHOOK_REINSTALL',
			description: 'Переустановлен webhook Info_bot',
			entity: {
				type: 'telegram_webhook',
				id: 'info',
				label: 'Info_bot',
				targetUserId: null,
				targetSnapshot: { name: null, email: null }
			},
			metadata: {
				bot: 'info',
				title: 'Info_bot',
				dropPendingUpdates: true,
				allowedUpdates: ['message'],
				secretConfigured: true,
				installedAt: '2026-08-14T12:00:00.000Z'
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.identity.v1',
				messageId: MESSAGE_ID,
				kind: 'identity-admin-audit'
			})
		).not.toThrow();
	});

	it('accepts the Identity verification cleanup audit in TASKS', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-08-14T12:00:00.000Z',
			correlationId: 'request:identity-cleanup-42',
			actorId: 'admin-user-id',
			actorSnapshot: { name: 'Admin', email: 'admin@example.com' },
			section: 'TASKS',
			action: 'VERIFICATION_CHALLENGE_CLEANUP_RUN',
			description: 'Очистка verification challenges',
			entity: {
				type: 'manual_task',
				id: 'verificationChallengeCleanup',
				label: 'Очистка verification challenges',
				targetUserId: null,
				targetSnapshot: { name: null, email: null }
			},
			metadata: {
				taskId: 'verificationChallengeCleanup',
				title: 'Очистка verification challenges',
				affectedCount: 2,
				message: 'Удалено 2 просроченных verification challenge(s).',
				executedAt: '2026-08-14T12:00:00.000Z'
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.identity.v1',
				messageId: MESSAGE_ID,
				kind: 'identity-admin-audit'
			})
		).not.toThrow();
	});

	it('accepts only the scoped Identity messaging retry and close metadata', () => {
		const base = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-08-14T12:00:00.000Z',
			correlationId: 'request:identity-messaging-42',
			actorId: 'admin-user-id',
			actorSnapshot: { name: 'Admin', email: 'admin@example.com' },
			section: 'MESSAGING',
			description: 'Изменено состояние ошибки доставки',
			entity: {
				type: 'integration_delivery_failure',
				id: 'failure-id',
				label: 'telegram-destination-unavailable',
				targetUserId: null,
				targetSnapshot: { name: null, email: null }
			}
		};
		const assertPayload = (value: unknown) =>
			assertMessagingEventContract(value, {
				eventType: base.eventType,
				routingKey: 'admin.audit.identity.v1',
				messageId: MESSAGE_ID,
				kind: 'identity-admin-audit'
			});

		expect(() =>
			assertPayload({
				...base,
				action: 'MESSAGING_FAILURE_RETRY',
				metadata: {
					integration: 'telegram-destination-unavailable',
					requestId: 'request-id'
				}
			})
		).not.toThrow();
		expect(() =>
			assertPayload({
				...base,
				action: 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY',
				metadata: {
					integration: 'telegram-destination-unavailable',
					comment: 'Проверено вручную'
				}
			})
		).not.toThrow();
		expect(() =>
			assertPayload({
				...base,
				action: 'MESSAGING_FAILURE_RETRY',
				metadata: { integration: 'email' }
			})
		).toThrow('payload.metadata.integration is invalid');
		expect(() =>
			assertPayload({
				...base,
				action: 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY',
				metadata: {
					integration: 'telegram-destination-unavailable',
					comment: 'Проверено вручную',
					refreshTokenHash: 'must-not-cross-the-boundary'
				}
			})
		).toThrow('forbidden');
	});

	it('rejects Reporting audit values, PII, and unstable changedFields', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-07-31T12:00:00.000Z',
			correlationId: 'request.reporting-settings',
			actorId: 'admin-user-id',
			action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
			target: { reportingSettingsId: 'daily-summary' },
			metadata: { changedFields: ['enabled', 'timezone'] }
		};
		const assertPayload = (value: unknown) =>
			assertMessagingEventContract(value, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.reporting.v1',
				messageId: MESSAGE_ID,
				kind: 'reporting-admin-audit'
			});

		expect(() =>
			assertPayload({
				...payload,
				metadata: { changedFields: ['timezone', 'enabled'] }
			})
		).toThrow('sorted and unique');
		expect(() =>
			assertPayload({
				...payload,
				metadata: { changedFields: ['enabled', 'enabled'] }
			})
		).toThrow('sorted and unique');
		expect(() =>
			assertPayload({
				...payload,
				metadata: {
					changedFields: ['enabled'],
					destinationChatId: '-100123'
				}
			})
		).toThrow('unexpected fields');
		expect(() =>
			assertPayload({
				...payload,
				target: {
					reportingSettingsId: 'daily-summary',
					adminEmail: 'admin@example.com'
				}
			})
		).toThrow('unexpected fields');
		expect(() =>
			assertPayload({
				...payload,
				correlationId: 'contains spaces'
			})
		).toThrow('correlationId is invalid');
	});

	it('accepts a value-free Reporting delivery retry audit', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-07-31T12:00:00.000Z',
			correlationId: 'request:reporting-retry-42',
			actorId: 'dev-user-id',
			action: 'REPORTING_DELIVERY_RETRY',
			target: {
				eventId: '22222222-2222-4222-8222-222222222222',
				consumerKind: 'lead'
			},
			metadata: {}
		};
		const assertPayload = (value: unknown) =>
			assertMessagingEventContract(value, {
				eventType: payload.eventType,
				routingKey: 'admin.audit.reporting.v1',
				messageId: MESSAGE_ID,
				kind: 'reporting-admin-audit'
			});

		expect(() => assertPayload(payload)).not.toThrow();
		expect(() =>
			assertPayload({
				...payload,
				target: { ...payload.target, consumerKind: 'unknown' }
			})
		).toThrow('consumerKind is invalid');
		expect(() =>
			assertPayload({
				...payload,
				target: { ...payload.target, eventId: 'not-a-uuid' }
			})
		).toThrow('target.eventId must be a UUID');
		expect(() =>
			assertPayload({
				...payload,
				metadata: { payload: { contact: '+79990000000' } }
			})
		).toThrow('unexpected fields');
	});

	it.each([
		[
			'WIDGET_UPDATE',
			{ widgetId: 'widget-1', widgetType: 'WHEEL', ownerId: 'owner-1' },
			{ changedFields: ['config', 'name'] }
		],
		[
			'WIDGET_PUBLISH',
			{ widgetId: 'quiz-1', widgetType: 'QUIZ', ownerId: 'owner-1' },
			{ version: 2 }
		],
		[
			'WIDGET_DELIVERY_RETRY',
			{
				widgetId: 'callback-1',
				widgetType: 'CALLBACK',
				ownerId: 'owner-1',
				failureId: 'failure-1',
				integration: 'webhook'
			},
			{}
		],
		[
			'WIDGET_DELIVERY_CLOSE',
			{
				widgetId: 'calculator-1',
				widgetType: 'CALCULATOR',
				ownerId: 'owner-1',
				failureId: 'failure-2',
				integration: 'amo-crm'
			},
			{ commentPresent: true, commentLength: 28 }
		]
	] as const)(
		'accepts a strict %s Widgets audit event on its isolated route',
		(action, target, metadata) => {
			const payload = {
				schemaVersion: 1,
				eventType: 'admin.audit.event.v1',
				eventId: MESSAGE_ID,
				occurredAt: '2026-08-04T18:00:00.000Z',
				correlationId: 'request:widgets-audit-42',
				actorId: 'admin-user-id',
				action,
				target,
				metadata
			};

			expect(() =>
				assertMessagingEventContract(payload, {
					eventType: payload.eventType,
					routingKey: 'admin.audit.widgets.v1',
					messageId: MESSAGE_ID,
					kind: 'widgets-admin-audit'
				})
			).not.toThrow();
		}
	);

	it('rejects cross-routed, unstable or credential-bearing Widgets audits', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: MESSAGE_ID,
			occurredAt: '2026-08-04T18:00:00.000Z',
			correlationId: 'request:widgets-audit-42',
			actorId: 'admin-user-id',
			action: 'WIDGET_UPDATE',
			target: {
				widgetId: 'widget-1',
				widgetType: 'WHEEL',
				ownerId: 'owner-1'
			},
			metadata: { changedFields: ['config', 'name'] }
		};
		const assertPayload = (
			value: unknown,
			routingKey = 'admin.audit.widgets.v1'
		) =>
			assertMessagingEventContract(value, {
				eventType: payload.eventType,
				routingKey,
				messageId: MESSAGE_ID,
				kind: 'widgets-admin-audit'
			});

		expect(() => assertPayload(payload)).not.toThrow();
		expect(() =>
			assertPayload(payload, 'admin.audit.reporting.v1')
		).toThrow('Routing key');
		expect(() =>
			assertPayload({
				...payload,
				metadata: { changedFields: ['name', 'config'] }
			})
		).toThrow('sorted and unique');
		expect(() =>
			assertPayload({
				...payload,
				metadata: {
					changedFields: ['config'],
					token: 'must-not-cross-the-boundary'
				}
			})
		).toThrow('forbidden');
	});

	it('rejects server credentials anywhere in a payload', () => {
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 2,
					eventType: 'lead.integration.requested.v2',
					integration: 'webhook',
					source: 'widget',
					entity: { id: 'widget-1', name: 'Колесо' },
					lead: {
						id: 'lead-1',
						createdAt: '2026-07-25T00:00:00.000Z'
					},
					destination: {
						credentialRef: '22222222-2222-4222-8222-222222222222'
					},
					webhookUrl: 'https://example.com/secret'
				},
				{
					eventType: 'lead.integration.requested.v2',
					routingKey: 'lead.integration.webhook.v2',
					messageId: MESSAGE_ID
				}
			)
		).toThrow('forbidden');
	});

	it('rejects a scheduled event whose jobId differs from messageId', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId: MESSAGE_ID,
			jobType: 'DATABASE_BACKUP',
			scheduleKey: 'manual:test',
			periodStart: null,
			periodEnd: null
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: '22222222-2222-4222-8222-222222222222',
				kind: 'database-backup'
			})
		).toThrow('jobId must match');
	});

	it('accepts a scheduled event routed to its Outbox-backed dead letter', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId: MESSAGE_ID,
			jobType: 'DATABASE_BACKUP',
			scheduleKey: 'scheduled:test',
			periodStart: null,
			periodEnd: null
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'database-backup.dead-letter',
				messageId: MESSAGE_ID,
				kind: 'database-backup'
			})
		).not.toThrow();
	});

	it('accepts the dedicated notification-delivery database backup job type', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId: MESSAGE_ID,
			jobType: 'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
			scheduleKey: 'scheduled:test',
			periodStart: '2026-07-25T00:00:00.000Z',
			periodEnd: '2026-07-26T00:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'database-backup'
			})
		).not.toThrow();
	});

	it('accepts the dedicated Widgets database backup job type', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId: MESSAGE_ID,
			jobType: 'WIDGETS_DATABASE_BACKUP',
			scheduleKey: 'scheduled:test',
			periodStart: '2026-08-03T21:00:00.000Z',
			periodEnd: '2026-08-04T21:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'database-backup'
			})
		).not.toThrow();
	});

	it('rejects an unknown database backup job type', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId: MESSAGE_ID,
			jobType: 'UNKNOWN_DATABASE_BACKUP',
			scheduleKey: 'scheduled:test',
			periodStart: null,
			periodEnd: null
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'database-backup'
			})
		).toThrow('Invalid database backup job type');
	});

	it('rejects a backup period with only one boundary', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId: MESSAGE_ID,
			jobType: 'DATABASE_BACKUP',
			scheduleKey: 'scheduled:test',
			periodStart: '2026-07-25T00:00:00.000Z',
			periodEnd: null
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'database-backup'
			})
		).toThrow('must be null or dates together');
	});

	it('keeps payment.succeeded.v1 exclusive to payment email', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'payment.succeeded.v1',
			payment: {
				id: 'payment-1',
				yookassaId: 'yookassa-1',
				amount: '990.00',
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
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'payment.succeeded.v1',
				messageId: MESSAGE_ID,
				kind: 'payment-email'
			})
		).not.toThrow();
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'payment.succeeded.v1',
				messageId: MESSAGE_ID,
				kind: 'payment-telegram'
			})
		).toThrow('cannot be consumed by payment-telegram');
	});

	it('accepts the prepared payment Telegram contract with a nullable destination', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'payment.notification.telegram.requested.v1',
			payment: {
				id: 'payment-1',
				yookassaId: 'yookassa-1',
				amount: '990.00',
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
			destination: {
				telegramChatId: null,
				messageThreadId: null
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'payment.notification.telegram.requested.v1',
				messageId: MESSAGE_ID,
				kind: 'payment-telegram'
			})
		).not.toThrow();
	});

	it('rejects non-positive payment Telegram topic IDs', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'payment.notification.telegram.requested.v1',
			payment: {
				id: 'payment-1',
				yookassaId: 'yookassa-1',
				amount: '990.00',
				plan: 'EASY',
				billingPeriod: 'MONTHLY',
				succeededAt: '2026-07-25T00:00:00.000Z'
			},
			user: {
				id: 'user-1',
				name: null,
				email: null,
				phone: null
			},
			destination: {
				telegramChatId: '-100123',
				messageThreadId: 0
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'payment-telegram'
			})
		).toThrow('positive integer or null');
	});

	it('accepts the strict Telegram destination-unavailable outcome', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.telegram.destination-unavailable.v1',
			sourceEventId: '22222222-2222-4222-8222-222222222222',
			sourceKind: 'limit-telegram',
			destination: { telegramChatId: '123456789' },
			normalizedCode: 'TELEGRAM_BOT_BLOCKED',
			occurredAt: '2026-07-25T00:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'notification.telegram.destination-unavailable.v1',
				messageId: MESSAGE_ID,
				kind: 'telegram-destination-unavailable'
			})
		).not.toThrow();
	});

	it('accepts campaign Telegram as a destination-unavailable source', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.telegram.destination-unavailable.v1',
			sourceEventId: '22222222-2222-4222-8222-222222222222',
			sourceKind: 'campaign-telegram',
			destination: { telegramChatId: '123456789' },
			normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
			occurredAt: '2026-07-25T00:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'telegram-destination-unavailable'
			})
		).not.toThrow();
	});

	it('accepts a strict Notification Delivery outcome', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.delivery.outcome.v1',
			sourceEventId: '22222222-2222-4222-8222-222222222222',
			sourceKind: 'subscription-expiry-email',
			reference: {
				type: 'subscription-expiry-reminder',
				id: '33333333-3333-4333-8333-333333333333'
			},
			status: 'FAILED',
			failure: {
				normalizedCode: 'SMTP_REJECTED',
				safeReason: 'Mailbox rejected the message'
			},
			occurredAt: '2026-07-25T00:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'notification-delivery-outcome'
			})
		).not.toThrow();
	});

	it('rejects a delivery outcome owned by another service', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.delivery.outcome.v1',
			sourceEventId: '22222222-2222-4222-8222-222222222222',
			sourceKind: 'external-notification',
			reference: {
				type: 'external-job',
				id: '33333333-3333-4333-8333-333333333333'
			},
			status: 'DELIVERED',
			failure: null,
			occurredAt: '2026-08-03T22:50:14.915Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'notification-delivery-outcome'
			})
		).toThrow('payload.sourceKind is invalid');
	});

	it('rejects a Core outcome with a non-Core reference', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.delivery.outcome.v1',
			sourceEventId: '22222222-2222-4222-8222-222222222222',
			sourceKind: 'subscription-expiry-email',
			reference: {
				type: 'external-job',
				id: '33333333-3333-4333-8333-333333333333'
			},
			status: 'DELIVERED',
			failure: null,
			occurredAt: '2026-08-03T22:50:14.915Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'notification-delivery-outcome'
			})
		).toThrow(
			'payload.reference.type must be subscription-expiry-reminder'
		);
	});

	it('rejects unsupported source kinds in destination outcomes', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.telegram.destination-unavailable.v1',
			sourceEventId: '22222222-2222-4222-8222-222222222222',
			sourceKind: 'payment-telegram',
			destination: { telegramChatId: '123456789' },
			normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
			occurredAt: '2026-07-25T00:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'telegram-destination-unavailable'
			})
		).toThrow('sourceKind is invalid');
	});

	it('accepts the exact Billing offer source event', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'billing.offer.changed.v1',
			eventId: MESSAGE_ID,
			aggregateId: 'offer',
			aggregateVersion: '3',
			sourceSequence: '42',
			occurredAt: '2026-08-11T00:00:00.000Z',
			tombstone: false,
			state: {
				id: 'offer',
				content: '<p>offer</p>',
				sha256:
					'8efd4197e25b4f2a1f14e87d137f544cbbf52ccff37595a3024a4a65255c27d9',
				updatedAt: '2026-08-11T00:00:00.000Z',
				consentVersion: 'auto-renewal-2026-07-28-v4',
				consentText: AUTO_RENEWAL_CONSENT_TEXT
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'billing-offer-source'
			})
		).not.toThrow();
	});

	it('rejects Billing offer consent drift', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'billing.offer.changed.v1',
			eventId: MESSAGE_ID,
			aggregateId: 'offer',
			aggregateVersion: '1',
			sourceSequence: '1',
			occurredAt: '2026-08-11T00:00:00.000Z',
			tombstone: false,
			state: {
				id: 'offer',
				content: '',
				sha256: '0'.repeat(64),
				updatedAt: '2026-08-11T00:00:00.000Z',
				consentVersion: 'auto-renewal-2026-07-28-v4',
				consentText: 'stale'
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'billing-offer-source'
			})
		).toThrow('Invalid Billing offer consent contract');
	});

	it('accepts a Billing offer tombstone', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'billing.offer.changed.v1',
			eventId: MESSAGE_ID,
			aggregateId: 'offer',
			aggregateVersion: '2',
			sourceSequence: '2',
			occurredAt: '2026-08-11T00:00:00.000Z',
			tombstone: true,
			state: null
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'billing-offer-source'
			})
		).not.toThrow();
	});

	it('rejects routing a Billing offer event to another source kind', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'billing.offer.changed.v1',
			eventId: MESSAGE_ID,
			aggregateId: 'offer',
			aggregateVersion: '2',
			sourceSequence: '2',
			occurredAt: '2026-08-11T00:00:00.000Z',
			tombstone: true,
			state: null
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'billing-settings-source'
			})
		).toThrow(
			'Event type billing.offer.changed.v1 cannot be consumed by billing-settings-source'
		);
	});
});
