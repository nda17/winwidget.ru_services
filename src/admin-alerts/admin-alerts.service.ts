import { PrismaService } from '@/prisma.service';
import { HealthService } from '@/health/health.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type AdminAlertType =
	| 'SUBSCRIPTION_EXPIRES_SOON'
	| 'EXPIRED_ACTIVE_SUBSCRIPTION'
	| 'PENDING_PAYMENT'
	| 'USER_WITHOUT_CONTACT'
	| 'ACTIVE_SUBSCRIBER_WITHOUT_CONTACT'
	| 'SUCCEEDED_PAYMENT_WITHOUT_ACCESS'
	| 'MULTIPLE_PENDING_PAYMENTS'
	| 'ACTIVE_WIDGET_WITHOUT_ACCESS'
	| 'ACTIVE_WIDGET_WITHOUT_DOMAIN'
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
	target_user_phone: string | null;
	title: string;
	message: string;
	alert_at: Date;
}

@Injectable()
export class AdminAlertsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly healthService: HealthService
	) {}

	async getAll(page = 1, limit = 20, filters: AdminAlertFilters = {}) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const baseSql = await this.getBaseSql();
		const whereSql = this.getWhereSql(filters);

		const [items, totalRows] = await this.prisma.$transaction([
			this.prisma.$queryRaw<AdminAlertRow[]>(Prisma.sql`
				SELECT *
				FROM (${baseSql}) AS admin_alerts
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
				FROM (${baseSql}) AS admin_alerts
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
		const userFieldsSql = Prisma.sql`
			u.id AS target_user_id,
			u.name AS target_user_name,
			email_identity.value AS target_user_email,
			phone_identity.value AS target_user_phone
		`;
		const userIdentityJoinsSql = Prisma.sql`
			LEFT JOIN LATERAL (
				SELECT ai.value
				FROM auth_identities ai
				WHERE ai.user_id = u.id AND ai.type::text = 'EMAIL'
				ORDER BY ai.created_at ASC
				LIMIT 1
			) email_identity ON true
			LEFT JOIN LATERAL (
				SELECT ai.value
				FROM auth_identities ai
				WHERE ai.user_id = u.id AND ai.type::text = 'PHONE'
				ORDER BY ai.created_at ASC
				LIMIT 1
			) phone_identity ON true
		`;
		const widgetsSql = this.getWidgetsSql();
		const integrationAlertsSql = await this.getIntegrationAlertsSql();
		const integrationAlertsUnionSql = integrationAlertsSql
			? Prisma.sql`
				UNION ALL

				${integrationAlertsSql}
			`
			: Prisma.empty;

		return Prisma.sql`
			SELECT
				'EXPIRED_ACTIVE_SUBSCRIPTION'::text AS alert_type,
				'HIGH'::text AS severity,
				s.id AS reference_id,
				${userFieldsSql},
				'Истёкшая подписка ещё активна'::text AS title,
				concat('Подписка истекла ', to_char(s.expires_at, 'DD.MM.YYYY HH24:MI'), ', но статус всё ещё ACTIVE') AS message,
				s.expires_at AS alert_at
			FROM subscriptions s
			JOIN "User" u ON u.id = s.user_id
			${userIdentityJoinsSql}
			WHERE s.status::text = 'ACTIVE'
				AND s.expires_at IS NOT NULL
				AND s.expires_at < NOW()

			UNION ALL

			SELECT
				'SUBSCRIPTION_EXPIRES_SOON'::text AS alert_type,
				'MEDIUM'::text AS severity,
				s.id AS reference_id,
				${userFieldsSql},
				'Подписка скоро истекает'::text AS title,
				concat('Подписка истекает ', to_char(s.expires_at, 'DD.MM.YYYY HH24:MI')) AS message,
				s.expires_at AS alert_at
			FROM subscriptions s
			JOIN "User" u ON u.id = s.user_id
			${userIdentityJoinsSql}
			WHERE s.status::text = 'ACTIVE'
				AND s.expires_at IS NOT NULL
				AND s.expires_at >= NOW()
				AND s.expires_at <= NOW() + INTERVAL '7 days'

			UNION ALL

			SELECT
				'PENDING_PAYMENT'::text AS alert_type,
				'MEDIUM'::text AS severity,
				p.id AS reference_id,
				${userFieldsSql},
				'Платёж долго в pending'::text AS title,
				concat('Платёж ', p.yookassa_id, ' ожидает подтверждения больше 30 минут') AS message,
				p.created_at AS alert_at
			FROM payments p
			JOIN "User" u ON u.id = p.user_id
			${userIdentityJoinsSql}
			WHERE p.status::text = 'PENDING'
				AND p.created_at <= NOW() - INTERVAL '30 minutes'

			UNION ALL

			SELECT
				'SUCCEEDED_PAYMENT_WITHOUT_ACCESS'::text AS alert_type,
				'HIGH'::text AS severity,
				p.id AS reference_id,
				${userFieldsSql},
				'Оплата прошла, доступ не активен'::text AS title,
				concat('Платёж ', p.yookassa_id, ' успешен, но у пользователя нет активной подписки') AS message,
				p.updated_at AS alert_at
			FROM payments p
			JOIN "User" u ON u.id = p.user_id
			LEFT JOIN subscriptions s ON s.user_id = u.id
			${userIdentityJoinsSql}
			WHERE p.status::text = 'SUCCEEDED'
				AND p.updated_at >= NOW() - INTERVAL '7 days'
				AND (
					s.id IS NULL
					OR s.status::text <> 'ACTIVE'
					OR (s.expires_at IS NOT NULL AND s.expires_at < NOW())
				)

			UNION ALL

			SELECT
				'MULTIPLE_PENDING_PAYMENTS'::text AS alert_type,
				'MEDIUM'::text AS severity,
				u.id AS reference_id,
				${userFieldsSql},
				'Несколько pending-платежей у пользователя'::text AS title,
				concat('У пользователя ', pending_payments.pending_count, ' платежа в статусе PENDING') AS message,
				pending_payments.last_pending_at AS alert_at
			FROM (
				SELECT
					user_id,
					COUNT(*)::int AS pending_count,
					MAX(created_at) AS last_pending_at
				FROM payments
				WHERE status::text = 'PENDING'
				GROUP BY user_id
				HAVING COUNT(*) > 1
			) pending_payments
			JOIN "User" u ON u.id = pending_payments.user_id
			${userIdentityJoinsSql}

			UNION ALL

			SELECT
				'USER_WITHOUT_CONTACT'::text AS alert_type,
				'LOW'::text AS severity,
				u.id AS reference_id,
				${userFieldsSql},
				'Пользователь без email и телефона'::text AS title,
				'У пользователя нет email или телефона для оплаты, рассылок и поддержки'::text AS message,
				u.created_at AS alert_at
			FROM "User" u
			${userIdentityJoinsSql}
			WHERE u.status::text = 'ACTIVE'
				AND email_identity.value IS NULL
				AND phone_identity.value IS NULL
				AND NOT EXISTS (
					SELECT 1
					FROM subscriptions active_contact_subscription
					WHERE active_contact_subscription.user_id = u.id
						AND active_contact_subscription.status::text = 'ACTIVE'
						AND (
							active_contact_subscription.expires_at IS NULL
							OR active_contact_subscription.expires_at >= NOW()
						)
				)

			UNION ALL

			SELECT
				'ACTIVE_SUBSCRIBER_WITHOUT_CONTACT'::text AS alert_type,
				'MEDIUM'::text AS severity,
				u.id AS reference_id,
				${userFieldsSql},
				'Активная подписка без контактов'::text AS title,
				concat('У пользователя активный тариф ', s.plan, ', но нет email или телефона для оплаты, рассылок и поддержки') AS message,
				COALESCE(s.expires_at, u.created_at) AS alert_at
			FROM "User" u
			JOIN subscriptions s ON s.user_id = u.id
			${userIdentityJoinsSql}
			WHERE u.status::text = 'ACTIVE'
				AND s.status::text = 'ACTIVE'
				AND (s.expires_at IS NULL OR s.expires_at >= NOW())
				AND email_identity.value IS NULL
				AND phone_identity.value IS NULL

			UNION ALL

			SELECT
				'ACTIVE_WIDGET_WITHOUT_ACCESS'::text AS alert_type,
				'HIGH'::text AS severity,
				w.id AS reference_id,
				${userFieldsSql},
				'Активный виджет без права доступа'::text AS title,
				concat(w.widget_label, ' "', w.name, '" активен, но у владельца нет активной подписки') AS message,
				w.updated_at AS alert_at
			FROM (${widgetsSql}) w
			JOIN "User" u ON u.id = w.user_id
			LEFT JOIN subscriptions s ON s.user_id = u.id
			${userIdentityJoinsSql}
			WHERE w.is_active = true
				AND (
					s.id IS NULL
					OR s.status::text <> 'ACTIVE'
					OR (s.expires_at IS NOT NULL AND s.expires_at < NOW())
				)

			UNION ALL

			SELECT
				'ACTIVE_WIDGET_WITHOUT_DOMAIN'::text AS alert_type,
				'MEDIUM'::text AS severity,
				w.id AS reference_id,
				${userFieldsSql},
				'Активный виджет без домена установки'::text AS title,
				concat(w.widget_label, ' "', w.name, '" активен, но домен установки не задан') AS message,
				w.updated_at AS alert_at
			FROM (${widgetsSql}) w
			JOIN "User" u ON u.id = w.user_id
			${userIdentityJoinsSql}
			WHERE w.is_active = true
				AND btrim(w.install_domain) = ''

			UNION ALL

			SELECT
				'WIDGET_DOMAIN_CONFLICT'::text AS alert_type,
				'HIGH'::text AS severity,
				w.id AS reference_id,
				${userFieldsSql},
				'Домен виджета занят у разных пользователей'::text AS title,
				concat('Домен ', w.install_domain, ' используется активными виджетами разных пользователей') AS message,
				w.updated_at AS alert_at
			FROM (${widgetsSql}) w
			JOIN (
				SELECT lower(btrim(domain_widgets.install_domain)) AS install_domain
				FROM (${widgetsSql}) domain_widgets
				WHERE domain_widgets.is_active = true
					AND btrim(domain_widgets.install_domain) <> ''
				GROUP BY lower(btrim(domain_widgets.install_domain))
				HAVING COUNT(DISTINCT domain_widgets.user_id) > 1
			) domain_conflicts
				ON lower(btrim(w.install_domain)) = domain_conflicts.install_domain
			JOIN "User" u ON u.id = w.user_id
			${userIdentityJoinsSql}
			WHERE w.is_active = true

			UNION ALL

			SELECT
				'WIDGET_INVALID_DOMAIN'::text AS alert_type,
				'MEDIUM'::text AS severity,
				w.id AS reference_id,
				${userFieldsSql},
				'Некорректный домен виджета'::text AS title,
				concat('У ', w.widget_label, ' "', w.name, '" сохранён домен, который не похож на нормализованное значение: ', w.install_domain) AS message,
				w.updated_at AS alert_at
			FROM (${widgetsSql}) w
			JOIN "User" u ON u.id = w.user_id
			${userIdentityJoinsSql}
			WHERE w.is_active = true
				AND btrim(w.install_domain) <> ''
				AND (
					w.install_domain <> lower(w.install_domain)
					OR w.install_domain LIKE '% %'
					OR w.install_domain LIKE '%/%'
					OR w.install_domain LIKE '%@%'
				)

			UNION ALL

			SELECT
				'AFFILIATE_REWARD_STALE'::text AS alert_type,
				'MEDIUM'::text AS severity,
				ar.id AS reference_id,
				${userFieldsSql},
				'Партнёрская выплата ждёт обработки'::text AS title,
				concat('Кэшбек ', COALESCE(ar.cashback_amount, 0), ' ₽ доступен с ', to_char(ar.available_at, 'DD.MM.YYYY HH24:MI')) AS message,
				ar.available_at AS alert_at
			FROM affiliate_referrals ar
			JOIN "User" u ON u.id = ar.referrer_id
			${userIdentityJoinsSql}
			WHERE ar.status::text = 'REWARD_PENDING'
				AND ar.available_at IS NOT NULL
				AND ar.available_at <= NOW() - INTERVAL '3 days'

			UNION ALL

			SELECT
				'AFFILIATE_REWARD_PAYMENT_CANCELLED'::text AS alert_type,
				'HIGH'::text AS severity,
				ar.id AS reference_id,
				${userFieldsSql},
				'Кэшбек привязан к отменённому платежу'::text AS title,
				concat('Реферальное начисление связано с отменённым платежом ', p.yookassa_id) AS message,
				COALESCE(ar.cancelled_at, ar.updated_at) AS alert_at
			FROM affiliate_referrals ar
			JOIN payments p ON p.id = ar.first_payment_id
			JOIN "User" u ON u.id = ar.referrer_id
			${userIdentityJoinsSql}
			WHERE p.status::text = 'CANCELLED'
				AND ar.status::text IN ('REWARD_PENDING', 'PAID')

			${integrationAlertsUnionSql}
		`;
	}

	private getWidgetsSql() {
		return Prisma.sql`
			SELECT
				'WHEEL'::text AS widget_type,
				'Колесо'::text AS widget_label,
				id,
				user_id,
				name,
				public_key,
				is_active,
				install_domain,
				created_at,
				updated_at
			FROM widgets

			UNION ALL

			SELECT
				'QUIZ'::text AS widget_type,
				'Квиз'::text AS widget_label,
				id,
				user_id,
				name,
				public_key,
				is_active,
				install_domain,
				created_at,
				updated_at
			FROM quizzes

			UNION ALL

			SELECT
				'CALLBACK'::text AS widget_type,
				'Обратный звонок'::text AS widget_label,
				id,
				user_id,
				name,
				public_key,
				is_active,
				install_domain,
				created_at,
				updated_at
			FROM callbacks

			UNION ALL

			SELECT
				'TIMER'::text AS widget_type,
				'Таймер'::text AS widget_label,
				id,
				user_id,
				name,
				public_key,
				is_active,
				install_domain,
				created_at,
				updated_at
			FROM countdown_timers

			UNION ALL

			SELECT
				'STOP_OFFER'::text AS widget_type,
				'Стоп-оффер'::text AS widget_label,
				id,
				user_id,
				name,
				public_key,
				is_active,
				install_domain,
				created_at,
				updated_at
			FROM stop_offers

			UNION ALL

			SELECT
				'ONLINE_CONSULTANT'::text AS widget_type,
				'Онлайн-консультант'::text AS widget_label,
				id,
				user_id,
				name,
				public_key,
				is_active,
				install_domain,
				created_at,
				updated_at
			FROM online_consultants
		`;
	}

	private async getIntegrationAlertsSql() {
		const health = await this.healthService.getAdminHealth();
		const checks = health.checks.filter(
			check => check.status === 'warning' || check.status === 'down'
		);

		if (!checks.length) {
			return null;
		}

		const now = new Date();
		const rows = checks.map(check => {
			const severity: AdminAlertSeverity =
				check.status === 'down' ? 'HIGH' : 'MEDIUM';
			const message = check.latencyMs
				? `${check.message}. Время ответа: ${check.latencyMs} мс`
				: check.message;

			return Prisma.sql`
				SELECT
					'INTEGRATION_PROBLEM'::text AS alert_type,
					${severity}::text AS severity,
					${check.id}::text AS reference_id,
					NULL::text AS target_user_id,
					NULL::text AS target_user_name,
					NULL::text AS target_user_email,
					NULL::text AS target_user_phone,
					${`Интеграция требует внимания: ${check.title}`}::text AS title,
					${message}::text AS message,
					${now}::timestamp AS alert_at
			`;
		});

		return Prisma.join(rows, ' UNION ALL ');
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
					target_user_phone,
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
			'USER_WITHOUT_CONTACT',
			'ACTIVE_SUBSCRIBER_WITHOUT_CONTACT',
			'SUCCEEDED_PAYMENT_WITHOUT_ACCESS',
			'MULTIPLE_PENDING_PAYMENTS',
			'ACTIVE_WIDGET_WITHOUT_ACCESS',
			'ACTIVE_WIDGET_WITHOUT_DOMAIN',
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
						phone: item.target_user_phone
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
