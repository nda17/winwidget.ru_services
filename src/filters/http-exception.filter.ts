import {
	ArgumentsHost,
	Catch,
	ExceptionFilter,
	HttpException
} from '@nestjs/common';

type ErrorDescriptor = {
	code: string;
	message: string;
};

const ERROR_MAP: Record<string, ErrorDescriptor> = {
	'User already exists': {
		code: 'user_already_exists',
		message: 'Пользователь уже существует.'
	},
	'Invalid refresh token': {
		code: 'invalid_refresh_token',
		message: 'Недействительный refresh token.'
	},
	'User not found': {
		code: 'user_not_found',
		message: 'Пользователь не найден.'
	},
	'Email or password invalid': {
		code: 'invalid_credentials',
		message: 'Неверный логин или пароль.'
	},
	'User not found by social media': {
		code: 'social_user_not_found',
		message: 'Не удалось получить пользователя из социальной сети.'
	},
	'Token not passed': {
		code: 'token_not_passed',
		message: 'Токен не передан.'
	},
	'Email not passed': {
		code: 'email_not_passed',
		message: 'Email не передан.'
	},
	'Refresh token not passed': {
		code: 'refresh_token_not_passed',
		message: 'Refresh token не передан.'
	},
	'Email busy': {
		code: 'email_busy',
		message: 'Этот email уже занят.'
	},
	'Phone busy': {
		code: 'phone_busy',
		message: 'Этот номер телефона уже занят.'
	},
	'Phone already exists': {
		code: 'phone_already_exists',
		message: 'Пользователь с таким номером уже существует.'
	},
	'Email already linked': {
		code: 'email_already_linked',
		message: 'Этот email уже привязан к вашему профилю.'
	},
	'Phone already linked': {
		code: 'phone_already_linked',
		message: 'Этот номер телефона уже привязан к вашему профилю.'
	},
	'Phone not verified': {
		code: 'phone_not_verified',
		message: 'Номер телефона не подтвержден.'
	},
	'Phone verification code not found': {
		code: 'phone_code_not_found',
		message: 'Код подтверждения не найден или истёк.'
	},
	'Phone verification code invalid': {
		code: 'phone_code_invalid',
		message: 'Неверный код подтверждения.'
	},
	'Phone verification code attempts exceeded': {
		code: 'phone_code_attempts_exceeded',
		message: 'Лимит попыток исчерпан. Запросите новый код.'
	},
	'Phone verification resend cooldown': {
		code: 'phone_code_resend_cooldown',
		message: 'Отправить код повторно можно немного позже.'
	},
	'Email verification code not found': {
		code: 'email_code_not_found',
		message: 'Код подтверждения email не найден или истёк.'
	},
	'Email verification code invalid': {
		code: 'email_code_invalid',
		message: 'Неверный код подтверждения email.'
	},
	'Email verification code attempts exceeded': {
		code: 'email_code_attempts_exceeded',
		message: 'Лимит попыток исчерпан. Запросите новый код.'
	},
	'Email verification resend cooldown': {
		code: 'email_code_resend_cooldown',
		message: 'Отправить код повторно можно немного позже.'
	},
	'Email registration not completed': {
		code: 'email_registration_not_completed',
		message:
			'Регистрация по email не завершена. Подтвердите email кодом из письма.'
	},
	'Sms provider insufficient funds': {
		code: 'sms_provider_balance',
		message: 'Не удалось отправить SMS. Попробуйте позже.'
	},
	'SMS provider request failed': {
		code: 'sms_provider_failed',
		message: 'Не удалось отправить SMS. Попробуйте позже.'
	},
	'SMS provider returned an error': {
		code: 'sms_provider_failed',
		message: 'Не удалось отправить SMS. Попробуйте позже.'
	},
	'Invalid ip-address': {
		code: 'sms_provider_ip',
		message: 'Не удалось отправить SMS. Попробуйте позже.'
	},
	'У тебя нет прав!': {
		code: 'forbidden',
		message: 'У вас нет прав для выполнения этого действия.'
	}
};

@Catch(HttpException)
export class AppHttpExceptionFilter implements ExceptionFilter {
	catch(exception: HttpException, host: ArgumentsHost) {
		const response = host.switchToHttp().getResponse();
		const status = exception.getStatus();
		const exceptionResponse = exception.getResponse();

		if (typeof exceptionResponse === 'string') {
			const mapped = ERROR_MAP[exceptionResponse];
			return response.status(status).json({
				statusCode: status,
				message: mapped?.message || exceptionResponse,
				error: exception.name,
				code: mapped?.code || 'http_error'
			});
		}

		if (
			typeof exceptionResponse === 'object' &&
			exceptionResponse !== null
		) {
			const payload = exceptionResponse as {
				message?: string | string[];
				error?: string;
				statusCode?: number;
				code?: string;
			};

			if (Array.isArray(payload.message)) {
				return response.status(status).json({
					statusCode: status,
					message: payload.message,
					error: payload.error || exception.name,
					code: payload.code || 'validation_error'
				});
			}

			const mapped = payload.message
				? ERROR_MAP[payload.message]
				: undefined;

			return response.status(status).json({
				statusCode: status,
				message: mapped?.message || payload.message || 'Ошибка запроса.',
				error: payload.error || exception.name,
				code: payload.code || mapped?.code || 'http_error'
			});
		}

		return response.status(status).json({
			statusCode: status,
			message: 'Ошибка запроса.',
			error: exception.name,
			code: 'http_error'
		});
	}
}
