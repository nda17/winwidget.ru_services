import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { CrmCustomersHealthService } from './crm-customers-health.service';

@Controller('health')
export class CrmCustomersHealthController {
	constructor(private readonly health: CrmCustomersHealthService) {}

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
