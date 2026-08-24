import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

interface PlatformRequestContext {
	correlationId: string;
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storage = new AsyncLocalStorage<PlatformRequestContext>();

export function platformRequestContextMiddleware(
	request: Request,
	response: Response,
	next: NextFunction
): void {
	const supplied = request.header('x-correlation-id');
	const correlationId =
		typeof supplied === 'string' && UUID_PATTERN.test(supplied)
			? supplied.toLowerCase()
			: randomUUID();
	response.setHeader('X-Correlation-ID', correlationId);
	response.setHeader('X-WinWidget-Service', 'platform');
	storage.run({ correlationId }, next);
}

export function getPlatformCorrelationId(): string {
	return storage.getStore()?.correlationId || randomUUID();
}

export function getPlatformClientContext(request: Request): {
	ip?: string;
	userAgent: string | null;
} {
	return {
		ip: request.ip || request.socket?.remoteAddress || undefined,
		userAgent: request.get('user-agent') ?? null
	};
}
