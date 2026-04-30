import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import { YookassaService } from '@/payment/yookassa.service';
import { PrismaService } from '@/prisma.service';
import { PLAN_PRIORITY } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
import { TariffPricesService } from '@/tariff-prices/tariff-prices.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
	AuthIdentityType,
	BillingPeriod,
	Payment,
	PaymentStatus,
	Plan,
	SubscriptionStatus
} from '@prisma/client';

@Injectable()
export class PaymentService {
	private readonly RETURN_URL = `${process.env.RECAPTCHA_CLIENT_URL}/payment/success`;
	private readonly logger = new Logger(PaymentService.name);

	constructor(
		private prisma: PrismaService,
		private yookassa: YookassaService,
		private subscriptionService: SubscriptionService,
		private paymentCleanupService: PaymentCleanupService,
		private tariffPricesService: TariffPricesService
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
			where: { yookassaId }
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

		await this.prisma.$transaction([
			this.prisma.payment.update({
				where: { yookassaId },
				data: {
					status: PaymentStatus.SUCCEEDED,
					confirmationUrl: null
				}
			})
		]);

		await this.subscriptionService.createOrUpgradeSubscription(
			userId,
			payment.plan,
			payment.billingPeriod
		);

		this.logger.log(
			`Payment succeeded: yookassaId=${yookassaId} userId=${userId} plan=${payment.plan}`
		);
	}

	private async handlePaymentCanceled(yookassaId: string) {
		await this.prisma.payment.updateMany({
			where: { yookassaId, status: PaymentStatus.PENDING },
			data: {
				status: PaymentStatus.CANCELLED,
				confirmationUrl: null
			}
		});

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
