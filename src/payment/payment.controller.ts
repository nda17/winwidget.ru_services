import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import {
	AdminCheckPaymentDto,
	CreatePaymentDto
} from '@/payment/dto/create-payment.dto';
import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import { PaymentService } from '@/payment/payment.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Post,
	Query,
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

@Controller('payments')
export class PaymentController {
	constructor(
		private readonly paymentService: PaymentService,
		private readonly paymentCleanupService: PaymentCleanupService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@Post('create')
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async createPayment(
		@CurrentUser('id') userId: string,
		@Body() dto: CreatePaymentDto
	) {
		return this.paymentService.createPayment(
			userId,
			dto.plan,
			dto.billingPeriod
		);
	}

	@Post('verify')
	@Auth()
	async verifyPayment(@CurrentUser('id') userId: string) {
		return this.paymentService.verifyLatestPayment(userId);
	}

	@HttpCode(200)
	@Get('pending')
	@Auth()
	async getPendingPayment(@CurrentUser('id') userId: string) {
		return this.paymentService.getPendingPayment(userId);
	}

	@HttpCode(200)
	@Post('pending/cancel')
	@Auth()
	async cancelPendingPayment(@CurrentUser('id') userId: string) {
		return this.paymentService.cancelPendingPayment(userId);
	}

	@HttpCode(200)
	@Get('admin/list')
	@Auth(Role.ADMIN)
	async adminGetPayments(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('status') status?: string
	) {
		return this.paymentService.adminGetPayments(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			status
		);
	}

	@HttpCode(200)
	@Post('admin/check')
	@Auth(Role.ADMIN)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async adminCheckPayment(
		@Body() dto: AdminCheckPaymentDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const result = await this.paymentService.adminCheckPayment(
			dto.paymentId
		);

		await this.adminEventLogService.record({
			adminId,
			section: 'PAYMENTS',
			action: 'PAYMENT_MANUAL_CHECK',
			description: `Ручная проверка платежа ${result.payment.yookassaId}`,
			entityType: 'payment',
			entityId: result.payment.id,
			entityLabel: result.payment.yookassaId,
			targetUserId: result.payment.user.id,
			metadata: {
				requestedPaymentId: dto.paymentId.trim(),
				providerStatus: result.providerStatus,
				localStatus: result.payment.status,
				message: result.message,
				checkedAt: result.checkedAt
			},
			request
		});

		return result;
	}

	@HttpCode(200)
	@Post('admin/run-cleanup')
	@Auth(Role.ADMIN)
	async runCleanup(
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const deletedCount =
			await this.paymentCleanupService.runManualCleanup();

		const result = {
			taskId: 'paymentCleanup',
			title: 'Очистка зависших платежей',
			affectedCount: deletedCount,
			message:
				deletedCount > 0
					? `Удалено ${deletedCount} зависших платежей.`
					: 'Зависшие платежи не найдены.',
			executedAt: new Date().toISOString()
		};

		await this.adminEventLogService.record({
			adminId,
			section: 'TASKS',
			action: 'PAYMENT_CLEANUP_RUN',
			description: result.title,
			entityType: 'manual_task',
			entityId: result.taskId,
			entityLabel: result.title,
			metadata: result,
			request
		});

		return result;
	}

	@Post('webhook')
	async webhook(@Body() body: any) {
		return this.paymentService.handleWebhook(body);
	}
}
