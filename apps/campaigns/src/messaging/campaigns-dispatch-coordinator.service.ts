import {
	CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE,
	CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE
} from './campaigns-messaging.constants';
import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	CampaignDeliveryChannel,
	CampaignDeliveryStatus,
	CampaignOutboxEvent,
	CampaignOutboxStatus,
	CampaignStatus,
	Prisma
} from '@prisma/campaigns-client';

export type ClaimedCampaignOutboxEvent = CampaignOutboxEvent & {
	lockToken: string;
};

@Injectable()
export class CampaignsDispatchCoordinatorService {
	constructor(
		private readonly prisma: CampaignsPrismaService,
		private readonly config: ConfigService
	) {}

	async prepareDispatch(
		event: ClaimedCampaignOutboxEvent,
		workerId: string
	): Promise<boolean> {
		const isDeliveryRequest =
			event.aggregateType === 'campaign-delivery' &&
			(event.eventType === CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE ||
				event.eventType === CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE);
		if (!isDeliveryRequest || !event.aggregateId || !event.generation) {
			return true;
		}
		const aggregateId = event.aggregateId;
		const generation = event.generation;
		return this.prisma.$transaction(
			async transaction => {
				const identity = await transaction.campaignDelivery.findUnique({
					where: { id: aggregateId },
					select: { campaignId: true }
				});
				if (!identity) {
					await this.cancelEvent(
						transaction,
						event,
						workerId,
						'UNKNOWN_CAMPAIGN_DELIVERY'
					);
					return false;
				}
				await transaction.$executeRaw`
					SELECT pg_advisory_xact_lock(
						hashtextextended(
							${`campaign-aggregate:${identity.campaignId}`},
							0
						)
					)
				`;
				await transaction.$executeRaw`
					SELECT pg_advisory_xact_lock(
						hashtextextended(
							${`campaign-aggregate:${aggregateId}`},
							0
						)
					)
				`;
				const delivery = await transaction.campaignDelivery.findUnique({
					where: { id: aggregateId },
					include: { campaign: true }
				});
				if (
					!delivery ||
					delivery.dispatchGeneration !== generation ||
					delivery.requestEventId !== event.messageId
				) {
					await this.cancelEvent(
						transaction,
						event,
						workerId,
						'STALE_CAMPAIGN_DELIVERY_REQUEST'
					);
					return false;
				}
				if (delivery.status === CampaignDeliveryStatus.PROCESSING) {
					return true;
				}
				if (delivery.status !== CampaignDeliveryStatus.PENDING) {
					await this.cancelEvent(
						transaction,
						event,
						workerId,
						'TERMINAL_CAMPAIGN_DELIVERY'
					);
					return false;
				}
				if (
					delivery.campaign.status === CampaignStatus.CANCEL_REQUESTED ||
					delivery.campaign.status === CampaignStatus.CANCELLED
				) {
					await transaction.campaignDelivery.update({
						where: { id: delivery.id },
						data: {
							status: CampaignDeliveryStatus.CANCELLED,
							cancelledAt: new Date()
						}
					});
					await transaction.campaign.update({
						where: { id: delivery.campaignId },
						data: {
							cancelledCount: { increment: 1 }
						}
					});
					await this.cancelEvent(
						transaction,
						event,
						workerId,
						'CAMPAIGN_CANCEL_REQUESTED'
					);
					await this.finalizeCancellation(
						transaction,
						delivery.campaignId
					);
					return false;
				}
				if (delivery.campaign.status === CampaignStatus.SNAPSHOTTING) {
					await transaction.campaignOutboxEvent.updateMany({
						where: {
							id: event.id,
							status: CampaignOutboxStatus.PUBLISHING,
							lockedBy: workerId,
							lockToken: event.lockToken
						},
						data: {
							status: CampaignOutboxStatus.PENDING,
							availableAt: new Date(Date.now() + 1000),
							lockedAt: null,
							lockedBy: null,
							lockToken: null,
							leaseExpiresAt: null
						}
					});
					return false;
				}
				if (
					delivery.campaign.status !== CampaignStatus.QUEUED &&
					delivery.campaign.status !== CampaignStatus.RUNNING
				) {
					await this.cancelEvent(
						transaction,
						event,
						workerId,
						'CAMPAIGN_NOT_DISPATCHABLE'
					);
					return false;
				}
				const delay = await this.acquireRateSlot(
					transaction,
					delivery.campaignId,
					delivery.channel
				);
				if (delay > 0) {
					await transaction.campaignOutboxEvent.updateMany({
						where: {
							id: event.id,
							status: CampaignOutboxStatus.PUBLISHING,
							lockedBy: workerId,
							lockToken: event.lockToken
						},
						data: {
							status: CampaignOutboxStatus.PENDING,
							availableAt: new Date(Date.now() + delay),
							lockedAt: null,
							lockedBy: null,
							lockToken: null,
							leaseExpiresAt: null
						}
					});
					return false;
				}
				await transaction.campaignDelivery.update({
					where: { id: delivery.id },
					data: {
						status: CampaignDeliveryStatus.PROCESSING,
						attempts: { increment: 1 }
					}
				});
				await transaction.campaign.updateMany({
					where: {
						id: delivery.campaignId,
						status: CampaignStatus.QUEUED
					},
					data: {
						status: CampaignStatus.RUNNING,
						startedAt: delivery.campaign.startedAt || new Date()
					}
				});
				return true;
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
	}

	async quarantineInvalidContract(
		event: ClaimedCampaignOutboxEvent,
		workerId: string,
		reason: string
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			if (
				event.aggregateType === 'campaign-delivery' &&
				event.aggregateId &&
				event.generation
			) {
				const identity = await transaction.campaignDelivery.findUnique({
					where: { id: event.aggregateId },
					select: { campaignId: true }
				});
				if (identity) {
					await transaction.$executeRaw`
						SELECT pg_advisory_xact_lock(
							hashtextextended(
								${`campaign-aggregate:${identity.campaignId}`},
								0
							)
						)
					`;
					const delivery = await transaction.campaignDelivery.findUnique({
						where: { id: event.aggregateId },
						include: { campaign: true }
					});
					if (
						delivery &&
						delivery.dispatchGeneration === event.generation &&
						delivery.requestEventId === event.messageId &&
						(delivery.status === CampaignDeliveryStatus.PENDING ||
							delivery.status === CampaignDeliveryStatus.PROCESSING)
					) {
						await transaction.campaignDelivery.update({
							where: { id: delivery.id },
							data: {
								status: CampaignDeliveryStatus.FAILED,
								lastErrorCode: 'INVALID_OUTBOX_CONTRACT',
								lastErrorReason:
									'Campaign delivery request failed internal contract validation'
							}
						});
						const campaign = await transaction.campaign.update({
							where: { id: delivery.campaignId },
							data: {
								failedCount: { increment: 1 }
							}
						});
						const active = await transaction.campaignDelivery.count({
							where: {
								campaignId: delivery.campaignId,
								status: {
									in: [
										CampaignDeliveryStatus.PENDING,
										CampaignDeliveryStatus.PROCESSING
									]
								}
							}
						});
						if (active === 0) {
							await transaction.campaign.update({
								where: { id: delivery.campaignId },
								data: {
									status:
										campaign.status === CampaignStatus.CANCEL_REQUESTED
											? CampaignStatus.CANCELLED
											: campaign.sentCount > 0
												? CampaignStatus.PARTIAL_FAILED
												: CampaignStatus.FAILED,
									completedAt: new Date()
								}
							});
						}
					}
				}
			}
			const quarantined = await transaction.campaignOutboxEvent.updateMany(
				{
					where: {
						id: event.id,
						status: CampaignOutboxStatus.PUBLISHING,
						lockedBy: workerId,
						lockToken: event.lockToken
					},
					data: {
						status: CampaignOutboxStatus.CANCELLED,
						attempts: { increment: 1 },
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						lastError: `INVALID_OUTBOX_CONTRACT: ${reason}`.slice(0, 4000)
					}
				}
			);
			if (quarantined.count !== 1) {
				throw new Error('Campaigns outbox quarantine claim was lost');
			}
		});
	}

