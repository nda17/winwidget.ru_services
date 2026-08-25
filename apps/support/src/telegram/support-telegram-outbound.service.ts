import { Injectable } from '@nestjs/common';
import {
	Prisma,
	TelegramOutboundDeliveryStatus,
	TelegramOutboundMethod
} from '@prisma/support-client';
import { createHash, randomUUID } from 'node:crypto';
import { safeError } from '../common/support-request-context';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportRuntimeService } from '../runtime/support-runtime.service';
import {
	SupportTelegramError,
	SupportTelegramTransport
} from './support-telegram.transport';

interface SendMessageRequest {
	chatId: string;
	text: string;
	replyToMessageId?: number;
	messageThreadId?: number;
}

interface CopyMessageRequest {
	chatId: string;
	fromChatId: string;
	messageId: number;
	messageThreadId?: number;
}

type TelegramOutboundRequest = SendMessageRequest | CopyMessageRequest;

export function canonicalSupportJson(value: unknown): string {
	if (value === null || typeof value !== 'object')
		return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalSupportJson(item)).join(',')}]`;
	}
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(
			([key, item]) =>
				`${JSON.stringify(key)}:${canonicalSupportJson(item)}`
		)
		.join(',')}}`;
}

@Injectable()
export class SupportTelegramOutboundService {
	constructor(
		private readonly prisma: SupportPrismaService,
		private readonly runtime: SupportRuntimeService,
		private readonly telegram: SupportTelegramTransport
	) {}

	sendMessage(
		inboxId: string,
		idempotencyKey: string,
		request: SendMessageRequest
	): Promise<{ messageId: number }> {
		return this.execute(
			inboxId,
			idempotencyKey,
			TelegramOutboundMethod.SEND_MESSAGE,
			request
		);
	}

	copyMessage(
		inboxId: string,
		idempotencyKey: string,
		request: CopyMessageRequest
	): Promise<{ messageId: number }> {
		return this.execute(
			inboxId,
			idempotencyKey,
			TelegramOutboundMethod.COPY_MESSAGE,
			request
		);
	}

	private async execute(
		inboxId: string,
		idempotencyKey: string,
		method: TelegramOutboundMethod,
		request: TelegramOutboundRequest
	): Promise<{ messageId: number }> {
		if (!idempotencyKey || idempotencyKey.length > 255) {
			throw new Error('Support Telegram idempotency key is invalid');
		}
		const requestHash = createHash('sha256')
			.update(canonicalSupportJson(request))
			.digest('hex');
		await this.prisma.telegramOutboundDelivery.createMany({
			data: [
				{
					inboxId,
					idempotencyKey,
					method,
					requestHash,
					request: request as unknown as Prisma.InputJsonValue
				}
			],
			skipDuplicates: true
		});
		let delivery =
			await this.prisma.telegramOutboundDelivery.findUniqueOrThrow({
				where: { idempotencyKey }
			});
		if (
			delivery.inboxId !== inboxId ||
			delivery.method !== method ||
			delivery.requestHash !== requestHash
		) {
			throw new Error('Support Telegram idempotency key was reused');
		}
		if (
			delivery.status === TelegramOutboundDeliveryStatus.DELIVERED &&
			delivery.responseMessageId
		) {
			return { messageId: delivery.responseMessageId };
		}

		const now = new Date();
		const leaseToken = randomUUID();
		const leaseExpiresAt = new Date(
			now.getTime() + Math.max(this.runtime.inboxLeaseMs, 30_000)
		);
		const claimed = await this.prisma.telegramOutboundDelivery.updateMany({
			where: {
				id: delivery.id,
				requestHash,
				OR: [
					{ status: TelegramOutboundDeliveryStatus.PENDING },
					{
						status: TelegramOutboundDeliveryStatus.PROCESSING,
						leaseExpiresAt: { lte: now }
					}
				]
			},
			data: {
				status: TelegramOutboundDeliveryStatus.PROCESSING,
				attempts: { increment: 1 },
				leaseToken,
				leaseExpiresAt,
				lastError: null
			}
		});
		if (claimed.count !== 1) {
			delivery =
				await this.prisma.telegramOutboundDelivery.findUniqueOrThrow({
					where: { idempotencyKey }
				});
			if (
				delivery.status === TelegramOutboundDeliveryStatus.DELIVERED &&
				delivery.responseMessageId
			) {
				return { messageId: delivery.responseMessageId };
			}
			throw new SupportTelegramError(
				'Support Telegram outbound delivery is already processing',
				true
			);
		}

		try {
			const stored = this.parseRequest(method, delivery.request);
			const receipt =
				method === TelegramOutboundMethod.SEND_MESSAGE
					? await this.telegram.sendMessage(
							stored.chatId,
							(stored as SendMessageRequest).text,
							{
								replyToMessageId: (stored as SendMessageRequest)
									.replyToMessageId,
								messageThreadId: stored.messageThreadId
							}
						)
					: await this.telegram.copyMessage(
							stored.chatId,
							(stored as CopyMessageRequest).fromChatId,
							(stored as CopyMessageRequest).messageId,
							{ messageThreadId: stored.messageThreadId }
						);
			const completed =
				await this.prisma.telegramOutboundDelivery.updateMany({
					where: {
						id: delivery.id,
						status: TelegramOutboundDeliveryStatus.PROCESSING,
						leaseToken
					},
					data: {
						status: TelegramOutboundDeliveryStatus.DELIVERED,
						leaseToken: null,
						leaseExpiresAt: null,
						responseMessageId: receipt.messageId,
						deliveredAt: new Date(),
						lastError: null
					}
				});
			if (completed.count !== 1) {
				throw new Error(
					'Support Telegram outbound lease was lost after provider success'
				);
			}
			return receipt;
		} catch (error) {
			await this.prisma.telegramOutboundDelivery.updateMany({
				where: {
					id: delivery.id,
					status: TelegramOutboundDeliveryStatus.PROCESSING,
					leaseToken
				},
				data: {
					status: TelegramOutboundDeliveryStatus.PENDING,
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: safeError(error)
				}
			});
			throw error;
		}
	}

	private parseRequest(
		method: TelegramOutboundMethod,
		value: Prisma.JsonValue
	): TelegramOutboundRequest {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Support Telegram stored request is invalid');
		}
		const request = value as Record<string, unknown>;
		const positiveInteger = (candidate: unknown): candidate is number =>
			Number.isSafeInteger(candidate) && Number(candidate) > 0;
		if (
			typeof request.chatId !== 'string' ||
			!request.chatId ||
			(request.messageThreadId !== undefined &&
				!positiveInteger(request.messageThreadId))
		) {
			throw new Error('Support Telegram stored request is invalid');
		}
		if (method === TelegramOutboundMethod.SEND_MESSAGE) {
			if (
				typeof request.text !== 'string' ||
				!request.text ||
				(request.replyToMessageId !== undefined &&
					!positiveInteger(request.replyToMessageId))
			) {
				throw new Error('Support Telegram stored send request is invalid');
			}
			return request as unknown as SendMessageRequest;
		}
		if (
			typeof request.fromChatId !== 'string' ||
			!request.fromChatId ||
			!positiveInteger(request.messageId)
		) {
			throw new Error('Support Telegram stored copy request is invalid');
		}
		return request as unknown as CopyMessageRequest;
	}
}
