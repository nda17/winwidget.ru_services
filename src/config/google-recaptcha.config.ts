import { ConfigService } from '@nestjs/config'
import { GoogleRecaptchaModuleOptions } from '@nestlab/google-recaptcha/interfaces/google-recaptcha-module-options'

const DEFAULT_RECAPTCHA_MIN_SCORE = 0.5
const isTrue = (value?: string) => value === 'true'

export const getGoogleRecaptchaConfig = async (
	configService: ConfigService
): Promise<GoogleRecaptchaModuleOptions> => ({
	secretKey: configService.get<string>('RECAPTCHA_SECRET_KEY'),
	response: (req) => {
		const rawToken = req.headers.recaptcha
		return Array.isArray(rawToken) ? rawToken[0] : rawToken || ''
	},
	actions: [
		'login',
		'register',
		'restore-password',
		'restore_password',
		'phone_send_code',
		'phone_register',
		'phone_login'
	],
	score:
		Number(configService.get<string>('RECAPTCHA_MIN_SCORE')) ||
		DEFAULT_RECAPTCHA_MIN_SCORE,
	skipIf: () => !isTrue(configService.get<string>('RECAPTCHA_ENABLED'))
})
