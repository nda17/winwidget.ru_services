import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/identity-client';
import {
	createPrivateKey,
	createPublicKey,
	randomUUID,
	type JsonWebKey,
	type KeyObject
} from 'node:crypto';

export interface PublicJwk extends JsonWebKey {
	kty: 'RSA';
	kid: string;
	use: 'sig';
	alg: 'RS256';
	n: string;
	e: string;
}

interface JwtConfig {
	privateKey: string;
	activeKid: string;
	issuer: string;
	audience: string;
	ttlSeconds: number;
	clockToleranceSeconds: number;
	jwks: { keys: PublicJwk[] };
	publicKeys: ReadonlyMap<string, string>;
}

export interface AccessJwtPayload {
	iss: string;
	aud: string;
	sub: string;
	sid: string;
	roles: Role[];
	token_use: 'access';
	jti: string;
	iat: number;
	nbf: number;
	exp: number;
}

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_ID = /^[^\s\x00-\x1f\x7f]{1,256}$/;
const KID = /^[A-Za-z0-9._:-]{1,128}$/;
const ROLES = new Set(Object.values(Role));

@Injectable()
export class AccessJwtService {
	private readonly config: JwtConfig;

	constructor(
		private readonly jwt: JwtService,
		config: ConfigService
	) {
		this.config = loadConfig(config);
	}

	issue(userId: string, roles: Role[], sessionId: string): string {
		const uniqueRoles = [...new Set(roles)];
		if (!uniqueRoles.length)
			throw new Error('Cannot issue token without roles');
		const now = Math.floor(Date.now() / 1_000);
		const payload: AccessJwtPayload = {
			iss: this.config.issuer,
			aud: this.config.audience,
			sub: userId,
			sid: sessionId,
			roles: uniqueRoles,
			token_use: 'access',
			jti: randomUUID(),
			iat: now,
			nbf: now,
			exp: now + this.config.ttlSeconds
		};
		return this.jwt.sign(payload, {
			algorithm: 'RS256',
			privateKey: this.config.privateKey,
			header: {
				alg: 'RS256',
				typ: 'at+jwt',
				kid: this.config.activeKid
			}
		});
	}

	verify(token: string): AccessJwtPayload {
		const header = this.protectedHeader(token);
		const publicKey = this.config.publicKeys.get(header.kid);
		if (!publicKey)
			throw new UnauthorizedException('Invalid access token');
		let payload: unknown;
		try {
			payload = this.jwt.verify(token, {
				publicKey,
				algorithms: ['RS256'],
				issuer: this.config.issuer,
				audience: this.config.audience,
				clockTolerance: this.config.clockToleranceSeconds
			});
		} catch {
			throw new UnauthorizedException('Invalid access token');
		}
		if (!validPayload(payload, this.config)) {
			throw new UnauthorizedException('Invalid access token');
		}
		return payload as AccessJwtPayload;
	}

	getPublicJwks(): { keys: PublicJwk[] } {
		return { keys: this.config.jwks.keys.map(key => ({ ...key })) };
	}

	private protectedHeader(token: string): { kid: string } {
		let decoded: unknown;
		try {
			decoded = this.jwt.decode(token, { complete: true });
		} catch {
			throw new UnauthorizedException('Invalid access token');
		}
		if (
			!record(decoded) ||
			!record(decoded.header) ||
			decoded.header.alg !== 'RS256' ||
			decoded.header.typ !== 'at+jwt' ||
			typeof decoded.header.kid !== 'string' ||
			!KID.test(decoded.header.kid)
		) {
			throw new UnauthorizedException('Invalid access token');
		}
		return { kid: decoded.header.kid };
	}
}

