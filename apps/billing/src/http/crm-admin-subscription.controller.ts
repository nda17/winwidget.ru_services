import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Header,
	Headers,
	HttpCode,
	Param,
	ParseUUIDPipe,
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
import { CrmAdminSubscriptionService } from '../domain/crm-admin-subscription.service';
import {
	CrmAdminSubscriptionListDto,
	CrmAdminSubscriptionPageDto,
	CancelCrmSubscriptionGrantDto,
	ExtendCrmSubscriptionDaysDto
} from './crm-admin-subscription.dto';

@Controller('subscriptions/admin/crm')
@BillingAuth(['ADMIN', 'DEV'])
@UseGuards(BillingAuthGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class CrmAdminSubscriptionController {
	constructor(
		private readonly subscriptions: CrmAdminSubscriptionService
	) {}

	@Get()
	@Header('Cache-Control', 'no-store')
	list(
		@Query() query: CrmAdminSubscriptionListDto,
		@CurrentBillingActor() actor: BillingActor
	) {
		return this.subscriptions.list(query, actor);
	}

	@Get(':workspaceId')
	@Header('Cache-Control', 'no-store')
	detail(
		@Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string,
		@CurrentBillingActor() actor: BillingActor
	) {
		return this.subscriptions.detail(workspaceId, actor);
	}

	@Get(':workspaceId/history')
	@Header('Cache-Control', 'no-store')
	history(
		@Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string,
		@Query() query: CrmAdminSubscriptionPageDto,
		@CurrentBillingActor() actor: BillingActor
	) {
		return this.subscriptions.history(workspaceId, query, actor);
	}

	@Get(':workspaceId/commands/:commandId')
	@Header('Cache-Control', 'no-store')
	command(
		@Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string,
		@Param('commandId', new ParseUUIDPipe({ version: '4' }))
		commandId: string,
		@CurrentBillingActor() actor: BillingActor
	) {
		return this.subscriptions.command(workspaceId, commandId, actor);
	}

	@Post(':workspaceId/extend-days')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	extend(
		@Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string,
		@Body() dto: ExtendCrmSubscriptionDaysDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request,
		@Headers('idempotency-key') key?: string
	) {
		if (key !== dto.commandId)
			throw new BadRequestException({
				code: 'crm_admin_subscription_idempotency_key_mismatch',
				message: 'Idempotency-Key must match commandId'
			});
		return this.subscriptions.extend(workspaceId, dto, {
			actor,
			...getBillingClientContext(request)
		});
	}

	@Post(':workspaceId/commands/:commandId/cancel')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	cancel(
		@Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string,
		@Param('commandId', new ParseUUIDPipe({ version: '4' }))
		commandId: string,
		@Body() dto: CancelCrmSubscriptionGrantDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request,
		@Headers('idempotency-key') key?: string
	) {
		if (key !== commandId)
			throw new BadRequestException({
				code: 'crm_admin_subscription_idempotency_key_mismatch',
				message: 'Idempotency-Key must match original commandId'
			});
		return this.subscriptions.cancel(workspaceId, commandId, dto, {
			actor,
			...getBillingClientContext(request)
		});
	}
}
