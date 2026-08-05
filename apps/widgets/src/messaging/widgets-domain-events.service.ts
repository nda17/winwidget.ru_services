import { Injectable } from '@nestjs/common';
import { Prisma, WidgetsOutboxExchange } from '@prisma/widgets-client';
import { createHash, randomUUID } from 'node:crypto';
import type { WidgetLeadRecord } from '../domain/widgets-domain.repository';
import {
	asJsonObject,
	getWidgetDefinition,
	WidgetEntity,
	WidgetType
} from '../domain/widgets-domain.types';

const LEAD_EVENT_TYPE = 'lead.integration.requested.v2';
const ADMIN_AUDIT_EVENT_TYPE = 'admin.audit.event.v1';
const ADMIN_AUDIT_ROUTING_KEY = 'admin.audit.widgets.v1';

export type LeadIntegration =
	| 'email'
	| 'telegram'
	| 'webhook'
	| 'bitrix24'
	| 'amo-crm';

export type WidgetsAdminAuditAction =
	| 'WIDGET_UPDATE'
	| 'WIDGET_PUBLISH'
	| 'WIDGET_VERSION_RESTORE'
	| 'WIDGET_CLONE'
	| 'WIDGET_DRAFT_DISCARD'
	| 'WIDGET_BUTTON_IMAGE_UPDATE'
	| 'WIDGET_DELETE'
	| 'WIDGET_DELIVERY_RETRY'
	| 'WIDGET_DELIVERY_CLOSE';

export interface WidgetsAuditInput {
	action: WidgetsAdminAuditAction;
	actorId: string;
	correlationId: string;
	widget: Pick<WidgetEntity, 'id' | 'userId'>;
	widgetType: WidgetType;
	metadata: Prisma.InputJsonObject;
	targetExtra?: Prisma.InputJsonObject;
}

@Injectable()
export class WidgetsDomainEventsService {
	credentialForConfig(
		type: WidgetType,
		config: unknown,
		integration: 'webhook' | 'bitrix24' | 'amo-crm'
	): {
		credentials: Prisma.InputJsonObject;
		targetFingerprint: string;
	} | null {
		const values = asJsonObject(asJsonObject(config).integrations);
		let destination: {
			integration: LeadIntegration;
			value: string | { domain: string; token: string };
		} | null = null;
		if (
			integration === 'webhook' &&
			typeof values.webhookUrl === 'string' &&
			values.webhookUrl.trim()
		) {
			destination = { integration, value: values.webhookUrl.trim() };
		} else if (
			integration === 'bitrix24' &&
			typeof values.bitrix24WebhookUrl === 'string' &&
			values.bitrix24WebhookUrl.trim()
		) {
			destination = {
				integration,
				value: values.bitrix24WebhookUrl.trim()
			};
		} else if (
			integration === 'amo-crm' &&
			type &&
			typeof values.amoCrmDomain === 'string' &&
			values.amoCrmDomain.trim() &&
			typeof values.amoCrmToken === 'string' &&
			values.amoCrmToken.trim()
		) {
			destination = {
				integration,
				value: {
					domain: values.amoCrmDomain.trim(),
					token: values.amoCrmToken.trim()
				}
			};
		}
		return destination
			? {
					credentials: this.credentials(destination),
					targetFingerprint: this.fingerprint(destination)
				}
			: null;
	}

	async enqueueLeadIntegrations(
		transaction: Prisma.TransactionClient,
		input: {
			type: WidgetType;
			widget: Pick<WidgetEntity, 'id' | 'name'>;
			lead: WidgetLeadRecord & { name?: string | null };
			config: unknown;
		}
	): Promise<void> {
		const integrations = asJsonObject(
			asJsonObject(input.config).integrations
		);
		const destinations: Array<{
			integration: LeadIntegration;
			value: string | { domain: string; token: string };
		}> = [];
		this.add(destinations, 'email', integrations.email);
		this.add(destinations, 'telegram', integrations.telegramChatId);
		this.add(destinations, 'webhook', integrations.webhookUrl);
		this.add(destinations, 'bitrix24', integrations.bitrix24WebhookUrl);
		if (
			typeof integrations.amoCrmDomain === 'string' &&
			integrations.amoCrmDomain.trim() &&
			typeof integrations.amoCrmToken === 'string' &&
			integrations.amoCrmToken.trim()
		) {
			destinations.push({
				integration: 'amo-crm',
				value: {
					domain: integrations.amoCrmDomain.trim(),
					token: integrations.amoCrmToken.trim()
				}
			});
		}
		for (const destination of destinations) {
			await this.enqueueLeadIntegration(transaction, input, destination);
		}
	}

