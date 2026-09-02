import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export function parseCrmAccessPort(value: string | undefined): number {
	const port = value?.trim() ? Number(value) : 5300;
	if (!Number.isInteger(port) || port !== 5300) {
		throw new Error('CRM_ACCESS_PORT must be the canonical port 5300');
	}
	return port;
}

@Injectable()
export class CrmAccessRuntimeService {
	readonly port: number;

	constructor(config: ConfigService) {
		this.port = parseCrmAccessPort(config.get<string>('CRM_ACCESS_PORT'));
	}
}
