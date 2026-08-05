import {
	IntegrationDeliveryReceiptStatus,
	Prisma
} from '@prisma/widgets-client';
import type { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
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

/**
 * Removes leftovers created by older releases. The bounded candidate set is
 * terminal first, then filtered against unresolved failures before deletion.
 */
export async function cleanupTerminalWidgetsCredentialSnapshots(
	prisma: WidgetsPrismaService,
	input: { cutoff: Date; batchSize: number }
): Promise<number> {
	if (
		!Number.isInteger(input.batchSize) ||
		input.batchSize < 1 ||
		input.batchSize > 1000
	) {
		throw new Error(
			'Widgets credential snapshot cleanup batch must be between 1 and 1000'
		);
	}
	const receipts = await prisma.integrationDeliveryReceipt.findMany({
		where: {
			status: {
				in: [
					IntegrationDeliveryReceiptStatus.DELIVERED,
					IntegrationDeliveryReceiptStatus.CLOSED_NO_RETRY
				]
			},
			updatedAt: { lte: input.cutoff }
		},
		orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
		take: input.batchSize,
		select: { eventId: true, integration: true }
	});
	if (!receipts.length) return 0;
	const keys = receipts.map(receipt => ({
		eventId: receipt.eventId,
		integration: receipt.integration as WidgetsProviderKind
	}));
	const unresolved = await prisma.integrationDeliveryFailure.findMany({
		where: {
			resolvedAt: null,
			OR: keys.map(key => ({
				eventId: key.eventId,
				integration: key.integration
			}))
		},
		select: { eventId: true, integration: true }
	});
	const blocked = new Set(
		unresolved.map(row => `${row.eventId}:${row.integration}`)
	);
	const eligible = keys.filter(
		key => !blocked.has(`${key.eventId}:${key.integration}`)
	);
	if (!eligible.length) return 0;
	const result = await prisma.integrationCredentialSnapshot.deleteMany({
		where: {
			OR: eligible.map(key => ({
				eventId: key.eventId,
				integration: key.integration
			}))
		}
	});
	return result.count;
}
