import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/widgets-client';
import { createHash } from 'node:crypto';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import { WidgetsProviderKind } from '../messaging/widgets-messaging.constants';
import { WidgetsSafeHttpService } from './widgets-safe-http.service';

export const WIDGETS_INTEGRATION_MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_STRING_LENGTH = 10_000;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEAD_SOURCES = [
	'widget',
	'quiz',
	'callback',
	'countdown-timer',
	'stop-offer',
	'online-consultant',
	'calculator'
] as const;
const OPTIONAL_LEAD_FIELDS = [
	'contact',
	'name',
	'phone',
	'email',
	'bonus',
	'result',
	'timeSlot',
	'timezone',
	'actionLabel',
	'actionValue',
	'calculatedPrice',
	'currency',
	'answers',
	'url'
] as const;
const FORBIDDEN_PAYLOAD_KEYS = new Set([
	'amocrmtoken',
	'apikey',
	'authorization',
	'bitrix24webhookurl',
	'databaseurl',
	'password',
	'refreshtoken',
	'secret',
	'secretkey',
	'smtppassword',
	'telegrambottoken',
	'token',
	'webhookurl'
]);

export type WidgetsLeadSource = (typeof LEAD_SOURCES)[number];

export interface WidgetsLeadIntegrationEvent {
	schemaVersion: 2;
	eventType: 'lead.integration.requested.v2';
	integration: WidgetsProviderKind;
	source: WidgetsLeadSource;
	entity: { id: string; name: string };
	lead: {
		id: string;
		createdAt: string;
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
	};
	destination: { credentialRef: string };
}

export class WidgetsIntegrationDestinationError extends Error {
	constructor(
		readonly code:
			| 'DESTINATION_SNAPSHOT_MISSING'
			| 'DESTINATION_SNAPSHOT_INVALID'
			| 'DESTINATION_CONFIGURATION_MISSING'
			| 'DESTINATION_TARGET_CHANGED',
		message: string
	) {
		super(message);
		this.name = 'WidgetsIntegrationDestinationError';
	}
}

export function assertWidgetsIntegrationMessageSize(
	content: Buffer,
	maximumBytes = WIDGETS_INTEGRATION_MAX_MESSAGE_BYTES
): void {
	if (
		!Number.isInteger(maximumBytes) ||
		maximumBytes < 1024 ||
		maximumBytes > 10 * 1024 * 1024
	) {
		throw new Error('Widgets integration message limit is invalid');
	}
	if (!content.length || content.length > maximumBytes) {
		throw new Error(
			`Widgets integration message size is invalid bytes=${content.length}`
		);
	}
}

@Injectable()
export class WidgetsIntegrationDeliveryService {
	constructor(
		private readonly prisma: WidgetsPrismaService,
		private readonly http: WidgetsSafeHttpService
	) {}

	parse(
		value: unknown,
		expected: WidgetsProviderKind
	): WidgetsLeadIntegrationEvent {
		const event = this.exactRecord(
			value,
			[
				'schemaVersion',
				'eventType',
				'integration',
				'source',
				'entity',
				'lead',
				'destination'
			],
			[],
			'payload'
		);
		this.assertNoForbiddenFields(event);
		if (
			event.schemaVersion !== 2 ||
			event.eventType !== 'lead.integration.requested.v2'
		) {
			throw new Error('Invalid lead integration contract version');
		}
		if (event.integration !== expected) {
			throw new Error('Lead integration kind does not match the consumer');
		}
		if (!LEAD_SOURCES.includes(event.source as WidgetsLeadSource)) {
			throw new Error('Invalid lead source');
		}
		const entity = this.exactRecord(
			event.entity,
			['id', 'name'],
			[],
			'payload.entity'
		);
		this.assertString(entity.id, 'payload.entity.id');
		this.assertString(entity.name, 'payload.entity.name');
		const lead = this.exactRecord(
			event.lead,
			['id', 'createdAt'],
			OPTIONAL_LEAD_FIELDS,
			'payload.lead'
		);
		this.assertString(lead.id, 'payload.lead.id');
		this.assertIsoDate(lead.createdAt, 'payload.lead.createdAt');
		for (const field of OPTIONAL_LEAD_FIELDS) {
			if (field !== 'answers') {
				this.assertOptionalString(lead[field], `payload.lead.${field}`);
			}
		}
		const destination = this.exactRecord(
			event.destination,
			['credentialRef'],
			[],
			'payload.destination'
		);
		if (
			typeof destination.credentialRef !== 'string' ||
			!UUID_PATTERN.test(destination.credentialRef)
		) {
			throw new Error('payload.destination.credentialRef must be a UUID');
		}
		return event as unknown as WidgetsLeadIntegrationEvent;
	}

