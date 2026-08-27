import { BadRequestException, Injectable } from '@nestjs/common';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsFederationClient } from '../federation/operations-federation.client';

const ALERT_TYPES = [
	'SUBSCRIPTION_EXPIRES_SOON',
	'EXPIRED_ACTIVE_SUBSCRIPTION',
	'PENDING_PAYMENT',
	'SUCCEEDED_PAYMENT_WITHOUT_ACCESS',
	'MULTIPLE_PENDING_PAYMENTS',
	'PAYMENT_RECEIPT_CANCELLED',
	'PAYMENT_RECEIPT_SYNC_FAILED',
	'PAYMENT_RECEIPT_STALE',
	'ACTIVE_WIDGET_WITHOUT_ACCESS',
	'WIDGET_DOMAIN_CONFLICT',
	'WIDGET_INVALID_DOMAIN',
	'INTEGRATION_PROBLEM',
	'AFFILIATE_REWARD_STALE',
	'AFFILIATE_REWARD_PAYMENT_CANCELLED'
] as const;
const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
type AlertType = (typeof ALERT_TYPES)[number];
type AlertSeverity = (typeof SEVERITIES)[number];

interface AlertItem {
	type: AlertType;
	severity: AlertSeverity;
	referenceId: string;
	ownerId: string | null;
	targetName: string | null;
	targetEmail: string | null;
	title: string;
	message: string;
	alertAt: string;
}

