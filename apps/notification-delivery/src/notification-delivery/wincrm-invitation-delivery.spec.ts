import { NotificationDeliveryAdapterService } from './notification-delivery-adapter.service';
import type { WincrmInvitationContextService } from './wincrm-invitation-context.service';
import type { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import type { TelegramInfoTransportService } from '../telegram/telegram-info-transport.service';
import { EmailService } from '../email/email.service';
import type { Transporter } from 'nodemailer';
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
function setup() {
	const sendMail = jest.fn().mockResolvedValue({});
	const canDeliver = jest.fn().mockResolvedValue(true);
	return {
		sendMail,
		canDeliver,
		service: new NotificationDeliveryAdapterService(
			new EmailService({ sendMail } as unknown as Transporter),
			{} as TelegramInfoTransportService,
			{} as NotificationDeliveryPrismaService,
			{ canDeliver } as unknown as WincrmInvitationContextService
		)
	};
}

describe('WinCRM invitation email adapter (fake SMTP only)', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-09-06T00:00:00.000Z'));
	});
	afterEach(() => jest.useRealTimers());
	it('renders only the fixed invitation link, generic subject and stable Message-ID after fresh eligibility', async () => {
		const value = setup();
		await value.service.deliver(
			'wincrm-invitation-email',
			event,
			event.eventId,
			'claimed'
		);
		expect(value.canDeliver).toHaveBeenCalledWith(event);
		expect(value.sendMail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: event.destination.email,
				subject: 'Приглашение в WinCRM',
				messageId: `<${event.eventId}.wincrm-invitation@winwidget.ru>`,
				html: expect.stringContaining(
					`href="https://crm.winwidget.ru/invitations/${event.reference.id}"`
				)
			})
		);
		const html = value.sendMail.mock.calls[0][0].html as string;
		expect(html).toContain('Ссылка сама по себе не предоставляет доступ');
		expect(html).not.toContain('token=');
		expect(value.canDeliver.mock.invocationCallOrder[0]).toBeLessThan(
			value.sendMail.mock.invocationCallOrder[0]
		);
	});
	it('does not contact Identity or SMTP for an expired envelope', async () => {
		jest.setSystemTime(new Date(event.content.expiresAt));
		const value = setup();
		await expect(
			value.service.deliver(
				'wincrm-invitation-email',
				event,
				event.eventId,
				'claimed'
			)
		).resolves.toEqual({
			status: 'SKIPPED',
			reason: 'INVITATION_EXPIRED'
		});
		expect(value.canDeliver).not.toHaveBeenCalled();
		expect(value.sendMail).not.toHaveBeenCalled();
	});
	it('does not send revoked/accepted/inactive invitations', async () => {
		const value = setup();
		value.canDeliver.mockResolvedValue(false);
		await expect(
			value.service.deliver(
				'wincrm-invitation-email',
				event,
				event.eventId,
				'claimed'
			)
		).resolves.toEqual({
			status: 'SKIPPED',
			reason: 'INVITATION_UNAVAILABLE'
		});
		expect(value.sendMail).not.toHaveBeenCalled();
	});
	it('rechecks expiry after the eligibility response', async () => {
		const value = setup();
		value.canDeliver.mockImplementation(async () => {
			jest.setSystemTime(new Date(event.content.expiresAt));
			return true;
		});
		await expect(
			value.service.deliver(
				'wincrm-invitation-email',
				event,
				event.eventId,
				'claimed'
			)
		).resolves.toEqual({
			status: 'SKIPPED',
			reason: 'INVITATION_EXPIRED'
		});
		expect(value.sendMail).not.toHaveBeenCalled();
	});
	it('propagates eligibility/provider errors without claiming success', async () => {
		const value = setup();
		value.canDeliver.mockRejectedValueOnce(
			new Error('context unavailable')
		);
		await expect(
			value.service.deliver(
				'wincrm-invitation-email',
				event,
				event.eventId,
				'claimed'
			)
		).rejects.toThrow('context unavailable');
		expect(value.sendMail).not.toHaveBeenCalled();
		value.sendMail.mockRejectedValueOnce(
			Object.assign(new Error('SMTP unavailable'), { code: 'ECONNECTION' })
		);
		await expect(
			value.service.deliver(
				'wincrm-invitation-email',
				event,
				event.eventId,
				'claimed'
			)
		).rejects.toThrow('SMTP unavailable');
	});
	it('requires a matching event and an active claim before any external call', async () => {
		const value = setup();
		await expect(
			value.service.deliver(
				'wincrm-invitation-email',
				event,
				event.eventId
			)
		).rejects.toThrow('matching active claim');
		await expect(
			value.service.deliver(
				'wincrm-invitation-email',
				event,
				event.reference.id,
				'claimed'
			)
		).rejects.toThrow('matching active claim');
		expect(value.canDeliver).not.toHaveBeenCalled();
		expect(value.sendMail).not.toHaveBeenCalled();
	});
});
