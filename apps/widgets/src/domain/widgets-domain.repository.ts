import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/widgets-client';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import { WidgetEntity, WidgetType } from './widgets-domain.types';
import type {
	DuplicateLeadLookup,
	WidgetStatsAggregate
} from './widgets-type-adapter';

export type WidgetsDomainClient =
	| WidgetsPrismaService
	| Prisma.TransactionClient;

export interface WidgetWithLeadCount extends WidgetEntity {
	_count: { leads: number };
}

export interface WidgetLeadRecord {
	id: string;
	createdAt: Date;
	contact?: string | null;
	phone?: string | null;
	email?: string | null;
	bonus?: string | null;
	result?: string | null;
	timeSlot?: string | null;
	timezone?: string | null;
	actionLabel?: string | null;
	actionValue?: string | null;
	calculatedPrice?: Prisma.Decimal | null;
	currency?: string | null;
	answers?: Prisma.JsonValue;
	url?: string | null;
	ip?: string | null;
}

export interface CreateLeadData {
	contact?: string;
	phone?: string;
	email?: string;
	bonus?: string;
	result?: string;
	timeSlot?: string;
	timezone?: string;
	actionLabel?: string;
	actionValue?: string;
	calculatedPrice?: Prisma.Decimal;
	currency?: string;
	answers?: Prisma.InputJsonValue;
	url?: string;
	ip?: string;
	resetToken?: string;
}

@Injectable()
export class WidgetsDomainRepository {
	constructor(private readonly prisma: WidgetsPrismaService) {}

	client(): WidgetsPrismaService {
		return this.prisma;
	}

	async findManyForOwner(
		type: WidgetType,
		userId: string,
		client: WidgetsDomainClient = this.prisma
	): Promise<WidgetWithLeadCount[]> {
		const args = {
			where: { userId },
			orderBy: { createdAt: 'desc' as const },
			include: { _count: { select: { leads: true } } }
		};
		switch (type) {
			case WidgetType.WHEEL:
				return client.widget.findMany(args) as Promise<
					WidgetWithLeadCount[]
				>;
			case WidgetType.QUIZ:
				return client.quiz.findMany(args) as Promise<
					WidgetWithLeadCount[]
				>;
			case WidgetType.CALLBACK:
				return client.callback.findMany(args) as Promise<
					WidgetWithLeadCount[]
				>;
			case WidgetType.TIMER:
				return client.countdownTimer.findMany(args) as Promise<
					WidgetWithLeadCount[]
				>;
			case WidgetType.STOP_OFFER:
				return client.stopOffer.findMany(args) as Promise<
					WidgetWithLeadCount[]
				>;
			case WidgetType.ONLINE_CONSULTANT:
				return client.onlineConsultant.findMany(args) as Promise<
					WidgetWithLeadCount[]
				>;
			case WidgetType.CALCULATOR:
				return client.calculator.findMany(args) as Promise<
					WidgetWithLeadCount[]
				>;
		}
	}

	async findById(
		type: WidgetType,
		id: string,
		client: WidgetsDomainClient = this.prisma
	): Promise<WidgetEntity | null> {
		const args = { where: { id } };
		switch (type) {
			case WidgetType.WHEEL:
				return client.widget.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.QUIZ:
				return client.quiz.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.CALLBACK:
				return client.callback.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.TIMER:
				return client.countdownTimer.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.STOP_OFFER:
				return client.stopOffer.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.ONLINE_CONSULTANT:
				return client.onlineConsultant.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.CALCULATOR:
				return client.calculator.findUnique(
					args
				) as Promise<WidgetEntity | null>;
		}
	}

	async findByPublicKey(
		type: WidgetType,
		publicKey: string,
		client: WidgetsDomainClient = this.prisma
	): Promise<WidgetEntity | null> {
		const args = { where: { publicKey } };
		switch (type) {
			case WidgetType.WHEEL:
				return client.widget.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.QUIZ:
				return client.quiz.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.CALLBACK:
				return client.callback.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.TIMER:
				return client.countdownTimer.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.STOP_OFFER:
				return client.stopOffer.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.ONLINE_CONSULTANT:
				return client.onlineConsultant.findUnique(
					args
				) as Promise<WidgetEntity | null>;
			case WidgetType.CALCULATOR:
				return client.calculator.findUnique(
					args
				) as Promise<WidgetEntity | null>;
		}
	}

