import { AuthService } from '@/auth/auth.service';
import { GithubAuthEnabledGuard } from '@/auth/guards/social-auth-enabled/github-auth-enabled.guard';
import { GoogleAuthEnabledGuard } from '@/auth/guards/social-auth-enabled/google-auth-enabled.guard';
import { YandexAuthEnabledGuard } from '@/auth/guards/social-auth-enabled/yandex-auth-enabled.guard';
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
import { USER_DEACTIVATED_MESSAGE } from '@/utils/auth.constants';
import {
	Controller,
	ExecutionContext,
	Get,
	Query,
	Req,
	Res,
	UnauthorizedException,
	UseGuards
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';

const MAX_AFFILIATE_REFERRER_ID_LENGTH = 128;

const normalizeAffiliateReferrerId = (value: unknown) => {
	const rawValue = Array.isArray(value) ? value[0] : value;

	if (typeof rawValue !== 'string') {
		return undefined;
	}

	const referrerId = rawValue.trim();
	return referrerId &&
		referrerId.length <= MAX_AFFILIATE_REFERRER_ID_LENGTH
		? referrerId
		: undefined;
};

const getAffiliateAuthOptions = (context: ExecutionContext) => {
	const request = context.switchToHttp().getRequest<Request>();
	const referrerId = normalizeAffiliateReferrerId(request.query.ref);

	return referrerId ? { state: referrerId } : {};
};

class GoogleAffiliateAuthGuard extends AuthGuard('google') {
	getAuthenticateOptions(context: ExecutionContext) {
		return getAffiliateAuthOptions(context);
	}
}

class GithubAffiliateAuthGuard extends AuthGuard('github') {
	getAuthenticateOptions(context: ExecutionContext) {
		return getAffiliateAuthOptions(context);
	}
}

@Controller('auth')
export class SocialMediaAuthController {
	constructor(
		private readonly socialMediaAuthService: SocialMediaAuthService,
		private readonly authService: AuthService,
		private readonly refreshTokenService: RefreshTokenService
	) {}

	private _SOCIAL_AUTH_REDIRECT = `${process.env.RECAPTCHA_CLIENT_URL}/social-auth`;
	private _LOGIN_REDIRECT = `${process.env.RECAPTCHA_CLIENT_URL}/login`;

	@Get('google')
	@UseGuards(GoogleAuthEnabledGuard, GoogleAffiliateAuthGuard)
	async googleAuth() {}

	@Get('google/redirect')
	@UseGuards(GoogleAuthEnabledGuard, AuthGuard('google'))
	async googleAuthRedirect(
		@Req() req: { user: TSocialProfile },
		@Query('state') state: string,
		@Res({ passthrough: true }) res: Response
	) {
		try {
			const user = await this.socialMediaAuthService.login(
				req,
				normalizeAffiliateReferrerId(state)
			);

			const { refreshToken } =
				await this.authService.buildResponseObject(user);
			this.refreshTokenService.addRefreshTokenToResponse(
				res,
				refreshToken
			);

			return res.redirect(this._SOCIAL_AUTH_REDIRECT);
		} catch (error) {
			this.refreshTokenService.removeRefreshTokenFromResponse(res);
			return res.redirect(this.getSocialAuthErrorRedirect(error));
		}
	}

	@Get('github')
	@UseGuards(GithubAuthEnabledGuard, GithubAffiliateAuthGuard)
	async githubAuth() {}

	@Get('github/redirect')
	@UseGuards(GithubAuthEnabledGuard, AuthGuard('github'))
	async githubAuthRedirect(
		@Req() req: { user: TSocialProfile },
		@Query('state') state: string,
		@Res({ passthrough: true }) res: Response
	) {
		try {
			const user = await this.socialMediaAuthService.login(
				req,
				normalizeAffiliateReferrerId(state)
			);

			const { refreshToken } =
				await this.authService.buildResponseObject(user);
			this.refreshTokenService.addRefreshTokenToResponse(
				res,
				refreshToken
			);

			return res.redirect(this._SOCIAL_AUTH_REDIRECT);
		} catch (error) {
			this.refreshTokenService.removeRefreshTokenFromResponse(res);
			return res.redirect(this.getSocialAuthErrorRedirect(error));
		}
	}

	@Get('yandex')
	@UseGuards(YandexAuthEnabledGuard)
	yandexAuth(@Query('ref') ref: string, @Res() res: Response) {
		const url = buildYandexAuthUrl(
			process.env.YANDEX_CLIENT_ID!,
			process.env.YANDEX_CALLBACK_URL!,
			normalizeAffiliateReferrerId(ref)
		);
		return res.redirect(url);
	}

	@Get('yandex/redirect')
	@UseGuards(YandexAuthEnabledGuard)
	async yandexAuthRedirect(
		@Query('code') code: string,
		@Query('state') state: string,
		@Res({ passthrough: true }) res: Response
	) {
		try {
			const yandexAccessToken = await exchangeYandexCode(
				code,
				process.env.YANDEX_CLIENT_ID!,
				process.env.YANDEX_CLIENT_SECRET!,
				process.env.YANDEX_CALLBACK_URL!
			);

			const userInfo = await fetchYandexUserInfo(yandexAccessToken);

			const profile: IYandexProfile = {
				providerId: userInfo.id,
				email: userInfo.default_email,
				displayName: userInfo.display_name,
				picture: buildYandexAvatarUrl(userInfo),
				accessToken: yandexAccessToken
			};

			const user = await this.socialMediaAuthService.login(
				{
					user: profile
				},
				normalizeAffiliateReferrerId(state)
			);

			const { refreshToken } =
				await this.authService.buildResponseObject(user);
			this.refreshTokenService.addRefreshTokenToResponse(
				res,
				refreshToken
			);

			return res.redirect(this._SOCIAL_AUTH_REDIRECT);
		} catch (error) {
			this.refreshTokenService.removeRefreshTokenFromResponse(res);
			return res.redirect(this.getSocialAuthErrorRedirect(error));
		}
	}

	private getSocialAuthErrorRedirect(error: unknown) {
		const errorCode =
			error instanceof UnauthorizedException &&
			error.message === USER_DEACTIVATED_MESSAGE
				? 'account_deactivated'
				: 'social_auth_failed';

		return `${this._LOGIN_REDIRECT}?error=${errorCode}`;
	}
}
