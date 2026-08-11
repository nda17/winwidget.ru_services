import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const BILLING_PROCESS_ROLES = [
	'api',
	'scheduler',
	'worker',
	'outbox-publisher'
] as const;

export type BillingProcessRole = (typeof BILLING_PROCESS_ROLES)[number];

const ROLE_PORT_KEYS: Record<BillingProcessRole, string> = {
	api: 'BILLING_API_PORT',
	scheduler: 'BILLING_SCHEDULER_PORT',
	worker: 'BILLING_WORKER_PORT',
	'outbox-publisher': 'BILLING_OUTBOX_PUBLISHER_PORT'
};

const ROLE_DEFAULT_PORTS: Record<BillingProcessRole, number> = {
	api: 4800,
	scheduler: 4801,
	worker: 4802,
	'outbox-publisher': 4803
};

export function parseBillingProcessRole(
	value: string | undefined
): BillingProcessRole {
	const role = value?.trim() || 'api';
	if (!BILLING_PROCESS_ROLES.includes(role as BillingProcessRole)) {
		throw new Error(
			`BILLING_PROCESS_ROLE must be one of ${BILLING_PROCESS_ROLES.join(', ')}`
		);
	}
	return role as BillingProcessRole;
}

export function parseBillingPort(
	role: BillingProcessRole,
	environment: NodeJS.ProcessEnv = process.env
): number {
	const key = ROLE_PORT_KEYS[role];
	const raw = environment[key]?.trim();
	const port = raw ? Number(raw) : ROLE_DEFAULT_PORTS[role];
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`${key} must be an integer between 1 and 65535`);
	}
	return port;
}

@Injectable()
export class BillingRuntimeService {
	readonly role: BillingProcessRole;
	readonly prefetch: number;
	readonly outboxBatchSize: number;
	readonly outboxPollIntervalMs: number;
	readonly outboxRetentionDays: number;
	readonly receiptRetentionDays: number;
	readonly failureDetailRetentionDays: number;

	constructor(config: ConfigService) {
		this.role = parseBillingProcessRole(
			config.get<string>('BILLING_PROCESS_ROLE')
		);
		this.prefetch = parseBoundedInteger(
			config.get<string>('BILLING_PREFETCH'),
			10,
			1,
			1_000,
			'BILLING_PREFETCH'
		);
		this.outboxBatchSize = parseBoundedInteger(
			config.get<string>('BILLING_OUTBOX_BATCH_SIZE'),
			50,
			1,
			1_000,
			'BILLING_OUTBOX_BATCH_SIZE'
		);
		this.outboxPollIntervalMs = parseBoundedInteger(
			config.get<string>('BILLING_OUTBOX_POLL_INTERVAL_MS'),
			1_000,
			100,
			60_000,
			'BILLING_OUTBOX_POLL_INTERVAL_MS'
		);
		this.outboxRetentionDays = parseBoundedInteger(
			config.get<string>('BILLING_OUTBOX_RETENTION_DAYS'),
			7,
			1,
			365,
			'BILLING_OUTBOX_RETENTION_DAYS'
		);
		this.receiptRetentionDays = parseBoundedInteger(
			config.get<string>('BILLING_RECEIPT_RETENTION_DAYS'),
			90,
			1,
			3_650,
			'BILLING_RECEIPT_RETENTION_DAYS'
		);
		this.failureDetailRetentionDays = parseBoundedInteger(
			config.get<string>('BILLING_FAILURE_DETAIL_RETENTION_DAYS'),
			30,
			1,
			365,
			'BILLING_FAILURE_DETAIL_RETENTION_DAYS'
		);
	}

	get apiEnabled(): boolean {
		return this.role === 'api';
	}

	get schedulerEnabled(): boolean {
		return this.role === 'scheduler';
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

export function parseBoundedInteger(
	raw: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string
): number {
	const value = raw?.trim() ? Number(raw.trim()) : fallback;
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(
			`${name} must be an integer between ${minimum} and ${maximum}`
		);
	}
	return value;
}

export function parseStrictBoolean(
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
