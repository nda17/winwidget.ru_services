import { CoreInternalClient } from '../internal/core-internal.client';
import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	REPORTING_PROJECTION_STREAMS,
	ReportingProjectionStream,
	ReportingSourceEvent,
	parseReportingSourceEvent,
	sourceEventTypeToStream
} from '../projections/reporting-event.contract';
import {
	ProjectionApplySummary,
	ProjectionService
} from '../projections/projection.service';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import { Injectable, Logger } from '@nestjs/common';
import {
	Prisma,
	ReportingBackfillRun,
	ReportingBackfillStatus
} from '@prisma/reporting-client';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,64})$/;
const BATCH_SIZE = 100;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;
const BACKFILL_LEASE_MS = 5 * 60 * 1000;

interface SnapshotHeader {
	schemaVersion: 1;
	kind: 'header';
	snapshotId: string;
	watermarks: Record<ReportingProjectionStream, string>;
}

interface SnapshotRecord {
	schemaVersion: 1;
	kind: 'record';
	stream: ReportingProjectionStream;
	event: ReportingSourceEvent;
}

interface SnapshotFooter {
	schemaVersion: 1;
	kind: 'footer';
	snapshotId: string;
	recordCount: number;
	sha256: string;
}

export interface ReportingBackfillResult extends ProjectionApplySummary {
	snapshotId: string;
	recordCount: number;
	sha256: string;
	counts: Record<ReportingProjectionStream, number>;
	watermarks: Record<ReportingProjectionStream, string>;
}

interface BackfillClaim {
	snapshotId: string;
	lockToken: string;
}

class AlreadyVerifiedSnapshot extends Error {
	constructor(readonly result: ReportingBackfillResult) {
		super('Snapshot is already verified');
	}
}

@Injectable()
export class ReportingBackfillService {
	private readonly logger = new Logger(ReportingBackfillService.name);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;

	constructor(
		private readonly core: CoreInternalClient,
		private readonly projections: ProjectionService,
		private readonly runtime: ReportingRuntimeService,
		private readonly metrics: ReportingMetricsService,
		private readonly prisma: ReportingPrismaService
	) {}

	async run(): Promise<ReportingBackfillResult> {
		if (!this.runtime.backfillEnabled) {
			throw new Error(
				'Reporting backfill requires REPORTING_PROCESS_ROLE=backfill'
			);
		}
		const response = await this.core.openProjectionSnapshot();
		const result = await this.importResponse(response);
		this.metrics.increment('backfill_records_total', result.recordCount);
		this.logger.log(
			`Reporting backfill verified snapshotId=${result.snapshotId} records=${result.recordCount} sha256=${result.sha256}`
		);
		return result;
	}

