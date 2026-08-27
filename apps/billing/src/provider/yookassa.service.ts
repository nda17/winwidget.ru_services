import { Injectable } from '@nestjs/common';

const BASE_URL = 'https://api.yookassa.ru/v3';
const REQUEST_TIMEOUT_MS = 20_000;
const YOOKASSA_OBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const isYooKassaObjectId = (value: unknown): value is string =>
	typeof value === 'string' && YOOKASSA_OBJECT_ID_PATTERN.test(value);

export const YOOKASSA_RECEIPT_CONTRACT = {
	schemaVersion: 1,
	contractVersion: 'yookassa-receipt-create-v1',
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
		'fiscal_document.fiscal_document_number',
		'fiscal_document.fiscal_storage_number',
		'fiscal_document.fiscal_attribute',
		'registered_at',
		'receipt_url'
	],
	rawProviderResponseStored: true
} as const;

export class ProviderRequestError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly retryable: boolean,
		readonly ambiguous: boolean,
		readonly status?: number
	) {
		super(message);
	}
}

interface CreateProviderPaymentInput {
	paymentId: string;
	amount: string;
	currency: string;
	plan: string;
	billingPeriod: string;
	autoRenew: boolean;
	customerEmail?: string | null;
	customerPhone?: string | null;
	returnUrl?: string;
	paymentMethodId?: string;
	kind: 'ONE_TIME' | 'RECURRING';
}

@Injectable()
export class YooKassaService {
	isConfigured(): boolean {
		return this.configurationStatus().credentialsConfigured;
	}

	configurationStatus() {
		const { shopId, secret } = this.credentialValues();
		const shopIdConfigured = Boolean(shopId);
		const secretKeyConfigured = Boolean(secret);
		return {
			mode:
				process.env.MODE?.trim().toLowerCase() === 'production'
					? ('production' as const)
					: ('non-production' as const),
			shopIdConfigured,
			secretKeyConfigured,
			credentialsConfigured: shopIdConfigured && secretKeyConfigured
		};
	}

	async createPayment(
		input: CreateProviderPaymentInput,
		idempotencyKey: string
	): Promise<Record<string, unknown>> {
		const customer: Record<string, string> = {};
		if (input.customerEmail) customer.email = input.customerEmail;
		if (input.customerPhone) customer.phone = input.customerPhone;
		if (!Object.keys(customer).length) {
			throw new ProviderRequestError(
				'Payment customer contact is missing',
				'CUSTOMER_CONTACT_MISSING',
				false,
				false
			);
		}
		const body: Record<string, unknown> = {
			amount: { value: input.amount, currency: input.currency },
			capture: true,
			description: `WinWidget ${input.plan} ${input.billingPeriod}`,
			metadata: {
				paymentId: input.paymentId,
				kind: input.kind,
				plan: input.plan,
				billingPeriod: input.billingPeriod
			},
			receipt: {
				customer,
				items: [
					{
						description: `Подписка WinWidget ${input.plan}`,
						quantity: '1.00',
						amount: { value: input.amount, currency: input.currency },
						vat_code: YOOKASSA_RECEIPT_CONTRACT.item.vatCode,
						payment_subject: YOOKASSA_RECEIPT_CONTRACT.item.paymentSubject,
						payment_mode: YOOKASSA_RECEIPT_CONTRACT.item.paymentMode
					}
				],
				internet: YOOKASSA_RECEIPT_CONTRACT.internet
			}
		};
		if (input.paymentMethodId) {
			body.payment_method_id = input.paymentMethodId;
		} else {
			body.confirmation = {
				type: 'redirect',
				return_url: input.returnUrl
			};
			body.save_payment_method = input.autoRenew;
		}
		return this.request('/payments', {
			method: 'POST',
			body: JSON.stringify(body),
			headers: { 'Idempotence-Key': idempotencyKey }
		});
	}

	getPayment(providerPaymentId: string): Promise<Record<string, unknown>> {
		return this.request(
			`/payments/${encodeURIComponent(providerPaymentId)}`,
			{
				method: 'GET'
			}
		);
	}

	getReceipts(
		providerPaymentId: string
	): Promise<Record<string, unknown>> {
		return this.request(
			`/receipts?payment_id=${encodeURIComponent(providerPaymentId)}`,
			{ method: 'GET' }
		);
	}

	private async request(
		path: string,
		options: {
			method: 'GET' | 'POST';
			body?: string;
			headers?: Record<string, string>;
		}
	): Promise<Record<string, unknown>> {
		const credentials = this.credentials();
		let response: Response;
		try {
			response = await fetch(`${BASE_URL}${path}`, {
				method: options.method,
				headers: {
					authorization: `Basic ${Buffer.from(`${credentials.shopId}:${credentials.secret}`).toString('base64')}`,
					accept: 'application/json',
					'content-type': 'application/json',
					...(options.headers || {})
				},
				body: options.body,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch {
			throw new ProviderRequestError(
				'Payment provider request outcome is unknown',
				'PROVIDER_TRANSPORT_UNKNOWN',
				true,
				true
			);
		}
		let value: unknown = null;
		try {
			value = await response.json();
		} catch {
			if (response.ok) {
				throw new ProviderRequestError(
					'Payment provider returned an invalid response',
					'PROVIDER_INVALID_RESPONSE',
					true,
					true,
					response.status
				);
			}
		}
		if (!response.ok) {
			const retryable = response.status === 429 || response.status >= 500;
			throw new ProviderRequestError(
				retryable
					? 'Payment provider is temporarily unavailable'
					: 'Payment provider rejected the request',
				retryable ? 'PROVIDER_RETRYABLE' : 'PROVIDER_REJECTED',
				retryable,
				false,
				response.status
			);
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new ProviderRequestError(
				'Payment provider returned an invalid response',
				'PROVIDER_INVALID_RESPONSE',
				true,
				true,
				response.status
			);
		}
		return value as Record<string, unknown>;
	}

	private credentials(): { shopId: string; secret: string } {
		const { shopId, secret } = this.credentialValues();
		if (!shopId || !secret) {
			throw new Error(
				'YooKassa credentials are missing for the selected MODE'
			);
		}
		return { shopId, secret };
	}

	private credentialValues(): {
		shopId: string | undefined;
		secret: string | undefined;
	} {
		const production =
			process.env.MODE?.trim().toLowerCase() === 'production';
		const shopId = (
			production
				? process.env.YOOKASSA_PRODUCTION_SHOP_ID
				: process.env.YOOKASSA_SHOP_ID
		)?.trim();
		const secret = (
			production
				? process.env.YOOKASSA_PRODUCTION_SECRET_KEY
				: process.env.YOOKASSA_SECRET_KEY
		)?.trim();
		return { shopId, secret };
	}
}
