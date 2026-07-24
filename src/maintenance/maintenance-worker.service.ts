import {
	DatabaseBackupInput,
	DatabaseBackupResult,
	DatabaseBackupService
} from '@/maintenance/database-backup.service';
import { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import { DatabaseBackupRequestedEventPayload } from '@/messaging/database-backup-event';
import {
	DATABASE_BACKUP_EVENT_TYPE,
	MAINTENANCE_KINDS,
	MESSAGING_ROUTING_KEYS,
	MaintenanceKind,
	RETRY_DELAYS_MS
} from '@/messaging/messaging.constants';
import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { PrismaService } from '@/prisma.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import {
	SCHEDULED_JOB_TYPES,
	ScheduledJobRunView
} from '@/scheduled-jobs/scheduled-jobs.types';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ScheduledJobRunStatus } from '@prisma/client';
import type { ConsumeMessage } from 'amqplib';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ScheduledJobStatusRow {
	status: ScheduledJobRunStatus;
}

@Injectable()
export class MaintenanceWorkerService implements OnModuleInit {
	private readonly logger = new Logger(MaintenanceWorkerService.name);
	private readonly workerId = `maintenance:${hostname()}:${process.pid}:${randomUUID()}`;

	constructor(
		private readonly rabbitMq: RabbitMqService,
		private readonly configService: ConfigService,
		private readonly prisma: PrismaService,
		private readonly scheduledJobs: ScheduledJobsService,
		private readonly scheduledTasks: ScheduledTasksService,
		private readonly backup: DatabaseBackupService
	) {}

	async onModuleInit(): Promise<void> {
		const prefetch = this.getPrefetch();
		for (const kind of this.getEnabledKinds()) {
			await this.rabbitMq.consume(
				kind,
				message => this.handle(kind, message),
				prefetch
			);
			await this.rabbitMq.consumeDeadLetter(
				kind,
				message => this.collectDeadLetter(kind, message),
				prefetch
			);
		}
		this.logger.log(
			`Maintenance consumers started kinds=${this.getEnabledKinds().join(',')} prefetch=${prefetch}`
		);
	}

	private async handle(
		kind: MaintenanceKind,
		message: ConsumeMessage
	): Promise<void> {
		let payload: DatabaseBackupRequestedEventPayload;
		try {
			payload = this.parsePayload(message);
		} catch (error) {
			await this.deadLetterMalformed(
				kind,
				message,
				error instanceof Error ? error.message : String(error)
			);
			return;
		}
		const eventId = message.properties.messageId || payload.jobId;
		let claimedJob: ScheduledJobRunView | null = null;
		let claimedLeaseToken: string | null = null;

		try {
			const claim = await this.scheduledJobs.claim(
				payload.jobId,
				this.workerId,
				this.getLeaseMs(),
				SCHEDULED_JOB_TYPES.DATABASE_BACKUP
			);
			if (claim.state === 'not_found') {
				await this.publishDeadLetter(
					kind,
					payload,
					eventId,
					this.getRetryAttempt(message),
					`Database backup job not found: ${payload.jobId}`
				);
				this.rabbitMq.ack(message);
				return;
			}
			if (claim.job.jobType !== SCHEDULED_JOB_TYPES.DATABASE_BACKUP) {
				await this.publishDeadLetter(
					kind,
					payload,
					eventId,
					this.getRetryAttempt(message),
					`Unexpected database backup job type: ${claim.job.jobType}`
				);
				this.rabbitMq.ack(message);
				return;
			}
			if (claim.state === 'terminal') {
				if (claim.job.status === ScheduledJobRunStatus.FAILED) {
					await this.publishDeadLetter(
						kind,
						payload,
						eventId,
						claim.job.attempts,
						claim.job.lastError || 'Database backup job failed'
					);
				} else if (claim.job.status === ScheduledJobRunStatus.SUCCEEDED) {
					await this.resolveFailure(eventId, kind);
				}
				this.rabbitMq.ack(message);
				return;
			}
			if (claim.state !== 'claimed') {
				this.logger.warn(
					`Skipped duplicate database backup event jobId=${payload.jobId} state=${claim.state}`
				);
				this.rabbitMq.ack(message);
				return;
			}
			claimedJob = claim.job;
			claimedLeaseToken = claim.leaseToken;

			const input = this.parseJobInput(claim.job.input);
			const lease = this.startLeaseRenewal(claim.job.id, claim.leaseToken);
			let result: DatabaseBackupResult | null = null;
			try {
				result = await this.backup.createAndSend(
					claim.job.id,
					input,
					lease.signal
				);

				if (lease.signal.aborted) {
					throw this.getAbortError(lease.signal);
				}
				const completedAt = new Date();
				const completed = await this.prisma.$transaction(
					async transaction => {
						const job = await this.scheduledJobs.completeInTransaction(
							transaction,
							claim.job.id,
							claim.leaseToken,
							result as unknown as Prisma.InputJsonObject
						);
						if (!job) return null;
						if (job.trigger === 'SCHEDULED' && job.periodStart) {
							await transaction.telegramBotSettings.update({
								where: { id: 'singleton' },
								data: {
									databaseBackupLastSentPeriodStart: new Date(
										job.periodStart
									),
									databaseBackupLastSentAt: completedAt
								}
							});
						}
						return job;
					}
				);
				if (!completed) {
					throw new Error(
						'Database backup lease was lost after Telegram delivery'
					);
				}
			} finally {
				await lease.stop();
			}
			await this.resolveFailure(eventId, kind);
			this.rabbitMq.ack(message);
			this.logger.log(
				`Database backup completed jobId=${payload.jobId} file=${result?.fileName}`
			);
		} catch (error) {
			await this.handleFailure(
				kind,
				payload,
				eventId,
				message,
				claimedJob,
				claimedLeaseToken,
				error
			);
		}
	}

