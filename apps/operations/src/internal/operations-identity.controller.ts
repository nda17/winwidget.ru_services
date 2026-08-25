import {
	BadRequestException,
	Controller,
	Get,
	HttpCode,
	Param,
	UseGuards
} from '@nestjs/common';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import { OperationsOwnershipService } from '../ownership/operations-ownership.service';
import { OperationsIdentityGuard } from './operations-identity.guard';

@Controller('internal/v1/identity')
@UseGuards(OperationsIdentityGuard)
export class OperationsIdentityController {
	constructor(
		private readonly adminEvents: AdminEventLogService,
		private readonly ownership: OperationsOwnershipService
	) {}

	@Get('users/:userId/admin-events/overview')
	@HttpCode(200)
	async activity(@Param('userId') userId: string) {
		await this.ownership.assertActive();
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
