import { createMessagingHeaders } from '../messaging/messaging-context';
import { IntegrationErrorClassification } from '../messaging/integration-error-classifier';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/notification-delivery-client';
import type { ConsumeMessage } from 'amqplib';
import { getScalarMessageHeaders } from './notification-delivery-contract';

const SAFE_HEADER_NAMES = new Set([
	'x-correlation-id',
	'x-request-id',
	'x-causation-id',
	'x-retry-attempt',
	'x-first-failed-at',
	'x-delivery-token',
	'x-last-error',
	'x-error-category',
	'x-error-code',
	'x-safe-reason',
	'x-error-retryable',
	'x-classification-version',
	'x-http-status',
	'x-provider-code'
]);

export interface NotificationDeliveryFailureMetadata {
	httpStatus: number | null;
	providerCode: string | null;
}

@Injectable()
export class NotificationDeliveryMessageMetadataService {
	failureHeaders(
		message: ConsumeMessage,
		eventId: string,
		attempt: number,
		firstFailedAt: Date,
		classification: IntegrationErrorClassification,
		metadata: NotificationDeliveryFailureMetadata,
		deliveryToken?: string
	): Prisma.InputJsonObject {
		return createMessagingHeaders({
			messageId: eventId,
			causationId: eventId,
			headers: {
				...this.filterSafeHeaders(getScalarMessageHeaders(message)),
				'x-retry-attempt': attempt,
				'x-first-failed-at': firstFailedAt.toISOString(),
				'x-last-error': classification.safeReason.slice(0, 1000),
				'x-error-category': classification.category,
				'x-error-code': classification.normalizedCode.slice(0, 255),
				'x-safe-reason': classification.safeReason.slice(0, 1000),
				'x-error-retryable': classification.retryable,
				'x-classification-version': classification.classificationVersion,
				...(metadata.httpStatus
					? { 'x-http-status': metadata.httpStatus }
					: {}),
				...(metadata.providerCode
					? { 'x-provider-code': metadata.providerCode }
					: {}),
				...(deliveryToken ? { 'x-delivery-token': deliveryToken } : {})
			}
		}) as Prisma.InputJsonObject;
	}

	filterSafeHeaders(
		headers: Record<string, string | number | boolean>
	): Record<string, string | number | boolean> {
		return Object.fromEntries(
			Object.entries(headers).filter(([name]) =>
				SAFE_HEADER_NAMES.has(name)
			)
		);
	}

	failureMetadata(error: unknown): NotificationDeliveryFailureMetadata {
		const details =
			error && typeof error === 'object'
				? (error as Record<string, unknown>)
				: null;
		const status = Number(
			details?.httpStatus || details?.status || details?.responseCode
		);
		const rawProviderCode =
			typeof details?.providerCode === 'string'
				? details.providerCode
				: typeof details?.errorCode === 'string' ||
					  typeof details?.errorCode === 'number'
					? String(details.errorCode)
					: typeof details?.code === 'string'
						? details.code
						: null;
		return {
			httpStatus:
				Number.isInteger(status) && status >= 100 && status <= 599
					? status
					: null,
			providerCode: rawProviderCode?.slice(0, 255) || null
		};
	}

	retryAttempt(message: ConsumeMessage): number {
		const value = Number(message.properties.headers?.['x-retry-attempt']);
		return Number.isInteger(value) && value >= 0 && value <= 1_000_000
			? value
			: 0;
	}

	stringHeader(message: ConsumeMessage, name: string): string | null {
		const value = message.properties.headers?.[name];
		if (typeof value === 'string') return value;
		if (Buffer.isBuffer(value)) return value.toString('utf8');
		return null;
	}

	numberHeader(message: ConsumeMessage, name: string): number | null {
		const value = Number(message.properties.headers?.[name]);
		return Number.isInteger(value) && value >= 0 && value <= 1_000_000
			? value
			: null;
	}

	booleanHeader(message: ConsumeMessage, name: string): boolean | null {
		const value = message.properties.headers?.[name];
		if (typeof value === 'boolean') return value;
		if (value === 'true' || value === 1) return true;
		if (value === 'false' || value === 0) return false;
		return null;
	}

	headerDate(message: ConsumeMessage, name: string, fallback: Date): Date {
		const value = this.stringHeader(message, name);
		const timestamp = value ? Date.parse(value) : Number.NaN;
		return Number.isFinite(timestamp) &&
			timestamp <= fallback.getTime() + 60_000
			? new Date(timestamp)
			: fallback;
	}
}