function loadConfig(config: ConfigService): JwtConfig {
	const privateKey = decode(
		requireValue(config, 'JWT_ACCESS_PRIVATE_KEY_BASE64')
	);
	const parsedJwks = JSON.parse(
		decode(requireValue(config, 'JWT_ACCESS_JWKS_BASE64'))
	) as unknown;
	if (
		!record(parsedJwks) ||
		!Array.isArray(parsedJwks.keys) ||
		!parsedJwks.keys.length
	) {
		throw new Error('JWT_ACCESS_JWKS_BASE64 must contain non-empty JWKS');
	}
	const jwks = { keys: parsedJwks.keys.map(parseJwk) };
	if (new Set(jwks.keys.map(key => key.kid)).size !== jwks.keys.length) {
		throw new Error(
			'JWT_ACCESS_JWKS_BASE64 contains duplicate kid values'
		);
	}
	const activeKid = requireValue(config, 'JWT_ACCESS_ACTIVE_KID');
	const privateObject = parsePrivateKey(privateKey);
	const publicKeys = new Map(
		jwks.keys.map(key => [
			key.kid,
			createPublicKey({ key, format: 'jwk' })
				.export({ type: 'spki', format: 'pem' })
				.toString()
		])
	);
	const active = jwks.keys.find(key => key.kid === activeKid);
	if (!active)
		throw new Error('JWT_ACCESS_ACTIVE_KID does not exist in JWKS');
	const derived = createPublicKey(privateObject).export({ format: 'jwk' });
	if (derived.n !== active.n || derived.e !== active.e) {
		throw new Error('JWT private key does not match active public JWK');
	}
	return {
		privateKey,
		activeKid,
		issuer: requireValue(config, 'JWT_ISSUER'),
		audience: requireValue(config, 'JWT_AUDIENCE'),
		ttlSeconds: integer(
			config.get<string>('JWT_ACCESS_TTL_SECONDS'),
			900,
			60,
			1_800
		),
		clockToleranceSeconds: integer(
			config.get<string>('JWT_CLOCK_TOLERANCE_SECONDS'),
			0,
			0,
			60
		),
		jwks,
		publicKeys
	};
}

function parsePrivateKey(value: string): KeyObject {
	let key: KeyObject;
	try {
		key = createPrivateKey(value);
	} catch {
		throw new Error('JWT_ACCESS_PRIVATE_KEY_BASE64 contains invalid key');
	}
	if (
		key.asymmetricKeyType !== 'rsa' ||
		(key.asymmetricKeyDetails?.modulusLength || 0) < 2_048
	) {
		throw new Error('JWT private key must be RSA with at least 2048 bits');
	}
	return key;
}

function parseJwk(value: unknown): PublicJwk {
	if (
		!record(value) ||
		value.kty !== 'RSA' ||
		value.alg !== 'RS256' ||
		value.use !== 'sig' ||
		typeof value.kid !== 'string' ||
		!KID.test(value.kid) ||
		typeof value.n !== 'string' ||
		typeof value.e !== 'string' ||
		['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(field => field in value)
	) {
		throw new Error('JWKS contains invalid or private key');
	}
	if (
		value.key_ops !== undefined &&
		(!Array.isArray(value.key_ops) ||
			!value.key_ops.every(operation => typeof operation === 'string') ||
			!value.key_ops.includes('verify') ||
			value.key_ops.some(operation => operation !== 'verify'))
	) {
		throw new Error('JWT access JWK key_ops must contain only verify');
	}
	const jwk: PublicJwk = {
		kty: 'RSA',
		kid: value.kid,
		use: 'sig',
		alg: 'RS256',
		n: value.n,
		e: value.e,
		...(value.key_ops ? { key_ops: ['verify'] } : {})
	};
	const key = createPublicKey({ key: jwk, format: 'jwk' });
	if ((key.asymmetricKeyDetails?.modulusLength || 0) < 2_048) {
		throw new Error('JWKS RSA key must be at least 2048 bits');
	}
	return jwk;
}

function validPayload(value: unknown, config: JwtConfig): boolean {
	return (
		record(value) &&
		value.iss === config.issuer &&
		value.aud === config.audience &&
		typeof value.sub === 'string' &&
		CLAIM_ID.test(value.sub) &&
		typeof value.sid === 'string' &&
		UUID.test(value.sid) &&
		Array.isArray(value.roles) &&
		value.roles.length > 0 &&
		value.roles.every(
			role => typeof role === 'string' && ROLES.has(role as Role)
		) &&
		new Set(value.roles).size === value.roles.length &&
		value.token_use === 'access' &&
		typeof value.jti === 'string' &&
		UUID.test(value.jti) &&
		numeric(value.iat) &&
		numeric(value.nbf) &&
		numeric(value.exp) &&
		value.nbf === value.iat &&
		value.exp > value.iat &&
		value.exp - value.iat <= config.ttlSeconds
	);
}

function decode(value: string): string {
	const buffer = Buffer.from(value, 'base64');
	if (
		!buffer.length ||
		buffer.toString('base64').replace(/=+$/, '') !==
			value.replace(/=+$/, '')
	) {
		throw new Error('JWT base64 configuration is invalid');
	}
	return buffer.toString('utf8');
}

function requireValue(config: ConfigService, name: string): string {
	const value = config.get<string>(name)?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function integer(
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number
): number {
	const value = raw?.trim() ? Number(raw) : fallback;
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(
			`JWT integer configuration must be between ${min} and ${max}`
		);
	}
	return value;
}

function record(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' && value !== null && !Array.isArray(value)
	);
}

function numeric(value: unknown): value is number {
	return (
		typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
	);
}
