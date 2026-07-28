import { Injectable } from '@nestjs/common';

interface ICreatePaymentParams {
	amount: string;
	description: string;
	userId: string;
	localPaymentId: string;
	idempotencyKey: string;
	customerEmail?: string;
	customerPhone?: string;
	returnUrl?: string;
	savePaymentMethod: boolean;
	paymentMethodId?: string;
}

export interface IYookassaPaymentResponse {
	id: string;
	status: string;
	created_at?: string;
	expires_at?: string;
	captured_at?: string;
	confirmation?: {
		type: string;
		confirmation_url?: string;
	};
	amount?: {
		value: string;
		currency: string;
	};
	payment_method?: {
		id?: string;
		type?: string;
		saved?: boolean;
		title?: string;
		card?: {
			last4?: string;
		};
	};
	cancellation_details?: {
		party?: string;
		reason?: string;
	};
	metadata?: {
		userId?: string;
		paymentId?: string;
		kind?: string;
	};
}

export interface IYookassaReceipt {
	id: string;
	type?: string;
	payment_id?: string;
	status: string;
	fiscal_document_number?: string;
	fiscal_storage_number?: string;
	fiscal_attribute?: string;
	registered_at?: string;
}

interface IYookassaReceiptListResponse {
	type?: string;
	items?: IYookassaReceipt[];
	next_cursor?: string;
}

export class YookassaApiError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly httpStatus: number | null,
		readonly retryAfterMs: number | null
	) {
		super(message);
		this.name = 'YookassaApiError';
	}
}

@Injectable()
export class YookassaService {
	private readonly baseUrl = 'https://api.yookassa.ru/v3';
	private readonly requestTimeoutMs = 20_000;

	async createPayment(params: ICreatePaymentParams) {
		const customer = params.customerEmail
			? { email: params.customerEmail }
			: { phone: params.customerPhone! };
		const paymentMethod = params.paymentMethodId
			? { payment_method_id: params.paymentMethodId }
			: {
					confirmation: {
						type: 'redirect',
						return_url: params.returnUrl
					}
				};

		return this.request<IYookassaPaymentResponse>('/payments', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotence-Key': params.idempotencyKey
			},
			body: JSON.stringify({
				amount: { value: params.amount, currency: 'RUB' },
				capture: true,
				...paymentMethod,
				save_payment_method: params.savePaymentMethod,
				description: params.description,
				metadata: {
					userId: params.userId,
					paymentId: params.localPaymentId,
					kind: params.paymentMethodId ? 'RECURRING' : 'ONE_TIME'
				},
				receipt: {
					customer,
					items: [
						{
							description: params.description,
							quantity: '1.00',
							amount: {
								value: params.amount,
								currency: 'RUB'
							},
							vat_code: 1,
							payment_subject: 'service',
							payment_mode: 'full_payment'
						}
					],
					internet: true
				}
			})
		});
	}

	getPayment(yookassaId: string) {
		return this.request<IYookassaPaymentResponse>(
			`/payments/${encodeURIComponent(yookassaId)}`,
			{ method: 'GET' }
		);
	}

	async getReceipts(paymentId: string): Promise<IYookassaReceipt[]> {
		const query = new URLSearchParams({ payment_id: paymentId });
		const response = await this.request<IYookassaReceiptListResponse>(
			`/receipts?${query.toString()}`,
			{ method: 'GET' }
		);
		return Array.isArray(response.items) ? response.items : [];
	}

	private async request<T>(path: string, init: RequestInit): Promise<T> {
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, {
				...init,
				signal: AbortSignal.timeout(this.requestTimeoutMs),
				headers: {
					Authorization: this.getAuthHeader(),
					...(init.headers ?? {})
				}
			});
		} catch {
			throw new YookassaApiError(
				'ЮKassa временно недоступна',
				'YOOKASSA_NETWORK',
				null,
				30_000
			);
		}
		const data = await response.json().catch(() => null);

		if (!response.ok) {
			const retryAfterSeconds = Number(
				response.headers.get('retry-after')
			);
			throw new YookassaApiError(
				`ЮKassa отклонила API-запрос: HTTP ${response.status}`,
				`YOOKASSA_HTTP_${response.status}`,
				response.status,
				Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
					? retryAfterSeconds * 1000
					: null
			);
		}

		return data as T;
	}

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
}
