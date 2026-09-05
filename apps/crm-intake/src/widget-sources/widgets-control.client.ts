import {
	HttpException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { WidgetControlConfig } from './widget-control.config';
import {
	ConfigureRequest,
	identifier,
	integer,
	iso,
	object,
	text,
	uuid,
	widgetType
} from './widget-control.contract';

export class WidgetsControlDependencyError extends Error {
	constructor(
		readonly status: number,
		readonly code: string
	) {
		super('Widgets control dependency rejected request');
	}
}
export interface CandidateConnection {
	id: string;
	workspaceId: string;
	sourceId: string;
	controlVersion: number;
	generation: number;
	enabled: boolean;
}
export interface CandidateItem {
	widgetType: ReturnType<typeof widgetType>;
	widgetId: string;
	name: string;
	isActive: boolean;
	publishedVersion: number;
	createdAt: string;
	connector: CandidateConnection | null;
}
export interface WidgetsEligibility {
	schemaVersion: 1;
	ownerSubject: string;
	eligible: boolean;
	reason: string;
	subscriptionId: string | null;
	version: string | null;
	plan: 'TRIAL' | 'EASY' | 'HARD' | null;
	startsAt: string | null;
	expiresAt: string | null;
	checkedAt: string;
	validUntil: string;
}
export interface CandidatesResponse {
	schemaVersion: 1;
	ownerSubject: string;
	page: number;
	pageSize: number;
	total: number;
	eligibility: WidgetsEligibility;
	items: CandidateItem[];
}
function eligibility(value: unknown, owner: string): WidgetsEligibility {
	const row = object(value, [
		'schemaVersion',
		'ownerSubject',
		'eligible',
		'reason',
		'subscriptionId',
		'version',
		'plan',
		'startsAt',
		'expiresAt',
		'checkedAt',
		'validUntil'
	]);
	if (
		row.schemaVersion !== 1 ||
		row.ownerSubject !== owner ||
		typeof row.eligible !== 'boolean' ||
		![
			'ELIGIBLE',
			'NO_SUBSCRIPTION',
			'TRIAL',
			'INACTIVE',
			'NOT_STARTED',
			'EXPIRED'
		].includes(String(row.reason))
	)
		throw new Error('Invalid eligibility');
	const checked = Date.parse(iso(row.checkedAt)),
		until = Date.parse(iso(row.validUntil)),
		now = Date.now();
	if (checked > now || checked < now - 5000 || until > checked + 5000)
		throw new Error('Stale eligibility');
	if (row.reason === 'NO_SUBSCRIPTION') {
		if (
			row.eligible ||
			[
				row.subscriptionId,
				row.version,
				row.plan,
				row.startsAt,
				row.expiresAt
			].some(item => item !== null)
		)
			throw new Error('Invalid absent period');
	} else {
		identifier(row.subscriptionId, 255);
		if (
			typeof row.version !== 'string' ||
			!/^(0|[1-9][0-9]{0,18})$/.test(row.version) ||
			BigInt(row.version) > 9223372036854775807n
		)
			throw new Error('Invalid period version');
		if (!['TRIAL', 'EASY', 'HARD'].includes(String(row.plan)))
			throw new Error('Invalid plan');
		if (row.startsAt !== null) iso(row.startsAt);
		if (row.expiresAt !== null) iso(row.expiresAt);
	}
	if (row.eligible) {
		if (
			row.reason !== 'ELIGIBLE' ||
			!['EASY', 'HARD'].includes(String(row.plan)) ||
			row.startsAt === null ||
			row.expiresAt === null ||
			Date.parse(String(row.startsAt)) > checked ||
			Date.parse(String(row.expiresAt)) <= checked ||
			until <= now ||
			until > Date.parse(String(row.expiresAt))
		)
			throw new Error('Invalid active period');
	} else if (row.reason === 'ELIGIBLE' || until !== checked)
		throw new Error('Invalid denial');
	return row as unknown as WidgetsEligibility;
}
export function parseCandidates(
	value: unknown,
	owner: string,
	page: number,
	pageSize: number
): CandidatesResponse {
	const row = object(value, [
		'schemaVersion',
		'ownerSubject',
		'page',
		'pageSize',
		'total',
		'eligibility',
		'items'
	]);
	if (
		row.schemaVersion !== 1 ||
		row.ownerSubject !== owner ||
		row.page !== page ||
		row.pageSize !== pageSize ||
		!Array.isArray(row.items) ||
		row.items.length > pageSize
	)
		throw new Error('Invalid candidates');
	const total = integer(row.total, 0, Number.MAX_SAFE_INTEGER);
	if (total < row.items.length) throw new Error('Invalid total');
	const seen = new Set<string>();
	const items = row.items.map(raw => {
		const item = object(raw, [
			'widgetType',
			'widgetId',
			'name',
			'isActive',
			'publishedVersion',
			'createdAt',
			'connector'
		]);
		const type = widgetType(item.widgetType),
			id = identifier(item.widgetId, 255),
			key = type + ':' + id;
		if (seen.has(key) || typeof item.isActive !== 'boolean')
			throw new Error('Invalid widget');
		seen.add(key);
		let connector: CandidateConnection | null = null;
		if (item.connector !== null) {
			const value = object(item.connector, [
				'id',
				'workspaceId',
				'sourceId',
				'controlVersion',
				'generation',
				'enabled'
			]);
			if (value.enabled !== true)
				throw new Error('Invalid active connector');
			connector = {
				id: uuid(value.id),
				workspaceId: uuid(value.workspaceId),
				sourceId: uuid(value.sourceId),
				controlVersion: integer(value.controlVersion),
				generation: integer(value.generation),
				enabled: true
			};
			if (connector.generation > connector.controlVersion)
				throw new Error('Invalid connector generation');
		}
		return {
			widgetType: type,
			widgetId: id,
			name: text(item.name),
			isActive: item.isActive,
			publishedVersion: integer(item.publishedVersion, 0),
			createdAt: iso(item.createdAt),
			connector
		};
	});
	return {
		schemaVersion: 1,
		ownerSubject: owner,
		page,
		pageSize,
		total,
		eligibility: eligibility(row.eligibility, owner),
		items
	};
}
export function parseConfigureResponse(
	value: unknown,
	connectorId: string,
	request: ConfigureRequest
) {
	const result = object(value, ['schemaVersion', 'connector']);
	if (result.schemaVersion !== 1)
		throw new Error('Invalid response schema');
	const row = object(result.connector, [
		'id',
		'workspaceId',
		'sourceId',
		'ownerSubject',
		'widgetType',
		'widgetId',
		'controlVersion',
		'generation',
		'enabled',
		'enabledAt',
		'createdAt',
		'updatedAt'
	]);
	for (const key of [
		'workspaceId',
		'sourceId',
		'ownerSubject',
		'widgetType',
		'widgetId',
		'controlVersion',
		'generation',
		'enabled'
	] as const)
		if (row[key] !== request[key])
			throw new Error('Invalid acknowledgment binding');
	if (row.id !== connectorId)
		throw new Error('Invalid connector identity');
	iso(row.createdAt);
	iso(row.updatedAt);
	if (request.enabled) {
		iso(row.enabledAt);
	} else if (row.enabledAt !== null)
		throw new Error('Invalid disabled connector');
	return result as {
		schemaVersion: 1;
		connector: Record<string, string | number | boolean | null>;
	};
}
@Injectable()
export class WidgetsControlClient {
	constructor(private readonly config: WidgetControlConfig) {}
	async candidates(ownerSubject: string, page: number, pageSize: number) {
		return this.checked(() =>
			this.request(
				'widget-connectors/candidates',
				{ schemaVersion: 1, ownerSubject, page, pageSize },
				256 * 1024
			).then(value => parseCandidates(value, ownerSubject, page, pageSize))
		);
	}
	async configure(connectorId: string, request: ConfigureRequest) {
		return this.checked(() =>
			this.request(
				'widget-connectors/' + uuid(connectorId) + '/configure',
				request,
				16384,
				request.commandId
			).then(value => parseConfigureResponse(value, connectorId, request))
		);
	}
	private async checked<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (
				error instanceof WidgetsControlDependencyError ||
				error instanceof HttpException
			)
				throw error;
			throw new ServiceUnavailableException({
				code: 'crm_widget_source_dependency_unavailable',
				message: 'Widgets dependency is unavailable'
			});
		}
	}
	private async request(
		path: string,
		body: object,
		limit: number,
		commandId?: string
	): Promise<unknown> {
		if (!this.config.enabled) throw new NotFoundException();
		const response = await fetch(
			this.config.origin + '/internal/v1/crm-intake/' + path,
			{
				method: 'POST',
				redirect: 'error',
				cache: 'no-store',
				signal: AbortSignal.timeout(this.config.timeoutMs),
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
					'x-winwidget-service': 'crm-intake',
					'x-winwidget-internal-token': this.config.token,
					...(commandId ? { 'idempotency-key': commandId } : {})
				},
				body: JSON.stringify(body)
			}
		);
		if (
			!response.body ||
			response.redirected ||
			!response.headers
				.get('content-type')
				?.toLowerCase()
				.includes('application/json')
		) {
			await response.body?.cancel();
			throw new Error('Invalid dependency response');
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				length += part.value.byteLength;
				if (length > limit) {
					await reader.cancel();
					throw new Error('Dependency body too large');
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
		const value = JSON.parse(
			Buffer.concat(chunks, length).toString('utf8')
		);
		if (response.status !== 200) {
			const code =
				value &&
				typeof value === 'object' &&
				typeof value.code === 'string'
					? value.code
					: '';
			const allow = [
				'widgets_wincrm_subscription_required',
				'widgets_wincrm_widget_already_connected',
				'widgets_wincrm_widget_not_found',
				'widgets_wincrm_control_stale',
				'widgets_wincrm_control_conflict',
				'widgets_wincrm_generation_conflict',
				'widgets_wincrm_binding_conflict',
				'widgets_wincrm_internal_forbidden'
			];
			throw new WidgetsControlDependencyError(
				response.status,
				allow.includes(code) ? code : 'DEPENDENCY_UNAVAILABLE'
			);
		}
		return value;
	}
}
