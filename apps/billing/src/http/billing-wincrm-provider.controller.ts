import {
	BadRequestException,
	Body,
	Controller,
	Header,
	Headers,
	HttpCode,
	Param,
	Post,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Equals, IsInt, IsUUID, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { BillingAuth, BillingAuthGuard } from '../auth/billing-auth.guard';
import { CurrentBillingActor } from '../auth/current-billing-actor.decorator';
import type { BillingActor } from '../auth/billing-request';
import { getBillingClientContext } from '../common/billing-request-context';
import { WincrmCommerceService } from '../domain/wincrm-commerce.service';

export class RetryWincrmProviderDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') commandId!: string;
	@IsInt() @Min(1) @Max(2147483646) expectedVersion!: number;
}

@Controller('payments/admin/crm-provider-operations')
export class BillingWincrmProviderController {
	constructor(private readonly commerce: WincrmCommerceService) {}
	@Post(':operationId/retry')
	@HttpCode(202)
	@Header('Cache-Control', 'no-store')
	@BillingAuth(['DEV'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		})
	)
	retry(
		@Param('operationId') operationId: string,
		@Body() dto: RetryWincrmProviderDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request,
		@Headers('idempotency-key') key?: string
	) {
		if (key !== dto.commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		return this.commerce.retryProviderOperation(operationId, dto, {
			id: actor.subject,
			role: actor.roles.includes('DEV') ? 'DEV' : 'ADMIN',
			...getBillingClientContext(request)
		});
	}
}
