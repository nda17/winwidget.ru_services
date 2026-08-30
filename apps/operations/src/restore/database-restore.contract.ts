import type { DatabaseBackupTarget } from '../scheduled-jobs/scheduled-jobs.types';

export const DATABASE_RESTORE_TARGETS = [
	'notification-delivery',
	'campaigns',
	'reporting',
	'widgets',
	'identity',
	'platform',
	'support'
] as const satisfies ReadonlyArray<DatabaseBackupTarget>;
export type DatabaseRestoreTarget =
	(typeof DATABASE_RESTORE_TARGETS)[number];
export const DATABASE_RESTORE_SERVICES_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const DATABASE_RESTORE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED =
	'PHYSICAL_WRITER_FENCE_UNCONFIRMED';
export const DATABASE_RESTORE_PERMIT_TTL_MS = 10 * 60 * 1000;
export const DATABASE_RESTORE_RECOVERY_ACTION_TTL_MS = 15 * 60 * 1000;
export const DATABASE_RESTORE_MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
export const DATABASE_RESTORE_UPLOAD_LIMITS = {
	fieldNameSize: 64,
	fieldSize: 1024,
	fields: 2,
	fileSize: DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	files: 1,
	parts: 4,
	fieldNestingDepth: 0
} as const;

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
	}
];

export interface UploadedRestoreFile {
	originalname: string;
	size: number;
	buffer: Buffer;
}
