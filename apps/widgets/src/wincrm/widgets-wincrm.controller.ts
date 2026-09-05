import {
	BadRequestException,
	Body,
	Controller,
	Header,
	Headers,
	HttpCode,
	Param,
	Post,
	UseGuards
} from '@nestjs/common';
import {
	configureInput,
	identifier,
	integer,
	record,
	uuid
} from './widgets-wincrm.contract';
import { WidgetsWincrmGuard } from './widgets-wincrm.config';
import { WidgetsWincrmService } from './widgets-wincrm.service';

function input<T>(parse: () => T): T {
	try {
		return parse();
	} catch {
		throw new BadRequestException({
			code: 'widgets_wincrm_invalid_request'
		});
	}
}

@Controller('internal/v1/crm-intake')
@UseGuards(WidgetsWincrmGuard)
export class WidgetsWincrmController {
	constructor(private readonly service: WidgetsWincrmService) {}
	@Post('widget-connectors/candidates')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	candidates(@Body() body: unknown) {
		const parsed = input(() => {
			const item = record(body, [
				'schemaVersion',
				'ownerSubject',
				'page',
				'pageSize'
			]);
			if (item.schemaVersion !== 1) throw new Error();
			return {
				ownerSubject: identifier(item.ownerSubject, 256),
				page: integer(item.page, 1000000),
				pageSize: integer(item.pageSize, 100)
			};
		});
		return this.service.candidates(
			parsed.ownerSubject,
			parsed.page,
			parsed.pageSize
		);
	}
	@Post('widget-connectors/:connectorId/configure')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	configure(
		@Param('connectorId') connectorId: string,
		@Body() body: unknown,
		@Headers('idempotency-key') key: unknown
	) {
		const parsed = input(() => ({
			id: uuid(connectorId),
			command: configureInput(body, key)
		}));
		return this.service.configure(parsed.id, parsed.command);
	}
	@Post('widget-transfers/:transferId/context')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	context(@Param('transferId') transferId: string, @Body() body: unknown) {
		const parsed = input(() => {
			const item = record(body, [
				'schemaVersion',
				'eventId',
				'connectorId',
				'generation',
				'workspaceId',
				'sourceId'
			]);
			if (item.schemaVersion !== 1) throw new Error();
			return {
				id: uuid(transferId),
				binding: {
					eventId: uuid(item.eventId),
					connectorId: uuid(item.connectorId),
					generation: integer(item.generation),
					workspaceId: uuid(item.workspaceId),
					sourceId: uuid(item.sourceId)
				}
			};
		});
		return this.service.context(parsed.id, parsed.binding);
	}
}
