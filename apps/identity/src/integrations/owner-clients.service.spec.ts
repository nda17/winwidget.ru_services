import { ConfigService } from '@nestjs/config';
import { OwnerClientsService } from './owner-clients.service';

const values = {
	BILLING_IDENTITY_TOKEN: `billing-${'b'.repeat(48)}`,
	WIDGETS_IDENTITY_TOKEN: `widgets-${'w'.repeat(48)}`,
	CORE_IDENTITY_TOKEN: `core-${'c'.repeat(48)}`
};

function config(overrides: Record<string, string> = {}) {
	const all = { ...values, ...overrides };
	return {
		get: (name: string) => all[name as keyof typeof all]
	} as ConfigService;
}

describe('Identity narrow owner clients', () => {
	const originalFetch = global.fetch;
	const originalBillingOrigin = process.env.BILLING_INTERNAL_BASE_URL;
	const originalWidgetsOrigin = process.env.WIDGETS_INTERNAL_BASE_URL;
	const originalCoreOrigin = process.env.CORE_INTERNAL_BASE_URL;

	beforeEach(() => {
		delete process.env.BILLING_INTERNAL_BASE_URL;
		delete process.env.WIDGETS_INTERNAL_BASE_URL;
		delete process.env.CORE_INTERNAL_BASE_URL;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		if (originalBillingOrigin === undefined) {
			delete process.env.BILLING_INTERNAL_BASE_URL;
		} else process.env.BILLING_INTERNAL_BASE_URL = originalBillingOrigin;
		if (originalWidgetsOrigin === undefined) {
			delete process.env.WIDGETS_INTERNAL_BASE_URL;
		} else process.env.WIDGETS_INTERNAL_BASE_URL = originalWidgetsOrigin;
		if (originalCoreOrigin === undefined) {
			delete process.env.CORE_INTERNAL_BASE_URL;
		} else process.env.CORE_INTERNAL_BASE_URL = originalCoreOrigin;
	});

	it('uses only narrow Billing/Widgets routes and explicit identity provenance', async () => {
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({})
		} as unknown as globalThis.Response) as typeof fetch;
		const clients = new OwnerClientsService(config());
		await clients.ensureTrial(
			'user-id',
			new Date('2026-08-14T10:00:00.000Z')
		);
		await clients.widgetsOverview('user-id');
		const calls = (global.fetch as jest.Mock).mock.calls;
		expect(calls[0]?.[0]).toBe(
			'http://127.0.0.1:4800/internal/v1/identity/billing/trials/ensure'
		);
		expect(calls[1]?.[0]).toBe(
			'http://127.0.0.1:4700/internal/v1/identity/widgets/admin-owner-overview'
		);
		for (const [, options] of calls) {
			expect(options.headers).toMatchObject({
				'x-winwidget-service': 'identity'
			});
		}
	});

	it('rejects broad/placeholder/shared credentials at startup', () => {
		expect(
			() =>
				new OwnerClientsService(
					config({
						BILLING_IDENTITY_TOKEN:
							'ci_billing_identity_token_at_least_32_chars'
					})
				)
		).toThrow('non-placeholder secret');
		expect(
			() =>
				new OwnerClientsService(
					config({ WIDGETS_IDENTITY_TOKEN: values.BILLING_IDENTITY_TOKEN })
				)
		).toThrow('pairwise distinct');
	});

	it('rejects any non-loopback owner origin', () => {
		process.env.BILLING_INTERNAL_BASE_URL = 'http://billing.example:4800';
		expect(() => new OwnerClientsService(config())).toThrow(
			'BILLING_INTERNAL_BASE_URL must be a private HTTP origin'
		);
	});
});
