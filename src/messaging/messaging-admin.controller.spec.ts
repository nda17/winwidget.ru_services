import { MessagingAdminController } from '@/messaging/messaging-admin.controller';
import { Role } from '@prisma/client';

describe('MessagingAdminController authorization', () => {
	const getRoles = (
		method: keyof Pick<
			MessagingAdminController,
			'getOverview' | 'getFailures' | 'retryFailure'
		>
	): Role[] =>
		Reflect.getMetadata(
			'roles',
			MessagingAdminController.prototype[method]
		) as Role[];

	it('declares authorization explicitly on controller methods', () => {
		expect(
			Reflect.getMetadata('roles', MessagingAdminController)
		).toBeUndefined();
		expect(getRoles('getOverview')).toBeDefined();
		expect(getRoles('getFailures')).toBeDefined();
		expect(getRoles('retryFailure')).toBeDefined();
	});

	it('allows ADMIN and DEV to read the queue overview', () => {
		expect(getRoles('getOverview')).toEqual([Role.ADMIN, Role.DEV]);
	});

	it('keeps delivery failures and manual retry DEV-only', () => {
		expect(getRoles('getFailures')).toEqual([Role.DEV]);
		expect(getRoles('retryFailure')).toEqual([Role.DEV]);
	});
});
