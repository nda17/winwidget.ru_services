import {
	Prisma,
	ScheduledJobRun,
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/client';

export const SCHEDULED_JOB_TYPES = {
	DATABASE_BACKUP: 'DATABASE_BACKUP',
	NOTIFICATION_DELIVERY_DATABASE_BACKUP:
		'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
	CAMPAIGNS_DATABASE_BACKUP: 'CAMPAIGNS_DATABASE_BACKUP',
	REPORTING_DATABASE_BACKUP: 'REPORTING_DATABASE_BACKUP',
	WIDGETS_DATABASE_BACKUP: 'WIDGETS_DATABASE_BACKUP',
	BILLING_DATABASE_BACKUP: 'BILLING_DATABASE_BACKUP',
	IDENTITY_DATABASE_BACKUP: 'IDENTITY_DATABASE_BACKUP'
} as const;

export type ScheduledJobType =
	| (typeof SCHEDULED_JOB_TYPES)[keyof typeof SCHEDULED_JOB_TYPES]
	| string;

export const DATABASE_BACKUP_JOB_TYPES = [
	SCHEDULED_JOB_TYPES.DATABASE_BACKUP,
	SCHEDULED_JOB_TYPES.NOTIFICATION_DELIVERY_DATABASE_BACKUP,
	SCHEDULED_JOB_TYPES.CAMPAIGNS_DATABASE_BACKUP,
	SCHEDULED_JOB_TYPES.REPORTING_DATABASE_BACKUP,
	SCHEDULED_JOB_TYPES.WIDGETS_DATABASE_BACKUP,
	SCHEDULED_JOB_TYPES.BILLING_DATABASE_BACKUP,
	SCHEDULED_JOB_TYPES.IDENTITY_DATABASE_BACKUP
] as const;

export type DatabaseBackupJobType =
	(typeof DATABASE_BACKUP_JOB_TYPES)[number];

export const isDatabaseBackupJobType = (
	value: string
): value is DatabaseBackupJobType =>
	DATABASE_BACKUP_JOB_TYPES.includes(value as DatabaseBackupJobType);

export const TERMINAL_SCHEDULED_JOB_STATUSES: ScheduledJobRunStatus[] = [
	ScheduledJobRunStatus.SUCCEEDED,
	ScheduledJobRunStatus.FAILED,
	ScheduledJobRunStatus.CANCELLED,
	ScheduledJobRunStatus.SKIPPED
];

export interface ScheduledJobOutboxEvent {
	eventType: string;
	routingKey: string;
	deadLetterRoutingKey: string;
	payload?: Prisma.InputJsonObject;
}

export interface ScheduledJobFailureOptions {
	allowRetry?: boolean;
	deadLetterHeaders?: Record<string, string | number | boolean>;
}

export interface EnqueueScheduledJobInput {
	jobType: ScheduledJobType;
	scheduleKey: string;
	trigger?: ScheduledJobRunTrigger;
	scheduledFor: Date;
	periodStart?: Date | null;
	periodEnd?: Date | null;
	input?: Prisma.InputJsonValue;
	maxAttempts?: number;
	availableAt?: Date;
}

export interface ScheduledJobRunView {
	id: string;
	jobType: string;
	scheduleKey: string;
	trigger: ScheduledJobRunTrigger;
	status: ScheduledJobRunStatus;
	scheduledFor: string;
	periodStart: string | null;
	periodEnd: string | null;
	input: Prisma.JsonValue;
	checkpoint: Prisma.JsonValue;
	result: Prisma.JsonValue | null;
	attempts: number;
	maxAttempts: number;
	availableAt: string;
	leaseOwner: string | null;
	leaseToken: string | null;
	leaseExpiresAt: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}

export type ScheduledJobClaimResult =
	| {
			state: 'claimed';
			job: ScheduledJobRunView;
			leaseToken: string;
	  }
	| {
			state: 'busy' | 'not_due' | 'terminal';
			job: ScheduledJobRunView;
	  }
	| {
			state: 'not_found';
	  };

export type ScheduledJobFailureResult =
	| {
			state: 'retry_scheduled' | 'failed';
			job: ScheduledJobRunView;
	  }
	| {
			state: 'lost';
	  };

export type ScheduledJobInterruptionResult =
	| {
			state: 'requeued';
			job: ScheduledJobRunView;
	  }
	| {
			state: 'lost';
	  };

export interface RecoverExpiredScheduledJobsResult {
	requeued: number;
	failed: number;
}

export const serializeScheduledJobRun = (
	job: ScheduledJobRun
): ScheduledJobRunView => ({
	id: job.id,
	jobType: job.jobType,
	scheduleKey: job.scheduleKey,
	trigger: job.trigger,
	status: job.status,
	scheduledFor: job.scheduledFor.toISOString(),
	periodStart: job.periodStart?.toISOString() ?? null,
	periodEnd: job.periodEnd?.toISOString() ?? null,
	input: job.input,
	checkpoint: job.checkpoint,
	result: job.result,
	attempts: job.attempts,
	maxAttempts: job.maxAttempts,
	availableAt: job.availableAt.toISOString(),
	leaseOwner: job.leaseOwner,
	leaseToken: job.leaseToken,
	leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
	startedAt: job.startedAt?.toISOString() ?? null,
	finishedAt: job.finishedAt?.toISOString() ?? null,
	lastError: job.lastError,
	createdAt: job.createdAt.toISOString(),
	updatedAt: job.updatedAt.toISOString()
});
