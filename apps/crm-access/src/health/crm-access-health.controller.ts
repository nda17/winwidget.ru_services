import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { CrmAccessHealthService } from './crm-access-health.service';

@Controller('health')
export class CrmAccessHealthController {
	constructor(private readonly health: CrmAccessHealthService) {}

	@Get('live')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	live() {
		return this.health.liveness();
	}

	@Get('ready')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	ready() {
		return this.health.readiness();
	}
}
