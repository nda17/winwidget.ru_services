import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TOKEN_VERSION = 1;
const SESSION_TOKEN_TTL_SECONDS = 10 * 60;
const SESSION_TOKEN_CLOCK_SKEW_SECONDS = 30;
const SESSION_TOKEN_MAX_LENGTH = 2_048;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const PUBLIC_KEY_PATTERN = /^[a-f0-9]{12}$/;
const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

interface SessionTokenPayload {
	v: 1;
	k: string;
	s: string;
	o: string;
	w: string;
	i: string;
	p: number;
	t: number;
	e: number;
	n: string;
}

export interface WidgetsAiSessionClaims {
	publicKey: string;
	sessionId: string;
	ownerScope: string;
	widgetScope: string;
	sourceScope: string;
	publishedVersion: number;
	expiresAt: number;
}

export interface WidgetsAiSessionIdentity {
	publicKey: string;
	sessionId: string;
	ownerId: string;
	widgetId: string;
	ip: string;
	publishedVersion: number;
}

export interface WidgetsAiSessionTokenResult {
	sessionId: string;
	sessionToken: string;
	expiresAt: string;
}

@Injectable()
export class WidgetsAiSessionTokenService {
	private readonly secret: Buffer;

	constructor(config: ConfigService) {
		const value = config.get<string>('WIDGETS_AI_SESSION_SECRET') || '';
		if (Buffer.byteLength(value, 'utf8') < 32) {
			throw new Error(
				'WIDGETS_AI_SESSION_SECRET is required and must contain at least 32 bytes'
			);
		}
		this.secret = Buffer.from(value, 'utf8');
	}

	issue(identity: WidgetsAiSessionIdentity): WidgetsAiSessionTokenResult {
		const issuedAt = Math.floor(Date.now() / 1_000);
		const expiresAt = issuedAt + SESSION_TOKEN_TTL_SECONDS;
		const payload: SessionTokenPayload = {
			v: SESSION_TOKEN_VERSION,
			k: identity.publicKey,
			s: identity.sessionId,
			o: this.scope('owner', identity.ownerId),
			w: this.scope('widget', identity.widgetId),
			i: this.scope('source', this.source(identity.ip)),
			p: identity.publishedVersion,
			t: issuedAt,
			e: expiresAt,
			n: randomBytes(16).toString('base64url')
		};
		const encoded = Buffer.from(JSON.stringify(payload)).toString(
			'base64url'
		);
		const signature = this.sign(encoded).toString('base64url');
		return {
			sessionId: identity.sessionId,
			sessionToken: `${encoded}.${signature}`,
			expiresAt: new Date(expiresAt * 1_000).toISOString()
		};
	}

	verify(
		token: string,
		expected: { publicKey: string; sessionId: string; ip: string }
	): WidgetsAiSessionClaims {
		if (
			token.length > SESSION_TOKEN_MAX_LENGTH ||
			!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
		) {
			this.invalid();
		}
		const [encoded, suppliedSignature] = token.split('.');
		const expectedSignature = this.sign(encoded);
		let signature: Buffer;
		try {
			signature = Buffer.from(suppliedSignature, 'base64url');
		} catch {
			return this.invalid();
		}
		if (
			signature.toString('base64url') !== suppliedSignature ||
			signature.length !== expectedSignature.length ||
			!timingSafeEqual(signature, expectedSignature)
		) {
			this.invalid();
		}

		let payload: SessionTokenPayload;
		try {
			const decoded = Buffer.from(encoded, 'base64url');
			if (decoded.toString('base64url') !== encoded) return this.invalid();
			payload = JSON.parse(
				decoded.toString('utf8')
			) as SessionTokenPayload;
		} catch {
			return this.invalid();
		}
		const now = Math.floor(Date.now() / 1_000);
		if (
			!payload ||
			typeof payload !== 'object' ||
			payload.v !== SESSION_TOKEN_VERSION ||
			!PUBLIC_KEY_PATTERN.test(payload.k) ||
			!SESSION_ID_PATTERN.test(payload.s) ||
			!SHA256_BASE64URL_PATTERN.test(payload.o) ||
			!SHA256_BASE64URL_PATTERN.test(payload.w) ||
			!SHA256_BASE64URL_PATTERN.test(payload.i) ||
			!TOKEN_ID_PATTERN.test(payload.n) ||
			!Number.isInteger(payload.p) ||
			payload.p < 1 ||
			!Number.isInteger(payload.t) ||
			!Number.isInteger(payload.e) ||
			payload.t > now + SESSION_TOKEN_CLOCK_SKEW_SECONDS ||
			payload.e <= now ||
			payload.e - payload.t !== SESSION_TOKEN_TTL_SECONDS ||
			payload.k !== expected.publicKey ||
			payload.s !== expected.sessionId ||
			!this.equal(
				payload.i,
				this.scope('source', this.source(expected.ip))
			)
		) {
			this.invalid();
		}
		return {
			publicKey: payload.k,
			sessionId: payload.s,
			ownerScope: payload.o,
			widgetScope: payload.w,
			sourceScope: payload.i,
			publishedVersion: payload.p,
			expiresAt: payload.e * 1_000
		};
	}

	assertWidget(
		claims: WidgetsAiSessionClaims,
		widget: {
			id: string;
			userId: string;
			publicKey: string;
			publishedVersion: number;
		}
	): void {
		if (
			claims.publicKey !== widget.publicKey ||
			claims.publishedVersion !== widget.publishedVersion ||
			!this.equal(claims.ownerScope, this.scope('owner', widget.userId)) ||
			!this.equal(claims.widgetScope, this.scope('widget', widget.id))
		) {
			this.invalid();
		}
	}

	private source(ip: string): string {
		return ip.trim() || 'unknown';
	}

	private scope(kind: string, value: string): string {
		return createHmac('sha256', this.secret)
			.update(kind)
			.update('\0')
			.update(value)
			.digest('base64url');
	}

	private sign(value: string): Buffer {
		return createHmac('sha256', this.secret).update(value).digest();
	}

	private equal(left: string, right: string): boolean {
		const leftBuffer = Buffer.from(left);
		const rightBuffer = Buffer.from(right);
		return (
			leftBuffer.length === rightBuffer.length &&
			timingSafeEqual(leftBuffer, rightBuffer)
		);
	}

	private invalid(): never {
		throw new UnauthorizedException(
			'Сессия AI-консультанта недействительна или истекла'
		);
	}
}
