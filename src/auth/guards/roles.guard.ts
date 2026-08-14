import type {
	PlatformIdentityActor,
	PlatformRole
} from '@/auth/decorators/roles.decorator';
import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

type PlatformRequest = Request & { user?: PlatformIdentityActor };

@Injectable()
export class RolesGuard implements CanActivate {
	constructor(private reflector: Reflector) {}

	canActivate(context: ExecutionContext): boolean {
		const roles = this.reflector.getAllAndOverride<PlatformRole[]>(
			'roles',
			[context.getHandler(), context.getClass()]
		);
		if (!roles) {
			return true;
		}

		const request = context.switchToHttp().getRequest<PlatformRequest>();
		const user = request.user;
		if (!user) {
			throw new ForbiddenException('У тебя нет прав!');
		}

		const hasRole = () => user.rights.some(role => roles.includes(role));
		if (!hasRole()) {
			throw new ForbiddenException('У тебя нет прав!');
		}

		return true;
	}
}
