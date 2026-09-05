import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type CrmAccessRole = 'api' | 'worker' | 'outbox-publisher';
export function parseCrmAccessRole(
	value: string | undefined
): CrmAccessRole {
	const role = value?.trim() || 'api';
	if (!['api', 'worker', 'outbox-publisher'].includes(role))
		throw new Error('CRM_ACCESS_PROCESS_ROLE is invalid');
	return role as CrmAccessRole;
}
export function parseCrmAccessPort(
	value: string | undefined,
	role: CrmAccessRole = 'api'
): number {
	const expected = { api: 5300, worker: 5301, 'outbox-publisher': 5302 }[
		role
	];
	const port = value?.trim() ? Number(value) : expected;
	if (!Number.isInteger(port) || port !== expected) {
		throw new Error(
			`CRM_ACCESS_PORT must be the canonical port ${expected}`
		);
	}
	return port;
}

@Injectable()
export class CrmAccessRuntimeService {
	readonly port: number;
	readonly role: CrmAccessRole;
	readonly workerEnabled: boolean;
	readonly publisherEnabled: boolean;
	readonly rabbitEnabled: boolean;

	constructor(config: ConfigService) {
		this.role = parseCrmAccessRole(
			config.get<string>('CRM_ACCESS_PROCESS_ROLE')
		);
		this.port = parseCrmAccessPort(
			config.get<string>('CRM_ACCESS_PORT'),
			this.role
		);
		this.workerEnabled = this.role === 'worker';
		this.publisherEnabled = this.role === 'outbox-publisher';
		this.rabbitEnabled = this.workerEnabled || this.publisherEnabled;
	}
}
