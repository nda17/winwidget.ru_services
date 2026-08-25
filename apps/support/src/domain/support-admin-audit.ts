import { OutboxExchange, Prisma } from '@prisma/support-client';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { SupportActor } from '../auth/support-request';
import {
	getSupportClientContext,
	getSupportCorrelationId
} from '../common/support-request-context';
import {
	SUPPORT_ADMIN_AUDIT_EVENT,
	SUPPORT_ADMIN_AUDIT_ROUTING_KEY
} from '../messaging/support-messaging.constants';

export type SupportAuditAction =
	| 'SUPPORT_ROUTING_SETTINGS_UPDATE'
	| 'SUPPORT_WEBHOOK_REINSTALL'
	| 'SUPPORT_DELIVERY_RETRY'
	| 'SUPPORT_DELIVERY_CLOSE';

export async function enqueueSupportAdminAudit(
	transaction: Prisma.TransactionClient,
	input: {
		actor: SupportActor;
		action: SupportAuditAction;
		description: string;
		entityType: string;
		entityId: string;
		entityLabel: string | null;
		metadata: Record<string, unknown>;
		request: Request;
	}
): Promise<void> {
	const eventId = randomUUID();
	const correlationId = getSupportCorrelationId();
	const context = getSupportClientContext(input.request);
	await transaction.outboxEvent.create({
		data: {
			messageId: eventId,
			exchange: OutboxExchange.AUDIT,
			eventType: SUPPORT_ADMIN_AUDIT_EVENT,
			routingKey: SUPPORT_ADMIN_AUDIT_ROUTING_KEY,
			aggregateType: 'support.admin-audit',
			aggregateId: input.entityId,
			headers: { 'x-correlation-id': correlationId },
			payload: {
				schemaVersion: 1,
				eventType: SUPPORT_ADMIN_AUDIT_EVENT,
				eventId,
				occurredAt: new Date().toISOString(),
				correlationId,
				actorId: input.actor.subject,
				section: 'SUPPORT',
				action: input.action,
				description: input.description,
				entity: {
					type: input.entityType,
					id: input.entityId,
					label: input.entityLabel,
					targetUserId: null
				},
				metadata: {
					...input.metadata,
					actorRole: input.actor.roles.includes('DEV') ? 'DEV' : 'ADMIN',
					requestIp: context.ip,
					requestUserAgent: context.userAgent
				}
			} as Prisma.InputJsonValue
		}
	});
}
