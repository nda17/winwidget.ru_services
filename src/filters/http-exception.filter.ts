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
	'Token not exists!': {
		code: 'verification_token_not_found',
		message: 'Токен подтверждения не найден.'
	},
	'User not found': {
		code: 'user_not_found',
		message: 'Пользователь не найден.'
	},
	'Email or password invalid': {
		code: 'invalid_credentials',
		message: 'Неверный email или пароль.'
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
