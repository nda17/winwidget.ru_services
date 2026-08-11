import { Prisma } from '@prisma/billing-client';
import { randomUUID } from 'node:crypto';
import {
	BILLING_ADMIN_AUDIT_ROUTING_KEY,
	BILLING_EVENT_TYPES,
	BILLING_EVENTS_EXCHANGE
} from '../messaging/billing-messaging.constants';
import { getBillingCorrelationId } from '../common/billing-request-context';

export const BILLING_ADMIN_AUDIT_ACTIONS = [
	'PAYMENT_MANUAL_CHECK',
	'PAYMENT_CLEANUP_RUN',
	'TARIFF_PRICES_UPDATE',
	'SUBSCRIPTION_ACTIVATE',
	'SUBSCRIPTION_EXTEND_DAYS',
	'SUBSCRIPTION_CANCEL',
	'SUBSCRIPTION_EXPIRY_CHECK_RUN',
	'AUTO_RENEWAL_ADMIN_PAUSE',
	'AUTO_RENEWAL_ADMIN_RESUME',
	'AUTO_RENEWAL_REVOKE',
	'AUTO_RENEWAL_RECONCILE',
	'AUTO_RENEWAL_TECHNICAL_RESUME',
	'AFFILIATE_SETTINGS_UPDATE',
	'SITE_SETTINGS_UPDATE',
	'BILLING_DELIVERY_RETRY'
] as const;

export type BillingAdminAuditAction =
	(typeof BILLING_ADMIN_AUDIT_ACTIONS)[number];
export type BillingAdminAuditSection =
	| 'PAYMENTS'
	| 'SUBSCRIPTIONS'
	| 'AFFILIATE'
	| 'SITE_SETTINGS'
	| 'TASKS'
	| 'MESSAGING';

export interface BillingAdminActor {
	id: string;
	role: 'ADMIN' | 'DEV';
	ip?: string | null;
	userAgent?: string | null;
}

export interface BillingAdminAuditInput {
	actor: BillingAdminActor;
	section: BillingAdminAuditSection;
	action: BillingAdminAuditAction;
	description: string;
	entity: {
		type: string;
		id: string;
		label: string | null;
		targetUserId: string | null;
	};
	metadata?: Record<string, unknown>;
	correlationId?: string;
}

export async function enqueueBillingAdminAudit(
	transaction: Prisma.TransactionClient,
	input: BillingAdminAuditInput
): Promise<void> {
	const eventId = randomUUID();
	const occurredAt = new Date().toISOString();
	const correlationId = input.correlationId || getBillingCorrelationId();
	await transaction.outboxEvent.create({
		data: {
			eventId,
			eventType: BILLING_EVENT_TYPES.adminAudit,
			aggregateType: 'billing.admin-audit',
			aggregateId: input.entity.id,
			correlationId,
			exchange: BILLING_EVENTS_EXCHANGE,
			routingKey: BILLING_ADMIN_AUDIT_ROUTING_KEY,
			payload: {
				schemaVersion: 1,
				eventType: BILLING_EVENT_TYPES.adminAudit,
				eventId,
				occurredAt,
				correlationId,
				actorId: input.actor.id,
				section: input.section,
				action: input.action,
				description: input.description,
				entity: input.entity,
				metadata: {
					actorRole: input.actor.role,
					...(input.metadata || {})
				}
			} as Prisma.InputJsonValue
		}
	});
}
