import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Header,
	Headers,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Query
} from '@nestjs/common';
import {
	IntakePageQuery,
	VersionedIntakeCommandDto
} from '../intake/intake.dto';
import { WidgetTransferService } from './widget-transfer.service';
@Controller('crm/intake/widget-sources')
export class WidgetTransferController {
	constructor(private readonly service: WidgetTransferService) {}
	@Get(':sourceId/transfers')
	@Header('Cache-Control', 'no-store')
	list(
		@Headers('authorization') bearer: string | undefined,
		@Param('sourceId', new ParseUUIDPipe({ version: '4' }))
		sourceId: string,
		@Query() query: IntakePageQuery
	) {
		return this.service.list(bearer, sourceId, query);
	}
	@Post(':sourceId/transfers/:transferId/retry')
	@HttpCode(202)
	@Header('Cache-Control', 'no-store')
	retry(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('sourceId', new ParseUUIDPipe({ version: '4' }))
		sourceId: string,
		@Param('transferId', new ParseUUIDPipe({ version: '4' }))
		transferId: string,
		@Body() dto: VersionedIntakeCommandDto
	) {
		if (key !== dto.commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		return this.service.retry(bearer, sourceId, transferId, dto);
	}
}
