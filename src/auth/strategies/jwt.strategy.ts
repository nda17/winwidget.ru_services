import { UserService } from '@/user/user.service';
import { PrismaService } from '@/prisma.service';
import { USER_DEACTIVATED_MESSAGE } from '@/utils/auth.constants';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { UserStatus } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
	constructor(
		private configService: ConfigService,
		private userService: UserService,
		private prisma: PrismaService
	) {
		super({
			jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
			ignoreExpiration: false,
			secretOrKey: configService.get('JWT_SECRET')
		});
	}

	async validate({ id, sessionId }: { id: string; sessionId: string }) {
		if (!id || !sessionId) {
			throw new UnauthorizedException('Invalid session');
		}

		const session = await this.prisma.userSession.findFirst({
			where: {
				id: sessionId,
				userId: id,
				revokedAt: null,
				expiresAt: { gt: new Date() }
			}
		});

		if (!session) {
			throw new UnauthorizedException('Invalid session');
		}

		const user = await this.userService.getUserById(id);

		if (!user || user.status === UserStatus.DEACTIVATED) {
			throw new UnauthorizedException(USER_DEACTIVATED_MESSAGE);
		}

		return { ...user, sessionId };
	}
}
