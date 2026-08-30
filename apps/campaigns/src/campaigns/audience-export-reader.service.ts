import { CampaignsDependenciesClient } from '../internal/campaigns-dependencies.client';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	AudienceSnapshot,
	Campaign,
	CampaignDeliveryChannel
} from '@prisma/campaigns-client';
import { createHash } from 'node:crypto';

const MAX_AUDIENCE_RECIPIENTS = 500_000;
const DEFAULT_IMPORT_BATCH_SIZE = 1000;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ExportedAudienceMetadata {
	sourceSnapshotId: string;
	asOf: Date;
	sha256: string;
	totalCount: number;
	billingSnapshotId: string | null;
	billingSnapshotSha256: string | null;
	billingSnapshotAsOf: Date | null;
}

interface ActiveSubscriberSnapshot {
	snapshotId: string;
	asOf: Date;
	sha256: string;
	userIds: ReadonlySet<string>;
}

@Injectable()
export class AudienceExportReaderService {
	constructor(
		private readonly dependencies: CampaignsDependenciesClient,
		private readonly config: ConfigService
	) {}

	async streamExport(
		campaign: Campaign,
		snapshot: AudienceSnapshot,
		onChunk: (destinations: readonly string[]) => Promise<void>,
		abortSignal: AbortSignal
	): Promise<ExportedAudienceMetadata> {
		const activeSubscribers =
			campaign.audience === 'ACTIVE_SUBSCRIPTION'
				? await this.readActiveSubscriberSnapshot(abortSignal)
				: null;
		const response = await this.dependencies.exportAudience(
			snapshot.channel,
			abortSignal
		);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		const sourceHasher = createHash('sha256');
		const resultHasher = createHash('sha256');
		const batchSize = this.importBatchSize();
		let destinations: string[] = [];
		let totalCount = 0;
		let sourceTotalCount = 0;
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
		let previousSourcePair: {
			destination: string;
			userId: string;
		} | null = null;
		let previousResultDestination: string | null = null;

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
					record.schemaVersion !== 2 ||
					typeof record.snapshotId !== 'string' ||
					!UUID_PATTERN.test(record.snapshotId) ||
					typeof record.asOf !== 'string' ||
					!Number.isFinite(Date.parse(record.asOf))
				) {
					throw new Error('Audience export snapshot header is invalid');
				}
				const criteria = this.record(record.criteria);
				this.exactKeys(criteria, ['channel']);
				if (criteria.channel !== snapshot.channel) {
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
			this.exactKeys(record, ['type', 'userId', 'destination']);
			if (
				record.type !== 'recipient' ||
				typeof record.userId !== 'string' ||
				!record.userId ||
				record.userId.length > 255 ||
				typeof record.destination !== 'string'
			) {
				throw new Error('Audience export recipient is invalid');
			}
			const destination = this.validateDestination(
				snapshot.channel,
				record.destination
			);
			if (
				previousSourcePair !== null &&
				(destination < previousSourcePair.destination ||
					(destination === previousSourcePair.destination &&
						record.userId <= previousSourcePair.userId))
			) {
				throw new Error(
					'Audience export recipients must be sorted and unique by destination and user ID'
				);
			}
			previousSourcePair = {
				destination,
				userId: record.userId
			};
			sourceTotalCount += 1;
			if (sourceTotalCount > MAX_AUDIENCE_RECIPIENTS) {
				throw new Error(
					`Audience export exceeds ${MAX_AUDIENCE_RECIPIENTS} recipients`
				);
			}
			sourceHasher.update(
				`${snapshot.channel}\u0000${destination}\u0000${record.userId}\n`
			);
			if (
				activeSubscribers &&
				!activeSubscribers.userIds.has(record.userId)
			) {
				return;
			}
			if (destination === previousResultDestination) return;
			previousResultDestination = destination;
			totalCount += 1;
			destinations.push(destination);
			resultHasher.update(`${snapshot.channel}\u0000${destination}\n`);
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
		const sourceDigest = sourceHasher.digest('hex');
		if (
			trailer.snapshotId !== header.snapshotId ||
			trailer.totalCount !== sourceTotalCount ||
			trailer.sha256 !== sourceDigest
		) {
			throw new Error(
				'Audience export count or SHA-256 verification failed'
			);
		}
		await flush();
		return {
			sourceSnapshotId: header.snapshotId,
			asOf:
				activeSubscribers && activeSubscribers.asOf > header.asOf
					? activeSubscribers.asOf
					: header.asOf,
			sha256: resultHasher.digest('hex'),
			totalCount,
			billingSnapshotId: activeSubscribers?.snapshotId || null,
			billingSnapshotSha256: activeSubscribers?.sha256 || null,
			billingSnapshotAsOf: activeSubscribers?.asOf || null
		};
	}

