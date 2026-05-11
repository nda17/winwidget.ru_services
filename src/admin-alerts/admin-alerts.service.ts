import { PrismaService } from '@/prisma.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type AdminAlertType =
	| 'SUBSCRIPTION_EXPIRES_SOON'
	| 'EXPIRED_ACTIVE_SUBSCRIPTION'
	| 'PENDING_PAYMENT'
	| 'USER_WITHOUT_CONTACT';

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
	constructor(private readonly prisma: PrismaService) {}

	async getAll(page = 1, limit = 20, filters: AdminAlertFilters = {}) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const baseSql = this.getBaseSql();
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

	private getBaseSql() {
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
		`;
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
			'USER_WITHOUT_CONTACT'
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
