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
import {
	UpdateRawHomePageContentDto,
	UpdateStructuredHomePageContentDto
} from './home-page-content.dto';
import { PlatformHomePageContentService } from './home-page-content.service';

const STRICT_PIPE = new ValidationPipe({
	whitelist: true,
	forbidNonWhitelisted: true,
	transform: true
});

@Controller('home-page-content')
export class PlatformHomePageContentController {
	constructor(private readonly service: PlatformHomePageContentService) {}

	@Get()
	@HttpCode(200)
	get() {
		return this.service.get();
	}

	@Patch()
	@HttpCode(200)
	@PlatformAuth(['ADMIN', 'DEV'])
	@UseGuards(PlatformAuthGuard)
	@UsePipes(STRICT_PIPE)
	updateStructured(
		@Body() dto: UpdateStructuredHomePageContentDto,
		@CurrentPlatformActor() actor: PlatformActor,
		@Req() request: Request
	) {
		return this.service.updateStructured(dto, {
			actor,
			...getPlatformClientContext(request)
		});
	}

	@Patch('raw-code')
	@HttpCode(200)
	@PlatformAuth(['DEV'])
	@UseGuards(PlatformAuthGuard)
	@UsePipes(STRICT_PIPE)
	updateRaw(
		@Body() dto: UpdateRawHomePageContentDto,
		@CurrentPlatformActor() actor: PlatformActor,
		@Req() request: Request
	) {
		return this.service.updateRaw(dto, {
			actor,
			...getPlatformClientContext(request)
		});
	}
}
