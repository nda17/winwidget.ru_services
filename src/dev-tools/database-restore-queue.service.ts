import {
	DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES,
	DATABASE_RESTORE_GLOBAL_GATE_VERSION,
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	DATABASE_RESTORE_PUBLICATION_GRACE_MS,
	DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
	DATABASE_RESTORE_PUBLISH_RECEIPT_VERSION,
	DATABASE_RESTORE_QUEUE_MANIFEST_VERSION,
	DATABASE_RESTORE_TARGET_SETTINGS,
	DATABASE_RESTORE_TARGET_LOCK_VERSION,
	DATABASE_RESTORE_TARGETS,
	DATABASE_RESTORE_TRANSITION_GATE_VERSION,
	DatabaseRestoreJobPayload,
	DatabaseRestoreTarget,
	PublicDatabaseRestoreJob,
	SignedDatabaseRestoreProductionPermit,
	SignedDatabaseRestoreJobManifest,
	isDatabaseRestoreJobId,
	isDatabaseRestoreTarget,
	parseAndVerifyDatabaseRestoreJobManifest,
	parseAndVerifyDatabaseRestoreGlobalGate,
	parseAndVerifyDatabaseRestoreProductionPermit,
	parseAndVerifyDatabaseRestorePublishReceipt,
	parseAndVerifyDatabaseRestoreTargetLock,
	parseAndVerifyDatabaseRestoreTransitionGate,
	signDatabaseRestoreGlobalGate,
	signDatabaseRestoreJobPayload,
	signDatabaseRestorePublishReceipt,
	signDatabaseRestoreTargetLock,
	signDatabaseRestoreTransitionGate,
	toPublicDatabaseRestoreJob,
	verifyDatabaseRestoreProductionPermit
} from '@/dev-tools/database-restore-queue.contract';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	unlink
} from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';

const DATABASE_RESTORE_STORAGE_ENV = 'DATABASE_RESTORE_STORAGE_DIR';
const DATABASE_RESTORE_QUEUE_SECRET_ENV = 'DATABASE_RESTORE_QUEUE_SECRET';
const DATABASE_RESTORE_PRODUCTION_ENABLED_ENV =
	'DATABASE_RESTORE_PRODUCTION_ENABLED';
const DATABASE_RESTORE_PRODUCTION_PERMIT_ENV =
	'DATABASE_RESTORE_PRODUCTION_PERMIT';
const APP_REVISION_ENV = 'APP_REVISION';
const APP_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DATABASE_RESTORE_QUEUE_DIRECTORIES = [
	'uploads',
	'queued',
	'processing',
	'terminal',
	'locks',
	'gates',
	'fences',
	'permits',
	'receipts'
] as const;

type DatabaseRestoreQueueDirectory =
	(typeof DATABASE_RESTORE_QUEUE_DIRECTORIES)[number];

interface DatabaseRestoreQueuePaths {
	root: string;
	uploads: string;
	queued: string;
	processing: string;
	terminal: string;
	locks: string;
	gates: string;
	fences: string;
	permits: string;
	receipts: string;
}

type DatabaseRestoreTransitionGateState =
	| 'CANCELLABLE'
	| 'CANCEL_PENDING'
	| 'CANCEL_REQUESTED'
	| 'DESTRUCTIVE';

export type DatabaseRestoreBeforePublish = (
	job: PublicDatabaseRestoreJob
) => Promise<void>;

export interface DatabaseRestorePublishedContext {
	job: PublicDatabaseRestoreJob;
	manifestStatus: SignedDatabaseRestoreJobManifest['status'];
	manifestSignature: string;
	productionPermit: {
		appRevision: string;
		expiresAt: string;
		runId: string;
		evidence: string;
		incident: string;
		permitSignature: string;
	} | null;
}

export type DatabaseRestoreAfterPublish = (
	context: DatabaseRestorePublishedContext
) => Promise<{ auditEventId: string }>;

export type DatabaseRestoreBeforeCancel = (
	job: PublicDatabaseRestoreJob
) => Promise<void>;

@Injectable()
export class DatabaseRestoreQueueService {
	async getSettings() {
		const production = this.isProductionMode();
		let approved: {
			target: DatabaseRestoreTarget;
			jobId: string;
			expiresAt: string;
		} | null = null;
		let enabled = !production;

		if (production && this.isProductionRestoreGateEnabled()) {
			const secret = this.getQueueSecret();
			const permit = this.getProductionPermit(secret, true);
			if (permit) {
				approved = {
					target: permit.target,
					jobId: permit.jobId,
					expiresAt: permit.expiresAt
				};
				const paths = await this.ensureStorageDirectories();
				await this.reconcileGlobalGate(paths, secret);
				enabled =
					Date.parse(permit.expiresAt) > Date.now() &&
					(await this.isPermitAvailable(paths, permit, secret));
			}
		}

		return {
			enabled,
			approved,
			maxFileSizeBytes: DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
			allowedFileExtension: '.dump',
			targets: DATABASE_RESTORE_TARGET_SETTINGS.map(target => ({
				...target
			}))
		};
	}

