import { NotificationDeliveryHealthService } from './notification-delivery-health.service';
import { Controller, Get, Header, HttpCode } from '@nestjs/common';

@Controller('/health')
export class NotificationDeliveryHealthController {
	constructor(
		private readonly healthService: NotificationDeliveryHealthService
	) {}

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
}
