import {
	ConflictException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException,
	BadRequestException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getCrmAccessCorrelationId } from '../common/crm-access-request-context';
import {
	parseInternalBaseUrl,
	parseInternalTimeout,
	parseInternalToken,
	readBoundedJson
} from '../internal/internal-http.config';
import { billingEnabled, requireBilling } from './billing.validation';
import {
	parseBillingResponse,
	type BillingResponseKind,
	type BillingResponse
} from './billing-response.parser';

@Injectable()
export class BillingCommerceClient {
	readonly enabled: boolean;
	private readonly origin: string;
	private readonly token: string;
	private readonly timeoutMs: number;
	constructor(config: ConfigService) {
		this.enabled = billingEnabled(config);
		this.origin = this.enabled
			? parseInternalBaseUrl(
					'BILLING_INTERNAL_BASE_URL',
					config.get<string>('BILLING_INTERNAL_BASE_URL'),
					'http://127.0.0.1:4800'
				)
			: '';
		this.token = this.enabled
			? parseInternalToken(
					'BILLING_CRM_ACCESS_TOKEN',
					config.get<string>('BILLING_CRM_ACCESS_TOKEN'),
					['billing_crm_access_token']
				)
			: '';
		this.timeoutMs = this.enabled
			? parseInternalTimeout(
					'BILLING_CRM_ACCESS_TIMEOUT_MS',
					config.get<string>('BILLING_CRM_ACCESS_TIMEOUT_MS')
				)
			: 10000;
	}
	async request<T extends BillingResponse>(
		path: string,
		body: Record<string, unknown> & {
			workspaceId: string;
			commandId?: string;
			requestHash?: string;
		},
		kind: BillingResponseKind,
		command = false,
		binding?: { commandId: string; requestHash: string }
	): Promise<T> {
		requireBilling(this.enabled);
		const allowed = [
			'summary',
			'quote',
			'checkout',
			'seats',
			'renewal/disable',
			'renewal/confirm-price',
			'orders/get',
			'orders/verify',
			'history',
			'operations/get',
			'operations/close'
		];
		if (!allowed.includes(path)) throw new Error('BILLING_PATH');
		try {
			const response = await fetch(
				`${this.origin}/internal/v1/crm-access/billing/commerce/${path}`,
				{
					method: 'POST',
					redirect: 'error',
					cache: 'no-store',
					headers: {
						'x-winwidget-service': 'crm-access',
						'x-winwidget-internal-token': this.token,
						'x-correlation-id': getCrmAccessCorrelationId(),
						'content-type': 'application/json',
						accept: 'application/json',
						...(command && body.commandId
							? { 'idempotency-key': body.commandId }
							: {})
					},
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(this.timeoutMs)
				}
			);
			if (
				response.status !== 200 &&
				!(
					['checkout', 'orders/verify'].includes(path) &&
					response.status === 202
				)
			) {
				await response.body?.cancel();
				if (
					response.status === 404 &&
					['operations/get', 'orders/get'].includes(path)
				)
					throw new NotFoundException('CRM billing operation not found');
				if (response.status === 409)
					throw new ConflictException('CRM billing state changed');
				if (response.status === 400)
					throw new BadRequestException('CRM billing command is invalid');
				throw new Error('BILLING_DEPENDENCY');
			}
			if (
				response.redirected ||
				response.headers
					.get('content-type')
					?.split(';')[0]
					.trim()
					.toLowerCase() !== 'application/json'
			) {
				await response.body?.cancel();
				throw new Error('BILLING_RESPONSE_MEDIA_TYPE');
			}
			let value: unknown;
			try {
				value = await readBoundedJson(response, 512 * 1024);
			} catch {
				await response.body?.cancel().catch(() => undefined);
				throw new Error('BILLING_RESPONSE_BODY');
			}
			return parseBillingResponse(
				kind,
				value,
				body.workspaceId,
				binding ??
					(body.commandId && body.requestHash
						? { commandId: body.commandId, requestHash: body.requestHash }
						: undefined)
			) as T;
		} catch (error) {
			if (
				error instanceof NotFoundException ||
				error instanceof ConflictException ||
				error instanceof BadRequestException
			)
				throw error;
			throw new ServiceUnavailableException(
				'CRM billing service is unavailable'
			);
		}
	}
}
