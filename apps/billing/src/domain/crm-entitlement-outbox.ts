import { Prisma } from '@prisma/billing-client';
import { randomUUID } from 'node:crypto';

/** Wake CRM Access using the existing versioned event, in the caller's transaction. */
export async function enqueueCrmEntitlementChanged(
	tx: Prisma.TransactionClient,
	workspaceId: string
) {
	const base = await tx.crmEntitlement.findUnique({
		where: { workspaceId }
	});
	if (!base) return;
	const now = new Date();
	const period = await tx.crmPaidPeriod.findFirst({
		where: { workspaceId, startsAt: { lte: now } },
		orderBy: [{ startsAt: 'desc' }, { id: 'desc' }]
	});
	const account = await tx.crmCommerceAccount.findUnique({
		where: { workspaceId }
	});
	const counter = await tx.billingSourceSequence.upsert({
		where: { id: 'billing' },
		create: { id: 'billing', nextValue: 2n },
		update: { nextValue: { increment: 1n } }
	});
	const sequence = counter.nextValue - 1n;
	const version =
		(account?.version ?? 0n) > base.aggregateVersion
			? account!.version
			: base.aggregateVersion + 1n;
	await tx.crmEntitlement.update({
		where: { workspaceId },
		data: { sourceSequence: sequence, aggregateVersion: version }
	});
	if (period && !period.activationNotifiedAt) {
		await tx.crmPaidPeriod.update({
			where: { id: period.id },
			data: { activationNotifiedAt: now }
		});
	}
	const eventId = randomUUID();
	await tx.outboxEvent.create({
		data: {
			eventId,
			eventType: 'billing.crm-entitlement.changed.v1',
			aggregateType: 'billing.crm-entitlement',
			aggregateId: base.id,
			aggregateVersion: version,
			sourceSequence: sequence,
			exchange: 'winwidget.events',
			routingKey: 'billing.crm-entitlement.changed.v1',
			payload: {
				schemaVersion: 1,
				eventType: 'billing.crm-entitlement.changed.v1',
				eventId,
				aggregateId: base.id,
				aggregateVersion: version.toString(),
				sourceSequence: sequence.toString(),
				occurredAt: now.toISOString(),
				tombstone: false,
				state: {
					workspaceId,
					productCode: 'WINCRM',
					planCode: period ? 'PAID' : base.planCode,
					status: base.status,
					seatLimit: period?.totalSeats ?? base.seatLimit,
					effectiveFrom: (
						period?.startsAt ?? base.effectiveFrom
					).toISOString(),
					effectiveUntil: (
						period?.expiresAt ?? base.effectiveUntil
					).toISOString()
				}
			}
		}
	});
}
