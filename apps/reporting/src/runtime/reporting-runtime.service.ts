import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const REPORTING_PROCESS_ROLES = [
	'all',
	'api',
	'worker',
	'publisher',
	'scheduler'
] as const;

export type ReportingProcessRole =
	(typeof REPORTING_PROCESS_ROLES)[number];

export function parseReportingProcessRole(
	value: string | undefined
): ReportingProcessRole {
	const role = value?.trim() || 'all';
	if (!REPORTING_PROCESS_ROLES.includes(role as ReportingProcessRole)) {
		throw new Error(
			`REPORTING_PROCESS_ROLE must be one of ${REPORTING_PROCESS_ROLES.join(', ')}`
		);
	}
	return role as ReportingProcessRole;
}

export function parseStrictBoolean(
	value: string | boolean | undefined,
	key: string,
	fallback: boolean
): boolean {
	if (value === undefined || value === '') return fallback;
	if (value === true || value === 'true') return true;
	if (value === false || value === 'false') return false;
	throw new Error(`${key} must be true or false`);
}

@Injectable()
export class ReportingRuntimeService {
	readonly role: ReportingProcessRole;
	readonly schedulerConfigured: boolean;

	constructor(config: ConfigService) {
		this.role = parseReportingProcessRole(
			config.get<string>('REPORTING_PROCESS_ROLE')
		);
		this.schedulerConfigured = parseStrictBoolean(
			config.get<string | boolean>('REPORTING_SCHEDULER_ENABLED'),
			'REPORTING_SCHEDULER_ENABLED',
			false
		);
	}

	get apiEnabled(): boolean {
		return this.role === 'all' || this.role === 'api';
	}

	get workerEnabled(): boolean {
		return this.role === 'all' || this.role === 'worker';
	}

	get publisherEnabled(): boolean {
		return this.role === 'all' || this.role === 'publisher';
	}

	get schedulerRoleEnabled(): boolean {
		return this.role === 'all' || this.role === 'scheduler';
	}

	get schedulerEnabled(): boolean {
		return this.schedulerRoleEnabled && this.schedulerConfigured;
	}

	get rabbitEnabled(): boolean {
		return this.workerEnabled || this.publisherEnabled;
	}
}
