import { InvalidReportingEventError } from '../projections/reporting-event.contract';
import { ReportingConsumerReceiptService } from './reporting-consumer-receipt.service';
import {
	Prisma,
	ReportingConsumerReceiptStatus
} from '@prisma/reporting-client';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const RECEIPT_ID = '22222222-2222-4222-8222-222222222222';
const CONSUMER = 'reporting-identity-user-v1';
const PAYLOAD_HASH = 'a'.repeat(64);

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
	return new Prisma.PrismaClientKnownRequestError('duplicate', {
		code: 'P2002',
		clientVersion: '5.22.0'
	});
}

function prismaWithReceipt(receipt: Record<string, unknown> | null) {
	return {
		consumerReceipt: {
			create: jest.fn().mockRejectedValue(uniqueViolation()),
			findUnique: jest.fn().mockResolvedValue(receipt),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		}
	};
}

describe('ReportingConsumerReceiptService', () => {
	beforeEach(() => {
		jest.useFakeTimers().setSystemTime(NOW);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('creates a new PROCESSING receipt with the exact five-minute lease', async () => {
		const prisma = {
			consumerReceipt: {
				create: jest.fn().mockResolvedValue(undefined),
				findUnique: jest.fn(),
				updateMany: jest.fn()
			}
		};
		const service = new ReportingConsumerReceiptService(prisma as never);

		const claim = await service.claim(
			EVENT_ID,
			CONSUMER,
			PAYLOAD_HASH,
			0,
			2
		);

		expect(claim).toEqual({
			state: 'claimed',
			lockToken: expect.any(String)
		});
		expect(prisma.consumerReceipt.create).toHaveBeenCalledWith({
			data: {
				eventId: EVENT_ID,
				consumer: CONSUMER,
				payloadHash: PAYLOAD_HASH,
				status: ReportingConsumerReceiptStatus.PROCESSING,
				lockedAt: NOW,
				lockedBy: expect.any(String),
				lockToken: claim.state === 'claimed' ? claim.lockToken : '',
				leaseExpiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
				retryCycle: 2
			}
		});
		expect(prisma.consumerReceipt.findUnique).not.toHaveBeenCalled();
	});

	it('rethrows a non-unique create error without reading another receipt', async () => {
		const failure = new Error('database unavailable');
		const prisma = {
			consumerReceipt: {
				create: jest.fn().mockRejectedValue(failure),
				findUnique: jest.fn(),
				updateMany: jest.fn()
			}
		};
		const service = new ReportingConsumerReceiptService(prisma as never);

		await expect(
			service.claim(EVENT_ID, CONSUMER, PAYLOAD_HASH, 0, 0)
		).rejects.toBe(failure);
		expect(prisma.consumerReceipt.findUnique).not.toHaveBeenCalled();
	});

	it('fails closed when the unique receipt disappears', async () => {
		const prisma = prismaWithReceipt(null);
		const service = new ReportingConsumerReceiptService(prisma as never);

		await expect(
			service.claim(EVENT_ID, CONSUMER, PAYLOAD_HASH, 0, 0)
		).rejects.toThrow('Consumer receipt disappeared');
	});

	it('rejects reuse of eventId with a different canonical payload', async () => {
		const prisma = prismaWithReceipt({
			id: RECEIPT_ID,
			payloadHash: 'b'.repeat(64),
			status: ReportingConsumerReceiptStatus.PROCESSING,
			retryCycle: 0,
			leaseExpiresAt: new Date(NOW.getTime() + 1000),
			retryAttempt: null
		});
		const service = new ReportingConsumerReceiptService(prisma as never);

		await expect(
			service.claim(EVENT_ID, CONSUMER, PAYLOAD_HASH, 0, 0)
		).rejects.toThrow(InvalidReportingEventError);
		expect(prisma.consumerReceipt.updateMany).not.toHaveBeenCalled();
	});

	it.each([
		ReportingConsumerReceiptStatus.DELIVERED,
		ReportingConsumerReceiptStatus.DEAD_LETTERED
	])('treats terminal %s receipts as done', async status => {
		const prisma = prismaWithReceipt({
			id: RECEIPT_ID,
			payloadHash: PAYLOAD_HASH,
			status,
			retryCycle: 0,
			leaseExpiresAt: null,
			retryAttempt: null
		});
		const service = new ReportingConsumerReceiptService(prisma as never);

		await expect(
			service.claim(EVENT_ID, CONSUMER, PAYLOAD_HASH, 0, 0)
		).resolves.toEqual({ state: 'done' });
		expect(prisma.consumerReceipt.updateMany).not.toHaveBeenCalled();
	});

	it.each([
		{ incomingCycle: 1, storedCycle: 2, expected: 'done' },
		{ incomingCycle: 3, storedCycle: 2, expected: 'active' }
	])(
		'maps an out-of-order retry cycle to $expected',
		async ({ incomingCycle, storedCycle, expected }) => {
			const prisma = prismaWithReceipt({
				id: RECEIPT_ID,
				payloadHash: PAYLOAD_HASH,
				status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
				retryCycle: storedCycle,
				leaseExpiresAt: null,
				retryAttempt: 1
			});
			const service = new ReportingConsumerReceiptService(prisma as never);

			await expect(
				service.claim(EVENT_ID, CONSUMER, PAYLOAD_HASH, 1, incomingCycle)
			).resolves.toEqual({ state: expected });
			expect(prisma.consumerReceipt.updateMany).not.toHaveBeenCalled();
		}
	);

	it('reclaims only the exact scheduled retry attempt with a CAS update', async () => {
		const prisma = prismaWithReceipt({
			id: RECEIPT_ID,
			payloadHash: PAYLOAD_HASH,
			status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
			retryCycle: 3,
			leaseExpiresAt: null,
			retryAttempt: 2
		});
		const service = new ReportingConsumerReceiptService(prisma as never);

		const claim = await service.claim(
			EVENT_ID,
			CONSUMER,
			PAYLOAD_HASH,
			2,
			3
		);

		expect(claim).toEqual({
			state: 'claimed',
			lockToken: expect.any(String)
		});
		expect(prisma.consumerReceipt.updateMany).toHaveBeenCalledWith({
			where: {
				id: RECEIPT_ID,
				payloadHash: PAYLOAD_HASH,
				retryCycle: 3,
				OR: [
					{
						status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
						retryAttempt: 2
					},
					{
						status: ReportingConsumerReceiptStatus.PROCESSING,
						leaseExpiresAt: { lte: NOW }
					}
				]
			},
			data: expect.objectContaining({
				status: ReportingConsumerReceiptStatus.PROCESSING,
				lockedAt: NOW,
				lockedBy: expect.any(String),
				lockToken: claim.state === 'claimed' ? claim.lockToken : undefined,
				leaseExpiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
				retryAttempt: null,
				lastError: null
			})
		});
	});

	it('keeps a scheduled retry active when the attempt does not match', async () => {
		const prisma = prismaWithReceipt({
			id: RECEIPT_ID,
			payloadHash: PAYLOAD_HASH,
			status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
			retryCycle: 3,
			leaseExpiresAt: null,
			retryAttempt: 2
		});
		const service = new ReportingConsumerReceiptService(prisma as never);

		await expect(
			service.claim(EVENT_ID, CONSUMER, PAYLOAD_HASH, 1, 3)
		).resolves.toEqual({ state: 'active' });
		expect(prisma.consumerReceipt.updateMany).not.toHaveBeenCalled();
	});

	it('keeps a scheduled retry active when another worker wins its CAS', async () => {
		const prisma = prismaWithReceipt({
			id: RECEIPT_ID,
			payloadHash: PAYLOAD_HASH,
			status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
			retryCycle: 3,
			leaseExpiresAt: null,
			retryAttempt: 2
		});
		prisma.consumerReceipt.updateMany.mockResolvedValue({ count: 0 });
		const service = new ReportingConsumerReceiptService(prisma as never);

		await expect(
			service.claim(EVENT_ID, CONSUMER, PAYLOAD_HASH, 2, 3)
		).resolves.toEqual({ state: 'active' });
		expect(prisma.consumerReceipt.updateMany).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			leaseExpiresAt: new Date(NOW.getTime() + 1),
			updateCount: 1,
			expected: 'active'
		},
		{
			leaseExpiresAt: new Date(NOW.getTime() - 1),
			updateCount: 1,
			expected: 'claimed'
		},
		{
			leaseExpiresAt: new Date(NOW.getTime() - 1),
			updateCount: 0,
			expected: 'active'
		}
	])(
		'maps PROCESSING lease/CAS state to $expected',
		async ({ leaseExpiresAt, updateCount, expected }) => {
			const prisma = prismaWithReceipt({
				id: RECEIPT_ID,
				payloadHash: PAYLOAD_HASH,
				status: ReportingConsumerReceiptStatus.PROCESSING,
				retryCycle: 0,
				leaseExpiresAt,
				retryAttempt: null
			});
			prisma.consumerReceipt.updateMany.mockResolvedValue({
				count: updateCount
			});
			const service = new ReportingConsumerReceiptService(prisma as never);

			const claim = await service.claim(
				EVENT_ID,
				CONSUMER,
				PAYLOAD_HASH,
				0,
				0
			);

			expect(claim.state).toBe(expected);
			expect(prisma.consumerReceipt.updateMany).toHaveBeenCalledTimes(
				expected === 'active' && leaseExpiresAt > NOW ? 0 : 1
			);
		}
	);

	it.each([
		{ count: 1, expected: true },
		{ count: 0, expected: false }
	])('renews only the exact owned claim', async ({ count, expected }) => {
		const prisma = {
			consumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count })
			}
		};
		const service = new ReportingConsumerReceiptService(prisma as never);

		await expect(
			service.renew(EVENT_ID, CONSUMER, RECEIPT_ID)
		).resolves.toBe(expected);
		expect(prisma.consumerReceipt.updateMany).toHaveBeenCalledWith({
			where: {
				eventId: EVENT_ID,
				consumer: CONSUMER,
				status: ReportingConsumerReceiptStatus.PROCESSING,
				lockedBy: expect.any(String),
				lockToken: RECEIPT_ID
			},
			data: {
				leaseExpiresAt: new Date(NOW.getTime() + 5 * 60 * 1000)
			}
		});
	});

	it.each([
		{
			shouldRetry: true,
			expectedStatus: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
			expectedAttempt: 2
		},
		{
			shouldRetry: false,
			expectedStatus: ReportingConsumerReceiptStatus.DEAD_LETTERED,
			expectedAttempt: null
		}
	])(
		'transitions the owned receipt to $expectedStatus in the caller transaction',
		async ({ shouldRetry, expectedStatus, expectedAttempt }) => {
			const transaction = {
				consumerReceipt: {
					updateMany: jest.fn().mockResolvedValue({ count: 1 })
				}
			};
			const service = new ReportingConsumerReceiptService({} as never);

			await service.transitionAfterFailure(transaction as never, {
				eventId: EVENT_ID,
				consumer: CONSUMER,
				lockToken: RECEIPT_ID,
				shouldRetry,
				nextAttempt: 2,
				errorMessage: 'failure'
			});

			expect(transaction.consumerReceipt.updateMany).toHaveBeenCalledWith({
				where: {
					eventId: EVENT_ID,
					consumer: CONSUMER,
					status: ReportingConsumerReceiptStatus.PROCESSING,
					lockedBy: expect.any(String),
					lockToken: RECEIPT_ID
				},
				data: {
					status: expectedStatus,
					retryAttempt: expectedAttempt,
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: 'failure'
				}
			});
		}
	);

	it('rejects a failure transition after the receipt claim is lost', async () => {
		const transaction = {
			consumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			}
		};
		const service = new ReportingConsumerReceiptService({} as never);

		await expect(
			service.transitionAfterFailure(transaction as never, {
				eventId: EVENT_ID,
				consumer: CONSUMER,
				lockToken: RECEIPT_ID,
				shouldRetry: true,
				nextAttempt: 1,
				errorMessage: 'failure'
			})
		).rejects.toThrow('Consumer receipt lease was lost during failure');
	});
});
