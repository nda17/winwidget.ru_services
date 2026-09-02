import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { CrmIntakeHealthService } from './crm-intake-health.service';

@Controller('health')
export class CrmIntakeHealthController {
	constructor(private readonly health: CrmIntakeHealthService) {}

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