@Injectable()
export class AdminAlertsService {
	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly federation: OperationsFederationClient
	) {}

	async getAll(
		page: number,
		limit: number,
		filters: { type?: string; severity?: string; search?: string }
	) {
		const normalizedPage = this.integer(page, 1);
		const normalizedLimit = Math.min(this.integer(limit, 20), 100);
		const type = this.type(filters.type);
		const severity = this.severity(filters.severity);
		const search = filters.search?.trim().toLocaleLowerCase('ru-RU') || '';
		const generatedAt = new Date();
		const [billing, widgets, local, serviceHealth] = await Promise.all([
			this.federation
				.getBillingAlerts()
				.then(items => ({ items, error: null as string | null }))
				.catch(() => ({
					items: [] as unknown[],
					error: 'Billing admin alerts недоступны'
				})),
			this.federation
				.getWidgetsAlerts()
				.then(items => ({ items, error: null as string | null }))
				.catch(() => ({
					items: [] as unknown[],
					error: 'Widgets admin alerts недоступны'
				})),
			this.prisma.operationalAlert.findMany({
				where: { resolvedAt: null },
				orderBy: { alertAt: 'asc' },
				take: 100_000
			}),
			this.federation.getMessagingOverviews()
		]);
		const items = [
			...billing.items.map(value => this.external(value)),
			...widgets.items.map(value => this.external(value)),
			...local.map(value => ({
				type: this.type(value.type) || 'INTEGRATION_PROBLEM',
				severity: value.severity,
				referenceId: value.referenceId,
				ownerId: value.targetUserId,
				targetName: value.targetUserName,
				targetEmail: value.targetUserEmail,
				title: value.title,
				message: value.message,
				alertAt: value.alertAt.toISOString()
			})),
			...[
				...(billing.error
					? [{ id: 'billing-admin-alerts', message: billing.error }]
					: []),
				...(widgets.error
					? [{ id: 'widgets-admin-alerts', message: widgets.error }]
					: []),
				...serviceHealth
					.filter((entry): entry is typeof entry & { error: string } =>
						Boolean(entry.error)
					)
					.map(entry => ({
						id: `${entry.source}-messaging`,
						message: `${entry.source} internal API недоступен`
					}))
			].map(problem =>
				this.integrationProblem(problem.id, problem.message, generatedAt)
			)
		];
		const directory = await this.identityDirectory(
			items
				.map(item => item.ownerId)
				.filter((id): id is string => Boolean(id))
		).catch(() => {
			items.push(
				this.integrationProblem(
					'identity-directory',
					'Identity audit snapshots недоступны',
					generatedAt
				)
			);
			return new Map<
				string,
				{ name: string | null; email: string | null }
			>();
		});
		const filtered = items
			.filter(item => !type || item.type === type)
			.filter(item => !severity || item.severity === severity)
			.filter(item => {
				if (!search) return true;
				const identity = item.ownerId
					? directory.get(item.ownerId)
					: undefined;
				return [
					item.referenceId,
					item.ownerId,
					identity?.name,
					identity?.email,
					item.title,
					item.message
				]
					.filter((value): value is string => Boolean(value))
					.join(' ')
					.toLocaleLowerCase('ru-RU')
					.includes(search);
			})
			.sort((left, right) => {
				const severityOrder =
					SEVERITIES.indexOf(left.severity) -
					SEVERITIES.indexOf(right.severity);
				return severityOrder || left.alertAt.localeCompare(right.alertAt);
			});
		const total = filtered.length;
		const start = (normalizedPage - 1) * normalizedLimit;
		return {
			items: filtered.slice(start, start + normalizedLimit).map(item => {
				const identity = item.ownerId
					? directory.get(item.ownerId)
					: undefined;
				return {
					type: item.type,
					severity: item.severity,
					referenceId: item.referenceId,
					targetUser: item.ownerId
						? {
								id: item.ownerId,
								name: identity?.name ?? item.targetName,
								email: identity?.email ?? item.targetEmail,
								phone: null
							}
						: null,
					title: item.title,
					message: item.message,
					alertAt: item.alertAt
				};
			}),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	private integrationProblem(
		referenceId: string,
		message: string,
		alertAt: Date
	): AlertItem {
		return {
			type: 'INTEGRATION_PROBLEM',
			severity: 'HIGH',
			referenceId,
			ownerId: null,
			targetName: null,
			targetEmail: null,
			title: 'Интеграция требует внимания',
			message,
			alertAt: alertAt.toISOString()
		};
	}

	private external(value: unknown): AlertItem {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Federated admin alert is invalid');
		}
		const record = value as Record<string, unknown>;
		const type = this.type(record.type);
		const severity = this.severity(record.severity);
		if (
			!type ||
			!severity ||
			typeof record.referenceId !== 'string' ||
			!record.referenceId ||
			typeof record.ownerId !== 'string' ||
			!record.ownerId ||
			typeof record.title !== 'string' ||
			typeof record.message !== 'string' ||
			typeof record.alertAt !== 'string' ||
			!Number.isFinite(Date.parse(record.alertAt))
		) {
			throw new Error('Federated admin alert contract is invalid');
		}
		return {
			type,
			severity,
			referenceId: record.referenceId,
			ownerId: record.ownerId,
			targetName: null,
			targetEmail: null,
			title: record.title,
			message: record.message,
			alertAt: new Date(record.alertAt).toISOString()
		};
	}

	private async identityDirectory(userIds: string[]) {
		const unique = [...new Set(userIds)];
		const output = new Map<
			string,
			{ name: string | null; email: string | null }
		>();
		for (let index = 0; index < unique.length; index += 100) {
			const batch = unique.slice(index, index + 100);
			const values = await this.federation.getIdentitySnapshots(batch);
			for (const value of values) {
				if (!value || typeof value !== 'object' || Array.isArray(value))
					continue;
				const record = value as Record<string, unknown>;
				if (typeof record.id !== 'string' || !batch.includes(record.id))
					continue;
				output.set(record.id, {
					name: typeof record.name === 'string' ? record.name : null,
					email: typeof record.email === 'string' ? record.email : null
				});
			}
		}
		return output;
	}

	private type(value: unknown): AlertType | undefined {
		if (value === undefined || value === null || value === '')
			return undefined;
		const normalized =
			typeof value === 'string' ? value.trim().toUpperCase() : '';
		if (!ALERT_TYPES.includes(normalized as AlertType)) {
			throw new BadRequestException('Некорректный тип предупреждения');
		}
		return normalized as AlertType;
	}

	private severity(value: unknown): AlertSeverity | undefined {
		if (value === undefined || value === null || value === '')
			return undefined;
		const normalized =
			typeof value === 'string' ? value.trim().toUpperCase() : '';
		if (!SEVERITIES.includes(normalized as AlertSeverity)) {
			throw new BadRequestException(
				'Некорректная важность предупреждения'
			);
		}
		return normalized as AlertSeverity;
	}

	private integer(value: number, fallback: number) {
		return Number.isSafeInteger(value) && value > 0 ? value : fallback;
	}
}
