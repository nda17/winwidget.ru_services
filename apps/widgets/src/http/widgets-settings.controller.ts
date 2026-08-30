import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	ParseIntPipe,
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
import { WidgetsDomainService } from '../domain/widgets-domain.service';
import type { IntrospectedWidgetsActor } from '../internal/widgets-identity.client';
import { CloneWidgetDto, ExpectedDraftRevisionDto } from './widgets.dto';
import {
	CurrentWidgetsActor,
	parseLifecycleType,
	requestCorrelationId,
	WIDGETS_SCALAR_QUERY_PIPE
} from './widgets-http.util';

@Controller('widget-settings')
@UseGuards(WidgetsApiGuard, WidgetsAuthGuard)
@WidgetsRoles('USER', 'ADMIN', 'DEV')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WidgetsSettingsController {
	constructor(private readonly widgets: WidgetsDomainService) {}

	@Get(':type/:id')
	@HttpCode(200)
	state(
		@Param('type') type: string,
		@Param('id') id: string,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor
	) {
		return this.widgets.state(parseLifecycleType(type), id, actor.subject);
	}

	@Post(':type/:id/publish')
	@HttpCode(200)
	publish(
		@Param('type') type: string,
		@Param('id') id: string,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Body() dto: ExpectedDraftRevisionDto,
		@Req() request: Request
	) {
		return this.widgets.publish(
			parseLifecycleType(type),
			id,
			actor.subject,
			dto.expectedDraftRevision,
			requestCorrelationId(request)
		);
	}

	@Get(':type/:id/versions')
	@HttpCode(200)
	versions(
		@Param('type') type: string,
		@Param('id') id: string,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Query('page', WIDGETS_SCALAR_QUERY_PIPE) page?: string,
		@Query('limit', WIDGETS_SCALAR_QUERY_PIPE) limit?: string
	) {
		return this.widgets.versions(
			parseLifecycleType(type),
			id,
			actor.subject,
			Number(page) || 1,
			Number(limit) || 20
		);
	}

	@Post(':type/:id/versions/:version/restore')
	@HttpCode(200)
	restore(
		@Param('type') type: string,
		@Param('id') id: string,
		@Param('version', ParseIntPipe) version: number,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Body() dto: ExpectedDraftRevisionDto,
		@Req() request: Request
	) {
		return this.widgets.restore(
			parseLifecycleType(type),
			id,
			version,
			actor.subject,
			dto.expectedDraftRevision,
			requestCorrelationId(request)
		);
	}

	@Post(':type/:id/clone')
	@HttpCode(201)
	clone(
		@Param('type') type: string,
		@Param('id') id: string,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Body() dto: CloneWidgetDto,
		@Req() request: Request
	) {
		return this.widgets.clone(
			parseLifecycleType(type),
			id,
			actor.subject,
			dto.name,
			requestCorrelationId(request)
		);
	}

	@Post(':type/:id/discard-draft')
	@HttpCode(200)
	discard(
		@Param('type') type: string,
		@Param('id') id: string,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Body() dto: ExpectedDraftRevisionDto,
		@Req() request: Request
	) {
		return this.widgets.discard(
			parseLifecycleType(type),
			id,
			actor.subject,
			dto.expectedDraftRevision,
			requestCorrelationId(request)
		);
	}
}
