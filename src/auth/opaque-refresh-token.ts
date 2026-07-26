import { createHash, randomBytes } from 'node:crypto';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFRESH_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ParsedOpaqueRefreshToken {
	sessionId: string;
}

export const createOpaqueRefreshToken = (sessionId: string) =>
	`${sessionId}.${randomBytes(32).toString('base64url')}`;

export const getOpaqueRefreshTokenHashInput = (token: string) =>
	createHash('sha256').update(token, 'utf8').digest('base64url');

export const parseOpaqueRefreshToken = (
	token: string
): ParsedOpaqueRefreshToken | null => {
	if (typeof token !== 'string') {
		return null;
	}

	const [sessionId, secret, extraPart] = token.split('.');

	if (
		extraPart !== undefined ||
		!UUID_PATTERN.test(sessionId) ||
		!REFRESH_SECRET_PATTERN.test(secret)
	) {
		return null;
	}

	return { sessionId };
};
