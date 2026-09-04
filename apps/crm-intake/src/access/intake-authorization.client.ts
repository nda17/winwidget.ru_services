import {
	ForbiddenException,
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';

export interface IntakeAuthorization {
	schemaVersion: 1;
	workspaceId: string;
	subject: string;
	role: 'OWNER' | 'CRM_ADMIN' | 'TEAM_LEAD' | 'MANAGER' | 'ANALYST';
	state: 'ACTIVE' | 'GRACE' | 'READ_ONLY';
	dataScope: 'ALL' | 'TEAM' | 'OWN';
	teamIds: string[];
	permissions: string[];
}

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = [
	'schemaVersion',
	'workspaceId',
	'subject',
	'role',
	'state',
	'dataScope',
	'teamIds',
	'permissions'
];

export function parseIntakeAuthorization(
	value: unknown,
	workspaceId: string
): IntakeAuthorization | null {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return null;
	const data = value as Record<string, unknown>;
	if (
		Object.keys(data).length !== KEYS.length ||
		!KEYS.every(key => Object.prototype.hasOwnProperty.call(data, key)) ||
		data.schemaVersion !== 1 ||
		data.workspaceId !== workspaceId ||
		!UUID.test(workspaceId) ||
		typeof data.subject !== 'string' ||
		!/^[^\s\x00-\x1f\x7f]{1,256}$/.test(data.subject) ||
		typeof data.role !== 'string' ||
		!['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER', 'ANALYST'].includes(
			String(data.role)
		) ||
		typeof data.state !== 'string' ||
		!['ACTIVE', 'GRACE', 'READ_ONLY'].includes(data.state) ||
		typeof data.dataScope !== 'string' ||
		!['ALL', 'TEAM', 'OWN'].includes(data.dataScope) ||
		!Array.isArray(data.teamIds) ||
		data.teamIds.length > 1000 ||
		!data.teamIds.every(id => typeof id === 'string' && UUID.test(id)) ||
		new Set(data.teamIds).size !== data.teamIds.length ||
		!Array.isArray(data.permissions) ||
		data.permissions.length > 100 ||
		!data.permissions.every(
			permission =>
				typeof permission === 'string' &&
				/^[a-z][a-z-]{0,63}:[a-z][a-z-]{0,63}$/.test(permission)
		) ||
		new Set(data.permissions).size !== data.permissions.length
	)
		return null;
	return data as unknown as IntakeAuthorization;
}

export function parseIntakeAccessOrigin(
	value: string | undefined
): string {
	let url: URL;
	try {
		url = new URL(value || '');
	} catch {
		throw new Error('CRM_ACCESS_INTERNAL_BASE_URL must be configured');
	}
	if (
		(url.protocol !== 'https:' &&
			!(
				url.protocol === 'http:' &&
				['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
			)) ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	)
		throw new Error(
			'CRM_ACCESS_INTERNAL_BASE_URL must be an exact HTTPS origin or loopback HTTP origin'
		);
	return url.origin;
}

export function assertIntakePermission(
	context: IntakeAuthorization,
	permission: string,
	write = false
): void {
	if (
		!context.permissions.includes(permission) ||
		(write && context.state === 'READ_ONLY')
	) {
		throw new ForbiddenException({
			code: 'crm_intake_permission_denied',
			message: 'Intake action is not allowed'
		});
	}
}

@Injectable()
export class IntakeAuthorizationClient {
	private readonly origin = parseIntakeAccessOrigin(
		process.env.CRM_ACCESS_INTERNAL_BASE_URL
	);
	private readonly token: string;
	private readonly timeout: number;

	constructor() {
		this.token = process.env.CRM_ACCESS_CRM_INTAKE_TOKEN?.trim() || '';
		if (
			this.token.length < 32 ||
			/change[_-]?me|<[^>]+>|^ci_/i.test(this.token) ||
			/\s/.test(this.token)
		) {
			throw new Error(
				'CRM_ACCESS_CRM_INTAKE_TOKEN requires a non-placeholder secret of at least 32 characters'
			);
		}
		this.timeout = Number(
			process.env.CRM_ACCESS_INTERNAL_TIMEOUT_MS || 10_000
		);
		if (
			!Number.isInteger(this.timeout) ||
			this.timeout < 500 ||
			this.timeout > 60_000
		)
			throw new Error(
				'CRM_ACCESS_INTERNAL_TIMEOUT_MS must be between 500 and 60000'
			);
	}

	async authorize(
		authorization: string | undefined,
		workspaceId: string
	): Promise<IntakeAuthorization> {
		if (
			!authorization ||
			!/^Bearer [^\s\x00-\x1f\x7f]{1,8192}$/.test(authorization)
		)
			throw new UnauthorizedException('Bearer authentication is required');
		return this.request('authorize', workspaceId, authorization);
	}

	async authorizeSource(
		workspaceId: string,
		subject: string
	): Promise<IntakeAuthorization> {
		const context = await this.request(
			'authorize-source',
			workspaceId,
			undefined,
			subject
		);
		if (context.subject !== subject)
			throw new ServiceUnavailableException(
				'CRM source authority could not be confirmed'
			);
		if (
			!['OWNER', 'CRM_ADMIN'].includes(context.role) ||
			context.state === 'READ_ONLY' ||
			!context.permissions.includes('intake:manage-sources')
		) {
			throw new ForbiddenException('CRM source access is denied');
		}
		return context;
	}

	private async request(
		path: 'authorize' | 'authorize-source',
		workspaceId: string,
		authorization?: string,
		subject?: string
	): Promise<IntakeAuthorization> {
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), this.timeout);
		try {
			const response = await fetch(
				`${this.origin}/internal/v1/crm-access/${path}`,
				{
					method: 'POST',
					redirect: 'error',
					signal: abort.signal,
					headers: {
						...(authorization ? { authorization } : {}),
						'content-type': 'application/json',
						'x-winwidget-service': 'crm-intake',
						'x-winwidget-internal-token': this.token
					},
					body: JSON.stringify({
						schemaVersion: 1,
						workspaceId,
						...(subject ? { subject } : {})
					})
				}
			);
			if (response.status === 401 && path === 'authorize') {
				await response.body?.cancel();
				throw new UnauthorizedException('CRM session is not active');
			}
			if (response.status === 403) {
				await response.body?.cancel();
				throw new ForbiddenException('CRM access is denied');
			}
			if (response.status !== 200 || !response.body) {
				await response.body?.cancel();
				throw new Error('DEPENDENCY_RESPONSE');
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.byteLength;
					if (size > 64 * 1024) {
						await reader.cancel();
						throw new Error('DEPENDENCY_SIZE');
					}
					chunks.push(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}
			const context = parseIntakeAuthorization(
				JSON.parse(Buffer.concat(chunks, size).toString('utf8')),
				workspaceId
			);
			if (!context) throw new Error('DEPENDENCY_CONTRACT');
			return context;
		} catch (error) {
			if (
				error instanceof UnauthorizedException ||
				error instanceof ForbiddenException
			)
				throw error;
			throw new ServiceUnavailableException({
				code: 'crm_intake_access_unavailable',
				message: 'CRM access could not be confirmed'
			});
		} finally {
			clearTimeout(timer);
		}
	}
}
