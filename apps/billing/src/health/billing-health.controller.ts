import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { BillingHealthService } from './billing-health.service';

@Controller('health')
export class BillingHealthController {
	constructor(private readonly health: BillingHealthService) {}

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
