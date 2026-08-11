import { TSocialProfile } from '@/auth/social-media/social-media-auth.types';
import { UserService } from '@/user/user.service';
import { BadRequestException, Injectable } from '@nestjs/common';

@Injectable()
export class SocialMediaAuthService {
	constructor(private readonly userService: UserService) {}

	async login(req: { user: TSocialProfile }, referrerId?: string) {
		if (!req.user) {
			throw new BadRequestException('User not found by social media');
		}

		const result = await this.userService.findOrCreateSocialUserWithResult(
			req.user,
			referrerId
		);

		return result.user;
	}
}
