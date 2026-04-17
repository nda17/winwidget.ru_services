import { YookassaService } from '@/payment/yookassa.service';
import { PrismaService } from '@/prisma.service';
import { PLAN_PRICES } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
	AuthIdentityType,
	BillingPeriod,
	PaymentStatus,
	Plan
} from '@prisma/client';

@Injectable()
export class PaymentService {
	private readonly RETURN_URL = `${process.env.RECAPTCHA_CLIENT_URL}/payment/success`;
	private readonly logger = new Logger(PaymentService.name);

	constructor(
		private prisma: PrismaService,
		private yookassa: YookassaService,
		private subscriptionService: SubscriptionService
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

		const pendingPayment = await this.prisma.payment.findFirst({
			where: { userId, status: PaymentStatus.PENDING }
		});

		if (pendingPayment) {
			throw new BadRequestException(
				'У вас уже есть незавершённый платёж. Завершите его или дождитесь отмены'
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

		const price = PLAN_PRICES[plan][billingPeriod];
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

		await this.prisma.payment.create({
			data: {
				userId,
				yookassaId: yookassaPayment.id,
				amount,
				status: PaymentStatus.PENDING,
				plan,
				billingPeriod
			}
		});

		this.logger.log(
			`Payment created: yookassaId=${yookassaPayment.id} userId=${userId} plan=${plan} period=${billingPeriod}`
		);

		return {
			confirmationUrl: yookassaPayment.confirmation.confirmation_url
		};
	}

	async verifyLatestPayment(userId: string) {
		const payment = await this.prisma.payment.findFirst({
			where: {
				userId,
				status: { in: [PaymentStatus.PENDING, PaymentStatus.SUCCEEDED] }
			},
			orderBy: { createdAt: 'desc' }
		});

		if (!payment) {
			throw new BadRequestException('Платёж не найден');
		}

		if (payment.status === PaymentStatus.SUCCEEDED) {
			return { activated: true };
		}

		await this.handlePaymentSucceeded(payment.yookassaId);

		const updated = await this.prisma.payment.findUnique({
			where: { yookassaId: payment.yookassaId }
		});

		return { activated: updated?.status === PaymentStatus.SUCCEEDED };
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
				data: { status: PaymentStatus.SUCCEEDED }
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
			data: { status: PaymentStatus.CANCELLED }
		});

		this.logger.log(`Payment cancelled: yookassaId=${yookassaId}`);
	}
}
