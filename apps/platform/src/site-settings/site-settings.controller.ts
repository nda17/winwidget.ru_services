import {
	Body,
	Controller,
	Get,
	HttpCode,
	Patch,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Request } from 'express';
import {
	PlatformAuth,
	PlatformAuthGuard
} from '../auth/platform-auth.guard';
import { CurrentPlatformActor } from '../auth/current-platform-actor.decorator';
import type { PlatformActor } from '../auth/platform-request';
import { getPlatformClientContext } from '../common/platform-request-context';
import { UpdatePlatformSiteSettingsDto } from './site-settings.dto';
import { PlatformSiteSettingsService } from './site-settings.service';

@Controller('site-settings')
export class PlatformSiteSettingsController {
	constructor(private readonly service: PlatformSiteSettingsService) {}

	@Get()
	@HttpCode(200)
	get() {
		return this.service.get();
	}

	@Patch()
	@HttpCode(200)
	@PlatformAuth(['ADMIN', 'DEV'])
	@UseGuards(PlatformAuthGuard)
	@UsePipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		})
	)
	update(
		@Body() dto: UpdatePlatformSiteSettingsDto,
		@CurrentPlatformActor() actor: PlatformActor,
		@Req() request: Request
	) {
		return this.service.update(dto, {
			actor,
			...getPlatformClientContext(request)
		});
	}
}
