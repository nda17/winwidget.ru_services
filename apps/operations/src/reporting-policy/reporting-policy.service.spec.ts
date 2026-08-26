import { ReportingPolicyService } from './reporting-policy.service';

const CHANGE_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('ReportingPolicyService', () => {
	it('reserves and confirms the next schedule generation under the singleton lock', async () => {
		const policy = {
			reservationTime: '03:00',
			reservationGeneration: 7n,
			confirmedChangeId: null,
			pendingChangeId: null,
			pendingTime: null,
			pendingGeneration: null
		};
		const transaction = {
			telegramBotSettings: {
				upsert: jest.fn(),
				findUniqueOrThrow: jest
					.fn()
					.mockResolvedValue({ databaseBackupTime: '01:45' })
			},
			reportingSchedulePolicy: {
				upsert: jest.fn(),
				findUniqueOrThrow: jest.fn().mockResolvedValue(policy),
				update: jest.fn()
			},
			$queryRaw: jest.fn()
		};
		const prisma = {
			$transaction: jest.fn((callback: (value: unknown) => unknown) =>
				callback(transaction)
			)
		};
		const service = new ReportingPolicyService(prisma as never);

		await expect(
			service.reserve({
				changeId: CHANGE_ID,
				scheduleTime: '04:30',
				expectedScheduleGeneration: '7',
				actorId: 'reporting-scheduler'
			})
		).resolves.toEqual({
			accepted: true,
			changeId: CHANGE_ID,
			reservationGeneration: '8',
			confirmationRequired: true
		});
		expect(
			transaction.reportingSchedulePolicy.update
		).toHaveBeenCalledWith({
			where: { id: 'singleton' },
			data: {
				pendingChangeId: CHANGE_ID,
				pendingTime: '04:30',
				pendingGeneration: 8n
			}
		});

		transaction.reportingSchedulePolicy.findUniqueOrThrow.mockResolvedValue(
			{
				...policy,
				pendingChangeId: CHANGE_ID,
				pendingTime: '04:30',
				pendingGeneration: 8n
			}
		);
		await expect(
			service.confirm({ changeId: CHANGE_ID, scheduleGeneration: '8' })
		).resolves.toEqual({
			confirmed: true,
			changeId: CHANGE_ID,
			reservationGeneration: '8'
		});
		expect(
			transaction.reportingSchedulePolicy.update
		).toHaveBeenLastCalledWith({
			where: { id: 'singleton' },
			data: {
				reservationTime: '04:30',
				reservationGeneration: 8n,
				confirmedChangeId: CHANGE_ID,
				pendingChangeId: null,
				pendingTime: null,
				pendingGeneration: null
			}
		});
		expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
	});

	it('rejects compatibility fields instead of accepting a wider contract', async () => {
		const prisma = { $transaction: jest.fn() };
		const service = new ReportingPolicyService(prisma as never);

		await expect(
			service.reserve({
				changeId: CHANGE_ID,
				scheduleTime: '04:30',
				expectedScheduleGeneration: '7',
				actorId: 'reporting-scheduler',
				legacyGeneration: '7'
			})
		).rejects.toThrow('schedule policy request is invalid');
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
});
