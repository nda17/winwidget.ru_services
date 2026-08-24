import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { AllowPlatformShadow } from '../ownership/platform-ownership.service';
import { PlatformHealthService } from './platform-health.service';

@Controller('health')
@AllowPlatformShadow()
export class PlatformHealthController {
	constructor(private readonly health: PlatformHealthService) {}

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
