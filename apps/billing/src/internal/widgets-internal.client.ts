import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface WidgetsOwnerUsage {
	userId: string;
	widgetCount: number;
	leadCount: number;
	periodKey: string | null;
	periodStartsAt: string | null;
	periodEndsAt: string | null;
}

@Injectable()
export class WidgetsInternalClient {
	constructor(private readonly config: ConfigService) {}

	async getOwnerUsage(userIds: string[]): Promise<WidgetsOwnerUsage[]> {
		if (!userIds.length) return [];
		if (userIds.length > 100 || new Set(userIds).size !== userIds.length) {
			throw new Error('Widgets owner usage input is invalid');
		}
		const baseUrl = this.baseUrl();
		const token = this.token();
		let response: Response;
		try {
			response = await fetch(
				`${baseUrl}/api/v1/internal/v1/widgets/owner-usage`,
				{
					method: 'POST',
					headers: {
						accept: 'application/json',
						'content-type': 'application/json',
						'x-winwidget-internal-token': token
					},
					body: JSON.stringify({ userIds }),
					signal: AbortSignal.timeout(this.timeout())
				}
			);
		} catch {
			throw this.unavailable();
		}
		if (!response.ok) throw this.unavailable();
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw this.unavailable();
		}
		if (!value || typeof value !== 'object') throw this.unavailable();
		const items = (value as Record<string, unknown>).items;
		if (!Array.isArray(items) || items.length !== userIds.length) {
			throw this.unavailable();
		}
		const parsed = items.map(item => this.parseItem(item));
		if (parsed.some((item, index) => item.userId !== userIds[index])) {
			throw this.unavailable();
		}
		return parsed;
	}

	private parseItem(value: unknown): WidgetsOwnerUsage {
		if (!value || typeof value !== 'object') throw this.unavailable();
		const item = value as Record<string, unknown>;
		if (
			typeof item.userId !== 'string' ||
			!Number.isInteger(item.widgetCount) ||
			!Number.isInteger(item.leadCount)
		) {
			throw this.unavailable();
		}
		for (const key of [
			'periodKey',
			'periodStartsAt',
			'periodEndsAt'
		] as const) {
			if (item[key] !== null && typeof item[key] !== 'string') {
				throw this.unavailable();
			}
		}
		return item as unknown as WidgetsOwnerUsage;
	}

	private baseUrl(): string {
		const raw = this.config
			.get<string>('WIDGETS_INTERNAL_BASE_URL')
			?.trim();
		if (!raw) throw this.unavailable();
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw this.unavailable();
		}
		if (
			url.protocol !== 'http:' ||
			!['127.0.0.1', '::1', 'localhost'].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw this.unavailable();
		}
		return url.origin;
	}

	private token(): string {
		const value = this.config
			.get<string>('WIDGETS_INTERNAL_TOKEN')
			?.trim();
		if (
			!value ||
			value.length < 32 ||
			['change_me', 'XYZXYZXYZ'].includes(value)
		) {
			throw this.unavailable();
		}
		return value;
	}

	private timeout(): number {
		const value = Number(
			this.config.get<string>('WIDGETS_INTERNAL_TIMEOUT_MS') || 3_000
		);
		if (!Number.isInteger(value) || value < 500 || value > 60_000) {
			throw this.unavailable();
		}
		return value;
	}

	private unavailable(): ServiceUnavailableException {
		return new ServiceUnavailableException(
			'Widgets service is unavailable'
		);
	}
}
