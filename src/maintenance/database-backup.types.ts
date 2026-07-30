import type { TelegramDocumentReceipt } from '@/telegram-bot/telegram-info-transport.service';

export const DATABASE_BACKUP_TARGETS = {
	CORE: 'core',
	NOTIFICATION_DELIVERY: 'notification-delivery',
	CAMPAIGNS: 'campaigns'
} as const;

export type DatabaseBackupTarget =
	(typeof DATABASE_BACKUP_TARGETS)[keyof typeof DATABASE_BACKUP_TARGETS];

export const NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES = 15;
export const CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES = 30;

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
