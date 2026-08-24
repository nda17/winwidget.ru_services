import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const PLATFORM_PROCESS_ROLES = ['api', 'outbox-publisher'] as const;
export type PlatformProcessRole = (typeof PLATFORM_PROCESS_ROLES)[number];

const ROLE_PORT_KEYS: Record<PlatformProcessRole, string> = {
	api: 'PLATFORM_API_PORT',
	'outbox-publisher': 'PLATFORM_OUTBOX_PUBLISHER_PORT'
};

const ROLE_DEFAULT_PORTS: Record<PlatformProcessRole, number> = {
	api: 5000,
	'outbox-publisher': 5001
};

export function parsePlatformProcessRole(
	value: string | undefined
): PlatformProcessRole {
	const role = value?.trim() || 'api';
	if (!PLATFORM_PROCESS_ROLES.includes(role as PlatformProcessRole)) {
		throw new Error(
			`PLATFORM_PROCESS_ROLE must be one of ${PLATFORM_PROCESS_ROLES.join(', ')}`
		);
	}
	return role as PlatformProcessRole;
}

export function parsePlatformPort(
	role: PlatformProcessRole,
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

export function parsePlatformBoundedInteger(
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

export function parsePlatformStrictBoolean(
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
export class PlatformRuntimeService {
	readonly role: PlatformProcessRole;
	readonly outboxBatchSize: number;
	readonly outboxPollIntervalMs: number;
	readonly outboxRetentionDays: number;

	constructor(config: ConfigService) {
		this.role = parsePlatformProcessRole(
			config.get<string>('PLATFORM_PROCESS_ROLE')
		);
		this.outboxBatchSize = parsePlatformBoundedInteger(
			config.get<string>('PLATFORM_OUTBOX_BATCH_SIZE'),
			50,
			1,
			1_000,
			'PLATFORM_OUTBOX_BATCH_SIZE'
		);
		this.outboxPollIntervalMs = parsePlatformBoundedInteger(
			config.get<string>('PLATFORM_OUTBOX_POLL_INTERVAL_MS'),
			1_000,
			100,
			60_000,
			'PLATFORM_OUTBOX_POLL_INTERVAL_MS'
		);
		this.outboxRetentionDays = parsePlatformBoundedInteger(
			config.get<string>('PLATFORM_OUTBOX_RETENTION_DAYS'),
			7,
			1,
			365,
			'PLATFORM_OUTBOX_RETENTION_DAYS'
		);
	}

	get apiEnabled(): boolean {
		return this.role === 'api';
	}

	get outboxPublisherEnabled(): boolean {
		return this.role === 'outbox-publisher';
	}
}
