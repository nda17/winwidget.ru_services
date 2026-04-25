import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

interface ICreatePaymentParams {
	amount: string;
	description: string;
	returnUrl: string;
	userId: string;
	customerEmail?: string;
	customerPhone?: string;
}

interface IYookassaPaymentResponse {
	id: string;
	status: string;
	confirmation?: {
		type: string;
		confirmation_url?: string;
	};
	metadata?: {
		userId?: string;
	};
}

@Injectable()
export class YookassaService {
	private readonly baseUrl = 'https://api.yookassa.ru/v3';

	private getCredentials() {
		const isProduction =
			process.env.MODE?.trim().toLowerCase() === 'production';
		const shopId = isProduction
			? process.env.YOOKASSA_PRODUCTION_SHOP_ID
			: process.env.YOOKASSA_SHOP_ID;
		const secretKey = isProduction
			? process.env.YOOKASSA_PRODUCTION_SECRET_KEY
			: process.env.YOOKASSA_SECRET_KEY;

		if (!shopId || !secretKey) {
			throw new Error(
				isProduction
					? 'YooKassa production credentials are missing: set YOOKASSA_PRODUCTION_SHOP_ID and YOOKASSA_PRODUCTION_SECRET_KEY'
					: 'YooKassa development credentials are missing: set YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY'
			);
		}

		return { shopId, secretKey };
	}

	private getAuthHeader(): string {
		const { shopId, secretKey } = this.getCredentials();
		return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;
	}

	async createPayment(params: ICreatePaymentParams) {
		const customer = params.customerEmail
			? { email: params.customerEmail }
			: { phone: params.customerPhone! };

		const response = await fetch(`${this.baseUrl}/payments`, {
			method: 'POST',
			headers: {
				Authorization: this.getAuthHeader(),
				'Content-Type': 'application/json',
				'Idempotence-Key': randomUUID()
			},
			body: JSON.stringify({
				amount: { value: params.amount, currency: 'RUB' },
				capture: true,
				confirmation: {
					type: 'redirect',
					return_url: params.returnUrl
				},
				description: params.description,
				metadata: { userId: params.userId },
				receipt: {
					customer,
					items: [
						{
							description: params.description,
							quantity: '1.00',
							amount: { value: params.amount, currency: 'RUB' },
							vat_code: 1,
							payment_subject: 'service',
							payment_mode: 'full_payment'
						}
					]
				}
			})
		});

		const data = await response.json();

		if (!response.ok) {
			throw new Error(
				`ЮKassa error ${response.status}: ${data?.description ?? JSON.stringify(data)}`
			);
		}

		return data as IYookassaPaymentResponse;
	}

	async getPayment(yookassaId: string) {
		const response = await fetch(
			`${this.baseUrl}/payments/${yookassaId}`,
			{
				method: 'GET',
				headers: {
					Authorization: this.getAuthHeader()
				}
			}
		);

		const data = await response.json();

		if (!response.ok) {
			throw new Error(
				`ЮKassa error ${response.status}: ${data?.description ?? JSON.stringify(data)}`
			);
		}

		return data as IYookassaPaymentResponse;
	}
}
