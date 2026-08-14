import {
	Controller,
	Get,
	Query,
	Req,
	Res,
	UseGuards
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthRateLimitGuard } from '../auth/auth-rate-limit.guard';
import { OAuthService } from './oauth.service';

@Controller('auth')
@UseGuards(AuthRateLimitGuard)
export class OAuthController {
	constructor(private readonly oauth: OAuthService) {}

	@Get('google')
	google(
		@Query('ref') ref: string | undefined,
		@Res() response: Response
	) {
		return this.oauth.start('google', ref, response);
	}

	@Get('google/redirect')
	googleCallback(
		@Req() request: Request,
		@Res() response: Response,
		@Query('code') code?: string,
		@Query('state') state?: string,
		@Query('error') error?: string
	) {
		return this.oauth.callback('google', request, response, {
			code,
			state,
			error
		});
	}

	@Get('github')
	github(
		@Query('ref') ref: string | undefined,
		@Res() response: Response
	) {
		return this.oauth.start('github', ref, response);
	}

	@Get('github/redirect')
	githubCallback(
		@Req() request: Request,
		@Res() response: Response,
		@Query('code') code?: string,
		@Query('state') state?: string,
		@Query('error') error?: string
	) {
		return this.oauth.callback('github', request, response, {
			code,
			state,
			error
		});
	}

	@Get('yandex')
	yandex(
		@Query('ref') ref: string | undefined,
		@Res() response: Response
	) {
		return this.oauth.start('yandex', ref, response);
	}

	@Get('yandex/redirect')
	yandexCallback(
		@Req() request: Request,
		@Res() response: Response,
		@Query('code') code?: string,
		@Query('state') state?: string,
		@Query('error') error?: string
	) {
		return this.oauth.callback('yandex', request, response, {
			code,
			state,
			error
		});
	}

	@Get('vk')
	vk(@Query('ref') ref: string | undefined, @Res() response: Response) {
		return this.oauth.start('vk', ref, response);
	}

	@Get('vk/redirect')
	vkCallback(
		@Req() request: Request,
		@Res() response: Response,
		@Query('code') code?: string,
		@Query('state') state?: string,
		@Query('device_id') deviceId?: string,
		@Query('error') error?: string
	) {
		return this.oauth.callback('vk', request, response, {
			code,
			state,
			deviceId,
			error
		});
	}
}
