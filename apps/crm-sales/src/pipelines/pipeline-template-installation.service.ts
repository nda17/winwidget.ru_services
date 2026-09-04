import {
	ConflictException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma } from '@prisma/crm-sales-client';
import { createHash } from 'node:crypto';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { PipelineTemplateCatalogService } from '../templates/pipeline-template-catalog.service';
import type { InstallPipelineTemplateDto } from './pipeline-template-installation.dto';

const COMMAND_INCLUDE = {
	installation: true
} satisfies Prisma.PipelineTemplateInstallationCommandInclude;
const TRANSACTION_RETRY_LIMIT = 3;

type StoredCommand = Prisma.PipelineTemplateInstallationCommandGetPayload<{
	include: typeof COMMAND_INCLUDE;
}>;
type StoredInstallation =
	Prisma.PipelineTemplateInstallationGetPayload<object>;

export interface PipelineTemplateInstallationResponse {
	schemaVersion: 1;
	installation: {
		commandId: string;
		initialCommandId: string;
		workspaceId: string;
		pipelineId: string;
		templateKey: string;
		templateVersion: number;
		templateFingerprint: string;
	};
}

export type PipelineTemplateInstallationSummary = Omit<
	PipelineTemplateInstallationResponse,
	'installation'
> & {
	installation: Omit<
		PipelineTemplateInstallationResponse['installation'],
		'commandId'
	>;
};

@Injectable()
export class PipelineTemplateInstallationService {
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly catalog: PipelineTemplateCatalogService
	) {}

	async install(
		command: InstallPipelineTemplateDto
	): Promise<PipelineTemplateInstallationResponse> {
		const requestHash = this.requestHash(command);

		for (
			let attempt = 1;
			attempt <= TRANSACTION_RETRY_LIMIT;
			attempt += 1
		) {
			try {
				return await this.prisma.$transaction(
					async transaction => {
						await this.lock(
							transaction,
							`crm-sales:pipeline-install:command:${command.commandId}`
						);
						const prior =
							await transaction.pipelineTemplateInstallationCommand.findUnique(
								{
									where: { commandId: command.commandId },
									include: COMMAND_INCLUDE
								}
							);
						if (prior) {
							return this.replay(prior, requestHash, command.commandId);
						}

						const template = this.catalog.getTemplate(
							command.templateKey,
							command.templateVersion
						);
						const fingerprint = this.catalog.getTemplateFingerprint(
							command.templateKey,
							command.templateVersion
						);
						if (!template || !fingerprint) {
							throw new NotFoundException({
								message: 'Pipeline template version was not found',
								code: 'crm_template_version_not_found'
							});
						}

						await this.lock(
							transaction,
							`crm-sales:pipeline-install:workspace:${command.workspaceId}`
						);
						const existing =
							await transaction.pipelineTemplateInstallation.findUnique({
								where: { workspaceId: command.workspaceId }
							});
						if (existing) {
							this.assertSameTemplate(existing, command, fingerprint);
							await this.createCommandReceipt(
								transaction,
								existing.id,
								command,
								requestHash
							);
							return this.response(existing, command.commandId);
						}

						const pipeline = await transaction.pipeline.create({
							data: {
								workspaceId: command.workspaceId,
								name: template.name,
								templateKey: template.key,
								templateVersion: template.version,
								templateFingerprint: fingerprint,
								installedBySubject: command.installedBySubject,
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
						const installation =
							await transaction.pipelineTemplateInstallation.create({
								data: {
									initialCommandId: command.commandId,
									workspaceId: command.workspaceId,
									pipelineId: pipeline.id,
									templateKey: template.key,
									templateVersion: template.version,
									templateFingerprint: fingerprint,
									installedBySubject: command.installedBySubject
								}
							});
						await this.createCommandReceipt(
							transaction,
							installation.id,
							command,
							requestHash
						);
						return this.response(installation, command.commandId);
					},
					{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
				);
			} catch (error) {
				if (
					attempt === TRANSACTION_RETRY_LIMIT ||
					!this.isRetryableTransactionError(error)
				) {
					throw error;
				}
			}
		}

		throw new ServiceUnavailableException(
			'Pipeline installation could not be completed'
		);
	}

	async getInstallation(
		workspaceId: string
	): Promise<PipelineTemplateInstallationSummary> {
		const installation =
			await this.prisma.pipelineTemplateInstallation.findUnique({
				where: { workspaceId }
			});
		if (!installation) {
			throw new NotFoundException({
				message: 'Workspace pipeline installation was not found',
				code: 'crm_pipeline_installation_not_found'
			});
		}
		return {
			schemaVersion: 1,
			installation: {
				initialCommandId: installation.initialCommandId,
				workspaceId: installation.workspaceId,
				pipelineId: installation.pipelineId,
				templateKey: installation.templateKey,
				templateVersion: installation.templateVersion,
				templateFingerprint: installation.templateFingerprint
			}
		};
	}

	private async lock(
		transaction: Prisma.TransactionClient,
		key: string
	): Promise<void> {
		await transaction.$executeRaw(Prisma.sql`
			SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
		`);
	}

	private async createCommandReceipt(
		transaction: Prisma.TransactionClient,
		installationId: string,
		command: InstallPipelineTemplateDto,
		requestHash: string
	): Promise<void> {
		await transaction.pipelineTemplateInstallationCommand.create({
			data: {
				commandId: command.commandId,
				installationId,
				requestHash,
				requestHashVersion: 1,
				requestedBySubject: command.installedBySubject
			}
		});
	}

	private assertSameTemplate(
		installation: StoredInstallation,
		command: InstallPipelineTemplateDto,
		fingerprint: string
	): void {
		if (
			installation.templateKey !== command.templateKey ||
			installation.templateVersion !== command.templateVersion
		) {
			throw new ConflictException({
				message: 'Workspace pipeline is already initialized',
				code: 'crm_pipeline_already_initialized'
			});
		}
		if (installation.templateFingerprint !== fingerprint) {
			throw new ServiceUnavailableException({
				message: 'Stored pipeline template fingerprint is invalid',
				code: 'crm_template_fingerprint_mismatch'
			});
		}
	}

	private replay(
		command: StoredCommand,
		requestHash: string,
		requestedCommandId: string
	): PipelineTemplateInstallationResponse {
		if (
			command.requestHashVersion !== 1 ||
			command.requestHash !== requestHash
		) {
			throw new ConflictException({
				message:
					'Command ID conflicts with a previous pipeline installation',
				code: 'crm_pipeline_install_command_conflict'
			});
		}
		return this.response(command.installation, requestedCommandId);
	}

	private response(
		installation: StoredInstallation,
		commandId: string
	): PipelineTemplateInstallationResponse {
		return {
			schemaVersion: 1,
			installation: {
				commandId,
				initialCommandId: installation.initialCommandId,
				workspaceId: installation.workspaceId,
				pipelineId: installation.pipelineId,
				templateKey: installation.templateKey,
				templateVersion: installation.templateVersion,
				templateFingerprint: installation.templateFingerprint
			}
		};
	}

	private requestHash(command: InstallPipelineTemplateDto): string {
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

	private isRetryableTransactionError(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			['P2002', 'P2034'].includes(error.code)
		);
	}
}
