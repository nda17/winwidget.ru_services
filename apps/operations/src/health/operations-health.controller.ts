import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { OperationsHealthService } from './operations-health.service';

@Controller('health')
export class OperationsHealthController {
	constructor(private readonly health: OperationsHealthService) {}

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
