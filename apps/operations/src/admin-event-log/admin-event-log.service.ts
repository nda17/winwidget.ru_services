import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/operations-client';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import {
	ADMIN_EVENT_LOG_ACTIONS,
	ADMIN_EVENT_LOG_SECTIONS,
	AdminEventLogAction,
	AdminEventLogRecordInput,
	AdminEventLogSection
} from './admin-event-log.contract';

interface AdminEventLogFilters {
	userId?: string;
	adminId?: string;
	section?: string;
	action?: string;
	createdFrom?: string;
	createdTo?: string;
}

const PUBLIC_SELECT = {
	id: true,
	adminId: true,
	adminName: true,
	adminEmail: true,
	section: true,
	action: true,
	description: true,
	entityType: true,
	entityId: true,
	entityLabel: true,
	targetUserId: true,
	targetUserName: true,
	targetUserEmail: true,
	metadata: true,
	ip: true,
	userAgent: true,
	createdAt: true
} as const;

@Injectable()
export class AdminEventLogService {
	constructor(private readonly prisma: OperationsPrismaService) {}

	async getAll(page = 1, limit = 20, filters: AdminEventLogFilters = {}) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const where = this.getWhere(filters);
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [items, total] = await this.prisma.$transaction([
			this.prisma.adminEventLog.findMany({
				where,
				select: PUBLIC_SELECT,
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.adminEventLog.count({ where })
		]);
		return {
			items,
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async getUserActivity(userId: string) {
		const latest = await this.prisma.adminEventLog.findMany({
			where: {
				OR: [{ targetUserId: userId }, { adminId: userId }]
			},
			orderBy: { createdAt: 'desc' },
			take: 5,
			select: {
				id: true,
				section: true,
				action: true,
				description: true,
				entityType: true,
				entityLabel: true,
				adminName: true,
				adminEmail: true,
				targetUserId: true,
				createdAt: true
			}
		});
		return {
			latest: latest.map(item => ({
				...item,
				role: item.targetUserId === userId ? 'TARGET' : 'ADMIN'
			}))
		};
	}

	recordInTransaction(
		transaction: Prisma.TransactionClient,
		input: AdminEventLogRecordInput
	) {
		const description = input.description.trim();
		if (!description) {
			throw new Error('Admin event description must not be empty');
		}
		return transaction.adminEventLog.create({
			data: {
				...(input.id ? { id: input.id } : {}),
				adminId: input.adminId || null,
				adminName: input.adminName ?? null,
				adminEmail: input.adminEmail ?? null,
				section: input.section,
				action: input.action,
				description,
				entityType: input.entityType || null,
				entityId: input.entityId || null,
				entityLabel: input.entityLabel || null,
				targetUserId: input.targetUserId || null,
				targetUserName: input.targetUserName ?? null,
				targetUserEmail: input.targetUserEmail ?? null,
				metadata: input.metadata ?? {},
				ip: input.ip || null,
				userAgent: input.userAgent || null
			}
		});
	}

	private getWhere(
		filters: AdminEventLogFilters
	): Prisma.AdminEventLogWhereInput | undefined {
		const and: Prisma.AdminEventLogWhereInput[] = [];
		const userId = filters.userId?.trim();
		const adminId = filters.adminId?.trim();
		const section = this.normalizeSection(filters.section);
		const action = this.normalizeAction(filters.action);
		const createdAt = this.getDateRangeFilter(
			filters.createdFrom,
			filters.createdTo
		);
		if (userId) {
			and.push({
				OR: [{ targetUserId: userId }, { adminId: userId }]
			});
		}
		if (adminId) and.push({ adminId });
		if (section) and.push({ section });
		if (action) and.push({ action });
		if (createdAt) and.push({ createdAt });
		return and.length ? { AND: and } : undefined;
	}

	private normalizeSection(value?: string) {
		const normalized = value?.trim().toUpperCase();
		if (!normalized) return undefined;
		if (
			!ADMIN_EVENT_LOG_SECTIONS.includes(
				normalized as AdminEventLogSection
			)
		) {
			throw new BadRequestException('Некорректный раздел журнала');
		}
		return normalized;
	}

	private normalizeAction(value?: string) {
		const normalized = value?.trim().toUpperCase();
		if (!normalized) return undefined;
		if (
			!ADMIN_EVENT_LOG_ACTIONS.includes(normalized as AdminEventLogAction)
		) {
			throw new BadRequestException('Некорректное действие журнала');
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
