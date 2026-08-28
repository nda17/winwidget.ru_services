import {
	Body,
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	NotFoundException,
	Param,
	Post,
	Req,
	Res,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { WidgetsApiGuard } from '../auth/widgets-auth.guard';
import { CallbackOtpRateLimitException } from '../callback/widgets-callback-otp.service';
import { WidgetsDomainService } from '../domain/widgets-domain.service';
import {
	getWidgetDefinition,
	WidgetType,
	WIDGET_DEFINITIONS
} from '../domain/widgets-domain.types';
import {
	getClientIp,
	getRequestDomain,
	getRequestHostname,
	isAiDirectPageRequest,
	isDirectPageRequest,
	safePublicKey
} from '../domain/widgets-domain.util';
import {
	CallbackVerificationStartDto,
	SubmitCallbackLeadDto,
	SubmitWidgetLeadDto
} from './widgets.dto';
import {
	requestCorrelationId,
	typeFromRequestPath
} from './widgets-http.util';

const CONFIG_PATHS = WIDGET_DEFINITIONS.map(
	item => `${item.publicApi}/:key/config`
);
const LEAD_PATHS = WIDGET_DEFINITIONS.filter(
	item =>
		item.type !== WidgetType.AI_CONSULTANT &&
		item.type !== WidgetType.CALLBACK
).map(item => `${item.publicApi}/:key/lead`);

@Controller()
@UseGuards(WidgetsApiGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class WidgetsPublicController {
	constructor(
		private readonly widgets: WidgetsDomainService,
		private readonly configService: ConfigService
	) {}

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
			type === WidgetType.AI_CONSULTANT
				? getRequestHostname(request)
				: getRequestDomain(request),
			type === WidgetType.AI_CONSULTANT
				? isAiDirectPageRequest(
						request,
						definition.pagePath,
						key,
						this.configService.get<string>('NODE_ENV')
					)
				: isDirectPageRequest(request, definition.pagePath, key),
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

	@Post('callback/:key/verification/start')
	@HttpCode(HttpStatus.OK)
	async startCallbackVerification(
		@Param('key') rawKey: string,
		@Body() dto: CallbackVerificationStartDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		response.setHeader('Access-Control-Allow-Origin', '*');
		response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
		const key = safePublicKey(rawKey);
		try {
			return await this.widgets.startCallbackVerification(
				key,
				dto,
				getClientIp(request),
				getRequestDomain(request),
				isDirectPageRequest(request, 'page-callback', key)
			);
		} catch (error) {
			if (error instanceof CallbackOtpRateLimitException) {
				response.setHeader('Retry-After', String(error.retryAfterSeconds));
			}
			throw error;
		}
	}

	@Post('callback/:key/lead')
	async submitCallback(
		@Param('key') rawKey: string,
		@Body() dto: SubmitCallbackLeadDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		response.setHeader('Access-Control-Allow-Origin', '*');
		const key = safePublicKey(rawKey);
		return this.widgets.submitLead(
			WidgetType.CALLBACK,
			key,
			dto,
			getClientIp(request),
			getRequestDomain(request),
			isDirectPageRequest(request, 'page-callback', key),
			requestCorrelationId(request)
		);
	}
}
