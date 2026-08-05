import type { Prisma } from '@prisma/widgets-client';
import { deleteTerminalWidgetsCredentialSnapshot } from './widgets-credential-snapshot-lifecycle';

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
});
