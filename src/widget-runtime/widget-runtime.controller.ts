import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { RecordWidgetRuntimeEventDto } from '@/widget-runtime/widget-runtime.dto';
import { WidgetRuntimeService } from '@/widget-runtime/widget-runtime.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Post,
	Query,
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Request } from 'express';

@Controller()
export class WidgetRuntimeController {
	constructor(
		private readonly widgetRuntimeService: WidgetRuntimeService
	) {}

	@Post('widget-events/:type/:publicKey')
	@HttpCode(204)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	async recordEvent(
		@Param('type') type: string,
		@Param('publicKey') publicKey: string,
		@Body() dto: RecordWidgetRuntimeEventDto,
		@Req() request: Request
	) {
		await this.widgetRuntimeService.recordEvent(
			type,
			publicKey,
			dto,
			request
		);
	}

	@Get('widget-runtime/:type/:id/status')
	@Auth()
	getStatus(
		@CurrentUser('id') userId: string,
		@Param('type') type: string,
		@Param('id') id: string
	) {
		return this.widgetRuntimeService.getStatus(userId, type, id);
	}

	@Get('widget-runtime/:type/:id/analytics')
	@Auth()
	getAnalytics(
		@CurrentUser('id') userId: string,
		@Param('type') type: string,
		@Param('id') id: string,
		@Query('days') days?: string
	) {
		return this.widgetRuntimeService.getAnalytics(
			userId,
			type,
			id,
			days ? Number(days) : 30
		);
	}
}
