import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import {
	AdminActivateSubscriptionDto,
	AdminExtendSubscriptionDto
} from '@/subscription/dto/admin-activate-subscription.dto';
import { SubscriptionExpiryService } from '@/subscription/subscription-expiry.service';
import { SubscriptionService } from '@/subscription/subscription.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Query,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('subscriptions')
export class SubscriptionController {
	constructor(
		private readonly subscriptionService: SubscriptionService,
		private readonly subscriptionExpiryService: SubscriptionExpiryService
	) {}

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
	async adminGetAll(
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.subscriptionService.adminGetAllSubscriptions(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 15
		);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('admin/history')
	async adminGetHistory(
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.subscriptionService.adminGetSubscriptionHistory(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 10
		);
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
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('admin/extend-days')
	async adminExtendDays(
		@Body() dto: AdminExtendSubscriptionDto,
		@CurrentUser('id') adminId: string
	) {
		return this.subscriptionService.adminExtendSubscriptionDays(
			dto.userId,
			dto.days,
			adminId
		);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch('admin/:userId/cancel')
	async adminCancel(@Param('userId') userId: string) {
		return this.subscriptionService.adminCancelSubscription(userId);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Post('admin/run-expiry-check')
	async runExpiryCheck() {
		const expiredCount =
			await this.subscriptionExpiryService.runManualCheck();

		return {
			taskId: 'subscriptionExpiryCheck',
			title: 'Проверка истёкших подписок',
			affectedCount: expiredCount,
			message:
				expiredCount > 0
					? `Деактивировано ${expiredCount} истёкших подписок.`
					: 'Истёкшие подписки для деактивации не найдены.',
			executedAt: new Date().toISOString()
		};
	}
}
