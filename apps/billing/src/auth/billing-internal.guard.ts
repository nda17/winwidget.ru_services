import {
	CanActivate,
	ExecutionContext,
	Injectable,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

@Injectable()
export class BillingInternalGuard implements CanActivate {
	private readonly token: string;

	constructor(config: ConfigService) {
		this.token =
			config.get<string>('BILLING_INTERNAL_TOKEN')?.trim() || '';
	}

	canActivate(context: ExecutionContext): boolean {
		if (
			this.token.length < 32 ||
			['change_me', 'XYZXYZXYZ', 'billing_internal_token'].includes(
				this.token
			)
		) {
			throw new Error(
				'BILLING_INTERNAL_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		const request = context.switchToHttp().getRequest<Request>();
		const provided = request.header('x-winwidget-internal-token') || '';
		const expectedBuffer = Buffer.from(this.token);
		const providedBuffer = Buffer.from(provided);
		if (
			providedBuffer.length !== expectedBuffer.length ||
			!timingSafeEqual(providedBuffer, expectedBuffer)
		) {
			throw new UnauthorizedException('Invalid internal token');
		}
		return true;
	}
}
