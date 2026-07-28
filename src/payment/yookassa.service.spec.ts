import { YookassaService } from '@/payment/yookassa.service';

describe('YookassaService', () => {
	const originalFetch = global.fetch;
	const originalShopId = process.env.YOOKASSA_SHOP_ID;
	const originalSecretKey = process.env.YOOKASSA_SECRET_KEY;

	beforeEach(() => {
		process.env.YOOKASSA_SHOP_ID = 'test-shop';
		process.env.YOOKASSA_SECRET_KEY = 'test-secret';
	});

	afterEach(() => {
		global.fetch = originalFetch;
		process.env.YOOKASSA_SHOP_ID = originalShopId;
		process.env.YOOKASSA_SECRET_KEY = originalSecretKey;
		jest.restoreAllMocks();
	});

	it('marks the fiscal receipt as an internet payment', async () => {
		const fetchMock = jest.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					id: 'provider-payment-1',
					status: 'pending'
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				}
			)
		);
		global.fetch = fetchMock;

		await new YookassaService().createPayment({
			amount: '990.00',
			description: 'Тариф Easy на месяц — winwidget.ru',
			userId: 'user-1',
			localPaymentId: 'payment-1',
			idempotencyKey: 'idempotency-key-1',
			customerEmail: 'user@example.com',
			savePaymentMethod: true
		});

		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body)) as {
			receipt?: { internet?: boolean };
		};
		expect(body.receipt?.internet).toBe(true);
	});
});
