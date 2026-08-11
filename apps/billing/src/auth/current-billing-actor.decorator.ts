import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { BillingRequest } from './billing-request';

export const CurrentBillingActor = createParamDecorator(
	(_data: unknown, context: ExecutionContext) =>
		context.switchToHttp().getRequest<BillingRequest>().billingActor
);
