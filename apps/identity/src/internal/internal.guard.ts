import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	SetMetadata
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

export const IDENTITY_INTERNAL_SERVICES = [
	'core',
	'campaigns',
	'reporting',
	'widgets',
	'billing',
	'platform',
	'support',
	'operations'
] as const;
export type IdentityInternalService =
	(typeof IDENTITY_INTERNAL_SERVICES)[number];

const META = 'identity.internal.services';
const PLACEHOLDERS = new Set([
	'change_me',
	'change-me',
	'XYZXYZXYZ',
	'identity_core_token',
	'identity_campaigns_token',
	'identity_reporting_token',
	'identity_widgets_token',
	'identity_billing_token',
	'identity_platform_token',
	'identity_support_token',
	'identity_operations_token',
	'change_me_identity_operations_token_at_least_32_chars',
	'ci_identity_core_token_at_least_32_chars',
	'ci_identity_campaigns_token_at_least_32_chars',
	'ci_identity_reporting_token_at_least_32_chars',
	'ci_identity_widgets_token_at_least_32_chars',
	'ci_identity_billing_token_at_least_32_chars',
	'ci_identity_platform_token_at_least_32_chars',
	'ci_identity_support_token_at_least_32_chars',
	'ci_identity_operations_token_at_least_32_chars'
]);

export const InternalServices = (...services: IdentityInternalService[]) =>
	SetMetadata(META, services);

@Injectable()
export class IdentityInternalGuard implements CanActivate {
	private readonly tokens = new Map<IdentityInternalService, Buffer>();

	constructor(
		config: ConfigService,
		private readonly reflector: Reflector
	) {
		for (const service of IDENTITY_INTERNAL_SERVICES) {
			const name = `IDENTITY_${service.toUpperCase()}_TOKEN`;
			const value = config.get<string>(name)?.trim() || '';
			if (value.length < 32 || PLACEHOLDERS.has(value)) {
				throw new Error(
					`${name} must be a non-placeholder secret with at least 32 characters`
				);
			}
			this.tokens.set(service, Buffer.from(value));
		}
		const distinct = new Set(
			[...this.tokens.values()].map(value => value.toString('base64'))
		);
		if (distinct.size !== IDENTITY_INTERNAL_SERVICES.length) {
			throw new Error(
				'Identity internal service credentials must be pairwise distinct'
			);
		}
	}

	canActivate(context: ExecutionContext): boolean {
		const allowed =
			this.reflector.getAllAndOverride<IdentityInternalService[]>(META, [
				context.getHandler(),
				context.getClass()
			]) || [];
		const request = context.switchToHttp().getRequest<Request>();
		const service = request.header('x-winwidget-service') as
			| IdentityInternalService
			| undefined;
		if (
			!service ||
			!allowed.includes(service) ||
			!this.isLoopback(request.socket.remoteAddress)
		) {
			throw new ForbiddenException('Invalid internal credentials');
		}
		const expected = this.tokens.get(service)!;
		const candidate = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		if (
			candidate.length !== expected.length ||
			!timingSafeEqual(candidate, expected)
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
