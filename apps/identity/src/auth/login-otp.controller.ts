import {
	Body,
	Controller,
	Get,
	Header,
	HttpCode,
	Post,
	Req,
	Res,
	ValidationPipe
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequestLoginOtpDto, VerifyLoginOtpDto } from './login-otp.dto';
import { LoginOtpService } from './login-otp.service';
import { RefreshTokenService } from './refresh-token.service';

const INPUT = new ValidationPipe({
	transform: true,
	whitelist: true,
	forbidNonWhitelisted: true
});

@Controller('auth/login-otp')
export class LoginOtpController {
	constructor(
		private readonly otp: LoginOtpService,
		private readonly refresh: RefreshTokenService
	) {}

	@Get('capabilities')
	@Header('Cache-Control', 'no-store')
	capabilities() {
		return this.otp.capabilities();
	}

	@Post('request')
	@HttpCode(202)
	@Header('Cache-Control', 'no-store')
	async request(@Body() input: unknown, @Req() request: Request) {
		// Keep the raw body until this strict boundary. The legacy global pipe
		// strips unknown DTO fields and would hide them from a later pipe.
		const dto: RequestLoginOtpDto = await INPUT.transform(input, {
			type: 'body',
			metatype: RequestLoginOtpDto
		});
		return this.otp.request(dto, request);
	}

	@Post('verify')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	async verify(
		@Body() input: unknown,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		const dto: VerifyLoginOtpDto = await INPUT.transform(input, {
			type: 'body',
			metatype: VerifyLoginOtpDto
		});
		const { refreshToken, ...body } = await this.otp.verify(dto, request);
		this.refresh.add(response, refreshToken);
		return body;
	}
}