	async enqueue(
		targetValue: string,
		file: Express.Multer.File | undefined,
		confirmation: string,
		requestedBy: string,
		beforePublish: DatabaseRestoreBeforePublish,
		requestedJobId?: string,
		afterPublish?: DatabaseRestoreAfterPublish
	): Promise<PublicDatabaseRestoreJob> {
		const target = this.assertTarget(targetValue);
		this.assertConfirmation(target, confirmation);
		const validatedFile = this.assertUpload(file);
		const secret = this.getQueueSecret();
		const paths = await this.ensureStorageDirectories();
		const normalizedRequestedJobId = requestedJobId
			? this.assertJobId(requestedJobId)
			: null;
		const productionPermit = this.resolveProductionPermitForEnqueue(
			target,
			normalizedRequestedJobId,
			secret
		);
		if (this.isProductionMode() && !afterPublish) {
			throw new ServiceUnavailableException(
				'Не настроено подтверждение публикации восстановления'
			);
		}
		const jobId =
			productionPermit?.jobId || normalizedRequestedJobId || randomUUID();
		const sha256 = createHash('sha256')
			.update(validatedFile.buffer)
			.digest('hex');
		const existingManifest = await this.findManifest(jobId, paths, secret);
		if (existingManifest) {
			if (
				existingManifest.target !== target ||
				existingManifest.requestedBy !== requestedBy ||
				existingManifest.originalFileName !== validatedFile.originalName ||
				existingManifest.fileSize !== validatedFile.buffer.length ||
				existingManifest.sha256 !== sha256
			) {
				throw new ConflictException(
					'requestId уже принадлежит другому заданию восстановления'
				);
			}

			if (afterPublish) {
				await this.ensurePublishReceipt(
					paths,
					existingManifest,
					secret,
					productionPermit,
					afterPublish
				);
			}
			if (productionPermit) {
				await this.consumeProductionPermit(
					paths,
					productionPermit,
					secret
				);
			}
			return this.toPublicJob(existingManifest, paths, secret);
		}
		if (productionPermit) this.assertPermitNotExpired(productionPermit);
		await this.assertTargetNotFenced(paths.fences, target, secret);
		const uploadFileName = `${jobId}.dump`;
		const uploadPath = join(paths.uploads, uploadFileName);
		const manifestPath = join(paths.queued, `${jobId}.json`);
		const stagedManifestPath = join(paths.queued, `.${jobId}.staged`);
		const uploadTempPath = join(
			paths.uploads,
			`.${jobId}.${randomUUID()}.tmp`
		);
		const requestedAt = new Date().toISOString();
		const cancellableGatePath = this.transitionGatePath(
			paths.gates,
			jobId,
			'CANCELLABLE'
		);
		const gateTempPath = join(
			paths.gates,
			`.${jobId}.${randomUUID()}.gate.tmp`
		);
		let manifestPublished = false;
		let uploadPublished = false;
		let stagedManifestCreated = false;
		let targetLockAcquired = false;
		let transitionGateCreated = false;
		let globalGateAcquired = false;
		let productionPermitClaimed = false;

		try {
			await this.acquireGlobalGate(
				paths,
				target,
				jobId,
				requestedAt,
				secret
			);
			globalGateAcquired = true;
			await this.assertNoActiveTargetLocks(paths.locks, secret);
			if (productionPermit) {
				await this.claimProductionPermit(paths, productionPermit, secret);
				productionPermitClaimed = true;
			}
			await this.writeDurableFile(uploadTempPath, validatedFile.buffer);
			await link(uploadTempPath, uploadPath);
			uploadPublished = true;
			await chmod(uploadPath, FILE_MODE);
			await this.syncDirectory(paths.uploads);
			await this.deleteFileIfPresent(uploadTempPath);

			const payload: DatabaseRestoreJobPayload = {
				version: DATABASE_RESTORE_QUEUE_MANIFEST_VERSION,
				jobId,
				target,
				status: 'QUEUED',
				uploadFileName,
				originalFileName: validatedFile.originalName,
				fileSize: validatedFile.buffer.length,
				sha256,
				requestedBy,
				requestedAt,
				startedAt: null,
				finishedAt: null,
				attempt: 0,
				error: null,
				result: null
			};
			const manifest = signDatabaseRestoreJobPayload(payload, secret);
			const publicJob = toPublicDatabaseRestoreJob(manifest, {
				canCancel: true
			});
			await this.writeDurableFile(
				stagedManifestPath,
				Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')
			);
			stagedManifestCreated = true;
			await this.syncDirectory(paths.queued);
			await this.acquireTargetLock(
				paths.locks,
				target,
				jobId,
				requestedAt,
				secret
			);
			targetLockAcquired = true;
			const transitionGate = signDatabaseRestoreTransitionGate(
				{
					version: DATABASE_RESTORE_TRANSITION_GATE_VERSION,
					kind: 'DATABASE_RESTORE_TRANSITION_GATE',
					target,
					jobId,
					createdAt: requestedAt
				},
				secret
			);
			await this.writeDurableFile(
				gateTempPath,
				Buffer.from(`${JSON.stringify(transitionGate)}\n`, 'utf8')
			);
			await link(gateTempPath, cancellableGatePath);
			transitionGateCreated = true;
			await this.syncDirectory(paths.gates);
			await this.deleteFileIfPresent(gateTempPath);
			await beforePublish(publicJob);
			await rename(stagedManifestPath, manifestPath);
			stagedManifestCreated = false;
			manifestPublished = true;
			await this.syncDirectory(paths.queued);
			if (afterPublish) {
				await this.ensurePublishReceipt(
					paths,
					manifest,
					secret,
					productionPermit,
					afterPublish
				);
			}
			if (productionPermit) {
				await this.consumeProductionPermit(
					paths,
					productionPermit,
					secret
				);
				productionPermitClaimed = false;
			}

			return this.toPublicJob(manifest, paths, secret);
		} catch (error) {
			await this.deleteFileIfPresent(uploadTempPath);
			if (stagedManifestCreated) {
				await this.deleteFileIfPresent(stagedManifestPath);
			}
			await this.deleteFileIfPresent(gateTempPath);
			if (!manifestPublished) {
				if (uploadPublished) {
					await this.deleteFileIfPresent(uploadPath);
				}
				await this.syncDirectory(paths.uploads);
				await this.syncDirectory(paths.queued);
				if (transitionGateCreated) {
					await this.deleteFileIfPresent(cancellableGatePath);
					await this.syncDirectory(paths.gates);
				}
				if (targetLockAcquired) {
					await this.releaseOwnedTargetLock(
						paths.locks,
						target,
						jobId,
						secret
					);
				}
				if (productionPermitClaimed && productionPermit) {
					await this.releaseProductionPermitClaim(
						paths,
						productionPermit,
						secret
					);
				}
				if (globalGateAcquired) {
					await this.releaseOwnedGlobalGate(paths, jobId, secret);
				}
			}
			throw error;
		}
	}

