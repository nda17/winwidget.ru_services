import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { AdminActivateSubscriptionDto } from '@/subscription/dto/admin-activate-subscription.dto';
import { SubscriptionService } from '@/subscription/subscription.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';

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

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('admin/list')
	async adminGetAll() {
		return this.subscriptionService.adminGetAllSubscriptions();
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('admin/activate')
	async adminActivate(@Body() dto: AdminActivateSubscriptionDto) {
		return this.subscriptionService.adminActivateSubscription(
			dto.userId,
			dto.plan,
			dto.billingPeriod,
			dto.startsAt ? new Date(dto.startsAt) : undefined,
			dto.extendIfActive
		);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch('admin/:userId/cancel')
	async adminCancel(@Param('userId') userId: string) {
		return this.subscriptionService.adminCancelSubscription(userId);
	}
}
