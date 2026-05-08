import { AuthRateLimitGuard } from '@/auth/guards/auth-rate-limit.guard';
import {
	TelegramAuthService,
	type TelegramWebhookUpdate
} from '@/auth/telegram-auth/telegram-auth.service';
import { AuthService } from '@/auth/auth.service';
import { RefreshTokenService } from '@/auth/refresh-token.service';
import {
	Body,
	Controller,
	Headers,
	HttpCode,
	Post,
	Res,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Recaptcha } from '@nestlab/google-recaptcha';
import { IsString, Matches } from 'class-validator';
import { Response } from 'express';

class TelegramAuthVerifyDto {
	@IsString()
	requestId: string;

	@Matches(/^\d{4,6}$/, {
		message: 'Please enter a valid verification code'
	})
	@IsString()
	code: string;
}

@Controller()
export class TelegramAuthController {
	constructor(
		private readonly telegramAuthService: TelegramAuthService,
		private readonly authService: AuthService,
		private readonly refreshTokenService: RefreshTokenService
	) {}

	@UseGuards(AuthRateLimitGuard)
	@HttpCode(200)
	@Recaptcha({ action: 'telegram_auth_start' })
	@Post('auth/telegram/start')
	start() {
		return this.telegramAuthService.start();
	}

	@UseGuards(AuthRateLimitGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@HttpCode(200)
	@Recaptcha({ action: 'telegram_auth_verify' })
	@Post('auth/telegram/verify')
	async verify(
		@Body() dto: TelegramAuthVerifyDto,
		@Res({ passthrough: true }) res: Response
	) {
		const user = await this.telegramAuthService.verify(
			dto.requestId,
			dto.code
		);
		const { refreshToken, ...response } =
			await this.authService.buildResponseObject(user);
		this.refreshTokenService.addRefreshTokenToResponse(res, refreshToken);
		return response;
	}

	@HttpCode(200)
	@Post('telegram-auth/webhook')
	handleWebhook(
		@Body() update: TelegramWebhookUpdate,
		@Headers('x-telegram-bot-api-secret-token') secret?: string
	) {
		return this.telegramAuthService.handleWebhook(update, secret);
	}
}
