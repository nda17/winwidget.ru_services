import { AccessJwtService } from '@/auth/access-jwt.service';
import { PrismaService } from '@/prisma.service';
import { USER_DEACTIVATED_MESSAGE } from '@/utils/auth.constants';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';

@Injectable()
export class BillingAuthIntrospectionService {
	constructor(
		private readonly accessJwtService: AccessJwtService,
		private readonly prisma: PrismaService
	) {}

	async introspect(authorization: string | undefined) {
		const accessToken = this.getBearerToken(authorization);
		const payload = this.accessJwtService.verifyAccessToken(accessToken);
		const session = await this.prisma.userSession.findFirst({
			where: {
				id: payload.sid,
				userId: payload.sub,
				revokedAt: null,
				expiresAt: { gt: new Date() }
			},
			select: { id: true }
		});

		if (!session) {
			throw new UnauthorizedException('Invalid session');
		}
		const user = await this.prisma.user.findUnique({
			where: { id: payload.sub },
			select: {
				id: true,
				status: true,
				deletedAt: true,
				rights: true
			}
		});
		if (
			!user ||
			user.status === UserStatus.DEACTIVATED ||
			user.deletedAt
		) {
			throw new UnauthorizedException(USER_DEACTIVATED_MESSAGE);
		}

		return {
			active: true as const,
			subject: user.id,
			sessionId: session.id,
			roles: user.rights
		};
	}

	private getBearerToken(authorization: string | undefined): string {
		if (!authorization) {
			throw new UnauthorizedException('Access token not passed');
		}
		const parts = authorization.split(' ');
		if (
			parts.length !== 2 ||
			parts[0] !== 'Bearer' ||
			!parts[1] ||
			parts[1].length > 16 * 1024
		) {
			throw new UnauthorizedException('Invalid access token');
		}
		return parts[1];
	}
}
