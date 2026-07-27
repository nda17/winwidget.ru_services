import { NotificationDeliveryKind } from './messaging.constants';

export const INTEGRATION_ERROR_CATEGORIES = [
	'TRANSIENT',
	'RATE_LIMIT',
	'PERMANENT',
	'AUTH_CONFIGURATION'
] as const;

export type IntegrationErrorCategory =
	(typeof INTEGRATION_ERROR_CATEGORIES)[number];

export const INTEGRATION_ERROR_CLASSIFICATION_VERSION = 1;

export interface IntegrationErrorClassification {
	category: IntegrationErrorCategory;
	normalizedCode: string;
	retryable: boolean;
	retryDelayMs: number | null;
	safeReason: string;
	recognized: boolean;
	mayDisableDestination: boolean;
	classificationVersion: number;
}

interface ClassificationInput {
	category: IntegrationErrorCategory;
	normalizedCode: string;
	safeReason: string;
	recognized?: boolean;
	retryDelayMs?: number | null;
	mayDisableDestination?: boolean;
}

interface TelegramErrorDetails {
	code: string | null;
	httpStatus: number | null;
	description: string | null;
	retryAfterMs: number | null;
	migrateToChatId: boolean;
}

interface SmtpErrorDetails {
	code: string | null;
	responseCode: number | null;
	enhancedCode: string | null;
	responseText: string;
	retryAfterMs: number | null;
}

const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 30_000;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

const SMTP_TRANSIENT_CODES = new Set([
	'ECONNECTION',
	'ECONNREFUSED',
	'ECONNRESET',
	'EDNS',
	'EAI_AGAIN',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ESOCKET',
	'ETIMEDOUT'
]);
const SMTP_PERMANENT_CODES = new Set(['EENVELOPE', 'EMESSAGE']);

export function classifyIntegrationError(
	kind: NotificationDeliveryKind,
	error: unknown
): IntegrationErrorClassification {
	const destination = classifyDestinationError(error);
	if (destination) return destination;

	if (kind === 'telegram') {
		const telegram = classifyTelegramError(error);
		if (telegram) return telegram;
	} else {
		const smtp = classifySmtpError(error);
		if (smtp) return smtp;
	}

	return unclassified();
}

function classifyDestinationError(
	error: unknown
): IntegrationErrorClassification | null {
	const record = toRecord(error);
	const code = normalizeCode(readString(record?.code));
	if (
		!code ||
		![
			'DESTINATION_SNAPSHOT_MISSING',
			'DESTINATION_SNAPSHOT_INVALID',
			'DESTINATION_CONFIGURATION_MISSING',
			'DESTINATION_TARGET_CHANGED'
		].includes(code)
	) {
		return null;
	}
	return createClassification({
		category: 'AUTH_CONFIGURATION',
		normalizedCode: code,
		safeReason:
			code === 'DESTINATION_TARGET_CHANGED'
				? 'Integration destination changed; automatic redirection is blocked'
				: 'Integration destination configuration is unavailable'
	});
}

