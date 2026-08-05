import { Injectable } from '@nestjs/common';
import { Prisma, WidgetsOutboxExchange } from '@prisma/widgets-client';
import { randomUUID } from 'node:crypto';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import { projectionPayloadHash } from '../projections/widgets-projection.contract';

export const WIDGET_CHANGED_EVENT_TYPE = 'widgets.widget.changed.v1';
export const WIDGET_LEAD_CHANGED_EVENT_TYPE = 'widgets.lead.changed.v1';

export type WidgetsReportingEventType =
	| typeof WIDGET_CHANGED_EVENT_TYPE
	| typeof WIDGET_LEAD_CHANGED_EVENT_TYPE;

export interface ReportingAggregateSeed {
	aggregateType: string;
	aggregateId: string;
	version: string;
	sourceSequence: string;
	stateHash: string;
}

export interface ReportingSequenceSeed {
	sourceDatabaseFingerprint: string;
	sourceExportedAt: string;
	sourceSnapshotSha256: string;
	sourceSnapshotCounts: Prisma.InputJsonObject;
	sourceSequenceHighWater: string;
	aggregates: ReportingAggregateSeed[];
}

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
	constructor(private readonly prisma: WidgetsPrismaService) {}

	async seed(input: ReportingSequenceSeed): Promise<void> {
		this.assertSeed(input);
		await this.prisma.$transaction(
			transaction => this.seedInTransaction(transaction, input),
			{ maxWait: 5000, timeout: 30_000 }
		);
	}

	async seedInTransaction(
		transaction: Prisma.TransactionClient,
		input: ReportingSequenceSeed
	): Promise<void> {
		this.assertSeed(input);
		await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended('widgets-reporting-sequence-seed', 0)
			)
		`;
		const identity = await this.ensureIdentity(transaction);
		if (identity.ownershipActivatedAt) {
			throw new Error(
				'Reporting sequence cannot be seeded after Widgets ownership activation'
			);
		}
		if (
			identity.sourceDatabaseFingerprint &&
			identity.sourceDatabaseFingerprint !==
				input.sourceDatabaseFingerprint
		) {
			throw new Error(
				'Reporting sequence seed source fingerprint does not match the existing import'
			);
		}
		if (
			identity.sourceSnapshotSha256 &&
			identity.sourceSnapshotSha256 !== input.sourceSnapshotSha256
		) {
			throw new Error(
				'Reporting sequence seed snapshot hash conflicts with the existing import'
			);
		}
		const highWater = BigInt(input.sourceSequenceHighWater);
		const sequence = await transaction.widgetSourceSequence.findUnique({
			where: { id: 'reporting' }
		});
		if (sequence && sequence.lastValue > highWater) {
			throw new Error(
				'Reporting sequence seed would move the source high-water backwards'
			);
		}
		await transaction.widgetSourceSequence.upsert({
			where: { id: 'reporting' },
			create: { id: 'reporting', lastValue: highWater },
			update: { lastValue: highWater }
		});
		for (const aggregate of input.aggregates) {
			const version = BigInt(aggregate.version);
			const sourceSequence = BigInt(aggregate.sourceSequence);
			const current = await transaction.widgetAggregateVersion.findUnique({
				where: {
					aggregateType_aggregateId: {
						aggregateType: aggregate.aggregateType,
						aggregateId: aggregate.aggregateId
					}
				}
			});
			if (
				current &&
				(current.version !== version ||
					current.sourceSequence !== sourceSequence ||
					current.stateHash !== aggregate.stateHash)
			) {
				throw new Error(
					`Reporting aggregate seed conflicts with existing anchor type=${aggregate.aggregateType} id=${aggregate.aggregateId}`
				);
			}
			await transaction.widgetAggregateVersion.upsert({
				where: {
					aggregateType_aggregateId: {
						aggregateType: aggregate.aggregateType,
						aggregateId: aggregate.aggregateId
					}
				},
				create: {
					aggregateType: aggregate.aggregateType,
					aggregateId: aggregate.aggregateId,
					version,
					sourceSequence,
					stateHash: aggregate.stateHash
				},
				update: {}
			});
		}
		await transaction.widgetsServiceIdentity.update({
			where: { id: 'widgets-service' },
			data: {
				sourceDatabaseFingerprint: input.sourceDatabaseFingerprint,
				sourceExportedAt: new Date(input.sourceExportedAt),
				sourceSnapshotSha256: input.sourceSnapshotSha256,
				sourceSnapshotCounts: input.sourceSnapshotCounts,
				sourceReportingHighWater: highWater
			}
		});
	}

	async activateOwnership(): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			await transaction.$executeRaw`
				SELECT pg_advisory_xact_lock(
					hashtextextended('widgets-reporting-sequence-seed', 0)
				)
			`;
			const identity = await this.ensureIdentity(transaction);
			if (identity.ownershipActivatedAt) return;
			if (
				!identity.sourceDatabaseFingerprint ||
				!identity.sourceExportedAt ||
				!identity.sourceSnapshotSha256 ||
				!identity.sourceSnapshotCounts ||
				identity.sourceReportingHighWater === null
			) {
				throw new Error(
					'Reporting sequence must be seeded before Widgets ownership activation'
				);
			}
			if (!identity.handoffStartedAt) {
				throw new Error(
					'Widgets durable handoff must start before ownership activation'
				);
			}
			const sequence = await transaction.widgetSourceSequence.findUnique({
				where: { id: 'reporting' }
			});
			if (!sequence) {
				throw new Error(
					'Reporting source sequence anchor is missing before ownership activation'
				);
			}
			await transaction.widgetsServiceIdentity.update({
				where: { id: 'widgets-service' },
				data: {
					ownershipGeneration: { increment: 1 },
					ownershipActivatedAt: new Date()
				}
			});
		});
	}

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
		const identity = await transaction.widgetsServiceIdentity.findUnique({
			where: { id: 'widgets-service' }
		});
		if (!identity?.ownershipActivatedAt) {
			throw new Error(
				'Widgets Reporting producer ownership is not active'
			);
		}
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

	private async ensureIdentity(transaction: Prisma.TransactionClient) {
		return transaction.widgetsServiceIdentity.upsert({
			where: { id: 'widgets-service' },
			create: {
				id: 'widgets-service',
				databaseId: randomUUID()
			},
			update: {}
		});
	}

	private assertSeed(input: ReportingSequenceSeed): void {
		if (!/^[0-9a-f]{64}$/.test(input.sourceDatabaseFingerprint)) {
			throw new Error('Reporting seed source fingerprint must be SHA-256');
		}
		if (!/^[0-9a-f]{64}$/.test(input.sourceSnapshotSha256)) {
			throw new Error('Reporting seed snapshot hash must be SHA-256');
		}
		if (
			!input.sourceSnapshotCounts ||
			typeof input.sourceSnapshotCounts !== 'object' ||
			Array.isArray(input.sourceSnapshotCounts)
		) {
			throw new Error('Reporting seed snapshot counts must be an object');
		}
		this.assertIsoDate(input.sourceExportedAt, 'sourceExportedAt');
		this.assertDecimal(
			input.sourceSequenceHighWater,
			'sourceSequenceHighWater',
			true
		);
		const seen = new Set<string>();
		const highWater = BigInt(input.sourceSequenceHighWater);
		for (const aggregate of input.aggregates) {
			if (
				!aggregate.aggregateType.startsWith('widgets.widget.') &&
				!aggregate.aggregateType.startsWith('widgets.lead.')
			) {
				throw new Error(
					'Reporting seed aggregate type is not Widget-owned'
				);
			}
			if (!aggregate.aggregateId || aggregate.aggregateId.length > 255) {
				throw new Error('Reporting seed aggregate ID is invalid');
			}
			const key = `${aggregate.aggregateType}\u0000${aggregate.aggregateId}`;
			if (seen.has(key))
				throw new Error('Reporting seed has duplicate aggregate');
			seen.add(key);
			this.assertDecimal(aggregate.version, 'aggregate.version', false);
			this.assertDecimal(
				aggregate.sourceSequence,
				'aggregate.sourceSequence',
				false
			);
			if (BigInt(aggregate.sourceSequence) > highWater) {
				throw new Error(
					'Reporting aggregate source sequence exceeds seed high-water'
				);
			}
			if (!/^[0-9a-f]{64}$/.test(aggregate.stateHash)) {
				throw new Error('Reporting aggregate stateHash must be SHA-256');
			}
		}
	}

	private assertDecimal(
		value: string,
		path: string,
		allowZero: boolean
	): void {
		const pattern = allowZero
			? /^(0|[1-9][0-9]{0,18})$/
			: /^[1-9][0-9]{0,18}$/;
		if (!pattern.test(value)) {
			throw new Error(
				`${path} must be a valid PostgreSQL bigint decimal string`
			);
		}
		if (BigInt(value) > 9_223_372_036_854_775_807n) {
			throw new Error(
				`${path} must be a valid PostgreSQL bigint decimal string`
			);
		}
	}

	private assertIsoDate(value: string, path: string): void {
		if (
			Number.isNaN(Date.parse(value)) ||
			new Date(value).toISOString() !== value
		) {
			throw new Error(`${path} must be an ISO timestamp`);
		}
	}
}
