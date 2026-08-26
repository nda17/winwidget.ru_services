import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
	DatabaseRestoreJobStatus,
	OperationalAlertSeverity
} from '@prisma/operations-client';
import type { ConsumeMessage } from 'amqplib';
import { rm } from 'node:fs/promises';
import { OPERATIONS_DATABASE_RESTORE_EVENT_TYPE } from '../messaging/operations-messaging.constants';
import {
	OperationsConsumeDecision,
	OperationsRabbitMqService
} from '../messaging/operations-rabbitmq.service';
import { OperationalAlertService } from '../monitoring/operational-alert.service';
import { OperationsOwnershipService } from '../ownership/operations-ownership.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import {
	DATABASE_RESTORE_TARGETS,
	DatabaseRestoreTarget
} from './database-restore.contract';
import { DatabaseRestoreExecutorService } from './database-restore-executor.service';
import { DatabaseRestoreService } from './database-restore.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class DatabaseRestoreWorkerService implements OnModuleInit {
	private readonly logger = new Logger(DatabaseRestoreWorkerService.name);
	private ready = false;

	constructor(
		private readonly runtime: OperationsRuntimeService,
		private readonly ownership: OperationsOwnershipService,
		private readonly rabbit: OperationsRabbitMqService,
		private readonly control: DatabaseRestoreService,
		private readonly prisma: OperationsPrismaService,
		private readonly executor: DatabaseRestoreExecutorService,
		private readonly alerts: OperationalAlertService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.restoreWorkerEnabled) return;
		if (!(await this.ownership.isActive())) {
			this.ready = true;
			return;
		}
		await this.rabbit.consumeDatabaseRestoreJobs(message =>
			this.handleMessage(message)
		);
		this.ready = true;
	}

	isReady(): boolean {
		return !this.runtime.restoreWorkerEnabled || this.ready;
	}

	async handleMessage(
		message: ConsumeMessage
	): Promise<OperationsConsumeDecision> {
		let event: {
			eventId: string;
			jobId: string;
			target: DatabaseRestoreTarget;
		};
		try {
			event = this.parseEvent(message);
		} catch {
			return 'reject';
		}
		const claimed = await this.prisma.databaseRestoreJob.updateMany({
			where: {
				id: event.jobId,
				target: event.target,
				status: DatabaseRestoreJobStatus.QUEUED
			},
			data: {
				status: DatabaseRestoreJobStatus.PROCESSING,
				startedAt: new Date(),
				lastError: null
			}
		});
		if (claimed.count !== 1) return 'ack';
		const source = await this.control.resolveSourcePath(event.jobId);
		try {
			const job = await this.prisma.databaseRestoreJob.findUniqueOrThrow({
				where: { id: event.jobId }
			});
			const result = await this.executor.restore({
				jobId: job.id,
				target: event.target,
				source,
				expectedSha256: job.sourceSha256
			});
			const finishedAt = new Date();
			if (event.target === 'operations') {
				await this.prisma.databaseRestoreJob.upsert({
					where: { id: job.id },
					create: {
						id: job.id,
						target: job.target,
						status: DatabaseRestoreJobStatus.SUCCEEDED,
						sourceFileName: job.sourceFileName,
						sourceSha256: job.sourceSha256,
						sourceSize: job.sourceSize,
						requestedById: job.requestedById,
						idempotencyKey: job.idempotencyKey,
						result,
						startedAt: job.startedAt,
						finishedAt
					},
					update: {
						status: DatabaseRestoreJobStatus.SUCCEEDED,
						result,
						lastError: null,
						startedAt: job.startedAt,
						finishedAt
					}
				});
			} else {
				await this.prisma.databaseRestoreJob.update({
					where: { id: job.id },
					data: {
						status: DatabaseRestoreJobStatus.SUCCEEDED,
						result,
						finishedAt
					}
				});
			}
			await this.alerts
				.resolve(`database-restore:${event.target}`)
				.catch(() => undefined);
			return 'ack';
		} catch (error) {
			await this.prisma.databaseRestoreJob
				.updateMany({
					where: {
						id: event.jobId,
						status: DatabaseRestoreJobStatus.PROCESSING
					},
					data: {
						status: DatabaseRestoreJobStatus.FAILED,
						lastError: this.safeError(error),
						finishedAt: new Date()
					}
				})
				.catch(() => undefined);
			await this.alerts
				.record({
					deduplicationKey: `database-restore:${event.target}`,
					type: 'INTEGRATION_PROBLEM',
					severity: OperationalAlertSeverity.HIGH,
					source: 'operations',
					referenceId: event.jobId,
					title: `Не восстановлена база ${event.target}`,
					message:
						'DEV database restore завершился ошибкой; проверьте job и safety backup'
				})
				.catch(() => undefined);
			this.logger.error(`Database restore failed jobId=${event.jobId}`);
			return 'ack';
		} finally {
			await rm(source, { force: true });
		}
	}

	private parseEvent(message: ConsumeMessage) {
		if (
			message.properties.type !== OPERATIONS_DATABASE_RESTORE_EVENT_TYPE ||
			message.content.length > 64 * 1024
		) {
			throw new Error('Database restore message is invalid');
		}
		const value = JSON.parse(message.content.toString('utf8')) as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Database restore event is invalid');
		}
		const record = value as Record<string, unknown>;
		if (
			Object.keys(record).sort().join(',') !==
				'eventId,jobId,schemaVersion,target' ||
			record.schemaVersion !== 1 ||
			typeof record.eventId !== 'string' ||
			!UUID_PATTERN.test(record.eventId) ||
			typeof record.jobId !== 'string' ||
			!UUID_PATTERN.test(record.jobId) ||
			typeof record.target !== 'string' ||
			!DATABASE_RESTORE_TARGETS.includes(
				record.target as DatabaseRestoreTarget
			) ||
			message.properties.messageId !== record.eventId
		) {
			throw new Error('Database restore event contract is invalid');
		}
		return {
			eventId: record.eventId,
			jobId: record.jobId,
			target: record.target as DatabaseRestoreTarget
		};
	}

	private safeError(error: unknown): string {
		return (error instanceof Error ? error.message : String(error))
			.replace(/[\r\n]+/g, ' ')
			.slice(0, 2_000);
	}
}
