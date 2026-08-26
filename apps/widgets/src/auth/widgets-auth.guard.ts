import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
	WIDGETS_REQUIRED_ROLES,
	WidgetsRole
} from './widgets-auth.decorator';
import type { WidgetsRequest } from './widgets-request';
import { WidgetsIdentityClient } from '../internal/widgets-identity.client';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';

@Injectable()
export class WidgetsApiGuard implements CanActivate {
	constructor(private readonly runtime: WidgetsRuntimeService) {}

	canActivate(): boolean {
		if (!this.runtime.apiEnabled) {
			throw new ServiceUnavailableException(
				'Widgets API is disabled for this process role'
			);
		}
		return true;
	}
}

@Injectable()
export class WidgetsAuthGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly identity: WidgetsIdentityClient
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<WidgetsRequest>();
		const authorization = request.headers.authorization?.trim() || '';
		if (!authorization.toLowerCase().startsWith('bearer ')) {
			throw new UnauthorizedException('Bearer token is required');
		}

		const actor = await this.identity.introspect(authorization);
		const requiredRoles =
			this.reflector.getAllAndOverride<WidgetsRole[]>(
				WIDGETS_REQUIRED_ROLES,
				[context.getHandler(), context.getClass()]
			) || [];
		if (!requiredRoles.length) {
			throw new ForbiddenException(
				'Widgets endpoint has no access policy'
			);
		}
		if (!requiredRoles.some(role => actor.roles.includes(role))) {
			throw new ForbiddenException('Required role is missing');
		}
		request.widgetsActor = actor;
		return true;
	}
}
