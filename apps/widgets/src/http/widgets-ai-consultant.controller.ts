import {
	Body,
	Controller,
	HttpCode,
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
import { WidgetsAiConsultantService } from '../ai/widgets-ai-consultant.service';
import { WidgetsRoles } from '../auth/widgets-auth.decorator';
import {
	WidgetsApiGuard,
	WidgetsAuthGuard
} from '../auth/widgets-auth.guard';
import {
	getClientIp,
	getRequestHostname,
	isAiDirectPageRequest,
	safePublicKey
} from '../domain/widgets-domain.util';
import {
	getWidgetDefinition,
	WidgetType
} from '../domain/widgets-domain.types';
import type { IntrospectedWidgetsActor } from '../internal/widgets-identity.client';
import {
	AiConsultantConsentDto,
	AiConsultantPublicMessageDto,
	AiConsultantSessionDto,
	AiConsultantTestMessageDto
} from './widgets.dto';
import { CurrentWidgetsActor } from './widgets-http.util';

const strictValidation = new ValidationPipe({
	whitelist: true,
	forbidNonWhitelisted: true,
	transform: true
});

@Controller()
@UseGuards(WidgetsApiGuard)
@UsePipes(strictValidation)
export class WidgetsAiConsultantPublicController {
	constructor(
		private readonly ai: WidgetsAiConsultantService,
		private readonly config: ConfigService
	) {}

	@Post('ai-consultant/:key/consents')
	consent(
		@Param('key') rawKey: string,
		@Body() dto: AiConsultantConsentDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		response.setHeader('Access-Control-Allow-Origin', '*');
		response.setHeader('Cache-Control', 'no-store');
		const key = safePublicKey(rawKey);
		const definition = getWidgetDefinition(WidgetType.AI_CONSULTANT);
		return this.ai.publicConsent(
			key,
			dto,
			getClientIp(request),
			getRequestHostname(request),
			isAiDirectPageRequest(
				request,
				definition.pagePath,
				key,
				this.config.get<string>('NODE_ENV')
			)
		);
	}

	@Post('ai-consultant/:key/session')
	@HttpCode(200)
	session(
		@Param('key') rawKey: string,
		@Body() dto: AiConsultantSessionDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		response.setHeader('Access-Control-Allow-Origin', '*');
		response.setHeader('Cache-Control', 'no-store');
		const key = safePublicKey(rawKey);
		const definition = getWidgetDefinition(WidgetType.AI_CONSULTANT);
		return this.ai.publicSession(
			key,
			dto.sessionId,
			dto.turnstileToken,
			dto.consentToken,
			getClientIp(request),
			getRequestHostname(request),
			isAiDirectPageRequest(
				request,
				definition.pagePath,
				key,
				this.config.get<string>('NODE_ENV')
			)
		);
	}

	@Post('ai-consultant/:key/messages')
	@HttpCode(200)
	message(
		@Param('key') rawKey: string,
		@Body() dto: AiConsultantPublicMessageDto,
		@Req() request: Request,
		@Res({ passthrough: true }) response: Response
	) {
		response.setHeader('Access-Control-Allow-Origin', '*');
		response.setHeader('Cache-Control', 'no-store');
		const key = safePublicKey(rawKey);
		return this.ai.publicMessage(key, dto, getClientIp(request));
	}
}

@Controller('ai-consultants')
@UseGuards(WidgetsApiGuard, WidgetsAuthGuard)
@WidgetsRoles('USER', 'ADMIN', 'DEV')
@UsePipes(strictValidation)
export class WidgetsAiConsultantManagementController {
	constructor(private readonly ai: WidgetsAiConsultantService) {}

	@Post(':id/test-message')
	@HttpCode(200)
	testMessage(
		@Param('id') id: string,
		@Body() dto: AiConsultantTestMessageDto,
		@Req() request: Request,
		@CurrentWidgetsActor() actor: IntrospectedWidgetsActor
	) {
		return this.ai.testMessage(id, actor, dto, getClientIp(request));
	}
}
