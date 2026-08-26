import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OperationalAlertSeverity } from '@prisma/operations-client';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { OPERATIONS_SCHEDULED_JOB_EVENT_TYPE } from '../messaging/operations-messaging.constants';
import {
	OperationsConsumeDecision,
	OperationsRabbitMqService
} from '../messaging/operations-rabbitmq.service';
import { OperationalAlertService } from '../monitoring/operational-alert.service';
import { OperationsOwnershipService } from '../ownership/operations-ownership.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import {
	DATABASE_BACKUP_TARGETS,
	DatabaseBackupTarget,
	databaseBackupJobType
} from '../scheduled-jobs/scheduled-jobs.types';
import { ScheduledJobsService } from '../scheduled-jobs/scheduled-jobs.service';
import { DatabaseBackupService } from './database-backup.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEASE_MS = 60_000;

@Injectable()
export class MaintenanceWorkerService implements OnModuleInit {
	private readonly logger = new Logger(MaintenanceWorkerService.name);
	private ready = false;
	private readonly instanceId = `operations-worker-${randomUUID()}`;

	constructor(
		private readonly runtime: OperationsRuntimeService,
		private readonly ownership: OperationsOwnershipService,
		private readonly rabbit: OperationsRabbitMqService,
		private readonly jobs: ScheduledJobsService,
		private readonly backup: DatabaseBackupService,
		private readonly prisma: OperationsPrismaService,
		private readonly alerts: OperationalAlertService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		if (!(await this.ownership.isActive())) {
			this.ready = true;
			return;
		}
		await this.rabbit.consumeScheduledJobs(message =>
			this.handleScheduledJob(message)
		);
		this.ready = true;
	}

	isReady(): boolean {
		return !this.runtime.workerEnabled || this.ready;
	}

	async handleScheduledJob(
		message: ConsumeMessage
	): Promise<OperationsConsumeDecision> {
		let event: { eventId: string; jobId: string; jobType: string };
		try {
			event = this.parseEvent(message);
		} catch {
			return 'reject';
		}
		const claim = await this.jobs.claim(
			event.jobId,
			this.instanceId,
			LEASE_MS
		);
		if (!claim) return 'ack';
		const input = this.parseBackupInput(
			claim.job.input,
			claim.job.jobType
		);
		if (!input) {
			await this.jobs.fail(
				claim.job.id,
				claim.leaseToken,
				new Error('Unsupported Operations scheduled job'),
				60_000
			);
			return 'ack';
		}
		const controller = new AbortController();
		const renew = setInterval(() => {
			void this.jobs
				.renewLease(claim.job.id, claim.leaseToken, LEASE_MS)
				.then(ok => {
					if (!ok) controller.abort(new Error('Backup lease was lost'));
				})
				.catch(() =>
					controller.abort(new Error('Backup lease renewal failed'))
				);
		}, LEASE_MS / 3);
		renew.unref();
		try {
			const result = await this.backup.createAndSend(
				claim.job.id,
				input.target,
				input,
				controller.signal
			);
			const completed = await this.jobs.complete(
				claim.job.id,
				claim.leaseToken,
				{
					...result,
					telegramReceipt: { ...result.telegramReceipt }
				}
			);
			if (!completed) return 'requeue';
			await this.alerts
				.resolve(`database-backup:${input.target}`)
				.catch(() =>
					this.logger.warn(
						`Could not resolve backup alert target=${input.target}`
					)
				);
			if (claim.job.periodStart) {
				await this.prisma.telegramBotSettings.update({
					where: { id: 'singleton' },
					data: {
						databaseBackupLastSentPeriodStart: new Date(
							claim.job.periodStart
						),
						databaseBackupLastSentAt: new Date()
					}
				});
			}
			return 'ack';
		} catch (error) {
			const failed = await this.jobs.fail(
				claim.job.id,
				claim.leaseToken,
				error,
				30_000 * 2 ** Math.min(claim.job.attempts, 6)
			);
			if (failed && claim.job.attempts >= claim.job.maxAttempts) {
				await this.alerts
					.record({
						deduplicationKey: `database-backup:${input.target}`,
						type: 'INTEGRATION_PROBLEM',
						severity: OperationalAlertSeverity.HIGH,
						source: 'operations',
						referenceId: claim.job.id,
						title: `Не выполнен backup базы ${input.target}`,
						message:
							'Исчерпан лимит автоматических попыток database backup'
					})
					.catch(() =>
						this.logger.warn(
							`Could not record backup alert target=${input.target}`
						)
					);
			}
			this.logger.warn(`Database backup failed jobId=${claim.job.id}`);
			return 'ack';
		} finally {
			clearInterval(renew);
		}
	}

	private parseEvent(message: ConsumeMessage) {
		if (
			message.properties.type !== OPERATIONS_SCHEDULED_JOB_EVENT_TYPE ||
			message.content.length > 64 * 1024
		) {
			throw new Error('Scheduled job message properties are invalid');
		}
		const value = JSON.parse(message.content.toString('utf8')) as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Scheduled job event is invalid');
		}
		const record = value as Record<string, unknown>;
		if (
			Object.keys(record).sort().join(',') !==
				'eventId,jobId,jobType,schemaVersion' ||
			record.schemaVersion !== 1 ||
			typeof record.eventId !== 'string' ||
			!UUID_PATTERN.test(record.eventId) ||
			typeof record.jobId !== 'string' ||
			!UUID_PATTERN.test(record.jobId) ||
			typeof record.jobType !== 'string' ||
			message.properties.messageId !== record.eventId
		) {
			throw new Error('Scheduled job event contract is invalid');
		}
		return {
			eventId: record.eventId,
			jobId: record.jobId,
			jobType: record.jobType
		};
	}

	private parseBackupInput(value: unknown, jobType: string) {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return null;
		const record = value as Record<string, unknown>;
		if (
			record.schemaVersion !== 1 ||
			typeof record.target !== 'string' ||
			!DATABASE_BACKUP_TARGETS.includes(
				record.target as DatabaseBackupTarget
			) ||
			jobType !==
				databaseBackupJobType(record.target as DatabaseBackupTarget) ||
			typeof record.chatId !== 'string' ||
			!record.chatId.trim() ||
			!Number.isInteger(record.messageThreadId) ||
			Number(record.messageThreadId) < 1 ||
			(record.trigger !== 'MANUAL' && record.trigger !== 'SCHEDULED')
		) {
			return null;
		}
		return {
			target: record.target as DatabaseBackupTarget,
			chatId: record.chatId,
			messageThreadId: record.messageThreadId as number,
			trigger: record.trigger as 'MANUAL' | 'SCHEDULED'
		};
	}
}
