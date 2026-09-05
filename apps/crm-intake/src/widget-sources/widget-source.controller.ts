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
import { WidgetSourceService } from './widget-source.service';
import {
	CreateWidgetSourceDto,
	ConfigureWidgetSourceDto,
	VersionedWidgetSourceDto,
	WidgetSourcePageQuery,
	WidgetSourceWorkspaceQuery
} from './widget-source.dto';
@Controller('crm/intake/widget-sources')
export class WidgetSourceController {
	constructor(private readonly sources: WidgetSourceService) {}
	@Get('candidates')
	@Header('Cache-Control', 'no-store')
	candidates(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: WidgetSourcePageQuery
	) {
		return this.sources.candidates(bearer, query);
	}
	@Get()
	@Header('Cache-Control', 'no-store')
	list(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: WidgetSourcePageQuery
	) {
		return this.sources.list(bearer, query);
	}
	@Get(':id')
	@Header('Cache-Control', 'no-store')
	get(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: WidgetSourceWorkspaceQuery
	) {
		return this.sources.get(bearer, query.workspaceId, id);
	}
	@Post()
	@HttpCode(202)
	@Header('Cache-Control', 'no-store')
	create(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: CreateWidgetSourceDto
	) {
		this.key(key, dto.commandId);
		return this.sources.create(bearer, dto);
	}
	@Post(':id/configure')
	@HttpCode(202)
	@Header('Cache-Control', 'no-store')
	configure(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: ConfigureWidgetSourceDto
	) {
		this.key(key, dto.commandId);
		return this.sources.configure(bearer, id, dto);
	}
	@Post(':id/retry')
	@HttpCode(202)
	@Header('Cache-Control', 'no-store')
	retry(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: VersionedWidgetSourceDto
	) {
		this.key(key, dto.commandId);
		return this.sources.retry(bearer, id, dto);
	}
	private key(key: string | undefined, id: string) {
		if (key !== id)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
	}
}
