import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export function identityRequestContext(
	request: Request,
	response: Response,
	next: NextFunction
): void {
	const requestId =
		(typeof request.headers['x-request-id'] === 'string' &&
			request.headers['x-request-id'].slice(0, 128)) ||
		randomUUID();
	const correlationId =
		(typeof request.headers['x-correlation-id'] === 'string' &&
			request.headers['x-correlation-id'].slice(0, 128)) ||
		requestId;
	request.headers['x-request-id'] = requestId;
	request.headers['x-correlation-id'] = correlationId;
	response.setHeader('x-request-id', requestId);
	response.setHeader('x-correlation-id', correlationId);
	next();
}
