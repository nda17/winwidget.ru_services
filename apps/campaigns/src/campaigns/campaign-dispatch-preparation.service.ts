import { SnapshotImportCancelledError } from './audience-snapshot-import-coordinator.service';
import { buildDeliveryOutboxData } from '../messaging/campaigns-outbox.factory';
import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	AudienceSnapshot,
	AudienceSnapshotStatus,
	Campaign,
	CampaignDeliveryChannel,
	CampaignStatus,
	Prisma
} from '@prisma/campaigns-client';

const DEFAULT_IMPORT_BATCH_SIZE = 1000;

@Injectable()
export class CampaignDispatchPreparationService {
	constructor(
		private readonly prisma: CampaignsPrismaService,
		private readonly config: ConfigService
	) {}

	async queueDeliveries(
		campaign: Campaign & { snapshots: AudienceSnapshot[] }
	): Promise<void> {
		const batchSize = this.importBatchSize();
		let cursor: string | undefined;
		while (true) {
			const deliveries = await this.prisma.campaignDelivery.findMany({
				where: { campaignId: campaign.id },
				orderBy: { id: 'asc' },
				take: batchSize,
				...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
			});
			if (!deliveries.length) break;
			await this.prisma.$transaction(
				async transaction => {
					await this.lockCampaign(transaction, campaign.id);
					const current = await transaction.campaign.findUnique({
						where: { id: campaign.id },
						include: { snapshots: true }
					});
					if (
						!current ||
						current.status !== CampaignStatus.SNAPSHOTTING ||
						current.snapshots.some(
							snapshot => snapshot.status !== AudienceSnapshotStatus.READY
						)
					) {
						throw new SnapshotImportCancelledError();
					}
					const outboxData = deliveries.map(delivery => {
						if (!delivery.requestEventId) {
							throw new Error('Snapshot delivery has no request event ID');
						}
						return buildDeliveryOutboxData(
							current,
							delivery,
							delivery.requestEventId
						);
					});
					await transaction.campaignOutboxEvent.createMany({
						data: outboxData,
						skipDuplicates: true
					});
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: 10_000,
					timeout: 30_000
				}
			);
			cursor = deliveries[deliveries.length - 1].id;
		}

		await this.prisma.$transaction(
			async transaction => {
				await this.lockCampaign(transaction, campaign.id);
				const current = await transaction.campaign.findUnique({
					where: { id: campaign.id },
					include: { snapshots: true }
				});
				if (
					!current ||
					current.status !== CampaignStatus.SNAPSHOTTING ||
					current.snapshots.some(
						snapshot => snapshot.status !== AudienceSnapshotStatus.READY
					)
				) {
					return;
				}
				const [deliveryCount, emailCount, outboxCountRows] =
					await Promise.all([
						transaction.campaignDelivery.count({
							where: { campaignId: campaign.id }
						}),
						transaction.campaignDelivery.count({
							where: {
								campaignId: campaign.id,
								channel: CampaignDeliveryChannel.EMAIL
							}
						}),
						transaction.$queryRaw<Array<{ count: bigint }>>`
							SELECT COUNT(*)::bigint AS "count"
							FROM "campaigns"."outbox_events" outbox
							INNER JOIN "campaigns"."deliveries" delivery
								ON delivery."id" = outbox."aggregate_id"
							WHERE delivery."campaign_id" = ${campaign.id}::uuid
								AND outbox."aggregate_type" = 'campaign-delivery'
								AND outbox."generation" = delivery."dispatch_generation"
						`
					]);
				const outboxCount = Number(outboxCountRows[0]?.count || 0n);
				if (outboxCount !== deliveryCount) {
					throw new Error('Campaign dispatch Outbox is incomplete');
				}
				await transaction.campaign.update({
					where: { id: campaign.id },
					data: {
						status:
							deliveryCount > 0
								? CampaignStatus.QUEUED
								: CampaignStatus.COMPLETED,
						recipientCount: deliveryCount,
						emailCount,
						telegramCount: deliveryCount - emailCount,
						completedAt: deliveryCount === 0 ? new Date() : null
					}
				});
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
	}

	private lockCampaign(
		transaction: Prisma.TransactionClient,
		campaignId: string
	): Promise<number> {
		return transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${`campaign-aggregate:${campaignId}`}, 0)
			)
		`;
	}

	private importBatchSize(): number {
		const value = Number(
			this.config.get<string>('CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE') ||
				DEFAULT_IMPORT_BATCH_SIZE
		);
		if (!Number.isInteger(value) || value < 1 || value > 5000) {
			throw new Error(
				'CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE must be between 1 and 5000'
			);
		}
		return value;
	}
}
