import { AuthService } from '@/auth/auth.service';
import { AuthDto } from '@/auth/dto/auth.dto';
import { EmailRegisterDto } from '@/auth/dto/email-register.dto';
import { PhoneLoginDto } from '@/auth/dto/phone-login.dto';
import { PhoneRegisterDto } from '@/auth/dto/phone-register.dto';
import { ResendEmailCodeDto } from '@/auth/dto/resend-email-code.dto';
import { RestorePasswordDto } from '@/auth/dto/restore-password.dto';
import { SendPhoneCodeDto } from '@/auth/dto/send-phone-code.dto';
import { RefreshTokenService } from '@/auth/refresh-token.service';
import { AuthRateLimitGuard } from '@/auth/guards/auth-rate-limit.guard';
import {
	Body,
	Controller,
	HttpCode,
	NotFoundException,
	Patch,
	Post,
	Req,
	Res,
	UnauthorizedException,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Recaptcha } from '@nestlab/google-recaptcha';
import { Request, Response } from 'express';

@Controller()
export class AuthController {
	constructor(
		private readonly authService: AuthService,
		private readonly refreshTokenService: RefreshTokenService
	) {}

	@UseGuards(AuthRateLimitGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@HttpCode(200)
	@Recaptcha({ action: 'login' })
	@Post('auth/login')
	async login(
		@Body() dto: AuthDto,
		@Res({ passthrough: true }) res: Response
	) {
		const { refreshToken, ...response } =
			await this.authService.login(dto);
		this.refreshTokenService.addRefreshTokenToResponse(res, refreshToken);
		return response;
	}

	@UseGuards(AuthRateLimitGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@HttpCode(200)
	@Recaptcha({ action: 'register' })
	@Post('auth/register')
	async register(@Body() dto: AuthDto) {
		return this.authService.register(dto);
	}

	@UseGuards(AuthRateLimitGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@HttpCode(200)
	@Recaptcha({ action: 'email_register' })
	@Post('auth/email/register')
	async registerByEmail(
		@Body() dto: EmailRegisterDto,
		@Res({ passthrough: true }) res: Response
	) {
		const { refreshToken, ...response } =
			await this.authService.registerByEmail(dto);

		this.refreshTokenService.addRefreshTokenToResponse(res, refreshToken);

		return response;
	}

	@UseGuards(AuthRateLimitGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@HttpCode(200)
	@Recaptcha({ action: 'email_resend_code' })
	@Post('auth/email/resend-code')
	async resendEmailCode(@Body() dto: ResendEmailCodeDto) {
		return this.authService.resendEmailCode(dto);
	}

	@UseGuards(AuthRateLimitGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@HttpCode(200)
	@Recaptcha({ action: 'phone_send_code' })
	@Post('auth/phone/send-code')
	async sendPhoneCode(@Body() dto: SendPhoneCodeDto, @Req() req: Request) {
		const ip = this.getClientIp(req);
		return this.authService.sendPhoneCode(dto, ip);
	}

	@UseGuards(AuthRateLimitGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@HttpCode(200)
	@Recaptcha({ action: 'phone_register' })
	@Post('auth/phone/register')
	async registerByPhone(
		@Body() dto: PhoneRegisterDto,
		@Res({ passthrough: true }) res: Response
	) {
		const { refreshToken, ...response } =
			await this.authService.registerByPhone(dto);

		this.refreshTokenService.addRefreshTokenToResponse(res, refreshToken);
		return response;
	}

	@UseGuards(AuthRateLimitGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@HttpCode(200)
	@Recaptcha({ action: 'phone_login' })
	@Post('auth/phone/login')
	async loginByPhone(
		@Body() dto: PhoneLoginDto,
		@Res({ passthrough: true }) res: Response
	) {
		const { refreshToken, ...response } =
			await this.authService.loginByPhone(dto);

		this.refreshTokenService.addRefreshTokenToResponse(res, refreshToken);
		return response;
	}

	@UseGuards(AuthRateLimitGuard)
	@HttpCode(200)
	@Recaptcha({ action: 'restore_password' })
	@Patch('auth/restore-password')
	async restorePassword(@Body() dto: RestorePasswordDto) {
		if (!dto || (!dto.email && !dto.phone)) {
			throw new NotFoundException('Email or phone not passed');
		}

		return this.authService.restorePassword(dto);
	}

	@UseGuards(AuthRateLimitGuard)
	@HttpCode(200)
	@Post('auth/access-token')
	async getNewTokens(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		const refreshTokenFromCookies =
			req.cookies[this.refreshTokenService.REFRESH_TOKEN_NAME];

		if (!refreshTokenFromCookies) {
			this.refreshTokenService.removeRefreshTokenFromResponse(res);
			throw new UnauthorizedException('Refresh token not passed');
		}

		const { refreshToken, ...response } =
			await this.authService.getNewTokens(refreshTokenFromCookies);

		this.refreshTokenService.addRefreshTokenToResponse(res, refreshToken);

		return response;
	}

	@HttpCode(200)
	@Post('auth/logout')
	async logout(
		@Req() req: Request,
		@Res({ passthrough: true }) res: Response
	) {
		const refreshTokenFromCookies =
			req.cookies[this.refreshTokenService.REFRESH_TOKEN_NAME];

		await this.authService.logout(refreshTokenFromCookies);
		this.refreshTokenService.removeRefreshTokenFromResponse(res);

		return true;
	}

	private getClientIp(request: Request) {
		const forwardedFor = request.headers['x-forwarded-for'];
		const realIp = request.headers['x-real-ip'];
		const cfIp = request.headers['cf-connecting-ip'];

		if (typeof cfIp === 'string' && cfIp.length > 0) {
			return cfIp.trim();
		}

		if (typeof realIp === 'string' && realIp.length > 0) {
			return realIp.trim();
		}

		if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
			return forwardedFor.split(',')[0].trim();
		}

		return request.ip ?? undefined;
	}
}