	private async resolveFailure(
		eventId: string,
		kind: MaintenanceKind
	): Promise<void> {
		await this.prisma.integrationDeliveryFailure
			.updateMany({
				where: {
					eventId,
					integration: kind,
					resolvedAt: null
				},
				data: {
					resolvedAt: new Date(),
					retryingAt: null
				}
			})
			.catch(error => {
				this.logger.warn(
					`Database backup succeeded but failure resolution could not be persisted eventId=${eventId}: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			});
	}

	private async handleFailure(
		kind: MaintenanceKind,
		payload: DatabaseBackupRequestedEventPayload,
		eventId: string,
		message: ConsumeMessage,
		job: ScheduledJobRunView | null,
		leaseToken: string | null,
		error: unknown
	): Promise<void> {
		if (!job || !leaseToken) {
			const nextAttempt = this.getRetryAttempt(message) + 1;
			try {
				await this.rabbitMq.publishRetry(
					kind,
					payload,
					nextAttempt,
					eventId,
					DATABASE_BACKUP_EVENT_TYPE
				);
				this.rabbitMq.ack(message);
				this.logger.warn(
					`Database backup dispatch retry scheduled before claim jobId=${payload.jobId} attempt=${nextAttempt}: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			} catch (publishError) {
				this.logger.error(
					`Database backup dispatch retry failed jobId=${payload.jobId}: ${
						publishError instanceof Error
							? publishError.message
							: String(publishError)
					}`
				);
				this.rabbitMq.nack(message, true);
			}
			return;
		}

		try {
			const retryDelay =
				RETRY_DELAYS_MS[
					Math.min(
						Math.max(job.attempts - 1, 0),
						RETRY_DELAYS_MS.length - 1
					)
				];
			const result = await this.scheduledJobs.releaseOrFail(
				job.id,
				leaseToken,
				error,
				retryDelay,
				this.scheduledTasks.getEventForType(job.jobType)
			);
			if (result.state === 'lost') {
				this.logger.warn(
					`Ignored stale database backup delivery after lease loss jobId=${job.id}`
				);
				this.rabbitMq.ack(message);
				return;
			}
			if (result.state === 'failed') {
				await this.publishDeadLetter(
					kind,
					payload,
					eventId,
					result.job.attempts,
					result.job.lastError || 'Database backup failed'
				);
				this.logger.error(
					`Database backup moved to dead-letter jobId=${job.id}: ${result.job.lastError}`
				);
			} else {
				this.logger.warn(
					`Database backup retry persisted jobId=${job.id} attempt=${result.job.attempts}: ${result.job.lastError}`
				);
			}
			this.rabbitMq.ack(message);
		} catch (publishError) {
			this.logger.error(
				`Database backup failure handling failed jobId=${payload.jobId}: ${
					publishError instanceof Error
						? publishError.stack
						: String(publishError)
				}`
			);
			this.rabbitMq.nack(message, true);
		}
	}

	private async collectDeadLetter(
		kind: MaintenanceKind,
		message: ConsumeMessage
	): Promise<void> {
		const raw = message.content.toString('utf8');
		let payload: Prisma.InputJsonValue = { raw: raw.slice(0, 10_000) };
		try {
			const parsed = JSON.parse(raw) as unknown;
			payload =
				parsed === null
					? { raw: raw.slice(0, 10_000) }
					: (parsed as Prisma.InputJsonValue);
		} catch {}
		const payloadJobId = this.getPayloadJobId(payload);
		const eventId = this.getSafeEventId(
			message.properties.messageId,
			payloadJobId
		);
		const header = message.properties.headers?.['x-last-error'];
		const lastError =
			typeof header === 'string'
				? header
				: Buffer.isBuffer(header)
					? header.toString('utf8')
					: 'Database backup failed';
		try {
			await this.prisma.$transaction(async transaction => {
				await transaction.$queryRaw(
					Prisma.sql`
						SELECT "id"
						FROM "integration_delivery_failures"
						WHERE "event_id" = ${eventId}::uuid
							AND "integration" = ${kind}
						FOR UPDATE
					`
				);
				const jobs = payloadJobId
					? await transaction.$queryRaw<ScheduledJobStatusRow[]>(
							Prisma.sql`
								SELECT "status"
								FROM "scheduled_job_runs"
								WHERE "id" = ${payloadJobId}::uuid
								FOR SHARE
							`
						)
					: [];
				const job = jobs[0];
				if (
					job &&
					eventId === payloadJobId &&
					job.status !== ScheduledJobRunStatus.FAILED
				) {
					return;
				}
				await transaction.integrationDeliveryFailure.upsert({
					where: {
						eventId_integration: {
							eventId,
							integration: kind
						}
					},
					create: {
						eventId,
						integration: kind,
						routingKey: MESSAGING_ROUTING_KEYS[kind],
						payload,
						attempts: this.getRetryAttempt(message),
						lastError: lastError.slice(0, 10_000)
					},
					update: {
						payload,
						attempts: this.getRetryAttempt(message),
						lastError: lastError.slice(0, 10_000),
						failedAt: new Date(),
						retryingAt: null,
						resolvedAt: null
					}
				});
			});
			this.rabbitMq.ack(message);
		} catch (error) {
			this.logger.error(
				`Failed to persist maintenance dead-letter eventId=${eventId}: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
			this.rabbitMq.nack(message, true);
		}
	}

	private async deadLetterMalformed(
		kind: MaintenanceKind,
		message: ConsumeMessage,
		error: string
	): Promise<void> {
		const eventId = this.getSafeEventId(message.properties.messageId);
		let payload: unknown = {
			raw: message.content.toString('utf8').slice(0, 10_000)
		};
		try {
			payload = JSON.parse(message.content.toString('utf8'));
		} catch {}
		try {
			await this.publishDeadLetter(
				kind,
				payload,
				eventId,
				this.getRetryAttempt(message),
				error
			);
			this.rabbitMq.ack(message);
		} catch {
			this.rabbitMq.nack(message, true);
		}
	}

	private publishDeadLetter(
		kind: MaintenanceKind,
		payload: unknown,
		eventId: string,
		attempt: number,
		error: string
	): Promise<void> {
		return this.rabbitMq.publishDeadLetter(
			kind,
			payload,
			attempt,
			eventId,
			error,
			DATABASE_BACKUP_EVENT_TYPE
		);
	}

	private parsePayload(
		message: ConsumeMessage
	): DatabaseBackupRequestedEventPayload {
		const value = JSON.parse(
			message.content.toString('utf8')
		) as DatabaseBackupRequestedEventPayload;
		if (
			value?.schemaVersion !== 1 ||
			value.eventType !== DATABASE_BACKUP_EVENT_TYPE ||
			!UUID_PATTERN.test(value.jobId || '') ||
			message.properties.messageId !== value.jobId
		) {
			throw new Error('Invalid database backup event payload');
		}
		return value;
	}

	private parseJobInput(value: Prisma.JsonValue): DatabaseBackupInput {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Database backup job input is invalid');
		}
		const chatId = value.chatId;
		const messageThreadId = value.messageThreadId;
		const trigger = value.trigger;
		const periodStart = value.periodStart;
		if (
			typeof chatId !== 'string' ||
			!chatId.trim() ||
			typeof messageThreadId !== 'number' ||
			!Number.isInteger(messageThreadId) ||
			messageThreadId < 1 ||
			(trigger !== 'MANUAL' && trigger !== 'SCHEDULED') ||
			(periodStart !== null &&
				periodStart !== undefined &&
				typeof periodStart !== 'string')
		) {
			throw new Error('Database backup job input is invalid');
		}
		return {
			chatId: chatId.trim(),
			messageThreadId,
			trigger,
			periodStart: typeof periodStart === 'string' ? periodStart : null
		};
	}

	private startLeaseRenewal(
		jobId: string,
		leaseToken: string
	): {
		signal: AbortSignal;
		stop: () => Promise<void>;
	} {
		const controller = new AbortController();
		let stopped = false;
		let renewal: Promise<void> | null = null;
		const timer = setInterval(() => {
			if (renewal || stopped || controller.signal.aborted) return;
			renewal = (async () => {
				try {
					const renewed = await this.scheduledJobs.renewLease(
						jobId,
						leaseToken,
						this.getLeaseMs()
					);
					if (!renewed) {
						controller.abort(
							new Error('Database backup lease renewal failed')
						);
					}
				} catch (error) {
					controller.abort(
						error instanceof Error ? error : new Error(String(error))
					);
				} finally {
					renewal = null;
				}
			})();
		}, this.getLeaseRenewInterval());
		timer.unref();
		return {
			signal: controller.signal,
			stop: async () => {
				stopped = true;
				clearInterval(timer);
				if (renewal) await renewal;
			}
		};
	}

	private getEnabledKinds(): MaintenanceKind[] {
		const configured = this.configService
			.get<string>('MAINTENANCE_WORKER_KINDS')
			?.split(',')
			.map(value => value.trim())
			.filter(Boolean);
		if (!configured?.length) return [...MAINTENANCE_KINDS];
		const invalid = configured.filter(
			value => !MAINTENANCE_KINDS.includes(value as MaintenanceKind)
		);
		if (invalid.length) {
			throw new Error(
				`Invalid MAINTENANCE_WORKER_KINDS values: ${invalid.join(', ')}`
			);
		}
		return [...new Set(configured as MaintenanceKind[])];
	}

	private getPrefetch(): number {
		const value = Number(
			this.configService.get<string>('MAINTENANCE_WORKER_PREFETCH') || 1
		);
		if (Number.isInteger(value) && value !== 1) {
			this.logger.warn(
				'MAINTENANCE_WORKER_PREFETCH is forced to 1 for database backup'
			);
		}
		return 1;
	}

	private getLeaseMs(): number {
		const value = Number(
			this.configService.get<string>('SCHEDULED_JOB_LEASE_MS') || 120_000
		);
		return Number.isInteger(value) && value >= 30_000
			? Math.min(value, 60 * 60 * 1000)
			: 120_000;
	}

	private getLeaseRenewInterval(): number {
		const value = Number(
			this.configService.get<string>(
				'SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS'
			) || 30_000
		);
		const max = Math.max(5_000, Math.floor(this.getLeaseMs() / 2));
		return Number.isInteger(value) && value >= 5_000
			? Math.min(value, max)
			: Math.min(30_000, max);
	}

	private getRetryAttempt(message: ConsumeMessage): number {
		const value = Number(message.properties.headers?.['x-retry-attempt']);
		return Number.isInteger(value) && value >= 0 ? value : 0;
	}

	private getSafeEventId(
		messageId: string | undefined,
		fallback?: string | null
	): string {
		if (messageId && UUID_PATTERN.test(messageId)) return messageId;
		if (fallback && UUID_PATTERN.test(fallback)) return fallback;
		return randomUUID();
	}

	private getPayloadJobId(payload: Prisma.InputJsonValue): string | null {
		if (
			payload &&
			typeof payload === 'object' &&
			!Array.isArray(payload)
		) {
			const jobId = (payload as Record<string, unknown>).jobId;
			if (typeof jobId === 'string' && UUID_PATTERN.test(jobId)) {
				return jobId;
			}
		}
		return null;
	}

	private getAbortError(signal: AbortSignal): Error {
		return signal.reason instanceof Error
			? signal.reason
			: new Error('Database backup lease was lost');
	}
}