	private async readActiveSubscriberSnapshot(
		abortSignal: AbortSignal
	): Promise<ActiveSubscriberSnapshot> {
		const response =
			await this.dependencies.exportActiveSubscriberIds(abortSignal);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		const hasher = createHash('sha256');
		const userIds = new Set<string>();
		let buffer = '';
		let previousUserId: string | null = null;
		let header: { snapshotId: string; asOf: Date } | null = null;
		let trailer: {
			snapshotId: string;
			totalCount: number;
			sha256: string;
		} | null = null;

		const processLine = (line: string) => {
			if (!line) return;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				throw new Error('Active subscriber export contains invalid JSON');
			}
			const record = this.record(value);
			if (!header) {
				this.exactKeys(record, [
					'type',
					'schemaVersion',
					'snapshotId',
					'asOf'
				]);
				if (
					record.type !== 'snapshot' ||
					record.schemaVersion !== 1 ||
					typeof record.snapshotId !== 'string' ||
					!UUID_PATTERN.test(record.snapshotId) ||
					typeof record.asOf !== 'string' ||
					!Number.isFinite(Date.parse(record.asOf))
				) {
					throw new Error('Active subscriber snapshot header is invalid');
				}
				header = {
					snapshotId: record.snapshotId,
					asOf: new Date(record.asOf)
				};
				return;
			}
			if (record.type === 'complete') {
				if (trailer) {
					throw new Error('Active subscriber export has two trailers');
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
					throw new Error('Active subscriber snapshot trailer is invalid');
				}
				trailer = {
					snapshotId: record.snapshotId,
					totalCount: record.totalCount,
					sha256: record.sha256
				};
				return;
			}
			if (trailer) {
				throw new Error('Active subscriber export has data after trailer');
			}
			this.exactKeys(record, ['type', 'userId']);
			if (
				record.type !== 'subscriber' ||
				typeof record.userId !== 'string' ||
				!record.userId ||
				record.userId.length > 255 ||
				(previousUserId !== null && record.userId <= previousUserId)
			) {
				throw new Error('Active subscriber record is invalid');
			}
			previousUserId = record.userId;
			userIds.add(record.userId);
			if (userIds.size > MAX_AUDIENCE_RECIPIENTS) {
				throw new Error(
					`Active subscriber export exceeds ${MAX_AUDIENCE_RECIPIENTS} users`
				);
			}
			hasher.update(`${record.userId}\n`, 'utf8');
		};

		try {
			for (;;) {
				const chunk = await reader.read();
				buffer += decoder.decode(chunk.value, { stream: !chunk.done });
				let newline = buffer.indexOf('\n');
				while (newline >= 0) {
					processLine(buffer.slice(0, newline).replace(/\r$/, ''));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf('\n');
				}
				if (chunk.done) break;
			}
			if (buffer) processLine(buffer.replace(/\r$/, ''));
		} catch (error) {
			await reader.cancel().catch(() => undefined);
			throw error;
		} finally {
			reader.releaseLock();
		}

		const digest = hasher.digest('hex');
		const completedHeader = header as {
			snapshotId: string;
			asOf: Date;
		} | null;
		const completedTrailer = trailer as {
			snapshotId: string;
			totalCount: number;
			sha256: string;
		} | null;
		if (
			!completedHeader ||
			!completedTrailer ||
			completedTrailer.snapshotId !== completedHeader.snapshotId ||
			completedTrailer.totalCount !== userIds.size ||
			completedTrailer.sha256 !== digest
		) {
			throw new Error(
				'Active subscriber snapshot count or SHA-256 verification failed'
			);
		}
		return {
			snapshotId: completedHeader.snapshotId,
			asOf: completedHeader.asOf,
			sha256: digest,
			userIds
		};
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
