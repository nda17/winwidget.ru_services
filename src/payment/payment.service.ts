import { AffiliateService } from '@/affiliate/affiliate.service';
import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import { YookassaService } from '@/payment/yookassa.service';
import { PrismaService } from '@/prisma.service';
import { PLAN_PRIORITY } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
import { TariffPricesService } from '@/tariff-prices/tariff-prices.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import {
	BadRequestException,
	Injectable,
	Logger,
	NotFoundException
} from '@nestjs/common';
import {
	AuthIdentityType,
	BillingPeriod,
	Payment,
	PaymentStatus,
	Plan,
	Prisma,
	SubscriptionStatus
} from '@prisma/client';

type AdminPaymentWithUser = Payment & {
	user: {
		id: string;
		name: string | null;
		authIdentities: Array<{
			type: AuthIdentityType;
			value: string;
		}>;
	};
};

export interface AdminPaymentFilters {
	status?: string;
	plan?: string;
	billingPeriod?: string;
	createdFrom?: string;
	createdTo?: string;
	search?: string;
}

@Injectable()
export class PaymentService {
	private readonly RETURN_URL = `${process.env.RECAPTCHA_CLIENT_URL}/payment/success`;
	private readonly logger = new Logger(PaymentService.name);

	constructor(
		private prisma: PrismaService,
		private yookassa: YookassaService,
		private subscriptionService: SubscriptionService,
		private paymentCleanupService: PaymentCleanupService,
		private tariffPricesService: TariffPricesService,
		private affiliateService: AffiliateService,
		private readonly telegramBotService: TelegramBotService
	) {}

