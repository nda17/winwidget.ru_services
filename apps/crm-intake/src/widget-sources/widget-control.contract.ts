import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const WIDGET_TYPES = [
	'WHEEL',
	'QUIZ',
	'CALLBACK',
	'TIMER',
	'STOP_OFFER',
	'CALCULATOR'
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export const CONTROL_CONSUMER = 'crm-intake.widget-control.v1';
export const CONTROL_EVENT = 'crm.intake.widget-control.requested.v1';
export const CONTROL_RETRY_MS = [5000, 30000, 120000] as const;
export const CONTROL_ERRORS = [
	'DELEGATION_REVOKED',
	'OWNER_CHANGED',
	'SUBSCRIPTION_REQUIRED',
	'WIDGET_UNAVAILABLE',
	'ALREADY_CONNECTED',
	'CONTROL_CONFLICT',
	'DEPENDENCY_UNAVAILABLE',
	'INVALID_RESPONSE'
] as const;
export type ControlError = (typeof CONTROL_ERRORS)[number];
export const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function object(
	value: unknown,
	keys: readonly string[]
): Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))
	)
		throw new Error('Invalid contract fields');
	return value as Record<string, unknown>;
}
export function uuid(value: unknown): string {
	if (typeof value !== 'string' || !UUID.test(value))
		throw new Error('Invalid identifier');
	return value;
}
export function identifier(value: unknown, max = 256): string {
	if (
		typeof value !== 'string' ||
		!value.length ||
		value.length > max ||
		/[\s\x00-\x1f\x7f\ufffd\ud800-\udfff]/u.test(value)
	)
		throw new Error('Invalid identifier');
	return value;
}
export function integer(
	value: unknown,
	min = 1,
	max = 2147483646
): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	)
		throw new Error('Invalid number');
	return value;
}
export function iso(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.length !== 24 ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	)
		throw new Error('Invalid timestamp');
	return value;
}
export function text(value: unknown, max = 200): string {
	if (
		typeof value !== 'string' ||
		value.length > max ||
		/[\x00-\x1f\x7f\ufffd\ud800-\udfff]/u.test(value)
	)
		throw new Error('Invalid text');
	return value;
}
export function widgetType(value: unknown): WidgetType {
	if (!WIDGET_TYPES.includes(value as WidgetType))
		throw new Error('Invalid widget type');
	return value as WidgetType;
}
export const controlHash = (value: unknown) =>
	createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
export interface ControlEvent {
	schemaVersion: 1;
	eventId: string;
	workspaceId: string;
	sourceId: string;
	commandId: string;
	controlVersion: number;
	generation: number;
}
export function parseControlEvent(value: unknown): ControlEvent {
	const data = object(value, [
		'schemaVersion',
		'eventId',
		'workspaceId',
		'sourceId',
		'commandId',
		'controlVersion',
		'generation'
	]);
	if (data.schemaVersion !== 1) throw new Error('Invalid schema');
	const controlVersion = integer(data.controlVersion);
	return {
		schemaVersion: 1,
		eventId: uuid(data.eventId),
		workspaceId: uuid(data.workspaceId),
		sourceId: uuid(data.sourceId),
		commandId: uuid(data.commandId),
		controlVersion,
		generation: integer(data.generation, 1, controlVersion)
	};
}
export interface ConfigureRequest {
	schemaVersion: 1;
	commandId: string;
	workspaceId: string;
	sourceId: string;
	ownerSubject: string;
	widgetType: WidgetType;
	widgetId: string;
	controlVersion: number;
	generation: number;
	enabled: boolean;
}
export function invalidInput<T>(parse: () => T): T {
	try {
		return parse();
	} catch {
		throw new BadRequestException({
			code: 'crm_widget_source_invalid_request',
			message: 'Invalid managed widget source request'
		});
	}
}
