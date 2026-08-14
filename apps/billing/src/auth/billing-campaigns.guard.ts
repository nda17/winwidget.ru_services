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
	'billing_campaigns_token',
	'ci_billing_campaigns_token_at_least_32_chars'
]);

@Injectable()
export class BillingCampaignsGuard implements CanActivate {
	private readonly token: string;

	constructor(config: ConfigService) {
		this.token =
			config.get<string>('BILLING_CAMPAIGNS_TOKEN')?.trim() || '';
		if (this.token.length < 32 || PLACEHOLDERS.has(this.token)) {
			throw new Error(
				'BILLING_CAMPAIGNS_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		if (
			request.header('x-winwidget-service') !== 'campaigns' ||
			!this.isLoopback(request.socket.remoteAddress)
		) {
			throw new UnauthorizedException('Invalid internal credentials');
		}
		const supplied = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		const expected = Buffer.from(this.token);
		if (
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		) {
			throw new UnauthorizedException('Invalid internal credentials');
		}
		return true;
	}

	private isLoopback(value?: string): boolean {
		if (!value) return false;
		const normalized = value.toLowerCase();
		return (
			normalized === '::1' ||
			normalized.startsWith('127.') ||
			normalized.startsWith('::ffff:127.')
		);
	}
}
