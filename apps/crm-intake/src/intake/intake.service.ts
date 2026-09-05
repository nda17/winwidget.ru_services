import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	InboxEntry,
	IntakeSource,
	Prisma
} from '@prisma/crm-intake-client';
import { createHash } from 'node:crypto';
import {
	assertIntakePermission,
	IntakeAuthorization
} from '../access/intake-authorization.client';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import {
	CreateInboxEntryDto,
	CreateIntakeSourceDto,
	InboxListQuery,
	IntakeCommandDto,
	IntakePageQuery,
	RejectInboxEntryDto,
	RotateIntakeSourceTokenDto,
	VersionedIntakeCommandDto
} from './intake.dto';

export function intakeEntryScope(
	context: IntakeAuthorization
): Prisma.InboxEntryWhereInput {
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

export function inboxEntryView(entry: InboxEntry) {
	return {
		id: entry.id,
		workspaceId: entry.workspaceId,
		title: entry.title,
		name: entry.name,
		phone: entry.phone,
		email: entry.email,
		message: entry.message,
		origin: entry.origin,
		sourceId: entry.sourceId,
		status: entry.status,
		createdBySubject: entry.createdBySubject,
		teamId: entry.teamId,
		version: entry.version,
		contactId: entry.contactId,
		dealId: entry.dealId,
		rejectionReason: entry.rejectionReason,
		receivedAt: entry.receivedAt.toISOString(),
		updatedAt: entry.updatedAt.toISOString(),
		acceptedAt: entry.acceptedAt?.toISOString() ?? null,
		rejectedAt: entry.rejectedAt?.toISOString() ?? null
	};
}

export function intakeSourceView(source: IntakeSource) {
	return {
		id: source.id,
		workspaceId: source.workspaceId,
		name: source.name,
		kind: source.kind,
		tokenVersion: source.tokenVersion,
		createdBySubject: source.createdBySubject,
		teamId: source.teamId,
		version: source.version,
		revokedAt: source.revokedAt?.toISOString() ?? null,
		createdAt: source.createdAt.toISOString(),
		updatedAt: source.updatedAt.toISOString()
	};
}

export function hashIntakeSourceToken(token: string): string {
	if (
		!/^[A-Za-z0-9_-]{43}$/.test(token) ||
		Buffer.from(token, 'base64url').byteLength !== 32 ||
		Buffer.from(token, 'base64url').toString('base64url') !== token
	)
		throw new BadRequestException(
			'Source token must encode exactly 32 random bytes as canonical base64url'
		);
	return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class IntakeService {
	constructor(private readonly prisma: CrmIntakePrismaService) {}

	async list(context: IntakeAuthorization, query: InboxListQuery) {
		this.assertContext(context, query.workspaceId, 'intake:read');
		const search = query.search?.trim();
		const where: Prisma.InboxEntryWhereInput = {
			AND: [
				intakeEntryScope(context),
				...(query.status ? [{ status: query.status }] : []),
				...(search
					? [
							{
								OR: [
									{
										title: {
											contains: search,
											mode: 'insensitive' as const
										}
									},
									{
										name: {
											contains: search,
											mode: 'insensitive' as const
										}
									},
									{ phone: { contains: search } },
									{
										email: {
											contains: search,
											mode: 'insensitive' as const
										}
									}
								]
							}
						]
					: [])
			]
		};
		const [items, total] = await this.prisma.$transaction(
			[
				this.prisma.inboxEntry.findMany({
					where,
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize,
					orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }]
				}),
				this.prisma.inboxEntry.count({ where })
			],
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
		return {
			schemaVersion: 1,
			items: items.map(inboxEntryView),
			page: query.page,
			pageSize: query.pageSize,
			total
		};
	}

	async get(
		context: IntakeAuthorization,
		workspaceId: string,
		id: string
	) {
		this.assertContext(context, workspaceId, 'intake:read');
		const entry = await this.entry(this.prisma, context, id);
		return { schemaVersion: 1, entry: inboxEntryView(entry) };
	}

	async activities(
		context: IntakeAuthorization,
		id: string,
		query: IntakePageQuery
	) {
		this.assertContext(context, query.workspaceId, 'intake:read');
		await this.entry(this.prisma, context, id);
		const where = {
			workspaceId: context.workspaceId,
			entityId: id,
			entityKind: 'entry'
		};
		const [items, total] = await this.prisma.$transaction(
			[
				this.prisma.intakeActivity.findMany({
					where,
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize,
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
				}),
				this.prisma.intakeActivity.count({ where })
			],
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
		return {
			schemaVersion: 1,
			items: items.map(item => ({
				...item,
				createdAt: item.createdAt.toISOString()
			})),
			page: query.page,
			pageSize: query.pageSize,
			total
		};
	}

	async createManual(
		context: IntakeAuthorization,
		dto: CreateInboxEntryDto
	) {
		this.assertContext(context, dto.workspaceId, 'intake:write', true);
		this.assertTeam(context, dto.teamId);
		const data = {
			title: dto.title.trim(),
			name: dto.name.trim(),
			phone: dto.phone ?? null,
			email: dto.email?.trim().toLowerCase() || null,
			message: dto.message?.trim() || null,
			teamId: dto.teamId ?? null
		};
		if (!data.title || !data.name)
			throw new BadRequestException('Title and name are required');
		return this.command(
			context,
			dto,
			'entry',
			'create',
			data,
			null,
			async tx => {
				const entry = await tx.inboxEntry.create({
					data: {
						workspaceId: context.workspaceId,
						createdBySubject: context.subject,
						origin: 'MANUAL',
						...data
					}
				});
				return {
					id: entry.id,
					version: entry.version,
					action: 'CREATED',
					response: { schemaVersion: 1, entry: inboxEntryView(entry) }
				};
			}
		);
	}

	async reject(
		context: IntakeAuthorization,
		id: string,
		dto: RejectInboxEntryDto
	) {
		this.assertContext(context, dto.workspaceId, 'intake:write', true);
		const reason = dto.reason.trim();
		if (!reason)
			throw new BadRequestException('Rejection reason is required');
		return this.command(
			context,
			dto,
			'entry',
			'reject',
			{ expectedVersion: dto.expectedVersion, reason },
			id,
			async tx => {
				if (
					await tx.acceptance.findFirst({
						where: {
							workspaceId: context.workspaceId,
							entryId: id,
							status: { not: 'CANCELLED' }
						}
					})
				)
					throw new ConflictException('Acceptance is already in progress');
				const prior = await this.entry(tx, context, id);
				if (prior.version !== dto.expectedVersion)
					throw this.versionConflict();
				if (prior.status !== 'NEW')
					throw new ConflictException({
						code: 'crm_intake_entry_not_new',
						message: 'Only a new Inbox entry can be rejected'
					});
				const result = await tx.inboxEntry.updateMany({
					where: {
						AND: [
							intakeEntryScope(context),
							{ id, version: dto.expectedVersion, status: 'NEW' }
						]
					},
					data: {
						status: 'REJECTED',
						rejectionReason: reason,
						rejectedAt: new Date(),
						version: { increment: 1 }
					}
				});
				if (result.count !== 1) throw this.versionConflict();
				const entry = await this.entry(tx, context, id);
				return {
					id,
					version: entry.version,
					action: 'REJECTED',
					response: { schemaVersion: 1, entry: inboxEntryView(entry) }
				};
			}
		);
	}

	async listSources(context: IntakeAuthorization, query: IntakePageQuery) {
		this.assertSourceManager(context, query.workspaceId);
		const where = { workspaceId: context.workspaceId };
		const [items, total] = await this.prisma.$transaction(
			[
				this.prisma.intakeSource.findMany({
					where,
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize,
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
				}),
				this.prisma.intakeSource.count({ where })
			],
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
		return {
			schemaVersion: 1,
			items: items.map(intakeSourceView),
			page: query.page,
			pageSize: query.pageSize,
			total
		};
	}

	async createSource(
		context: IntakeAuthorization,
		dto: CreateIntakeSourceDto
	) {
		this.assertSourceManager(context, dto.workspaceId, true);
		this.assertTeam(context, dto.teamId);
		const data = {
			name: dto.name.trim(),
			teamId: dto.teamId ?? null,
			tokenHash: hashIntakeSourceToken(dto.token)
		};
		if (!data.name)
			throw new BadRequestException('Source name is required');
		return this.command(
			context,
			dto,
			'source',
			'create',
			data,
			null,
			async tx => {
				const source = await tx.intakeSource.create({
					data: {
						workspaceId: context.workspaceId,
						createdBySubject: context.subject,
						kind: 'API',
						...data
					}
				});
				return {
					id: source.id,
					version: source.version,
					action: 'SOURCE_CREATED',
					response: { schemaVersion: 1, source: intakeSourceView(source) }
				};
			}
		);
	}

	async rotateSource(
		context: IntakeAuthorization,
		id: string,
		dto: RotateIntakeSourceTokenDto
	) {
		this.assertSourceManager(context, dto.workspaceId, true);
		const tokenHash = hashIntakeSourceToken(dto.token);
		return this.command(
			context,
			dto,
			'source',
			'rotate',
			{ expectedVersion: dto.expectedVersion, tokenHash },
			id,
			async tx => {
				const prior = await this.source(tx, context, id);
				this.assertSourceVersion(prior, dto.expectedVersion);
				if (prior.tokenHash === tokenHash)
					throw new ConflictException({
						code: 'crm_intake_token_unchanged',
						message: 'Rotation requires a new token'
					});
				const result = await tx.intakeSource.updateMany({
					where: {
						id,
						workspaceId: context.workspaceId,
						version: dto.expectedVersion,
						revokedAt: null
					},
					data: {
						tokenHash,
						tokenVersion: { increment: 1 },
						version: { increment: 1 }
					}
				});
				if (result.count !== 1) throw this.versionConflict();
				const source = await this.source(tx, context, id);
				return {
					id,
					version: source.version,
					action: 'SOURCE_TOKEN_ROTATED',
					response: { schemaVersion: 1, source: intakeSourceView(source) }
				};
			}
		);
	}

	async revokeSource(
		context: IntakeAuthorization,
		id: string,
		dto: VersionedIntakeCommandDto
	) {
		this.assertSourceManager(context, dto.workspaceId, true);
		return this.command(
			context,
			dto,
			'source',
			'revoke',
			{ expectedVersion: dto.expectedVersion },
			id,
			async tx => {
				const prior = await this.source(tx, context, id);
				this.assertSourceVersion(prior, dto.expectedVersion);
				const result = await tx.intakeSource.updateMany({
					where: {
						id,
						workspaceId: context.workspaceId,
						version: dto.expectedVersion,
						revokedAt: null
					},
					data: { revokedAt: new Date(), version: { increment: 1 } }
				});
				if (result.count !== 1) throw this.versionConflict();
				const source = await this.source(tx, context, id);
				return {
					id,
					version: source.version,
					action: 'SOURCE_REVOKED',
					response: { schemaVersion: 1, source: intakeSourceView(source) }
				};
			}
		);
	}

	private async command(
		context: IntakeAuthorization,
		dto: IntakeCommandDto,
		kind: 'entry' | 'source',
		operation: string,
		payload: object,
		entityId: string | null,
		apply: (tx: Prisma.TransactionClient) => Promise<{
			id: string;
			version: number;
			action: string;
			response: Prisma.InputJsonObject;
		}>
	) {
		const requestHash = createHash('sha256')
			.update(
				JSON.stringify({
					schemaVersion: 1,
					workspaceId: context.workspaceId,
					actor: context.subject,
					kind,
					operation,
					entityId,
					payload
				})
			)
			.digest('hex');
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw(
							Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-intake:command:${dto.commandId}`}, 0))`
						);
						const receipt = await tx.intakeCommand.findUnique({
							where: { commandId: dto.commandId }
						});
						if (receipt) {
							if (
								receipt.requestHash !== requestHash ||
								receipt.workspaceId !== context.workspaceId ||
								receipt.actorSubject !== context.subject ||
								receipt.entityKind !== kind
							)
								throw new ConflictException({
									code: 'crm_intake_command_conflict',
									message:
										'Command ID was already used for another request'
								});
							if (kind === 'entry')
								await this.entry(tx, context, receipt.entityId);
							else await this.source(tx, context, receipt.entityId);
							return receipt.response;
						}
						const result = await apply(tx);
						await tx.intakeActivity.create({
							data: {
								workspaceId: context.workspaceId,
								entityId: result.id,
								entityKind: kind,
								commandId: dto.commandId,
								actorSubject: context.subject,
								action: result.action,
								entityVersion: result.version
							}
						});
						await tx.intakeCommand.create({
							data: {
								commandId: dto.commandId,
								workspaceId: context.workspaceId,
								entityId: result.id,
								entityKind: kind,
								actorSubject: context.subject,
								requestHash,
								response: result.response
							}
						});
						return result.response;
					},
					{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
				);
			} catch (error) {
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === 'P2002' &&
					String(error.meta?.target).includes('token_hash')
				)
					throw new ConflictException({
						code: 'crm_intake_token_reused',
						message: 'Source token must be unique'
					});
				if (
					!(error instanceof Prisma.PrismaClientKnownRequestError) ||
					!['P2034', 'P2002'].includes(error.code)
				)
					throw error;
				if (attempt === 2)
					throw new ServiceUnavailableException({
						code: 'crm_intake_retry_required',
						message: 'Retry the same command'
					});
			}
		}
		throw new ServiceUnavailableException('Intake command is unavailable');
	}

	private async entry(
		tx: Prisma.TransactionClient,
		context: IntakeAuthorization,
		id: string
	) {
		const entry = await tx.inboxEntry.findFirst({
			where: { AND: [intakeEntryScope(context), { id }] }
		});
		if (!entry)
			throw new NotFoundException({
				code: 'crm_intake_entry_not_found',
				message: 'Inbox entry was not found'
			});
		return entry;
	}
	private async source(
		tx: Prisma.TransactionClient,
		context: IntakeAuthorization,
		id: string
	) {
		const source = await tx.intakeSource.findFirst({
			where: { workspaceId: context.workspaceId, id }
		});
		if (!source)
			throw new NotFoundException({
				code: 'crm_intake_source_not_found',
				message: 'Intake source was not found'
			});
		return source;
	}
	private assertContext(
		context: IntakeAuthorization,
		workspaceId: string,
		permission: string,
		write = false
	) {
		if (context.workspaceId !== workspaceId)
			throw new ForbiddenException('Workspace scope mismatch');
		assertIntakePermission(context, permission, write);
	}
	private assertSourceManager(
		context: IntakeAuthorization,
		workspaceId: string,
		write = false
	) {
		this.assertContext(
			context,
			workspaceId,
			write ? 'intake:manage-sources' : 'intake:read',
			write
		);
		if (!['OWNER', 'CRM_ADMIN'].includes(context.role))
			throw new ForbiddenException(
				'Only workspace owner and CRM admin can manage sources'
			);
	}
	private assertTeam(
		context: IntakeAuthorization,
		teamId?: string | null
	) {
		if (teamId && !context.teamIds.includes(teamId))
			throw new ForbiddenException(
				'Team must belong to the authorized context'
			);
	}
	private assertSourceVersion(
		source: IntakeSource,
		expectedVersion: number
	) {
		if (source.version !== expectedVersion) throw this.versionConflict();
		if (source.revokedAt)
			throw new ConflictException({
				code: 'crm_intake_source_revoked',
				message: 'Source has already been revoked'
			});
	}
	private versionConflict() {
		return new ConflictException({
			code: 'crm_intake_version_conflict',
			message: 'Record has changed; reload it before editing'
		});
	}
}
