import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
	IDENTITY_INTERNAL_SERVICES,
	IdentityInternalGuard,
	type IdentityInternalService
} from './internal.guard';

function credential(service: IdentityInternalService): string {
	return `test-${service}-${'x'.repeat(48)}`;
}

function environment(): Record<string, string> {
	return {
		WINCRM_INVITATION_EMAIL_ENABLED: 'true',
		...Object.fromEntries(
			IDENTITY_INTERNAL_SERVICES.map(service => [
				`IDENTITY_${service.replace(/-/g, '_').toUpperCase()}_TOKEN`,
				credential(service)
			])
		)
	};
}

function config(values: Record<string, string>): ConfigService {
	return {
		get: jest.fn((name: string) => values[name])
	} as unknown as ConfigService;
}

function context(
	service: IdentityInternalService,
	token: string,
	remoteAddress = '127.0.0.1'
): ExecutionContext {
	const headers: Record<string, string> = {
		'x-winwidget-service': service,
		'x-winwidget-internal-token': token
	};
	const request = {
		header: (name: string) => headers[name.toLowerCase()],
		socket: { remoteAddress }
	};
	return {
		getHandler: () => function handler() {},
		getClass: () => class Controller {},
		switchToHttp: () => ({ getRequest: () => request })
	} as unknown as ExecutionContext;
}

function guard(allowed: IdentityInternalService[]) {
	const reflector = {
		getAllAndOverride: jest.fn().mockReturnValue(allowed)
	} as unknown as Reflector;
	return new IdentityInternalGuard(config(environment()), reflector);
}

describe('IdentityInternalGuard', () => {
	it('keeps the optional notification caller disabled without requiring a new token', () => {
		const values = environment();
		values.WINCRM_INVITATION_EMAIL_ENABLED = 'false';
		delete values.IDENTITY_NOTIFICATION_DELIVERY_TOKEN;
		const instance = new IdentityInternalGuard(config(values), {
			getAllAndOverride: () => ['notification-delivery']
		} as never);
		expect(() =>
			instance.canActivate(
				context(
					'notification-delivery',
					credential('notification-delivery')
				)
			)
		).toThrow(ForbiddenException);
		values.WINCRM_INVITATION_EMAIL_ENABLED = 'true';
		expect(
			() => new IdentityInternalGuard(config(values), new Reflector())
		).toThrow('IDENTITY_NOTIFICATION_DELIVERY_TOKEN');
	});
	it.each(IDENTITY_INTERNAL_SERVICES)(
		'allows the matching scoped %s credential from loopback',
		service => {
			expect(
				guard([service]).canActivate(context(service, credential(service)))
			).toBe(true);
		}
	);

	it('rejects a valid token from another service scope with 403', () => {
		expect(() =>
			guard(['operations']).canActivate(
				context('operations', credential('billing'))
			)
		).toThrow(ForbiddenException);
	});

	it('does not let the Platform credential escape its endpoint scope', () => {
		expect(() =>
			guard(['operations']).canActivate(
				context('platform', credential('platform'))
			)
		).toThrow(ForbiddenException);
	});

	it('does not let the Support credential escape its endpoint scope', () => {
		expect(() =>
			guard(['operations']).canActivate(
				context('support', credential('support'))
			)
		).toThrow(ForbiddenException);
	});

	it('does not let the Reporting credential escape its endpoint scope', () => {
		expect(() =>
			guard(['operations']).canActivate(
				context('reporting', credential('reporting'))
			)
		).toThrow(ForbiddenException);
	});

	it('rejects non-loopback callers before token comparison', () => {
		expect(() =>
			guard(['operations']).canActivate(
				context('operations', credential('operations'), '10.10.0.25')
			)
		).toThrow('Invalid internal credentials');
	});

	it('rejects exact CI placeholders and pairwise-equal credentials at startup', () => {
		const placeholder = environment();
		placeholder.IDENTITY_OPERATIONS_TOKEN =
			'ci_identity_operations_token_at_least_32_chars';
		expect(
			() => new IdentityInternalGuard(config(placeholder), new Reflector())
		).toThrow('non-placeholder secret');

		const duplicate = environment();
		duplicate.IDENTITY_PLATFORM_TOKEN =
			duplicate.IDENTITY_OPERATIONS_TOKEN;
		expect(
			() => new IdentityInternalGuard(config(duplicate), new Reflector())
		).toThrow('pairwise distinct');
	});
});
