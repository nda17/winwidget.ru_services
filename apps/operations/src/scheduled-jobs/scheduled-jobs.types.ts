import type {
	Prisma,
	ScheduledJobRun,
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/operations-client';

export const DATABASE_BACKUP_TARGETS = [
	'notification-delivery',
	'campaigns',
	'reporting',
	'widgets',
	'billing',
	'identity',
	'platform',
	'support',
	'operations'
] as const;

export type DatabaseBackupTarget =
	(typeof DATABASE_BACKUP_TARGETS)[number];

export const DATABASE_BACKUP_DELAY_MINUTES: Record<
	DatabaseBackupTarget,
	number
> = {
	'notification-delivery': 15,
	campaigns: 30,
	reporting: 45,
	widgets: 60,
	billing: 75,
	identity: 90,
	platform: 105,
	support: 120,
	operations: 135
};

export const databaseBackupJobType = (target: DatabaseBackupTarget) =>
	`${target.replace(/-/g, '_').toUpperCase()}_DATABASE_BACKUP`;

export const DATABASE_BACKUP_JOB_TYPES = DATABASE_BACKUP_TARGETS.map(
	databaseBackupJobType
);

export interface EnqueueScheduledJobInput {
	jobType: string;
	scheduleKey: string;
	trigger?: ScheduledJobRunTrigger;
	scheduledFor: Date;
	periodStart?: Date | null;
	periodEnd?: Date | null;
	input?: Prisma.InputJsonValue;
	maxAttempts?: number;
	availableAt?: Date;
}

export interface ScheduledJobView {
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

export const serializeScheduledJob = (
	job: ScheduledJobRun
): ScheduledJobView => ({
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
