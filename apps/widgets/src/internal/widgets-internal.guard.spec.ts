import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import {
	isWidgetsInternalLoopback,
	WidgetsInternalGuard
} from './widgets-internal.guard';

const token = 'widgets-internal-test-token-with-at-least-32-characters';
const context = (address: string, supplied = token) =>
	({
		switchToHttp: () => ({
			getRequest: () => ({
				socket: { remoteAddress: address },
				headers: { 'x-winwidget-internal-token': supplied }
			})
		})
	}) as ExecutionContext;

describe('WidgetsInternalGuard', () => {
	it.each(['127.0.0.1', '127.25.30.40', '::1', '::ffff:127.0.0.1'])(
		'accepts loopback address %s',
		address => {
			expect(isWidgetsInternalLoopback(address)).toBe(true);
		}
	);

	it.each(['10.0.0.2', '::ffff:10.0.0.2', '127.999.0.1'])(
		'rejects non-loopback address %s',
		address => {
			expect(isWidgetsInternalLoopback(address)).toBe(false);
		}
	);

	it('requires loopback and a timing-safe matching token', () => {
		const guard = new WidgetsInternalGuard({
			get: () => token
		} as unknown as ConfigService);
		expect(guard.canActivate(context('127.0.0.1'))).toBe(true);
		expect(() => guard.canActivate(context('10.0.0.2'))).toThrow(
			'loopback-only'
		);
		expect(() => guard.canActivate(context('127.0.0.1', 'wrong'))).toThrow(
			'Invalid internal credentials'
		);
	});

	it('fails application startup for placeholder credentials', () => {
		expect(
			() =>
				new WidgetsInternalGuard({
					get: () => 'ci_widgets_internal_token_at_least_32_chars'
				} as unknown as ConfigService)
		).toThrow('at least 32 characters');
	});
});
