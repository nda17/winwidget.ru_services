import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import {
	BadRequestException,
	Controller,
	Get,
	HttpCode,
	Param,
	UseGuards
} from '@nestjs/common';
import { CoreIdentityInternalGuard } from './core-identity-internal.guard';

@Controller('internal/v1/identity')
@UseGuards(CoreIdentityInternalGuard)
export class CoreIdentityInternalController {
	constructor(private readonly adminEvents: AdminEventLogService) {}

	@Get('users/:userId/admin-events/overview')
	@HttpCode(200)
	activity(@Param('userId') userId: string) {
		if (
			!userId ||
			userId.length > 256 ||
			/[\s\x00-\x1f\x7f]/.test(userId)
		) {
			throw new BadRequestException('Invalid userId');
		}
		return this.adminEvents.getUserActivity(userId);
	}
}