	async getJob(jobId: string): Promise<PublicDatabaseRestoreJob> {
		if (!isDatabaseRestoreJobId(jobId)) {
			throw new BadRequestException(
				'Некорректный ID задания восстановления'
			);
		}

		const secret = this.getQueueSecret();
		const paths = await this.ensureStorageDirectories();
		const manifest = await this.findManifest(jobId, paths, secret);
		if (!manifest) {
			throw new NotFoundException('Задание восстановления не найдено');
		}
		const publicJob = await this.toPublicJob(manifest, paths, secret);
		if (['CANCELLED', 'SUCCEEDED', 'FAILED'].includes(manifest.status)) {
			await this.reconcileGlobalGate(paths, secret);
		}
		return publicJob;
	}

	async cancel(
		jobId: string,
		beforeCancel: DatabaseRestoreBeforeCancel
	): Promise<PublicDatabaseRestoreJob> {
		if (!isDatabaseRestoreJobId(jobId)) {
			throw new BadRequestException(
				'Некорректный ID задания восстановления'
			);
		}

		const secret = this.getQueueSecret();
		const paths = await this.ensureStorageDirectories();
		const manifest = await this.findManifest(jobId, paths, secret);
		if (!manifest) {
			throw new NotFoundException('Задание восстановления не найдено');
		}
		if (manifest.status === 'CANCELLED') {
			return toPublicDatabaseRestoreJob(manifest);
		}
		if (!['QUEUED', 'PROCESSING'].includes(manifest.status)) {
			throw new ConflictException(
				'Завершённое восстановление нельзя отменить'
			);
		}

		let gateState = await this.readTransitionGateState(
			paths.gates,
			manifest,
			secret
		);
		if (gateState === 'CANCEL_REQUESTED') {
			return toPublicDatabaseRestoreJob(manifest, {
				cancellationRequested: true
			});
		}
		if (gateState === 'CANCEL_PENDING') {
			throw new ConflictException(
				'Отмена уже резервируется и ожидает записи в журнал событий'
			);
		}
		if (gateState === 'DESTRUCTIVE') {
			throw new ConflictException(
				'Отмена недоступна: worker уже начал защищённую фазу восстановления'
			);
		}

		let cancellationReserved = false;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				await rename(
					this.transitionGatePath(paths.gates, jobId, 'CANCELLABLE'),
					this.transitionGatePath(paths.gates, jobId, 'CANCEL_PENDING')
				);
				await this.syncDirectory(paths.gates);
				cancellationReserved = true;
				break;
			} catch (error) {
				if (!this.isMissingFileError(error)) throw error;
			}

