import type { Prisma } from '@prisma/widgets-client';
import type { WidgetsReportingSequenceService } from '../reporting/widgets-reporting-sequence.service';
import {
	projectionStateHash,
	type WidgetsProjectionEvent
} from './widgets-projection.contract';
import { WidgetsProjectionService } from './widgets-projection.service';

const identityEvent = {
	schemaVersion: 1,
	eventType: 'identity.user.changed.v1',
	eventId: '11111111-1111-4111-8111-111111111111',
	aggregateId: 'user-1',
	aggregateVersion: '1',
	sourceSequence: '1',
	occurredAt: '2026-08-04T12:00:00.000Z',
	tombstone: false,
	state: {
		id: 'user-1',
		createdAt: '2026-08-04T12:00:00.000Z',
		updatedAt: '2026-08-04T12:00:00.000Z',
		deletedAt: null,
		status: 'ACTIVE',
		roles: ['USER'],
		hasEmailIdentity: true,
		hasPhoneIdentity: false,
		hasTelegramIdentity: false,
		loginMethodCount: 1
	}
} satisfies WidgetsProjectionEvent;

const entitlementEvent = {
	schemaVersion: 1,
	eventType: 'billing.subscription.changed.v1',
	eventId: '22222222-2222-4222-8222-222222222222',
	aggregateId: 'subscription-1',
	aggregateVersion: '1',
	sourceSequence: '2',
	occurredAt: '2026-08-04T12:00:00.000Z',
	tombstone: false,
	state: {
		id: 'subscription-1',
		userId: 'user-1',
		plan: 'EASY',
		billingPeriod: 'MONTHLY',
		status: 'ACTIVE',
		startsAt: '2026-08-04T12:00:00.000Z',
		expiresAt: '2026-09-04T12:00:00.000Z',
		periodResetsAt: '2026-09-04T12:00:00.000Z',
		maxWidgets: 1,
		maxLeadsPerPeriod: 100,
		unlimited: false,
		createdAt: '2026-08-04T12:00:00.000Z'
	}
} satisfies WidgetsProjectionEvent;

function transactionFixture(
	current: Record<string, unknown> | null = null
) {
	return {
		$executeRaw: jest.fn().mockResolvedValue(1),
		widgetAggregateVersion: {
			findUnique: jest.fn().mockResolvedValue(current),
			upsert: jest.fn().mockResolvedValue({})
		},
		widgetOwnerProjection: {
			upsert: jest.fn().mockResolvedValue({})
		},
		widgetEntitlementProjection: {
			findUnique: jest.fn().mockResolvedValue(null),
			delete: jest.fn().mockResolvedValue({}),
			upsert: jest.fn().mockResolvedValue({})
		},
		widgetUsageCounter: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockResolvedValue({})
		}
	};
}

function projectionService(): WidgetsProjectionService {
	return new WidgetsProjectionService(
		{} as WidgetsReportingSequenceService
	);
}

describe('WidgetsProjectionService', () => {
	it('uses the Identity aggregate namespace and a balanced advisory lock', async () => {
		const transaction = transactionFixture();

		await expect(
			projectionService().applyInTransaction(
				transaction as unknown as Prisma.TransactionClient,
				identityEvent
			)
		).resolves.toBe('applied');

		expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
		const [segments] = transaction.$executeRaw.mock.calls[0];
		const sql = (segments as TemplateStringsArray).join('?');
		let depth = 0;
		for (const character of sql) {
			if (character === '(') depth += 1;
			if (character === ')') depth -= 1;
			expect(depth).toBeGreaterThanOrEqual(0);
		}
		expect(depth).toBe(0);
		expect(
			transaction.widgetAggregateVersion.findUnique
		).toHaveBeenCalledWith({
			where: {
				aggregateType_aggregateId: {
					aggregateType: 'identity.user',
					aggregateId: identityEvent.aggregateId
				}
			}
		});
		expect(transaction.widgetAggregateVersion.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					aggregateType_aggregateId: {
						aggregateType: 'identity.user',
						aggregateId: identityEvent.aggregateId
					}
				},
				create: expect.objectContaining({ aggregateType: 'identity.user' })
			})
		);
	});

	it('uses the Billing aggregate namespace for entitlement projections', async () => {
		const transaction = transactionFixture();

		await expect(
			projectionService().applyInTransaction(
				transaction as unknown as Prisma.TransactionClient,
				entitlementEvent
			)
		).resolves.toBe('applied');

		expect(
			transaction.widgetAggregateVersion.findUnique
		).toHaveBeenCalledWith({
			where: {
				aggregateType_aggregateId: {
					aggregateType: 'billing.subscription',
					aggregateId: entitlementEvent.aggregateId
				}
			}
		});
		expect(transaction.widgetAggregateVersion.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					aggregateType_aggregateId: {
						aggregateType: 'billing.subscription',
						aggregateId: entitlementEvent.aggregateId
					}
				},
				create: expect.objectContaining({
					aggregateType: 'billing.subscription'
				})
			})
		);
	});

	it('keeps an identical aggregate version idempotent', async () => {
		const transaction = transactionFixture({
			version: 1n,
			sourceSequence: 1n,
			stateHash: projectionStateHash(identityEvent)
		});

		await expect(
			projectionService().applyInTransaction(
				transaction as unknown as Prisma.TransactionClient,
				identityEvent
			)
		).resolves.toBe('duplicate');

		expect(
			transaction.widgetOwnerProjection.upsert
		).not.toHaveBeenCalled();
		expect(
			transaction.widgetAggregateVersion.upsert
		).not.toHaveBeenCalled();
	});

	it('ignores an older aggregate version as stale', async () => {
		const transaction = transactionFixture({
			version: 2n,
			sourceSequence: 2n,
			stateHash: '0'.repeat(64)
		});

		await expect(
			projectionService().applyInTransaction(
				transaction as unknown as Prisma.TransactionClient,
				identityEvent
			)
		).resolves.toBe('stale');

		expect(
			transaction.widgetOwnerProjection.upsert
		).not.toHaveBeenCalled();
		expect(
			transaction.widgetAggregateVersion.upsert
		).not.toHaveBeenCalled();
	});
});
