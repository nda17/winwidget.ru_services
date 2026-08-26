import { DATABASE_BACKUP_TARGETS } from '../scheduled-jobs/scheduled-jobs.types';

export const DATABASE_RESTORE_TARGETS = DATABASE_BACKUP_TARGETS;
export type DatabaseRestoreTarget =
	(typeof DATABASE_RESTORE_TARGETS)[number];
export const DATABASE_RESTORE_MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;

export const DATABASE_RESTORE_SETTINGS: ReadonlyArray<{
	id: DatabaseRestoreTarget;
	label: string;
	confirmation: string;
}> = [
	{
		id: 'notification-delivery',
		label: 'Notification Delivery',
		confirmation: 'ВОССТАНОВИТЬ NOTIFICATION DELIVERY'
	},
	{
		id: 'campaigns',
		label: 'Campaigns',
		confirmation: 'ВОССТАНОВИТЬ CAMPAIGNS'
	},
	{
		id: 'reporting',
		label: 'Reporting',
		confirmation: 'ВОССТАНОВИТЬ REPORTING'
	},
	{
		id: 'widgets',
		label: 'Widgets',
		confirmation: 'ВОССТАНОВИТЬ WIDGETS'
	},
	{
		id: 'billing',
		label: 'Billing',
		confirmation: 'ВОССТАНОВИТЬ BILLING'
	},
	{
		id: 'identity',
		label: 'Identity',
		confirmation: 'ВОССТАНОВИТЬ IDENTITY'
	},
	{
		id: 'platform',
		label: 'Platform',
		confirmation: 'ВОССТАНОВИТЬ PLATFORM'
	},
	{
		id: 'support',
		label: 'Support',
		confirmation: 'ВОССТАНОВИТЬ SUPPORT'
	},
	{
		id: 'operations',
		label: 'Operations',
		confirmation: 'ВОССТАНОВИТЬ OPERATIONS'
	}
];

export interface UploadedRestoreFile {
	originalname: string;
	size: number;
	buffer: Buffer;
}
