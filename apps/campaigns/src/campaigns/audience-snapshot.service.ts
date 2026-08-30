import {
	AudienceSnapshotImportCoordinatorService,
	SnapshotImportCancelledError
} from './audience-snapshot-import-coordinator.service';
import { CampaignDispatchPreparationService } from './campaign-dispatch-preparation.service';
import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import { Injectable } from '@nestjs/common';
import {
	AudienceSnapshot,
	AudienceSnapshotStatus,
	Campaign,
	CampaignDeliveryStatus,
	CampaignStatus,
	Prisma
} from '@prisma/campaigns-client';

@Injectable()
export class AudienceSnapshotService {
	constructor(
		private readonly prisma: CampaignsPrismaService,
		private readonly importCoordinator: AudienceSnapshotImportCoordinatorService,
		private readonly dispatchPreparation: CampaignDispatchPreparationService
	) {}

	async captureCampaign(campaignId: string): Promise<void> {
		let campaign = await this.prisma.campaign.findUnique({
			where: { id: campaignId },
			include: { snapshots: { orderBy: { channel: 'asc' } } }
		});
		if (!campaign) return;
		if (
			campaign.status === CampaignStatus.CANCEL_REQUESTED ||
			campaign.status === CampaignStatus.CANCELLED
		) {
			await this.finalizeCancelled(campaign);
			return;
		}
		if (campaign.status !== CampaignStatus.SNAPSHOTTING) return;

		try {
			for (const snapshot of campaign.snapshots) {
				if (snapshot.status === AudienceSnapshotStatus.READY) continue;
				await this.importCoordinator.importSnapshot(campaign, snapshot);
			}

			campaign = await this.prisma.campaign.findUnique({
				where: { id: campaignId },
				include: { snapshots: { orderBy: { channel: 'asc' } } }
			});
			if (!campaign) return;
			if (
				campaign.status === CampaignStatus.CANCEL_REQUESTED ||
				campaign.status === CampaignStatus.CANCELLED
			) {
				await this.finalizeCancelled(campaign);
				return;
			}
			await this.dispatchPreparation.queueDeliveries(campaign);
		} catch (error) {
			if (!(error instanceof SnapshotImportCancelledError)) throw error;
			const cancelled = await this.prisma.campaign.findUnique({
				where: { id: campaignId },
				include: { snapshots: { orderBy: { channel: 'asc' } } }
			});
			if (
				cancelled &&
				(cancelled.status === CampaignStatus.CANCEL_REQUESTED ||
					cancelled.status === CampaignStatus.CANCELLED)
			) {
				await this.finalizeCancelled(cancelled);
				return;
			}
			throw error;
		}
	}

	async failCampaign(campaignId: string, reason: string): Promise<void> {
		await this.prisma.$transaction(
			transaction =>
				this.failCampaignInTransaction(transaction, campaignId, reason),
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
	}

	async failCampaignInTransaction(
		transaction: Prisma.TransactionClient,
		campaignId: string,
		reason: string
	): Promise<void> {
		await this.lockCampaign(transaction, campaignId);
		const campaign = await transaction.campaign.findUnique({
			where: { id: campaignId }
		});
		if (!campaign || campaign.status !== CampaignStatus.SNAPSHOTTING) {
			return;
		}
		const now = new Date();
		await transaction.campaignDelivery.deleteMany({
			where: { campaignId }
		});
		await transaction.audienceSnapshot.updateMany({
			where: {
				campaignId,
				status: AudienceSnapshotStatus.CREATING
			},
			data: {
				status: AudienceSnapshotStatus.FAILED,
				lastError: reason.slice(0, 2000),
				importToken: null,
				importLeaseExpiresAt: null,
				completedAt: now
			}
		});
		await transaction.campaign.update({
			where: { id: campaignId },
			data: {
				status: CampaignStatus.FAILED,
				completedAt: now
			}
		});
	}

	private async finalizeCancelled(
		campaign: Campaign & { snapshots: AudienceSnapshot[] }
	): Promise<void> {
		await this.prisma.$transaction(
			async transaction => {
				await this.lockCampaign(transaction, campaign.id);
				const current = await transaction.campaign.findUnique({
					where: { id: campaign.id }
				});
				if (
					!current ||
					(current.status !== CampaignStatus.CANCEL_REQUESTED &&
						current.status !== CampaignStatus.CANCELLED)
				) {
					return;
				}
				const now = new Date();
				if (current.recipientCount === 0) {
					await transaction.campaignDelivery.deleteMany({
						where: { campaignId: campaign.id }
					});
				}
				const cancelled =
					current.recipientCount > 0
						? await transaction.campaignDelivery.updateMany({
								where: {
									campaignId: campaign.id,
									status: CampaignDeliveryStatus.PENDING
								},
								data: {
									status: CampaignDeliveryStatus.CANCELLED,
									cancelledAt: now
								}
							})
						: { count: 0 };
				await transaction.audienceSnapshot.updateMany({
					where: {
						campaignId: campaign.id,
						status: AudienceSnapshotStatus.CREATING
					},
					data: {
						status: AudienceSnapshotStatus.CANCELLED,
						importToken: null,
						importLeaseExpiresAt: null,
						completedAt: now
					}
				});
				const active = await transaction.campaignDelivery.count({
					where: {
						campaignId: campaign.id,
						status: CampaignDeliveryStatus.PROCESSING
					}
				});
				await transaction.campaign.update({
					where: { id: campaign.id },
					data: {
						status:
							active === 0
								? CampaignStatus.CANCELLED
								: CampaignStatus.CANCEL_REQUESTED,
						cancelledCount: {
							increment: cancelled.count
						},
						completedAt: active === 0 ? now : null
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
}
