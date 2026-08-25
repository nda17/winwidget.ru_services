import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

export interface LifecycleRevocation {
	commandId: string;
	requestedAt: string;
	userId: string;
	operation: 'DEACTIVATE' | 'DELETE';
	actorId: string;
	actorRole: 'ADMIN' | 'DEV';
}

export class LifecycleRevocationError extends Error {
	constructor(
		readonly revocation: LifecycleRevocation,
		options?: ErrorOptions
	) {
		super(
			'Billing lifecycle command has an indeterminate result',
			options
		);
	}
}

@Injectable()
export class OwnerClientsService {
	private readonly billing = endpoint('BILLING_INTERNAL_BASE_URL', 4800);
	private readonly widgets = endpoint('WIDGETS_INTERNAL_BASE_URL', 4700);
	private readonly operations = endpoint(
		'OPERATIONS_INTERNAL_BASE_URL',
		5200
	);
	private readonly billingToken: string;
	private readonly widgetsToken: string;
	private readonly operationsToken: string;

	constructor(config: ConfigService) {
		this.billingToken = token(config, 'BILLING_IDENTITY_TOKEN');
		this.widgetsToken = token(config, 'WIDGETS_IDENTITY_TOKEN');
		this.operationsToken = token(config, 'OPERATIONS_IDENTITY_TOKEN');
		if (
			new Set([this.billingToken, this.widgetsToken, this.operationsToken])
				.size !== 3
		) {
			throw new Error(
				'Identity owner credentials must be pairwise distinct'
			);
		}
	}

	ensureTrial(userId: string, registeredAt: Date): Promise<unknown> {
		const commandId = randomUUID();
		return this.call(
			this.billing,
			'/internal/v1/identity/billing/trials/ensure',
			this.billingToken,
			{
				schemaVersion: 1,
				commandId,
				userId,
				trialDays: 7,
				registeredAt: registeredAt.toISOString()
			},
			commandId
		);
	}

	async revokeEntitlements(input: {
		userId: string;
		reason: 'USER_DEACTIVATION' | 'USER_SOFT_DELETE';
		actorId: string;
		actorRole: 'ADMIN' | 'DEV';
	}): Promise<LifecycleRevocation> {
		const commandId = randomUUID();
		const requestedAt = new Date().toISOString();
		const operation =
			input.reason === 'USER_SOFT_DELETE' ? 'DELETE' : 'DEACTIVATE';
		const revocation: LifecycleRevocation = {
			commandId,
			requestedAt,
			userId: input.userId,
			operation,
			actorId: input.actorId,
			actorRole: input.actorRole
		};
		try {
			await this.call(
				this.billing,
				'/internal/v1/identity/billing/users/revoke-entitlements',
				this.billingToken,
				{
					schemaVersion: 1,
					commandId,
					...input,
					occurredAt: requestedAt
				},
				commandId,
				'POST',
				{ 'x-winwidget-service': 'identity' }
			);
		} catch (error) {
			throw new LifecycleRevocationError(revocation, { cause: error });
		}
		return revocation;
	}

	widgetsOverview(userId: string): Promise<unknown> {
		return this.call(
			this.widgets,
			'/internal/v1/identity/widgets/admin-owner-overview',
			this.widgetsToken,
			{ userId }
		);
	}

	billingOverview(userId: string): Promise<unknown> {
		return this.call(
			this.billing,
			`/internal/v1/identity/billing/users/${encodeURIComponent(userId)}/admin-overview`,
			this.billingToken,
			undefined,
			undefined,
			'GET'
		);
	}

	async subscriptionUserIds(): Promise<string[]> {
		const value = await this.call(
			this.billing,
			'/internal/v1/identity/billing/directory/subscription-user-ids',
			this.billingToken,
			undefined,
			undefined,
			'GET',
			{ 'x-winwidget-service': 'identity' }
		);
		if (
			!isRecord(value) ||
			!exactKeys(value, [
				'schemaVersion',
				'userIds',
				'count',
				'sourceSequence'
			])
		) {
			throw new ServiceUnavailableException(
				'Billing returned invalid directory response'
			);
		}
		if (
			value.schemaVersion !== 1 ||
			!Array.isArray(value.userIds) ||
			value.userIds.some(item => typeof item !== 'string' || !item) ||
			!Number.isSafeInteger(value.count) ||
			value.count !== value.userIds.length ||
			typeof value.sourceSequence !== 'string' ||
			!/^\d+$/.test(value.sourceSequence)
		) {
			throw new ServiceUnavailableException(
				'Billing returned invalid directory response'
			);
		}
		const userIds = value.userIds as string[];
		if (
			new Set(userIds).size !== userIds.length ||
			userIds.some(
				(item, index) => index > 0 && userIds[index - 1] >= item
			)
		) {
			throw new ServiceUnavailableException(
				'Billing returned invalid directory response'
			);
		}
		return userIds;
	}

	async adminOverview(userId: string): Promise<unknown> {
		return this.call(
			this.operations,
			`/internal/v1/identity/users/${encodeURIComponent(userId)}/admin-events/overview`,
			this.operationsToken,
			undefined,
			undefined,
			'GET',
			{ 'x-winwidget-service': 'identity' }
		);
	}

	private async call(
		origin: string,
		path: string,
		internalToken: string,
		body: unknown,
		idempotencyKey?: string,
		method: 'GET' | 'POST' = 'POST',
		extraHeaders: Record<string, string> = {}
	): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(`${origin}${path}`, {
				method,
				headers: {
					...(method === 'POST'
						? { 'content-type': 'application/json' }
						: {}),
					accept: 'application/json',
					'x-winwidget-internal-token': internalToken,
					'x-winwidget-service': 'identity',
					...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
					...extraHeaders
				},
				...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
				signal: AbortSignal.timeout(10_000)
			});
		} catch {
			throw new ServiceUnavailableException('Domain owner is unavailable');
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Domain owner rejected the request'
			);
		}
		try {
			return await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Domain owner returned invalid JSON'
			);
		}
	}
}

function endpoint(name: string, fallbackPort: number): string {
	const raw =
		process.env[name]?.trim() || `http://127.0.0.1:${fallbackPort}`;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${name} must be a valid URL`);
	}
	if (
		url.protocol !== 'http:' ||
		url.hostname !== '127.0.0.1' ||
		url.port !== String(fallbackPort) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	) {
		throw new Error(`${name} must be a private HTTP origin`);
	}
	return url.toString().replace(/\/$/, '');
}

function token(
	config: ConfigService,
	name: string,
	required = true
): string {
	const value = config.get<string>(name)?.trim() || '';
	const placeholders = new Set([
		'change_me',
		'change-me',
		'XYZXYZXYZ',
		'billing_internal_token',
		'widgets_internal_token',
		'core_identity_token',
		'operations_identity_token',
		'change_me_operations_identity_token_at_least_32_chars',
		'billing_identity_token',
		'widgets_identity_token',
		'ci_billing_internal_token_at_least_32_chars',
		'ci_widgets_internal_token_at_least_32_chars',
		'ci_core_identity_token_at_least_32_chars',
		'ci_operations_identity_token_at_least_32_chars',
		'ci_billing_identity_token_at_least_32_chars',
		'ci_widgets_identity_token_at_least_32_chars'
	]);
	if (required && (value.length < 32 || placeholders.has(value))) {
		throw new Error(
			`${name} must contain a non-placeholder secret of at least 32 characters`
		);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		Boolean(value) && typeof value === 'object' && !Array.isArray(value)
	);
}

function exactKeys(
	value: Record<string, unknown>,
	keys: string[]
): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}
