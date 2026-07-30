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
	CAMPAIGNS_REQUIRED_ROLE,
	CampaignsRole
} from './campaigns-auth.decorator';
import type { CampaignsRequest } from './campaigns-request';
import { CoreInternalClient } from '../internal/core-internal.client';
import { CampaignsRuntimeService } from '../runtime/campaigns-runtime.service';

@Injectable()
export class CampaignsApiGuard implements CanActivate {
	constructor(private readonly runtime: CampaignsRuntimeService) {}

	canActivate(): boolean {
		if (!this.runtime.apiEnabled) {
			throw new ServiceUnavailableException(
				'Campaigns API is disabled for this process role'
			);
		}
		return true;
	}
}

@Injectable()
export class CampaignsAuthGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly coreInternal: CoreInternalClient
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<CampaignsRequest>();
		const authorization = request.headers.authorization?.trim() || '';
		if (!authorization.toLowerCase().startsWith('bearer ')) {
			throw new UnauthorizedException('Bearer token is required');
		}

		const actor = await this.coreInternal.introspect(authorization);
		const requiredRole = this.reflector.getAllAndOverride<CampaignsRole>(
			CAMPAIGNS_REQUIRED_ROLE,
			[context.getHandler(), context.getClass()]
		);
		if (!requiredRole) {
			throw new ForbiddenException(
				'Campaigns endpoint has no access policy'
			);
		}
		if (!actor.roles.includes(requiredRole)) {
			throw new ForbiddenException(`${requiredRole} role is required`);
		}
		request.campaignsActor = actor;
		return true;
	}
}
