import {
	classifyIntegrationError,
	INTEGRATION_ERROR_CATEGORIES,
	INTEGRATION_ERROR_CLASSIFICATION_VERSION
} from '@/messaging/integration-error-classifier';
import { IntegrationKind } from '@/messaging/messaging.constants';
import { SafeOutboundHttpError } from '@/safe-outbound-http/safe-outbound-http.error';

describe('classifyIntegrationError', () => {
	it('экспортирует ровно четыре категории', () => {
		expect(INTEGRATION_ERROR_CATEGORIES).toEqual([
			'TRANSIENT',
			'RATE_LIMIT',
			'PERMANENT',
			'AUTH_CONFIGURATION'
		]);
	});

	it.each<[string, IntegrationKind, unknown, Record<string, unknown>]>([
		[
			'Telegram rate limit with retry_after',
			'telegram',
			{
				error_code: 429,
				description: 'Too Many Requests: retry later',
				parameters: { retry_after: 12 }
			},
			{
				category: 'RATE_LIMIT',
				normalizedCode: 'TELEGRAM_RATE_LIMIT',
				retryable: true,
				retryDelayMs: 12_000,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'current Telegram blocked-user error',
			'mailing-telegram',
			new Error(
				'Telegram API returned 403: {"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}'
			),
			{
				category: 'PERMANENT',
				normalizedCode: 'TELEGRAM_BOT_BLOCKED',
				retryable: false,
				retryDelayMs: null,
				recognized: true,
				mayDisableDestination: true
			}
		],
		[
			'temporary YooKassa transport failure',
			'auto-renewal',
			Object.assign(new Error('ЮKassa временно недоступна'), {
				code: 'YOOKASSA_NETWORK',
				httpStatus: null,
				retryAfterMs: 30_000
			}),
			{
				category: 'TRANSIENT',
				normalizedCode: 'YOOKASSA_NETWORK',
				retryable: true,
				retryDelayMs: 30_000,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'permanent YooKassa request rejection',
			'auto-renewal',
			Object.assign(new Error('ЮKassa отклонила запрос'), {
				code: 'YOOKASSA_HTTP_400',
				httpStatus: 400,
				retryAfterMs: null
			}),
			{
				category: 'PERMANENT',
				normalizedCode: 'YOOKASSA_HTTP_400',
				retryable: false,
				retryDelayMs: null,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'Telegram formatting error',
			'limit-telegram',
			new Error(
				`Telegram API returned 400: {"ok":false,"error_code":400,"description":"Bad Request: can't parse entities"}`
			),
			{
				category: 'PERMANENT',
				normalizedCode: 'TELEGRAM_INVALID_MESSAGE',
				retryable: false,
				retryDelayMs: null,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'Telegram transport timeout',
			'telegram',
			Object.assign(new Error('Telegram request timed out'), {
				code: 'TELEGRAM_TRANSPORT_TIMEOUT',
				httpStatus: 0,
				description: 'Telegram request timed out'
			}),
			{
				category: 'TRANSIENT',
				normalizedCode: 'TELEGRAM_TRANSPORT_TIMEOUT',
				retryable: true,
				retryDelayMs: 30_000,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'Nodemailer timeout',
			'email',
			Object.assign(new Error('connect ETIMEDOUT'), {
				code: 'ETIMEDOUT'
			}),
			{
				category: 'TRANSIENT',
				normalizedCode: 'SMTP_ETIMEDOUT',
				retryable: true,
				retryDelayMs: 30_000,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'SMTP authentication failure',
			'payment-email',
			Object.assign(new Error('authentication failed'), {
				code: 'EAUTH',
				responseCode: 535,
				response: '535 5.7.8 Authentication credentials invalid'
			}),
			{
				category: 'AUTH_CONFIGURATION',
				normalizedCode: 'SMTP_AUTHENTICATION_FAILED',
				retryable: false,
				retryDelayMs: null,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'SMTP permanent recipient failure',
			'mailing-email',
			Object.assign(new Error('delivery rejected'), {
				responseCode: 550,
				response: '550 5.1.1 Mailbox does not exist'
			}),
			{
				category: 'PERMANENT',
				normalizedCode: 'SMTP_5_1_1',
				retryable: false,
				retryDelayMs: null,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'generic webhook rate limit',
			'webhook',
			new SafeOutboundHttpError({
				provider: 'webhook',
				httpStatus: 429,
				providerCode: 'HTTP_429',
				retryAfterMs: 20_000,
				safeReason: 'Webhook request failed (HTTP_429)'
			}),
			{
				category: 'RATE_LIMIT',
				normalizedCode: 'WEBHOOK_HTTP_429',
				retryable: true,
				retryDelayMs: 20_000,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'temporary webhook DNS failure',
			'webhook',
			new SafeOutboundHttpError({
				provider: 'webhook',
				httpStatus: null,
				providerCode: 'DNS_TEMPORARY',
				retryAfterMs: null,
				safeReason: 'Outbound integration DNS lookup failed temporarily'
			}),
			{
				category: 'TRANSIENT',
				normalizedCode: 'WEBHOOK_DNS_TEMPORARY',
				retryable: true,
				retryDelayMs: 30_000,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'missing webhook DNS destination',
			'webhook',
			new SafeOutboundHttpError({
				provider: 'webhook',
				httpStatus: null,
				providerCode: 'DNS_NOT_FOUND',
				retryAfterMs: null,
				safeReason: 'Outbound integration DNS destination was not found'
			}),
			{
				category: 'AUTH_CONFIGURATION',
				normalizedCode: 'WEBHOOK_DNS_NOT_FOUND',
				retryable: false,
				retryDelayMs: null,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'amoCRM validation error',
			'amo-crm',
			new SafeOutboundHttpError({
				provider: 'amo-crm',
				httpStatus: 400,
				providerCode: 'NotSupportedChoice',
				retryAfterMs: null,
				safeReason: 'amoCRM request failed (NotSupportedChoice)'
			}),
			{
				category: 'PERMANENT',
				normalizedCode: 'AMO_CRM_NOTSUPPORTEDCHOICE',
				retryable: false,
				retryDelayMs: null,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'amoCRM authorization failure',
			'amo-crm',
			new SafeOutboundHttpError({
				provider: 'amo-crm',
				httpStatus: 401,
				providerCode: 'HTTP_401',
				retryAfterMs: null,
				safeReason: 'amoCRM request failed (HTTP_401)'
			}),
			{
				category: 'AUTH_CONFIGURATION',
				normalizedCode: 'AMO_CRM_HTTP_401',
				retryable: false,
				retryDelayMs: null,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'Bitrix24 QUERY_LIMIT_EXCEEDED despite HTTP 503',
			'bitrix24',
			new SafeOutboundHttpError({
				provider: 'bitrix24',
				httpStatus: 503,
				providerCode: 'QUERY_LIMIT_EXCEEDED',
				retryAfterMs: null,
				safeReason: 'Bitrix24 request failed (QUERY_LIMIT_EXCEEDED)'
			}),
			{
				category: 'RATE_LIMIT',
				normalizedCode: 'BITRIX24_QUERY_LIMIT_EXCEEDED',
				retryable: true,
				retryDelayMs: 60_000,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'Bitrix24 manual overload block despite HTTP 503',
			'bitrix24',
			new SafeOutboundHttpError({
				provider: 'bitrix24',
				httpStatus: 503,
				providerCode: 'OVERLOAD_LIMIT',
				retryAfterMs: null,
				safeReason: 'Bitrix24 request failed (OVERLOAD_LIMIT)'
			}),
			{
				category: 'AUTH_CONFIGURATION',
				normalizedCode: 'BITRIX24_OVERLOAD_LIMIT',
				retryable: false,
				retryDelayMs: null,
				recognized: true,
				mayDisableDestination: false
			}
		],
		[
			'Bitrix24 deleted portal despite HTTP 500',
			'bitrix24',
			new SafeOutboundHttpError({
				provider: 'bitrix24',
				httpStatus: 500,
				providerCode: 'PORTAL_DELETED',
				retryAfterMs: null,
				safeReason: 'Bitrix24 request failed (PORTAL_DELETED)'
			}),
			{
				category: 'AUTH_CONFIGURATION',
				normalizedCode: 'BITRIX24_PORTAL_DELETED',
				retryable: false,
				retryDelayMs: null,
				recognized: true,
				mayDisableDestination: false
			}
		]
	])('%s', (_name, kind, error, expected) => {
		expect(classifyIntegrationError(kind, error)).toEqual({
			...expected,
			safeReason: expect.any(String),
			classificationVersion: INTEGRATION_ERROR_CLASSIFICATION_VERSION
		});
	});

	it('использует безопасный TRANSIENT fallback без пятой категории', () => {
		const result = classifyIntegrationError(
			'webhook',
			new Error(
				'unknown failure token=private-token https://private.example.test'
			)
		);

		expect(result).toEqual({
			category: 'TRANSIENT',
			normalizedCode: 'UNCLASSIFIED',
			retryable: true,
			retryDelayMs: 30_000,
			safeReason: 'Unclassified integration error',
			recognized: false,
			mayDisableDestination: false,
			classificationVersion: INTEGRATION_ERROR_CLASSIFICATION_VERSION
		});
		expect(JSON.stringify(result)).not.toContain('private-token');
		expect(JSON.stringify(result)).not.toContain('private.example.test');
	});

	it('не отключает Telegram destination для неизвестного 403', () => {
		const result = classifyIntegrationError(
			'telegram',
			new Error(
				'Telegram API returned 403: {"ok":false,"error_code":403,"description":"Forbidden"}'
			)
		);

		expect(result).toMatchObject({
			category: 'TRANSIENT',
			normalizedCode: 'UNCLASSIFIED',
			recognized: false,
			mayDisableDestination: false
		});
	});
});
