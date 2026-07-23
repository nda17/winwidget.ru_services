import { UpdateAffiliateSettingsDto } from '@/affiliate/dto/update-affiliate-settings.dto';
import { PrismaService } from '@/prisma.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
	AffiliateReferralStatus,
	AuthIdentityType,
	Payment,
	PaymentStatus,
	Prisma,
	UserStatus
} from '@prisma/client';

interface AffiliateListFilters {
	status?: string;
	search?: string;
}

type AffiliateReferralWithUsers = Prisma.AffiliateReferralGetPayload<{
	include: {
		referrer: {
			select: {
				id: true;
				name: true;
				authIdentities: {
					select: {
						type: true;
						value: true;
					};
				};
			};
		};
		referredUser: {
			select: {
				id: true;
				name: true;
				authIdentities: {
					select: {
						type: true;
						value: true;
					};
				};
			};
		};
		firstPayment: true;
	};
}>;

@Injectable()
export class AffiliateService {
	private readonly COOLING_PERIOD_DAYS = 20;

	constructor(private readonly prisma: PrismaService) {}

	async getPublicSettings() {
		const settings = await this.getSettingsRecord();

		return this.serializeSettings(settings);
	}

	async updateSettings(dto: UpdateAffiliateSettingsDto) {
		const data: Prisma.SiteSettingsUpdateInput = {};

		if (dto.enabled !== undefined) {
			data.affiliateProgramEnabled = dto.enabled;
		}

		if (dto.cashbackPercent !== undefined) {
			data.affiliateCashbackPercent = dto.cashbackPercent;
		}

		const settings = await this.prisma.siteSettings.upsert({
			where: { id: 'singleton' },
			update: data,
			create: {
				id: 'singleton',
				affiliateProgramEnabled: dto.enabled ?? false,
				affiliateCashbackPercent: dto.cashbackPercent ?? 10
			}
		});

		return this.serializeSettings(settings);
	}

	async registerReferral(
		referrerId: string | undefined,
		referredUserId: string
	) {
		const normalizedReferrerId = referrerId?.trim();

		if (!normalizedReferrerId || normalizedReferrerId === referredUserId) {
			return null;
		}

		const settings = await this.getSettingsRecord();
		if (!settings.affiliateProgramEnabled) {
			return null;
		}

		const [referrer, existingReferral, existingPaymentCount] =
			await Promise.all([
				this.prisma.user.findFirst({
					where: {
						id: normalizedReferrerId,
						status: UserStatus.ACTIVE
					},
					select: { id: true }
				}),
				this.prisma.affiliateReferral.findUnique({
					where: { referredUserId }
				}),
				this.prisma.payment.count({
					where: { userId: referredUserId }
				})
			]);

		if (!referrer || existingReferral || existingPaymentCount > 0) {
			return null;
		}

		return this.prisma.affiliateReferral.create({
			data: {
				referrerId: normalizedReferrerId,
				referredUserId
			}
		});
	}

	async processPaymentSucceededInTransaction(
		transaction: Prisma.TransactionClient,
		payment: Payment
	) {
		if (!payment.plan || !payment.billingPeriod) {
			return;
		}

		const referral = await transaction.affiliateReferral.findUnique({
			where: { referredUserId: payment.userId }
		});

		if (
			!referral ||
			referral.status !== AffiliateReferralStatus.REGISTERED
		) {
			return;
		}

		const settings = await transaction.siteSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
		const succeededPaymentsCount = await transaction.payment.count({
			where: {
				userId: payment.userId,
				status: PaymentStatus.SUCCEEDED
			}
		});

		if (
			!settings.affiliateProgramEnabled ||
			succeededPaymentsCount !== 1
		) {
			await transaction.affiliateReferral.update({
				where: { id: referral.id },
				data: {
					status: AffiliateReferralStatus.CANCELLED,
					cancelledAt: new Date()
				}
			});
			return;
		}

		const paymentAmount = Math.round(Number(payment.amount));
		const cashbackPercent = settings.affiliateCashbackPercent;
		const cashbackAmount = Math.floor(
			(paymentAmount * cashbackPercent) / 100
		);
		const availableAt = new Date(
			Date.now() + this.COOLING_PERIOD_DAYS * 24 * 60 * 60 * 1000
		);

		await transaction.affiliateReferral.update({
			where: { id: referral.id },
			data: {
				firstPaymentId: payment.id,
				status: AffiliateReferralStatus.REWARD_PENDING,
				paymentAmount,
				cashbackPercent,
				cashbackAmount,
				availableAt
			}
		});
	}

	async cancelRewardForPayment(paymentId: string) {
		await this.prisma.affiliateReferral.updateMany({
			where: {
				firstPaymentId: paymentId,
				status: AffiliateReferralStatus.REWARD_PENDING
			},
			data: {
				status: AffiliateReferralStatus.CANCELLED,
				cancelledAt: new Date()
			}
		});
	}

