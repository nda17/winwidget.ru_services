import { PaymentMethodCryptoService } from '@/payment/payment-method-crypto.service';

describe('PaymentMethodCryptoService', () => {
	const previousKey = process.env.PAYMENT_METHOD_ENCRYPTION_KEY;

	afterEach(() => {
		if (previousKey === undefined) {
			delete process.env.PAYMENT_METHOD_ENCRYPTION_KEY;
		} else {
			process.env.PAYMENT_METHOD_ENCRYPTION_KEY = previousKey;
		}
	});

	it('encrypts and decrypts a saved YooKassa payment method', () => {
		process.env.PAYMENT_METHOD_ENCRYPTION_KEY = Buffer.alloc(
			32,
			7
		).toString('base64');
		const service = new PaymentMethodCryptoService();
		const paymentMethodId = '2f4f8f0d-000f-5000-9000-1d4f15f9a123';

		const ciphertext = service.encrypt(paymentMethodId);

		expect(ciphertext).toMatch(/^v1:/);
		expect(ciphertext).not.toContain(paymentMethodId);
		expect(service.decrypt(ciphertext)).toBe(paymentMethodId);
	});

	it('rejects a key that is not exactly 32 bytes', () => {
		process.env.PAYMENT_METHOD_ENCRYPTION_KEY = Buffer.alloc(
			16,
			1
		).toString('base64');

		expect(() =>
			new PaymentMethodCryptoService().assertConfigured()
		).toThrow('32 байта');
	});
});