	async create(
		type: WidgetType,
		client: Prisma.TransactionClient,
		data: {
			userId: string;
			publicKey: string;
			name: string;
			isActive?: boolean;
			config: Prisma.InputJsonObject;
			draftConfig: Prisma.InputJsonObject;
			draftInstallDomain: string;
			draftRevision: number;
		}
	): Promise<WidgetEntity> {
		switch (type) {
			case WidgetType.WHEEL:
				return client.widget.create({ data }) as Promise<WidgetEntity>;
			case WidgetType.QUIZ:
				return client.quiz.create({ data }) as Promise<WidgetEntity>;
			case WidgetType.CALLBACK:
				return client.callback.create({ data }) as Promise<WidgetEntity>;
			case WidgetType.TIMER:
				return client.countdownTimer.create({
					data
				}) as Promise<WidgetEntity>;
			case WidgetType.STOP_OFFER:
				return client.stopOffer.create({ data }) as Promise<WidgetEntity>;
			case WidgetType.ONLINE_CONSULTANT:
				return client.onlineConsultant.create({
					data
				}) as Promise<WidgetEntity>;
			case WidgetType.CALCULATOR:
				return client.calculator.create({ data }) as Promise<WidgetEntity>;
		}
	}

	async updateMany(
		type: WidgetType,
		client: Prisma.TransactionClient,
		where: Record<string, unknown>,
		data: Record<string, unknown>
	): Promise<number> {
		let result: { count: number };
		switch (type) {
			case WidgetType.WHEEL:
				result = await client.widget.updateMany({
					where,
					data
				} as Prisma.WidgetUpdateManyArgs);
				break;
			case WidgetType.QUIZ:
				result = await client.quiz.updateMany({
					where,
					data
				} as Prisma.QuizUpdateManyArgs);
				break;
			case WidgetType.CALLBACK:
				result = await client.callback.updateMany({
					where,
					data
				} as Prisma.CallbackUpdateManyArgs);
				break;
			case WidgetType.TIMER:
				result = await client.countdownTimer.updateMany({
					where,
					data
				} as Prisma.CountdownTimerUpdateManyArgs);
				break;
			case WidgetType.STOP_OFFER:
				result = await client.stopOffer.updateMany({
					where,
					data
				} as Prisma.StopOfferUpdateManyArgs);
				break;
			case WidgetType.ONLINE_CONSULTANT:
				result = await client.onlineConsultant.updateMany({
					where,
					data
				} as Prisma.OnlineConsultantUpdateManyArgs);
				break;
			case WidgetType.CALCULATOR:
				result = await client.calculator.updateMany({
					where,
					data
				} as Prisma.CalculatorUpdateManyArgs);
				break;
		}
		return result.count;
	}

	async delete(
		type: WidgetType,
		id: string,
		client: Prisma.TransactionClient
	): Promise<WidgetEntity> {
		const args = { where: { id } };
		switch (type) {
			case WidgetType.WHEEL:
				return client.widget.delete(args) as Promise<WidgetEntity>;
			case WidgetType.QUIZ:
				return client.quiz.delete(args) as Promise<WidgetEntity>;
			case WidgetType.CALLBACK:
				return client.callback.delete(args) as Promise<WidgetEntity>;
			case WidgetType.TIMER:
				return client.countdownTimer.delete(args) as Promise<WidgetEntity>;
			case WidgetType.STOP_OFFER:
				return client.stopOffer.delete(args) as Promise<WidgetEntity>;
			case WidgetType.ONLINE_CONSULTANT:
				return client.onlineConsultant.delete(
					args
				) as Promise<WidgetEntity>;
			case WidgetType.CALCULATOR:
				return client.calculator.delete(args) as Promise<WidgetEntity>;
		}
	}

