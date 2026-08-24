import { IdentityInternalClient } from '@/identity-boundary/identity-internal.client';
import { PrismaService } from '@/prisma.service';
import { getClientIp } from '@/utils/ip.util';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

export type AdminEventLogSection =
	| 'PAYMENTS'
	| 'CAMPAIGNS'
	| 'TASKS'
	| 'SUBSCRIPTIONS'
	| 'USERS'
	| 'BACKLOG'
	| 'SITE_SETTINGS'
	| 'TELEGRAM_BOT'
	| 'AFFILIATE'
	| 'MESSAGING'
	| 'REPORTING'
	| 'DEV_TOOLS'
	| 'WIDGETS'
	| 'PLATFORM_CONTENT';

export type AdminEventLogAction =
	| 'PAYMENT_MANUAL_CHECK'
	| 'PAYMENT_CLEANUP_RUN'
	| 'AUTO_RENEWAL_ADMIN_PAUSE'
	| 'AUTO_RENEWAL_ADMIN_RESUME'
	| 'AUTO_RENEWAL_REVOKE'
	| 'AUTO_RENEWAL_RECONCILE'
	| 'AUTO_RENEWAL_TECHNICAL_RESUME'
	| 'TARIFF_PRICES_UPDATE'
	| 'LEGAL_PAGE_UPDATE'
	| 'CAMPAIGN_CREATE'
	| 'CAMPAIGN_CANCEL'
	| 'CAMPAIGN_DELIVERY_RETRY'
	| 'SUBSCRIPTION_ACTIVATE'
	| 'SUBSCRIPTION_EXTEND_DAYS'
	| 'SUBSCRIPTION_CANCEL'
	| 'SUBSCRIPTION_EXPIRY_CHECK_RUN'
	| 'VERIFICATION_CHALLENGE_CLEANUP_RUN'
	| 'USER_UPDATE'
	| 'USER_TOGGLE_ACTIVATION'
	| 'USER_DELETE'
	| 'USER_SOFT_DELETE'
	| 'USER_RESTORE'
	| 'BACKLOG_TASK_CREATE'
	| 'BACKLOG_TASK_UPDATE'
	| 'BACKLOG_TASK_DELETE'
	| 'SITE_SETTINGS_UPDATE'
	| 'AFFILIATE_SETTINGS_UPDATE'
	| 'TELEGRAM_BOT_SETTINGS_UPDATE'
	| 'TELEGRAM_SCHEDULE_SETTINGS_REJECTED'
	| 'TELEGRAM_BOT_WEBHOOK_REINSTALL'
	| 'TELEGRAM_DATABASE_BACKUP_CREATE'
	| 'TELEGRAM_DATABASE_RESTORE'
	| 'MESSAGING_FAILURE_RETRY'
	| 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY'
	| 'BILLING_DELIVERY_RETRY'
	| 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE'
	| 'REPORTING_DAILY_SUMMARY_SCHEDULE_UPDATE'
	| 'REPORTING_DAILY_SUMMARY_SCHEDULE_REJECTED'
	| 'REPORTING_DELIVERY_RETRY'
	| 'DEV_DATABASE_RESTORE'
	| 'DEV_DATABASE_RESTORE_PUBLISHED'
	| 'WIDGET_UPDATE'
	| 'WIDGET_PUBLISH'
	| 'WIDGET_DRAFT_DISCARD'
	| 'WIDGET_VERSION_RESTORE'
	| 'WIDGET_CLONE'
	| 'WIDGET_DELETE'
	| 'WIDGET_BUTTON_IMAGE_UPDATE'
	| 'WIDGET_DELIVERY_RETRY'
	| 'WIDGET_DELIVERY_CLOSE'
	| 'PLATFORM_SITE_SETTINGS_UPDATE'
	| 'PLATFORM_LEGAL_PAGE_UPDATE'
	| 'PLATFORM_HOME_PAGE_CONTENT_UPDATE'
	| 'PLATFORM_HOME_PAGE_RAW_CODE_UPDATE';

const ADMIN_EVENT_LOG_SECTIONS: AdminEventLogSection[] = [
	'PAYMENTS',
	'CAMPAIGNS',
	'TASKS',
	'SUBSCRIPTIONS',
	'USERS',
	'BACKLOG',
	'SITE_SETTINGS',
	'TELEGRAM_BOT',
	'AFFILIATE',
	'MESSAGING',
	'REPORTING',
	'DEV_TOOLS',
	'WIDGETS',
	'PLATFORM_CONTENT'
];

