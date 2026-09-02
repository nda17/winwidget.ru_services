import { Controller, Get, Header, HttpCode } from '@nestjs/common';
import { PipelineTemplateCatalogService } from './pipeline-template-catalog.service';

@Controller('crm/templates')
export class PipelineTemplateCatalogController {
	constructor(private readonly catalog: PipelineTemplateCatalogService) {}

	@Get()
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	listTemplates() {
		return this.catalog.listTemplates();
	}
}
