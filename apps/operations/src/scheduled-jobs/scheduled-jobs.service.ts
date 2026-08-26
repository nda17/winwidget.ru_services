import { BadRequestException, Injectable } from '@nestjs/common';
import {
	Prisma,
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { OperationsOutboxService } from '../messaging/operations-outbox.service';
import {
	OPERATIONS_SCHEDULED_JOB_EVENT_TYPE,
	OPERATIONS_SCHEDULED_JOB_ROUTING_KEY
} from '../messaging/operations-messaging.constants';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import {
	EnqueueScheduledJobInput,
	ScheduledJobView,
	serializeScheduledJob
} from './scheduled-jobs.types';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
@Injectable()
export class ScheduledJobsService {
	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly outbox: OperationsOutboxService
	) {}

	enqueueUnique(input: EnqueueScheduledJobInput) {
		return this.prisma.$transaction(transaction =>
			this.enqueueUniqueInTransaction(transaction, input)
		);
	}

	async enqueueUniqueInTransaction(
		transaction: Prisma.TransactionClient,
		input: EnqueueScheduledJobInput
	): Promise<{ created: boolean; job: ScheduledJobView }> {
		this.validateInput(input);
		await transaction.$executeRaw(
			Prisma.sql`
				SELECT pg_advisory_xact_lock(
					hashtextextended(
						CAST(${`operations-job:${input.jobType}:${input.scheduleKey}`} AS text),
						0::bigint
					)
				)
			`
		);
		const existing = await transaction.scheduledJobRun.findUnique({
			where: {
				jobType_scheduleKey: {
					jobType: input.jobType,
					scheduleKey: input.scheduleKey
				}
			}
		});
		if (existing) {
			return { created: false, job: serializeScheduledJob(existing) };
		}
		const job = await transaction.scheduledJobRun.create({
			data: {
				jobType: input.jobType,
				scheduleKey: input.scheduleKey,
				trigger: input.trigger ?? ScheduledJobRunTrigger.SCHEDULED,
				scheduledFor: input.scheduledFor,
				periodStart: input.periodStart ?? null,
				periodEnd: input.periodEnd ?? null,
				input: input.input ?? {},
				maxAttempts: input.maxAttempts ?? 4,
				availableAt: input.availableAt ?? new Date()
			}
		});
		const eventId = randomUUID();
		await this.outbox.enqueue(transaction, {
			eventId,
			deduplicationKey: `scheduled-job:${job.id}:requested`,
			eventType: OPERATIONS_SCHEDULED_JOB_EVENT_TYPE,
			aggregateType: 'scheduled-job',
			aggregateId: job.id,
			routingKey: OPERATIONS_SCHEDULED_JOB_ROUTING_KEY,
			payload: {
				schemaVersion: 1,
				eventId,
				jobId: job.id,
				jobType: job.jobType
			}
		});
		return { created: true, job: serializeScheduledJob(job) };
	}

	async enqueueManual(
		adminId: string,
		idempotencyKey: string,
		input: EnqueueScheduledJobInput
	): Promise<{ created: boolean; job: ScheduledJobView }> {
		this.assertUuid(idempotencyKey, 'Idempotency-Key');
		if (!adminId.trim() || adminId.length > 255) {
			throw new BadRequestException(
				'Некорректный идентификатор администратора'
			);
		}
		return this.prisma.$transaction(async transaction => {
			await transaction.$executeRaw(
				Prisma.sql`
					SELECT pg_advisory_xact_lock(
						hashtextextended(
							CAST(${`operations-manual-job:${adminId}:${input.jobType}`} AS text),
							0::bigint
						)
					)
				`
			);
			const existing =
				await transaction.scheduledJobIdempotencyKey.findUnique({
					where: {
						adminId_jobType_idempotencyKey: {
							adminId,
							jobType: input.jobType,
							idempotencyKey
						}
					},
					include: { job: true }
				});
			if (existing) {
				return {
					created: false,
					job: serializeScheduledJob(existing.job)
				};
			}
			const active = await transaction.scheduledJobRun.findFirst({
				where: {
					jobType: input.jobType,
					trigger: ScheduledJobRunTrigger.MANUAL,
					status: {
						in: [
							ScheduledJobRunStatus.QUEUED,
							ScheduledJobRunStatus.PROCESSING
						]
					},
					idempotencyKeys: { some: { adminId } }
				},
				orderBy: { createdAt: 'desc' }
			});
			if (active) {
				await transaction.scheduledJobIdempotencyKey.create({
					data: {
						adminId,
						jobType: input.jobType,
						idempotencyKey,
						jobId: active.id
					}
				});
				return { created: false, job: serializeScheduledJob(active) };
			}
			const result = await this.enqueueUniqueInTransaction(transaction, {
				...input,
				trigger: ScheduledJobRunTrigger.MANUAL
			});
			await transaction.scheduledJobIdempotencyKey.create({
				data: {
					adminId,
					jobType: input.jobType,
					idempotencyKey,
					jobId: result.job.id
				}
			});
			return result;
		});
	}

	async get(id: string): Promise<ScheduledJobView | null> {
		this.assertUuid(id, 'job id');
		const job = await this.prisma.scheduledJobRun.findUnique({
			where: { id }
		});
		return job ? serializeScheduledJob(job) : null;
	}

	async getLatestActiveManual(jobType: string, adminId: string) {
		const job = await this.prisma.scheduledJobRun.findFirst({
			where: {
				jobType,
				trigger: ScheduledJobRunTrigger.MANUAL,
				status: {
					in: [
						ScheduledJobRunStatus.QUEUED,
						ScheduledJobRunStatus.PROCESSING
					]
				},
				idempotencyKeys: { some: { adminId } }
			},
			orderBy: { createdAt: 'desc' }
		});
		return job ? serializeScheduledJob(job) : null;
	}

	async getManualForAdmin(id: string, jobType: string, adminId: string) {
		this.assertUuid(id, 'job id');
		const job = await this.prisma.scheduledJobRun.findFirst({
			where: {
				id,
				jobType,
				trigger: ScheduledJobRunTrigger.MANUAL,
				idempotencyKeys: { some: { adminId } }
			}
		});
		return job ? serializeScheduledJob(job) : null;
	}

	async getLatest(
		jobType: string,
		filters: {
			trigger?: ScheduledJobRunTrigger;
			status?: ScheduledJobRunStatus;
		} = {}
	) {
		const job = await this.prisma.scheduledJobRun.findFirst({
			where: {
				jobType,
				...(filters.trigger ? { trigger: filters.trigger } : {}),
				...(filters.status ? { status: filters.status } : {})
			},
			orderBy: { createdAt: 'desc' }
		});
		return job ? serializeScheduledJob(job) : null;
	}

	async list(input: {
		jobTypes?: string[];
		trigger?: ScheduledJobRunTrigger;
		status?: ScheduledJobRunStatus;
		page: number;
		limit: number;
	}) {
		const page = this.positiveInteger(input.page, 1, 'page');
		const limit = Math.min(
			this.positiveInteger(input.limit, 20, 'limit'),
			100
		);
		const where: Prisma.ScheduledJobRunWhereInput = {
			...(input.jobTypes?.length
				? { jobType: { in: input.jobTypes } }
				: {}),
			...(input.trigger ? { trigger: input.trigger } : {}),
			...(input.status ? { status: input.status } : {})
		};
		const [items, total] = await this.prisma.$transaction([
			this.prisma.scheduledJobRun.findMany({
				where,
				orderBy: { createdAt: 'desc' },
				skip: (page - 1) * limit,
				take: limit
			}),
			this.prisma.scheduledJobRun.count({ where })
		]);
		return {
			items: items.map(serializeScheduledJob),
			page,
			limit,
			total,
			totalPages: Math.max(1, Math.ceil(total / limit))
		};
	}

	async claimNext(workerId: string, leaseMs: number) {
		if (!workerId.trim() || workerId.length > 255) {
			throw new Error('Worker id is invalid');
		}
		if (
			!Number.isInteger(leaseMs) ||
			leaseMs < 1_000 ||
			leaseMs > 3_600_000
		) {
			throw new Error('Lease duration is invalid');
		}
		const candidate = await this.prisma.scheduledJobRun.findFirst({
			where: {
				availableAt: { lte: new Date() },
				OR: [
					{ status: ScheduledJobRunStatus.QUEUED },
					{
						status: ScheduledJobRunStatus.PROCESSING,
						leaseExpiresAt: { lt: new Date() }
					}
				]
			},
			orderBy: { createdAt: 'asc' }
		});
		if (!candidate || candidate.attempts >= candidate.maxAttempts)
			return null;
		const leaseToken = randomUUID();
		const claimed = await this.prisma.scheduledJobRun.updateMany({
			where: {
				id: candidate.id,
				attempts: candidate.attempts,
				status: candidate.status,
				leaseToken: candidate.leaseToken
			},
			data: {
				status: ScheduledJobRunStatus.PROCESSING,
				attempts: { increment: 1 },
				leaseOwner: workerId,
				leaseToken,
				leaseExpiresAt: new Date(Date.now() + leaseMs),
				startedAt: candidate.startedAt ?? new Date(),
				lastError: null
			}
		});
		if (claimed.count !== 1) return null;
		const job = await this.prisma.scheduledJobRun.findUniqueOrThrow({
			where: { id: candidate.id }
		});
		return { job: serializeScheduledJob(job), leaseToken };
	}

	async claim(id: string, workerId: string, leaseMs: number) {
		this.assertUuid(id, 'job id');
		if (!workerId.trim() || workerId.length > 255) {
			throw new Error('Worker id is invalid');
		}
		if (
			!Number.isInteger(leaseMs) ||
			leaseMs < 1_000 ||
			leaseMs > 3_600_000
		) {
			throw new Error('Lease duration is invalid');
		}
		const job = await this.prisma.scheduledJobRun.findUnique({
			where: { id }
		});
		if (
			!job ||
			job.attempts >= job.maxAttempts ||
			job.availableAt.getTime() > Date.now() ||
			(job.status !== ScheduledJobRunStatus.QUEUED &&
				!(
					job.status === ScheduledJobRunStatus.PROCESSING &&
					job.leaseExpiresAt &&
					job.leaseExpiresAt.getTime() < Date.now()
				))
		) {
			return null;
		}
		const leaseToken = randomUUID();
		const claimed = await this.prisma.scheduledJobRun.updateMany({
			where: {
				id,
				attempts: job.attempts,
				status: job.status,
				leaseToken: job.leaseToken
			},
			data: {
				status: ScheduledJobRunStatus.PROCESSING,
				attempts: { increment: 1 },
				leaseOwner: workerId,
				leaseToken,
				leaseExpiresAt: new Date(Date.now() + leaseMs),
				startedAt: job.startedAt ?? new Date(),
				lastError: null
			}
		});
		if (claimed.count !== 1) return null;
		const claimedJob = await this.prisma.scheduledJobRun.findUniqueOrThrow(
			{
				where: { id }
			}
		);
		return { job: serializeScheduledJob(claimedJob), leaseToken };
	}

	async complete(
		id: string,
		leaseToken: string,
		result: Prisma.InputJsonValue
	): Promise<boolean> {
		this.assertUuid(id, 'job id');
		this.assertUuid(leaseToken, 'lease token');
		const updated = await this.prisma.scheduledJobRun.updateMany({
			where: {
				id,
				status: ScheduledJobRunStatus.PROCESSING,
				leaseToken,
				leaseExpiresAt: { gt: new Date() }
			},
			data: {
				status: ScheduledJobRunStatus.SUCCEEDED,
				result,
				finishedAt: new Date(),
				leaseOwner: null,
				leaseToken: null,
				leaseExpiresAt: null,
				lastError: null
			}
		});
		return updated.count === 1;
	}

	async renewLease(
		id: string,
		leaseToken: string,
		leaseMs: number
	): Promise<boolean> {
		this.assertUuid(id, 'job id');
		this.assertUuid(leaseToken, 'lease token');
		const updated = await this.prisma.scheduledJobRun.updateMany({
			where: {
				id,
				status: ScheduledJobRunStatus.PROCESSING,
				leaseToken,
				leaseExpiresAt: { gt: new Date() }
			},
			data: { leaseExpiresAt: new Date(Date.now() + leaseMs) }
		});
		return updated.count === 1;
	}

	async fail(
		id: string,
		leaseToken: string,
		error: unknown,
		retryDelayMs = 30_000
	): Promise<boolean> {
		this.assertUuid(id, 'job id');
		this.assertUuid(leaseToken, 'lease token');
		return this.prisma.$transaction(async transaction => {
			const job = await transaction.scheduledJobRun.findUnique({
				where: { id }
			});
			if (!job || job.leaseToken !== leaseToken) return false;
			const retry = job.attempts < job.maxAttempts;
			const availableAt = retry
				? new Date(Date.now() + Math.max(1_000, retryDelayMs))
				: job.availableAt;
			const updated = await transaction.scheduledJobRun.updateMany({
				where: {
					id,
					status: ScheduledJobRunStatus.PROCESSING,
					leaseToken
				},
				data: {
					status: retry
						? ScheduledJobRunStatus.QUEUED
						: ScheduledJobRunStatus.FAILED,
					availableAt,
					finishedAt: retry ? null : new Date(),
					leaseOwner: null,
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: this.safeError(error)
				}
			});
			if (updated.count !== 1) return false;
			if (retry) {
				const eventId = randomUUID();
				await this.outbox.enqueue(transaction, {
					eventId,
					deduplicationKey: `scheduled-job:${id}:attempt:${job.attempts + 1}`,
					eventType: OPERATIONS_SCHEDULED_JOB_EVENT_TYPE,
					aggregateType: 'scheduled-job',
					aggregateId: id,
					routingKey: OPERATIONS_SCHEDULED_JOB_ROUTING_KEY,
					payload: {
						schemaVersion: 1,
						eventId,
						jobId: id,
						jobType: job.jobType
					}
				});
				await transaction.outboxEvent.updateMany({
					where: { eventId },
					data: { availableAt }
				});
			}
			return true;
		});
	}

	private validateInput(input: EnqueueScheduledJobInput): void {
		for (const [name, value] of [
			['job type', input.jobType],
			['schedule key', input.scheduleKey]
		] as const) {
			if (!value.trim() || value.length > 255) {
				throw new BadRequestException(`Invalid ${name}`);
			}
		}
		if (
			input.maxAttempts !== undefined &&
			(!Number.isInteger(input.maxAttempts) ||
				input.maxAttempts < 1 ||
				input.maxAttempts > 100)
		) {
			throw new BadRequestException('Invalid max attempts');
		}
	}

	private assertUuid(value: string, label: string): void {
		if (!UUID_PATTERN.test(value)) {
			throw new BadRequestException(`Invalid ${label}`);
		}
	}

	private positiveInteger(value: number, fallback: number, label: string) {
		if (value === undefined || value === null) return fallback;
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new BadRequestException(`${label} must be a positive integer`);
		}
		return value;
	}

	private safeError(error: unknown): string {
		const value = error instanceof Error ? error.message : String(error);
		return value.replace(/[\r\n]+/g, ' ').slice(0, 2_000);
	}
}
