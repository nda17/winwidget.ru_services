import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Patch,
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
import { SubscriptionDomainService } from '../domain/subscription-domain.service';
import {
	AdminActivateSubscriptionDto,
	AdminExtendSubscriptionDto
} from './billing.dto';

@Controller('subscriptions')
export class SubscriptionController {
	constructor(private readonly subscriptions: SubscriptionDomainService) {}

	@Get('me')
	@HttpCode(200)
	@BillingAuth()
	@UseGuards(BillingAuthGuard)
	me(@CurrentBillingActor() actor: BillingActor) {
		return this.subscriptions.me(actor.subject);
	}

	@Get('admin/list')
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	adminList(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('plan') plan?: string,
		@Query('status') status?: string,
		@Query('billingPeriod') billingPeriod?: string,
		@Query('expiresFrom') expiresFrom?: string,
		@Query('expiresTo') expiresTo?: string
	) {
		return this.subscriptions.adminList(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 15,
			{ plan, status, billingPeriod, expiresFrom, expiresTo }
		);
	}

	@Get('admin/history')
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	history(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('audience') audience?: string,
		@Query('adminId') adminId?: string,
		@Query('createdFrom') createdFrom?: string,
		@Query('createdTo') createdTo?: string
	) {
		return this.subscriptions.history(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 10,
			{ audience, adminId, createdFrom, createdTo }
		);
	}

	@Post('admin/activate')
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	activate(
		@Body() dto: AdminActivateSubscriptionDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.subscriptions.activate(dto, this.admin(actor, request));
	}

	@Post('admin/extend-days')
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	extend(
		@Body() dto: AdminExtendSubscriptionDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.subscriptions.extend(dto, this.admin(actor, request));
	}

	@Patch('admin/:userId/cancel')
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	cancel(
		@Param('userId') userId: string,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.subscriptions.cancel(userId, this.admin(actor, request));
	}

	@Post('admin/run-expiry-check')
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	runExpiry(
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.subscriptions.runExpiryCheck(this.admin(actor, request));
	}

	private admin(actor: BillingActor, request: Request) {
		return {
			id: actor.subject,
			role: actor.roles.includes('DEV')
				? ('DEV' as const)
				: ('ADMIN' as const),
			...getBillingClientContext(request)
		};
	}
}
