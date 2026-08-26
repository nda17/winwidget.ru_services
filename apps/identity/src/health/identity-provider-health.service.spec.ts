import type { ConfigService } from '@nestjs/config';
import { IdentityInternalController } from '../internal/internal.controller';
import { IdentityProviderHealthService } from './identity-provider-health.service';

const createService = (options: {
	recaptchaEnvironment?: string;
	recaptchaDatabase?: boolean;
	recaptchaSecret?: string;
	emailConfigured?: boolean;
	smsConfigured?: boolean;
	verifyEmail?: jest.Mock;
	verifySms?: jest.Mock;
}) => {
	const values: Record<string, string | undefined> = {
		RECAPTCHA_ENABLED: options.recaptchaEnvironment,
		RECAPTCHA_SECRET_KEY: options.recaptchaSecret
	};
	const settings = {
		get: jest.fn().mockResolvedValue({
			recaptchaEnabled: options.recaptchaDatabase ?? true
		})
	};
	const transport = {
		isEmailConfigured: jest.fn(() => options.emailConfigured ?? true),
		isSmsConfigured: jest.fn(() => options.smsConfigured ?? true),
		verifyEmailTransport:
			options.verifyEmail ?? jest.fn().mockResolvedValue(undefined),
		verifySmsTransport:
			options.verifySms ?? jest.fn().mockResolvedValue(undefined)
	};
	const service = new IdentityProviderHealthService(
		{
			get: jest.fn((key: string) => values[key])
		} as unknown as ConfigService,
		settings as any,
		transport as any
	);
	return { service, settings, transport };
};

describe('IdentityProviderHealthService', () => {
	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('returns three fixed safe provider checks without exposing credentials or errors', async () => {
		const secretError = 'provider leaked secret value';
		const { service } = createService({
			recaptchaEnvironment: 'true',
			recaptchaSecret: 'configured-secret',
			verifyEmail: jest.fn().mockRejectedValue(new Error(secretError))
		});

		const result = await service.providerHealth();

		expect(result).toEqual({
			service: 'identity',
			checks: [
				expect.objectContaining({
					id: 'smtp',
					status: 'down',
					message: 'Проверка подключения не пройдена'
				}),
				expect.objectContaining({
					id: 'smsaero',
					status: 'ok',
					message: 'Подключение работает'
				}),
				{
					id: 'recaptcha',
					title: 'reCAPTCHA',
					status: 'ok',
					message: 'Ключ настроен'
				}
			]
		});
		expect(JSON.stringify(result)).not.toContain(secretError);
		expect(JSON.stringify(result)).not.toContain('configured-secret');
	});

	it('uses both environment and database settings for reCAPTCHA state', async () => {
		const environmentDisabled = createService({
			recaptchaEnvironment: 'false',
			recaptchaDatabase: true,
			emailConfigured: false,
			smsConfigured: false
		});
		const databaseDisabled = createService({
			recaptchaEnvironment: 'true',
			recaptchaDatabase: false,
			recaptchaSecret: 'configured'
		});

		await expect(
			environmentDisabled.service.providerHealth()
		).resolves.toEqual(
			expect.objectContaining({
				checks: expect.arrayContaining([
					expect.objectContaining({
						id: 'recaptcha',
						status: 'disabled',
						message: 'reCAPTCHA отключена конфигурацией'
					})
				])
			})
		);
		await expect(
			databaseDisabled.service.providerHealth()
		).resolves.toEqual(
			expect.objectContaining({
				checks: expect.arrayContaining([
					expect.objectContaining({
						id: 'recaptcha',
						status: 'disabled',
						message: 'reCAPTCHA отключена настройками'
					})
				])
			})
		);
	});

	it('bounds a stalled provider probe', async () => {
		jest.useFakeTimers();
		const { service } = createService({
			recaptchaEnvironment: 'false',
			verifyEmail: jest.fn(() => new Promise<void>(() => undefined))
		});

		const resultPromise = service.providerHealth();
		await Promise.resolve();
		await jest.advanceTimersByTimeAsync(3_001);

		await expect(resultPromise).resolves.toEqual(
			expect.objectContaining({
				checks: expect.arrayContaining([
					expect.objectContaining({ id: 'smtp', status: 'down' })
				])
			})
		);
	});

	it('returns a fixed down check when auth settings cannot be loaded', async () => {
		const { service, settings } = createService({
			recaptchaEnvironment: 'true',
			recaptchaSecret: 'configured'
		});
		settings.get.mockRejectedValue(new Error('database secret details'));

		const result = await service.providerHealth();

		expect(result.checks).toContainEqual({
			id: 'recaptcha',
			title: 'reCAPTCHA',
			status: 'down',
			message: 'Настройки reCAPTCHA недоступны'
		});
		expect(JSON.stringify(result)).not.toContain(
			'database secret details'
		);
	});

	it('keeps the admin health endpoint scoped to Operations and delegates to the API provider', async () => {
		const providerHealth = jest.fn().mockResolvedValue({
			service: 'identity',
			checks: []
		});
		const controller = new IdentityInternalController(
			{} as any,
			{ providerHealth } as any
		);

		await expect(controller.adminHealth()).resolves.toEqual({
			service: 'identity',
			checks: []
		});
		expect(
			Reflect.getMetadata(
				'identity.internal.services',
				IdentityInternalController.prototype.adminHealth
			)
		).toEqual(['operations']);
	});
});
