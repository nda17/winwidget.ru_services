import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	UseGuards
} from '@nestjs/common';
import { CrmSalesInternalGuard } from '../internal/crm-sales-internal.guard';
import { InstallPipelineTemplateDto } from './pipeline-template-installation.dto';
import { PipelineTemplateInstallationService } from './pipeline-template-installation.service';

@Controller('internal/v1/crm-access/pipelines')
@UseGuards(CrmSalesInternalGuard)
export class PipelineTemplateInstallationController {
	constructor(
		private readonly installation: PipelineTemplateInstallationService
	) {}

	@Post('install-template')
	@HttpCode(200)
	installTemplate(
		@Headers('idempotency-key') idempotencyKey: string | undefined,
		@Body() dto: InstallPipelineTemplateDto
	) {
		if (idempotencyKey !== dto.commandId) {
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		}
		return this.installation.install(dto);
	}

	@Get('workspaces/:workspaceId/installation')
	@HttpCode(200)
	getInstallation(
		@Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string
	) {
		return this.installation.getInstallation(workspaceId);
	}
}
