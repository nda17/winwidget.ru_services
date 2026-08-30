import {
	AudienceExportReaderService,
	ExportedAudienceMetadata
} from './audience-export-reader.service';
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
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const SNAPSHOT_IMPORT_LEASE_MS = 10 * 60 * 1000;
const SNAPSHOT_IMPORT_HEARTBEAT_MS = 2 * 60 * 1000;

export class SnapshotImportCancelledError extends Error {
	constructor() {
		super('Campaign snapshot import was cancelled');
		this.name = 'SnapshotImportCancelledError';
	}
}

@Injectable()
export class AudienceSnapshotImportCoordinatorService {
	constructor(
		private readonly prisma: CampaignsPrismaService,
		private readonly exportReader: AudienceExportReaderService
	) {}

	async importSnapshot(
		campaign: Campaign,
		snapshot: AudienceSnapshot
	): Promise<void> {
		const importToken = await this.beginImport(campaign.id, snapshot.id);
		if (!importToken) return;
		try {
			const metadata = await this.withImportLeaseHeartbeat(
				campaign.id,
				snapshot.id,
				importToken,
				abortSignal =>
					this.exportReader.streamExport(
						campaign,
						snapshot,
						destinations =>
							this.persistImportChunk(
								campaign.id,
								snapshot,
								importToken,
								destinations
							),
						abortSignal
					)
			);
			await this.completeImport(
				campaign.id,
				snapshot.id,
				importToken,
				metadata
			);
		} catch (error) {
			await this.rollbackImport(
				campaign.id,
				snapshot.id,
				importToken,
				error
			).catch(() => undefined);
			throw error;
		}
	}

