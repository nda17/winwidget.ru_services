import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { BillingOperationsGuard } from './billing-operations.guard';

const TOKEN = 'billing-operations-test-token-at-least-32-characters';

function context(
	token = TOKEN,
	service = 'operations',
	remoteAddress = '127.0.0.1'
) {
	return {
		switchToHttp: () => ({
			getRequest: () => ({
				header: (name: string) =>
					name === 'x-winwidget-internal-token'
						? token
						: name === 'x-winwidget-service'
							? service
							: undefined,
				socket: { remoteAddress }
			})
		})
	} as ExecutionContext;
}

describe('BillingOperationsGuard', () => {
	const guard = (value: string | undefined) =>
		new BillingOperationsGuard({
			get: () => value
		} as unknown as ConfigService);

	it('accepts only the exact Operations credential from loopback', () => {
		expect(guard(TOKEN).canActivate(context())).toBe(true);
	});

	it.each([
		context(TOKEN, 'core'),
		context(TOKEN, 'operations', '10.0.0.2'),
		context('wrong', 'operations')
	])('rejects an invalid caller', requestContext => {
		expect(() => guard(TOKEN).canActivate(requestContext)).toThrow(
			ForbiddenException
		);
	});

	it.each([undefined, 'short', 'change_me'])(
		'fails closed for weak configured token %s',
		value => {
			expect(() => guard(value)).toThrow('BILLING_OPERATIONS_TOKEN');
		}
	);
});
