import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
		const apiBaseUrl = this.getApiBaseUrl();
		await this.withTimeout(
			this.messageTimeoutMs,
			options.signal,
			async signal => {
				const response = await fetch(
					`${apiBaseUrl}/bot${token}/sendMessage`,
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

	private getApiBaseUrl(): string {
		const mode = this.configService
			.get<string>('MODE')
			?.trim()
			.toLowerCase();
		const configured = this.configService
			.get<string>('TELEGRAM_API_BASE_URL')
			?.trim();
		if (!configured) {
			if (mode === 'production') throw this.invalidApiBaseUrl();
			return 'https://api.telegram.org';
		}

		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw this.invalidApiBaseUrl();
		}
		const loopbackHost = ['127.0.0.1', 'localhost', '[::1]'].includes(
			url.hostname
		);
		const directTelegramApi =
			url.protocol === 'https:' &&
			url.hostname === 'api.telegram.org' &&
			url.port === '' &&
			url.pathname === '/';
		const productionReverseProxy =
			url.protocol === 'https:' &&
			url.hostname === 'tg.winwidget.ru' &&
			url.port === '' &&
			url.pathname === '/telegram-api';
		const loopbackTestApi =
			mode !== 'production' && url.protocol === 'http:' && loopbackHost;
		if (
			!(mode === 'production'
				? productionReverseProxy
				: directTelegramApi ||
					productionReverseProxy ||
					loopbackTestApi) ||
			url.username !== '' ||
			url.password !== '' ||
			url.search !== '' ||
			url.hash !== ''
		) {
			throw this.invalidApiBaseUrl();
		}
		return url.toString().replace(/\/+$/, '');
	}

	private invalidApiBaseUrl(): TelegramApiError {
		return new TelegramApiError({
			httpStatus: 0,
			code: 'TELEGRAM_CONFIGURATION_INVALID',
			description: 'Telegram API base URL is not allowed'
		});
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
