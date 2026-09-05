import {
	ConflictException,
	ForbiddenException,
	HttpException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	ManagedWidgetSource,
	Prisma,
	WidgetTransferReceipt
} from '@prisma/crm-intake-client';
import { isEmail } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { IntakeAuthorizationClient } from '../access/intake-authorization.client';
import {
	TRANSFER_CONSUMER,
	TRANSFER_RETRY_MS,
	TransferEvent,
	transferHash
} from './widget-transfer.contract';
import {
	WidgetTransferClient,
	WidgetTransferDependencyError
} from './widget-transfer.client';

export const transferJson = (value: unknown) =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
export const TRANSFER_STATUSES = [
	'PROCESSING',
	'RETRY_PENDING',
	'BLOCKED',
	'ERROR',
	'DELIVERED',
	'SKIPPED'
] as const;
export const TRANSFER_CODES = [
	'DELEGATION_REVOKED',
	'OWNER_CHANGED',
	'LOCAL_DISABLED',
	'GENERATION_CHANGED',
	'PERIOD_EXPIRED',
	'BILLING_INELIGIBLE',
	'BILLING_PERIOD_CHANGED',
	'CONNECTOR_DISABLED',
	'WIDGET_UNAVAILABLE',
	'LEAD_UNAVAILABLE',
	'PAYLOAD_TOO_LARGE',
	'PAYLOAD_SHAPE_UNSUPPORTED',
	'TEXT_UNSUPPORTED',
	'SOURCE_PERIOD_INELIGIBLE',
	'SOURCE_PERIOD_INVALID',
	'BEFORE_ACTIVATION',
	'DEPENDENCY_UNAVAILABLE',
	'INVALID_RESPONSE',
	'CONTEXT_UNAVAILABLE'
] as const;
export class TransferOutcome extends Error {
	constructor(
		readonly state: 'SKIPPED' | 'BLOCKED',
		readonly code: string
	) {
		super(code);
	}
}
export async function transferConstraints(tx: Prisma.TransactionClient) {
	await tx.$executeRawUnsafe(
		'SET CONSTRAINTS crm_intake.widget_transfer_receipts_entry_fkey, crm_intake.widget_transfer_receipts_integrity, crm_intake.widget_entry_snapshots_integrity, crm_intake.inbox_widget_integrity IMMEDIATE'
	);
}
export function transferOutbox(
	event: TransferEvent,
	generation: number,
	attempt: number,
	route: string
) {
	return {
		eventId: event.eventId,
		deduplicationKey: `${event.eventId}:${generation}:${route}:${attempt}`,
		payload: transferJson(event),
		route,
		retryAttempt: attempt,
		retryGeneration: generation
	};
}
export function transferView(row: WidgetTransferReceipt) {
	return {
		id: row.transferId,
		workspaceId: row.workspaceId,
		sourceId: row.sourceId,
		state: row.status,
		version: row.version,
		reason: row.lastErrorCode,
		entryId: row.entryId,
		occurredAt: (row.event as unknown as TransferEvent).occurredAt,
		receivedAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		completedAt: row.completedAt?.toISOString() ?? null
	};
}
@Injectable()
export class WidgetTransferProcessor {
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly authorization: IntakeAuthorizationClient,
		private readonly widgets: WidgetTransferClient
	) {}
	private async transaction<T>(
		callback: (tx: Prisma.TransactionClient) => Promise<T>
	): Promise<T> {
		return this.prisma.$transaction(
			async tx => {
				await tx.$executeRawUnsafe("SET LOCAL lock_timeout='1000ms'");
				await tx.$executeRawUnsafe("SET LOCAL statement_timeout='3500ms'");
				const result = await callback(tx);
				await transferConstraints(tx);
				return result;
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 1500,
				timeout: 5000
			}
		);
	}
	private binding(row: WidgetTransferReceipt, event: TransferEvent) {
		if (
			row.payloadHash !== transferHash(event) ||
			row.transferId !== event.transferId ||
			row.workspaceId !== event.workspaceId ||
			row.sourceId !== event.sourceId ||
			row.connectorId !== event.connectorId ||
			row.generation !== event.generation
		)
			throw new ConflictException('Widget transfer binding mismatch');
	}
	private sourceBinding(
		source: ManagedWidgetSource | null,
		event: TransferEvent
	) {
		if (
			!source ||
			source.workspaceId !== event.workspaceId ||
			source.connectorId !== event.connectorId
		)
			throw new ConflictException('Widget transfer source unavailable');
		return source;
	}
	private fence(source: ManagedWidgetSource, event: TransferEvent) {
		if (!source.enabled)
			throw new TransferOutcome('SKIPPED', 'LOCAL_DISABLED');
		if (source.generation !== event.generation)
			throw new TransferOutcome('SKIPPED', 'GENERATION_CHANGED');
		if (
			event.originalDeadline &&
			Date.parse(event.originalDeadline) <= Date.now()
		)
			throw new TransferOutcome('SKIPPED', 'PERIOD_EXPIRED');
	}
	async claim(
		event: TransferEvent,
		retryAttempt = 0,
		retryGeneration = 0
	): Promise<{ state: 'DONE' } | { state: 'CLAIMED'; token: string }> {
		return this.transaction(async tx => {
			const source = this.sourceBinding(
				await tx.managedWidgetSource.findUnique({
					where: { id: event.sourceId }
				}),
				event
			);
			const key = {
				eventId_consumer: {
					eventId: event.eventId,
					consumer: TRANSFER_CONSUMER
				}
			};
			const prior = await tx.widgetTransferReceipt.findUnique({
				where: key
			});
			if (!prior) {
				const existingTransfer = await tx.widgetTransferReceipt.findUnique(
					{
						where: {
							transferId_consumer: {
								transferId: event.transferId,
								consumer: TRANSFER_CONSUMER
							}
						}
					}
				);
				if (existingTransfer)
					throw new ConflictException('Widget transfer event mismatch');
			}
			if (prior) {
				this.binding(prior, event);
				if (
					['DELIVERED', 'SKIPPED'].includes(prior.status) ||
					retryGeneration < prior.retryGeneration ||
					(retryGeneration === prior.retryGeneration &&
						retryAttempt < prior.retryAttempt)
				)
					return { state: 'DONE' };
				if (
					retryGeneration !== prior.retryGeneration ||
					retryAttempt !== prior.retryAttempt
				)
					throw new ConflictException('Widget retry sequence mismatch');
				if (['BLOCKED', 'ERROR'].includes(prior.status))
					return { state: 'DONE' };
				if (
					prior.status === 'PROCESSING' &&
					prior.leaseUntil &&
					prior.leaseUntil > new Date()
				)
					throw new ServiceUnavailableException('Widget transfer leased');
			} else if (retryAttempt !== 0 || retryGeneration !== 0)
				throw new ConflictException('Unknown widget retry');
			const token = randomUUID(),
				until = new Date(Date.now() + 30000);
			if (prior) {
				const changed = await tx.widgetTransferReceipt.updateMany({
					where: {
						...key.eventId_consumer,
						version: prior.version,
						OR: [
							{ status: 'RETRY_PENDING' },
							{ status: 'PROCESSING', leaseUntil: { lte: new Date() } }
						]
					},
					data: {
						status: 'PROCESSING',
						leaseToken: token,
						leaseUntil: until,
						version: { increment: 1 }
					}
				});
				if (changed.count !== 1)
					throw new ServiceUnavailableException(
						'Widget transfer claim changed'
					);
			} else
				await tx.widgetTransferReceipt.create({
					data: {
						...key.eventId_consumer,
						transferId: event.transferId,
						workspaceId: event.workspaceId,
						sourceId: event.sourceId,
						connectorId: event.connectorId,
						generation: event.generation,
						actorSubject: source.createdBySubject,
						ownerSubject: source.ownerSubject,
						teamId: source.teamId,
						event: transferJson(event),
						payloadHash: transferHash(event),
						originalDeadline: event.originalDeadline
							? new Date(event.originalDeadline)
							: null,
						status: 'PROCESSING',
						leaseToken: token,
						leaseUntil: until
					}
				});
			return { state: 'CLAIMED', token };
		});
	}
	private async current(event: TransferEvent, token: string) {
		const row = await this.prisma.widgetTransferReceipt.findFirst({
			where: {
				eventId: event.eventId,
				consumer: TRANSFER_CONSUMER,
				status: 'PROCESSING',
				leaseToken: token,
				leaseUntil: { gt: new Date() }
			}
		});
		if (!row) throw new ConflictException('Widget transfer lease lost');
		this.binding(row, event);
		return row;
	}
	async renew(event: TransferEvent, token: string) {
		const changed = await this.transaction(tx =>
			tx.widgetTransferReceipt.updateMany({
				where: {
					eventId: event.eventId,
					consumer: TRANSFER_CONSUMER,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: new Date() }
				},
				data: {
					leaseUntil: new Date(Date.now() + 30000),
					version: { increment: 1 }
				}
			})
		);
		return changed.count === 1;
	}
	private async authority(row: WidgetTransferReceipt) {
		const context = await this.authorization.authorizeWidgetSource(
			row.workspaceId,
			row.actorSubject
		);
		if (context.ownerSubject !== row.ownerSubject)
			throw new TransferOutcome('BLOCKED', 'OWNER_CHANGED');
		if (row.teamId && !context.teamIds.includes(row.teamId))
			throw new TransferOutcome('BLOCKED', 'DELEGATION_REVOKED');
		return context;
	}
	async run(event: TransferEvent, token: string) {
		const receipt = await this.current(event, token);
		const source = this.sourceBinding(
			await this.prisma.managedWidgetSource.findUnique({
				where: { id: event.sourceId }
			}),
			event
		);
		this.fence(source, event);
		await this.authority(receipt);
		await this.current(event, token);
		this.fence(
			this.sourceBinding(
				await this.prisma.managedWidgetSource.findUnique({
					where: { id: event.sourceId }
				}),
				event
			),
			event
		);
		const context = await this.widgets.context(event, source);
		if (!context.deliver)
			throw new TransferOutcome(
				['BILLING_INELIGIBLE', 'WIDGET_UNAVAILABLE'].includes(
					context.reason
				)
					? 'BLOCKED'
					: 'SKIPPED',
				context.reason
			);
		// This is a new business write: recheck CRM authority after the bounded Widgets call.
		await this.authority(receipt);
		const payload = context.payload!;
		const title: { [key: string]: string } = {
			WHEEL: 'Колесо фортуны',
			QUIZ: 'Квиз',
			CALLBACK: 'Обратный звонок',
			TIMER: 'Таймер',
			STOP_OFFER: 'Стоп-оффер',
			CALCULATOR: 'Калькулятор'
		};
		await this.transaction(async tx => {
			await tx.$queryRaw`SELECT id FROM crm_intake.managed_widget_sources WHERE id=${source.id}::uuid FOR UPDATE`;
			const fresh = this.sourceBinding(
				await tx.managedWidgetSource.findUnique({
					where: { id: source.id }
				}),
				event
			);
			this.fence(fresh, event);
			const [clock] = await tx.$queryRaw<
				Array<{ now: Date }>
			>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
			if (
				!clock ||
				Date.parse(context.validUntil) <=
					Math.max(Date.now(), clock.now.getTime()) ||
				!event.originalDeadline ||
				Date.parse(event.originalDeadline) <=
					Math.max(Date.now(), clock.now.getTime())
			)
				throw new ServiceUnavailableException(
					'Widget context expired before commit'
				);
			const entryId = randomUUID(),
				auditCommandId = randomUUID();
			const email = payload.lead.email?.trim() || null;
			await tx.inboxEntry.create({
				data: {
					id: entryId,
					workspaceId: event.workspaceId,
					widgetSourceId: source.id,
					sourceId: null,
					origin: 'WIDGET',
					title: 'Заявка: ' + title[source.widgetType],
					name: payload.lead.contactName?.trim() || null,
					phone: payload.lead.phoneE164,
					email: email && isEmail(email) ? email.toLowerCase() : null,
					message: null,
					createdBySubject: receipt.actorSubject,
					teamId: receipt.teamId,
					receivedAt: clock.now
				}
			});
			await tx.widgetEntrySnapshot.create({
				data: {
					entryId,
					workspaceId: event.workspaceId,
					sourceId: source.id,
					transferId: event.transferId,
					eventId: event.eventId,
					payload: transferJson(payload),
					payloadHash: transferHash(payload),
					byteCount: Buffer.byteLength(JSON.stringify(payload), 'utf8')
				}
			});
			await tx.intakeActivity.create({
				data: {
					workspaceId: event.workspaceId,
					entityId: entryId,
					entityKind: 'entry',
					commandId: auditCommandId,
					actorSubject: receipt.actorSubject,
					action: 'CREATED',
					entityVersion: 1
				}
			});
			const [finish] = await tx.$queryRaw<
				Array<{ now: Date }>
			>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
			if (
				!finish ||
				Math.max(Date.now(), finish.now.getTime()) >=
					Math.min(
						Date.parse(context.validUntil),
						Date.parse(event.originalDeadline)
					)
			)
				throw new ServiceUnavailableException(
					'Widget context expired during transaction'
				);
			const changed = await tx.widgetTransferReceipt.updateMany({
				where: {
					eventId: event.eventId,
					consumer: TRANSFER_CONSUMER,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: finish.now }
				},
				data: {
					status: 'DELIVERED',
					entryId,
					auditCommandId,
					lastErrorCode: null,
					leaseToken: null,
					leaseUntil: null,
					completedAt: clock.now,
					version: { increment: 1 }
				}
			});
			if (changed.count !== 1)
				throw new ConflictException(
					'Widget transfer completion lease lost'
				);
		});
	}
	async fail(
		event: TransferEvent,
		token: string,
		retryAttempt: number,
		error: unknown
	): Promise<boolean> {
		let state: 'SKIPPED' | 'BLOCKED' | 'ERROR' | 'RETRY_PENDING' = 'ERROR',
			code = 'DEPENDENCY_UNAVAILABLE';
		if (error instanceof TransferOutcome) {
			state = error.state;
			code = error.code;
		} else if (error instanceof ForbiddenException) {
			state = 'BLOCKED';
			code = 'DELEGATION_REVOKED';
		} else if (error instanceof WidgetTransferDependencyError) {
			code = error.code;
			if (error.status === 404) state = 'BLOCKED';
		} else if (
			error instanceof HttpException &&
			error.getStatus() === 403
		) {
			state = 'BLOCKED';
			code = 'DELEGATION_REVOKED';
		}
		if (state === 'ERROR' && retryAttempt < TRANSFER_RETRY_MS.length)
			state = 'RETRY_PENDING';
		if (!TRANSFER_CODES.includes(code as (typeof TRANSFER_CODES)[number]))
			code = 'INVALID_RESPONSE';
		return this.transaction(async tx => {
			const row = await tx.widgetTransferReceipt.findFirst({
				where: {
					eventId: event.eventId,
					consumer: TRANSFER_CONSUMER,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: new Date() }
				}
			});
			if (!row) return false;
			const changed = await tx.widgetTransferReceipt.updateMany({
				where: {
					eventId: event.eventId,
					consumer: TRANSFER_CONSUMER,
					version: row.version,
					leaseToken: token,
					status: 'PROCESSING'
				},
				data: {
					status: state,
					leaseToken: null,
					leaseUntil: null,
					lastErrorCode: code,
					retryAttempt:
						state === 'RETRY_PENDING' ? retryAttempt + 1 : retryAttempt,
					completedAt: state === 'SKIPPED' ? new Date() : null,
					version: { increment: 1 }
				}
			});
			if (changed.count !== 1) return false;
			if (state !== 'SKIPPED') {
				const [clock] = await tx.$queryRaw<
					Array<{ now: Date }>
				>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
				if (!clock || !Number.isFinite(clock.now.getTime()))
					throw new ServiceUnavailableException(
						'Widget retry clock unavailable'
					);
				await tx.widgetTransferOutbox.create({
					data: {
						...transferOutbox(
							event,
							row.retryGeneration,
							state === 'RETRY_PENDING' ? retryAttempt + 1 : retryAttempt,
							state === 'RETRY_PENDING' ? 'MAIN' : 'DLQ'
						),
						// The delay belongs to durable PostgreSQL state, not a lossy broker TTL relay.
						availableAt: new Date(
							clock.now.getTime() +
								(state === 'RETRY_PENDING'
									? TRANSFER_RETRY_MS[retryAttempt]
									: 0)
						),
						lastErrorCode: code
					}
				});
			}
			return true;
		});
	}
}