	async importResponse(
		response: Response
	): Promise<ReportingBackfillResult> {
		if (!response.body) throw new Error('Snapshot response has no body');
		const reader = response.body.getReader();
		const spoolDirectory = await mkdtemp(
			join(tmpdir(), 'winwidget-reporting-backfill-')
		);
		await chmod(spoolDirectory, 0o700);
		const spoolPath = join(spoolDirectory, 'verified-records.ndjson');
		const spool = await open(spoolPath, 'wx', 0o600);
		let spoolClosed = false;
		let pending = Buffer.alloc(0);
		let header: SnapshotHeader | null = null;
		let footer: SnapshotFooter | null = null;
		let claim: BackfillClaim | null = null;
		let recordCount = 0;
		let spooledBytes = 0;
		let computedDigest: string | null = null;
		const hash = createHash('sha256');
		const summary: ProjectionApplySummary = {
			applied: 0,
			duplicate: 0,
			stale: 0
		};
		const counts = Object.fromEntries(
			REPORTING_PROJECTION_STREAMS.map(stream => [stream, 0])
		) as Record<ReportingProjectionStream, number>;

		const processLine = async (lineWithNewline: Buffer): Promise<void> => {
			if (lineWithNewline.length > MAX_LINE_BYTES) {
				throw new Error('Snapshot NDJSON line is too large');
			}
			const content = lineWithNewline.subarray(
				0,
				lineWithNewline.length - 1
			);
			if (!content.length || content.includes(0x0d)) {
				throw new Error('Snapshot must use non-empty LF-delimited NDJSON');
			}
			let value: unknown;
			try {
				value = JSON.parse(
					new TextDecoder('utf-8', { fatal: true }).decode(content)
				);
			} catch {
				throw new Error('Snapshot contains invalid UTF-8 JSON');
			}
			if (!header) {
				header = this.parseHeader(value);
				const acquired = await this.claimSnapshot(header);
				if (acquired instanceof AlreadyVerifiedSnapshot) throw acquired;
				claim = acquired;
				spooledBytes += lineWithNewline.length;
				if (spooledBytes > MAX_SNAPSHOT_BYTES) {
					throw new Error('Snapshot exceeds the bounded spool size');
				}
				await spool.writeFile(lineWithNewline);
				hash.update(lineWithNewline);
				return;
			}
			if (footer) throw new Error('Snapshot contains data after footer');
			const kind = this.recordKind(value);
			if (kind === 'footer') {
				footer = this.parseFooter(value);
				return;
			}
			const record = this.parseRecord(value);
			spooledBytes += lineWithNewline.length;
			if (spooledBytes > MAX_SNAPSHOT_BYTES) {
				throw new Error('Snapshot exceeds the bounded spool size');
			}
			await spool.writeFile(lineWithNewline);
			hash.update(lineWithNewline);
			recordCount += 1;
			counts[record.stream] += 1;
			if (claim && recordCount % BATCH_SIZE === 0) {
				await this.checkpoint(claim, counts, recordCount, summary);
			}
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (value?.length) {
					pending = Buffer.concat([pending, Buffer.from(value)]);
					if (pending.length > MAX_LINE_BYTES && !pending.includes(0x0a)) {
						throw new Error('Snapshot NDJSON line is too large');
					}
					let newline = pending.indexOf(0x0a);
					while (newline >= 0) {
						const line = pending.subarray(0, newline + 1);
						pending = pending.subarray(newline + 1);
						await processLine(line);
						newline = pending.indexOf(0x0a);
					}
				}
				if (done) break;
			}
			if (pending.length) {
				throw new Error('Snapshot footer must end with an LF delimiter');
			}
			const verifiedHeader = header as SnapshotHeader | null;
			const verifiedFooter = footer as SnapshotFooter | null;
			if (!verifiedHeader || !verifiedFooter || !claim) {
				throw new Error('Snapshot header or footer is missing');
			}
			if (verifiedFooter.snapshotId !== verifiedHeader.snapshotId) {
				throw new Error('Snapshot footer snapshotId mismatch');
			}
			if (verifiedFooter.recordCount !== recordCount) {
				throw new Error(
					`Snapshot record count mismatch expected=${verifiedFooter.recordCount} actual=${recordCount}`
				);
			}
			computedDigest = hash.digest('hex');
			if (verifiedFooter.sha256 !== computedDigest) {
				throw new Error('Snapshot SHA-256 mismatch');
			}
			await spool.sync();
			await spool.close();
			spoolClosed = true;
			const spooledDigest = await this.fileSha256(spoolPath);
			if (spooledDigest !== computedDigest) {
				throw new Error('Snapshot spool SHA-256 mismatch');
			}

			// No projection row is mutated until the complete transport and the local
			// durable spool have both passed their checksums. A corrupt late record can
			// therefore never poison an aggregateVersion before verification.
			await this.applyVerifiedSpool(
				spoolPath,
				claim,
				counts,
				recordCount,
				summary
			);
			const result = {
				snapshotId: verifiedHeader.snapshotId,
				recordCount,
				sha256: computedDigest,
				counts,
				watermarks: verifiedHeader.watermarks,
				...summary
			};
			await this.verify(claim, verifiedFooter.sha256, result);
			return result;
		} catch (error) {
			if (error instanceof AlreadyVerifiedSnapshot) {
				await reader.cancel().catch(() => undefined);
				return error.result;
			}
			if (claim && header) {
				const partialDigest = computedDigest || hash.copy().digest('hex');
				const failedFooter = footer as SnapshotFooter | null;
				await this.fail(
					claim,
					header,
					counts,
					recordCount,
					summary,
					partialDigest,
					failedFooter?.sha256 || null,
					error
				).catch(persistError =>
					this.logger.error(
						`Could not persist failed backfill snapshotId=${claim!.snapshotId}: ${this.error(persistError)}`
					)
				);
			}
			throw error;
		} finally {
			if (!spoolClosed) await spool.close().catch(() => undefined);
			await rm(spoolDirectory, { recursive: true, force: true }).catch(
				() => undefined
			);
		}
	}

	private async fileSha256(path: string): Promise<string> {
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(path)) {
			hash.update(chunk as Buffer);
		}
		return hash.digest('hex');
	}

	private async applyVerifiedSpool(
		path: string,
		claim: BackfillClaim,
		counts: Record<ReportingProjectionStream, number>,
		expectedRecordCount: number,
		summary: ProjectionApplySummary
	): Promise<void> {
		const batch: ReportingSourceEvent[] = [];
		let promotedCount = 0;
		const flush = async (): Promise<void> => {
			if (!batch.length) return;
			const applied = await this.projections.applyBatch(batch.splice(0));
			summary.applied += applied.applied;
			summary.duplicate += applied.duplicate;
			summary.stale += applied.stale;
			await this.checkpoint(claim, counts, expectedRecordCount, summary);
		};

		const lines = createInterface({
			input: createReadStream(path, { encoding: 'utf8' }),
			crlfDelay: Infinity
		});
		let headerSeen = false;
		try {
			for await (const line of lines) {
				if (!line)
					throw new Error(
						'Verified snapshot spool contains an empty line'
					);
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					throw new Error('Verified snapshot spool contains invalid JSON');
				}
				if (!headerSeen) {
					this.parseHeader(value);
					headerSeen = true;
					continue;
				}
				batch.push(this.parseRecord(value).event);
				promotedCount += 1;
				if (batch.length >= BATCH_SIZE) await flush();
			}
			await flush();
		} finally {
			lines.close();
		}
		if (!headerSeen) {
			throw new Error('Verified snapshot spool header is missing');
		}
		if (promotedCount !== expectedRecordCount) {
			throw new Error(
				`Snapshot spool record count mismatch expected=${expectedRecordCount} actual=${promotedCount}`
			);
		}
	}

	private async claimSnapshot(
		header: SnapshotHeader
	): Promise<BackfillClaim | AlreadyVerifiedSnapshot> {
		const now = new Date();
		const lockToken = randomUUID();
		const data = {
			status: ReportingBackfillStatus.RUNNING,
			watermarks: header.watermarks as Prisma.InputJsonObject,
			counts: this.emptyCounts() as Prisma.InputJsonObject,
			recordCount: 0,
			appliedCount: 0,
			duplicateCount: 0,
			staleCount: 0,
			sha256: null,
			expectedSha256: null,
			lockedBy: this.workerId,
			lockToken,
			leaseExpiresAt: new Date(now.getTime() + BACKFILL_LEASE_MS),
			lastError: null,
			startedAt: now,
			verifiedAt: null,
			failedAt: null
		};
		try {
			await this.prisma.reportingBackfillRun.create({
				data: { snapshotId: header.snapshotId, ...data }
			});
			return { snapshotId: header.snapshotId, lockToken };
		} catch (error) {
			if (!this.isUniqueViolation(error)) throw error;
		}
		const existing = await this.prisma.reportingBackfillRun.findUnique({
			where: { snapshotId: header.snapshotId }
		});
		if (!existing)
			throw new Error('Backfill run disappeared after conflict');
		if (existing.status === ReportingBackfillStatus.VERIFIED) {
			return new AlreadyVerifiedSnapshot(this.resultFromRun(existing));
		}
		const claimed = await this.prisma.reportingBackfillRun.updateMany({
			where: {
				snapshotId: header.snapshotId,
				OR: [
					{ status: ReportingBackfillStatus.FAILED },
					{
						status: ReportingBackfillStatus.RUNNING,
						leaseExpiresAt: { lte: now }
					}
				]
			},
			data
		});
		if (claimed.count !== 1) {
			throw new Error(
				`Backfill snapshot ${header.snapshotId} is already being imported`
			);
		}
		return { snapshotId: header.snapshotId, lockToken };
	}

	private async checkpoint(
		claim: BackfillClaim,
		counts: Record<ReportingProjectionStream, number>,
		recordCount: number,
		summary: ProjectionApplySummary
	): Promise<void> {
		const updated = await this.prisma.reportingBackfillRun.updateMany({
			where: {
				snapshotId: claim.snapshotId,
				status: ReportingBackfillStatus.RUNNING,
				lockedBy: this.workerId,
				lockToken: claim.lockToken
			},
			data: {
				counts: counts as Prisma.InputJsonObject,
				recordCount,
				appliedCount: summary.applied,
				duplicateCount: summary.duplicate,
				staleCount: summary.stale,
				leaseExpiresAt: new Date(Date.now() + BACKFILL_LEASE_MS)
			}
		});
		if (updated.count !== 1) throw new Error('Backfill lease was lost');
	}

	private async verify(
		claim: BackfillClaim,
		expectedSha256: string,
		result: ReportingBackfillResult
	): Promise<void> {
		const verified = await this.prisma.reportingBackfillRun.updateMany({
			where: {
				snapshotId: claim.snapshotId,
				status: ReportingBackfillStatus.RUNNING,
				lockedBy: this.workerId,
				lockToken: claim.lockToken
			},
			data: {
				status: ReportingBackfillStatus.VERIFIED,
				counts: result.counts as Prisma.InputJsonObject,
				recordCount: result.recordCount,
				appliedCount: result.applied,
				duplicateCount: result.duplicate,
				staleCount: result.stale,
				sha256: result.sha256,
				expectedSha256,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				verifiedAt: new Date()
			}
		});
		if (verified.count !== 1) {
			throw new Error('Backfill verification lease was lost');
		}
	}

	private async fail(
		claim: BackfillClaim,
		header: SnapshotHeader,
		counts: Record<ReportingProjectionStream, number>,
		recordCount: number,
		summary: ProjectionApplySummary,
		sha256: string,
		expectedSha256: string | null,
		error: unknown
	): Promise<void> {
		await this.prisma.reportingBackfillRun.updateMany({
			where: {
				snapshotId: claim.snapshotId,
				status: ReportingBackfillStatus.RUNNING,
				lockedBy: this.workerId,
				lockToken: claim.lockToken
			},
			data: {
				status: ReportingBackfillStatus.FAILED,
				watermarks: header.watermarks as Prisma.InputJsonObject,
				counts: counts as Prisma.InputJsonObject,
				recordCount,
				appliedCount: summary.applied,
				duplicateCount: summary.duplicate,
				staleCount: summary.stale,
				sha256,
				expectedSha256,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				lastError: this.error(error).slice(0, 4000),
				failedAt: new Date()
			}
		});
	}

	private resultFromRun(
		run: ReportingBackfillRun
	): ReportingBackfillResult {
		if (!run.sha256) throw new Error('Verified backfill has no checksum');
		return {
			snapshotId: run.snapshotId,
			recordCount: run.recordCount,
			sha256: run.sha256.trim(),
			counts: this.parseCounts(run.counts),
			watermarks: this.parseWatermarks(run.watermarks),
			applied: run.appliedCount,
			duplicate: run.duplicateCount,
			stale: run.staleCount
		};
	}

	private emptyCounts(): Record<ReportingProjectionStream, number> {
		return Object.fromEntries(
			REPORTING_PROJECTION_STREAMS.map(stream => [stream, 0])
		) as Record<ReportingProjectionStream, number>;
	}

	private parseCounts(
		value: Prisma.JsonValue
	): Record<ReportingProjectionStream, number> {
		const record = this.exactRecord(value, REPORTING_PROJECTION_STREAMS);
		for (const stream of REPORTING_PROJECTION_STREAMS) {
			if (
				!Number.isSafeInteger(record[stream]) ||
				Number(record[stream]) < 0
			) {
				throw new Error('Persisted backfill counts are invalid');
			}
		}
		return record as unknown as Record<ReportingProjectionStream, number>;
	}

	private parseWatermarks(
		value: Prisma.JsonValue
	): Record<ReportingProjectionStream, string> {
		const record = this.exactRecord(value, REPORTING_PROJECTION_STREAMS);
		for (const stream of REPORTING_PROJECTION_STREAMS) {
			this.assertDecimal(record[stream], `watermarks.${stream}`);
		}
		return record as unknown as Record<ReportingProjectionStream, string>;
	}

	private isUniqueViolation(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private parseHeader(value: unknown): SnapshotHeader {
		const record = this.exactRecord(value, [
			'schemaVersion',
			'kind',
			'snapshotId',
			'watermarks'
		]);
		if (record.schemaVersion !== 1 || record.kind !== 'header') {
			throw new Error('Snapshot must start with a v1 header');
		}
		this.assertUuid(record.snapshotId, 'header.snapshotId');
		const watermarks = this.exactRecord(
			record.watermarks,
			REPORTING_PROJECTION_STREAMS
		);
		for (const stream of REPORTING_PROJECTION_STREAMS) {
			this.assertDecimal(
				watermarks[stream],
				`header.watermarks.${stream}`
			);
		}
		return record as unknown as SnapshotHeader;
	}

	private parseRecord(value: unknown): SnapshotRecord {
		const record = this.exactRecord(value, [
			'schemaVersion',
			'kind',
			'stream',
			'event'
		]);
		if (
			record.schemaVersion !== 1 ||
			record.kind !== 'record' ||
			typeof record.stream !== 'string' ||
			!REPORTING_PROJECTION_STREAMS.includes(
				record.stream as ReportingProjectionStream
			)
		) {
			throw new Error('Snapshot record metadata is invalid');
		}
		const event = parseReportingSourceEvent(record.event, undefined, {
			allowZeroVersion: true
		});
		if (sourceEventTypeToStream(event.eventType) !== record.stream) {
			throw new Error('Snapshot record stream does not match eventType');
		}
		return { ...record, event } as unknown as SnapshotRecord;
	}

	private parseFooter(value: unknown): SnapshotFooter {
		const record = this.exactRecord(value, [
			'schemaVersion',
			'kind',
			'snapshotId',
			'recordCount',
			'sha256'
		]);
		if (record.schemaVersion !== 1 || record.kind !== 'footer') {
			throw new Error('Snapshot footer is invalid');
		}
		this.assertUuid(record.snapshotId, 'footer.snapshotId');
		if (
			!Number.isSafeInteger(record.recordCount) ||
			Number(record.recordCount) < 0
		) {
			throw new Error('footer.recordCount is invalid');
		}
		if (
			typeof record.sha256 !== 'string' ||
			!/^[0-9a-f]{64}$/.test(record.sha256)
		) {
			throw new Error('footer.sha256 is invalid');
		}
		return record as unknown as SnapshotFooter;
	}

	private recordKind(value: unknown): unknown {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>).kind
			: null;
	}

	private exactRecord(
		value: unknown,
		keys: readonly string[]
	): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Snapshot item must be an object');
		}
		const record = value as Record<string, unknown>;
		const actual = Object.keys(record).sort();
		const expected = [...keys].sort();
		if (
			actual.length !== expected.length ||
			actual.some((key, index) => key !== expected[index])
		) {
			throw new Error('Snapshot item contains invalid keys');
		}
		return record;
	}

	private assertUuid(
		value: unknown,
		field: string
	): asserts value is string {
		if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
			throw new Error(`${field} must be a UUID`);
		}
	}

	private assertDecimal(
		value: unknown,
		field: string
	): asserts value is string {
		if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
			throw new Error(`${field} must be a non-negative decimal string`);
		}
	}
}
