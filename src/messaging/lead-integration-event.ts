import {
	INTEGRATION_ROUTING_KEYS,
	LeadIntegrationKind,
	OUTBOX_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { Prisma } from '@prisma/client';

export type LeadSource =
	| 'widget'
	| 'quiz'
	| 'callback'
	| 'countdown-timer'
	| 'stop-offer'
	| 'online-consultant'
	| 'calculator';

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

export interface LeadIntegrationEventPayload {
	schemaVersion: 1;
	integration: LeadIntegrationKind;
	source: LeadSource;
	entity: {
		id: string;
		name: string;
	};
	lead: Omit<LeadIntegrationData, 'createdAt'> & {
		createdAt: string;
	};
	destination: {
		email?: string;
		webhookUrl?: string;
		telegramChatId?: string;
		bitrix24WebhookUrl?: string;
		amoCrmDomain?: string;
		amoCrmToken?: string;
	};
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

export async function enqueueLeadIntegrationEvents(
	transaction: Prisma.TransactionClient,
	input: EnqueueLeadIntegrationEventsInput
): Promise<void> {
	const integrations = input.integrations;
	if (!integrations) return;

	const destinations: Array<{
		integration: LeadIntegrationKind;
		destination: LeadIntegrationEventPayload['destination'];
	}> = [];

	if (nonEmpty(integrations.email)) {
		destinations.push({
			integration: 'email',
			destination: { email: integrations.email }
		});
	}
	if (nonEmpty(integrations.webhookUrl)) {
		destinations.push({
			integration: 'webhook',
			destination: { webhookUrl: integrations.webhookUrl }
		});
	}
	if (nonEmpty(integrations.telegramChatId)) {
		destinations.push({
			integration: 'telegram',
			destination: { telegramChatId: integrations.telegramChatId }
		});
	}
	if (nonEmpty(integrations.bitrix24WebhookUrl)) {
		destinations.push({
			integration: 'bitrix24',
			destination: {
				bitrix24WebhookUrl: integrations.bitrix24WebhookUrl
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
				amoCrmDomain: integrations.amoCrmDomain,
				amoCrmToken: integrations.amoCrmToken
			}
		});
	}

	if (!destinations.length) return;

	await transaction.outboxEvent.createMany({
		data: destinations.map(({ integration, destination }) => {
			const payload: LeadIntegrationEventPayload = {
				schemaVersion: 1,
				integration,
				source: input.source,
				entity: input.entity,
				lead: {
					...input.lead,
					createdAt: input.lead.createdAt.toISOString()
				},
				destination
			};

			return {
				eventType: OUTBOX_EVENT_TYPE,
				routingKey: INTEGRATION_ROUTING_KEYS[integration],
				payload: payload as unknown as Prisma.InputJsonValue
			};
		})
	});
}
