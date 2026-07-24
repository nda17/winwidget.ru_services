import { DAILY_SUMMARY_EVENT_TYPE } from '@/messaging/messaging.constants';

export interface DailySummaryRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof DAILY_SUMMARY_EVENT_TYPE;
	jobId: string;
	periodStart: string;
	periodEnd: string;
}
