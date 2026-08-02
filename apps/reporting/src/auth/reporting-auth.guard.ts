import { CoreInternalClient } from '../internal/core-internal.client';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import type { ReportingRequest } from './reporting-request';
import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	SetMetadata,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const REPORTING_REQUIRED_ROLE = 'reporting-required-role';
export type ReportingRequiredRole = 'ADMIN' | 'DEV';
export const RequireReportingRole = (role: ReportingRequiredRole) =>
	SetMetadata(REPORTING_REQUIRED_ROLE, role);

@Injectable()
export class ReportingApiGuard implements CanActivate {
	constructor(private readonly runtime: ReportingRuntimeService) {}

	canActivate(): boolean {
		if (!this.runtime.apiEnabled) {
			throw new ServiceUnavailableException(
				'Reporting API is disabled for this process role'
			);
		}
		return true;
	}
}

@Injectable()
export class ReportingAdminGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly coreInternal: CoreInternalClient
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<ReportingRequest>();
		const authorization = request.headers.authorization?.trim() || '';
		if (!authorization.toLowerCase().startsWith('bearer ')) {
			throw new UnauthorizedException('Bearer token is required');
		}
		// Forwarded role/user headers are intentionally ignored. Only the
		// fail-closed core introspection result is trusted for authorization.
		const actor = await this.coreInternal.introspect(authorization);
		const requiredRole =
			this.reflector.getAllAndOverride<ReportingRequiredRole>(
				REPORTING_REQUIRED_ROLE,
				[context.getHandler(), context.getClass()]
			);
		if (!requiredRole) {
			throw new ForbiddenException(
				'Reporting endpoint has no access policy'
			);
		}
		if (!actor.roles.includes(requiredRole)) {
			throw new ForbiddenException(`${requiredRole} role is required`);
		}
		request.reportingActor = actor;
		return true;
	}
}
