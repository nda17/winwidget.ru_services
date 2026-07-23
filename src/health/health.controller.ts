import { Auth } from '@/auth/decorators/auth.decorator';
import { HealthService } from '@/health/health.service';
import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { Role } from '@prisma/client';

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

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('/admin')
	async getAdminHealth() {
		return this.healthService.getAdminHealth();
	}
}
