import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { PlatformRuntimeService } from '../runtime/platform-runtime.service';

const PLACEHOLDER_TOKENS = new Set([
	'change_me',
	'change-me',
	'XYZXYZXYZ',
	'platform_core_token'
]);

const isPlaceholderToken = (value: string): boolean =>
	PLACEHOLDER_TOKENS.has(value) ||
	value.startsWith('change_me') ||
	value.startsWith('change-me') ||
	value.startsWith('ci_');

@Injectable()
export class PlatformInternalGuard implements CanActivate {
	private readonly token: Buffer;

	constructor(config: ConfigService, runtime: PlatformRuntimeService) {
		const value = config.get<string>('PLATFORM_CORE_TOKEN')?.trim() || '';
		if (
			runtime.apiEnabled &&
			(value.length < 32 || isPlaceholderToken(value))
		) {
			throw new Error(
				'PLATFORM_CORE_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		this.token = Buffer.from(value);
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		if (
			request.header('x-winwidget-service') !== 'core' ||
			!this.isLoopback(request.socket.remoteAddress)
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
