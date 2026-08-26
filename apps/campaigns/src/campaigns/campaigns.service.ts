import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	AudienceSnapshot,
	Campaign,
	CampaignControlActionKind,
	CampaignDelivery,
	CampaignDeliveryChannel,
	CampaignDeliveryStatus,
	CampaignRequestedChannel,
	CampaignStatus,
	Prisma
} from '@prisma/campaigns-client';
import {
	CampaignDeliveriesPageQueryDto,
	CampaignsPageQueryDto,
	CreateCampaignDto
} from './campaigns.dto';
import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import {
	createAdminAuditOutbox,
	createDeliveryOutbox,
	createSnapshotOutbox
} from '../messaging/campaigns-outbox.factory';
import type { CampaignDeliveryOutcomeEvent } from '../messaging/campaigns-event.contract';
import { createHash, randomUUID } from 'node:crypto';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TERMINAL_CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
	CampaignStatus.COMPLETED,
	CampaignStatus.PARTIAL_FAILED,
	CampaignStatus.FAILED,
	CampaignStatus.CANCELLED
];

type CampaignWithSnapshots = Campaign & {
	snapshots: AudienceSnapshot[];
};

@Injectable()
export class CampaignsService {
	constructor(private readonly prisma: CampaignsPrismaService) {}

	async create(
		actorId: string,
		idempotencyKey: string | undefined,
		dto: CreateCampaignDto
	) {
		const key = this.parseIdempotencyKey(idempotencyKey);
		const normalized = {
			subject: dto.subject.trim(),
			message: dto.message.trim(),
			audience: dto.audience,
			channel: dto.channel
		};
		const requestHash = this.hash(normalized);

		const campaignId = await this.prisma.$transaction(
			async transaction => {
				await this.lockIdempotency(
					transaction,
					'CAMPAIGN_CREATE',
					actorId,
					key
				);
				const existing =
					await transaction.campaignIdempotencyRecord.findUnique({
						where: {
							scope_actorId_key: {
								scope: 'CAMPAIGN_CREATE',
								actorId,
								key
							}
						}
					});
				if (existing) {
					this.assertSameIdempotentRequest(
						existing.requestHash,
						requestHash
					);
					return existing.resourceId;
				}
				const existingCampaign = await transaction.campaign.findUnique({
					where: {
						actorId_idempotencyKey: {
							actorId,
							idempotencyKey: key
						}
					}
				});
				if (existingCampaign) {
					this.assertSameIdempotentRequest(
						this.hash({
							subject: existingCampaign.subject.trim(),
							message: existingCampaign.message.trim(),
							audience: existingCampaign.audience,
							channel: existingCampaign.requestedChannel
						}),
						requestHash
					);
					await transaction.campaignIdempotencyRecord.create({
						data: {
							scope: 'CAMPAIGN_CREATE',
							actorId,
							key,
							requestHash,
							resourceType: 'campaign',
							resourceId: existingCampaign.id,
							expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS)
						}
					});
					return existingCampaign.id;
				}

				const campaign = await transaction.campaign.create({
					data: {
						actorId,
						idempotencyKey: key,
						subject: normalized.subject,
						message: normalized.message,
						audience: normalized.audience,
						requestedChannel: normalized.channel
					}
				});
				await transaction.audienceSnapshot.createMany({
					data: this.channelsFor(normalized.channel).map(channel => ({
						campaignId: campaign.id,
						channel,
						audience: normalized.audience
					}))
				});
				await transaction.campaignIdempotencyRecord.create({
					data: {
						scope: 'CAMPAIGN_CREATE',
						actorId,
						key,
						requestHash,
						resourceType: 'campaign',
						resourceId: campaign.id,
						expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS)
					}
				});
				await createSnapshotOutbox(transaction, campaign.id);
				await createAdminAuditOutbox(transaction, {
					correlationId: campaign.id,
					actorId,
					action: 'CAMPAIGN_CREATE',
					target: { campaignId: campaign.id },
					metadata: {
						channel: normalized.channel,
						audience:
							normalized.audience === 'ACTIVE_SUBSCRIPTION'
								? 'ACTIVE_SUBSCRIBERS'
								: 'ALL'
					},
					deduplicationKey: `campaign-audit:create:${campaign.id}`
				});
				return campaign.id;
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
		return this.get(campaignId);
	}

