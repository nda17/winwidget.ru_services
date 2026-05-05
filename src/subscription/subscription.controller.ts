import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
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
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

@Controller('subscriptions')
export class SubscriptionController {
	constructor(
		private readonly subscriptionService: SubscriptionService,
		private readonly subscriptionExpiryService: SubscriptionExpiryService,
		private readonly adminEventLogService: AdminEventLogService
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
	async adminActivate(
		@Body() dto: AdminActivateSubscriptionDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const subscription =
			await this.subscriptionService.adminActivateSubscription(
				dto.userId,
				dto.plan,
				dto.billingPeriod,
				dto.startsAt ? new Date(dto.startsAt) : undefined,
				dto.extendIfActive
			);

		await this.adminEventLogService.record({
			adminId,
			section: 'SUBSCRIPTIONS',
			action: 'SUBSCRIPTION_ACTIVATE',
			description: `Ручная активация подписки: ${dto.plan}`,
			entityType: 'subscription',
			entityId: subscription.id,
			entityLabel: dto.plan,
			targetUserId: dto.userId,
			metadata: {
				plan: dto.plan,
				billingPeriod: dto.billingPeriod ?? null,
				startsAt: dto.startsAt ?? null,
				extendIfActive: dto.extendIfActive ?? null,
				expiresAt: subscription.expiresAt?.toISOString() ?? null
			},
			request
		});

		return subscription;
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('admin/extend-days')
	async adminExtendDays(
		@Body() dto: AdminExtendSubscriptionDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const subscription =
			await this.subscriptionService.adminExtendSubscriptionDays(
				dto.userId,
				dto.days,
				adminId
			);

		await this.adminEventLogService.record({
			adminId,
			section: 'SUBSCRIPTIONS',
			action: 'SUBSCRIPTION_EXTEND_DAYS',
			description: `Начислены бонусные дни: ${dto.days}`,
			entityType: 'subscription',
			entityId: subscription.id,
			entityLabel: `${dto.days} дн.`,
			targetUserId: dto.userId,
			metadata: {
				days: dto.days,
				expiresAt: subscription.expiresAt?.toISOString() ?? null
			},
			request
		});

		return subscription;
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch('admin/:userId/cancel')
	async adminCancel(
		@Param('userId') userId: string,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const subscription =
			await this.subscriptionService.adminCancelSubscription(userId);

		await this.adminEventLogService.record({
			adminId,
			section: 'SUBSCRIPTIONS',
			action: 'SUBSCRIPTION_CANCEL',
			description: 'Ручная отмена подписки',
			entityType: 'subscription',
			entityId: subscription.id,
			entityLabel: subscription.plan,
			targetUserId: userId,
			metadata: {
				status: subscription.status,
				plan: subscription.plan,
				expiresAt: subscription.expiresAt?.toISOString() ?? null
			},
			request
		});

		return subscription;
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Post('admin/run-expiry-check')
	async runExpiryCheck(
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const expiredCount =
			await this.subscriptionExpiryService.runManualCheck();

		const result = {
			taskId: 'subscriptionExpiryCheck',
			title: 'Проверка истёкших подписок',
			affectedCount: expiredCount,
			message:
				expiredCount > 0
					? `Деактивировано ${expiredCount} истёкших подписок.`
					: 'Истёкшие подписки для деактивации не найдены.',
			executedAt: new Date().toISOString()
		};

		await this.adminEventLogService.record({
			adminId,
			section: 'TASKS',
			action: 'SUBSCRIPTION_EXPIRY_CHECK_RUN',
			description: result.title,
			entityType: 'manual_task',
			entityId: result.taskId,
			entityLabel: result.title,
			metadata: result,
			request
		});

		return result;
	}
}
