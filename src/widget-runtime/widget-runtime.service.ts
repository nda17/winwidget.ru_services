import { PrismaService } from '@/prisma.service';
import { SubscriptionService } from '@/subscription/subscription.service';
import {
	RecordWidgetRuntimeEventDto,
	WidgetRuntimeEvent
} from '@/widget-runtime/widget-runtime.dto';
import {
	getWidgetRequestDomain,
	isWidgetDomainAllowed
} from '@/widget-domain/widget-domain.util';
import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { Plan, Prisma, SubscriptionStatus } from '@prisma/client';
import { Request } from 'express';

const MIN_ANALYTICS_DAYS = 7;
const MAX_ANALYTICS_DAYS = 90;

type RuntimeWidgetType =
	| 'WHEEL'
	| 'QUIZ'
	| 'CALLBACK'
	| 'TIMER'
	| 'STOP_OFFER'
	| 'ONLINE_CONSULTANT'
	| 'CALCULATOR';

interface RuntimeWidgetRecord {
	id: string;
	userId: string;
	publicKey: string;
	isActive: boolean;
	installDomain: string;
	config: unknown;
	publishedVersion: number;
	publishedAt: Date | null;
}

interface SubmissionRow {
	date: Date;
	count: bigint;
}

type RuntimePersistenceClient = Pick<
	Prisma.TransactionClient,
	| 'widget'
	| 'quiz'
	| 'callback'
	| 'countdownTimer'
	| 'stopOffer'
	| 'onlineConsultant'
	| 'calculator'
	| 'widgetRuntimePresence'
	| 'widgetRuntimeDailyMetric'
	| '$queryRaw'
>;

const normalizeRuntimeType = (value: string): RuntimeWidgetType => {
	switch (value.trim().toLowerCase()) {
		case 'wheel':
			return 'WHEEL';
		case 'quiz':
			return 'QUIZ';
		case 'callback':
			return 'CALLBACK';
		case 'timer':
		case 'countdown-timer':
			return 'TIMER';
		case 'stop-offer':
			return 'STOP_OFFER';
		case 'online-consultant':
			return 'ONLINE_CONSULTANT';
		case 'calculator':
			return 'CALCULATOR';
		default:
			throw new BadRequestException('Неизвестный тип виджета');
	}
};

const startOfUtcDay = (date: Date) =>
	new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
	);

const addUtcDays = (date: Date, days: number) =>
	new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const dateKey = (date: Date) => date.toISOString().slice(0, 10);

const percentage = (value: number, total: number) =>
	total > 0 ? Math.round((value / total) * 1000) / 10 : null;

