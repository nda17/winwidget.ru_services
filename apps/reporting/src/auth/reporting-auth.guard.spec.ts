import { ReportingAnalyticsController } from '../analytics/reporting-analytics.controller';
import { ReportingDeliveryFailuresController } from '../delivery-failures/reporting-delivery-failures.controller';
import { CoreInternalClient } from '../internal/core-internal.client';
import { DailySummarySettingsController } from '../settings/daily-summary-settings.controller';
import {
	REPORTING_REQUIRED_ROLE,
	ReportingAdminGuard
} from './reporting-auth.guard';
import type { ReportingRequest } from './reporting-request';
import {
	ExecutionContext,
	ForbiddenException,
	UnauthorizedException
} from '@nestjs/common';
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
	const core = {
		introspect: jest.fn()
	};
	const reflector = new Reflector();
	const guard = new ReportingAdminGuard(
		reflector,
		core as unknown as CoreInternalClient
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
		core.introspect.mockResolvedValue({
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
		core.introspect.mockResolvedValue({
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
		core.introspect.mockResolvedValue({
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
		expect(core.introspect).toHaveBeenCalledWith('Bearer token');
	});

	it('fails closed when an endpoint has no explicit access policy', async () => {
		core.introspect.mockResolvedValue({
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
		expect(core.introspect).not.toHaveBeenCalled();
	});
});
