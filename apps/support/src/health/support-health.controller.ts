import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { AllowSupportShadow } from '../ownership/support-ownership.service';
import { SupportHealthService } from './support-health.service';

@Controller('health')
@AllowSupportShadow()
export class SupportHealthController {
	constructor(private readonly health: SupportHealthService) {}

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
