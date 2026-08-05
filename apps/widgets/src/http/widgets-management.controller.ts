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
	Res,
	UploadedFile,
	UseGuards,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { WidgetsRoles } from '../auth/widgets-auth.decorator';
import {
	WidgetsApiGuard,
	WidgetsAuthGuard
} from '../auth/widgets-auth.guard';
import type { IntrospectedWidgetsActor } from '../internal/core-internal.client';
import { WidgetsDomainService } from '../domain/widgets-domain.service';
import { WIDGET_DEFINITIONS } from '../domain/widgets-domain.types';
import { WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES } from '../domain/widgets-image.service';
import { CreateWidgetDto, UpdateWidgetDto } from './widgets.dto';
import {
	CurrentWidgetsActor,
	requestCorrelationId,
	typeFromRequestPath
} from './widgets-http.util';

const COLLECTIONS = WIDGET_DEFINITIONS.map(item => item.collection);
const ITEM_PATHS = COLLECTIONS.map(path => `${path}/:id`);
const IMAGE_PATHS = COLLECTIONS.filter(path => path !== 'stop-offers').map(
	path => `${path}/:id/button-image`
);
const LEADS_PATHS = COLLECTIONS.map(path => `${path}/:id/leads`);
const STATS_PATHS = [
	'widgets/:id/leads/stats',
	'quizzes/:id/leads/stats',
	'calculators/:id/leads/stats'
];
const EXPORT_PATHS = COLLECTIONS.map(path => `${path}/:id/leads/export`);

@Controller()
@UseGuards(WidgetsApiGuard, WidgetsAuthGuard)
@WidgetsRoles('USER', 'ADMIN', 'DEV')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WidgetsManagementController {
	constructor(private readonly widgets: WidgetsDomainService) {}

	@Get(COLLECTIONS)
	@HttpCode(200)
	list(
		@Req() request: Request,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor
	) {
		return this.widgets.list(typeFromRequestPath(request), actor.subject);
	}

	@Post(COLLECTIONS)
	@HttpCode(201)
	create(
		@Req() request: Request,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Body() dto: CreateWidgetDto
	) {
		return this.widgets.create(
			typeFromRequestPath(request),
			actor.subject,
			dto.name,
			requestCorrelationId(request)
		);
	}

	@Patch(ITEM_PATHS)
	@HttpCode(200)
	update(
		@Req() request: Request,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Param('id') id: string,
		@Body() dto: UpdateWidgetDto
	) {
		return this.widgets.update(
			typeFromRequestPath(request),
			id,
			actor.subject,
			dto,
			requestCorrelationId(request)
		);
	}

	@Delete(ITEM_PATHS)
	@HttpCode(200)
	delete(
		@Req() request: Request,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Param('id') id: string
	) {
		return this.widgets.delete(
			typeFromRequestPath(request),
			id,
			actor.subject,
			requestCorrelationId(request)
		);
	}

	@Post(IMAGE_PATHS)
	@HttpCode(200)
	@UseInterceptors(
		FileInterceptor('file', {
			limits: { fileSize: WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES }
		})
	)
	uploadImage(
		@Req() request: Request,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Param('id') id: string,
		@Body('expectedDraftRevision', ParseIntPipe)
		expectedDraftRevision: number,
		@UploadedFile() file?: Express.Multer.File
	) {
		return this.widgets.uploadImage(
			typeFromRequestPath(request),
			id,
			actor.subject,
			file,
			expectedDraftRevision,
			requestCorrelationId(request)
		);
	}

	@Get(LEADS_PATHS)
	@HttpCode(200)
	leads(
		@Req() request: Request,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Param('id') id: string,
		@Query('page') page?: string,
		@Query('limit') limit?: string
	) {
		return this.widgets.leads(
			typeFromRequestPath(request),
			id,
			actor.subject,
			Number(page) || 1,
			Number(limit) || 50
		);
	}

	@Get(STATS_PATHS)
	@HttpCode(200)
	stats(
		@Req() request: Request,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Param('id') id: string
	) {
		return this.widgets.stats(
			typeFromRequestPath(request),
			id,
			actor.subject
		);
	}

	@Get(EXPORT_PATHS)
	@HttpCode(200)
	async export(
		@Req() request: Request,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor,
		@Param('id') id: string,
		@Query('format') format: string,
		@Res() response: Response
	) {
		const file = await this.widgets.export(
			typeFromRequestPath(request),
			id,
			actor.subject,
			format === 'xlsx' ? 'xlsx' : 'csv'
		);
		response.setHeader('Content-Type', file.contentType);
		response.setHeader(
			'Content-Disposition',
			`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`
		);
		response.send(file.data);
	}
}
