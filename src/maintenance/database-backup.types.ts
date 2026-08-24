import type { TelegramDocumentReceipt } from '@/telegram-bot/telegram-info-transport.service';
import type {
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/client';

export const DATABASE_BACKUP_TARGETS = {
	NOTIFICATION_DELIVERY: 'notification-delivery',
	CAMPAIGNS: 'campaigns',
	REPORTING: 'reporting',
	WIDGETS: 'widgets',
	BILLING: 'billing',
	IDENTITY: 'identity',
	PLATFORM: 'platform'
} as const;

export type DatabaseBackupTarget =
	(typeof DATABASE_BACKUP_TARGETS)[keyof typeof DATABASE_BACKUP_TARGETS];

export const NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES = 15;
export const CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES = 30;
export const REPORTING_DATABASE_BACKUP_DELAY_MINUTES = 45;
export const WIDGETS_DATABASE_BACKUP_DELAY_MINUTES = 60;
export const BILLING_DATABASE_BACKUP_DELAY_MINUTES = 75;
export const IDENTITY_DATABASE_BACKUP_DELAY_MINUTES = 90;
export const PLATFORM_DATABASE_BACKUP_DELAY_MINUTES = 105;

export interface DatabaseBackupInput {
	chatId: string;
	messageThreadId: number;
	trigger: 'MANUAL' | 'SCHEDULED';
	periodStart?: string | null;
}

export interface DatabaseBackupResult {
	target: DatabaseBackupTarget;
	databaseName: string;
	schema: string;
	fileName: string;
	fileSize: number;
	fileSha256: string;
	createdAt: string;
	telegramSent: true;
	telegramReceipt: TelegramDocumentReceipt;
}

export const DATABASE_BACKUP_FRESHNESS_HOURS = 36;

export type DatabaseBackupFreshness =
	| 'DISABLED'
	| 'MISSING'
	| 'FRESH'
	| 'STALE';

export interface DatabaseBackupAdminJobSummary {
	target: DatabaseBackupTarget;
	jobId: string;
	trigger: ScheduledJobRunTrigger;
	status: ScheduledJobRunStatus;
	queuedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	attempts: number;
	maxAttempts: number;
	fileSize: number | null;
	hasError: boolean;
}

export interface DatabaseBackupOverviewItem {
	target: DatabaseBackupTarget;
	freshness: DatabaseBackupFreshness;
	staleAfter: string | null;
	latest: DatabaseBackupAdminJobSummary | null;
	latestScheduled: DatabaseBackupAdminJobSummary | null;
	latestManual: DatabaseBackupAdminJobSummary | null;
	latestSuccessful: DatabaseBackupAdminJobSummary | null;
}

export interface DatabaseBackupOverview {
	databaseBackupEnabled: boolean;
	generatedAt: string;
	staleAfterHours: number;
	items: DatabaseBackupOverviewItem[];
}

export interface DatabaseBackupJobsQuery {
	target?: DatabaseBackupTarget;
	trigger?: ScheduledJobRunTrigger;
	status?: ScheduledJobRunStatus;
	page: number;
	limit: number;
}

export interface DatabaseBackupJobsPage {
	items: DatabaseBackupAdminJobSummary[];
	page: number;
	limit: number;
	total: number;
	totalPages: number;
}
