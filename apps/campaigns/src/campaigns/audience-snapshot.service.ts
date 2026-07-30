import { CoreInternalClient } from '../internal/core-internal.client';
import { buildDeliveryOutboxData } from '../messaging/campaigns-outbox.factory';
import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	AudienceSnapshot,
	AudienceSnapshotStatus,
	Campaign,
	CampaignDeliveryChannel,
	CampaignDeliveryStatus,
	CampaignStatus,
	Prisma
} from '@prisma/campaigns-client';
import { createHash, randomUUID } from 'node:crypto';

const MAX_AUDIENCE_RECIPIENTS = 500_000;
const DEFAULT_IMPORT_BATCH_SIZE = 1000;
const SNAPSHOT_IMPORT_LEASE_MS = 10 * 60 * 1000;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ExportedAudienceMetadata {
	sourceSnapshotId: string;
	asOf: Date;
	sha256: string;
	totalCount: number;
}

class SnapshotImportCancelledError extends Error {
	constructor() {
		super('Campaign snapshot import was cancelled');
		this.name = 'SnapshotImportCancelledError';
	}
}

@Injectable()
export class AudienceSnapshotService {
	constructor(
		private readonly prisma: CampaignsPrismaService,
		private readonly coreInternal: CoreInternalClient,
		private readonly config: ConfigService
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
				await this.importSnapshot(campaign, snapshot);
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
			await this.queueDeliveries(campaign);
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

	private async importSnapshot(
		campaign: Campaign,
		snapshot: AudienceSnapshot
	): Promise<void> {
		const importToken = await this.beginImport(campaign.id, snapshot.id);
		if (!importToken) return;
		try {
			const metadata = await this.streamExport(
				campaign,
				snapshot,
				destinations =>
					this.persistImportChunk(
						campaign.id,
						snapshot,
						importToken,
						destinations
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

	private async streamExport(
		campaign: Campaign,
		snapshot: AudienceSnapshot,
		onChunk: (destinations: readonly string[]) => Promise<void>
	): Promise<ExportedAudienceMetadata> {
		const response = await this.coreInternal.exportAudience(
			snapshot.channel,
			snapshot.audience
		);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		const hasher = createHash('sha256');
		const batchSize = this.importBatchSize();
		let destinations: string[] = [];
		let totalCount = 0;
		let buffer = '';
		let header:
			| {
					snapshotId: string;
					asOf: Date;
			  }
			| undefined;
		let trailer:
			| {
					snapshotId: string;
					totalCount: number;
					sha256: string;
			  }
			| undefined;
		let previousDestination: string | null = null;

		const flush = async () => {
			if (!destinations.length) return;
			const current = destinations;
			destinations = [];
			await onChunk(current);
		};
		const processLine = async (line: string) => {
			if (!line) return;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				throw new Error('Audience export contains invalid JSON');
			}
			const record = this.record(value);
			if (!header) {
				this.exactKeys(record, [
					'type',
					'schemaVersion',
					'snapshotId',
					'asOf',
					'criteria'
				]);
				if (
					record.type !== 'snapshot' ||
					record.schemaVersion !== 1 ||
					typeof record.snapshotId !== 'string' ||
					!UUID_PATTERN.test(record.snapshotId) ||
					typeof record.asOf !== 'string' ||
					!Number.isFinite(Date.parse(record.asOf))
				) {
					throw new Error('Audience export snapshot header is invalid');
				}
				const criteria = this.record(record.criteria);
				this.exactKeys(criteria, ['channel', 'audience']);
				const expectedAudience =
					campaign.audience === 'ACTIVE_SUBSCRIPTION'
						? 'ACTIVE_SUBSCRIBERS'
						: 'ALL';
				if (
					criteria.channel !== snapshot.channel ||
					criteria.audience !== expectedAudience
				) {
					throw new Error(
						'Audience export criteria do not match campaign'
					);
				}
				header = {
					snapshotId: record.snapshotId,
					asOf: new Date(record.asOf)
				};
				return;
			}
			if (record.type === 'complete') {
				if (trailer) {
					throw new Error('Audience export contains two trailers');
				}
				this.exactKeys(record, [
					'type',
					'snapshotId',
					'totalCount',
					'sha256'
				]);
				if (
					typeof record.snapshotId !== 'string' ||
					typeof record.totalCount !== 'number' ||
					!Number.isInteger(record.totalCount) ||
					record.totalCount < 0 ||
					typeof record.sha256 !== 'string' ||
					!/^[0-9a-f]{64}$/.test(record.sha256)
				) {
					throw new Error('Audience export trailer is invalid');
				}
				trailer = {
					snapshotId: record.snapshotId,
					totalCount: record.totalCount,
					sha256: record.sha256
				};
				return;
			}
			if (trailer) {
				throw new Error('Audience export contains data after the trailer');
			}
			this.exactKeys(record, ['type', 'destination']);
			if (
				record.type !== 'recipient' ||
				typeof record.destination !== 'string'
			) {
				throw new Error('Audience export recipient is invalid');
			}
			const destination = this.validateDestination(
				snapshot.channel,
				record.destination
			);
			if (
				previousDestination !== null &&
				destination <= previousDestination
			) {
				throw new Error(
					'Audience export recipients must be sorted and unique'
				);
			}
			previousDestination = destination;
			totalCount += 1;
			if (totalCount > MAX_AUDIENCE_RECIPIENTS) {
				throw new Error(
					`Audience export exceeds ${MAX_AUDIENCE_RECIPIENTS} recipients`
				);
			}
			destinations.push(destination);
			hasher.update(`${snapshot.channel}\u0000${destination}\n`);
			if (destinations.length >= batchSize) await flush();
		};

		try {
			while (true) {
				const chunk = await reader.read();
				buffer += decoder.decode(chunk.value, {
					stream: !chunk.done
				});
				let newline = buffer.indexOf('\n');
				while (newline >= 0) {
					const line = buffer.slice(0, newline).replace(/\r$/, '');
					buffer = buffer.slice(newline + 1);
					await processLine(line);
					newline = buffer.indexOf('\n');
				}
				if (chunk.done) break;
			}
			if (buffer) await processLine(buffer.replace(/\r$/, ''));
		} catch (error) {
			await reader.cancel().catch(() => undefined);
			throw error;
		} finally {
			reader.releaseLock();
		}

		if (!header || !trailer) {
			throw new Error(
				'Audience export must contain snapshot header and complete trailer'
			);
		}
		const digest = hasher.digest('hex');
		if (
			trailer.snapshotId !== header.snapshotId ||
			trailer.totalCount !== totalCount ||
			trailer.sha256 !== digest
		) {
			throw new Error(
				'Audience export count or SHA-256 verification failed'
			);
		}
		await flush();
		return {
			sourceSnapshotId: header.snapshotId,
			asOf: header.asOf,
			sha256: digest,
			totalCount
		};
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

	private async queueDeliveries(
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

	private validateDestination(
		channel: CampaignDeliveryChannel,
		value: string
	): string {
		const normalized = value.trim();
		if (normalized !== value || !normalized) {
			throw new Error('Audience destination is not normalized');
		}
		if (channel === CampaignDeliveryChannel.EMAIL) {
			if (
				normalized !== normalized.toLowerCase() ||
				normalized.length > 320 ||
				!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
			) {
				throw new Error(
					'Audience export contains an invalid verified email'
				);
			}
		} else if (normalized.length > 32 || !/^-?\d+$/.test(normalized)) {
			throw new Error(
				'Audience export contains an invalid Telegram chat ID'
			);
		}
		return normalized;
	}

	private record(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Audience export line must be an object');
		}
		return value as Record<string, unknown>;
	}

	private exactKeys(
		record: Record<string, unknown>,
		keys: readonly string[]
	): void {
		const actual = Object.keys(record).sort();
		const expected = [...keys].sort();
		if (
			actual.length !== expected.length ||
			actual.some((key, index) => key !== expected[index])
		) {
			throw new Error('Audience export line contains invalid keys');
		}
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

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
