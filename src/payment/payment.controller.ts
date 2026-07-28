import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import {
	AdminAutoRenewalActionDto,
	AdminCheckPaymentDto,
	CreatePaymentDto,
	VerifyPaymentDto
} from '@/payment/dto/create-payment.dto';
import { AutoRenewalService } from '@/payment/auto-renewal.service';
import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import { PaymentService } from '@/payment/payment.service';
import { getClientIp } from '@/utils/ip.util';
import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
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
		private readonly autoRenewalService: AutoRenewalService,
		private readonly paymentCleanupService: PaymentCleanupService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@Post('create')
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async createPayment(
		@CurrentUser('id') userId: string,
		@Body() dto: CreatePaymentDto,
		@Req() request: Request
	) {
		return this.paymentService.createPayment(
			userId,
			dto.plan,
			dto.billingPeriod,
			dto.expectedAmount,
			dto.autoRenew ?? false,
			dto.consentVersion,
			this.getRequestContext(request)
		);
	}

	@Post('verify')
	@Auth()
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async verifyPayment(
		@CurrentUser('id') userId: string,
		@Body() dto?: VerifyPaymentDto
	) {
		return this.paymentService.verifyPayment(userId, dto?.paymentId);
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
	@Get('history')
	@Auth()
	async getPaymentHistory(
		@CurrentUser('id') userId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.paymentService.getPaymentHistory(
			userId,
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 10
		);
	}

	@HttpCode(200)
	@Get('auto-renewal')
	@Auth()
	getAutoRenewal(@CurrentUser('id') userId: string) {
		return this.autoRenewalService.getForUser(userId);
	}

	@HttpCode(200)
	@Delete('auto-renewal')
	@Auth()
	disableAutoRenewal(
		@CurrentUser('id') userId: string,
		@Req() request: Request
	) {
		return this.autoRenewalService.disableByUser(
			userId,
			this.getRequestContext(request)
		);
	}

	@HttpCode(200)
	@Post('auto-renewal/confirm-price')
	@Auth()
	confirmAutoRenewalPrice(
		@CurrentUser('id') userId: string,
		@Req() request: Request
	) {
		return this.autoRenewalService.confirmCurrentPrice(
			userId,
			this.getRequestContext(request)
		);
	}

	@HttpCode(200)
	@Get('admin/list')
	@Auth(Role.ADMIN)
	async adminGetPayments(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('status') status?: string,
		@Query('plan') plan?: string,
		@Query('billingPeriod') billingPeriod?: string,
		@Query('createdFrom') createdFrom?: string,
		@Query('createdTo') createdTo?: string,
		@Query('search') search?: string
	) {
		return this.paymentService.adminGetPayments(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{
				status,
				plan,
				billingPeriod,
				createdFrom,
				createdTo,
				search
			}
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
		const expiredCount =
			await this.paymentCleanupService.runManualCleanup();

		const result = {
			taskId: 'paymentCleanup',
			title: 'Сверка просроченных платёжных попыток',
			affectedCount: expiredCount,
			message:
				expiredCount > 0
					? `Помечено просроченными: ${expiredCount}.`
					: 'Новые просроченные попытки не найдены.',
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

	@HttpCode(200)
	@Get('admin/auto-renewals/:userId')
	@Auth([Role.ADMIN, Role.DEV])
	getAdminAutoRenewal(
		@Param('userId') userId: string,
		@CurrentUser('rights') adminRights: Role[] = []
	) {
		return this.autoRenewalService.getForAdmin(
			userId,
			adminRights.includes(Role.DEV)
		);
	}

	@HttpCode(200)
	@Post('admin/auto-renewals/:userId/pause')
	@Auth([Role.ADMIN, Role.DEV])
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async pauseAdminAutoRenewal(
		@Param('userId') userId: string,
		@Body() dto: AdminAutoRenewalActionDto,
		@CurrentUser('id') adminId: string,
		@CurrentUser('rights') adminRights: Role[] = [],
		@Req() request: Request
	) {
		const result = await this.autoRenewalService.pauseByAdmin(
			userId,
			adminId,
			this.getAdminRole(adminRights),
			dto.reason
		);
		await this.recordAutoRenewalAction({
			action: 'AUTO_RENEWAL_ADMIN_PAUSE',
			description: 'Автопродление пользователя приостановлено',
			userId,
			adminId,
			reason: dto.reason,
			result,
			request
		});
		return result;
	}

	@HttpCode(200)
	@Post('admin/auto-renewals/:userId/resume')
	@Auth([Role.ADMIN, Role.DEV])
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async resumeAdminAutoRenewal(
		@Param('userId') userId: string,
		@Body() dto: AdminAutoRenewalActionDto,
		@CurrentUser('id') adminId: string,
		@CurrentUser('rights') adminRights: Role[] = [],
		@Req() request: Request
	) {
		const result = await this.autoRenewalService.resumeAdminPause(
			userId,
			adminId,
			this.getAdminRole(adminRights),
			dto.reason
		);
		await this.recordAutoRenewalAction({
			action: 'AUTO_RENEWAL_ADMIN_RESUME',
			description: 'Автопродление пользователя возобновлено',
			userId,
			adminId,
			reason: dto.reason,
			result,
			request
		});
		return result;
	}

	@HttpCode(200)
	@Post('admin/auto-renewals/:userId/revoke')
	@Auth([Role.ADMIN, Role.DEV])
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async revokeAdminAutoRenewal(
		@Param('userId') userId: string,
		@Body() dto: AdminAutoRenewalActionDto,
		@CurrentUser('id') adminId: string,
		@CurrentUser('rights') adminRights: Role[] = [],
		@Req() request: Request
	) {
		const result = await this.autoRenewalService.revokeByAdmin(
			userId,
			adminId,
			this.getAdminRole(adminRights),
			dto.reason
		);
		await this.recordAutoRenewalAction({
			action: 'AUTO_RENEWAL_REVOKE',
			description: 'Согласие пользователя на автопродление отозвано',
			userId,
			adminId,
			reason: dto.reason,
			result,
			request
		});
		return result;
	}

	@HttpCode(200)
	@Post('dev/auto-renewals/:userId/reconcile')
	@Auth(Role.DEV)
	async reconcileAutoRenewal(
		@Param('userId') userId: string,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const result = await this.autoRenewalService.reconcileByDev(userId);
		await this.recordAutoRenewalAction({
			action: 'AUTO_RENEWAL_RECONCILE',
			description: 'Выполнена техническая сверка автопродления',
			userId,
			adminId,
			result,
			request
		});
		return result;
	}

	@HttpCode(200)
	@Post('dev/auto-renewals/:userId/resume-technical')
	@Auth(Role.DEV)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async resumeTechnicalAutoRenewal(
		@Param('userId') userId: string,
		@Body() dto: AdminAutoRenewalActionDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const result = await this.autoRenewalService.resumeTechnicalPause(
			userId,
			adminId,
			dto.reason
		);
		await this.recordAutoRenewalAction({
			action: 'AUTO_RENEWAL_TECHNICAL_RESUME',
			description: 'Техническая пауза автопродления снята',
			userId,
			adminId,
			reason: dto.reason,
			result,
			request
		});
		return result;
	}

	@Post('webhook')
	async webhook(@Body() body: any) {
		return this.paymentService.handleWebhook(body);
	}

	private getRequestContext(request: Request) {
		return {
			ip: getClientIp(request),
			userAgent: request.get('user-agent') ?? null
		};
	}

	private getAdminRole(rights: Role[]) {
		return rights.includes(Role.DEV) ? Role.DEV : Role.ADMIN;
	}

	private async recordAutoRenewalAction(input: {
		action:
			| 'AUTO_RENEWAL_ADMIN_PAUSE'
			| 'AUTO_RENEWAL_ADMIN_RESUME'
			| 'AUTO_RENEWAL_REVOKE'
			| 'AUTO_RENEWAL_RECONCILE'
			| 'AUTO_RENEWAL_TECHNICAL_RESUME';
		description: string;
		userId: string;
		adminId: string;
		reason?: string;
		result: Awaited<
			ReturnType<
				| AutoRenewalService['pauseByAdmin']
				| AutoRenewalService['resumeAdminPause']
				| AutoRenewalService['revokeByAdmin']
				| AutoRenewalService['reconcileByDev']
				| AutoRenewalService['resumeTechnicalPause']
			>
		>;
		request: Request;
	}) {
		const renewal = input.result.autoRenewal;
		await this.adminEventLogService.record({
			adminId: input.adminId,
			section: 'PAYMENTS',
			action: input.action,
			description: input.description,
			entityType: 'auto_renewal',
			entityId: renewal.id,
			entityLabel: renewal.id ?? input.userId,
			targetUserId: input.userId,
			metadata: {
				reason: input.reason ?? null,
				status: renewal.status,
				amount: renewal.amount,
				currency: renewal.currency,
				nextChargeAt: renewal.nextChargeAt,
				priceChangeRequired: renewal.priceChange.required,
				result: input.result.message
			},
			request: input.request
		});
	}
}
