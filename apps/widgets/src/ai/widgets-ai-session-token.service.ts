import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CONSENT_TOKEN_VERSION = 1;
const SESSION_TOKEN_VERSION = 2;
const CONSENT_TOKEN_TTL_SECONDS = 15 * 60;
const SESSION_TOKEN_TTL_SECONDS = 10 * 60;
const TOKEN_CLOCK_SKEW_SECONDS = 30;
const TOKEN_MAX_LENGTH = 3_072;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const PUBLIC_KEY_PATTERN = /^[a-f0-9]{12}$/;
const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const UUID_V4_PATTERN =
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DOCUMENT_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type TokenKind = 'consent' | 'session';

interface TokenPayloadBase {
	y: TokenKind;
	k: string;
	s: string;
	o: string;
	w: string;
	i: string;
	q: string;
	p: number;
	r: string;
	a: string;
	c: string;
	d: string;
	h: string;
	t: number;
	e: number;
	n: string;
}

interface ConsentTokenPayload extends TokenPayloadBase {
	v: 1;
	y: 'consent';
}

interface SessionTokenPayload extends TokenPayloadBase {
	v: 2;
	y: 'session';
}

export interface WidgetsAiScopedIdentity {
	ownerScope: string;
	widgetScope: string;
	sourceScope: string;
	sessionScope: string;
}

export interface WidgetsAiConsentBinding {
	consentReceiptId: string;
	acceptanceId: string;
	documentVersion: string;
	documentHash: string;
	requestHostname: string;
}

export interface WidgetsAiConsentClaims
	extends WidgetsAiScopedIdentity, WidgetsAiConsentBinding {
	publicKey: string;
	sessionId: string;
	publishedVersion: number;
	acceptedAt: number;
	expiresAt: number;
}

