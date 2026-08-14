import {
	ArgumentsHost,
	Catch,
	ExceptionFilter,
	HttpException
} from '@nestjs/common';

const FORBIDDEN_MESSAGE = 'У тебя нет прав!';

@Catch(HttpException)
export class AppHttpExceptionFilter implements ExceptionFilter {
	catch(exception: HttpException, host: ArgumentsHost) {
		const response = host.switchToHttp().getResponse();
		const status = exception.getStatus();
		const exceptionResponse = exception.getResponse();

		if (typeof exceptionResponse === 'string') {
			return response.status(status).json({
				statusCode: status,
				message:
					exceptionResponse === FORBIDDEN_MESSAGE
						? 'У вас нет прав для выполнения этого действия.'
						: exceptionResponse,
				error: exception.name,
				code:
					exceptionResponse === FORBIDDEN_MESSAGE
						? 'forbidden'
						: 'http_error'
			});
		}

		if (
			typeof exceptionResponse === 'object' &&
			exceptionResponse !== null
		) {
			const payload = exceptionResponse as {
				message?: string | string[];
				error?: string;
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

			const forbidden = payload.message === FORBIDDEN_MESSAGE;
			return response.status(status).json({
				statusCode: status,
				message: forbidden
					? 'У вас нет прав для выполнения этого действия.'
					: payload.message || 'Ошибка запроса.',
				error: payload.error || exception.name,
				code: payload.code || (forbidden ? 'forbidden' : 'http_error')
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
