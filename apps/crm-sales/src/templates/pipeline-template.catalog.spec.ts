import { createHash } from 'node:crypto';
import { PATH_METADATA } from '@nestjs/common/constants';
import { PipelineTemplateCatalogController } from './pipeline-template-catalog.controller';
import { PipelineTemplateCatalogService } from './pipeline-template-catalog.service';
import {
	buildPipelineTemplateVersionIndex,
	getPipelineTemplate,
	getPipelineTemplateFromIndex,
	PIPELINE_TEMPLATE_VERSIONS,
	PIPELINE_TEMPLATES_V1,
	validatePipelineTemplateCatalog
} from './pipeline-template.catalog';

const EXPECTED_TEMPLATE_KEYS = [
	'universal-sales',
	'appointment-services',
	'retail-orders',
	'wholesale-manufacturing',
	'custom-projects',
	'education-courses',
	'memberships-fitness',
	'construction-repair',
	'logistics',
	'blank'
];

describe('pipeline template catalog v1', () => {
	it('publishes exactly the agreed ten templates', () => {
		expect(PIPELINE_TEMPLATES_V1.map(template => template.key)).toEqual(
			EXPECTED_TEMPLATE_KEYS
		);
		expect(PIPELINE_TEMPLATES_V1).toHaveLength(10);
		expect(
			PIPELINE_TEMPLATES_V1.every(template => template.version === 1)
		).toBe(true);
	});

	it('uses Russian display text and unique ordered stage keys', () => {
		for (const template of PIPELINE_TEMPLATES_V1) {
			expect(template.name).toMatch(/[А-Яа-яЁё]/);
			expect(template.description).toMatch(/[А-Яа-яЁё]/);
			expect(new Set(template.stages.map(stage => stage.key)).size).toBe(
				template.stages.length
			);
			expect(template.stages.map(stage => stage.order)).toEqual(
				template.stages.map((_, index) => index + 1)
			);
			expect(
				template.stages.every(stage => /[А-Яа-яЁё]/.test(stage.name))
			).toBe(true);
		}
	});

	it('keeps OPEN stages before one WON and one LOST terminal stage', () => {
		for (const template of PIPELINE_TEMPLATES_V1) {
			const states = template.stages.map(stage => stage.state);
			expect(
				states.filter(state => state === 'OPEN').length
			).toBeGreaterThan(0);
			expect(states.filter(state => state === 'WON')).toHaveLength(1);
			expect(states.filter(state => state === 'LOST')).toHaveLength(1);
			expect(states.slice(-2)).toEqual(['WON', 'LOST']);
		}
	});

	it('deep-freezes immutable template definitions', () => {
		expect(Object.isFrozen(PIPELINE_TEMPLATES_V1)).toBe(true);
		for (const template of PIPELINE_TEMPLATES_V1) {
			expect(Object.isFrozen(template)).toBe(true);
			expect(Object.isFrozen(template.industryTags)).toBe(true);
			expect(Object.isFrozen(template.stages)).toBe(true);
			expect(template.stages.every(Object.isFrozen)).toBe(true);
		}
	});

	it('supports coexisting immutable versions and exact version lookup', () => {
		const versionOne = PIPELINE_TEMPLATES_V1[0];
		const versionTwo = Object.freeze({ ...versionOne, version: 2 });
		const index = buildPipelineTemplateVersionIndex([
			versionOne,
			versionTwo
		]);

		expect(getPipelineTemplateFromIndex(index, 'universal-sales', 1)).toBe(
			versionOne
		);
		expect(getPipelineTemplateFromIndex(index, 'universal-sales', 2)).toBe(
			versionTwo
		);
		expect(getPipelineTemplate('universal-sales', 1)).toBe(versionOne);
		expect(getPipelineTemplate('universal-sales', 2)).toBeUndefined();
		expect(PIPELINE_TEMPLATE_VERSIONS['universal-sales@1']).toBe(
			versionOne
		);
		expect(Object.isFrozen(PIPELINE_TEMPLATE_VERSIONS)).toBe(true);
		expect(Object.isFrozen(index)).toBe(true);
	});

	it('pins the canonical v1 payload fingerprint', () => {
		expect(
			createHash('sha256')
				.update(JSON.stringify(PIPELINE_TEMPLATES_V1))
				.digest('hex')
		).toBe(
			'ecbb5ff6a22d7d45617433a0cb3341acd35e499289a776bcfbf267fb70041280'
		);
	});

	it('rejects duplicate template versions and duplicate stage keys', () => {
		expect(() =>
			validatePipelineTemplateCatalog([
				...PIPELINE_TEMPLATES_V1,
				PIPELINE_TEMPLATES_V1[0]
			])
		).toThrow('Duplicate template version');

		const template = PIPELINE_TEMPLATES_V1[0];
		expect(() =>
			validatePipelineTemplateCatalog([
				{
					...template,
					stages: [...template.stages, template.stages[0]]
				}
			])
		).toThrow('Duplicate stage key');
	});

	it('rejects a non-positive or unsafe template version', () => {
		const template = PIPELINE_TEMPLATES_V1[0];
		expect(() =>
			validatePipelineTemplateCatalog([{ ...template, version: 0 }])
		).toThrow('Invalid template version');
		expect(() =>
			validatePipelineTemplateCatalog([
				{ ...template, version: Number.MAX_SAFE_INTEGER + 1 }
			])
		).toThrow('Invalid template version');
	});

	it('rejects broken order and terminal semantics', () => {
		const template = PIPELINE_TEMPLATES_V1[0];
		expect(() =>
			validatePipelineTemplateCatalog([
				{
					...template,
					stages: template.stages.map((stage, index) =>
						index === 0 ? { ...stage, order: 2 } : stage
					)
				}
			])
		).toThrow('Invalid stage order');

		expect(() =>
			validatePipelineTemplateCatalog([
				{
					...template,
					stages: template.stages.map(stage => ({
						...stage,
						state: 'OPEN' as const
					}))
				}
			])
		).toThrow('Invalid OPEN/WON/LOST structure');
	});

	it('rejects values that the frontend contract cannot accept', () => {
		const template = PIPELINE_TEMPLATES_V1[0];
		expect(() =>
			validatePipelineTemplateCatalog([
				{
					...template,
					industryTags: ['duplicate', 'duplicate']
				}
			])
		).toThrow('Invalid industry tags');
		expect(() =>
			validatePipelineTemplateCatalog([
				{
					...template,
					name: 'x'.repeat(201)
				}
			])
		).toThrow('Template text is required');
	});
});

describe('PipelineTemplateCatalogController', () => {
	it('exposes the read-only catalog at the CRM templates route', () => {
		expect(
			Reflect.getMetadata(PATH_METADATA, PipelineTemplateCatalogController)
		).toBe('crm/templates');

		const catalog = new PipelineTemplateCatalogService();
		const controller = new PipelineTemplateCatalogController(catalog);
		expect(controller.listTemplates()).toEqual({
			schemaVersion: 1,
			catalogRevision: 1,
			templates: PIPELINE_TEMPLATES_V1
		});
		expect(Object.isFrozen(controller.listTemplates())).toBe(true);
		expect(catalog.getTemplate('blank', 1)?.key).toBe('blank');
	});
});
