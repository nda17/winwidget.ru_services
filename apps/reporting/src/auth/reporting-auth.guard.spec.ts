import { ReportingAnalyticsController } from '../analytics/reporting-analytics.controller';
import { ReportingDeliveryFailuresController } from '../delivery-failures/reporting-delivery-failures.controller';
import { IdentityIntrospectionClient } from '../internal/identity-introspection.client';
import { ReportingMessagingOverviewController } from '../internal/reporting-messaging-overview.controller';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import { DailySummarySettingsController } from '../settings/daily-summary-settings.controller';
import {
	REPORTING_REQUIRED_ROLE,
	ReportingAdminGuard,
	ReportingApiGuard,
	ReportingMessagingInternalGuard,
	isReportingMessagingLoopback
} from './reporting-auth.guard';
import type { ReportingRequest } from './reporting-request';
import {
	ExecutionContext,
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

const createContext = (
	request: Pick<ReportingRequest, 'headers'> &
		Partial<Pick<ReportingRequest, 'reportingActor'>>,
	handler: object,
	type: object
): ExecutionContext =>
	({
		switchToHttp: () => ({ getRequest: () => request }),
		getHandler: () => handler,
		getClass: () => type
	}) as unknown as ExecutionContext;

describe('ReportingAdminGuard access matrix', () => {
	const identity = {
		introspect: jest.fn()
	};
	const reflector = new Reflector();
	const guard = new ReportingAdminGuard(
		reflector,
		identity as unknown as IdentityIntrospectionClient
	);

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('keeps the existing controller-level policies on ADMIN', () => {
		expect(
			Reflect.getMetadata(
				REPORTING_REQUIRED_ROLE,
				ReportingAnalyticsController
			)
		).toBe('ADMIN');
		expect(
			Reflect.getMetadata(
				REPORTING_REQUIRED_ROLE,
				DailySummarySettingsController
			)
		).toBe('ADMIN');
		expect(
			Reflect.getMetadata(
				REPORTING_REQUIRED_ROLE,
				ReportingDeliveryFailuresController
			)
		).toBe('ADMIN');
	});

	it('overrides manual retry with a DEV-only policy', () => {
		expect(
			Reflect.getMetadata(
				REPORTING_REQUIRED_ROLE,
				ReportingDeliveryFailuresController.prototype.retry
			)
		).toBe('DEV');
	});

	it('allows ADMIN to use the read-only analytics policy', async () => {
		identity.introspect.mockResolvedValue({
			active: true,
			subject: 'admin-id',
			sessionId: 'session-id',
			roles: ['ADMIN']
		});
		const request = { headers: { authorization: 'Bearer token' } };

		await expect(
			guard.canActivate(
				createContext(
					request,
					ReportingAnalyticsController.prototype.getOverview,
					ReportingAnalyticsController
				)
			)
		).resolves.toBe(true);
		expect(request).toHaveProperty('reportingActor.subject', 'admin-id');
	});

	it('rejects ADMIN without DEV on manual retry', async () => {
		identity.introspect.mockResolvedValue({
			active: true,
			subject: 'admin-id',
			sessionId: 'session-id',
			roles: ['ADMIN']
		});

		await expect(
			guard.canActivate(
				createContext(
					{ headers: { authorization: 'Bearer token' } },
					ReportingDeliveryFailuresController.prototype.retry,
					ReportingDeliveryFailuresController
				)
			)
		).rejects.toThrow(new ForbiddenException('DEV role is required'));
	});

	it('allows DEV on manual retry without trusting forwarded roles', async () => {
		identity.introspect.mockResolvedValue({
			active: true,
			subject: 'dev-id',
			sessionId: 'session-id',
			roles: ['DEV']
		});
		const request = {
			headers: {
				authorization: 'Bearer token',
				'x-user-roles': 'ADMIN'
			}
		};

		await expect(
			guard.canActivate(
				createContext(
					request,
					ReportingDeliveryFailuresController.prototype.retry,
					ReportingDeliveryFailuresController
				)
			)
		).resolves.toBe(true);
		expect(identity.introspect).toHaveBeenCalledWith('Bearer token');
	});

	it('fails closed when an endpoint has no explicit access policy', async () => {
		identity.introspect.mockResolvedValue({
			active: true,
			subject: 'dev-id',
			sessionId: 'session-id',
			roles: ['ADMIN', 'DEV']
		});

		await expect(
			guard.canActivate(
				createContext(
					{ headers: { authorization: 'Bearer token' } },
					function unprotectedHandler() {},
					class UnprotectedController {}
				)
			)
		).rejects.toThrow(
			new ForbiddenException('Reporting endpoint has no access policy')
		);
	});

	it('rejects a request before introspection when Bearer auth is absent', async () => {
		await expect(
			guard.canActivate(
				createContext(
					{ headers: {} },
					ReportingAnalyticsController.prototype.getOverview,
					ReportingAnalyticsController
				)
			)
		).rejects.toThrow(
			new UnauthorizedException('Bearer token is required')
		);
		expect(identity.introspect).not.toHaveBeenCalled();
	});
});

describe('Reporting messaging overview guards', () => {
	const token = 'reporting-overview-internal-token-at-least-32-characters';
	const guard = () =>
		new ReportingMessagingInternalGuard({
			get: jest.fn((key: string) =>
				key === 'REPORTING_OPERATIONS_TOKEN' ? token : undefined
			)
		} as unknown as ConfigService);
	const internalContext = (
		address: string,
		suppliedToken: string | string[] | null = token,
		service: string | string[] | undefined = 'operations'
	): ExecutionContext =>
		({
			switchToHttp: () => ({
				getRequest: () => ({
					socket: { remoteAddress: address },
					headers: {
						'x-winwidget-service': service,
						...(suppliedToken === null
							? {}
							: { 'x-winwidget-internal-token': suppliedToken })
					}
				})
			})
		}) as unknown as ExecutionContext;

	it('binds both the API-role and internal caller guards to the endpoint', () => {
		expect(
			Reflect.getMetadata(
				GUARDS_METADATA,
				ReportingMessagingOverviewController
			)
		).toEqual([ReportingApiGuard, ReportingMessagingInternalGuard]);
	});

	it.each(['127.0.0.1', '127.23.45.67', '::1', '::ffff:127.0.0.1'])(
		'allows an authenticated Operations caller on loopback %s',
		address => {
			expect(guard().canActivate(internalContext(address))).toBe(true);
		}
	);

	it.each(['10.0.0.5', '::ffff:10.0.0.5', '::2', 'localhost'])(
		'rejects a non-loopback caller %s',
		address => {
			expect(() => guard().canActivate(internalContext(address))).toThrow(
				ForbiddenException
			);
		}
	);

	it('rejects the wrong service identity before accepting its token', () => {
		expect(() =>
			guard().canActivate(internalContext('127.0.0.1', token, 'campaigns'))
		).toThrow(ForbiddenException);
	});

	it.each([null, 'wrong-token', [token]])(
		'rejects an invalid token header %#',
		suppliedToken => {
			expect(() =>
				guard().canActivate(internalContext('127.0.0.1', suppliedToken))
			).toThrow(UnauthorizedException);
		}
	);

	it('fails startup closed for an insecure configured token', () => {
		expect(
			() =>
				new ReportingMessagingInternalGuard({
					get: jest.fn((key: string) =>
						key === 'REPORTING_OPERATIONS_TOKEN' ? 'change_me' : undefined
					)
				} as unknown as ConfigService)
		).toThrow('REPORTING_OPERATIONS_TOKEN');
	});

	it('does not accept the outbound Reporting-to-Operations credential', () => {
		expect(
			() =>
				new ReportingMessagingInternalGuard({
					get: jest.fn((key: string) =>
						key === 'REPORTING_INTERNAL_TOKEN' ? token : undefined
					)
				} as unknown as ConfigService)
		).toThrow('REPORTING_OPERATIONS_TOKEN');
	});

	it('rejects the endpoint outside the API process role', () => {
		const apiGuard = new ReportingApiGuard({
			apiEnabled: false
		} as ReportingRuntimeService);

		expect(() => apiGuard.canActivate()).toThrow(
			ServiceUnavailableException
		);
	});

	it('rejects missing and malformed loopback addresses', () => {
		expect(isReportingMessagingLoopback(undefined)).toBe(false);
		expect(isReportingMessagingLoopback('127.0.0.999')).toBe(false);
	});
});
