import {
	YOOKASSA_RECEIPT_CONTRACT,
	YooKassaService
} from './yookassa.service';

const ENV_KEYS = [
	'MODE',
	'YOOKASSA_SHOP_ID',
	'YOOKASSA_SECRET_KEY',
	'YOOKASSA_PRODUCTION_SHOP_ID',
	'YOOKASSA_PRODUCTION_SECRET_KEY'
] as const;

describe('YooKassaService safe readiness', () => {
	const original = new Map<string, string | undefined>();
	const originalFetch = global.fetch;

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			original.set(key, process.env[key]);
			delete process.env[key];
		}
	});

	afterEach(() => {
		global.fetch = originalFetch;
		for (const key of ENV_KEYS) {
			const value = original.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it('reports only production credential-presence booleans', () => {
		process.env.MODE = 'production';
		process.env.YOOKASSA_PRODUCTION_SHOP_ID = 'test-production-shop-id';
		process.env.YOOKASSA_PRODUCTION_SECRET_KEY = 'test-production-secret';
		process.env.YOOKASSA_SHOP_ID = 'ignored-non-production-shop-id';
		process.env.YOOKASSA_SECRET_KEY = 'ignored-non-production-secret';
		const service = new YooKassaService();

		const status = service.configurationStatus();

		expect(status).toEqual({
			mode: 'production',
			shopIdConfigured: true,
			secretKeyConfigured: true,
			credentialsConfigured: true
		});
		expect(JSON.stringify(status)).not.toContain(
			'test-production-shop-id'
		);
		expect(JSON.stringify(status)).not.toContain('test-production-secret');
	});

	it('fails readiness closed when either selected credential is absent', () => {
		process.env.MODE = 'development';
		process.env.YOOKASSA_SHOP_ID = 'test-shop-id';
		const service = new YooKassaService();

		expect(service.configurationStatus()).toEqual({
			mode: 'non-production',
			shopIdConfigured: true,
			secretKeyConfigured: false,
			credentialsConfigured: false
		});
		expect(service.isConfigured()).toBe(false);
	});

	it('pins the fiscal receipt request and stored-response field contract', () => {
		expect(YOOKASSA_RECEIPT_CONTRACT).toEqual({
			schemaVersion: 1,
			contractVersion: 'yookassa-receipt-create-v2',
			requestIncluded: true,
			customerContactRequired: true,
			item: {
				vatCode: 1,
				paymentSubject: 'service',
				paymentMode: 'full_payment'
			},
			internet: true,
			normalizedStoredFields: [
				'id',
				'status',
				'type',
				'fiscal_document_number',
				'fiscal_storage_number',
				'fiscal_attribute',
				'registered_at'
			],
			rawProviderResponseStored: true
		});
	});

	it('sends the pinned fiscal receipt fields in the mocked create request', async () => {
		process.env.MODE = 'development';
		process.env.YOOKASSA_SHOP_ID = 'test-shop-id';
		process.env.YOOKASSA_SECRET_KEY = 'test-secret';
		const fetchMock = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({
				id: 'provider-payment-1',
				status: 'pending'
			})
		});
		global.fetch = fetchMock as unknown as typeof fetch;
		const service = new YooKassaService();

		await service.createPayment(
			{
				paymentId: 'payment-1',
				amount: '990.00',
				currency: 'RUB',
				plan: 'EASY',
				billingPeriod: 'MONTHLY',
				autoRenew: false,
				customerEmail: 'payer@example.test',
				customerPhone: '+79990000000',
				returnUrl: 'https://winwidget.ru/payment/success',
				kind: 'ONE_TIME'
			},
			'provider-command-1'
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0] as [
			string,
			{ body: string; headers: Record<string, string> }
		];
		expect(url).toBe('https://api.yookassa.ru/v3/payments');
		expect(options.headers['Idempotence-Key']).toBe('provider-command-1');
		const body = JSON.parse(options.body) as Record<string, any>;
		expect(body.receipt).toEqual({
			customer: {
				email: 'payer@example.test',
				phone: '+79990000000'
			},
			items: [
				{
					description: 'Подписка WinWidget EASY',
					quantity: '1.00',
					amount: { value: '990.00', currency: 'RUB' },
					vat_code: 1,
					payment_subject: 'service',
					payment_mode: 'full_payment'
				}
			],
			internet: true
		});
	});

	it('reads every receipt page and forwards only an encoded opaque cursor', async () => {
		process.env.MODE = 'development';
		process.env.YOOKASSA_SHOP_ID = 'test-shop-id';
		process.env.YOOKASSA_SECRET_KEY = 'test-secret';
		const fetchMock = jest
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: jest.fn().mockResolvedValue({
					type: 'list',
					items: [{ id: 'provider-receipt-1', status: 'succeeded' }],
					next_cursor: 'cursor:page-2'
				})
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: jest.fn().mockResolvedValue({
					type: 'list',
					items: [{ id: 'provider-receipt-2', status: 'canceled' }]
				})
			});
		global.fetch = fetchMock as unknown as typeof fetch;
		const service = new YooKassaService();

		await expect(
			service.getReceipts('provider-payment:1')
		).resolves.toEqual({
			type: 'list',
			items: [
				{ id: 'provider-receipt-1', status: 'succeeded' },
				{ id: 'provider-receipt-2', status: 'canceled' }
			]
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'https://api.yookassa.ru/v3/receipts?payment_id=provider-payment%3A1&limit=100'
		);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			'https://api.yookassa.ru/v3/receipts?payment_id=provider-payment%3A1&limit=100&cursor=cursor%3Apage-2'
		);
	});

	it('fails closed on a repeated receipt cursor', async () => {
		process.env.MODE = 'development';
		process.env.YOOKASSA_SHOP_ID = 'test-shop-id';
		process.env.YOOKASSA_SECRET_KEY = 'test-secret';
		const fetchMock = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({
				type: 'list',
				items: [],
				next_cursor: 'same-cursor'
			})
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			new YooKassaService().getReceipts('provider-payment-1')
		).rejects.toMatchObject({
			code: 'PROVIDER_RECEIPT_PAGINATION_INVALID',
			retryable: false
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('fails closed instead of silently truncating an excessive receipt list', async () => {
		process.env.MODE = 'development';
		process.env.YOOKASSA_SHOP_ID = 'test-shop-id';
		process.env.YOOKASSA_SECRET_KEY = 'test-secret';
		let page = 0;
		const fetchMock = jest.fn().mockImplementation(() => {
			page += 1;
			return Promise.resolve({
				ok: true,
				status: 200,
				json: jest.fn().mockResolvedValue({
					type: 'list',
					items: [],
					next_cursor: `cursor-${page}`
				})
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			new YooKassaService().getReceipts('provider-payment-1')
		).rejects.toMatchObject({
			code: 'PROVIDER_RECEIPT_PAGINATION_LIMIT',
			retryable: false
		});
		expect(fetchMock).toHaveBeenCalledTimes(10);
	});
});
