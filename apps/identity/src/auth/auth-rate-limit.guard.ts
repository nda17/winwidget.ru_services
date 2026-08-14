import {
	CanActivate,
	ExecutionContext,
	HttpException,
	HttpStatus,
	Injectable
} from '@nestjs/common';
import type { Request } from 'express';
import { clientIp } from '../common/identity.util';

interface Entry {
	count: number;
	expiresAt: number;
}

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
	private static readonly storage = new Map<string, Entry>();
	private static cleanup: NodeJS.Timeout | null = null;

	constructor() {
		if (!AuthRateLimitGuard.cleanup) {
			AuthRateLimitGuard.cleanup = setInterval(() => {
				const now = Date.now();
				for (const [key, entry] of AuthRateLimitGuard.storage) {
					if (entry.expiresAt <= now)
						AuthRateLimitGuard.storage.delete(key);
				}
			}, 5 * 60_000);
			AuthRateLimitGuard.cleanup.unref();
		}
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		const path = request.route?.path || request.path;
		const { limit, windowMs } = path.includes('refresh')
			? { limit: 20, windowMs: 60_000 }
			: path.includes('telegram/complete')
				? { limit: 80, windowMs: 180_000 }
				: { limit: 10, windowMs: 600_000 };
		const key = `${clientIp(request) || 'unknown'}:${path}`;
		const now = Date.now();
		const entry = AuthRateLimitGuard.storage.get(key);
		if (!entry || entry.expiresAt <= now) {
			AuthRateLimitGuard.storage.set(key, {
				count: 1,
				expiresAt: now + windowMs
			});
			return true;
		}
		if (entry.count >= limit) {
			throw new HttpException(
				'Слишком много запросов. Попробуйте позже.',
				HttpStatus.TOO_MANY_REQUESTS
			);
		}
		entry.count += 1;
		return true;
	}
}
