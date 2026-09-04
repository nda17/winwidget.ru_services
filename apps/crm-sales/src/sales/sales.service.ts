import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	Prisma,
	type Deal,
	type SalesTask
} from '@prisma/crm-sales-client';
import { createHash, randomUUID } from 'node:crypto';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import type { SalesAccess } from './sales-access';
import { SalesContactClient } from './sales-contact.client';
import type {
	CompleteTaskDto,
	CreateDealDto,
	DealListQuery,
	NextTaskDto,
	SalesCommandDto,
	SalesListQuery,
	TransitionDealDto,
	VersionedSalesCommand
} from './sales.dto';

type DealWithTasks = Deal & { tasks: SalesTask[] };
const includeTasks = { tasks: { where: { status: 'OPEN' as const } } };

export function salesScope(access: SalesAccess): Prisma.DealWhereInput {
	if (access.dataScope === 'ALL')
		return { workspaceId: access.workspaceId };
	if (access.dataScope === 'TEAM')
		return {
			workspaceId: access.workspaceId,
			OR: [
				{ assignedToSubject: access.subject },
				{ teamId: { in: access.teamIds } }
			]
		};
	return {
		workspaceId: access.workspaceId,
		assignedToSubject: access.subject
	};
}
function taskDto(task: SalesTask) {
	return {
		id: task.id,
		workspaceId: task.workspaceId,
		dealId: task.dealId,
		version: task.version,
		title: task.title,
		dueAt: task.dueAt.toISOString(),
		status: task.status,
		assignedToSubject: task.assignedToSubject,
		completedAt: task.completedAt?.toISOString() || null,
		createdAt: task.createdAt.toISOString(),
		updatedAt: task.updatedAt.toISOString()
	};
}
function dealDto(deal: DealWithTasks) {
	return {
		id: deal.id,
		workspaceId: deal.workspaceId,
		version: deal.version,
		title: deal.title,
		currency: 'RUB' as const,
		amountMinor: deal.amountMinor,
		pipelineId: deal.pipelineId,
		stageId: deal.stageId,
		status: deal.status,
		contactId: deal.contactId,
		contactName: deal.contactName,
		assignedToSubject: deal.assignedToSubject,
		teamId: deal.teamId,
		archivedAt: deal.archivedAt?.toISOString() || null,
		createdAt: deal.createdAt.toISOString(),
		updatedAt: deal.updatedAt.toISOString(),
		nextTask: deal.tasks.find(task => task.id === deal.nextTaskId)
			? taskDto(deal.tasks.find(task => task.id === deal.nextTaskId)!)
			: null
	};
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(',')}}`;
	return JSON.stringify(value);
}

@Injectable()
export class SalesService {
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly contacts: SalesContactClient
	) {}

	async pipelines(access: SalesAccess) {
		this.permission(access, 'sales:read');
		const items = await this.prisma.pipeline.findMany({
			where: { workspaceId: access.workspaceId },
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
			include: { stages: { orderBy: { position: 'asc' } } }
		});
		return {
			schemaVersion: 1 as const,
			items: items.map(pipeline => ({
				id: pipeline.id,
				workspaceId: pipeline.workspaceId,
				name: pipeline.name,
				templateKey: pipeline.templateKey,
				templateVersion: pipeline.templateVersion,
				stages: pipeline.stages.map(stage => ({
					id: stage.id,
					key: stage.key,
					name: stage.name,
					position: stage.position,
					state: stage.state
				}))
			}))
		};
	}

	async deals(access: SalesAccess, query: DealListQuery) {
		this.permission(access, 'sales:read');
		const where: Prisma.DealWhereInput = {
			AND: [
				salesScope(access),
				{
					archivedAt: null,
					pipelineId: query.pipelineId,
					stageId: query.stageId,
					status: query.status,
					...(query.search
						? {
								OR: [
									{
										title: {
											contains: query.search.trim(),
											mode: 'insensitive'
										}
									},
									{
										contactName: {
											contains: query.search.trim(),
											mode: 'insensitive'
										}
									}
								]
							}
						: {})
				}
			]
		};
		const [total, rows] = await this.prisma.$transaction([
			this.prisma.deal.count({ where }),
			this.prisma.deal.findMany({
				where,
				skip: (query.page - 1) * query.pageSize,
				take: query.pageSize,
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
				include: includeTasks
			})
		]);
		return {
			schemaVersion: 1 as const,
			page: query.page,
			pageSize: query.pageSize,
			total,
			items: rows.map(dealDto)
		};
	}

	async detail(access: SalesAccess, id: string) {
		this.permission(access, 'sales:read');
		return {
			schemaVersion: 1 as const,
			deal: dealDto(await this.visible(this.prisma, access, id))
		};
	}

	async tasks(access: SalesAccess, query: SalesListQuery) {
		this.permission(access, 'sales:read');
		const where: Prisma.SalesTaskWhereInput = {
			workspaceId: access.workspaceId,
			status: 'OPEN',
			deal: { AND: [salesScope(access), { archivedAt: null }] },
			...(query.search
				? { title: { contains: query.search.trim(), mode: 'insensitive' } }
				: {})
		};
		const [total, rows] = await this.prisma.$transaction([
			this.prisma.salesTask.count({ where }),
			this.prisma.salesTask.findMany({
				where,
				skip: (query.page - 1) * query.pageSize,
				take: query.pageSize,
				orderBy: [{ dueAt: 'asc' }, { id: 'asc' }]
			})
		]);
		return {
			schemaVersion: 1 as const,
			page: query.page,
			pageSize: query.pageSize,
			total,
			items: rows.map(taskDto)
		};
	}

	async timeline(
		access: SalesAccess,
		dealId: string,
		query: SalesListQuery
	) {
		this.permission(access, 'sales:read');
		await this.visible(this.prisma, access, dealId);
		const where = {
			workspaceId: access.workspaceId,
			dealId,
			deal: { AND: [salesScope(access), { archivedAt: null }] }
		};
		const [total, rows] = await this.prisma.$transaction([
			this.prisma.dealTimeline.count({ where }),
			this.prisma.dealTimeline.findMany({
				where,
				skip: (query.page - 1) * query.pageSize,
				take: query.pageSize,
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
			})
		]);
		return {
			schemaVersion: 1 as const,
			page: query.page,
			pageSize: query.pageSize,
			total,
			items: rows.map(row => ({
				id: row.id,
				dealId: row.dealId,
				kind: row.kind,
				actorSubject: row.actorSubject,
				outcome: row.outcome,
				fromStageId: row.fromStageId,
				toStageId: row.toStageId,
				createdAt: row.createdAt.toISOString()
			}))
		};
	}

	async analytics(access: SalesAccess) {
		this.permission(access, 'sales:analytics');
		const rows = await this.prisma.deal.groupBy({
			by: ['status'],
			where: { AND: [salesScope(access), { archivedAt: null }] },
			_count: { id: true },
			_sum: { amountMinor: true }
		});
		return {
			schemaVersion: 1 as const,
			currency: 'RUB' as const,
			items: ['OPEN', 'WON', 'LOST'].map(status => {
				const row = rows.find(item => item.status === status);
				return {
					status,
					count: row?._count.id || 0,
					amountMinor: row?._sum.amountMinor || 0
				};
			})
		};
	}

	async create(
		access: SalesAccess,
		dto: CreateDealDto,
		authorization: string
	) {
		this.permission(access, 'sales:write');
		this.nextTask(dto.nextTask);
		if (dto.teamId && !access.teamIds.includes(dto.teamId))
			throw new ForbiddenException('Недоступная команда');
		return this.command(
			access,
			dto,
			'CREATE_DEAL',
			null,
			async transaction => {
				const stage = await this.stage(
					transaction,
					access.workspaceId,
					dto.pipelineId,
					dto.stageId
				);
				if (stage.state !== 'OPEN')
					throw new BadRequestException(
						'Новая сделка должна начинаться на открытом этапе'
					);
				const contact = await this.contacts.requireContact(
					authorization,
					access.workspaceId,
					dto.contactId
				);
				const id = randomUUID();
				const taskId = randomUUID();
				await transaction.deal.create({
					data: {
						id,
						workspaceId: access.workspaceId,
						title: dto.title.trim(),
						currency: 'RUB',
						amountMinor: dto.amountMinor,
						pipelineId: dto.pipelineId,
						stageId: dto.stageId,
						contactId: contact.id,
						contactName: contact.name,
						assignedToSubject: access.subject,
						teamId: dto.teamId || null,
						nextTaskId: taskId
					}
				});
				await this.createTask(
					transaction,
					access,
					id,
					taskId,
					dto.nextTask
				);
				await this.event(
					transaction,
					access,
					id,
					'CREATED',
					'Создана сделка',
					null,
					dto.stageId
				);
				return id;
			}
		);
	}

	async transition(
		access: SalesAccess,
		id: string,
		dto: TransitionDealDto
	) {
		this.permission(access, 'sales:write');
		if (dto.nextTask) this.nextTask(dto.nextTask);
		return this.command(
			access,
			dto,
			'TRANSITION_DEAL',
			id,
			async transaction => {
				const deal = await this.visible(transaction, access, id);
				const stage = await this.stage(
					transaction,
					access.workspaceId,
					deal.pipelineId,
					dto.targetStageId
				);
				if (stage.state === 'OPEN' && !dto.nextTask)
					throw new BadRequestException(
						'Для открытой сделки нужно следующее действие'
					);
				if (stage.state !== 'OPEN' && dto.nextTask)
					throw new BadRequestException(
						'Закрытая сделка не должна иметь следующего действия'
					);
				const taskId = stage.state === 'OPEN' ? randomUUID() : null;
				await this.updateDeal(
					transaction,
					access,
					deal,
					dto.expectedVersion,
					{ stageId: stage.id, status: stage.state, nextTaskId: taskId }
				);
				await this.closeTasks(transaction, access, id, 'COMPLETED');
				if (taskId && dto.nextTask)
					await this.createTask(
						transaction,
						{ ...access, subject: deal.assignedToSubject },
						id,
						taskId,
						dto.nextTask
					);
				await this.event(
					transaction,
					access,
					id,
					'TRANSITIONED',
					dto.outcome.trim(),
					deal.stageId,
					stage.id
				);
				return id;
			}
		);
	}

	async complete(
		access: SalesAccess,
		taskId: string,
		dto: CompleteTaskDto
	) {
		this.permission(access, 'sales:write');
		this.nextTask(dto.nextTask);
		return this.command(
			access,
			dto,
			'COMPLETE_TASK',
			taskId,
			async transaction => {
				const task = await transaction.salesTask.findFirst({
					where: {
						id: taskId,
						workspaceId: access.workspaceId,
						deal: salesScope(access)
					}
				});
				if (!task) this.notFound();
				const deal = await this.visible(transaction, access, task.dealId);
				if (
					task.status !== 'OPEN' ||
					deal.nextTaskId !== taskId ||
					deal.status !== 'OPEN'
				)
					this.conflict();
				if (task.version !== dto.expectedVersion) this.conflict();
				const nextTaskId = randomUUID();
				await this.updateDeal(transaction, access, deal, deal.version, {
					nextTaskId
				});
				await this.closeTasks(transaction, access, deal.id, 'COMPLETED');
				await this.createTask(
					transaction,
					{ ...access, subject: deal.assignedToSubject },
					deal.id,
					nextTaskId,
					dto.nextTask
				);
				await this.event(
					transaction,
					access,
					deal.id,
					'TASK_COMPLETED',
					dto.outcome.trim(),
					deal.stageId,
					deal.stageId
				);
				return deal.id;
			}
		);
	}

	async archive(
		access: SalesAccess,
		id: string,
		dto: VersionedSalesCommand
	) {
		this.permission(access, 'sales:write');
		return this.command(
			access,
			dto,
			'ARCHIVE_DEAL',
			id,
			async transaction => {
				const deal = await this.visible(transaction, access, id);
				await this.updateDeal(
					transaction,
					access,
					deal,
					dto.expectedVersion,
					{ archivedAt: new Date(), nextTaskId: null }
				);
				await this.closeTasks(transaction, access, id, 'CANCELLED');
				await this.event(
					transaction,
					access,
					id,
					'ARCHIVED',
					'Сделка архивирована',
					deal.stageId,
					null
				);
				return id;
			}
		);
	}

	private async command(
		access: SalesAccess,
		dto: SalesCommandDto,
		type: string,
		targetId: string | null,
		action: (transaction: Prisma.TransactionClient) => Promise<string>
	) {
		if (dto.workspaceId !== access.workspaceId)
			throw new ForbiddenException();
		const requestHash = createHash('sha256')
			.update(canonical({ dto, type, targetId, subject: access.subject }))
			.digest('hex');
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				return await this.prisma.$transaction(
					async transaction => {
						await transaction.$executeRaw(
							Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-sales-command:${dto.commandId}`}, 0))`
						);
						const prior = await transaction.salesCommandReceipt.findUnique(
							{ where: { commandId: dto.commandId } }
						);
						if (prior) {
							if (
								prior.workspaceId !== access.workspaceId ||
								prior.actorSubject !== access.subject ||
								prior.requestHash !== requestHash ||
								prior.commandType !== type
							)
								this.conflict('crm_sales_command_conflict');
							await this.visible(transaction, access, prior.dealId, true);
							return prior.result;
						}
						const dealId = await action(transaction);
						const result = {
							schemaVersion: 1 as const,
							deal: dealDto(
								await this.visible(transaction, access, dealId, true)
							)
						};
						await transaction.salesCommandReceipt.create({
							data: {
								commandId: dto.commandId,
								workspaceId: access.workspaceId,
								actorSubject: access.subject,
								commandType: type,
								requestHash,
								dealId,
								result
							}
						});
						// Prisma 5 may resolve a failed deferred COMMIT after PostgreSQL
						// has rolled back. Check before returning an accepted result.
						await transaction.$executeRaw(Prisma.sql`
							SET CONSTRAINTS
								crm_sales.deals_next_task_fkey,
								crm_sales.deals_next_action_integrity,
								crm_sales.tasks_next_action_integrity IMMEDIATE
						`);
						return result;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						timeout: 15000,
						maxWait: 5000
					}
				);
			} catch (error) {
				if (
					attempt === 3 ||
					!error ||
					typeof error !== 'object' ||
					!('code' in error) ||
					error.code !== 'P2034'
				)
					throw error;
			}
		}
		throw new ConflictException();
	}

	private async visible(
		client: Pick<Prisma.TransactionClient, 'deal'>,
		access: SalesAccess,
		id: string,
		includeArchived = false
	): Promise<DealWithTasks> {
		const deal = await client.deal.findFirst({
			where: {
				AND: [
					salesScope(access),
					{ id, ...(includeArchived ? {} : { archivedAt: null }) }
				]
			},
			include: includeTasks
		});
		if (!deal) this.notFound();
		return deal;
	}
	private async stage(
		transaction: Prisma.TransactionClient,
		workspaceId: string,
		pipelineId: string,
		id: string
	) {
		const stage = await transaction.pipelineStage.findFirst({
			where: { id, workspaceId, pipelineId }
		});
		if (!stage) this.notFound();
		return stage;
	}
	private async updateDeal(
		transaction: Prisma.TransactionClient,
		access: SalesAccess,
		deal: Deal,
		version: number,
		data: Prisma.DealUncheckedUpdateManyInput
	) {
		const updated = await transaction.deal.updateMany({
			where: {
				AND: [
					salesScope(access),
					{ id: deal.id, version, archivedAt: null }
				]
			},
			data: { ...data, version: { increment: 1 } }
		});
		if (updated.count !== 1) this.conflict();
	}
	private async createTask(
		transaction: Prisma.TransactionClient,
		access: SalesAccess,
		dealId: string,
		id: string,
		next: NextTaskDto
	) {
		await transaction.salesTask.create({
			data: {
				id,
				workspaceId: access.workspaceId,
				dealId,
				title: next.title.trim(),
				dueAt: new Date(next.dueAt),
				assignedToSubject: access.subject
			}
		});
	}
	private async closeTasks(
		transaction: Prisma.TransactionClient,
		access: SalesAccess,
		dealId: string,
		status: 'COMPLETED' | 'CANCELLED'
	) {
		await transaction.salesTask.updateMany({
			where: { workspaceId: access.workspaceId, dealId, status: 'OPEN' },
			data: { status, completedAt: new Date(), version: { increment: 1 } }
		});
	}
	private async event(
		transaction: Prisma.TransactionClient,
		access: SalesAccess,
		dealId: string,
		kind: string,
		outcome: string,
		fromStageId: string | null,
		toStageId: string | null
	) {
		await transaction.dealTimeline.create({
			data: {
				workspaceId: access.workspaceId,
				dealId,
				kind,
				actorSubject: access.subject,
				outcome,
				fromStageId,
				toStageId
			}
		});
	}
	private nextTask(next: NextTaskDto | undefined) {
		if (
			!next ||
			!Number.isFinite(Date.parse(next.dueAt)) ||
			new Date(next.dueAt).toISOString() !== next.dueAt
		)
			throw new BadRequestException(
				'Следующее действие должно содержать корректную дату'
			);
	}
	private permission(access: SalesAccess, permission: string) {
		if (
			!access.permissions.includes(permission) ||
			(access.role === 'ANALYST' && permission !== 'sales:analytics') ||
			(permission === 'sales:write' && access.state === 'READ_ONLY')
		)
			throw new ForbiddenException();
	}
	private notFound(): never {
		throw new NotFoundException({
			code: 'crm_sales_record_not_found',
			message: 'Запись недоступна'
		});
	}
	private conflict(code = 'crm_sales_version_conflict'): never {
		throw new ConflictException({
			code,
			message: 'Данные изменились. Обновите запись'
		});
	}
}