function classifyTelegramError(
	error: unknown
): IntegrationErrorClassification | null {
	const details = getTelegramErrorDetails(error);
	if (!details) {
		const message = error instanceof Error ? error.message : '';
		if (
			/telegram.+(?:not configured|configuration is missing)/i.test(
				message
			)
		) {
			return createClassification({
				category: 'AUTH_CONFIGURATION',
				normalizedCode: 'TELEGRAM_CONFIGURATION_MISSING',
				safeReason: 'Telegram configuration is missing'
			});
		}
		return null;
	}

	if (details.httpStatus === 429 || details.retryAfterMs !== null) {
		return createClassification({
			category: 'RATE_LIMIT',
			normalizedCode: 'TELEGRAM_RATE_LIMIT',
			retryDelayMs: normalizeRetryDelay(
				details.retryAfterMs,
				DEFAULT_RATE_LIMIT_RETRY_DELAY_MS
			),
			safeReason: 'Telegram rate limit exceeded'
		});
	}

	if (
		details.code === 'TELEGRAM_TRANSPORT_TIMEOUT' ||
		details.code === 'TELEGRAM_TRANSPORT_ERROR'
	) {
		return createClassification({
			category: 'TRANSIENT',
			normalizedCode: details.code,
			safeReason:
				details.code === 'TELEGRAM_TRANSPORT_TIMEOUT'
					? 'Telegram request timed out'
					: 'Telegram transport request failed'
		});
	}

	if (details.httpStatus === 401) {
		return createClassification({
			category: 'AUTH_CONFIGURATION',
			normalizedCode: 'TELEGRAM_BOT_AUTHENTICATION_FAILED',
			safeReason: 'Telegram bot authentication failed'
		});
	}

	if (
		details.httpStatus === 408 ||
		(details.httpStatus !== null && details.httpStatus >= 500)
	) {
		return createClassification({
			category: 'TRANSIENT',
			normalizedCode: `TELEGRAM_HTTP_${details.httpStatus}`,
			safeReason: 'Telegram is temporarily unavailable'
		});
	}

	if (details.migrateToChatId) {
		return createClassification({
			category: 'PERMANENT',
			normalizedCode: 'TELEGRAM_CHAT_MIGRATED',
			safeReason: 'Telegram chat migrated to another identifier'
		});
	}

	const description = details.description?.trim().toLowerCase() || '';
	const destinationFailure = getTelegramDestinationFailure(description);
	if (destinationFailure) {
		return createClassification({
			category: 'PERMANENT',
			normalizedCode: destinationFailure,
			safeReason: 'Telegram destination is no longer available',
			mayDisableDestination: true
		});
	}

	if (
		[
			"can't parse entities",
			'message is too long',
			'message text is empty',
			'unsupported parse_mode'
		].some(reason => description.includes(reason))
	) {
		return createClassification({
			category: 'PERMANENT',
			normalizedCode: 'TELEGRAM_INVALID_MESSAGE',
			safeReason: 'Telegram rejected the message payload'
		});
	}

	return unclassified();
}

function getTelegramDestinationFailure(
	description: string
): string | null {
	if (description.includes('chat not found')) {
		return 'TELEGRAM_CHAT_NOT_FOUND';
	}
	if (description.includes('user is deactivated')) {
		return 'TELEGRAM_USER_DEACTIVATED';
	}
	if (description.includes('bot was blocked by the user')) {
		return 'TELEGRAM_BOT_BLOCKED';
	}
	if (
		description.includes('bot was kicked from the group') ||
		description.includes('bot was kicked from the supergroup') ||
		description.includes('bot was kicked from the channel')
	) {
		return 'TELEGRAM_BOT_KICKED';
	}
	return null;
}

function getTelegramErrorDetails(
	error: unknown
): TelegramErrorDetails | null {
	const record = toRecord(error);
	let source = record;
	let httpStatus =
		readNumber(record?.httpStatus) ||
		readNumber(record?.status) ||
		readNumber(record?.error_code);

	const message = error instanceof Error ? error.message : null;
	const messageMatch = message?.match(
		/^Telegram API returned (\d{3}):\s*([\s\S]*)$/
	);
	if (messageMatch) {
		httpStatus = Number(messageMatch[1]);
		source = parseJsonRecord(messageMatch[2]) || source;
	}

	if (!source && httpStatus === null) return null;

	const parameters = toRecord(source?.parameters);
	const retryAfterSeconds = readNumber(parameters?.retry_after);
	const retryAfterMs =
		readNumber(source?.retryAfterMs) ||
		(retryAfterSeconds !== null ? retryAfterSeconds * 1000 : null);
	const description =
		readString(source?.description) ||
		readString(toRecord(source?.response)?.description);

	if (
		httpStatus === null &&
		!description &&
		retryAfterMs === null &&
		!parameters
	) {
		return null;
	}

	return {
		code: normalizeCode(readString(source?.code)),
		httpStatus: httpStatus || readNumber(source?.error_code),
		description,
		retryAfterMs,
		migrateToChatId: readNumber(parameters?.migrate_to_chat_id) !== null
	};
}

