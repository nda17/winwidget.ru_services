import {
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common/interfaces';
import { Request } from 'express';
import {
	CAMPAIGNS_INTERNAL_TOKEN_ENV,
	CAMPAIGNS_INTERNAL_TOKEN_HEADER
} from './campaigns-internal.constants';
import {
	CampaignsInternalTokenGuard,
	isCampaignsLoopbackAddress
} from './campaigns-internal-token.guard';

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
						...(token ? { [CAMPAIGNS_INTERNAL_TOKEN_HEADER]: token } : {}),
						...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {})
					}
				}) as unknown as Request
		})
	}) as ExecutionContext;

describe('CampaignsInternalTokenGuard', () => {
	const originalToken = process.env[CAMPAIGNS_INTERNAL_TOKEN_ENV];
	const token = 'campaigns-internal-token-with-at-least-32-characters';

	afterEach(() => {
		if (originalToken === undefined) {
			delete process.env[CAMPAIGNS_INTERNAL_TOKEN_ENV];
		} else {
			process.env[CAMPAIGNS_INTERNAL_TOKEN_ENV] = originalToken;
		}
	});

	it.each([
		'127.0.0.1',
		'127.42.10.3',
		'::1',
		'::ffff:127.0.0.1',
		'::ffff:127.255.255.255'
	])('accepts the supported loopback address %s', address => {
		expect(isCampaignsLoopbackAddress(address)).toBe(true);
	});

	it('requires the service token and trusts only the socket address', () => {
		process.env[CAMPAIGNS_INTERNAL_TOKEN_ENV] = token;
		const guard = new CampaignsInternalTokenGuard();

		expect(
			guard.canActivate(
				createContext('127.20.30.40', token, '203.0.113.10')
			)
		).toBe(true);
		expect(() =>
			guard.canActivate(createContext('10.0.0.2', token, '127.0.0.1'))
		).toThrow(ForbiddenException);
	});

	it('rejects a missing or invalid service token', () => {
		process.env[CAMPAIGNS_INTERNAL_TOKEN_ENV] = token;
		const guard = new CampaignsInternalTokenGuard();

		expect(() => guard.canActivate(createContext('::1'))).toThrow(
			UnauthorizedException
		);
		expect(() =>
			guard.canActivate(createContext('::1', `${token}-wrong`))
		).toThrow(UnauthorizedException);
	});

	it('fails closed when the configured service token is insecure', () => {
		process.env[CAMPAIGNS_INTERNAL_TOKEN_ENV] = 'short';
		const guard = new CampaignsInternalTokenGuard();

		expect(() =>
			guard.canActivate(createContext('127.0.0.1', 'short'))
		).toThrow(ServiceUnavailableException);
	});
});
