import { AuthService } from '@/auth/auth.service';
import { RefreshTokenService } from '@/auth/refresh-token.service';
import { SocialMediaAuthService } from '@/auth/social-media/social-media-auth.service';
import {
	IYandexProfile,
	TSocialProfile
} from '@/auth/social-media/social-media-auth.types';
import {
	buildYandexAuthUrl,
	buildYandexAvatarUrl,
	exchangeYandexCode,
	fetchYandexUserInfo
} from '@/auth/strategies/yandex.strategy';
import {
	Controller,
	Get,
	Query,
	Req,
	Res,
	UseGuards
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';

@Controller('auth')
export class SocialMediaAuthController {
	constructor(
		private readonly socialMediaAuthService: SocialMediaAuthService,
		private readonly authService: AuthService,
		private readonly refreshTokenService: RefreshTokenService
	) {}

	private _CLIENT_BASE_URL = `${process.env.RECAPTCHA_CLIENT_URL}/social-auth?accessToken=`;

	@Get('google')
	@UseGuards(AuthGuard('google'))
	async googleAuth() {}

	@Get('google/redirect')
	@UseGuards(AuthGuard('google'))
	async googleAuthRedirect(
		@Req() req: { user: TSocialProfile },
		@Res({ passthrough: true }) res: Response
	) {
		const user = await this.socialMediaAuthService.login(req);

		const { accessToken, refreshToken } =
			await this.authService.buildResponseObject(user);
		this.refreshTokenService.addRefreshTokenToResponse(res, refreshToken);

		return res.redirect(`${this._CLIENT_BASE_URL}${accessToken}`);
	}

	@Get('github')
	@UseGuards(AuthGuard('github'))
	async githubAuth() {}

	@Get('github/redirect')
	@UseGuards(AuthGuard('github'))
	async githubAuthRedirect(
		@Req() req: { user: TSocialProfile },
		@Res({ passthrough: true }) res: Response
	) {
		const user = await this.socialMediaAuthService.login(req);

		const { accessToken, refreshToken } =
			await this.authService.buildResponseObject(user);
		this.refreshTokenService.addRefreshTokenToResponse(res, refreshToken);

		return res.redirect(`${this._CLIENT_BASE_URL}${accessToken}`);
	}

	@Get('yandex')
	yandexAuth(@Res() res: Response) {
		const url = buildYandexAuthUrl(
			process.env.YANDEX_CLIENT_ID!,
			process.env.YANDEX_CALLBACK_URL!
		);
		return res.redirect(url);
	}

	@Get('yandex/redirect')
	async yandexAuthRedirect(
		@Query('code') code: string,
		@Res({ passthrough: true }) res: Response
	) {
		const accessToken = await exchangeYandexCode(
			code,
			process.env.YANDEX_CLIENT_ID!,
			process.env.YANDEX_CLIENT_SECRET!,
			process.env.YANDEX_CALLBACK_URL!
		);

		const userInfo = await fetchYandexUserInfo(accessToken);

		const profile: IYandexProfile = {
			providerId: userInfo.id,
			email: userInfo.default_email,
			displayName: userInfo.display_name,
			picture: buildYandexAvatarUrl(userInfo),
			accessToken
		};

		const user = await this.socialMediaAuthService.login({
			user: profile
		});

		const { accessToken: jwt, refreshToken } =
			await this.authService.buildResponseObject(user);
		this.refreshTokenService.addRefreshTokenToResponse(res, refreshToken);

		return res.redirect(`${this._CLIENT_BASE_URL}${jwt}`);
	}
}
