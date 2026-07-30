import { CampaignsHealthService } from './campaigns-health.service';
import { Controller, Get, Header, HttpCode } from '@nestjs/common';

@Controller('/health')
export class CampaignsHealthController {
	constructor(private readonly health: CampaignsHealthService) {}

	@Get('/live')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	liveness() {
		return this.health.liveness();
	}

	@Get('/ready')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	readiness() {
		return this.health.readiness();
	}
}
