import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	HttpException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { ManagedWidgetSource, Prisma } from '@prisma/crm-intake-client';
import { randomUUID } from 'node:crypto';
import {
	IntakeAuthorization,
	IntakeAuthorizationClient,
	assertIntakePermission
} from '../access/intake-authorization.client';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { IntakePageQuery } from '../intake/intake.dto';
import { WidgetControlConfig } from './widget-control.config';
import { controlHash, ControlEvent } from './widget-control.contract';
import {
	CreateWidgetSourceDto,
	ConfigureWidgetSourceDto,
	VersionedWidgetSourceDto,
	WidgetSourceCommandDto
} from './widget-source.dto';
import {
	WidgetsControlClient,
	WidgetsControlDependencyError
} from './widgets-control.client';
class CommandBusy extends Error {}
const json = (value: unknown) =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
export function widgetSourceView(row: ManagedWidgetSource) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		kind: 'WIDGET' as const,
		name: row.name,
		widgetType: row.widgetType,
		widgetId: row.widgetId,
		teamId: row.teamId,
		createdBySubject: row.createdBySubject,
		version: row.version,
		enabled: row.enabled,
		generation: row.generation,
		controlVersion: row.controlVersion,
		appliedControlVersion: row.appliedControlVersion,
		appliedGeneration: row.appliedGeneration,
		syncState: row.syncState,
		lastErrorCode: row.lastErrorCode,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		syncedAt: row.syncedAt?.toISOString() ?? null
	};
}
export async function widgetControlConstraints(
	tx: Prisma.TransactionClient
) {
	await tx.$executeRawUnsafe(
		'SET CONSTRAINTS crm_intake.widget_control_jobs_command_fkey, crm_intake.managed_widget_sources_current_job_fkey, crm_intake.managed_widget_sources_integrity, crm_intake.widget_control_jobs_integrity IMMEDIATE'
	);
}
export function controlOutbox(
	event: ControlEvent,
	route: 'MAIN' | 'DLQ' = 'MAIN',
	retryAttempt = 0,
	suffix = 'main'
) {
	return {
		eventId: event.eventId,
		deduplicationKey: event.eventId + ':' + suffix,
		route,
		payload: json(event),
		retryAttempt
	};
}
@Injectable()
export class WidgetSourceService {
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly authorization: IntakeAuthorizationClient,
		private readonly widgets: WidgetsControlClient,
		private readonly config: WidgetControlConfig
	) {}
	private enabled() {
		if (!this.config.enabled) throw new NotFoundException();
	}
	private async actor(
		bearer: string | undefined,
		workspaceId: string,
		write: boolean
	) {
		this.enabled();
		const context = await this.authorization.authorize(
			bearer,
			workspaceId
		);
		if (
			context.workspaceId !== workspaceId ||
			!['OWNER', 'CRM_ADMIN'].includes(context.role)
		)
			throw new ForbiddenException('Managed source access denied');
		assertIntakePermission(
			context,
			write ? 'intake:manage-sources' : 'intake:read',
			write
		);
		return context;
	}
	async candidates(bearer: string | undefined, query: IntakePageQuery) {
		const actor = await this.actor(bearer, query.workspaceId, true);
		const authority = await this.authorization.authorizeWidgetSource(
			query.workspaceId,
			actor.subject
		);
		try {
			const response = await this.widgets.candidates(
				authority.ownerSubject,
				query.page,
				query.pageSize
			);
			const {
				eligible,
				reason,
				plan,
				startsAt,
				expiresAt,
				checkedAt,
				validUntil
			} = response.eligibility;
			return {
				schemaVersion: 1,
				workspaceId: query.workspaceId,
				page: response.page,
				pageSize: response.pageSize,
				total: response.total,
				eligibility: {
					eligible,
					reason,
					plan,
					startsAt,
					expiresAt,
					checkedAt,
					validUntil
				},
				items: response.items.map(item => {
					const { connector, ...widget } = item;
					return {
						...widget,
						connection: connector
							? connector.workspaceId === query.workspaceId
								? 'THIS_WORKSPACE'
								: 'OTHER_WORKSPACE'
							: 'NONE',
						sourceId:
							connector?.workspaceId === query.workspaceId
								? connector.sourceId
								: null
					};
				})
			};
		} catch (error) {
			if (error instanceof WidgetsControlDependencyError)
				throw new ServiceUnavailableException({
					code: 'crm_widget_source_dependency_unavailable',
					message: 'Widgets candidates unavailable'
				});
			throw error;
		}
	}
	async list(bearer: string | undefined, query: IntakePageQuery) {
		await this.actor(bearer, query.workspaceId, false);
		const where = { workspaceId: query.workspaceId };
		const [items, total] = await this.prisma.$transaction(
			[
				this.prisma.managedWidgetSource.findMany({
					where,
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize,
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
				}),
				this.prisma.managedWidgetSource.count({ where })
			],
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
		return {
			schemaVersion: 1,
			items: items.map(widgetSourceView),
			page: query.page,
			pageSize: query.pageSize,
			total
		};
	}
	async get(bearer: string | undefined, workspaceId: string, id: string) {
		await this.actor(bearer, workspaceId, false);
		return {
			schemaVersion: 1,
			source: widgetSourceView(
				await this.source(this.prisma, workspaceId, id)
			)
		};
	}
	async create(bearer: string | undefined, dto: CreateWidgetSourceDto) {
		const actor = await this.actor(bearer, dto.workspaceId, true);
		if (!dto.name.trim())
			throw new BadRequestException('Source name is required');
		if (dto.teamId !== null && !actor.teamIds.includes(dto.teamId))
			throw new ForbiddenException('Source team is not authorized');
		const authority = await this.authorization.authorizeWidgetSource(
			dto.workspaceId,
			actor.subject
		);
		return this.command(actor, dto, 'create', null, async tx => {
			const eventId = randomUUID(),
				sourceId = randomUUID(),
				connectorId = randomUUID();
			const source = await tx.managedWidgetSource.create({
				data: {
					id: sourceId,
					workspaceId: dto.workspaceId,
					name: dto.name.trim(),
					ownerSubject: authority.ownerSubject,
					widgetType: dto.widgetType,
					widgetId: dto.widgetId,
					connectorId,
					createdBySubject: actor.subject,
					teamId: dto.teamId,
					currentCommandId: dto.commandId
				}
			});
			await this.job(tx, source, dto.commandId, actor.subject, eventId);
			return { source, action: 'WIDGET_SOURCE_CREATED' };
		});
	}
	async configure(
		bearer: string | undefined,
		id: string,
		dto: ConfigureWidgetSourceDto
	) {
		const actor = await this.actor(bearer, dto.workspaceId, true);
		if (dto.enabled) {
			const original = await this.source(this.prisma, dto.workspaceId, id);
			const authority = await this.authorization.authorizeWidgetSource(
				dto.workspaceId,
				original.createdBySubject
			);
			if (authority.ownerSubject !== original.ownerSubject)
				throw new ForbiddenException('Managed source owner changed');
		}
		return this.command(actor, dto, 'configure', id, async tx => {
			const current = await this.source(tx, dto.workspaceId, id);
			this.version(current, dto.expectedVersion);
			const generation =
				current.generation + (!current.enabled && dto.enabled ? 1 : 0);
			const changed = await tx.managedWidgetSource.updateMany({
				where: {
					id,
					workspaceId: dto.workspaceId,
					version: dto.expectedVersion
				},
				data: {
					enabled: dto.enabled,
					version: { increment: 1 },
					controlVersion: { increment: 1 },
					generation,
					currentCommandId: dto.commandId,
					syncState: 'PENDING',
					lastErrorCode: null
				}
			});
			if (changed.count !== 1)
				throw new ConflictException({
					code: 'crm_intake_version_conflict'
				});
			const source = await this.source(tx, dto.workspaceId, id);
			await this.job(
				tx,
				source,
				dto.commandId,
				actor.subject,
				randomUUID()
			);
			return { source, action: 'WIDGET_SOURCE_CONFIGURED' };
		});
	}
	async retry(
		bearer: string | undefined,
		id: string,
		dto: VersionedWidgetSourceDto
	) {
		const actor = await this.actor(bearer, dto.workspaceId, true);
		return this.command(actor, dto, 'retry', id, async tx => {
			const source = await this.source(tx, dto.workspaceId, id);
			this.version(source, dto.expectedVersion);
			if (!['BLOCKED', 'ERROR'].includes(source.syncState))
				throw new ConflictException({
					code: 'crm_widget_source_retry_not_available'
				});
			const job = await tx.widgetControlJob.findUniqueOrThrow({
				where: { commandId: source.currentCommandId }
			});
			const eventId = randomUUID();
			const changed = await tx.widgetControlJob.updateMany({
				where: {
					commandId: job.commandId,
					status: { in: ['BLOCKED', 'ERROR'] }
				},
				data: {
					status: 'PENDING',
					activeEventId: eventId,
					leaseToken: null,
					leaseUntil: null,
					lastErrorCode: null,
					completedAt: null
				}
			});
			if (changed.count !== 1)
				throw new ConflictException({
					code: 'crm_widget_source_retry_not_available'
				});
			await tx.widgetControlOutbox.create({
				data: controlOutbox({
					schemaVersion: 1,
					eventId,
					workspaceId: source.workspaceId,
					sourceId: id,
					commandId: job.commandId,
					controlVersion: job.controlVersion,
					generation: job.generation
				})
			});
			const updated = await tx.managedWidgetSource.update({
				where: { id },
				data: { syncState: 'PENDING', lastErrorCode: null }
			});
			return { source: updated, action: 'WIDGET_SOURCE_RETRY_QUEUED' };
		});
	}
	private async job(
		tx: Prisma.TransactionClient,
		source: ManagedWidgetSource,
		commandId: string,
		requestedBySubject: string,
		eventId: string
	) {
		await tx.widgetControlJob.create({
			data: {
				commandId,
				workspaceId: source.workspaceId,
				sourceId: source.id,
				connectorId: source.connectorId,
				ownerSubject: source.ownerSubject,
				actorSubject: source.createdBySubject,
				requestedBySubject,
				widgetType: source.widgetType,
				widgetId: source.widgetId,
				controlVersion: source.controlVersion,
				generation: source.generation,
				enabled: source.enabled,
				activeEventId: eventId
			}
		});
		await tx.widgetControlOutbox.create({
			data: controlOutbox({
				schemaVersion: 1,
				eventId,
				workspaceId: source.workspaceId,
				sourceId: source.id,
				commandId,
				controlVersion: source.controlVersion,
				generation: source.generation
			})
		});
	}
	private async command(
		actor: IntakeAuthorization,
		dto: WidgetSourceCommandDto,
		operation: string,
		id: string | null,
		apply: (
			tx: Prisma.TransactionClient
		) => Promise<{ source: ManagedWidgetSource; action: string }>
	) {
		const requestHash = controlHash({
			schemaVersion: 1,
			workspaceId: actor.workspaceId,
			actor: actor.subject,
			kind: 'widget-source',
			operation,
			entityId: id,
			payload: dto
		});
		for (let attempt = 0; attempt < 6; attempt++)
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRawUnsafe(
							"SET LOCAL lock_timeout = '1500ms'"
						);
						await tx.$executeRawUnsafe(
							"SET LOCAL statement_timeout = '3500ms'"
						);
						const [lock] = await tx.$queryRaw<
							Array<{ locked: boolean }>
						>`SELECT pg_try_advisory_xact_lock(hashtextextended(${'crm-intake:command:' + dto.commandId},0)) AS locked`;
						if (!lock?.locked) throw new CommandBusy();
						const old = await tx.intakeCommand.findUnique({
							where: { commandId: dto.commandId }
						});
						if (old) {
							if (
								old.workspaceId !== actor.workspaceId ||
								old.actorSubject !== actor.subject ||
								old.entityKind !== 'widget-source' ||
								old.requestHash !== requestHash
							)
								throw new ConflictException({
									code: 'crm_intake_command_conflict'
								});
							await this.source(tx, actor.workspaceId, old.entityId);
							return old.response;
						}
						const { source, action } = await apply(tx);
						const response = json({
							schemaVersion: 1,
							source: widgetSourceView(source),
							command: { id: dto.commandId, state: 'QUEUED' }
						});
						await tx.intakeActivity.create({
							data: {
								workspaceId: actor.workspaceId,
								entityId: source.id,
								entityKind: 'widget-source',
								commandId: dto.commandId,
								actorSubject: actor.subject,
								action,
								entityVersion: source.version
							}
						});
						await tx.intakeCommand.create({
							data: {
								commandId: dto.commandId,
								workspaceId: actor.workspaceId,
								entityId: source.id,
								entityKind: 'widget-source',
								actorSubject: actor.subject,
								requestHash,
								response
							}
						});
						await widgetControlConstraints(tx);
						return response;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 2000,
						timeout: 5000
					}
				);
			} catch (error) {
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === 'P2002' &&
					(String(error.meta?.target).includes('enabled_widget') ||
						(String(error.meta?.target).includes('owner_subject') &&
							String(error.meta?.target).includes('widget_id')))
				)
					throw new ConflictException({
						code: 'crm_widget_source_already_connected'
					});
				const retry =
					error instanceof CommandBusy ||
					(error instanceof Prisma.PrismaClientKnownRequestError &&
						(['P2002', 'P2034'].includes(error.code) ||
							(error.code === 'P2010' &&
								['55P03', '57014'].includes(String(error.meta?.code)))));
				if (!retry || attempt === 5) {
					if (error instanceof HttpException) throw error;
					throw new ServiceUnavailableException({
						code: 'crm_widget_source_unavailable',
						message:
							'Managed source is unavailable; retry the same command'
					});
				}
				await new Promise(resolve =>
					setTimeout(resolve, 20 * (attempt + 1))
				);
			}
		throw new ServiceUnavailableException(
			'Managed source command unavailable'
		);
	}
	private async source(
		tx: Prisma.TransactionClient,
		workspaceId: string,
		id: string
	) {
		const row = await tx.managedWidgetSource.findFirst({
			where: { workspaceId, id }
		});
		if (!row)
			throw new NotFoundException({ code: 'crm_widget_source_not_found' });
		return row;
	}
	private version(row: ManagedWidgetSource, expected: number) {
		if (row.version !== expected)
			throw new ConflictException({ code: 'crm_intake_version_conflict' });
	}
}
