import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { EntitlementPlan } from '@prisma/widgets-client';
import type { Request } from 'express';
import { WidgetsDomainRepository } from '../domain/widgets-domain.repository';
import {
	asJsonObject,
	WidgetEntity,
	WidgetType
} from '../domain/widgets-domain.types';
import {
	getRequestDomain,
	isDomainAllowed
} from '../domain/widgets-domain.util';
import { WidgetsQuotaService } from '../quota/widgets-quota.service';
import type { RecordWidgetRuntimeEventDto } from '../http/widgets.dto';

const utcDay = (date: Date) =>
	new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
	);
const addDays = (date: Date, days: number) =>
	new Date(date.getTime() + days * 86_400_000);
const key = (date: Date) => date.toISOString().slice(0, 10);
const percentage = (value: number, total: number) =>
	total > 0 ? Math.round((value / total) * 1000) / 10 : null;

@Injectable()
export class WidgetsTelemetryService {
	constructor(
		private readonly repository: WidgetsDomainRepository,
		private readonly quota: WidgetsQuotaService
	) {}

	async record(
		type: WidgetType,
		publicKey: string,
		dto: RecordWidgetRuntimeEventDto,
		request: Request
	): Promise<void> {
		if (dto.event !== 'STEP' && dto.stepKey !== undefined)
			throw new BadRequestException(
				'stepKey допустим только для события STEP'
			);
		if (
			dto.event === 'STEP' &&
			![WidgetType.QUIZ, WidgetType.CALCULATOR].includes(type)
		) {
			throw new BadRequestException(
				'Шаги доступны только для квиза и калькулятора'
			);
		}
		const now = new Date();
		await this.repository.client().$transaction(async transaction => {
			await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`widgets-runtime:${type}:${publicKey}`}, 0))`;
			const widget = await this.repository.findByPublicKey(
				type,
				publicKey,
				transaction
			);
			if (
				!widget ||
				!widget.isActive ||
				!widget.publishedAt ||
				widget.publishedVersion !== dto.publishedVersion ||
				!isDomainAllowed(widget.installDomain, getRequestDomain(request))
			)
				return;
			if (
				dto.event === 'STEP' &&
				!this.steps(type, widget.config).some(
					step => step.key === dto.stepKey
				)
			) {
				throw new BadRequestException('Некорректный шаг виджета');
			}
			const current = await transaction.widgetRuntimePresence.findUnique({
				where: {
					widgetType_widgetId: { widgetType: type, widgetId: widget.id }
				},
				select: { publishedVersion: true }
			});
			await transaction.widgetRuntimePresence.upsert({
				where: {
					widgetType_widgetId: { widgetType: type, widgetId: widget.id }
				},
				create: {
					widgetType: type,
					widgetId: widget.id,
					installDomain: widget.installDomain,
					runtimeVersion: dto.runtimeVersion.trim(),
					publishedVersion: widget.publishedVersion,
					firstSeenAt: now,
					lastSeenAt: now
				},
				update: {
					installDomain: widget.installDomain,
					runtimeVersion: dto.runtimeVersion.trim(),
					publishedVersion: widget.publishedVersion,
					...(current?.publishedVersion !== widget.publishedVersion && {
						firstSeenAt: now
					}),
					lastSeenAt: now
				}
			});
			const date = utcDay(now);
			if (dto.event === 'STEP') {
				await transaction.widgetRuntimeDailyStepMetric.upsert({
					where: {
						widgetType_widgetId_publishedVersion_date_stepKey: {
							widgetType: type,
							widgetId: widget.id,
							publishedVersion: widget.publishedVersion,
							date,
							stepKey: dto.stepKey as string
						}
					},
					create: {
						widgetType: type,
						widgetId: widget.id,
						publishedVersion: widget.publishedVersion,
						date,
						stepKey: dto.stepKey as string,
						count: 1
					},
					update: { count: { increment: 1 } }
				});
				return;
			}
			const create = {
				widgetType: type,
				widgetId: widget.id,
				publishedVersion: widget.publishedVersion,
				date,
				impressions: dto.event === 'IMPRESSION' ? 1 : 0,
				opens: dto.event === 'OPEN' ? 1 : 0,
				starts: dto.event === 'START' ? 1 : 0,
				completions: dto.event === 'COMPLETE' ? 1 : 0
			};
			const update =
				dto.event === 'IMPRESSION'
					? { impressions: { increment: 1 } }
					: dto.event === 'OPEN'
						? { opens: { increment: 1 } }
						: dto.event === 'START'
							? { starts: { increment: 1 } }
							: { completions: { increment: 1 } };
			await transaction.widgetRuntimeDailyMetric.upsert({
				where: {
					widgetType_widgetId_publishedVersion_date: {
						widgetType: type,
						widgetId: widget.id,
						publishedVersion: widget.publishedVersion,
						date
					}
				},
				create,
				update
			});
		});
	}

	async status(userId: string, type: WidgetType, id: string) {
		const widget = await this.owned(userId, type, id);
		const presence = await this.repository
			.client()
			.widgetRuntimePresence.findUnique({
				where: { widgetType_widgetId: { widgetType: type, widgetId: id } }
			});
		const matches =
			Boolean(widget.installDomain) &&
			presence?.installDomain === widget.installDomain &&
			presence.publishedVersion === widget.publishedVersion;
		return {
			serverTime: new Date().toISOString(),
			installation: {
				state: !widget.installDomain
					? 'DOMAIN_REQUIRED'
					: matches
						? 'SIGNAL_RECEIVED'
						: 'NOT_SEEN',
				domain: widget.installDomain,
				firstSeenAt: matches
					? presence?.firstSeenAt.toISOString() || null
					: null,
				lastSeenAt: matches
					? presence?.lastSeenAt.toISOString() || null
					: null,
				runtimeVersion: matches ? presence?.runtimeVersion || null : null
			}
		};
	}

	async analytics(
		userId: string,
		type: WidgetType,
		id: string,
		requestedDays: number
	) {
		const widget = await this.owned(userId, type, id);
		const snapshot = await this.quota.snapshot(userId);
		if (snapshot.entitlement.plan !== EntitlementPlan.HARD)
			throw new ForbiddenException(
				'Аналитика виджетов доступна только на активном тарифе Hard'
			);
		const days = Number.isFinite(requestedDays)
			? Math.min(90, Math.max(7, Math.trunc(requestedDays)))
			: 30;
		const today = utcDay(new Date());
		const from = addDays(today, -(days - 1));
		const until = addDays(today, 1);
		const definitions = this.steps(type, widget.config);
		const [presence, metrics, stepMetrics] = await Promise.all([
			this.repository.client().widgetRuntimePresence.findUnique({
				where: {
					widgetType_widgetId: { widgetType: type, widgetId: id }
				}
			}),
			this.repository.client().widgetRuntimeDailyMetric.findMany({
				where: {
					widgetType: type,
					widgetId: id,
					publishedVersion: widget.publishedVersion,
					date: { gte: from, lt: until }
				},
				orderBy: { date: 'asc' }
			}),
			definitions.length
				? this.repository.client().widgetRuntimeDailyStepMetric.findMany({
						where: {
							widgetType: type,
							widgetId: id,
							publishedVersion: widget.publishedVersion,
							date: { gte: from, lt: until },
							stepKey: { in: definitions.map(item => item.key) }
						},
						select: { stepKey: true, count: true }
					})
				: []
		]);
		const byDate = new Map(metrics.map(item => [key(item.date), item]));
		const daily = Array.from({ length: days }, (_, index) => {
			const date = key(addDays(from, index));
			const metric = byDate.get(date);
			return {
				date,
				impressions: metric?.impressions || 0,
				opens: metric?.opens || 0,
				starts: metric?.starts || 0,
				submits: metric?.completions || 0
			};
		});
		const totals = daily.reduce(
			(sum, item) => ({
				impressions: sum.impressions + item.impressions,
				opens: sum.opens + item.opens,
				starts: sum.starts + item.starts,
				submits: sum.submits + item.submits
			}),
			{ impressions: 0, opens: 0, starts: 0, submits: 0 }
		);
		const counts = new Map<string, number>();
		for (const item of stepMetrics)
			counts.set(
				item.stepKey,
				(counts.get(item.stepKey) || 0) + item.count
			);
		let previous = totals.starts;
		const steps = definitions.map(item => {
			const count = counts.get(item.key) || 0;
			const result = {
				...item,
				count,
				conversionRate: percentage(
					count,
					type === WidgetType.CALCULATOR ? totals.starts : previous
				)
			};
			if (type === WidgetType.QUIZ) previous = count;
			return result;
		});
		const submitAvailable =
			type === WidgetType.CALLBACK ||
			asJsonObject(widget.config).dataType !== 'NONE';
		const tracking =
			presence?.publishedVersion === widget.publishedVersion
				? presence.firstSeenAt
				: null;
		return {
			from: key(from),
			to: key(today),
			days,
			trackingStartedAt: tracking?.toISOString() || null,
			isPartialPeriod: !tracking || tracking > from,
			submitAvailable,
			completionLabel: submitAvailable ? 'Заявки' : 'Завершения',
			stepRateBasis:
				type === WidgetType.CALCULATOR
					? 'START'
					: type === WidgetType.QUIZ
						? 'PREVIOUS_STEP'
						: null,
			totals,
			conversion: {
				openRate: percentage(totals.opens, totals.impressions),
				startRate: percentage(totals.starts, totals.opens),
				submitRate: percentage(totals.submits, totals.starts)
			},
			daily,
			steps
		};
	}

	private async owned(
		userId: string,
		type: WidgetType,
		id: string
	): Promise<WidgetEntity> {
		const widget = await this.repository.findById(type, id);
		if (!widget || widget.userId !== userId)
			throw new NotFoundException('Виджет не найден');
		return widget;
	}

	private steps(
		type: WidgetType,
		configValue: unknown
	): Array<{ key: string; label: string }> {
		if (![WidgetType.QUIZ, WidgetType.CALCULATOR].includes(type))
			return [];
		const config = asJsonObject(configValue);
		const source =
			type === WidgetType.QUIZ ? config.questions : config.fields;
		if (!Array.isArray(source)) return [];
		const prefix = type === WidgetType.QUIZ ? 'question' : 'field';
		const property = type === WidgetType.QUIZ ? 'text' : 'label';
		return source
			.slice(0, type === WidgetType.QUIZ ? 10 : 20)
			.map((value, index) => {
				const item = asJsonObject(value);
				const raw = item[property];
				return {
					key: `${prefix}:${index + 1}`,
					label:
						typeof raw === 'string' && raw.trim()
							? raw.trim().slice(0, 100)
							: `${type === WidgetType.QUIZ ? 'Вопрос' : 'Поле'} ${index + 1}`
				};
			});
	}
}
