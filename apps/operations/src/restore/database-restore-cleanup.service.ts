import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus
} from '@prisma/operations-client';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';

const CLEANUP_STATUSES = [
	DatabaseRestoreJobStatus.SUCCEEDED,
	DatabaseRestoreJobStatus.FAILED,
	DatabaseRestoreJobStatus.CANCELLED
] as const;
const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1_000;
const ORPHAN_DB_LOOKUP_BATCH_SIZE = 250;
const UUID_PART =
	'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SOURCE_ARTIFACT_PATTERN = new RegExp(`^(${UUID_PART})\\.dump$`, 'i');
const SAFETY_ARTIFACT_PATTERN = new RegExp(
	`^(${UUID_PART})\\.dump\\.safety$`,
	'i'
);
const TEMPORARY_ARTIFACT_PATTERN = new RegExp(
	`^(${UUID_PART})\\.dump\\.${UUID_PART}\\.tmp$`,
	'i'
);

export interface DatabaseRestoreCleanupJob {
	id: string;
	status: DatabaseRestoreJobStatus;
	phase: DatabaseRestoreJobPhase | null;
	recoveryResolvedAt: Date | null;
	artifactRetainUntil: Date | null;
	sourceDeletedAt: Date | null;
	safetyDeletedAt: Date | null;
}

