import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storage = new AsyncLocalStorage<{ correlationId: string }>();

export function crmAccessRequestContextMiddleware(
	request: Request,
	response: Response,
	next: NextFunction
): void {
	const supplied = request.header('x-correlation-id');
	const correlationId =
		typeof supplied === 'string' && UUID_V4.test(supplied)
			? supplied.toLowerCase()
			: randomUUID();
	response.setHeader('X-Correlation-ID', correlationId);
	response.setHeader('X-WinWidget-Service', 'crm-access');
	storage.run({ correlationId }, next);
}

export function getCrmAccessCorrelationId(): string {
	return storage.getStore()?.correlationId || randomUUID();
}
