import { CoreInternalClient } from '../internal/core-internal.client';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import type { ReportingRequest } from './reporting-request';
import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	SetMetadata,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

const REPORTING_INTERNAL_TOKEN_MIN_LENGTH = 32;
const REPORTING_INTERNAL_TOKEN_PLACEHOLDERS = new Set([
	'XYZXYZXYZ',
	'change-me',
	'change_me',
	'REPORTING_INTERNAL_TOKEN',
	'reporting_internal_token',
	'ci_reporting_internal_token_at_least_32_chars'
]);
const IPV4_LOOPBACK_PATTERN =
	/^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/;

export const isReportingMessagingLoopback = (
	address: string | undefined
): boolean => {
	if (!address) return false;
	const normalized = address.toLowerCase();
	if (normalized === '::1') return true;
	const ipv4 = normalized.startsWith('::ffff:')
		? normalized.slice('::ffff:'.length)
		: normalized;
	return (
		IPV4_LOOPBACK_PATTERN.test(ipv4) &&
		ipv4
			.split('.')
			.slice(1)
			.every(part => Number(part) >= 0 && Number(part) <= 255)
	);
};

const hashInternalToken = (value: string): Buffer =>
	createHash('sha256').update(value, 'utf8').digest();

export const REPORTING_REQUIRED_ROLE = 'reporting-required-role';
export type ReportingRequiredRole = 'ADMIN' | 'DEV';
export const RequireReportingRole = (role: ReportingRequiredRole) =>
	SetMetadata(REPORTING_REQUIRED_ROLE, role);

@Injectable()
export class ReportingApiGuard implements CanActivate {
	constructor(private readonly runtime: ReportingRuntimeService) {}

	canActivate(): boolean {
		if (!this.runtime.apiEnabled) {
			throw new ServiceUnavailableException(
				'Reporting API is disabled for this process role'
			);
		}
		return true;
	}
}

@Injectable()
export class ReportingMessagingInternalGuard implements CanActivate {
	private readonly tokenHash: Buffer;

	constructor(config: ConfigService) {
		const token =
			config.get<string>('REPORTING_INTERNAL_TOKEN')?.trim() || '';
		if (
			token.length < REPORTING_INTERNAL_TOKEN_MIN_LENGTH ||
			REPORTING_INTERNAL_TOKEN_PLACEHOLDERS.has(token)
		) {
			throw new Error(
				'REPORTING_INTERNAL_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		this.tokenHash = hashInternalToken(token);
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		if (
			!isReportingMessagingLoopback(request.socket?.remoteAddress) ||
			request.headers['x-winwidget-service'] !== 'core'
		) {
			throw new ForbiddenException('Invalid reporting internal caller');
		}
		const supplied = request.headers['x-winwidget-internal-token'];
		if (
			typeof supplied !== 'string' ||
			!supplied ||
			supplied.length > 4096 ||
			!timingSafeEqual(this.tokenHash, hashInternalToken(supplied))
		) {
			throw new UnauthorizedException('Invalid reporting internal token');
		}
		return true;
	}
}

@Injectable()
export class ReportingAdminGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly coreInternal: CoreInternalClient
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<ReportingRequest>();
		const authorization = request.headers.authorization?.trim() || '';
		if (!authorization.toLowerCase().startsWith('bearer ')) {
			throw new UnauthorizedException('Bearer token is required');
		}
		// Forwarded role/user headers are intentionally ignored. Only the
		// fail-closed core introspection result is trusted for authorization.
		const actor = await this.coreInternal.introspect(authorization);
		const requiredRole =
			this.reflector.getAllAndOverride<ReportingRequiredRole>(
				REPORTING_REQUIRED_ROLE,
				[context.getHandler(), context.getClass()]
			);
		if (!requiredRole) {
			throw new ForbiddenException(
				'Reporting endpoint has no access policy'
			);
		}
		if (!actor.roles.includes(requiredRole)) {
			throw new ForbiddenException(`${requiredRole} role is required`);
		}
		request.reportingActor = actor;
		return true;
	}
}
