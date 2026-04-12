import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { GoogleRecaptchaModuleOptions } from '@nestlab/google-recaptcha/interfaces/google-recaptcha-module-options';
import { Request } from 'express';

const DEFAULT_RECAPTCHA_MIN_SCORE = 0.5;
const isTrue = (value?: string) => value === 'true';
const recaptchaLogger = new Logger('reCAPTCHA');

export const getGoogleRecaptchaConfig = async (
	configService: ConfigService
): Promise<GoogleRecaptchaModuleOptions> => {
	const isDevelopment =
		configService.get<string>('MODE') === 'development';
	const isRecaptchaEnabled = () =>
		isTrue(configService.get<string>('RECAPTCHA_ENABLED'));

	return {
		secretKey: configService.get<string>('RECAPTCHA_SECRET_KEY'),
		response: req => {
			const rawToken = req.headers.recaptcha;
			return Array.isArray(rawToken) ? rawToken[0] : rawToken || '';
		},
		actions: [
			'login',
			'register',
			'email_register',
			'email_resend_code',
			'restore-password',
			'restore_password',
			'phone_send_code',
			'phone_register',
			'phone_login'
		],
		score:
			Number(configService.get<string>('RECAPTCHA_MIN_SCORE')) ||
			DEFAULT_RECAPTCHA_MIN_SCORE,
		skipIf: req => {
			const request = req as Request;
			const shouldSkip = !isRecaptchaEnabled();

			if (isDevelopment && shouldSkip) {
				recaptchaLogger.debug(
					{
						method: request.method,
						path: request.originalUrl || request.url,
						tokenProvided: Boolean(request.headers.recaptcha)
					},
					'skip'
				);
			}

			return shouldSkip;
		}
	};
};
