import {
	CallHandler,
	ExecutionContext,
	Injectable,
	NestInterceptor,
	ServiceUnavailableException
} from '@nestjs/common';
import { Observable, catchError } from 'rxjs';

@Injectable()
export class BillingLegacyWriteFenceInterceptor implements NestInterceptor {
	intercept(
		_context: ExecutionContext,
		next: CallHandler
	): Observable<unknown> {
		return next.handle().pipe(
			catchError(error => {
				if (isBillingLegacyWriteFenceError(error)) {
					throw new ServiceUnavailableException({
						statusCode: 503,
						message:
							'Billing migration is in progress. Please retry shortly.',
						error: 'Service Unavailable',
						code: 'billing_legacy_writer_fenced'
					});
				}
				throw error;
			})
		);
	}
}

export function isBillingLegacyWriteFenceError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const value = error as {
		code?: unknown;
		message?: unknown;
		meta?: Record<string, unknown>;
	};
	const metadata = Object.values(value.meta ?? {})
		.filter(item => typeof item === 'string')
		.join(' ');
	const details = `${String(value.message ?? '')} ${metadata}`;
	return (
		value.code === '55000' ||
		(details.includes('55000') && details.includes('Core Billing')) ||
		details.includes(
			'Core Billing source is frozen; legacy table write rejected'
		) ||
		details.includes(
			'Core Billing settings source is frozen; legacy field write rejected'
		)
	);
}
