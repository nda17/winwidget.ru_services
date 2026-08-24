import {
	ArgumentsHost,
	Catch,
	ExceptionFilter,
	HttpException
} from '@nestjs/common';
import type { Response } from 'express';

@Catch(HttpException)
export class OperationsHttpExceptionFilter implements ExceptionFilter {
	catch(exception: HttpException, host: ArgumentsHost): void {
		const response = host.switchToHttp().getResponse<Response>();
		const status = exception.getStatus();
		const raw = exception.getResponse();
		if (typeof raw === 'string') {
			response.status(status).json({
				statusCode: status,
				message: raw,
				error: exception.name,
				code: 'http_error'
			});
			return;
		}
		if (typeof raw === 'object' && raw !== null) {
			const payload = raw as {
				message?: string | string[];
				error?: string;
				code?: string;
			};
			response.status(status).json({
				statusCode: status,
				message: payload.message || 'Ошибка запроса.',
				error: payload.error || exception.name,
				code:
					payload.code ||
					(Array.isArray(payload.message)
						? 'validation_error'
						: 'http_error')
			});
			return;
		}
		response.status(status).json({
			statusCode: status,
			message: 'Ошибка запроса.',
			error: exception.name,
			code: 'http_error'
		});
	}
}
