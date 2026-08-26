import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

const CAMPAIGNS_OPERATIONS_TOKEN_MIN_LENGTH = 32;
const CAMPAIGNS_OPERATIONS_TOKEN_PLACEHOLDERS = new Set([
	'XYZXYZXYZ',
	'change-me',
	'change_me',
	'CAMPAIGNS_OPERATIONS_TOKEN',
	'campaigns_operations_token',
	'ci_campaigns_operations_token_at_least_32_chars'
]);
const IPV4_LOOPBACK_PATTERN =
	/^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/;

export const isCampaignsMessagingLoopback = (
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
import {
	CAMPAIGNS_REQUIRED_ROLE,
	CampaignsRole
} from './campaigns-auth.decorator';
import type { CampaignsRequest } from './campaigns-request';
import { CampaignsDependenciesClient } from '../internal/campaigns-dependencies.client';
import { CampaignsRuntimeService } from '../runtime/campaigns-runtime.service';

@Injectable()
export class CampaignsApiGuard implements CanActivate {
	constructor(private readonly runtime: CampaignsRuntimeService) {}

	canActivate(): boolean {
		if (!this.runtime.apiEnabled) {
			throw new ServiceUnavailableException(
				'Campaigns API is disabled for this process role'
			);
		}
		return true;
	}
}

@Injectable()
export class CampaignsMessagingInternalGuard implements CanActivate {
	private readonly tokenHash: Buffer;

	constructor(config: ConfigService) {
		const token =
			config.get<string>('CAMPAIGNS_OPERATIONS_TOKEN')?.trim() || '';
		if (
			token.length < CAMPAIGNS_OPERATIONS_TOKEN_MIN_LENGTH ||
			CAMPAIGNS_OPERATIONS_TOKEN_PLACEHOLDERS.has(token)
		) {
			throw new Error(
				'CAMPAIGNS_OPERATIONS_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		this.tokenHash = hashInternalToken(token);
	}

	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		if (
			!isCampaignsMessagingLoopback(request.socket?.remoteAddress) ||
			request.headers['x-winwidget-service'] !== 'operations'
		) {
			throw new ForbiddenException('Invalid campaigns internal caller');
		}
		const supplied = request.headers['x-winwidget-internal-token'];
		if (
			typeof supplied !== 'string' ||
			!supplied ||
			supplied.length > 4096 ||
			!timingSafeEqual(this.tokenHash, hashInternalToken(supplied))
		) {
			throw new UnauthorizedException('Invalid campaigns internal token');
		}
		return true;
	}
}

@Injectable()
export class CampaignsAuthGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly dependencies: CampaignsDependenciesClient
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest<CampaignsRequest>();
		const authorization = request.headers.authorization?.trim() || '';
		if (!authorization.toLowerCase().startsWith('bearer ')) {
			throw new UnauthorizedException('Bearer token is required');
		}

		const actor = await this.dependencies.introspect(authorization);
		const requiredRole = this.reflector.getAllAndOverride<CampaignsRole>(
			CAMPAIGNS_REQUIRED_ROLE,
			[context.getHandler(), context.getClass()]
		);
		if (!requiredRole) {
			throw new ForbiddenException(
				'Campaigns endpoint has no access policy'
			);
		}
		if (!actor.roles.includes(requiredRole)) {
			throw new ForbiddenException(`${requiredRole} role is required`);
		}
		request.campaignsActor = actor;
		return true;
	}
}
