import { PrismaService } from '@/prisma.service';
import { getClientIp } from '@/utils/ip.util';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AuthIdentityType, Prisma } from '@prisma/client';
import { Request } from 'express';

export type AdminEventLogSection =
	| 'PAYMENTS'
	| 'MAILINGS'
	| 'TASKS'
	| 'SUBSCRIPTIONS'
	| 'USERS'
	| 'BACKLOG'
	| 'SITE_SETTINGS'
	| 'TELEGRAM_BOT'
	| 'AFFILIATE'
	| 'MESSAGING'
	| 'DEV_TOOLS'
	| 'WIDGETS';

export type AdminEventLogAction =
	| 'PAYMENT_MANUAL_CHECK'
	| 'PAYMENT_CLEANUP_RUN'
	| 'MAILING_BROADCAST_SEND'
	| 'MAILING_BROADCAST_CANCEL'
	| 'SUBSCRIPTION_ACTIVATE'
	| 'SUBSCRIPTION_EXTEND_DAYS'
	| 'SUBSCRIPTION_CANCEL'
	| 'SUBSCRIPTION_EXPIRY_CHECK_RUN'
	| 'VERIFICATION_CHALLENGE_CLEANUP_RUN'
	| 'USER_UPDATE'
	| 'USER_TOGGLE_ACTIVATION'
	| 'USER_DELETE'
	| 'BACKLOG_TASK_CREATE'
	| 'BACKLOG_TASK_UPDATE'
	| 'BACKLOG_TASK_DELETE'
	| 'SITE_SETTINGS_UPDATE'
	| 'AFFILIATE_SETTINGS_UPDATE'
	| 'TELEGRAM_BOT_SETTINGS_UPDATE'
	| 'TELEGRAM_BOT_WEBHOOK_REINSTALL'
	| 'TELEGRAM_DATABASE_BACKUP_CREATE'
	| 'TELEGRAM_DATABASE_RESTORE'
	| 'MESSAGING_FAILURE_RETRY'
	| 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY'
	| 'DEV_DATABASE_RESTORE'
	| 'WIDGET_UPDATE'
	| 'WIDGET_DELETE'
	| 'WIDGET_BUTTON_IMAGE_UPDATE';

const ADMIN_EVENT_LOG_SECTIONS: AdminEventLogSection[] = [
	'PAYMENTS',
	'MAILINGS',
	'TASKS',
	'SUBSCRIPTIONS',
	'USERS',
	'BACKLOG',
	'SITE_SETTINGS',
	'TELEGRAM_BOT',
	'AFFILIATE',
	'MESSAGING',
	'DEV_TOOLS',
	'WIDGETS'
];

const ADMIN_EVENT_LOG_ACTIONS: AdminEventLogAction[] = [
	'PAYMENT_MANUAL_CHECK',
	'PAYMENT_CLEANUP_RUN',
	'MAILING_BROADCAST_SEND',
	'MAILING_BROADCAST_CANCEL',
	'SUBSCRIPTION_ACTIVATE',
	'SUBSCRIPTION_EXTEND_DAYS',
	'SUBSCRIPTION_CANCEL',
	'SUBSCRIPTION_EXPIRY_CHECK_RUN',
	'VERIFICATION_CHALLENGE_CLEANUP_RUN',
	'USER_UPDATE',
	'USER_TOGGLE_ACTIVATION',
	'USER_DELETE',
	'BACKLOG_TASK_CREATE',
	'BACKLOG_TASK_UPDATE',
	'BACKLOG_TASK_DELETE',
	'SITE_SETTINGS_UPDATE',
	'AFFILIATE_SETTINGS_UPDATE',
	'TELEGRAM_BOT_SETTINGS_UPDATE',
	'TELEGRAM_BOT_WEBHOOK_REINSTALL',
	'TELEGRAM_DATABASE_BACKUP_CREATE',
	'TELEGRAM_DATABASE_RESTORE',
	'MESSAGING_FAILURE_RETRY',
	'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY',
	'DEV_DATABASE_RESTORE',
	'WIDGET_UPDATE',
	'WIDGET_DELETE',
	'WIDGET_BUTTON_IMAGE_UPDATE'
];

