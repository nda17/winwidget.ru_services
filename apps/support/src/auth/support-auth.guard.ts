import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	SetMetadata,
	UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdentityIntrospectionClient } from './identity-introspection.client';
import type { SupportRequest, SupportRole } from './support-request';

const SUPPORT_REQUIRED_ROLES = 'support-required-roles';
export const SupportAuth = (roles: SupportRole[]) =>
	SetMetadata(SUPPORT_REQUIRED_ROLES, roles);

@Injectable()
export class SupportAuthGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly identity: IdentityIntrospectionClient
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<SupportRequest>();
		const required = this.reflector.getAllAndOverride<SupportRole[]>(
			SUPPORT_REQUIRED_ROLES,
			[context.getHandler(), context.getClass()]
		);
		if (!required) {
			throw new ForbiddenException(
				'Support endpoint has no access policy'
			);
		}
		const authorization = request.headers.authorization;
		if (!authorization || !/^Bearer [^ ]{1,16384}$/.test(authorization)) {
			throw new UnauthorizedException('Invalid access token');
		}
		const actor = await this.identity.introspect(authorization);
		if (!required.some(role => actor.roles.includes(role))) {
			throw new ForbiddenException('У тебя нет прав!');
		}
		request.supportActor = actor;
		return true;
	}
}
