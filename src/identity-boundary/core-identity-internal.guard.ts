import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

const PLACEHOLDERS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'core_identity_token',
	'ci_core_identity_token_at_least_32_chars'
]);

@Injectable()
export class CoreIdentityInternalGuard implements CanActivate {
	private readonly token: string;

	constructor(config: ConfigService) {
		this.token = config.get<string>('CORE_IDENTITY_TOKEN')?.trim() || '';
		if (this.token.length < 32 || PLACEHOLDERS.has(this.token)) {
			throw new Error(
				'CORE_IDENTITY_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		const remoteAddress =
			request.socket.remoteAddress?.toLowerCase() || '';
		const isLoopback =
			remoteAddress === '::1' ||
			remoteAddress.startsWith('127.') ||
			remoteAddress.startsWith('::ffff:127.');
		const supplied = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		const expected = Buffer.from(this.token);
		if (
			!isLoopback ||
			request.header('x-winwidget-service') !== 'identity' ||
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		) {
			throw new UnauthorizedException('Invalid internal credentials');
		}
		return true;
	}
}
