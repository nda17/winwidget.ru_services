import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

const PLACEHOLDERS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'billing_identity_token',
	'ci_billing_identity_token_at_least_32_chars'
]);

const isLoopback = (value?: string): boolean => {
	if (!value) return false;
	const normalized = value.toLowerCase();
	if (normalized === '::1') return true;
	const ipv4 = normalized.startsWith('::ffff:')
		? normalized.slice('::ffff:'.length)
		: normalized;
	const octets = ipv4.split('.');
	return (
		octets.length === 4 &&
		octets[0] === '127' &&
		octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
	);
};

@Injectable()
export class BillingIdentityGuard implements CanActivate {
	private readonly token: Buffer;

	constructor(config: ConfigService) {
		const value =
			config.get<string>('BILLING_IDENTITY_TOKEN')?.trim() || '';
		if (value.length < 32 || PLACEHOLDERS.has(value)) {
			throw new Error(
				'BILLING_IDENTITY_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		this.token = Buffer.from(value);
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		if (
			request.header('x-winwidget-service') !== 'identity' ||
			!isLoopback(request.socket?.remoteAddress)
		) {
			throw new ForbiddenException('Invalid internal credentials');
		}
		const candidate = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		if (
			candidate.length !== this.token.length ||
			!timingSafeEqual(candidate, this.token)
		) {
			throw new ForbiddenException('Invalid internal credentials');
		}
		return true;
	}
}
