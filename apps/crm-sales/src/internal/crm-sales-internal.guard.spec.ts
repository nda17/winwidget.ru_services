import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CrmSalesInternalGuard } from './crm-sales-internal.guard';

const TOKEN = 'crm-sales-access-token-0123456789abcdef';

function createGuard(token = TOKEN): CrmSalesInternalGuard {
	return new CrmSalesInternalGuard(
		new ConfigService({ CRM_SALES_CRM_ACCESS_TOKEN: token })
	);
}

function createContext({
	service = 'crm-access',
	token = TOKEN,
	remoteAddress = '127.0.0.1'
}: {
	service?: string;
	token?: string;
	remoteAddress?: string;
} = {}): ExecutionContext {
	const headers: Record<string, string> = {
		'x-winwidget-service': service,
		'x-winwidget-internal-token': token
	};
	return {
		switchToHttp: () => ({
			getRequest: () => ({
				header: (name: string) => headers[name.toLowerCase()],
				socket: { remoteAddress }
			})
		})
	} as unknown as ExecutionContext;
}

describe('CrmSalesInternalGuard', () => {
	it.each([
		undefined,
		'',
		'short',
		'change_me',
		'ci_crm_sales_crm_access_token_at_least_32_chars'
	])('fails closed for an unusable configured token: %p', token => {
		const config = new ConfigService(
			token === undefined ? {} : { CRM_SALES_CRM_ACCESS_TOKEN: token }
		);
		expect(() => new CrmSalesInternalGuard(config)).toThrow(
			'CRM_SALES_CRM_ACCESS_TOKEN must be a non-placeholder secret'
		);
	});

	it.each(['127.0.0.1', '127.20.30.40', '::1', '::ffff:127.0.0.1'])(
		'accepts the exact crm-access credential from loopback %s',
		remoteAddress => {
			expect(
				createGuard().canActivate(createContext({ remoteAddress }))
			).toBe(true);
		}
	);

	it.each([
		createContext({ service: 'crm-intake' }),
		createContext({ token: `${TOKEN.slice(0, -1)}0` }),
		createContext({ remoteAddress: '10.0.0.2' }),
		createContext({ remoteAddress: '' })
	])('rejects a request outside the exact internal boundary', context => {
		expect(() => createGuard().canActivate(context)).toThrow(
			ForbiddenException
		);
	});
});
