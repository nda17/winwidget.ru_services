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
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { WidgetsRoles } from '../auth/widgets-auth.decorator';
import {
	WidgetsApiGuard,
	WidgetsAuthGuard
} from '../auth/widgets-auth.guard';
import {
	getWidgetDefinition,
	parsePublicWidgetApiType,
	parseWidgetType,
	WidgetType
} from '../domain/widgets-domain.types';
import { isAiDirectPageRequest } from '../domain/widgets-domain.util';
import type { IntrospectedWidgetsActor } from '../internal/widgets-identity.client';
import { WidgetsTelemetryService } from '../telemetry/widgets-telemetry.service';
import { RecordWidgetRuntimeEventDto } from './widgets.dto';
import {
	CurrentWidgetsActor,
	WIDGETS_SCALAR_QUERY_PIPE
} from './widgets-http.util';

@Controller()
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WidgetsTelemetryController {
	constructor(
		private readonly telemetry: WidgetsTelemetryService,
		private readonly config: ConfigService
	) {}

	@Post('widget-events/:type/:publicKey')
	@UseGuards(WidgetsApiGuard)
	@HttpCode(204)
	record(
		@Param('type') type: string,
		@Param('publicKey') key: string,
		@Body() dto: RecordWidgetRuntimeEventDto,
		@Req() request: Request
	) {
		const widgetType = parsePublicWidgetApiType(type);
		const definition = getWidgetDefinition(widgetType);
		return this.telemetry.record(
			widgetType,
			key,
			dto,
			request,
			widgetType === WidgetType.AI_CONSULTANT &&
				isAiDirectPageRequest(
					request,
					definition.pagePath,
					key,
					this.config.get<string>('NODE_ENV')
				)
		);
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
		@Query('days', WIDGETS_SCALAR_QUERY_PIPE) days: string | undefined,
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
