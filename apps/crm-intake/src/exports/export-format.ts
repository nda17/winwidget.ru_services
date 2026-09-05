import {
	ForbiddenException,
	HttpException,
	PayloadTooLargeException,
	ServiceUnavailableException
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Service-owned implementation. No runtime imports from other applications.
export const EXPORT_MAX_ROWS = 10_000;
export const EXPORT_MAX_BYTES = 16 * 1024 * 1024;
export const EXPORT_MAX_MS = 5_000;
export const EXPORT_PAGE_SIZE = 500;
export const EXPORT_EXPOSE_HEADERS =
	'content-disposition, content-length, x-content-type-options, x-wincrm-export-entity, x-wincrm-export-rows, x-wincrm-export-snapshot-at, x-wincrm-export-schema, x-wincrm-workspace-id, x-wincrm-export-actor-sha256, x-wincrm-export-bytes';
export type ExportFormat = 'json' | 'csv';
export interface ExportAuthority {
	workspaceId: string;
	subject: string;
	role: string;
	state: string;
	dataScope: 'ALL' | 'TEAM' | 'OWN';
	teamIds: string[];
	permissions: string[];
}
export type ExportItem = Record<string, string | number | null>;
export interface ExportFile {
	workspaceId: string;
	entity: string;
	format: ExportFormat;
	snapshotAt: string;
	rowCount: number;
	actorHash: string;
	body: Buffer;
}
export const assertExportAuthority = (
	context: ExportAuthority,
	workspaceId: string,
	namespace: string
) => {
	if (
		context.workspaceId !== workspaceId ||
		context.role !== 'OWNER' ||
		!['ACTIVE', 'GRACE', 'READ_ONLY'].includes(context.state) ||
		!context.permissions.includes(namespace + ':read') ||
		!context.permissions.includes(namespace + ':export')
	)
		throw new ForbiddenException({
			code: 'crm_export_permission_denied',
			message: 'Export is not allowed'
		});
};
export const exportScopeFingerprint = (context: ExportAuthority) =>
	JSON.stringify({
		subject: context.subject,
		workspaceId: context.workspaceId,
		scope: context.dataScope,
		teams: [...context.teamIds].sort()
	});
export const exportActorHash = (subject: string) =>
	createHash('sha256').update(subject, 'utf8').digest('hex');
export const exportScope = (
	context: ExportAuthority,
	ownerField: string
) => ({
	workspaceId: context.workspaceId,
	...(context.dataScope === 'ALL'
		? {}
		: context.dataScope === 'OWN'
			? { [ownerField]: context.subject }
			: {
					OR: [
						{ [ownerField]: context.subject },
						{ teamId: { in: context.teamIds } }
					]
				})
});
export function exportItem(
	row: Record<string, unknown>,
	columns: readonly string[]
): ExportItem {
	const item: ExportItem = {};
	for (const key of columns) {
		const value = row[key];
		if (value instanceof Date && Number.isFinite(value.getTime()))
			item[key] = value.toISOString();
		else if (
			value === null ||
			typeof value === 'string' ||
			(typeof value === 'number' && Number.isSafeInteger(value))
		)
			item[key] = value;
		else
			throw new ServiceUnavailableException({
				code: 'crm_export_unavailable',
				message: 'Export data is unavailable'
			});
	}
	return item;
}
export function exportCsvCell(value: string | number | null): string {
	let text = value === null ? '' : String(value);
	if (
		typeof value === 'string' &&
		(/^[\s\x00-\x1f\x7f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))
	)
		text = "'" + text;
	return '"' + text.replace(/"/g, '""') + '"';
}
export function exportCheckpoint(
	started: number,
	signal?: AbortSignal,
	now: () => number = performance.now.bind(performance)
) {
	if (signal?.aborted)
		throw new ServiceUnavailableException({
			code: 'crm_export_cancelled',
			message: 'Export was cancelled'
		});
	if (now() - started >= EXPORT_MAX_MS)
		throw new ServiceUnavailableException({
			code: 'crm_export_timeout',
			message: 'Export materialization timed out'
		});
}
export async function materializeExport(input: {
	workspaceId: string;
	entity: string;
	format: ExportFormat;
	snapshotAt: string;
	columns: readonly string[];
	started: number;
	signal?: AbortSignal;
	fetchPage: (after: string | null, take: number) => Promise<ExportItem[]>;
	now?: () => number;
}): Promise<{ body: Buffer; rowCount: number }> {
	let rowCount = 0;
	let cursor: string | null = null;
	let bytes = 0;
	const chunks: Buffer[] = [];
	const checkpoint = () =>
		exportCheckpoint(input.started, input.signal, input.now);
	const jsonPrefix = (count: number) =>
		Buffer.from(
			JSON.stringify({
				schemaVersion: 1,
				workspaceId: input.workspaceId,
				entity: input.entity,
				snapshotAt: input.snapshotAt,
				rowCount: count,
				items: []
			}).slice(0, -2)
		);
	if (input.format === 'csv') {
		const header = Buffer.from(
			'\uFEFF' + input.columns.map(exportCsvCell).join(',') + '\r\n'
		);
		chunks.push(header);
		bytes = header.byteLength;
	}
	for (;;) {
		checkpoint();
		const rows = await input.fetchPage(
			cursor,
			Math.min(EXPORT_PAGE_SIZE, EXPORT_MAX_ROWS + 1 - rowCount)
		);
		checkpoint();
		if (
			rows.length >
			Math.min(EXPORT_PAGE_SIZE, EXPORT_MAX_ROWS + 1 - rowCount)
		)
			throw new ServiceUnavailableException('Export page is invalid');
		for (const item of rows) {
			checkpoint();
			if (++rowCount > EXPORT_MAX_ROWS)
				throw new PayloadTooLargeException({
					code: 'crm_export_limit_exceeded',
					message: 'Export exceeds the row or byte limit'
				});
			if (
				typeof item.id !== 'string' ||
				item.workspaceId !== input.workspaceId ||
				Object.keys(item).length !== input.columns.length
			)
				throw new ServiceUnavailableException(
					'Export page scope is invalid'
				);
			const chunk = Buffer.from(
				input.format === 'json'
					? (rowCount > 1 ? ',' : '') + JSON.stringify(item)
					: input.columns.map(key => exportCsvCell(item[key])).join(',') +
							'\r\n'
			);
			bytes += chunk.byteLength;
			const total =
				bytes +
				(input.format === 'json'
					? jsonPrefix(rowCount).byteLength + 2
					: 0);
			if (total > EXPORT_MAX_BYTES)
				throw new PayloadTooLargeException({
					code: 'crm_export_limit_exceeded',
					message: 'Export exceeds the row or byte limit'
				});
			chunks.push(chunk);
		}
		if (rows.length === 0) break;
		const last = rows.at(-1)!.id as string;
		if (cursor !== null && last <= cursor)
			throw new ServiceUnavailableException('Export cursor is invalid');
		cursor = last;
		if (rows.length < EXPORT_PAGE_SIZE) break;
	}
	checkpoint();
	const body =
		input.format === 'json'
			? Buffer.concat([jsonPrefix(rowCount), ...chunks, Buffer.from(']}')])
			: Buffer.concat(chunks);
	if (body.byteLength > EXPORT_MAX_BYTES)
		throw new PayloadTooLargeException({
			code: 'crm_export_limit_exceeded',
			message: 'Export exceeds the row or byte limit'
		});
	checkpoint();
	return { body, rowCount };
}
export function exportHeaders(file: ExportFile): Record<string, string> {
	return {
		'Content-Type':
			file.format === 'json'
				? 'application/json; charset=utf-8'
				: 'text/csv; charset=utf-8',
		'Content-Length': String(file.body.byteLength),
		'Content-Disposition':
			'attachment; filename="wincrm-' +
			file.entity +
			'.' +
			file.format +
			'"',
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		'X-WinCRM-Export-Entity': file.entity,
		'X-WinCRM-Export-Rows': String(file.rowCount),
		'X-WinCRM-Export-Snapshot-At': file.snapshotAt,
		'X-WinCRM-Export-Schema': '1',
		'X-WinCRM-Workspace-Id': file.workspaceId,
		'X-WinCRM-Export-Actor-SHA256': file.actorHash,
		'X-WinCRM-Export-Bytes': String(file.body.byteLength)
	};
}
export class ExportConcurrency {
	private readonly active = new Set<string>();
	claim(context: ExportAuthority): () => void {
		const key = JSON.stringify([context.subject, context.workspaceId]);
		if (this.active.size >= 4 || this.active.has(key))
			throw new HttpException(
				{
					code: 'crm_export_busy',
					message: 'An export is already in progress; retry later'
				},
				429
			);
		this.active.add(key);
		return () => {
			this.active.delete(key);
		};
	}
}
