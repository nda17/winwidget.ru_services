import { IntegrationErrorCategory } from '@prisma/widgets-client';
import {
	classifyWidgetsIntegrationError,
	exhaustedWidgetsRetryClassification,
	expiredWidgetsRetryClassification
} from './widgets-integration-error-classifier';
import { WidgetsIntegrationDestinationError } from './widgets-integration-delivery.service';
import { WidgetsSafeHttpError } from './widgets-safe-http.service';

const httpError = (
	provider: 'webhook' | 'bitrix24' | 'amo-crm',
	input: {
		status?: number | null;
		code?: string | null;
		retryAfterMs?: number | null;
	} = {}
) =>
	new WidgetsSafeHttpError({
		provider,
		httpStatus: input.status ?? null,
		providerCode: input.code ?? null,
		retryAfterMs: input.retryAfterMs ?? null,
		safeReason: 'Safe provider failure'
	});

describe('classifyWidgetsIntegrationError', () => {
	it('classifies HTTP 429 before generic 4xx and respects Retry-After', () => {
		expect(
			classifyWidgetsIntegrationError(
				'webhook',
				httpError('webhook', {
					status: 429,
					code: 'HTTP_429',
					retryAfterMs: 12_000
				})
			)
		).toMatchObject({
			category: IntegrationErrorCategory.RATE_LIMIT,
			normalizedCode: 'WEBHOOK_HTTP_429',
			retryable: true,
			retryDelayMs: 12_000,
			httpStatus: 429,
			providerCode: 'HTTP_429'
		});
	});

	it.each([
		[401, IntegrationErrorCategory.AUTH_CONFIGURATION, false],
		[403, IntegrationErrorCategory.AUTH_CONFIGURATION, false],
		[408, IntegrationErrorCategory.TRANSIENT, true],
		[500, IntegrationErrorCategory.TRANSIENT, true],
		[400, IntegrationErrorCategory.PERMANENT, false]
	])('classifies webhook HTTP %s', (status, category, retryable) => {
		expect(
			classifyWidgetsIntegrationError(
				'webhook',
				httpError('webhook', { status, code: `HTTP_${status}` })
			)
		).toMatchObject({ category, retryable });
	});

	it('recognizes Bitrix24 rate limit returned inside HTTP 200', () => {
		expect(
			classifyWidgetsIntegrationError(
				'bitrix24',
				httpError('bitrix24', {
					status: 200,
					code: 'QUERY_LIMIT_EXCEEDED'
				})
			)
		).toMatchObject({
			category: IntegrationErrorCategory.RATE_LIMIT,
			retryable: true,
			retryDelayMs: 60_000
		});
	});

	it('recognizes amoCRM authentication codes', () => {
		expect(
			classifyWidgetsIntegrationError(
				'amo-crm',
				httpError('amo-crm', { status: 401, code: 'UNAUTHORIZED' })
			)
		).toMatchObject({
			category: IntegrationErrorCategory.AUTH_CONFIGURATION,
			retryable: false
		});
	});

	it('maps transport failures to retryable transient failures', () => {
		expect(
			classifyWidgetsIntegrationError(
				'webhook',
				httpError('webhook', { code: 'TRANSPORT_TIMEOUT' })
			)
		).toMatchObject({
			category: IntegrationErrorCategory.TRANSIENT,
			normalizedCode: 'WEBHOOK_TRANSPORT_TIMEOUT',
			retryable: true,
			retryDelayMs: 30_000
		});
	});

	it('fails closed for missing or changed credential snapshots', () => {
		expect(
			classifyWidgetsIntegrationError(
				'webhook',
				new WidgetsIntegrationDestinationError(
					'DESTINATION_TARGET_CHANGED',
					'raw destination detail'
				)
			)
		).toMatchObject({
			category: IntegrationErrorCategory.AUTH_CONFIGURATION,
			normalizedCode: 'DESTINATION_TARGET_CHANGED',
			retryable: false,
			safeReason:
				'Integration destination changed; automatic redirection is blocked'
		});
	});

	it('allows only one bounded retry for an unclassified error', () => {
		expect(
			classifyWidgetsIntegrationError(
				'webhook',
				new Error('raw secret detail')
			)
		).toMatchObject({
			category: IntegrationErrorCategory.TRANSIENT,
			normalizedCode: 'UNCLASSIFIED',
			retryable: true,
			recognized: false,
			safeReason: 'Unclassified integration error'
		});
	});

	it('bounds provider retry delay to one day', () => {
		expect(
			classifyWidgetsIntegrationError(
				'webhook',
				httpError('webhook', {
					status: 429,
					code: 'HTTP_429',
					retryAfterMs: Number.MAX_SAFE_INTEGER
				})
			).retryDelayMs
		).toBe(24 * 60 * 60 * 1000);
	});
});

describe('terminal retry classifications', () => {
	it('marks an expired automatic retry window as permanent', () => {
		expect(expiredWidgetsRetryClassification()).toMatchObject({
			category: IntegrationErrorCategory.PERMANENT,
			normalizedCode: 'AUTOMATIC_RETRY_WINDOW_EXPIRED',
			retryable: false
		});
	});

	it('preserves diagnostics while making an exhausted retry terminal', () => {
		const retryable = classifyWidgetsIntegrationError(
			'webhook',
			httpError('webhook', { status: 500, code: 'HTTP_500' })
		);
		expect(exhaustedWidgetsRetryClassification(retryable)).toMatchObject({
			normalizedCode: retryable.normalizedCode,
			retryable: false,
			retryDelayMs: null
		});
	});
});
