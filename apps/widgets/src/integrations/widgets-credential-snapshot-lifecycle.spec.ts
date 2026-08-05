import type { Prisma } from '@prisma/widgets-client';
import type { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import {
	cleanupTerminalWidgetsCredentialSnapshots,
	deleteTerminalWidgetsCredentialSnapshot
} from './widgets-credential-snapshot-lifecycle';

describe('Widgets credential snapshot lifecycle', () => {
	it('deletes a snapshot through the caller terminal-state transaction', async () => {
		const transaction = {
			integrationCredentialSnapshot: {
				deleteMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		} as unknown as Prisma.TransactionClient;

		await deleteTerminalWidgetsCredentialSnapshot(transaction, {
			eventId: '11111111-1111-4111-8111-111111111111',
			integration: 'webhook'
		});

		expect(
			transaction.integrationCredentialSnapshot.deleteMany
		).toHaveBeenCalledWith({
			where: {
				eventId: '11111111-1111-4111-8111-111111111111',
				integration: 'webhook'
			}
		});
	});

	it('deletes only old terminal snapshots without unresolved failures', async () => {
		const prisma = {
			integrationDeliveryReceipt: {
				findMany: jest.fn().mockResolvedValue([
					{ eventId: 'event-delivered', integration: 'webhook' },
					{ eventId: 'event-unresolved', integration: 'bitrix24' }
				])
			},
			integrationDeliveryFailure: {
				findMany: jest
					.fn()
					.mockResolvedValue([
						{ eventId: 'event-unresolved', integration: 'bitrix24' }
					])
			},
			integrationCredentialSnapshot: {
				deleteMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		} as unknown as WidgetsPrismaService;
		const cutoff = new Date('2026-05-01T00:00:00.000Z');

		await expect(
			cleanupTerminalWidgetsCredentialSnapshots(prisma, {
				cutoff,
				batchSize: 100
			})
		).resolves.toBe(1);

		expect(
			prisma.integrationDeliveryReceipt.findMany
		).toHaveBeenCalledWith(
			expect.objectContaining({ take: 100, where: expect.any(Object) })
		);
		expect(
			prisma.integrationCredentialSnapshot.deleteMany
		).toHaveBeenCalledWith({
			where: {
				OR: [{ eventId: 'event-delivered', integration: 'webhook' }]
			}
		});
	});

	it('does not issue a delete when every terminal candidate is unresolved', async () => {
		const prisma = {
			integrationDeliveryReceipt: {
				findMany: jest
					.fn()
					.mockResolvedValue([
						{ eventId: 'event-unresolved', integration: 'amo-crm' }
					])
			},
			integrationDeliveryFailure: {
				findMany: jest
					.fn()
					.mockResolvedValue([
						{ eventId: 'event-unresolved', integration: 'amo-crm' }
					])
			},
			integrationCredentialSnapshot: { deleteMany: jest.fn() }
		} as unknown as WidgetsPrismaService;

		await expect(
			cleanupTerminalWidgetsCredentialSnapshots(prisma, {
				cutoff: new Date(),
				batchSize: 100
			})
		).resolves.toBe(0);
		expect(
			prisma.integrationCredentialSnapshot.deleteMany
		).not.toHaveBeenCalled();
	});
});
