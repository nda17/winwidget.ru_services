import { DATABASE_BACKUP_EVENT_TYPE } from '@/messaging/messaging.constants';
import { DatabaseBackupJobType } from '@/scheduled-jobs/scheduled-jobs.types';

export interface DatabaseBackupRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof DATABASE_BACKUP_EVENT_TYPE;
	jobId: string;
	jobType: DatabaseBackupJobType;
	scheduleKey: string;
	periodStart: string | null;
	periodEnd: string | null;
}
