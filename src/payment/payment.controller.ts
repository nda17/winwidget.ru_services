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
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('payments')
export class PaymentController {
	constructor(
		private readonly paymentService: PaymentService,
		private readonly paymentCleanupService: PaymentCleanupService
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
	async adminCheckPayment(@Body() dto: AdminCheckPaymentDto) {
		return this.paymentService.adminCheckPayment(dto.paymentId);
	}

	@HttpCode(200)
	@Post('admin/run-cleanup')
	@Auth(Role.ADMIN)
	async runCleanup() {
		const deletedCount =
			await this.paymentCleanupService.runManualCleanup();

		return {
			taskId: 'paymentCleanup',
			title: 'Очистка зависших платежей',
			affectedCount: deletedCount,
			message:
				deletedCount > 0
					? `Удалено ${deletedCount} зависших платежей.`
					: 'Зависшие платежи не найдены.',
			executedAt: new Date().toISOString()
		};
	}

	@Post('webhook')
	async webhook(@Body() body: any) {
		return this.paymentService.handleWebhook(body);
	}
}
