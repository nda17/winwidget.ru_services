import { HealthService } from '@/health/health.service';
import {
	IdentityAuditSnapshot,
	IdentityInternalClient
} from '@/identity-boundary/identity-internal.client';
import { PrismaService } from '@/prisma.service';
import {
	WidgetsAdminAlert,
	WidgetsAdminOverviewClient
} from '@/widgets-internal/widgets-admin-overview.client';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type AdminAlertType =
	| 'SUBSCRIPTION_EXPIRES_SOON'
	| 'EXPIRED_ACTIVE_SUBSCRIPTION'
	| 'PENDING_PAYMENT'
	| 'SUCCEEDED_PAYMENT_WITHOUT_ACCESS'
	| 'MULTIPLE_PENDING_PAYMENTS'
	| 'ACTIVE_WIDGET_WITHOUT_ACCESS'
	| 'WIDGET_DOMAIN_CONFLICT'
	| 'WIDGET_INVALID_DOMAIN'
	| 'INTEGRATION_PROBLEM'
	| 'AFFILIATE_REWARD_STALE'
	| 'AFFILIATE_REWARD_PAYMENT_CANCELLED';

type AdminAlertSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

interface AdminAlertFilters {
	type?: string;
	severity?: string;
	search?: string;
}

interface AdminAlertRow {
	alert_type: AdminAlertType;
	severity: AdminAlertSeverity;
	reference_id: string;
	target_user_id: string | null;
	target_user_name: string | null;
	target_user_email: string | null;
	target_user_phone: null;
	title: string;
	message: string;
	alert_at: Date;
}

