import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

interface OperationsRequestContext {
	correlationId: string;
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storage = new AsyncLocalStorage<OperationsRequestContext>();

export const OPERATIONS_SCALAR_QUERY_PIPE: PipeTransform<
	unknown,
	string | undefined
> = {
	transform(value: unknown): string | undefined {
		if (value === undefined) return undefined;
		if (typeof value !== 'string') {
			throw new BadRequestException(
				'Query parameter must contain exactly one string value'
			);
		}
		return value;
	}
};

export function operationsRequestContextMiddleware(
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
	response.setHeader('X-WinWidget-Service', 'operations');
	storage.run({ correlationId }, next);
}

export function getOperationsCorrelationId(): string {
	return storage.getStore()?.correlationId || randomUUID();
}

export function getOperationsClientContext(request: Request): {
	ip: string | null;
	userAgent: string | null;
	correlationId: string;
} {
	return {
		ip: request.ip || request.socket?.remoteAddress || null,
		userAgent: request.get('user-agent') ?? null,
		correlationId: getOperationsCorrelationId()
	};
}
