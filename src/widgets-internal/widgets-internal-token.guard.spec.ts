import { ExecutionContext } from '@nestjs/common';
import {
	WIDGETS_INTERNAL_TOKEN_ENV,
	WIDGETS_INTERNAL_TOKEN_HEADER
} from './widgets-internal.constants';
import {
	isWidgetsLoopbackAddress,
	WidgetsInternalTokenGuard
} from './widgets-internal-token.guard';

const context = (address: string, token?: string): ExecutionContext =>
	({
		switchToHttp: () => ({
			getRequest: () => ({
				socket: { remoteAddress: address },
				headers: token ? { [WIDGETS_INTERNAL_TOKEN_HEADER]: token } : {}
			})
		})
	}) as ExecutionContext;

describe('WidgetsInternalTokenGuard', () => {
	const original = process.env[WIDGETS_INTERNAL_TOKEN_ENV];

	afterEach(() => {
		if (original === undefined) {
			delete process.env[WIDGETS_INTERNAL_TOKEN_ENV];
		} else {
			process.env[WIDGETS_INTERNAL_TOKEN_ENV] = original;
		}
	});

	it.each(['127.0.0.1', '127.12.34.56', '::1', '::ffff:127.0.0.1'])(
		'accepts loopback address %s',
		address => {
			expect(isWidgetsLoopbackAddress(address)).toBe(true);
		}
	);

	it.each(['10.0.0.2', '::ffff:10.0.0.2', '127.999.0.1', undefined])(
		'rejects non-loopback address %s',
		address => {
			expect(isWidgetsLoopbackAddress(address)).toBe(false);
		}
	);

	it('requires a secure matching token on loopback', () => {
		const token = 'widgets-internal-token-at-least-32-characters';
		process.env[WIDGETS_INTERNAL_TOKEN_ENV] = token;
		const guard = new WidgetsInternalTokenGuard();

		expect(guard.canActivate(context('127.0.0.1', token))).toBe(true);
		expect(() =>
			guard.canActivate(context('127.0.0.1', 'wrong-token'))
		).toThrow('Invalid Widgets internal token');
		expect(() => guard.canActivate(context('10.0.0.2', token))).toThrow(
			'loopback-only'
		);
	});

	it('fails closed for an absent or placeholder server token', () => {
		const guard = new WidgetsInternalTokenGuard();
		delete process.env[WIDGETS_INTERNAL_TOKEN_ENV];
		expect(() =>
			guard.canActivate(context('127.0.0.1', 'any-token'))
		).toThrow('not configured securely');

		process.env[WIDGETS_INTERNAL_TOKEN_ENV] = 'XYZXYZXYZ';
		expect(() =>
			guard.canActivate(context('127.0.0.1', 'XYZXYZXYZ'))
		).toThrow('not configured securely');
	});
});
