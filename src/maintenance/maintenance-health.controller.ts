import { MaintenanceHealthService } from '@/maintenance/maintenance-health.service';
import { Controller, Get, Header, HttpCode } from '@nestjs/common';

@Controller('/health')
export class MaintenanceHealthController {
	constructor(
		private readonly maintenanceHealthService: MaintenanceHealthService
	) {}

	@Get('/live')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	getLivenessHealth() {
		return this.maintenanceHealthService.getLivenessHealth();
	}

	@Get('/ready')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	getReadinessHealth() {
		return this.maintenanceHealthService.getReadinessHealth();
	}
}
