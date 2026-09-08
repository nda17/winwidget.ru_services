import type { WincrmTaskReminderEventPayload } from './delivery-event.types';
import {
	WINCRM_TASK_REMINDER_EMAIL_EVENT_TYPE,
	WINCRM_TASK_REMINDER_TELEGRAM_EVENT_TYPE
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
export type ReminderChannel = 'EMAIL' | 'TELEGRAM';
export interface ReminderContent {
	trigger?: 'ASSIGNED';
	taskId: string;
	title: string;
	dueAt: string;
	timeZone: string;
}
export type ReminderDeliveryContext = {
	schemaVersion: 1 | 2;
	eventId: string;
	reminderId: string;
	workspaceId: string;
	channel: ReminderChannel;
} & (
	| {
			deliver: true;
			retryAt: null;
			destination: { email: string | null; telegramChatId: string | null };
			content: ReminderContent;
	  }
	| {
			deliver: false;
			retryAt: string | null;
			destination: null;
			content: null;
	  }
);

export function assertWincrmTaskReminderEvent(
	value: unknown
): asserts value is WincrmTaskReminderEventPayload {
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
			WINCRM_TASK_REMINDER_EMAIL_EVENT_TYPE,
			WINCRM_TASK_REMINDER_TELEGRAM_EVENT_TYPE
		].includes(value.eventType as string) ||
		!iso(value.occurredAt) ||
		!exact(value.reference, ['type', 'id', 'workspaceId']) ||
		value.reference.type !== 'wincrm-task-reminder' ||
		!uuid(value.reference.id) ||
		!uuid(value.reference.workspaceId)
	)
		throw new Error('Invalid WinCRM task reminder event');
}

export function parseReminderDeliveryContext(
	value: unknown,
	event: WincrmTaskReminderEventPayload,
	channel: ReminderChannel,
	now = Date.now()
): ReminderDeliveryContext {
	const invalid = () => new Error('Invalid WinCRM task reminder context');
	if (
		!exact(value, [
			'schemaVersion',
			'eventId',
			'reminderId',
			'workspaceId',
			'channel',
			'deliver',
			'retryAt',
			'destination',
			'content'
		]) ||
		(value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
		value.eventId !== event.eventId ||
		value.reminderId !== event.reference.id ||
		value.workspaceId !== event.reference.workspaceId ||
		value.channel !== channel
	)
		throw invalid();
	if (value.deliver === false) {
		if (
			value.destination !== null ||
			value.content !== null ||
			(value.retryAt !== null &&
				(!iso(value.retryAt) ||
					Date.parse(value.retryAt) <= now ||
					Date.parse(value.retryAt) > now + 72 * 60 * 60 * 1000))
		)
			throw invalid();
	} else if (value.deliver === true) {
		if (
			value.retryAt !== null ||
			!exact(value.destination, ['email', 'telegramChatId']) ||
			(channel === 'EMAIL'
				? !isNormalizedInvitationEmail(value.destination.email) ||
					value.destination.telegramChatId !== null
				: value.destination.email !== null ||
					typeof value.destination.telegramChatId !== 'string' ||
					!/^-?[1-9][0-9]{0,19}$/.test(
						value.destination.telegramChatId
					)) ||
			!exact(
				value.content,
				value.schemaVersion === 1
					? ['taskId', 'title', 'dueAt', 'timeZone']
					: ['taskId', 'title', 'dueAt', 'timeZone', 'trigger']
			) ||
			(value.schemaVersion === 2 &&
				value.content.trigger !== 'ASSIGNED') ||
			!uuid(value.content.taskId) ||
			typeof value.content.title !== 'string' ||
			!value.content.title.trim() ||
			Array.from(value.content.title).length > 200 ||
			!iso(value.content.dueAt) ||
			typeof value.content.timeZone !== 'string' ||
			value.content.timeZone.length > 100 ||
			!/^[A-Za-z][A-Za-z0-9._+\/-]*$/.test(value.content.timeZone) ||
			!isTimeZone(value.content.timeZone)
		)
			throw invalid();
	} else throw invalid();
	return value as unknown as ReminderDeliveryContext;
}
