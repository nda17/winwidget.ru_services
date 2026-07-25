import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { SendAdminBroadcastDto } from '@/mailing/dto/send-admin-broadcast.dto';
import { MailingService } from '@/mailing/mailing.service';
import {
	Body,
	BadRequestException,
	Controller,
	DefaultValuePipe,
	Get,
	Headers,
	HttpCode,
	Param,
	ParseIntPipe,
	Post,
	Query,
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { isUUID } from 'class-validator';
import { Request } from 'express';

@Controller('mailings')
export class MailingController {
	constructor(private readonly mailingService: MailingService) {}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('admin/broadcast')
	async sendAdminBroadcast(
		@Body() dto: SendAdminBroadcastDto,
		@CurrentUser('id') adminId: string,
		@Headers('idempotency-key') idempotencyKey: string | undefined,
		@Req() request: Request
	) {
		if (!idempotencyKey || !isUUID(idempotencyKey)) {
			throw new BadRequestException(
				'Заголовок Idempotency-Key должен содержать UUID'
			);
		}

		return this.mailingService.createAdminBroadcast(
			adminId,
			dto,
			idempotencyKey,
			request
		);
	}

	@Auth(Role.ADMIN)
	@Get('admin/campaigns')
	getCampaigns(
		@Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
		@Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number
	) {
		return this.mailingService.getCampaigns(page, limit);
	}

	@Auth(Role.ADMIN)
	@Get('admin/campaigns/:id')
	getCampaign(@Param('id') id: string) {
		return this.mailingService.getCampaign(id);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Post('admin/campaigns/:id/cancel')
	async cancelCampaign(
		@Param('id') id: string,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.mailingService.cancelCampaign(id, adminId, request);
	}
}
