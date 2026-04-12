import {
	ArgumentsHost,
	Catch,
	ExceptionFilter,
	Logger
} from '@nestjs/common';
import {
	ErrorCode,
	GoogleRecaptchaException
} from '@nestlab/google-recaptcha';
import { Request } from 'express';

const RECAPTCHA_ERROR_MESSAGES: Record<string, string> = {
	[ErrorCode.MissingInputSecret]: 'Не настроен секретный ключ reCAPTCHA.',
	[ErrorCode.InvalidInputSecret]:
		'Указан неверный секретный ключ reCAPTCHA.',
	[ErrorCode.MissingInputResponse]: 'Капча не была пройдена.',
	[ErrorCode.InvalidInputResponse]: 'Токен reCAPTCHA недействителен.',
	[ErrorCode.BadRequest]: 'Некорректный запрос проверки reCAPTCHA.',
	[ErrorCode.TimeoutOrDuplicate]:
		'Проверка reCAPTCHA истекла или уже была использована.',
	[ErrorCode.ForbiddenAction]: 'Некорректное действие reCAPTCHA.',
	[ErrorCode.LowScore]:
		'Проверка reCAPTCHA не пройдена. Попробуйте ещё раз.',
	[ErrorCode.InvalidKeys]: 'Ключи reCAPTCHA настроены некорректно.',
	[ErrorCode.IncorrectCaptchaSol]: 'Капча решена неверно.',
	[ErrorCode.NetworkError]:
		'Не удалось проверить reCAPTCHA. Попробуйте позже.',
	[ErrorCode.SiteMismatch]:
		'Текущий домен не разрешён для этого ключа reCAPTCHA.',
	[ErrorCode.BrowserError]: 'Браузер не смог пройти проверку reCAPTCHA.',
	[ErrorCode.UnknownError]: 'Ошибка проверки reCAPTCHA.'
};

@Catch(GoogleRecaptchaException)
export class GoogleRecaptchaExceptionFilter implements ExceptionFilter {
	private readonly logger = new Logger('reCAPTCHA');
	private readonly isDevelopment = process.env.MODE === 'development';

	catch(exception: GoogleRecaptchaException, host: ArgumentsHost) {
		const request = host.switchToHttp().getRequest<
			Request & {
				recaptchaValidationResult?: {
					success: boolean;
					action?: string;
					score?: number;
					hostname?: string;
					remoteIp?: string;
					errors?: string[];
				};
			}
		>();
		const response = host.switchToHttp().getResponse();
		const status = exception.getStatus();
		const errorCodes = exception.errorCodes || [];
		const firstErrorCode = errorCodes[0] || ErrorCode.UnknownError;

		if (this.isDevelopment) {
			this.logger.debug(
				{
					method: request?.method,
					path: request?.originalUrl || request?.url,
					tokenProvided: Boolean(request?.headers?.recaptcha),
					success: request?.recaptchaValidationResult?.success ?? false,
					action: request?.recaptchaValidationResult?.action,
					score: request?.recaptchaValidationResult?.score,
					hostname: request?.recaptchaValidationResult?.hostname,
					remoteIp:
						request?.recaptchaValidationResult?.remoteIp ?? request?.ip,
					errors: errorCodes
				},
				'error'
			);
		}

		response.status(status).json({
			statusCode: status,
			message:
				RECAPTCHA_ERROR_MESSAGES[firstErrorCode] ||
				RECAPTCHA_ERROR_MESSAGES[ErrorCode.UnknownError],
			error: 'reCAPTCHA Error',
			code: firstErrorCode
		});
	}
}
