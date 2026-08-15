import { Role, UserStatus } from '@prisma/identity-client';
import {
	auditMetadata,
	IdentityEventsService,
	publicUser
} from './identity-events.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CREATED_AT = new Date('2026-08-14T10:00:00.000Z');

describe('Identity event parity', () => {
	it('locks the aggregate before reading state and emits exact legacy payloads', async () => {
		const query = jest
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ lastValue: 101n }])
			.mockResolvedValueOnce([{ version: 7n, sourceSequence: 101n }])
			.mockResolvedValueOnce([{ lastValue: 202n }])
			.mockResolvedValueOnce([{ version: 4n, sourceSequence: 202n }]);
		const findUnique = jest.fn().mockResolvedValue({
			id: USER_ID,
			name: 'User',
			password: 'hash',
			avatarPath: null,
			status: UserStatus.ACTIVE,
			personalDataConsentRevokedAt: null,
			deletedAt: null,
			rights: [Role.DEV, Role.USER, Role.DEV],
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
			authIdentities: [
				{ type: 'YANDEX', value: 'ya-id', verifiedAt: CREATED_AT },
				{ type: 'PHONE', value: '+79991234567', verifiedAt: null },
				{
					type: 'EMAIL',
					value: 'user@example.com',
					verifiedAt: CREATED_AT
				},
				{ type: 'TELEGRAM', value: '777', verifiedAt: CREATED_AT }
			],
			telegramNotificationChannel: {
				chatId: '777',
				isActive: true
			}
		});
		const create = jest.fn();
		const transaction = {
			$queryRaw: query,
			user: { findUnique },
			outboxEvent: { create }
		};
		await new IdentityEventsService().emitUserChanged(
			transaction as any,
			USER_ID,
			'correlation-id'
		);
		expect(query.mock.invocationCallOrder[0]).toBeLessThan(
			findUnique.mock.invocationCallOrder[0]!
		);
		expect(create).toHaveBeenCalledTimes(2);

		const identityPayload = create.mock.calls[0]?.[0].data.payload;
		expect(Object.keys(identityPayload).sort()).toEqual(
			[
				'aggregateId',
				'aggregateVersion',
				'eventId',
				'eventType',
				'occurredAt',
				'schemaVersion',
				'sourceSequence',
				'state',
				'tombstone'
			].sort()
		);
		expect(identityPayload).toMatchObject({
			schemaVersion: 1,
			eventType: 'identity.user.changed.v1',
			aggregateId: USER_ID,
			aggregateVersion: '7',
			sourceSequence: '101',
			tombstone: false,
			state: {
				id: USER_ID,
				status: UserStatus.ACTIVE,
				deletedAt: null,
				roles: [Role.DEV, Role.USER],
				hasEmailIdentity: true,
				hasPhoneIdentity: true,
				hasTelegramIdentity: true,
				loginMethodCount: 2,
				createdAt: CREATED_AT.toISOString(),
				updatedAt: CREATED_AT.toISOString()
			}
		});
		expect(Object.keys(identityPayload.state).sort()).toEqual(
			[
				'id',
				'status',
				'deletedAt',
				'roles',
				'hasEmailIdentity',
				'hasPhoneIdentity',
				'hasTelegramIdentity',
				'loginMethodCount',
				'createdAt',
				'updatedAt'
			].sort()
		);

		const billingPayload = create.mock.calls[1]?.[0].data.payload;
		expect(billingPayload).toMatchObject({
			schemaVersion: 1,
			eventType: 'billing.identity.changed.v1',
			aggregateVersion: '4',
			sourceSequence: '202',
			tombstone: false,
			state: {
				id: USER_ID,
				name: 'User',
				email: 'user@example.com',
				phone: '+79991234567',
				status: UserStatus.ACTIVE,
				deletedAt: null,
				roles: [Role.DEV, Role.USER],
				telegramChatId: '777',
				telegramChannelActive: true,
				createdAt: CREATED_AT.toISOString(),
				updatedAt: CREATED_AT.toISOString()
			}
		});
		expect(Object.keys(billingPayload.state).sort()).toEqual(
			[
				'id',
				'name',
				'email',
				'phone',
				'status',
				'deletedAt',
				'roles',
				'telegramChatId',
				'telegramChannelActive',
				'createdAt',
				'updatedAt'
			].sort()
		);
	});

	it('uses the frozen public login-method order and PHONE verification rule', () => {
		const result = publicUser({
			id: USER_ID,
			name: 'User',
			avatarPath: null,
			status: UserStatus.ACTIVE,
			personalDataConsentRevokedAt: null,
			deletedAt: null,
			rights: [Role.USER],
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
			authIdentities: [
				{ type: 'TELEGRAM', value: '7', verifiedAt: CREATED_AT },
				{ type: 'VK', value: 'vk', verifiedAt: CREATED_AT },
				{ type: 'PHONE', value: '+79991234567', verifiedAt: null },
				{
					type: 'EMAIL',
					value: 'user@example.com',
					verifiedAt: CREATED_AT
				},
				{ type: 'GOOGLE', value: 'google', verifiedAt: CREATED_AT }
			]
		});
		expect(result.loginMethods).toEqual([
			'EMAIL',
			'GOOGLE',
			'VK',
			'TELEGRAM'
		]);
		expect(result).toHaveProperty('deletedAt', null);
		expect(result).toHaveProperty('personalDataConsentRevokedAt', null);
	});
});

describe('Identity audit metadata', () => {
	it('accepts only the action-specific safe shape', () => {
		expect(
			auditMetadata('USER_UPDATE', {
				changedFields: ['name'],
				passwordChanged: false
			})
		).toEqual({ changedFields: ['name'], passwordChanged: false });
	});

	it('accepts webhook audit metadata without provider URLs or secrets', () => {
		expect(
			auditMetadata('TELEGRAM_BOT_WEBHOOK_REINSTALL', {
				bot: 'info',
				title: 'Info_bot',
				dropPendingUpdates: true,
				allowedUpdates: ['message'],
				secretConfigured: true,
				installedAt: '2026-08-14T12:00:00.000Z'
			})
		).toEqual({
			bot: 'info',
			title: 'Info_bot',
			dropPendingUpdates: true,
			allowedUpdates: ['message'],
			secretConfigured: true,
			installedAt: '2026-08-14T12:00:00.000Z'
		});
		expect(() =>
			auditMetadata('TELEGRAM_BOT_WEBHOOK_REINSTALL', {
				bot: 'info',
				title: 'Info_bot',
				dropPendingUpdates: true,
				allowedUpdates: ['message'],
				secretConfigured: true,
				installedAt: '2026-08-14T12:00:00.000Z',
				webhookUrl: 'https://api.winwidget.ru/api/v1/telegram-bot/webhook'
			})
		).toThrow('Unsafe Identity audit metadata key webhookUrl');
	});

	it.each([
		'passwordHash',
		'refreshTokenHash',
		'oauthAccessToken',
		'otpCode',
		'codeHash',
		'clientSecret',
		'correlationId',
		'requestIp'
	])('rejects secret-shaped or reserved metadata key %s', key => {
		expect(() =>
			auditMetadata('USER_UPDATE', {
				changedFields: ['name'],
				passwordChanged: false,
				[key]: 'secret-shaped-value'
			})
		).toThrow('Unsafe Identity audit metadata key');
	});
});
