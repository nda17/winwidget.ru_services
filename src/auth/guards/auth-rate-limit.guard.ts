import { getClientIp } from '@/utils/ip.util';
import {
	CanActivate,
	ExecutionContext,
	HttpException,
	HttpStatus,
	Injectable
} from '@nestjs/common';
import { Request } from 'express';

interface IRateLimitEntry {
	count: number;
	expiresAt: number;
}

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
	private static readonly storage = new Map<string, IRateLimitEntry>();
	private static cleanupInterval: ReturnType<typeof setInterval> | null =
		null;

	constructor() {
		if (!AuthRateLimitGuard.cleanupInterval) {
			AuthRateLimitGuard.cleanupInterval = setInterval(
				() => {
					const now = Date.now();
					for (const [key, entry] of AuthRateLimitGuard.storage) {
						if (entry.expiresAt <= now) {
							AuthRateLimitGuard.storage.delete(key);
						}
					}
				},
				5 * 60 * 1000
			);
		}
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		const ip = getClientIp(request) ?? 'unknown';
		const path = request.route?.path ?? request.path;
		const limitConfig = this.getLimitConfig(path);
		const key = `${ip}:${path}`;
		const now = Date.now();
		const currentEntry = AuthRateLimitGuard.storage.get(key);

		if (!currentEntry || currentEntry.expiresAt <= now) {
			AuthRateLimitGuard.storage.set(key, {
				count: 1,
				expiresAt: now + limitConfig.windowMs
			});
			return true;
		}

		if (currentEntry.count >= limitConfig.limit) {
			throw new HttpException(
				'Слишком много запросов. Попробуйте позже.',
				HttpStatus.TOO_MANY_REQUESTS
			);
		}

		currentEntry.count += 1;
		AuthRateLimitGuard.storage.set(key, currentEntry);
		return true;
	}

	private getLimitConfig(path: string) {
		if (path.includes('refresh')) {
			return { limit: 20, windowMs: 60 * 1000 };
		}

		if (path.includes('telegram/complete')) {
			return { limit: 80, windowMs: 3 * 60 * 1000 };
		}

		return { limit: 10, windowMs: 10 * 60 * 1000 };
	}
}
