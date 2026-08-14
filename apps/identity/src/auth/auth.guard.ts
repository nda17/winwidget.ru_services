import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	SetMetadata,
	UnauthorizedException,
	createParamDecorator
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role, UserStatus, type User } from '@prisma/identity-client';
import type { Request } from 'express';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { USER_DEACTIVATED_MESSAGE } from '../common/identity.util';
import { AccessJwtService } from './access-jwt.service';

export interface IdentityActor {
	id: string;
	sessionId: string;
	rights: Role[];
	user: User;
}

type IdentityRequest = Request & { identityActor?: IdentityActor };

export const IDENTITY_ROLES = 'identity_roles';
export const Auth = (...roles: Role[]) =>
	SetMetadata(IDENTITY_ROLES, roles.length ? roles : [Role.USER]);

export const CurrentUser = createParamDecorator(
	(field: keyof IdentityActor | undefined, context: ExecutionContext) => {
		const actor = context
			.switchToHttp()
			.getRequest<IdentityRequest>().identityActor;
		return field ? actor?.[field] : actor;
	}
);

@Injectable()
export class IdentityAuthGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly jwt: AccessJwtService,
		private readonly prisma: IdentityPrismaService
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const roles = this.reflector.getAllAndOverride<Role[]>(
			IDENTITY_ROLES,
			[context.getHandler(), context.getClass()]
		);
		if (!roles) return true;
		const request = context.switchToHttp().getRequest<IdentityRequest>();
		const authorization = request.headers.authorization;
		if (!authorization?.startsWith('Bearer ')) {
			throw new UnauthorizedException('Unauthorized');
		}
		const payload = this.jwt.verify(authorization.slice(7));
		const session = await this.prisma.userSession.findFirst({
			where: {
				id: payload.sid,
				userId: payload.sub,
				revokedAt: null,
				expiresAt: { gt: new Date() }
			},
			include: { user: true }
		});
		if (!session) {
			throw new UnauthorizedException('Invalid session');
		}
		if (
			session.user.status !== UserStatus.ACTIVE ||
			session.user.deletedAt
		) {
			throw new UnauthorizedException(USER_DEACTIVATED_MESSAGE);
		}
		if (!roles.some(role => session.user.rights.includes(role))) {
			throw new ForbiddenException('Forbidden resource');
		}
		request.identityActor = {
			id: session.user.id,
			sessionId: session.id,
			rights: session.user.rights,
			user: session.user
		};
		return true;
	}
}
