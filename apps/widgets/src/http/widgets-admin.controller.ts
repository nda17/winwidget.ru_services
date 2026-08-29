import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	ParseIntPipe,
	Patch,
	Post,
	Query,
	Req,
	UploadedFile,
	UseGuards,
	UseInterceptors,
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
import { parseWidgetType } from '../domain/widgets-domain.types';
import type { IntrospectedWidgetsActor } from '../internal/widgets-identity.client';
import { WidgetsAdminMonitoringService } from '../monitoring/widgets-admin-monitoring.service';
import { WidgetsTelemetryService } from '../telemetry/widgets-telemetry.service';
import {
	CloneWidgetDto,
	ExpectedDraftRevisionDto,
	UpdateWidgetDto
} from './widgets.dto';
import {
	CurrentWidgetsActor,
	requestCorrelationId,
	WidgetButtonImageInterceptor
} from './widgets-http.util';

@Controller('widgets/admin')
@UseGuards(WidgetsApiGuard, WidgetsAuthGuard)
@WidgetsRoles('ADMIN', 'DEV')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WidgetsAdminController {
	constructor(
		private readonly widgets: WidgetsDomainService,
		private readonly monitoring: WidgetsAdminMonitoringService,
		private readonly telemetry: WidgetsTelemetryService
	) {}

	@Get('monitoring')
	@HttpCode(200)
	list(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('type') type?: string,
		@Query('isActive') isActive?: string,
		@Query('plan') plan?: string,
		@Query('search') search?: string
	) {
		return this.monitoring.list(Number(page) || 1, Number(limit) || 20, {
			type,
			isActive,
			plan,
			search
		});
	}

	@Get(':type/:id')
	@HttpCode(200)
	get(@Param('type') type: string, @Param('id') id: string) {
		return this.monitoring.get(parseWidgetType(type), id);
	}

	@Get(':type/:id/versions')
	@HttpCode(200)
	async versions(
		@Param('type') type: string,
		@Param('id') id: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		const widgetType = parseWidgetType(type);
		return this.widgets.versions(
			widgetType,
			id,
			await this.owner(widgetType, id),
			Number(page) || 1,
			Number(limit) || 20
		);
	}

	@Post(':type/:id/versions/:version/restore')
	@HttpCode(200)
	@WidgetsRoles('DEV')
	async restore(
		@Param('type') type: string,
		@Param('id') id: string,
		@Param('version', ParseIntPipe) version: number,
		@Body() dto: ExpectedDraftRevisionDto,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Req() request: Request
	) {
		const widgetType = parseWidgetType(type);
		const ownerId = await this.owner(widgetType, id);
		return this.widgets.restore(
			widgetType,
			id,
			version,
			ownerId,
			dto.expectedDraftRevision,
			requestCorrelationId(request),
			{ actorId: actor.subject }
		);
	}

	@Post(':type/:id/clone')
	@HttpCode(201)
	@WidgetsRoles('DEV')
	async clone(
		@Param('type') type: string,
		@Param('id') id: string,
		@Body() dto: CloneWidgetDto,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Req() request: Request
	) {
		const widgetType = parseWidgetType(type);
		const ownerId = await this.owner(widgetType, id);
		return this.widgets.clone(
			widgetType,
			id,
			ownerId,
			dto.name,
			requestCorrelationId(request),
			{ actorId: actor.subject }
		);
	}

	@Get(':type/:id/runtime-status')
	@HttpCode(200)
	async runtimeStatus(
		@Param('type') type: string,
		@Param('id') id: string
	) {
		const widgetType = parseWidgetType(type);
		return this.telemetry.status(
			await this.owner(widgetType, id),
			widgetType,
			id
		);
	}

	@Get(':type/:id/analytics')
	@HttpCode(200)
	async analytics(
		@Param('type') type: string,
		@Param('id') id: string,
		@Query('days') days?: string
	) {
		const widgetType = parseWidgetType(type);
		return this.telemetry.analytics(
			await this.owner(widgetType, id),
			widgetType,
			id,
			Number(days) || 30
		);
	}

	@Patch(':type/:id')
	@HttpCode(200)
	@WidgetsRoles('DEV')
	async update(
		@Param('type') type: string,
		@Param('id') id: string,
		@Body() dto: UpdateWidgetDto,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Req() request: Request
	) {
		const widgetType = parseWidgetType(type);
		const ownerId = await this.owner(widgetType, id);
		return {
			type: widgetType,
			entity: await this.widgets.update(
				widgetType,
				id,
				ownerId,
				dto,
				requestCorrelationId(request),
				{ actorId: actor.subject }
			)
		};
	}

	@Delete(':type/:id')
	@HttpCode(200)
	@WidgetsRoles('DEV')
	async delete(
		@Param('type') type: string,
		@Param('id') id: string,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Req() request: Request
	) {
		const widgetType = parseWidgetType(type);
		const ownerId = await this.owner(widgetType, id);
		await this.widgets.delete(
			widgetType,
			id,
			ownerId,
			requestCorrelationId(request),
			{ actorId: actor.subject }
		);
		return { type: widgetType, id };
	}

	@Post(':type/:id/publish')
	@HttpCode(200)
	@WidgetsRoles('DEV')
	async publish(
		@Param('type') type: string,
		@Param('id') id: string,
		@Body() dto: ExpectedDraftRevisionDto,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Req() request: Request
	) {
		const widgetType = parseWidgetType(type);
		const ownerId = await this.owner(widgetType, id);
		return this.widgets.publish(
			widgetType,
			id,
			ownerId,
			dto.expectedDraftRevision,
			requestCorrelationId(request),
			{ actorId: actor.subject }
		);
	}

	@Post(':type/:id/discard-draft')
	@HttpCode(200)
	@WidgetsRoles('DEV')
	async discard(
		@Param('type') type: string,
		@Param('id') id: string,
		@Body() dto: ExpectedDraftRevisionDto,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Req() request: Request
	) {
		const widgetType = parseWidgetType(type);
		const ownerId = await this.owner(widgetType, id);
		return this.widgets.discard(
			widgetType,
			id,
			ownerId,
			dto.expectedDraftRevision,
			requestCorrelationId(request),
			{ actorId: actor.subject }
		);
	}

	@Post(':type/:id/button-image')
	@HttpCode(200)
	@WidgetsRoles('DEV')
	@UseInterceptors(WidgetButtonImageInterceptor())
	async image(
		@Param('type') type: string,
		@Param('id') id: string,
		@Body('expectedDraftRevision', ParseIntPipe)
		expectedDraftRevision: number,
		@UploadedFile() file: Express.Multer.File | undefined,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Req() request: Request
	) {
		const widgetType = parseWidgetType(type);
		const ownerId = await this.owner(widgetType, id);
		return {
			type: widgetType,
			entity: await this.widgets.uploadImage(
				widgetType,
				id,
				ownerId,
				file,
				expectedDraftRevision,
				requestCorrelationId(request),
				{ actorId: actor.subject }
			)
		};
	}

	private async owner(
		type: ReturnType<typeof parseWidgetType>,
		id: string
	): Promise<string> {
		return this.widgets.ownerId(type, id);
	}
}
