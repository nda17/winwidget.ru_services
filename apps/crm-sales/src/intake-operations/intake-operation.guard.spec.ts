import {
	type ExecutionContext,
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { IntakeOperationGuard } from './intake-operation.guard';
const token = 'local-intake-pairwise-guard-test-token'.repeat(2);
const original = process.env.CRM_SALES_CRM_INTAKE_TOKEN;
const context = (
	service = 'crm-intake',
	candidate = token,
	remoteAddress = '127.0.0.1'
) =>
	({
		switchToHttp: () => ({
			getRequest: () => ({
				socket: { remoteAddress },
				header: (key: string) =>
					({
						'x-winwidget-service': service,
						'x-winwidget-internal-token': candidate
					})[key]
			})
		})
	}) as unknown as ExecutionContext;
describe('Sales intake exact pairwise boundary', () => {
	beforeEach(() => {
		process.env.CRM_SALES_CRM_INTAKE_TOKEN = token;
	});
	afterEach(() => {
		if (original === undefined)
			delete process.env.CRM_SALES_CRM_INTAKE_TOKEN;
		else process.env.CRM_SALES_CRM_INTAKE_TOKEN = original;
	});
	it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
		'accepts only local private ingress %s',
		peer => {
			expect(
				new IntakeOperationGuard().canActivate(
					context('crm-intake', token, peer)
				)
			).toBe(true);
		}
	);
	it.each([
		context('crm-access'),
		context('crm-customers'),
		context('crm-intake', token.slice(1)),
		context('crm-intake', token, '10.0.0.8'),
		context('crm-intake', token, '')
	])('rejects wrong service, token or ingress', request => {
		expect(() => new IntakeOperationGuard().canActivate(request)).toThrow(
			ForbiddenException
		);
	});
	it('fails closed without configured credentials', () => {
		delete process.env.CRM_SALES_CRM_INTAKE_TOKEN;
		expect(() =>
			new IntakeOperationGuard().canActivate(context())
		).toThrow(ServiceUnavailableException);
	});
});
