import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Header,
	Headers,
	HttpCode,
	Post,
	Query
} from '@nestjs/common';
import {
	UpdateWorkspaceBrandingDto,
	WorkspaceBrandingQueryDto
} from './workspace-branding.dto';
import { CrmWorkspaceBrandingService } from './workspace-branding.service';

@Controller('crm/access/workspace/branding')
export class CrmWorkspaceBrandingController {
	constructor(private readonly branding: CrmWorkspaceBrandingService) {}

	@Get()
	@Header('Cache-Control', 'no-store')
	get(
		@Headers('authorization') token: string | undefined,
		@Query() query: WorkspaceBrandingQueryDto
	) {
		return this.branding.get(token, query);
	}

	@Post()
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	update(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: UpdateWorkspaceBrandingDto
	) {
		if (key !== dto.commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		return this.branding.update(token, dto);
	}
}
