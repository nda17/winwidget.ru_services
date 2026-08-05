import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { WIDGETS_INTERNAL_TOKEN_HEADER } from './widgets-internal.constants';

const OVERVIEW_PATH = '/internal/v1/widgets/admin-owner-overview';
const ADMIN_ALERTS_PATH = '/api/v1/internal/v1/widgets/admin-alerts';
const OWNER_USAGE_PATH = '/api/v1/internal/v1/widgets/owner-usage';
const REQUEST_TIMEOUT_MS = 3000;
const MAX_ADMIN_ALERTS = 100_000;
const WIDGET_TYPES = [
	'WHEEL',
	'QUIZ',
	'CALLBACK',
	'COUNTDOWN_TIMER',
	'STOP_OFFER',
	'ONLINE_CONSULTANT',
	'CALCULATOR'
] as const;

type WidgetType = (typeof WIDGET_TYPES)[number];
type JsonRecord = Record<string, unknown>;

export interface WidgetsAdminOwnerOverview {
	widgets: {
		total: number;
		active: number;
		inactive: number;
		byType: Array<{
			type: WidgetType;
			label: string;
			count: number;
			active: number;
			inactive: number;
		}>;
		latest: Array<{
			id: string;
			type: WidgetType;
			label: string;
			name: string;
			isActive: boolean;
			installDomain: string;
			leadsCount: number;
			updatedAt: string;
		}>;
	};
	leads: {
		total: number;
		byType: Array<{
			type: WidgetType;
			label: string;
			count: number;
		}>;
		latest: Array<{
			id: string;
			type: WidgetType;
			label: string;
			sourceName: string;
			contact: string | null;
			phone: string | null;
			email: string | null;
			url: string | null;
			detail: string | null;
			createdAt: string;
		}>;
	};
	usage: WidgetsOwnerUsage;
}

export interface WidgetsOwnerUsage {
	widgetCount: number;
	leadCount: number;
	periodKey: string | null;
	periodStartsAt: string | null;
	periodEndsAt: string | null;
}

export interface WidgetsOwnerUsageItem extends WidgetsOwnerUsage {
	userId: string;
}

export interface WidgetsAdminAlert {
	type:
		| 'ACTIVE_WIDGET_WITHOUT_ACCESS'
		| 'WIDGET_DOMAIN_CONFLICT'
		| 'WIDGET_INVALID_DOMAIN';
	severity: 'HIGH' | 'MEDIUM';
	referenceId: string;
	ownerId: string;
	title: string;
	message: string;
	alertAt: string;
}

