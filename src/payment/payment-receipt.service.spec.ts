import { PaymentReceiptService } from '@/payment/payment-receipt.service';

describe('PaymentReceiptService', () => {
	const service = new PaymentReceiptService({} as never, {} as never);

	it('builds the exact public First OFD receipt URL from fiscal fields', () => {
		expect(
			service.buildFirstOfdReceiptUrl({
				fiscalStorageNumber: '7384440901528528',
				fiscalDocumentNumber: '69448',
				fiscalAttribute: '1926198146',
				receiptType: 'payment',
				receiptStatus: 'succeeded'
			})
		).toBe(
			'https://consumer.1-ofd.ru/ticket?fn=7384440901528528&i=69448&fp=1926198146&n=1'
		);
	});

	it.each([
		{
			fiscalStorageNumber: '123',
			fiscalDocumentNumber: '69448',
			fiscalAttribute: '1926198146'
		},
		{
			fiscalStorageNumber: '7384440901528528',
			fiscalDocumentNumber: 'not-a-number',
			fiscalAttribute: '1926198146'
		},
		{
			fiscalStorageNumber: '7384440901528528',
			fiscalDocumentNumber: '69448',
			fiscalAttribute: '',
			receiptType: 'payment',
			receiptStatus: 'succeeded'
		},
		{
			fiscalStorageNumber: '7384440901528528',
			fiscalDocumentNumber: '69448',
			fiscalAttribute: '1926198146',
			receiptType: 'refund',
			receiptStatus: 'succeeded'
		},
		{
			fiscalStorageNumber: '7384440901528528',
			fiscalDocumentNumber: '69448',
			fiscalAttribute: '1926198146',
			receiptType: 'payment',
			receiptStatus: 'canceled'
		}
	])('does not expose a malformed fiscal URL', input => {
		expect(service.buildFirstOfdReceiptUrl(input)).toBeNull();
	});
});
