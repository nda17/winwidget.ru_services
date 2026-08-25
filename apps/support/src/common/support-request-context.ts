import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storage = new AsyncLocalStorage<{ correlationId: string }>();

export function supportRequestContextMiddleware(
	request: Request,
	response: Response,
	next: NextFunction
): void {
	const supplied = request.header('x-correlation-id');
	const correlationId =
		typeof supplied === 'string' && UUID.test(supplied)
			? supplied.toLowerCase()
			: randomUUID();
	response.setHeader('X-Correlation-ID', correlationId);
	response.setHeader('X-WinWidget-Service', 'support');
	storage.run({ correlationId }, next);
}

export function getSupportCorrelationId(): string {
	return storage.getStore()?.correlationId || randomUUID();
}

export function getSupportClientContext(request: Request): {
	ip: string | null;
	userAgent: string | null;
} {
	return {
		ip:
			(request.ip || request.socket.remoteAddress || '').slice(0, 128) ||
			null,
		userAgent: request.get('user-agent')?.slice(0, 500) || null
	};
}

export function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		2000
	);
}
