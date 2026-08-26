import {
	ProjectionService,
	ProjectionStateConflictError,
	reportingProjectionStateHash
} from './projection.service';
import type { ReportingSourceEvent } from './reporting-event.contract';
import { Prisma, ProjectionReceiptResult } from '@prisma/reporting-client';

const EVENT: ReportingSourceEvent<'identity.user.changed.v1'> = {
	schemaVersion: 1,
	eventType: 'identity.user.changed.v1',
	eventId: '11111111-1111-4111-8111-111111111111',
	aggregateId: 'user-1',
	aggregateVersion: '2',
	sourceSequence: '10',
	occurredAt: '2026-07-31T00:00:00.000Z',
	tombstone: false,
	state: {
		id: 'user-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-31T00:00:00.000Z',
		deletedAt: null,
		status: 'ACTIVE',
		roles: ['USER'],
		hasEmailIdentity: true,
		hasPhoneIdentity: false,
		hasTelegramIdentity: false,
		loginMethodCount: 1
	}
};

describe('ProjectionService equal-version integrity', () => {
	function harness(stateHash: string) {
		const transaction = {
			projectionReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({})
			},
			$executeRaw: jest.fn().mockResolvedValue(1),
			identityUserProjection: {
				findUnique: jest.fn().mockResolvedValue({
					aggregateVersion: new Prisma.Decimal(2),
					stateHash
				})
			},
			projectionWatermark: {
				findUnique: jest.fn().mockResolvedValue(null),
				upsert: jest.fn().mockResolvedValue({})
			}
		};
		const service = new ProjectionService({} as never, {} as never);
		const apply = (
			event: ReportingSourceEvent<'identity.user.changed.v1'>
		) =>
			(
				service as unknown as {
					applyInTransaction(
						transaction: unknown,
						event: ReportingSourceEvent
					): Promise<ProjectionReceiptResult>;
				}
			).applyInTransaction(transaction, event);
		return { apply, transaction };
	}

	it('accepts queue replay with equal version and equal canonical state', async () => {
		const hash = reportingProjectionStateHash(EVENT);
		const { apply, transaction } = harness(hash);
		await expect(apply(EVENT)).resolves.toBe(
			ProjectionReceiptResult.DUPLICATE
		);
		expect(transaction.projectionReceipt.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ stateHash: hash })
			})
		);
	});

	it('rejects equal version with different full state', async () => {
		const existingHash = reportingProjectionStateHash(EVENT);
		const { apply, transaction } = harness(existingHash);
		await expect(
			apply({
				...EVENT,
				eventId: '22222222-2222-4222-8222-222222222222',
				state: { ...EVENT.state!, hasPhoneIdentity: true }
			})
		).rejects.toBeInstanceOf(ProjectionStateConflictError);
		expect(transaction.projectionReceipt.create).not.toHaveBeenCalled();
	});
});

describe('ProjectionService shared Telegram routing ownership', () => {
	it('applies the exact Operations routing event with receipt completion atomically', async () => {
		const transaction = {
			reportingSettings: {
				upsert: jest.fn().mockResolvedValue({}),
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					operationalAlertsChangedAt: null
				}),
				update: jest.fn().mockResolvedValue({})
			},
			consumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			reportingConsumerFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'daily-summary' }])
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (value: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const metrics = { increment: jest.fn() };
		const service = new ProjectionService(
			prisma as never,
			metrics as never
		);

		await expect(
			service.applyOperationsNotificationRouting(
				{
					schemaVersion: 1,
					eventId: '44444444-4444-4444-8444-444444444444',
					operationalAlertsThreadId: 2024,
					changedAt: '2026-08-26T00:00:00.000Z'
				},
				{
					eventId: '44444444-4444-4444-8444-444444444444',
					consumer: 'reporting-settings-v1',
					lockToken: '55555555-5555-4555-8555-555555555555'
				}
			)
		).resolves.toBeUndefined();

		const update =
			transaction.reportingSettings.update.mock.calls[0][0].data;
		expect(update).toEqual({
			operationalAlertsThreadId: 2024,
			operationalAlertsChangedAt: new Date('2026-08-26T00:00:00.000Z')
		});
		expect(update).not.toHaveProperty('destinationChatId');
		expect(update).not.toHaveProperty('scheduleTime');
		expect(transaction.consumerReceipt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					eventId: '44444444-4444-4444-8444-444444444444',
					consumer: 'reporting-settings-v1'
				})
			})
		);
		expect(metrics.increment).toHaveBeenCalledWith(
			'projection_events_applied_total'
		);
	});

	it('completes an older retry without reverting newer Operations routing', async () => {
		const transaction = {
			reportingSettings: {
				upsert: jest.fn().mockResolvedValue({}),
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					operationalAlertsChangedAt: new Date('2026-08-26T00:00:01.000Z')
				}),
				update: jest.fn()
			},
			consumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			reportingConsumerFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'daily-summary' }])
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (value: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const metrics = { increment: jest.fn() };
		const service = new ProjectionService(
			prisma as never,
			metrics as never
		);

		await service.applyOperationsNotificationRouting(
			{
				schemaVersion: 1,
				eventId: '66666666-6666-4666-8666-666666666666',
				operationalAlertsThreadId: 43,
				changedAt: '2026-08-26T00:00:00.000Z'
			},
			{
				eventId: '66666666-6666-4666-8666-666666666666',
				consumer: 'reporting-settings-v1',
				lockToken: '77777777-7777-4777-8777-777777777777'
			}
		);

		expect(transaction.reportingSettings.update).not.toHaveBeenCalled();
		expect(transaction.consumerReceipt.updateMany).toHaveBeenCalled();
		expect(metrics.increment).toHaveBeenCalledWith(
			'projection_events_stale_total'
		);
	});

	it('rejects a newer Operations routing event that collides with the Daily Summary topic', async () => {
		const transaction = {
			reportingSettings: {
				upsert: jest.fn().mockResolvedValue({}),
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					messageThreadId: 2024,
					operationalAlertsChangedAt: null
				}),
				update: jest.fn()
			},
			consumerReceipt: {
				updateMany: jest.fn()
			},
			reportingConsumerFailure: {
				updateMany: jest.fn()
			},
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'daily-summary' }])
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (value: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const metrics = { increment: jest.fn() };
		const service = new ProjectionService(
			prisma as never,
			metrics as never
		);

		await expect(
			service.applyOperationsNotificationRouting(
				{
					schemaVersion: 1,
					eventId: '88888888-8888-4888-8888-888888888888',
					operationalAlertsThreadId: 2024,
					changedAt: '2026-08-26T00:00:00.000Z'
				},
				{
					eventId: '88888888-8888-4888-8888-888888888888',
					consumer: 'reporting-settings-v1',
					lockToken: '99999999-9999-4999-8999-999999999999'
				}
			)
		).rejects.toThrow(
			'Daily Summary and operational alerts require separate Telegram topics'
		);

		expect(transaction.reportingSettings.update).not.toHaveBeenCalled();
		expect(transaction.consumerReceipt.updateMany).not.toHaveBeenCalled();
		expect(metrics.increment).not.toHaveBeenCalled();
	});
});
