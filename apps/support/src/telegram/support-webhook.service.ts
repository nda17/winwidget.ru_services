import {
	ConflictException,
	Injectable,
	UnauthorizedException,
	UnprocessableEntityException
} from '@nestjs/common';
import { Prisma } from '@prisma/support-client';
import { createHash, randomUUID } from 'node:crypto';
import { SupportConfigService } from '../config/support-config.service';
import { getSupportCorrelationId } from '../common/support-request-context';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import {
	SUPPORT_EVENTS_EXCHANGE,
	SUPPORT_WEBHOOK_EVENT,
	SUPPORT_WEBHOOK_ROUTING_KEY
} from '../messaging/support-messaging.constants';
import type { TelegramSupportUpdate } from './support-telegram.types';

const MAX_WEBHOOK_BYTES = 512 * 1024;

@Injectable()
export class SupportWebhookService {
	constructor(
		private readonly config: SupportConfigService,
		private readonly prisma: SupportPrismaService
	) {}

	async admit(rawBody: Buffer | undefined, secret: string | undefined) {
		try {
			this.config.assertWebhookSecret(secret);
		} catch {
			throw new UnauthorizedException({
				statusCode: 401,
				message: 'Telegram support webhook secret invalid',
				error: 'Unauthorized',
				code: 'support_webhook_secret_invalid'
			});
		}
		const { raw, update } = this.validateRawBody(rawBody);
		const bodyHash = createHash('sha256').update(raw).digest('hex');
		const correlationId = getSupportCorrelationId();

		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				return await this.prisma.$transaction(
					async transaction => {
						const existing =
							await transaction.telegramWebhookInbox.findUnique({
								where: { updateId: BigInt(update.update_id) },
								select: { id: true, bodyHash: true }
							});
						if (existing) {
							if (existing.bodyHash !== bodyHash) {
								throw this.hashConflict();
							}
							return { accepted: true, duplicate: true };
						}

						const inbox = await transaction.telegramWebhookInbox.create({
							data: {
								updateId: BigInt(update.update_id),
								bodyHash,
								rawPayload: raw
							}
						});
						const eventId = randomUUID();
						await transaction.outboxEvent.create({
							data: {
								messageId: eventId,
								deduplicationKey: `support-webhook:${update.update_id}`,
								exchange: SUPPORT_EVENTS_EXCHANGE,
								eventType: SUPPORT_WEBHOOK_EVENT,
								routingKey: SUPPORT_WEBHOOK_ROUTING_KEY,
								aggregateType: 'support.telegram-webhook',
								aggregateId: String(update.update_id),
								aggregateVersion: 1n,
								headers: {
									'x-correlation-id': correlationId
								} as Prisma.InputJsonValue,
								payload: {
									schemaVersion: 1,
									eventType: SUPPORT_WEBHOOK_EVENT,
									eventId,
									inboxId: inbox.id,
									updateId: String(update.update_id),
									bodyHash,
									occurredAt: new Date().toISOString()
								} as Prisma.InputJsonValue
							}
						});
						return { accepted: true, duplicate: false };
					},
					{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
				);
			} catch (error) {
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === 'P2034' &&
					attempt < 2
				) {
					continue;
				}
				if (
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === 'P2002'
				) {
					const existing =
						await this.prisma.telegramWebhookInbox.findUnique({
							where: { updateId: BigInt(update.update_id) },
							select: { bodyHash: true }
						});
					if (existing?.bodyHash === bodyHash) {
						return { accepted: true, duplicate: true };
					}
					if (existing) {
						throw this.hashConflict();
					}
				}
				throw error;
			}
		}
		throw new Error('Support webhook admission retry exhausted');
	}

	private hashConflict(): ConflictException {
		return new ConflictException({
			statusCode: 409,
			message: 'Telegram update_id was reused with a different body',
			error: 'Conflict',
			code: 'support_webhook_hash_conflict'
		});
	}

	private validateRawBody(rawBody: Buffer | undefined): {
		raw: Buffer;
		update: TelegramSupportUpdate;
	} {
		if (!rawBody?.length || rawBody.length > MAX_WEBHOOK_BYTES) {
			throw new UnprocessableEntityException(
				'Telegram webhook body is missing or too large'
			);
		}
		const text = rawBody.toString('utf8');
		if (!Buffer.from(text, 'utf8').equals(rawBody)) {
			throw new UnprocessableEntityException(
				'Telegram webhook body must be valid UTF-8'
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			throw new UnprocessableEntityException(
				'Telegram webhook body must be valid JSON'
			);
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new UnprocessableEntityException('Telegram update is invalid');
		}
		const updateId = (value as Record<string, unknown>).update_id;
		if (!Number.isSafeInteger(updateId) || Number(updateId) < 0) {
			throw new UnprocessableEntityException(
				'Telegram update_id is invalid'
			);
		}
		return {
			raw: Buffer.from(rawBody),
			update: value as TelegramSupportUpdate
		};
	}
}
