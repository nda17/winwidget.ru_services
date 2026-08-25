import {
	DatabaseRestoreCommandRunner,
	DatabaseRestoreFileSystem
} from '@/database-restore-worker/database-restore-worker.adapters';
import {
	DatabaseRestoreTargetConfig,
	DatabaseRestoreWorkerConfig
} from '@/database-restore-worker/database-restore-worker.config';
import {
	assertDatabaseRestoreTableOfContents,
	assertExactDatabaseMigrations,
	buildDatabaseConnectionPreflightSql,
	buildDatabaseFenceSql,
	buildDatabaseOwnershipAndAclRepairSql,
	buildDatabasePreReopenVerificationSql,
	buildDatabaseReopenSql,
	buildMigrationLedgerQuery,
	parseDatabaseMigrationRows
} from '@/database-restore-worker/database-restore-postgres';
import {
	assertDatabaseRestoreJobManifest,
	canonicalDatabaseRestoreJson,
	DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES,
	DATABASE_RESTORE_PUBLICATION_GRACE_MS,
	DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
	DatabaseRestoreJobError,
	DatabaseRestoreJobPayload,
	DatabaseRestoreJobResult,
	DatabaseRestoreTarget,
	isDatabaseRestoreJobId,
	parseAndVerifyDatabaseRestoreGlobalGate,
	parseAndVerifyDatabaseRestorePublishReceipt,
	parseAndVerifyDatabaseRestoreTargetLock,
	parseAndVerifyDatabaseRestoreTransitionGate,
	signDatabaseRestoreJobPayload,
	signDatabaseRestoreTargetLock,
	SignedDatabaseRestorePublishReceipt,
	SignedDatabaseRestoreJobManifest,
	verifyDatabaseRestoreProductionPermit,
	verifyDatabaseRestoreJobManifest
} from '@/dev-tools/database-restore-queue.contract';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

type RestoreProgressPhase =
	| 'SAFETY_CREATED'
	| 'FENCING'
	| 'FENCED'
	| 'RESTORED'
	| 'REPAIRED'
	| 'VERIFIED'
	| 'REOPENED';

interface RestoreProgressPayload {
	version: 1;
	jobId: string;
	target: DatabaseRestoreTarget;
	phase: RestoreProgressPhase;
	safetyBackupFileName: string | null;
	safetyBackupSha256: string | null;
	restoredAt: string | null;
	verifiedAt: string | null;
	updatedAt: string;
}

interface SignedRestoreProgress extends RestoreProgressPayload {
	signature: string;
}

interface PublicationValidationClaimPayload {
	version: 1;
	kind: 'DATABASE_RESTORE_PUBLICATION_VALIDATION';
	jobId: string;
	target: DatabaseRestoreTarget;
	manifestSignature: string;
	receiptSignature: string;
	appRevision: string;
	validatedAt: string;
}

interface SignedPublicationValidationClaim extends PublicationValidationClaimPayload {
	signature: string;
}

type RestoreStage =
	| 'MANIFEST'
	| 'PREFLIGHT'
	| 'SAFETY_BACKUP'
	| 'FENCE'
	| 'RESTORE'
	| 'ACL_REPAIR'
	| 'VERIFY'
	| 'REOPEN'
	| 'FINALIZE';

type DatabaseRestoreTransitionGateState =
	| 'CANCELLABLE'
	| 'CANCEL_PENDING'
	| 'CANCEL_REQUESTED'
	| 'DESTRUCTIVE';

type DestructiveTransitionResult =
	| 'CLAIMED'
	| 'CANCEL_PENDING'
	| 'CANCEL_REQUESTED';

class RestoreJobFailure extends Error {
	constructor(
		readonly code: string,
		readonly safeMessage: string,
		message = safeMessage
	) {
		super(message);
		this.name = RestoreJobFailure.name;
	}
}

class RestorePublicationPending extends Error {
	constructor(
		readonly code: string,
		readonly safeMessage: string,
		message = safeMessage
	) {
		super(message);
		this.name = RestorePublicationPending.name;
	}
}

const PROGRESS_PHASES: readonly RestoreProgressPhase[] = [
	'FENCING',
	'FENCED',
	'SAFETY_CREATED',
	'RESTORED',
	'REPAIRED',
	'VERIFIED',
	'REOPENED'
];
const MINIMUM_RESTORE_FREE_SPACE_BYTES = 256 * 1024 * 1024;
const RESTORE_SPACE_HEADROOM_BYTES = 256 * 1024 * 1024;

