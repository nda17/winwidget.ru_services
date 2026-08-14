import { AudienceSnapshotService } from './audience-snapshot.service';
import {
	CampaignAudience,
	CampaignDeliveryChannel,
	CampaignRequestedChannel,
	CampaignStatus,
	AudienceSnapshotStatus
} from '@prisma/campaigns-client';
import { createHash } from 'node:crypto';

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

describe('AudienceSnapshotService NDJSON verification', () => {
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
		const core = {
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
		const service = new AudienceSnapshotService(
			{} as never,
			core as never,
			{ get: jest.fn().mockReturnValue('1') } as never
		);
		const onChunk = jest.fn().mockResolvedValue(undefined);
		const result = await (
			service as unknown as {
				streamExport: (
					inputCampaign: typeof campaign,
					inputSnapshot: typeof snapshot,
					consumer: (destinations: readonly string[]) => Promise<void>
				) => Promise<{
					sha256: string;
					totalCount: number;
				}>;
			}
		).streamExport(campaign, snapshot, onChunk);
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
		const core = {
			exportActiveSubscriberIds: jest
				.fn()
				.mockResolvedValue(activeSubscriberResponse(['user-b'])),
			exportAudience: jest.fn().mockResolvedValue(new Response(body))
		};
		const service = new AudienceSnapshotService(
			{} as never,
			core as never,
			{ get: jest.fn().mockReturnValue('1000') } as never
		);
		const onChunk = jest.fn().mockResolvedValue(undefined);

		const result = await (
			service as unknown as {
				streamExport: (
					inputCampaign: typeof campaign,
					inputSnapshot: typeof snapshot,
					consumer: (destinations: readonly string[]) => Promise<void>
				) => Promise<{ sha256: string; totalCount: number }>;
			}
		).streamExport(campaign, snapshot, onChunk);

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
		const core = {
			exportActiveSubscriberIds: jest.fn(),
			exportAudience: jest.fn().mockResolvedValue(new Response(body))
		};
		const service = new AudienceSnapshotService(
			{} as never,
			core as never,
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

		const result = await (
			service as unknown as {
				streamExport: (
					inputCampaign: typeof allCampaign,
					inputSnapshot: typeof allSnapshot,
					consumer: (destinations: readonly string[]) => Promise<void>
				) => Promise<{ totalCount: number }>;
			}
		).streamExport(allCampaign, allSnapshot, onChunk);

		expect(result.totalCount).toBe(1);
		expect(onChunk).toHaveBeenCalledWith([destination]);
		expect(core.exportActiveSubscriberIds).not.toHaveBeenCalled();
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
		const core = {
			exportActiveSubscriberIds: jest
				.fn()
				.mockResolvedValue(activeSubscriberResponse(['user-1'])),
			exportAudience: jest.fn().mockResolvedValue(new Response(body))
		};
		const service = new AudienceSnapshotService(
			{} as never,
			core as never,
			{ get: jest.fn().mockReturnValue('1000') } as never
		);
		await expect(
			(
				service as unknown as {
					streamExport: (
						inputCampaign: typeof campaign,
						inputSnapshot: typeof snapshot,
						consumer: (destinations: readonly string[]) => Promise<void>
					) => Promise<unknown>;
				}
			).streamExport(
				campaign,
				snapshot,
				jest.fn().mockResolvedValue(undefined)
			)
		).rejects.toThrow('invalid verified email');
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
		const service = new AudienceSnapshotService(
			prisma as never,
			{} as never,
			{ get: jest.fn() } as never
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
		const service = new AudienceSnapshotService(
			prisma as never,
			{} as never,
			{ get: jest.fn().mockReturnValue('1000') } as never
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
			{} as never,
			{ get: jest.fn() } as never
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
			{} as never,
			{ get: jest.fn() } as never
		);

		await service.captureCampaign(campaign.id);
		await service.captureCampaign(campaign.id);

		expect(status).toBe(CampaignStatus.CANCELLED);
		expect(
			transaction.campaignOutboxEvent.createMany
		).not.toHaveBeenCalled();
	});
});
