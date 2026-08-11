import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { UpdateAffiliateSettingsDto } from '@/affiliate/dto/update-affiliate-settings.dto';
import { AffiliateService } from '@/affiliate/affiliate.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { BillingLegacyRouteGuard } from '@/billing-boundary/billing-legacy-route.guard';
import { BillingLegacyWriteFenceInterceptor } from '@/billing-boundary/billing-legacy-write-fence.interceptor';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Patch,
	Query,
	Req,
	UsePipes,
	UseGuards,
	UseInterceptors,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

@Controller('affiliate')
@UseGuards(BillingLegacyRouteGuard)
@UseInterceptors(BillingLegacyWriteFenceInterceptor)
export class AffiliateController {
	constructor(
		private readonly affiliateService: AffiliateService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@HttpCode(200)
	@Get('public-settings')
	getPublicSettings() {
		return this.affiliateService.getPublicSettings();
	}

	@HttpCode(200)
	@Auth()
	@Get('me')
	getMyProgram(
		@CurrentUser('id') userId: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.affiliateService.getMyProgram(
			userId,
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20
		);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('admin/referrals')
	adminGetReferrals(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('status') status?: string,
		@Query('search') search?: string
	) {
		return this.affiliateService.adminGetReferrals(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{ status, search }
		);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('admin/settings')
	adminGetSettings() {
		return this.affiliateService.getPublicSettings();
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Patch('admin/settings')
	async adminUpdateSettings(
		@Body() dto: UpdateAffiliateSettingsDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const result = await this.affiliateService.updateSettings(dto);

		await this.adminEventLogService.record({
			adminId,
			section: 'AFFILIATE',
			action: 'AFFILIATE_SETTINGS_UPDATE',
			description: 'Настройки партнёрской программы обновлены',
			entityType: 'affiliate_settings',
			entityId: 'singleton',
			entityLabel: 'Партнёрская программа',
			metadata: result,
			request
		});

		return result;
	}
}
