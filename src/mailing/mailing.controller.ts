import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { SendAdminBroadcastDto } from '@/mailing/dto/send-admin-broadcast.dto';
import { MailingService } from '@/mailing/mailing.service';
import {
	Body,
	Controller,
	HttpCode,
	Post,
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
		const result = await this.mailingService.sendAdminBroadcast(dto);

		await this.adminEventLogService.record({
			adminId,
			section: 'MAILINGS',
			action: 'MAILING_BROADCAST_SEND',
			description: `Ручная рассылка: ${dto.subject.trim()}`,
			entityType: 'mailing',
			entityLabel: dto.subject.trim(),
			metadata: {
				audience: result.audience,
				recipientCount: result.recipientCount,
				sentCount: result.sentCount,
				failedCount: result.failedCount,
				executedAt: result.executedAt
			},
			request
		});

		return result;
	}
}
