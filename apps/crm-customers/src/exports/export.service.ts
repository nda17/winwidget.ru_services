import {
	BadRequestException,
	ForbiddenException,
	HttpException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma } from '@prisma/crm-customers-client';
import { performance } from 'node:perf_hooks';
import { CrmCustomersPrismaService } from '../prisma/crm-customers-prisma.service';
import { CustomersAuthorizationClient } from '../access/customers-authorization.client';
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
	contacts: [
		'id',
		'workspaceId',
		'name',
		'notes',
		'createdBySubject',
		'teamId',
		'version',
		'archivedAt',
		'createdAt',
		'updatedAt',
		'phone',
		'email',
		'companyId'
	],
	companies: [
		'id',
		'workspaceId',
		'name',
		'notes',
		'createdBySubject',
		'teamId',
		'version',
		'archivedAt',
		'createdAt',
		'updatedAt',
		'inn',
		'website'
	]
} as const;
type Entity = 'contacts' | 'companies';

@Injectable()
export class CustomersExportService {
	private readonly concurrency = new ExportConcurrency();
	constructor(
		private readonly prisma: CrmCustomersPrismaService,
		private readonly authorization: CustomersAuthorizationClient
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
		assertExportAuthority(context, workspaceId, 'customers');
		const release = this.concurrency.claim(context);
		try {
			const started = performance.now();
			const columns = EXPORT_COLUMNS[entity];
			const scope = exportScope(context, 'createdBySubject');
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
							if (entity === 'contacts')
								return (
									await tx.contact.findMany({
										where,
										orderBy: { id: 'asc' },
										take,
										select: {
											id: true,
											workspaceId: true,
											name: true,
											notes: true,
											createdBySubject: true,
											teamId: true,
											version: true,
											archivedAt: true,
											createdAt: true,
											updatedAt: true,
											phone: true,
											email: true,
											companyId: true
										}
									})
								).map(row => exportItem(row, columns));
							return (
								await tx.company.findMany({
									where,
									orderBy: { id: 'asc' },
									take,
									select: {
										id: true,
										workspaceId: true,
										name: true,
										notes: true,
										createdBySubject: true,
										teamId: true,
										version: true,
										archivedAt: true,
										createdAt: true,
										updatedAt: true,
										inn: true,
										website: true
									}
								})
							).map(row => exportItem(row, columns));
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
			assertExportAuthority(fresh, workspaceId, 'customers');
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
