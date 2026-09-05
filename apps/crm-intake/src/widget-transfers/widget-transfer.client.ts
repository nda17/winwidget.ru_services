import { Injectable } from '@nestjs/common';
import { WidgetControlConfig } from '../widget-sources/widget-control.config';
import {
	iso,
	record,
	parseWidgetLeadSnapshot,
	SNAPSHOT_SKIP_REASONS,
	TransferEvent,
	TransferReason,
	WidgetLeadSnapshotV1
} from './widget-transfer.contract';

export interface WidgetTransferContext {
	schemaVersion: 1;
	transferId: string;
	eventId: string;
	connectorId: string;
	generation: number;
	workspaceId: string;
	sourceId: string;
	deliver: boolean;
	reason: TransferReason;
	checkedAt: string;
	validUntil: string;
	payload: WidgetLeadSnapshotV1 | null;
}
export class WidgetTransferDependencyError extends Error {
	constructor(
		readonly status: number,
		readonly code:
			| 'DEPENDENCY_UNAVAILABLE'
			| 'INVALID_RESPONSE'
			| 'CONTEXT_UNAVAILABLE' = 'DEPENDENCY_UNAVAILABLE'
	) {
		super(code);
	}
}
export function parseWidgetTransferContext(
	value: unknown,
	event: TransferEvent,
	source: { widgetType: string; widgetId: string },
	now = Date.now()
): WidgetTransferContext {
	const data = record(value, [
		'schemaVersion',
		'transferId',
		'eventId',
		'connectorId',
		'generation',
		'workspaceId',
		'sourceId',
		'deliver',
		'reason',
		'checkedAt',
		'validUntil',
		'payload'
	]);
	if (
		data.schemaVersion !== 1 ||
		[
			'transferId',
			'eventId',
			'connectorId',
			'generation',
			'workspaceId',
			'sourceId'
		].some(k => data[k] !== event[k as keyof TransferEvent])
	)
		throw new Error('Invalid transfer binding');
	const reasons: TransferReason[] = [
		...SNAPSHOT_SKIP_REASONS,
		'READY',
		'CONNECTOR_DISABLED',
		'GENERATION_CHANGED',
		'WIDGET_UNAVAILABLE',
		'LEAD_UNAVAILABLE',
		'PERIOD_EXPIRED',
		'BILLING_INELIGIBLE',
		'BILLING_PERIOD_CHANGED'
	];
	if (
		typeof data.deliver !== 'boolean' ||
		!reasons.includes(data.reason as TransferReason)
	)
		throw new Error('Invalid outcome');
	const checked = Date.parse(iso(data.checkedAt)),
		until = Date.parse(iso(data.validUntil));
	if (checked > now || checked < now - 5000 || until > checked + 5000)
		throw new Error('Stale context');
	if (data.deliver) {
		if (
			data.reason !== 'READY' ||
			until <= now ||
			!event.originalDeadline ||
			!event.originalPeriodStartsAt ||
			!event.originalSubscriptionId ||
			event.originalSubscriptionVersion === null ||
			until > Date.parse(event.originalDeadline) ||
			Date.parse(event.originalPeriodStartsAt) >
				Date.parse(event.occurredAt) ||
			Date.parse(event.originalDeadline) <= Date.parse(event.occurredAt) ||
			Date.parse(event.occurredAt) > now
		)
			throw new Error('Invalid period proof');
		const payload = parseWidgetLeadSnapshot(data.payload);
		if (
			payload.widget.type !== source.widgetType ||
			payload.widget.id !== source.widgetId ||
			payload.lead.createdAt !== event.occurredAt
		)
			throw new Error('Invalid payload binding');
	} else if (
		data.reason === 'READY' ||
		data.payload !== null ||
		until !== checked
	)
		throw new Error('Invalid denial');
	return data as unknown as WidgetTransferContext;
}
@Injectable()
export class WidgetTransferClient {
	constructor(private readonly config: WidgetControlConfig) {}
	async context(
		event: TransferEvent,
		source: { widgetType: string; widgetId: string }
	): Promise<WidgetTransferContext> {
		if (!this.config.enabled) throw new WidgetTransferDependencyError(503);
		const abort = AbortSignal.timeout(this.config.timeoutMs);
		try {
			const response = await fetch(
				this.config.origin +
					'/internal/v1/crm-intake/widget-transfers/' +
					event.transferId +
					'/context',
				{
					method: 'POST',
					redirect: 'error',
					cache: 'no-store',
					signal: abort,
					headers: {
						'content-type': 'application/json',
						accept: 'application/json',
						'x-winwidget-service': 'crm-intake',
						'x-winwidget-internal-token': this.config.token
					},
					body: JSON.stringify({
						schemaVersion: 1,
						eventId: event.eventId,
						connectorId: event.connectorId,
						generation: event.generation,
						workspaceId: event.workspaceId,
						sourceId: event.sourceId
					})
				}
			);
			if (response.status !== 200) {
				await response.body?.cancel();
				throw new WidgetTransferDependencyError(
					response.status,
					response.status === 404
						? 'CONTEXT_UNAVAILABLE'
						: 'DEPENDENCY_UNAVAILABLE'
				);
			}
			if (
				response.redirected ||
				!response.body ||
				!response.headers
					.get('content-type')
					?.toLowerCase()
					.includes('application/json')
			)
				throw new WidgetTransferDependencyError(503, 'INVALID_RESPONSE');
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let length = 0;
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					length += chunk.value.byteLength;
					if (length > 272 * 1024) {
						await reader.cancel();
						throw new Error('Limit');
					}
					chunks.push(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}
			try {
				return parseWidgetTransferContext(
					JSON.parse(
						new TextDecoder('utf-8', { fatal: true }).decode(
							Buffer.concat(chunks, length)
						)
					),
					event,
					source
				);
			} catch {
				throw new WidgetTransferDependencyError(503, 'INVALID_RESPONSE');
			}
		} catch (error) {
			if (error instanceof WidgetTransferDependencyError) throw error;
			throw new WidgetTransferDependencyError(503);
		}
	}
}
