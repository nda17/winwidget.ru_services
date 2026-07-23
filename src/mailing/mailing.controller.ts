import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { SendAdminBroadcastDto } from '@/mailing/dto/send-admin-broadcast.dto';
import { MailingService } from '@/mailing/mailing.service';
import {
	Body,
	Controller,
	DefaultValuePipe,
	Get,
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
import { Request } from 'express';

@Controller('mailings')
export class MailingController {
	constructor(
		private readonly mailingService: MailingService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('admin/broadcast')
	async sendAdminBroadcast(
		@Body() dto: SendAdminBroadcastDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const result = await this.mailingService.createAdminBroadcast(
			adminId,
			dto
		);

		await this.adminEventLogService.record({
			adminId,
			section: 'MAILINGS',
			action: 'MAILING_BROADCAST_SEND',
			description: `Ручная рассылка: ${dto.subject.trim()}`,
			entityType: 'mailing',
			entityLabel: dto.subject.trim(),
			metadata: {
				audience: result.audience,
				channel: result.requestedChannel,
				campaignId: result.id,
				recipientCount: result.recipientCount,
				emailRecipientCount: result.emailRecipientCount,
				telegramRecipientCount: result.telegramRecipientCount,
				status: result.status
			},
			request
		});

		return result;
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
		const result = await this.mailingService.cancelCampaign(id);
		await this.adminEventLogService.record({
			adminId,
			section: 'MAILINGS',
			action: 'MAILING_BROADCAST_CANCEL',
			description: `Отмена рассылки: ${result.subject}`,
			entityType: 'mailing',
			entityId: result.id,
			entityLabel: result.subject,
			metadata: {
				campaignId: result.id,
				status: result.status,
				sentCount: result.sentCount,
				cancelledCount: result.cancelledCount
			},
			request
		});
		return result;
	}
}