	async deliver(
		kind: WidgetsProviderKind,
		eventId: string,
		event: WidgetsLeadIntegrationEvent
	): Promise<void> {
		const snapshot =
			await this.prisma.integrationCredentialSnapshot.findUnique({
				where: { id: event.destination.credentialRef }
			});
		if (!snapshot) {
			throw new WidgetsIntegrationDestinationError(
				'DESTINATION_SNAPSHOT_MISSING',
				'Integration credential snapshot is missing'
			);
		}
		if (
			snapshot.eventId !== eventId ||
			snapshot.integration !== kind ||
			snapshot.source !== event.source ||
			snapshot.entityId !== event.entity.id ||
			snapshot.version < 1
		) {
			throw new WidgetsIntegrationDestinationError(
				'DESTINATION_SNAPSHOT_INVALID',
				'Integration credential snapshot does not match the lead event'
			);
		}
		const credentials = this.credentials(kind, snapshot.credentials);
		const fingerprint = this.targetFingerprint(kind, credentials);
		if (snapshot.targetFingerprint !== fingerprint) {
			throw new WidgetsIntegrationDestinationError(
				'DESTINATION_TARGET_CHANGED',
				'Integration credential snapshot target fingerprint does not match'
			);
		}
		if (kind === 'webhook') {
			await this.http.postJson(
				credentials.webhookUrl as string,
				{
					eventId,
					eventType: 'lead.created.v1',
					source: event.source,
					entity: event.entity,
					lead: event.lead
				},
				{
					policy: 'webhook',
					headers: { 'X-WinWidget-Event-Id': eventId }
				}
			);
			return;
		}
		if (kind === 'bitrix24') {
			const fields: Record<string, unknown> = {
				TITLE: this.buildLeadTitle(event),
				SOURCE_ID: 'WEB',
				COMMENTS: this.buildComments(event)
			};
			if (event.lead.name) fields.NAME = event.lead.name;
			if (event.lead.phone) {
				fields.PHONE = [{ VALUE: event.lead.phone, VALUE_TYPE: 'WORK' }];
			}
			if (event.lead.email) {
				fields.EMAIL = [{ VALUE: event.lead.email, VALUE_TYPE: 'WORK' }];
			}
			const base = (credentials.bitrix24WebhookUrl as string).replace(
				/\/$/,
				''
			);
			await this.http.postJson(
				`${base}/crm.lead.add.json`,
				{ fields },
				{ policy: 'bitrix24' }
			);
			return;
		}
		const contactFields: Array<Record<string, unknown>> = [];
		if (event.lead.phone) {
			contactFields.push({
				field_code: 'PHONE',
				values: [{ value: event.lead.phone, enum_code: 'WORK' }]
			});
		}
		if (event.lead.email) {
			contactFields.push({
				field_code: 'EMAIL',
				values: [{ value: event.lead.email, enum_code: 'WORK' }]
			});
		}
		const contact = {
			...(event.lead.name ? { first_name: event.lead.name } : {}),
			...(contactFields.length
				? { custom_fields_values: contactFields }
				: {})
		};
		await this.http.postJson(
			this.http.amoApiUrl(credentials.amoCrmDomain as string),
			[
				{
					name: this.buildLeadTitle(event),
					_embedded: { contacts: [contact] },
					custom_fields_values: [
						{
							field_code: 'DESCRIPTION',
							values: [{ value: this.buildComments(event) }]
						}
					]
				}
			],
			{
				policy: 'amo-crm',
				headers: {
					Authorization: `Bearer ${credentials.amoCrmToken as string}`
				}
			}
		);
	}

	private credentials(
		kind: WidgetsProviderKind,
		value: Prisma.JsonValue
	): Record<string, string> {
		const required =
			kind === 'webhook'
				? ['webhookUrl']
				: kind === 'bitrix24'
					? ['bitrix24WebhookUrl']
					: ['amoCrmDomain', 'amoCrmToken'];
		const record = this.exactRecord(
			value,
			required,
			[],
			'credentialSnapshot.credentials'
		);
		for (const key of required) {
			try {
				this.assertString(
					record[key],
					`credentialSnapshot.credentials.${key}`
				);
			} catch {
				throw new WidgetsIntegrationDestinationError(
					'DESTINATION_CONFIGURATION_MISSING',
					'Integration destination configuration is incomplete'
				);
			}
		}
		return Object.fromEntries(
			required.map(key => [key, String(record[key]).trim()])
		);
	}

