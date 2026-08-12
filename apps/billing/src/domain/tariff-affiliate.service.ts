import {
	AffiliateReferralStatus,
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	BillingPeriod,
	PaymentStatus,
	Plan,
	Prisma
} from '@prisma/billing-client';
import {
	BadRequestException,
	ConflictException,
	Injectable
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
	UpdateAffiliateSettingsDto,
	UpdateTariffPricesDto
} from '../http/billing.dto';
import {
	BILLING_EVENT_TYPES,
	BILLING_EVENTS_EXCHANGE
} from '../messaging/billing-messaging.constants';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import {
	enqueueBillingAdminAudit,
	type BillingAdminActor,
	type BillingAdminAuditAction
} from './billing-admin-audit';

const PAID_PLANS = [Plan.EASY, Plan.HARD] as const;
const PERIODS = [BillingPeriod.MONTHLY, BillingPeriod.YEARLY] as const;

@Injectable()
export class TariffAffiliateService {
	constructor(private readonly prisma: BillingPrismaService) {}

	async tariffPrices() {
		// This public read is exercised while the isolated import target is empty.
		// Return only truthful persisted DTOs so the later snapshot import stays valid.
		return this.prisma.tariffPrice.findMany({
			where: { plan: { in: [...PAID_PLANS] } },
			orderBy: [{ plan: 'asc' }, { billingPeriod: 'asc' }]
		});
	}

	async updateTariffPrices(
		dto: UpdateTariffPricesDto,
		actor: BillingAdminActor
	) {
		for (const price of dto.prices) {
			if (
				!PAID_PLANS.includes(price.plan as (typeof PAID_PLANS)[number])
			) {
				throw new BadRequestException(
					'Можно менять цены только для тарифов Easy и Hard'
				);
			}
		}
		const map = new Map(
			dto.prices.map(item => [`${item.plan}:${item.billingPeriod}`, item])
		);
		if (
			map.size !== 4 ||
			PAID_PLANS.some(plan =>
				PERIODS.some(period => !map.has(`${plan}:${period}`))
			)
		) {
			throw new BadRequestException(
				'Нужно передать цены Easy и Hard для месяца и года'
			);
		}
		await this.prisma.$transaction(
			async transaction => {
				for (const plan of PAID_PLANS) {
					for (const billingPeriod of PERIODS) {
						const price = map.get(`${plan}:${billingPeriod}`)!;
						await transaction.tariffPrice.upsert({
							where: {
								plan_billingPeriod: {
									plan: price.plan,
									billingPeriod: price.billingPeriod
								}
							},
							create: price,
							update: { amount: price.amount }
						});
						const renewals = await transaction.autoRenewal.findMany({
							where: {
								plan: price.plan,
								billingPeriod: price.billingPeriod,
								status: {
									in: [
										AutoRenewalStatus.ACTIVE,
										AutoRenewalStatus.ADMIN_PAUSED,
										AutoRenewalStatus.TECHNICAL_PAUSE
									]
								}
							}
						});
						const amount = `${price.amount}.00`;
						for (const renewal of renewals) {
							if (renewal.amount === amount) {
								if (renewal.pendingAmount) {
									await transaction.autoRenewal.updateMany({
										where: {
											id: renewal.id,
											stateVersion: renewal.stateVersion
										},
										data: {
											pendingAmount: null,
											priceChangeDetectedAt: null,
											stateVersion: { increment: 1 }
										}
									});
								}
								continue;
							}
							if (renewal.pendingAmount === amount) continue;
							const detectedAt = new Date();
							const changed = await transaction.autoRenewal.updateMany({
								where: {
									id: renewal.id,
									stateVersion: renewal.stateVersion
								},
								data: {
									pendingAmount: amount,
									priceChangeDetectedAt: detectedAt,
									stateVersion: { increment: 1 }
								}
							});
							if (changed.count !== 1)
								throw new ConflictException(
									'Состояние автопродления изменилось параллельно. Повторите изменение цен'
								);
							await transaction.autoRenewalConsentEvent.create({
								data: {
									autoRenewalId: renewal.id,
									userId: renewal.userId,
									type: AutoRenewalConsentEventType.PRICE_CHANGE_REQUIRED,
									actorUserId: actor.id,
									actorRole: actor.role,
									source: 'ADMIN_TARIFF_PRICE_UPDATE',
									reason:
										'Новая стоимость требует явного подтверждения пользователя',
									consentVersion: renewal.consentVersion,
									consentText: renewal.consentText,
									offerSnapshot: renewal.offerSnapshot,
									offerSha256: renewal.offerSha256,
									offerUpdatedAt: renewal.offerUpdatedAt,
									plan: renewal.plan,
									billingPeriod: renewal.billingPeriod,
									amount: renewal.amount,
									currency: renewal.currency,
									metadata: {
										previousAmount:
											renewal.pendingAmount || renewal.amount,
										consentedAmount: renewal.amount,
										newAmount: amount,
										detectedAt: detectedAt.toISOString()
									}
								}
							});
						}
					}
				}
				await this.audit(
					transaction,
					actor,
					'TARIFF_PRICES_UPDATE',
					undefined,
					{ prices: [...map.values()] }
				);
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 5_000,
				timeout: 30_000
			}
		);
		return this.tariffPrices();
	}

