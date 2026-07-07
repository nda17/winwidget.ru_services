import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { UpdateSiteSettingsDto } from '@/site-settings/dto/update-site-settings.dto';
import { SiteSettingsService } from '@/site-settings/site-settings.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Patch,
	Req
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

@Controller('/site-settings')
export class SiteSettingsController {
	constructor(
		private readonly siteSettingsService: SiteSettingsService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@HttpCode(200)
	@Get()
	get() {
		return this.siteSettingsService.get();
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch()
	async update(
		@Body() dto: UpdateSiteSettingsDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const settings = await this.siteSettingsService.update(dto);

		await this.adminEventLogService.record({
			adminId,
			section: 'SITE_SETTINGS',
			action: 'SITE_SETTINGS_UPDATE',
			description: 'Обновлены настройки сайта',
			entityType: 'site_settings',
			entityId: 'singleton',
			entityLabel: 'Настройки сайта',
			metadata: this.getSiteSettingsUpdateMetadata(dto, settings),
			request
		});

		return settings;
	}

	private getSiteSettingsUpdateMetadata(
		dto: UpdateSiteSettingsDto,
		settings: Awaited<ReturnType<SiteSettingsService['update']>>
	) {
		const changedFields = Object.keys(dto);

		return {
			changedFields,
			bannerTextChanged: typeof dto.bannerText === 'string',
			...(typeof dto.bannerEnabled === 'boolean'
				? { bannerEnabled: settings.bannerEnabled }
				: {}),
			...(typeof dto.snowflakeEnabled === 'boolean'
				? { snowflakeEnabled: settings.snowflakeEnabled }
				: {}),
			...(typeof dto.paymentEnabled === 'boolean'
				? { paymentEnabled: settings.paymentEnabled }
				: {}),
			...(typeof dto.recaptchaEnabled === 'boolean'
				? { recaptchaEnabled: settings.recaptchaEnabled }
				: {}),
			...(typeof dto.googleAuthEnabled === 'boolean'
				? { googleAuthEnabled: settings.googleAuthEnabled }
				: {}),
			...(typeof dto.yandexAuthEnabled === 'boolean'
				? { yandexAuthEnabled: settings.yandexAuthEnabled }
				: {}),
			...(typeof dto.githubAuthEnabled === 'boolean'
				? { githubAuthEnabled: settings.githubAuthEnabled }
				: {}),
			...(typeof dto.vkAuthEnabled === 'boolean'
				? { vkAuthEnabled: settings.vkAuthEnabled }
				: {}),
			...(typeof dto.telegramAuthEnabled === 'boolean'
				? { telegramAuthEnabled: settings.telegramAuthEnabled }
				: {})
		};
	}
}
