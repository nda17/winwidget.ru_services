import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const WIDGETS_PROCESS_ROLES = [
	'all',
	'api',
	'worker',
	'publisher'
] as const;

export type WidgetsProcessRole = (typeof WIDGETS_PROCESS_ROLES)[number];

export function parseWidgetsProcessRole(
	value: string | undefined
): WidgetsProcessRole {
	const role = value?.trim() || 'all';
	if (!WIDGETS_PROCESS_ROLES.includes(role as WidgetsProcessRole)) {
		throw new Error(
			`WIDGETS_PROCESS_ROLE must be one of ${WIDGETS_PROCESS_ROLES.join(', ')}`
		);
	}
	return role as WidgetsProcessRole;
}

@Injectable()
export class WidgetsRuntimeService {
	readonly role: WidgetsProcessRole;

	constructor(config: ConfigService) {
		this.role = parseWidgetsProcessRole(
			config.get<string>('WIDGETS_PROCESS_ROLE')
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

	get rabbitEnabled(): boolean {
		return this.workerEnabled || this.publisherEnabled;
	}
}