	async getMyProgram(userId: string, page = 1, limit = 20) {
		const settings = await this.getSettingsRecord();

		if (!settings.affiliateProgramEnabled) {
			return {
				settings: this.serializeSettings(settings),
				referralLink: '',
				items: [],
				total: 0,
				page: 1,
				limit,
				totalPages: 1
			};
		}

		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const where: Prisma.AffiliateReferralWhereInput = {
			referrerId: userId
		};
		const [items, total] = await this.prisma.$transaction([
			this.prisma.affiliateReferral.findMany({
				where,
				include: this.getReferralInclude(),
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.affiliateReferral.count({ where })
		]);

		return {
			settings: this.serializeSettings(settings),
			referralLink: this.buildReferralLink(userId),
			items: items.map(item => this.serializeReferral(item)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async adminGetReferrals(
		page = 1,
		limit = 20,
		filters: AffiliateListFilters = {}
	) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const where = this.getReferralWhere(filters);
		const [items, total] = await this.prisma.$transaction([
			this.prisma.affiliateReferral.findMany({
				where,
				include: this.getReferralInclude(),
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.affiliateReferral.count({ where })
		]);

		return {
			items: items.map(item => this.serializeReferral(item)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	private getReferralWhere(
		filters: AffiliateListFilters
	): Prisma.AffiliateReferralWhereInput | undefined {
		const and: Prisma.AffiliateReferralWhereInput[] = [];
		const status = this.normalizeStatus(filters.status);
		const search = filters.search?.trim();

		if (status) and.push({ status });
		if (search) {
			and.push({
				OR: [
					{ id: { contains: search, mode: 'insensitive' } },
					{
						referrer: {
							OR: [
								{ name: { contains: search, mode: 'insensitive' } },
								{
									authIdentities: {
										some: {
											value: {
												contains: search,
												mode: 'insensitive'
											}
										}
									}
								}
							]
						}
					},
					{
						referredUser: {
							OR: [
								{ name: { contains: search, mode: 'insensitive' } },
								{
									authIdentities: {
										some: {
											value: {
												contains: search,
												mode: 'insensitive'
											}
										}
									}
								}
							]
						}
					}
				]
			});
		}

		return and.length ? { AND: and } : undefined;
	}

	private normalizeStatus(value?: string) {
		const normalized = value?.trim().toUpperCase();

		if (!normalized) {
			return undefined;
		}

		if (
			!Object.values(AffiliateReferralStatus).includes(
				normalized as AffiliateReferralStatus
			)
		) {
			throw new BadRequestException('Некорректный статус реферала');
		}

		return normalized as AffiliateReferralStatus;
	}

	private getReferralInclude() {
		return {
			referrer: {
				select: {
					id: true,
					name: true,
					authIdentities: {
						where: {
							type: {
								in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
							}
						},
						select: {
							type: true,
							value: true
						}
					}
				}
			},
			referredUser: {
				select: {
					id: true,
					name: true,
					authIdentities: {
						where: {
							type: {
								in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
							}
						},
						select: {
							type: true,
							value: true
						}
					}
				}
			},
			firstPayment: true
		} satisfies Prisma.AffiliateReferralInclude;
	}

	private async getSettingsRecord() {
		return this.prisma.siteSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
	}

	private serializeSettings(settings: {
		affiliateProgramEnabled: boolean;
		affiliateCashbackPercent: number;
	}) {
		return {
			enabled: settings.affiliateProgramEnabled,
			cashbackPercent: settings.affiliateCashbackPercent
		};
	}

	private serializeReferral(item: AffiliateReferralWithUsers) {
		return {
			id: item.id,
			status: item.status,
			rewardAvailable:
				item.status === AffiliateReferralStatus.REWARD_PENDING &&
				Boolean(item.availableAt) &&
				item.availableAt!.getTime() <= Date.now(),
			referrer: this.serializeUser(item.referrer),
			referredUser: this.serializeUser(item.referredUser),
			paymentAmount: item.paymentAmount,
			cashbackPercent: item.cashbackPercent,
			cashbackAmount: item.cashbackAmount,
			availableAt: item.availableAt?.toISOString() ?? null,
			cancelledAt: item.cancelledAt?.toISOString() ?? null,
			paidAt: item.paidAt?.toISOString() ?? null,
			firstPayment: item.firstPayment
				? {
						id: item.firstPayment.id,
						yookassaId: item.firstPayment.yookassaId,
						status: item.firstPayment.status,
						amount: item.firstPayment.amount,
						createdAt: item.firstPayment.createdAt
					}
				: null,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt
		};
	}

	private serializeUser(user: {
		id: string;
		name: string | null;
		authIdentities: Array<{
			type: AuthIdentityType;
			value: string;
		}>;
	}) {
		const email = user.authIdentities.find(
			identity => identity.type === AuthIdentityType.EMAIL
		)?.value;
		const phone = user.authIdentities.find(
			identity => identity.type === AuthIdentityType.PHONE
		)?.value;

		return {
			id: user.id,
			name: user.name,
			email: email ?? null,
			phone: phone ?? null
		};
	}

	private buildReferralLink(userId: string) {
		const origin =
			process.env.RECAPTCHA_CLIENT_URL ||
			process.env.WIDGET_RUNTIME_URL ||
			'https://winwidget.ru';

		return `${origin.replace(/\/$/, '')}/register?ref=${encodeURIComponent(userId)}`;
	}
}
