import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	HttpException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { CsvImport, Prisma } from '@prisma/crm-intake-client';
import { createHash, randomUUID } from 'node:crypto';
import {
	assertIntakePermission,
	IntakeAuthorization
} from '../access/intake-authorization.client';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import {
	CSV_TEXT_PATTERN,
	ImportIntakeCsvDto
} from './intake-csv-import.dto';

function importScope(
	context: IntakeAuthorization
): Prisma.CsvImportWhereInput {
	return {
		workspaceId: context.workspaceId,
		...(context.dataScope === 'ALL'
			? {}
			: context.dataScope === 'OWN'
				? { createdBySubject: context.subject }
				: {
						OR: [
							{ createdBySubject: context.subject },
							{ teamId: { in: context.teamIds } }
						]
					})
	};
}

function view(batch: CsvImport) {
	return {
		schemaVersion: 1 as const,
		import: {
			id: batch.id,
			workspaceId: batch.workspaceId,
			createdBySubject: batch.createdBySubject,
			teamId: batch.teamId,
			label: batch.label,
			rowCount: batch.rowCount,
			createdAt: batch.createdAt.toISOString()
		}
	};
}

class CsvCommandBusy extends Error {}

@Injectable()
export class IntakeCsvImportService {
	constructor(private readonly prisma: CrmIntakePrismaService) {}

	async get(
		context: IntakeAuthorization,
		workspaceId: string,
		id: string
	) {
		this.authorize(context, workspaceId, false);
		return view(await this.find(this.prisma, context, id));
	}

