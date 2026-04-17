import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { SubscriptionService } from '@/subscription/subscription.service';
import { Controller, Get, HttpCode } from '@nestjs/common';

@Controller('subscriptions')
export class SubscriptionController {
	constructor(private readonly subscriptionService: SubscriptionService) {}

	@HttpCode(200)
	@Auth()
	@Get('me')
	async getMySubscription(@CurrentUser('id') userId: string) {
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);

		if (!sub) {
			return this.subscriptionService.getOrCreateTrialSubscription(userId);
		}

		return sub;
	}
}
