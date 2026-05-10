import { PrismaService } from '@/prisma.service';
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
	| 'TELEGRAM_BOT';

export type AdminEventLogAction =
	| 'PAYMENT_MANUAL_CHECK'
	| 'PAYMENT_CLEANUP_RUN'
	| 'MAILING_BROADCAST_SEND'
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
	| 'TELEGRAM_BOT_SETTINGS_UPDATE'
	| 'TELEGRAM_BOT_WEBHOOK_REINSTALL';

const ADMIN_EVENT_LOG_SECTIONS: AdminEventLogSection[] = [
	'PAYMENTS',
	'MAILINGS',
	'TASKS',
	'SUBSCRIPTIONS',
	'USERS',
	'BACKLOG',
	'SITE_SETTINGS',
	'TELEGRAM_BOT'
];

const ADMIN_EVENT_LOG_ACTIONS: AdminEventLogAction[] = [
	'PAYMENT_MANUAL_CHECK',
	'PAYMENT_CLEANUP_RUN',
	'MAILING_BROADCAST_SEND',
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
	'TELEGRAM_BOT_SETTINGS_UPDATE',
	'TELEGRAM_BOT_WEBHOOK_REINSTALL'
];

interface AdminEventLogRecordInput {
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
			const [adminSnapshot, targetUserSnapshot] = await Promise.all([
				this.getUserSnapshot(input.adminId),
				this.getUserSnapshot(input.targetUserId)
			]);
			const requestSnapshot = this.getRequestSnapshot(input.request);

			return await this.prisma.adminEventLog.create({
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
		} catch (error) {
			this.logger.warn(
				`Admin event log failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			return null;
		}
	}

	private async getUserSnapshot(
		userId?: string | null
	): Promise<UserSnapshot | null> {
		if (!userId) {
			return null;
		}

		const user = await this.prisma.user.findUnique({
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

		const forwardedFor = this.getHeaderValue(
			request.headers['x-forwarded-for']
		);
		const realIp = this.getHeaderValue(request.headers['x-real-ip']);
		const cfIp = this.getHeaderValue(request.headers['cf-connecting-ip']);
		const userAgent = this.getHeaderValue(request.headers['user-agent']);

		return {
			ip:
				cfIp ||
				realIp ||
				(forwardedFor ? forwardedFor.split(',')[0].trim() : null) ||
				request.ip ||
				null,
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
