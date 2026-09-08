import type { WincrmIntakeSlaEventPayload } from './delivery-event.types';
import {
	WINCRM_INTAKE_SLA_EMAIL_EVENT_TYPE,
	WINCRM_INTAKE_SLA_TELEGRAM_EVENT_TYPE
} from './messaging.constants';
import {
	hasExactInvitationKeys as exact,
	isCanonicalInvitationDate as iso,
	isNormalizedInvitationEmail
} from './wincrm-invitation.contract';
import { isTimeZone } from 'class-validator';
const uuid = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value
	);
export interface SlaContent {
	entryId: string;
	title: string;
	dueAt: string;
	timeZone: string;
}
export type SlaChannel = 'EMAIL' | 'TELEGRAM';
export type SlaDeliveryContext = {
	schemaVersion: 1;
	eventId: string;
	notificationId: string;
	workspaceId: string;
	channel: SlaChannel;
} & (
	| {
			deliver: true;
			destination: { email: string | null; telegramChatId: string | null };
			content: SlaContent;
	  }
	| { deliver: false; destination: null; content: null }
);
export function assertWincrmIntakeSlaEvent(
	value: unknown
): asserts value is WincrmIntakeSlaEventPayload {
	if (
		!exact(value, [
			'schemaVersion',
			'eventId',
			'eventType',
			'occurredAt',
			'reference'
		]) ||
		value.schemaVersion !== 1 ||
		!uuid(value.eventId) ||
		![
			WINCRM_INTAKE_SLA_EMAIL_EVENT_TYPE,
			WINCRM_INTAKE_SLA_TELEGRAM_EVENT_TYPE
		].includes(value.eventType as string) ||
		!iso(value.occurredAt) ||
		!exact(value.reference, ['type', 'id', 'workspaceId']) ||
		value.reference.type !== 'wincrm-intake-sla' ||
		value.reference.id !== value.eventId ||
		!uuid(value.reference.workspaceId)
	)
		throw new Error('Invalid WinCRM Intake SLA event');
}
export function parseSlaDeliveryContext(
	value: unknown,
	event: WincrmIntakeSlaEventPayload,
	channel: SlaChannel
): SlaDeliveryContext {
	const invalid = () => new Error('Invalid WinCRM Intake SLA context');
	if (
		!exact(value, [
			'schemaVersion',
			'eventId',
			'notificationId',
			'workspaceId',
			'channel',
			'deliver',
			'destination',
			'content'
		]) ||
		value.schemaVersion !== 1 ||
		value.eventId !== event.eventId ||
		value.notificationId !== event.reference.id ||
		value.workspaceId !== event.reference.workspaceId ||
		value.channel !== channel
	)
		throw invalid();
	if (value.deliver === false) {
		if (value.destination !== null || value.content !== null)
			throw invalid();
	} else if (value.deliver === true) {
		if (
			!exact(value.destination, ['email', 'telegramChatId']) ||
			(channel === 'EMAIL'
				? !isNormalizedInvitationEmail(value.destination.email) ||
					value.destination.telegramChatId !== null
				: value.destination.email !== null ||
					typeof value.destination.telegramChatId !== 'string' ||
					!/^[1-9][0-9]{0,19}$/.test(value.destination.telegramChatId)) ||
			!exact(value.content, ['entryId', 'title', 'dueAt', 'timeZone']) ||
			!uuid(value.content.entryId) ||
			typeof value.content.title !== 'string' ||
			!value.content.title.trim() ||
			Array.from(value.content.title).length > 200 ||
			!iso(value.content.dueAt) ||
			typeof value.content.timeZone !== 'string' ||
			value.content.timeZone.length > 100 ||
			/^[+-]/.test(value.content.timeZone) ||
			!isTimeZone(value.content.timeZone)
		)
			throw invalid();
	} else throw invalid();
	return value as unknown as SlaDeliveryContext;
}
