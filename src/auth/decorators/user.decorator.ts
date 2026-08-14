import type { PlatformIdentityActor } from '@/auth/decorators/roles.decorator';
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
	(
		data: keyof PlatformIdentityActor | undefined,
		ctx: ExecutionContext
	) => {
		const request = ctx.switchToHttp().getRequest();
		const user = request.user as PlatformIdentityActor;

		return data ? user[data] : user;
	}
);
