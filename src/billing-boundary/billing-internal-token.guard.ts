import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
	BILLING_INTERNAL_TOKEN_ENV,
	BILLING_INTERNAL_TOKEN_HEADER,
	BILLING_INTERNAL_TOKEN_MIN_LENGTH
} from './billing-boundary.constants';

const IPV4_LOOPBACK_PATTERN =
	/^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/;
const INSECURE_TOKENS = new Set([
	'XYZXYZXYZ',
	'change-me',
	'change_me',
	'BILLING_INTERNAL_TOKEN',
	'billing_internal_token'
]);

const isLoopbackIpv4 = (address: string): boolean => {
	if (!IPV4_LOOPBACK_PATTERN.test(address)) return false;
	return address
		.split('.')
		.slice(1)
		.every(part => Number(part) >= 0 && Number(part) <= 255);
};

export const isBillingLoopbackAddress = (
	address: string | undefined
): boolean => {
	if (!address) return false;
	const normalized = address.toLowerCase();
	if (normalized === '::1') return true;
	if (isLoopbackIpv4(normalized)) return true;
	if (!normalized.startsWith('::ffff:')) return false;
	return isLoopbackIpv4(normalized.slice('::ffff:'.length));
};

const hashToken = (value: string): Buffer =>
	createHash('sha256').update(value, 'utf8').digest();

@Injectable()
export class BillingInternalTokenGuard implements CanActivate {
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		if (!isBillingLoopbackAddress(request.socket?.remoteAddress)) {
			throw new ForbiddenException(
				'Billing internal API is loopback-only'
			);
		}

		const expectedToken = process.env[BILLING_INTERNAL_TOKEN_ENV]?.trim();
		if (
			!expectedToken ||
			INSECURE_TOKENS.has(expectedToken) ||
			expectedToken.length < BILLING_INTERNAL_TOKEN_MIN_LENGTH
		) {
			throw new ServiceUnavailableException(
				'Billing internal token is not configured securely'
			);
		}

		const supplied = request.headers[BILLING_INTERNAL_TOKEN_HEADER];
		if (
			typeof supplied !== 'string' ||
			!supplied ||
			supplied.length > 4096 ||
			!timingSafeEqual(hashToken(expectedToken), hashToken(supplied))
		) {
			throw new UnauthorizedException('Invalid Billing internal token');
		}

		return true;
	}
}
