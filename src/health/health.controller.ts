import { Auth } from '@/auth/decorators/auth.decorator';
import { HealthService } from '@/health/health.service';
import { Controller, Get, Header, HttpCode } from '@nestjs/common';

@Controller('/health')
export class HealthController {
	constructor(private readonly healthService: HealthService) {}

	@Get('/deployment')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	getDeploymentHealth() {
		return {
			service: 'api',
			revision: process.env.APP_REVISION || 'unknown'
		};
	}

	@Get('/live')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	getLivenessHealth() {
		return this.healthService.getLivenessHealth();
	}

	@Get('/ready')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	getReadinessHealth() {
		return this.healthService.getReadinessHealth();
	}

	@HttpCode(200)
	@Auth('ADMIN')
	@Get('/admin')
	async getAdminHealth() {
		return this.healthService.getAdminHealth();
	}
}
