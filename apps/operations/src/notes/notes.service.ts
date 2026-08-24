import {
	BadRequestException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import type { Prisma } from '@prisma/operations-client';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { CreateNoteDto, UpdateNoteDto } from './notes.dto';

interface AdminNoteFilters {
	status?: string;
	createdFrom?: string;
	createdTo?: string;
}

export interface NoteAuditContext {
	actorId: string;
	ip: string | null;
	userAgent: string | null;
	correlationId: string;
}

@Injectable()
export class NotesService {
	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly adminEventLog: AdminEventLogService
	) {}

	async getAll(page = 1, limit = 10, filters: AdminNoteFilters = {}) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
		const where = this.getWhere(filters);
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [items, total, doneTotal] = await Promise.all([
			this.prisma.note.findMany({
				where,
				orderBy: [{ done: 'asc' }, { createdAt: 'desc' }],
				skip,
				take: normalizedLimit
			}),
			this.prisma.note.count({ where }),
			this.prisma.note.count({
				where: { ...(where ?? {}), done: true }
			})
		]);
		return {
			items,
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit)),
			doneTotal
		};
	}

	create(dto: CreateNoteDto, context: NoteAuditContext) {
		return this.prisma.$transaction(async transaction => {
			const note = await transaction.note.create({
				data: { text: dto.text }
			});
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId: context.actorId,
				section: 'BACKLOG',
				action: 'BACKLOG_TASK_CREATE',
				description: 'Создана задача в бэклоге',
				entityType: 'backlog_task',
				entityId: note.id,
				entityLabel: note.text,
				metadata: { text: note.text },
				ip: context.ip,
				userAgent: context.userAgent
			});
			return note;
		});
	}

	update(id: string, dto: UpdateNoteDto, context: NoteAuditContext) {
		return this.prisma.$transaction(async transaction => {
			await this.findOneOrFail(transaction, id);
			const note = await transaction.note.update({
				where: { id },
				data: dto
			});
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId: context.actorId,
				section: 'BACKLOG',
				action: 'BACKLOG_TASK_UPDATE',
				description:
					typeof dto.done === 'boolean'
						? dto.done
							? 'Задача бэклога отмечена выполненной'
							: 'С задачи бэклога снята отметка выполнения'
						: 'Обновлена задача в бэклоге',
				entityType: 'backlog_task',
				entityId: note.id,
				entityLabel: note.text,
				metadata: {
					text: note.text,
					done: note.done,
					updatedFields: Object.keys(dto)
				},
				ip: context.ip,
				userAgent: context.userAgent
			});
			return note;
		});
	}

	delete(id: string, context: NoteAuditContext) {
		return this.prisma.$transaction(async transaction => {
			await this.findOneOrFail(transaction, id);
			const note = await transaction.note.delete({ where: { id } });
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId: context.actorId,
				section: 'BACKLOG',
				action: 'BACKLOG_TASK_DELETE',
				description: 'Удалена задача из бэклога',
				entityType: 'backlog_task',
				entityId: note.id,
				entityLabel: note.text,
				metadata: {
					text: note.text,
					done: note.done
				},
				ip: context.ip,
				userAgent: context.userAgent
			});
			return note;
		});
	}

	private async findOneOrFail(
		transaction: Prisma.TransactionClient,
		id: string
	) {
		const note = await transaction.note.findUnique({ where: { id } });
		if (!note) throw new NotFoundException('Note not found');
		return note;
	}

	private getWhere(
		filters: AdminNoteFilters
	): Prisma.NoteWhereInput | undefined {
		const where: Prisma.NoteWhereInput = {};
		const status = this.normalizeStatus(filters.status);
		const createdAt = this.getDateRangeFilter(
			filters.createdFrom,
			filters.createdTo
		);
		if (status === 'DONE') where.done = true;
		if (status === 'PENDING') where.done = false;
		if (createdAt) where.createdAt = createdAt;
		return Object.keys(where).length ? where : undefined;
	}

	private normalizeStatus(value?: string) {
		const normalized = value?.trim().toUpperCase();
		if (!normalized) return undefined;
		if (normalized !== 'DONE' && normalized !== 'PENDING') {
			throw new BadRequestException('Некорректный статус задачи');
		}
		return normalized;
	}

	private getDateRangeFilter(from?: string, to?: string) {
		const gte = this.normalizeDate(from, false);
		const lte = this.normalizeDate(to, true);
		if (!gte && !lte) return undefined;
		return {
			...(gte ? { gte } : {}),
			...(lte ? { lte } : {})
		};
	}

	private normalizeDate(value?: string, endOfDay = false) {
		const normalized = value?.trim();
		if (!normalized) return undefined;
		const date = new Date(
			endOfDay
				? `${normalized}T23:59:59.999Z`
				: `${normalized}T00:00:00.000Z`
		);
		if (Number.isNaN(date.getTime())) {
			throw new BadRequestException('Некорректная дата фильтра');
		}
		return date;
	}
}
