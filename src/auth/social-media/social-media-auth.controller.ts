import { AuthService } from '@/auth/auth.service';
import { GithubAuthEnabledGuard } from '@/auth/guards/social-auth-enabled/github-auth-enabled.guard';
import { GoogleAuthEnabledGuard } from '@/auth/guards/social-auth-enabled/google-auth-enabled.guard';
import { VkAuthEnabledGuard } from '@/auth/guards/social-auth-enabled/vk-auth-enabled.guard';
import { YandexAuthEnabledGuard } from '@/auth/guards/social-auth-enabled/yandex-auth-enabled.guard';
import { RefreshTokenService } from '@/auth/refresh-token.service';
import { SocialMediaAuthService } from '@/auth/social-media/social-media-auth.service';
import {
	IYandexProfile,
	IVkProfile,
	TSocialProfile
} from '@/auth/social-media/social-media-auth.types';
import {
	buildVkAuthUrl,
	exchangeVkCode,
	fetchVkUserInfo,
	generateVkPkcePair,
	generateVkState
} from '@/auth/strategies/vk.strategy';
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
import { CookieOptions, Request, Response } from 'express';

const MAX_AFFILIATE_REFERRER_ID_LENGTH = 128;
const VK_AUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
const VK_AUTH_STATE_COOKIE = 'vkAuthState';
const VK_AUTH_CODE_VERIFIER_COOKIE = 'vkAuthCodeVerifier';
const VK_AUTH_REFERRER_COOKIE = 'vkAuthReferrer';

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

const getVkAuthCookieOptions = (includeDomain = true): CookieOptions => {
	const isProduction = process.env.MODE === 'production';
	const domain = includeDomain
		? process.env.AUTH_COOKIE_DOMAIN?.trim()
		: '';

	return {
		httpOnly: true,
		secure: isProduction,
		sameSite: isProduction ? ('none' as const) : ('lax' as const),
		...(domain ? { domain } : {}),
		path: '/auth/vk'
	};
};

const setVkAuthCookie = (res: Response, name: string, value: string) => {
	res.cookie(name, value, {
		...getVkAuthCookieOptions(),
		maxAge: VK_AUTH_COOKIE_MAX_AGE_MS
	});
};

const clearVkAuthCookie = (res: Response, name: string) => {
	res.clearCookie(name, getVkAuthCookieOptions());

	if (process.env.AUTH_COOKIE_DOMAIN?.trim()) {
		res.clearCookie(name, getVkAuthCookieOptions(false));
	}
};

const clearVkAuthCookies = (res: Response) => {
	for (const cookieName of [
		VK_AUTH_STATE_COOKIE,
		VK_AUTH_CODE_VERIFIER_COOKIE,
		VK_AUTH_REFERRER_COOKIE
	]) {
		clearVkAuthCookie(res, cookieName);
	}
};

const getVkServiceToken = () =>
	process.env.VK_SERVICE_TOKEN?.trim() ||
	process.env.VK_CLIENT_SECRET?.trim();

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

	@Get('vk')
	@UseGuards(VkAuthEnabledGuard)
	vkAuth(@Query('ref') ref: string, @Res() res: Response) {
		const state = generateVkState();
		const { codeVerifier, codeChallenge } = generateVkPkcePair();
		const referrerId = normalizeAffiliateReferrerId(ref);

		setVkAuthCookie(res, VK_AUTH_STATE_COOKIE, state);
		setVkAuthCookie(res, VK_AUTH_CODE_VERIFIER_COOKIE, codeVerifier);

		if (referrerId) {
			setVkAuthCookie(res, VK_AUTH_REFERRER_COOKIE, referrerId);
		} else {
			clearVkAuthCookie(res, VK_AUTH_REFERRER_COOKIE);
		}

		const url = buildVkAuthUrl(
			process.env.VK_CLIENT_ID!,
			process.env.VK_CALLBACK_URL!,
			state,
			codeChallenge
		);

		return res.redirect(url);
	}

	@Get('vk/redirect')
	@UseGuards(VkAuthEnabledGuard)
	async vkAuthRedirect(
		@Req() req: Request,
		@Query('code') code: string,
		@Query('state') state: string,
		@Query('device_id') deviceId: string,
		@Query('error') vkError: string,
		@Query('error_description') vkErrorDescription: string,
		@Res({ passthrough: true }) res: Response
	) {
		try {
			const cookieState = req.cookies?.[VK_AUTH_STATE_COOKIE];
			const codeVerifier = req.cookies?.[VK_AUTH_CODE_VERIFIER_COOKIE];
			const referrerId = normalizeAffiliateReferrerId(
				req.cookies?.[VK_AUTH_REFERRER_COOKIE]
			);
			const serviceToken = getVkServiceToken();

			if (vkError) {
				throw new Error(
					`VK authorization failed: ${vkErrorDescription || vkError}`
				);
			}

			if (!code || !state || !deviceId) {
				throw new Error(
					'VK authorization failed: missing callback params'
				);
			}

			if (!cookieState || !codeVerifier || cookieState !== state) {
				throw new Error('VK authorization failed: invalid state');
			}

			if (!serviceToken) {
				throw new Error('VK authorization failed: missing service token');
			}

			const vkToken = await exchangeVkCode(
				code,
				process.env.VK_CLIENT_ID!,
				serviceToken,
				process.env.VK_CALLBACK_URL!,
				codeVerifier,
				deviceId,
				state
			);

			if (vkToken.state && vkToken.state !== state) {
				throw new Error('VK token exchange failed: invalid state');
			}

			const userInfo = await fetchVkUserInfo(
				vkToken.access_token!,
				process.env.VK_CLIENT_ID!
			);

			if (!userInfo.email) {
				throw new Error('VK user info failed: missing email');
			}

			const profile: IVkProfile = {
				provider: 'vk',
				providerId: String(userInfo.user_id || vkToken.user_id),
				email: userInfo.email,
				firstName: userInfo.first_name,
				lastName: userInfo.last_name,
				picture: userInfo.avatar,
				accessToken: vkToken.access_token!
			};

			const user = await this.socialMediaAuthService.login(
				{
					user: profile
				},
				referrerId
			);

			const { refreshToken } =
				await this.authService.buildResponseObject(user);
			this.refreshTokenService.addRefreshTokenToResponse(
				res,
				refreshToken
			);
			clearVkAuthCookies(res);

			return res.redirect(this._SOCIAL_AUTH_REDIRECT);
		} catch (error) {
			this.refreshTokenService.removeRefreshTokenFromResponse(res);
			clearVkAuthCookies(res);
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
