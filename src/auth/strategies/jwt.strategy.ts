import {
	AccessJwtService,
	type AccessJwtPayload
} from '@/auth/access-jwt.service';
import { UserService } from '@/user/user.service';
import { PrismaService } from '@/prisma.service';
import { USER_DEACTIVATED_MESSAGE } from '@/utils/auth.constants';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { UserStatus } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(
		private readonly accessJwtService: AccessJwtService,
		private userService: UserService,
		private prisma: PrismaService
	) {
		super({
			jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
			ignoreExpiration: false,
			algorithms: ['RS256'],
			issuer: accessJwtService.issuer,
			audience: accessJwtService.audience,
			jsonWebTokenOptions: {
				clockTolerance: accessJwtService.clockToleranceSeconds
			},
			secretOrKeyProvider: (_request, token, done) => {
				try {
					done(null, accessJwtService.getVerificationKey(token));
				} catch (error) {
					done(error);
				}
			}
		});
	}

	async validate(rawPayload: unknown) {
		const payload: AccessJwtPayload =
			this.accessJwtService.assertAccessTokenPayload(rawPayload);

		const session = await this.prisma.userSession.findFirst({
			where: {
				id: payload.sid,
				userId: payload.sub,
				revokedAt: null,
				expiresAt: { gt: new Date() }
			}
		});

		if (!session) {
			throw new UnauthorizedException('Invalid session');
		}

		const user = await this.userService.getUserById(payload.sub);

		if (
			!user ||
			user.status === UserStatus.DEACTIVATED ||
			user.deletedAt
		) {
			throw new UnauthorizedException(USER_DEACTIVATED_MESSAGE);
		}

		return { ...user, sessionId: payload.sid };
	}
}
