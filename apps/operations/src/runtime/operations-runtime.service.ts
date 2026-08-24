import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const OPERATIONS_PROCESS_ROLES = [
	'api',
	'worker',
	'outbox-publisher'
] as const;
export type OperationsProcessRole =
	(typeof OPERATIONS_PROCESS_ROLES)[number];

const ROLE_PORT_KEYS: Record<OperationsProcessRole, string> = {
	api: 'OPERATIONS_API_PORT',
	worker: 'OPERATIONS_WORKER_PORT',
	'outbox-publisher': 'OPERATIONS_OUTBOX_PUBLISHER_PORT'
};
const ROLE_DEFAULT_PORTS: Record<OperationsProcessRole, number> = {
	api: 5200,
	worker: 5201,
	'outbox-publisher': 5202
};

export function parseOperationsProcessRole(
	value: string | undefined
): OperationsProcessRole {
	const role = value?.trim() || 'api';
	if (!OPERATIONS_PROCESS_ROLES.includes(role as OperationsProcessRole)) {
		throw new Error(
			`OPERATIONS_PROCESS_ROLE must be one of ${OPERATIONS_PROCESS_ROLES.join(', ')}`
		);
	}
	return role as OperationsProcessRole;
}

export function parseOperationsPort(
	role: OperationsProcessRole,
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

export function parseOperationsBoundedInteger(
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

export function parseOperationsStrictBoolean(
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
export class OperationsRuntimeService {
	readonly role: OperationsProcessRole;
	readonly outboxBatchSize: number;
	readonly outboxPollIntervalMs: number;
	readonly auditReceiptLeaseMs: number;
	readonly auditRetryDelayMs: number;
	readonly auditMaxRetryAttempts: number;

	constructor(config: ConfigService) {
		this.role = parseOperationsProcessRole(
			config.get<string>('OPERATIONS_PROCESS_ROLE')
		);
		this.outboxBatchSize = parseOperationsBoundedInteger(
			config.get<string>('OPERATIONS_OUTBOX_BATCH_SIZE'),
			50,
			1,
			1_000,
			'OPERATIONS_OUTBOX_BATCH_SIZE'
		);
		this.outboxPollIntervalMs = parseOperationsBoundedInteger(
			config.get<string>('OPERATIONS_OUTBOX_POLL_INTERVAL_MS'),
			1_000,
			100,
			60_000,
			'OPERATIONS_OUTBOX_POLL_INTERVAL_MS'
		);
		this.auditReceiptLeaseMs = parseOperationsBoundedInteger(
			config.get<string>('OPERATIONS_AUDIT_RECEIPT_LEASE_MS'),
			60_000,
			5_000,
			15 * 60_000,
			'OPERATIONS_AUDIT_RECEIPT_LEASE_MS'
		);
		this.auditRetryDelayMs = parseOperationsBoundedInteger(
			config.get<string>('OPERATIONS_AUDIT_RETRY_DELAY_MS'),
			30_000,
			1_000,
			60 * 60_000,
			'OPERATIONS_AUDIT_RETRY_DELAY_MS'
		);
		this.auditMaxRetryAttempts = parseOperationsBoundedInteger(
			config.get<string>('OPERATIONS_AUDIT_MAX_RETRY_ATTEMPTS'),
			4,
			0,
			20,
			'OPERATIONS_AUDIT_MAX_RETRY_ATTEMPTS'
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
