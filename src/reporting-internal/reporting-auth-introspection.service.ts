import { AccessJwtService } from '@/auth/access-jwt.service';
import { PrismaService } from '@/prisma.service';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';

@Injectable()
export class ReportingAuthIntrospectionService {
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
				expiresAt: { gt: new Date() },
				user: {
					status: UserStatus.ACTIVE,
					deletedAt: null
				}
			},
			select: {
				id: true,
				user: {
					select: {
						id: true,
						rights: true
					}
				}
			}
		});

		if (!session) {
			throw new UnauthorizedException('Invalid session');
		}

		return {
			active: true as const,
			subject: session.user.id,
			sessionId: session.id,
			roles: session.user.rights
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
