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
import type {
	OperationsRequest,
	OperationsRole
} from './operations-request';

export const OPERATIONS_REQUIRED_ROLES = 'operations-required-roles';
export const OperationsAuth = (roles: OperationsRole[] = []) =>
	SetMetadata(OPERATIONS_REQUIRED_ROLES, roles);

@Injectable()
export class OperationsAuthGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly identity: IdentityIntrospectionClient
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<OperationsRequest>();
		const authorization = this.requireAuthorization(
			request.headers.authorization
		);
		const required = this.reflector.getAllAndOverride<OperationsRole[]>(
			OPERATIONS_REQUIRED_ROLES,
			[context.getHandler(), context.getClass()]
		);
		if (!required) {
			throw new ForbiddenException(
				'Operations endpoint has no access policy'
			);
		}
		const actor = await this.identity.introspect(authorization);
		if (
			required.length > 0 &&
			!required.some(role => actor.roles.includes(role))
		) {
			throw new ForbiddenException('У тебя нет прав!');
		}
		request.operationsActor = actor;
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
