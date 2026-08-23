import { getCurrentCorrelationId } from '@/messaging/messaging-context';
import { BillingSettingsState } from '@/messaging/billing-events';
import { parseBillingSettingsState } from '@/billing-boundary/billing-settings-state';
import { ServiceUnavailableException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	BILLING_INTERNAL_TOKEN_ENV,
	BILLING_INTERNAL_TOKEN_HEADER,
	BILLING_INTERNAL_TOKEN_MIN_LENGTH,
	BILLING_SERVICE_BASE_URL_ENV,
	BILLING_SERVICE_DEFAULT_BASE_URL,
	BILLING_SERVICE_TIMEOUT_ENV,
	BILLING_SETTINGS_PATH
} from './billing-boundary.constants';

const DEFAULT_TIMEOUT_MS = 10_000;
const INSECURE_TOKENS = new Set([
	'XYZXYZXYZ',
	'change-me',
	'change_me',
	'BILLING_INTERNAL_TOKEN',
	'billing_internal_token'
]);

@Injectable()
export class BillingInternalClient {
	constructor(private readonly config: ConfigService) {}

	async updateSettings(input: {
		commandId: string;
		actorId: string;
		occurredAt: string;
		settings: {
			paymentEnabled?: boolean;
			autoRenewalSignupEnabled?: boolean;
			autoRenewalChargesEnabled?: boolean;
			affiliateProgramEnabled?: boolean;
			affiliateCashbackPercent?: number;
		};
	}): Promise<BillingSettingsState> {
		const value = await this.request(
			'PATCH',
			BILLING_SETTINGS_PATH,
			{
				schemaVersion: 1,
				...input
			},
			input.commandId
		);
		return parseBillingSettingsState(value);
	}

	private async request(
		method: 'PATCH',
		path: string,
		body: Record<string, unknown>,
		idempotencyKey: string
	): Promise<unknown> {
		const baseUrl = this.getBaseUrl();
		const token = this.getToken();
		let response: Response;
		try {
			response = await fetch(`${baseUrl}${path}`, {
				method,
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
					[BILLING_INTERNAL_TOKEN_HEADER]: token,
					'idempotency-key': idempotencyKey,
					...(getCurrentCorrelationId()
						? { 'x-correlation-id': getCurrentCorrelationId()! }
						: {})
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.getTimeoutMs())
			});
		} catch {
			throw new ServiceUnavailableException(
				'Billing internal command is unavailable'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Billing internal command was not confirmed'
			);
		}
		if (response.status === 204) return null;
		try {
			return await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Billing internal command returned invalid JSON'
			);
		}
	}

	private getBaseUrl(): string {
		const configured =
			this.config.get<string>(BILLING_SERVICE_BASE_URL_ENV)?.trim() ||
			BILLING_SERVICE_DEFAULT_BASE_URL;
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new ServiceUnavailableException(
				'Billing internal URL is invalid'
			);
		}
		if (
			url.protocol !== 'http:' ||
			!this.isLoopbackHost(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new ServiceUnavailableException(
				'Billing internal URL must be an exact loopback HTTP origin'
			);
		}
		return url.origin;
	}

	private getToken(): string {
		const token =
			this.config.get<string>(BILLING_INTERNAL_TOKEN_ENV)?.trim() || '';
		if (
			token.length < BILLING_INTERNAL_TOKEN_MIN_LENGTH ||
			INSECURE_TOKENS.has(token)
		) {
			throw new ServiceUnavailableException(
				'Billing internal token is not configured securely'
			);
		}
		return token;
	}

	private getTimeoutMs(): number {
		const value = Number(
			this.config.get<string>(BILLING_SERVICE_TIMEOUT_ENV) ||
				DEFAULT_TIMEOUT_MS
		);
		if (!Number.isInteger(value) || value < 500 || value > 60_000) {
			throw new ServiceUnavailableException(
				'Billing internal timeout is invalid'
			);
		}
		return value;
	}

	private isLoopbackHost(hostname: string): boolean {
		return (
			hostname === 'localhost' ||
			hostname === '::1' ||
			/^127(?:\.\d{1,3}){3}$/.test(hostname)
		);
	}
}
