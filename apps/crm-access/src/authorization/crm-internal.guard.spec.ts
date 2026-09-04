import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { CrmInternalGuard, CRM_CALLERS } from './crm-internal.guard';
import { CrmAuthorizationController } from './crm-authorization.controller';

const credentials = Object.fromEntries(
	Object.values(CRM_CALLERS).map(name => [
		name,
		`local-unit-test-${name}-32-chars-minimum`
	])
);
function guard() {
	return new CrmInternalGuard({
		get: (key: string) => credentials[key]
	} as ConfigService);
}
function context(
	caller = 'crm-sales',
	token = credentials.CRM_ACCESS_CRM_SALES_TOKEN,
	ip = '127.0.0.1'
) {
	return {
		switchToHttp: () => ({
			getRequest: () => ({
				socket: { remoteAddress: ip },
				header: (name: string) =>
					name === 'x-winwidget-service'
						? caller
						: name === 'x-winwidget-internal-token'
							? token
							: undefined
			})
		})
	} as ExecutionContext;
}
describe('CRM internal caller credentials', () => {
	it('limits durable source authorization to Intake even for another correctly authenticated CRM service', () => {
		const authorization = { authorizeSource: jest.fn() };
		const controller = new CrmAuthorizationController(
			authorization as never
		);
		const dto = {
			schemaVersion: 1 as const,
			workspaceId: '33333333-3333-4333-8333-333333333333',
			subject: 'user-1'
		};
		for (const caller of ['crm-sales', 'crm-customers'] as const)
			expect(() => controller.authorizeSource(caller, dto)).toThrow(
				ForbiddenException
			);
		expect(authorization.authorizeSource).not.toHaveBeenCalled();
		controller.authorizeSource('crm-intake', dto);
		expect(authorization.authorizeSource).toHaveBeenCalledWith(
			dto.workspaceId,
			dto.subject
		);
	});
	it.each(Object.entries(CRM_CALLERS))(
		'accepts only the scoped %s credential',
		(caller, envKey) => {
			expect(
				guard().canActivate(context(caller, credentials[envKey]))
			).toBe(true);
		}
	);
	it.each([
		['crm-customers', credentials.CRM_ACCESS_CRM_SALES_TOKEN, '127.0.0.1'],
		['unknown', credentials.CRM_ACCESS_CRM_SALES_TOKEN, '127.0.0.1'],
		['crm-sales', 'wrong-token', '127.0.0.1'],
		['crm-sales', credentials.CRM_ACCESS_CRM_SALES_TOKEN, '10.0.0.2'],
		['crm-sales', credentials.CRM_ACCESS_CRM_SALES_TOKEN, '127.999.0.1']
	])('rejects caller or peer mismatch', (caller, token, ip) => {
		expect(() => guard().canActivate(context(caller, token, ip))).toThrow(
			ForbiddenException
		);
	});
	it('rejects missing configuration at startup', () => {
		expect(
			() =>
				new CrmInternalGuard({
					get: () => undefined
				} as unknown as ConfigService)
		).toThrow('CRM_ACCESS_CRM_CUSTOMERS_TOKEN');
	});
});
