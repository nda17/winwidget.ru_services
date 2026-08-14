import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthSettingsController } from './auth-settings.controller';
import {
	AUTH_SETTING_KEYS,
	AuthSettingsService
} from './auth-settings.service';

describe('Auth settings HTTP contract', () => {
	it('keeps GET public and returns exactly six boolean flags', async () => {
		const row = {
			id: 'singleton',
			recaptchaEnabled: true,
			googleAuthEnabled: false,
			yandexAuthEnabled: true,
			githubAuthEnabled: false,
			vkAuthEnabled: true,
			telegramAuthEnabled: false,
			createdAt: new Date(),
			updatedAt: new Date()
		};
		const service = new AuthSettingsService(
			{
				authSettings: {
					findUniqueOrThrow: jest.fn().mockResolvedValue(row)
				}
			} as any,
			{} as any
		);
		const controller = new AuthSettingsController(service);
		const result = await controller.get();
		expect(Object.keys(result)).toEqual(AUTH_SETTING_KEYS);
		expect(
			Object.values(result).every(value => typeof value === 'boolean')
		).toBe(true);
		expect(
			Reflect.getMetadata(
				GUARDS_METADATA,
				AuthSettingsController.prototype.get
			)
		).toBeUndefined();
	});
});
