import { YookassaService } from '@/payment/yookassa.service';
import { PrismaService } from '@/prisma.service';
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { AuthIdentityType, PaymentStatus, Role } from '@prisma/client';

@Injectable()
export class PaymentService {
	private readonly PREMIUM_PRICE = '100.00';
	private readonly RETURN_URL = `${process.env.RECAPTCHA_CLIENT_URL}/payment/success`;
	private readonly logger = new Logger(PaymentService.name);

	constructor(
		private prisma: PrismaService,
		private yookassa: YookassaService
	) {}

	async createPremiumPayment(userId: string) {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			include: { authIdentities: true }
		});

		if (!user) {
			throw new BadRequestException('Пользователь не найден');
		}

		if (user.rights.includes(Role.PREMIUM)) {
			throw new BadRequestException('У вас уже есть подписка PREMIUM');
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

		const yookassaPayment = await this.yookassa.createPayment({
			amount: this.PREMIUM_PRICE,
			description: 'Подписка PREMIUM — winwidget.ru',
			returnUrl: this.RETURN_URL,
			userId,
			customerEmail: emailIdentity?.value,
			customerPhone: phoneIdentity?.value
		});

		await this.prisma.payment.create({
			data: {
				userId,
				yookassaId: yookassaPayment.id,
				amount: this.PREMIUM_PRICE,
				status: PaymentStatus.PENDING
			}
		});

		this.logger.log(
			`Payment created: yookassaId=${yookassaPayment.id} userId=${userId}`
		);

		return {
			confirmationUrl: yookassaPayment.confirmation.confirmation_url
		};
	}

	async verifyLatestPayment(userId: string) {
		// Ищем последний платёж пользователя (PENDING или SUCCEEDED)
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

		if (!userId) {
			return;
		}

		await this.prisma.$transaction([
			this.prisma.payment.update({
				where: { yookassaId },
				data: { status: PaymentStatus.SUCCEEDED }
			}),
			this.prisma.user.update({
				where: { id: userId },
				data: {
					rights: { push: Role.PREMIUM }
				}
			})
		]);

		this.logger.log(
			`Payment succeeded: yookassaId=${yookassaId} userId=${userId}`
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
