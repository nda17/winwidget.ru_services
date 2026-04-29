import { Auth } from '@/auth/decorators/auth.decorator';
import { SendAdminBroadcastDto } from '@/mailing/dto/send-admin-broadcast.dto';
import { MailingService } from '@/mailing/mailing.service';
import {
	Body,
	Controller,
	HttpCode,
	Post,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('mailings')
export class MailingController {
	constructor(private readonly mailingService: MailingService) {}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('admin/broadcast')
	async sendAdminBroadcast(@Body() dto: SendAdminBroadcastDto) {
		return this.mailingService.sendAdminBroadcast(dto);
	}
}
