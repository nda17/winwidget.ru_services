import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { SupportInternalGuard } from '../auth/support-internal.guard';
import { SupportMessagingAdminService } from './support-messaging-admin.service';

@Controller('internal/v1/support/messaging')
@UseGuards(SupportInternalGuard)
export class SupportInternalController {
	constructor(private readonly messaging: SupportMessagingAdminService) {}

	@Get('overview')
	@Header('Cache-Control', 'no-store')
	overview() {
		return this.messaging.overview();
	}
}
