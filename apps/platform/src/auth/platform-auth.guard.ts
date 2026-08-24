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
import type { PlatformRequest, PlatformRole } from './platform-request';

export const PLATFORM_REQUIRED_ROLES = 'platform-required-roles';
export const PlatformAuth = (roles: PlatformRole[] = []) =>
	SetMetadata(PLATFORM_REQUIRED_ROLES, roles);

@Injectable()
export class PlatformAuthGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly identity: IdentityIntrospectionClient
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<PlatformRequest>();
		const authorization = this.requireAuthorization(
			request.headers.authorization
		);
		const required = this.reflector.getAllAndOverride<PlatformRole[]>(
			PLATFORM_REQUIRED_ROLES,
			[context.getHandler(), context.getClass()]
		);
		if (!required) {
			throw new ForbiddenException(
				'Platform endpoint has no access policy'
			);
		}
		const actor = await this.identity.introspect(authorization);
		if (
			required.length > 0 &&
			!required.some(role => actor.roles.includes(role))
		) {
			throw new ForbiddenException('У тебя нет прав!');
		}
		request.platformActor = actor;
		return true;
	}

	private requireAuthorization(value: string | undefined): string {
		if (!value) throw new UnauthorizedException();
		const parts = value.split(' ');
		if (
			parts.length !== 2 ||
			parts[0] !== 'Bearer' ||
			!parts[1] ||
			parts[1].length > 16 * 1024
		) {
			throw new UnauthorizedException('Invalid access token');
		}
		return value;
	}
}
