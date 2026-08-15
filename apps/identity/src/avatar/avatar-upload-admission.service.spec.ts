import {
	HttpException,
	ServiceUnavailableException,
	type CallHandler,
	type ExecutionContext
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import {
	AVATAR_UPLOAD_MAX_CONCURRENCY,
	AVATAR_UPLOAD_RATE_LIMIT,
	AvatarUploadAdmissionInterceptor,
	AvatarUploadAdmissionService
} from './avatar-upload-admission.service';

function context(actorId: string, targetId?: string): ExecutionContext {
	return {
		switchToHttp: () => ({
			getRequest: () => ({
				identityActor: { id: actorId },
				params: targetId ? { id: targetId } : {}
			})
		})
	} as unknown as ExecutionContext;
}

function downstream() {
	const normalization = jest.fn();
	const staging = jest.fn();
	const storage = jest.fn();
	const next: CallHandler = {
		handle: jest.fn(() => {
			normalization();
			staging();
			storage();
			return of({ avatarPath: 'https://cdn.example.test/avatar.webp' });
		})
	};
	return { next, normalization, staging, storage };
}

describe('AvatarUploadAdmissionInterceptor', () => {
	it('rate-limits by target user before normalization, staging or S3', async () => {
		const admission = new AvatarUploadAdmissionService();
		const interceptor = new AvatarUploadAdmissionInterceptor(admission);
		for (
			let attempt = 0;
			attempt < AVATAR_UPLOAD_RATE_LIMIT;
			attempt += 1
		) {
			await lastValueFrom(
				interceptor.intercept(context('user-1'), downstream().next)
			);
		}

		const rejected = downstream();
		expect(() =>
			interceptor.intercept(context('user-1'), rejected.next)
		).toThrow(HttpException);
		expect(rejected.next.handle).not.toHaveBeenCalled();
		expect(rejected.normalization).not.toHaveBeenCalled();
		expect(rejected.staging).not.toHaveBeenCalled();
		expect(rejected.storage).not.toHaveBeenCalled();
	});

	it('uses the admin target id rather than the actor id as the rate key', async () => {
		const admission = new AvatarUploadAdmissionService();
		const interceptor = new AvatarUploadAdmissionInterceptor(admission);
		for (
			let attempt = 0;
			attempt < AVATAR_UPLOAD_RATE_LIMIT;
			attempt += 1
		) {
			await lastValueFrom(
				interceptor.intercept(
					context('admin-1', 'target-1'),
					downstream().next
				)
			);
		}

		try {
			interceptor.intercept(
				context('admin-2', 'target-1'),
				downstream().next
			);
			throw new Error('Expected target rate limit rejection');
		} catch (error) {
			expect(error).toMatchObject({ status: 429 });
		}
		await expect(
			lastValueFrom(
				interceptor.intercept(
					context('admin-1', 'target-2'),
					downstream().next
				)
			)
		).resolves.toEqual({
			avatarPath: 'https://cdn.example.test/avatar.webp'
		});
	});

	it('fails fast when process capacity is saturated and releases exactly once', async () => {
		const admission = new AvatarUploadAdmissionService();
		const releases = Array.from(
			{ length: AVATAR_UPLOAD_MAX_CONCURRENCY },
			(_, index) => admission.acquire(`holder-${index}`)
		);
		const interceptor = new AvatarUploadAdmissionInterceptor(admission);
		const rejected = downstream();

		expect(() =>
			interceptor.intercept(context('user-1'), rejected.next)
		).toThrow(ServiceUnavailableException);
		expect(rejected.next.handle).not.toHaveBeenCalled();
		expect(rejected.normalization).not.toHaveBeenCalled();
		expect(rejected.staging).not.toHaveBeenCalled();
		expect(rejected.storage).not.toHaveBeenCalled();

		releases[0]!();
		releases[0]!();
		await expect(
			lastValueFrom(
				interceptor.intercept(context('user-1'), downstream().next)
			)
		).resolves.toBeDefined();
		for (const release of releases.slice(1)) release();
	});

	it('releases process capacity when downstream fails', async () => {
		const admission = new AvatarUploadAdmissionService();
		const interceptor = new AvatarUploadAdmissionInterceptor(admission);
		const holder = admission.acquire('holder');
		const failed: CallHandler = {
			handle: jest.fn(() =>
				throwError(() => new Error('normalization failed'))
			)
		};

		await expect(
			lastValueFrom(interceptor.intercept(context('user-1'), failed))
		).rejects.toThrow('normalization failed');
		await expect(
			lastValueFrom(
				interceptor.intercept(context('user-2'), downstream().next)
			)
		).resolves.toBeDefined();
		holder();
	});
});
