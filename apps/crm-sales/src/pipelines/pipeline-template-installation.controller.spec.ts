import {
	ArgumentMetadata,
	BadRequestException,
	ValidationPipe
} from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { CrmSalesInternalGuard } from '../internal/crm-sales-internal.guard';
import { PipelineTemplateInstallationController } from './pipeline-template-installation.controller';
import { InstallPipelineTemplateDto } from './pipeline-template-installation.dto';
import { PipelineTemplateInstallationService } from './pipeline-template-installation.service';

const COMMAND_ID = '802aa340-132f-4d3e-b6ae-9f6158d72f62';
const WORKSPACE_ID = 'c82f4e68-b738-401d-9d0d-e73bd35e3247';
const DTO: InstallPipelineTemplateDto = {
	schemaVersion: 1,
	commandId: COMMAND_ID,
	workspaceId: WORKSPACE_ID,
	templateKey: 'universal-sales',
	templateVersion: 1,
	installedBySubject: 'identity-subject'
};

function createHarness() {
	const installation = {
		install: jest.fn().mockResolvedValue({ schemaVersion: 1 }),
		getInstallation: jest.fn().mockResolvedValue({ schemaVersion: 1 })
	};
	return {
		controller: new PipelineTemplateInstallationController(
			installation as unknown as PipelineTemplateInstallationService
		),
		installation
	};
}

describe('PipelineTemplateInstallationController', () => {
	it('keeps the endpoint behind the crm-access internal guard', () => {
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				PipelineTemplateInstallationController
			)
		).toBe('internal/v1/crm-access/pipelines');
		expect(
			Reflect.getMetadata(
				GUARDS_METADATA,
				PipelineTemplateInstallationController
			)
		).toContain(CrmSalesInternalGuard);
	});

	it('requires Idempotency-Key to match commandId exactly', async () => {
		const { controller, installation } = createHarness();
		expect(() => controller.installTemplate(undefined, DTO)).toThrow(
			BadRequestException
		);
		expect(() => controller.installTemplate(WORKSPACE_ID, DTO)).toThrow(
			BadRequestException
		);
		expect(installation.install).not.toHaveBeenCalled();

		await expect(
			controller.installTemplate(COMMAND_ID, DTO)
		).resolves.toEqual({
			schemaVersion: 1
		});
		expect(installation.install).toHaveBeenCalledWith(DTO);
	});

	it('delegates the workspace-scoped recovery lookup', async () => {
		const { controller, installation } = createHarness();
		await expect(
			controller.getInstallation(WORKSPACE_ID)
		).resolves.toEqual({
			schemaVersion: 1
		});
		expect(installation.getInstallation).toHaveBeenCalledWith(
			WORKSPACE_ID
		);
	});

	it('rejects unknown fields and values outside the internal DTO contract', async () => {
		const pipe = new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			forbidUnknownValues: true,
			transform: true
		});
		const metadata: ArgumentMetadata = {
			type: 'body',
			metatype: InstallPipelineTemplateDto
		};

		await expect(
			pipe.transform({ ...DTO, unexpected: true }, metadata)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			pipe.transform({ ...DTO, templateVersion: 32_768 }, metadata)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			pipe.transform(
				{ ...DTO, installedBySubject: 'subject with spaces' },
				metadata
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