function classifySmtpError(
	error: unknown
): IntegrationErrorClassification | null {
	const details = getSmtpErrorDetails(error);
	if (!details) return null;

	if (
		details.code === 'EAUTH' ||
		details.responseCode === 530 ||
		details.responseCode === 535 ||
		details.enhancedCode === '5.7.8'
	) {
		return createClassification({
			category: 'AUTH_CONFIGURATION',
			normalizedCode: 'SMTP_AUTHENTICATION_FAILED',
			safeReason: 'SMTP authentication or configuration failed'
		});
	}

	const rateLimited =
		/(?:rate.?limit|too many|throttl)/i.test(details.responseText) &&
		(details.responseCode === null ||
			details.responseCode === 421 ||
			(details.responseCode >= 400 && details.responseCode < 500));
	if (rateLimited) {
		return createClassification({
			category: 'RATE_LIMIT',
			normalizedCode: 'SMTP_RATE_LIMIT',
			retryDelayMs: normalizeRetryDelay(
				details.retryAfterMs,
				DEFAULT_RATE_LIMIT_RETRY_DELAY_MS
			),
			safeReason: 'SMTP provider rate limit exceeded'
		});
	}

	if (
		(details.code && SMTP_TRANSIENT_CODES.has(details.code)) ||
		details.enhancedCode?.startsWith('4.') ||
		(details.responseCode !== null &&
			details.responseCode >= 400 &&
			details.responseCode < 500)
	) {
		return createClassification({
			category: 'TRANSIENT',
			normalizedCode: getSmtpNormalizedCode(details),
			safeReason: 'SMTP delivery failed temporarily'
		});
	}

	if (
		(details.code && SMTP_PERMANENT_CODES.has(details.code)) ||
		details.enhancedCode?.startsWith('5.') ||
		(details.responseCode !== null &&
			details.responseCode >= 500 &&
			details.responseCode < 600)
	) {
		return createClassification({
			category: 'PERMANENT',
			normalizedCode: getSmtpNormalizedCode(details),
			safeReason: 'SMTP rejected the message permanently'
		});
	}

	return unclassified();
}

function getSmtpErrorDetails(error: unknown): SmtpErrorDetails | null {
	const record = toRecord(error);
	if (!record) return null;

	const code = normalizeCode(readString(record.code));
	const responseCode =
		readNumber(record.responseCode) || readNumber(record.statusCode);
	const message = error instanceof Error ? error.message : '';
	const response = readString(record.response) || '';
	const responseText = `${response} ${message}`.slice(0, 2000);
	const enhancedCode =
		responseText.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1] || null;
	const retryAfterMs = readNumber(record.retryAfterMs);

	if (!code && responseCode === null && !enhancedCode && !response) {
		return null;
	}

	return {
		code,
		responseCode,
		enhancedCode,
		responseText,
		retryAfterMs
	};
}

function getSmtpNormalizedCode(details: SmtpErrorDetails): string {
	if (details.enhancedCode) {
		return `SMTP_${details.enhancedCode.replace(/\./g, '_')}`;
	}
	if (details.responseCode !== null) {
		return `SMTP_${details.responseCode}`;
	}
	return details.code ? `SMTP_${details.code}` : 'SMTP_ERROR';
}

function createClassification(
	input: ClassificationInput
): IntegrationErrorClassification {
	const retryable =
		input.category === 'TRANSIENT' || input.category === 'RATE_LIMIT';
	return {
		category: input.category,
		normalizedCode: input.normalizedCode,
		retryable,
		retryDelayMs: retryable
			? normalizeRetryDelay(
					input.retryDelayMs,
					input.category === 'RATE_LIMIT'
						? DEFAULT_RATE_LIMIT_RETRY_DELAY_MS
						: DEFAULT_TRANSIENT_RETRY_DELAY_MS
				)
			: null,
		safeReason: input.safeReason,
		recognized: input.recognized ?? true,
		mayDisableDestination: input.mayDisableDestination ?? false,
		classificationVersion: INTEGRATION_ERROR_CLASSIFICATION_VERSION
	};
}

function unclassified(): IntegrationErrorClassification {
	return createClassification({
		category: 'TRANSIENT',
		normalizedCode: 'UNCLASSIFIED',
		safeReason: 'Unclassified integration error',
		recognized: false
	});
}

function normalizeRetryDelay(
	value: number | null | undefined,
	fallback: number
): number {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(Math.max(Math.round(value), 1000), MAX_RETRY_DELAY_MS);
}

function normalizeCode(value: string | null): string | null {
	if (!value) return null;
	const normalized = value.trim().toUpperCase();
	return /^[A-Z\d_.:-]{1,100}$/.test(normalized)
		? normalized.replace(/[.:-]/g, '_')
		: null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
	try {
		return toRecord(JSON.parse(value) as unknown);
	} catch {
		return null;
	}
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: null;
}