const ADMIN_EVENT_LOG_ACTIONS: AdminEventLogAction[] = [
	'PAYMENT_MANUAL_CHECK',
	'PAYMENT_CLEANUP_RUN',
	'AUTO_RENEWAL_ADMIN_PAUSE',
	'AUTO_RENEWAL_ADMIN_RESUME',
	'AUTO_RENEWAL_REVOKE',
	'AUTO_RENEWAL_RECONCILE',
	'AUTO_RENEWAL_TECHNICAL_RESUME',
	'TARIFF_PRICES_UPDATE',
	'LEGAL_PAGE_UPDATE',
	'CAMPAIGN_CREATE',
	'CAMPAIGN_CANCEL',
	'CAMPAIGN_DELIVERY_RETRY',
	'SUBSCRIPTION_ACTIVATE',
	'SUBSCRIPTION_EXTEND_DAYS',
	'SUBSCRIPTION_CANCEL',
	'SUBSCRIPTION_EXPIRY_CHECK_RUN',
	'VERIFICATION_CHALLENGE_CLEANUP_RUN',
	'USER_UPDATE',
	'USER_TOGGLE_ACTIVATION',
	'USER_DELETE',
	'USER_SOFT_DELETE',
	'USER_RESTORE',
	'BACKLOG_TASK_CREATE',
	'BACKLOG_TASK_UPDATE',
	'BACKLOG_TASK_DELETE',
	'SITE_SETTINGS_UPDATE',
	'AFFILIATE_SETTINGS_UPDATE',
	'TELEGRAM_BOT_SETTINGS_UPDATE',
	'TELEGRAM_SCHEDULE_SETTINGS_REJECTED',
	'TELEGRAM_BOT_WEBHOOK_REINSTALL',
	'TELEGRAM_DATABASE_BACKUP_CREATE',
	'TELEGRAM_DATABASE_RESTORE',
	'MESSAGING_FAILURE_RETRY',
	'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY',
	'BILLING_DELIVERY_RETRY',
	'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
	'REPORTING_DAILY_SUMMARY_SCHEDULE_UPDATE',
	'REPORTING_DAILY_SUMMARY_SCHEDULE_REJECTED',
	'REPORTING_DELIVERY_RETRY',
	'DEV_DATABASE_RESTORE',
	'DEV_DATABASE_RESTORE_PUBLISHED',
	'WIDGET_UPDATE',
	'WIDGET_PUBLISH',
	'WIDGET_DRAFT_DISCARD',
	'WIDGET_VERSION_RESTORE',
	'WIDGET_CLONE',
	'WIDGET_DELETE',
	'WIDGET_BUTTON_IMAGE_UPDATE',
	'WIDGET_DELIVERY_RETRY',
	'WIDGET_DELIVERY_CLOSE',
	'PLATFORM_SITE_SETTINGS_UPDATE',
	'PLATFORM_LEGAL_PAGE_UPDATE',
	'PLATFORM_HOME_PAGE_CONTENT_UPDATE',
	'PLATFORM_HOME_PAGE_RAW_CODE_UPDATE'
];

export interface AdminEventLogRecordInput {
	adminId?: string | null;
	adminName?: string | null;
	adminEmail?: string | null;
	section: AdminEventLogSection;
	action: AdminEventLogAction;
	description: string;
	entityType?: string | null;
	entityId?: string | null;
	entityLabel?: string | null;
	targetUserId?: string | null;
	targetUserName?: string | null;
	targetUserEmail?: string | null;
	metadata?: Prisma.InputJsonValue;
	request?: Request;
	ip?: string | null;
	userAgent?: string | null;
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

	constructor(
		private readonly prisma: PrismaService,
		private readonly identity: IdentityInternalClient
	) {}

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

	async recordOnce(recordId: string, input: AdminEventLogRecordInput) {
		const normalizedRecordId = recordId.trim();
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalizedRecordId)) {
			this.logger.warn('Admin event log idempotency id is invalid');
			return null;
		}
		try {
			return await this.recordWithClient(
				this.prisma,
				input,
				normalizedRecordId
			);
		} catch (error) {
			try {
				const existing = await this.prisma.adminEventLog.findUnique({
					where: { id: normalizedRecordId }
				});
				if (
					existing?.action === input.action &&
					existing.entityId === (input.entityId || null)
				) {
					return existing;
				}
			} catch {
				// The original error is logged below without exposing audit payloads.
			}
			this.logger.warn(
				`Idempotent admin event log failed: ${
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
		input: AdminEventLogRecordInput,
		recordId?: string
	) {
		const [adminSnapshot, targetUserSnapshot] =
			await this.resolveUserSnapshots(input);
		const requestSnapshot = input.request
			? this.getRequestSnapshot(input.request)
			: {
					ip: input.ip || null,
					userAgent: input.userAgent || null
				};

		return client.adminEventLog.create({
			data: {
				...(recordId ? { id: recordId } : {}),
				adminId: input.adminId || null,
				adminName: adminSnapshot.name,
				adminEmail: adminSnapshot.email,
				section: input.section,
				action: input.action,
				description: input.description.trim(),
				entityType: input.entityType || null,
				entityId: input.entityId || null,
				entityLabel: input.entityLabel || null,
				targetUserId: input.targetUserId || null,
				targetUserName: targetUserSnapshot.name,
				targetUserEmail: targetUserSnapshot.email,
				metadata: input.metadata ?? {},
				ip: requestSnapshot.ip,
				userAgent: requestSnapshot.userAgent
			}
		});
	}

	private async resolveUserSnapshots(
		input: AdminEventLogRecordInput
	): Promise<[UserSnapshot, UserSnapshot]> {
		const requestedIds = [
			input.adminName === undefined && input.adminEmail === undefined
				? input.adminId
				: undefined,
			input.targetUserName === undefined &&
			input.targetUserEmail === undefined
				? input.targetUserId
				: undefined
		].filter((value): value is string => Boolean(value));
		const uniqueIds = [...new Set(requestedIds)];
		let snapshots = new Map<string, UserSnapshot>();
		if (uniqueIds.length) {
			try {
				snapshots = await this.identity.getAuditSnapshots(uniqueIds);
			} catch (error) {
				this.logger.warn(
					`Identity audit snapshot lookup failed: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			}
		}
		return [
			this.resolveUserSnapshot(
				input.adminId,
				input.adminName,
				input.adminEmail,
				snapshots
			),
			this.resolveUserSnapshot(
				input.targetUserId,
				input.targetUserName,
				input.targetUserEmail,
				snapshots
			)
		];
	}

	private resolveUserSnapshot(
		userId: string | null | undefined,
		providedName: string | null | undefined,
		providedEmail: string | null | undefined,
		snapshots: Map<string, UserSnapshot>
	): UserSnapshot {
		if (providedName !== undefined || providedEmail !== undefined) {
			return {
				name: providedName ?? null,
				email: providedEmail ?? null
			};
		}
		return (
			(userId && snapshots.get(userId)) || { name: null, email: null }
		);
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
