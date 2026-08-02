import { ReportingHealthService } from './reporting-health.service';
import { Controller, Get, Header, HttpCode } from '@nestjs/common';

@Controller('/health')
export class ReportingHealthController {
	constructor(private readonly health: ReportingHealthService) {}

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