	async list(query: CampaignsPageQueryDto) {
		const where: Prisma.CampaignWhereInput = query.status
			? { status: query.status }
			: {};
		const [items, total] = await this.prisma.$transaction([
			this.prisma.campaign.findMany({
				where,
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
				skip: (query.page - 1) * query.limit,
				take: query.limit
			}),
			this.prisma.campaign.count({ where })
		]);
		return {
			items: items.map(campaign => this.toCampaignSummary(campaign)),
			total,
			page: query.page,
			limit: query.limit,
			totalPages: Math.ceil(total / query.limit)
		};
	}

	async get(id: string) {
		const campaign = await this.prisma.campaign.findUnique({
			where: { id },
			include: { snapshots: { orderBy: { channel: 'asc' } } }
		});
		if (!campaign) throw new NotFoundException('Campaign not found');
		return this.toCampaignDetail(campaign);
	}

	async cancel(id: string, actorId: string) {
		await this.prisma.$transaction(
			async transaction => {
				await this.lockAggregate(transaction, id);
				const campaign = await transaction.campaign.findUnique({
					where: { id }
				});
				if (!campaign) {
					throw new NotFoundException('Campaign not found');
				}
				if (TERMINAL_CAMPAIGN_STATUSES.includes(campaign.status)) {
					return;
				}

				const now = new Date();
				let cancelledCount = 0;
				let active = 0;
				if (campaign.status === CampaignStatus.SNAPSHOTTING) {
					await transaction.campaignDelivery.deleteMany({
						where: { campaignId: id }
					});
					await transaction.audienceSnapshot.updateMany({
						where: {
							campaignId: id,
							status: 'CREATING'
						},
						data: {
							status: 'CANCELLED',
							importToken: null,
							importLeaseExpiresAt: null,
							completedAt: now
						}
					});
				} else {
					const cancelled = await transaction.campaignDelivery.updateMany({
						where: {
							campaignId: id,
							status: CampaignDeliveryStatus.PENDING
						},
						data: {
							status: CampaignDeliveryStatus.CANCELLED,
							cancelledAt: now
						}
					});
					cancelledCount = cancelled.count;
					active = await transaction.campaignDelivery.count({
						where: {
							campaignId: id,
							status: {
								in: [
									CampaignDeliveryStatus.PENDING,
									CampaignDeliveryStatus.PROCESSING
								]
							}
						}
					});
				}
				const terminal = active === 0;
				await transaction.campaign.update({
					where: { id },
					data: {
						status: terminal
							? CampaignStatus.CANCELLED
							: CampaignStatus.CANCEL_REQUESTED,
						cancelRequestedAt: campaign.cancelRequestedAt || now,
						completedAt: terminal ? now : null,
						cancelledCount: {
							increment: cancelledCount
						}
					}
				});
				const actionId = randomUUID();
				await transaction.campaignControlAction.create({
					data: {
						id: actionId,
						campaignId: id,
						actorId,
						action: CampaignControlActionKind.CANCEL
					}
				});
				await createAdminAuditOutbox(transaction, {
					correlationId: id,
					actorId,
					action: 'CAMPAIGN_CANCEL',
					target: { campaignId: id },
					metadata: {
						recipientCount: campaign.recipientCount
					},
					deduplicationKey: `campaign-audit:cancel:${actionId}`
				});
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
		return this.get(id);
	}

	async listDeliveries(
		campaignId: string,
		query: CampaignDeliveriesPageQueryDto
	) {
		const exists = await this.prisma.campaign.findUnique({
			where: { id: campaignId },
			select: { id: true }
		});
		if (!exists) throw new NotFoundException('Campaign not found');

		const where: Prisma.CampaignDeliveryWhereInput = {
			campaignId,
			...(query.status ? { status: query.status } : {})
		};
		const [items, total] = await this.prisma.$transaction([
			this.prisma.campaignDelivery.findMany({
				where,
				orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
				skip: (query.page - 1) * query.limit,
				take: query.limit
			}),
			this.prisma.campaignDelivery.count({ where })
		]);
		return {
			items: items.map(delivery => this.toDelivery(delivery)),
			total,
			page: query.page,
			limit: query.limit,
			totalPages: Math.ceil(total / query.limit)
		};
	}

	async retryDelivery(
		campaignId: string,
		deliveryId: string,
		actorId: string,
		idempotencyKey: string | undefined
	) {
		const key = this.parseIdempotencyKey(idempotencyKey);
		const requestHash = this.hash({ campaignId, deliveryId });

		await this.prisma.$transaction(
			async transaction => {
				await this.lockIdempotency(
					transaction,
					'CAMPAIGN_DELIVERY_RETRY',
					actorId,
					key
				);
				const existing =
					await transaction.campaignIdempotencyRecord.findUnique({
						where: {
							scope_actorId_key: {
								scope: 'CAMPAIGN_DELIVERY_RETRY',
								actorId,
								key
							}
						}
					});
				if (existing) {
					this.assertSameIdempotentRequest(
						existing.requestHash,
						requestHash
					);
					return;
				}

				await this.lockAggregate(transaction, campaignId);
				await this.lockAggregate(transaction, deliveryId);
				const delivery = await transaction.campaignDelivery.findFirst({
					where: { id: deliveryId, campaignId },
					include: { campaign: true }
				});
				if (!delivery) {
					throw new NotFoundException('Campaign delivery not found');
				}
				if (delivery.status !== CampaignDeliveryStatus.FAILED) {
					throw new ConflictException(
						'Only failed delivery can be retried'
					);
				}
				if (
					delivery.campaign.status === CampaignStatus.CANCEL_REQUESTED ||
					delivery.campaign.status === CampaignStatus.CANCELLED
				) {
					throw new ConflictException(
						'Cancelled campaign delivery cannot be retried'
					);
				}

				const dispatchGeneration = delivery.dispatchGeneration + 1;
				const updated = await transaction.campaignDelivery.update({
					where: { id: delivery.id },
					data: {
						status: CampaignDeliveryStatus.PENDING,
						dispatchGeneration,
						requestEventId: null,
						lastOutcomeEventId: null,
						lastErrorCode: null,
						lastErrorReason: null,
						sentAt: null,
						cancelledAt: null
					}
				});
				await transaction.campaign.update({
					where: { id: campaignId },
					data: {
						status: CampaignStatus.QUEUED,
						failedCount: { decrement: 1 },
						completedAt: null
					}
				});
				await createDeliveryOutbox(
					transaction,
					delivery.campaign,
					updated
				);
				await transaction.campaignControlAction.create({
					data: {
						campaignId,
						deliveryId,
						actorId,
						action: CampaignControlActionKind.RETRY,
						idempotencyKey: key,
						dispatchGeneration
					}
				});
				await transaction.campaignIdempotencyRecord.create({
					data: {
						scope: 'CAMPAIGN_DELIVERY_RETRY',
						actorId,
						key,
						requestHash,
						resourceType: 'campaign-delivery',
						resourceId: deliveryId,
						expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS)
					}
				});
				await createAdminAuditOutbox(transaction, {
					correlationId: campaignId,
					actorId,
					action: 'CAMPAIGN_DELIVERY_RETRY',
					target: { campaignId, deliveryId },
					metadata: {
						channel: updated.channel,
						dispatchGeneration
					},
					deduplicationKey: `campaign-audit:retry:${actorId}:${key}`
				});
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
		const delivery = await this.prisma.campaignDelivery.findUnique({
			where: { id: deliveryId }
		});
		if (!delivery) {
			throw new NotFoundException('Campaign delivery not found');
		}
		return this.toDelivery(delivery);
	}

	async applyOutcome(
		outcome: CampaignDeliveryOutcomeEvent,
		receipt: {
			eventId: string;
			consumer: string;
			lockToken: string;
		}
	): Promise<void> {
		await this.prisma.$transaction(
			async transaction => {
				await this.lockAggregate(transaction, outcome.campaignId);
				await this.lockAggregate(transaction, outcome.deliveryId);
				const delivery = await transaction.campaignDelivery.findUnique({
					where: { id: outcome.deliveryId },
					include: { campaign: true }
				});
				const channelMatches =
					delivery &&
					((delivery.channel === CampaignDeliveryChannel.EMAIL &&
						outcome.sourceKind === 'campaign-email') ||
						(delivery.channel === CampaignDeliveryChannel.TELEGRAM &&
							outcome.sourceKind === 'campaign-telegram'));
				const current =
					delivery &&
					channelMatches &&
					delivery.campaignId === outcome.campaignId &&
					delivery.dispatchGeneration === outcome.dispatchGeneration &&
					delivery.requestEventId === outcome.sourceEventId &&
					delivery.status === CampaignDeliveryStatus.PROCESSING;

				if (current) {
					const delivered = outcome.status === 'DELIVERED';
					await transaction.campaignDelivery.update({
						where: { id: delivery.id },
						data: {
							status: delivered
								? CampaignDeliveryStatus.SENT
								: CampaignDeliveryStatus.FAILED,
							lastOutcomeEventId: outcome.eventId,
							lastErrorCode: delivered
								? null
								: outcome.failure?.normalizedCode,
							lastErrorReason: delivered
								? null
								: outcome.failure?.safeReason,
							sentAt: delivered ? new Date() : null
						}
					});
					await transaction.campaign.update({
						where: { id: delivery.campaignId },
						data: delivered
							? { sentCount: { increment: 1 } }
							: { failedCount: { increment: 1 } }
					});
					await this.finalizeCampaignIfTerminal(
						transaction,
						delivery.campaignId
					);
				}

				const finalized =
					await transaction.campaignConsumerReceipt.updateMany({
						where: {
							eventId: receipt.eventId,
							consumer: receipt.consumer,
							status: 'PROCESSING',
							lockToken: receipt.lockToken
						},
						data: {
							status: 'DELIVERED',
							deliveredAt: new Date(),
							lockedAt: null,
							lockedBy: null,
							lockToken: null,
							leaseExpiresAt: null,
							retryAttempt: null
						}
					});
				if (finalized.count !== 1) {
					throw new Error('Campaign outcome receipt claim was lost');
				}
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
	}

	async markReceiptDelivered(input: {
		eventId: string;
		consumer: string;
		lockToken: string;
	}): Promise<void> {
		const result = await this.prisma.campaignConsumerReceipt.updateMany({
			where: {
				eventId: input.eventId,
				consumer: input.consumer,
				status: 'PROCESSING',
				lockToken: input.lockToken
			},
			data: {
				status: 'DELIVERED',
				deliveredAt: new Date(),
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				retryAttempt: null
			}
		});
		if (result.count !== 1) {
			throw new Error('Campaign consumer receipt claim was lost');
		}
	}

	private async finalizeCampaignIfTerminal(
		transaction: Prisma.TransactionClient,
		campaignId: string
	): Promise<void> {
		const [campaign, active] = await Promise.all([
			transaction.campaign.findUnique({
				where: { id: campaignId }
			}),
			transaction.campaignDelivery.count({
				where: {
					campaignId,
					status: {
						in: [
							CampaignDeliveryStatus.PENDING,
							CampaignDeliveryStatus.PROCESSING
						]
					}
				}
			})
		]);
		if (!campaign || active > 0) return;
		const status =
			campaign.status === CampaignStatus.CANCEL_REQUESTED
				? CampaignStatus.CANCELLED
				: campaign.failedCount === 0
					? CampaignStatus.COMPLETED
					: campaign.sentCount > 0
						? CampaignStatus.PARTIAL_FAILED
						: CampaignStatus.FAILED;
		await transaction.campaign.update({
			where: { id: campaignId },
			data: {
				status,
				completedAt: new Date()
			}
		});
	}

	private channelsFor(
		channel: CampaignRequestedChannel
	): CampaignDeliveryChannel[] {
		if (channel === CampaignRequestedChannel.BOTH) {
			return [
				CampaignDeliveryChannel.EMAIL,
				CampaignDeliveryChannel.TELEGRAM
			];
		}
		return [
			channel === CampaignRequestedChannel.EMAIL
				? CampaignDeliveryChannel.EMAIL
				: CampaignDeliveryChannel.TELEGRAM
		];
	}

	private parseIdempotencyKey(value: string | undefined): string {
		const key = value?.trim() || '';
		if (!UUID_PATTERN.test(key)) {
			throw new BadRequestException(
				'Idempotency-Key header must be a UUID'
			);
		}
		return key;
	}

	private hash(value: unknown): string {
		return createHash('sha256')
			.update(JSON.stringify(value))
			.digest('hex');
	}

	private assertSameIdempotentRequest(
		existingHash: string,
		requestHash: string
	): void {
		if (existingHash !== requestHash) {
			throw new ConflictException(
				'Idempotency-Key was already used with a different request'
			);
		}
	}

	private lockIdempotency(
		transaction: Prisma.TransactionClient,
		scope: string,
		actorId: string,
		key: string
	): Promise<number> {
		return transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${`${scope}:${actorId}:${key}`}, 0)
			)
		`;
	}

	private lockAggregate(
		transaction: Prisma.TransactionClient,
		id: string
	): Promise<number> {
		return transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${`campaign-aggregate:${id}`}, 0)
			)
		`;
	}

	private toCampaignSummary(campaign: Campaign) {
		return {
			id: campaign.id,
			subject: campaign.subject,
			audience: campaign.audience,
			requestedChannel: campaign.requestedChannel,
			status: campaign.status,
			recipientCount: campaign.recipientCount,
			sentCount: campaign.sentCount,
			failedCount: campaign.failedCount,
			cancelledCount: campaign.cancelledCount,
			emailCount: campaign.emailCount,
			telegramCount: campaign.telegramCount,
			createdAt: campaign.createdAt,
			startedAt: campaign.startedAt,
			completedAt: campaign.completedAt,
			cancelRequestedAt: campaign.cancelRequestedAt
		};
	}

	private toCampaignDetail(campaign: CampaignWithSnapshots) {
		return {
			...this.toCampaignSummary(campaign),
			message: campaign.message,
			snapshots: campaign.snapshots.map(snapshot => ({
				id: snapshot.id,
				sourceSnapshotId: snapshot.sourceSnapshotId,
				channel: snapshot.channel,
				status: snapshot.status,
				recipientCount: snapshot.recipientCount,
				sha256: snapshot.sha256,
				asOf: snapshot.asOf,
				completedAt: snapshot.completedAt
			}))
		};
	}

	private toDelivery(delivery: CampaignDelivery) {
		return {
			id: delivery.id,
			campaignId: delivery.campaignId,
			channel: delivery.channel,
			status: delivery.status,
			dispatchGeneration: delivery.dispatchGeneration,
			attempts: delivery.attempts,
			failure:
				delivery.status === CampaignDeliveryStatus.FAILED
					? {
							code: delivery.lastErrorCode,
							reason: delivery.lastErrorReason
						}
					: null,
			createdAt: delivery.createdAt,
			sentAt: delivery.sentAt,
			cancelledAt: delivery.cancelledAt
		};
	}
}
