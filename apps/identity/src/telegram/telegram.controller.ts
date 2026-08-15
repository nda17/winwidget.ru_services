import {
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Post,
	Req,
	Res,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/identity-client';
import type { Request, Response } from 'express';
import {
	TelegramCompleteDto,
	TelegramRequestDto,
	TelegramVerifyDto
} from '../auth/auth.dto';
import { Auth, CurrentUser, IdentityAuthGuard } from '../auth/auth.guard';
import { AuthRateLimitGuard } from '../auth/auth-rate-limit.guard';
import { RecaptchaAction, RecaptchaGuard } from '../auth/recaptcha.guard';
import { RefreshTokenService } from '../auth/refresh-token.service';
import {
	TelegramService,
	type TelegramWebhookUpdate
} from './telegram.service';

@Controller()
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class TelegramController {
	constructor(
		private readonly telegram: TelegramService,
		private readonly refresh: RefreshTokenService
	) {}

	@Post('auth/telegram/start')
	@HttpCode(200)
	@UseGuards(AuthRateLimitGuard, RecaptchaGuard)
	@RecaptchaAction('telegram_auth_start')
	startLogin() {
		return this.telegram.startLogin();
	}

	@Post('auth/telegram/verify')
	@HttpCode(200)
	@UseGuards(AuthRateLimitGuard, RecaptchaGuard)
	@RecaptchaAction('telegram_auth_verify')
	async verifyLogin(
		@Body() dto: TelegramVerifyDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const { refreshToken, ...body } = await this.telegram.verifyLogin(
			dto.requestId,
			dto.code,
			dto.referrerId,
			request
		);
		this.refresh.add(response, refreshToken);
		return body;
	}

	@Post('auth/telegram/complete')
	@HttpCode(200)
	@UseGuards(AuthRateLimitGuard)
	async completeLogin(
		@Body() dto: TelegramCompleteDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const result = await this.telegram.completeLogin(
			dto.requestId,
			dto.referrerId,
			request
		);
		if (!result.confirmed) return result;
		const { refreshToken, ...body } = result;
		this.refresh.add(response, refreshToken);
		return body;
	}

	@Post('auth/telegram/cancel')
	@HttpCode(200)
	@UseGuards(AuthRateLimitGuard)
	cancelLogin(@Body() dto: TelegramRequestDto) {
		return this.telegram.cancelLogin(dto.requestId);
	}

	@Post('telegram-auth/webhook')
	@HttpCode(200)
	authWebhook(
		@Body() update: TelegramWebhookUpdate,
		@Headers('x-telegram-bot-api-secret-token') secret?: string
	) {
		return this.telegram.handleAuthWebhook(update, secret);
	}

	@Post('telegram-bot/webhook')
	@HttpCode(200)
	infoWebhook(
		@Body() update: TelegramWebhookUpdate,
		@Headers('x-telegram-bot-api-secret-token') secret?: string
	) {
		return this.telegram.handleInfoWebhook(update, secret);
	}
}

@Controller('telegram-auth/admin')
@UseGuards(IdentityAuthGuard)
export class TelegramAdminController {
	constructor(private readonly telegram: TelegramService) {}

	@Get('settings')
	@Auth(Role.ADMIN)
	settings() {
		return this.telegram.adminSettings();
	}

	@Get('webhook/status')
	@Auth(Role.ADMIN)
	status() {
		return this.telegram.authWebhookStatus();
	}

	@Get('info-webhook/status')
	@Auth(Role.ADMIN)
	infoStatus() {
		return this.telegram.infoWebhookStatus();
	}

	@Post('webhook/reinstall')
	@HttpCode(200)
	@Auth(Role.ADMIN)
	reinstall(@CurrentUser('id') actorId: string, @Req() request: Request) {
		return this.telegram.reinstallAuthWebhook(actorId, request);
	}

	@Post('info-webhook/reinstall')
	@HttpCode(200)
	@Auth(Role.ADMIN)
	reinstallInfo(
		@CurrentUser('id') actorId: string,
		@Req() request: Request
	) {
		return this.telegram.reinstallInfoWebhook(actorId, request);
	}
}
