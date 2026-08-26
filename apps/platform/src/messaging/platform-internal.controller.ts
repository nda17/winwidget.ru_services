import {
	Controller,
	Get,
	Header,
	HttpCode,
	UseGuards
} from '@nestjs/common';
import { PlatformInternalGuard } from '../auth/platform-internal.guard';
import { PlatformMessagingAdminService } from './platform-messaging-admin.service';

@Controller('internal/v1/platform')
@UseGuards(PlatformInternalGuard)
export class PlatformInternalController {
	constructor(private readonly messaging: PlatformMessagingAdminService) {}

	@Get('messaging/overview')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	overview() {
		return this.messaging.overview();
	}
}
