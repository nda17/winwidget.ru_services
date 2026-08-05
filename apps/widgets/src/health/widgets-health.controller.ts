import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { WidgetsHealthService } from './widgets-health.service';

@Controller('health')
export class WidgetsHealthController {
	constructor(private readonly health: WidgetsHealthService) {}

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