	async createLead(
		type: WidgetType,
		widgetId: string,
		data: CreateLeadData,
		client: Prisma.TransactionClient
	): Promise<WidgetLeadRecord> {
		switch (type) {
			case WidgetType.WHEEL:
				return client.lead.create({
					data: {
						widgetId,
						contact: data.contact || data.phone || data.email || 'unknown',
						phone: data.phone,
						email: data.email,
						bonus: data.bonus,
						url: data.url,
						ip: data.ip,
						spinResetToken: data.resetToken || ''
					}
				}) as Promise<WidgetLeadRecord>;
			case WidgetType.QUIZ:
				return client.quizLead.create({
					data: {
						quizId: widgetId,
						contact: data.contact || data.phone || data.email || 'unknown',
						phone: data.phone,
						email: data.email,
						answers: data.answers || [],
						result: data.result,
						url: data.url,
						ip: data.ip,
						quizResetToken: data.resetToken || ''
					}
				}) as Promise<WidgetLeadRecord>;
			case WidgetType.CALLBACK:
				return client.callbackLead.create({
					data: {
						callbackId: widgetId,
						phone: data.phone || '',
						timeSlot: data.timeSlot || '',
						timezone: data.timezone || '',
						url: data.url,
						ip: data.ip
					}
				}) as Promise<WidgetLeadRecord>;
			case WidgetType.TIMER:
				return client.countdownTimerLead.create({
					data: {
						countdownTimerId: widgetId,
						phone: data.phone,
						email: data.email,
						url: data.url,
						ip: data.ip,
						timerResetToken: data.resetToken || ''
					}
				}) as Promise<WidgetLeadRecord>;
			case WidgetType.STOP_OFFER:
				return client.stopOfferLead.create({
					data: {
						stopOfferId: widgetId,
						phone: data.phone,
						email: data.email,
						url: data.url,
						ip: data.ip,
						resetToken: data.resetToken || ''
					}
				}) as Promise<WidgetLeadRecord>;
			case WidgetType.ONLINE_CONSULTANT:
				return client.onlineConsultantLead.create({
					data: {
						onlineConsultantId: widgetId,
						phone: data.phone,
						email: data.email,
						actionLabel: data.actionLabel || '',
						actionValue: data.actionValue || '',
						url: data.url,
						ip: data.ip
					}
				}) as Promise<WidgetLeadRecord>;
			case WidgetType.CALCULATOR:
				return client.calculatorLead.create({
					data: {
						calculatorId: widgetId,
						contact: data.contact || data.phone || data.email || 'unknown',
						phone: data.phone,
						email: data.email,
						answers: data.answers || [],
						calculatedPrice: data.calculatedPrice || new Prisma.Decimal(0),
						currency: data.currency || 'RUB',
						url: data.url,
						ip: data.ip
					}
				}) as Promise<WidgetLeadRecord>;
		}
	}

	async findDuplicateLead(
		type: WidgetType,
		widgetId: string,
		lookup: DuplicateLeadLookup,
		client: WidgetsDomainClient
	): Promise<boolean> {
		const createdAt = lookup.since ? { gte: lookup.since } : undefined;
		switch (type) {
			case WidgetType.WHEEL:
				return Boolean(
					await client.lead.findFirst({
						where: {
							widgetId,
							spinResetToken: lookup.resetToken || '',
							...(createdAt && { createdAt }),
							OR: this.duplicateOr([
								lookup.contact ? { contact: lookup.contact } : null,
								lookup.phone ? { phone: lookup.phone } : null,
								lookup.email ? { email: lookup.email } : null,
								lookup.ip ? { ip: lookup.ip } : null
							]) as Prisma.LeadWhereInput[]
						},
						select: { id: true }
					})
				);
			case WidgetType.QUIZ:
				return Boolean(
					await client.quizLead.findFirst({
						where: {
							quizId: widgetId,
							quizResetToken: lookup.resetToken || '',
							...(createdAt && { createdAt }),
							OR: this.duplicateOr([
								lookup.contact ? { contact: lookup.contact } : null,
								lookup.phone ? { phone: lookup.phone } : null,
								lookup.email ? { email: lookup.email } : null,
								lookup.ip ? { ip: lookup.ip } : null
							]) as Prisma.QuizLeadWhereInput[]
						},
						select: { id: true }
					})
				);
			case WidgetType.CALLBACK:
				return Boolean(
					await client.callbackLead.findFirst({
						where: {
							callbackId: widgetId,
							...(createdAt && { createdAt }),
							OR: this.duplicateOr([
								lookup.phone ? { phone: lookup.phone } : null,
								lookup.ip ? { ip: lookup.ip } : null
							]) as Prisma.CallbackLeadWhereInput[]
						},
						select: { id: true }
					})
				);
			case WidgetType.TIMER:
				return Boolean(
					await client.countdownTimerLead.findFirst({
						where: {
							countdownTimerId: widgetId,
							timerResetToken: lookup.resetToken || '',
							...(createdAt && { createdAt }),
							OR: this.duplicateOr([
								lookup.phone ? { phone: lookup.phone } : null,
								lookup.email ? { email: lookup.email } : null,
								lookup.ip ? { ip: lookup.ip } : null
							]) as Prisma.CountdownTimerLeadWhereInput[]
						},
						select: { id: true }
					})
				);
			case WidgetType.STOP_OFFER:
				return Boolean(
					await client.stopOfferLead.findFirst({
						where: {
							stopOfferId: widgetId,
							resetToken: lookup.resetToken || '',
							...(createdAt && { createdAt }),
							OR: this.duplicateOr([
								lookup.phone ? { phone: lookup.phone } : null,
								lookup.email ? { email: lookup.email } : null,
								lookup.ip ? { ip: lookup.ip } : null
							]) as Prisma.StopOfferLeadWhereInput[]
						},
						select: { id: true }
					})
				);
			case WidgetType.ONLINE_CONSULTANT:
				return Boolean(
					await client.onlineConsultantLead.findFirst({
						where: {
							onlineConsultantId: widgetId,
							...(createdAt && { createdAt }),
							OR: this.duplicateOr([
								lookup.phone ? { phone: lookup.phone } : null,
								lookup.email ? { email: lookup.email } : null,
								lookup.ip ? { ip: lookup.ip } : null
							]) as Prisma.OnlineConsultantLeadWhereInput[]
						},
						select: { id: true }
					})
				);
			case WidgetType.CALCULATOR:
				return Boolean(
					await client.calculatorLead.findFirst({
						where: {
							calculatorId: widgetId,
							...(createdAt && { createdAt }),
							OR: this.duplicateOr([
								lookup.contact ? { contact: lookup.contact } : null,
								lookup.phone ? { phone: lookup.phone } : null,
								lookup.email ? { email: lookup.email } : null,
								lookup.ip ? { ip: lookup.ip } : null
							]) as Prisma.CalculatorLeadWhereInput[]
						},
						select: { id: true }
					})
				);
		}
	}