	async create(context: IntakeAuthorization, dto: ImportIntakeCsvDto) {
		this.authorize(context, dto.workspaceId, true);
		if (dto.teamId && !context.teamIds.includes(dto.teamId))
			throw new ForbiddenException(
				'Team must belong to the authorized context'
			);
		if (
			!dto.label.trim() ||
			['.', '..'].includes(dto.label) ||
			/[/\\\x00-\x1f\x7f]/.test(dto.label)
		)
			throw new BadRequestException(
				'A filename without path or control characters is required'
			);
		if (
			!Array.isArray(dto.rows) ||
			dto.rows.length < 1 ||
			dto.rows.length > 250
		)
			throw new BadRequestException(
				'CSV import requires between 1 and 250 rows'
			);
		if (
			!CSV_TEXT_PATTERN.test(dto.label) ||
			dto.rows.some(row =>
				[row.title, row.name, row.phone, row.email, row.message].some(
					value =>
						value !== null &&
						(typeof value !== 'string' || !CSV_TEXT_PATTERN.test(value))
				)
			)
		)
			throw new BadRequestException(
				'CSV text contains unsupported characters'
			);
		// Bind the exact input values, not only their normalized persisted form.
		const requestHash = createHash('sha256')
			.update(
				JSON.stringify({
					schemaVersion: 1,
					workspaceId: dto.workspaceId,
					actor: context.subject,
					kind: 'import',
					operation: 'csv',
					label: dto.label,
					teamId: dto.teamId,
					rows: dto.rows.map(row => ({
						title: row.title,
						name: row.name,
						phone: row.phone,
						email: row.email,
						message: row.message
					}))
				})
			)
			.digest('hex');
		const rows = dto.rows.map(row => ({
			title: row.title.trim(),
			name: row.name.trim(),
			phone: row.phone,
			email: row.email?.trim().toLowerCase() || null,
			message: row.message?.trim() || null
		}));
		if (rows.some(row => !row.title || !row.name))
			throw new BadRequestException(
				'Title and name are required for every row'
			);
		for (let attempt = 0; attempt < 6; attempt++) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
						await tx.$executeRaw`SET LOCAL statement_timeout = '3500ms'`;
						const locks = await tx.$queryRaw<{ locked: boolean }[]>`
						SELECT pg_try_advisory_xact_lock(hashtextextended(${`crm-intake:command:${dto.commandId}`}, 0)) AS locked`;
						if (!locks[0]?.locked) throw new CsvCommandBusy();
						const receipt = await tx.intakeCommand.findUnique({
							where: { commandId: dto.commandId }
						});
						if (receipt) {
							if (
								receipt.workspaceId !== context.workspaceId ||
								receipt.actorSubject !== context.subject ||
								receipt.entityKind !== 'import' ||
								receipt.entityId !== dto.commandId ||
								receipt.requestHash !== requestHash
							)
								throw new ConflictException({
									code: 'crm_intake_command_conflict',
									message:
										'Command ID was already used for another request'
								});
							return view(await this.find(tx, context, dto.commandId));
						}
						const batch = await tx.csvImport.create({
							data: {
								id: dto.commandId,
								workspaceId: context.workspaceId,
								createdBySubject: context.subject,
								teamId: dto.teamId,
								label: dto.label,
								rowCount: rows.length
							}
						});
						const receivedAt = batch.createdAt;
						const entries = rows.map(row => ({
							...row,
							id: randomUUID(),
							workspaceId: context.workspaceId,
							createdBySubject: context.subject,
							teamId: dto.teamId,
							origin: 'CSV',
							sourceId: null,
							status: 'NEW',
							version: 1,
							receivedAt,
							updatedAt: receivedAt
						}));
						const audits = entries.map(entry => ({
							id: randomUUID(),
							commandId: randomUUID(),
							workspaceId: context.workspaceId,
							entityId: entry.id,
							entityKind: 'entry',
							actorSubject: context.subject,
							action: 'CREATED',
							entityVersion: 1,
							createdAt: receivedAt
						}));
						await tx.inboxEntry.createMany({ data: entries });
						await tx.intakeActivity.createMany({ data: audits });
						await tx.csvImportRow.createMany({
							data: entries.map((entry, index) => ({
								importId: batch.id,
								workspaceId: context.workspaceId,
								entryId: entry.id,
								rowNumber: index + 1,
								auditCommandId: audits[index].commandId
							}))
						});
						const response = view(batch);
						await tx.intakeCommand.create({
							data: {
								commandId: dto.commandId,
								workspaceId: context.workspaceId,
								actorSubject: context.subject,
								entityKind: 'import',
								entityId: batch.id,
								requestHash,
								response
							}
						});
						// Force deferred proof checks inside the callback; never rely on
						// a driver surfacing a failed COMMIT as a rejected transaction.
						await tx.$executeRaw`SET CONSTRAINTS crm_intake.csv_imports_command_fkey,
						crm_intake.csv_imports_integrity_check, crm_intake.csv_import_rows_integrity_check IMMEDIATE`;
						return response;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 2000,
						timeout: 5000
					}
				);
			} catch (error) {
				const retry =
					error instanceof CsvCommandBusy ||
					(error instanceof Prisma.PrismaClientKnownRequestError &&
						(['P2034', 'P2002'].includes(error.code) ||
							(error.code === 'P2010' &&
								['55P03', '57014'].includes(String(error.meta?.code)))));
				if (!retry) {
					if (error instanceof HttpException) throw error;
					throw new ServiceUnavailableException({
						code: 'crm_intake_import_unavailable',
						message: 'CSV import is unavailable; retry the same command'
					});
				}
				if (attempt === 5)
					throw new ServiceUnavailableException({
						code: 'crm_intake_retry_required',
						message: 'Retry the same command'
					});
				await new Promise(resolve =>
					setTimeout(resolve, 20 * (attempt + 1))
				);
			}
		}
		throw new ServiceUnavailableException('CSV import is unavailable');
	}

	private authorize(
		context: IntakeAuthorization,
		workspaceId: string,
		write: boolean
	) {
		if (context.workspaceId !== workspaceId)
			throw new ForbiddenException('Workspace scope mismatch');
		assertIntakePermission(
			context,
			write ? 'intake:write' : 'intake:read',
			write
		);
		if (
			write &&
			!['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER'].includes(
				context.role
			)
		)
			throw new ForbiddenException('CSV import is not allowed');
	}

	private async find(
		tx: Prisma.TransactionClient,
		context: IntakeAuthorization,
		id: string
	) {
		const batch = await tx.csvImport.findFirst({
			where: { AND: [importScope(context), { id }] }
		});
		if (!batch)
			throw new NotFoundException({
				code: 'crm_intake_import_not_found',
				message: 'CSV import was not found'
			});
		return batch;
	}
}
