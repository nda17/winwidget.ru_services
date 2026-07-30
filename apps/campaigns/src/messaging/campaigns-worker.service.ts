import { AudienceSnapshotService } from '../campaigns/audience-snapshot.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import { CampaignsRuntimeService } from '../runtime/campaigns-runtime.service';
import {
	IncomingCampaignsEvent,
	InvalidCampaignsEventError,
	parseCampaignsMessage
} from './campaigns-event.contract';
import {
	CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE,
	CAMPAIGNS_CONSUMERS,
	CAMPAIGNS_RETRY_DELAYS_MS,
	CampaignsConsumerKind,
	getCampaignsDeadLetterRoutingKey,
	getCampaignsRetryRoutingKey
} from './campaigns-messaging.constants';
import { CampaignsRabbitMqService } from './campaigns-rabbitmq.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	CampaignConsumerReceiptStatus,
	CampaignOutboxExchange,
	Prisma
} from '@prisma/campaigns-client';
import type { ConsumeMessage } from 'amqplib';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const RECEIPT_LEASE_MS = 5 * 60 * 1000;
const RECEIPT_RENEW_INTERVAL_MS = 60_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;

type ReceiptClaim =
	| { state: 'claimed'; lockToken: string }
	| { state: 'done' }
	| { state: 'active'; leaseExpiresAt: Date };

