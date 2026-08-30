import { AudienceExportReaderService } from './audience-export-reader.service';
import { AudienceSnapshotImportCoordinatorService } from './audience-snapshot-import-coordinator.service';
import { AudienceSnapshotService } from './audience-snapshot.service';
import { CampaignDispatchPreparationService } from './campaign-dispatch-preparation.service';
import {
	CampaignAudience,
	CampaignDeliveryChannel,
	CampaignDeliveryStatus,
	CampaignRequestedChannel,
	CampaignStatus,
	AudienceSnapshotStatus,
	Prisma
} from '@prisma/campaigns-client';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

jest.mock('node:timers/promises', () => ({
	setTimeout: jest.fn()
}));

const SNAPSHOT_ID = '3a879a0a-0fd9-49f8-aed0-c4731e4ae41d';
const SUBSCRIBER_SNAPSHOT_ID = '4b879a0a-0fd9-49f8-aed0-c4731e4ae41d';

const activeSubscriberResponse = (userIds: string[]) => {
	const sha256 = createHash('sha256')
		.update(userIds.map(userId => `${userId}\n`).join(''))
		.digest('hex');
	return new Response(
		[
			JSON.stringify({
				type: 'snapshot',
				schemaVersion: 1,
				snapshotId: SUBSCRIBER_SNAPSHOT_ID,
				asOf: '2026-07-30T11:59:59.000Z'
			}),
			...userIds.map(userId =>
				JSON.stringify({ type: 'subscriber', userId })
			),
			JSON.stringify({
				type: 'complete',
				snapshotId: SUBSCRIBER_SNAPSHOT_ID,
				totalCount: userIds.length,
				sha256
			})
		].join('\n'),
		{ headers: { 'content-type': 'application/x-ndjson' } }
	);
};

