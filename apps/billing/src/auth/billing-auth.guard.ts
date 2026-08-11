import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	SetMetadata,
	UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CoreInternalClient } from '../internal/core-internal.client';
import type { BillingRequest, BillingRole } from './billing-request';

export const BILLING_REQUIRED_ROLES = 'billing-required-roles';

export const BillingAuth = (roles: BillingRole[] = []) =>
	SetMetadata(BILLING_REQUIRED_ROLES, roles);

@Injectable()
export class BillingAuthGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly core: CoreInternalClient
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<BillingRequest>();
		const authorization = this.requireAuthorization(
			request.headers.authorization
		);
		const required = this.reflector.getAllAndOverride<BillingRole[]>(
			BILLING_REQUIRED_ROLES,
			[context.getHandler(), context.getClass()]
		);
		if (!required) {
			throw new ForbiddenException(
				'Billing endpoint has no access policy'
			);
		}
		const actor = await this.core.introspect(authorization);
		if (
			required.length > 0 &&
			!required.some(role => actor.roles.includes(role))
		) {
			throw new ForbiddenException('У тебя нет прав!');
		}
		request.billingActor = actor;
		return true;
	}

	private requireAuthorization(value: string | undefined): string {
		if (!value) {
			throw new UnauthorizedException('Access token not passed');
		}
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
