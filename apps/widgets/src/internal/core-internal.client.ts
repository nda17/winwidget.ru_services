import {
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';

const DEFAULT_IDENTITY_BASE_URL = 'http://127.0.0.1:4900';
const DEFAULT_TIMEOUT_MS = 10_000;
const PLACEHOLDER_INTERNAL_TOKENS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'identity_widgets_token',
	'ci_identity_widgets_token_at_least_32_chars',
	'widgets_internal_token',
	'ci_widgets_internal_token_at_least_32_chars'
]);

export interface IntrospectedWidgetsActor {
	active: true;
	subject: string;
	sessionId: string;
	roles: Array<'ADMIN' | 'DEV' | 'USER'>;
}

export interface WidgetsOwnerDirectoryItem {
	id: string;
	name: string | null;
	status: 'ACTIVE' | 'DEACTIVATED' | 'DELETED';
	deletedAt: string | null;
	rights: Array<'ADMIN' | 'DEV' | 'USER'>;
	email: string | null;
	phone: string | null;
	subscription?: {
		id: string;
		plan: 'TRIAL' | 'EASY' | 'HARD';
		billingPeriod: 'MONTHLY' | 'YEARLY' | null;
		status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
		startsAt: string;
		expiresAt: string | null;
		periodResetsAt: string | null;
		createdAt: string;
		updatedAt: string;
	} | null;
}

export interface WidgetsOwnerSearchResult {
	items: WidgetsOwnerDirectoryItem[];
	nextAfterId: string | null;
}

@Injectable()
export class CoreInternalClient {
	private readonly identityBaseUrl: string;
	private readonly identityToken: string;
	private readonly timeoutMs: number;

