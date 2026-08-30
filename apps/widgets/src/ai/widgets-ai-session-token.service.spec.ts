import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { WidgetsAiSessionTokenService } from './widgets-ai-session-token.service';

describe('WidgetsAiSessionTokenService', () => {
	beforeEach(() => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
	});

	afterEach(() => jest.useRealTimers());

	const secret = 'test-session-secret-with-at-least-32-bytes';
	const service = () =>
		new WidgetsAiSessionTokenService(
			new ConfigService({ WIDGETS_AI_SESSION_SECRET: secret })
		);
	const binding = {
		consentReceiptId: '11111111-1111-4111-8111-111111111111',
		acceptanceId: '22222222-2222-4222-8222-222222222222',
		documentVersion: 'ai-consultant-consent-v2',
		documentHash: 'a'.repeat(64),
		requestHostname: 'shop.example.test'
	};
	const identity = {
		publicKey: 'abcdef123456',
		sessionId: 'session_abcdef1234567890',
		ownerId: 'owner-1',
		widgetId: 'widget-1',
		ip: '203.0.113.7',
		publishedVersion: 3,
		...binding
	};
	const consentIdentity = {
		...identity,
		acceptedAt: new Date('2026-08-30T12:00:00.000Z'),
		proofExpiresAt: new Date('2026-08-30T12:15:00.000Z')
	};

	it('issues a consent proof bound to immutable document and request evidence', () => {
		const tokens = service();
		const issued = tokens.issueConsent(consentIdentity);
		const claims = tokens.verifyConsent(issued.consentToken, identity);

		expect(issued.expiresAt).toBe('2026-08-30T12:15:00.000Z');
		expect(claims).toMatchObject({
			publicKey: identity.publicKey,
			sessionId: identity.sessionId,
			publishedVersion: 3,
			acceptedAt: consentIdentity.acceptedAt.getTime(),
			expiresAt: consentIdentity.proofExpiresAt.getTime(),
			...binding
		});
		expect(claims.ownerScope).not.toContain(identity.ownerId);
		expect(claims.widgetScope).not.toContain(identity.widgetId);
		expect(claims.sourceScope).not.toContain(identity.ip);
		expect(claims.sessionScope).not.toContain(identity.sessionId);
	});

	it('issues a v2 session token bound to the verified consent receipt', () => {
		const tokens = service();
		const issued = tokens.issue(identity);
		const claims = tokens.verify(issued.sessionToken, identity);

		expect(claims).toMatchObject({
			publicKey: identity.publicKey,
			sessionId: identity.sessionId,
			publishedVersion: 3,
			...binding
		});
		expect(() =>
			tokens.assertWidget(claims, {
				id: identity.widgetId,
				userId: identity.ownerId,
				publicKey: identity.publicKey,
				publishedVersion: 3
			})
		).not.toThrow();
	});

	it('does not accept consent and session tokens interchangeably', () => {
		const tokens = service();
		const consent = tokens.issueConsent(consentIdentity);
		const session = tokens.issue(identity);

		expect(() => tokens.verify(consent.consentToken, identity)).toThrow(
			UnauthorizedException
		);
		expect(() =>
			tokens.verifyConsent(session.sessionToken, identity)
		).toThrow(UnauthorizedException);
	});

	it.each([
		{ publicKey: '000000000000' },
		{ sessionId: 'another_session_123456' },
		{ ip: '203.0.113.8' }
	])('rejects a session outside its signed request scope', override => {
		const tokens = service();
		const issued = tokens.issue(identity);
		expect(() =>
			tokens.verify(issued.sessionToken, { ...identity, ...override })
		).toThrow(UnauthorizedException);
	});

	it('rejects tampering, expiry and a republished widget', () => {
		const tokens = service();
		const issued = tokens.issue(identity);
		const claims = tokens.verify(issued.sessionToken, identity);
		const tampered = `${issued.sessionToken.slice(0, -1)}x`;

		expect(() => tokens.verify(tampered, identity)).toThrow(
			UnauthorizedException
		);
		expect(() =>
			tokens.assertWidget(claims, {
				id: identity.widgetId,
				userId: identity.ownerId,
				publicKey: identity.publicKey,
				publishedVersion: 4
			})
		).toThrow(UnauthorizedException);
		jest.setSystemTime(new Date('2026-08-30T12:11:00.000Z'));
		expect(() => tokens.verify(issued.sessionToken, identity)).toThrow(
			UnauthorizedException
		);
	});

	it('rejects legacy v1 session signatures without compatibility mode', () => {
		const tokens = service();
		const encoded = Buffer.from(
			JSON.stringify({
				v: 1,
				k: identity.publicKey,
				s: identity.sessionId,
				t: Math.floor(Date.now() / 1000),
				e: Math.floor(Date.now() / 1000) + 600
			})
		).toString('base64url');
		const signature = createHmac('sha256', secret)
			.update(encoded)
			.digest('base64url');

		expect(() =>
			tokens.verify(`${encoded}.${signature}`, identity)
		).toThrow(UnauthorizedException);
	});

	it('rejects an invalid consent proof lifetime', () => {
		expect(() =>
			service().issueConsent({
				...consentIdentity,
				proofExpiresAt: new Date('2026-08-30T12:14:59.000Z')
			})
		).toThrow('AI consent proof TTL is invalid');
	});

	it('fails closed without a strong server secret', () => {
		expect(
			() =>
				new WidgetsAiSessionTokenService(
					new ConfigService({ WIDGETS_AI_SESSION_SECRET: 'short' })
				)
		).toThrow('WIDGETS_AI_SESSION_SECRET');
	});
});
