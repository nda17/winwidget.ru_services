import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class RefreshTokenService {
	readonly name = 'refreshToken';
	readonly expirationDays = 7;

	create(sessionId: string): string {
		return `${sessionId}.${randomBytes(32).toString('base64url')}`;
	}

	parse(value: string): { sessionId: string } | null {
		const [sessionId, secret, extra] = value.split('.');
		return extra === undefined &&
			UUID.test(sessionId) &&
			SECRET.test(secret)
			? { sessionId }
			: null;
	}

	hashInput(value: string): string {
		return createHash('sha256').update(value).digest('base64url');
	}

	add(response: Response, token: string): void {
		const expires = new Date();
		expires.setDate(expires.getDate() + this.expirationDays);
		this.removeLegacyHostCookie(response);
		response.cookie(this.name, token, this.options(expires));
	}

	remove(response: Response): void {
		this.removeLegacyHostCookie(response);
		response.cookie(this.name, '', this.options(new Date(0)));
	}

	private removeLegacyHostCookie(response: Response): void {
		if (!process.env.AUTH_COOKIE_DOMAIN?.trim()) return;
		response.cookie(this.name, '', this.options(new Date(0), false));
	}

	private options(expires: Date, includeDomain = true) {
		const production = process.env.MODE === 'production';
		const domain = includeDomain
			? process.env.AUTH_COOKIE_DOMAIN?.trim()
			: '';
		return {
			httpOnly: true,
			expires,
			secure: production,
			sameSite: production ? ('none' as const) : ('lax' as const),
			...(domain ? { domain } : {}),
			path: '/'
		};
	}
}