@Injectable()
export class DatabaseRestoreCleanupService {
	private readonly logger = new Logger(DatabaseRestoreCleanupService.name);

	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly config: ConfigService
	) {}

	async pending(limit: number): Promise<DatabaseRestoreCleanupJob[]> {
		return this.prisma.databaseRestoreJob.findMany({
			where: {
				OR: [
					{
						status: DatabaseRestoreJobStatus.SUCCEEDED,
						sourceDeletedAt: null
					},
					{
						status: DatabaseRestoreJobStatus.SUCCEEDED,
						safetyDeletedAt: null,
						artifactRetainUntil: { lte: new Date() }
					},
					{
						status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
						recoveryResolvedAt: { not: null },
						artifactRetainUntil: { lte: new Date() },
						OR: [{ sourceDeletedAt: null }, { safetyDeletedAt: null }]
					},
					{
						AND: [
							{
								OR: [
									{
										status: DatabaseRestoreJobStatus.FAILED,
										phase: {
											in: [
												DatabaseRestoreJobPhase.PREPARING,
												DatabaseRestoreJobPhase.SAFETY_READY
											]
										}
									},
									{ status: DatabaseRestoreJobStatus.CANCELLED }
								]
							},
							{
								OR: [{ sourceDeletedAt: null }, { safetyDeletedAt: null }]
							}
						]
					}
				]
			},
			orderBy: { updatedAt: 'asc' },
			take: limit,
			select: {
				id: true,
				status: true,
				phase: true,
				recoveryResolvedAt: true,
				artifactRetainUntil: true,
				sourceDeletedAt: true,
				safetyDeletedAt: true
			}
		});
	}

	async cleanup(input: {
		id: string;
		status: DatabaseRestoreJobStatus;
		phase: DatabaseRestoreJobPhase | null;
		recoveryResolvedAt?: Date | null;
		artifactRetainUntil?: Date | null;
		sourceDeletedAt?: Date | null;
		safetyDeletedAt?: Date | null;
		source: string;
		stagingSource?: string;
	}): Promise<void> {
		if (!this.shouldCleanup(input)) return;
		const deleteSafety =
			input.status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED ||
			(input.status === DatabaseRestoreJobStatus.SUCCEEDED &&
				Boolean(
					input.artifactRetainUntil &&
					input.artifactRetainUntil.getTime() <= Date.now()
				)) ||
			(input.status === DatabaseRestoreJobStatus.FAILED &&
				this.isProvenPreMutation(input.phase)) ||
			input.status === DatabaseRestoreJobStatus.CANCELLED;
		const sourceResult = input.sourceDeletedAt
			? { deletedAt: null, error: null }
			: await this.removeSourceArtifacts(
					input.source,
					input.stagingSource
				);
		const safetyResult =
			deleteSafety && !input.safetyDeletedAt
				? await this.removeArtifact(`${input.source}.safety`)
				: { deletedAt: null, error: null };
		const cleanupError = [sourceResult.error, safetyResult.error]
			.filter((value): value is string => Boolean(value))
			.join('; ');
		try {
			const updated = await this.prisma.databaseRestoreJob.updateMany({
				where: {
					id: input.id,
					status: input.status,
					...(input.status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED
						? {
								recoveryResolvedAt: { not: null },
								artifactRetainUntil: { lte: new Date() }
							}
						: {}),
					...(input.status === DatabaseRestoreJobStatus.SUCCEEDED &&
					deleteSafety
						? { artifactRetainUntil: { lte: new Date() } }
						: {})
				},
				data: {
					...(sourceResult.deletedAt
						? { sourceDeletedAt: sourceResult.deletedAt }
						: {}),
					...(safetyResult.deletedAt
						? { safetyDeletedAt: safetyResult.deletedAt }
						: {}),
					cleanupError: cleanupError || null
				}
			});
			if (updated.count !== 1) {
				this.logger.warn(
					`Database restore cleanup evidence CAS lost jobId=${input.id}`
				);
			}
		} catch (error) {
			this.logger.error(
				`Database restore cleanup evidence failed jobId=${input.id}: ${this.safeError(error)}`
			);
		}
	}

	async recordError(
		id: string,
		status: DatabaseRestoreJobStatus,
		error: unknown
	): Promise<void> {
		try {
			await this.prisma.databaseRestoreJob.updateMany({
				where: { id, status },
				data: { cleanupError: this.safeError(error) }
			});
		} catch (persistenceError) {
			this.logger.error(
				`Database restore cleanup error evidence failed jobId=${id}: ${this.safeError(persistenceError)}`
			);
		}
	}

	async sweepOrphans(limit: number): Promise<number> {
		if (!Number.isInteger(limit) || limit < 1) return 0;
		const directories = await this.artifactDirectories();
		const candidates: Array<{
			path: string;
			jobId: string;
			kind: 'source' | 'safety' | 'temporary';
		}> = [];
		const cutoff = Date.now() - ORPHAN_RETENTION_MS;
		for (const directory of directories) {
			for (const name of (await readdir(directory.path)).sort()) {
				const parsed = this.parseArtifactName(name, directory.sealed);
				if (!parsed) continue;
				const path = join(directory.path, name);
				let state;
				try {
					state = await lstat(path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
					throw error;
				}
				if (state.isDirectory() || state.mtimeMs > cutoff) continue;
				candidates.push({ path, ...parsed });
			}
		}
		if (candidates.length === 0) return 0;
		let removed = 0;
		for (
			let offset = 0;
			offset < candidates.length && removed < limit;
			offset += ORPHAN_DB_LOOKUP_BATCH_SIZE
		) {
			const batch = candidates.slice(
				offset,
				offset + ORPHAN_DB_LOOKUP_BATCH_SIZE
			);
			const jobs = await this.prisma.databaseRestoreJob.findMany({
				where: {
					id: { in: Array.from(new Set(batch.map(item => item.jobId))) }
				},
				select: {
					id: true,
					status: true,
					phase: true,
					recoveryResolvedAt: true,
					artifactRetainUntil: true,
					sourceDeletedAt: true,
					safetyDeletedAt: true
				}
			});
			const jobsById = new Map(jobs.map(job => [job.id, job]));
			for (const candidate of batch) {
				if (removed >= limit) break;
				const job = jobsById.get(candidate.jobId);
				// Absence of a job is not proof that an upload transaction rolled
				// back: its backend may still be blocked or completing an ambiguous
				// commit. Keep durable source/safety bytes until an explicit intent
				// contract can prove they are orphaned. Worker-only temporary files do
				// not have this enqueue race and remain age-cleanable.
				if (!job && candidate.kind !== 'temporary') continue;
				if (job && !this.canRemoveOrphan(candidate.kind, job)) continue;
				const result = await this.removeArtifact(candidate.path);
				if (result.deletedAt) removed += 1;
				else if (result.error) {
					this.logger.warn(
						`Database restore orphan cleanup failed file=${this.safeFileName(candidate.path)}: ${result.error}`
					);
				}
			}
		}
		return removed;
	}

	private async removeArtifact(path: string): Promise<{
		deletedAt: Date | null;
		error: string | null;
	}> {
		try {
			await rm(path, { force: true });
			await this.syncParentDirectory(path);
			return { deletedAt: new Date(), error: null };
		} catch (error) {
			return { deletedAt: null, error: this.safeError(error) };
		}
	}

	private async artifactDirectories(): Promise<
		Array<{ path: string; sealed: boolean }>
	> {
		const configured = [
			{
				key: 'DATABASE_RESTORE_STAGING_DIR',
				value: this.config
					.get<string>('DATABASE_RESTORE_STAGING_DIR')
					?.trim(),
				sealed: false
			},
			{
				key: 'DATABASE_RESTORE_SEALED_DIR',
				value: this.config
					.get<string>('DATABASE_RESTORE_SEALED_DIR')
					?.trim(),
				sealed: true
			}
		];
		const states = [];
		for (const directory of configured) {
			if (
				!directory.value ||
				!isAbsolute(directory.value) ||
				directory.value === '/'
			) {
				throw new Error(
					`${directory.key} is not configured for orphan cleanup`
				);
			}
			const state = await lstat(directory.value);
			if (!state.isDirectory() || state.isSymbolicLink()) {
				throw new Error(`${directory.key} must be a real directory`);
			}
			states.push(state);
		}
		if (
			states[0].dev === states[1].dev &&
			states[0].ino === states[1].ino
		) {
			throw new Error(
				'Restore staging and sealed paths must not share filesystem directory identity'
			);
		}
		const staging = await realpath(configured[0].value!);
		const sealed = await realpath(configured[1].value!);
		if (this.directoriesOverlap(staging, sealed)) {
			throw new Error(
				'Restore staging and sealed directories must be distinct non-nested paths'
			);
		}
		return [
			{ path: staging, sealed: false },
			{ path: sealed, sealed: true }
		];
	}

	private parseArtifactName(
		name: string,
		sealed: boolean
	): {
		jobId: string;
		kind: 'source' | 'safety' | 'temporary';
	} | null {
		const temporary = sealed
			? TEMPORARY_ARTIFACT_PATTERN.exec(name)
			: null;
		if (temporary) return { jobId: temporary[1], kind: 'temporary' };
		const safety = sealed ? SAFETY_ARTIFACT_PATTERN.exec(name) : null;
		if (safety) return { jobId: safety[1], kind: 'safety' };
		const source = SOURCE_ARTIFACT_PATTERN.exec(name);
		return source ? { jobId: source[1], kind: 'source' } : null;
	}

	private canRemoveOrphan(
		kind: 'source' | 'safety' | 'temporary',
		job: {
			status: DatabaseRestoreJobStatus;
			phase: DatabaseRestoreJobPhase | null;
			recoveryResolvedAt: Date | null;
			artifactRetainUntil: Date | null;
			sourceDeletedAt: Date | null;
			safetyDeletedAt: Date | null;
		}
	): boolean {
		if (kind === 'temporary') {
			return job.status !== DatabaseRestoreJobStatus.PROCESSING;
		}
		if (kind === 'source' && job.sourceDeletedAt) return true;
		if (kind === 'safety' && job.safetyDeletedAt) return true;
		if (job.status === DatabaseRestoreJobStatus.SUCCEEDED) {
			return (
				kind === 'source' ||
				Boolean(
					job.artifactRetainUntil &&
					job.artifactRetainUntil.getTime() <= Date.now()
				)
			);
		}
		if (job.status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED) {
			return Boolean(
				job.recoveryResolvedAt &&
				job.artifactRetainUntil &&
				job.artifactRetainUntil.getTime() <= Date.now()
			);
		}
		return (
			job.status === DatabaseRestoreJobStatus.CANCELLED ||
			(job.status === DatabaseRestoreJobStatus.FAILED &&
				this.isProvenPreMutation(job.phase))
		);
	}

	private async syncParentDirectory(path: string): Promise<void> {
		const handle = await open(dirname(path), 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private directoriesOverlap(first: string, second: string): boolean {
		const isWithin = (base: string, candidate: string) => {
			const path = relative(base, candidate);
			return (
				path === '' ||
				(path !== '..' &&
					!path.startsWith(`..${sep}`) &&
					!isAbsolute(path))
			);
		};
		return isWithin(first, second) || isWithin(second, first);
	}

	private safeFileName(path: string): string {
		return path.slice(
			Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1
		);
	}

	private async removeSourceArtifacts(
		sealedPath: string,
		stagingPath?: string
	): Promise<{ deletedAt: Date | null; error: string | null }> {
		const paths = Array.from(
			new Set(
				[sealedPath, stagingPath].filter(
					(value): value is string => !!value
				)
			)
		);
		const results = [];
		for (const path of paths)
			results.push(await this.removeArtifact(path));
		const error = results
			.map(result => result.error)
			.filter((value): value is string => Boolean(value))
			.join('; ');
		return {
			deletedAt: error ? null : new Date(),
			error: error || null
		};
	}

	private shouldCleanup(input: {
		status: DatabaseRestoreJobStatus;
		phase: DatabaseRestoreJobPhase | null;
		recoveryResolvedAt?: Date | null;
		artifactRetainUntil?: Date | null;
	}): boolean {
		if (input.status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED) {
			return Boolean(
				input.recoveryResolvedAt &&
				input.artifactRetainUntil &&
				input.artifactRetainUntil.getTime() <= Date.now()
			);
		}
		if (
			!CLEANUP_STATUSES.includes(
				input.status as (typeof CLEANUP_STATUSES)[number]
			)
		) {
			return false;
		}
		return (
			input.status !== DatabaseRestoreJobStatus.FAILED ||
			this.isProvenPreMutation(input.phase)
		);
	}

	private isProvenPreMutation(
		phase: DatabaseRestoreJobPhase | null
	): boolean {
		return (
			phase === DatabaseRestoreJobPhase.PREPARING ||
			phase === DatabaseRestoreJobPhase.SAFETY_READY
		);
	}

	private safeError(error: unknown): string {
		return (error instanceof Error ? error.message : String(error))
			.replace(/[\r\n]+/g, ' ')
			.slice(0, 2_000);
	}
}
