import { assertMessagingEventContract } from './messaging-event-contract';
import {
	WINCRM_INVITATION_EMAIL_EVENT_TYPE,
	MESSAGING_QUEUE_NAMES
} from './messaging.constants';
import { assertWincrmInvitationEvent } from './wincrm-invitation.contract';
import { parseNotificationDeliveryKinds } from '../notification-delivery/notification-delivery-worker.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const INVITATION_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const payload = () => ({
	schemaVersion: 1,
	eventId: EVENT_ID,
	eventType: WINCRM_INVITATION_EMAIL_EVENT_TYPE,
	occurredAt: '2026-09-05T00:00:00.000Z',
	reference: {
		type: 'wincrm-invitation',
		id: INVITATION_ID,
		workspaceId: WORKSPACE_ID
	},
	destination: { email: 'invited@example.test' },
	content: {
		invitationId: INVITATION_ID,
		expiresAt: '2026-09-12T00:00:00.000Z'
	}
});

describe('WinCRM invitation notification contract', () => {
	it('requires explicit opt-in without changing existing default consumers', () => {
		expect(parseNotificationDeliveryKinds(undefined)).toHaveLength(11);
		expect(parseNotificationDeliveryKinds(undefined)).not.toContain(
			'wincrm-invitation-email'
		);
		expect(
			parseNotificationDeliveryKinds('email,wincrm-invitation-email')
		).toEqual(['email', 'wincrm-invitation-email']);
		expect(MESSAGING_QUEUE_NAMES['wincrm-invitation-email']).toBe(
			'winwidget.notification.wincrm.invitation.email'
		);
	});
	it.each([
		WINCRM_INVITATION_EMAIL_EVENT_TYPE,
		'manual.wincrm-invitation-email',
		'wincrm-invitation-email',
		'wincrm-invitation-email.dead-letter'
	])('accepts only the bounded invitation contract on %s', routingKey => {
		expect(() =>
			assertMessagingEventContract(payload(), {
				eventType: WINCRM_INVITATION_EMAIL_EVENT_TYPE,
				messageId: EVENT_ID,
				routingKey,
				kind: 'wincrm-invitation-email'
			})
		).not.toThrow();
	});
	it.each([
		{ eventId: INVITATION_ID },
		{ schemaVersion: 2 },
		{ occurredAt: '2026-09-05' },
		{
			reference: {
				type: 'workspace',
				id: INVITATION_ID,
				workspaceId: WORKSPACE_ID
			}
		},
		{
			reference: {
				type: 'wincrm-invitation',
				id: INVITATION_ID,
				workspaceId: 'workspace'
			}
		},
		{
			content: {
				invitationId: WORKSPACE_ID,
				expiresAt: '2026-09-12T00:00:00.000Z'
			}
		},
		{
			content: {
				invitationId: INVITATION_ID,
				expiresAt: '2026-09-05T00:00:00.000Z'
			}
		},
		{
			content: {
				invitationId: INVITATION_ID,
				expiresAt: '2026-09-12T03:00:00+03:00'
			}
		},
		{
			content: {
				invitationId: INVITATION_ID,
				expiresAt: '2026-09-12T00:00:00.000Z',
				html: '<script/>'
			}
		},
		{ destination: { email: 'Invited@example.test' } },
		{ destination: { email: ' invited@example.test' } },
		{
			destination: {
				email: 'invited@example.test\r\nBcc: attacker@example.test'
			}
		},
		{ destination: { email: 'one@example.test,two@example.test' } },
		{ destination: { email: 'Display <invited@example.test>' } },
		{ url: 'https://attacker.example.test' },
		{ token: 'not-a-real-token' },
		{ actorId: WORKSPACE_ID }
	])('rejects malformed or expanded input %#', patch => {
		expect(() =>
			assertMessagingEventContract(
				{ ...payload(), ...patch },
				{
					eventType: WINCRM_INVITATION_EMAIL_EVENT_TYPE,
					messageId: EVENT_ID,
					routingKey: WINCRM_INVITATION_EMAIL_EVENT_TYPE,
					kind: 'wincrm-invitation-email'
				}
			)
		).toThrow();
	});
	it('allows already expired valid messages so the worker can record an explicit terminal skip', () => {
		expect(() => assertWincrmInvitationEvent(payload())).not.toThrow();
	});
	it('rejects cross-consumer or wrong routing metadata', () => {
		for (const metadata of [
			{
				kind: 'email' as const,
				routingKey: WINCRM_INVITATION_EMAIL_EVENT_TYPE
			},
			{
				kind: 'wincrm-invitation-email' as const,
				routingKey: 'manual.email'
			}
		]) {
			expect(() =>
				assertMessagingEventContract(payload(), {
					...metadata,
					eventType: WINCRM_INVITATION_EMAIL_EVENT_TYPE,
					messageId: EVENT_ID
				})
			).toThrow();
		}
	});
});
