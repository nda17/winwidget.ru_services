import { Auth } from '@/auth/decorators/auth.decorator';
import { HealthService } from '@/health/health.service';
import { Controller, Get, HttpCode } from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('/health')
export class HealthController {
	constructor(private readonly healthService: HealthService) {}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('/admin')
	async getAdminHealth() {
		return this.healthService.getAdminHealth();
	}
}
