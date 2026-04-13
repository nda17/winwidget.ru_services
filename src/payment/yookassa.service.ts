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

@Injectable()
export class YookassaService {
	private readonly baseUrl = 'https://api.yookassa.ru/v3';

	private getAuthHeader(): string {
		const shopId = process.env.YOOKASSA_SHOP_ID!;
		const secretKey = process.env.YOOKASSA_SECRET_KEY!;
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

		return data;
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

		return data as {
			id: string;
			status: string;
			metadata: { userId: string };
		};
	}
}
