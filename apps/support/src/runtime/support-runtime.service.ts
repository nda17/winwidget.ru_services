import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const SUPPORT_PROCESS_ROLES = [
	'api',
	'worker',
	'outbox-publisher'
] as const;
export type SupportProcessRole = (typeof SUPPORT_PROCESS_ROLES)[number];

const ROLE_PORTS: Record<SupportProcessRole, number> = {
	api: 5100,
	worker: 5101,
	'outbox-publisher': 5102
};

export function parseSupportProcessRole(
	value: string | undefined
): SupportProcessRole {
	const role = value?.trim() || 'api';
	if (!SUPPORT_PROCESS_ROLES.includes(role as SupportProcessRole)) {
		throw new Error(
			`SUPPORT_PROCESS_ROLE must be one of ${SUPPORT_PROCESS_ROLES.join(', ')}`
		);
	}
	return role as SupportProcessRole;
}

export function parseSupportPort(
	role: SupportProcessRole,
	environment: NodeJS.ProcessEnv = process.env
): number {
	const raw = environment.SUPPORT_PORT?.trim();
	const port = raw ? Number(raw) : ROLE_PORTS[role];
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error('SUPPORT_PORT must be an integer between 1 and 65535');
	}
	if (role === 'api' && port !== 5100) {
		throw new Error('Support API must listen on canonical port 5100');
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
export class SupportRuntimeService {
	readonly role: SupportProcessRole;
	readonly prefetch: number;
	readonly inboxLeaseMs: number;
	readonly outboxBatchSize: number;
	readonly outboxPollIntervalMs: number;
	readonly outboxRetentionDays: number;
	readonly receiptRetentionDays: number;
	readonly failureRetentionDays: number;

	constructor(config: ConfigService) {
		this.role = parseSupportProcessRole(
			config.get<string>('SUPPORT_PROCESS_ROLE')
		);
		this.prefetch = boundedInteger(
			config.get<string>('SUPPORT_PREFETCH'),
			10,
			1,
			1000,
			'SUPPORT_PREFETCH'
		);
		this.inboxLeaseMs = boundedInteger(
			config.get<string>('SUPPORT_INBOX_LEASE_MS'),
			60_000,
			5_000,
			10 * 60_000,
			'SUPPORT_INBOX_LEASE_MS'
		);
		this.outboxBatchSize = boundedInteger(
			config.get<string>('SUPPORT_OUTBOX_BATCH_SIZE'),
			50,
			1,
			1000,
			'SUPPORT_OUTBOX_BATCH_SIZE'
		);
		this.outboxPollIntervalMs = boundedInteger(
			config.get<string>('SUPPORT_OUTBOX_POLL_INTERVAL_MS'),
			1000,
			100,
			60_000,
			'SUPPORT_OUTBOX_POLL_INTERVAL_MS'
		);
		this.outboxRetentionDays = boundedInteger(
			config.get<string>('SUPPORT_OUTBOX_RETENTION_DAYS'),
			7,
			1,
			365,
			'SUPPORT_OUTBOX_RETENTION_DAYS'
		);
		this.receiptRetentionDays = boundedInteger(
			config.get<string>('SUPPORT_RECEIPT_RETENTION_DAYS'),
			90,
			1,
			3650,
			'SUPPORT_RECEIPT_RETENTION_DAYS'
		);
		this.failureRetentionDays = boundedInteger(
			config.get<string>('SUPPORT_FAILURE_DETAIL_RETENTION_DAYS'),
			30,
			1,
			365,
			'SUPPORT_FAILURE_DETAIL_RETENTION_DAYS'
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
