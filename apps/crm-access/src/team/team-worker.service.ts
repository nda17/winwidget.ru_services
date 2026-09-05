import {
	BeforeApplicationShutdown,
	Injectable,
	OnModuleInit
} from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { type CrmTeamDelivery } from '@prisma/crm-access-client';
import { createHash, randomUUID } from 'node:crypto';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { CrmAccessRuntimeService } from '../runtime/crm-access-runtime.service';
import { isUuidV4 } from '../internal/internal-http.config';
import {
	CrmTeamAdmissionService,
	type AcceptedInvitationEvent
} from './team-admission.service';
import { CrmTeamRabbitService } from './team-rabbit.service';
import {
	json,
	queueTeamDelivery,
	semanticHash,
	serializable,
	type TeamConsumer
} from './team.util';
import {
	parseTeamEvent,
	TEAM_CONSUMERS,
	TEAM_RETRY_DELAYS,
	teamRetryRoute,
	teamRoute,
	type TeamEvent
} from './team-messaging.contract';

// Four sequential HTTP phases are bounded at 60s each by internal client config.
export const TEAM_DELIVERY_LEASE_MS = 300_000;

@Injectable()
export class CrmTeamWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly active = new Set<Promise<void>>();
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly runtime: CrmAccessRuntimeService,
		private readonly rabbit: CrmTeamRabbitService,
		private readonly admissions: CrmTeamAdmissionService
	) {}
	async onModuleInit() {
		if (!this.runtime.workerEnabled) return;
		for (const consumer of TEAM_CONSUMERS)
			await this.rabbit.consume(consumer, message => {
				const work = this.handle(consumer, message);
				this.active.add(work);
				void work
					.finally(() => this.active.delete(work))
					.catch(() => undefined);
				return work;
			});
	}
	async beforeApplicationShutdown() {
		await this.rabbit.stopConsumers();
		await Promise.allSettled([...this.active]);
	}
	async handle(consumer: TeamConsumer, message: ConsumeMessage) {
		let event: TeamEvent;
		try {
			if (
				message.content.length > 32_768 ||
				message.properties.contentType !== 'application/json'
			)
				throw new Error('INVALID_EVENT');
			event = parseTeamEvent(
				JSON.parse(message.content.toString('utf8')),
				consumer
			);
			const original = message.properties.headers?.['x-original-event-id'];
			if (
				!isUuidV4(message.properties.messageId) ||
				(original !== undefined
					? original !== event.eventId
					: message.properties.messageId !== event.eventId) ||
				(message.properties.type !== undefined &&
					message.properties.type !== event.eventType)
			)
				throw new Error('INVALID_EVENT');
		} catch {
			await this.quarantine(consumer, message);
			this.rabbit.ack(message);
			return;
		}
		const claimed = await this.claim(consumer, event, message);
		if (claimed === 'CONFLICT') {
			await this.quarantine(consumer, message);
			this.rabbit.ack(message);
			return;
		}
		if (!claimed) {
			this.rabbit.ack(message);
			return;
		}
		try {
			if (consumer === 'provision')
				await this.admissions.provision(
					event.workspaceId,
					event.invitationId!
				);
			else if (consumer === 'acceptance')
				await this.admissions.accept(event as AcceptedInvitationEvent);
			else await this.admissions.admitNext(event.workspaceId);
			const changed = await this.prisma.crmTeamDelivery.updateMany({
				where: {
					id: claimed.id,
					status: 'PROCESSING',
					leaseToken: claimed.leaseToken
				},
				data: {
					status: 'DELIVERED',
					deliveredAt: new Date(),
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: null,
					version: { increment: 1 }
				}
			});
			if (changed.count !== 1) throw new Error('DELIVERY_LEASE_LOST');
		} catch {
			await this.failed(claimed);
		}
		this.rabbit.ack(message);
	}
	private async claim(
		consumer: TeamConsumer,
		event: TeamEvent,
		message: ConsumeMessage
	): Promise<CrmTeamDelivery | 'CONFLICT' | null> {
		return serializable(this.prisma, async tx => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wincrm-team-delivery:${consumer}:${event.eventId}`}, 0))`;
			const where = {
				eventId_consumer: { eventId: event.eventId, consumer }
			};
			const prior = await tx.crmTeamDelivery.findUnique({ where });
			const payloadHash = semanticHash(event);
			const token = randomUUID();
			const now = new Date();
			if (!prior)
				return tx.crmTeamDelivery.create({
					data: {
						eventId: event.eventId,
						consumer,
						workspaceId: event.workspaceId,
						payloadHash,
						payload: json(event),
						leaseToken: token,
						leaseExpiresAt: new Date(
							now.getTime() + TEAM_DELIVERY_LEASE_MS
						)
					}
				});
			if (
				prior.payloadHash !== payloadHash ||
				prior.workspaceId !== event.workspaceId
			)
				return 'CONFLICT';
			if (['DELIVERED', 'DEAD_LETTERED'].includes(prior.status))
				return null;
			if (
				prior.status === 'PROCESSING' &&
				prior.leaseExpiresAt &&
				prior.leaseExpiresAt > now
			) {
				// Retain a durable wake for an unacknowledged redelivery even if its original worker dies.
				await queueTeamDelivery(tx, prior, {
					deduplicationKey: `busy:${prior.id}:${prior.leaseToken}`,
					exchange: 'winwidget.manual-retry',
					routingKey: teamRoute(consumer),
					availableAt: prior.leaseExpiresAt
				});
				return null;
			}
			if (
				prior.status === 'RETRY_SCHEDULED' &&
				(message.properties.headers?.['x-delivery-token'] !==
					prior.leaseToken ||
					message.properties.headers?.['x-manual-retry-cycle'] !==
						prior.manualRetryCycle ||
					message.properties.headers?.['x-retry-attempt'] !==
						prior.retryAttempt)
			)
				return null;
			const changed = await tx.crmTeamDelivery.updateMany({
				where: {
					id: prior.id,
					version: prior.version,
					status: prior.status,
					leaseToken: prior.leaseToken
				},
				data: {
					status: 'PROCESSING',
					leaseToken: token,
					leaseExpiresAt: new Date(now.getTime() + TEAM_DELIVERY_LEASE_MS),
					version: { increment: 1 }
				}
			});
			if (changed.count !== 1) throw new Error('DELIVERY_CLAIM_CONFLICT');
			return tx.crmTeamDelivery.findUniqueOrThrow({
				where: { id: prior.id }
			});
		});
	}
	private async failed(claimed: CrmTeamDelivery) {
		await serializable(this.prisma, async tx => {
			const token = randomUUID();
			const retry = claimed.retryAttempt < TEAM_RETRY_DELAYS.length;
			const changed = await tx.crmTeamDelivery.updateMany({
				where: {
					id: claimed.id,
					status: 'PROCESSING',
					leaseToken: claimed.leaseToken
				},
				data: {
					status: retry ? 'RETRY_SCHEDULED' : 'DEAD_LETTERED',
					leaseToken: retry ? token : null,
					leaseExpiresAt: null,
					retryAttempt: { increment: retry ? 1 : 0 },
					lastError: 'TEAM_OPERATION_FAILED',
					version: { increment: 1 }
				}
			});
			if (changed.count !== 1) {
				const current = await tx.crmTeamDelivery.findUniqueOrThrow({
					where: { id: claimed.id }
				});
				if (current.status === 'PROCESSING')
					await queueTeamDelivery(tx, current, {
						deduplicationKey: `busy:${current.id}:${current.leaseToken}`,
						exchange: 'winwidget.manual-retry',
						routingKey: teamRoute(current.consumer as TeamConsumer),
						availableAt: current.leaseExpiresAt ?? new Date()
					});
				return;
			}
			const receipt = await tx.crmTeamDelivery.findUniqueOrThrow({
				where: { id: claimed.id }
			});
			await queueTeamDelivery(tx, receipt, {
				deduplicationKey: `retry:${receipt.id}:${receipt.manualRetryCycle}:${receipt.retryAttempt}:${receipt.status}`,
				exchange: retry ? 'winwidget.retry' : 'winwidget.dead-letter',
				routingKey: retry
					? teamRetryRoute(
							receipt.consumer as TeamConsumer,
							receipt.retryAttempt
						)
					: `${teamRoute(receipt.consumer as TeamConsumer)}.dead-letter`,
				...(retry ? { token } : {})
			});
		});
	}
	private async quarantine(
		consumer: TeamConsumer,
		message: ConsumeMessage
	) {
		const payloadHash = createHash('sha256')
			.update(message.content)
			.digest('hex');
		const raw = createHash('sha256')
			.update(
				`${consumer}:${message.properties.messageId ?? ''}:${payloadHash}`
			)
			.digest('hex');
		const eventId = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
		await serializable(this.prisma, async tx => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wincrm-team-poison:${consumer}:${eventId}`}, 0))`;
			if (
				await tx.crmTeamDelivery.findUnique({
					where: { eventId_consumer: { eventId, consumer } }
				})
			)
				return;
			const receipt = await tx.crmTeamDelivery.create({
				data: {
					eventId,
					consumer,
					payloadHash,
					status: 'DEAD_LETTERED',
					lastError: 'INVALID_EVENT',
					payload: {
						schemaVersion: 1,
						eventId,
						eventType: 'crm.access.invalid-envelope.v1',
						reason: 'INVALID_EVENT',
						payloadHash
					}
				}
			});
			await queueTeamDelivery(tx, receipt, {
				deduplicationKey: `poison:${consumer}:${eventId}`,
				exchange: 'winwidget.dead-letter',
				routingKey: `${teamRoute(consumer)}.dead-letter`
			});
		});
	}
}
