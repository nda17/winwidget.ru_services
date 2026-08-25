import {
	Body,
	Controller,
	Get,
	Header,
	Patch,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentSupportActor } from '../auth/current-support-actor.decorator';
import { SupportAuth, SupportAuthGuard } from '../auth/support-auth.guard';
import type { SupportActor } from '../auth/support-request';
import { UpdateSupportRoutingSettingsDto } from './support-settings.dto';
import { SupportSettingsService } from './support-settings.service';

@Controller('support/admin/routing-settings')
@UseGuards(SupportAuthGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class SupportSettingsController {
	constructor(private readonly settings: SupportSettingsService) {}

	@Get()
	@Header('Cache-Control', 'no-store')
	@SupportAuth(['ADMIN', 'DEV'])
	get() {
		return this.settings.get();
	}

	@Patch()
	@Header('Cache-Control', 'no-store')
	@SupportAuth(['DEV'])
	update(
		@Body() dto: UpdateSupportRoutingSettingsDto,
		@CurrentSupportActor() actor: SupportActor,
		@Req() request: Request
	) {
		return this.settings.update(dto, actor, request);
	}
}
