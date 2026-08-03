import {
	ProjectionService,
	ProjectionStateConflictError,
	reportingProjectionStateHash
} from './projection.service';
import type { ReportingSourceEvent } from './reporting-event.contract';
import {
	Prisma,
	ProjectionReceiptResult,
	ReportingOwner
} from '@prisma/reporting-client';

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

	it('accepts snapshot/queue replay with equal version and equal canonical state', async () => {
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

describe('ProjectionService batch locking', () => {
	it('pre-acquires unique aggregate locks in stable order before applying the batch', async () => {
		const transaction = { $executeRaw: jest.fn().mockResolvedValue(1) };
		const prisma = {
			$transaction: jest.fn(
				(callback: (value: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new ProjectionService(
			prisma as never,
			{
				increment: jest.fn()
			} as never
		);
		const apply = jest
			.spyOn(service as never, 'applyInTransaction' as never)
			.mockResolvedValue(ProjectionReceiptResult.APPLIED as never);
		const eventB = { ...EVENT, aggregateId: 'user-b' };
		const eventA = {
			...EVENT,
			eventId: '22222222-2222-4222-8222-222222222222',
			aggregateId: 'user-a'
		};

		await service.applyBatch([eventB, eventA, eventB]);

		expect(
			transaction.$executeRaw.mock.calls.map(call => call[1])
		).toEqual([
			'reporting:identityUser:user-a',
			'reporting:identityUser:user-b'
		]);
		expect(apply).toHaveBeenCalledTimes(3);
		expect(
			transaction.$executeRaw.mock.invocationCallOrder[1]
		).toBeLessThan(apply.mock.invocationCallOrder[0]);
	});
});

describe('ProjectionService shared Telegram routing ownership', () => {
	it('applies the versioned post-cutover Core routing event without legacy fields', async () => {
		const transaction = {
			reportingSettings: {
				upsert: jest.fn().mockResolvedValue({}),
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					owner: ReportingOwner.REPORTING
				}),
				update: jest.fn().mockResolvedValue({})
			},
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'daily-summary' }])
		};
		const event: ReportingSourceEvent<'reporting.core-operational-routing.changed.v1'> =
			{
				schemaVersion: 1,
				eventType: 'reporting.core-operational-routing.changed.v1',
				eventId: '44444444-4444-4444-8444-444444444444',
				aggregateId: 'singleton',
				aggregateVersion: '1',
				sourceSequence: '21',
				occurredAt: '2026-07-31T00:00:00.000Z',
				tombstone: false,
				state: {
					id: 'singleton',
					coreOperationalAlertsDestinationChatId: '-100777',
					coreOperationalAlertsThreadId: 2024
				}
			};
		const service = new ProjectionService({} as never, {} as never);

		await expect(
			(
				service as unknown as {
					applyNewerEvent(
						transaction: unknown,
						stream: 'reportingSettings',
						event: ReportingSourceEvent,
						stateHash: string
					): Promise<ProjectionReceiptResult>;
				}
			).applyNewerEvent(
				transaction,
				'reportingSettings',
				event,
				reportingProjectionStateHash(event)
			)
		).resolves.toBe(ProjectionReceiptResult.APPLIED);

		const update =
			transaction.reportingSettings.update.mock.calls[0][0].data;
		expect(update).toEqual(
			expect.objectContaining({
				coreOperationalAlertsDestinationChatId: '-100777',
				coreOperationalAlertsThreadId: 2024,
				coreOperationalRoutingSourceAggregateVersion: new Prisma.Decimal(
					'1'
				),
				coreOperationalRoutingSourceSequence: new Prisma.Decimal('21')
			})
		);
		expect(update).not.toHaveProperty('destinationChatId');
		expect(update).not.toHaveProperty('scheduleTime');
	});
});
