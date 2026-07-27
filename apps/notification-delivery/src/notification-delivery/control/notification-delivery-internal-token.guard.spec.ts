import {
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common/interfaces';
import { Request } from 'express';
import {
	NOTIFICATION_DELIVERY_INTERNAL_TOKEN_ENV,
	NOTIFICATION_DELIVERY_INTERNAL_TOKEN_HEADER,
	NotificationDeliveryInternalTokenGuard,
	isNotificationDeliveryLoopbackAddress
} from './notification-delivery-internal-token.guard';

const createContext = (
	remoteAddress: string,
	token?: string,
	forwardedFor?: string
) =>
	({
		switchToHttp: () => ({
			getRequest: () =>
				({
					socket: { remoteAddress },
					headers: {
						...(token
							? {
									[NOTIFICATION_DELIVERY_INTERNAL_TOKEN_HEADER]: token
								}
							: {}),
						...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {})
					}
				}) as unknown as Request
		})
	}) as ExecutionContext;

describe('NotificationDeliveryInternalTokenGuard', () => {
	const originalToken =
		process.env[NOTIFICATION_DELIVERY_INTERNAL_TOKEN_ENV];
	const token = 'a-secure-internal-token-with-32-characters';

	afterEach(() => {
		if (originalToken === undefined) {
			delete process.env[NOTIFICATION_DELIVERY_INTERNAL_TOKEN_ENV];
		} else {
			process.env[NOTIFICATION_DELIVERY_INTERNAL_TOKEN_ENV] =
				originalToken;
		}
	});

	it.each([
		'127.0.0.1',
		'127.42.10.3',
		'::1',
		'::ffff:127.0.0.1',
		'::ffff:127.255.255.255'
	])('accepts the supported loopback address %s', address => {
		expect(isNotificationDeliveryLoopbackAddress(address)).toBe(true);
	});

	it('requires a valid token and uses the socket address', () => {
		process.env[NOTIFICATION_DELIVERY_INTERNAL_TOKEN_ENV] = token;
		const guard = new NotificationDeliveryInternalTokenGuard();

		expect(
			guard.canActivate(
				createContext('127.20.30.40', token, '203.0.113.10')
			)
		).toBe(true);
	});

	it('does not trust x-forwarded-for for loopback access', () => {
		process.env[NOTIFICATION_DELIVERY_INTERNAL_TOKEN_ENV] = token;
		const guard = new NotificationDeliveryInternalTokenGuard();

		expect(() =>
			guard.canActivate(createContext('10.0.0.2', token, '127.0.0.1'))
		).toThrow(ForbiddenException);
	});

	it('rejects a missing or incorrect token', () => {
		process.env[NOTIFICATION_DELIVERY_INTERNAL_TOKEN_ENV] = token;
		const guard = new NotificationDeliveryInternalTokenGuard();

		expect(() => guard.canActivate(createContext('::1'))).toThrow(
			UnauthorizedException
		);
		expect(() =>
			guard.canActivate(createContext('::1', `${token}-wrong`))
		).toThrow(UnauthorizedException);
	});

	it('fails closed when the configured secret is too short', () => {
		process.env[NOTIFICATION_DELIVERY_INTERNAL_TOKEN_ENV] = 'short';
		const guard = new NotificationDeliveryInternalTokenGuard();

		expect(() =>
			guard.canActivate(createContext('127.0.0.1', 'short'))
		).toThrow(ServiceUnavailableException);
	});
});
