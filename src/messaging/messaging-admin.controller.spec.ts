import { MessagingAdminController } from '@/messaging/messaging-admin.controller';
import type { PlatformRole } from '@/auth/decorators/roles.decorator';

describe('MessagingAdminController authorization', () => {
	const getRoles = (
		method: keyof Pick<
			MessagingAdminController,
			'getOverview' | 'getFailures' | 'retryFailure' | 'closeFailure'
		>
	): PlatformRole[] =>
		Reflect.getMetadata(
			'roles',
			MessagingAdminController.prototype[method]
		) as PlatformRole[];

	it('declares authorization explicitly on controller methods', () => {
		expect(
			Reflect.getMetadata('roles', MessagingAdminController)
		).toBeUndefined();
		expect(getRoles('getOverview')).toBeDefined();
		expect(getRoles('getFailures')).toBeDefined();
		expect(getRoles('retryFailure')).toBeDefined();
		expect(getRoles('closeFailure')).toBeDefined();
	});

	it('allows ADMIN and DEV to read the queue overview', () => {
		expect(getRoles('getOverview')).toEqual(['ADMIN', 'DEV']);
	});

	it('keeps delivery failures and manual retry DEV-only', () => {
		expect(getRoles('getFailures')).toEqual(['DEV']);
		expect(getRoles('retryFailure')).toEqual(['DEV']);
		expect(getRoles('closeFailure')).toEqual(['DEV']);
	});
});
