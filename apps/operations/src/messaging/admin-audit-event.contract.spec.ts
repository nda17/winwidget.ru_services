import { parseAdminAuditEvent } from './admin-audit-event.contract';
import { OPERATIONS_AUDIT_SOURCES } from './operations-messaging.constants';

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
					widgetType: 'WHEEL',
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

	it('binds the legacy campaign producer to its exact current route', () => {
		expect(source('campaigns').routingKey).toBe('admin.audit.event.v1');
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