@Injectable()
export class CampaignsWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(CampaignsWorkerService.name);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly activeHandlers = new Set<Promise<void>>();
	private ready = false;
	private shuttingDown = false;

	constructor(
		private readonly rabbitMq: CampaignsRabbitMqService,
		private readonly prisma: CampaignsPrismaService,
		private readonly campaigns: CampaignsService,
		private readonly audience: AudienceSnapshotService,
		private readonly runtime: CampaignsRuntimeService,
		private readonly config: ConfigService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		const prefetch = this.prefetch();
		await this.rabbitMq.consume(
			'snapshot',
			message => this.track(() => this.handle('snapshot', message)),
			prefetch
		);
		await this.rabbitMq.consume(
			'outcome',
			message => this.track(() => this.handle('outcome', message)),
			prefetch
		);
		this.ready = true;
	}

	isReady(): boolean {
		return (
			!this.runtime.workerEnabled || (this.ready && !this.shuttingDown)
		);
	}

	async beforeApplicationShutdown(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		this.ready = false;
		this.shuttingDown = true;
		await this.rabbitMq
			.cancelConsumers()
			.catch(error =>
				this.logger.error(
					`Could not cancel campaigns consumers: ${this.error(error)}`
				)
			);
		const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
		while (this.activeHandlers.size && Date.now() < deadline) {
			await Promise.allSettled([...this.activeHandlers]);
		}
	}

	private track(handler: () => Promise<void>): Promise<void> {
		const promise = handler();
		this.activeHandlers.add(promise);
		void promise.then(
			() => this.activeHandlers.delete(promise),
			() => this.activeHandlers.delete(promise)
		);
		return promise;
	}

	private async handle(
		kind: CampaignsConsumerKind,
		message: ConsumeMessage
	): Promise<void> {
		let parsed: ReturnType<typeof parseCampaignsMessage>;
		try {
			parsed = parseCampaignsMessage(kind, message);
		} catch (error) {
			await this.deadLetterMalformed(kind, message, error);
			return;
		}
		const payloadHash = createHash('sha256')
			.update(JSON.stringify(parsed.payload))
			.digest('hex');
		let claim: ReceiptClaim;
		try {
			claim = await this.claim(
				parsed.eventId,
				CAMPAIGNS_CONSUMERS[kind],
				payloadHash,
				parsed.retryAttempt
			);
		} catch (error) {
			this.logger.error(
				`Campaign event claim failed eventId=${parsed.eventId}: ${this.error(error)}`
			);
			this.rabbitMq.nack(message, true);
			return;
		}
		if (claim.state === 'done') {
			this.rabbitMq.ack(message);
			return;
		}
		if (claim.state === 'active') {
			try {
				await this.scheduleClaimRecovery(
					kind,
					parsed,
					claim.leaseExpiresAt
				);
				this.rabbitMq.ack(message);
			} catch (error) {
				this.logger.error(
					`Could not schedule claim recovery eventId=${parsed.eventId}: ${this.error(error)}`
				);
				this.rabbitMq.nack(message, true);
			}
			return;
		}

		const renewal = setInterval(
			() =>
				void this.renew(
					parsed.eventId,
					CAMPAIGNS_CONSUMERS[kind],
					claim.lockToken
				),
			RECEIPT_RENEW_INTERVAL_MS
		);
		renewal.unref();
		try {
			if (kind === 'snapshot') {
				const snapshotEvent = parsed.payload;
				if (snapshotEvent.eventType !== 'campaign.snapshot.requested.v1') {
					throw new InvalidCampaignsEventError(
						'Snapshot consumer received another event type'
					);
				}
				await this.audience.captureCampaign(snapshotEvent.campaignId);
				await this.campaigns.markReceiptDelivered({
					eventId: parsed.eventId,
					consumer: CAMPAIGNS_CONSUMERS[kind],
					lockToken: claim.lockToken
				});
			} else {
				const outcome = parsed.payload;
				if (outcome.eventType !== 'notification.delivery.outcome.v2') {
					throw new InvalidCampaignsEventError(
						'Outcome consumer received another event type'
					);
				}
				await this.campaigns.applyOutcome(outcome, {
					eventId: parsed.eventId,
					consumer: CAMPAIGNS_CONSUMERS[kind],
					lockToken: claim.lockToken
				});
			}
			this.rabbitMq.ack(message);
		} catch (error) {
			try {
				await this.finalizeFailure({
					kind,
					eventId: parsed.eventId,
					eventType: parsed.eventType,
					payload: parsed.payload,
					retryAttempt: parsed.retryAttempt,
					lockToken: claim.lockToken,
					error
				});
				this.rabbitMq.ack(message);
			} catch (finalizationError) {
				this.logger.error(
					`Campaign event failure finalization failed eventId=${parsed.eventId}: ${this.error(finalizationError)}`
				);
				this.rabbitMq.nack(message, true);
			}
		} finally {
			clearInterval(renewal);
		}
	}

	private async claim(
		eventId: string,
		consumer: string,
		payloadHash: string,
		retryAttempt: number
	): Promise<ReceiptClaim> {
		const now = new Date();
		const lockToken = randomUUID();
		const leaseExpiresAt = new Date(now.getTime() + RECEIPT_LEASE_MS);
		try {
			await this.prisma.campaignConsumerReceipt.create({
				data: {
					eventId,
					consumer,
					payloadHash,
					status: CampaignConsumerReceiptStatus.PROCESSING,
					lockedAt: now,
					lockedBy: this.workerId,
					lockToken,
					leaseExpiresAt
				}
			});
			return { state: 'claimed', lockToken };
		} catch (error) {
			if (!this.isUniqueViolation(error)) throw error;
		}
		const receipt = await this.prisma.campaignConsumerReceipt.findUnique({
			where: { eventId_consumer: { eventId, consumer } }
		});
		if (!receipt) throw new Error('Consumer receipt disappeared');
		if (receipt.payloadHash !== payloadHash) {
			throw new InvalidCampaignsEventError(
				'eventId was reused with another payload'
			);
		}
		if (
			receipt.status === CampaignConsumerReceiptStatus.DELIVERED ||
			receipt.status === CampaignConsumerReceiptStatus.DEAD_LETTERED
		) {
			return { state: 'done' };
		}
		const reclaimable =
			(receipt.status === CampaignConsumerReceiptStatus.RETRY_SCHEDULED &&
				(receipt.retryAttempt ?? -1) === retryAttempt) ||
			(receipt.status === CampaignConsumerReceiptStatus.PROCESSING &&
				receipt.leaseExpiresAt !== null &&
				receipt.leaseExpiresAt <= now);
		if (!reclaimable) {
			if (
				receipt.status === CampaignConsumerReceiptStatus.RETRY_SCHEDULED
			) {
				return { state: 'done' };
			}
			return {
				state: 'active',
				leaseExpiresAt:
					receipt.leaseExpiresAt ||
					new Date(now.getTime() + RECEIPT_LEASE_MS)
			};
		}
		const updated = await this.prisma.campaignConsumerReceipt.updateMany({
			where: {
				id: receipt.id,
				payloadHash,
				OR: [
					{
						status: CampaignConsumerReceiptStatus.RETRY_SCHEDULED,
						retryAttempt
					},
					{
						status: CampaignConsumerReceiptStatus.PROCESSING,
						leaseExpiresAt: { lte: now }
					}
				]
			},
			data: {
				status: CampaignConsumerReceiptStatus.PROCESSING,
				lockedAt: now,
				lockedBy: this.workerId,
				lockToken,
				leaseExpiresAt,
				retryAttempt: null
			}
		});
		return updated.count === 1
			? { state: 'claimed', lockToken }
			: {
					state: 'active',
					leaseExpiresAt
				};
	}

	private async scheduleClaimRecovery(
		kind: CampaignsConsumerKind,
		parsed: ReturnType<typeof parseCampaignsMessage>,
		leaseExpiresAt: Date
	): Promise<void> {
		const delay = CAMPAIGNS_RETRY_DELAYS_MS[0];
		const availableAt = new Date(
			Math.max(Date.now(), leaseExpiresAt.getTime() - delay + 1000)
		);
		await this.prisma.campaignOutboxEvent.createMany({
			data: [
				{
					messageId: parsed.eventId,
					deduplicationKey: `campaign-consumer:${kind}:${parsed.eventId}:claim-recovery:${leaseExpiresAt.toISOString()}`,
					exchange: CampaignOutboxExchange.RETRY,
					eventType: parsed.eventType,
					routingKey: getCampaignsRetryRoutingKey(kind, 0),
					payload: parsed.payload as unknown as Prisma.InputJsonObject,
					headers: {
						'x-retry-attempt': parsed.retryAttempt,
						'x-correlation-id': parsed.payload.correlationId,
						'x-causation-id': parsed.eventId
					},
					availableAt
				}
			],
			skipDuplicates: true
		});
	}

	private renew(
		eventId: string,
		consumer: string,
		lockToken: string
	): Promise<Prisma.BatchPayload> {
		const now = new Date();
		return this.prisma.campaignConsumerReceipt.updateMany({
			where: {
				eventId,
				consumer,
				status: CampaignConsumerReceiptStatus.PROCESSING,
				lockToken
			},
			data: {
				lockedAt: now,
				leaseExpiresAt: new Date(now.getTime() + RECEIPT_LEASE_MS)
			}
		});
	}

	private async finalizeFailure(input: {
		kind: CampaignsConsumerKind;
		eventId: string;
		eventType: string;
		payload: IncomingCampaignsEvent;
		retryAttempt: number;
		lockToken: string;
		error: unknown;
	}): Promise<void> {
		const nextAttempt = input.retryAttempt + 1;
		const permanent = input.error instanceof InvalidCampaignsEventError;
		if (!permanent && nextAttempt <= CAMPAIGNS_RETRY_DELAYS_MS.length) {
			await this.scheduleRetry(input, nextAttempt);
			return;
		}
		await this.moveToDeadLetter(input, nextAttempt);
	}

	private scheduleRetry(
		input: {
			kind: CampaignsConsumerKind;
			eventId: string;
			eventType: string;
			payload: IncomingCampaignsEvent;
			lockToken: string;
		},
		attempt: number
	): Promise<void> {
		return this.prisma.$transaction(async transaction => {
			const updated = await transaction.campaignConsumerReceipt.updateMany(
				{
					where: {
						eventId: input.eventId,
						consumer: CAMPAIGNS_CONSUMERS[input.kind],
						status: CampaignConsumerReceiptStatus.PROCESSING,
						lockToken: input.lockToken
					},
					data: {
						status: CampaignConsumerReceiptStatus.RETRY_SCHEDULED,
						retryAttempt: attempt,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null
					}
				}
			);
			if (updated.count !== 1) {
				throw new Error('Campaign receipt claim was lost');
			}
			await transaction.campaignOutboxEvent.create({
				data: {
					messageId: input.eventId,
					deduplicationKey: `campaign-consumer:${input.kind}:${input.eventId}:retry:${attempt}`,
					exchange: CampaignOutboxExchange.RETRY,
					eventType: input.eventType,
					routingKey: getCampaignsRetryRoutingKey(input.kind, attempt - 1),
					payload: input.payload as unknown as Prisma.InputJsonObject,
					headers: {
						'x-retry-attempt': attempt,
						'x-correlation-id': input.payload.correlationId,
						'x-causation-id': input.eventId
					}
				}
			});
		});
	}

	private moveToDeadLetter(
		input: {
			kind: CampaignsConsumerKind;
			eventId: string;
			eventType: string;
			payload: IncomingCampaignsEvent;
			lockToken: string;
			error: unknown;
		},
		attempt: number
	): Promise<void> {
		return this.prisma.$transaction(async transaction => {
			if (
				input.kind === 'snapshot' &&
				input.payload.eventType === CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE
			) {
				await this.audience.failCampaignInTransaction(
					transaction,
					input.payload.campaignId,
					'Audience snapshot could not be completed'
				);
			}
			const updated = await transaction.campaignConsumerReceipt.updateMany(
				{
					where: {
						eventId: input.eventId,
						consumer: CAMPAIGNS_CONSUMERS[input.kind],
						status: CampaignConsumerReceiptStatus.PROCESSING,
						lockToken: input.lockToken
					},
					data: {
						status: CampaignConsumerReceiptStatus.DEAD_LETTERED,
						retryAttempt: null,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null
					}
				}
			);
			if (updated.count !== 1) {
				throw new Error('Campaign receipt claim was lost');
			}
			await transaction.campaignOutboxEvent.create({
				data: {
					messageId: input.eventId,
					deduplicationKey: `campaign-consumer:${input.kind}:${input.eventId}:dead-letter`,
					exchange: CampaignOutboxExchange.DEAD_LETTER,
					eventType: input.eventType,
					routingKey: getCampaignsDeadLetterRoutingKey(input.kind),
					payload: input.payload as unknown as Prisma.InputJsonObject,
					headers: {
						'x-retry-attempt': attempt,
						'x-error-code':
							input.error instanceof InvalidCampaignsEventError
								? 'INVALID_EVENT_PAYLOAD'
								: 'CAMPAIGNS_PROCESSING_FAILED',
						'x-safe-reason': this.error(input.error).slice(0, 1000),
						'x-correlation-id': input.payload.correlationId
					}
				}
			});
		});
	}

	private async deadLetterMalformed(
		kind: CampaignsConsumerKind,
		message: ConsumeMessage,
		error: unknown
	): Promise<void> {
		const contentHash = createHash('sha256')
			.update(message.content)
			.digest('hex');
		const eventId = this.stableUuid(`${kind}:${contentHash}`);
		try {
			await this.prisma.campaignOutboxEvent.createMany({
				data: [
					{
						messageId: eventId,
						deduplicationKey: `campaign-malformed:${kind}:${contentHash}`,
						exchange: CampaignOutboxExchange.DEAD_LETTER,
						eventType: 'campaigns.invalid-event.v1',
						routingKey: getCampaignsDeadLetterRoutingKey(kind),
						payload: {
							malformed: true,
							kind,
							contentLength: message.content.length,
							contentSha256: contentHash
						},
						headers: {
							'x-error-code': 'INVALID_EVENT_PAYLOAD',
							'x-safe-reason': this.error(error).slice(0, 1000)
						}
					}
				],
				skipDuplicates: true
			});
			this.rabbitMq.ack(message);
		} catch (persistenceError) {
			this.logger.error(
				`Could not persist malformed event kind=${kind}: ${this.error(persistenceError)}`
			);
			this.rabbitMq.nack(message, true);
		}
	}

	private stableUuid(value: string): string {
		const hex = createHash('sha256').update(value).digest('hex');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
			13,
			16
		)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	}

	private isUniqueViolation(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}

	private prefetch(): number {
		const value = Number(
			this.config.get<string>('CAMPAIGNS_PREFETCH') || 10
		);
		if (!Number.isInteger(value) || value < 1 || value > 100) {
			throw new Error('CAMPAIGNS_PREFETCH must be between 1 and 100');
		}
		return value;
	}

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
