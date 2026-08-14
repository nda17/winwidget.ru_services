import { IdentityInternalClient } from '@/identity-boundary/identity-internal.client';
import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class JwtAuthGuard implements CanActivate {
	constructor(private readonly identity: IdentityInternalClient) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<Request>();
		const authorization = request.headers.authorization;
		if (
			typeof authorization !== 'string' ||
			!/^Bearer [^\s]+$/.test(authorization)
		) {
			throw new UnauthorizedException();
		}

		const actor = await this.identity.introspect(authorization);
		request.user = {
			id: actor.subject,
			rights: actor.roles,
			sessionId: actor.sessionId
		} as never;
		return true;
	}
}
