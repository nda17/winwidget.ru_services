import {
	Body,
	Controller,
	Headers,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Req
} from '@nestjs/common';
import type { Request } from 'express';
import { IngestInboxEntryDto } from './intake.dto';
import { IntakeIngestionService } from './intake-ingestion.service';

@Controller('crm/intake/ingest')
export class IntakeIngestionController {
	constructor(private readonly ingestion: IntakeIngestionService) {}

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
