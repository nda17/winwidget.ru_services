import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { PlatformRequest } from './platform-request';

export const CurrentPlatformActor = createParamDecorator(
	(_data: unknown, context: ExecutionContext) =>
		context.switchToHttp().getRequest<PlatformRequest>().platformActor
);
