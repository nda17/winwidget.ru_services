import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const CAMPAIGNS_PROCESS_ROLES = [
	'all',
	'api',
	'worker',
	'publisher'
] as const;

export type CampaignsProcessRole =
	(typeof CAMPAIGNS_PROCESS_ROLES)[number];

export function parseCampaignsProcessRole(
	value: string | undefined
): CampaignsProcessRole {
	const role = value?.trim() || 'all';
	if (!CAMPAIGNS_PROCESS_ROLES.includes(role as CampaignsProcessRole)) {
		throw new Error(
			`CAMPAIGNS_PROCESS_ROLE must be one of ${CAMPAIGNS_PROCESS_ROLES.join(', ')}`
		);
	}
	return role as CampaignsProcessRole;
}

@Injectable()
export class CampaignsRuntimeService {
	readonly role: CampaignsProcessRole;

	constructor(config: ConfigService) {
		this.role = parseCampaignsProcessRole(
			config.get<string>('CAMPAIGNS_PROCESS_ROLE')
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
