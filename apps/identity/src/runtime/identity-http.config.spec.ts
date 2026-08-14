import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { IdentityMessagingAdminController } from '../messaging/messaging-admin.controller';
import { IDENTITY_GLOBAL_PREFIX_EXCLUDES } from './identity-http.config';

describe('Identity HTTP route contract', () => {
	it('keeps the messaging admin API on its canonical unprefixed paths', () => {
		expect(
			Reflect.getMetadata(PATH_METADATA, IdentityMessagingAdminController)
		).toBe('internal/v1/identity/messaging');

		const messagingExcludes = IDENTITY_GLOBAL_PREFIX_EXCLUDES.filter(
			({ path }) => path.startsWith('internal/v1/identity/messaging/')
		);
		expect(messagingExcludes).toEqual([
			{
				path: 'internal/v1/identity/messaging/overview',
				method: RequestMethod.GET
			},
			{
				path: 'internal/v1/identity/messaging/failures',
				method: RequestMethod.GET
			},
			{
				path: 'internal/v1/identity/messaging/failures/:id/retry',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/identity/messaging/failures/:id/close',
				method: RequestMethod.POST
			}
		]);
		expect(
			messagingExcludes.every(({ path }) => !path.startsWith('api/v1/'))
		).toBe(true);
	});
});
