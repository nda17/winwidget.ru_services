import {
	ConflictException,
	ForbiddenException,
	HttpException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma } from '@prisma/crm-intake-client';
import {
	IntakeAuthorizationClient,
	assertIntakePermission
} from '../access/intake-authorization.client';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import {
	IntakePageQuery,
	VersionedIntakeCommandDto
} from '../intake/intake.dto';
import {
	parseWidgetTransferEvent,
	TRANSFER_CONSUMER,
	transferHash
} from './widget-transfer.contract';
import {
	transferConstraints,
	transferJson,
	transferOutbox,
	transferView
} from './widget-transfer.processor';
import { widgetTransfersEnabled } from './widget-transfer.config';
class RetryBusy extends Error {}
@Injectable()
export class WidgetTransferService {
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly authorization: IntakeAuthorizationClient
	) {}
	private async actor(
		bearer: string | undefined,
		workspaceId: string,
		write = false
	) {
		const actor = await this.authorization.authorize(bearer, workspaceId);
		if (
			actor.workspaceId !== workspaceId ||
			!['OWNER', 'CRM_ADMIN'].includes(actor.role)
		)
			throw new ForbiddenException('Managed transfer access denied');
		assertIntakePermission(
			actor,
			write ? 'intake:manage-sources' : 'intake:read',
			write
		);
		return actor;
	}
	async list(
		bearer: string | undefined,
		sourceId: string,
		query: IntakePageQuery
	) {
		await this.actor(bearer, query.workspaceId);
		if (
			!(await this.prisma.managedWidgetSource.findFirst({
				where: { id: sourceId, workspaceId: query.workspaceId }
			}))
		)
			throw new NotFoundException();
		const where = {
			workspaceId: query.workspaceId,
			sourceId,
			consumer: TRANSFER_CONSUMER
		};
		const [rows, total] = await this.prisma.$transaction(
			[
				this.prisma.widgetTransferReceipt.findMany({
					where,
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize,
					orderBy: [{ createdAt: 'desc' }, { transferId: 'desc' }]
				}),
				this.prisma.widgetTransferReceipt.count({ where })
			],
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
		return {
			schemaVersion: 1,
			items: rows.map(transferView),
			page: query.page,
			pageSize: query.pageSize,
			total
		};
	}
	async retry(
		bearer: string | undefined,
		sourceId: string,
		transferId: string,
		dto: VersionedIntakeCommandDto
	) {
		if (!widgetTransfersEnabled()) throw new NotFoundException();
		const actor = await this.actor(bearer, dto.workspaceId, true);
		const hash = transferHash({
			actor: actor.subject,
			workspaceId: actor.workspaceId,
			kind: 'widget-transfer',
			operation: 'retry',
			sourceId,
			transferId,
			payload: dto
		});
		for (let attempt = 0; attempt < 6; attempt++)
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRawUnsafe("SET LOCAL lock_timeout='1000ms'");
						await tx.$executeRawUnsafe(
							"SET LOCAL statement_timeout='3500ms'"
						);
						const [lock] = await tx.$queryRaw<
							Array<{ locked: boolean }>
						>`SELECT pg_try_advisory_xact_lock(hashtextextended(${'crm-intake:command:' + dto.commandId},0)) AS locked`;
						if (!lock?.locked) throw new RetryBusy();
						const row = await tx.widgetTransferReceipt.findFirst({
							where: {
								transferId,
								consumer: TRANSFER_CONSUMER,
								sourceId,
								workspaceId: actor.workspaceId
							}
						});
						if (!row)
							throw new NotFoundException('Widget transfer not found');
						const previous = await tx.intakeCommand.findUnique({
							where: { commandId: dto.commandId }
						});
						if (previous) {
							if (
								previous.workspaceId !== actor.workspaceId ||
								previous.actorSubject !== actor.subject ||
								previous.entityKind !== 'widget-transfer' ||
								previous.entityId !== transferId ||
								previous.requestHash !== hash
							)
								throw new ConflictException({
									code: 'crm_intake_command_conflict'
								});
							return previous.response;
						}
						if (row.version !== dto.expectedVersion)
							throw new ConflictException({
								code: 'crm_intake_version_conflict'
							});
						if (
							!['BLOCKED', 'ERROR'].includes(row.status) ||
							!row.originalDeadline ||
							row.originalDeadline <= new Date()
						)
							throw new ConflictException({
								code: 'crm_widget_transfer_retry_not_available'
							});
						const source = await tx.managedWidgetSource.findFirst({
							where: {
								id: sourceId,
								workspaceId: actor.workspaceId,
								enabled: true,
								generation: row.generation
							}
						});
						if (!source)
							throw new ConflictException({
								code: 'crm_widget_transfer_retry_not_available'
							});
						const changed = await tx.widgetTransferReceipt.updateMany({
							where: {
								eventId: row.eventId,
								consumer: TRANSFER_CONSUMER,
								version: dto.expectedVersion,
								status: { in: ['BLOCKED', 'ERROR'] }
							},
							data: {
								status: 'RETRY_PENDING',
								retryGeneration: { increment: 1 },
								retryAttempt: 0,
								lastErrorCode: null,
								leaseToken: null,
								leaseUntil: null,
								version: { increment: 1 }
							}
						});
						if (changed.count !== 1)
							throw new ConflictException({
								code: 'crm_intake_version_conflict'
							});
						const updated =
							await tx.widgetTransferReceipt.findUniqueOrThrow({
								where: {
									eventId_consumer: {
										eventId: row.eventId,
										consumer: TRANSFER_CONSUMER
									}
								}
							});
						await tx.widgetTransferOutbox.create({
							data: transferOutbox(
								parseWidgetTransferEvent(row.event),
								updated.retryGeneration,
								0,
								'MAIN'
							)
						});
						const response = transferJson({
							schemaVersion: 1,
							transfer: transferView(updated),
							command: { id: dto.commandId, state: 'QUEUED' }
						});
						await tx.intakeActivity.create({
							data: {
								workspaceId: actor.workspaceId,
								entityId: transferId,
								entityKind: 'widget-transfer',
								commandId: dto.commandId,
								actorSubject: actor.subject,
								action: 'WIDGET_TRANSFER_RETRY_QUEUED',
								entityVersion: updated.version
							}
						});
						await tx.intakeCommand.create({
							data: {
								commandId: dto.commandId,
								workspaceId: actor.workspaceId,
								entityId: transferId,
								entityKind: 'widget-transfer',
								actorSubject: actor.subject,
								requestHash: hash,
								response
							}
						});
						await transferConstraints(tx);
						return response;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 1500,
						timeout: 5000
					}
				);
			} catch (error) {
				if (error instanceof HttpException) throw error;
				const retry =
					error instanceof RetryBusy ||
					(error instanceof Prisma.PrismaClientKnownRequestError &&
						['P2002', 'P2034'].includes(error.code));
				if (!retry || attempt === 5)
					throw new ServiceUnavailableException(
						'Widget transfer retry unavailable; retry the same command'
					);
				await new Promise(resolve =>
					setTimeout(resolve, 20 * (attempt + 1))
				);
			}
		throw new ServiceUnavailableException();
	}
}
