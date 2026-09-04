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
import { CrmAccessService } from './crm-access.service';
import {
	ActivateCrmTrialDto,
	CrmBootstrapQueryDto,
	InstallCrmPipelineTemplateDto
} from './crm-access.dto';

@Controller('crm/access')
export class CrmAccessController {
	constructor(private readonly access: CrmAccessService) {}

	@Get('bootstrap')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	bootstrap(
		@Headers('authorization') authorization: string | undefined,
		@Query() query: CrmBootstrapQueryDto
	) {
		return this.access.bootstrap(authorization, query.workspaceId);
	}

	@Post('trial')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	activateTrial(
		@Headers('authorization') authorization: string | undefined,
		@Headers('idempotency-key') idempotencyKey: string | undefined,
		@Body() dto: ActivateCrmTrialDto
	) {
		if (idempotencyKey !== dto.commandId) {
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		}
		return this.access.activateTrial(authorization, dto);
	}

	@Post('onboarding/template')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	installTemplate(
		@Headers('authorization') authorization: string | undefined,
		@Headers('idempotency-key') idempotencyKey: string | undefined,
		@Body() dto: InstallCrmPipelineTemplateDto
	) {
		if (idempotencyKey !== dto.commandId) {
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		}
		return this.access.installTemplate(authorization, dto);
	}
}
