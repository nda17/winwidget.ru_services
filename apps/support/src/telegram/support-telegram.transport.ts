import { Injectable } from '@nestjs/common';
import { SupportConfigService } from '../config/support-config.service';

interface TelegramEnvelope<T> {
	ok?: boolean;
	result?: T;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
}

export class SupportTelegramError extends Error {
	readonly retryable: boolean;
	readonly retryAfterMs: number | null;

	constructor(
		message: string,
		retryable: boolean,
		retryAfterMs: number | null = null
	) {
		super(message.slice(0, 500));
		this.name = 'SupportTelegramError';
		this.retryable = retryable;
		this.retryAfterMs = retryAfterMs;
	}
}

@Injectable()
export class SupportTelegramTransport {
	constructor(private readonly config: SupportConfigService) {}

	async getMe(): Promise<{ username: string }> {
		const result = await this.request<{ username?: unknown }>('getMe');
		if (
			!result ||
			typeof result.username !== 'string' ||
			result.username !== this.config.botUsername
		) {
			throw new SupportTelegramError(
				'Telegram bot username does not match configuration',
				false
			);
		}
		return { username: result.username };
	}

	async getWebhookInfo(): Promise<{
		url: string;
		pendingUpdateCount: number;
		lastErrorMessage: string | null;
	}> {
		const result = await this.request<{
			url?: unknown;
			pending_update_count?: unknown;
			last_error_message?: unknown;
		}>('getWebhookInfo');
		return {
			url: typeof result?.url === 'string' ? result.url : '',
			pendingUpdateCount:
				typeof result?.pending_update_count === 'number' &&
				Number.isSafeInteger(result.pending_update_count) &&
				result.pending_update_count >= 0
					? result.pending_update_count
					: 0,
			lastErrorMessage:
				typeof result?.last_error_message === 'string'
					? result.last_error_message.slice(0, 500)
					: null
		};
	}

	async setWebhook(dropPendingUpdates = false): Promise<void> {
		await this.request<boolean>('setWebhook', {
			url: this.config.webhookPublicUrl,
			secret_token: this.config.webhookSecret,
			allowed_updates: ['message'],
			max_connections: 40,
			drop_pending_updates: dropPendingUpdates
		});
	}

	async sendMessage(
		chatId: string,
		text: string,
		options: {
			replyToMessageId?: number;
			messageThreadId?: number;
		} = {}
	): Promise<{ messageId: number }> {
		const result = await this.request<{ message_id?: unknown }>(
			'sendMessage',
			{
				chat_id: chatId,
				text,
				disable_web_page_preview: true,
				...(options.replyToMessageId
					? { reply_to_message_id: options.replyToMessageId }
					: {}),
				...(options.messageThreadId
					? { message_thread_id: options.messageThreadId }
					: {})
			}
		);
		if (!result || !this.positiveInteger(result.message_id)) {
			throw new SupportTelegramError(
				'Telegram sendMessage returned an invalid receipt',
				true
			);
		}
		return { messageId: result.message_id };
	}

	async copyMessage(
		chatId: string,
		fromChatId: string,
		messageId: number,
		options: { messageThreadId?: number } = {}
	): Promise<{ messageId: number }> {
		const result = await this.request<{ message_id?: unknown }>(
			'copyMessage',
			{
				chat_id: chatId,
				from_chat_id: fromChatId,
				message_id: messageId,
				...(options.messageThreadId
					? { message_thread_id: options.messageThreadId }
					: {})
			}
		);
		if (!result || !this.positiveInteger(result.message_id)) {
			throw new SupportTelegramError(
				'Telegram copyMessage returned an invalid receipt',
				true
			);
		}
		return { messageId: result.message_id };
	}

	private async request<T>(
		method: string,
		body?: Record<string, unknown>
	): Promise<T> {
		let response: Response;
		try {
			response = await fetch(
				`${this.config.telegramApiBaseUrl}/bot${this.config.botToken}/${method}`,
				{
					method: body ? 'POST' : 'GET',
					headers: body
						? { 'Content-Type': 'application/json' }
						: undefined,
					body: body ? JSON.stringify(body) : undefined,
					signal: AbortSignal.timeout(10_000),
					redirect: 'error'
				}
			);
		} catch {
			throw new SupportTelegramError(
				'Telegram transport request failed',
				true
			);
		}
		let envelope: TelegramEnvelope<T> | null = null;
		try {
			envelope = (await response.json()) as TelegramEnvelope<T>;
		} catch {
			throw new SupportTelegramError(
				'Telegram returned an invalid response',
				response.status >= 500
			);
		}
		if (!response.ok || !envelope?.ok || envelope.result === undefined) {
			const code = envelope?.error_code || response.status;
			const retryable = code === 429 || code >= 500 || code === 0;
			throw new SupportTelegramError(
				`Telegram ${method} failed with code ${code}`,
				retryable,
				typeof envelope?.parameters?.retry_after === 'number'
					? Math.max(0, envelope.parameters.retry_after * 1000)
					: null
			);
		}
		return envelope.result;
	}

	private positiveInteger(value: unknown): value is number {
		return Number.isSafeInteger(value) && Number(value) > 0;
	}
}
