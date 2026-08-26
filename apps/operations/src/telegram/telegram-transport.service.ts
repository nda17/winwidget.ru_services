import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';

export interface TelegramDocumentReceipt {
	messageId: number;
	chatId: string;
	messageThreadId: number;
	fileId: string;
	fileUniqueId: string;
}

interface TelegramDocumentResponse {
	message_id?: unknown;
	message_thread_id?: unknown;
	chat?: { id?: unknown };
	document?: {
		file_id?: unknown;
		file_unique_id?: unknown;
	};
}

@Injectable()
export class TelegramTransportService {
	constructor(private readonly config: ConfigService) {}

	async sendMessage(
		chatId: string,
		text: string,
		options: { messageThreadId?: number; signal?: AbortSignal } = {}
	): Promise<void> {
		const response = await fetch(
			`${this.baseUrl()}/bot${this.token()}/sendMessage`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId,
					...(options.messageThreadId
						? { message_thread_id: options.messageThreadId }
						: {}),
					text,
					parse_mode: 'HTML',
					disable_web_page_preview: true
				}),
				signal: this.timeoutSignal(10_000, options.signal)
			}
		);
		await this.telegramResult(response, 'sendMessage');
	}

	async sendDocument(
		chatId: string,
		filePath: string,
		caption: string,
		options: { messageThreadId: number; signal?: AbortSignal }
	): Promise<TelegramDocumentReceipt> {
		const normalizedChatId = chatId.trim();
		if (
			!/^-?[1-9]\d*$/.test(normalizedChatId) &&
			!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(normalizedChatId)
		) {
			throw new Error('Telegram backup chat ID is invalid');
		}
		if (
			!Number.isInteger(options.messageThreadId) ||
			options.messageThreadId < 1
		) {
			throw new Error('Telegram Backups topic is invalid');
		}
		const file = await stat(filePath);
		const boundary = `winwidget-${randomBytes(18).toString('hex')}`;
		const fileName = basename(filePath).replace(/["\r\n]/g, '_');
		const prefix = Buffer.from(
			[
				this.field(boundary, 'chat_id', normalizedChatId),
				this.field(
					boundary,
					'message_thread_id',
					String(options.messageThreadId)
				),
				this.field(boundary, 'caption', caption),
				this.field(boundary, 'parse_mode', 'HTML'),
				`--${boundary}\r\n`,
				`Content-Disposition: form-data; name="document"; filename="${fileName}"\r\n`,
				'Content-Type: application/octet-stream\r\n\r\n'
			].join('')
		);
		const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
		const body = Readable.from(
			(async function* () {
				yield prefix;
				for await (const chunk of createReadStream(filePath)) yield chunk;
				yield suffix;
			})()
		);
		const response = await fetch(
			`${this.baseUrl()}/bot${this.token()}/sendDocument`,
			{
				method: 'POST',
				headers: {
					'Content-Type': `multipart/form-data; boundary=${boundary}`,
					'Content-Length': String(
						prefix.length + file.size + suffix.length
					)
				},
				body: body as unknown as BodyInit,
				duplex: 'half',
				signal: this.timeoutSignal(10 * 60_000, options.signal)
			} as RequestInit & { duplex: 'half' }
		);
		const result = await this.telegramResult<TelegramDocumentResponse>(
			response,
			'sendDocument'
		);
		if (
			!Number.isSafeInteger(result.message_id) ||
			typeof result.document?.file_id !== 'string' ||
			!result.document.file_id ||
			typeof result.document.file_unique_id !== 'string' ||
			!result.document.file_unique_id
		) {
			throw new Error('Telegram sendDocument response is invalid');
		}
		return {
			messageId: result.message_id as number,
			chatId: String(result.chat?.id ?? normalizedChatId),
			messageThreadId:
				typeof result.message_thread_id === 'number'
					? result.message_thread_id
					: options.messageThreadId,
			fileId: result.document.file_id,
			fileUniqueId: result.document.file_unique_id
		};
	}

	private token(): string {
		const token = this.config
			.get<string>('TELEGRAM_INFO_BOT_TOKEN')
			?.trim();
		if (
			!token ||
			token.length < 20 ||
			['change_me', 'XYZXYZXYZ'].includes(token) ||
			token.startsWith('change_me_')
		) {
			throw new Error('TELEGRAM_INFO_BOT_TOKEN is not configured');
		}
		return token;
	}

	private baseUrl(): string {
		const mode = this.config.get<string>('MODE')?.trim().toLowerCase();
		const raw = this.config.get<string>('TELEGRAM_API_BASE_URL')?.trim();
		if (!raw) {
			if (mode === 'production') {
				throw new Error('TELEGRAM_API_BASE_URL is required in production');
			}
			return 'https://api.telegram.org';
		}
		const url = new URL(raw);
		const productionProxy =
			url.protocol === 'https:' &&
			url.hostname === 'tg.winwidget.ru' &&
			url.port === '' &&
			url.pathname === '/telegram-api';
		const developmentAllowed =
			mode !== 'production' &&
			((url.protocol === 'https:' &&
				url.hostname === 'api.telegram.org' &&
				url.pathname === '/') ||
				(url.protocol === 'http:' &&
					['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
		if (
			(!productionProxy && !developmentAllowed) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error('TELEGRAM_API_BASE_URL is not allowed');
		}
		return url.toString().replace(/\/+$/, '');
	}

	private field(boundary: string, name: string, value: string): string {
		return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
	}

	private timeoutSignal(
		timeoutMs: number,
		parent?: AbortSignal
	): AbortSignal {
		return parent
			? AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs);
	}

	private async telegramResult<T = unknown>(
		response: Response,
		method: string
	): Promise<T> {
		const payload = (await response.json().catch(() => null)) as {
			ok?: boolean;
			result?: T;
			description?: string;
		} | null;
		if (!response.ok || !payload?.ok || payload.result === undefined) {
			throw new Error(
				`Telegram ${method} failed: ${payload?.description?.slice(0, 500) || `HTTP ${response.status}`}`
			);
		}
		return payload.result;
	}
}