describe('Audience snapshot orchestration boundaries', () => {
	const campaign = {
		id: 'fe5e1389-9b9a-4c5a-9689-8feae659f89f',
		actorId: 'admin-id',
		idempotencyKey: 'a2a52cf8-0af7-4285-8f21-638b7049cad9',
		subject: 'Campaign subject',
		message: 'Campaign message',
		audience: CampaignAudience.ACTIVE_SUBSCRIPTION,
		requestedChannel: CampaignRequestedChannel.EMAIL,
		status: CampaignStatus.SNAPSHOTTING,
		recipientCount: 0,
		sentCount: 0,
		failedCount: 0,
		cancelledCount: 0,
		emailCount: 0,
		telegramCount: 0,
		startedAt: null,
		completedAt: null,
		cancelRequestedAt: null,
		createdAt: new Date(),
		updatedAt: new Date()
	};
	const snapshot = {
		id: '1944252d-4ad3-4698-a53a-1200039a516a',
		sourceSnapshotId: null,
		billingSnapshotId: null,
		billingSnapshotSha256: null,
		billingSnapshotAsOf: null,
		campaignId: campaign.id,
		channel: CampaignDeliveryChannel.EMAIL,
		audience: CampaignAudience.ACTIVE_SUBSCRIPTION,
		status: AudienceSnapshotStatus.CREATING,
		asOf: null,
		recipientCount: 0,
		sha256: null,
		lastError: null,
		importToken: null,
		importLeaseExpiresAt: null,
		completedAt: null,
		createdAt: new Date(),
		updatedAt: new Date()
	};

	it('accepts sorted recipients and canonical channel hash', async () => {
		const destinations = ['a@example.com', 'b@example.com'];
		const resultSha256 = createHash('sha256')
			.update(
				destinations
					.map(destination => `EMAIL\u0000${destination}\n`)
					.join('')
			)
			.digest('hex');
		const sourceSha256 = createHash('sha256')
			.update(
				destinations
					.map(
						(destination, index) =>
							`EMAIL\u0000${destination}\u0000user-${index + 1}\n`
					)
					.join('')
			)
			.digest('hex');
		const body = [
			JSON.stringify({
				type: 'snapshot',
				schemaVersion: 2,
				snapshotId: SNAPSHOT_ID,
				asOf: '2026-07-30T12:00:00.000Z',
				criteria: {
					channel: 'EMAIL'
				}
			}),
			...destinations.map((destination, index) =>
				JSON.stringify({
					type: 'recipient',
					userId: `user-${index + 1}`,
					destination
				})
			),
			JSON.stringify({
				type: 'complete',
				snapshotId: SNAPSHOT_ID,
				totalCount: 2,
				sha256: sourceSha256
			})
		].join('\n');
		const dependencies = {
			exportActiveSubscriberIds: jest
				.fn()
				.mockResolvedValue(activeSubscriberResponse(['user-1', 'user-2'])),
			exportAudience: jest.fn().mockResolvedValue(
				new Response(body, {
					headers: {
						'content-type': 'application/x-ndjson'
					}
				})
			)
		};
		const service = new AudienceExportReaderService(
			dependencies as never,
			{ get: jest.fn().mockReturnValue('1') } as never
		);
		const onChunk = jest.fn().mockResolvedValue(undefined);
		const result = await service.streamExport(
			campaign,
			snapshot,
			onChunk,
			new AbortController().signal
		);
		expect(result.sha256).toBe(resultSha256);
		expect(result.totalCount).toBe(2);
		expect(onChunk).toHaveBeenNthCalledWith(1, ['a@example.com']);
		expect(onChunk).toHaveBeenNthCalledWith(2, ['b@example.com']);
	});

	it('keeps one delivery when an inactive owner sorts before an active owner of the same destination', async () => {
		const destination = 'shared@example.com';
		const recipients = [
			{ userId: 'user-a', destination },
			{ userId: 'user-b', destination }
		];
		const sourceSha256 = createHash('sha256')
			.update(
				recipients
					.map(
						recipient =>
							`EMAIL\u0000${recipient.destination}\u0000${recipient.userId}\n`
					)
					.join('')
			)
			.digest('hex');
		const resultSha256 = createHash('sha256')
			.update(`EMAIL\u0000${destination}\n`)
			.digest('hex');
		const body = [
			JSON.stringify({
				type: 'snapshot',
				schemaVersion: 2,
				snapshotId: SNAPSHOT_ID,
				asOf: '2026-07-30T12:00:00.000Z',
				criteria: { channel: 'EMAIL' }
			}),
			...recipients.map(recipient =>
				JSON.stringify({ type: 'recipient', ...recipient })
			),
			JSON.stringify({
				type: 'complete',
				snapshotId: SNAPSHOT_ID,
				totalCount: recipients.length,
				sha256: sourceSha256
			})
		].join('\n');
		const dependencies = {
			exportActiveSubscriberIds: jest
				.fn()
				.mockResolvedValue(activeSubscriberResponse(['user-b'])),
			exportAudience: jest.fn().mockResolvedValue(new Response(body))
		};
		const service = new AudienceExportReaderService(
			dependencies as never,
			{ get: jest.fn().mockReturnValue('1000') } as never
		);
		const onChunk = jest.fn().mockResolvedValue(undefined);

		const result = await service.streamExport(
			campaign,
			snapshot,
			onChunk,
			new AbortController().signal
		);

		expect(result).toEqual(
			expect.objectContaining({
				sha256: resultSha256,
				totalCount: 1
			})
		);
		expect(onChunk).toHaveBeenCalledTimes(1);
		expect(onChunk).toHaveBeenCalledWith([destination]);
	});

	it('deduplicates a shared destination for the ALL audience after validating every source pair', async () => {
		const destination = 'shared@example.com';
		const recipients = [
			{ userId: 'user-a', destination },
			{ userId: 'user-b', destination }
		];
		const sourceSha256 = createHash('sha256')
			.update(
				recipients
					.map(
						recipient =>
							`EMAIL\u0000${recipient.destination}\u0000${recipient.userId}\n`
					)
					.join('')
			)
			.digest('hex');
		const body = [
			JSON.stringify({
				type: 'snapshot',
				schemaVersion: 2,
				snapshotId: SNAPSHOT_ID,
				asOf: '2026-07-30T12:00:00.000Z',
				criteria: { channel: 'EMAIL' }
			}),
			...recipients.map(recipient =>
				JSON.stringify({ type: 'recipient', ...recipient })
			),
			JSON.stringify({
				type: 'complete',
				snapshotId: SNAPSHOT_ID,
				totalCount: recipients.length,
				sha256: sourceSha256
			})
		].join('\n');
		const dependencies = {
			exportActiveSubscriberIds: jest.fn(),
			exportAudience: jest.fn().mockResolvedValue(new Response(body))
		};
		const service = new AudienceExportReaderService(
			dependencies as never,
			{ get: jest.fn().mockReturnValue('1000') } as never
		);
		const allCampaign = {
			...campaign,
			audience: CampaignAudience.ALL
		};
		const allSnapshot = {
			...snapshot,
			audience: CampaignAudience.ALL
		};
		const onChunk = jest.fn().mockResolvedValue(undefined);

		const result = await service.streamExport(
			allCampaign,
			allSnapshot,
			onChunk,
			new AbortController().signal
		);

		expect(result.totalCount).toBe(1);
		expect(onChunk).toHaveBeenCalledWith([destination]);
		expect(dependencies.exportActiveSubscriberIds).not.toHaveBeenCalled();
	});

	it('rejects an unverified/non-normalized email export', async () => {
		const destination = 'User@Example.com';
		const sha256 = createHash('sha256')
			.update(`EMAIL\u0000${destination}\u0000user-1\n`)
			.digest('hex');
		const body = [
			JSON.stringify({
				type: 'snapshot',
				schemaVersion: 2,
				snapshotId: SNAPSHOT_ID,
				asOf: '2026-07-30T12:00:00.000Z',
				criteria: {
					channel: 'EMAIL'
				}
			}),
			JSON.stringify({ type: 'recipient', userId: 'user-1', destination }),
			JSON.stringify({
				type: 'complete',
				snapshotId: SNAPSHOT_ID,
				totalCount: 1,
				sha256
			})
		].join('\n');
		const dependencies = {
			exportActiveSubscriberIds: jest
				.fn()
				.mockResolvedValue(activeSubscriberResponse(['user-1'])),
			exportAudience: jest.fn().mockResolvedValue(new Response(body))
		};
		const service = new AudienceExportReaderService(
			dependencies as never,
			{ get: jest.fn().mockReturnValue('1000') } as never
		);
		await expect(
			service.streamExport(
				campaign,
				snapshot,
				jest.fn().mockResolvedValue(undefined),
				new AbortController().signal
			)
		).rejects.toThrow('invalid verified email');
	});

	it('does not replace a snapshot import while its lease is active', async () => {
		const importToken = '492a78c8-f55d-4601-a379-ac6769ad67e2';
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaign: {
				findUnique: jest.fn().mockResolvedValue({
					status: CampaignStatus.SNAPSHOTTING
				})
			},
			audienceSnapshot: {
				findUnique: jest.fn().mockResolvedValue({
					status: AudienceSnapshotStatus.CREATING,
					importToken,
					importLeaseExpiresAt: new Date(Date.now() + 60_000)
				}),
				update: jest.fn()
			},
			campaignDelivery: {
				deleteMany: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new AudienceSnapshotImportCoordinatorService(
			prisma as never,
			{} as never
		);

		await expect(
			(
				service as unknown as {
					beginImport: (
						campaignId: string,
						snapshotId: string
					) => Promise<string | null>;
				}
			).beginImport(campaign.id, snapshot.id)
		).rejects.toThrow('already has an active lease');

		expect(transaction.campaignDelivery.deleteMany).not.toHaveBeenCalled();
		expect(transaction.audienceSnapshot.update).not.toHaveBeenCalled();
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
	});

	it('reclaims an expired import lease and resets staged rows in the same serializable transaction', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaign: {
				findUnique: jest.fn().mockResolvedValue({
					status: CampaignStatus.SNAPSHOTTING
				})
			},
			audienceSnapshot: {
				findUnique: jest.fn().mockResolvedValue({
					status: AudienceSnapshotStatus.CREATING,
					importToken: '492a78c8-f55d-4601-a379-ac6769ad67e2',
					importLeaseExpiresAt: new Date(Date.now() - 60_000)
				}),
				update: jest.fn().mockResolvedValue(undefined)
			},
			campaignDelivery: {
				deleteMany: jest.fn().mockResolvedValue({ count: 2 })
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new AudienceSnapshotImportCoordinatorService(
			prisma as never,
			{} as never
		);

		const nextToken = await (
			service as unknown as {
				beginImport: (
					campaignId: string,
					snapshotId: string
				) => Promise<string | null>;
			}
		).beginImport(campaign.id, snapshot.id);

		expect(nextToken).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		expect(transaction.campaignDelivery.deleteMany).toHaveBeenCalledWith({
			where: { snapshotId: snapshot.id }
		});
		expect(transaction.audienceSnapshot.update).toHaveBeenCalledWith({
			where: { id: snapshot.id },
			data: expect.objectContaining({
				importToken: nextToken,
				importLeaseExpiresAt: expect.any(Date),
				recipientCount: 0,
				lastError: null
			})
		});
		expect(
			transaction.campaignDelivery.deleteMany.mock.invocationCallOrder[0]
		).toBeLessThan(
			transaction.audienceSnapshot.update.mock.invocationCallOrder[0]
		);
	});

	it('does not complete an import checkpoint when the verified count differs from persisted rows', async () => {
		const importToken = '492a78c8-f55d-4601-a379-ac6769ad67e2';
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaign: {
				findUnique: jest.fn().mockResolvedValue({
					status: CampaignStatus.SNAPSHOTTING
				})
			},
			audienceSnapshot: {
				findUnique: jest.fn().mockResolvedValue({
					status: AudienceSnapshotStatus.CREATING,
					importToken
				}),
				updateMany: jest.fn()
			},
			campaignDelivery: {
				count: jest.fn().mockResolvedValue(1)
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new AudienceSnapshotImportCoordinatorService(
			prisma as never,
			{} as never
		);

		await expect(
			(
				service as unknown as {
					completeImport: (
						campaignId: string,
						snapshotId: string,
						token: string,
						metadata: {
							sourceSnapshotId: string;
							asOf: Date;
							sha256: string;
							totalCount: number;
							billingSnapshotId: string | null;
							billingSnapshotSha256: string | null;
							billingSnapshotAsOf: Date | null;
						}
					) => Promise<void>;
				}
			).completeImport(campaign.id, snapshot.id, importToken, {
				sourceSnapshotId: SNAPSHOT_ID,
				asOf: new Date(),
				sha256: 'a'.repeat(64),
				totalCount: 2,
				billingSnapshotId: null,
				billingSnapshotSha256: null,
				billingSnapshotAsOf: null
			})
		).rejects.toThrow('row count does not match verified trailer');

		expect(transaction.audienceSnapshot.updateMany).not.toHaveBeenCalled();
	});

	it('requires the import-token CAS to win before marking the snapshot ready', async () => {
		const importToken = '492a78c8-f55d-4601-a379-ac6769ad67e2';
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaign: {
				findUnique: jest.fn().mockResolvedValue({
					status: CampaignStatus.SNAPSHOTTING
				})
			},
			audienceSnapshot: {
				findUnique: jest.fn().mockResolvedValue({
					status: AudienceSnapshotStatus.CREATING,
					importToken
				}),
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			campaignDelivery: {
				count: jest.fn().mockResolvedValue(1)
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new AudienceSnapshotImportCoordinatorService(
			prisma as never,
			{} as never
		);
		const metadata = {
			sourceSnapshotId: SNAPSHOT_ID,
			asOf: new Date(),
			sha256: 'a'.repeat(64),
			totalCount: 1,
			billingSnapshotId: null,
			billingSnapshotSha256: null,
			billingSnapshotAsOf: null
		};

		await expect(
			(
				service as unknown as {
					completeImport: (
						campaignId: string,
						snapshotId: string,
						token: string,
						inputMetadata: typeof metadata
					) => Promise<void>;
				}
			).completeImport(campaign.id, snapshot.id, importToken, metadata)
		).rejects.toThrow('cancelled');

		expect(transaction.audienceSnapshot.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: snapshot.id,
					status: AudienceSnapshotStatus.CREATING,
					importToken
				}
			})
		);
	});

	it('stops the import heartbeat when its lease CAS no longer matches', async () => {
		const importToken = '492a78c8-f55d-4601-a379-ac6769ad67e2';
		const updateMany = jest.fn().mockResolvedValue({ count: 0 });
		const service = new AudienceSnapshotImportCoordinatorService(
			{
				audienceSnapshot: { updateMany }
			} as never,
			{} as never
		);
		const abortController = new AbortController();
		(wait as jest.Mock).mockResolvedValueOnce(undefined);

		await expect(
			(
				service as unknown as {
					runImportLeaseHeartbeat: (
						campaignId: string,
						snapshotId: string,
						token: string,
						signal: AbortSignal
					) => Promise<void>;
				}
			).runImportLeaseHeartbeat(
				campaign.id,
				snapshot.id,
				importToken,
				abortController.signal
			)
		).rejects.toThrow('cancelled');
		expect(wait).toHaveBeenCalledWith(2 * 60 * 1000, undefined, {
			signal: abortController.signal
		});
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: snapshot.id,
				campaignId: campaign.id,
				status: AudienceSnapshotStatus.CREATING,
				importToken,
				campaign: { status: CampaignStatus.SNAPSHOTTING }
			},
			data: {
				importLeaseExpiresAt: expect.any(Date)
			}
		});
	});

	it('removes only the failed import attempt rows before a resumable retry', async () => {
		const importToken = '492a78c8-f55d-4601-a379-ac6769ad67e2';
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			audienceSnapshot: {
				findUnique: jest.fn().mockResolvedValue({
					status: AudienceSnapshotStatus.CREATING,
					importToken
				}),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			campaignDelivery: {
				deleteMany: jest.fn().mockResolvedValue({ count: 2 })
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new AudienceSnapshotImportCoordinatorService(
			prisma as never,
			{} as never
		);

		await (
			service as unknown as {
				rollbackImport: (
					campaignId: string,
					snapshotId: string,
					token: string,
					error: Error
				) => Promise<void>;
			}
		).rollbackImport(
			campaign.id,
			snapshot.id,
			importToken,
			new Error('stream failed')
		);

		expect(transaction.campaignDelivery.deleteMany).toHaveBeenCalledWith({
			where: { snapshotId: snapshot.id }
		});
		expect(transaction.audienceSnapshot.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ importToken }),
				data: expect.objectContaining({
					importToken: null,
					importLeaseExpiresAt: null,
					recipientCount: 0,
					lastError: 'stream failed'
				})
			})
		);
	});

	it('does not persist a chunk after campaign cancellation', async () => {
		const importToken = '492a78c8-f55d-4601-a379-ac6769ad67e2';
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaign: {
				findUnique: jest.fn().mockResolvedValue({
					status: CampaignStatus.CANCELLED
				})
			},
			audienceSnapshot: {
				findUnique: jest.fn().mockResolvedValue({
					status: AudienceSnapshotStatus.CREATING,
					importToken
				}),
				updateMany: jest.fn()
			},
			campaignDelivery: {
				createMany: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new AudienceSnapshotImportCoordinatorService(
			prisma as never,
			{} as never
		);

		await expect(
			(
				service as unknown as {
					persistImportChunk: (
						campaignId: string,
						inputSnapshot: typeof snapshot,
						token: string,
						destinations: readonly string[]
					) => Promise<void>;
				}
			).persistImportChunk(campaign.id, snapshot, importToken, [
				'a@example.com'
			])
		).rejects.toThrow('cancelled');
		expect(transaction.campaignDelivery.createMany).not.toHaveBeenCalled();
	});

	it('continues dispatch preparation from the last delivery ID and preserves generation checkpoints', async () => {
		const readySnapshot = {
			...snapshot,
			status: AudienceSnapshotStatus.READY
		};
		const deliveryOne = {
			id: '3944252d-4ad3-4698-a53a-1200039a516a',
			campaignId: campaign.id,
			snapshotId: snapshot.id,
			channel: CampaignDeliveryChannel.EMAIL,
			destination: 'a@example.com',
			destinationKey: 'a'.repeat(64),
			status: CampaignDeliveryStatus.PENDING,
			dispatchGeneration: 1,
			attempts: 0,
			requestEventId: '5944252d-4ad3-4698-a53a-1200039a516a',
			lastOutcomeEventId: null,
			lastErrorCode: null,
			lastErrorReason: null,
			sentAt: null,
			cancelledAt: null,
			createdAt: new Date(),
			updatedAt: new Date()
		};
		const deliveryTwo = {
			...deliveryOne,
			id: '4944252d-4ad3-4698-a53a-1200039a516a',
			destination: 'b@example.com',
			destinationKey: 'b'.repeat(64),
			dispatchGeneration: 3,
			requestEventId: '6944252d-4ad3-4698-a53a-1200039a516a'
		};
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			$queryRaw: jest.fn().mockResolvedValue([{ count: 2n }]),
			campaign: {
				findUnique: jest.fn().mockResolvedValue({
					...campaign,
					snapshots: [readySnapshot]
				}),
				update: jest.fn().mockResolvedValue(undefined)
			},
			campaignDelivery: {
				count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(2)
			},
			campaignOutboxEvent: {
				createMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			campaignDelivery: {
				findMany: jest
					.fn()
					.mockResolvedValueOnce([deliveryOne])
					.mockResolvedValueOnce([deliveryTwo])
					.mockResolvedValueOnce([])
			},
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new CampaignDispatchPreparationService(
			prisma as never,
			{ get: jest.fn().mockReturnValue('1') } as never
		);

		await service.queueDeliveries({
			...campaign,
			snapshots: [readySnapshot]
		});

		expect(prisma.campaignDelivery.findMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				cursor: { id: deliveryOne.id },
				skip: 1,
				take: 1
			})
		);
		expect(prisma.campaignDelivery.findMany).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				cursor: { id: deliveryTwo.id },
				skip: 1
			})
		);
		const outboxBatches =
			transaction.campaignOutboxEvent.createMany.mock.calls.map(
				([input]) => input.data[0]
			);
		expect(outboxBatches).toEqual([
			expect.objectContaining({
				aggregateId: deliveryOne.id,
				generation: 1,
				deduplicationKey: `campaign-delivery:${deliveryOne.id}:generation:1`
			}),
			expect.objectContaining({
				aggregateId: deliveryTwo.id,
				generation: 3,
				deduplicationKey: `campaign-delivery:${deliveryTwo.id}:generation:3`
			})
		]);
		expect(transaction.$queryRaw.mock.calls[0][0].join(' ')).toContain(
			'outbox."generation" = delivery."dispatch_generation"'
		);
		expect(transaction.campaign.update).toHaveBeenCalledWith({
			where: { id: campaign.id },
			data: expect.objectContaining({
				status: CampaignStatus.QUEUED,
				recipientCount: 2,
				emailCount: 2,
				telegramCount: 0
			})
		});
	});

	it('keeps the facade responsible only for import sequencing and dispatch handoff', async () => {
		const creatingSnapshot = {
			...snapshot,
			status: AudienceSnapshotStatus.CREATING
		};
		const readySnapshot = {
			...snapshot,
			status: AudienceSnapshotStatus.READY
		};
		const prisma = {
			campaign: {
				findUnique: jest
					.fn()
					.mockResolvedValueOnce({
						...campaign,
						snapshots: [creatingSnapshot]
					})
					.mockResolvedValueOnce({
						...campaign,
						snapshots: [readySnapshot]
					})
			}
		};
		const importCoordinator = {
			importSnapshot: jest.fn().mockResolvedValue(undefined)
		};
		const dispatchPreparation = {
			queueDeliveries: jest.fn().mockResolvedValue(undefined)
		};
		const service = new AudienceSnapshotService(
			prisma as never,
			importCoordinator as never,
			dispatchPreparation as never
		);

		await service.captureCampaign(campaign.id);

		expect(importCoordinator.importSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ id: campaign.id }),
			creatingSnapshot
		);
		expect(dispatchPreparation.queueDeliveries).toHaveBeenCalledWith(
			expect.objectContaining({
				id: campaign.id,
				snapshots: [readySnapshot]
			})
		);
		expect(
			importCoordinator.importSnapshot.mock.invocationCallOrder[0]
		).toBeLessThan(
			dispatchPreparation.queueDeliveries.mock.invocationCallOrder[0]
		);
	});

	it('deletes staged snapshot rows without increasing the cancellation counter', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaign: {
				findUnique: jest.fn().mockResolvedValue({
					...campaign,
					status: CampaignStatus.CANCEL_REQUESTED
				}),
				update: jest.fn().mockResolvedValue(undefined)
			},
			campaignDelivery: {
				deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
				updateMany: jest.fn(),
				count: jest.fn().mockResolvedValue(0)
			},
			audienceSnapshot: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			campaignOutboxEvent: {
				createMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			campaign: {
				findUnique: jest.fn().mockResolvedValue({
					...campaign,
					status: CampaignStatus.CANCEL_REQUESTED,
					snapshots: [snapshot]
				})
			},
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new AudienceSnapshotService(
			prisma as never,
			{ importSnapshot: jest.fn() } as never,
			{ queueDeliveries: jest.fn() } as never
		);

		await service.captureCampaign(campaign.id);

		expect(transaction.campaignDelivery.deleteMany).toHaveBeenCalledWith({
			where: { campaignId: campaign.id }
		});
		expect(transaction.campaignDelivery.updateMany).not.toHaveBeenCalled();
		expect(transaction.campaign.update).toHaveBeenCalledWith({
			where: { id: campaign.id },
			data: expect.objectContaining({
				status: CampaignStatus.CANCELLED,
				cancelledCount: { increment: 0 }
			})
		});
	});

	it('replays cancellation finalization without emitting a create audit', async () => {
		let status: CampaignStatus = CampaignStatus.CANCEL_REQUESTED;
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaign: {
				findUnique: jest.fn(() =>
					Promise.resolve({ ...campaign, status })
				),
				update: jest.fn((input: { data: { status: CampaignStatus } }) => {
					status = input.data.status;
					return Promise.resolve(undefined);
				})
			},
			campaignDelivery: {
				deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
				updateMany: jest.fn(),
				count: jest.fn().mockResolvedValue(0)
			},
			audienceSnapshot: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			campaignOutboxEvent: {
				createMany: jest.fn()
			}
		};
		const prisma = {
			campaign: {
				findUnique: jest.fn(() =>
					Promise.resolve({
						...campaign,
						status,
						snapshots: [snapshot]
					})
				)
			},
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new AudienceSnapshotService(
			prisma as never,
			{ importSnapshot: jest.fn() } as never,
			{ queueDeliveries: jest.fn() } as never
		);

		await service.captureCampaign(campaign.id);
		await service.captureCampaign(campaign.id);

		expect(status).toBe(CampaignStatus.CANCELLED);
		expect(
			transaction.campaignOutboxEvent.createMany
		).not.toHaveBeenCalled();
	});
});
