import { DatabaseBackupService } from '@/maintenance/database-backup.service';
import {
	DatabaseBackupInput,
	DatabaseBackupResult,
	DatabaseBackupTarget
} from '@/maintenance/database-backup.types';
import { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import { DatabaseBackupRequestedEventPayload } from '@/messaging/database-backup-event';
import {
	DATABASE_BACKUP_EVENT_TYPE,
	MAINTENANCE_KINDS,
	MESSAGING_ROUTING_KEYS,
	MaintenanceKind,
	RETRY_DELAYS_MS
} from '@/messaging/messaging.constants';
import { getCurrentCorrelationId } from '@/messaging/messaging-context';
import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { getStableMessageId } from '@/messaging/poison-message-id';
import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { PrismaService } from '@/prisma.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import {
	DatabaseBackupJobType,
	SCHEDULED_JOB_TYPES,
	ScheduledJobRunView
} from '@/scheduled-jobs/scheduled-jobs.types';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ScheduledJobRunStatus } from '@prisma/client';
import type { ConsumeMessage } from 'amqplib';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;

interface ScheduledJobStatusRow {
	status: ScheduledJobRunStatus;
	attempts: number;
}

interface DeliveryFailureStatusRow {
	resolvedAt: Date | null;
}

interface BackupLease {
	signal: AbortSignal;
	stop: () => Promise<void>;
	interruptForShutdown: (reason: Error) => void;
	wasInterruptedByShutdown: (error: unknown) => boolean;
}

class MaintenanceWorkerShutdownError extends Error {
	constructor(signal?: string) {
		super(
			`Maintenance worker is shutting down${
				signal ? ` after ${signal}` : ''
			}`
		);
		this.name = MaintenanceWorkerShutdownError.name;
	}
}

