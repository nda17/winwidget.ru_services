import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

const LOOPBACK_V4 = /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/;
const PLACEHOLDERS = new Set([
	'XYZXYZXYZ',
	'change-me',
	'change_me',
	'WIDGETS_INTERNAL_TOKEN',
	'ci_widgets_internal_token_at_least_32_chars'
]);

export const isWidgetsInternalLoopback = (
	address: string | undefined
): boolean => {
	if (!address) return false;
	const normalized = address.toLowerCase();
	if (normalized === '::1') return true;
	const ipv4 = normalized.startsWith('::ffff:')
		? normalized.slice('::ffff:'.length)
		: normalized;
	return (
		LOOPBACK_V4.test(ipv4) &&
		ipv4
			.split('.')
			.slice(1)
			.every(part => Number(part) >= 0 && Number(part) <= 255)
	);
};

@Injectable()
export class WidgetsInternalGuard implements CanActivate {
	private readonly token: Buffer;

	constructor(config: ConfigService) {
		const value =
			config.get<string>('WIDGETS_INTERNAL_TOKEN')?.trim() || '';
		if (value.length < 32 || PLACEHOLDERS.has(value)) {
			throw new Error(
				'WIDGETS_INTERNAL_TOKEN must contain at least 32 characters'
			);
		}
		this.token = Buffer.from(value);
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		if (!isWidgetsInternalLoopback(request.socket?.remoteAddress)) {
			throw new ForbiddenException(
				'Widgets internal API is loopback-only'
			);
		}
		const candidateValue = request.headers['x-winwidget-internal-token'];
		const candidate = Buffer.from(
			typeof candidateValue === 'string' ? candidateValue : ''
		);
		if (
			candidate.length !== this.token.length ||
			!timingSafeEqual(candidate, this.token)
		) {
			throw new UnauthorizedException('Invalid internal credentials');
		}
		return true;
	}
}
