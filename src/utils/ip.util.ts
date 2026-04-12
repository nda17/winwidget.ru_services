import { Request } from 'express';

export const getClientIp = (request: Request): string | undefined => {
	const forwardedFor = request.headers['x-forwarded-for'];
	const realIp = request.headers['x-real-ip'];
	const cfIp = request.headers['cf-connecting-ip'];

	if (typeof cfIp === 'string' && cfIp.length > 0) {
		return cfIp.trim();
	}

	if (typeof realIp === 'string' && realIp.length > 0) {
		return realIp.trim();
	}

	if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
		return forwardedFor.split(',')[0].trim();
	}

	return request.ip ?? undefined;
};