	private async beginImport(
		campaignId: string,
		snapshotId: string
	): Promise<string | null> {
		return this.prisma.$transaction(
			async transaction => {
				await this.lockCampaign(transaction, campaignId);
				const [campaign, snapshot] = await Promise.all([
					transaction.campaign.findUnique({
						where: { id: campaignId }
					}),
					transaction.audienceSnapshot.findUnique({
						where: { id: snapshotId }
					})
				]);
				if (!campaign || !snapshot) return null;
				if (campaign.status !== CampaignStatus.SNAPSHOTTING) {
					throw new SnapshotImportCancelledError();
				}
				if (snapshot.status === AudienceSnapshotStatus.READY) {
					return null;
				}
				if (snapshot.status !== AudienceSnapshotStatus.CREATING) {
					throw new Error(
						`Audience snapshot cannot be imported from ${snapshot.status}`
					);
				}
				const now = new Date();
				if (
					snapshot.importToken &&
					snapshot.importLeaseExpiresAt &&
					snapshot.importLeaseExpiresAt > now
				) {
					throw new Error(
						'Audience snapshot import already has an active lease'
					);
				}
				const importToken = randomUUID();
				await transaction.campaignDelivery.deleteMany({
					where: { snapshotId }
				});
				await transaction.audienceSnapshot.update({
					where: { id: snapshotId },
					data: {
						sourceSnapshotId: null,
						billingSnapshotId: null,
						billingSnapshotSha256: null,
						billingSnapshotAsOf: null,
						asOf: null,
						recipientCount: 0,
						sha256: null,
						lastError: null,
						completedAt: null,
						importToken,
						importLeaseExpiresAt: new Date(
							now.getTime() + SNAPSHOT_IMPORT_LEASE_MS
						)
					}
				});
				return importToken;
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
	}

	private async withImportLeaseHeartbeat<T>(
		campaignId: string,
		snapshotId: string,
		importToken: string,
		operation: (abortSignal: AbortSignal) => Promise<T>
	): Promise<T> {
		const operationAbort = new AbortController();
		const heartbeatStop = new AbortController();
		const operationPromise = operation(operationAbort.signal);
		const heartbeatPromise = this.runImportLeaseHeartbeat(
			campaignId,
			snapshotId,
			importToken,
			heartbeatStop.signal
		).catch(error => {
			operationAbort.abort();
			throw error;
		});
		const heartbeatFailure = heartbeatPromise.then(
			() => new Promise<never>(() => undefined),
			error => Promise.reject(error)
		);

		try {
			return await Promise.race([operationPromise, heartbeatFailure]);
		} finally {
			heartbeatStop.abort();
			operationAbort.abort();
			await Promise.allSettled([operationPromise, heartbeatPromise]);
		}
	}

	private async runImportLeaseHeartbeat(
		campaignId: string,
		snapshotId: string,
		importToken: string,
		abortSignal: AbortSignal
	): Promise<void> {
		while (!abortSignal.aborted) {
			try {
				await wait(SNAPSHOT_IMPORT_HEARTBEAT_MS, undefined, {
					signal: abortSignal
				});
			} catch (error) {
				if (abortSignal.aborted) return;
				throw error;
			}
			const renewed = await this.prisma.audienceSnapshot.updateMany({
				where: {
					id: snapshotId,
					campaignId,
					status: AudienceSnapshotStatus.CREATING,
					importToken,
					campaign: { status: CampaignStatus.SNAPSHOTTING }
				},
				data: {
					importLeaseExpiresAt: new Date(
						Date.now() + SNAPSHOT_IMPORT_LEASE_MS
					)
				}
			});
			if (renewed.count !== 1) {
				throw new SnapshotImportCancelledError();
			}
		}
	}

	private async persistImportChunk(
		campaignId: string,
		snapshot: AudienceSnapshot,
		importToken: string,
		destinations: readonly string[]
	): Promise<void> {
		const deliveries = destinations.map(destination => ({
			id: randomUUID(),
			campaignId,
			snapshotId: snapshot.id,
			channel: snapshot.channel,
			destination,
			destinationKey: createHash('sha256')
				.update(`${snapshot.channel}\u0000${destination}`)
				.digest('hex'),
			status: CampaignDeliveryStatus.PENDING,
			dispatchGeneration: 1,
			requestEventId: randomUUID()
		}));
		await this.prisma.$transaction(
			async transaction => {
				await this.lockCampaign(transaction, campaignId);
				const [campaign, current] = await Promise.all([
					transaction.campaign.findUnique({
						where: { id: campaignId },
						select: { status: true }
					}),
					transaction.audienceSnapshot.findUnique({
						where: { id: snapshot.id },
						select: {
							status: true,
							importToken: true
						}
					})
				]);
				if (
					campaign?.status !== CampaignStatus.SNAPSHOTTING ||
					current?.status !== AudienceSnapshotStatus.CREATING ||
					current.importToken !== importToken
				) {
					throw new SnapshotImportCancelledError();
				}
				await transaction.campaignDelivery.createMany({
					data: deliveries,
					skipDuplicates: true
				});
				const renewed = await transaction.audienceSnapshot.updateMany({
					where: {
						id: snapshot.id,
						status: AudienceSnapshotStatus.CREATING,
						importToken
					},
					data: {
						importLeaseExpiresAt: new Date(
							Date.now() + SNAPSHOT_IMPORT_LEASE_MS
						)
					}
				});
				if (renewed.count !== 1) {
					throw new SnapshotImportCancelledError();
				}
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 10_000,
				timeout: 30_000
			}
		);
	}

	private async completeImport(
		campaignId: string,
		snapshotId: string,
		importToken: string,
		metadata: ExportedAudienceMetadata
	): Promise<void> {
		await this.prisma.$transaction(
			async transaction => {
				await this.lockCampaign(transaction, campaignId);
				const [campaign, snapshot, importedCount] = await Promise.all([
					transaction.campaign.findUnique({
						where: { id: campaignId },
						select: { status: true }
					}),
					transaction.audienceSnapshot.findUnique({
						where: { id: snapshotId },
						select: {
							status: true,
							importToken: true
						}
					}),
					transaction.campaignDelivery.count({
						where: { snapshotId }
					})
				]);
				if (
					campaign?.status !== CampaignStatus.SNAPSHOTTING ||
					snapshot?.status !== AudienceSnapshotStatus.CREATING ||
					snapshot.importToken !== importToken
				) {
					throw new SnapshotImportCancelledError();
				}
				if (importedCount !== metadata.totalCount) {
					throw new Error(
						'Audience import row count does not match verified trailer'
					);
				}
				const completed = await transaction.audienceSnapshot.updateMany({
					where: {
						id: snapshotId,
						status: AudienceSnapshotStatus.CREATING,
						importToken
					},
					data: {
						sourceSnapshotId: metadata.sourceSnapshotId,
						billingSnapshotId: metadata.billingSnapshotId,
						billingSnapshotSha256: metadata.billingSnapshotSha256,
						billingSnapshotAsOf: metadata.billingSnapshotAsOf,
						asOf: metadata.asOf,
						status: AudienceSnapshotStatus.READY,
						recipientCount: metadata.totalCount,
						sha256: metadata.sha256,
						lastError: null,
						importToken: null,
						importLeaseExpiresAt: null,
						completedAt: new Date()
					}
				});
				if (completed.count !== 1) {
					throw new SnapshotImportCancelledError();
				}
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
	}

	private async rollbackImport(
		campaignId: string,
		snapshotId: string,
		importToken: string,
		error: unknown
	): Promise<void> {
		await this.prisma.$transaction(
			async transaction => {
				await this.lockCampaign(transaction, campaignId);
				const snapshot = await transaction.audienceSnapshot.findUnique({
					where: { id: snapshotId },
					select: {
						status: true,
						importToken: true
					}
				});
				if (
					!snapshot ||
					snapshot.status !== AudienceSnapshotStatus.CREATING ||
					snapshot.importToken !== importToken
				) {
					return;
				}
				await transaction.campaignDelivery.deleteMany({
					where: { snapshotId }
				});
				await transaction.audienceSnapshot.updateMany({
					where: {
						id: snapshotId,
						status: AudienceSnapshotStatus.CREATING,
						importToken
					},
					data: {
						sourceSnapshotId: null,
						billingSnapshotId: null,
						billingSnapshotSha256: null,
						billingSnapshotAsOf: null,
						asOf: null,
						recipientCount: 0,
						sha256: null,
						lastError: this.errorMessage(error).slice(0, 2000),
						importToken: null,
						importLeaseExpiresAt: null,
						completedAt: null
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

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
