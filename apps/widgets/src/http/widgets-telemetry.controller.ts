import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Post,
	Query,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Request } from 'express';
import { WidgetsRoles } from '../auth/widgets-auth.decorator';
import {
	WidgetsApiGuard,
	WidgetsAuthGuard
} from '../auth/widgets-auth.guard';
import { parseWidgetType } from '../domain/widgets-domain.types';
import type { IntrospectedWidgetsActor } from '../internal/widgets-identity.client';
import { WidgetsTelemetryService } from '../telemetry/widgets-telemetry.service';
import { RecordWidgetRuntimeEventDto } from './widgets.dto';
import { CurrentWidgetsActor } from './widgets-http.util';

@Controller()
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WidgetsTelemetryController {
	constructor(private readonly telemetry: WidgetsTelemetryService) {}

	@Post('widget-events/:type/:publicKey')
	@UseGuards(WidgetsApiGuard)
	@HttpCode(204)
	record(
		@Param('type') type: string,
		@Param('publicKey') key: string,
		@Body() dto: RecordWidgetRuntimeEventDto,
		@Req() request: Request
	) {
		return this.telemetry.record(parseWidgetType(type), key, dto, request);
	}

	@Get('widget-runtime/:type/:id/status')
	@UseGuards(WidgetsApiGuard, WidgetsAuthGuard)
	@WidgetsRoles('USER', 'ADMIN', 'DEV')
	status(
		@Param('type') type: string,
		@Param('id') id: string,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor
	) {
		return this.telemetry.status(actor.subject, parseWidgetType(type), id);
	}

	@Get('widget-runtime/:type/:id/analytics')
	@UseGuards(WidgetsApiGuard, WidgetsAuthGuard)
	@WidgetsRoles('USER', 'ADMIN', 'DEV')
	analytics(
		@Param('type') type: string,
		@Param('id') id: string,
		@Query('days') days: string | undefined,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor
	) {
		return this.telemetry.analytics(
			actor.subject,
			parseWidgetType(type),
			id,
			Number(days) || 30
		);
	}
}
