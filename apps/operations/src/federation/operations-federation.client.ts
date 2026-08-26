import {
	BadGatewayException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

export type MessagingFailureSource =
	| 'notificationDelivery'
	| 'widgets'
	| 'billing'
	| 'identity';

type ServiceName =
	| MessagingFailureSource
	| 'campaigns'
	| 'reporting'
	| 'support'
	| 'platform';

interface ServiceConfig {
	baseUrlEnv: string;
	defaultBaseUrl: string;
	tokenEnv: string;
}

const SERVICES: Record<ServiceName, ServiceConfig> = {
	notificationDelivery: {
		baseUrlEnv: 'NOTIFICATION_DELIVERY_INTERNAL_URL',
		defaultBaseUrl: 'http://127.0.0.1:4401',
		tokenEnv: 'NOTIFICATION_DELIVERY_OPERATIONS_TOKEN'
	},
	widgets: {
		baseUrlEnv: 'WIDGETS_INTERNAL_BASE_URL',
		defaultBaseUrl: 'http://127.0.0.1:4700',
		tokenEnv: 'WIDGETS_OPERATIONS_TOKEN'
	},
	billing: {
		baseUrlEnv: 'BILLING_INTERNAL_BASE_URL',
		defaultBaseUrl: 'http://127.0.0.1:4800',
		tokenEnv: 'BILLING_OPERATIONS_TOKEN'
	},
	identity: {
		baseUrlEnv: 'IDENTITY_INTERNAL_BASE_URL',
		defaultBaseUrl: 'http://127.0.0.1:4900',
		tokenEnv: 'IDENTITY_OPERATIONS_TOKEN'
	},
	campaigns: {
		baseUrlEnv: 'CAMPAIGNS_INTERNAL_BASE_URL',
		defaultBaseUrl: 'http://127.0.0.1:4500',
		tokenEnv: 'CAMPAIGNS_OPERATIONS_TOKEN'
	},
	reporting: {
		baseUrlEnv: 'REPORTING_INTERNAL_BASE_URL',
		defaultBaseUrl: 'http://127.0.0.1:4600',
		tokenEnv: 'REPORTING_OPERATIONS_TOKEN'
	},
	support: {
		baseUrlEnv: 'SUPPORT_INTERNAL_BASE_URL',
		defaultBaseUrl: 'http://127.0.0.1:5100',
		tokenEnv: 'SUPPORT_OPERATIONS_TOKEN'
	},
	platform: {
		baseUrlEnv: 'PLATFORM_INTERNAL_BASE_URL',
		defaultBaseUrl: 'http://127.0.0.1:5000',
		tokenEnv: 'PLATFORM_OPERATIONS_TOKEN'
	}
};

const OVERVIEW_PATHS: Record<ServiceName, string> = {
	notificationDelivery: '/internal/notification-delivery/overview',
	widgets: '/api/v1/internal/v1/operations/widgets/messaging-overview',
	billing: '/internal/v1/operations/billing/messaging/overview',
	identity: '/internal/v1/identity/messaging/overview',
	campaigns: '/internal/v1/campaigns/messaging/overview',
	reporting: '/internal/v1/reporting/messaging/overview',
	support: '/internal/v1/support/messaging/overview',
	platform: '/internal/v1/platform/messaging/overview'
};

const FAILURE_PATHS: Record<MessagingFailureSource, string> = {
	notificationDelivery: '/internal/notification-delivery/failures',
	widgets: '/api/v1/internal/v1/operations/widgets/delivery-failures',
	billing: '/internal/v1/operations/billing/messaging/failures',
	identity: '/internal/v1/identity/messaging/failures'
};

const BILLING_CONSUMER_TO_PUBLIC_INTEGRATION: Record<string, string> = {
	identity: 'billing-identity-source',
	offer: 'billing-offer-source',
	'notification-routing': 'billing-notification-routing-source',
	'trial-request': 'billing-trial-source',
	'referral-request': 'billing-referral-source',
	'lifecycle-repair': 'billing-lifecycle-repair-source',
	'auto-renewal-charge': 'auto-renewal',
	'notification-outcome': 'notification-delivery-outcome'
};
const PUBLIC_INTEGRATION_TO_BILLING_CONSUMER = Object.fromEntries(
	Object.entries(BILLING_CONSUMER_TO_PUBLIC_INTEGRATION).map(
		([consumer, integration]) => [integration, consumer]
	)
);

export class OperationsFederationHttpError extends Error {
	constructor(
		readonly source: ServiceName,
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = OperationsFederationHttpError.name;
	}
}

@Injectable()
export class OperationsFederationClient {
	constructor(private readonly config: ConfigService) {}

	async getBillingAlerts(): Promise<unknown[]> {
		const value = await this.request(
			'billing',
			'/internal/v1/operations/billing/admin-alerts'
		);
		const record = this.record(value, 'Billing admin alerts');
		if (
			record.schemaVersion !== 1 ||
			!Array.isArray(record.items) ||
			record.items.length > 100_000
		) {
			throw new BadGatewayException(
				'Billing admin alerts response is invalid'
			);
		}
		return record.items;
	}

	async getWidgetsAlerts(): Promise<unknown[]> {
		const value = await this.request(
			'widgets',
			'/api/v1/internal/v1/operations/widgets/admin-alerts',
			{ method: 'POST' }
		);
		const record = this.record(value, 'Widgets admin alerts');
		if (!Array.isArray(record.items) || record.items.length > 100_000) {
			throw new BadGatewayException(
				'Widgets admin alerts response is invalid'
			);
		}
		return record.items;
	}

	async getIdentitySnapshots(userIds: string[]) {
		if (!userIds.length) return [];
		const value = await this.request(
			'identity',
			'/internal/v1/operations/audit-snapshots',
			{ method: 'POST', body: JSON.stringify({ userIds }) }
		);
		const record = this.record(value, 'Identity audit snapshots');
		if (
			!Array.isArray(record.items) ||
			record.items.length > userIds.length
		) {
			throw new BadGatewayException(
				'Identity audit snapshots response is invalid'
			);
		}
		return record.items;
	}

	async getIdentityAdminHealth(): Promise<unknown[]> {
		const value = await this.request(
			'identity',
			'/internal/v1/operations/admin-health'
		);
		const record = this.record(value, 'Identity admin health');
		if (record.service !== 'identity' || !Array.isArray(record.checks)) {
			throw new BadGatewayException(
				'Identity admin health response is invalid'
			);
		}
		if (record.checks.length > 100) {
			throw new BadGatewayException(
				'Identity admin health response is too large'
			);
		}
		return record.checks;
	}

	async getMessagingOverviews() {
		const sources = Object.keys(OVERVIEW_PATHS) as ServiceName[];
		return Promise.all(
			sources.map(async source => {
				try {
					return {
						source,
						value: await this.request(source, OVERVIEW_PATHS[source]),
						error: null
					};
				} catch (error) {
					return {
						source,
						value: null,
						error:
							error instanceof Error
								? error.message.slice(0, 500)
								: 'Service unavailable'
					};
				}
			})
		);
	}

	async getFailures(
		source: MessagingFailureSource,
		page: number,
		limit: number,
		filters: { integration?: string; category?: string; status?: string }
	) {
		const query = new URLSearchParams({
			page: String(page),
			limit: String(limit)
		});
		if (filters.integration) {
			if (source === 'billing') {
				query.set(
					'consumer',
					PUBLIC_INTEGRATION_TO_BILLING_CONSUMER[filters.integration] ||
						filters.integration
				);
			} else if (source === 'identity') {
				query.set('consumer', filters.integration);
			} else query.set('integration', filters.integration);
		}
		if (filters.category) query.set('category', filters.category);
		if (filters.status) query.set('status', filters.status);
		const value = await this.request(
			source,
			`${FAILURE_PATHS[source]}?${query.toString()}`
		);
		const record = this.record(value, `${source} failures`);
		if (
			!Array.isArray(record.items) ||
			!Number.isSafeInteger(record.total) ||
			Number(record.total) < 0
		) {
			throw new BadGatewayException(
				`${source} failures response is invalid`
			);
		}
		return {
			items: record.items.map(item => this.normalizeFailure(source, item)),
			total: Number(record.total)
		};
	}

	async retryFailure(
		source: MessagingFailureSource,
		id: string,
		actorId: string
	) {
		const commandId = randomUUID();
		return this.request(
			source,
			`${FAILURE_PATHS[source]}/${encodeURIComponent(id)}/retry`,
			{
				method: 'POST',
				headers:
					source === 'billing' ? { 'idempotency-key': commandId } : {},
				body: JSON.stringify(
					source === 'billing'
						? {
								schemaVersion: 1,
								commandId,
								actorId,
								actorRole: 'DEV',
								occurredAt: new Date().toISOString()
							}
						: { actorId }
				)
			}
		);
	}

	async closeFailure(
		source: MessagingFailureSource,
		id: string,
		actorId: string,
		comment: string
	) {
		const commandId = randomUUID();
		return this.request(
			source,
			`${FAILURE_PATHS[source]}/${encodeURIComponent(id)}/close`,
			{
				method: 'POST',
				headers:
					source === 'billing' ? { 'idempotency-key': commandId } : {},
				body: JSON.stringify(
					source === 'billing'
						? {
								schemaVersion: 1,
								commandId,
								actorId,
								actorRole: 'DEV',
								occurredAt: new Date().toISOString(),
								comment
							}
						: { actorId, comment }
				)
			}
		);
	}

	private async request(
		source: ServiceName,
		path: string,
		init: RequestInit = {}
	): Promise<unknown> {
		const service = SERVICES[source];
		const token = this.token(service.tokenEnv);
		const url = `${this.baseUrl(service)}${path}`;
		let response: Response;
		try {
			response = await fetch(url, {
				...init,
				redirect: 'error',
				headers: {
					accept: 'application/json',
					'x-winwidget-internal-token': token,
					'x-winwidget-service': 'operations',
					'x-message-id': randomUUID(),
					...(init.body ? { 'content-type': 'application/json' } : {}),
					...(init.headers || {})
				},
				signal: AbortSignal.timeout(5_000)
			});
		} catch {
			throw new ServiceUnavailableException(`${source} is unavailable`);
		}
		const body = await response.json().catch(() => null);
		if (!response.ok) {
			throw new OperationsFederationHttpError(
				source,
				response.status,
				this.safeMessage(
					body,
					`${source} returned HTTP ${response.status}`
				)
			);
		}
		return body;
	}

	private normalizeFailure(
		source: MessagingFailureSource,
		value: unknown
	) {
		const record = this.record(value, `${source} failure`);
		const consumer =
			typeof record.consumer === 'string' ? record.consumer : null;
		return {
			...record,
			integration:
				source === 'billing' && consumer
					? BILLING_CONSUMER_TO_PUBLIC_INTEGRATION[consumer] || consumer
					: record.integration,
			source
		};
	}

	private baseUrl(service: ServiceConfig): string {
		const raw =
			this.config.get<string>(service.baseUrlEnv)?.trim() ||
			service.defaultBaseUrl;
		const url = new URL(raw);
		if (
			url.protocol !== 'http:' ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(
				`${service.baseUrlEnv} must be an exact private HTTP origin`
			);
		}
		return url.origin;
	}

	private token(name: string): string {
		const value = this.config.get<string>(name)?.trim();
		if (
			!value ||
			value.length < 32 ||
			[
				'change_me',
				'XYZXYZXYZ',
				name,
				`ci_${name.toLowerCase()}_at_least_32_chars`
			].includes(value) ||
			value.startsWith('change_me_')
		) {
			throw new ServiceUnavailableException(
				`${name} is not configured securely`
			);
		}
		return value;
	}

	private record(value: unknown, name: string): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new BadGatewayException(`${name} is invalid`);
		}
		return value as Record<string, unknown>;
	}

	private safeMessage(value: unknown, fallback: string): string {
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const message = (value as Record<string, unknown>).message;
			if (typeof message === 'string' && message.trim()) {
				return message.trim().slice(0, 500);
			}
		}
		return fallback;
	}
}
