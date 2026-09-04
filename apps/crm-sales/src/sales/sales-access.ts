import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException,
	SetMetadata,
	UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

export interface SalesAccess {
	schemaVersion: 1;
	workspaceId: string;
	subject: string;
	role: 'OWNER' | 'CRM_ADMIN' | 'TEAM_LEAD' | 'MANAGER' | 'ANALYST';
	state: 'ACTIVE' | 'GRACE' | 'READ_ONLY';
	dataScope: 'ALL' | 'TEAM' | 'OWN';
	teamIds: string[];
	permissions: string[];
}
export interface SalesRequest extends Request {
	salesAccess: SalesAccess;
}
export const SALES_PERMISSION = 'crm-sales-permission';
export const SalesPermission = (permission: string) =>
	SetMetadata(SALES_PERMISSION, permission);
export const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function serviceOrigin(value: string | undefined) {
	try {
		const url = new URL(value || '');
		if (
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash ||
			(url.protocol !== 'https:' &&
				!(
					url.protocol === 'http:' &&
					['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
				))
		)
			throw new Error();
		return url.origin;
	} catch {
		throw new ServiceUnavailableException(
			'CRM service configuration is unavailable'
		);
	}
}

export function parseSalesAccess(
	value: unknown,
	workspaceId: string
): SalesAccess {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid access response');
	const access = value as Record<string, unknown>;
	const keys = [
		'schemaVersion',
		'workspaceId',
		'subject',
		'role',
		'state',
		'dataScope',
		'teamIds',
		'permissions'
	];
	if (
		Object.keys(access).length !== keys.length ||
		keys.some(key => !(key in access)) ||
		access.schemaVersion !== 1 ||
		access.workspaceId !== workspaceId ||
		typeof access.subject !== 'string' ||
		!/^[^\s\x00-\x1f\x7f]{1,256}$/.test(access.subject) ||
		!['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER', 'ANALYST'].includes(
			String(access.role)
		) ||
		!['ACTIVE', 'GRACE', 'READ_ONLY'].includes(String(access.state)) ||
		!['ALL', 'TEAM', 'OWN'].includes(String(access.dataScope)) ||
		!Array.isArray(access.teamIds) ||
		access.teamIds.length > 10000 ||
		access.teamIds.some(id => typeof id !== 'string' || !UUID.test(id)) ||
		new Set(access.teamIds).size !== access.teamIds.length ||
		!Array.isArray(access.permissions) ||
		access.permissions.length > 100 ||
		access.permissions.some(
			permission =>
				typeof permission !== 'string' ||
				!/^[a-z][a-z-]*:[a-z][a-z-]*$/.test(permission)
		)
	)
		throw new Error('Invalid access response');
	return access as unknown as SalesAccess;
}

export function salesAccessToken() {
	const token = process.env.CRM_ACCESS_CRM_SALES_TOKEN;
	if (
		!token ||
		token.startsWith('replace-') ||
		token.length < 32 ||
		token.length > 4096 ||
		/\s/.test(token)
	) {
		throw new ServiceUnavailableException(
			'CRM access configuration is unavailable'
		);
	}
	return token;
}

@Injectable()
export class SalesAccessClient {
	async authorize(
		authorization: string,
		workspaceId: string
	): Promise<SalesAccess> {
		const origin = serviceOrigin(process.env.CRM_ACCESS_INTERNAL_BASE_URL);
		const token = salesAccessToken();
		let response: Response;
		try {
			response = await fetch(
				`${origin}/internal/v1/crm-access/authorize`,
				{
					method: 'POST',
					headers: {
						Authorization: authorization,
						'content-type': 'application/json',
						'x-winwidget-service': 'crm-sales',
						'x-winwidget-internal-token': token
					},
					body: JSON.stringify({ schemaVersion: 1, workspaceId }),
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(5000)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'CRM access is temporarily unavailable'
			);
		}
		if (response.status === 401) throw new UnauthorizedException();
		if (response.status === 403) throw new ForbiddenException();
		try {
			if (!response.ok) throw new Error();
			return parseSalesAccess(await response.json(), workspaceId);
		} catch {
			throw new ServiceUnavailableException(
				'CRM access is temporarily unavailable'
			);
		}
	}
}

@Injectable()
export class SalesAccessGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly client: SalesAccessClient
	) {}
	async canActivate(context: ExecutionContext) {
		const request = context.switchToHttp().getRequest<SalesRequest>();
		const permission = this.reflector.getAllAndOverride<string>(
			SALES_PERMISSION,
			[context.getHandler(), context.getClass()]
		);
		if (!permission) throw new ForbiddenException();
		const authorization = request.headers.authorization;
		if (!authorization || !/^Bearer [^\s]{1,16384}$/.test(authorization))
			throw new UnauthorizedException();
		const workspaceId =
			request.method === 'GET'
				? request.query.workspaceId
				: request.body?.workspaceId;
		if (typeof workspaceId !== 'string' || !UUID.test(workspaceId))
			throw new ForbiddenException('Workspace is required');
		const access = await this.client.authorize(authorization, workspaceId);
		if (
			!access.permissions.includes(permission) ||
			(access.state === 'READ_ONLY' &&
				!['sales:read', 'sales:export', 'sales:analytics'].includes(
					permission
				)) ||
			(access.role === 'ANALYST' && permission !== 'sales:analytics')
		)
			throw new ForbiddenException();
		request.salesAccess = access;
		return true;
	}
}
