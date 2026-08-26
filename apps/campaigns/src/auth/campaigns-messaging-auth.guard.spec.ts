import { CampaignsMessagingOverviewController } from '../internal/campaigns-messaging-overview.controller';
import { CampaignsRuntimeService } from '../runtime/campaigns-runtime.service';
import {
	CampaignsApiGuard,
	CampaignsMessagingInternalGuard,
	isCampaignsMessagingLoopback
} from './campaigns-auth.guard';
import {
	ExecutionContext,
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';

const TOKEN = 'campaigns-overview-internal-token-at-least-32-characters';

const createContext = (
	address: string,
	token: string | string[] | null = TOKEN,
	service: string | string[] | undefined = 'operations'
): ExecutionContext =>
	({
		switchToHttp: () => ({
			getRequest: () => ({
				socket: { remoteAddress: address },
				headers: {
					'x-winwidget-service': service,
					...(token === null
						? {}
						: { 'x-winwidget-internal-token': token })
				}
			})
		})
	}) as unknown as ExecutionContext;

describe('Campaigns messaging overview guards', () => {
	const guard = () =>
		new CampaignsMessagingInternalGuard({
			get: jest.fn().mockReturnValue(TOKEN)
		} as unknown as ConfigService);

	it('binds both the API-role and internal caller guards to the endpoint', () => {
		expect(
			Reflect.getMetadata(
				GUARDS_METADATA,
				CampaignsMessagingOverviewController
			)
		).toEqual([CampaignsApiGuard, CampaignsMessagingInternalGuard]);
	});

	it.each(['127.0.0.1', '127.23.45.67', '::1', '::ffff:127.0.0.1'])(
		'allows an authenticated Operations caller on loopback %s',
		address => {
			expect(guard().canActivate(createContext(address))).toBe(true);
		}
	);

	it.each(['10.0.0.5', '::ffff:10.0.0.5', '::2', 'localhost'])(
		'rejects a non-loopback caller %s',
		address => {
			expect(() => guard().canActivate(createContext(address))).toThrow(
				ForbiddenException
			);
		}
	);

	it('rejects the wrong service identity before accepting its token', () => {
		expect(() =>
			guard().canActivate(createContext('127.0.0.1', TOKEN, 'reporting'))
		).toThrow(ForbiddenException);
	});

	it.each([null, 'wrong-token', [TOKEN]])(
		'rejects an invalid token header %#',
		token => {
			expect(() =>
				guard().canActivate(createContext('127.0.0.1', token))
			).toThrow(UnauthorizedException);
		}
	);

	it('fails startup closed for an insecure configured token', () => {
		expect(
			() =>
				new CampaignsMessagingInternalGuard({
					get: jest.fn().mockReturnValue('change_me')
				} as unknown as ConfigService)
		).toThrow('non-placeholder secret');
	});

	it('rejects the endpoint outside the API process role', () => {
		const apiGuard = new CampaignsApiGuard({
			apiEnabled: false
		} as CampaignsRuntimeService);

		expect(() => apiGuard.canActivate()).toThrow(
			ServiceUnavailableException
		);
	});
});

describe('isCampaignsMessagingLoopback', () => {
	it('rejects missing and malformed addresses', () => {
		expect(isCampaignsMessagingLoopback(undefined)).toBe(false);
		expect(isCampaignsMessagingLoopback('127.0.0.999')).toBe(false);
	});
});
