import { verify as verifySignature } from 'node:crypto';
import type { GatewayConfig } from './config';
import {
	JwksStore,
	JwksUnavailableError,
	UnknownSigningKeyError
} from './jwks';

export class JwtValidationError extends Error {
	readonly code = 'invalid_token';
}

export interface AccessTokenClaims {
	iss: string;
	aud: string;
	sub: string;
	sid: string;
	roles: string[];
	token_use: 'access';
	exp: number;
	nbf: number;
	iat: number;
	jti: string;
}

const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const KID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CLAIM_ID_PATTERN = /^[^\s\x00-\x1f\x7f]{1,256}$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_ROLES = new Set(['USER', 'ADMIN', 'DEV']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const decodeJsonSegment = (
	segment: string,
	label: string
): Record<string, unknown> => {
	if (!JWT_SEGMENT_PATTERN.test(segment)) {
		throw new JwtValidationError(`Invalid JWT ${label}`);
	}

	try {
		const value: unknown = JSON.parse(
			Buffer.from(segment, 'base64url').toString('utf8')
		);
		if (!isRecord(value)) {
			throw new Error('not an object');
		}
		return value;
	} catch {
		throw new JwtValidationError(`Invalid JWT ${label}`);
	}
};

const isNumericDate = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const validateClaims = (
	payload: Record<string, unknown>,
	config: GatewayConfig
): AccessTokenClaims => {
	if (
		payload.iss !== config.issuer ||
		payload.aud !== config.audience ||
		payload.token_use !== 'access'
	) {
		throw new JwtValidationError('JWT context is invalid');
	}
	if (
		typeof payload.sub !== 'string' ||
		!CLAIM_ID_PATTERN.test(payload.sub) ||
		typeof payload.sid !== 'string' ||
		!UUID_PATTERN.test(payload.sid) ||
		typeof payload.jti !== 'string' ||
		!UUID_PATTERN.test(payload.jti)
	) {
		throw new JwtValidationError('JWT identity is invalid');
	}
	if (
		!Array.isArray(payload.roles) ||
		payload.roles.length === 0 ||
		payload.roles.length > 32 ||
		payload.roles.some(
			role => typeof role !== 'string' || !ACCESS_ROLES.has(role)
		) ||
		new Set(payload.roles).size !== payload.roles.length
	) {
		throw new JwtValidationError('JWT roles are invalid');
	}
	if (
		!isNumericDate(payload.exp) ||
		!isNumericDate(payload.nbf) ||
		!isNumericDate(payload.iat)
	) {
		throw new JwtValidationError('JWT time claims are invalid');
	}

	const now = Math.floor(Date.now() / 1000);
	const tolerance = config.clockToleranceSeconds;
	if (
		payload.exp <= now - tolerance ||
		payload.nbf > now + tolerance ||
		payload.iat > now + tolerance ||
		payload.nbf !== payload.iat ||
		payload.nbf >= payload.exp ||
		payload.iat >= payload.exp ||
		payload.exp - payload.iat > config.maxTokenLifetimeSeconds
	) {
		throw new JwtValidationError('JWT is expired or not active');
	}

	return payload as unknown as AccessTokenClaims;
};

export const readBearerAuthorization = (
	rawHeaders: string[]
): string | undefined => {
	const values: string[] = [];
	for (let index = 0; index < rawHeaders.length; index += 2) {
		if (rawHeaders[index]?.toLowerCase() === 'authorization') {
			values.push(rawHeaders[index + 1] ?? '');
		}
	}

	if (values.length === 0) return undefined;
	if (values.length !== 1) {
		throw new JwtValidationError('Multiple Authorization headers');
	}

	const match = /^Bearer ([^\s]+)$/i.exec(values[0]);
	if (!match) {
		throw new JwtValidationError('Authorization must use Bearer');
	}
	return match[1];
};

export const verifyAccessToken = async (
	token: string,
	jwks: JwksStore,
	config: GatewayConfig
): Promise<AccessTokenClaims> => {
	if (Buffer.byteLength(token) > config.maxTokenBytes) {
		throw new JwtValidationError('JWT is too large');
	}

	const segments = token.split('.');
	if (
		segments.length !== 3 ||
		segments.some(segment => !JWT_SEGMENT_PATTERN.test(segment))
	) {
		throw new JwtValidationError('JWT format is invalid');
	}

	const header = decodeJsonSegment(segments[0], 'header');
	if (
		header.alg !== 'RS256' ||
		header.typ !== 'at+jwt' ||
		typeof header.kid !== 'string' ||
		!KID_PATTERN.test(header.kid)
	) {
		throw new JwtValidationError('JWT protected header is invalid');
	}

	let key;
	try {
		key = await jwks.getKey(header.kid);
	} catch (error) {
		if (
			error instanceof JwksUnavailableError ||
			error instanceof UnknownSigningKeyError
		) {
			throw error;
		}
		throw new JwtValidationError('JWT signing key is invalid');
	}

	const signingInput = Buffer.from(`${segments[0]}.${segments[1]}`);
	const signature = Buffer.from(segments[2], 'base64url');
	if (!verifySignature('RSA-SHA256', signingInput, key, signature)) {
		throw new JwtValidationError('JWT signature is invalid');
	}

	const payload = decodeJsonSegment(segments[1], 'payload');
	return validateClaims(payload, config);
};
