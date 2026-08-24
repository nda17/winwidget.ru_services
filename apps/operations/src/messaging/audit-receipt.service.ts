import { Injectable } from '@nestjs/common';
import { AuditReceiptStatus, Prisma } from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { AdminEventLogRecordInput } from '../admin-event-log/admin-event-log.contract';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { OPERATIONS_AUDIT_CONSUMER } from './operations-messaging.constants';

export type AuditReceiptClaim =
	| { state: 'claimed'; leaseToken: string }
	| { state: 'delivered' }
	| { state: 'dead-lettered' }
	| { state: 'busy' };

@Injectable()
export class AuditReceiptService {
	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly runtime: OperationsRuntimeService,
		private readonly adminEventLog: AdminEventLogService
	) {}

	async claim(eventId: string): Promise<AuditReceiptClaim> {
		const now = new Date();
		const leaseToken = randomUUID();
		const leaseExpiresAt = new Date(
			now.getTime() + this.runtime.auditReceiptLeaseMs
		);
		try {
			await this.prisma.auditEventReceipt.create({
				data: {
					eventId,
					consumer: OPERATIONS_AUDIT_CONSUMER,
					status: AuditReceiptStatus.PROCESSING,
					attempt: 1,
					leaseToken,
					leaseExpiresAt
				}
			});
			return { state: 'claimed', leaseToken };
		} catch (error) {
			if (!this.isUniqueConstraintError(error)) throw error;
		}

		const receipt = await this.prisma.auditEventReceipt.findUniqueOrThrow({
			where: {
				eventId_consumer: {
					eventId,
					consumer: OPERATIONS_AUDIT_CONSUMER
				}
			}
		});
		if (receipt.status === AuditReceiptStatus.DELIVERED) {
			return { state: 'delivered' };
		}
		if (receipt.status === AuditReceiptStatus.DEAD_LETTERED) {
			return { state: 'dead-lettered' };
		}

		const changed = await this.prisma.auditEventReceipt.updateMany({
			where: {
				id: receipt.id,
				OR: [
					{
						status: AuditReceiptStatus.PROCESSING,
						leaseExpiresAt: { lte: now }
					},
					{
						status: AuditReceiptStatus.RETRY_SCHEDULED,
						retryAvailableAt: { lte: now }
					}
				]
			},
			data: {
				status: AuditReceiptStatus.PROCESSING,
				attempt: { increment: 1 },
				leaseToken,
				leaseExpiresAt,
				retryAvailableAt: null,
				lastError: null
			}
		});
		return changed.count === 1
			? { state: 'claimed', leaseToken }
			: { state: 'busy' };
	}

	async deliver(
		eventId: string,
		leaseToken: string,
		record: AdminEventLogRecordInput
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			await this.adminEventLog.recordInTransaction(transaction, record);
			const delivered = await transaction.auditEventReceipt.updateMany({
				where: {
					eventId,
					consumer: OPERATIONS_AUDIT_CONSUMER,
					status: AuditReceiptStatus.PROCESSING,
					leaseToken
				},
				data: {
					status: AuditReceiptStatus.DELIVERED,
					leaseToken: null,
					leaseExpiresAt: null,
					retryAvailableAt: null,
					deliveredAt: new Date(),
					lastError: null
				}
			});
			if (delivered.count !== 1) {
				throw new Error('OPERATIONS_AUDIT_RECEIPT_LEASE_LOST');
			}
		});
	}

	async scheduleRetry(
		eventId: string,
		leaseToken: string,
		availableAt: Date
	): Promise<void> {
		const changed = await this.prisma.auditEventReceipt.updateMany({
			where: {
				eventId,
				consumer: OPERATIONS_AUDIT_CONSUMER,
				status: AuditReceiptStatus.PROCESSING,
				leaseToken
			},
			data: {
				status: AuditReceiptStatus.RETRY_SCHEDULED,
				leaseToken: null,
				leaseExpiresAt: null,
				retryAvailableAt: availableAt,
				lastError: 'AUDIT_PERSISTENCE_FAILED'
			}
		});
		if (changed.count !== 1) {
			throw new Error('OPERATIONS_AUDIT_RETRY_LEASE_LOST');
		}
	}

	async markDeadLettered(
		eventId: string,
		leaseToken: string
	): Promise<void> {
		const changed = await this.prisma.auditEventReceipt.updateMany({
			where: {
				eventId,
				consumer: OPERATIONS_AUDIT_CONSUMER,
				status: AuditReceiptStatus.PROCESSING,
				leaseToken
			},
			data: {
				status: AuditReceiptStatus.DEAD_LETTERED,
				leaseToken: null,
				leaseExpiresAt: null,
				retryAvailableAt: null,
				deadLetteredAt: new Date(),
				lastError: 'AUDIT_RETRY_BUDGET_EXHAUSTED'
			}
		});
		if (changed.count !== 1) {
			throw new Error('OPERATIONS_AUDIT_DLQ_LEASE_LOST');
		}
	}

	async releaseForRedelivery(
		eventId: string,
		leaseToken: string
	): Promise<void> {
		await this.prisma.auditEventReceipt.updateMany({
			where: {
				eventId,
				consumer: OPERATIONS_AUDIT_CONSUMER,
				status: AuditReceiptStatus.PROCESSING,
				leaseToken
			},
			data: {
				status: AuditReceiptStatus.RETRY_SCHEDULED,
				leaseToken: null,
				leaseExpiresAt: null,
				retryAvailableAt: new Date(),
				lastError: 'AUDIT_FINALIZATION_FAILED'
			}
		});
	}

	private isUniqueConstraintError(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}
}
