import { Auth } from '@/auth/decorators/auth.decorator';
import { UpdateSiteSettingsDto } from '@/site-settings/dto/update-site-settings.dto';
import { SiteSettingsService } from '@/site-settings/site-settings.service';
import { Body, Controller, Get, HttpCode, Patch } from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('/site-settings')
export class SiteSettingsController {
	constructor(private readonly siteSettingsService: SiteSettingsService) {}

	@HttpCode(200)
	@Get()
	get() {
		return this.siteSettingsService.get();
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch()
	update(@Body() dto: UpdateSiteSettingsDto) {
		return this.siteSettingsService.update(dto);
	}
}
