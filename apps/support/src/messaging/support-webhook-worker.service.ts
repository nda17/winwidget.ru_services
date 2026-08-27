import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import {
	ConsumerFailureStatus,
	ConsumerReceiptStatus,
	OutboxExchange,
	Prisma,
	SupportInboxOutcome,
	SupportInboxStatus,
	SupportMappingKind
} from '@prisma/support-client';
import type { ConsumeMessage } from 'amqplib';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { safeError } from '../common/support-request-context';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportRuntimeService } from '../runtime/support-runtime.service';
import { SupportTelegramError } from '../telegram/support-telegram.transport';
import { SupportTelegramOutboundService } from '../telegram/support-telegram-outbound.service';
import type {
	TelegramMessage,
	TelegramSupportUpdate
} from '../telegram/support-telegram.types';
import {
	SUPPORT_DEAD_ROUTING_KEY,
	SUPPORT_RETRY_DELAYS_MS,
	SUPPORT_WEBHOOK_CONSUMER,
	SUPPORT_WEBHOOK_EVENT,
	SUPPORT_WEBHOOK_ROUTING_KEY,
	supportRetryRoutingKey
} from './support-messaging.constants';
import { SupportRabbitMqService } from './support-rabbitmq.service';

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface WebhookEvent {
	schemaVersion: 1;
	eventType: typeof SUPPORT_WEBHOOK_EVENT;
	eventId: string;
	inboxId: string;
	updateId: string;
	bodyHash: string;
	occurredAt: string;
}

interface ParsedEvent {
	event: WebhookEvent;
	eventId: string;
	payloadHash: string;
	headers: Record<string, string | number | boolean>;
	retryAttempt: number;
	deliveryToken: string;
}

interface MappingResult {
	kind: SupportMappingKind;
	adminChatId: string;
	adminMessageId: number;
	userChatId: string;
	telegramUserId: string | null;
	username: string | null;
	firstName: string | null;
	lastName: string | null;
	text: string | null;
}