export interface WidgetsAiSessionClaims
	extends WidgetsAiScopedIdentity, WidgetsAiConsentBinding {
	publicKey: string;
	sessionId: string;
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

export interface WidgetsAiConsentTokenIdentity
	extends WidgetsAiSessionIdentity, WidgetsAiConsentBinding {
	acceptedAt: Date;
	proofExpiresAt: Date;
}

export type WidgetsAiSessionTokenIdentity = WidgetsAiSessionIdentity &
	WidgetsAiConsentBinding;

export interface WidgetsAiConsentTokenResult {
	consentToken: string;
	expiresAt: string;
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

	scopes(identity: {
		ownerId: string;
		widgetId: string;
		ip: string;
		sessionId: string;
	}): WidgetsAiScopedIdentity {
		return {
			ownerScope: this.scope('owner', identity.ownerId),
			widgetScope: this.scope('widget', identity.widgetId),
			sourceScope: this.scope('source', this.source(identity.ip)),
			sessionScope: this.scope('session', identity.sessionId)
		};
	}

	issueConsent(
		identity: WidgetsAiConsentTokenIdentity
	): WidgetsAiConsentTokenResult {
		const issuedAt = Math.floor(identity.acceptedAt.getTime() / 1_000);
		const expiresAt = Math.floor(
			identity.proofExpiresAt.getTime() / 1_000
		);
		if (expiresAt - issuedAt !== CONSENT_TOKEN_TTL_SECONDS) {
			throw new Error('AI consent proof TTL is invalid');
		}
		const payload: ConsentTokenPayload = {
			v: CONSENT_TOKEN_VERSION,
			y: 'consent',
			...this.payload(identity, issuedAt, expiresAt)
		};
		return {
			consentToken: this.encode('consent', payload),
			expiresAt: new Date(expiresAt * 1_000).toISOString()
		};
	}

	verifyConsent(
		token: string,
		expected: { publicKey: string; sessionId: string; ip: string }
	): WidgetsAiConsentClaims {
		const payload = this.decode('consent', token) as ConsentTokenPayload;
		this.assertPayload(
			payload,
			'consent',
			CONSENT_TOKEN_VERSION,
			CONSENT_TOKEN_TTL_SECONDS,
			expected
		);
		return {
			...this.claims(payload),
			acceptedAt: payload.t * 1_000,
			expiresAt: payload.e * 1_000
		};
	}

	issue(
		identity: WidgetsAiSessionTokenIdentity
	): WidgetsAiSessionTokenResult {
		const issuedAt = Math.floor(Date.now() / 1_000);
		const expiresAt = issuedAt + SESSION_TOKEN_TTL_SECONDS;
		const payload: SessionTokenPayload = {
			v: SESSION_TOKEN_VERSION,
			y: 'session',
			...this.payload(identity, issuedAt, expiresAt)
		};
		return {
			sessionId: identity.sessionId,
			sessionToken: this.encode('session', payload),
			expiresAt: new Date(expiresAt * 1_000).toISOString()
		};
	}

	verify(
		token: string,
		expected: { publicKey: string; sessionId: string; ip: string }
	): WidgetsAiSessionClaims {
		const payload = this.decode('session', token) as SessionTokenPayload;
		this.assertPayload(
			payload,
			'session',
			SESSION_TOKEN_VERSION,
			SESSION_TOKEN_TTL_SECONDS,
			expected
		);
		return {
			...this.claims(payload),
			expiresAt: payload.e * 1_000
		};
	}

	assertWidget(
		claims: WidgetsAiSessionClaims | WidgetsAiConsentClaims,
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

	private payload(
		identity: WidgetsAiSessionIdentity & WidgetsAiConsentBinding,
		issuedAt: number,
		expiresAt: number
	): Omit<TokenPayloadBase, 'y'> {
		const scopes = this.scopes(identity);
		return {
			k: identity.publicKey,
			s: identity.sessionId,
			o: scopes.ownerScope,
			w: scopes.widgetScope,
			i: scopes.sourceScope,
			q: scopes.sessionScope,
			p: identity.publishedVersion,
			r: identity.consentReceiptId,
			a: identity.acceptanceId,
			c: identity.documentVersion,
			d: identity.documentHash,
			h: identity.requestHostname,
			t: issuedAt,
			e: expiresAt,
			n: randomBytes(16).toString('base64url')
		};
	}

	private claims(
		payload: ConsentTokenPayload | SessionTokenPayload
	): Omit<WidgetsAiSessionClaims, 'expiresAt'> {
		return {
			publicKey: payload.k,
			sessionId: payload.s,
			ownerScope: payload.o,
			widgetScope: payload.w,
			sourceScope: payload.i,
			sessionScope: payload.q,
			publishedVersion: payload.p,
			consentReceiptId: payload.r,
			acceptanceId: payload.a,
			documentVersion: payload.c,
			documentHash: payload.d,
			requestHostname: payload.h
		};
	}

	private encode(
		kind: TokenKind,
		payload: ConsentTokenPayload | SessionTokenPayload
	): string {
		const encoded = Buffer.from(JSON.stringify(payload)).toString(
			'base64url'
		);
		const signature = this.sign(kind, encoded).toString('base64url');
		return `${encoded}.${signature}`;
	}

	private decode(kind: TokenKind, token: string): unknown {
		if (
			typeof token !== 'string' ||
			token.length > TOKEN_MAX_LENGTH ||
			!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
		) {
			this.invalid();
		}
		const [encoded, suppliedSignature] = token.split('.');
		const expectedSignature = this.sign(kind, encoded);
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

		try {
			const decoded = Buffer.from(encoded, 'base64url');
			if (decoded.toString('base64url') !== encoded) return this.invalid();
			return JSON.parse(decoded.toString('utf8')) as unknown;
		} catch {
			return this.invalid();
		}
	}

	private assertPayload(
		payload: ConsentTokenPayload | SessionTokenPayload,
		kind: TokenKind,
		version: number,
		ttlSeconds: number,
		expected: { publicKey: string; sessionId: string; ip: string }
	): void {
		const now = Math.floor(Date.now() / 1_000);
		if (
			!payload ||
			typeof payload !== 'object' ||
			payload.v !== version ||
			payload.y !== kind ||
			!PUBLIC_KEY_PATTERN.test(payload.k) ||
			!SESSION_ID_PATTERN.test(payload.s) ||
			!SHA256_BASE64URL_PATTERN.test(payload.o) ||
			!SHA256_BASE64URL_PATTERN.test(payload.w) ||
			!SHA256_BASE64URL_PATTERN.test(payload.i) ||
			!SHA256_BASE64URL_PATTERN.test(payload.q) ||
			!UUID_V4_PATTERN.test(payload.r) ||
			!UUID_V4_PATTERN.test(payload.a) ||
			!DOCUMENT_VERSION_PATTERN.test(payload.c) ||
			!SHA256_HEX_PATTERN.test(payload.d) ||
			typeof payload.h !== 'string' ||
			!payload.h ||
			payload.h.length > 253 ||
			/[\s\u0000-\u001f\u007f]/.test(payload.h) ||
			!TOKEN_ID_PATTERN.test(payload.n) ||
			!Number.isInteger(payload.p) ||
			payload.p < 1 ||
			!Number.isInteger(payload.t) ||
			!Number.isInteger(payload.e) ||
			payload.t > now + TOKEN_CLOCK_SKEW_SECONDS ||
			payload.e <= now ||
			payload.e - payload.t !== ttlSeconds ||
			payload.k !== expected.publicKey ||
			payload.s !== expected.sessionId ||
			!this.equal(
				payload.i,
				this.scope('source', this.source(expected.ip))
			) ||
			!this.equal(payload.q, this.scope('session', expected.sessionId))
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

	private sign(kind: TokenKind, value: string): Buffer {
		return createHmac('sha256', this.secret)
			.update('winwidget-ai-token')
			.update('\0')
			.update(kind)
			.update('\0')
			.update(value)
			.digest();
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
			'Сессия или согласие AI-консультанта недействительны либо истекли'
		);
	}
}
