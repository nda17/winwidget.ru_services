import {
	Controller,
	Headers,
	HttpCode,
	Post,
	RawBodyRequest,
	Req
} from '@nestjs/common';
import type { Request } from 'express';
import { SupportWebhookService } from './support-webhook.service';

@Controller('telegram-bot')
export class SupportWebhookController {
	constructor(private readonly webhook: SupportWebhookService) {}

	@Post('support-webhook')
	@HttpCode(200)
	admit(
		@Req() request: RawBodyRequest<Request>,
		@Headers('x-telegram-bot-api-secret-token') secret?: string
	) {
		return this.webhook.admit(request.rawBody, secret);
	}
}
