import type { NextFunction, Request, Response } from 'express';
import type { ConsumeMessage } from 'amqplib';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const CONTEXT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface MessagingContext {
	correlationId: string;
	requestId: string;
	causationId?: string;
}

interface CreateMessagingHeadersOptions {
	messageId: string;
	causationId?: string;
	headers?: Record<string, string | number | boolean>;
}

const storage = new AsyncLocalStorage<MessagingContext>();

const normalizeContextId = (value: unknown): string | null => {
	const normalized = Buffer.isBuffer(value)
		? value.toString('utf8')
		: typeof value === 'string'
			? value
			: null;
	if (!normalized || !CONTEXT_ID_PATTERN.test(normalized)) return null;
	return normalized;
};

const getRequestHeader = (
	request: Request,
	name: string
): string | null => {
	const value = request.headers[name];
	return normalizeContextId(Array.isArray(value) ? value[0] : value);
};

const getMessageHeader = (
	message: ConsumeMessage,
	name: string
): string | null => normalizeContextId(message.properties.headers?.[name]);

export function messagingContextMiddleware(
	request: Request,
	response: Response,
	next: NextFunction
): void {
	const requestId =
		getRequestHeader(request, 'x-request-id') || randomUUID();
	const correlationId =
		getRequestHeader(request, 'x-correlation-id') || requestId;

	response.setHeader('X-Request-Id', requestId);
	response.setHeader('X-Correlation-Id', correlationId);
	storage.run({ requestId, correlationId }, next);
}

export function runWithMessageContext<T>(
	message: ConsumeMessage,
	callback: () => T
): T {
	const messageId = normalizeContextId(message.properties.messageId);
	const correlationId =
		getMessageHeader(message, 'x-correlation-id') ||
		normalizeContextId(message.properties.correlationId) ||
		messageId ||
		randomUUID();
	const requestId =
		getMessageHeader(message, 'x-request-id') || correlationId;
	const causationId =
		getMessageHeader(message, 'x-causation-id') || messageId || undefined;

	return storage.run(
		{
			correlationId,
			requestId,
			...(causationId ? { causationId } : {})
		},
		callback
	);
}

export function createMessagingHeaders({
	messageId,
	causationId,
	headers = {}
}: CreateMessagingHeadersOptions): Record<
	string,
	string | number | boolean
> {
	const context = storage.getStore();
	const correlationId =
		normalizeContextId(headers['x-correlation-id']) ||
		context?.correlationId ||
		messageId;
	const requestId =
		normalizeContextId(headers['x-request-id']) ||
		context?.requestId ||
		correlationId;
	const resolvedCausationId =
		normalizeContextId(causationId) ||
		normalizeContextId(headers['x-causation-id']) ||
		context?.causationId ||
		undefined;

	return {
		...headers,
		'x-correlation-id': correlationId,
		'x-request-id': requestId,
		...(resolvedCausationId
			? { 'x-causation-id': resolvedCausationId }
			: {})
	};
}

export function getCurrentCorrelationId(): string | null {
	return storage.getStore()?.correlationId || null;
}