	private async acquireRateSlot(
		transaction: Prisma.TransactionClient,
		campaignId: string,
		channel: CampaignDeliveryChannel
	): Promise<number> {
		await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${`campaign-rate:${campaignId}:${channel}`}, 0)
			)
		`;
		const now = new Date();
		const current = await transaction.campaignRateLimit.findUnique({
			where: { campaignId_channel: { campaignId, channel } }
		});
		if (current && current.nextAvailableAt.getTime() > now.getTime()) {
			return current.nextAvailableAt.getTime() - now.getTime();
		}
		const rate = this.ratePerSecond(channel);
		const nextAvailableAt = new Date(
			now.getTime() + Math.ceil(1000 / rate)
		);
		await transaction.campaignRateLimit.upsert({
			where: { campaignId_channel: { campaignId, channel } },
			create: { campaignId, channel, nextAvailableAt },
			update: { nextAvailableAt }
		});
		return 0;
	}

	private async finalizeCancellation(
		transaction: Prisma.TransactionClient,
		campaignId: string
	): Promise<void> {
		const active = await transaction.campaignDelivery.count({
			where: {
				campaignId,
				status: {
					in: [
						CampaignDeliveryStatus.PENDING,
						CampaignDeliveryStatus.PROCESSING
					]
				}
			}
		});
		if (active === 0) {
			await transaction.campaign.updateMany({
				where: {
					id: campaignId,
					status: CampaignStatus.CANCEL_REQUESTED
				},
				data: {
					status: CampaignStatus.CANCELLED,
					completedAt: new Date()
				}
			});
		}
	}

	private cancelEvent(
		transaction: Prisma.TransactionClient,
		event: ClaimedCampaignOutboxEvent,
		workerId: string,
		reason: string
	) {
		return transaction.campaignOutboxEvent.updateMany({
			where: {
				id: event.id,
				status: CampaignOutboxStatus.PUBLISHING,
				lockedBy: workerId,
				lockToken: event.lockToken
			},
			data: {
				status: CampaignOutboxStatus.CANCELLED,
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				lastError: reason
			}
		});
	}

	private ratePerSecond(channel: CampaignDeliveryChannel): number {
		const key =
			channel === CampaignDeliveryChannel.EMAIL
				? 'CAMPAIGNS_EMAIL_RATE_PER_SECOND'
				: 'CAMPAIGNS_TELEGRAM_RATE_PER_SECOND';
		const fallback = channel === CampaignDeliveryChannel.EMAIL ? 10 : 5;
		const value = Number(this.config.get<string>(key) || fallback);
		if (!Number.isFinite(value) || value <= 0 || value > 1000) {
			throw new Error(`${key} must be greater than 0 and at most 1000`);
		}
		return value;
	}
}
