import {
	ArgumentsHost,
	Catch,
	ExceptionFilter,
	HttpException
} from '@nestjs/common';
import type { Response } from 'express';

@Catch(HttpException)
export class SupportHttpExceptionFilter implements ExceptionFilter {
	catch(exception: HttpException, host: ArgumentsHost): void {
		const response = host.switchToHttp().getResponse<Response>();
		const status = exception.getStatus();
		const raw = exception.getResponse();
		const payload =
			typeof raw === 'object' && raw !== null
				? (raw as {
						message?: string | string[];
						error?: string;
						code?: string;
					})
				: null;
		response.status(status).json({
			statusCode: status,
			message:
				payload?.message ||
				(typeof raw === 'string' ? raw : 'Ошибка запроса.'),
			error: payload?.error || exception.name,
			code:
				payload?.code ||
				(Array.isArray(payload?.message)
					? 'validation_error'
					: 'http_error')
		});
	}
}
