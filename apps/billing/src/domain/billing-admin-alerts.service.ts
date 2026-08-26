import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/billing-client';
import { BillingPrismaService } from '../prisma/billing-prisma.service';

export const BILLING_ADMIN_ALERT_TYPES = [
	'EXPIRED_ACTIVE_SUBSCRIPTION',
	'SUBSCRIPTION_EXPIRES_SOON',
	'PENDING_PAYMENT',
	'SUCCEEDED_PAYMENT_WITHOUT_ACCESS',
	'MULTIPLE_PENDING_PAYMENTS',
	'AFFILIATE_REWARD_STALE',
	'AFFILIATE_REWARD_PAYMENT_CANCELLED'
] as const;

type BillingAdminAlertType = (typeof BILLING_ADMIN_ALERT_TYPES)[number];
type BillingAdminAlertSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

interface BillingAdminAlertRow {
	type: BillingAdminAlertType;
	severity: BillingAdminAlertSeverity;
	referenceId: string;
	ownerId: string;
	title: string;
	message: string;
	alertAt: Date;
}

@Injectable()
export class BillingAdminAlertsService {
	constructor(private readonly prisma: BillingPrismaService) {}

	async getAlerts() {
		const rows = await this.prisma.$queryRaw<BillingAdminAlertRow[]>(
			Prisma.sql`
				WITH billing_alerts AS (
					SELECT
						'EXPIRED_ACTIVE_SUBSCRIPTION'::text AS type,
						'HIGH'::text AS severity,
						s.id AS "referenceId",
						s.user_id AS "ownerId",
						'Истёкшая подписка ещё активна'::text AS title,
						concat('Подписка истекла ', to_char(s.expires_at, 'DD.MM.YYYY HH24:MI'), ', но статус всё ещё ACTIVE') AS message,
						s.expires_at AS "alertAt"
					FROM billing.subscriptions s
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
					FROM billing.subscriptions s
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
					FROM billing.payments p
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
					FROM billing.payments p
					LEFT JOIN billing.subscriptions s ON s.user_id = p.user_id
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
						FROM billing.payments
						WHERE status::text = 'PENDING'
						GROUP BY user_id
						HAVING COUNT(*) > 1
					) pending_payments

					UNION ALL

					SELECT
						'AFFILIATE_REWARD_STALE'::text,
						'MEDIUM'::text,
						ar.id,
						ar.referrer_id,
						'Партнёрская выплата ждёт обработки'::text,
						concat('Кэшбек ', COALESCE(ar.cashback_amount, 0), ' ₽ доступен с ', to_char(ar.available_at, 'DD.MM.YYYY HH24:MI')),
						ar.available_at
					FROM billing.affiliate_referrals ar
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
					FROM billing.affiliate_referrals ar
					JOIN billing.payments p ON p.id = ar.first_payment_id
					WHERE p.status::text = 'CANCELLED'
						AND ar.status::text IN ('REWARD_PENDING', 'PAID')
				)
				SELECT
					type,
					severity,
					"referenceId",
					"ownerId",
					title,
					message,
					"alertAt"
				FROM billing_alerts
				ORDER BY
					CASE severity
						WHEN 'HIGH' THEN 1
						WHEN 'MEDIUM' THEN 2
						ELSE 3
					END,
					"alertAt" ASC,
					type ASC,
					"referenceId" ASC
			`
		);

		const items = rows.map(row => ({
			type: row.type,
			severity: row.severity,
			referenceId: row.referenceId,
			ownerId: row.ownerId,
			title: row.title,
			message: row.message,
			alertAt: row.alertAt.toISOString()
		}));
		const byType = Object.fromEntries(
			BILLING_ADMIN_ALERT_TYPES.map(type => [type, 0])
		) as Record<BillingAdminAlertType, number>;
		const bySeverity: Record<BillingAdminAlertSeverity, number> = {
			HIGH: 0,
			MEDIUM: 0,
			LOW: 0
		};
		for (const item of items) {
			byType[item.type] += 1;
			bySeverity[item.severity] += 1;
		}

		return {
			schemaVersion: 1 as const,
			total: items.length,
			counts: { byType, bySeverity },
			items
		};
	}
}
