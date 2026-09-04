import { createHash } from 'node:crypto';
import { PATH_METADATA } from '@nestjs/common/constants';
import { PipelineTemplateCatalogController } from './pipeline-template-catalog.controller';
import { PipelineTemplateCatalogService } from './pipeline-template-catalog.service';
import {
	buildPipelineTemplateVersionIndex,
	getPipelineTemplateFingerprint,
	getPipelineTemplate,
	getPipelineTemplateFromIndex,
	MAX_PIPELINE_TEMPLATE_VERSION,
	PIPELINE_TEMPLATE_FINGERPRINTS,
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

const EXPECTED_TEMPLATE_FINGERPRINTS = {
	'universal-sales@1':
		'3db975e233207eab18fb8a4c5675a3c9aa10341e3a30011b46da5072bd88a842',
	'appointment-services@1':
		'384e27ade3d71d6f1caa6d677486512840515e892093684b4461695f48c44442',
	'retail-orders@1':
		'4e7e04c181d23e6bc285bf9de7dc5732338c723dc4b379f60f7b0b9df20670e1',
	'wholesale-manufacturing@1':
		'b28ece4c5d893783822eaac8aceefcebaf43b9030c7342ab5c469f5422766512',
	'custom-projects@1':
		'b748c99ad5ee44ebdf0cbb7b5931a3b80c14de139e5dbf48ff4bea367cca325f',
	'education-courses@1':
		'10e22e2da4ac8e20f82294f5d7b306eb5a7405f043054784f27c9530a09dfa3e',
	'memberships-fitness@1':
		'1d0e86d7d1857f69ede19219fa6bf30b5116d0686436f88ed4b33e0f0dafa704',
	'construction-repair@1':
		'0d8baab45673133c99eba8ac5033f9297150c7c5803cb8c87fecffaf78d82c75',
	'logistics@1':
		'371f579d1778f1b742f2c0cb004c4bee885acc4a86b3cfcd5fd277ed3b3086a6',
	'blank@1':
		'f30349ec7b8b34c06eb09fd080646fccf07c6ab24d443d88e0a2483aac41d201'
} as const;

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

	it('pins every immutable template version independently', () => {
		expect(PIPELINE_TEMPLATE_FINGERPRINTS).toEqual(
			EXPECTED_TEMPLATE_FINGERPRINTS
		);
		expect(Object.isFrozen(PIPELINE_TEMPLATE_FINGERPRINTS)).toBe(true);
		for (const [versionId, fingerprint] of Object.entries(
			EXPECTED_TEMPLATE_FINGERPRINTS
		)) {
			const separator = versionId.lastIndexOf('@');
			const key = versionId.slice(0, separator);
			const version = Number(versionId.slice(separator + 1));
			expect(getPipelineTemplateFingerprint(key, version)).toBe(
				fingerprint
			);
		}
		expect(
			getPipelineTemplateFingerprint('universal-sales', 2)
		).toBeUndefined();
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

	it('rejects a template version outside the PostgreSQL SMALLINT contract', () => {
		const template = PIPELINE_TEMPLATES_V1[0];
		expect(() =>
			validatePipelineTemplateCatalog([{ ...template, version: 0 }])
		).toThrow('Invalid template version');
		expect(() =>
			validatePipelineTemplateCatalog([
				{ ...template, version: MAX_PIPELINE_TEMPLATE_VERSION + 1 }
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
