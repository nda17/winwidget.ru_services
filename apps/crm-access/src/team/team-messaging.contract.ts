import {
	hasExactKeys,
	isRecord,
	isUuidV4
} from '../internal/internal-http.config';
import type { AcceptedInvitationEvent } from './team-admission.service';
import { TEAM_EVENTS, type TeamConsumer } from './team.util';

export const TEAM_CONSUMERS = Object.keys(TEAM_EVENTS) as TeamConsumer[];
export const TEAM_RETRY_DELAYS = [30_000, 300_000, 1_800_000] as const;
export const teamQueue = (consumer: TeamConsumer) =>
	`winwidget.crm-access.team.${consumer}`;
export const teamRoute = (consumer: TeamConsumer) =>
	`crm-access.team.${consumer}`;
export const teamRetryRoute = (consumer: TeamConsumer, attempt: number) =>
	`${teamRoute(consumer)}.retry.${attempt}`;
export type TeamEvent =
	| AcceptedInvitationEvent
	| {
			schemaVersion: 1;
			eventId: string;
			eventType: string;
			workspaceId: string;
			invitationId?: string;
			occurredAt: string;
	  };
export function parseTeamEvent(
	value: unknown,
	consumer: TeamConsumer
): TeamEvent {
	if (!isRecord(value)) throw new Error('INVALID_EVENT');
	const keys = [
		'schemaVersion',
		'eventId',
		'eventType',
		'workspaceId',
		'occurredAt',
		...(consumer === 'admission' ? [] : ['invitationId']),
		...(consumer === 'acceptance'
			? ['invitationVersion', 'acceptanceId', 'subject', 'membershipId']
			: [])
	];
	if (
		!hasExactKeys(value, keys) ||
		value.schemaVersion !== 1 ||
		value.eventType !== TEAM_EVENTS[consumer] ||
		!isUuidV4(value.eventId) ||
		!isUuidV4(value.workspaceId) ||
		(consumer !== 'admission' && !isUuidV4(value.invitationId)) ||
		typeof value.occurredAt !== 'string' ||
		!Number.isFinite(Date.parse(value.occurredAt)) ||
		new Date(value.occurredAt).toISOString() !== value.occurredAt
	)
		throw new Error('INVALID_EVENT');
	if (
		consumer === 'acceptance' &&
		(!isUuidV4(value.acceptanceId) ||
			!isUuidV4(value.membershipId) ||
			!Number.isSafeInteger(value.invitationVersion) ||
			Number(value.invitationVersion) < 1 ||
			Number(value.invitationVersion) > 2147483647 ||
			typeof value.subject !== 'string' ||
			!/^[^\s\x00-\x1f\x7f]{1,256}$/.test(value.subject))
	)
		throw new Error('INVALID_EVENT');
	return value as unknown as TeamEvent;
}
