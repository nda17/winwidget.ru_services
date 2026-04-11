import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import {
	ErrorCode,
	GoogleRecaptchaException
} from '@nestlab/google-recaptcha';

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
	catch(exception: GoogleRecaptchaException, host: ArgumentsHost) {
		const response = host.switchToHttp().getResponse();
		const status = exception.getStatus();
		const errorCodes = exception.errorCodes || [];
		const firstErrorCode = errorCodes[0] || ErrorCode.UnknownError;

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
