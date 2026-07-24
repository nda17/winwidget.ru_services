import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { MessagingAdminService } from '@/messaging/messaging-admin.service';
import {
	Controller,
	Get,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Req
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

@Controller('messaging/admin')
export class MessagingAdminController {
	constructor(
		private readonly messagingAdminService: MessagingAdminService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@Get('overview')
	@Auth([Role.ADMIN, Role.DEV])
	@HttpCode(200)
	getOverview() {
		return this.messagingAdminService.getOverview();
	}

	@Get('failures')
	@Auth(Role.DEV)
	@HttpCode(200)
	getFailures(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('integration') integration?: string,
		@Query('status') status?: string
	) {
		return this.messagingAdminService.getFailures(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{ integration, status }
		);
	}

	@Post('failures/:id/retry')
	@Auth(Role.DEV)
	@HttpCode(200)
	async retryFailure(
		@Param('id', new ParseUUIDPipe()) id: string,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const result = await this.messagingAdminService.retryFailure(id);
		await this.adminEventLogService.record({
			adminId,
			section: 'MESSAGING',
			action: 'MESSAGING_FAILURE_RETRY',
			description: `Повторно отправлено событие интеграции ${result.integration}`,
			entityType: 'integration_delivery_failure',
			entityId: result.id,
			entityLabel: result.integration,
			metadata: {
				eventId: result.eventId,
				integration: result.integration
			},
			request
		});
		return result;
	}
}
