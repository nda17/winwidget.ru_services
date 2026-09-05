import type { ConfigService } from '@nestjs/config';
import { WincrmInvitationContextService } from './wincrm-invitation-context.service';
import type { WincrmInvitationEmailRequestedEventPayload } from '../messaging/delivery-event.types';

const event: WincrmInvitationEmailRequestedEventPayload = {
	schemaVersion: 1,
	eventId: '11111111-1111-4111-8111-111111111111',
	eventType: 'notification.wincrm.invitation.email.requested.v1',
	occurredAt: '2026-09-05T00:00:00.000Z',
	reference: {
		type: 'wincrm-invitation',
		id: '22222222-2222-4222-8222-222222222222',
		workspaceId: '33333333-3333-4333-8333-333333333333'
	},
	destination: { email: 'invited@example.test' },
	content: {
		invitationId: '22222222-2222-4222-8222-222222222222',
		expiresAt: '2026-09-12T00:00:00.000Z'
	}
};
const response = () => ({
	schemaVersion: 1,
	invitationId: event.reference.id,
	workspaceId: event.reference.workspaceId,
	eventId: event.eventId,
	deliver: true,
	email: event.destination.email,
	expiresAt: event.content.expiresAt
});
const fixtureToken = 'a'.repeat(48);
function service(overrides: Record<string, string | undefined> = {}) {
	const values: Record<string, string | undefined> = {
		NOTIFICATION_DELIVERY_KINDS: 'wincrm-invitation-email',
		IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4500',
		IDENTITY_NOTIFICATION_DELIVERY_TOKEN: fixtureToken,
		...overrides
	};
	return new WincrmInvitationContextService({
		get: (key: string) => values[key]
	} as ConfigService);
}

describe('WincrmInvitationContextService', () => {
	afterEach(() => {
		jest.restoreAllMocks();
		jest.useRealTimers();
	});
	it('does not require new configuration for old default consumers', () => {
		expect(() =>
			service({
				NOTIFICATION_DELIVERY_KINDS: undefined,
				IDENTITY_INTERNAL_BASE_URL: undefined,
				IDENTITY_NOTIFICATION_DELIVERY_TOKEN: undefined
			}).onModuleInit()
		).not.toThrow();
	});
	it('rejects reuse of the Operations control credential', () => {
		expect(() =>
			service({
				NOTIFICATION_DELIVERY_OPERATIONS_TOKEN: fixtureToken
			}).onModuleInit()
		).toThrow();
	});
	it.each([
		'https://user:pass@example.test',
		'http://example.test',
		'file:///tmp/identity',
		'https://identity.example.test/path',
		'https://identity.example.test?x=1',
		'https://identity.example.test#fragment'
	])('rejects unsafe origin %s before startup', origin => {
		expect(() =>
			service({ IDENTITY_INTERNAL_BASE_URL: origin }).onModuleInit()
		).toThrow();
	});
	it.each([
		undefined,
		'',
		'change_me',
		'a'.repeat(31),
		`a${'b'.repeat(32)}\r\n`,
		'placeholder'.repeat(5)
	])('rejects absent/invalid pair credential %#', token => {
		expect(() =>
			service({
				IDENTITY_NOTIFICATION_DELIVERY_TOKEN: token
			}).onModuleInit()
		).toThrow();
	});
	it('uses only the scoped pair headers and exact stored event binding; no redirects', async () => {
		const fetcher = jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(Response.json(response()));
		await expect(service().canDeliver(event)).resolves.toBe(true);
		expect(fetcher).toHaveBeenCalledWith(
			`http://127.0.0.1:4500/internal/v1/notification-delivery/wincrm-invitations/${event.reference.id}/delivery-context`,
			expect.objectContaining({
				method: 'POST',
				redirect: 'error',
				signal: expect.any(AbortSignal),
				headers: {
					'content-type': 'application/json',
					'x-winwidget-service': 'notification-delivery',
					'x-winwidget-internal-token': fixtureToken
				},
				body: JSON.stringify({
					schemaVersion: 1,
					eventId: event.eventId,
					workspaceId: event.reference.workspaceId
				})
			})
		);
	});
	it('accepts only explicit known no-send state with a null destination', async () => {
		jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				Response.json({ ...response(), deliver: false, email: null })
			);
		await expect(service().canDeliver(event)).resolves.toBe(false);
	});
	it.each([
		{ eventId: event.reference.id },
		{ workspaceId: event.eventId },
		{ invitationId: event.eventId },
		{ email: 'other@example.test' },
		{ email: null },
		{ deliver: false },
		{ expiresAt: '2026-09-13T00:00:00.000Z' },
		{ role: 'OWNER' },
		{ deliver: 'true' }
	])('rejects stale, expanded and cross-scope context %#', async patch => {
		jest
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(Response.json({ ...response(), ...patch }));
		await expect(service().canDeliver(event)).rejects.toThrow(
			'WinCRM invitation eligibility is unavailable'
		);
	});
	it.each([301, 401, 403, 404, 500, 503])(
		'does not treat HTTP %s as successful skip',
		async status => {
			jest
				.spyOn(globalThis, 'fetch')
				.mockResolvedValue(
					Response.json({ private: 'not-returned' }, { status })
				);
			await expect(service().canDeliver(event)).rejects.toThrow(
				'WinCRM invitation eligibility is unavailable'
			);
		}
	);
	it('rejects oversized and non-JSON context without exposing the body', async () => {
		const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('a'.repeat(4097), {
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect(service().canDeliver(event)).rejects.toThrow(
			'WinCRM invitation eligibility is unavailable'
		);
		fetcher.mockResolvedValue(
			new Response('<private>', {
				headers: { 'content-type': 'text/html' }
			})
		);
		await expect(service().canDeliver(event)).rejects.toThrow(
			'WinCRM invitation eligibility is unavailable'
		);
	});
	it('aborts timed-out HTTP calls and suppresses transport exception contents', async () => {
		jest.useFakeTimers();
		jest
			.spyOn(globalThis, 'fetch')
			.mockImplementation(
				(_url, options) =>
					new Promise((_resolve, reject) =>
						options?.signal?.addEventListener('abort', () =>
							reject(new Error(`private token ${fixtureToken}`))
						)
					)
			);
		const check = expect(service().canDeliver(event)).rejects.toThrow(
			'WinCRM invitation eligibility is unavailable'
		);
		await jest.advanceTimersByTimeAsync(5001);
		await check;
	});
});
