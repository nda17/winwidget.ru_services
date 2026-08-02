import {
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common/interfaces';
import { Request } from 'express';
import {
	REPORTING_INTERNAL_TOKEN_ENV,
	REPORTING_INTERNAL_TOKEN_HEADER
} from './reporting-internal.constants';
import {
	isReportingLoopbackAddress,
	ReportingInternalTokenGuard
} from './reporting-internal-token.guard';

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
						...(token !== undefined
							? { [REPORTING_INTERNAL_TOKEN_HEADER]: token }
							: {}),
						...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {})
					}
				}) as unknown as Request
		})
	}) as ExecutionContext;

describe('ReportingInternalTokenGuard', () => {
	const originalToken = process.env[REPORTING_INTERNAL_TOKEN_ENV];
	const token = 'reporting-internal-token-with-at-least-32-characters';

	afterEach(() => {
		if (originalToken === undefined) {
			delete process.env[REPORTING_INTERNAL_TOKEN_ENV];
		} else {
			process.env[REPORTING_INTERNAL_TOKEN_ENV] = originalToken;
		}
	});

	it.each(['127.0.0.1', '127.42.10.3', '::1', '::ffff:127.0.0.1'])(
		'accepts supported loopback address %s',
		address => {
			expect(isReportingLoopbackAddress(address)).toBe(true);
		}
	);

	it('trusts the socket address, token and not forwarded headers', () => {
		process.env[REPORTING_INTERNAL_TOKEN_ENV] = token;
		const guard = new ReportingInternalTokenGuard();

		expect(
			guard.canActivate(
				createContext('127.20.30.40', token, '203.0.113.10')
			)
		).toBe(true);
		expect(() =>
			guard.canActivate(createContext('10.0.0.2', token, '127.0.0.1'))
		).toThrow(ForbiddenException);
	});

	it('fails closed for missing, invalid or placeholder tokens', () => {
		process.env[REPORTING_INTERNAL_TOKEN_ENV] = token;
		const guard = new ReportingInternalTokenGuard();
		expect(() => guard.canActivate(createContext('::1'))).toThrow(
			UnauthorizedException
		);

		process.env[REPORTING_INTERNAL_TOKEN_ENV] =
			'ci_reporting_internal_token_at_least_32_chars';
		expect(() =>
			guard.canActivate(
				createContext(
					'::1',
					'ci_reporting_internal_token_at_least_32_chars'
				)
			)
		).toThrow(ServiceUnavailableException);
	});

	it.each([undefined, 'short-token'])(
		'fails closed for an unavailable or short configured token: %s',
		expectedToken => {
			if (expectedToken === undefined) {
				delete process.env[REPORTING_INTERNAL_TOKEN_ENV];
			} else {
				process.env[REPORTING_INTERNAL_TOKEN_ENV] = expectedToken;
			}
			expect(() =>
				new ReportingInternalTokenGuard().canActivate(
					createContext('::1', token)
				)
			).toThrow(ServiceUnavailableException);
		}
	);

	it.each([undefined, '', 'wrong-token', 'x'.repeat(4097)])(
		'rejects a missing, wrong or oversized supplied token',
		suppliedToken => {
			process.env[REPORTING_INTERNAL_TOKEN_ENV] = token;
			expect(() =>
				new ReportingInternalTokenGuard().canActivate(
					createContext('::1', suppliedToken)
				)
			).toThrow(UnauthorizedException);
		}
	);
});