	async affiliateSettings() {
		// Keep the pre-import public contract read-only for the same reason as prices.
		const settings = await this.prisma.billingSettings.findUnique({
			where: { id: 'singleton' },
			select: {
				affiliateProgramEnabled: true,
				affiliateCashbackPercent: true
			}
		});
		return {
			enabled: settings?.affiliateProgramEnabled ?? false,
			cashbackPercent: settings?.affiliateCashbackPercent ?? 10
		};
	}

	async updateAffiliateSettings(
		dto: UpdateAffiliateSettingsDto,
		actor: BillingAdminActor
	) {
		const settings = await this.prisma.$transaction(async transaction => {
			const current = await transaction.billingSettings.upsert({
				where: { id: 'singleton' },
				create: { id: 'singleton' },
				update: {}
			});
			const sequence = await this.nextSequence(transaction);
			const updated = await transaction.billingSettings.update({
				where: { id: 'singleton' },
				data: {
					affiliateProgramEnabled:
						dto.enabled ?? current.affiliateProgramEnabled,
					affiliateCashbackPercent:
						dto.cashbackPercent ?? current.affiliateCashbackPercent,
					aggregateVersion: { increment: 1n },
					sourceSequence: sequence
				}
			});
			await this.emitSettings(transaction, updated);
			await this.audit(
				transaction,
				actor,
				'AFFILIATE_SETTINGS_UPDATE',
				undefined,
				{
					enabled: updated.affiliateProgramEnabled,
					cashbackPercent: updated.affiliateCashbackPercent
				}
			);
			return updated;
		});
		return {
			enabled: settings.affiliateProgramEnabled,
			cashbackPercent: settings.affiliateCashbackPercent
		};
	}

	async myAffiliate(userId: string, page = 1, limit = 20) {
		const settings = await this.settings();
		if (!settings.affiliateProgramEnabled) {
			return {
				settings: {
					enabled: false,
					cashbackPercent: settings.affiliateCashbackPercent
				},
				referralLink: '',
				items: [],
				total: 0,
				page: 1,
				limit,
				totalPages: 1
			};
		}
		return {
			settings: {
				enabled: true,
				cashbackPercent: settings.affiliateCashbackPercent
			},
			referralLink: `${this.publicClientUrl()}/register?ref=${encodeURIComponent(userId)}`,
			...(await this.affiliateList(page, limit, { referrerId: userId }))
		};
	}

	async adminReferrals(
		page = 1,
		limit = 20,
		status?: string,
		search?: string
	) {
		const where: Prisma.AffiliateReferralWhereInput = {};
		if (status?.trim()) {
			const normalized = status.trim().toUpperCase();
			if (
				!Object.values(AffiliateReferralStatus).includes(
					normalized as AffiliateReferralStatus
				)
			) {
				throw new BadRequestException('Некорректный статус реферала');
			}
			where.status = normalized as AffiliateReferralStatus;
		}
		if (search?.trim()) {
			const ids = await this.prisma.identityContactProjection.findMany({
				where: {
					OR: [
						{ userId: { contains: search.trim(), mode: 'insensitive' } },
						{ name: { contains: search.trim(), mode: 'insensitive' } },
						{ email: { contains: search.trim(), mode: 'insensitive' } },
						{ phone: { contains: search.trim(), mode: 'insensitive' } }
					]
				},
				select: { userId: true }
			});
			where.OR = [
				{ id: { contains: search.trim(), mode: 'insensitive' } },
				{ referrerId: { in: ids.map(item => item.userId) } },
				{ referredUserId: { in: ids.map(item => item.userId) } }
			];
		}
		return this.affiliateList(page, limit, where);
	}

