import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';

interface TelegramErrorParameters {
	retry_after?: number;
	migrate_to_chat_id?: number;
}

export class TelegramApiError extends Error {
	readonly code: string;
	readonly httpStatus: number;
	readonly errorCode: number;
	readonly description: string;
	readonly retryAfterMs: number | null;
	readonly parameters: TelegramErrorParameters | null;

	constructor(input: {
		httpStatus: number;
		errorCode?: number;
		code?: string;
		description: string;
		parameters?: TelegramErrorParameters | null;
	}) {
		super(input.description);
		this.name = 'TelegramApiError';
		this.code = input.code || 'TELEGRAM_API_ERROR';
		this.httpStatus = input.httpStatus;
		this.errorCode = input.errorCode || input.httpStatus;
		this.description = input.description.slice(0, 500);
		this.parameters = input.parameters || null;
		this.retryAfterMs =
			typeof this.parameters?.retry_after === 'number'
				? Math.max(0, this.parameters.retry_after * 1000)
				: null;
	}
}

@Injectable()
export class TelegramInfoTransportService {
	private readonly messageTimeoutMs = 10_000;
	private readonly documentTimeoutMs = 10 * 60 * 1000;

	constructor(private readonly configService: ConfigService) {}

	async sendMessage(
		chatId: string,
		text: string,
		options: {
			messageThreadId?: number;
			parseMode?: 'HTML' | null;
			signal?: AbortSignal;
		} = {}
	): Promise<void> {
		const token = this.getToken();
		await this.withTimeout(
			this.messageTimeoutMs,
			options.signal,
			async signal => {
				const response = await fetch(
					`https://api.telegram.org/bot${token}/sendMessage`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							chat_id: chatId,
							...(options.messageThreadId
								? {
										message_thread_id: options.messageThreadId
									}
								: {}),
							text,
							...(options.parseMode === null
								? {}
								: { parse_mode: options.parseMode || 'HTML' }),
							disable_web_page_preview: true
						}),
						signal
					}
				);
				await this.assertTelegramResponse(response, 'sendMessage');
			}
		);
	}

	async sendDocument(
		chatId: string,
		filePath: string,
		caption: string,
		options: {
			messageThreadId: number;
			signal?: AbortSignal;
		}
	): Promise<void> {
		const token = this.getToken();
		const file = await stat(filePath);
		const boundary = `winwidget-${randomBytes(18).toString('hex')}`;
		const fileName = basename(filePath).replace(/["\r\n]/g, '_');
		const prefix = Buffer.from(
			[
				this.field(boundary, 'chat_id', chatId),
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
		const contentLength = prefix.length + file.size + suffix.length;

		await this.withTimeout(
			this.documentTimeoutMs,
			options.signal,
			async signal => {
				const body = Readable.from(
					(async function* () {
						yield prefix;
						for await (const chunk of createReadStream(filePath)) {
							yield chunk;
						}
						yield suffix;
					})()
				);
				const response = await fetch(
					`https://api.telegram.org/bot${token}/sendDocument`,
					{
						method: 'POST',
						headers: {
							'Content-Type': `multipart/form-data; boundary=${boundary}`,
							'Content-Length': String(contentLength)
						},
						body: body as unknown as BodyInit,
						duplex: 'half',
						signal
					} as RequestInit & { duplex: 'half' }
				);
				await this.assertTelegramResponse(response, 'sendDocument');
			}
		);
	}

	private field(boundary: string, name: string, value: string): string {
		return [
			`--${boundary}\r\n`,
			`Content-Disposition: form-data; name="${name}"\r\n\r\n`,
			value,
			'\r\n'
		].join('');
	}

	private getToken(): string {
		const token = this.configService
			.get<string>('TELEGRAM_INFO_BOT_TOKEN')
			?.trim();
		if (!token) {
			throw new TelegramApiError({
				httpStatus: 401,
				description: 'Telegram bot token is not configured'
			});
		}
		return token;
	}

	private async assertTelegramResponse(
		response: Response,
		method: string
	): Promise<void> {
		const data = (await response.json().catch(() => null)) as {
			ok?: boolean;
			error_code?: number;
			description?: string;
			parameters?: TelegramErrorParameters;
		} | null;
		if (!response.ok || !data?.ok) {
			throw new TelegramApiError({
				httpStatus: response.status,
				errorCode: data?.error_code,
				description:
					data?.description ||
					`Telegram ${method} failed with HTTP ${response.status}`,
				parameters: data?.parameters
			});
		}
	}

	private async withTimeout<T>(
		timeoutMs: number,
		parentSignal: AbortSignal | undefined,
		action: (signal: AbortSignal) => Promise<T>
	): Promise<T> {
		const controller = new AbortController();
		let timedOut = false;
		const abort = () => controller.abort(parentSignal?.reason);
		if (parentSignal?.aborted) abort();
		parentSignal?.addEventListener('abort', abort, { once: true });
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error('Telegram request timed out'));
		}, timeoutMs);
		timeout.unref();
		try {
			return await action(controller.signal);
		} catch (error) {
			if (error instanceof TelegramApiError || parentSignal?.aborted) {
				throw error;
			}
			throw new TelegramApiError({
				httpStatus: 0,
				errorCode: 0,
				code: timedOut
					? 'TELEGRAM_TRANSPORT_TIMEOUT'
					: 'TELEGRAM_TRANSPORT_ERROR',
				description: timedOut
					? 'Telegram request timed out'
					: 'Telegram transport request failed'
			});
		} finally {
			clearTimeout(timeout);
			parentSignal?.removeEventListener('abort', abort);
		}
	}
}
