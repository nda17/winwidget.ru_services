import {
	ConflictException,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma } from '@prisma/crm-sales-client';
import { createHash } from 'node:crypto';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { PipelineTemplateCatalogService } from '../templates/pipeline-template-catalog.service';
import type { InstallPipelineTemplateDto } from './pipeline-template-installation.dto';
import { PipelineTemplateInstallationService } from './pipeline-template-installation.service';

const COMMAND_ID = '802aa340-132f-4d3e-b6ae-9f6158d72f62';
const RECOVERY_COMMAND_ID = '462a5dbf-3625-4a9f-8ce5-6e91f0e14ca8';
const WORKSPACE_ID = 'c82f4e68-b738-401d-9d0d-e73bd35e3247';
const PIPELINE_ID = '73e71ad3-fce0-4a41-9f32-d671259fa76e';
const INSTALLATION_ID = '834e3fb5-b934-4194-860b-d3e3cc755167';
const COMMAND: InstallPipelineTemplateDto = {
	schemaVersion: 1,
	commandId: COMMAND_ID,
	workspaceId: WORKSPACE_ID,
	templateKey: 'universal-sales',
	templateVersion: 1,
	installedBySubject: 'identity-subject'
};

type TransactionMock = ReturnType<typeof createTransaction>;

function requestHash(command: InstallPipelineTemplateDto): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				schemaVersion: command.schemaVersion,
				workspaceId: command.workspaceId,
				templateKey: command.templateKey,
				templateVersion: command.templateVersion,
				installedBySubject: command.installedBySubject
			})
		)
		.digest('hex');
}

const catalog = new PipelineTemplateCatalogService();
const fingerprint = catalog.getTemplateFingerprint('universal-sales', 1)!;

function installation(overrides: Record<string, unknown> = {}) {
	return {
		id: INSTALLATION_ID,
		initialCommandId: COMMAND_ID,
		workspaceId: WORKSPACE_ID,
		pipelineId: PIPELINE_ID,
		templateKey: 'universal-sales',
		templateVersion: 1,
		templateFingerprint: fingerprint,
		installedBySubject: 'identity-subject',
		createdAt: new Date('2026-09-04T09:00:00.000Z'),
		...overrides
	};
}

function storedCommand(
	command: InstallPipelineTemplateDto = COMMAND,
	overrides: Record<string, unknown> = {}
) {
	return {
		commandId: command.commandId,
		installationId: INSTALLATION_ID,
		requestHash: requestHash(command),
		requestHashVersion: 1,
		requestedBySubject: command.installedBySubject,
		createdAt: new Date('2026-09-04T09:00:00.000Z'),
		installation: installation(),
		...overrides
	};
}

function createTransaction() {
	return {
		$executeRaw: jest.fn().mockResolvedValue(1),
		pipeline: {
			create: jest.fn().mockResolvedValue({ id: PIPELINE_ID })
		},
		pipelineTemplateInstallation: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockResolvedValue(installation())
		},
		pipelineTemplateInstallationCommand: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockResolvedValue(storedCommand())
		}
	};
}

function createHarness(transaction = createTransaction()) {
	const prisma = {
		$transaction: jest.fn(
			async (callback: (value: TransactionMock) => Promise<unknown>) =>
				callback(transaction)
		),
		pipelineTemplateInstallation: {
			findUnique: jest.fn().mockResolvedValue(null)
		}
	};
	return {
		service: new PipelineTemplateInstallationService(
			prisma as unknown as CrmSalesPrismaService,
			catalog
		),
		prisma,
		transaction
	};
}

