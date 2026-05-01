import { UserService } from '@/user/user.service';
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
		private userService: UserService
	) {
		super({
			jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
			ignoreExpiration: false,
			secretOrKey: configService.get('JWT_SECRET')
		});
	}

	async validate({ id }: { id: string }) {
		const user = await this.userService.getUserById(id);

		if (user?.status === UserStatus.DEACTIVATED) {
			throw new UnauthorizedException(USER_DEACTIVATED_MESSAGE);
		}

		return user;
	}
}