export interface AdminEventLogRecordInput {
	adminId?: string | null;
	section: AdminEventLogSection;
	action: AdminEventLogAction;
	description: string;
	entityType?: string | null;
	entityId?: string | null;
	entityLabel?: string | null;
	targetUserId?: string | null;
	metadata?: Prisma.InputJsonValue;
	request?: Request;
}

interface AdminEventLogFilters {
	userId?: string;
	adminId?: string;
	section?: string;
	action?: string;
	createdFrom?: string;
	createdTo?: string;
}

interface UserSnapshot {
	name: string | null;
	email: string | null;
}

@Injectable()
export class AdminEventLogService {
	private readonly logger = new Logger(AdminEventLogService.name);

	constructor(private readonly prisma: PrismaService) {}

	async getAll(page = 1, limit = 20, filters: AdminEventLogFilters = {}) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const where = this.getAdminEventLogWhere(filters);
		const skip = (normalizedPage - 1) * normalizedLimit;

		const [items, total] = await this.prisma.$transaction([
			this.prisma.adminEventLog.findMany({
				where,
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

	private getAdminEventLogWhere(
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

		if (!normalized) {
			return undefined;
		}

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

		if (!normalized) {
			return undefined;
		}

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

		if (!gte && !lte) {
			return undefined;
		}

		return {
			...(gte ? { gte } : {}),
			...(lte ? { lte } : {})
		};
	}

	private normalizeDate(value?: string, endOfDay = false) {
		const normalized = value?.trim();

		if (!normalized) {
			return undefined;
		}

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

	async record(input: AdminEventLogRecordInput) {
		try {
			return await this.recordWithClient(this.prisma, input);
		} catch (error) {
			this.logger.warn(
				`Admin event log failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			return null;
		}
	}

	recordInTransaction(
		transaction: Prisma.TransactionClient,
		input: AdminEventLogRecordInput
	) {
		return this.recordWithClient(transaction, input);
	}

	private async recordWithClient(
		client: Prisma.TransactionClient | PrismaService,
		input: AdminEventLogRecordInput
	) {
		const [adminSnapshot, targetUserSnapshot] = await Promise.all([
			this.getUserSnapshot(input.adminId, client),
			this.getUserSnapshot(input.targetUserId, client)
		]);
		const requestSnapshot = this.getRequestSnapshot(input.request);

		return client.adminEventLog.create({
			data: {
				adminId: input.adminId || null,
				adminName: adminSnapshot?.name ?? null,
				adminEmail: adminSnapshot?.email ?? null,
				section: input.section,
				action: input.action,
				description: input.description.trim(),
				entityType: input.entityType || null,
				entityId: input.entityId || null,
				entityLabel: input.entityLabel || null,
				targetUserId: input.targetUserId || null,
				targetUserName: targetUserSnapshot?.name ?? null,
				targetUserEmail: targetUserSnapshot?.email ?? null,
				metadata: input.metadata ?? {},
				ip: requestSnapshot.ip,
				userAgent: requestSnapshot.userAgent
			}
		});
	}

	private async getUserSnapshot(
		userId?: string | null,
		client: Prisma.TransactionClient | PrismaService = this.prisma
	): Promise<UserSnapshot | null> {
		if (!userId) {
			return null;
		}

		const user = await client.user.findUnique({
			where: { id: userId },
			select: {
				name: true,
				authIdentities: {
					where: { type: AuthIdentityType.EMAIL },
					select: { value: true },
					take: 1
				}
			}
		});

		if (!user) {
			return null;
		}

		return {
			name: user.name,
			email: user.authIdentities[0]?.value ?? null
		};
	}

	private getRequestSnapshot(request?: Request) {
		if (!request) {
			return {
				ip: null,
				userAgent: null
			};
		}

		const userAgent = this.getHeaderValue(request.headers['user-agent']);

		return {
			ip: getClientIp(request) || null,
			userAgent: userAgent || null
		};
	}

	private getHeaderValue(value?: string | string[]) {
		if (Array.isArray(value)) {
			return value[0]?.trim() || null;
		}

		return value?.trim() || null;
	}
}
