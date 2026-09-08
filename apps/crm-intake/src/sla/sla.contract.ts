import { BadRequestException } from '@nestjs/common';
import { ACCEPTANCE_UUID } from '../acceptance/acceptance.contract';

export interface SlaBinding {
	subject: string;
	membershipId: string | null;
}
export interface SlaRuleConfig {
	enabled: boolean;
	workingMinutes: number;
	timeZone: string;
	weekdays: number[];
	workStart: string;
	workEnd: string;
	responsibleBinding: SlaBinding | null;
	notifyManagers: boolean;
	channels: Array<'EMAIL' | 'TELEGRAM'>;
}
export interface SlaCommand {
	schemaVersion: 1;
	workspaceId: string;
	commandId: string;
	expectedVersion: number;
	config: SlaRuleConfig;
}
export interface SlaEvent {
	schemaVersion: 1;
	eventId: string;
	workspaceId: string;
	jobId: string;
	generation: number;
}
export const SLA_EMAIL_EVENT =
	'notification.wincrm.intake-sla.email.requested.v1';
export const SLA_TELEGRAM_EVENT =
	'notification.wincrm.intake-sla.telegram.requested.v1';
export interface SlaNotificationEvent {
	schemaVersion: 1;
	eventId: string;
	eventType: typeof SLA_EMAIL_EVENT | typeof SLA_TELEGRAM_EVENT;
	occurredAt: string;
	reference: {
		type: 'wincrm-intake-sla';
		id: string;
		workspaceId: string;
	};
}
export function parseSlaNotificationEvent(
	value: unknown
): SlaNotificationEvent {
	if (
		!slaRecord(value) ||
		!slaKeys(value, [
			'schemaVersion',
			'eventId',
			'eventType',
			'occurredAt',
			'reference'
		]) ||
		value.schemaVersion !== 1 ||
		!slaUuid(value.eventId) ||
		![SLA_EMAIL_EVENT, SLA_TELEGRAM_EVENT].includes(
			String(value.eventType)
		) ||
		typeof value.occurredAt !== 'string' ||
		!Number.isFinite(Date.parse(value.occurredAt)) ||
		new Date(value.occurredAt).toISOString() !== value.occurredAt ||
		!slaRecord(value.reference) ||
		!slaKeys(value.reference, ['type', 'id', 'workspaceId']) ||
		value.reference.type !== 'wincrm-intake-sla' ||
		value.reference.id !== value.eventId ||
		!slaUuid(value.reference.workspaceId)
	)
		throw new Error('INVALID_SLA_NOTIFICATION_EVENT');
	return value as unknown as SlaNotificationEvent;
}
export const slaRecord = (
	value: unknown
): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
export const slaKeys = (value: Record<string, unknown>, keys: string[]) =>
	Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export const slaUuid = (value: unknown): value is string =>
	typeof value === 'string' && ACCEPTANCE_UUID.test(value);
export const slaSubject = (value: unknown): value is string =>
	typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,256}$/.test(value);
export const slaBinding = (value: unknown): value is SlaBinding =>
	slaRecord(value) &&
	slaKeys(value, ['subject', 'membershipId']) &&
	slaSubject(value.subject) &&
	(value.membershipId === null || slaUuid(value.membershipId));
const clock = (value: unknown): value is string =>
	typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const minutes = (value: string) =>
	Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export function parseSlaRule(value: unknown): SlaRuleConfig {
	const invalid = (): never => {
		throw new BadRequestException('Invalid Intake SLA rule');
	};
	if (
		!slaRecord(value) ||
		!slaKeys(value, [
			'enabled',
			'workingMinutes',
			'timeZone',
			'weekdays',
			'workStart',
			'workEnd',
			'responsibleBinding',
			'notifyManagers',
			'channels'
		]) ||
		typeof value.enabled !== 'boolean' ||
		!Number.isInteger(value.workingMinutes) ||
		Number(value.workingMinutes) < 1 ||
		Number(value.workingMinutes) > 1440 ||
		typeof value.timeZone !== 'string' ||
		value.timeZone.length > 100 ||
		!Array.isArray(value.weekdays) ||
		value.weekdays.length < 1 ||
		value.weekdays.length > 7 ||
		!value.weekdays.every(
			day => Number.isInteger(day) && day >= 1 && day <= 7
		) ||
		new Set(value.weekdays).size !== value.weekdays.length ||
		!clock(value.workStart) ||
		!clock(value.workEnd) ||
		minutes(value.workEnd) - minutes(value.workStart) < 30 ||
		!(
			value.responsibleBinding === null ||
			slaBinding(value.responsibleBinding)
		) ||
		typeof value.notifyManagers !== 'boolean' ||
		(value.enabled &&
			value.responsibleBinding === null &&
			!value.notifyManagers) ||
		!Array.isArray(value.channels) ||
		value.channels.length < 1 ||
		value.channels.length > 2 ||
		!value.channels.every(item => ['EMAIL', 'TELEGRAM'].includes(item)) ||
		new Set(value.channels).size !== value.channels.length
	)
		return invalid();
	try {
		new Intl.DateTimeFormat('en-GB', {
			timeZone: value.timeZone
		}).format();
	} catch {
		return invalid();
	}
	return {
		...value,
		weekdays: [...value.weekdays].sort((a, b) => a - b),
		channels: [...value.channels].sort()
	} as SlaRuleConfig;
}
export function parseSlaCommand(value: unknown): SlaCommand {
	if (
		!slaRecord(value) ||
		!slaKeys(value, [
			'schemaVersion',
			'workspaceId',
			'commandId',
			'expectedVersion',
			'config'
		]) ||
		value.schemaVersion !== 1 ||
		!slaUuid(value.workspaceId) ||
		!slaUuid(value.commandId) ||
		!Number.isInteger(value.expectedVersion) ||
		Number(value.expectedVersion) < 0 ||
		Number(value.expectedVersion) >= 2147483646
	)
		throw new BadRequestException('Invalid Intake SLA command');
	return { ...value, config: parseSlaRule(value.config) } as SlaCommand;
}
export function parseSlaEvent(value: unknown): SlaEvent {
	if (
		!slaRecord(value) ||
		!slaKeys(value, [
			'schemaVersion',
			'eventId',
			'workspaceId',
			'jobId',
			'generation'
		]) ||
		value.schemaVersion !== 1 ||
		![value.eventId, value.workspaceId, value.jobId].every(slaUuid) ||
		!Number.isInteger(value.generation) ||
		Number(value.generation) < 1 ||
		Number(value.generation) > 2147483646
	)
		throw new Error('INVALID_EVENT');
	return value as unknown as SlaEvent;
}
export function intakeSlaEnabled(
	value = process.env.CRM_INTAKE_SLA_ENABLED
) {
	if (value !== undefined && value !== 'true' && value !== 'false')
		throw new Error('CRM_INTAKE_SLA_ENABLED must be true or false');
	return value === 'true';
}
