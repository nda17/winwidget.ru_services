import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

const TOKEN_PLACEHOLDERS = new Set([
	'change_me',
	'change-me',
	'crm_sales_crm_access_token',
	'ci_crm_sales_crm_access_token_at_least_32_chars'
]);

@Injectable()
export class CrmSalesInternalGuard implements CanActivate {
	private readonly expectedToken: Buffer;

	constructor(config: ConfigService) {
		const token =
			config.get<string>('CRM_SALES_CRM_ACCESS_TOKEN')?.trim() || '';
		if (
			token.length < 32 ||
			TOKEN_PLACEHOLDERS.has(token) ||
			/^(?:change[_-]?me|ci_)/i.test(token)
		) {
			throw new Error(
				'CRM_SALES_CRM_ACCESS_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		this.expectedToken = Buffer.from(token);
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		const candidate = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		if (
			request.header('x-winwidget-service') !== 'crm-access' ||
			!this.isLoopback(request.socket.remoteAddress) ||
			candidate.length !== this.expectedToken.length ||
			!timingSafeEqual(candidate, this.expectedToken)
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
