import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WidgetsAiSessionTokenService } from './widgets-ai-session-token.service';

describe('WidgetsAiSessionTokenService', () => {
	beforeEach(() => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-28T12:00:00.000Z'));
	});

	afterEach(() => jest.useRealTimers());

	const service = () =>
		new WidgetsAiSessionTokenService(
			new ConfigService({
				WIDGETS_AI_SESSION_SECRET:
					'test-session-secret-with-at-least-32-bytes'
			})
		);

	const identity = {
		publicKey: 'abcdef123456',
		sessionId: 'session_abcdef1234567890',
		ownerId: 'owner-1',
		widgetId: 'widget-1',
		ip: '203.0.113.7',
		publishedVersion: 3
	};

	it('issues a short-lived token bound to key, session, IP and widget version', () => {
		const tokens = service();
		const issued = tokens.issue(identity);
		const claims = tokens.verify(issued.sessionToken, identity);

		expect(claims).toMatchObject({
			publicKey: identity.publicKey,
			sessionId: identity.sessionId,
			publishedVersion: 3
		});
		expect(claims.ownerScope).not.toContain(identity.ownerId);
		expect(claims.widgetScope).not.toContain(identity.widgetId);
		expect(claims.sourceScope).not.toContain(identity.ip);
		expect(() =>
			tokens.assertWidget(claims, {
				id: identity.widgetId,
				userId: identity.ownerId,
				publicKey: identity.publicKey,
				publishedVersion: 3
			})
		).not.toThrow();
	});

	it.each([
		{ publicKey: '000000000000' },
		{ sessionId: 'another_session_123456' },
		{ ip: '203.0.113.8' }
	])('rejects a token outside its signed request scope', override => {
		const tokens = service();
		const issued = tokens.issue(identity);
		expect(() =>
			tokens.verify(issued.sessionToken, { ...identity, ...override })
		).toThrow(UnauthorizedException);
	});

	it('rejects expired, tampered and republished-widget sessions', () => {
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
		jest.setSystemTime(new Date('2026-08-28T12:11:00.000Z'));
		expect(() => tokens.verify(issued.sessionToken, identity)).toThrow(
			UnauthorizedException
		);
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
