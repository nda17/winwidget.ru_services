import {
	CallHandler,
	ExecutionContext,
	HttpException,
	HttpStatus,
	Injectable,
	NestInterceptor,
	ServiceUnavailableException
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, finalize } from 'rxjs';
import type { IdentityActor } from '../auth/auth.guard';

export const AVATAR_UPLOAD_RATE_LIMIT = 10;
export const AVATAR_UPLOAD_RATE_WINDOW_MS = 10 * 60_000;
export const AVATAR_UPLOAD_MAX_CONCURRENCY = 2;

type AvatarUploadRequest = Request & {
	identityActor?: IdentityActor;
	params: Request['params'] & { id?: string };
};

type RateWindow = {
	count: number;
	expiresAt: number;
};

@Injectable()
export class AvatarUploadAdmissionService {
	private readonly windows = new Map<string, RateWindow>();
	private active = 0;
	private nextSweepAt = 0;

	acquire(targetUserId: string, now = Date.now()): () => void {
		this.sweep(now);
		const current = this.windows.get(targetUserId);
		if (
			current &&
			current.expiresAt > now &&
			current.count >= AVATAR_UPLOAD_RATE_LIMIT
		) {
			throw new HttpException(
				'Слишком много обновлений аватара. Попробуйте позже.',
				HttpStatus.TOO_MANY_REQUESTS
			);
		}
		if (this.active >= AVATAR_UPLOAD_MAX_CONCURRENCY) {
			throw new ServiceUnavailableException(
				'Avatar processing capacity is temporarily exhausted'
			);
		}

		if (current && current.expiresAt > now) {
			current.count += 1;
		} else {
			this.windows.set(targetUserId, {
				count: 1,
				expiresAt: now + AVATAR_UPLOAD_RATE_WINDOW_MS
			});
		}

		this.active += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active = Math.max(0, this.active - 1);
		};
	}

	private sweep(now: number): void {
		if (now < this.nextSweepAt) return;
		for (const [userId, window] of this.windows) {
			if (window.expiresAt <= now) this.windows.delete(userId);
		}
		this.nextSweepAt = now + AVATAR_UPLOAD_RATE_WINDOW_MS;
	}
}

@Injectable()
export class AvatarUploadAdmissionInterceptor implements NestInterceptor {
	constructor(private readonly admission: AvatarUploadAdmissionService) {}

	intercept(
		context: ExecutionContext,
		next: CallHandler
	): Observable<unknown> {
		const request = context
			.switchToHttp()
			.getRequest<AvatarUploadRequest>();
		const targetUserId = request.params?.id || request.identityActor?.id;
		if (!targetUserId) {
			throw new ServiceUnavailableException(
				'Avatar upload identity is unavailable'
			);
		}
		const release = this.admission.acquire(targetUserId);
		try {
			return next.handle().pipe(finalize(release));
		} catch (error) {
			release();
			throw error;
		}
	}
}
