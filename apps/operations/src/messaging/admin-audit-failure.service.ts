import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { AuditReceiptStatus, Prisma } from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { parseAdminAuditEvent } from './admin-audit-event.contract';
import {
	getOperationsAuditManualRetryRoutingKey,
	getOperationsAuditSourceByName,
	OPERATIONS_AUDIT_CONSUMER,
	OPERATIONS_AUDIT_EVENT_TYPE,
	OPERATIONS_MANUAL_RETRY_EXCHANGE
} from './operations-messaging.constants';
import { OperationsOutboxService } from './operations-outbox.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuditFailureRetryContext {
	actorId: string;
	ip: string | null;
	userAgent: string | null;
	correlationId: string;
}

@Injectable()
export class AdminAuditFailureService {
	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly outbox: OperationsOutboxService,
		private readonly adminEventLog: AdminEventLogService
	) {}

	async list(page = 1, limit = 20) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const where = {
			consumer: OPERATIONS_AUDIT_CONSUMER,
			status: AuditReceiptStatus.DEAD_LETTERED
		} as const;
		const [items, total] = await this.prisma.$transaction([
			this.prisma.auditEventReceipt.findMany({
				where,
				select: {
					eventId: true,
					deadLetterSource: true,
					attempt: true,
					manualRetryCycle: true,
					deadLetteredAt: true,
					lastError: true
				},
				orderBy: { deadLetteredAt: 'desc' },
				skip: (normalizedPage - 1) * normalizedLimit,
				take: normalizedLimit
			}),
			this.prisma.auditEventReceipt.count({ where })
		]);
		return {
			items,
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async retry(
		eventId: string,
		context: AuditFailureRetryContext
	): Promise<{
		accepted: true;
		eventId: string;
		manualRetryCycle: number;
	}> {
		if (!UUID_PATTERN.test(eventId)) {
			throw new BadRequestException('Invalid audit eventId');
		}
		return this.prisma.$transaction(
			async transaction => {
				const receipt = await transaction.auditEventReceipt.findUnique({
					where: {
						eventId_consumer: {
							eventId,
							consumer: OPERATIONS_AUDIT_CONSUMER
						}
					}
				});
				if (!receipt) {
					throw new NotFoundException('Audit failure not found');
				}
				if (receipt.status !== AuditReceiptStatus.DEAD_LETTERED) {
					throw new ConflictException('Audit failure is not retryable');
				}
				const source = receipt.deadLetterSource
					? getOperationsAuditSourceByName(receipt.deadLetterSource)
					: undefined;
				const payload = this.validPayload(
					source,
					receipt.deadLetterPayload,
					eventId
				);
				const manualRetryCycle = receipt.manualRetryCycle + 1;
				const changed = await transaction.auditEventReceipt.updateMany({
					where: {
						id: receipt.id,
						status: AuditReceiptStatus.DEAD_LETTERED,
						manualRetryCycle: receipt.manualRetryCycle
					},
					data: {
						status: AuditReceiptStatus.RETRY_SCHEDULED,
						retryAvailableAt: new Date(),
						deadLetteredAt: null,
						deadLetterSource: null,
						deadLetterPayload: Prisma.DbNull,
						manualRetryCycle,
						lastError: null
					}
				});
				if (changed.count !== 1) {
					throw new ConflictException('Audit failure retry state changed');
				}
				await this.outbox.enqueue(transaction, {
					eventId: randomUUID(),
					messageId: eventId,
					deduplicationKey: `${eventId}:manual:${manualRetryCycle}`,
					eventType: OPERATIONS_AUDIT_EVENT_TYPE,
					aggregateType: 'operations.admin-audit-retry',
					aggregateId: eventId,
					correlationId: context.correlationId,
					exchange: OPERATIONS_MANUAL_RETRY_EXCHANGE,
					routingKey: getOperationsAuditManualRetryRoutingKey(source!),
					payload,
					headers: {
						'x-retry-attempt': 0,
						'x-manual-retry-cycle': manualRetryCycle
					}
				});
				await this.adminEventLog.recordInTransaction(transaction, {
					adminId: context.actorId,
					section: 'MESSAGING',
					action: 'MESSAGING_FAILURE_RETRY',
					description: 'Запрошен ручной retry события журнала',
					entityType: 'operations_audit_failure',
					entityId: eventId,
					entityLabel: source!.source,
					metadata: { eventId, manualRetryCycle, source: source!.source },
					ip: context.ip,
					userAgent: context.userAgent
				});
				return { accepted: true, eventId, manualRetryCycle };
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private validPayload(
		source: ReturnType<typeof getOperationsAuditSourceByName>,
		value: Prisma.JsonValue | null,
		eventId: string
	): Prisma.InputJsonObject {
		if (
			!source ||
			!value ||
			typeof value !== 'object' ||
			Array.isArray(value)
		) {
			throw new ConflictException('Audit failure payload is unavailable');
		}
		try {
			const payload = value as Prisma.InputJsonObject;
			const normalized = parseAdminAuditEvent(source, payload);
			if (normalized.eventId !== eventId)
				throw new Error('eventId mismatch');
			return payload;
		} catch {
			throw new ConflictException('Audit failure payload is invalid');
		}
	}
}