@Injectable()
export class WidgetRuntimeService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly subscriptionService: SubscriptionService
	) {}

	async recordEvent(
		typeValue: string,
		publicKey: string,
		dto: RecordWidgetRuntimeEventDto,
		request: Request
	): Promise<void> {
		const type = normalizeRuntimeType(typeValue);
		const requestDomain = getWidgetRequestDomain(request);
		const now = new Date();
		const date = startOfUtcDay(now);
		const runtimeVersion = dto.runtimeVersion.trim().slice(0, 32);
		if (!runtimeVersion) return;

		await this.prisma.$transaction(async transaction => {
			const widgetId = await this.lockWidgetByPublicKey(
				transaction,
				type,
				publicKey
			);
			if (!widgetId) return;

			const widget = await this.findById(type, widgetId, transaction);
			if (
				!widget ||
				!widget.isActive ||
				!widget.publishedAt ||
				widget.publishedVersion < 1 ||
				!isWidgetDomainAllowed(widget.installDomain, requestDomain)
			) {
				return;
			}

			await transaction.widgetRuntimePresence.upsert({
				where: {
					widgetType_widgetId: {
						widgetType: type,
						widgetId: widget.id
					}
				},
				create: {
					widgetType: type,
					widgetId: widget.id,
					installDomain: widget.installDomain,
					runtimeVersion,
					firstSeenAt: now,
					lastSeenAt: now
				},
				update: {
					installDomain: widget.installDomain,
					runtimeVersion,
					lastSeenAt: now
				}
			});
			await this.incrementMetric(
				transaction,
				type,
				widget.id,
				date,
				dto.event
			);
		});
	}

	async getStatus(userId: string, typeValue: string, id: string) {
		const type = normalizeRuntimeType(typeValue);
		const widget = await this.getOwnedWidget(type, id, userId);
		const presence = await this.prisma.widgetRuntimePresence.findUnique({
			where: {
				widgetType_widgetId: {
					widgetType: type,
					widgetId: widget.id
				}
			}
		});
		const matchesPublishedDomain =
			Boolean(widget.installDomain) &&
			presence?.installDomain === widget.installDomain;

		return {
			serverTime: new Date().toISOString(),
			installation: {
				state: !widget.installDomain
					? 'DOMAIN_REQUIRED'
					: matchesPublishedDomain
						? 'SIGNAL_RECEIVED'
						: 'NOT_SEEN',
				domain: widget.installDomain,
				firstSeenAt: matchesPublishedDomain
					? (presence?.firstSeenAt.toISOString() ?? null)
					: null,
				lastSeenAt: matchesPublishedDomain
					? (presence?.lastSeenAt.toISOString() ?? null)
					: null,
				runtimeVersion: matchesPublishedDomain
					? (presence?.runtimeVersion ?? null)
					: null
			}
		};
	}

	async getAnalytics(
		userId: string,
		typeValue: string,
		id: string,
		requestedDays: number
	) {
		const type = normalizeRuntimeType(typeValue);
		const widget = await this.getOwnedWidget(type, id, userId);
		await this.assertCanUseAnalytics(userId);
		const days = Number.isFinite(requestedDays)
			? Math.min(
					MAX_ANALYTICS_DAYS,
					Math.max(MIN_ANALYTICS_DAYS, Math.trunc(requestedDays))
				)
			: 30;
		const today = startOfUtcDay(new Date());
		const fromDate = addUtcDays(today, -(days - 1));
		const untilDate = addUtcDays(today, 1);
		const [presence, metrics] = await Promise.all([
			this.prisma.widgetRuntimePresence.findUnique({
				where: {
					widgetType_widgetId: {
						widgetType: type,
						widgetId: widget.id
					}
				}
			}),
			this.prisma.widgetRuntimeDailyMetric.findMany({
				where: {
					widgetType: type,
					widgetId: widget.id,
					date: {
						gte: fromDate,
						lt: untilDate
					}
				},
				orderBy: { date: 'asc' }
			})
		]);
		const submitAvailable = this.isSubmitAvailable(type, widget.config);
		const trackingStartedAt = presence?.firstSeenAt ?? null;
		const leadFromDate =
			trackingStartedAt && trackingStartedAt > fromDate
				? trackingStartedAt
				: fromDate;
		const submissionRows = trackingStartedAt
			? await this.getSubmissionRows(
					type,
					widget.id,
					leadFromDate,
					untilDate
				)
			: [];
		const metricsByDate = new Map(
			metrics.map(metric => [dateKey(metric.date), metric])
		);
		const submissionsByDate = new Map(
			submissionRows.map(row => [dateKey(row.date), Number(row.count)])
		);
		const daily = Array.from({ length: days }, (_, index) => {
			const date = addUtcDays(fromDate, index);
			const key = dateKey(date);
			const metric = metricsByDate.get(key);

			return {
				date: key,
				impressions: metric?.impressions ?? 0,
				opens: metric?.opens ?? 0,
				starts: metric?.starts ?? 0,
				submits: submissionsByDate.get(key) ?? 0
			};
		});
		const totals = daily.reduce(
			(result, item) => ({
				impressions: result.impressions + item.impressions,
				opens: result.opens + item.opens,
				starts: result.starts + item.starts,
				submits: result.submits + item.submits
			}),
			{
				impressions: 0,
				opens: 0,
				starts: 0,
				submits: 0
			}
		);

		return {
			from: dateKey(fromDate),
			to: dateKey(today),
			days,
			trackingStartedAt: trackingStartedAt?.toISOString() ?? null,
			isPartialPeriod: !trackingStartedAt || trackingStartedAt > fromDate,
			submitAvailable,
			totals,
			conversion: {
				openRate: percentage(totals.opens, totals.impressions),
				startRate: percentage(totals.starts, totals.opens),
				submitRate: percentage(totals.submits, totals.starts)
			},
			daily
		};
	}

	private incrementMetric(
		client: RuntimePersistenceClient,
		type: RuntimeWidgetType,
		widgetId: string,
		date: Date,
		event: WidgetRuntimeEvent
	) {
		const create = {
			widgetType: type,
			widgetId,
			date,
			impressions: event === 'IMPRESSION' ? 1 : 0,
			opens: event === 'OPEN' ? 1 : 0,
			starts: event === 'START' ? 1 : 0
		};
		const update =
			event === 'IMPRESSION'
				? { impressions: { increment: 1 } }
				: event === 'OPEN'
					? { opens: { increment: 1 } }
					: { starts: { increment: 1 } };

		return client.widgetRuntimeDailyMetric.upsert({
			where: {
				widgetType_widgetId_date: {
					widgetType: type,
					widgetId,
					date
				}
			},
			create,
			update
		});
	}

	private async getOwnedWidget(
		type: RuntimeWidgetType,
		id: string,
		userId: string
	): Promise<RuntimeWidgetRecord> {
		const widget = await this.findById(type, id);
		if (!widget || widget.userId !== userId) {
			throw new NotFoundException('Виджет не найден');
		}
		return widget;
	}

	private findById(
		type: RuntimeWidgetType,
		id: string,
		client: RuntimePersistenceClient = this.prisma
	): Promise<RuntimeWidgetRecord | null> {
		const args = {
			where: { id },
			select: this.runtimeWidgetSelect
		};
		switch (type) {
			case 'WHEEL':
				return client.widget.findUnique(args);
			case 'QUIZ':
				return client.quiz.findUnique(args);
			case 'CALLBACK':
				return client.callback.findUnique(args);
			case 'TIMER':
				return client.countdownTimer.findUnique(args);
			case 'STOP_OFFER':
				return client.stopOffer.findUnique(args);
			case 'ONLINE_CONSULTANT':
				return client.onlineConsultant.findUnique(args);
			case 'CALCULATOR':
				return client.calculator.findUnique(args);
		}
	}

	private async lockWidgetByPublicKey(
		client: RuntimePersistenceClient,
		type: RuntimeWidgetType,
		publicKey: string
	): Promise<string | null> {
		let rows: Array<{ id: string }>;

		switch (type) {
			case 'WHEEL':
				rows = await client.$queryRaw`
					SELECT "id"
					FROM "widgets"
					WHERE "public_key" = ${publicKey}
					FOR KEY SHARE
				`;
				break;
			case 'QUIZ':
				rows = await client.$queryRaw`
					SELECT "id"
					FROM "quizzes"
					WHERE "public_key" = ${publicKey}
					FOR KEY SHARE
				`;
				break;
			case 'CALLBACK':
				rows = await client.$queryRaw`
					SELECT "id"
					FROM "callbacks"
					WHERE "public_key" = ${publicKey}
					FOR KEY SHARE
				`;
				break;
			case 'TIMER':
				rows = await client.$queryRaw`
					SELECT "id"
					FROM "countdown_timers"
					WHERE "public_key" = ${publicKey}
					FOR KEY SHARE
				`;
				break;
			case 'STOP_OFFER':
				rows = await client.$queryRaw`
					SELECT "id"
					FROM "stop_offers"
					WHERE "public_key" = ${publicKey}
					FOR KEY SHARE
				`;
				break;
			case 'ONLINE_CONSULTANT':
				rows = await client.$queryRaw`
					SELECT "id"
					FROM "online_consultants"
					WHERE "public_key" = ${publicKey}
					FOR KEY SHARE
				`;
				break;
			case 'CALCULATOR':
				rows = await client.$queryRaw`
					SELECT "id"
					FROM "calculators"
					WHERE "public_key" = ${publicKey}
					FOR KEY SHARE
				`;
				break;
		}

		return rows[0]?.id ?? null;
	}

	private readonly runtimeWidgetSelect = {
		id: true,
		userId: true,
		publicKey: true,
		isActive: true,
		installDomain: true,
		config: true,
		publishedVersion: true,
		publishedAt: true
	} satisfies Prisma.WidgetSelect;

	private isSubmitAvailable(type: RuntimeWidgetType, config: unknown) {
		if (type === 'CALLBACK') return true;
		if (!config || typeof config !== 'object') return false;
		return (config as { dataType?: string }).dataType !== 'NONE';
	}

	private async assertCanUseAnalytics(userId: string) {
		const subscription =
			await this.subscriptionService.checkAndResetPeriod(userId);

		if (
			!subscription ||
			subscription.status !== SubscriptionStatus.ACTIVE ||
			subscription.plan !== Plan.HARD
		) {
			throw new ForbiddenException(
				'Аналитика виджетов доступна только на активном тарифе Hard'
			);
		}
	}

	private getSubmissionRows(
		type: RuntimeWidgetType,
		widgetId: string,
		fromDate: Date,
		untilDate: Date
	): Promise<SubmissionRow[]> {
		switch (type) {
			case 'WHEEL':
				return this.prisma.$queryRaw<SubmissionRow[]>`
					SELECT "created_at"::date AS "date", COUNT(*)::bigint AS "count"
					FROM "leads"
					WHERE "widget_id" = ${widgetId}
					  AND "created_at" >= ${fromDate}
					  AND "created_at" < ${untilDate}
					GROUP BY "created_at"::date
				`;
			case 'QUIZ':
				return this.prisma.$queryRaw<SubmissionRow[]>`
					SELECT "created_at"::date AS "date", COUNT(*)::bigint AS "count"
					FROM "quiz_leads"
					WHERE "quiz_id" = ${widgetId}
					  AND "created_at" >= ${fromDate}
					  AND "created_at" < ${untilDate}
					GROUP BY "created_at"::date
				`;
			case 'CALLBACK':
				return this.prisma.$queryRaw<SubmissionRow[]>`
					SELECT "created_at"::date AS "date", COUNT(*)::bigint AS "count"
					FROM "callback_leads"
					WHERE "callback_id" = ${widgetId}
					  AND "created_at" >= ${fromDate}
					  AND "created_at" < ${untilDate}
					GROUP BY "created_at"::date
				`;
			case 'TIMER':
				return this.prisma.$queryRaw<SubmissionRow[]>`
					SELECT "created_at"::date AS "date", COUNT(*)::bigint AS "count"
					FROM "countdown_timer_leads"
					WHERE "countdown_timer_id" = ${widgetId}
					  AND "created_at" >= ${fromDate}
					  AND "created_at" < ${untilDate}
					GROUP BY "created_at"::date
				`;
			case 'STOP_OFFER':
				return this.prisma.$queryRaw<SubmissionRow[]>`
					SELECT "created_at"::date AS "date", COUNT(*)::bigint AS "count"
					FROM "stop_offer_leads"
					WHERE "stop_offer_id" = ${widgetId}
					  AND "created_at" >= ${fromDate}
					  AND "created_at" < ${untilDate}
					GROUP BY "created_at"::date
				`;
			case 'ONLINE_CONSULTANT':
				return this.prisma.$queryRaw<SubmissionRow[]>`
					SELECT "created_at"::date AS "date", COUNT(*)::bigint AS "count"
					FROM "online_consultant_leads"
					WHERE "online_consultant_id" = ${widgetId}
					  AND "created_at" >= ${fromDate}
					  AND "created_at" < ${untilDate}
					GROUP BY "created_at"::date
				`;
			case 'CALCULATOR':
				return this.prisma.$queryRaw<SubmissionRow[]>`
					SELECT "created_at"::date AS "date", COUNT(*)::bigint AS "count"
					FROM "calculator_leads"
					WHERE "calculator_id" = ${widgetId}
					  AND "created_at" >= ${fromDate}
					  AND "created_at" < ${untilDate}
					GROUP BY "created_at"::date
				`;
		}
	}
}
