import {
	Controller,
	Get,
	Header,
	HttpCode,
	UseGuards
} from '@nestjs/common';
import { PlatformInternalGuard } from '../auth/platform-internal.guard';
import { AllowPlatformShadow } from '../ownership/platform-ownership.service';
import { PlatformMessagingAdminService } from './platform-messaging-admin.service';

@Controller('internal/v1/platform')
@UseGuards(PlatformInternalGuard)
@AllowPlatformShadow()
export class PlatformInternalController {
	constructor(private readonly messaging: PlatformMessagingAdminService) {}

	@Get('messaging/overview')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	overview() {
		return this.messaging.overview();
	}
}