	private duplicateOr<T extends object>(conditions: Array<T | null>): T[] {
		const values = conditions.filter(
			(value): value is T => value !== null
		);
		// Every caller supplies at least one bounded public value. An empty OR in
		// Prisma is easy to misread and must never become a broad duplicate scan.
		return values.length ? values : [{ id: '__never__' } as T];
	}

	async listLeads(
		type: WidgetType,
		widgetId: string,
		page: number,
		limit: number
	): Promise<{ leads: WidgetLeadRecord[]; total: number }> {
		const args = {
			where: this.leadWhere(type, widgetId),
			orderBy: { createdAt: 'desc' as const },
			skip: (page - 1) * limit,
			take: limit
		};
		const [leads, total] = await this.prisma.$transaction([
			this.leadFindMany(type, args),
			this.leadCount(type, this.leadWhere(type, widgetId))
		]);
		return { leads: leads as WidgetLeadRecord[], total };
	}

	async allLeads(
		type: WidgetType,
		widgetId: string
	): Promise<WidgetLeadRecord[]> {
		return this.leadFindMany(type, {
			where: this.leadWhere(type, widgetId),
			orderBy: { createdAt: 'asc' }
		}) as Promise<WidgetLeadRecord[]>;
	}

	async allLeadsInTransaction(
		type: WidgetType,
		widgetId: string,
		client: Prisma.TransactionClient
	): Promise<WidgetLeadRecord[]> {
		const args = {
			where: this.leadWhere(type, widgetId),
			orderBy: { createdAt: 'asc' as const }
		};
		switch (type) {
			case WidgetType.WHEEL:
				return client.lead.findMany(args) as Promise<WidgetLeadRecord[]>;
			case WidgetType.QUIZ:
				return client.quizLead.findMany(args) as Promise<
					WidgetLeadRecord[]
				>;
			case WidgetType.CALLBACK:
				return client.callbackLead.findMany(args) as Promise<
					WidgetLeadRecord[]
				>;
			case WidgetType.TIMER:
				return client.countdownTimerLead.findMany(args) as Promise<
					WidgetLeadRecord[]
				>;
			case WidgetType.STOP_OFFER:
				return client.stopOfferLead.findMany(args) as Promise<
					WidgetLeadRecord[]
				>;
			case WidgetType.ONLINE_CONSULTANT:
				return client.onlineConsultantLead.findMany(args) as Promise<
					WidgetLeadRecord[]
				>;
			case WidgetType.CALCULATOR:
				return client.calculatorLead.findMany(args) as Promise<
					WidgetLeadRecord[]
				>;
		}
	}

