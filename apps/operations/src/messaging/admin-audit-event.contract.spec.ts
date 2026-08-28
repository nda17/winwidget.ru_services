import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAdminAuditEvent } from './admin-audit-event.contract';
import { OPERATIONS_AUDIT_SOURCES } from './operations-messaging.constants';

const onlineConsultantAuditCleanupMigration = readFileSync(
	resolve(
		__dirname,
		'../../prisma/migrations/20260827230000_remove_online_consultant_audit_data/migration.sql'
	),
	'utf8'
);

describe('admin audit event contract', () => {
	const eventId = '3ad36f14-550c-47bd-8f69-2c913cdb83ee';
	const correlationId = '68165343-a387-4dc1-b875-e511c3038c67';
	const campaignId = 'f222744f-6e95-4da7-a9b9-e1cc6ed067c9';
	const source = (name: string) =>
		OPERATIONS_AUDIT_SOURCES.find(item => item.source === name)!;
	const common = {
		schemaVersion: 1,
		eventType: 'admin.audit.event.v1',
		eventId,
		occurredAt: '2026-08-24T00:00:00.000Z',
		correlationId,
		actorId: 'admin-1'
	};
	const unknownProviderResolution = (
		overrides: {
			section?: string;
			entity?: Record<string, unknown>;
			metadata?: Record<string, unknown>;
		} = {}
	) => ({
		...common,
		section: overrides.section ?? 'PAYMENTS',
		action: 'PAYMENT_UNKNOWN_PROVIDER_RESOLVED',
		description: 'Платёж с неизвестным provider ID разрешён вручную',
		entity: {
			type: 'payment',
			id: 'payment-1',
			label: 'payment-1',
			targetUserId: 'user-1',
			...overrides.entity
		},
		metadata: {
			paymentId: 'payment-1',
			commandId: 'c7de40a7-b401-41d5-92ef-2c437180e201',
			resolution: 'PROVIDER_PAYMENT_NOT_FOUND',
			reason: 'Provider payment was not found after manual reconciliation',
			previousStatus: 'PENDING',
			previousProviderStatus: 'creating',
			finalStatus: 'CANCELLED',
			finalProviderStatus: 'not_found',
			providerOperationId: 'operation-1',
			checkedMetadataPaymentId: 'payment-1',
			providerIdempotencyKeySha256: 'a'.repeat(64),
			providerReconciliationConfirmed: true,
			resolvedAt: '2026-08-24T00:00:00.000Z',
			actorRole: 'DEV',
			requestIp: '203.0.113.7',
			requestUserAgent: 'billing-resolution-test',
			...overrides.metadata
		}
	});

	it('normalizes the existing campaign event into the journal contract', () => {
		const result = parseAdminAuditEvent(source('campaigns'), {
			...common,
			action: 'CAMPAIGN_CREATE',
			target: { campaignId },
			metadata: { channel: 'EMAIL', audience: 'ALL' }
		});
		expect(result).toEqual({
			eventId,
			record: expect.objectContaining({
				id: eventId,
				section: 'CAMPAIGNS',
				action: 'CAMPAIGN_CREATE',
				entityId: campaignId
			})
		});
	});

	it('preserves Identity actor and target snapshots', () => {
		const result = parseAdminAuditEvent(source('identity'), {
			...common,
			actorSnapshot: { name: 'Admin', email: 'admin@example.test' },
			section: 'USERS',
			action: 'USER_UPDATE',
			description: 'Пользователь обновлён',
			entity: {
				type: 'user',
				id: 'user-1',
				label: 'User',
				targetUserId: 'user-1',
				targetSnapshot: {
					name: 'User',
					email: 'user@example.test'
				}
			},
			metadata: {
				changedFields: ['name'],
				passwordChanged: false
			}
		});
		expect(result.record).toEqual(
			expect.objectContaining({
				adminName: 'Admin',
				adminEmail: 'admin@example.test',
				targetUserName: 'User',
				targetUserEmail: 'user@example.test'
			})
		);
	});

	it('accepts the audited Support event contract on its dedicated source', () => {
		const result = parseAdminAuditEvent(source('support'), {
			...common,
			section: 'SUPPORT',
			action: 'SUPPORT_ROUTING_SETTINGS_UPDATE',
			description: 'Настройки маршрутизации поддержки обновлены',
			entity: {
				type: 'support_routing_settings',
				id: 'singleton',
				label: null,
				targetUserId: null
			},
			metadata: {
				adminChatIdConfigured: true,
				supportThreadIdConfigured: true,
				aggregateVersion: '1',
				actorRole: 'DEV',
				requestIp: '127.0.0.1',
				requestUserAgent: 'jest'
			}
		});
		expect(result.record).toEqual(
			expect.objectContaining({
				id: eventId,
				section: 'SUPPORT',
				action: 'SUPPORT_ROUTING_SETTINGS_UPDATE'
			})
		);
	});

	it.each([
		{
			entity: {
				type: 'support_delivery_failure',
				id: 'not-a-uuid',
				label: null,
				targetUserId: null
			}
		},
		{
			entity: {
				type: 'support_delivery_failure',
				id: '00000000-0000-4000-8000-000000000099',
				label: null,
				targetUserId: 'unexpected-user'
			}
		}
	])(
		'rejects Support delivery events outside the exact producer contract',
		fixture => {
			expect(() =>
				parseAdminAuditEvent(source('support'), {
					...common,
					section: 'SUPPORT',
					action: 'SUPPORT_DELIVERY_CLOSE',
					description: 'Support delivery закрыта',
					entity: fixture.entity,
					metadata: {
						eventId: '00000000-0000-4000-8000-000000000098',
						actorRole: 'DEV',
						requestIp: '127.0.0.1',
						requestUserAgent: 'jest'
					}
				})
			).toThrow();
		}
	);

	it.each([
		{
			source: 'reporting',
			payload: {
				...common,
				action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
				target: { reportingSettingsId: 'daily-summary' },
				metadata: { changedFields: ['enabled', 'timezone'] }
			},
			section: 'REPORTING'
		},
		{
			source: 'widgets',
			payload: {
				...common,
				action: 'WIDGET_PUBLISH',
				target: {
					widgetId: 'widget-1',
					widgetType: 'AI_CONSULTANT',
					ownerId: 'owner-1'
				},
				metadata: { version: 2 }
			},
			section: 'WIDGETS'
		},
		{
			source: 'billing',
			payload: {
				...common,
				section: 'PAYMENTS',
				action: 'PAYMENT_MANUAL_CHECK',
				description: 'Платёж проверен',
				entity: {
					type: 'payment',
					id: 'payment-1',
					label: null,
					targetUserId: 'user-1'
				},
				metadata: {}
			},
			section: 'PAYMENTS'
		}
	])('normalizes the $source source contract', fixture => {
		const result = parseAdminAuditEvent(
			source(fixture.source),
			fixture.payload
		);
		expect(result.record).toEqual(
			expect.objectContaining({ id: eventId, section: fixture.section })
		);
	});

	it('rejects the removed online consultant widget type', () => {
		expect(() =>
			parseAdminAuditEvent(source('widgets'), {
				...common,
				action: 'WIDGET_PUBLISH',
				target: {
					widgetId: 'widget-1',
					widgetType: 'ONLINE_CONSULTANT',
					ownerId: 'owner-1'
				},
				metadata: { version: 2 }
			})
		).toThrow('Widget audit type is invalid');
	});

	it('removes only persisted audit data for the retired widget type', () => {
		expect(onlineConsultantAuditCleanupMigration.trimStart()).toMatch(
			/^BEGIN;/
		);
		expect(onlineConsultantAuditCleanupMigration.trimEnd()).toMatch(
			/COMMIT;$/
		);
		expect(onlineConsultantAuditCleanupMigration).not.toMatch(
			/\bCREATE\s+(?:LOCAL\s+|GLOBAL\s+)?TEMP(?:ORARY)?\s+TABLE\b/i
		);
		expect(onlineConsultantAuditCleanupMigration).toContain(
			'CREATE TABLE "operations"."retired_online_consultant_audit_events"'
		);
		expect(onlineConsultantAuditCleanupMigration).toContain(
			"\"entity_label\" IN ('ONLINE_CONSULTANT', 'Онлайн-консультант')"
		);
		expect(onlineConsultantAuditCleanupMigration).toContain(
			"\"metadata\" ->> 'widgetType' = 'ONLINE_CONSULTANT'"
		);
		expect(onlineConsultantAuditCleanupMigration).toContain(
			'"dead_letter_payload" #>> \'{payload,target,widgetType}\''
		);
		expect(onlineConsultantAuditCleanupMigration).toContain(
			'"aggregate_type" = \'operations.admin-audit-retry\''
		);
		expect(
			onlineConsultantAuditCleanupMigration.indexOf(
				'DROP TABLE "operations"."retired_online_consultant_audit_events"'
			)
		).toBeGreaterThan(
			onlineConsultantAuditCleanupMigration.indexOf(
				'DELETE FROM "operations"."admin_event_logs"'
			)
		);
	});

	it('binds the legacy campaign producer to its exact current route', () => {
		expect(source('campaigns').routingKey).toBe('admin.audit.event.v1');
	});

	it('accepts the Billing unknown-provider resolution audit action', () => {
		const result = parseAdminAuditEvent(
			source('billing'),
			unknownProviderResolution()
		);

		expect(result.record).toEqual(
			expect.objectContaining({
				section: 'PAYMENTS',
				action: 'PAYMENT_UNKNOWN_PROVIDER_RESOLVED',
				entityId: 'payment-1',
				targetUserId: 'user-1',
				ip: '203.0.113.7',
				userAgent: 'billing-resolution-test'
			})
		);
	});

	it.each([
		[
			'non-Billing source',
			() =>
				parseAdminAuditEvent(
					source('campaigns'),
					unknownProviderResolution()
				)
		],
		[
			'wrong section',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({ section: 'SUBSCRIPTIONS' })
				)
		],
		[
			'wrong entity type',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({
						entity: { type: 'subscription' }
					})
				)
		],
		[
			'non-DEV actor',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({ metadata: { actorRole: 'ADMIN' } })
				)
		],
		[
			'invalid command UUID',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({ metadata: { commandId: 'invalid' } })
				)
		],
		[
			'unsupported resolution',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({
						metadata: { resolution: 'SUCCEEDED' }
					})
				)
		],
		[
			'non-final payment status',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({
						metadata: { finalStatus: 'SUCCEEDED' }
					})
				)
		],
		[
			'non-final provider status',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({
						metadata: { finalProviderStatus: 'unknown' }
					})
				)
		],
		[
			'missing reconciliation confirmation',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({
						metadata: { providerReconciliationConfirmed: false }
					})
				)
		],
		[
			'mismatched metadata payment ID',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({
						metadata: { checkedMetadataPaymentId: 'payment-2' }
					})
				)
		],
		[
			'invalid provider key hash',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({
						metadata: { providerIdempotencyKeySha256: 'A'.repeat(64) }
					})
				)
		],
		[
			'extra metadata',
			() =>
				parseAdminAuditEvent(
					source('billing'),
					unknownProviderResolution({
						metadata: { unexpected: true }
					})
				)
		]
	])('rejects unknown-provider audit with %s', (_case, parse) => {
		expect(parse).toThrow();
	});

	it('rejects a valid payload on the wrong source route', () => {
		expect(() =>
			parseAdminAuditEvent(source('billing'), {
				...common,
				section: 'PLATFORM_CONTENT',
				action: 'PLATFORM_SITE_SETTINGS_UPDATE',
				description: 'Настройки обновлены',
				entity: {
					type: 'site_settings',
					id: 'singleton',
					label: null,
					targetUserId: null
				},
				metadata: {}
			})
		).toThrow('Structured admin audit action is invalid');
	});

	it('rejects legacy or extra payload keys', () => {
		expect(() =>
			parseAdminAuditEvent(source('campaigns'), {
				...common,
				action: 'CAMPAIGN_CREATE',
				target: { campaignId },
				metadata: {},
				legacyAction: 'DATABASE_BACKUP'
			})
		).toThrow('Admin audit object keys are invalid');
	});
});
