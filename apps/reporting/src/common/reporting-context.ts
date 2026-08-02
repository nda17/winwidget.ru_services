import type { NextFunction, Request, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface ReportingContextValue {
	requestId: string;
	correlationId: string;
}

const storage = new AsyncLocalStorage<ReportingContextValue>();
const SAFE_CONTEXT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function header(request: Request, name: string): string | null {
	const value = request.headers[name];
	const candidate = Array.isArray(value) ? value[0] : value;
	return typeof candidate === 'string' && SAFE_CONTEXT_ID.test(candidate)
		? candidate
		: null;
}

export function reportingContextMiddleware(
	request: Request,
	response: Response,
	next: NextFunction
): void {
	const requestId = header(request, 'x-request-id') || randomUUID();
	const correlationId = header(request, 'x-correlation-id') || requestId;
	response.setHeader('X-Request-Id', requestId);
	response.setHeader('X-Correlation-Id', correlationId);
	storage.run({ requestId, correlationId }, next);
}

export function getReportingRequestId(): string | null {
	return storage.getStore()?.requestId || null;
}

export function getReportingCorrelationId(): string | null {
	return storage.getStore()?.correlationId || null;
}

export function createReportingCorrelationId(): string {
	return getReportingCorrelationId() || randomUUID();
}
