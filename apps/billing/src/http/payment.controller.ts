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
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Request } from 'express';
import { BillingAuth, BillingAuthGuard } from '../auth/billing-auth.guard';
import { CurrentBillingActor } from '../auth/current-billing-actor.decorator';
import type { BillingActor } from '../auth/billing-request';
import { getBillingClientContext } from '../common/billing-request-context';
import {
	BILLING_PAYMENT_WEBHOOK_SUBPATH,
	PaymentDomainService
} from '../domain/payment-domain.service';
import {
	AdminAutoRenewalActionDto,
	AdminPaymentCheckDto,
	CancelPaymentDto,
	CreatePaymentDto,
	DevResolveUnknownProviderPaymentDto,
	VerifyPaymentDto
} from './billing.dto';

@Controller('payments')
export class PaymentController {
	constructor(private readonly payments: PaymentDomainService) {}

	@Post('create')
	@BillingAuth()
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	create(
		@Body() dto: CreatePaymentDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.payments.create(
			actor.subject,
			dto,
			getBillingClientContext(request)
		);
	}

	@Post('verify')
	@BillingAuth()
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	verify(
		@CurrentBillingActor() actor: BillingActor,
		@Body() dto?: VerifyPaymentDto
	) {
		return this.payments.verify(actor.subject, dto?.paymentId);
	}

	@Get('pending')
	@HttpCode(200)
	@BillingAuth()
	@UseGuards(BillingAuthGuard)
	pending(@CurrentBillingActor() actor: BillingActor) {
		return this.payments.pending(actor.subject);
	}

	@Post('pending/cancel')
	@HttpCode(200)
	@BillingAuth()
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	cancelPending(
		@Body() dto: CancelPaymentDto,
		@CurrentBillingActor() actor: BillingActor
	) {
		return this.payments.cancelPending(actor.subject, dto.paymentId);
	}

	@Get('history')
	@HttpCode(200)
	@BillingAuth()
	@UseGuards(BillingAuthGuard)
	history(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@CurrentBillingActor() actor?: BillingActor
	) {
		return this.payments.history(
			actor!.subject,
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 10
		);
	}

	@Get('auto-renewal')
	@HttpCode(200)
	@BillingAuth()
	@UseGuards(BillingAuthGuard)
	autoRenewal(@CurrentBillingActor() actor: BillingActor) {
		return this.payments.userAutoRenewal(actor.subject);
	}

	@Delete('auto-renewal')
	@HttpCode(200)
	@BillingAuth()
	@UseGuards(BillingAuthGuard)
	disableAutoRenewal(
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.payments.disableUserAutoRenewal(
			actor.subject,
			getBillingClientContext(request)
		);
	}

	@Post('auto-renewal/confirm-price')
	@HttpCode(200)
	@BillingAuth()
	@UseGuards(BillingAuthGuard)
	confirmPrice(
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.payments.confirmPrice(
			actor.subject,
			getBillingClientContext(request)
		);
	}

	@Get('admin/list')
	@HttpCode(200)
	@BillingAuth(['ADMIN', 'DEV'])
	@UseGuards(BillingAuthGuard)
	adminList(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('status') status?: string,
		@Query('plan') plan?: string,
		@Query('billingPeriod') billingPeriod?: string,
		@Query('createdFrom') createdFrom?: string,
		@Query('createdTo') createdTo?: string,
		@Query('search') search?: string
	) {
		return this.payments.adminList(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{ status, plan, billingPeriod, createdFrom, createdTo, search }
		);
	}

	@Post('admin/check')
	@HttpCode(200)
	@BillingAuth(['ADMIN', 'DEV'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async adminCheck(
		@Body() dto: AdminPaymentCheckDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		const result = await this.payments.adminCheck(dto.paymentId);
		await this.payments.adminAudit(
			this.admin(actor, request),
			'PAYMENT_MANUAL_CHECK',
			result.payment.user.id,
			{
				paymentId: result.payment.id,
				yookassaId: result.payment.yookassaId,
				requestedPaymentId: dto.paymentId.trim(),
				providerStatus: result.providerStatus,
				localStatus: result.payment.status,
				message: result.message,
				checkedAt: result.checkedAt
			}
		);
		return result;
	}

	@Post('admin/run-cleanup')
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	runCleanup(
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.payments.runCleanup(this.admin(actor, request));
	}

	@Get('admin/auto-renewals/:userId')
	@HttpCode(200)
	@BillingAuth(['ADMIN', 'DEV'])
	@UseGuards(BillingAuthGuard)
	adminAutoRenewal(
		@Param('userId') userId: string,
		@CurrentBillingActor() actor: BillingActor
	) {
		return this.payments.adminAutoRenewal(
			userId,
			actor.roles.includes('DEV')
		);
	}

	@Post('admin/auto-renewals/:userId/pause')
	@HttpCode(200)
	@BillingAuth(['ADMIN', 'DEV'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	pause(
		@Param('userId') userId: string,
		@Body() dto: AdminAutoRenewalActionDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.payments.adminRenewalAction(
			userId,
			'pause',
			dto,
			this.admin(actor, request)
		);
	}

	@Post('admin/auto-renewals/:userId/resume')
	@HttpCode(200)
	@BillingAuth(['ADMIN', 'DEV'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	resume(
		@Param('userId') userId: string,
		@Body() dto: AdminAutoRenewalActionDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.payments.adminRenewalAction(
			userId,
			'resume',
			dto,
			this.admin(actor, request)
		);
	}

	@Post('admin/auto-renewals/:userId/revoke')
	@HttpCode(200)
	@BillingAuth(['ADMIN', 'DEV'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	revoke(
		@Param('userId') userId: string,
		@Body() dto: AdminAutoRenewalActionDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.payments.adminRenewalAction(
			userId,
			'revoke',
			dto,
			this.admin(actor, request)
		);
	}

	@Post('dev/auto-renewals/:userId/reconcile')
	@HttpCode(200)
	@BillingAuth(['DEV'])
	@UseGuards(BillingAuthGuard)
	reconcile(
		@Param('userId') userId: string,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.payments.reconcile(userId, this.admin(actor, request));
	}

	@Post('dev/auto-renewals/:userId/resume-technical')
	@HttpCode(200)
	@BillingAuth(['DEV'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	resumeTechnical(
		@Param('userId') userId: string,
		@Body() dto: AdminAutoRenewalActionDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.payments.adminRenewalAction(
			userId,
			'resume-technical',
			dto,
			this.admin(actor, request)
		);
	}

	@Get('dev/unknown-provider/:paymentId/evidence')
	@HttpCode(200)
	@BillingAuth(['DEV'])
	@UseGuards(BillingAuthGuard)
	unknownProviderPaymentEvidence(@Param('paymentId') paymentId: string) {
		return this.payments.unknownProviderPaymentEvidence(paymentId);
	}

	@Post('dev/unknown-provider/resolve')
	@HttpCode(200)
	@BillingAuth(['DEV'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		})
	)
	resolveUnknownProviderPayment(
		@Body() dto: DevResolveUnknownProviderPaymentDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.payments.resolveUnknownProviderPayment(
			dto,
			this.admin(actor, request)
		);
	}

	@Post(BILLING_PAYMENT_WEBHOOK_SUBPATH)
	@HttpCode(200)
	webhook(@Body() body: unknown) {
		return this.payments.webhook(body);
	}

	private admin(actor: BillingActor, request: Request) {
		const context = getBillingClientContext(request);
		return {
			id: actor.subject,
			role: actor.roles.includes('DEV')
				? ('DEV' as const)
				: ('ADMIN' as const),
			...context
		};
	}
}
