import { Request } from 'express';

export const getClientIp = (request: Request): string | undefined => {
	return request.ip || request.socket?.remoteAddress || undefined;
};
