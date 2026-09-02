export const PIPELINE_STAGE_STATES = ['OPEN', 'WON', 'LOST'] as const;

export type PipelineStageState = (typeof PIPELINE_STAGE_STATES)[number];

export interface PipelineTemplateStageDefinition {
	readonly key: string;
	readonly name: string;
	readonly order: number;
	readonly state: PipelineStageState;
}

export interface PipelineTemplateDefinition {
	readonly key: string;
	readonly version: number;
	readonly name: string;
	readonly description: string;
	readonly industryTags: readonly string[];
	readonly isBlank: boolean;
	readonly stages: readonly PipelineTemplateStageDefinition[];
}

export interface PipelineTemplateCatalogResponse {
	readonly schemaVersion: 1;
	readonly catalogRevision: 1;
	readonly templates: readonly PipelineTemplateDefinition[];
}