	private targetFingerprint(
		kind: WidgetsProviderKind,
		credentials: Record<string, string>
	): string {
		if (kind === 'webhook') {
			return this.fingerprint(credentials.webhookUrl);
		}
		if (kind === 'bitrix24') {
			let identity = credentials.bitrix24WebhookUrl;
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
			return this.fingerprint(identity);
		}
		return this.fingerprint(
			credentials.amoCrmDomain
				.toLowerCase()
				.replace(/^https?:\/\//, '')
				.replace(/\/+$/, '')
		);
	}

	private fingerprint(value: string): string {
		return createHash('sha256').update(value.trim()).digest('hex');
	}

	private buildLeadTitle(event: WidgetsLeadIntegrationEvent): string {
		const outcome = this.outcome(event);
		return `Заявка с виджета «${event.entity.name}»${outcome ? ` — ${outcome}` : ''}`;
	}

	private buildComments(event: WidgetsLeadIntegrationEvent): string {
		const detail = this.detail(event);
		const outcome = this.outcome(event);
		return [
			`${this.sourceLabel(event.source)}: ${event.entity.name}`,
			event.lead.contact ? `Контакт: ${event.lead.contact}` : '',
			outcome ? `Результат: ${outcome}` : '',
			detail ? `${detail.label}: ${detail.value}` : '',
			event.lead.timeSlot ? `Время: ${event.lead.timeSlot}` : '',
			event.lead.timezone ? `Часовой пояс: ${event.lead.timezone}` : '',
			event.lead.url ? `Страница: ${event.lead.url}` : ''
		]
			.filter(Boolean)
			.join('\n');
	}

	private outcome(event: WidgetsLeadIntegrationEvent): string | null {
		return (
			event.lead.bonus ||
			event.lead.result ||
			(event.lead.calculatedPrice
				? `${event.lead.calculatedPrice} ${event.lead.currency || ''}`.trim()
				: null)
		);
	}

	private detail(
		event: WidgetsLeadIntegrationEvent
	): { label: string; value: string } | null {
		if (event.lead.actionLabel && event.lead.actionValue) {
			return {
				label: event.lead.actionLabel,
				value: event.lead.actionValue
			};
		}
		if (event.lead.timeSlot) {
			return {
				label: 'Желаемое время',
				value: [
					event.lead.timeSlot,
					event.lead.timezone ? `(${event.lead.timezone})` : ''
				]
					.filter(Boolean)
					.join(' ')
			};
		}
		return null;
	}

	private sourceLabel(source: WidgetsLeadSource): string {
		const labels: Record<WidgetsLeadSource, string> = {
			widget: 'Колесо фортуны',
			quiz: 'Квиз',
			callback: 'Обратный звонок',
			'countdown-timer': 'Таймер',
			'stop-offer': 'Стоп-оффер',
			'online-consultant': 'Онлайн-консультант',
			calculator: 'Калькулятор стоимости'
		};
		return labels[source];
	}

	private exactRecord(
		value: unknown,
		required: readonly string[],
		optional: readonly string[],
		path: string
	): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error(`${path} must be an object`);
		}
		const record = value as Record<string, unknown>;
		const allowed = new Set([...required, ...optional]);
		const missing = required.filter(key => !(key in record));
		if (missing.length) {
			throw new Error(`${path} is missing fields: ${missing.join(', ')}`);
		}
		const unexpected = Object.keys(record).filter(
			key => !allowed.has(key)
		);
		if (unexpected.length) {
			throw new Error(
				`${path} contains unexpected fields: ${unexpected.join(', ')}`
			);
		}
		return record;
	}

	private assertString(
		value: unknown,
		path: string
	): asserts value is string {
		if (
			typeof value !== 'string' ||
			!value.trim() ||
			value.length > MAX_STRING_LENGTH
		) {
			throw new Error(`${path} must be a non-empty bounded string`);
		}
	}

	private assertOptionalString(value: unknown, path: string): void {
		if (value === undefined || value === null) return;
		if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) {
			throw new Error(`${path} must be a bounded string or null`);
		}
	}

	private assertIsoDate(value: unknown, path: string): void {
		this.assertString(value, path);
		if (
			Number.isNaN(Date.parse(value)) ||
			new Date(value).toISOString() !== value
		) {
			throw new Error(`${path} must be an ISO timestamp`);
		}
	}

	private assertNoForbiddenFields(
		value: unknown,
		path = 'payload',
		depth = 0
	): void {
		if (depth > 20) throw new Error(`${path} exceeds maximum nesting`);
		if (Array.isArray(value)) {
			value.forEach((item, index) =>
				this.assertNoForbiddenFields(item, `${path}[${index}]`, depth + 1)
			);
			return;
		}
		if (!value || typeof value !== 'object') return;
		for (const [key, item] of Object.entries(value)) {
			if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
				throw new Error(`${path}.${key} is forbidden in RabbitMQ payload`);
			}
			this.assertNoForbiddenFields(item, `${path}.${key}`, depth + 1);
		}
	}
}