describe('PipelineTemplateInstallationService', () => {
	it('atomically clones the exact template and records the command receipt', async () => {
		const { service, prisma, transaction } = createHarness();

		await expect(service.install(COMMAND)).resolves.toEqual({
			schemaVersion: 1,
			installation: {
				commandId: COMMAND_ID,
				initialCommandId: COMMAND_ID,
				workspaceId: WORKSPACE_ID,
				pipelineId: PIPELINE_ID,
				templateKey: 'universal-sales',
				templateVersion: 1,
				templateFingerprint: fingerprint
			}
		});

		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
		expect(transaction.$executeRaw).toHaveBeenCalledTimes(2);
		const template = catalog.getTemplate('universal-sales', 1)!;
		expect(transaction.pipeline.create).toHaveBeenCalledWith({
			data: {
				workspaceId: WORKSPACE_ID,
				name: template.name,
				templateKey: template.key,
				templateVersion: template.version,
				templateFingerprint: fingerprint,
				installedBySubject: COMMAND.installedBySubject,
				stages: {
					create: template.stages.map(stage => ({
						key: stage.key,
						name: stage.name,
						position: stage.order,
						state: stage.state
					}))
				}
			}
		});
		expect(
			transaction.pipelineTemplateInstallationCommand.create
		).toHaveBeenCalledWith({
			data: {
				commandId: COMMAND_ID,
				installationId: INSTALLATION_ID,
				requestHash: requestHash(COMMAND),
				requestHashVersion: 1,
				requestedBySubject: COMMAND.installedBySubject
			}
		});
	});

	it('replays the original command only when its request hash matches', async () => {
		const transaction = createTransaction();
		transaction.pipelineTemplateInstallationCommand.findUnique.mockResolvedValue(
			storedCommand()
		);
		const { service } = createHarness(transaction);

		await expect(service.install(COMMAND)).resolves.toMatchObject({
			installation: {
				commandId: COMMAND_ID,
				initialCommandId: COMMAND_ID,
				pipelineId: PIPELINE_ID
			}
		});
		expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
		expect(transaction.pipeline.create).not.toHaveBeenCalled();

		await expect(
			service.install({ ...COMMAND, templateKey: 'blank' })
		).rejects.toBeInstanceOf(ConflictException);
	});

	it('attaches a new command receipt when recovering the same template pair', async () => {
		const transaction = createTransaction();
		transaction.pipelineTemplateInstallation.findUnique.mockResolvedValue(
			installation()
		);
		const { service } = createHarness(transaction);
		const recovery = {
			...COMMAND,
			commandId: RECOVERY_COMMAND_ID,
			installedBySubject: 'replacement-owner'
		};

		await expect(service.install(recovery)).resolves.toMatchObject({
			installation: {
				commandId: RECOVERY_COMMAND_ID,
				initialCommandId: COMMAND_ID,
				pipelineId: PIPELINE_ID,
				templateFingerprint: fingerprint
			}
		});
		expect(transaction.pipeline.create).not.toHaveBeenCalled();
		expect(
			transaction.pipelineTemplateInstallationCommand.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				commandId: RECOVERY_COMMAND_ID,
				installationId: INSTALLATION_ID,
				requestedBySubject: 'replacement-owner'
			})
		});
	});

	it('rejects another template pair without recording a receipt', async () => {
		const transaction = createTransaction();
		transaction.pipelineTemplateInstallation.findUnique.mockResolvedValue(
			installation()
		);
		const { service } = createHarness(transaction);

		await expect(
			service.install({
				...COMMAND,
				commandId: RECOVERY_COMMAND_ID,
				templateKey: 'blank'
			})
		).rejects.toBeInstanceOf(ConflictException);
		expect(
			transaction.pipelineTemplateInstallationCommand.create
		).not.toHaveBeenCalled();
	});

	it('fails closed when stored provenance no longer matches the catalog', async () => {
		const transaction = createTransaction();
		transaction.pipelineTemplateInstallation.findUnique.mockResolvedValue(
			installation({ templateFingerprint: '0'.repeat(64) })
		);
		const { service } = createHarness(transaction);

		await expect(
			service.install({ ...COMMAND, commandId: RECOVERY_COMMAND_ID })
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(
			transaction.pipelineTemplateInstallationCommand.create
		).not.toHaveBeenCalled();
	});

	it('propagates a receipt failure so the database transaction can roll back', async () => {
		const transaction = createTransaction();
		transaction.pipelineTemplateInstallationCommand.create.mockRejectedValue(
			new Error('forced receipt failure')
		);
		const { service } = createHarness(transaction);

		await expect(service.install(COMMAND)).rejects.toThrow(
			'forced receipt failure'
		);
		expect(transaction.pipeline.create).toHaveBeenCalledTimes(1);
		expect(
			transaction.pipelineTemplateInstallation.create
		).toHaveBeenCalledTimes(1);
	});

	it('retries a bounded serialization conflict', async () => {
		const transaction = createTransaction();
		const retryable = new Prisma.PrismaClientKnownRequestError(
			'serialization failure',
			{ code: 'P2034', clientVersion: '5.22.0' }
		);
		const { service, prisma } = createHarness(transaction);
		prisma.$transaction
			.mockRejectedValueOnce(retryable)
			.mockImplementationOnce(
				async (callback: (value: TransactionMock) => Promise<unknown>) =>
					callback(transaction)
			);

		await expect(service.install(COMMAND)).resolves.toMatchObject({
			installation: { pipelineId: PIPELINE_ID }
		});
		expect(prisma.$transaction).toHaveBeenCalledTimes(2);
	});

	it('returns a stable workspace installation summary or a typed 404', async () => {
		const { service, prisma } = createHarness();
		prisma.pipelineTemplateInstallation.findUnique.mockResolvedValue(
			installation()
		);
		await expect(service.getInstallation(WORKSPACE_ID)).resolves.toEqual({
			schemaVersion: 1,
			installation: {
				initialCommandId: COMMAND_ID,
				workspaceId: WORKSPACE_ID,
				pipelineId: PIPELINE_ID,
				templateKey: 'universal-sales',
				templateVersion: 1,
				templateFingerprint: fingerprint
			}
		});

		prisma.pipelineTemplateInstallation.findUnique.mockResolvedValue(null);
		await expect(
			service.getInstallation(WORKSPACE_ID)
		).rejects.toBeInstanceOf(NotFoundException);
	});
});
