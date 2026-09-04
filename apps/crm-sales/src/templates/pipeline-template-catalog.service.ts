import { Injectable } from '@nestjs/common';
import {
	getPipelineTemplateFingerprint,
	getPipelineTemplate,
	PIPELINE_TEMPLATES_V1
} from './pipeline-template.catalog';
import {
	PipelineTemplateCatalogResponse,
	PipelineTemplateDefinition
} from './pipeline-template.types';

const PIPELINE_TEMPLATE_CATALOG_V1: PipelineTemplateCatalogResponse =
	Object.freeze({
		schemaVersion: 1,
		catalogRevision: 1,
		templates: PIPELINE_TEMPLATES_V1
	});

@Injectable()
export class PipelineTemplateCatalogService {
	listTemplates(): PipelineTemplateCatalogResponse {
		return PIPELINE_TEMPLATE_CATALOG_V1;
	}

	getTemplate(
		key: string,
		version: number
	): PipelineTemplateDefinition | undefined {
		return getPipelineTemplate(key, version);
	}

	getTemplateFingerprint(
		key: string,
		version: number
	): string | undefined {
		return getPipelineTemplateFingerprint(key, version);
	}
}