@Injectable()
export class DatabaseRestoreWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(DatabaseRestoreWorkerService.name);
	private timer: NodeJS.Timeout | null = null;
	private stopping = false;
	private activeCycle: Promise<boolean> | null = null;
	private activeAbortController: AbortController | null = null;

	constructor(
		private readonly config: DatabaseRestoreWorkerConfig,
		private readonly fileSystem: DatabaseRestoreFileSystem,
		private readonly commandRunner: DatabaseRestoreCommandRunner
	) {}

	async onModuleInit(): Promise<void> {
		await this.fileSystem.removeFile(this.readinessPath);
		await this.ensureStorageLayout();
		const fencedTargets = await this.validateStartupDependencies();
		await this.fileSystem.atomicWriteJson(this.readinessPath, {
			version: 1,
			revision: this.config.appRevision,
			pid: process.pid,
			startedAt: new Date().toISOString(),
			targets: Object.keys(this.config.targets).sort(),
			fencedTargets
		});
		this.scheduleNextCycle(0);
		this.logger.log('Database restore worker started');
	}

	async beforeApplicationShutdown(): Promise<void> {
		this.stopping = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.activeAbortController?.abort(
			new Error('Database restore worker is shutting down')
		);
		await this.activeCycle?.catch(() => undefined);
		await this.fileSystem.removeFile(this.readinessPath);
	}

	async processNextJob(): Promise<boolean> {
		await this.ensureStorageLayout();
		await this.reconcileCompletedJobLocks();
		const processingJob = await this.findFirstJobManifest(
			this.processingDirectory
		);
		if (processingJob) {
			await this.processManifest(processingJob);
			return true;
		}

		for (const queuedJob of await this.findJobManifests(
			this.queuedDirectory
		)) {
			if (this.config.productionMode) {
				const candidate = await this.readManifestCandidate(queuedJob);
				if (
					verifyDatabaseRestoreJobManifest(
						candidate,
						this.config.queueSecret
					)
				) {
					try {
						await this.validateProductionPublication(candidate);
					} catch (error) {
						if (!(error instanceof RestorePublicationPending)) throw error;
						this.logger.warn(
							`Database restore job ${candidate.jobId} is waiting for publication confirmation: ${error.code}`
						);
						return true;
					}
				}
			}
			const processingPath = this.manifestPath(
				this.processingDirectory,
				queuedJob.jobId
			);
			if (await this.fileSystem.pathExists(processingPath)) continue;
			try {
				await this.fileSystem.rename(queuedJob.path, processingPath);
			} catch (error) {
				if (this.fileSystem.isNodeError(error, 'ENOENT')) continue;
				throw error;
			}
			await this.processManifest({
				jobId: queuedJob.jobId,
				path: processingPath
			});
			return true;
		}

		return false;
	}

	private scheduleNextCycle(delayMs: number): void {
		if (this.stopping) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.activeCycle = this.processNextJob();
			void this.activeCycle
				.catch(error => {
					this.logger.error(
						`Database restore queue cycle failed: ${this.safeErrorText(error)}`
					);
				})
				.finally(() => {
					this.activeCycle = null;
					this.scheduleNextCycle(this.config.pollIntervalMs);
				});
		}, delayMs);
	}

	private async processManifest(input: {
		jobId: string;
		path: string;
	}): Promise<void> {
		if (
			await this.fileSystem.pathExists(
				this.terminalManifestPath(input.jobId)
			)
		) {
			const terminalManifest = await this.readManifestCandidate({
				jobId: input.jobId,
				path: this.terminalManifestPath(input.jobId)
			});
			if (
				!verifyDatabaseRestoreJobManifest(
					terminalManifest,
					this.config.queueSecret
				)
			) {
				throw new Error(
					'Terminal database restore manifest is unauthenticated'
				);
			}
			if (terminalManifest.status !== 'FAILED_FENCED') {
				await this.releaseTargetLock(terminalManifest).catch(error => {
					this.logger.error(
						`Failed to release completed restore lock ${terminalManifest.jobId}: ${this.safeErrorText(error)}`
					);
				});
				await this.releaseGlobalGate(terminalManifest).catch(error => {
					this.logger.error(
						`Failed to release completed global restore gate ${terminalManifest.jobId}: ${this.safeErrorText(error)}`
					);
				});
			}
			if (terminalManifest.status !== 'FAILED_FENCED') {
				await this.fileSystem.removeFile(this.uploadPath(input.jobId));
			}
			await this.cleanupCompletedProcessingFiles(input.jobId);
			return;
		}

		let manifest: SignedDatabaseRestoreJobManifest | null = null;
		let progress: SignedRestoreProgress | null = null;
		let target: DatabaseRestoreTargetConfig | null = null;
		let password: string | null = null;
		let stage: RestoreStage = 'MANIFEST';
		let databaseMayBeFenced = false;
		let fenceIdentityConfirmed = false;
		this.activeAbortController = new AbortController();

		try {
			const candidate = await this.readManifestCandidate(input);
			if (
				!verifyDatabaseRestoreJobManifest(
					candidate,
					this.config.queueSecret
				)
			) {
				throw new RestoreJobFailure(
					'MANIFEST_SIGNATURE_INVALID',
					'Подпись задания восстановления недействительна'
				);
			}
			manifest = candidate;
			await this.validateProductionPublication(manifest);
			manifest = await this.markProcessing(manifest, input.path);
			await this.assertTargetLock(manifest);
			target = this.config.targets[manifest.target];
			password = await this.fileSystem.readSecretFile(target.passwordFile);
			stage = 'FENCE';
			if (
				await this.fileSystem.pathExists(
					this.fenceSentinelPath(manifest.target)
				)
			) {
				databaseMayBeFenced = true;
				await this.readFenceSentinel(manifest.target, manifest.jobId);
				fenceIdentityConfirmed = true;
			}

			stage = 'PREFLIGHT';
			const progressPath = this.progressPath(manifest.jobId);
			if (await this.fileSystem.pathExists(progressPath)) {
				databaseMayBeFenced = true;
				progress = await this.readProgress(progressPath, manifest);
			}
			const initialGateState =
				await this.readTransitionGateState(manifest);
			if (initialGateState === 'CANCEL_PENDING') {
				if (databaseMayBeFenced) {
					throw new Error(
						'Pending cancellation gate conflicts with fenced restore progress'
					);
				}
				this.logger.log(
					`Database restore job ${manifest.jobId} (${manifest.target}) is waiting for cancellation audit`
				);
				return;
			}
			if (initialGateState === 'CANCEL_REQUESTED') {
				if (databaseMayBeFenced) {
					throw new Error(
						'Cancellation gate conflicts with fenced restore progress'
					);
				}
				await this.finishCancelled(manifest);
				this.logger.log(
					`Database restore job ${manifest.jobId} (${manifest.target}) was cancelled before preflight`
				);
				return;
			}
			if (progress?.phase === 'REOPENED') {
				if (
					await this.fileSystem.pathExists(
						this.fenceSentinelPath(manifest.target)
					)
				) {
					throw new Error(
						'Reopened restore progress conflicts with a durable fence sentinel'
					);
				}
				databaseMayBeFenced = false;
				stage = 'FINALIZE';
				await this.finishSucceeded(manifest, progress);
				return;
			}

			const resumePhase = progress?.phase ?? null;
			const resumedFromVerified = resumePhase === 'VERIFIED';
			const restoreMayReplay =
				resumePhase === null ||
				['FENCING', 'FENCED', 'SAFETY_CREATED'].includes(resumePhase);
			const expectedMigrations =
				await this.fileSystem.readMigrationChecksums(
					target.migrationsDirectory
				);
			if (resumePhase === null) {
				await this.validateUploadedDump(manifest, target, password);
				const currentDatabaseSizeBytes =
					await this.preflightTargetDatabase(target, password);
				await this.assertRestoreFreeSpace(
					manifest,
					currentDatabaseSizeBytes
				);
			}

			const transition = await this.claimDestructiveTransition(manifest);
			if (transition === 'CANCEL_PENDING') {
				this.logger.log(
					`Database restore job ${manifest.jobId} (${manifest.target}) paused for cancellation audit before fencing`
				);
				return;
			}
			if (transition === 'CANCEL_REQUESTED') {
				await this.finishCancelled(manifest);
				this.logger.log(
					`Database restore job ${manifest.jobId} (${manifest.target}) was cancelled before fencing`
				);
				return;
			}
			stage = 'FENCE';
			databaseMayBeFenced = true;
			await this.writeFenceSentinel(manifest);
			fenceIdentityConfirmed = true;
			if (!progress) {
				progress = await this.writeProgress({
					version: 1,
					jobId: manifest.jobId,
					target: manifest.target,
					phase: 'FENCING',
					safetyBackupFileName: null,
					safetyBackupSha256: null,
					restoredAt: null,
					verifiedAt: null,
					updatedAt: new Date().toISOString()
				});
			}

			await this.fenceDatabase(target, password);
			if (progress.phase === 'FENCING') {
				progress = await this.writeProgress({
					...this.progressPayload(progress),
					phase: 'FENCED',
					updatedAt: new Date().toISOString()
				});
			}

			if (resumePhase !== null && restoreMayReplay) {
				stage = 'PREFLIGHT';
				await this.validateUploadedDump(manifest, target, password);
				if (progress.phase === 'FENCED' && !progress.safetyBackupSha256) {
					const currentDatabaseSizeBytes =
						await this.preflightTargetDatabase(target, password);
					await this.assertRestoreFreeSpace(
						manifest,
						currentDatabaseSizeBytes
					);
				}
			}

			stage = 'SAFETY_BACKUP';
			if (progress.phase === 'FENCED') {
				if (progress.safetyBackupSha256) {
					await this.assertSafetyBackup(progress);
					progress = await this.writeProgress({
						...this.progressPayload(progress),
						phase: 'SAFETY_CREATED',
						updatedAt: new Date().toISOString()
					});
				} else {
					progress = await this.createSafetyBackup(
						manifest,
						target,
						password,
						progress
					);
				}
			} else {
				await this.assertSafetyBackup(progress);
			}

			if (progress.phase === 'SAFETY_CREATED') {
				stage = 'RESTORE';
				await this.restoreDump(manifest, target, password);
				const restoredAt = new Date().toISOString();
				progress = await this.writeProgress({
					...this.progressPayload(progress),
					phase: 'RESTORED',
					restoredAt,
					updatedAt: restoredAt
				});
			}

			if (progress.phase === 'RESTORED') {
				stage = 'ACL_REPAIR';
				await this.runPsql(
					target,
					password,
					buildDatabaseOwnershipAndAclRepairSql(target)
				);
				progress = await this.writeProgress({
					...this.progressPayload(progress),
					phase: 'REPAIRED',
					updatedAt: new Date().toISOString()
				});
			}

			if (progress.phase === 'REPAIRED') {
				stage = 'VERIFY';
				await this.verifyRestoredDatabase(
					target,
					password,
					expectedMigrations
				);
				const verifiedAt = new Date().toISOString();
				progress = await this.writeProgress({
					...this.progressPayload(progress),
					phase: 'VERIFIED',
					verifiedAt,
					updatedAt: verifiedAt
				});
			}
			if (resumedFromVerified) {
				stage = 'VERIFY';
				await this.verifyRestoredDatabase(
					target,
					password,
					expectedMigrations
				);
				const verifiedAt = new Date().toISOString();
				progress = await this.writeProgress({
					...this.progressPayload(progress),
					phase: 'VERIFIED',
					verifiedAt,
					updatedAt: verifiedAt
				});
			}
			if (progress.phase !== 'VERIFIED') {
				throw new Error(
					`Restore progress cannot reopen from phase ${progress.phase}`
				);
			}
			stage = 'REOPEN';
			await this.runPsql(target, password, buildDatabaseReopenSql(target));
			await this.removeFenceSentinel(manifest);
			fenceIdentityConfirmed = false;
			progress = await this.writeProgress({
				...this.progressPayload(progress),
				phase: 'REOPENED',
				updatedAt: new Date().toISOString()
			});
			databaseMayBeFenced = false;

			stage = 'FINALIZE';
			await this.finishSucceeded(manifest, progress);
			this.logger.log(
				`Database restore job ${manifest.jobId} (${manifest.target}) succeeded`
			);
		} catch (error) {
			if (!manifest) {
				await this.quarantineUnreadableManifest(input);
				this.logger.error(
					`Database restore manifest ${input.jobId} was quarantined: ${this.safeErrorText(error)}`
				);
				return;
			}
			if (error instanceof RestorePublicationPending) {
				this.logger.warn(
					`Database restore job ${manifest.jobId} is waiting for publication confirmation: ${error.code}`
				);
				return;
			}

			if (!databaseMayBeFenced) {
				const cancellationState = await this.readTransitionGateState(
					manifest
				).catch(() => null);
				if (cancellationState === 'CANCEL_PENDING') {
					this.logger.log(
						`Database restore job ${manifest.jobId} (${manifest.target}) paused for cancellation audit after a preflight interruption`
					);
					return;
				}
				if (cancellationState === 'CANCEL_REQUESTED') {
					await this.finishCancelled(manifest);
					this.logger.log(
						`Database restore job ${manifest.jobId} (${manifest.target}) was cancelled before fencing`
					);
					return;
				}
			}

			if (databaseMayBeFenced && target && password) {
				if (!fenceIdentityConfirmed) {
					await this.writeFenceSentinel(manifest)
						.then(() => {
							fenceIdentityConfirmed = true;
						})
						.catch(sentinelError => {
							this.logger.error(
								`Failed to persist fence sentinel for restore job ${manifest!.jobId}: ${this.safeErrorText(sentinelError)}`
							);
						});
				}
				if (fenceIdentityConfirmed) {
					await this.fenceDatabase(target, password, true).catch(
						fenceError => {
							this.logger.error(
								`Failed to reconfirm fence for restore job ${manifest!.jobId}: ${this.safeErrorText(fenceError)}`
							);
						}
					);
				} else {
					this.logger.error(
						`Refusing to fence database for restore job ${manifest.jobId}: durable fence identity is not owned by this job`
					);
				}
			}
			const terminalStatus = databaseMayBeFenced
				? 'FAILED_FENCED'
				: 'FAILED';
			const jobError = this.toJobError(error, stage);
			await this.finishFailed(
				manifest,
				progress,
				terminalStatus,
				jobError
			);
			this.logger.error(
				`Database restore job ${manifest.jobId} (${manifest.target}) failed with ${terminalStatus} at ${stage}: ${jobError.code}`
			);
		} finally {
			this.activeAbortController = null;
		}
	}

	private async readManifestCandidate(input: {
		jobId: string;
		path: string;
	}): Promise<SignedDatabaseRestoreJobManifest> {
		const raw = await this.fileSystem.readUtf8File(
			input.path,
			DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error('Database restore manifest is not valid JSON');
		}
		assertDatabaseRestoreJobManifest(parsed);
		if (parsed.jobId !== input.jobId) {
			throw new Error(
				'Database restore manifest path does not match job id'
			);
		}
		return parsed;
	}

	private async markProcessing(
		manifest: SignedDatabaseRestoreJobManifest,
		path: string
	): Promise<SignedDatabaseRestoreJobManifest> {
		if (manifest.status === 'PROCESSING') return manifest;
		if (manifest.status !== 'QUEUED') {
			throw new RestoreJobFailure(
				'MANIFEST_STATE_INVALID',
				'Задание восстановления находится в недопустимом состоянии'
			);
		}
		const processing = signDatabaseRestoreJobPayload(
			{
				...this.jobPayload(manifest),
				status: 'PROCESSING',
				startedAt: new Date().toISOString(),
				attempt: manifest.attempt + 1
			},
			this.config.queueSecret
		);
		await this.fileSystem.atomicWriteJson(path, processing);
		return processing;
	}

	private async validateUploadedDump(
		manifest: SignedDatabaseRestoreJobManifest,
		target: DatabaseRestoreTargetConfig,
		password: string
	): Promise<void> {
		const uploadPath = this.uploadPath(manifest.jobId);
		const uploadInfo = await this.fileSystem.fileInfo(uploadPath);
		if (
			!uploadInfo.isFile ||
			uploadInfo.isSymbolicLink ||
			uploadInfo.size !== manifest.fileSize
		) {
			throw new RestoreJobFailure(
				'DUMP_FILE_INVALID',
				'Загруженный dump повреждён или имеет неверный размер'
			);
		}
		if (
			(await this.fileSystem.calculateSha256(uploadPath)) !==
			manifest.sha256
		) {
			throw new RestoreJobFailure(
				'DUMP_SHA256_MISMATCH',
				'Контрольная сумма загруженного dump не совпадает'
			);
		}
		const list = await this.commandRunner.run({
			command: 'pg_restore',
			args: ['--list', uploadPath],
			password,
			timeoutMs: this.config.commandTimeoutMs,
			signal: this.activeAbortController?.signal
		});
		try {
			assertDatabaseRestoreTableOfContents(list.stdout, target);
		} catch (error) {
			throw new RestoreJobFailure(
				'DUMP_TARGET_MISMATCH',
				'Dump не соответствует выбранной базе данных',
				this.safeErrorText(error)
			);
		}
	}

	private async createSafetyBackup(
		manifest: SignedDatabaseRestoreJobManifest,
		target: DatabaseRestoreTargetConfig,
		password: string,
		progress: SignedRestoreProgress
	): Promise<SignedRestoreProgress> {
		const safetyPath = this.processingSafetyPath(manifest.jobId);
		await this.fileSystem.removeFile(safetyPath);
		await this.commandRunner.run({
			command: 'pg_dump',
			args: [
				'--format=custom',
				'--no-owner',
				'--no-privileges',
				'--no-password',
				'--schema',
				target.schema,
				'--file',
				safetyPath,
				'--host',
				target.host,
				'--port',
				String(target.port),
				'--username',
				target.adminRole,
				target.database
			],
			password,
			timeoutMs: this.config.commandTimeoutMs,
			signal: this.activeAbortController?.signal
		});
		const safetyInfo = await this.fileSystem.fileInfo(safetyPath);
		if (
			!safetyInfo.isFile ||
			safetyInfo.isSymbolicLink ||
			safetyInfo.size < 1
		) {
			throw new RestoreJobFailure(
				'SAFETY_BACKUP_INVALID',
				'Не удалось создать проверяемый safety backup'
			);
		}
		const safetyBackupSha256 =
			await this.fileSystem.calculateSha256(safetyPath);
		const list = await this.commandRunner.run({
			command: 'pg_restore',
			args: ['--list', safetyPath],
			password,
			timeoutMs: this.config.commandTimeoutMs,
			signal: this.activeAbortController?.signal
		});
		assertDatabaseRestoreTableOfContents(list.stdout, target);

		return this.writeProgress({
			...this.progressPayload(progress),
			phase: 'SAFETY_CREATED',
			safetyBackupFileName: this.safetyFileName(manifest.jobId),
			safetyBackupSha256,
			restoredAt: null,
			verifiedAt: null,
			updatedAt: new Date().toISOString()
		});
	}

	private async assertSafetyBackup(
		progress: SignedRestoreProgress
	): Promise<void> {
		if (!progress.safetyBackupFileName || !progress.safetyBackupSha256) {
			throw new Error('Safety backup progress is incomplete');
		}
		const safetyPath = await this.findSafetyPath(progress.jobId);
		const info = await this.fileSystem.fileInfo(safetyPath);
		if (!info.isFile || info.isSymbolicLink || info.size < 1) {
			throw new Error('Safety backup is unavailable');
		}
		if (
			(await this.fileSystem.calculateSha256(safetyPath)) !==
			progress.safetyBackupSha256
		) {
			throw new Error('Safety backup checksum is invalid');
		}
		if (
			progress.safetyBackupFileName !== this.safetyFileName(progress.jobId)
		) {
			throw new Error('Safety backup name is invalid');
		}
	}

	private async preflightTargetDatabase(
		target: DatabaseRestoreTargetConfig,
		password: string
	): Promise<number> {
		const result = await this.runPsql(
			target,
			password,
			buildDatabaseConnectionPreflightSql(target)
		);
		const lines = result.stdout
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean);
		const rawSize = lines.at(-1);
		if (!rawSize || !/^[0-9]+$/.test(rawSize)) {
			throw new RestoreJobFailure(
				'DATABASE_PREFLIGHT_INVALID',
				'Не удалось подтвердить размер и идентичность целевой базы'
			);
		}
		const databaseSizeBytes = Number(rawSize);
		if (
			!Number.isSafeInteger(databaseSizeBytes) ||
			databaseSizeBytes < 0
		) {
			throw new RestoreJobFailure(
				'DATABASE_PREFLIGHT_INVALID',
				'Размер целевой базы находится вне безопасного диапазона'
			);
		}
		return databaseSizeBytes;
	}

	private async assertRestoreFreeSpace(
		manifest: SignedDatabaseRestoreJobManifest,
		currentDatabaseSizeBytes: number
	): Promise<void> {
		const requiredFreeBytes = Math.max(
			MINIMUM_RESTORE_FREE_SPACE_BYTES,
			manifest.fileSize * 4,
			currentDatabaseSizeBytes + RESTORE_SPACE_HEADROOM_BYTES
		);
		if (
			(await this.fileSystem.availableBytes(
				this.config.storageDirectory
			)) < requiredFreeBytes
		) {
			throw new RestoreJobFailure(
				'INSUFFICIENT_RESTORE_SPACE',
				'Недостаточно свободного места для safety backup и восстановления'
			);
		}
	}

	private async fenceDatabase(
		target: DatabaseRestoreTargetConfig,
		password: string,
		ignoreShutdownSignal = false
	): Promise<void> {
		await this.runPsql(
			target,
			password,
			buildDatabaseFenceSql(target),
			ignoreShutdownSignal ? undefined : this.activeAbortController?.signal
		);
	}

	private async restoreDump(
		manifest: SignedDatabaseRestoreJobManifest,
		target: DatabaseRestoreTargetConfig,
		password: string
	): Promise<void> {
		await this.commandRunner.run({
			command: 'pg_restore',
			args: [
				'--exit-on-error',
				'--single-transaction',
				'--clean',
				'--if-exists',
				'--no-owner',
				'--no-privileges',
				'--no-password',
				'--schema',
				target.schema,
				'--host',
				target.host,
				'--port',
				String(target.port),
				'--username',
				target.adminRole,
				'--dbname',
				target.database,
				this.uploadPath(manifest.jobId)
			],
			password,
			timeoutMs: this.config.commandTimeoutMs,
			signal: this.activeAbortController?.signal
		});
	}

	private async verifyRestoredDatabase(
		target: DatabaseRestoreTargetConfig,
		password: string,
		expectedMigrations: readonly {
			migrationName: string;
			checksum: string;
		}[]
	): Promise<void> {
		const migrationResult = await this.runPsql(
			target,
			password,
			buildMigrationLedgerQuery(target)
		);
		assertExactDatabaseMigrations(
			parseDatabaseMigrationRows(migrationResult.stdout),
			expectedMigrations
		);
		await this.runPsql(
			target,
			password,
			buildDatabasePreReopenVerificationSql(target)
		);
	}

	private runPsql(
		target: DatabaseRestoreTargetConfig,
		password: string,
		sql: string,
		signal: AbortSignal | undefined = this.activeAbortController?.signal
	) {
		return this.commandRunner.run({
			command: 'psql',
			args: [
				'--no-psqlrc',
				'--no-password',
				'--set',
				'ON_ERROR_STOP=1',
				'--tuples-only',
				'--no-align',
				'--host',
				target.host,
				'--port',
				String(target.port),
				'--username',
				target.adminRole,
				'--dbname',
				target.database,
				'--command',
				sql
			],
			password,
			timeoutMs: this.config.commandTimeoutMs,
			signal
		});
	}

	private async finishSucceeded(
		manifest: SignedDatabaseRestoreJobManifest,
		progress: SignedRestoreProgress
	): Promise<void> {
		const result = await this.finalizeSafetyBackup(progress);
		const finishedAt = new Date().toISOString();
		const terminal = signDatabaseRestoreJobPayload(
			{
				...this.jobPayload(manifest),
				status: 'SUCCEEDED',
				finishedAt,
				error: null,
				result
			},
			this.config.queueSecret
		);
		await this.fileSystem.atomicWriteJson(
			this.terminalManifestPath(manifest.jobId),
			terminal
		);
		await this.releaseTargetLock(terminal).catch(error => {
			this.logger.error(
				`Database restore ${manifest.jobId} succeeded but its target lock could not be released: ${this.safeErrorText(error)}`
			);
		});
		await this.releaseGlobalGate(terminal).catch(error => {
			this.logger.error(
				`Database restore ${manifest.jobId} succeeded but its global gate could not be released: ${this.safeErrorText(error)}`
			);
		});
		await this.fileSystem.removeFile(this.uploadPath(manifest.jobId));
		await this.cleanupCompletedProcessingFiles(manifest.jobId);
	}

	private async finishCancelled(
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<void> {
		const terminal = signDatabaseRestoreJobPayload(
			{
				...this.jobPayload(manifest),
				status: 'CANCELLED',
				startedAt: manifest.startedAt || new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				attempt: Math.max(1, manifest.attempt),
				error: null,
				result: null
			},
			this.config.queueSecret
		);
		await this.fileSystem.atomicWriteJson(
			this.terminalManifestPath(manifest.jobId),
			terminal
		);
		await this.releaseTargetLock(terminal).catch(lockError => {
			this.logger.error(
				`Database restore ${manifest.jobId} was cancelled but its target lock could not be released: ${this.safeErrorText(lockError)}`
			);
		});
		await this.releaseGlobalGate(terminal).catch(lockError => {
			this.logger.error(
				`Database restore ${manifest.jobId} was cancelled but its global gate could not be released: ${this.safeErrorText(lockError)}`
			);
		});
		await this.fileSystem.removeFile(this.uploadPath(manifest.jobId));
		await this.cleanupCompletedProcessingFiles(manifest.jobId);
	}

	private async finishFailed(
		manifest: SignedDatabaseRestoreJobManifest,
		progress: SignedRestoreProgress | null,
		status: 'FAILED' | 'FAILED_FENCED',
		error: DatabaseRestoreJobError
	): Promise<void> {
		let result: DatabaseRestoreJobResult | null = null;
		if (progress?.safetyBackupFileName && progress.safetyBackupSha256) {
			result = await this.finalizeSafetyBackup(progress).catch(() => ({
				safetyBackupFileName: progress.safetyBackupFileName,
				safetyBackupSha256: progress.safetyBackupSha256,
				restoredAt: progress.restoredAt,
				verifiedAt: progress.verifiedAt
			}));
		}
		const startedAt = manifest.startedAt || new Date().toISOString();
		const terminal = signDatabaseRestoreJobPayload(
			{
				...this.jobPayload(manifest),
				status,
				startedAt,
				finishedAt: new Date().toISOString(),
				attempt: Math.max(1, manifest.attempt),
				error,
				result
			},
			this.config.queueSecret
		);
		await this.fileSystem.atomicWriteJson(
			this.terminalManifestPath(manifest.jobId),
			terminal
		);
		if (status === 'FAILED') {
			await this.releaseTargetLock(terminal).catch(lockError => {
				this.logger.error(
					`Database restore ${manifest.jobId} reached ${status} but its target lock could not be released: ${this.safeErrorText(lockError)}`
				);
			});
			await this.releaseGlobalGate(terminal).catch(lockError => {
				this.logger.error(
					`Database restore ${manifest.jobId} reached ${status} but its global gate could not be released: ${this.safeErrorText(lockError)}`
				);
			});
		}
		if (status === 'FAILED') {
			await this.fileSystem.removeFile(this.uploadPath(manifest.jobId));
		}
		await this.cleanupCompletedProcessingFiles(manifest.jobId);
	}

	private async finalizeSafetyBackup(
		progress: SignedRestoreProgress
	): Promise<DatabaseRestoreJobResult> {
		if (!progress.safetyBackupFileName || !progress.safetyBackupSha256) {
			throw new Error('Safety backup result is incomplete');
		}
		const terminalPath = this.terminalSafetyPath(progress.jobId);
		if (!(await this.fileSystem.pathExists(terminalPath))) {
			await this.fileSystem.rename(
				this.processingSafetyPath(progress.jobId),
				terminalPath
			);
		}
		if (
			(await this.fileSystem.calculateSha256(terminalPath)) !==
			progress.safetyBackupSha256
		) {
			throw new Error('Terminal safety backup checksum is invalid');
		}
		return {
			safetyBackupFileName: progress.safetyBackupFileName,
			safetyBackupSha256: progress.safetyBackupSha256,
			restoredAt: progress.restoredAt,
			verifiedAt: progress.verifiedAt
		};
	}

	private async assertTargetLock(
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<void> {
		const path = this.targetLockPath(manifest.target);
		let lock;
		try {
			lock = parseAndVerifyDatabaseRestoreTargetLock(
				await this.fileSystem.readUtf8File(
					path,
					DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
				),
				this.config.queueSecret
			);
		} catch {
			throw new RestoreJobFailure(
				'TARGET_LOCK_INVALID',
				'Блокировка выбранной базы отсутствует или повреждена'
			);
		}
		if (lock.jobId !== manifest.jobId || lock.target !== manifest.target) {
			throw new RestoreJobFailure(
				'TARGET_LOCK_MISMATCH',
				'Выбранная база заблокирована другим заданием'
			);
		}
	}

	private async validateProductionPublication(
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<void> {
		if (!this.config.productionMode) return;

		await this.assertGlobalGate(manifest);
		let receipt: SignedDatabaseRestorePublishReceipt;
		try {
			receipt = parseAndVerifyDatabaseRestorePublishReceipt(
				await this.fileSystem.readUtf8File(
					this.publishReceiptPath(manifest.jobId),
					DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
				),
				this.config.queueSecret
			);
		} catch {
			throw new RestorePublicationPending(
				'PUBLISH_RECEIPT_INVALID',
				'Подтверждение безопасной публикации задания отсутствует или повреждено'
			);
		}

		if (
			receipt.jobId !== manifest.jobId ||
			receipt.target !== manifest.target ||
			receipt.manifestStatus !== 'QUEUED' ||
			receipt.appRevision !== this.config.appRevision ||
			!receipt.permitSignature ||
			!receipt.permitExpiresAt ||
			!receipt.runId ||
			!receipt.evidence ||
			!receipt.incident ||
			Date.parse(receipt.publishedAt) < Date.parse(manifest.requestedAt) ||
			Date.parse(receipt.publishedAt) > Date.parse(receipt.permitExpiresAt)
		) {
			throw new RestorePublicationPending(
				'PUBLISH_RECEIPT_MISMATCH',
				'Подтверждение публикации не совпадает с заданием или текущей ревизией'
			);
		}

		const permit = {
			version: DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
			kind: 'DATABASE_RESTORE_PRODUCTION_PERMIT' as const,
			appRevision: receipt.appRevision,
			target: receipt.target,
			jobId: receipt.jobId,
			expiresAt: receipt.permitExpiresAt,
			runId: receipt.runId,
			evidence: receipt.evidence,
			incident: receipt.incident,
			signature: receipt.permitSignature
		};
		if (
			!verifyDatabaseRestoreProductionPermit(
				permit,
				this.config.queueSecret
			)
		) {
			throw new RestorePublicationPending(
				'PRODUCTION_PERMIT_INVALID',
				'Production restore permit в подтверждении публикации недействителен'
			);
		}

		if (manifest.status === 'QUEUED') {
			if (receipt.manifestSignature !== manifest.signature) {
				throw new RestorePublicationPending(
					'PUBLISH_RECEIPT_MANIFEST_MISMATCH',
					'Подтверждение публикации относится к другой версии задания'
				);
			}
			await this.persistPublicationValidationClaim(manifest, receipt);
			return;
		}
		if (manifest.status !== 'PROCESSING') {
			throw new RestorePublicationPending(
				'MANIFEST_STATE_INVALID',
				'Production worker получил задание в недопустимом состоянии'
			);
		}

		const claim = await this.readPublicationValidationClaim(
			manifest.jobId
		);
		if (
			claim.jobId !== manifest.jobId ||
			claim.target !== manifest.target ||
			claim.appRevision !== this.config.appRevision ||
			claim.manifestSignature !== receipt.manifestSignature ||
			claim.receiptSignature !== receipt.signature
		) {
			throw new RestorePublicationPending(
				'PUBLICATION_VALIDATION_CLAIM_MISMATCH',
				'Сохранённая проверка публикации не совпадает с заданием'
			);
		}
	}

	private async assertGlobalGate(
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<void> {
		let gate;
		try {
			gate = parseAndVerifyDatabaseRestoreGlobalGate(
				await this.fileSystem.readUtf8File(
					this.globalGatePath,
					DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
				),
				this.config.queueSecret
			);
		} catch {
			throw new RestorePublicationPending(
				'GLOBAL_GATE_INVALID',
				'Глобальная блокировка восстановления отсутствует или повреждена'
			);
		}
		if (gate.jobId !== manifest.jobId || gate.target !== manifest.target) {
			throw new RestorePublicationPending(
				'GLOBAL_GATE_MISMATCH',
				'Глобальная блокировка восстановления принадлежит другому заданию'
			);
		}
	}

	private async persistPublicationValidationClaim(
		manifest: SignedDatabaseRestoreJobManifest,
		receipt: SignedDatabaseRestorePublishReceipt
	): Promise<void> {
		const payload: PublicationValidationClaimPayload = {
			version: 1,
			kind: 'DATABASE_RESTORE_PUBLICATION_VALIDATION',
			jobId: manifest.jobId,
			target: manifest.target,
			manifestSignature: manifest.signature,
			receiptSignature: receipt.signature,
			appRevision: this.config.appRevision,
			validatedAt: new Date().toISOString()
		};
		const claim = this.signPublicationValidationClaim(payload);
		await this.fileSystem.atomicCreateJson(
			this.publicationValidationPath(manifest.jobId),
			claim
		);
		const persisted = await this.readPublicationValidationClaim(
			manifest.jobId
		);
		if (
			persisted.jobId !== payload.jobId ||
			persisted.target !== payload.target ||
			persisted.manifestSignature !== payload.manifestSignature ||
			persisted.receiptSignature !== payload.receiptSignature ||
			persisted.appRevision !== payload.appRevision
		) {
			throw new RestorePublicationPending(
				'PUBLICATION_VALIDATION_CLAIM_MISMATCH',
				'Не удалось атомарно зафиксировать проверку публикации'
			);
		}
	}

	private signPublicationValidationClaim(
		payload: PublicationValidationClaimPayload
	): SignedPublicationValidationClaim {
		this.assertPublicationValidationClaimPayload(payload);
		return {
			...payload,
			signature: createHmac('sha256', this.config.queueSecret)
				.update(canonicalDatabaseRestoreJson(payload))
				.digest('hex')
		};
	}

	private async readPublicationValidationClaim(
		jobId: string
	): Promise<SignedPublicationValidationClaim> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(
				await this.fileSystem.readUtf8File(
					this.publicationValidationPath(jobId),
					DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
				)
			);
		} catch {
			throw new RestorePublicationPending(
				'PUBLICATION_VALIDATION_CLAIM_INVALID',
				'Сохранённая проверка публикации отсутствует или повреждена'
			);
		}
		try {
			this.assertPublicationValidationClaim(parsed);
		} catch {
			throw new RestorePublicationPending(
				'PUBLICATION_VALIDATION_CLAIM_INVALID',
				'Сохранённая проверка публикации имеет неверный формат'
			);
		}
		const { signature, ...payload } = parsed;
		const expected = createHmac('sha256', this.config.queueSecret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest();
		const supplied = Buffer.from(signature, 'hex');
		if (
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		) {
			throw new RestorePublicationPending(
				'PUBLICATION_VALIDATION_CLAIM_INVALID',
				'Подпись сохранённой проверки публикации недействительна'
			);
		}
		return parsed;
	}

	private assertPublicationValidationClaim(
		value: unknown
	): asserts value is SignedPublicationValidationClaim {
		if (!this.isPlainObject(value)) {
			throw new Error('Publication validation claim must be an object');
		}
		const expectedKeys = [
			'appRevision',
			'jobId',
			'kind',
			'manifestSignature',
			'receiptSignature',
			'signature',
			'target',
			'validatedAt',
			'version'
		].sort();
		const keys = Object.keys(value).sort();
		if (
			keys.length !== expectedKeys.length ||
			keys.some((key, index) => key !== expectedKeys[index]) ||
			typeof value.signature !== 'string' ||
			!/^[0-9a-f]{64}$/.test(value.signature)
		) {
			throw new Error('Publication validation claim shape is invalid');
		}
		const payload = { ...value };
		delete payload.signature;
		this.assertPublicationValidationClaimPayload(
			payload as unknown as PublicationValidationClaimPayload
		);
	}

	private assertPublicationValidationClaimPayload(
		value: PublicationValidationClaimPayload
	): void {
		if (
			!this.isPlainObject(value) ||
			value.version !== 1 ||
			value.kind !== 'DATABASE_RESTORE_PUBLICATION_VALIDATION' ||
			!isDatabaseRestoreJobId(value.jobId) ||
			!this.config.targets[value.target] ||
			!/^[0-9a-f]{64}$/.test(value.manifestSignature) ||
			!/^[0-9a-f]{64}$/.test(value.receiptSignature) ||
			value.appRevision !== this.config.appRevision ||
			!this.isIsoTimestamp(value.validatedAt)
		) {
			throw new Error('Publication validation claim payload is invalid');
		}
	}

	private async claimDestructiveTransition(
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<DestructiveTransitionResult> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const state = await this.readTransitionGateState(manifest);
			if (state === 'CANCEL_PENDING') return 'CANCEL_PENDING';
			if (state === 'CANCEL_REQUESTED') return 'CANCEL_REQUESTED';
			if (state === 'DESTRUCTIVE') return 'CLAIMED';

			try {
				await this.fileSystem.rename(
					this.transitionGatePath(manifest.jobId, 'CANCELLABLE'),
					this.transitionGatePath(manifest.jobId, 'DESTRUCTIVE')
				);
				const claimedState = await this.readTransitionGateState(manifest);
				if (claimedState !== 'DESTRUCTIVE') {
					throw new Error(
						'Database restore destructive transition was not persisted'
					);
				}
				return 'CLAIMED';
			} catch (error) {
				if (!this.fileSystem.isNodeError(error, 'ENOENT')) throw error;
			}
		}

		throw new Error(
			'Database restore destructive transition race did not settle'
		);
	}

	private async readTransitionGateState(
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<DatabaseRestoreTransitionGateState> {
		const states: readonly DatabaseRestoreTransitionGateState[] = [
			'CANCEL_REQUESTED',
			'CANCEL_PENDING',
			'DESTRUCTIVE',
			'CANCELLABLE'
		];
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const candidates = await Promise.all(
				states.map(async state => ({
					state,
					gate: await this.readTransitionGateIfPresent(
						this.transitionGatePath(manifest.jobId, state)
					)
				}))
			);
			const existing = candidates.filter(
				candidate => candidate.gate !== null
			);
			if (existing.length !== 1) continue;

			const candidate = existing[0];
			if (
				candidate.gate!.jobId !== manifest.jobId ||
				candidate.gate!.target !== manifest.target
			) {
				throw new Error(
					'Database restore transition gate belongs to another job'
				);
			}
			return candidate.state;
		}

		throw new Error(
			'Database restore transition gate is missing or ambiguous'
		);
	}

	private async readTransitionGateIfPresent(path: string) {
		if (!(await this.fileSystem.pathExists(path))) return null;
		try {
			return parseAndVerifyDatabaseRestoreTransitionGate(
				await this.fileSystem.readUtf8File(
					path,
					DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
				),
				this.config.queueSecret
			);
		} catch (error) {
			if (this.fileSystem.isNodeError(error, 'ENOENT')) return null;
			throw error;
		}
	}

	private async releaseTargetLock(
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<void> {
		const lockPath = this.targetLockPath(manifest.target);
		if (!(await this.fileSystem.pathExists(lockPath))) return;
		const current = parseAndVerifyDatabaseRestoreTargetLock(
			await this.fileSystem.readUtf8File(
				lockPath,
				DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
			),
			this.config.queueSecret
		);
		if (
			current.jobId !== manifest.jobId ||
			current.target !== manifest.target
		) {
			throw new Error(
				'Database restore target lock belongs to another job'
			);
		}

		const releasePath = join(
			this.locksDirectory,
			`.release-${manifest.target}-${manifest.jobId}`
		);
		await this.fileSystem.removeFile(releasePath);
		await this.fileSystem.rename(lockPath, releasePath);
		const claimed = parseAndVerifyDatabaseRestoreTargetLock(
			await this.fileSystem.readUtf8File(
				releasePath,
				DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
			),
			this.config.queueSecret
		);
		if (
			claimed.jobId !== manifest.jobId ||
			claimed.target !== manifest.target
		) {
			throw new Error(
				'Claimed database restore target lock changed identity'
			);
		}
		await this.fileSystem.removeFile(releasePath);
	}

	private async releaseGlobalGate(
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<void> {
		if (!(await this.fileSystem.pathExists(this.globalGatePath))) return;
		const gate = parseAndVerifyDatabaseRestoreGlobalGate(
			await this.fileSystem.readUtf8File(
				this.globalGatePath,
				DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
			),
			this.config.queueSecret
		);
		if (gate.jobId !== manifest.jobId || gate.target !== manifest.target) {
			throw new Error(
				'Database restore global gate belongs to another job'
			);
		}

		const releasePath = join(
			this.locksDirectory,
			`.release-global-${manifest.jobId}-${randomUUID()}`
		);
		try {
			await this.fileSystem.rename(this.globalGatePath, releasePath);
		} catch (error) {
			if (this.fileSystem.isNodeError(error, 'ENOENT')) return;
			throw error;
		}
		const claimed = parseAndVerifyDatabaseRestoreGlobalGate(
			await this.fileSystem.readUtf8File(
				releasePath,
				DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
			),
			this.config.queueSecret
		);
		if (
			claimed.jobId !== manifest.jobId ||
			claimed.target !== manifest.target
		) {
			throw new Error(
				'Claimed database restore global gate changed identity'
			);
		}
		await this.fileSystem.removeFile(releasePath);
	}

	private async writeFenceSentinel(
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<void> {
		const sentinel = signDatabaseRestoreTargetLock(
			{
				version: 1,
				target: manifest.target,
				jobId: manifest.jobId,
				createdAt: new Date().toISOString()
			},
			this.config.queueSecret
		);
		await this.fileSystem.atomicCreateJson(
			this.fenceSentinelPath(manifest.target),
			sentinel
		);
		await this.readFenceSentinel(manifest.target, manifest.jobId);
	}

	private async readFenceSentinel(
		target: DatabaseRestoreTarget,
		expectedJobId?: string
	) {
		const sentinel = parseAndVerifyDatabaseRestoreTargetLock(
			await this.fileSystem.readUtf8File(
				this.fenceSentinelPath(target),
				DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
			),
			this.config.queueSecret
		);
		if (sentinel.target !== target) {
			throw new Error(
				`Database restore fence sentinel path mismatch for ${target}`
			);
		}
		if (expectedJobId && sentinel.jobId !== expectedJobId) {
			throw new Error(
				`Database restore fence belongs to another job for ${target}`
			);
		}
		return sentinel;
	}

	private async removeFenceSentinel(
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<void> {
		const sentinelPath = this.fenceSentinelPath(manifest.target);
		await this.readFenceSentinel(manifest.target, manifest.jobId);
		const releasePath = join(
			this.fencesDirectory,
			`.release-${manifest.target}-${manifest.jobId}`
		);
		await this.fileSystem.removeFile(releasePath);
		await this.fileSystem.rename(sentinelPath, releasePath);
		const claimed = parseAndVerifyDatabaseRestoreTargetLock(
			await this.fileSystem.readUtf8File(
				releasePath,
				DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
			),
			this.config.queueSecret
		);
		if (
			claimed.jobId !== manifest.jobId ||
			claimed.target !== manifest.target
		) {
			throw new Error('Claimed database restore fence changed identity');
		}
		await this.fileSystem.removeFile(releasePath);
	}

	private async writeProgress(
		payload: RestoreProgressPayload
	): Promise<SignedRestoreProgress> {
		const progress = this.signProgress(payload);
		await this.fileSystem.atomicWriteJson(
			this.progressPath(payload.jobId),
			progress
		);
		return progress;
	}

	private async readProgress(
		path: string,
		manifest: SignedDatabaseRestoreJobManifest
	): Promise<SignedRestoreProgress> {
		const raw = await this.fileSystem.readUtf8File(
			path,
			DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error('Restore progress is not valid JSON');
		}
		this.assertProgress(parsed);
		if (
			parsed.jobId !== manifest.jobId ||
			parsed.target !== manifest.target ||
			!this.verifyProgress(parsed)
		) {
			throw new Error('Restore progress signature or identity is invalid');
		}
		return parsed;
	}

	private signProgress(
		payload: RestoreProgressPayload
	): SignedRestoreProgress {
		this.assertProgressPayload(payload);
		return {
			...payload,
			signature: createHmac('sha256', this.config.queueSecret)
				.update(canonicalDatabaseRestoreJson(payload))
				.digest('hex')
		};
	}

	private verifyProgress(progress: SignedRestoreProgress): boolean {
		const { signature, ...payload } = progress;
		const expected = createHmac('sha256', this.config.queueSecret)
			.update(canonicalDatabaseRestoreJson(payload))
			.digest();
		const actual = Buffer.from(signature, 'hex');
		return (
			actual.length === expected.length &&
			timingSafeEqual(actual, expected)
		);
	}

	private assertProgress(
		value: unknown
	): asserts value is SignedRestoreProgress {
		if (!this.isPlainObject(value)) {
			throw new Error('Restore progress must be an object');
		}
		const keys = Object.keys(value).sort();
		const expectedKeys = [
			'jobId',
			'phase',
			'restoredAt',
			'safetyBackupFileName',
			'safetyBackupSha256',
			'signature',
			'target',
			'updatedAt',
			'verifiedAt',
			'version'
		].sort();
		if (
			keys.length !== expectedKeys.length ||
			keys.some((key, index) => key !== expectedKeys[index])
		) {
			throw new Error('Restore progress contains unexpected fields');
		}
		const { signature, ...payload } = value;
		if (
			typeof signature !== 'string' ||
			!/^[0-9a-f]{64}$/.test(signature)
		) {
			throw new Error('Restore progress signature is invalid');
		}
		this.assertProgressPayload(
			payload as unknown as RestoreProgressPayload
		);
	}

	private assertProgressPayload(
		value: RestoreProgressPayload
	): asserts value is RestoreProgressPayload {
		const hasSafetyBackup =
			typeof value.safetyBackupFileName === 'string' &&
			value.safetyBackupFileName === this.safetyFileName(value.jobId) &&
			typeof value.safetyBackupSha256 === 'string' &&
			/^[0-9a-f]{64}$/.test(value.safetyBackupSha256);
		const hasNoSafetyBackup =
			value.safetyBackupFileName === null &&
			value.safetyBackupSha256 === null;
		const phaseRequiresSafetyBackup = !['FENCING', 'FENCED'].includes(
			value.phase
		);
		const phaseRequiresRestoredAt = [
			'RESTORED',
			'REPAIRED',
			'VERIFIED',
			'REOPENED'
		].includes(value.phase);
		const phaseRequiresVerifiedAt = ['VERIFIED', 'REOPENED'].includes(
			value.phase
		);
		if (
			!this.isPlainObject(value) ||
			value.version !== 1 ||
			!isDatabaseRestoreJobId(value.jobId) ||
			!this.config.targets[value.target] ||
			!PROGRESS_PHASES.includes(value.phase) ||
			(!hasSafetyBackup && !hasNoSafetyBackup) ||
			(phaseRequiresSafetyBackup && !hasSafetyBackup) ||
			!this.isIsoTimestamp(value.updatedAt) ||
			(value.restoredAt !== null &&
				!this.isIsoTimestamp(value.restoredAt)) ||
			(value.verifiedAt !== null &&
				!this.isIsoTimestamp(value.verifiedAt)) ||
			(phaseRequiresRestoredAt && !value.restoredAt) ||
			(phaseRequiresVerifiedAt && !value.verifiedAt)
		) {
			throw new Error('Restore progress payload is invalid');
		}
	}

	private progressPayload(
		progress: SignedRestoreProgress
	): RestoreProgressPayload {
		const payload = { ...progress };
		delete (payload as Partial<SignedRestoreProgress>).signature;
		return payload;
	}

	private jobPayload(
		manifest: SignedDatabaseRestoreJobManifest
	): DatabaseRestoreJobPayload {
		const payload = { ...manifest };
		delete (payload as Partial<SignedDatabaseRestoreJobManifest>)
			.signature;
		return payload;
	}

	private toJobError(
		error: unknown,
		stage: RestoreStage
	): DatabaseRestoreJobError {
		if (error instanceof RestoreJobFailure) {
			return { code: error.code, message: error.safeMessage };
		}
		const stageErrors: Record<RestoreStage, DatabaseRestoreJobError> = {
			MANIFEST: {
				code: 'MANIFEST_INVALID',
				message: 'Задание восстановления повреждено'
			},
			PREFLIGHT: {
				code: 'RESTORE_PREFLIGHT_FAILED',
				message: 'Предварительная проверка восстановления не пройдена'
			},
			SAFETY_BACKUP: {
				code: 'SAFETY_BACKUP_FAILED',
				message: 'Не удалось создать safety backup перед восстановлением'
			},
			FENCE: {
				code: 'DATABASE_FENCE_FAILED',
				message: 'Не удалось надёжно оградить базу данных'
			},
			RESTORE: {
				code: 'DATABASE_RESTORE_FAILED',
				message: 'Восстановление PostgreSQL завершилось ошибкой'
			},
			ACL_REPAIR: {
				code: 'DATABASE_ACL_REPAIR_FAILED',
				message: 'Не удалось восстановить владельцев и права базы данных'
			},
			VERIFY: {
				code: 'DATABASE_VERIFICATION_FAILED',
				message: 'Проверка восстановленной базы данных не пройдена'
			},
			REOPEN: {
				code: 'DATABASE_REOPEN_FAILED',
				message: 'База данных не была безопасно возвращена в работу'
			},
			FINALIZE: {
				code: 'RESTORE_FINALIZATION_FAILED',
				message: 'Не удалось зафиксировать результат восстановления'
			}
		};
		return stageErrors[stage];
	}

	private async ensureStorageLayout(): Promise<void> {
		await this.fileSystem.ensurePrivateDirectory(
			this.config.storageDirectory
		);
		for (const directory of [
			this.uploadsDirectory,
			this.queuedDirectory,
			this.processingDirectory,
			this.terminalDirectory,
			this.locksDirectory,
			this.gatesDirectory,
			this.fencesDirectory,
			this.receiptsDirectory
		]) {
			await this.fileSystem.ensurePrivateDirectory(directory);
		}
	}

	private async validateStartupDependencies(): Promise<
		DatabaseRestoreTarget[]
	> {
		const targets = Object.values(this.config.targets);
		if (
			new Set(targets.map(target => target.passwordFile)).size !==
			targets.length
		) {
			throw new Error(
				'Database restore targets must use separate admin password files'
			);
		}
		await this.validateAndReconcileTargetLocks();
		await this.validateAndReconcileGlobalGate();
		const fencedTargets = await this.validateAndReconfirmFenceSentinels();
		await this.validateAndReconcileTransitionGates();

		let probePassword: string | null = null;
		for (const target of targets) {
			const password = await this.fileSystem.readSecretFile(
				target.passwordFile
			);
			probePassword ||= password;
			await this.fileSystem.readMigrationChecksums(
				target.migrationsDirectory
			);
		}
		if (!probePassword) {
			throw new Error(
				'No database restore target credentials are configured'
			);
		}
		for (const command of ['pg_dump', 'pg_restore', 'psql'] as const) {
			await this.commandRunner.run({
				command,
				args: ['--version'],
				password: probePassword,
				timeoutMs: 10_000
			});
		}
		return fencedTargets;
	}

	private async reconcileCompletedJobLocks(): Promise<void> {
		for (const candidate of await this.findJobManifests(
			this.terminalDirectory
		)) {
			const terminal = await this.readManifestCandidate(candidate);
			if (
				!verifyDatabaseRestoreJobManifest(
					terminal,
					this.config.queueSecret
				) ||
				!['SUCCEEDED', 'FAILED', 'FAILED_FENCED', 'CANCELLED'].includes(
					terminal.status
				)
			) {
				throw new Error(
					`Terminal database restore manifest cannot be reconciled for ${candidate.jobId}`
				);
			}
		}
		await this.validateAndReconcileTargetLocks();
		await this.validateAndReconcileGlobalGate(false);
	}

	private async validateAndReconcileGlobalGate(
		validatePublication = true
	): Promise<void> {
		const active = [
			...(await this.findJobManifests(this.queuedDirectory)),
			...(await this.findJobManifests(this.processingDirectory))
		];
		const activeIds = [
			...new Set(active.map(candidate => candidate.jobId))
		];
		if (active.length !== activeIds.length || activeIds.length > 1) {
			throw new Error(
				'Database restore global gate has ambiguous active manifests'
			);
		}

		if (!(await this.fileSystem.pathExists(this.globalGatePath))) {
			if (this.config.productionMode && activeIds.length) {
				throw new Error(
					`Production database restore job has no global gate: ${activeIds[0]}`
				);
			}
			if (this.config.productionMode) {
				for (const target of Object.keys(
					this.config.targets
				) as DatabaseRestoreTarget[]) {
					if (
						await this.fileSystem.pathExists(
							this.fenceSentinelPath(target)
						)
					) {
						throw new Error(
							`Fenced production database restore target has no global gate: ${target}`
						);
					}
				}
			}
			return;
		}

		const gate = parseAndVerifyDatabaseRestoreGlobalGate(
			await this.fileSystem.readUtf8File(
				this.globalGatePath,
				DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
			),
			this.config.queueSecret
		);
		if (activeIds.length && activeIds[0] !== gate.jobId) {
			throw new Error(
				`Database restore global gate belongs to another active job: ${gate.jobId}`
			);
		}

		const terminalPath = this.terminalManifestPath(gate.jobId);
		if (await this.fileSystem.pathExists(terminalPath)) {
			const terminal = await this.readManifestCandidate({
				jobId: gate.jobId,
				path: terminalPath
			});
			if (
				!verifyDatabaseRestoreJobManifest(
					terminal,
					this.config.queueSecret
				) ||
				terminal.target !== gate.target ||
				!['SUCCEEDED', 'FAILED', 'FAILED_FENCED', 'CANCELLED'].includes(
					terminal.status
				)
			) {
				throw new Error(
					`Terminal database restore global gate cannot be reconciled for ${gate.jobId}`
				);
			}
			if (terminal.status !== 'FAILED_FENCED') {
				await this.releaseGlobalGate(terminal);
			}
			return;
		}

		if (!activeIds.length) {
			if (this.isPublicationWithinGrace(gate.createdAt)) return;
			throw new Error(
				`Orphan database restore global gate requires manual reconciliation jobId=${gate.jobId}`
			);
		}
		const candidate = active.find(entry => entry.jobId === gate.jobId)!;
		const manifest = await this.readManifestCandidate(candidate);
		if (
			!verifyDatabaseRestoreJobManifest(
				manifest,
				this.config.queueSecret
			) ||
			manifest.target !== gate.target ||
			!['QUEUED', 'PROCESSING'].includes(manifest.status)
		) {
			throw new Error(
				`Active database restore global gate cannot be reconciled for ${gate.jobId}`
			);
		}
		if (this.config.productionMode && validatePublication) {
			try {
				await this.validateProductionPublication(manifest);
			} catch (error) {
				if (!(error instanceof RestorePublicationPending)) throw error;
				this.logger.warn(
					`Database restore job ${manifest.jobId} is waiting for publication confirmation during startup: ${error.code}`
				);
			}
		}
	}

	private async validateAndReconfirmFenceSentinels(): Promise<
		DatabaseRestoreTarget[]
	> {
		const fencedTargets: DatabaseRestoreTarget[] = [];
		for (const target of Object.keys(
			this.config.targets
		) as DatabaseRestoreTarget[]) {
			if (
				!(await this.fileSystem.pathExists(this.fenceSentinelPath(target)))
			) {
				continue;
			}
			const lockPath = this.targetLockPath(target);
			if (!(await this.fileSystem.pathExists(lockPath))) {
				throw new Error(
					`Fenced database restore target has no durable target lock: ${target}`
				);
			}
			const lock = parseAndVerifyDatabaseRestoreTargetLock(
				await this.fileSystem.readUtf8File(
					lockPath,
					DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
				),
				this.config.queueSecret
			);
			if (lock.target !== target) {
				throw new Error(
					`Database restore target lock path mismatch for ${target}`
				);
			}
			await this.readFenceSentinel(target, lock.jobId);
			const targetConfig = this.config.targets[target];
			const password = await this.fileSystem.readSecretFile(
				targetConfig.passwordFile
			);
			await this.fenceDatabase(targetConfig, password, true);
			fencedTargets.push(target);
		}
		return fencedTargets.sort();
	}

	private async validateAndReconcileTargetLocks(): Promise<void> {
		for (const target of Object.keys(
			this.config.targets
		) as DatabaseRestoreTarget[]) {
			const lockPath = this.targetLockPath(target);
			if (!(await this.fileSystem.pathExists(lockPath))) continue;
			const lock = parseAndVerifyDatabaseRestoreTargetLock(
				await this.fileSystem.readUtf8File(
					lockPath,
					DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
				),
				this.config.queueSecret
			);
			if (lock.target !== target) {
				throw new Error(
					`Database restore target lock path mismatch for ${target}`
				);
			}
			const [queuedExists, processingExists, terminalExists] =
				await Promise.all([
					this.fileSystem.pathExists(
						this.manifestPath(this.queuedDirectory, lock.jobId)
					),
					this.fileSystem.pathExists(
						this.manifestPath(this.processingDirectory, lock.jobId)
					),
					this.fileSystem.pathExists(this.terminalManifestPath(lock.jobId))
				]);
			if (!queuedExists && !processingExists && !terminalExists) {
				await this.assertPendingPublicationLock(lock);
				continue;
			}
			if (!queuedExists && !processingExists && terminalExists) {
				const terminal = await this.readManifestCandidate({
					jobId: lock.jobId,
					path: this.terminalManifestPath(lock.jobId)
				});
				if (
					!verifyDatabaseRestoreJobManifest(
						terminal,
						this.config.queueSecret
					) ||
					terminal.target !== target ||
					!['SUCCEEDED', 'FAILED', 'FAILED_FENCED', 'CANCELLED'].includes(
						terminal.status
					)
				) {
					throw new Error(
						`Terminal database restore lock cannot be reconciled target=${target} jobId=${lock.jobId}`
					);
				}
				if (terminal.status === 'FAILED_FENCED') {
					if (
						!(await this.fileSystem.pathExists(
							this.fenceSentinelPath(target)
						))
					) {
						throw new Error(
							`FAILED_FENCED restore has no durable fence sentinel for ${target}`
						);
					}
					await this.readFenceSentinel(target, terminal.jobId);
				} else {
					await this.releaseTargetLock(terminal);
				}
			}
		}
	}

	private async validateAndReconcileTransitionGates(): Promise<void> {
		const stateBySuffix: Record<
			string,
			DatabaseRestoreTransitionGateState
		> = {
			cancellable: 'CANCELLABLE',
			'cancel-pending': 'CANCEL_PENDING',
			cancelled: 'CANCEL_REQUESTED',
			destructive: 'DESTRUCTIVE'
		};
		const entries = (
			await this.fileSystem.listFileNames(this.gatesDirectory)
		)
			.filter(fileName => !fileName.startsWith('.'))
			.map(fileName => {
				const match = fileName.match(
					/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(cancellable|cancel-pending|cancelled|destructive)$/
				);
				if (!match || !isDatabaseRestoreJobId(match[1])) {
					throw new Error(
						`Unexpected database restore transition gate file: ${fileName}`
					);
				}
				return {
					fileName,
					jobId: match[1],
					state: stateBySuffix[match[2]]
				};
			});

		for (const entry of entries) {
			if (
				entries.filter(candidate => candidate.jobId === entry.jobId)
					.length !== 1
			) {
				throw new Error(
					`Ambiguous database restore transition gates for ${entry.jobId}`
				);
			}
			const gate = parseAndVerifyDatabaseRestoreTransitionGate(
				await this.fileSystem.readUtf8File(
					join(this.gatesDirectory, entry.fileName),
					DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
				),
				this.config.queueSecret
			);
			if (gate.jobId !== entry.jobId) {
				throw new Error(
					`Database restore transition gate path mismatch for ${entry.jobId}`
				);
			}

			const queuedPath = this.manifestPath(
				this.queuedDirectory,
				entry.jobId
			);
			const processingPath = this.manifestPath(
				this.processingDirectory,
				entry.jobId
			);
			const terminalPath = this.terminalManifestPath(entry.jobId);
			const [queuedExists, processingExists, terminalExists] =
				await Promise.all([
					this.fileSystem.pathExists(queuedPath),
					this.fileSystem.pathExists(processingPath),
					this.fileSystem.pathExists(terminalPath)
				]);
			if (!queuedExists && !processingExists && !terminalExists) {
				await this.assertPendingPublicationTransitionGate(gate);
				continue;
			}

			if (!queuedExists && !processingExists && terminalExists) {
				const terminal = await this.readManifestCandidate({
					jobId: entry.jobId,
					path: terminalPath
				});
				if (
					!verifyDatabaseRestoreJobManifest(
						terminal,
						this.config.queueSecret
					) ||
					terminal.target !== gate.target ||
					!['SUCCEEDED', 'FAILED', 'FAILED_FENCED', 'CANCELLED'].includes(
						terminal.status
					)
				) {
					throw new Error(
						`Terminal database restore gate cannot be reconciled for ${entry.jobId}`
					);
				}
				if (terminal.status !== 'FAILED_FENCED') {
					await this.fileSystem.removeFile(this.uploadPath(entry.jobId));
				}
				await this.fileSystem.removeFile(
					join(this.gatesDirectory, entry.fileName)
				);
				continue;
			}

			const activePath = processingExists ? processingPath : queuedPath;
			const active = await this.readManifestCandidate({
				jobId: entry.jobId,
				path: activePath
			});
			if (
				!verifyDatabaseRestoreJobManifest(
					active,
					this.config.queueSecret
				) ||
				active.target !== gate.target
			) {
				throw new Error(
					`Active database restore gate cannot be reconciled for ${entry.jobId}`
				);
			}
			if (
				queuedExists &&
				!processingExists &&
				entry.state === 'DESTRUCTIVE'
			) {
				throw new Error(
					`Queued database restore has a destructive gate for ${entry.jobId}`
				);
			}
		}
	}

	private async assertPendingPublicationLock(
		lock: ReturnType<typeof parseAndVerifyDatabaseRestoreTargetLock>
	): Promise<void> {
		if (!(await this.fileSystem.pathExists(this.globalGatePath))) {
			throw new Error(
				`Unpublished database restore lock requires manual reconciliation target=${lock.target} jobId=${lock.jobId} createdAt=${lock.createdAt}`
			);
		}
		const globalGate = parseAndVerifyDatabaseRestoreGlobalGate(
			await this.fileSystem.readUtf8File(
				this.globalGatePath,
				DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
			),
			this.config.queueSecret
		);
		if (
			globalGate.jobId !== lock.jobId ||
			globalGate.target !== lock.target ||
			globalGate.createdAt !== lock.createdAt ||
			!this.isPublicationWithinGrace(globalGate.createdAt)
		) {
			throw new Error(
				`Unpublished database restore lock requires manual reconciliation target=${lock.target} jobId=${lock.jobId} createdAt=${lock.createdAt}`
			);
		}
	}

	private async assertPendingPublicationTransitionGate(
		gate: ReturnType<typeof parseAndVerifyDatabaseRestoreTransitionGate>
	): Promise<void> {
		if (!(await this.fileSystem.pathExists(this.globalGatePath))) {
			throw new Error(
				`Orphan database restore transition gate for ${gate.jobId}`
			);
		}
		const globalGate = parseAndVerifyDatabaseRestoreGlobalGate(
			await this.fileSystem.readUtf8File(
				this.globalGatePath,
				DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
			),
			this.config.queueSecret
		);
		if (
			globalGate.jobId !== gate.jobId ||
			globalGate.target !== gate.target ||
			globalGate.createdAt !== gate.createdAt ||
			!this.isPublicationWithinGrace(globalGate.createdAt)
		) {
			throw new Error(
				`Orphan database restore transition gate for ${gate.jobId}`
			);
		}
	}

	private isPublicationWithinGrace(createdAt: string): boolean {
		const ageMs = Date.now() - Date.parse(createdAt);
		return ageMs >= 0 && ageMs <= DATABASE_RESTORE_PUBLICATION_GRACE_MS;
	}

	private async findFirstJobManifest(directory: string) {
		return (await this.findJobManifests(directory))[0] || null;
	}

	private async findJobManifests(directory: string) {
		return (await this.fileSystem.listFileNames(directory))
			.filter(fileName => fileName.endsWith('.json'))
			.map(fileName => ({
				fileName,
				jobId: fileName.slice(0, -'.json'.length),
				path: join(directory, fileName)
			}))
			.filter(entry => isDatabaseRestoreJobId(entry.jobId));
	}

	private async quarantineUnreadableManifest(input: {
		jobId: string;
		path: string;
	}): Promise<void> {
		const quarantinePath = join(
			this.terminalDirectory,
			`${input.jobId}.invalid-manifest`
		);
		await this.fileSystem
			.rename(input.path, quarantinePath)
			.catch(() => undefined);
	}

	private async cleanupCompletedProcessingFiles(
		jobId: string
	): Promise<void> {
		await this.fileSystem.removeFile(
			this.manifestPath(this.processingDirectory, jobId)
		);
		await this.fileSystem.removeFile(this.progressPath(jobId));
		await this.fileSystem.removeFile(
			this.publicationValidationPath(jobId)
		);
		for (const state of [
			'CANCELLABLE',
			'CANCEL_PENDING',
			'CANCEL_REQUESTED',
			'DESTRUCTIVE'
		] as const) {
			await this.fileSystem.removeFile(
				this.transitionGatePath(jobId, state)
			);
		}
	}

	private async findSafetyPath(jobId: string): Promise<string> {
		const processingPath = this.processingSafetyPath(jobId);
		if (await this.fileSystem.pathExists(processingPath))
			return processingPath;
		const terminalPath = this.terminalSafetyPath(jobId);
		if (await this.fileSystem.pathExists(terminalPath))
			return terminalPath;
		throw new Error('Safety backup is missing');
	}

	private get uploadsDirectory(): string {
		return join(this.config.storageDirectory, 'uploads');
	}

	private get queuedDirectory(): string {
		return join(this.config.storageDirectory, 'queued');
	}

	private get processingDirectory(): string {
		return join(this.config.storageDirectory, 'processing');
	}

	private get terminalDirectory(): string {
		return join(this.config.storageDirectory, 'terminal');
	}

	private get locksDirectory(): string {
		return join(this.config.storageDirectory, 'locks');
	}

	private get gatesDirectory(): string {
		return join(this.config.storageDirectory, 'gates');
	}

	private get fencesDirectory(): string {
		return join(this.config.storageDirectory, 'fences');
	}

	private get receiptsDirectory(): string {
		return join(this.config.storageDirectory, 'receipts');
	}

	private get readinessPath(): string {
		return join(this.config.storageDirectory, 'worker-ready.json');
	}

	private manifestPath(directory: string, jobId: string): string {
		return join(directory, `${jobId}.json`);
	}

	private terminalManifestPath(jobId: string): string {
		return this.manifestPath(this.terminalDirectory, jobId);
	}

	private progressPath(jobId: string): string {
		return join(this.processingDirectory, `${jobId}.state`);
	}

	private publicationValidationPath(jobId: string): string {
		return join(this.processingDirectory, `${jobId}.publication`);
	}

	private targetLockPath(target: DatabaseRestoreTarget): string {
		return join(this.locksDirectory, `${target}.lock`);
	}

	private get globalGatePath(): string {
		return join(this.locksDirectory, 'global.lock');
	}

	private publishReceiptPath(jobId: string): string {
		return join(this.receiptsDirectory, `${jobId}.json`);
	}

	private transitionGatePath(
		jobId: string,
		state: DatabaseRestoreTransitionGateState
	): string {
		const suffix = {
			CANCELLABLE: 'cancellable',
			CANCEL_PENDING: 'cancel-pending',
			CANCEL_REQUESTED: 'cancelled',
			DESTRUCTIVE: 'destructive'
		}[state];
		return join(this.gatesDirectory, `${jobId}.${suffix}`);
	}

	private fenceSentinelPath(target: DatabaseRestoreTarget): string {
		return join(this.fencesDirectory, `${target}.json`);
	}

	private uploadPath(jobId: string): string {
		return join(this.uploadsDirectory, `${jobId}.dump`);
	}

	private safetyFileName(jobId: string): string {
		return `safety-${jobId}.dump`;
	}

	private processingSafetyPath(jobId: string): string {
		return join(this.processingDirectory, this.safetyFileName(jobId));
	}

	private terminalSafetyPath(jobId: string): string {
		return join(this.terminalDirectory, this.safetyFileName(jobId));
	}

	private isPlainObject(value: unknown): value is Record<string, unknown> {
		return (
			typeof value === 'object' && value !== null && !Array.isArray(value)
		);
	}

	private isIsoTimestamp(value: unknown): value is string {
		return (
			typeof value === 'string' &&
			!Number.isNaN(Date.parse(value)) &&
			new Date(value).toISOString() === value
		);
	}

	private safeErrorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
