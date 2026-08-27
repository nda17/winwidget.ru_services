import { Injectable } from '@nestjs/common';
import { Prisma, WidgetsOutboxExchange } from '@prisma/widgets-client';
import { randomUUID } from 'node:crypto';
import { projectionPayloadHash } from '../projections/widgets-projection.contract';

export const WIDGET_CHANGED_EVENT_TYPE = 'widgets.widget.changed.v1';
export const WIDGET_LEAD_CHANGED_EVENT_TYPE = 'widgets.lead.changed.v1';

export type WidgetsReportingEventType =
	| typeof WIDGET_CHANGED_EVENT_TYPE
	| typeof WIDGET_LEAD_CHANGED_EVENT_TYPE;

export interface ReportingEventInput {
	eventType: WidgetsReportingEventType;
	aggregateType: string;
	aggregateId: string;
	state: Prisma.InputJsonObject | null;
	tombstone: boolean;
	occurredAt?: Date;
	correlationId?: string;
}

@Injectable()
export class WidgetsReportingSequenceService {
	async createEventInTransaction(
		transaction: Prisma.TransactionClient,
		input: ReportingEventInput
	): Promise<{
		eventId: string;
		aggregateVersion: bigint;
		sourceSequence: bigint;
	}> {
		if (input.tombstone !== (input.state === null)) {
			throw new Error(
				'Reporting event tombstone must be true exactly when state is null'
			);
		}
		await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended('widgets-reporting-source-sequence', 0)
			)
		`;
		const sequence = await transaction.widgetSourceSequence.upsert({
			where: { id: 'reporting' },
			create: { id: 'reporting', lastValue: 1n },
			update: { lastValue: { increment: 1 } }
		});
		await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended(
					${`widgets-reporting-aggregate:${input.aggregateType}:${input.aggregateId}`},
					0
				)
			)
		`;
		const current = await transaction.widgetAggregateVersion.findUnique({
			where: {
				aggregateType_aggregateId: {
					aggregateType: input.aggregateType,
					aggregateId: input.aggregateId
				}
			}
		});
		const aggregateVersion = (current?.version || 0n) + 1n;
		const stateHash = projectionPayloadHash({
			tombstone: input.tombstone,
			state: input.state
		});
		await transaction.widgetAggregateVersion.upsert({
			where: {
				aggregateType_aggregateId: {
					aggregateType: input.aggregateType,
					aggregateId: input.aggregateId
				}
			},
			create: {
				aggregateType: input.aggregateType,
				aggregateId: input.aggregateId,
				version: aggregateVersion,
				sourceSequence: sequence.lastValue,
				stateHash
			},
			update: {
				version: aggregateVersion,
				sourceSequence: sequence.lastValue,
				stateHash
			}
		});
		const eventId = randomUUID();
		const occurredAt = input.occurredAt || new Date();
		const payload = {
			schemaVersion: 1,
			eventType: input.eventType,
			eventId,
			aggregateId: input.aggregateId,
			aggregateVersion: aggregateVersion.toString(),
			sourceSequence: sequence.lastValue.toString(),
			occurredAt: occurredAt.toISOString(),
			tombstone: input.tombstone,
			state: input.state
		} satisfies Prisma.InputJsonObject;
		await transaction.widgetsOutboxEvent.create({
			data: {
				messageId: eventId,
				deduplicationKey: `reporting:${input.aggregateType}:${input.aggregateId}:version:${aggregateVersion}`,
				exchange: WidgetsOutboxExchange.EVENTS,
				eventType: input.eventType,
				routingKey: input.eventType,
				payload,
				headers: {
					'x-correlation-id': input.correlationId || input.aggregateId,
					'x-causation-id': input.aggregateId
				},
				aggregateType: input.aggregateType,
				aggregateId: input.aggregateId,
				aggregateVersion,
				sourceSequence: sequence.lastValue
			}
		});
		return {
			eventId,
			aggregateVersion,
			sourceSequence: sequence.lastValue
		};
	}
}
