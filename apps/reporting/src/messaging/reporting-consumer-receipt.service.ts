import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import { InvalidReportingEventError } from '../projections/reporting-event.contract';
import { Injectable } from '@nestjs/common';
import {
	Prisma,
	ReportingConsumerReceiptStatus
} from '@prisma/reporting-client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const RECEIPT_LEASE_MS = 5 * 60 * 1000;

export type ReportingConsumerReceiptClaim =
	| { state: 'claimed'; lockToken: string }
	| { state: 'done' }
	| { state: 'active' };

@Injectable()
export class ReportingConsumerReceiptService {
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;

	constructor(private readonly prisma: ReportingPrismaService) {}

	async claim(
		eventId: string,
		consumer: string,
		payloadHash: string,
		retryAttempt: number,
		retryCycle: number
	): Promise<ReportingConsumerReceiptClaim> {
		const now = new Date();
		const lockToken = randomUUID();
		const leaseExpiresAt = new Date(now.getTime() + RECEIPT_LEASE_MS);
		try {
			await this.prisma.consumerReceipt.create({
				data: {
					eventId,
					consumer,
					payloadHash,
					status: ReportingConsumerReceiptStatus.PROCESSING,
					lockedAt: now,
					lockedBy: this.workerId,
					lockToken,
					leaseExpiresAt,
					retryCycle
				}
			});
			return { state: 'claimed', lockToken };
		} catch (error) {
			if (!this.isUniqueViolation(error)) throw error;
		}
		const receipt = await this.prisma.consumerReceipt.findUnique({
			where: { eventId_consumer: { eventId, consumer } }
		});
		if (!receipt) throw new Error('Consumer receipt disappeared');
		if (receipt.payloadHash !== payloadHash) {
			throw new InvalidReportingEventError(
				'eventId was reused with another payload'
			);
		}
		if (
			receipt.status === ReportingConsumerReceiptStatus.DELIVERED ||
			receipt.status === ReportingConsumerReceiptStatus.DEAD_LETTERED
		) {
			return { state: 'done' };
		}
		if (receipt.retryCycle !== retryCycle) {
			return retryCycle < receipt.retryCycle
				? { state: 'done' }
				: { state: 'active' };
		}
		const reclaimable =
			(receipt.status === ReportingConsumerReceiptStatus.RETRY_SCHEDULED &&
				receipt.retryAttempt === retryAttempt) ||
			(receipt.status === ReportingConsumerReceiptStatus.PROCESSING &&
				receipt.leaseExpiresAt !== null &&
				receipt.leaseExpiresAt <= now);
		if (!reclaimable) return { state: 'active' };
		const updated = await this.prisma.consumerReceipt.updateMany({
			where: {
				id: receipt.id,
				payloadHash,
				retryCycle,
				OR: [
					{
						status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
						retryAttempt
					},
					{
						status: ReportingConsumerReceiptStatus.PROCESSING,
						leaseExpiresAt: { lte: now }
					}
				]
			},
			data: {
				status: ReportingConsumerReceiptStatus.PROCESSING,
				lockedAt: now,
				lockedBy: this.workerId,
				lockToken,
				leaseExpiresAt,
				retryAttempt: null,
				lastError: null
			}
		});
		return updated.count === 1
			? { state: 'claimed', lockToken }
			: { state: 'active' };
	}

	async renew(
		eventId: string,
		consumer: string,
		lockToken: string
	): Promise<boolean> {
		const renewed = await this.prisma.consumerReceipt.updateMany({
			where: {
				eventId,
				consumer,
				status: ReportingConsumerReceiptStatus.PROCESSING,
				lockedBy: this.workerId,
				lockToken
			},
			data: {
				leaseExpiresAt: new Date(Date.now() + RECEIPT_LEASE_MS)
			}
		});
		return renewed.count === 1;
	}

	async transitionAfterFailure(
		transaction: Prisma.TransactionClient,
		input: {
			eventId: string;
			consumer: string;
			lockToken: string;
			shouldRetry: boolean;
			nextAttempt: number;
			errorMessage: string;
		}
	): Promise<void> {
		const updated = await transaction.consumerReceipt.updateMany({
			where: {
				eventId: input.eventId,
				consumer: input.consumer,
				status: ReportingConsumerReceiptStatus.PROCESSING,
				lockedBy: this.workerId,
				lockToken: input.lockToken
			},
			data: {
				status: input.shouldRetry
					? ReportingConsumerReceiptStatus.RETRY_SCHEDULED
					: ReportingConsumerReceiptStatus.DEAD_LETTERED,
				retryAttempt: input.shouldRetry ? input.nextAttempt : null,
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				lastError: input.errorMessage
			}
		});
		if (updated.count !== 1) {
			throw new Error('Consumer receipt lease was lost during failure');
		}
	}

	private isUniqueViolation(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}
}
