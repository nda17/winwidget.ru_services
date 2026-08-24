import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { SupportRequest } from './support-request';

export const CurrentSupportActor = createParamDecorator(
	(_data: unknown, context: ExecutionContext) =>
		context.switchToHttp().getRequest<SupportRequest>().supportActor
);