	async enqueueLimitReached(
		transaction: Prisma.TransactionClient,
		input: {
			type: WidgetType;
			widget: Pick<WidgetEntity, 'id' | 'name'>;
			config: unknown;
			limit: number;
			periodKey: string | null;
		}
	): Promise<void> {
		const integrations = asJsonObject(
			asJsonObject(input.config).integrations
		);
		const destinations: Array<{
			routingKey: string;
			eventType: string;
			destination: Prisma.InputJsonObject;
		}> = [];
		if (
			typeof integrations.email === 'string' &&
			integrations.email.trim()
		) {
			destinations.push({
				routingKey: 'lead.limit.reached.email.v2',
				eventType: 'lead.limit.reached.email.v2',
				destination: { email: integrations.email.trim().toLowerCase() }
			});
		}
		if (
			typeof integrations.telegramChatId === 'string' &&
			integrations.telegramChatId.trim()
		) {
			destinations.push({
				routingKey: 'lead.limit.reached.telegram.v2',
				eventType: 'lead.limit.reached.telegram.v2',
				destination: { telegramChatId: integrations.telegramChatId.trim() }
			});
		}
		for (const destination of destinations) {
			const id = randomUUID();
			await transaction.widgetsOutboxEvent.create({
				data: {
					messageId: id,
					deduplicationKey: `limit:${input.type}:${input.widget.id}:${input.periodKey || 'unbounded'}:${input.limit}:${destination.routingKey}`,
					exchange: WidgetsOutboxExchange.EVENTS,
					eventType: destination.eventType,
					routingKey: destination.routingKey,
					payload: {
						schemaVersion: 2,
						eventType: destination.eventType,
						entity: {
							id: input.widget.id,
							name: input.widget.name,
							type: getWidgetDefinition(input.type).slug
						},
						limit: input.limit,
						destination: destination.destination
					},
					headers: this.headers(id, input.widget.id)
				}
			});
		}
	}

	async enqueueAdminAudit(
		transaction: Prisma.TransactionClient,
		input: WidgetsAuditInput
	): Promise<void> {
		const eventId = randomUUID();
		const payload = {
			schemaVersion: 1,
			eventType: ADMIN_AUDIT_EVENT_TYPE,
			eventId,
			occurredAt: new Date().toISOString(),
			correlationId: input.correlationId,
			actorId: input.actorId,
			action: input.action,
			target: {
				widgetId: input.widget.id,
				widgetType: input.widgetType,
				ownerId: input.widget.userId,
				...(input.targetExtra || {})
			},
			metadata: input.metadata
		} satisfies Prisma.InputJsonObject;
		await transaction.widgetsOutboxEvent.create({
			data: {
				messageId: eventId,
				deduplicationKey: `admin-audit:${input.action}:${eventId}`,
				exchange: WidgetsOutboxExchange.EVENTS,
				eventType: ADMIN_AUDIT_EVENT_TYPE,
				routingKey: ADMIN_AUDIT_ROUTING_KEY,
				payload,
				headers: this.headers(eventId, input.correlationId)
			}
		});
	}

