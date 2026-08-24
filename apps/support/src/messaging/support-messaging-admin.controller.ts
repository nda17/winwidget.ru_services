import {
	Body,
	Controller,
	DefaultValuePipe,
	Get,
	Header,
	Param,
	ParseIntPipe,
	ParseUUIDPipe,
	Post,
	Query,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentSupportActor } from '../auth/current-support-actor.decorator';
import { SupportAuth, SupportAuthGuard } from '../auth/support-auth.guard';
import type { SupportActor } from '../auth/support-request';
import { CloseSupportFailureDto } from './support-messaging-admin.dto';
import { SupportMessagingAdminService } from './support-messaging-admin.service';

@Controller('support/admin/messaging/failures')
@UseGuards(SupportAuthGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class SupportMessagingAdminController {
	constructor(private readonly messaging: SupportMessagingAdminService) {}

	@Get()
	@Header('Cache-Control', 'no-store')
	@SupportAuth(['ADMIN', 'DEV'])
	list(
		@Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
		@Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number
	) {
		return this.messaging.list(
			Math.max(1, page),
			Math.min(100, Math.max(1, limit))
		);
	}

	@Post(':id/retry')
	@Header('Cache-Control', 'no-store')
	@SupportAuth(['DEV'])
	retry(
		@Param('id', new ParseUUIDPipe()) id: string,
		@CurrentSupportActor() actor: SupportActor,
		@Req() request: Request
	) {
		return this.messaging.retry(id, actor, request);
	}

	@Post(':id/close')
	@Header('Cache-Control', 'no-store')
	@SupportAuth(['DEV'])
	close(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: CloseSupportFailureDto,
		@CurrentSupportActor() actor: SupportActor,
		@Req() request: Request
	) {
		return this.messaging.close(id, body.comment, actor, request);
	}
}