@Injectable()
export class SupportWebhookWorkerService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(SupportWebhookWorkerService.name);
	private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private ready = false;

	constructor(
		private readonly prisma: SupportPrismaService,
		private readonly runtime: SupportRuntimeService,
		private readonly rabbit: SupportRabbitMqService,
		private readonly outbound: SupportTelegramOutboundService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		await this.rabbit.consume(message => this.handle(message));
		this.ready = true;
	}

	onApplicationShutdown(): void {
		this.ready = false;
	}

	isReady(): boolean {
		return (
			!this.runtime.workerEnabled ||
			(this.ready && this.rabbit.isConsumerReady())
		);
	}

	private async handle(message: ConsumeMessage): Promise<void> {
		let parsed: ParsedEvent;
		try {
			parsed = this.parseEvent(message);
		} catch (error) {
			try {
				await this.parkPoison(message, error);
				this.rabbit.ack(message);
			} catch (stateError) {
				this.logger.error(
					`Support poison parking failed: ${safeError(stateError)}`
				);
				this.rabbit.nack(message, true);
			}
			return;
		}

		let claim:
			| { state: 'claimed'; manualRetryCycle: number }
			| { state: 'delivered' }
			| { state: 'busy' };
		try {
			claim = await this.claim(parsed);
		} catch (error) {
			try {
				await this.parkPoison(message, error, parsed.eventId);
				this.rabbit.ack(message);
			} catch (stateError) {
				this.logger.error(
					`Support receipt poison failed: ${safeError(stateError)}`
				);
				this.rabbit.nack(message, true);
			}
			return;
		}
		if (claim.state === 'delivered') {
			this.rabbit.ack(message);
			return;
		}
		if (claim.state === 'busy') {
			this.rabbit.nack(message, true);
			return;
		}
		const manualRetryCycle = claim.manualRetryCycle;

		try {
			const delivery = await this.deliver(parsed.event);
			await this.complete(parsed, delivery.outcome, delivery.mappings);
			this.rabbit.ack(message);
		} catch (error) {
			try {
				await this.fail(parsed, manualRetryCycle, error);
				this.rabbit.ack(message);
			} catch (stateError) {
				this.logger.error(
					`Support failure state error: ${safeError(stateError)}`
				);
				this.rabbit.nack(message, true);
			}
		}
	}

	private parseEvent(message: ConsumeMessage): ParsedEvent {
		if (message.content.length > 256 * 1024) {
			throw new Error('Support event exceeds size limit');
		}
		const payloadHash = createHash('sha256')
			.update(message.content)
			.digest('hex');
		const value = JSON.parse(message.content.toString('utf8')) as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Support event must be an object');
		}
		const event = value as Record<string, unknown>;
		const exactKeys = [
			'bodyHash',
			'eventId',
			'eventType',
			'inboxId',
			'occurredAt',
			'schemaVersion',
			'updateId'
		].sort();
		const keys = Object.keys(event).sort();
		if (
			keys.length !== exactKeys.length ||
			!keys.every((key, index) => key === exactKeys[index]) ||
			event.schemaVersion !== 1 ||
			event.eventType !== SUPPORT_WEBHOOK_EVENT ||
			typeof event.eventId !== 'string' ||
			!UUID.test(event.eventId) ||
			typeof event.inboxId !== 'string' ||
			!UUID.test(event.inboxId) ||
			typeof event.updateId !== 'string' ||
			!/^\d{1,20}$/.test(event.updateId) ||
			typeof event.bodyHash !== 'string' ||
			!/^[0-9a-f]{64}$/.test(event.bodyHash) ||
			typeof event.occurredAt !== 'string' ||
			new Date(event.occurredAt).toISOString() !== event.occurredAt ||
			message.properties.messageId !== event.eventId ||
			message.properties.type !== SUPPORT_WEBHOOK_EVENT ||
			![SUPPORT_WEBHOOK_ROUTING_KEY, SUPPORT_WEBHOOK_CONSUMER].includes(
				message.fields.routingKey
			)
		) {
			throw new Error('Support event contract is invalid');
		}
		const headers = this.headers(message);
		return {
			event: event as unknown as WebhookEvent,
			eventId: event.eventId,
			payloadHash,
			headers,
			retryAttempt: this.integer(headers['x-retry-attempt'], 0),
			deliveryToken: this.uuid(headers['x-delivery-token']) || randomUUID()
		};
	}

	private async claim(
		parsed: ParsedEvent
	): Promise<
		| { state: 'claimed'; manualRetryCycle: number }
		| { state: 'delivered' | 'busy' }
	> {
		const now = new Date();
		const leaseUntil = new Date(now.getTime() + this.runtime.inboxLeaseMs);
		return this.prisma.$transaction(
			async transaction => {
				await transaction.consumerReceipt.createMany({
					data: [
						{
							eventId: parsed.eventId,
							consumer: SUPPORT_WEBHOOK_CONSUMER,
							payloadHash: parsed.payloadHash,
							status: ConsumerReceiptStatus.PROCESSING,
							lockedAt: now,
							lockedBy: this.instanceId,
							lockToken: parsed.deliveryToken,
							leaseExpiresAt: leaseUntil,
							retryAttempt: parsed.retryAttempt
						}
					],
					skipDuplicates: true
				});
				const receipt =
					await transaction.consumerReceipt.findUniqueOrThrow({
						where: {
							eventId_consumer: {
								eventId: parsed.eventId,
								consumer: SUPPORT_WEBHOOK_CONSUMER
							}
						}
					});
				if (receipt.payloadHash !== parsed.payloadHash) {
					throw new Error('Support receipt payload mismatch');
				}
				if (
					receipt.status === ConsumerReceiptStatus.DELIVERED ||
					receipt.status === ConsumerReceiptStatus.CLOSED_NO_RETRY
				) {
					return { state: 'delivered' as const };
				}
				const claimedReceipt =
					await transaction.consumerReceipt.updateMany({
						where: {
							eventId: parsed.eventId,
							consumer: SUPPORT_WEBHOOK_CONSUMER,
							payloadHash: parsed.payloadHash,
							OR: [
								{
									status: ConsumerReceiptStatus.RETRY_SCHEDULED,
									lockToken: parsed.deliveryToken
								},
								{
									status: ConsumerReceiptStatus.PROCESSING,
									OR: [
										{ lockToken: parsed.deliveryToken },
										{ leaseExpiresAt: { lte: now } }
									]
								},
								{
									status: ConsumerReceiptStatus.DEAD_LETTERED,
									lockToken: parsed.deliveryToken
								}
							]
						},
						data: {
							status: ConsumerReceiptStatus.PROCESSING,
							lockedAt: now,
							lockedBy: this.instanceId,
							lockToken: parsed.deliveryToken,
							leaseExpiresAt: leaseUntil,
							retryAttempt: parsed.retryAttempt,
							lastError: null
						}
					});
				if (claimedReceipt.count !== 1) return { state: 'busy' as const };
				const inbox = await transaction.telegramWebhookInbox.findUnique({
					where: { id: parsed.event.inboxId }
				});
				if (
					!inbox ||
					inbox.updateId.toString() !== parsed.event.updateId ||
					inbox.bodyHash !== parsed.event.bodyHash
				) {
					throw new Error('Support inbox contract mismatch');
				}
				const claimedInbox =
					await transaction.telegramWebhookInbox.updateMany({
						where: {
							id: inbox.id,
							bodyHash: parsed.event.bodyHash,
							OR: [
								{ status: SupportInboxStatus.PENDING },
								{ status: SupportInboxStatus.RETRY_SCHEDULED },
								{ status: SupportInboxStatus.DEAD_LETTERED },
								{
									status: SupportInboxStatus.PROCESSING,
									OR: [
										{ leaseToken: parsed.deliveryToken },
										{ leaseExpiresAt: { lte: now } }
									]
								}
							]
						},
						data: {
							status: SupportInboxStatus.PROCESSING,
							attempts: { increment: 1 },
							leaseToken: parsed.deliveryToken,
							leaseExpiresAt: leaseUntil,
							lastError: null
						}
					});
				if (claimedInbox.count !== 1) return { state: 'busy' as const };
				return {
					state: 'claimed' as const,
					manualRetryCycle: receipt.manualRetryCycle
				};
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private async deliver(event: WebhookEvent): Promise<{
		outcome: SupportInboxOutcome;
		mappings: MappingResult[];
	}> {
		const inbox = await this.prisma.telegramWebhookInbox.findUniqueOrThrow(
			{
				where: { id: event.inboxId },
				select: { rawPayload: true, bodyHash: true }
			}
		);
		const raw = Buffer.from(inbox.rawPayload);
		if (
			inbox.bodyHash !== event.bodyHash ||
			createHash('sha256').update(raw).digest('hex') !== event.bodyHash
		) {
			throw new Error('Support inbox payload hash mismatch');
		}
		const update = JSON.parse(
			raw.toString('utf8')
		) as TelegramSupportUpdate;
		if (String(update.update_id) !== event.updateId) {
			throw new Error('Support inbox update_id mismatch');
		}
		const message = update.message;
		if (!message || !this.validChat(message)) {
			return { outcome: SupportInboxOutcome.IGNORED_CHAT, mappings: [] };
		}
		if (message.from?.is_bot) {
			return { outcome: SupportInboxOutcome.IGNORED_BOT, mappings: [] };
		}
		if (
			message.chat.type === 'group' ||
			message.chat.type === 'supergroup'
		) {
			return this.deliverAdminReply(event, message);
		}
		if (message.chat.type && message.chat.type !== 'private') {
			return { outcome: SupportInboxOutcome.IGNORED_CHAT, mappings: [] };
		}
		return this.deliverUserMessage(event, message);
	}

	private async deliverUserMessage(
		event: WebhookEvent,
		message: TelegramMessage
	): Promise<{
		outcome: SupportInboxOutcome;
		mappings: MappingResult[];
	}> {
		const userChatId = String(message.chat.id);
		if (message.text?.startsWith('/start')) {
			await this.outbound.sendMessage(
				event.inboxId,
				`${event.eventId}:start`,
				{
					chatId: userChatId,
					text: 'Вас приветствует служба поддержки сервиса winwidget.ru! Напишите ваш вопрос, и мы ответим в ближайшее время.'
				}
			);
			return { outcome: SupportInboxOutcome.START_REPLIED, mappings: [] };
		}
		if (!this.positiveInteger(message.message_id)) {
			await this.outbound.sendMessage(
				event.inboxId,
				`${event.eventId}:reject`,
				{
					chatId: userChatId,
					text: 'Не удалось отправить сообщение. Пожалуйста, отправьте его ещё раз.'
				}
			);
			return {
				outcome: SupportInboxOutcome.USER_MESSAGE_REJECTED,
				mappings: []
			};
		}
		const settings = await this.prisma.routingSettings.findUniqueOrThrow({
			where: { id: 'singleton' }
		});
		if (!settings.adminChatId.trim() || !settings.supportThreadId) {
			throw new Error('Support routing settings are not configured');
		}
		const copied = await this.outbound.copyMessage(
			event.inboxId,
			`${event.eventId}:user-copy`,
			{
				chatId: settings.adminChatId,
				fromChatId: userChatId,
				messageId: message.message_id,
				messageThreadId: settings.supportThreadId
			}
		);
		const context = await this.outbound.sendMessage(
			event.inboxId,
			`${event.eventId}:user-context`,
			{
				chatId: settings.adminChatId,
				text: this.supportContext(message),
				replyToMessageId: copied.messageId,
				messageThreadId: settings.supportThreadId
			}
		);
		await this.outbound.sendMessage(
			event.inboxId,
			`${event.eventId}:user-ack`,
			{
				chatId: userChatId,
				text: 'Сообщение передано команде поддержки. Ответим в текущий чат в ближайшее время.'
			}
		);
		const base = this.mappingBase(
			settings.adminChatId,
			userChatId,
			message
		);
		return {
			outcome: SupportInboxOutcome.USER_MESSAGE_FORWARDED,
			mappings: [
				{
					...base,
					kind: SupportMappingKind.USER_COPY,
					adminMessageId: copied.messageId
				},
				{
					...base,
					kind: SupportMappingKind.USER_CONTEXT,
					adminMessageId: context.messageId
				}
			]
		};
	}

	private async deliverAdminReply(
		event: WebhookEvent,
		message: TelegramMessage
	): Promise<{
		outcome: SupportInboxOutcome;
		mappings: MappingResult[];
	}> {
		const replyTo = message.reply_to_message?.message_id;
		if (
			!this.positiveInteger(replyTo) ||
			!this.positiveInteger(message.message_id)
		) {
			return {
				outcome: SupportInboxOutcome.IGNORED_UNMAPPED_REPLY,
				mappings: []
			};
		}
		const settings = await this.prisma.routingSettings.findUniqueOrThrow({
			where: { id: 'singleton' }
		});
		const adminChatId = String(message.chat.id);
		if (
			adminChatId !== settings.adminChatId ||
			message.message_thread_id !== settings.supportThreadId
		) {
			return { outcome: SupportInboxOutcome.IGNORED_CHAT, mappings: [] };
		}
		const mapping = await this.prisma.supportMessageMapping.findUnique({
			where: {
				adminChatId_adminMessageId: {
					adminChatId,
					adminMessageId: replyTo
				}
			}
		});
		if (!mapping) {
			return {
				outcome: SupportInboxOutcome.IGNORED_UNMAPPED_REPLY,
				mappings: []
			};
		}
		await this.outbound.copyMessage(
			event.inboxId,
			`${event.eventId}:admin-copy`,
			{
				chatId: mapping.userChatId,
				fromChatId: adminChatId,
				messageId: message.message_id
			}
		);
		await this.outbound.sendMessage(
			event.inboxId,
			`${event.eventId}:admin-ack`,
			{
				chatId: adminChatId,
				text: 'Ответ отправлен пользователю.',
				replyToMessageId: message.message_id,
				messageThreadId: settings.supportThreadId || undefined
			}
		);
		return {
			outcome: SupportInboxOutcome.ADMIN_REPLY_DELIVERED,
			mappings: []
		};
	}

	private async complete(
		parsed: ParsedEvent,
		outcome: SupportInboxOutcome,
		mappings: MappingResult[]
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			if (mappings.length) {
				await transaction.supportMessageMapping.createMany({
					data: mappings.map(mapping => ({
						...mapping,
						inboxId: parsed.event.inboxId
					})),
					skipDuplicates: true
				});
			}
			const inbox = await transaction.telegramWebhookInbox.updateMany({
				where: {
					id: parsed.event.inboxId,
					status: SupportInboxStatus.PROCESSING,
					leaseToken: parsed.deliveryToken
				},
				data: {
					status: outcome.startsWith('IGNORED_')
						? SupportInboxStatus.IGNORED
						: SupportInboxStatus.DELIVERED,
					outcome,
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: null,
					processedAt: new Date()
				}
			});
			const receipt = await transaction.consumerReceipt.updateMany({
				where: {
					eventId: parsed.eventId,
					consumer: SUPPORT_WEBHOOK_CONSUMER,
					status: ConsumerReceiptStatus.PROCESSING,
					lockToken: parsed.deliveryToken
				},
				data: {
					status: ConsumerReceiptStatus.DELIVERED,
					deliveredAt: new Date(),
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: null
				}
			});
			if (inbox.count !== 1 || receipt.count !== 1) {
				throw new Error('Support delivery lease was lost');
			}
			await transaction.consumerFailure.updateMany({
				where: {
					eventId: parsed.eventId,
					consumer: SUPPORT_WEBHOOK_CONSUMER,
					status: {
						in: [
							ConsumerFailureStatus.OPEN,
							ConsumerFailureStatus.RETRYING
						]
					}
				},
				data: {
					status: ConsumerFailureStatus.RESOLVED,
					resolvedAt: new Date(),
					retryToken: null,
					retryLeaseExpiresAt: null
				}
			});
		});
	}

	private async fail(
		parsed: ParsedEvent,
		manualRetryCycle: number,
		error: unknown
	): Promise<void> {
		const errorText = safeError(error);
		const retryable =
			!(error instanceof SupportTelegramError) || error.retryable;
		const nextAttempt = parsed.retryAttempt + 1;
		const shouldRetry =
			retryable && nextAttempt <= SUPPORT_RETRY_DELAYS_MS.length;
		const nextToken = randomUUID();
		const correlationId =
			typeof parsed.headers['x-correlation-id'] === 'string' &&
			UUID.test(parsed.headers['x-correlation-id'])
				? parsed.headers['x-correlation-id']
				: randomUUID();
		await this.prisma.$transaction(async transaction => {
			await transaction.consumerFailure.upsert({
				where: {
					eventId_consumer: {
						eventId: parsed.eventId,
						consumer: SUPPORT_WEBHOOK_CONSUMER
					}
				},
				update: {
					status: ConsumerFailureStatus.OPEN,
					attempts: { increment: 1 },
					lastError: errorText,
					lastFailedAt: new Date(),
					retryToken: null,
					retryLeaseExpiresAt: null,
					resolvedAt: null
				},
				create: {
					eventId: parsed.eventId,
					consumer: SUPPORT_WEBHOOK_CONSUMER,
					eventType: SUPPORT_WEBHOOK_EVENT,
					routingKey: SUPPORT_WEBHOOK_ROUTING_KEY,
					payload: parsed.event as unknown as Prisma.InputJsonValue,
					headers: parsed.headers as Prisma.InputJsonValue,
					payloadHash: parsed.payloadHash,
					correlationId,
					attempts: 1,
					lastError: errorText
				}
			});
			const receipt = await transaction.consumerReceipt.updateMany({
				where: {
					eventId: parsed.eventId,
					consumer: SUPPORT_WEBHOOK_CONSUMER,
					status: ConsumerReceiptStatus.PROCESSING,
					lockToken: parsed.deliveryToken
				},
				data: {
					status: shouldRetry
						? ConsumerReceiptStatus.RETRY_SCHEDULED
						: ConsumerReceiptStatus.DEAD_LETTERED,
					lockToken: shouldRetry ? nextToken : null,
					lockedAt: null,
					lockedBy: null,
					leaseExpiresAt: null,
					lastError: errorText
				}
			});
			const inbox = await transaction.telegramWebhookInbox.updateMany({
				where: {
					id: parsed.event.inboxId,
					status: SupportInboxStatus.PROCESSING,
					leaseToken: parsed.deliveryToken
				},
				data: {
					status: shouldRetry
						? SupportInboxStatus.RETRY_SCHEDULED
						: SupportInboxStatus.DEAD_LETTERED,
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: errorText
				}
			});
			if (receipt.count !== 1 || inbox.count !== 1) {
				throw new Error('Support failure lease was lost');
			}
			await transaction.outboxEvent.create({
				data: {
					messageId: parsed.eventId,
					deduplicationKey: shouldRetry
						? `${parsed.eventId}:retry:${manualRetryCycle}:${nextAttempt}`
						: `${parsed.eventId}:dead-letter:${manualRetryCycle}`,
					exchange: shouldRetry
						? OutboxExchange.RETRY
						: OutboxExchange.DEAD_LETTER,
					eventType: SUPPORT_WEBHOOK_EVENT,
					routingKey: shouldRetry
						? supportRetryRoutingKey(nextAttempt)
						: SUPPORT_DEAD_ROUTING_KEY,
					aggregateType: 'support.telegram-webhook',
					aggregateId: parsed.event.updateId,
					headers: {
						...parsed.headers,
						'x-correlation-id': correlationId,
						'x-retry-attempt': nextAttempt,
						'x-delivery-token': nextToken
					} as Prisma.InputJsonValue,
					payload: parsed.event as unknown as Prisma.InputJsonValue
				}
			});
		});
	}

	private async parkPoison(
		message: ConsumeMessage,
		error: unknown,
		eventId?: string
	): Promise<void> {
		const payloadHash = createHash('sha256')
			.update(message.content)
			.digest('hex');
		const poisonId =
			eventId && UUID.test(eventId)
				? eventId
				: this.uuidFromHash(payloadHash);
		const errorText = safeError(error);
		await this.prisma.$transaction(async transaction => {
			await transaction.consumerFailure.upsert({
				where: {
					eventId_consumer: {
						eventId: poisonId,
						consumer: SUPPORT_WEBHOOK_CONSUMER
					}
				},
				update: {
					attempts: { increment: 1 },
					lastError: errorText,
					lastFailedAt: new Date()
				},
				create: {
					eventId: poisonId,
					consumer: SUPPORT_WEBHOOK_CONSUMER,
					eventType: 'support.poison.v1',
					routingKey: message.fields.routingKey.slice(0, 255),
					payload: { schemaVersion: 1, payloadHash },
					headers: {},
					payloadHash,
					correlationId: randomUUID(),
					attempts: 1,
					lastError: errorText
				}
			});
			await transaction.outboxEvent.createMany({
				data: [
					{
						messageId: poisonId,
						deduplicationKey: `${poisonId}:poison`,
						exchange: OutboxExchange.DEAD_LETTER,
						eventType: 'support.poison.v1',
						routingKey: SUPPORT_DEAD_ROUTING_KEY,
						payload: { schemaVersion: 1, payloadHash }
					}
				],
				skipDuplicates: true
			});
		});
	}

	private validChat(message: TelegramMessage): boolean {
		return Boolean(
			message.chat &&
			(typeof message.chat.id === 'string' ||
				Number.isSafeInteger(message.chat.id))
		);
	}

	private mappingBase(
		adminChatId: string,
		userChatId: string,
		message: TelegramMessage
	): Omit<MappingResult, 'kind' | 'adminMessageId'> {
		return {
			adminChatId,
			userChatId,
			telegramUserId: message.from?.id ? String(message.from.id) : null,
			username: message.from?.username?.slice(0, 255) || null,
			firstName: message.from?.first_name?.slice(0, 255) || null,
			lastName: message.from?.last_name?.slice(0, 255) || null,
			text:
				(message.text || message.caption || '').slice(0, 16 * 1024) || null
		};
	}

	private supportContext(message: TelegramMessage): string {
		const fullName = [message.from?.first_name, message.from?.last_name]
			.filter(Boolean)
			.join(' ')
			.trim();
		const name = message.from?.username
			? `@${message.from.username}`
			: fullName || 'Без имени';
		return [
			'Новое обращение в поддержку winwidget.ru',
			`Пользователь: ${name}`,
			`Telegram ID: ${message.from?.id ? String(message.from.id) : 'неизвестен'}`,
			`Chat ID: ${String(message.chat.id)}`,
			'',
			'Ответьте reply на это сообщение или на сообщение пользователя выше.',
			'',
			`Текст: ${message.text || message.caption || 'Сообщение без текста'}`
		]
			.join('\n')
			.slice(0, 4096);
	}

	private headers(
		message: ConsumeMessage
	): Record<string, string | number | boolean> {
		return Object.fromEntries(
			Object.entries(message.properties.headers || {}).filter(
				(entry): entry is [string, string | number | boolean] =>
					typeof entry[1] === 'string' ||
					typeof entry[1] === 'number' ||
					typeof entry[1] === 'boolean'
			)
		);
	}

	private integer(value: unknown, fallback: number): number {
		return Number.isSafeInteger(value) && Number(value) >= 0
			? Number(value)
			: fallback;
	}

	private uuid(value: unknown): string | null {
		return typeof value === 'string' && UUID.test(value) ? value : null;
	}

	private positiveInteger(value: unknown): value is number {
		return Number.isSafeInteger(value) && Number(value) > 0;
	}

	private uuidFromHash(hash: string): string {
		return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
	}
}
