import {
	CanActivate,
	ExecutionContext,
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const PLACEHOLDERS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'reporting_internal_token',
	'ci_reporting_internal_token_at_least_32_chars'
]);

@Injectable()
export class ReportingPolicyGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const expected = process.env.REPORTING_INTERNAL_TOKEN?.trim();
		if (!expected || expected.length < 32 || PLACEHOLDERS.has(expected)) {
			throw new ServiceUnavailableException(
				'Reporting internal token is not configured securely'
			);
		}
		const request = context.switchToHttp().getRequest<Request>();
		const supplied = request.headers['x-winwidget-internal-token'];
		if (
			typeof supplied !== 'string' ||
			!supplied ||
			supplied.length > 4_096 ||
			!timingSafeEqual(this.hash(expected), this.hash(supplied))
		) {
			throw new UnauthorizedException('Invalid reporting internal token');
		}
		return true;
	}

	private hash(value: string): Buffer {
		return createHash('sha256').update(value, 'utf8').digest();
	}
}
