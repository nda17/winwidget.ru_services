import {
	SUPPORT_NOTIFICATION_EVENT_TYPES,
	SUPPORT_NOTIFICATION_KINDS,
	SUPPORT_NOTIFICATION_OUTCOME_EVENT_TYPE,
	SupportNotificationKind
} from './messaging.constants';
import {
	hasExactInvitationKeys as exact,
	isCanonicalInvitationDate as iso,
	isNormalizedInvitationEmail
} from './wincrm-invitation.contract';

const uuid = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value
	);

export const SUPPORT_NOTIFICATION_SKIP_REASONS = [
	'RECIPIENT_UNAVAILABLE',
	'CHANNEL_DISABLED',
	'INTENT_CANCELLED'
] as const;
export type SupportNotificationSkipReason =
	(typeof SUPPORT_NOTIFICATION_SKIP_REASONS)[number];
export interface SupportNotificationEvent {
	schemaVersion: 1;
	eventId: string;
	eventType: (typeof SUPPORT_NOTIFICATION_EVENT_TYPES)[SupportNotificationKind];
	occurredAt: string;
	reference: { type: 'support-notification'; id: string };
}
export interface SupportNotificationContent {
	conversationId: string;
	conversationNumber: number;
	notificationType:
		| 'NEW_CONVERSATION'
		| 'CLIENT_MESSAGE'
		| 'OPERATOR_REPLY';
}
export type SupportNotificationContext = {
	schemaVersion: 1;
	eventId: string;
	intentId: string;
	kind: SupportNotificationKind;
} & (
	| {
			deliver: true;
			reason: null;
			content: SupportNotificationContent;
			destination:
				| { email: string }
				| {
						bot: 'SUPPORT';
						telegramChatId: string;
						messageThreadId: number;
				  };
	  }
	| {
			deliver: false;
			reason: SupportNotificationSkipReason;
			content: null;
			destination: null;
	  }
);
export interface SupportNotificationOutcome {
	schemaVersion: 1;
	eventId: string;
	eventType: typeof SUPPORT_NOTIFICATION_OUTCOME_EVENT_TYPE;
	occurredAt: string;
	sourceEventId: string;
	sourceKind: SupportNotificationKind;
	intentId: string;
	status: 'DELIVERED' | 'FAILED' | 'SKIPPED';
	reason: string | null;
}

export function isSupportNotificationKind(
	value: unknown
): value is SupportNotificationKind {
	return SUPPORT_NOTIFICATION_KINDS.some(kind => kind === value);
}

export function assertSupportNotificationEvent(
	value: unknown
): asserts value is SupportNotificationEvent {
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
		!iso(value.occurredAt) ||
		!Object.values(SUPPORT_NOTIFICATION_EVENT_TYPES).some(
			type => type === value.eventType
		) ||
		!exact(value.reference, ['type', 'id']) ||
		value.reference.type !== 'support-notification' ||
		!uuid(value.reference.id)
	)
		throw new Error('Invalid support notification event');
}

export function parseSupportNotificationContext(
	value: unknown,
	event: SupportNotificationEvent,
	kind: SupportNotificationKind
): SupportNotificationContext {
	const invalid = () => new Error('Invalid support notification context');
	if (
		!exact(value, [
			'schemaVersion',
			'eventId',
			'intentId',
			'kind',
			'deliver',
			'destination',
			'content',
			'reason'
		]) ||
		value.schemaVersion !== 1 ||
		value.eventId !== event.eventId ||
		value.intentId !== event.reference.id ||
		value.kind !== kind ||
		event.eventType !== SUPPORT_NOTIFICATION_EVENT_TYPES[kind]
	)
		throw invalid();
	if (value.deliver === false) {
		if (
			value.destination !== null ||
			value.content !== null ||
			!SUPPORT_NOTIFICATION_SKIP_REASONS.some(
				reason => reason === value.reason
			)
		)
			throw invalid();
	} else if (value.deliver === true) {
		if (
			value.reason !== null ||
			!exact(value.content, [
				'conversationId',
				'conversationNumber',
				'notificationType'
			]) ||
			!uuid(value.content.conversationId) ||
			!Number.isSafeInteger(value.content.conversationNumber) ||
			Number(value.content.conversationNumber) < 1 ||
			Number(value.content.conversationNumber) > 2147483647 ||
			!(
				kind === 'support-client-email'
					? ['OPERATOR_REPLY']
					: ['NEW_CONVERSATION', 'CLIENT_MESSAGE']
			).includes(String(value.content.notificationType))
		)
			throw invalid();
		if (kind === 'support-team-telegram') {
			if (
				!exact(value.destination, [
					'bot',
					'telegramChatId',
					'messageThreadId'
				]) ||
				value.destination.bot !== 'SUPPORT' ||
				typeof value.destination.telegramChatId !== 'string' ||
				!/^-[1-9][0-9]{0,18}$/.test(value.destination.telegramChatId) ||
				!Number.isSafeInteger(value.destination.messageThreadId) ||
				Number(value.destination.messageThreadId) < 1 ||
				Number(value.destination.messageThreadId) > 2147483647
			)
				throw invalid();
		} else if (
			!exact(value.destination, ['email']) ||
			!isNormalizedInvitationEmail(value.destination.email)
		)
			throw invalid();
	} else throw invalid();
	return value as unknown as SupportNotificationContext;
}

export function assertSupportNotificationOutcome(
	value: unknown
): asserts value is SupportNotificationOutcome {
	if (
		!exact(value, [
			'schemaVersion',
			'eventId',
			'eventType',
			'occurredAt',
			'sourceEventId',
			'sourceKind',
			'intentId',
			'status',
			'reason'
		]) ||
		value.schemaVersion !== 1 ||
		value.eventType !== SUPPORT_NOTIFICATION_OUTCOME_EVENT_TYPE ||
		!uuid(value.eventId) ||
		!uuid(value.sourceEventId) ||
		!uuid(value.intentId) ||
		!iso(value.occurredAt) ||
		!isSupportNotificationKind(value.sourceKind) ||
		!['DELIVERED', 'FAILED', 'SKIPPED'].includes(String(value.status)) ||
		(value.status === 'DELIVERED'
			? value.reason !== null
			: value.status === 'SKIPPED'
				? !SUPPORT_NOTIFICATION_SKIP_REASONS.some(
						reason => reason === value.reason
					)
				: typeof value.reason !== 'string' ||
					!/^[A-Z0-9_]{1,120}$/.test(value.reason))
	)
		throw new Error('Invalid support notification outcome');
}

export function supportConversationUrl(
	content: SupportNotificationContent,
	client: boolean
): string {
	return client
		? `https://crm.winwidget.ru/inbox?supportConversation=${content.conversationId}`
		: `https://winwidget.ru/admin/support?conversationId=${content.conversationId}`;
}
