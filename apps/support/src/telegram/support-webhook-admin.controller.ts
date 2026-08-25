import {
	Controller,
	Get,
	Header,
	Post,
	Req,
	UseGuards
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentSupportActor } from '../auth/current-support-actor.decorator';
import { SupportAuth, SupportAuthGuard } from '../auth/support-auth.guard';
import type { SupportActor } from '../auth/support-request';
import { SupportWebhookAdminService } from './support-webhook-admin.service';

@Controller('support/admin/webhook')
@UseGuards(SupportAuthGuard)
export class SupportWebhookAdminController {
	constructor(private readonly webhook: SupportWebhookAdminService) {}

	@Get('status')
	@Header('Cache-Control', 'no-store')
	@SupportAuth(['ADMIN', 'DEV'])
	status() {
		return this.webhook.status();
	}

	@Post('reinstall')
	@Header('Cache-Control', 'no-store')
	@SupportAuth(['DEV'])
	reinstall(
		@CurrentSupportActor() actor: SupportActor,
		@Req() request: Request
	) {
		return this.webhook.reinstall(actor, request);
	}
}
