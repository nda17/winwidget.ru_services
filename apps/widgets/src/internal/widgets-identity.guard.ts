import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { isWidgetsInternalLoopback } from './widgets-internal.guard';

const PLACEHOLDERS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'widgets_identity_token',
	'ci_widgets_identity_token_at_least_32_chars'
]);

@Injectable()
export class WidgetsIdentityGuard implements CanActivate {
	private readonly token: Buffer;

	constructor(config: ConfigService) {
		const value =
			config.get<string>('WIDGETS_IDENTITY_TOKEN')?.trim() || '';
		if (value.length < 32 || PLACEHOLDERS.has(value)) {
			throw new Error(
				'WIDGETS_IDENTITY_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		this.token = Buffer.from(value);
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		if (
			request.header('x-winwidget-service') !== 'identity' ||
			!isWidgetsInternalLoopback(request.socket?.remoteAddress)
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
