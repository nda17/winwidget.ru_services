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
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Request } from 'express';

@Controller('/site-settings')
export class SiteSettingsController {
	constructor(private readonly siteSettingsService: SiteSettingsService) {}

	@HttpCode(200)
	@Get()
	get() {
		return this.siteSettingsService.get();
	}

	@HttpCode(200)
	@Auth('ADMIN')
	@Patch()
	@UsePipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true
		})
	)
	async update(
		@Body() dto: UpdateSiteSettingsDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		return this.siteSettingsService.update(dto, {
			adminId,
			request
		});
	}
}
