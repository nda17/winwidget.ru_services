import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class SupportInternalGuard implements CanActivate {
	private readonly token: Buffer;

	constructor(config: ConfigService) {
		const value =
			config.get<string>('SUPPORT_OPERATIONS_TOKEN')?.trim() || '';
		if (
			value.length < 32 ||
			value.startsWith('change_me') ||
			value.startsWith('ci_')
		) {
			throw new Error(
				'SUPPORT_OPERATIONS_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		this.token = Buffer.from(value);
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		const candidate = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		if (
			request.header('x-winwidget-service') !== 'operations' ||
			!this.isLoopback(request.socket.remoteAddress) ||
			candidate.length !== this.token.length ||
			!timingSafeEqual(candidate, this.token)
		) {
			throw new ForbiddenException('Invalid internal credentials');
		}
		return true;
	}

	private isLoopback(value?: string): boolean {
		if (!value) return false;
		const normalized = value.toLowerCase();
		if (normalized === '::1') return true;
		const ipv4 = normalized.startsWith('::ffff:')
			? normalized.slice('::ffff:'.length)
			: normalized;
		return /^127(?:\.\d{1,3}){3}$/.test(ipv4);
	}
}