			gateState = await this.readTransitionGateState(
				paths.gates,
				manifest,
				secret
			);
			if (gateState === 'CANCEL_REQUESTED') {
				return toPublicDatabaseRestoreJob(manifest, {
					cancellationRequested: true
				});
			}
			if (gateState === 'CANCEL_PENDING') {
				throw new ConflictException(
					'Отмена уже резервируется и ожидает записи в журнал событий'
				);
			}
			if (gateState === 'DESTRUCTIVE') {
				throw new ConflictException(
					'Отмена недоступна: worker уже начал защищённую фазу восстановления'
				);
			}
		}

		if (!cancellationReserved) {
			throw new ServiceUnavailableException(
				'Не удалось надёжно зарезервировать отмену восстановления'
			);
		}

		const cancellableJob = toPublicDatabaseRestoreJob(manifest, {
			cancellationPending: true
		});
		try {
			await beforeCancel(cancellableJob);
		} catch (error) {
			await this.rollbackCancellationReservation(
				paths.gates,
				manifest,
				secret
			);
			throw error;
		}

		try {
			await rename(
				this.transitionGatePath(paths.gates, jobId, 'CANCEL_PENDING'),
				this.transitionGatePath(paths.gates, jobId, 'CANCEL_REQUESTED')
			);
			await this.syncDirectory(paths.gates);
		} catch (error) {
			if (!this.isMissingFileError(error)) throw error;
			const finalState = await this.readTransitionGateState(
				paths.gates,
				manifest,
				secret
			);
			if (finalState !== 'CANCEL_REQUESTED') {
				throw new ServiceUnavailableException(
					'Отмена записана в журнал, но её durable-состояние требует сверки'
				);
			}
		}

		return toPublicDatabaseRestoreJob(manifest, {
			cancellationRequested: true
		});
	}

	private async rollbackCancellationReservation(
		gatesDirectory: string,
		manifest: SignedDatabaseRestoreJobManifest,
		secret: string
	): Promise<void> {
		try {
			await rename(
				this.transitionGatePath(
					gatesDirectory,
					manifest.jobId,
					'CANCEL_PENDING'
				),
				this.transitionGatePath(
					gatesDirectory,
					manifest.jobId,
					'CANCELLABLE'
				)
			);
			await this.syncDirectory(gatesDirectory);
			return;
		} catch (error) {
			if (!this.isMissingFileError(error)) throw error;
		}

		const state = await this.readTransitionGateState(
			gatesDirectory,
			manifest,
			secret
		);
		if (state !== 'CANCELLABLE') {
			throw new ServiceUnavailableException(
				'Не удалось откатить резерв отмены после сбоя журнала событий'
			);
		}
	}

	private async findManifest(
		jobId: string,
		paths: DatabaseRestoreQueuePaths,
		secret: string
	): Promise<SignedDatabaseRestoreJobManifest | null> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const candidates = await Promise.all(
				(['terminal', 'processing', 'queued'] as const).map(directory =>
					this.readManifestIfPresent(
						join(paths[directory], `${jobId}.json`),
						secret
					)
				)
			);
			const manifest = candidates.find(candidate => candidate !== null);
			if (!manifest) continue;
			if (manifest.jobId !== jobId) {
				throw new ServiceUnavailableException(
					'Состояние задания восстановления повреждено'
				);
			}
			return manifest;
		}

		return null;
	}

	private async toPublicJob(
		manifest: SignedDatabaseRestoreJobManifest,
		paths: DatabaseRestoreQueuePaths,
		secret: string
	): Promise<PublicDatabaseRestoreJob> {
		const publicationConfirmed = await this.isPublicationConfirmed(
			manifest,
			paths,
			secret
		);
		if (!['QUEUED', 'PROCESSING'].includes(manifest.status)) {
			return toPublicDatabaseRestoreJob(manifest, {
				publicationConfirmed
			});
		}

		const gateState = await this.readTransitionGateState(
			paths.gates,
			manifest,
			secret
		);
		return toPublicDatabaseRestoreJob(manifest, {
			canCancel: gateState === 'CANCELLABLE',
			cancellationPending: gateState === 'CANCEL_PENDING',
			cancellationRequested: gateState === 'CANCEL_REQUESTED',
			publicationConfirmed
		});
	}

	private async isPublicationConfirmed(
		manifest: SignedDatabaseRestoreJobManifest,
		paths: DatabaseRestoreQueuePaths,
		secret: string
	): Promise<boolean> {
		const receipt = await this.readPublishReceiptIfPresent(
			this.publishReceiptPath(paths, manifest.jobId),
			secret
		);
		if (!receipt) return false;
		if (
			receipt.jobId !== manifest.jobId ||
			receipt.target !== manifest.target ||
			receipt.manifestStatus !== 'QUEUED' ||
			Date.parse(receipt.publishedAt) < Date.parse(manifest.requestedAt) ||
			(manifest.status === 'QUEUED' &&
				receipt.manifestSignature !== manifest.signature)
		) {
			return false;
		}

		if (!this.isProductionMode()) return true;
		if (
			!receipt.appRevision ||
			!receipt.permitSignature ||
			!receipt.permitExpiresAt ||
			!receipt.runId ||
			!receipt.evidence ||
			!receipt.incident ||
			receipt.appRevision !== process.env[APP_REVISION_ENV]?.trim() ||
			Date.parse(receipt.publishedAt) > Date.parse(receipt.permitExpiresAt)
		) {
			return false;
		}

		return verifyDatabaseRestoreProductionPermit(
			{
				version: DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
				kind: 'DATABASE_RESTORE_PRODUCTION_PERMIT',
				appRevision: receipt.appRevision,
				target: receipt.target,
				jobId: receipt.jobId,
				expiresAt: receipt.permitExpiresAt,
				runId: receipt.runId,
				evidence: receipt.evidence,
				incident: receipt.incident,
				signature: receipt.permitSignature
			},
			secret
		);
	}

	private async readTransitionGateState(
		gatesDirectory: string,
		manifest: SignedDatabaseRestoreJobManifest,
		secret: string
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
						this.transitionGatePath(gatesDirectory, manifest.jobId, state),
						secret
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
				throw new ServiceUnavailableException(
					'Защитный переход восстановления принадлежит другому заданию'
				);
			}
			return candidate.state;
		}

		throw new ServiceUnavailableException(
			'Защитный переход восстановления отсутствует или повреждён'
		);
	}

	private async readTransitionGateIfPresent(
		gatePath: string,
		secret: string
	) {
		let stats;
		try {
			stats = await lstat(gatePath);
		} catch (error) {
			if (this.isMissingFileError(error)) return null;
			throw error;
		}
		if (
			!stats.isFile() ||
			stats.isSymbolicLink() ||
			stats.size < 1 ||
			stats.size > DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
		) {
			throw new ServiceUnavailableException(
				'Защитный переход восстановления повреждён'
			);
		}

		try {
			return parseAndVerifyDatabaseRestoreTransitionGate(
				await readFile(gatePath, 'utf8'),
				secret
			);
		} catch (error) {
			if (this.isMissingFileError(error)) return null;
			throw new ServiceUnavailableException(
				'Подпись защитного перехода восстановления неверна'
			);
		}
	}

	private transitionGatePath(
		gatesDirectory: string,
		jobId: string,
		state: DatabaseRestoreTransitionGateState
	): string {
		const suffix = {
			CANCELLABLE: 'cancellable',
			CANCEL_PENDING: 'cancel-pending',
			CANCEL_REQUESTED: 'cancelled',
			DESTRUCTIVE: 'destructive'
		}[state];
		return join(gatesDirectory, `${jobId}.${suffix}`);
	}

	private assertTarget(target: string): DatabaseRestoreTarget {
		if (!isDatabaseRestoreTarget(target)) {
			throw new BadRequestException('Неизвестная база для восстановления');
		}
		return target;
	}

	private assertJobId(jobId: string): string {
		if (!isDatabaseRestoreJobId(jobId)) {
			throw new BadRequestException(
				'Некорректный requestId задания восстановления'
			);
		}
		return jobId.toLowerCase();
	}

	private assertConfirmation(
		target: DatabaseRestoreTarget,
		confirmation: string
	): void {
		const settings = DATABASE_RESTORE_TARGET_SETTINGS.find(
			candidate => candidate.id === target
		);
		if (!settings || confirmation !== settings.confirmation) {
			throw new BadRequestException(
				`Введите подтверждение: ${settings?.confirmation ?? ''}`.trim()
			);
		}
	}

	private assertUpload(file: Express.Multer.File | undefined): {
		buffer: Buffer;
		originalName: string;
	} {
		if (!file?.buffer?.length) {
			throw new BadRequestException('Файл backup не передан');
		}
		if (
			file.buffer.length > DATABASE_RESTORE_MAX_FILE_SIZE_BYTES ||
			file.size > DATABASE_RESTORE_MAX_FILE_SIZE_BYTES
		) {
			throw new BadRequestException(
				'Файл backup должен быть меньше 50 МБ'
			);
		}
		if (file.size !== file.buffer.length) {
			throw new BadRequestException('Размер файла backup не совпадает');
		}

		const rawOriginalName = file.originalname?.normalize('NFC');
		const originalName = rawOriginalName?.trim();
		if (
			!originalName ||
			rawOriginalName !== originalName ||
			originalName.length > 255 ||
			/[\u0000-\u001f\u007f\\/]/.test(originalName) ||
			!originalName.toLowerCase().endsWith('.dump')
		) {
			throw new BadRequestException(
				'Загрузите backup в формате .dump без пути в имени файла'
			);
		}

		return {
			buffer: file.buffer,
			originalName
		};
	}

	private isProductionMode(): boolean {
		return (process.env.MODE || '').trim().toLowerCase() === 'production';
	}

	private isProductionRestoreGateEnabled(): boolean {
		return process.env[DATABASE_RESTORE_PRODUCTION_ENABLED_ENV] === 'true';
	}

	private resolveProductionPermitForEnqueue(
		target: DatabaseRestoreTarget,
		requestedJobId: string | null,
		secret: string
	): SignedDatabaseRestoreProductionPermit | null {
		if (!this.isProductionMode()) return null;
		if (!this.isProductionRestoreGateEnabled()) {
			throw new ServiceUnavailableException(
				'Production-восстановление БД отключено release-gate'
			);
		}
		if (!requestedJobId) {
			throw new BadRequestException(
				'Production-восстановление требует approved requestId'
			);
		}
		const permit = this.getProductionPermit(secret, true);
		if (!permit) {
			throw new ServiceUnavailableException(
				'Production-восстановление требует подписанный one-shot permit'
			);
		}
		if (permit.target !== target || permit.jobId !== requestedJobId) {
			throw new ConflictException(
				'Цель или requestId не совпадают с approved restore permit'
			);
		}
		return permit;
	}

	private getProductionPermit(
		secret: string,
		allowExpired: boolean
	): SignedDatabaseRestoreProductionPermit | null {
		const rawPermit = process.env[DATABASE_RESTORE_PRODUCTION_PERMIT_ENV];
		if (!rawPermit) return null;
		if (
			rawPermit !== rawPermit.trim() ||
			Buffer.byteLength(rawPermit, 'utf8') >
				DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
		) {
			throw new ServiceUnavailableException(
				'Production restore permit имеет небезопасный формат'
			);
		}

		let permit: SignedDatabaseRestoreProductionPermit;
		try {
			permit = parseAndVerifyDatabaseRestoreProductionPermit(
				rawPermit,
				secret
			);
		} catch {
			throw new ServiceUnavailableException(
				'Подпись или формат production restore permit неверны'
			);
		}

		const appRevision = process.env[APP_REVISION_ENV]?.trim();
		if (!appRevision || !APP_REVISION_PATTERN.test(appRevision)) {
			throw new ServiceUnavailableException(
				'APP_REVISION должен содержать exact 40-character Git revision'
			);
		}
		if (permit.appRevision !== appRevision) {
			throw new ServiceUnavailableException(
				'Production restore permit выпущен для другой ревизии'
			);
		}
		if (!allowExpired && Date.parse(permit.expiresAt) <= Date.now()) {
			return null;
		}
		return permit;
	}

	private assertPermitNotExpired(
		permit: SignedDatabaseRestoreProductionPermit
	): void {
		if (Date.parse(permit.expiresAt) <= Date.now()) {
			throw new ServiceUnavailableException(
				'Production restore permit истёк'
			);
		}
	}

	private async isPermitAvailable(
		paths: DatabaseRestoreQueuePaths,
		permit: SignedDatabaseRestoreProductionPermit,
		secret: string
	): Promise<boolean> {
		const [active, consumed, receipt, globalGate] = await Promise.all([
			this.readProductionPermitIfPresent(
				this.activePermitPath(paths),
				secret
			),
			this.readProductionPermitIfPresent(
				this.consumedPermitPath(paths, permit.jobId),
				secret
			),
			this.readPublishReceiptIfPresent(
				this.publishReceiptPath(paths, permit.jobId),
				secret
			),
			this.readGlobalGateIfPresent(this.globalGatePath(paths), secret)
		]);
		if (active && active.signature !== permit.signature) return false;
		if (consumed && consumed.signature !== permit.signature) {
			throw new ServiceUnavailableException(
				'Consumed restore permit не совпадает с configured permit'
			);
		}
		if (
			receipt &&
			(receipt.jobId !== permit.jobId || receipt.target !== permit.target)
		) {
			throw new ServiceUnavailableException(
				'Publish receipt не совпадает с configured permit'
			);
		}
		return !active && !consumed && !receipt && !globalGate;
	}

	private async acquireGlobalGate(
		paths: DatabaseRestoreQueuePaths,
		target: DatabaseRestoreTarget,
		jobId: string,
		createdAt: string,
		secret: string
	): Promise<void> {
		const gatePath = this.globalGatePath(paths);
		const temporaryPath = join(
			paths.locks,
			`.global.${jobId}.${randomUUID()}.tmp`
		);
		const gate = signDatabaseRestoreGlobalGate(
			{
				version: DATABASE_RESTORE_GLOBAL_GATE_VERSION,
				kind: 'DATABASE_RESTORE_GLOBAL_GATE',
				target,
				jobId,
				createdAt
			},
			secret
		);
		await this.writeDurableFile(
			temporaryPath,
			Buffer.from(`${JSON.stringify(gate)}\n`, 'utf8')
		);
		let linked = false;
		try {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					await link(temporaryPath, gatePath);
					linked = true;
					await this.syncDirectory(paths.locks);
					return;
				} catch (error) {
					if (linked) {
						try {
							await this.releaseOwnedGlobalGate(
								paths,
								jobId,
								secret,
								gate.signature
							);
						} catch {
							throw new ServiceUnavailableException(
								'Не удалось безопасно откатить глобальный restore gate; ' +
									'требуется ручная сверка'
							);
						}
						throw error;
					}
					if (!this.isFileError(error, 'EEXIST')) throw error;
				}
				const active = await this.reconcileGlobalGate(paths, secret);
				if (active) {
					throw new ConflictException(
						`Восстановление базы ${active.target} уже является глобально активным`
					);
				}
			}
			throw new ServiceUnavailableException(
				'Не удалось атомарно захватить глобальный restore gate'
			);
		} finally {
			await this.deleteFileIfPresent(temporaryPath);
		}
	}

	private async reconcileGlobalGate(
		paths: DatabaseRestoreQueuePaths,
		secret: string
	) {
		const gate = await this.readGlobalGateIfPresent(
			this.globalGatePath(paths),
			secret
		);
		if (!gate) return null;
		const manifest = await this.findManifest(gate.jobId, paths, secret);
		if (!manifest) {
			if (this.isPublicationWithinGrace(gate.createdAt)) return gate;
			throw new ServiceUnavailableException(
				'Глобальный restore gate требует ручной сверки'
			);
		}
		if (manifest.target !== gate.target) {
			throw new ServiceUnavailableException(
				'Глобальный restore gate требует ручной сверки'
			);
		}
		if (['CANCELLED', 'SUCCEEDED', 'FAILED'].includes(manifest.status)) {
			await this.releaseOwnedGlobalGate(paths, gate.jobId, secret);
			return null;
		}
		return gate;
	}

	private isPublicationWithinGrace(createdAt: string): boolean {
		const ageMs = Date.now() - Date.parse(createdAt);
		return ageMs >= 0 && ageMs <= DATABASE_RESTORE_PUBLICATION_GRACE_MS;
	}

	private async releaseOwnedGlobalGate(
		paths: DatabaseRestoreQueuePaths,
		jobId: string,
		secret: string,
		expectedSignature?: string
	): Promise<void> {
		const gatePath = this.globalGatePath(paths);
		const gate = await this.readGlobalGateIfPresent(gatePath, secret);
		if (!gate) return;
		if (
			gate.jobId !== jobId ||
			(expectedSignature !== undefined &&
				gate.signature !== expectedSignature)
		) {
			throw new ServiceUnavailableException(
				'Глобальный restore gate сменил владельца'
			);
		}
		const releasePath = join(
			paths.locks,
			`.release-global-${jobId}-${randomUUID()}`
		);
		try {
			await rename(gatePath, releasePath);
		} catch (error) {
			if (this.isMissingFileError(error)) return;
			throw error;
		}
		const claimed = await this.readGlobalGateIfPresent(
			releasePath,
			secret
		);
		if (
			!claimed ||
			claimed.jobId !== jobId ||
			(expectedSignature !== undefined &&
				claimed.signature !== expectedSignature)
		) {
			throw new ServiceUnavailableException(
				'Claimed global restore gate повреждён'
			);
		}
		await unlink(releasePath);
		await this.syncDirectory(paths.locks);
	}

	private async assertNoActiveTargetLocks(
		locksDirectory: string,
		secret: string
	): Promise<void> {
		for (const target of DATABASE_RESTORE_TARGETS) {
			const lock = await this.readTargetLockIfPresent(
				join(locksDirectory, `${target}.lock`),
				secret
			);
			if (lock) {
				throw new ConflictException(
					`Восстановление базы ${lock.target} уже запущено`
				);
			}
		}
	}

	private async claimProductionPermit(
		paths: DatabaseRestoreQueuePaths,
		permit: SignedDatabaseRestoreProductionPermit,
		secret: string
	): Promise<void> {
		const consumed = await this.readProductionPermitIfPresent(
			this.consumedPermitPath(paths, permit.jobId),
			secret
		);
		if (consumed) {
			throw new ConflictException(
				'Production restore permit уже использован'
			);
		}
		if (
			await this.readPublishReceiptIfPresent(
				this.publishReceiptPath(paths, permit.jobId),
				secret
			)
		) {
			throw new ConflictException(
				'Production restore permit уже опубликован'
			);
		}

		const claimPath = this.activePermitPath(paths);
		const temporaryPath = join(
			paths.permits,
			`.${permit.jobId}.${randomUUID()}.permit.tmp`
		);
		await this.writeDurableFile(
			temporaryPath,
			Buffer.from(`${JSON.stringify(permit)}\n`, 'utf8')
		);
		try {
			await link(temporaryPath, claimPath);
			await this.syncDirectory(paths.permits);
		} catch (error) {
			if (!this.isFileError(error, 'EEXIST')) throw error;
			const active = await this.readProductionPermitIfPresent(
				claimPath,
				secret
			);
			if (!active) {
				throw new ServiceUnavailableException(
					'Active production restore permit повреждён'
				);
			}
			throw new ConflictException(
				'Другой production restore permit уже захвачен'
			);
		} finally {
			await this.deleteFileIfPresent(temporaryPath);
		}
	}

	private async consumeProductionPermit(
		paths: DatabaseRestoreQueuePaths,
		permit: SignedDatabaseRestoreProductionPermit,
		secret: string
	): Promise<void> {
		const activePath = this.activePermitPath(paths);
		const consumedPath = this.consumedPermitPath(paths, permit.jobId);
		const existingConsumed = await this.readProductionPermitIfPresent(
			consumedPath,
			secret
		);
		if (existingConsumed) {
			if (existingConsumed.signature !== permit.signature) {
				throw new ServiceUnavailableException(
					'Consumed production restore permit имеет другую подпись'
				);
			}
			await this.releaseProductionPermitClaim(paths, permit, secret);
			return;
		}
		const active = await this.readProductionPermitIfPresent(
			activePath,
			secret
		);
		if (!active || active.signature !== permit.signature) {
			throw new ServiceUnavailableException(
				'Production restore permit невозможно атомарно consume'
			);
		}
		try {
			await link(activePath, consumedPath);
			await this.syncDirectory(paths.permits);
		} catch (error) {
			if (!this.isFileError(error, 'EEXIST')) throw error;
			const consumed = await this.readProductionPermitIfPresent(
				consumedPath,
				secret
			);
			if (!consumed || consumed.signature !== permit.signature) {
				throw new ServiceUnavailableException(
					'Production restore permit consumption conflict'
				);
			}
		}
		await this.releaseProductionPermitClaim(paths, permit, secret);
	}

	private async releaseProductionPermitClaim(
		paths: DatabaseRestoreQueuePaths,
		permit: SignedDatabaseRestoreProductionPermit,
		secret: string
	): Promise<void> {
		const claimPath = this.activePermitPath(paths);
		const active = await this.readProductionPermitIfPresent(
			claimPath,
			secret
		);
		if (!active) return;
		if (active.signature !== permit.signature) {
			throw new ServiceUnavailableException(
				'Active production restore permit сменил владельца'
			);
		}
		await unlink(claimPath);
		await this.syncDirectory(paths.permits);
	}

	private async ensurePublishReceipt(
		paths: DatabaseRestoreQueuePaths,
		manifest: SignedDatabaseRestoreJobManifest,
		secret: string,
		permit: SignedDatabaseRestoreProductionPermit | null,
		afterPublish: DatabaseRestoreAfterPublish
	): Promise<void> {
		const receiptPath = this.publishReceiptPath(paths, manifest.jobId);
		const existing = await this.readPublishReceiptIfPresent(
			receiptPath,
			secret
		);
		if (existing) {
			if (
				existing.jobId !== manifest.jobId ||
				existing.target !== manifest.target ||
				!(await this.isPublicationConfirmed(manifest, paths, secret))
			) {
				throw new ServiceUnavailableException(
					'Publish receipt принадлежит другому restore job'
				);
			}
			return;
		}

		const publicJob = toPublicDatabaseRestoreJob(manifest);
		const productionPermit = permit
			? {
					appRevision: permit.appRevision,
					expiresAt: permit.expiresAt,
					runId: permit.runId,
					evidence: permit.evidence,
					incident: permit.incident,
					permitSignature: permit.signature
				}
			: null;
		const publication = await afterPublish({
			job: publicJob,
			manifestStatus: manifest.status,
			manifestSignature: manifest.signature,
			productionPermit
		});
		const receipt = signDatabaseRestorePublishReceipt(
			{
				version: DATABASE_RESTORE_PUBLISH_RECEIPT_VERSION,
				kind: 'DATABASE_RESTORE_PUBLISH_RECEIPT',
				jobId: manifest.jobId,
				target: manifest.target,
				manifestStatus: manifest.status,
				manifestSignature: manifest.signature,
				publishedAt: new Date().toISOString(),
				auditEventId: publication.auditEventId,
				appRevision: productionPermit?.appRevision ?? null,
				permitSignature: productionPermit?.permitSignature ?? null,
				permitExpiresAt: productionPermit?.expiresAt ?? null,
				runId: productionPermit?.runId ?? null,
				evidence: productionPermit?.evidence ?? null,
				incident: productionPermit?.incident ?? null
			},
			secret
		);
		const temporaryPath = join(
			paths.receipts,
			`.${manifest.jobId}.${randomUUID()}.receipt.tmp`
		);
		await this.writeDurableFile(
			temporaryPath,
			Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8')
		);
		try {
			await link(temporaryPath, receiptPath);
			await this.syncDirectory(paths.receipts);
		} catch (error) {
			if (!this.isFileError(error, 'EEXIST')) throw error;
			const concurrent = await this.readPublishReceiptIfPresent(
				receiptPath,
				secret
			);
			if (
				!concurrent ||
				concurrent.jobId !== manifest.jobId ||
				concurrent.target !== manifest.target ||
				!(await this.isPublicationConfirmed(manifest, paths, secret))
			) {
				throw new ServiceUnavailableException(
					'Concurrent publish receipt повреждён'
				);
			}
		} finally {
			await this.deleteFileIfPresent(temporaryPath);
		}
	}

	private activePermitPath(paths: DatabaseRestoreQueuePaths): string {
		return join(paths.permits, 'active.json');
	}

	private consumedPermitPath(
		paths: DatabaseRestoreQueuePaths,
		jobId: string
	): string {
		return join(paths.permits, `${jobId}.consumed.json`);
	}

	private publishReceiptPath(
		paths: DatabaseRestoreQueuePaths,
		jobId: string
	): string {
		return join(paths.receipts, `${jobId}.json`);
	}

	private globalGatePath(paths: DatabaseRestoreQueuePaths): string {
		return join(paths.locks, 'global.lock');
	}

	private async readProductionPermitIfPresent(
		filePath: string,
		secret: string
	) {
		return this.readSignedFileIfPresent(
			filePath,
			secret,
			parseAndVerifyDatabaseRestoreProductionPermit,
			'Production restore permit повреждён'
		);
	}

	private async readGlobalGateIfPresent(filePath: string, secret: string) {
		return this.readSignedFileIfPresent(
			filePath,
			secret,
			parseAndVerifyDatabaseRestoreGlobalGate,
			'Глобальный restore gate повреждён'
		);
	}

	private async readPublishReceiptIfPresent(
		filePath: string,
		secret: string
	) {
		return this.readSignedFileIfPresent(
			filePath,
			secret,
			parseAndVerifyDatabaseRestorePublishReceipt,
			'Publish receipt восстановления повреждён'
		);
	}

	private async readSignedFileIfPresent<T>(
		filePath: string,
		secret: string,
		parser: (raw: string, secret: string) => T,
		errorMessage: string
	): Promise<T | null> {
		let stats;
		try {
			stats = await lstat(filePath);
		} catch (error) {
			if (this.isMissingFileError(error)) return null;
			throw error;
		}
		if (
			!stats.isFile() ||
			stats.isSymbolicLink() ||
			stats.size < 1 ||
			stats.size > DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
		) {
			throw new ServiceUnavailableException(errorMessage);
		}
		try {
			return parser(await readFile(filePath, 'utf8'), secret);
		} catch (error) {
			if (this.isMissingFileError(error)) return null;
			throw new ServiceUnavailableException(errorMessage);
		}
	}

	private async ensureStorageDirectories(): Promise<DatabaseRestoreQueuePaths> {
		const root = this.getStorageRoot();
		await this.ensurePrivateDirectory(root);

		const directories = Object.fromEntries(
			DATABASE_RESTORE_QUEUE_DIRECTORIES.map(directory => [
				directory,
				join(root, directory)
			])
		) as Record<DatabaseRestoreQueueDirectory, string>;
		for (const directory of DATABASE_RESTORE_QUEUE_DIRECTORIES) {
			await this.ensurePrivateDirectory(directories[directory]);
		}

		return { root, ...directories };
	}

	private getStorageRoot(): string {
		const configured = process.env[DATABASE_RESTORE_STORAGE_ENV]?.trim();
		if (!configured || !isAbsolute(configured)) {
			throw new ServiceUnavailableException(
				`Не настроена абсолютная директория ${DATABASE_RESTORE_STORAGE_ENV}`
			);
		}

		const root = resolve(configured);
		if (root === parse(root).root) {
			throw new ServiceUnavailableException(
				`Переменная ${DATABASE_RESTORE_STORAGE_ENV} не может ` +
					'указывать на корень файловой системы'
			);
		}
		return root;
	}

	private getQueueSecret(): string {
		const secret = process.env[DATABASE_RESTORE_QUEUE_SECRET_ENV];
		if (
			!secret ||
			secret !== secret.trim() ||
			Buffer.byteLength(secret, 'utf8') < 32
		) {
			throw new ServiceUnavailableException(
				`Переменная ${DATABASE_RESTORE_QUEUE_SECRET_ENV} должна ` +
					'содержать не менее 32 байт без пробелов по краям'
			);
		}
		return secret;
	}

	private async ensurePrivateDirectory(directory: string): Promise<void> {
		await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
		const stats = await lstat(directory);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new ServiceUnavailableException(
				'Хранилище заданий восстановления небезопасно'
			);
		}
		await chmod(directory, DIRECTORY_MODE);
	}

	private async writeDurableFile(
		filePath: string,
		content: Buffer
	): Promise<void> {
		const handle = await open(filePath, 'wx', FILE_MODE);
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async syncDirectory(directory: string): Promise<void> {
		const handle = await open(directory, 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async acquireTargetLock(
		locksDirectory: string,
		target: DatabaseRestoreTarget,
		jobId: string,
		createdAt: string,
		secret: string
	): Promise<void> {
		const lockPath = join(locksDirectory, `${target}.lock`);
		const temporaryPath = join(
			locksDirectory,
			`.${target}.${jobId}.${randomUUID()}.tmp`
		);
		const lock = signDatabaseRestoreTargetLock(
			{
				version: DATABASE_RESTORE_TARGET_LOCK_VERSION,
				target,
				jobId,
				createdAt
			},
			secret
		);
		let linked = false;

		try {
			await this.writeDurableFile(
				temporaryPath,
				Buffer.from(`${JSON.stringify(lock)}\n`, 'utf8')
			);
			await link(temporaryPath, lockPath);
			linked = true;
			await this.syncDirectory(locksDirectory);
		} catch (error) {
			if (this.isFileError(error, 'EEXIST')) {
				await this.assertExistingTargetLock(lockPath, target, secret);
				throw new ConflictException(
					`Восстановление базы ${target} уже запущено`
				);
			}
			if (linked) {
				await this.deleteFileIfPresent(lockPath);
				await this.syncDirectory(locksDirectory);
			}
			throw error;
		} finally {
			await this.deleteFileIfPresent(temporaryPath);
		}
	}

	private async assertExistingTargetLock(
		lockPath: string,
		target: DatabaseRestoreTarget,
		secret: string
	): Promise<void> {
		const lock = await this.readTargetLockIfPresent(lockPath, secret);
		if (!lock || lock.target !== target) {
			throw new ServiceUnavailableException(
				'Блокировка восстановления базы повреждена'
			);
		}
	}

	private async assertTargetNotFenced(
		fencesDirectory: string,
		target: DatabaseRestoreTarget,
		secret: string
	): Promise<void> {
		const fence = await this.readTargetLockIfPresent(
			join(fencesDirectory, `${target}.json`),
			secret
		);
		if (!fence) return;
		if (fence.target !== target) {
			throw new ServiceUnavailableException(
				'Защитное ограждение восстановления повреждено'
			);
		}
		throw new ConflictException(
			`БД ${target} оставлена в защитном ограждении после ошибки; ` +
				'сначала выполните ручное recovery'
		);
	}

	private async releaseOwnedTargetLock(
		locksDirectory: string,
		target: DatabaseRestoreTarget,
		jobId: string,
		secret: string
	): Promise<void> {
		const lockPath = join(locksDirectory, `${target}.lock`);
		const lock = await this.readTargetLockIfPresent(lockPath, secret);
		if (!lock) return;
		if (lock.target !== target || lock.jobId !== jobId) {
			throw new ServiceUnavailableException(
				'Блокировка восстановления сменила владельца'
			);
		}
		await unlink(lockPath);
		await this.syncDirectory(locksDirectory);
	}

	private async readTargetLockIfPresent(lockPath: string, secret: string) {
		let stats;
		try {
			stats = await lstat(lockPath);
		} catch (error) {
			if (this.isMissingFileError(error)) return null;
			throw error;
		}
		if (
			!stats.isFile() ||
			stats.isSymbolicLink() ||
			stats.size < 1 ||
			stats.size > DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
		) {
			throw new ServiceUnavailableException(
				'Блокировка восстановления базы повреждена'
			);
		}

		try {
			return parseAndVerifyDatabaseRestoreTargetLock(
				await readFile(lockPath, 'utf8'),
				secret
			);
		} catch (error) {
			if (this.isMissingFileError(error)) return null;
			throw new ServiceUnavailableException(
				'Подпись или формат блокировки базы неверны'
			);
		}
	}

	private async readManifestIfPresent(filePath: string, secret: string) {
		let stats;
		try {
			stats = await lstat(filePath);
		} catch (error) {
			if (this.isMissingFileError(error)) return null;
			throw error;
		}
		if (
			!stats.isFile() ||
			stats.isSymbolicLink() ||
			stats.size < 1 ||
			stats.size > DATABASE_RESTORE_MANIFEST_MAX_FILE_SIZE_BYTES
		) {
			throw new ServiceUnavailableException(
				'Состояние задания восстановления повреждено'
			);
		}

		try {
			const rawManifest = await readFile(filePath, 'utf8');
			return parseAndVerifyDatabaseRestoreJobManifest(rawManifest, secret);
		} catch (error) {
			if (this.isMissingFileError(error)) return null;
			throw new ServiceUnavailableException(
				'Подпись или формат задания восстановления неверны'
			);
		}
	}

	private async deleteFileIfPresent(filePath: string): Promise<void> {
		await unlink(filePath).catch(error => {
			if (!this.isMissingFileError(error)) throw error;
		});
	}

	private isMissingFileError(error: unknown): boolean {
		return this.isFileError(error, 'ENOENT');
	}

	private isFileError(error: unknown, code: string): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === code
		);
	}
}