	async createPayment(
		userId: string,
		plan: Plan,
		billingPeriod: BillingPeriod
	) {
		if (plan === Plan.TRIAL) {
			throw new BadRequestException('Нельзя оплатить тестовый тариф');
		}

		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			include: { authIdentities: true }
		});

		if (!user) {
			throw new BadRequestException('Пользователь не найден');
		}

		await this.paymentCleanupService.cleanupStalePendingPaymentsForUser(
			userId
		);

		const pendingPayment = await this.getActualPendingPayment(userId);

		if (pendingPayment) {
			throw new BadRequestException(
				'У вас уже есть незавершённый платёж. Вернитесь к нему или отмените текущую попытку на странице оплаты.'
			);
		}

		const currentSubscription =
			await this.subscriptionService.checkAndResetPeriod(userId);

		if (
			currentSubscription &&
			currentSubscription.status === SubscriptionStatus.ACTIVE &&
			PLAN_PRIORITY[currentSubscription.plan] > PLAN_PRIORITY[plan]
		) {
			const currentPlanLabel = this.getPlanLabel(currentSubscription.plan);
			const requestedPlanLabel = this.getPlanLabel(plan);

			throw new BadRequestException(
				`Пока у вас активен тариф ${currentPlanLabel}, оплатить ${requestedPlanLabel} нельзя. Дождитесь окончания текущего тарифа или продлите ${currentPlanLabel}.`
			);
		}

		const emailIdentity = user.authIdentities.find(
			i => i.type === AuthIdentityType.EMAIL
		);
		const phoneIdentity = user.authIdentities.find(
			i => i.type === AuthIdentityType.PHONE
		);

		if (!emailIdentity && !phoneIdentity) {
			throw new BadRequestException(
				'Для оформления подписки необходимо привязать email или телефон в профиле'
			);
		}

		const price = await this.tariffPricesService.getPrice(
			plan,
			billingPeriod
		);
		const amount = `${price}.00`;
		const planLabel = plan === Plan.EASY ? 'Easy' : 'Hard';
		const periodLabel =
			billingPeriod === BillingPeriod.MONTHLY ? 'месяц' : 'год';
		const description = `Тариф ${planLabel} на ${periodLabel} — winwidget.ru`;

		const yookassaPayment = await this.yookassa.createPayment({
			amount,
			description,
			returnUrl: this.RETURN_URL,
			userId,
			customerEmail: emailIdentity?.value,
			customerPhone: phoneIdentity?.value
		});

		const confirmationUrl = yookassaPayment.confirmation?.confirmation_url;

		if (!confirmationUrl) {
			throw new BadRequestException(
				'Не удалось получить ссылку на оплату от ЮKassa'
			);
		}

		await this.prisma.payment.create({
			data: {
				userId,
				yookassaId: yookassaPayment.id,
				amount,
				confirmationUrl,
				status: PaymentStatus.PENDING,
				plan,
				billingPeriod
			}
		});

		this.logger.log(
			`Payment created: yookassaId=${yookassaPayment.id} userId=${userId} plan=${plan} period=${billingPeriod}`
		);

		return {
			confirmationUrl
		};
	}

	async getPendingPayment(userId: string) {
		await this.paymentCleanupService.cleanupStalePendingPaymentsForUser(
			userId
		);

		const pendingPayment = await this.getActualPendingPayment(userId);

		if (!pendingPayment || !pendingPayment.confirmationUrl) {
			return null;
		}

		return this.serializePendingPayment(pendingPayment);
	}

	async cancelPendingPayment(userId: string) {
		await this.paymentCleanupService.cleanupStalePendingPaymentsForUser(
			userId
		);

		const pendingPayment = await this.getActualPendingPayment(userId);

		if (!pendingPayment) {
			throw new BadRequestException('Незавершённый платёж не найден');
		}

		await this.prisma.payment.update({
			where: { id: pendingPayment.id },
			data: {
				status: PaymentStatus.CANCELLED,
				confirmationUrl: null
			}
		});

		this.logger.log(
			`Pending payment cancelled locally: yookassaId=${pendingPayment.yookassaId} userId=${userId}`
		);

		return {
			cancelled: true,
			message: 'Незавершённый платёж отменён.',
			cancelledAt: new Date().toISOString()
		};
	}

	async adminGetPayments(
		page = 1,
		limit = 20,
		filters: AdminPaymentFilters = {}
	) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const where = this.getAdminPaymentWhere(filters);
		const skip = (normalizedPage - 1) * normalizedLimit;

		const [payments, total] = await this.prisma.$transaction([
			this.prisma.payment.findMany({
				where,
				skip,
				take: normalizedLimit,
				orderBy: { createdAt: 'desc' },
				include: {
					user: {
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
					}
				}
			}),
			this.prisma.payment.count({ where })
		]);

		return {
			items: payments.map(payment => this.serializeAdminPayment(payment)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	private normalizeAdminPaymentStatus(status?: string) {
		if (!status) {
			return undefined;
		}

		const normalizedStatus = status.trim().toUpperCase();

		if (
			!Object.values(PaymentStatus).includes(
				normalizedStatus as PaymentStatus
			)
		) {
			throw new BadRequestException('Некорректный статус платежа');
		}

		return normalizedStatus as PaymentStatus;
	}

	private getAdminPaymentWhere(
		filters: AdminPaymentFilters
	): Prisma.PaymentWhereInput | undefined {
		const and: Prisma.PaymentWhereInput[] = [];
		const status = this.normalizeAdminPaymentStatus(filters.status);
		const plan = this.normalizeAdminPaymentPlan(filters.plan);
		const billingPeriod = this.normalizeAdminPaymentBillingPeriod(
			filters.billingPeriod
		);
		const createdAt = this.getDateRangeFilter(
			filters.createdFrom,
			filters.createdTo
		);
		const search = filters.search?.trim();

		if (status) and.push({ status });
		if (plan !== undefined) and.push({ plan });
		if (billingPeriod !== undefined) and.push({ billingPeriod });
		if (createdAt) and.push({ createdAt });

		if (search) {
			and.push({
				OR: [
					{
						id: {
							contains: search,
							mode: 'insensitive'
						}
					},
					{
						yookassaId: {
							contains: search,
							mode: 'insensitive'
						}
					},
					{
						user: {
							name: {
								contains: search,
								mode: 'insensitive'
							}
						}
					},
					{
						user: {
							authIdentities: {
								some: {
									type: {
										in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
									},
									value: {
										contains: search,
										mode: 'insensitive'
									}
								}
							}
						}
					}
				]
			});
		}

		return and.length ? { AND: and } : undefined;
	}

	private normalizeAdminPaymentPlan(value?: string) {
		const normalized = value?.trim().toUpperCase();

		if (!normalized) {
			return undefined;
		}

		if (normalized === 'NONE') {
			return null;
		}

		if (!Object.values(Plan).includes(normalized as Plan)) {
			throw new BadRequestException('Некорректный тариф платежа');
		}

		return normalized as Plan;
	}

	private normalizeAdminPaymentBillingPeriod(value?: string) {
		const normalized = value?.trim().toUpperCase();

		if (!normalized) {
			return undefined;
		}

		if (normalized === 'NONE') {
			return null;
		}

		if (
			!Object.values(BillingPeriod).includes(normalized as BillingPeriod)
		) {
			throw new BadRequestException('Некорректный период платежа');
		}

		return normalized as BillingPeriod;
	}

	private getDateRangeFilter(from?: string, to?: string) {
		const gte = this.normalizeDate(from, false);
		const lte = this.normalizeDate(to, true);

		if (!gte && !lte) {
			return undefined;
		}

		return {
			...(gte ? { gte } : {}),
			...(lte ? { lte } : {})
		};
	}

	private normalizeDate(value?: string, endOfDay = false) {
		const normalized = value?.trim();

		if (!normalized) {
			return undefined;
		}

		const date = new Date(
			endOfDay
				? `${normalized}T23:59:59.999Z`
				: `${normalized}T00:00:00.000Z`
		);

		if (Number.isNaN(date.getTime())) {
			throw new BadRequestException('Некорректная дата фильтра');
		}

		return date;
	}

	async adminCheckPayment(paymentId: string) {
		const normalizedPaymentId = paymentId.trim();

		if (!normalizedPaymentId) {
			throw new BadRequestException('Укажите ID платежа');
		}

		const payment = await this.prisma.payment.findFirst({
			where: {
				OR: [
					{ id: normalizedPaymentId },
					{ yookassaId: normalizedPaymentId }
				]
			}
		});

		if (!payment) {
			throw new NotFoundException('Платёж не найден');
		}

		const realPayment = await this.yookassa.getPayment(payment.yookassaId);

		if (realPayment.status === 'succeeded') {
			await this.handlePaymentSucceeded(payment.yookassaId);
		} else if (realPayment.status === 'canceled') {
			await this.handlePaymentCanceled(payment.yookassaId);
		}

		const updated = await this.prisma.payment.findUnique({
			where: { yookassaId: payment.yookassaId },
			include: {
				user: {
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
				}
			}
		});

		if (!updated) {
			throw new NotFoundException('Платёж не найден');
		}

		return {
			payment: this.serializeAdminPayment(updated),
			providerStatus: realPayment.status,
			message: this.getAdminCheckMessage(
				updated.status,
				realPayment.status
			),
			checkedAt: new Date().toISOString()
		};
	}

	async verifyLatestPayment(userId: string) {
		const payment = await this.prisma.payment.findFirst({
			where: {
				userId
			},
			orderBy: { createdAt: 'desc' }
		});

		if (!payment) {
			return {
				activated: false,
				status: 'not_found',
				plan: null,
				billingPeriod: null,
				message: 'Платёж не найден'
			};
		}

		if (payment.status === PaymentStatus.SUCCEEDED) {
			return this.serializePaymentVerification(payment, true);
		}

		if (payment.status === PaymentStatus.CANCELLED) {
			return this.serializePaymentVerification(payment, false);
		}

		const realPayment = await this.yookassa.getPayment(payment.yookassaId);

		if (realPayment.status === 'succeeded') {
			await this.handlePaymentSucceeded(payment.yookassaId);
		} else if (realPayment.status === 'canceled') {
			await this.handlePaymentCanceled(payment.yookassaId);
		}

		const updated = await this.prisma.payment.findUnique({
			where: { yookassaId: payment.yookassaId }
		});

		if (!updated) {
			return {
				activated: false,
				status: 'not_found',
				plan: null,
				billingPeriod: null,
				message: 'Платёж не найден'
			};
		}

		return this.serializePaymentVerification(
			updated,
			updated.status === PaymentStatus.SUCCEEDED
		);
	}

	async handleWebhook(body: any) {
		const event: string = body?.event;
		const yookassaId: string = body?.object?.id;

		if (!yookassaId) {
			return { ok: true };
		}

		if (event === 'payment.succeeded') {
			await this.handlePaymentSucceeded(yookassaId);
		} else if (event === 'payment.canceled') {
			await this.handlePaymentCanceled(yookassaId);
		}

		return { ok: true };
	}

	private async handlePaymentSucceeded(yookassaId: string) {
		const payment = await this.prisma.payment.findUnique({
			where: { yookassaId },
			select: {
				status: true,
				plan: true,
				billingPeriod: true
			}
		});

		if (!payment || payment.status === PaymentStatus.SUCCEEDED) {
			return;
		}

		const realPayment = await this.yookassa.getPayment(yookassaId);

		if (realPayment.status !== 'succeeded') {
			return;
		}

		const userId = realPayment.metadata?.userId;
		if (!userId) return;

		if (!payment.plan || !payment.billingPeriod) {
			this.logger.warn(`Payment ${yookassaId} missing plan/billingPeriod`);
			return;
		}

		const transitionResult = await this.prisma.payment.updateMany({
			where: {
				yookassaId,
				status: { not: PaymentStatus.SUCCEEDED }
			},
			data: {
				status: PaymentStatus.SUCCEEDED,
				confirmationUrl: null
			}
		});

		if (transitionResult.count !== 1) {
			return;
		}

		const updatedPayment = await this.prisma.payment.findUnique({
			where: { yookassaId }
		});

		if (!updatedPayment) {
			this.logger.warn(
				`Payment disappeared after succeeded transition: yookassaId=${yookassaId}`
			);
			return;
		}

		await this.subscriptionService.createOrUpgradeSubscription(
			userId,
			payment.plan,
			payment.billingPeriod
		);
		await this.affiliateService.processPaymentSucceeded(updatedPayment);

		try {
			const user = await this.prisma.user.findUnique({
				where: { id: userId },
				select: {
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
			});
			const emailIdentity = user?.authIdentities.find(
				identity => identity.type === AuthIdentityType.EMAIL
			);
			const phoneIdentity = user?.authIdentities.find(
				identity => identity.type === AuthIdentityType.PHONE
			);

			await this.telegramBotService.sendPaymentSucceededNotification({
				paymentId: updatedPayment.id,
				yookassaId: updatedPayment.yookassaId,
				amount: updatedPayment.amount,
				plan: payment.plan,
				billingPeriod: payment.billingPeriod,
				userId,
				userName: user?.name ?? null,
				email: emailIdentity?.value ?? null,
				phone: phoneIdentity?.value ?? null,
				succeededAt: updatedPayment.updatedAt
			});
		} catch (error) {
			this.logger.warn(
				`Failed to send Telegram payment notification: yookassaId=${yookassaId} error=${error instanceof Error ? error.message : String(error)}`
			);
		}

		this.logger.log(
			`Payment succeeded: yookassaId=${yookassaId} userId=${userId} plan=${payment.plan}`
		);
	}

	private async handlePaymentCanceled(yookassaId: string) {
		const payment = await this.prisma.payment.findUnique({
			where: { yookassaId }
		});

		await this.prisma.payment.updateMany({
			where: { yookassaId, status: PaymentStatus.PENDING },
			data: {
				status: PaymentStatus.CANCELLED,
				confirmationUrl: null
			}
		});

		if (payment) {
			await this.affiliateService.cancelRewardForPayment(payment.id);
		}

		this.logger.log(`Payment cancelled: yookassaId=${yookassaId}`);
	}

	private async getActualPendingPayment(userId: string) {
		const pendingPayment = await this.prisma.payment.findFirst({
			where: { userId, status: PaymentStatus.PENDING },
			orderBy: { createdAt: 'desc' }
		});

		if (!pendingPayment) {
			return null;
		}

		return this.syncPendingPaymentWithProvider(pendingPayment);
	}

	private async syncPendingPaymentWithProvider(payment: Payment) {
		try {
			const realPayment = await this.yookassa.getPayment(
				payment.yookassaId
			);

			if (realPayment.status === 'succeeded') {
				await this.handlePaymentSucceeded(payment.yookassaId);
				return null;
			}

			if (realPayment.status === 'canceled') {
				await this.handlePaymentCanceled(payment.yookassaId);
				return null;
			}
		} catch (error) {
			this.logger.warn(
				`Failed to sync payment status with ЮKassa: yookassaId=${payment.yookassaId} error=${error instanceof Error ? error.message : String(error)}`
			);
		}

		return payment;
	}

	private serializePendingPayment(payment: Payment) {
		return {
			id: payment.id,
			yookassaId: payment.yookassaId,
			amount: payment.amount,
			plan: payment.plan,
			billingPeriod: payment.billingPeriod,
			confirmationUrl: payment.confirmationUrl,
			createdAt: payment.createdAt
		};
	}

	private serializePaymentVerification(
		payment: Payment,
		activated: boolean
	) {
		const status =
			payment.status === PaymentStatus.SUCCEEDED
				? 'succeeded'
				: payment.status === PaymentStatus.CANCELLED
					? 'cancelled'
					: 'pending';

		const message =
			status === 'succeeded'
				? 'Оплата подтверждена'
				: status === 'cancelled'
					? 'Оплата отменена или не завершена'
					: 'Ожидаем подтверждение оплаты';

		return {
			activated,
			status,
			plan: payment.plan,
			billingPeriod: payment.billingPeriod,
			message
		};
	}

	private serializeAdminPayment(payment: AdminPaymentWithUser) {
		const emailIdentity = payment.user.authIdentities.find(
			identity => identity.type === AuthIdentityType.EMAIL
		);
		const phoneIdentity = payment.user.authIdentities.find(
			identity => identity.type === AuthIdentityType.PHONE
		);

		return {
			id: payment.id,
			yookassaId: payment.yookassaId,
			status: payment.status,
			amount: payment.amount,
			plan: payment.plan,
			billingPeriod: payment.billingPeriod,
			confirmationUrl: payment.confirmationUrl,
			createdAt: payment.createdAt,
			updatedAt: payment.updatedAt,
			user: {
				id: payment.user.id,
				name: payment.user.name,
				email: emailIdentity?.value ?? null,
				phone: phoneIdentity?.value ?? null
			}
		};
	}

	private getAdminCheckMessage(
		paymentStatus: PaymentStatus,
		providerStatus: string
	) {
		if (
			providerStatus === 'succeeded' &&
			paymentStatus !== PaymentStatus.SUCCEEDED
		) {
			return 'YooKassa вернула succeeded, но локальный статус не изменился. Проверь metadata платежа.';
		}

		if (paymentStatus === PaymentStatus.SUCCEEDED) {
			return 'Платёж подтверждён, подписка синхронизирована.';
		}

		if (paymentStatus === PaymentStatus.CANCELLED) {
			return 'Платёж отменён.';
		}

		return 'Платёж ещё ожидает оплаты.';
	}

	private getPlanLabel(plan: Plan) {
		switch (plan) {
			case Plan.TRIAL:
				return 'Тест-драйв';
			case Plan.EASY:
				return 'Easy';
			case Plan.HARD:
				return 'Hard';
			default:
				return plan;
		}
	}
}
