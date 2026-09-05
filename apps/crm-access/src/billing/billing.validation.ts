import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
	hasExactKeys,
	isRecord,
	isUuidV4
} from '../internal/internal-http.config';
import type {
	CommerceCommandType,
	CommerceUserCommand,
	WincrmQuoteRequest
} from './billing.contract';

export const billingEnabled = (config: ConfigService): boolean => {
	const flag = config.get<string>('CRM_ACCESS_BILLING_ENABLED')?.trim();
	if (flag && flag !== 'true' && flag !== 'false')
		throw new Error('CRM_ACCESS_BILLING_ENABLED must be true or false');
	return flag === 'true';
};
export const requireBilling = (enabled: boolean) => {
	if (!enabled) throw new NotFoundException();
};
export const validSubject = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length <= 256 &&
	/^[^\s\x00-\x1f\x7f\uD800-\uDFFF\uFFFD]+$/u.test(value);
export const validHash = (v: unknown): v is string =>
	typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const validUuid = (v: unknown): v is string =>
	isUuidV4(v) && v === v.toLowerCase();
export const validVersion = (v: unknown): v is string =>
	typeof v === 'string' &&
	/^(0|[1-9][0-9]{0,18})$/.test(v) &&
	BigInt(v) <= 9223372036854775807n;
export const validInt = (
	v: unknown,
	min = 1,
	max = 2147483646
): v is number =>
	typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export const validSeats = (v: unknown): v is number =>
	validInt(v, 2, 10000);
export const validConsent = (v: unknown): v is string =>
	typeof v === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(v);
export function invalid(): never {
	throw new BadRequestException('Invalid CRM billing request');
}
export function workspace(value: unknown): string {
	if (!validUuid(value)) invalid();
	return value;
}
export function contextBody(body: unknown): {
	schemaVersion: 1;
	workspaceId: string;
} {
	if (
		!isRecord(body) ||
		!hasExactKeys(body, ['schemaVersion', 'workspaceId']) ||
		body.schemaVersion !== 1
	)
		invalid();
	return { schemaVersion: 1, workspaceId: workspace(body.workspaceId) };
}
export function query(
	body: unknown,
	kind: 'context' | 'history' = 'context'
) {
	if (
		!isRecord(body) ||
		!Object.keys(body).every(k =>
			(kind === 'history'
				? ['workspaceId', 'page', 'pageSize']
				: ['workspaceId']
			).includes(k)
		)
	)
		invalid();
	const workspaceId = workspace(body.workspaceId);
	const number = (value: unknown, fallback: number, max: number) => {
		if (value === undefined) return fallback;
		if (
			typeof value !== 'string' ||
			!/^[1-9][0-9]*$/.test(value) ||
			!validInt(Number(value), 1, max)
		)
			invalid();
		return Number(value);
	};
	return {
		workspaceId,
		page: number(body.page, 1, 1000000),
		pageSize: number(body.pageSize, 20, 100)
	};
}
export function parseQuote(
	body: unknown
): Omit<WincrmQuoteRequest, 'actorSubject'> {
	if (
		!isRecord(body) ||
		!hasExactKeys(body, [
			'schemaVersion',
			'workspaceId',
			'intent',
			'cycle',
			'totalSeats'
		]) ||
		body.schemaVersion !== 1 ||
		typeof body.intent !== 'string' ||
		!['CHECKOUT', 'SEAT_CHANGE', 'RENEWAL'].includes(body.intent) ||
		typeof body.cycle !== 'string' ||
		!['MONTHLY', 'YEARLY'].includes(body.cycle) ||
		!validSeats(body.totalSeats)
	)
		invalid();
	workspace(body.workspaceId);
	return body as unknown as Omit<WincrmQuoteRequest, 'actorSubject'>;
}
export function parseCommand(
	type: CommerceCommandType,
	body: unknown,
	idempotencyKey: string | undefined,
	actorSubject: string
): CommerceUserCommand {
	const common = [
		'schemaVersion',
		'workspaceId',
		'commandId',
		'expectedBillingVersion'
	];
	const extra =
		type === 'WINCRM_VERIFY_ORDER'
			? ['orderId', 'expectedOrderVersion']
			: type === 'WINCRM_CHECKOUT'
				? [
						'expectedPolicyVersion',
						'cycle',
						'totalSeats',
						'autoRenew',
						'consentVersion'
					]
				: type === 'WINCRM_SEAT_CHANGE'
					? ['expectedPeriodId', 'expectedPeriodVersion', 'newTotalSeats']
					: type === 'WINCRM_CONFIRM_RENEWAL'
						? [
								'expectedRenewalVersion',
								'expectedPolicyVersion',
								'consentVersion'
							]
						: ['expectedRenewalVersion'];
	if (
		!isRecord(body) ||
		!hasExactKeys(body, [...common, ...extra]) ||
		body.schemaVersion !== 1 ||
		!validUuid(body.commandId) ||
		idempotencyKey !== body.commandId ||
		!validVersion(body.expectedBillingVersion) ||
		!validSubject(actorSubject)
	)
		invalid();
	workspace(body.workspaceId);
	if (
		type === 'WINCRM_VERIFY_ORDER' &&
		(!validUuid(body.orderId) || !validInt(body.expectedOrderVersion))
	)
		invalid();
	if (
		type === 'WINCRM_CHECKOUT' &&
		(!validInt(body.expectedPolicyVersion) ||
			(body.cycle !== 'MONTHLY' && body.cycle !== 'YEARLY') ||
			!validSeats(body.totalSeats) ||
			typeof body.autoRenew !== 'boolean' ||
			(body.autoRenew
				? !validConsent(body.consentVersion)
				: body.consentVersion !== null))
	)
		invalid();
	if (
		type === 'WINCRM_SEAT_CHANGE' &&
		(!validUuid(body.expectedPeriodId) ||
			!validInt(body.expectedPeriodVersion) ||
			!validSeats(body.newTotalSeats))
	)
		invalid();
	if (
		type === 'WINCRM_DISABLE_RENEWAL' ||
		type === 'WINCRM_CONFIRM_RENEWAL'
	) {
		if (!validInt(body.expectedRenewalVersion, 0)) invalid();
		if (
			type === 'WINCRM_CONFIRM_RENEWAL' &&
			(!validInt(body.expectedPolicyVersion) ||
				!validConsent(body.consentVersion))
		)
			invalid();
	}
	return { ...body, actorSubject } as unknown as CommerceUserCommand;
}
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (isRecord(value))
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map(k => [k, canonical(value[k])])
		);
	return value;
}
export function commerceHash(
	commandType: CommerceCommandType,
	payload: CommerceUserCommand
): string {
	return createHash('sha256')
		.update(JSON.stringify(canonical({ commandType, payload })))
		.digest('hex');
}
