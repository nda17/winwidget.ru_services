import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
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
import { UpdatePlatformLegalPageDto } from './legal-pages.dto';
import { PlatformLegalPagesService } from './legal-pages.service';

@Controller('legal-pages')
export class PlatformLegalPagesController {
	constructor(private readonly service: PlatformLegalPagesService) {}

	@Get()
	@HttpCode(200)
	getAll() {
		return this.service.getAll();
	}

	@Get(':slug')
	@HttpCode(200)
	getBySlug(@Param('slug') slug: string) {
		return this.service.getBySlug(slug);
	}

	@Patch(':slug')
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
		@Param('slug') slug: string,
		@Body() dto: UpdatePlatformLegalPageDto,
		@CurrentPlatformActor() actor: PlatformActor,
		@Req() request: Request
	) {
		return this.service.update(slug, dto, {
			actor,
			...getPlatformClientContext(request)
		});
	}
}
