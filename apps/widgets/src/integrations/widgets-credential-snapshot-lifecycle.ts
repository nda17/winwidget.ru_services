import { Prisma } from '@prisma/widgets-client';
import type { WidgetsProviderKind } from '../messaging/widgets-messaging.constants';

interface SnapshotKey {
	eventId: string;
	integration: WidgetsProviderKind;
}

/**
 * Call only in the transaction that moves the delivery to DELIVERED or
 * CLOSED_NO_RETRY. DEAD_LETTERED deliveries retain the snapshot for manual retry.
 */
export async function deleteTerminalWidgetsCredentialSnapshot(
	transaction: Prisma.TransactionClient,
	key: SnapshotKey
): Promise<void> {
	await transaction.integrationCredentialSnapshot.deleteMany({
		where: { eventId: key.eventId, integration: key.integration }
	});
}
