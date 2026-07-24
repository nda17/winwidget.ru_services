import { DATABASE_BACKUP_EVENT_TYPE } from '@/messaging/messaging.constants';

export interface DatabaseBackupRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof DATABASE_BACKUP_EVENT_TYPE;
	jobId: string;
}
