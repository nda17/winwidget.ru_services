import {
	Body,
	Controller,
	Headers,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Req,
	BadRequestException,
	UnauthorizedException,
	UnsupportedMediaTypeException
} from '@nestjs/common';
import type { Request } from 'express';
import { IngestInboxEntryDto } from './intake.dto';
import { IntakeIngestionService } from './intake-ingestion.service';

@Controller('crm/intake/ingest')
export class IntakeIngestionController {
	constructor(private readonly ingestion: IntakeIngestionService) {}

	@Post(':sourceId/tilda')
	@HttpCode(200)
	tilda(
		@Param('sourceId', new ParseUUIDPipe({ version: '4' }))
		sourceId: string,
		@Headers('x-wincrm-source-token') token: string | undefined,
		@Body() body: unknown,
		@Req() request: Request
	) {
		if (Object.keys(request.query).length)
			throw new BadRequestException('Query parameters are not supported');
		const tokenHeaders = request.rawHeaders
			.filter((_, index) => index % 2 === 0)
			.filter(name => name.toLowerCase() === 'x-wincrm-source-token');
		if (
			request.headers.authorization !== undefined ||
			tokenHeaders.length !== 1
		)
			throw new UnauthorizedException(
				'Source authentication is not valid'
			);
		if (
			!request.is('application/json') &&
			!request.is('application/x-www-form-urlencoded')
		)
			throw new UnsupportedMediaTypeException(
				'Use JSON or form-urlencoded'
			);
		return this.ingestion.ingestTilda(
			sourceId,
			token,
			body,
			request.socket.remoteAddress || ''
		);
	}

	@Post(':sourceId')
	@HttpCode(200)
	ingest(
		@Param('sourceId', new ParseUUIDPipe({ version: '4' }))
		sourceId: string,
		@Headers('authorization') authorization: string | undefined,
		@Headers('idempotency-key') commandId: string | undefined,
		@Body() dto: IngestInboxEntryDto,
		@Req() request: Request
	) {
		return this.ingestion.ingest(
			sourceId,
			authorization,
			commandId,
			dto,
			request.socket.remoteAddress || ''
		);
	}
}