@Injectable()
export class AdminAlertsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly healthService: HealthService,
		private readonly widgetsAdminClient: WidgetsAdminOverviewClient,
		private readonly identity: IdentityInternalClient
	) {}

	async getAll(page = 1, limit = 20, filters: AdminAlertFilters = {}) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const baseSql = await this.getBaseSql();
		const directory = await this.getIdentityDirectory(baseSql);
		const enrichedSql = this.enrichWithIdentity(baseSql, directory);
		const whereSql = this.getWhereSql(filters);

		const [items, totalRows] = await this.prisma.$transaction([
			this.prisma.$queryRaw<AdminAlertRow[]>(Prisma.sql`
				SELECT *
				FROM (${enrichedSql}) AS admin_alerts
				${whereSql}
				ORDER BY
					CASE severity
						WHEN 'HIGH' THEN 1
						WHEN 'MEDIUM' THEN 2
						ELSE 3
					END,
					alert_at ASC
				LIMIT ${normalizedLimit}
				OFFSET ${skip}
			`),
			this.prisma.$queryRaw<Array<{ count: number | bigint }>>(Prisma.sql`
				SELECT COUNT(*)::int AS count
				FROM (${enrichedSql}) AS admin_alerts
				${whereSql}
			`)
		]);

		const total = this.toNumber(totalRows[0]?.count ?? 0);
		return {
			items: items.map(item => this.serialize(item)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	private async getBaseSql() {
		const subscriptionsTable = Prisma.raw(
			'"billing_subscription_read_projections"'
		);
		const paymentsTable = Prisma.raw('"billing_payment_read_projections"');
		const affiliatesTable = Prisma.raw(
			'"billing_affiliate_read_projections"'
		);
		const [widgetAlerts, integrationAlertsSql] = await Promise.all([
			this.widgetsAdminClient.getAdminAlerts(),
			this.getIntegrationAlertsSql()
		]);
		const widgetAlertsSql = this.getWidgetAlertsSql(widgetAlerts);
		const widgetAlertsUnionSql = widgetAlertsSql
			? Prisma.sql`UNION ALL ${widgetAlertsSql}`
			: Prisma.empty;
		const integrationAlertsUnionSql = integrationAlertsSql
			? Prisma.sql`UNION ALL ${integrationAlertsSql}`
			: Prisma.empty;

		return Prisma.sql`
			SELECT
				'EXPIRED_ACTIVE_SUBSCRIPTION'::text AS alert_type,
				'HIGH'::text AS severity,
				s.id AS reference_id,
				s.user_id AS target_user_id,
				'Истёкшая подписка ещё активна'::text AS title,
				concat('Подписка истекла ', to_char(s.expires_at, 'DD.MM.YYYY HH24:MI'), ', но статус всё ещё ACTIVE') AS message,
				s.expires_at AS alert_at
			FROM ${subscriptionsTable} s
			WHERE s.status::text = 'ACTIVE'
				AND s.expires_at IS NOT NULL
				AND s.expires_at < NOW()

			UNION ALL

			SELECT
				'SUBSCRIPTION_EXPIRES_SOON'::text,
				'MEDIUM'::text,
				s.id,
				s.user_id,
				'Подписка скоро истекает'::text,
				concat('Подписка истекает ', to_char(s.expires_at, 'DD.MM.YYYY HH24:MI')),
				s.expires_at
			FROM ${subscriptionsTable} s
			WHERE s.status::text = 'ACTIVE'
				AND s.expires_at IS NOT NULL
				AND s.expires_at >= NOW()
				AND s.expires_at <= NOW() + INTERVAL '7 days'

			UNION ALL

			SELECT
				'PENDING_PAYMENT'::text,
				'MEDIUM'::text,
				p.id,
				p.user_id,
				'Платёж долго в pending'::text,
				concat('Платёж ', p.yookassa_id, ' ожидает подтверждения больше 30 минут'),
				p.created_at
			FROM ${paymentsTable} p
			WHERE p.status::text = 'PENDING'
				AND p.created_at <= NOW() - INTERVAL '30 minutes'

			UNION ALL

			SELECT
				'SUCCEEDED_PAYMENT_WITHOUT_ACCESS'::text,
				'HIGH'::text,
				p.id,
				p.user_id,
				'Оплата прошла, доступ не активен'::text,
				concat('Платёж ', p.yookassa_id, ' успешен, но у пользователя нет активной подписки'),
				p.updated_at
			FROM ${paymentsTable} p
			LEFT JOIN ${subscriptionsTable} s ON s.user_id = p.user_id
			WHERE p.status::text = 'SUCCEEDED'
				AND p.updated_at >= NOW() - INTERVAL '7 days'
				AND (
					s.id IS NULL
					OR s.status::text <> 'ACTIVE'
					OR (s.expires_at IS NOT NULL AND s.expires_at < NOW())
				)

			UNION ALL

			SELECT
				'MULTIPLE_PENDING_PAYMENTS'::text,
				'MEDIUM'::text,
				pending_payments.user_id,
				pending_payments.user_id,
				'Несколько pending-платежей у пользователя'::text,
				concat('У пользователя ', pending_payments.pending_count, ' платежа в статусе PENDING'),
				pending_payments.last_pending_at
			FROM (
				SELECT
					user_id,
					COUNT(*)::int AS pending_count,
					MAX(created_at) AS last_pending_at
				FROM ${paymentsTable}
				WHERE status::text = 'PENDING'
				GROUP BY user_id
				HAVING COUNT(*) > 1
			) pending_payments

			${widgetAlertsUnionSql}

			UNION ALL

			SELECT
				'AFFILIATE_REWARD_STALE'::text,
				'MEDIUM'::text,
				ar.id,
				ar.referrer_id,
				'Партнёрская выплата ждёт обработки'::text,
				concat('Кэшбек ', COALESCE(ar.cashback_amount, 0), ' ₽ доступен с ', to_char(ar.available_at, 'DD.MM.YYYY HH24:MI')),
				ar.available_at
			FROM ${affiliatesTable} ar
			WHERE ar.status::text = 'REWARD_PENDING'
				AND ar.available_at IS NOT NULL
				AND ar.available_at <= NOW() - INTERVAL '3 days'

			UNION ALL

			SELECT
				'AFFILIATE_REWARD_PAYMENT_CANCELLED'::text,
				'HIGH'::text,
				ar.id,
				ar.referrer_id,
				'Кэшбек привязан к отменённому платежу'::text,
				concat('Реферальное начисление связано с отменённым платежом ', p.yookassa_id),
				COALESCE(ar.cancelled_at, ar.updated_at)
			FROM ${affiliatesTable} ar
			JOIN ${paymentsTable} p ON p.id = ar.first_payment_id
			WHERE p.status::text = 'CANCELLED'
				AND ar.status::text IN ('REWARD_PENDING', 'PAID')

			${integrationAlertsUnionSql}
		`;
	}

	private async getIdentityDirectory(baseSql: Prisma.Sql) {
		const rows = await this.prisma.$queryRaw<
			Array<{ targetUserId: string }>
		>(Prisma.sql`
			SELECT DISTINCT target_user_id AS "targetUserId"
			FROM (${baseSql}) AS alert_sources
			WHERE target_user_id IS NOT NULL
			ORDER BY target_user_id ASC
		`);
		const userIds = rows.map(row => row.targetUserId);
		const snapshots: Array<IdentityAuditSnapshot> = [];
		for (let index = 0; index < userIds.length; index += 100) {
			const batch = userIds.slice(index, index + 100);
			const resolved = await this.identity.getAuditSnapshots(batch);
			for (const userId of batch) {
				const snapshot = resolved.get(userId);
				if (snapshot) snapshots.push(snapshot);
			}
		}
		return snapshots;
	}

	private enrichWithIdentity(
		baseSql: Prisma.Sql,
		directory: IdentityAuditSnapshot[]
	) {
		return Prisma.sql`
			SELECT
				source.alert_type,
				source.severity,
				source.reference_id,
				source.target_user_id,
				identity_snapshot.name AS target_user_name,
				identity_snapshot.email AS target_user_email,
				NULL::text AS target_user_phone,
				source.title,
				source.message,
				source.alert_at
			FROM (${baseSql}) AS source
			LEFT JOIN jsonb_to_recordset(${JSON.stringify(directory)}::jsonb)
				AS identity_snapshot(id text, name text, email text)
				ON identity_snapshot.id = source.target_user_id
		`;
	}

	private getWidgetAlertsSql(
		alerts: WidgetsAdminAlert[]
	): Prisma.Sql | null {
		if (!alerts.length) return null;
		const payload = alerts.map(alert => ({
			alert_type: alert.type,
			severity: alert.severity,
			reference_id: alert.referenceId,
			owner_id: alert.ownerId,
			title: alert.title,
			message: alert.message,
			alert_at: alert.alertAt
		}));
		return Prisma.sql`
			SELECT
				widget_alert.alert_type,
				widget_alert.severity,
				widget_alert.reference_id,
				widget_alert.owner_id,
				widget_alert.title,
				widget_alert.message,
				widget_alert.alert_at
			FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS widget_alert(
				alert_type text,
				severity text,
				reference_id text,
				owner_id text,
				title text,
				message text,
				alert_at timestamptz
			)
		`;
	}

	private async getIntegrationAlertsSql() {
		const health = await this.healthService.getAdminHealth();
		const checks = health.checks.filter(
			check => check.status === 'warning' || check.status === 'down'
		);
		if (!checks.length) return null;
		const now = new Date();
		return Prisma.join(
			checks.map(check => {
				const severity: AdminAlertSeverity =
					check.status === 'down' ? 'HIGH' : 'MEDIUM';
				const message = check.latencyMs
					? `${check.message}. Время ответа: ${check.latencyMs} мс`
					: check.message;
				return Prisma.sql`
					SELECT
						'INTEGRATION_PROBLEM'::text,
						${severity}::text,
						${check.id}::text,
						NULL::text,
						${`Интеграция требует внимания: ${check.title}`}::text,
						${message}::text,
						${now}::timestamp
				`;
			}),
			' UNION ALL '
		);
	}

	private getWhereSql(filters: AdminAlertFilters) {
		const and: Prisma.Sql[] = [];
		const type = this.normalizeType(filters.type);
		const severity = this.normalizeSeverity(filters.severity);
		const search = filters.search?.trim();
		if (type) and.push(Prisma.sql`alert_type = ${type}`);
		if (severity) and.push(Prisma.sql`severity = ${severity}`);
		if (search) {
			and.push(Prisma.sql`
				concat_ws(
					' ',
					reference_id,
					target_user_id,
					target_user_name,
					target_user_email,
					title,
					message
				) ILIKE ${`%${search}%`}
			`);
		}
		return and.length
			? Prisma.sql`WHERE ${Prisma.join(and, ' AND ')}`
			: Prisma.empty;
	}

	private normalizeType(value?: string) {
		const normalized = value?.trim().toUpperCase();
		const allowed: AdminAlertType[] = [
			'SUBSCRIPTION_EXPIRES_SOON',
			'EXPIRED_ACTIVE_SUBSCRIPTION',
			'PENDING_PAYMENT',
			'SUCCEEDED_PAYMENT_WITHOUT_ACCESS',
			'MULTIPLE_PENDING_PAYMENTS',
			'ACTIVE_WIDGET_WITHOUT_ACCESS',
			'WIDGET_DOMAIN_CONFLICT',
			'WIDGET_INVALID_DOMAIN',
			'INTEGRATION_PROBLEM',
			'AFFILIATE_REWARD_STALE',
			'AFFILIATE_REWARD_PAYMENT_CANCELLED'
		];
		if (!normalized) return undefined;
		if (!allowed.includes(normalized as AdminAlertType)) {
			throw new BadRequestException('Некорректный тип предупреждения');
		}
		return normalized as AdminAlertType;
	}

	private normalizeSeverity(value?: string) {
		const normalized = value?.trim().toUpperCase();
		const allowed: AdminAlertSeverity[] = ['HIGH', 'MEDIUM', 'LOW'];
		if (!normalized) return undefined;
		if (!allowed.includes(normalized as AdminAlertSeverity)) {
			throw new BadRequestException(
				'Некорректная важность предупреждения'
			);
		}
		return normalized as AdminAlertSeverity;
	}

	private serialize(item: AdminAlertRow) {
		return {
			type: item.alert_type,
			severity: item.severity,
			referenceId: item.reference_id,
			targetUser: item.target_user_id
				? {
						id: item.target_user_id,
						name: item.target_user_name,
						email: item.target_user_email,
						phone: null
					}
				: null,
			title: item.title,
			message: item.message,
			alertAt: item.alert_at.toISOString()
		};
	}

	private toNumber(value: number | bigint) {
		return typeof value === 'bigint' ? Number(value) : value;
	}
}
