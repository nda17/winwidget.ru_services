import {
	BadRequestException,
	ForbiddenException,
	HttpException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma } from '@prisma/crm-sales-client';
import { performance } from 'node:perf_hooks';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { SalesAccessClient } from '../sales/sales-access';
import {
	assertExportAuthority,
	exportActorHash,
	exportCheckpoint,
	ExportConcurrency,
	ExportFile,
	ExportFormat,
	exportItem,
	exportScope,
	exportScopeFingerprint,
	materializeExport
} from './export-format';

export const EXPORT_COLUMNS = {
	deals: [
		'id',
		'workspaceId',
		'version',
		'title',
		'currency',
		'amountMinor',
		'pipelineId',
		'stageId',
		'status',
		'contactId',
		'contactName',
		'assignedToSubject',
		'teamId',
		'nextTaskId',
		'archivedAt',
		'createdAt',
		'updatedAt',
		'pipelineName',
		'templateKey',
		'templateVersion',
		'stageKey',
		'stageName',
		'stagePosition'
	],
	tasks: [
		'id',
		'workspaceId',
		'dealId',
		'version',
		'title',
		'dueAt',
		'status',
		'assignedToSubject',
		'completedAt',
		'createdAt',
		'updatedAt'
	]
} as const;
type Entity = 'deals' | 'tasks';

@Injectable()
export class SalesExportService {
	private readonly concurrency = new ExportConcurrency();
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly authorization: SalesAccessClient
	) {}
	async prepare(
		bearer: string,
		workspaceId: string,
		entity: Entity,
		format: ExportFormat,
		signal?: AbortSignal
	): Promise<ExportFile> {
		if (
			!Object.prototype.hasOwnProperty.call(EXPORT_COLUMNS, entity) ||
			!['json', 'csv'].includes(format)
		)
			throw new BadRequestException('Invalid export request');
		const context = await this.authorization.authorize(
			bearer,
			workspaceId
		);
		assertExportAuthority(context, workspaceId, 'sales');
		const release = this.concurrency.claim(context);
		try {
			const started = performance.now();
			const columns = EXPORT_COLUMNS[entity];
			const scope = exportScope(context, 'assignedToSubject');
			const snapshot = await this.prisma.$transaction(
				async tx => {
					await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
					await tx.$executeRawUnsafe(
						"SET LOCAL statement_timeout = '4000ms'"
					);
					const [clock] = await tx.$queryRaw<
						Array<{ snapshotAt: Date }>
					>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS "snapshotAt"`;
					const snapshotAt = clock.snapshotAt.toISOString();
					const file = await materializeExport({
						workspaceId,
						entity,
						format,
						snapshotAt,
						columns,
						started,
						signal,
						fetchPage: async (after, take) => {
							const where = {
								...scope,
								...(after ? { id: { gt: after } } : {})
							};
							if (entity === 'tasks')
								return (
									await tx.salesTask.findMany({
										where: {
											workspaceId,
											deal: scope,
											...(after ? { id: { gt: after } } : {})
										},
										orderBy: { id: 'asc' },
										take,
										select: {
											id: true,
											workspaceId: true,
											dealId: true,
											version: true,
											title: true,
											dueAt: true,
											status: true,
											assignedToSubject: true,
											completedAt: true,
											createdAt: true,
											updatedAt: true
										}
									})
								).map(row => exportItem(row, columns));
							const rows = await tx.deal.findMany({
								where,
								orderBy: { id: 'asc' },
								take,
								select: {
									id: true,
									workspaceId: true,
									version: true,
									title: true,
									currency: true,
									amountMinor: true,
									pipelineId: true,
									stageId: true,
									status: true,
									contactId: true,
									contactName: true,
									assignedToSubject: true,
									teamId: true,
									nextTaskId: true,
									archivedAt: true,
									createdAt: true,
									updatedAt: true,
									pipeline: {
										select: {
											name: true,
											templateKey: true,
											templateVersion: true
										}
									},
									stage: {
										select: { key: true, name: true, position: true }
									}
								}
							});
							return rows.map(row =>
								exportItem(
									{
										...row,
										pipelineName: row.pipeline.name,
										templateKey: row.pipeline.templateKey,
										templateVersion: row.pipeline.templateVersion,
										stageKey: row.stage.key,
										stageName: row.stage.name,
										stagePosition: row.stage.position
									},
									columns
								)
							);
						}
					});
					return { ...file, snapshotAt };
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
					maxWait: 500,
					timeout: 4500
				}
			);
			exportCheckpoint(started, signal);
			// Revalidate after the complete snapshot; a downgrade to READ_ONLY still permits owner export.
			const fresh = await this.authorization.authorize(
				bearer,
				workspaceId
			);
			assertExportAuthority(fresh, workspaceId, 'sales');
			if (
				exportScopeFingerprint(context) !== exportScopeFingerprint(fresh)
			)
				throw new ForbiddenException({
					code: 'crm_export_scope_changed',
					message: 'Export authority changed; retry'
				});
			if (signal?.aborted)
				throw new ServiceUnavailableException({
					code: 'crm_export_cancelled',
					message: 'Export was cancelled'
				});
			// Technical PREPARED event, never an assertion that the browser downloaded the file.
			await this.prisma.exportAudit.create({
				data: {
					workspaceId,
					actorSubject: fresh.subject,
					entity,
					format,
					rowCount: snapshot.rowCount,
					byteCount: snapshot.body.byteLength,
					snapshotAt: new Date(snapshot.snapshotAt)
				}
			});
			if (signal?.aborted)
				throw new ServiceUnavailableException({
					code: 'crm_export_cancelled',
					message: 'Export was cancelled'
				});
			return {
				workspaceId,
				entity,
				format,
				...snapshot,
				actorHash: exportActorHash(fresh.subject)
			};
		} catch (error) {
			if (error instanceof HttpException) throw error;
			// Do not expose/log ORM exception values, business rows or bearer tokens.
			throw new ServiceUnavailableException({
				code: 'crm_export_unavailable',
				message: 'Export is temporarily unavailable'
			});
		} finally {
			release();
		}
	}
}
