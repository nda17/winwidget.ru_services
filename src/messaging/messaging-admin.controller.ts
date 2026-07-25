import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { CloseMessagingFailureDto } from '@/messaging/dto/close-messaging-failure.dto';
import { MessagingAdminService } from '@/messaging/messaging-admin.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

@Controller('messaging/admin')
export class MessagingAdminController {
	constructor(
		private readonly messagingAdminService: MessagingAdminService
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
		@Query('category') category?: string,
		@Query('status') status?: string
	) {
		return this.messagingAdminService.getFailures(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{ integration, category, status }
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
		return this.messagingAdminService.retryFailure(id, adminId, request);
	}

	@Post('failures/:id/close')
	@Auth(Role.DEV)
	@HttpCode(200)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async closeFailure(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() dto: CloseMessagingFailureDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const result = await this.messagingAdminService.closeFailure(
			id,
			adminId,
			dto.comment,
			request
		);
		return result;
	}
}
