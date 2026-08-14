import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { IdentityHealthService } from './identity-health.service';

@Controller('health')
export class IdentityHealthController {
	constructor(private readonly health: IdentityHealthService) {}

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

	@Get('ownership')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	ownership() {
		return this.health.ownership(true);
	}
}
