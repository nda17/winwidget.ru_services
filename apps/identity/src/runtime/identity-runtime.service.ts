import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const IDENTITY_PROCESS_ROLES = [
	'api',
	'worker',
	'outbox-publisher'
] as const;

export type IdentityProcessRole = (typeof IDENTITY_PROCESS_ROLES)[number];

const ROLE_PORTS: Record<IdentityProcessRole, number> = {
	api: 4900,
	worker: 4901,
	'outbox-publisher': 4902
};

export function parseIdentityProcessRole(
	value: string | undefined
): IdentityProcessRole {
	const role = value?.trim() || 'api';
	if (!IDENTITY_PROCESS_ROLES.includes(role as IdentityProcessRole)) {
		throw new Error(
			`IDENTITY_PROCESS_ROLE must be one of ${IDENTITY_PROCESS_ROLES.join(', ')}`
		);
	}
	return role as IdentityProcessRole;
}

export function parseIdentityPort(
	role: IdentityProcessRole,
	environment: NodeJS.ProcessEnv = process.env
): number {
	const raw = environment.IDENTITY_PORT?.trim();
	const port = raw ? Number(raw) : ROLE_PORTS[role];
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(
			'IDENTITY_PORT must be an integer between 1 and 65535'
		);
	}
	if (role === 'api' && port !== 4900) {
		throw new Error('Identity API must listen on canonical port 4900');
	}
	return port;
}

export function boundedInteger(
	raw: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string
): number {
	const value = raw?.trim() ? Number(raw) : fallback;
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be between ${minimum} and ${maximum}`);
	}
	return value;
}

export function strictBoolean(
	raw: string | undefined,
	fallback: boolean,
	name: string
): boolean {
	const value = raw?.trim().toLowerCase();
	if (!value) return fallback;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error(`${name} must be true or false`);
}

@Injectable()
export class IdentityRuntimeService {
	readonly role: IdentityProcessRole;
	readonly prefetch: number;
	readonly outboxBatchSize: number;
	readonly outboxPollIntervalMs: number;
	readonly outboxRetentionDays: number;
	readonly receiptRetentionDays: number;
	readonly failureRetentionDays: number;
	readonly housekeepingIntervalMs: number;

	constructor(config: ConfigService) {
		this.role = parseIdentityProcessRole(
			config.get<string>('IDENTITY_PROCESS_ROLE')
		);
		this.prefetch = boundedInteger(
			config.get<string>('IDENTITY_PREFETCH'),
			10,
			1,
			1_000,
			'IDENTITY_PREFETCH'
		);
		this.outboxBatchSize = boundedInteger(
			config.get<string>('IDENTITY_OUTBOX_BATCH_SIZE'),
			50,
			1,
			1_000,
			'IDENTITY_OUTBOX_BATCH_SIZE'
		);
		this.outboxPollIntervalMs = boundedInteger(
			config.get<string>('IDENTITY_OUTBOX_POLL_INTERVAL_MS'),
			1_000,
			100,
			60_000,
			'IDENTITY_OUTBOX_POLL_INTERVAL_MS'
		);
		this.outboxRetentionDays = boundedInteger(
			config.get<string>('IDENTITY_OUTBOX_RETENTION_DAYS'),
			7,
			1,
			365,
			'IDENTITY_OUTBOX_RETENTION_DAYS'
		);
		this.receiptRetentionDays = boundedInteger(
			config.get<string>('IDENTITY_RECEIPT_RETENTION_DAYS'),
			90,
			1,
			3_650,
			'IDENTITY_RECEIPT_RETENTION_DAYS'
		);
		this.failureRetentionDays = boundedInteger(
			config.get<string>('IDENTITY_FAILURE_DETAIL_RETENTION_DAYS'),
			30,
			1,
			365,
			'IDENTITY_FAILURE_DETAIL_RETENTION_DAYS'
		);
		this.housekeepingIntervalMs = boundedInteger(
			config.get<string>('IDENTITY_HOUSEKEEPING_INTERVAL_MS'),
			60 * 60_000,
			60_000,
			24 * 60 * 60_000,
			'IDENTITY_HOUSEKEEPING_INTERVAL_MS'
		);
	}

	get apiEnabled(): boolean {
		return this.role === 'api';
	}

	get workerEnabled(): boolean {
		return this.role === 'worker';
	}

	get outboxPublisherEnabled(): boolean {
		return this.role === 'outbox-publisher';
	}

	get rabbitEnabled(): boolean {
		return this.workerEnabled || this.outboxPublisherEnabled;
	}
}
