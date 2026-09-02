import {
	Body,
	Controller,
	Delete,
	Get,
	Header,
	HttpCode,
	Param,
	Patch,
	Post,
	Req,
	Res,
	UnauthorizedException,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/identity-client';
import type { Request, Response } from 'express';
import { clientIp } from '../common/identity.util';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { IdentityEventsService } from '../events/identity-events.service';
import { AccessJwtService } from './access-jwt.service';
import { Auth, CurrentUser, IdentityAuthGuard } from './auth.guard';
import {
	AuthDto,
	EmailRegisterDto,
	PhoneDto,
	PhoneLoginDto,
	PhoneRegisterDto,
	ResendEmailCodeDto,
	RestorePasswordDto
} from './auth.dto';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import {
	AuthService,
	RefreshRotationInProgressException
} from './auth.service';
import { RecaptchaAction, RecaptchaGuard } from './recaptcha.guard';
import { RefreshTokenService } from './refresh-token.service';

const PUBLIC_GUARDS = [AuthRateLimitGuard, RecaptchaGuard];

@Controller()
export class AuthController {
	constructor(
		private readonly auth: AuthService,
		private readonly jwt: AccessJwtService,
		private readonly refresh: RefreshTokenService,
		private readonly prisma: IdentityPrismaService,
		private readonly events: IdentityEventsService
	) {}

	@Get('auth/.well-known/jwks.json')
	@Header(
		'Cache-Control',
		'public, max-age=300, stale-while-revalidate=300'
	)
	getJwks() {
		return this.jwt.getPublicJwks();
	}

	@Post('auth/login')
	@HttpCode(200)
	@UseGuards(...PUBLIC_GUARDS)
	@RecaptchaAction('login')
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async login(
		@Body() dto: AuthDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const { refreshToken, ...body } = await this.auth.login(dto, request);
		this.refresh.add(response, refreshToken);
		return body;
	}

	@Post('auth/register')
	@HttpCode(200)
	@UseGuards(...PUBLIC_GUARDS)
	@RecaptchaAction('register')
	@UsePipes(new ValidationPipe({ whitelist: true }))
	register(@Body() dto: AuthDto) {
		return this.auth.register(dto);
	}

	@Post('auth/email/register')
	@HttpCode(200)
	@UseGuards(...PUBLIC_GUARDS)
	@RecaptchaAction('email_register')
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async registerEmail(
		@Body() dto: EmailRegisterDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const { refreshToken, ...body } = await this.auth.registerByEmail(
			dto,
			request
		);
		this.refresh.add(response, refreshToken);
		return body;
	}

	@Post('auth/email/resend-code')
	@HttpCode(200)
	@UseGuards(...PUBLIC_GUARDS)
	@RecaptchaAction('email_resend_code')
	@UsePipes(new ValidationPipe({ whitelist: true }))
	resendEmail(@Body() dto: ResendEmailCodeDto) {
		return this.auth.resendEmailCode(dto);
	}

	@Post('auth/phone/send-code')
	@HttpCode(200)
	@UseGuards(...PUBLIC_GUARDS)
	@RecaptchaAction('phone_send_code')
	@UsePipes(new ValidationPipe({ whitelist: true }))
	phoneCode(@Body() dto: PhoneDto) {
		return this.auth.sendPhoneCode(dto);
	}

	@Post('auth/phone/register')
	@HttpCode(200)
	@UseGuards(...PUBLIC_GUARDS)
	@RecaptchaAction('phone_register')
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async registerPhone(
		@Body() dto: PhoneRegisterDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const { refreshToken, ...body } = await this.auth.registerByPhone(
			dto,
			request
		);
		this.refresh.add(response, refreshToken);
		return body;
	}

	@Post('auth/phone/login')
	@HttpCode(200)
	@UseGuards(...PUBLIC_GUARDS)
	@RecaptchaAction('phone_login')
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async phoneLogin(
		@Body() dto: PhoneLoginDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const { refreshToken, ...body } = await this.auth.loginByPhone(
			dto,
			request
		);
		this.refresh.add(response, refreshToken);
		return body;
	}

	@Patch('auth/restore-password')
	@HttpCode(200)
	@UseGuards(...PUBLIC_GUARDS)
	@RecaptchaAction('restore_password')
	@UsePipes(new ValidationPipe({ whitelist: true }))
	restorePassword(@Body() dto: RestorePasswordDto) {
		return this.auth.restorePassword(dto);
	}

	@Post('auth/refresh')
	@HttpCode(200)
	@UseGuards(AuthRateLimitGuard)
	async refreshSession(
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		try {
			const token = request.cookies?.[this.refresh.name];
			if (!token)
				throw new UnauthorizedException('Refresh token not passed');
			const { refreshToken, ...body } = await this.auth.refresh(token);
			this.refresh.add(response, refreshToken);
			return body;
		} catch (error) {
			if (!(error instanceof RefreshRotationInProgressException)) {
				this.refresh.remove(response);
			}
			throw error;
		}
	}

	@Post('auth/logout')
	@HttpCode(200)
	async logout(
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const result = await this.auth.logout(
			request.cookies?.[this.refresh.name]
		);
		this.refresh.remove(response);
		return result;
	}

	@Get('auth/sessions')
	@Auth(Role.USER)
	@UseGuards(IdentityAuthGuard)
	sessions(
		@CurrentUser('id') userId: string,
		@CurrentUser('sessionId') sessionId: string
	) {
		return this.auth.sessions(userId, sessionId);
	}

	@Delete('auth/sessions/:sessionId')
	@Auth(Role.USER)
	@UseGuards(IdentityAuthGuard)
	revoke(
		@CurrentUser('id') userId: string,
		@CurrentUser('sessionId') currentSessionId: string,
		@Param('sessionId') sessionId: string,
		@Res({ passthrough: true }) response: Response
	) {
		return this.auth
			.revokeSession(userId, sessionId, currentSessionId)
			.then(result => {
				if (result.currentSessionRevoked) this.refresh.remove(response);
				return result;
			});
	}

	@Delete('auth/sessions')
	@Auth(Role.USER)
	@UseGuards(IdentityAuthGuard)
	async revokeAll(
		@CurrentUser('id') userId: string,
		@Res({ passthrough: true }) response: Response
	) {
		const result = await this.auth.revokeAll(userId);
		this.refresh.remove(response);
		return result;
	}

	@Post('auth/admin/run-verification-challenge-cleanup')
	@HttpCode(200)
	@Auth(Role.ADMIN)
	@UseGuards(IdentityAuthGuard)
	async cleanup(
		@CurrentUser('id') actorId: string,
		@Req() request: Request
	) {
		return this.prisma.$transaction(async transaction => {
			const deleted = await transaction.verificationChallenge.deleteMany({
				where: { expiresAt: { lte: new Date() } }
			});
			const result = {
				taskId: 'verificationChallengeCleanup',
				title: 'Очистка verification challenges',
				affectedCount: deleted.count,
				message:
					deleted.count > 0
						? `Удалено ${deleted.count} просроченных verification challenge(s).`
						: 'Просроченные verification challenges не найдены.',
				executedAt: new Date().toISOString()
			};
			await this.events.emitAudit(transaction, {
				actorId,
				section: 'TASKS',
				action: 'VERIFICATION_CHALLENGE_CLEANUP_RUN',
				entityType: 'manual_task',
				entityId: result.taskId,
				entityLabel: result.title,
				description: result.title,
				metadata: result,
				requestId: request.header('x-request-id'),
				requestIp: clientIp(request),
				requestUserAgent: request.get('user-agent')?.slice(0, 500),
				correlationId: request.header('x-correlation-id')
			});
			return result;
		});
	}
}