@Injectable()
export class WidgetsAdminOverviewClient {
	async getOwnerOverview(
		userId: string
	): Promise<WidgetsAdminOwnerOverview> {
		const baseUrl = this.getBaseUrl();
		const token = this.getInternalToken();

		let response: Response;
		try {
			response = await fetch(`${baseUrl}${OVERVIEW_PATH}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					[WIDGETS_INTERNAL_TOKEN_HEADER]: token
				},
				body: JSON.stringify({ userId }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch {
			throw this.unavailable();
		}

		if (!response.ok) throw this.unavailable();

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw this.unavailable();
		}

		try {
			return this.parseOverview(payload);
		} catch {
			throw this.unavailable();
		}
	}

	async getAdminAlerts(): Promise<WidgetsAdminAlert[]> {
		const baseUrl = this.getBaseUrl();
		const token = this.getInternalToken();

		let response: Response;
		try {
			response = await fetch(`${baseUrl}${ADMIN_ALERTS_PATH}`, {
				method: 'POST',
				headers: {
					accept: 'application/json',
					[WIDGETS_INTERNAL_TOKEN_HEADER]: token
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch {
			throw this.unavailable();
		}

		if (!response.ok) throw this.unavailable();

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw this.unavailable();
		}

		try {
			const root = exactRecord(payload, ['items']);
			return arrayOf(
				root.items,
				value => this.parseAdminAlert(value),
				MAX_ADMIN_ALERTS
			);
		} catch {
			throw this.unavailable();
		}
	}

	async getOwnerUsage(
		userIds: string[]
	): Promise<WidgetsOwnerUsageItem[]> {
		if (
			userIds.length < 1 ||
			userIds.length > 100 ||
			new Set(userIds).size !== userIds.length ||
			userIds.some(userId => !userId || userId.length > 255)
		) {
			throw new Error('Widgets owner usage input is invalid');
		}
		const baseUrl = this.getBaseUrl();
		const token = this.getInternalToken();

		let response: Response;
		try {
			response = await fetch(`${baseUrl}${OWNER_USAGE_PATH}`, {
				method: 'POST',
				headers: {
					accept: 'application/json',
					'content-type': 'application/json',
					[WIDGETS_INTERNAL_TOKEN_HEADER]: token
				},
				body: JSON.stringify({ userIds }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch {
			throw this.unavailable();
		}

		if (!response.ok) throw this.unavailable();

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw this.unavailable();
		}

		try {
			const root = exactRecord(payload, ['items']);
			const items = arrayOf(
				root.items,
				value => {
					const item = exactRecord(value, [
						'userId',
						'widgetCount',
						'leadCount',
						'periodKey',
						'periodStartsAt',
						'periodEndsAt'
					]);
					return {
						userId: boundedString(item.userId),
						...this.parseUsage(item)
					};
				},
				userIds.length
			);
			if (
				items.length !== userIds.length ||
				items.some((item, index) => item.userId !== userIds[index])
			) {
				throw new Error();
			}
			return items;
		} catch {
			throw this.unavailable();
		}
	}

	private getBaseUrl(): string {
		const value = process.env.WIDGETS_INTERNAL_BASE_URL?.trim();
		if (!value) throw this.unavailable();

		let url: URL;
		try {
			url = new URL(value);
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

	private getInternalToken(): string {
		const token = process.env.WIDGETS_INTERNAL_TOKEN?.trim();
		if (
			!token ||
			token.length < 32 ||
			[
				'XYZXYZXYZ',
				'change-me',
				'WIDGETS_INTERNAL_TOKEN',
				'ci_widgets_internal_token_at_least_32_chars'
			].includes(token)
		) {
			throw this.unavailable();
		}
		return token;
	}

	private parseOverview(value: unknown): WidgetsAdminOwnerOverview {
		const root = exactRecord(value, ['widgets', 'leads', 'usage']);
		const widgets = exactRecord(root.widgets, [
			'total',
			'active',
			'inactive',
			'byType',
			'latest'
		]);
		const leads = exactRecord(root.leads, ['total', 'byType', 'latest']);
		const usage = exactRecord(root.usage, [
			'widgetCount',
			'leadCount',
			'periodKey',
			'periodStartsAt',
			'periodEndsAt'
		]);
		const totalWidgets = nonNegativeInteger(widgets.total);
		const activeWidgets = nonNegativeInteger(widgets.active);
		const inactiveWidgets = nonNegativeInteger(widgets.inactive);
		if (activeWidgets + inactiveWidgets !== totalWidgets)
			throw new Error();

		return {
			widgets: {
				total: totalWidgets,
				active: activeWidgets,
				inactive: inactiveWidgets,
				byType: arrayOf(widgets.byType, value => {
					const item = exactRecord(value, [
						'type',
						'label',
						'count',
						'active',
						'inactive'
					]);
					const count = nonNegativeInteger(item.count);
					const active = nonNegativeInteger(item.active);
					const inactive = nonNegativeInteger(item.inactive);
					if (active + inactive !== count) throw new Error();
					return {
						type: widgetType(item.type),
						label: boundedString(item.label),
						count,
						active,
						inactive
					};
				}),
				latest: arrayOf(widgets.latest, value => {
					const item = exactRecord(value, [
						'id',
						'type',
						'label',
						'name',
						'isActive',
						'installDomain',
						'leadsCount',
						'updatedAt'
					]);
					return {
						id: boundedString(item.id),
						type: widgetType(item.type),
						label: boundedString(item.label),
						name: boundedString(item.name, true),
						isActive: booleanValue(item.isActive),
						installDomain: boundedString(item.installDomain, true),
						leadsCount: nonNegativeInteger(item.leadsCount),
						updatedAt: isoDate(item.updatedAt)
					};
				})
			},
			leads: {
				total: nonNegativeInteger(leads.total),
				byType: arrayOf(leads.byType, value => {
					const item = exactRecord(value, ['type', 'label', 'count']);
					return {
						type: widgetType(item.type),
						label: boundedString(item.label),
						count: nonNegativeInteger(item.count)
					};
				}),
				latest: arrayOf(leads.latest, value => {
					const item = exactRecord(value, [
						'id',
						'type',
						'label',
						'sourceName',
						'contact',
						'phone',
						'email',
						'url',
						'detail',
						'createdAt'
					]);
					return {
						id: boundedString(item.id),
						type: widgetType(item.type),
						label: boundedString(item.label),
						sourceName: boundedString(item.sourceName, true),
						contact: nullableString(item.contact),
						phone: nullableString(item.phone),
						email: nullableString(item.email),
						url: nullableString(item.url),
						detail: nullableString(item.detail),
						createdAt: isoDate(item.createdAt)
					};
				})
			},
			usage: this.parseUsage(usage)
		};
	}

	private parseUsage(value: JsonRecord): WidgetsOwnerUsage {
		return {
			widgetCount: nonNegativeInteger(value.widgetCount),
			leadCount: nonNegativeInteger(value.leadCount),
			periodKey: nullableString(value.periodKey),
			periodStartsAt: nullableIsoDate(value.periodStartsAt),
			periodEndsAt: nullableIsoDate(value.periodEndsAt)
		};
	}

	private parseAdminAlert(value: unknown): WidgetsAdminAlert {
		const item = exactRecord(value, [
			'type',
			'severity',
			'referenceId',
			'ownerId',
			'title',
			'message',
			'alertAt'
		]);
		const type = boundedString(item.type) as WidgetsAdminAlert['type'];
		if (
			![
				'ACTIVE_WIDGET_WITHOUT_ACCESS',
				'WIDGET_DOMAIN_CONFLICT',
				'WIDGET_INVALID_DOMAIN'
			].includes(type)
		) {
			throw new Error();
		}
		const severity = boundedString(
			item.severity
		) as WidgetsAdminAlert['severity'];
		const expectedSeverity =
			type === 'WIDGET_INVALID_DOMAIN' ? 'MEDIUM' : 'HIGH';
		if (severity !== expectedSeverity) throw new Error();

		return {
			type,
			severity,
			referenceId: boundedString(item.referenceId),
			ownerId: boundedString(item.ownerId),
			title: boundedString(item.title),
			message: boundedString(item.message),
			alertAt: isoDate(item.alertAt)
		};
	}

	private unavailable(): ServiceUnavailableException {
		return new ServiceUnavailableException(
			'Widgets service is unavailable'
		);
	}
}

const exactRecord = (
	value: unknown,
	keys: readonly string[]
): JsonRecord => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error();
	}
	const record = value as JsonRecord;
	if (
		Object.keys(record).length !== keys.length ||
		keys.some(key => !(key in record))
	) {
		throw new Error();
	}
	return record;
};

const arrayOf = <T>(
	value: unknown,
	parser: (item: unknown) => T,
	maxItems = 100
): T[] => {
	if (!Array.isArray(value) || value.length > maxItems) throw new Error();
	return value.map(parser);
};

const boundedString = (value: unknown, allowEmpty = false): string => {
	if (
		typeof value !== 'string' ||
		(!allowEmpty && !value) ||
		value.length > 10_000
	) {
		throw new Error();
	}
	return value;
};

const nullableString = (value: unknown): string | null =>
	value === null ? null : boundedString(value, true);

const nonNegativeInteger = (value: unknown): number => {
	if (!Number.isInteger(value) || Number(value) < 0) throw new Error();
	return Number(value);
};

const booleanValue = (value: unknown): boolean => {
	if (typeof value !== 'boolean') throw new Error();
	return value;
};

const isoDate = (value: unknown): string => {
	const result = boundedString(value);
	if (!Number.isFinite(Date.parse(result))) throw new Error();
	return result;
};

const nullableIsoDate = (value: unknown): string | null =>
	value === null ? null : isoDate(value);

const widgetType = (value: unknown): WidgetType => {
	if (!WIDGET_TYPES.includes(value as WidgetType)) throw new Error();
	return value as WidgetType;
};