	async registerReferral(
		referrerId: string,
		referredUserId: string,
		requestedAtValue: string
	) {
		if (!referrerId || referrerId === referredUserId) return null;
		const requestedAt = new Date(requestedAtValue);
		if (!Number.isFinite(requestedAt.getTime())) {
			throw new BadRequestException('Referral requestedAt is invalid');
		}
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				return await this.prisma.$transaction(
					async transaction => {
						await transaction.$executeRaw`
							SELECT pg_advisory_xact_lock(
								hashtextextended(${`billing.referral:${referredUserId}`}, 0)
							)
						`;
						const existing =
							await transaction.affiliateReferral.findUnique({
								where: { referredUserId }
							});
						if (existing) return existing;
						const [
							settings,
							referrer,
							firstExistingPayment,
							firstSucceededPayment
						] = await Promise.all([
							transaction.billingSettings.upsert({
								where: { id: 'singleton' },
								create: { id: 'singleton' },
								update: {}
							}),
							transaction.identityContactProjection.findUnique({
								where: { userId: referrerId }
							}),
							transaction.payment.findFirst({
								where: { userId: referredUserId },
								orderBy: { createdAt: 'asc' }
							}),
							transaction.payment.findFirst({
								where: {
									userId: referredUserId,
									status: PaymentStatus.SUCCEEDED
								},
								orderBy: [{ succeededAt: 'asc' }, { createdAt: 'asc' }]
							})
						]);
						if (!settings.affiliateProgramEnabled || referrer?.tombstone)
							return null;
						if (!referrer) {
							throw new Error(
								'Referral referrer identity projection is unavailable'
							);
						}
						if (
							firstExistingPayment?.createdAt &&
							firstExistingPayment.createdAt <= requestedAt
						)
							return null;

						const sequence = await this.nextSequence(transaction);
						const paymentAmount = firstSucceededPayment
							? Math.round(Number(firstSucceededPayment.amount))
							: null;
						const cashbackAmount =
							paymentAmount === null
								? null
								: Math.floor(
										(paymentAmount * settings.affiliateCashbackPercent) /
											100
									);
						const created = await transaction.affiliateReferral.create({
							data: {
								referrerId,
								referredUserId,
								firstPaymentId: firstSucceededPayment?.id ?? null,
								status: firstSucceededPayment
									? AffiliateReferralStatus.REWARD_PENDING
									: AffiliateReferralStatus.REGISTERED,
								paymentAmount,
								cashbackPercent: firstSucceededPayment
									? settings.affiliateCashbackPercent
									: null,
								cashbackAmount,
								availableAt: firstSucceededPayment?.succeededAt
									? new Date(
											firstSucceededPayment.succeededAt.getTime() +
												20 * 24 * 60 * 60 * 1000
										)
									: null,
								aggregateVersion: 1n,
								sourceSequence: sequence
							}
						});
						await this.emitAffiliate(transaction, created);
						return created;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 5_000,
						timeout: 15_000
					}
				);
			} catch (error) {
				if ((error as { code?: string }).code === 'P2002') {
					return this.prisma.affiliateReferral.findUnique({
						where: { referredUserId }
					});
				}
				if (!this.isSerializationConflict(error) || attempt === 3) {
					throw error;
				}
			}
		}
		throw new Error('Unreachable referral registration state');
	}

	private async affiliateList(
		page: number,
		limit: number,
		where: Prisma.AffiliateReferralWhereInput
	) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const [items, total] = await this.prisma.$transaction([
			this.prisma.affiliateReferral.findMany({
				where,
				orderBy: { createdAt: 'desc' },
				skip: (normalizedPage - 1) * normalizedLimit,
				take: normalizedLimit,
				include: { payment: true }
			}),
			this.prisma.affiliateReferral.count({ where })
		]);
		const identities =
			await this.prisma.identityContactProjection.findMany({
				where: {
					userId: {
						in: [
							...new Set(
								items.flatMap(item => [
									item.referrerId,
									item.referredUserId
								])
							)
						]
					}
				}
			});
		const map = new Map(identities.map(item => [item.userId, item]));
		return {
			items: items.map(item => ({
				id: item.id,
				status: item.status,
				rewardAvailable:
					item.status === AffiliateReferralStatus.REWARD_PENDING &&
					Boolean(item.availableAt) &&
					item.availableAt!.getTime() <= Date.now(),
				referrer: this.identity(map.get(item.referrerId), item.referrerId),
				referredUser: this.identity(
					map.get(item.referredUserId),
					item.referredUserId
				),
				paymentAmount: item.paymentAmount,
				cashbackPercent: item.cashbackPercent,
				cashbackAmount: item.cashbackAmount,
				availableAt: item.availableAt?.toISOString() || null,
				cancelledAt: item.cancelledAt?.toISOString() || null,
				paidAt: item.paidAt?.toISOString() || null,
				firstPayment: item.payment
					? {
							id: item.payment.id,
							yookassaId: item.payment.yookassaId,
							status: item.payment.status,
							amount: item.payment.amount,
							createdAt: item.payment.createdAt
						}
					: null,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt
			})),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	private identity(item: any, userId: string) {
		return {
			id: userId,
			name: item?.name ?? null,
			email: item?.email ?? null,
			phone: item?.phone ?? null
		};
	}

	private settings() {
		return this.prisma.billingSettings.upsert({
			where: { id: 'singleton' },
			create: { id: 'singleton' },
			update: {}
		});
	}

	private async emitAffiliate(
		transaction: Prisma.TransactionClient,
		item: any
	) {
		const eventId = randomUUID();
		const eventType = BILLING_EVENT_TYPES.affiliateChanged;
		await transaction.outboxEvent.create({
			data: {
				eventId,
				eventType,
				aggregateType: 'billing.affiliate',
				aggregateId: item.id,
				aggregateVersion: item.aggregateVersion,
				sourceSequence: item.sourceSequence,
				exchange: BILLING_EVENTS_EXCHANGE,
				routingKey: eventType,
				payload: {
					schemaVersion: 1,
					eventType,
					eventId,
					aggregateId: item.id,
					aggregateVersion: item.aggregateVersion.toString(),
					sourceSequence: item.sourceSequence.toString(),
					occurredAt: item.updatedAt.toISOString(),
					tombstone: false,
					state: {
						id: item.id,
						referrerId: item.referrerId,
						referredUserId: item.referredUserId,
						firstPaymentId: item.firstPaymentId,
						status: item.status,
						cashbackAmount: item.cashbackAmount,
						availableAt: item.availableAt?.toISOString() || null,
						cancelledAt: item.cancelledAt?.toISOString() || null,
						updatedAt: item.updatedAt.toISOString()
					}
				}
			}
		});
	}

	async emitSettings(transaction: Prisma.TransactionClient, item: any) {
		const eventId = randomUUID();
		const eventType = BILLING_EVENT_TYPES.settingsChanged;
		await transaction.outboxEvent.create({
			data: {
				eventId,
				eventType,
				aggregateType: 'billing.settings',
				aggregateId: item.id,
				aggregateVersion: item.aggregateVersion,
				sourceSequence: item.sourceSequence,
				exchange: BILLING_EVENTS_EXCHANGE,
				routingKey: eventType,
				payload: {
					schemaVersion: 1,
					eventType,
					eventId,
					aggregateId: item.id,
					aggregateVersion: item.aggregateVersion.toString(),
					sourceSequence: item.sourceSequence.toString(),
					occurredAt: item.updatedAt.toISOString(),
					tombstone: false,
					state: {
						id: item.id,
						paymentEnabled: item.paymentEnabled,
						autoRenewalSignupEnabled: item.autoRenewalSignupEnabled,
						autoRenewalChargesEnabled: item.autoRenewalChargesEnabled,
						autoRenewalChargesEnabledAt:
							item.autoRenewalChargesEnabledAt?.toISOString() || null,
						affiliateProgramEnabled: item.affiliateProgramEnabled,
						affiliateCashbackPercent: item.affiliateCashbackPercent,
						updatedAt: item.updatedAt.toISOString()
					}
				}
			}
		});
	}

	private async audit(
		transaction: Prisma.TransactionClient,
		actor: BillingAdminActor,
		action: Extract<
			BillingAdminAuditAction,
			'TARIFF_PRICES_UPDATE' | 'AFFILIATE_SETTINGS_UPDATE'
		>,
		targetUserId: string | undefined,
		metadata: Record<string, unknown>
	) {
		const affiliate = action === 'AFFILIATE_SETTINGS_UPDATE';
		await enqueueBillingAdminAudit(transaction, {
			actor,
			section: affiliate ? 'AFFILIATE' : 'PAYMENTS',
			action,
			description: affiliate
				? 'Настройки партнёрской программы обновлены'
				: 'Обновлены тарифные цены; новые суммы автопродления требуют подтверждения пользователей',
			entity: {
				type: affiliate ? 'affiliate_settings' : 'tariff_prices',
				id: affiliate ? 'singleton' : 'paid-plans',
				label: affiliate
					? 'Партнёрская программа'
					: 'Цены платных тарифов',
				targetUserId: targetUserId || null
			},
			metadata: {
				...metadata,
				requestIp: actor.ip || null,
				requestUserAgent: actor.userAgent || null
			}
		});
	}

	private publicClientUrl(): string {
		const configured =
			process.env.RECAPTCHA_CLIENT_URL?.trim() || 'https://winwidget.ru';
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			return 'https://winwidget.ru';
		}
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			return 'https://winwidget.ru';
		}
		return url.toString().replace(/\/$/, '');
	}

	private async nextSequence(transaction: Prisma.TransactionClient) {
		const state = await transaction.billingSourceSequence.upsert({
			where: { id: 'billing' },
			create: { id: 'billing', nextValue: 2n },
			update: { nextValue: { increment: 1n } }
		});
		return state.nextValue - 1n;
	}

	private isSerializationConflict(error: unknown): boolean {
		if (typeof error !== 'object' || error === null) return false;
		const candidate = error as {
			code?: string;
			meta?: { code?: string };
		};
		return (
			candidate.code === 'P2034' ||
			(candidate.code === 'P2010' &&
				['40001', '40P01'].includes(candidate.meta?.code || ''))
		);
	}
}
