import {
	Body,
	Controller,
	HttpCode,
	Post,
	Req,
	Res,
	UseGuards
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
	BILLING_IDENTITY_RESOLVE_PATH,
	BILLING_LIFECYCLE_COMPLETE_PATH,
	BILLING_SOURCE_REPAIR_PATH
} from './billing-boundary.constants';
import { BillingIdentityDirectoryService } from './billing-identity-directory.service';
import { BillingLifecycleCompletionService } from './billing-lifecycle-completion.service';
import { BillingInternalTokenGuard } from './billing-internal-token.guard';
import { BillingSourceRepairService } from './billing-source-repair.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller()
@UseGuards(BillingInternalTokenGuard)
export class BillingInternalController {
	constructor(
		private readonly identities: BillingIdentityDirectoryService,
		private readonly repairs: BillingSourceRepairService,
		private readonly lifecycle: BillingLifecycleCompletionService
	) {}

	@Post(BILLING_LIFECYCLE_COMPLETE_PATH)
	@HttpCode(200)
	completeLifecycle(
		@Body() body: unknown,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		this.setCorrelationId(request, response);
		return this.lifecycle.complete(body);
	}

	@Post(BILLING_IDENTITY_RESOLVE_PATH)
	@HttpCode(200)
	resolveIdentities(
		@Body() body: unknown,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		this.setCorrelationId(request, response);
		return this.identities.resolve(body);
	}

	@Post(BILLING_SOURCE_REPAIR_PATH)
	@HttpCode(200)
	repairSourceEvents(
		@Body() body: unknown,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		this.setCorrelationId(request, response);
		return this.repairs.repair(body);
	}

	private setCorrelationId(request: Request, response: Response): string {
		const supplied = request.headers['x-correlation-id'];
		const correlationId =
			typeof supplied === 'string' && UUID_PATTERN.test(supplied)
				? supplied
				: randomUUID();
		response.setHeader('X-Correlation-ID', correlationId);
		return correlationId;
	}
}
