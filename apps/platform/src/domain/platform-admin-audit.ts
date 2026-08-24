import { Prisma } from '@prisma/platform-client';
import { randomUUID } from 'node:crypto';
import type { PlatformActor } from '../auth/platform-request';
import { getPlatformCorrelationId } from '../common/platform-request-context';
import {
	PLATFORM_ADMIN_AUDIT_ROUTING_KEY,
	PLATFORM_EVENTS_EXCHANGE,
	PLATFORM_EVENT_TYPES
} from '../messaging/platform-messaging.constants';

export type PlatformAuditAction =
	| 'PLATFORM_SITE_SETTINGS_UPDATE'
	| 'PLATFORM_LEGAL_PAGE_UPDATE'
	| 'PLATFORM_HOME_PAGE_CONTENT_UPDATE'
	| 'PLATFORM_HOME_PAGE_RAW_CODE_UPDATE';

export interface PlatformAdminAuditInput {
	actor: PlatformActor;
	action: PlatformAuditAction;
	description: string;
	entity: { type: string; id: string; label: string | null };
	metadata: Record<string, unknown>;
	ip?: string | null;
	userAgent?: string | null;
}

export async function enqueuePlatformAdminAudit(
	transaction: Prisma.TransactionClient,
	input: PlatformAdminAuditInput
): Promise<void> {
	const eventId = randomUUID();
	const correlationId = getPlatformCorrelationId();
	const requestIp = boundedContext(input.ip, 128);
	const requestUserAgent = boundedContext(input.userAgent, 500);
	await transaction.outboxEvent.create({
		data: {
			eventId,
			eventType: PLATFORM_EVENT_TYPES.adminAudit,
			aggregateType: 'platform.admin-audit',
			aggregateId: input.entity.id,
			correlationId,
			exchange: PLATFORM_EVENTS_EXCHANGE,
			routingKey: PLATFORM_ADMIN_AUDIT_ROUTING_KEY,
			payload: {
				schemaVersion: 1,
				eventType: PLATFORM_EVENT_TYPES.adminAudit,
				eventId,
				occurredAt: new Date().toISOString(),
				correlationId,
				actorId: input.actor.subject,
				section: 'PLATFORM_CONTENT',
				action: input.action,
				description: input.description,
				entity: {
					...input.entity,
					targetUserId: null
				},
				metadata: {
					...input.metadata,
					actorRole: input.actor.roles.includes('DEV') ? 'DEV' : 'ADMIN',
					requestIp,
					requestUserAgent
				}
			} as Prisma.InputJsonValue
		}
	});
}

function boundedContext(
	value: string | null | undefined,
	maxLength: number
): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	return normalized ? normalized.slice(0, maxLength) : null;
}
