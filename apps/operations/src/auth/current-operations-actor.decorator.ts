import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { OperationsRequest } from './operations-request';

export const CurrentOperationsActor = createParamDecorator(
	(_data: unknown, context: ExecutionContext) =>
		context.switchToHttp().getRequest<OperationsRequest>().operationsActor
);
