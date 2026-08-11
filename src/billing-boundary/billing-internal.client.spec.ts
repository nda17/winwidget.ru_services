import { BillingInternalClient } from './billing-internal.client';
import type { ConfigService } from '@nestjs/config';

describe('BillingInternalClient', () => {
	const originalFetch = global.fetch;
	const token = 'billing-internal-token-at-least-32-characters';

	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	it('sends the exact idempotent seven-day trial command', async () => {
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 204,
			json: jest.fn()
		});
		const client = new BillingInternalClient({
			get: jest.fn((key: string) => {
				if (key === 'BILLING_INTERNAL_BASE_URL') {
					return 'http://127.0.0.1:4800';
				}
				if (key === 'BILLING_INTERNAL_TOKEN') return token;
				return undefined;
			})
		} as unknown as ConfigService);
		const command = {
			commandId: '11111111-1111-4111-8111-111111111111',
			userId: 'user-1',
			registeredAt: '2026-08-11T00:00:00.000Z'
		};

		await client.ensureTrial(command);

		expect(global.fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:4800/internal/v1/billing/trials/ensure',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					'x-winwidget-internal-token': token,
					'idempotency-key': command.commandId
				}),
				body: JSON.stringify({
					schemaVersion: 1,
					...command,
					trialDays: 7
				})
			})
		);
	});
});