	constructor(config: ConfigService, runtime: WidgetsRuntimeService) {
		this.identityBaseUrl = this.parseBaseUrl(
			config.get<string>('IDENTITY_INTERNAL_BASE_URL'),
			'IDENTITY_INTERNAL_BASE_URL'
		);
		this.identityToken =
			config.get<string>('IDENTITY_WIDGETS_TOKEN')?.trim() || '';
		if (
			runtime.apiEnabled &&
			(this.identityToken.length < 32 ||
				PLACEHOLDER_INTERNAL_TOKENS.has(this.identityToken))
		) {
			throw new Error(
				'IDENTITY_WIDGETS_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		const configuredTimeout = Number(
			config.get<string>('IDENTITY_INTERNAL_TIMEOUT_MS') ||
				DEFAULT_TIMEOUT_MS
		);
		if (
			!Number.isInteger(configuredTimeout) ||
			configuredTimeout < 500 ||
			configuredTimeout > 60_000
		) {
			throw new Error(
				'IDENTITY_INTERNAL_TIMEOUT_MS must be an integer between 500 and 60000'
			);
		}
		this.timeoutMs = configuredTimeout;
	}

	async introspect(
		authorization: string
	): Promise<IntrospectedWidgetsActor> {
		let response: Response;
		try {
			response = await fetch(
				`${this.identityBaseUrl}/internal/v1/auth/introspect`,
				{
					method: 'POST',
					headers: {
						authorization,
						'x-winwidget-service': 'widgets',
						'x-winwidget-internal-token': this.identityToken,
						accept: 'application/json'
					},
					signal: AbortSignal.timeout(this.timeoutMs)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Authorization service is unavailable'
			);
		}

		if (response.status === 401) {
			throw new UnauthorizedException('Authentication is no longer valid');
		}
		if (response.status === 403) {
			throw new ServiceUnavailableException(
				'Authorization service rejected its Widgets credential'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Authorization service is unavailable'
			);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		if (!this.isIntrospectedActor(payload)) {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		return payload;
	}

	async resolveOwners(
		userIds: string[]
	): Promise<WidgetsOwnerDirectoryItem[]> {
		if (!userIds.length) return [];
		if (
			userIds.length > 100 ||
			new Set(userIds).size !== userIds.length ||
			userIds.some(id => !id || id.length > 255)
		) {
			throw new Error('Widgets owner resolve input is invalid');
		}
		let response: Response;
		try {
			response = await fetch(
				`${this.identityBaseUrl}/internal/v1/widgets/owners/resolve`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'application/json',
						'x-winwidget-service': 'widgets',
						'x-winwidget-internal-token': this.identityToken
					},
					body: JSON.stringify({ userIds }),
					signal: AbortSignal.timeout(this.timeoutMs)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Owner directory is unavailable'
			);
		}
		if (!response.ok)
			throw new ServiceUnavailableException(
				'Owner directory is unavailable'
			);
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Owner directory returned an invalid response'
			);
		}
		if (
			!value ||
			typeof value !== 'object' ||
			Array.isArray(value) ||
			!Array.isArray((value as { items?: unknown }).items)
		) {
			throw new ServiceUnavailableException(
				'Owner directory returned an invalid response'
			);
		}
		const items = (value as { items: unknown[] }).items;
		if (
			items.length > userIds.length ||
			!items.every(item => this.isOwner(item, userIds))
		) {
			throw new ServiceUnavailableException(
				'Owner directory returned an invalid response'
			);
		}
		return items as WidgetsOwnerDirectoryItem[];
	}

	async searchOwners(input: {
		search?: string;
		plan?: 'TRIAL' | 'EASY' | 'HARD' | 'NONE';
		afterId?: string;
		limit?: number;
	}): Promise<WidgetsOwnerSearchResult> {
		const limit = input.limit ?? 100;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new Error('Widgets owner search limit is invalid');
		}
		const search = input.search?.trim();
		const afterId = input.afterId?.trim();
		if (
			(search && search.length > 200) ||
			(afterId && afterId.length > 255)
		) {
			throw new Error('Widgets owner search input is invalid');
		}
		let response: Response;
		try {
			response = await fetch(
				`${this.identityBaseUrl}/internal/v1/widgets/owners/search`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'application/json',
						'x-winwidget-service': 'widgets',
						'x-winwidget-internal-token': this.identityToken
					},
					body: JSON.stringify({
						...(search && { search }),
						...(input.plan && { plan: input.plan }),
						...(afterId && { afterId }),
						limit
					}),
					signal: AbortSignal.timeout(this.timeoutMs)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Owner directory is unavailable'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Owner directory is unavailable'
			);
		}
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Owner directory returned an invalid response'
			);
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new ServiceUnavailableException(
				'Owner directory returned an invalid response'
			);
		}
		const record = value as Record<string, unknown>;
		if (
			!Array.isArray(record.items) ||
			record.items.length > limit ||
			(record.nextAfterId !== null &&
				typeof record.nextAfterId !== 'string') ||
			!record.items.every(item => this.isOwner(item))
		) {
			throw new ServiceUnavailableException(
				'Owner directory returned an invalid response'
			);
		}
		const items = record.items as WidgetsOwnerDirectoryItem[];
		const ids = items.map(item => item.id);
		if (
			new Set(ids).size !== ids.length ||
			ids.some((id, index) => index > 0 && id <= ids[index - 1]) ||
			(afterId && ids.some(id => id <= afterId)) ||
			(record.nextAfterId !== null &&
				(!record.nextAfterId ||
					(afterId ? record.nextAfterId <= afterId : false) ||
					(items.length > 0 &&
						record.nextAfterId < items[items.length - 1].id)))
		) {
			throw new ServiceUnavailableException(
				'Owner directory returned an invalid response'
			);
		}
		return {
			items,
			nextAfterId: record.nextAfterId as string | null
		};
	}

	private parseBaseUrl(value: string | undefined, name: string): string {
		const configured = value?.trim() || DEFAULT_IDENTITY_BASE_URL;
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new Error(`${name} must be a valid URL`);
		}
		if (url.protocol !== 'http:') {
			throw new Error(`${name} must use http on the private network`);
		}
		if (url.username || url.password || url.search || url.hash) {
			throw new Error(
				`${name} must not contain credentials, query, or fragment`
			);
		}
		if (
			!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
				url.hostname.toLowerCase()
			)
		) {
			throw new Error(`${name} must use a loopback host`);
		}
		if (url.pathname !== '/') {
			throw new Error(`${name} must be an origin without a path`);
		}
		return url.toString().replace(/\/$/, '');
	}

	private isIntrospectedActor(
		value: unknown
	): value is IntrospectedWidgetsActor {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (
			keys.length !== 4 ||
			keys.some(
				(key, index) =>
					key !== ['active', 'roles', 'sessionId', 'subject'][index]
			)
		) {
			return false;
		}
		if (
			record.active !== true ||
			typeof record.subject !== 'string' ||
			!record.subject.trim() ||
			typeof record.sessionId !== 'string' ||
			!record.sessionId.trim() ||
			!Array.isArray(record.roles)
		) {
			return false;
		}
		return record.roles.every(role =>
			['ADMIN', 'DEV', 'USER'].includes(String(role))
		);
	}

	private isOwner(
		value: unknown,
		requested?: string[]
	): value is WidgetsOwnerDirectoryItem {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return false;
		const item = value as Record<string, unknown>;
		if (
			typeof item.id !== 'string' ||
			!item.id ||
			item.id.length > 255 ||
			(requested && !requested.includes(item.id)) ||
			(typeof item.name !== 'string' && item.name !== null) ||
			!['ACTIVE', 'DEACTIVATED', 'DELETED'].includes(
				String(item.status)
			) ||
			(typeof item.deletedAt !== 'string' && item.deletedAt !== null) ||
			(item.status === 'DELETED'
				? item.deletedAt === null
				: item.deletedAt !== null) ||
			(typeof item.email !== 'string' && item.email !== null) ||
			(typeof item.phone !== 'string' && item.phone !== null) ||
			!Array.isArray(item.rights)
		)
			return false;
		return item.rights.every(role =>
			['ADMIN', 'DEV', 'USER'].includes(String(role))
		);
	}
}
