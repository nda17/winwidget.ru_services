import {
	loadAccessJwtConfig,
	type AccessJwtConfig
} from '@/config/jwt.config';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';

interface AccessJwtHeader {
	alg: 'RS256';
	typ: 'at+jwt';
	kid: string;
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

@Injectable()
export class AccessJwtService {
	private readonly config: AccessJwtConfig;

	constructor(
		private readonly jwt: JwtService,
		configService: ConfigService
	) {
		this.config = loadAccessJwtConfig(configService);
	}

	get issuer() {
		return this.config.issuer;
	}

	get audience() {
		return this.config.audience;
	}

	get clockToleranceSeconds() {
		return this.config.clockToleranceSeconds;
	}

	issueAccessToken(userId: string, roles: Role[], sessionId: string) {
		const issuedAt = Math.floor(Date.now() / 1000);
		const uniqueRoles = [...new Set(roles)];

		if (uniqueRoles.length === 0) {
			throw new Error('Cannot issue an access token without roles');
		}

		const payload: AccessJwtPayload = {
			iss: this.config.issuer,
			aud: this.config.audience,
			sub: userId,
			sid: sessionId,
			roles: uniqueRoles,
			token_use: 'access',
			jti: randomUUID(),
			iat: issuedAt,
			nbf: issuedAt,
			exp: issuedAt + this.config.ttlSeconds
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

	verifyAccessToken(token: string) {
		const publicKey = this.getVerificationKey(token);
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

		return this.assertAccessTokenPayload(payload);
	}

	getVerificationKey(token: string) {
		const header = this.readProtectedHeader(token);
		const publicKey = this.config.publicKeysByKid.get(header.kid);

		if (!publicKey) {
			throw new UnauthorizedException('Invalid access token');
		}

		return publicKey;
	}

	assertAccessTokenPayload(payload: unknown): AccessJwtPayload {
		if (
			!isRecord(payload) ||
			payload.iss !== this.config.issuer ||
			payload.aud !== this.config.audience ||
			typeof payload.sub !== 'string' ||
			!CLAIM_ID_PATTERN.test(payload.sub) ||
			typeof payload.sid !== 'string' ||
			!isUuid(payload.sid) ||
			!Array.isArray(payload.roles) ||
			payload.roles.length === 0 ||
			!payload.roles.every(isRole) ||
			new Set(payload.roles).size !== payload.roles.length ||
			payload.token_use !== 'access' ||
			typeof payload.jti !== 'string' ||
			!isUuid(payload.jti) ||
			!isNumericDate(payload.iat) ||
			!isNumericDate(payload.nbf) ||
			!isNumericDate(payload.exp) ||
			payload.nbf !== payload.iat ||
			payload.exp <= payload.iat ||
			payload.exp - payload.iat > this.config.ttlSeconds
		) {
			throw new UnauthorizedException('Invalid access token');
		}

		return payload as unknown as AccessJwtPayload;
	}

	getPublicJwks() {
		return {
			keys: this.config.publicJwks.keys.map(key => ({
				...key,
				...(key.key_ops ? { key_ops: [...key.key_ops] } : {})
			}))
		};
	}

	private readProtectedHeader(token: string): AccessJwtHeader {
		let decoded: unknown;

		try {
			decoded = this.jwt.decode(token, { complete: true });
		} catch {
			throw new UnauthorizedException('Invalid access token');
		}

		if (
			!isRecord(decoded) ||
			!isRecord(decoded.header) ||
			decoded.header.alg !== 'RS256' ||
			decoded.header.typ !== 'at+jwt' ||
			typeof decoded.header.kid !== 'string' ||
			!KID_PATTERN.test(decoded.header.kid)
		) {
			throw new UnauthorizedException('Invalid access token');
		}

		return decoded.header as unknown as AccessJwtHeader;
	}
}

const ROLES = new Set<string>(Object.values(Role));
const CLAIM_ID_PATTERN = /^[^\s\x00-\x1f\x7f]{1,256}$/;
const KID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isRole = (value: unknown): value is Role =>
	typeof value === 'string' && ROLES.has(value);

const isUuid = (value: string) => UUID_PATTERN.test(value);

const isNumericDate = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