@Injectable()
export class MaintenanceWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(MaintenanceWorkerService.name);
	private readonly workerId = `maintenance:${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly activeHandlers = new Set<Promise<void>>();
	private readonly activeLeases = new Map<string, BackupLease>();
	private initialized = false;
	private shuttingDown = false;
	private shutdownReason: MaintenanceWorkerShutdownError | null = null;
	private shutdownPromise: Promise<void> | null = null;

	constructor(
		private readonly rabbitMq: RabbitMqService,
		private readonly configService: ConfigService,
		private readonly prisma: PrismaService,
		private readonly scheduledJobs: ScheduledJobsService,
		private readonly scheduledTasks: ScheduledTasksService,
		private readonly backup: DatabaseBackupService,
		private readonly heartbeat: MessagingHeartbeatService
	) {}

	async onModuleInit(): Promise<void> {
		this.initialized = false;
		const prefetch = this.getPrefetch();
		for (const kind of this.getEnabledKinds()) {
			await this.rabbitMq.consume(
				kind,
				message =>
					this.trackHandler(
						() => this.handle(kind, message),
						kind,
						message
					),
				prefetch
			);
			await this.rabbitMq.consumeDeadLetter(
				kind,
				message =>
					this.trackHandler(
						() => this.collectDeadLetter(kind, message),
						kind,
						message
					),
				prefetch
			);
		}
		this.initialized = true;
		this.logger.log(
			`Maintenance consumers started kinds=${this.getEnabledKinds().join(',')} prefetch=${prefetch}`
		);
	}

	isReady(): boolean {
		return this.initialized && !this.shuttingDown;
	}

	beforeApplicationShutdown(signal?: string): Promise<void> {
		this.initialized = false;
		this.shuttingDown = true;
		if (!this.shutdownPromise) {
			this.shutdownPromise = this.shutdown(signal);
		}
		return this.shutdownPromise;
	}

	private async shutdown(signal?: string): Promise<void> {
		this.initialized = false;
		this.shuttingDown = true;
		this.shutdownReason = new MaintenanceWorkerShutdownError(signal);
		let consumersCancelled = true;
		const cancelConsumers = this.rabbitMq
			.cancelConsumers()
			.catch(error => {
				consumersCancelled = false;
				this.logger.error(
					`Failed to cancel maintenance consumers during shutdown: ${
						error instanceof Error ? error.stack : String(error)
					}`
				);
			});
		for (const lease of this.activeLeases.values()) {
			lease.interruptForShutdown(this.shutdownReason);
		}

		const drained = await this.waitWithin(
			(async () => {
				await cancelConsumers;
				while (this.activeHandlers.size) {
					await Promise.allSettled([...this.activeHandlers]);
				}
			})(),
			SHUTDOWN_DRAIN_TIMEOUT_MS
		);
		if (!drained) {
			this.logger.warn(
				`Maintenance shutdown drain timed out after ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms activeHandlers=${this.activeHandlers.size}`
			);
			return;
		}
		if (consumersCancelled) {
			this.logger.log('Maintenance consumers stopped cleanly');
		} else {
			this.logger.warn(
				'Maintenance handlers drained; RabbitMQ channel close will finish consumer shutdown'
			);
		}
	}

	private trackHandler(
		handler: () => Promise<void>,
		kind?: MaintenanceKind,
		message?: ConsumeMessage
	): Promise<void> {
		const promise = handler().then(() => {
			if (!kind || !message) return;
			this.heartbeat.markSuccessfulConsume(kind);
			this.logger.log(
				JSON.stringify({
					event: 'maintenance_worker.consume_completed',
					kind,
					messageId: message.properties.messageId || null,
					correlationId: getCurrentCorrelationId()
				})
			);
		});
		this.activeHandlers.add(promise);
		void promise.then(
			() => this.activeHandlers.delete(promise),
			() => this.activeHandlers.delete(promise)
		);
		return promise;
	}

	private async handle(
		kind: MaintenanceKind,
		message: ConsumeMessage
	): Promise<void> {
		if (this.shuttingDown) {
			this.rabbitMq.nack(message, true);
			return;
		}

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
		let lease: BackupLease | null = null;

		try {
			const claim = await this.scheduledJobs.claim(
				payload.jobId,
				this.workerId,
				this.getLeaseMs(),
				payload.jobType,
				this.scheduledTasks.getEventForType(payload.jobType)
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
			if (claim.job.jobType !== payload.jobType) {
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
				if (claim.job.status === ScheduledJobRunStatus.SUCCEEDED) {
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
			lease = this.startLeaseRenewal(claim.job.id, claim.leaseToken);
			this.activeLeases.set(claim.job.id, lease);
			let result: DatabaseBackupResult | null = null;
			try {
				result = await this.backup.createAndSend(
					claim.job.id,
					this.getBackupTarget(payload.jobType),
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
						if (
							job.jobType === SCHEDULED_JOB_TYPES.DATABASE_BACKUP &&
							job.trigger === 'SCHEDULED' &&
							job.periodStart
						) {
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
						'Database backup lease was lost after artifact delivery'
					);
				}
			} finally {
				await lease.stop();
			}
			await this.resolveFailure(eventId, kind);
			this.rabbitMq.ack(message);
			this.logger.log(
				`Database backup completed jobId=${payload.jobId} target=${this.getBackupTarget(
					payload.jobType
				)} file=${result?.fileName}`
			);
		} catch (error) {
			await this.handleFailure(
				kind,
				payload,
				eventId,
				message,
				claimedJob,
				claimedLeaseToken,
				lease?.wasInterruptedByShutdown(error) ?? false,
				error
			);
		} finally {
			if (
				claimedJob &&
				lease &&
				this.activeLeases.get(claimedJob.id) === lease
			) {
				this.activeLeases.delete(claimedJob.id);
			}
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
					retryingAt: null,
					resolution: 'DELIVERED',
					resolutionComment: null,
					resolvedById: null,
					activeRetryToken: null
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
		interruptedByShutdown: boolean,
		error: unknown
	): Promise<void> {
		if (!job || !leaseToken) {
			if (this.shuttingDown) {
				this.rabbitMq.nack(message, true);
				return;
			}
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

		if (interruptedByShutdown) {
			await this.requeueInterruptedJob(message, job, leaseToken);
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
				this.logger.error(
					`Database backup terminal DLQ intent persisted jobId=${job.id}: ${result.job.lastError}`
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

	private async requeueInterruptedJob(
		message: ConsumeMessage,
		job: ScheduledJobRunView,
		leaseToken: string
	): Promise<void> {
		try {
			const result = await this.scheduledJobs.requeueInterrupted(
				job.id,
				leaseToken,
				this.scheduledTasks.getEventForType(job.jobType)
			);
			if (result.state === 'lost') {
				this.logger.warn(
					`Skipped shutdown requeue after lease ownership changed jobId=${job.id}`
				);
			} else {
				this.logger.log(
					`Database backup requeued during maintenance shutdown jobId=${job.id}`
				);
			}
			this.rabbitMq.ack(message);
		} catch (error) {
			this.logger.error(
				`Failed to requeue database backup during shutdown jobId=${job.id}: ${
					error instanceof Error ? error.stack : String(error)
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
		const eventId = getStableMessageId(message, kind, payloadJobId);
		const header = message.properties.headers?.['x-last-error'];
		const lastError =
			typeof header === 'string'
				? header
				: Buffer.isBuffer(header)
					? header.toString('utf8')
					: 'Database backup failed';
		try {
			await this.prisma.$transaction(async transaction => {
				const failures = await transaction.$queryRaw<
					DeliveryFailureStatusRow[]
				>(
					Prisma.sql`
						SELECT "resolved_at" AS "resolvedAt"
						FROM "integration_delivery_failures"
						WHERE "event_id" = ${eventId}::uuid
							AND "integration" = ${kind}
						FOR UPDATE
					`
				);
				if (failures[0]?.resolvedAt) {
					return;
				}
				const jobs = payloadJobId
					? await transaction.$queryRaw<ScheduledJobStatusRow[]>(
							Prisma.sql`
								SELECT "status", "attempts"
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
					(job.status !== ScheduledJobRunStatus.FAILED ||
						job.attempts !== this.getRetryAttempt(message))
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
		const eventId = getStableMessageId(message, kind);
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
		assertMessagingEventContract(value, {
			eventType:
				typeof message.properties.type === 'string'
					? message.properties.type
					: '',
			routingKey: message.fields.routingKey,
			messageId:
				typeof message.properties.messageId === 'string'
					? message.properties.messageId
					: '',
			kind: 'database-backup'
		});
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

	private getBackupTarget(
		jobType: DatabaseBackupJobType
	): DatabaseBackupTarget {
		switch (jobType) {
			case SCHEDULED_JOB_TYPES.DATABASE_BACKUP:
				return 'core';
			case SCHEDULED_JOB_TYPES.NOTIFICATION_DELIVERY_DATABASE_BACKUP:
				return 'notification-delivery';
			case SCHEDULED_JOB_TYPES.CAMPAIGNS_DATABASE_BACKUP:
				return 'campaigns';
			case SCHEDULED_JOB_TYPES.REPORTING_DATABASE_BACKUP:
				return 'reporting';
			case SCHEDULED_JOB_TYPES.WIDGETS_DATABASE_BACKUP:
				return 'widgets';
			case SCHEDULED_JOB_TYPES.BILLING_DATABASE_BACKUP:
				return 'billing';
			case SCHEDULED_JOB_TYPES.IDENTITY_DATABASE_BACKUP:
				return 'identity';
		}
	}

	private startLeaseRenewal(
		jobId: string,
		leaseToken: string
	): BackupLease {
		const controller = new AbortController();
		let stopped = false;
		let interruptedByShutdown = false;
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
		const lease: BackupLease = {
			signal: controller.signal,
			stop: async () => {
				stopped = true;
				clearInterval(timer);
				if (renewal) await renewal;
			},
			interruptForShutdown: reason => {
				if (controller.signal.aborted) return;
				interruptedByShutdown = true;
				controller.abort(reason);
			},
			wasInterruptedByShutdown: error =>
				interruptedByShutdown &&
				(error === controller.signal.reason ||
					error instanceof MaintenanceWorkerShutdownError)
		};
		if (this.shutdownReason) {
			lease.interruptForShutdown(this.shutdownReason);
		}
		return lease;
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

	private async waitWithin(
		promise: Promise<void>,
		timeoutMs: number
	): Promise<boolean> {
		let timeout: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				promise.then(() => true),
				new Promise<boolean>(resolve => {
					timeout = setTimeout(() => resolve(false), timeoutMs);
					timeout.unref();
				})
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
}
