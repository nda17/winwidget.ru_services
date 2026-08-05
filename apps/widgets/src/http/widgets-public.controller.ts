import {
	Body,
	Controller,
	Get,
	NotFoundException,
	Param,
	Post,
	Req,
	Res,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { WidgetsApiGuard } from '../auth/widgets-auth.guard';
import { WidgetsDomainService } from '../domain/widgets-domain.service';
import {
	getWidgetDefinition,
	WIDGET_DEFINITIONS
} from '../domain/widgets-domain.types';
import {
	getClientIp,
	getRequestDomain,
	isDirectPageRequest,
	safePublicKey
} from '../domain/widgets-domain.util';
import { SubmitWidgetLeadDto } from './widgets.dto';
import {
	requestCorrelationId,
	typeFromRequestPath
} from './widgets-http.util';

const CONFIG_PATHS = WIDGET_DEFINITIONS.map(
	item => `${item.publicApi}/:key/config`
);
const LEAD_PATHS = WIDGET_DEFINITIONS.map(
	item => `${item.publicApi}/:key/lead`
);

@Controller()
@UseGuards(WidgetsApiGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WidgetsPublicController {
	constructor(private readonly widgets: WidgetsDomainService) {}

	@Get(CONFIG_PATHS)
	async config(
		@Param('key') rawKey: string,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		response.setHeader('Access-Control-Allow-Origin', '*');
		response.setHeader(
			'Cache-Control',
			'no-store, no-cache, must-revalidate, proxy-revalidate'
		);
		const key = safePublicKey(rawKey);
		const type = typeFromRequestPath(request);
		const definition = getWidgetDefinition(type);
		const result = await this.widgets.publicConfig(
			type,
			key,
			getRequestDomain(request),
			isDirectPageRequest(request, definition.pagePath, key),
			getClientIp(request)
		);
		if (result === null) throw new NotFoundException('Виджет не найден');
		return result;
	}

	@Post(LEAD_PATHS)
	async submit(
		@Param('key') rawKey: string,
		@Body() dto: SubmitWidgetLeadDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		response.setHeader('Access-Control-Allow-Origin', '*');
		const key = safePublicKey(rawKey);
		const type = typeFromRequestPath(request);
		const definition = getWidgetDefinition(type);
		return this.widgets.submitLead(
			type,
			key,
			dto,
			getClientIp(request),
			getRequestDomain(request),
			isDirectPageRequest(request, definition.pagePath, key),
			requestCorrelationId(request)
		);
	}
}