	async aggregateLeadStats(
		type: WidgetType,
		widgetId: string
	): Promise<WidgetStatsAggregate> {
		switch (type) {
			case WidgetType.WHEEL: {
				const grouped = await this.prisma.lead.groupBy({
					by: ['bonus'],
					where: { widgetId },
					_count: { id: true },
					orderBy: { _count: { id: 'desc' } }
				});
				return {
					kind: 'grouped',
					total: grouped.reduce((sum, group) => sum + group._count.id, 0),
					groups: grouped.map(group => ({
						value: group.bonus,
						count: group._count.id
					}))
				};
			}
			case WidgetType.QUIZ: {
				const grouped = await this.prisma.quizLead.groupBy({
					by: ['result'],
					where: { quizId: widgetId },
					_count: { id: true },
					orderBy: { _count: { id: 'desc' } }
				});
				return {
					kind: 'grouped',
					total: grouped.reduce((sum, group) => sum + group._count.id, 0),
					groups: grouped.map(group => ({
						value: group.result,
						count: group._count.id
					}))
				};
			}
			case WidgetType.CALCULATOR: {
				const aggregate = await this.prisma.calculatorLead.aggregate({
					where: { calculatorId: widgetId },
					_count: { id: true },
					_min: { calculatedPrice: true },
					_max: { calculatedPrice: true },
					_avg: { calculatedPrice: true }
				});
				return {
					kind: 'calculator',
					total: aggregate._count.id,
					min: aggregate._min.calculatedPrice,
					max: aggregate._max.calculatedPrice,
					average: aggregate._avg.calculatedPrice
				};
			}
			default:
				return { kind: 'unsupported' };
		}
	}

	async countLeads(type: WidgetType, widgetId: string): Promise<number> {
		return this.leadCount(type, this.leadWhere(type, widgetId));
	}

	private leadWhere(
		type: WidgetType,
		widgetId: string
	): Record<string, string> {
		switch (type) {
			case WidgetType.WHEEL:
				return { widgetId };
			case WidgetType.QUIZ:
				return { quizId: widgetId };
			case WidgetType.CALLBACK:
				return { callbackId: widgetId };
			case WidgetType.TIMER:
				return { countdownTimerId: widgetId };
			case WidgetType.STOP_OFFER:
				return { stopOfferId: widgetId };
			case WidgetType.ONLINE_CONSULTANT:
				return { onlineConsultantId: widgetId };
			case WidgetType.CALCULATOR:
				return { calculatorId: widgetId };
		}
	}

	private leadFindMany(
		type: WidgetType,
		args: Record<string, unknown>
	): Prisma.PrismaPromise<unknown[]> {
		switch (type) {
			case WidgetType.WHEEL:
				return this.prisma.lead.findMany(args as Prisma.LeadFindManyArgs);
			case WidgetType.QUIZ:
				return this.prisma.quizLead.findMany(
					args as Prisma.QuizLeadFindManyArgs
				);
			case WidgetType.CALLBACK:
				return this.prisma.callbackLead.findMany(
					args as Prisma.CallbackLeadFindManyArgs
				);
			case WidgetType.TIMER:
				return this.prisma.countdownTimerLead.findMany(
					args as Prisma.CountdownTimerLeadFindManyArgs
				);
			case WidgetType.STOP_OFFER:
				return this.prisma.stopOfferLead.findMany(
					args as Prisma.StopOfferLeadFindManyArgs
				);
			case WidgetType.ONLINE_CONSULTANT:
				return this.prisma.onlineConsultantLead.findMany(
					args as Prisma.OnlineConsultantLeadFindManyArgs
				);
			case WidgetType.CALCULATOR:
				return this.prisma.calculatorLead.findMany(
					args as Prisma.CalculatorLeadFindManyArgs
				);
		}
	}

	private leadCount(
		type: WidgetType,
		where: Record<string, string>
	): Prisma.PrismaPromise<number> {
		switch (type) {
			case WidgetType.WHEEL:
				return this.prisma.lead.count({ where });
			case WidgetType.QUIZ:
				return this.prisma.quizLead.count({ where });
			case WidgetType.CALLBACK:
				return this.prisma.callbackLead.count({ where });
			case WidgetType.TIMER:
				return this.prisma.countdownTimerLead.count({ where });
			case WidgetType.STOP_OFFER:
				return this.prisma.stopOfferLead.count({ where });
			case WidgetType.ONLINE_CONSULTANT:
				return this.prisma.onlineConsultantLead.count({ where });
			case WidgetType.CALCULATOR:
				return this.prisma.calculatorLead.count({ where });
		}
	}
}