	private async enqueueLeadIntegration(
		transaction: Prisma.TransactionClient,
		input: {
			type: WidgetType;
			widget: Pick<WidgetEntity, 'id' | 'name'>;
			lead: WidgetLeadRecord & { name?: string | null };
		},
		destination: {
			integration: LeadIntegration;
			value: string | { domain: string; token: string };
		}
	): Promise<void> {
		const eventId = randomUUID();
		let publicDestination: Prisma.InputJsonObject;
		if (destination.integration === 'email') {
			publicDestination = { email: destination.value as string };
		} else if (destination.integration === 'telegram') {
			publicDestination = { telegramChatId: destination.value as string };
		} else {
			const credentialRef = randomUUID();
			const credentials = this.credentials(destination);
			await transaction.integrationCredentialSnapshot.create({
				data: {
					id: credentialRef,
					eventId,
					integration: destination.integration,
					source: this.source(input.type),
					entityId: input.widget.id,
					targetFingerprint: this.fingerprint(destination),
					credentials
				}
			});
			publicDestination = { credentialRef };
		}
		const lead = input.lead;
		const leadPayload = this.compact({
			id: lead.id,
			contact: lead.contact,
			name: lead.name,
			phone: lead.phone,
			email: lead.email,
			bonus: lead.bonus,
			result: lead.result,
			timeSlot: lead.timeSlot,
			timezone: lead.timezone,
			actionLabel: lead.actionLabel,
			actionValue: lead.actionValue,
			calculatedPrice: lead.calculatedPrice?.toString(),
			currency: lead.currency,
			answers: lead.answers,
			url: lead.url,
			createdAt: lead.createdAt.toISOString()
		});
		const source = this.source(input.type);
		const payload = {
			schemaVersion: 2,
			eventType: LEAD_EVENT_TYPE,
			integration: destination.integration,
			source,
			entity: { id: input.widget.id, name: input.widget.name },
			lead: leadPayload,
			destination: publicDestination
		} satisfies Prisma.InputJsonObject;
		const routingKey = `lead.integration.${destination.integration}.v2`;
		await transaction.widgetsOutboxEvent.create({
			data: {
				messageId: eventId,
				deduplicationKey: `lead-delivery:${lead.id}:${destination.integration}`,
				exchange: WidgetsOutboxExchange.EVENTS,
				eventType: LEAD_EVENT_TYPE,
				routingKey,
				payload,
				headers: this.headers(eventId, lead.id)
			}
		});
	}

	private add(
		destinations: Array<{
			integration: LeadIntegration;
			value: string | { domain: string; token: string };
		}>,
		integration: LeadIntegration,
		value: unknown
	): void {
		if (typeof value === 'string' && value.trim()) {
			destinations.push({ integration, value: value.trim() });
		}
	}

	private credentials(destination: {
		integration: LeadIntegration;
		value: string | { domain: string; token: string };
	}): Prisma.InputJsonObject {
		if (destination.integration === 'webhook')
			return { webhookUrl: destination.value as string };
		if (destination.integration === 'bitrix24')
			return { bitrix24WebhookUrl: destination.value as string };
		const amo = destination.value as { domain: string; token: string };
		return { amoCrmDomain: amo.domain, amoCrmToken: amo.token };
	}

	private fingerprint(destination: {
		integration: LeadIntegration;
		value: string | { domain: string; token: string };
	}): string {
		let identity: string;
		if (destination.integration === 'webhook') {
			identity = (destination.value as string).trim();
		} else if (destination.integration === 'bitrix24') {
			identity = (destination.value as string).trim();
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
		} else {
			identity = (destination.value as { domain: string }).domain
				.trim()
				.toLowerCase()
				.replace(/^https?:\/\//, '')
				.replace(/\/+$/, '');
		}
		return createHash('sha256').update(identity).digest('hex');
	}

	private compact(value: Record<string, unknown>): Prisma.InputJsonObject {
		return Object.fromEntries(
			Object.entries(value).filter(([, item]) => item !== undefined)
		) as Prisma.InputJsonObject;
	}

	private source(type: WidgetType): string {
		if (type === WidgetType.WHEEL) return 'widget';
		if (type === WidgetType.TIMER) return 'countdown-timer';
		return getWidgetDefinition(type).slug;
	}

	private headers(
		messageId: string,
		correlationId: string
	): Prisma.InputJsonObject {
		return {
			'x-message-id': messageId,
			'x-correlation-id': correlationId,
			'x-causation-id': correlationId
		};
	}
}
