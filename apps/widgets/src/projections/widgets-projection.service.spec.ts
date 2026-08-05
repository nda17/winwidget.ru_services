import type { Prisma } from '@prisma/widgets-client';
import type { WidgetsReportingSequenceService } from '../reporting/widgets-reporting-sequence.service';
import type { WidgetsProjectionEvent } from './widgets-projection.contract';
import { WidgetsProjectionService } from './widgets-projection.service';

const event: WidgetsProjectionEvent = {
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
};

describe('WidgetsProjectionService', () => {
	it('applies an owner projection with a syntactically balanced advisory lock', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			widgetAggregateVersion: {
				findUnique: jest.fn().mockResolvedValue(null),
				upsert: jest.fn().mockResolvedValue({})
			},
			widgetOwnerProjection: {
				upsert: jest.fn().mockResolvedValue({})
			}
		} as unknown as Prisma.TransactionClient;
		const service = new WidgetsProjectionService(
			{} as WidgetsReportingSequenceService
		);

		await expect(
			service.applyInTransaction(transaction, event)
		).resolves.toBe('applied');

		expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
		const [segments] = (transaction.$executeRaw as jest.Mock).mock
			.calls[0];
		const sql = (segments as TemplateStringsArray).join('?');
		let depth = 0;
		for (const character of sql) {
			if (character === '(') depth += 1;
			if (character === ')') depth -= 1;
			expect(depth).toBeGreaterThanOrEqual(0);
		}
		expect(depth).toBe(0);
		expect(transaction.widgetOwnerProjection.upsert).toHaveBeenCalledTimes(
			1
		);
		expect(
			transaction.widgetAggregateVersion.upsert
		).toHaveBeenCalledTimes(1);
	});
});
