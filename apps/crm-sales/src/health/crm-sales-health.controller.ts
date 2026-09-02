import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { CrmSalesHealthService } from './crm-sales-health.service';

@Controller('health')
export class CrmSalesHealthController {
	constructor(private readonly health: CrmSalesHealthService) {}

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

	@Get('revision')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	revision() {
		return this.health.revision();
	}
}
