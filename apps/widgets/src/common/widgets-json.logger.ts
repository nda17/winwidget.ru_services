import { LoggerService } from '@nestjs/common';
import {
	getWidgetsCorrelationId,
	getWidgetsRequestId
} from './widgets-context';

type LogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

export class WidgetsJsonLogger implements LoggerService {
	log(message: unknown, context?: string): void {
		this.write('log', message, context);
	}

	error(message: unknown, trace?: string, context?: string): void {
		this.write('error', message, context, trace);
	}

	warn(message: unknown, context?: string): void {
		this.write('warn', message, context);
	}

	debug(message: unknown, context?: string): void {
		this.write('debug', message, context);
	}

	verbose(message: unknown, context?: string): void {
		this.write('verbose', message, context);
	}

	fatal(message: unknown, context?: string): void {
		this.write('fatal', message, context);
	}

	private write(
		level: LogLevel,
		message: unknown,
		context?: string,
		trace?: string
	): void {
		const entry = {
			timestamp: new Date().toISOString(),
			level,
			service: 'widgets',
			context: context || null,
			requestId: getWidgetsRequestId(),
			correlationId: getWidgetsCorrelationId(),
			message: this.safeMessage(message),
			...(trace ? { trace: this.safeMessage(trace) } : {})
		};
		const line = JSON.stringify(entry);
		if (level === 'error' || level === 'fatal') {
			process.stderr.write(`${line}\n`);
			return;
		}
		process.stdout.write(`${line}\n`);
	}

	private safeMessage(value: unknown): string {
		const serialized =
			value instanceof Error
				? value.message
				: typeof value === 'string'
					? value
					: JSON.stringify(value);
		return (serialized ?? String(value))
			.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
			.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[DATABASE_URL_REDACTED]')
			.replace(/amqps?:\/\/[^\s]+/gi, '[RABBITMQ_URL_REDACTED]')
			.replace(
				/(token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
				'$1$2[REDACTED]'
			)
			.slice(0, 8000);
	}
}
