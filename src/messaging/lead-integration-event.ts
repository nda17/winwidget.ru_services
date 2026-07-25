import {
	INTEGRATION_ROUTING_KEYS,
	LeadIntegrationKind,
	OUTBOX_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

export const LEAD_SOURCES = [
	'widget',
	'quiz',
	'callback',
	'countdown-timer',
	'stop-offer',
	'online-consultant',
	'calculator'
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

export interface LeadIntegrationConfigSnapshot {
	email?: string | null;
	webhookUrl?: string | null;
	telegramChatId?: string | null;
	bitrix24WebhookUrl?: string | null;
	amoCrmDomain?: string | null;
	amoCrmToken?: string | null;
}

export interface LeadIntegrationData {
	id: string;
	contact?: string | null;
	name?: string | null;
	phone?: string | null;
	email?: string | null;
	bonus?: string | null;
	result?: string | null;
	timeSlot?: string | null;
	timezone?: string | null;
	actionLabel?: string | null;
	actionValue?: string | null;
	calculatedPrice?: string | null;
	currency?: string | null;
	answers?: unknown;
	url?: string | null;
	createdAt: Date;
}

type SerializedLeadIntegrationData = Omit<
	LeadIntegrationData,
	'createdAt'
> & {
	createdAt: string;
};

interface LeadIntegrationEventBase {
	integration: LeadIntegrationKind;
	source: LeadSource;
	entity: {
		id: string;
		name: string;
	};
	lead: SerializedLeadIntegrationData;
}

export interface ResolvedLeadIntegrationDestination {
	email?: string;
	webhookUrl?: string;
	telegramChatId?: string;
	bitrix24WebhookUrl?: string;
	amoCrmDomain?: string;
	amoCrmToken?: string;
}

export interface LeadIntegrationEventPayloadV2 extends LeadIntegrationEventBase {
	schemaVersion: 2;
	eventType: typeof OUTBOX_EVENT_TYPE;
	destination:
		| { email: string }
		| { telegramChatId: string }
		| { credentialRef: string };
}

export type LeadIntegrationEventPayload = LeadIntegrationEventPayloadV2;

export interface ResolvedLeadIntegrationEventPayload extends LeadIntegrationEventBase {
	schemaVersion: 2;
	eventType: typeof OUTBOX_EVENT_TYPE;
	destination: ResolvedLeadIntegrationDestination;
}

export interface LeadCredentialSnapshotData {
	eventId: string;
	integration: Extract<
		LeadIntegrationKind,
		'webhook' | 'bitrix24' | 'amo-crm'
	>;
	source: LeadSource;
	entityId: string;
	targetFingerprint: string;
	credentials: Prisma.InputJsonObject;
}

interface EnqueueLeadIntegrationEventsInput {
	source: LeadSource;
	entity: {
		id: string;
		name: string;
	};
	lead: LeadIntegrationData;
	integrations: LeadIntegrationConfigSnapshot | null | undefined;
}

const nonEmpty = (value: string | null | undefined): value is string =>
	typeof value === 'string' && value.trim().length > 0;

const fingerprint = (value: string): string =>
	createHash('sha256').update(value).digest('hex');

export function getLeadTargetFingerprint(
	integration: LeadCredentialSnapshotData['integration'],
	destination: ResolvedLeadIntegrationDestination
): string {
	if (integration === 'webhook' && destination.webhookUrl) {
		return fingerprint(destination.webhookUrl.trim());
	}
	if (integration === 'bitrix24' && destination.bitrix24WebhookUrl) {
		let identity = destination.bitrix24WebhookUrl.trim();
		try {
			const url = new URL(identity);
			const segments = url.pathname.split('/').filter(Boolean);
			const restIndex = segments.findIndex(
				segment => segment.toLowerCase() === 'rest'
			);
			identity =
				restIndex >= 0 && segments[restIndex + 1]
					? `${url.origin.toLowerCase()}/rest/${segments[restIndex + 1]}`
					: url.origin.toLowerCase();
		} catch {}
		return fingerprint(identity);
	}
	if (integration === 'amo-crm' && destination.amoCrmDomain) {
		return fingerprint(
			destination.amoCrmDomain
				.trim()
				.toLowerCase()
				.replace(/^https?:\/\//, '')
				.replace(/\/+$/, '')
		);
	}
	throw new Error(`Integration destination is incomplete: ${integration}`);
}

export function getCredentialSnapshotData(
	eventId: string,
	integration: LeadCredentialSnapshotData['integration'],
	source: LeadSource,
	entityId: string,
	destination: ResolvedLeadIntegrationDestination
): LeadCredentialSnapshotData {
	const credentials: Prisma.InputJsonObject =
		integration === 'webhook'
			? { webhookUrl: destination.webhookUrl as string }
			: integration === 'bitrix24'
				? {
						bitrix24WebhookUrl: destination.bitrix24WebhookUrl as string
					}
				: {
						amoCrmDomain: destination.amoCrmDomain as string,
						amoCrmToken: destination.amoCrmToken as string
					};

	return {
		eventId,
		integration,
		source,
		entityId,
		targetFingerprint: getLeadTargetFingerprint(integration, destination),
		credentials
	};
}

export async function enqueueLeadIntegrationEvents(
	transaction: Prisma.TransactionClient,
	input: EnqueueLeadIntegrationEventsInput
): Promise<void> {
	const integrations = input.integrations;
	if (!integrations) return;

	const destinations: Array<{
		integration: LeadIntegrationKind;
		destination: ResolvedLeadIntegrationDestination;
	}> = [];

	if (nonEmpty(integrations.email)) {
		destinations.push({
			integration: 'email',
			destination: { email: integrations.email.trim() }
		});
	}
	if (nonEmpty(integrations.webhookUrl)) {
		destinations.push({
			integration: 'webhook',
			destination: { webhookUrl: integrations.webhookUrl.trim() }
		});
	}
	if (nonEmpty(integrations.telegramChatId)) {
		destinations.push({
			integration: 'telegram',
			destination: {
				telegramChatId: integrations.telegramChatId.trim()
			}
		});
	}
	if (nonEmpty(integrations.bitrix24WebhookUrl)) {
		destinations.push({
			integration: 'bitrix24',
			destination: {
				bitrix24WebhookUrl: integrations.bitrix24WebhookUrl.trim()
			}
		});
	}
	if (
		nonEmpty(integrations.amoCrmDomain) &&
		nonEmpty(integrations.amoCrmToken)
	) {
		destinations.push({
			integration: 'amo-crm',
			destination: {
				amoCrmDomain: integrations.amoCrmDomain.trim(),
				amoCrmToken: integrations.amoCrmToken.trim()
			}
		});
	}

	if (!destinations.length) return;

	const snapshots: Array<LeadCredentialSnapshotData & { id: string }> = [];
	const outboxEvents = destinations.map(({ integration, destination }) => {
		const eventId = randomUUID();
		let eventDestination: LeadIntegrationEventPayloadV2['destination'];
		if (integration === 'email' && destination.email) {
			eventDestination = { email: destination.email };
		} else if (integration === 'telegram' && destination.telegramChatId) {
			eventDestination = {
				telegramChatId: destination.telegramChatId
			};
		} else if (
			integration === 'webhook' ||
			integration === 'bitrix24' ||
			integration === 'amo-crm'
		) {
			const credentialRef = randomUUID();
			snapshots.push({
				id: credentialRef,
				...getCredentialSnapshotData(
					eventId,
					integration,
					input.source,
					input.entity.id,
					destination
				)
			});
			eventDestination = { credentialRef };
		} else {
			throw new Error(
				`Integration destination is incomplete: ${integration}`
			);
		}
		const payload: LeadIntegrationEventPayloadV2 = {
			schemaVersion: 2,
			eventType: OUTBOX_EVENT_TYPE,
			integration,
			source: input.source,
			entity: input.entity,
			lead: {
				...input.lead,
				createdAt: input.lead.createdAt.toISOString()
			},
			destination: eventDestination
		};

		return {
			id: eventId,
			messageId: eventId,
			eventType: OUTBOX_EVENT_TYPE,
			routingKey: INTEGRATION_ROUTING_KEYS[integration],
			payload: payload as unknown as Prisma.InputJsonValue
		};
	});

	if (snapshots.length) {
		await transaction.integrationCredentialSnapshot.createMany({
			data: snapshots.map(snapshot => ({
				...snapshot,
				credentials: snapshot.credentials
			}))
		});
	}
	await transaction.outboxEvent.createMany({ data: outboxEvents });
}
