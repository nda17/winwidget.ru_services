import type { WincrmInvitationEmailRequestedEventPayload } from './delivery-event.types';
import { WINCRM_INVITATION_EMAIL_EVENT_TYPE } from './messaging.constants';

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCanonicalInvitationDate(
	value: unknown
): value is string {
	return (
		typeof value === 'string' &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}

export function isNormalizedInvitationEmail(
	value: unknown
): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 254 &&
		value === value.trim().toLowerCase() &&
		/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
			value
		)
	);
}

export function hasExactInvitationKeys(
	value: unknown,
	keys: readonly string[]
): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
	);
}

export function assertWincrmInvitationEvent(
	value: unknown
): asserts value is WincrmInvitationEmailRequestedEventPayload {
	if (
		!hasExactInvitationKeys(value, [
			'schemaVersion',
			'eventId',
			'eventType',
			'occurredAt',
			'reference',
			'destination',
			'content'
		]) ||
		value.schemaVersion !== 1 ||
		value.eventType !== WINCRM_INVITATION_EMAIL_EVENT_TYPE ||
		typeof value.eventId !== 'string' ||
		!UUID.test(value.eventId) ||
		!isCanonicalInvitationDate(value.occurredAt) ||
		!hasExactInvitationKeys(value.reference, [
			'type',
			'id',
			'workspaceId'
		]) ||
		value.reference.type !== 'wincrm-invitation' ||
		typeof value.reference.id !== 'string' ||
		!UUID.test(value.reference.id) ||
		typeof value.reference.workspaceId !== 'string' ||
		!UUID.test(value.reference.workspaceId) ||
		!hasExactInvitationKeys(value.destination, ['email']) ||
		!isNormalizedInvitationEmail(value.destination.email) ||
		!hasExactInvitationKeys(value.content, [
			'invitationId',
			'expiresAt'
		]) ||
		value.content.invitationId !== value.reference.id ||
		!isCanonicalInvitationDate(value.content.expiresAt) ||
		value.content.expiresAt <= value.occurredAt
	) {
		// Never interpolate message contents: contract errors can reach logs/DLQ metadata.
		throw new Error('Invalid WinCRM invitation notification contract');
	}
}
