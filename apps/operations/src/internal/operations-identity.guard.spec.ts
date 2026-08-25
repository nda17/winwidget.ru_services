import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { OperationsIdentityGuard } from './operations-identity.guard';

const TOKEN = 'operations-identity-test-token-at-least-32-characters';

function context(
	address = '127.0.0.1',
	service = 'identity',
	token = TOKEN
): ExecutionContext {
	return {
		switchToHttp: () => ({
			getRequest: () => ({
				socket: { remoteAddress: address },
				header: (name: string) =>
					({
						'x-winwidget-service': service,
						'x-winwidget-internal-token': token
					})[name]
			})
		})
	} as ExecutionContext;
}

describe('OperationsIdentityGuard', () => {
	it('accepts only Identity over loopback with its scoped token', () => {
		const guard = new OperationsIdentityGuard({
			get: () => TOKEN
		} as unknown as ConfigService);

		expect(guard.canActivate(context())).toBe(true);
		expect(() => guard.canActivate(context('10.0.0.2'))).toThrow(
			'Invalid internal credentials'
		);
		expect(() => guard.canActivate(context('127.0.0.1', 'core'))).toThrow(
			'Invalid internal credentials'
		);
		expect(() =>
			guard.canActivate(context('127.0.0.1', 'identity', 'wrong'))
		).toThrow('Invalid internal credentials');
	});

	it.each([
		'short',
		'operations_identity_token',
		'ci_operations_identity_token_at_least_32_chars',
		'change_me_operations_identity_token_at_least_32_chars'
	])('rejects weak scoped token %s', token => {
		expect(
			() =>
				new OperationsIdentityGuard({
					get: () => token
				} as unknown as ConfigService)
		).toThrow('OPERATIONS_IDENTITY_TOKEN');
	});
});
