import { Injectable } from '@nestjs/common';
import type { Response } from 'express';

@Injectable()
export class RefreshTokenService {
	readonly EXPIRE_DAY_REFRESH_TOKEN = 7;
	readonly REFRESH_TOKEN_NAME = 'refreshToken';

	private getCookieOptions(expires: Date, includeDomain = true) {
		const isProduction = process.env.MODE === 'production';
		const domain = includeDomain
			? process.env.AUTH_COOKIE_DOMAIN?.trim()
			: '';

		return {
			httpOnly: true,
			expires,
			secure: isProduction,
			sameSite: isProduction ? ('none' as const) : ('lax' as const),
			...(domain ? { domain } : {}),
			path: '/'
		};
	}

	private removeLegacyHostRefreshTokenCookie(res: Response) {
		if (!process.env.AUTH_COOKIE_DOMAIN?.trim()) return;

		res.cookie(
			this.REFRESH_TOKEN_NAME,
			'',
			this.getCookieOptions(new Date(0), false)
		);
	}

	addRefreshTokenToResponse(res: Response, refreshToken: string) {
		const expiresIn = new Date();
		expiresIn.setDate(expiresIn.getDate() + this.EXPIRE_DAY_REFRESH_TOKEN);
		this.removeLegacyHostRefreshTokenCookie(res);

		res.cookie(
			this.REFRESH_TOKEN_NAME,
			refreshToken,
			this.getCookieOptions(expiresIn)
		);
	}

	removeRefreshTokenFromResponse(res: Response) {
		this.removeLegacyHostRefreshTokenCookie(res);

		res.cookie(
			this.REFRESH_TOKEN_NAME,
			'',
			this.getCookieOptions(new Date(0))
		);
	}
}
