import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { PrismaService } from '@/prisma.service';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ReportingSchedulePolicyService } from './reporting-schedule-authority.service';

const CORRELATION_ID = '22222222-2222-4222-8222-222222222222';
const CHANGE_ID = '33333333-3333-4333-8333-333333333333';

const createService = ({
	owner = 'REPORTING',
	databaseBackupTime = '23:55',
	pending = null,
	confirmedChangeId = null
}: {
	owner?: 'CORE' | 'REPORTING';
	databaseBackupTime?: string;
	pending?: null | { changeId: string; time: string; generation: bigint };
	confirmedChangeId?: string | null;
} = {}) => {
	const state = {
		dailySummaryOwner: owner,
		dailySummaryPolicyReservationTime: '01:50',
		dailySummaryPolicyReservationGeneration: 3n,
		dailySummaryPolicyConfirmedChangeId: confirmedChangeId,
		dailySummaryPolicyPendingChangeId: pending?.changeId ?? null,
		dailySummaryPolicyPendingTime: pending?.time ?? null,
		dailySummaryPolicyPendingGeneration: pending?.generation ?? null
	};
	const queryRaw = jest
		.fn()
		.mockImplementation(() =>
			Promise.resolve(
				queryRaw.mock.calls.length % 2 === 1
					? [{ id: 'singleton' }]
					: [state]
			)
		);
	const transaction = {
		$queryRaw: queryRaw,
		telegramBotSettings: {
			upsert: jest.fn().mockResolvedValue({ id: 'singleton' }),
			findUniqueOrThrow: jest
				.fn()
				.mockResolvedValue({ databaseBackupTime })
		},
		reportingProducerState: { update: jest.fn().mockResolvedValue({}) }
	};
	const prisma = {
		$transaction: jest.fn(
			(callback: (client: typeof transaction) => unknown) =>
				callback(transaction)
		)
	} as unknown as PrismaService;
	const adminEventLog = {
		record: jest.fn().mockResolvedValue({})
	} as unknown as AdminEventLogService;
	return {
		service: new ReportingSchedulePolicyService(prisma, adminEventLog),
		prisma,
		transaction,
		adminEventLog
	};
};

const reservationRequest = (overrides: Record<string, unknown> = {}) => ({
	changeId: CHANGE_ID,
	scheduleTime: '00:20',
	expectedScheduleGeneration: '3',
	actorId: 'admin-id',
	...overrides
});

describe('ReportingSchedulePolicyService', () => {
	it('durably reserves a safe candidate without making Core its source', async () => {
		const { service, transaction } = createService();

		await expect(
			service.reserve(reservationRequest(), CORRELATION_ID)
		).resolves.toEqual({
			accepted: true,
			changeId: CHANGE_ID,
			reservationGeneration: '4',
			confirmationRequired: true
		});
		expect(transaction.reportingProducerState.update).toHaveBeenCalledWith(
			{
				where: { id: 'singleton' },
				data: {
					dailySummaryPolicyPendingChangeId: CHANGE_ID,
					dailySummaryPolicyPendingTime: '00:20',
					dailySummaryPolicyPendingGeneration: 4n
				}
			}
		);
		expect(
			transaction.telegramBotSettings.upsert.mock.invocationCallOrder[0]
		).toBeLessThan(transaction.$queryRaw.mock.invocationCallOrder[0]);
	});

	it('accepts the exact same pending reservation idempotently', async () => {
		const { service, transaction } = createService({
			pending: { changeId: CHANGE_ID, time: '00:20', generation: 4n }
		});

		await expect(
			service.reserve(reservationRequest(), CORRELATION_ID)
		).resolves.toEqual(
			expect.objectContaining({
				changeId: CHANGE_ID,
				reservationGeneration: '4',
				confirmationRequired: true
			})
		);
		expect(
			transaction.reportingProducerState.update
		).not.toHaveBeenCalled();
	});

	it('blocks a different command while an unconfirmed reservation exists', async () => {
		const { service, transaction, adminEventLog } = createService({
			pending: { changeId: CHANGE_ID, time: '00:20', generation: 4n }
		});

		await expect(
			service.reserve(
				reservationRequest({
					changeId: '44444444-4444-4444-8444-444444444444',
					scheduleTime: '03:00'
				}),
				CORRELATION_ID
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(
			transaction.reportingProducerState.update
		).not.toHaveBeenCalled();
		expect(adminEventLog.record).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					reasonCode: 'CONFIRMATION_PENDING'
				})
			})
		);
	});

	it('rejects a collision across midnight and records a safe reason', async () => {
		const { service, transaction, adminEventLog } = createService();

		await expect(
			service.reserve(
				reservationRequest({ scheduleTime: '00:08' }),
				CORRELATION_ID
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(
			transaction.reportingProducerState.update
		).not.toHaveBeenCalled();
		expect(adminEventLog.record).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: {
					reasonCode: 'BACKUP_SCHEDULE_CONFLICT',
					correlationId: CORRELATION_ID
				}
			})
		);
	});

	it('rejects reservation before Reporting owns the settings', async () => {
		const { service, transaction } = createService({ owner: 'CORE' });

		await expect(
			service.reserve(reservationRequest(), CORRELATION_ID)
		).rejects.toBeInstanceOf(ConflictException);
		expect(
			transaction.reportingProducerState.update
		).not.toHaveBeenCalled();
	});

	it('confirms the durable pending reservation after Reporting commits', async () => {
		const { service, transaction } = createService({
			pending: { changeId: CHANGE_ID, time: '00:20', generation: 4n }
		});

		await expect(
			service.confirm(
				{ changeId: CHANGE_ID, scheduleGeneration: '4' },
				CORRELATION_ID
			)
		).resolves.toEqual({
			confirmed: true,
			changeId: CHANGE_ID,
			reservationGeneration: '4'
		});
		expect(transaction.reportingProducerState.update).toHaveBeenCalledWith(
			{
				where: { id: 'singleton' },
				data: {
					dailySummaryPolicyReservationTime: '00:20',
					dailySummaryPolicyReservationGeneration: 4n,
					dailySummaryPolicyConfirmedChangeId: CHANGE_ID,
					dailySummaryPolicyPendingChangeId: null,
					dailySummaryPolicyPendingTime: null,
					dailySummaryPolicyPendingGeneration: null
				}
			}
		);
	});

	it('accepts a lost confirmation response idempotently', async () => {
		const { service, transaction } = createService({
			confirmedChangeId: CHANGE_ID
		});

		await expect(
			service.confirm(
				{ changeId: CHANGE_ID, scheduleGeneration: '3' },
				CORRELATION_ID
			)
		).resolves.toEqual(
			expect.objectContaining({ confirmed: true, changeId: CHANGE_ID })
		);
		expect(
			transaction.reportingProducerState.update
		).not.toHaveBeenCalled();
	});

	it('rejects unknown reservation fields before opening a transaction', async () => {
		const { service, prisma, adminEventLog } = createService();

		await expect(
			service.reserve(
				reservationRequest({ unexpected: true }),
				CORRELATION_ID
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(adminEventLog.record).toHaveBeenCalledWith(
			expect.objectContaining({
				adminId: 'admin-id',
				metadata: {
					reasonCode: 'INVALID_REQUEST',
					correlationId: CORRELATION_ID
				}
			})
		);
	});
});
