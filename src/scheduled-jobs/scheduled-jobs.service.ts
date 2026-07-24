import { PrismaService } from '@/prisma.service';
import {
	EnqueueScheduledJobInput,
	RecoverExpiredScheduledJobsResult,
	ScheduledJobClaimResult,
	ScheduledJobFailureResult,
	ScheduledJobInterruptionResult,
	ScheduledJobOutboxEvent,
	ScheduledJobRunView,
	serializeScheduledJobRun,
	TERMINAL_SCHEDULED_JOB_STATUSES
} from '@/scheduled-jobs/scheduled-jobs.types';
import { Injectable } from '@nestjs/common';
import {
	Prisma,
	ScheduledJobRun,
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_MAX_ATTEMPTS = 100;
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_ERROR_LENGTH = 10_000;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MANUAL_RETRY_ATTEMPTS = 4;

interface ClaimUpdateRow {
	id: string;
}

interface LeaseUpdateRow {
	leaseExpiresAt: Date;
}

interface RetryUpdateRow {
	availableAt: Date;
}

interface LockedJobAttempt {
	id: string;
	attempts: number;
	maxAttempts: number;
}

@Injectable()
export class ScheduledJobsService {
	constructor(private readonly prisma: PrismaService) {}

	async enqueueUnique(
		input: EnqueueScheduledJobInput,
		event: ScheduledJobOutboxEvent
	): Promise<{ created: boolean; job: ScheduledJobRunView }> {
		this.validateEnqueueInput(input);
		this.validateEvent(event);

		return this.prisma.$transaction(transaction =>
			this.enqueueUniqueInTransaction(transaction, input, event)
		);
	}

	async enqueueUniqueInTransaction(
		transaction: Prisma.TransactionClient,
		input: EnqueueScheduledJobInput,
		event: ScheduledJobOutboxEvent
	): Promise<{ created: boolean; job: ScheduledJobRunView }> {
		this.validateEnqueueInput(input);
		this.validateEvent(event);

		const id = randomUUID();
		const trigger = input.trigger ?? ScheduledJobRunTrigger.SCHEDULED;
		const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		const availableAt = input.availableAt ?? new Date();
		const inputJson = this.stringifyJson(input.input ?? {}, 'job input');
		const inserted = await transaction.$queryRaw<ClaimUpdateRow[]>(
			Prisma.sql`
				INSERT INTO "scheduled_job_runs" (
					"id",
					"job_type",
					"schedule_key",
					"trigger",
					"scheduled_for",
					"period_start",
					"period_end",
					"input",
					"max_attempts",
					"available_at",
					"updated_at"
				)
				VALUES (
					${id}::uuid,
					${input.jobType},
					${input.scheduleKey},
					${trigger}::"ScheduledJobRunTrigger",
					${input.scheduledFor},
					${input.periodStart ?? null},
					${input.periodEnd ?? null},
					CAST(${inputJson} AS jsonb),
					${maxAttempts},
					${availableAt},
					NOW()
				)
				ON CONFLICT ("job_type", "schedule_key") DO NOTHING
				RETURNING "id"
			`
		);
		const created = inserted.length === 1;
		const job = await transaction.scheduledJobRun.findUniqueOrThrow({
			where: created
				? { id }
				: {
						jobType_scheduleKey: {
							jobType: input.jobType,
							scheduleKey: input.scheduleKey
						}
					}
		});

		if (created) {
			await this.createOutboxEvent(transaction, job, event, availableAt);
		}

		return {
			created,
			job: serializeScheduledJobRun(job)
		};
	}

	async getJob(id: string): Promise<ScheduledJobRunView | null> {
		this.validateUuid(id, 'job id');
		const job = await this.prisma.scheduledJobRun.findUnique({
			where: { id }
		});
		return job ? serializeScheduledJobRun(job) : null;
	}

	async claim(
		id: string,
		workerId: string,
		leaseMs: number,
		expectedJobType: string
	): Promise<ScheduledJobClaimResult> {
		this.validateUuid(id, 'job id');
		this.validateIdentifier(workerId, 'worker id');
		this.validateLeaseMs(leaseMs);
		this.validateIdentifier(expectedJobType, 'expected job type');

		await this.markExhaustedJobFailed(id, expectedJobType);

		const leaseToken = randomUUID();
		const claimed = await this.prisma.$queryRaw<ClaimUpdateRow[]>(
			Prisma.sql`
				UPDATE "scheduled_job_runs"
				SET
					"status" = 'PROCESSING'::"ScheduledJobRunStatus",
					"attempts" = "attempts" + 1,
					"lease_owner" = ${workerId},
					"lease_token" = ${leaseToken}::uuid,
					"lease_expires_at" =
						NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
					"started_at" = COALESCE("started_at", NOW()),
					"finished_at" = NULL,
					"last_error" = NULL,
					"updated_at" = NOW()
				WHERE "id" = ${id}::uuid
					AND "job_type" = ${expectedJobType}
					AND "attempts" < "max_attempts"
					AND "available_at" <= NOW()
					AND (
						"status" = 'QUEUED'::"ScheduledJobRunStatus"
						OR (
							"status" = 'PROCESSING'::"ScheduledJobRunStatus"
							AND "lease_expires_at" < NOW()
						)
					)
				RETURNING "id"
			`
		);

		if (claimed.length === 1) {
			const job = await this.prisma.scheduledJobRun.findUniqueOrThrow({
				where: { id }
			});
			return {
				state: 'claimed',
				job: serializeScheduledJobRun(job),
				leaseToken
			};
		}

		const job = await this.prisma.scheduledJobRun.findUnique({
			where: { id }
		});
		if (!job) return { state: 'not_found' };
		const serialized = serializeScheduledJobRun(job);
		if (TERMINAL_SCHEDULED_JOB_STATUSES.includes(job.status)) {
			return { state: 'terminal', job: serialized };
		}
		if (
			job.status === ScheduledJobRunStatus.QUEUED &&
			job.availableAt.getTime() > Date.now()
		) {
			return { state: 'not_due', job: serialized };
		}
		return { state: 'busy', job: serialized };
	}

	async renewLease(
		id: string,
		leaseToken: string,
		leaseMs: number
	): Promise<Date | null> {
		this.validateUuid(id, 'job id');
		this.validateUuid(leaseToken, 'lease token');
		this.validateLeaseMs(leaseMs);

		const renewed = await this.prisma.$queryRaw<LeaseUpdateRow[]>(
			Prisma.sql`
				UPDATE "scheduled_job_runs"
				SET
					"lease_expires_at" =
						NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
					"updated_at" = NOW()
				WHERE "id" = ${id}::uuid
					AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"
					AND "lease_token" = ${leaseToken}::uuid
					AND "lease_expires_at" > NOW()
				RETURNING "lease_expires_at" AS "leaseExpiresAt"
			`
		);
		return renewed[0]?.leaseExpiresAt ?? null;
	}

	async saveCheckpoint(
		id: string,
		leaseToken: string,
		checkpoint: Prisma.InputJsonValue
	): Promise<ScheduledJobRunView | null> {
		this.validateUuid(id, 'job id');
		this.validateUuid(leaseToken, 'lease token');
		const checkpointJson = this.stringifyJson(
			checkpoint,
			'job checkpoint'
		);
		const updated = await this.prisma.$executeRaw(
			Prisma.sql`
				UPDATE "scheduled_job_runs"
				SET
					"checkpoint" = CAST(${checkpointJson} AS jsonb),
					"updated_at" = NOW()
				WHERE "id" = ${id}::uuid
					AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"
					AND "lease_token" = ${leaseToken}::uuid
					AND "lease_expires_at" > NOW()
			`
		);
		return updated === 1 ? this.getJob(id) : null;
	}

	async complete(
		id: string,
		leaseToken: string,
		result?: Prisma.InputJsonValue
	): Promise<ScheduledJobRunView | null> {
		return this.prisma.$transaction(transaction =>
			this.completeInTransaction(transaction, id, leaseToken, result)
		);
	}

	async completeInTransaction(
		transaction: Prisma.TransactionClient,
		id: string,
		leaseToken: string,
		result?: Prisma.InputJsonValue
	): Promise<ScheduledJobRunView | null> {
		this.validateUuid(id, 'job id');
		this.validateUuid(leaseToken, 'lease token');
		const resultSql =
			result === undefined
				? Prisma.sql`NULL`
				: Prisma.sql`CAST(${this.stringifyJson(result, 'job result')} AS jsonb)`;
		const completed = await transaction.$executeRaw(
			Prisma.sql`
				UPDATE "scheduled_job_runs"
				SET
					"status" = 'SUCCEEDED'::"ScheduledJobRunStatus",
					"result" = ${resultSql},
					"finished_at" = NOW(),
					"last_error" = NULL,
					"lease_owner" = NULL,
					"lease_token" = NULL,
					"lease_expires_at" = NULL,
					"updated_at" = NOW()
				WHERE "id" = ${id}::uuid
					AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"
					AND "lease_token" = ${leaseToken}::uuid
					AND "lease_expires_at" > NOW()
			`
		);
		if (completed !== 1) return null;
		const job = await transaction.scheduledJobRun.findUniqueOrThrow({
			where: { id }
		});
		return serializeScheduledJobRun(job);
	}

	async skip(
		id: string,
		leaseToken: string,
		reason: string
	): Promise<ScheduledJobRunView | null> {
		this.validateUuid(id, 'job id');
		this.validateUuid(leaseToken, 'lease token');
		const skipped = await this.prisma.$executeRaw(
			Prisma.sql`
				UPDATE "scheduled_job_runs"
				SET
					"status" = 'SKIPPED'::"ScheduledJobRunStatus",
					"finished_at" = NOW(),
					"last_error" = ${this.normalizeError(reason)},
					"lease_owner" = NULL,
					"lease_token" = NULL,
					"lease_expires_at" = NULL,
					"updated_at" = NOW()
				WHERE "id" = ${id}::uuid
					AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"
					AND "lease_token" = ${leaseToken}::uuid
					AND "lease_expires_at" > NOW()
			`
		);
		return skipped === 1 ? this.getJob(id) : null;
	}

	async releaseOrFail(
		id: string,
		leaseToken: string,
		error: unknown,
		retryDelayMs: number,
		event: ScheduledJobOutboxEvent
	): Promise<ScheduledJobFailureResult> {
		this.validateUuid(id, 'job id');
		this.validateUuid(leaseToken, 'lease token');
		this.validateRetryDelay(retryDelayMs);
		this.validateEvent(event);
		const lastError = this.normalizeError(error);

		return this.prisma.$transaction(async transaction => {
			const locked = await transaction.$queryRaw<LockedJobAttempt[]>(
				Prisma.sql`
					SELECT
						"id",
						"attempts",
						"max_attempts" AS "maxAttempts"
					FROM "scheduled_job_runs"
					WHERE "id" = ${id}::uuid
						AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"
						AND "lease_token" = ${leaseToken}::uuid
						AND "lease_expires_at" > NOW()
					FOR UPDATE
				`
			);
			if (!locked.length) return { state: 'lost' };

			if (locked[0].attempts >= locked[0].maxAttempts) {
				const failedCount = await transaction.$executeRaw(
					Prisma.sql`
						UPDATE "scheduled_job_runs"
						SET
							"status" = 'FAILED'::"ScheduledJobRunStatus",
							"finished_at" = NOW(),
							"last_error" = ${lastError},
							"lease_owner" = NULL,
							"lease_token" = NULL,
							"lease_expires_at" = NULL,
							"updated_at" = NOW()
						WHERE "id" = ${id}::uuid
							AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"
							AND "lease_token" = ${leaseToken}::uuid
							AND "lease_expires_at" > NOW()
					`
				);
				if (failedCount !== 1) return { state: 'lost' };
				const failed = await transaction.scheduledJobRun.findUniqueOrThrow(
					{
						where: { id }
					}
				);
				return {
					state: 'failed',
					job: serializeScheduledJobRun(failed)
				};
			}

			const retried = await transaction.$queryRaw<RetryUpdateRow[]>(
				Prisma.sql`
					UPDATE "scheduled_job_runs"
					SET
						"status" = 'QUEUED'::"ScheduledJobRunStatus",
						"available_at" =
							NOW() + (${retryDelayMs} * INTERVAL '1 millisecond'),
						"finished_at" = NULL,
						"last_error" = ${lastError},
						"lease_owner" = NULL,
						"lease_token" = NULL,
						"lease_expires_at" = NULL,
						"updated_at" = NOW()
					WHERE "id" = ${id}::uuid
						AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"
						AND "lease_token" = ${leaseToken}::uuid
						AND "lease_expires_at" > NOW()
					RETURNING "available_at" AS "availableAt"
				`
			);
			if (!retried.length) return { state: 'lost' };
			const job = await transaction.scheduledJobRun.findUniqueOrThrow({
				where: { id }
			});
			await this.createOutboxEvent(
				transaction,
				job,
				event,
				retried[0].availableAt
			);
			return {
				state: 'retry_scheduled',
				job: serializeScheduledJobRun(job)
			};
		});
	}

	async requeueInterrupted(
		id: string,
		leaseToken: string,
		event: ScheduledJobOutboxEvent
	): Promise<ScheduledJobInterruptionResult> {
		this.validateUuid(id, 'job id');
		this.validateUuid(leaseToken, 'lease token');
		this.validateEvent(event);

		return this.prisma.$transaction(async transaction => {
			const requeued = await transaction.$queryRaw<RetryUpdateRow[]>(
				Prisma.sql`
					UPDATE "scheduled_job_runs"
					SET
						"status" = 'QUEUED'::"ScheduledJobRunStatus",
						"attempts" = GREATEST("attempts" - 1, 0),
						"available_at" = NOW(),
						"finished_at" = NULL,
						"last_error" = NULL,
						"lease_owner" = NULL,
						"lease_token" = NULL,
						"lease_expires_at" = NULL,
						"updated_at" = NOW()
					WHERE "id" = ${id}::uuid
						AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"
						AND "lease_token" = ${leaseToken}::uuid
					RETURNING "available_at" AS "availableAt"
				`
			);
			if (!requeued.length) return { state: 'lost' };

			const job = await transaction.scheduledJobRun.findUniqueOrThrow({
				where: { id }
			});
			await this.createOutboxEvent(
				transaction,
				job,
				event,
				requeued[0].availableAt
			);
			return {
				state: 'requeued',
				job: serializeScheduledJobRun(job)
			};
		});
	}

	async reopenForManualRetry(
		id: string,
		event: ScheduledJobOutboxEvent,
		attemptsToGrant = DEFAULT_MANUAL_RETRY_ATTEMPTS
	): Promise<ScheduledJobRunView | null> {
		this.validateUuid(id, 'job id');
		this.validateEvent(event);
		if (
			!Number.isInteger(attemptsToGrant) ||
			attemptsToGrant < 1 ||
			attemptsToGrant > MAX_MAX_ATTEMPTS
		) {
			throw new Error(
				`attemptsToGrant must be an integer between 1 and ${MAX_MAX_ATTEMPTS}`
			);
		}

		return this.prisma.$transaction(async transaction => {
			const reopened = await transaction.$queryRaw<RetryUpdateRow[]>(
				Prisma.sql`
					UPDATE "scheduled_job_runs"
					SET
						"status" = 'QUEUED'::"ScheduledJobRunStatus",
						"max_attempts" = "attempts" + ${attemptsToGrant},
						"available_at" = NOW(),
						"finished_at" = NULL,
						"result" = NULL,
						"last_error" = NULL,
						"lease_owner" = NULL,
						"lease_token" = NULL,
						"lease_expires_at" = NULL,
						"updated_at" = NOW()
					WHERE "id" = ${id}::uuid
						AND "status" = 'FAILED'::"ScheduledJobRunStatus"
					RETURNING "available_at" AS "availableAt"
				`
			);
			if (!reopened.length) return null;
			const job = await transaction.scheduledJobRun.findUniqueOrThrow({
				where: { id }
			});
			await this.createOutboxEvent(
				transaction,
				job,
				event,
				reopened[0].availableAt
			);
			return serializeScheduledJobRun(job);
		});
	}

	async recoverExpired(
		eventFor: (job: ScheduledJobRunView) => ScheduledJobOutboxEvent,
		options: {
			limit?: number;
			retryDelayMs?: number;
		} = {}
	): Promise<RecoverExpiredScheduledJobsResult> {
		const limit = options.limit ?? 50;
		const retryDelayMs = options.retryDelayMs ?? 0;
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
			throw new Error('limit must be an integer between 1 and 500');
		}
		this.validateRetryDelay(retryDelayMs);

		return this.prisma.$transaction(async transaction => {
			const locked = await transaction.$queryRaw<ClaimUpdateRow[]>(
				Prisma.sql`
					SELECT "id"
					FROM "scheduled_job_runs"
					WHERE "status" = 'PROCESSING'::"ScheduledJobRunStatus"
						AND "lease_expires_at" < NOW()
					ORDER BY "lease_expires_at" ASC
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				`
			);
			if (!locked.length) return { requeued: 0, failed: 0 };

			const jobs = await transaction.scheduledJobRun.findMany({
				where: { id: { in: locked.map(item => item.id) } }
			});
			let requeued = 0;
			let failed = 0;

			for (const job of jobs) {
				const leaseError = 'Scheduled job lease expired';
				if (job.attempts >= job.maxAttempts) {
					const failedAt = await transaction.$queryRaw<RetryUpdateRow[]>(
						Prisma.sql`
							UPDATE "scheduled_job_runs"
							SET
								"status" = 'FAILED'::"ScheduledJobRunStatus",
								"finished_at" = NOW(),
								"last_error" = ${leaseError},
								"lease_owner" = NULL,
								"lease_token" = NULL,
								"lease_expires_at" = NULL,
								"updated_at" = NOW()
							WHERE "id" = ${job.id}::uuid
								AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"
							RETURNING "finished_at" AS "availableAt"
						`
					);
					if (!failedAt.length) continue;
					const failedJob =
						await transaction.scheduledJobRun.findUniqueOrThrow({
							where: { id: job.id }
						});
					const event = eventFor(serializeScheduledJobRun(failedJob));
					this.validateEvent(event);
					await this.createOutboxEvent(
						transaction,
						failedJob,
						event,
						failedAt[0].availableAt
					);
					failed += 1;
					continue;
				}

				const available = await transaction.$queryRaw<RetryUpdateRow[]>(
					Prisma.sql`
						UPDATE "scheduled_job_runs"
						SET
							"status" = 'QUEUED'::"ScheduledJobRunStatus",
							"available_at" =
								NOW() + (${retryDelayMs} * INTERVAL '1 millisecond'),
							"finished_at" = NULL,
							"last_error" = ${leaseError},
							"lease_owner" = NULL,
							"lease_token" = NULL,
							"lease_expires_at" = NULL,
							"updated_at" = NOW()
						WHERE "id" = ${job.id}::uuid
							AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"
						RETURNING "available_at" AS "availableAt"
					`
				);
				if (!available.length) continue;
				const requeuedJob =
					await transaction.scheduledJobRun.findUniqueOrThrow({
						where: { id: job.id }
					});
				const event = eventFor(serializeScheduledJobRun(requeuedJob));
				this.validateEvent(event);
				await this.createOutboxEvent(
					transaction,
					requeuedJob,
					event,
					available[0].availableAt
				);
				requeued += 1;
			}

			return { requeued, failed };
		});
	}

	private async markExhaustedJobFailed(
		id: string,
		expectedJobType: string
	): Promise<void> {
		await this.prisma.$executeRaw(
			Prisma.sql`
				UPDATE "scheduled_job_runs"
				SET
					"status" = 'FAILED'::"ScheduledJobRunStatus",
					"finished_at" = NOW(),
					"last_error" = COALESCE(
						"last_error",
						'Maximum scheduled job attempts exhausted'
					),
					"lease_owner" = NULL,
					"lease_token" = NULL,
					"lease_expires_at" = NULL,
					"updated_at" = NOW()
				WHERE "id" = ${id}::uuid
					AND "job_type" = ${expectedJobType}
					AND "attempts" >= "max_attempts"
					AND (
						"status" = 'QUEUED'::"ScheduledJobRunStatus"
						OR (
							"status" = 'PROCESSING'::"ScheduledJobRunStatus"
							AND "lease_expires_at" < NOW()
						)
					)
			`
		);
	}

	private async createOutboxEvent(
		transaction: Prisma.TransactionClient,
		job: ScheduledJobRun,
		event: ScheduledJobOutboxEvent,
		availableAt: Date
	): Promise<void> {
		await transaction.outboxEvent.create({
			data: {
				messageId: job.id,
				eventType: event.eventType,
				routingKey: event.routingKey,
				availableAt,
				payload: {
					...(event.payload ?? {}),
					jobId: job.id,
					jobType: job.jobType,
					scheduleKey: job.scheduleKey,
					periodStart: job.periodStart?.toISOString() ?? null,
					periodEnd: job.periodEnd?.toISOString() ?? null
				} as Prisma.InputJsonObject
			}
		});
	}

	private validateEnqueueInput(input: EnqueueScheduledJobInput): void {
		this.validateIdentifier(input.jobType, 'job type');
		this.validateIdentifier(input.scheduleKey, 'schedule key');
		this.validateDate(input.scheduledFor, 'scheduledFor');
		if (input.availableAt) {
			this.validateDate(input.availableAt, 'availableAt');
		}
		if (Boolean(input.periodStart) !== Boolean(input.periodEnd)) {
			throw new Error(
				'periodStart and periodEnd must be provided together'
			);
		}
		if (input.periodStart && input.periodEnd) {
			this.validateDate(input.periodStart, 'periodStart');
			this.validateDate(input.periodEnd, 'periodEnd');
			if (input.periodEnd <= input.periodStart) {
				throw new Error('periodEnd must be after periodStart');
			}
		}
		const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		if (
			!Number.isInteger(maxAttempts) ||
			maxAttempts < 1 ||
			maxAttempts > MAX_MAX_ATTEMPTS
		) {
			throw new Error(
				`maxAttempts must be an integer between 1 and ${MAX_MAX_ATTEMPTS}`
			);
		}
	}

	private validateEvent(event: ScheduledJobOutboxEvent): void {
		this.validateIdentifier(event.eventType, 'event type');
		this.validateIdentifier(event.routingKey, 'routing key');
	}

	private validateIdentifier(value: string, label: string): void {
		if (
			typeof value !== 'string' ||
			!value.trim() ||
			value !== value.trim() ||
			value.length > MAX_IDENTIFIER_LENGTH
		) {
			throw new Error(
				`${label} must be trimmed and between 1 and ${MAX_IDENTIFIER_LENGTH} characters`
			);
		}
	}

	private validateUuid(value: string, label: string): void {
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				value
			)
		) {
			throw new Error(`${label} must be a valid UUID`);
		}
	}

	private validateDate(value: Date, label: string): void {
		if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
			throw new Error(`${label} must be a valid Date`);
		}
	}

	private validateLeaseMs(value: number): void {
		if (
			!Number.isInteger(value) ||
			value < MIN_LEASE_MS ||
			value > MAX_LEASE_MS
		) {
			throw new Error(
				`leaseMs must be an integer between ${MIN_LEASE_MS} and ${MAX_LEASE_MS}`
			);
		}
	}

	private validateRetryDelay(value: number): void {
		if (
			!Number.isInteger(value) ||
			value < 0 ||
			value > MAX_RETRY_DELAY_MS
		) {
			throw new Error(
				`retryDelayMs must be an integer between 0 and ${MAX_RETRY_DELAY_MS}`
			);
		}
	}

	private normalizeError(error: unknown): string {
		const message =
			error instanceof Error
				? error.message
				: typeof error === 'string'
					? error
					: String(error);
		return (message.trim() || 'Scheduled job failed').slice(
			0,
			MAX_ERROR_LENGTH
		);
	}

	private stringifyJson(
		value: Prisma.InputJsonValue,
		label: string
	): string {
		const json = JSON.stringify(value);
		if (json === undefined) {
			throw new Error(`${label} must be JSON serializable`);
		}
		return json;
	}
}
