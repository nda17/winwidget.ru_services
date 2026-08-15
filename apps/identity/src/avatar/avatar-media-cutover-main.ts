import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import {
	AvatarCleanupKind,
	AvatarCleanupStatus,
	AvatarMediaOwnershipPhase,
	Prisma,
	PrismaClient
} from '@prisma/identity-client';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { sha256 } from '../common/identity.util';
import { IdentityEventsService } from '../events/identity-events.service';
import {
	AVATAR_MAX_UPLOAD_BYTES,
	AVATAR_STAGING_GRACE_MS,
	buildAvatarPublicUrl,
	createAvatarObjectKey,
	isOwnedAvatarObjectKey,
	normalizeAvatarImage,
	validateNormalizedAvatarImage
} from './avatar-storage.service';

const ACTIONS = ['inventory', 'migrate', 'status', 'activate'] as const;
const CLASSIFICATIONS = [
	'NONE',
	'NEW_MANAGED',
	'EXTERNAL',
	'LEGACY_S3',
	'LEGACY_UPLOAD',
	'INVALID'
] as const;
const VERIFICATIONS = [
	'NOT_APPLICABLE',
	'VERIFIED',
	'MISSING',
	'INVALID',
	'UNAVAILABLE'
] as const;
const CLASSIFICATION_ERROR_CODES = new Set([
	'OBJECT_KEY_WITHOUT_URL',
	'NEW_URL_KEY_MISMATCH',
	'UNTRUSTED_OBJECT_KEY',
	'MANAGED_BASE_KEY_OUTSIDE_PREFIX',
	'UNCLASSIFIED_AVATAR_PATH'
]);
const LEGACY_SOURCE_INVALID_ERROR_CODES = new Set([
	'UPLOADS_ROOT_UNAVAILABLE',
	'SOURCE_TOO_LARGE',
	'SOURCE_BODY_INVALID',
	'SOURCE_EMPTY',
	'UPLOAD_SYMLINK_REJECTED',
	'UPLOAD_PATH_ESCAPE',
	'UPLOAD_FILE_INVALID',
	'SOURCE_INVALID'
]);
const NEW_OBJECT_INVALID_ERROR_CODES = new Set([
	'NEW_OBJECT_URL_INVALID',
	'NEW_OBJECT_HTTP_ERROR',
	'NEW_OBJECT_TOO_LARGE',
	'NEW_OBJECT_CONTENT_TYPE_INVALID',
	'NEW_OBJECT_INVALID',
	'SOURCE_TOO_LARGE',
	'SOURCE_BODY_INVALID',
	'SOURCE_EMPTY'
]);

type Action = (typeof ACTIONS)[number];
type Classification = (typeof CLASSIFICATIONS)[number];
type Verification = (typeof VERIFICATIONS)[number];
type ManifestKind = 'INVENTORY' | 'STATUS';

export type AvatarMediaCutoverArgs = {
	action: Action;
	manifest?: string;
	sha256?: string;
	requireUnresolvedZero: boolean;
	inventoryManifest?: string;
	inventorySha256?: string;
	statusManifest?: string;
	statusSha256?: string;
	revision?: string;
};

type AvatarMediaCutoverConfig = {
	databaseUrl: string;
	endpoint: string | null;
	region: string | null;
	bucket: string | null;
	publicBaseUrl: string;
	keyPrefix: string;
	legacyPublicBaseUrl: string;
	legacyKeyPrefix: string;
	uploadsPublicBaseUrl: string | null;
	uploadsRoot: string | null;
	forcePathStyle: boolean;
	accessKeyId: string | null;
	secretAccessKey: string | null;
};

type AvatarState = {
	id: string;
	avatarPath: string | null;
	avatarObjectKey: string | null;
};

type ManifestSource = {
	kind: 'S3' | 'UPLOAD';
	key: string;
	sourceSha256?: string;
	normalizedSha256?: string;
};

export type AvatarManifestRow = {
	userId: string;
	avatarPathSha256: string | null;
	avatarObjectKeySha256: string | null;
	classification: Classification;
	verification: Verification;
	errorCode?: string;
	managedObjectKey?: string;
	managedObjectSha256?: string;
	source?: ManifestSource;
};

export type AvatarMediaManifest = {
	schemaVersion: 1;
	kind: ManifestKind;
	rows: AvatarManifestRow[];
};

type ManifestCounts = Record<Classification, number>;

export class AvatarMediaCutoverError extends Error {}

export function parseAvatarMediaCutoverArgs(
	argv: readonly string[]
): AvatarMediaCutoverArgs {
	const [rawAction, ...rest] = argv;
	if (!ACTIONS.includes(rawAction as Action)) {
		throw new AvatarMediaCutoverError(
			'Action must be inventory, migrate, status or activate'
		);
	}
	const action = rawAction as Action;
	if (action === 'activate') {
		if (
			rest.length !== 10 ||
			rest[0] !== '--inventory-manifest' ||
			!safeAbsolutePath(rest[1]) ||
			rest[2] !== '--inventory-sha256' ||
			!/^[a-f0-9]{64}$/i.test(rest[3] || '') ||
			rest[4] !== '--status-manifest' ||
			!safeAbsolutePath(rest[5]) ||
			rest[6] !== '--status-sha256' ||
			!/^[a-f0-9]{64}$/i.test(rest[7] || '') ||
			rest[8] !== '--revision' ||
			!/^[a-f0-9]{40}$/i.test(rest[9] || '')
		) {
			throw new AvatarMediaCutoverError(
				'activate requires exact inventory/status manifests, SHA-256 values and a 40-character revision'
			);
		}
		return {
			action,
			requireUnresolvedZero: true,
			inventoryManifest: rest[1],
			inventorySha256: rest[3]!.toLowerCase(),
			statusManifest: rest[5],
			statusSha256: rest[7]!.toLowerCase(),
			revision: rest[9]!.toLowerCase()
		};
	}
	if (rest[0] !== '--manifest' || !safeAbsolutePath(rest[1])) {
		throw new AvatarMediaCutoverError(
			`${action} requires --manifest <absolute-path>`
		);
	}
	if (action === 'inventory' && rest.length === 2) {
		return {
			action,
			manifest: rest[1]!,
			requireUnresolvedZero: false
		};
	}
	if (
		action === 'migrate' &&
		rest.length === 4 &&
		rest[2] === '--sha256' &&
		/^[a-f0-9]{64}$/i.test(rest[3] || '')
	) {
		return {
			action,
			manifest: rest[1]!,
			sha256: rest[3]!.toLowerCase(),
			requireUnresolvedZero: false
		};
	}
	if (
		action === 'status' &&
		rest.length === 3 &&
		rest[2] === '--require-unresolved-zero'
	) {
		return {
			action,
			manifest: rest[1]!,
			requireUnresolvedZero: true
		};
	}
	throw new AvatarMediaCutoverError(
		action === 'migrate'
			? 'migrate requires --manifest <absolute-path> --sha256 <hex>'
			: 'status requires --manifest <absolute-path> --require-unresolved-zero'
	);
}

export async function runAvatarMediaCutover(
	args: AvatarMediaCutoverArgs,
	environment: NodeJS.ProcessEnv = process.env
) {
	const config = loadConfig(args.action, environment);
	const prisma = new PrismaClient({
		datasources: { db: { url: config.databaseUrl } }
	});
	try {
		if (args.action === 'activate') {
			const runtimeRevision =
				environment.APP_REVISION?.trim().toLowerCase();
			if (
				!runtimeRevision ||
				runtimeRevision !== args.revision ||
				!/^[a-f0-9]{40}$/.test(runtimeRevision)
			) {
				throw new AvatarMediaCutoverError(
					'--revision must equal the immutable APP_REVISION'
				);
			}
			const inventory = await loadManifest(
				args.inventoryManifest!,
				args.inventorySha256!
			);
			const status = await loadManifest(
				args.statusManifest!,
				args.statusSha256!
			);
			assertActivationEvidence(inventory.value, status.value);
			const activation = await activateOwnership(prisma, {
				revision: runtimeRevision,
				inventorySha256: inventory.sha256,
				statusSha256: status.sha256
			});
			return { ok: true, action: args.action, ...activation };
		}
		if (args.action === 'migrate') {
			await assertPrepared(prisma);
			const loaded = await loadManifest(args.manifest!, args.sha256!);
			if (loaded.value.kind !== 'INVENTORY') {
				throw new AvatarMediaCutoverError(
					'Migrate requires an INVENTORY manifest'
				);
			}
			const inventorySummary = summarizeManifest(loaded.value);
			if (
				inventorySummary.counts.INVALID !== 0 ||
				inventorySummary.verificationFailures !== 0
			) {
				throw new AvatarMediaCutoverError(
					'Inventory contains invalid or unverified objects'
				);
			}
			const result = await migrateManifest(prisma, config, loaded.value);
			return {
				ok: result.failed === 0,
				action: args.action,
				manifestSha256: loaded.sha256,
				...result
			};
		}
		if (args.action === 'inventory') {
			await assertPrepared(prisma);
		}
		const manifest = await createManifest(prisma, config, {
			kind: args.action === 'inventory' ? 'INVENTORY' : 'STATUS',
			verifyLegacy: args.action === 'inventory',
			verifyNew: true
		});
		const written = await writeManifest(args.manifest!, manifest);
		const summary = summarizeManifest(manifest);
		const ownership = await readOwnership(prisma);
		const evidencePassed =
			args.action === 'inventory'
				? summary.counts.INVALID === 0 &&
					summary.verificationFailures === 0
				: summary.unresolved === 0 && summary.verificationFailures === 0;
		return {
			ok: evidencePassed,
			action: args.action,
			manifestSha256: written.sha256,
			ownership,
			...summary
		};
	} finally {
		await prisma.$disconnect();
	}
}

export async function createManifest(
	prisma: Pick<PrismaClient, 'user'>,
	config: AvatarMediaCutoverConfig,
	verification: {
		kind: ManifestKind;
		verifyLegacy: boolean;
		verifyNew: boolean;
	}
): Promise<AvatarMediaManifest> {
	const users = await prisma.user.findMany({
		select: { id: true, avatarPath: true, avatarObjectKey: true },
		orderBy: { id: 'asc' }
	});
	const client = verification.verifyLegacy
		? migrationS3Client(config)
		: null;
	const rows: AvatarManifestRow[] = [];
	for (const user of [...users].sort((left, right) =>
		left.id < right.id ? -1 : left.id > right.id ? 1 : 0
	)) {
		const row = classifyAvatarState(user, config);
		if (verification.verifyLegacy && row.source) {
			await verifySource(row, config, client!);
		} else if (
			verification.verifyNew &&
			row.classification === 'NEW_MANAGED'
		) {
			await verifyNewManagedObject(row, user.avatarPath!, config);
		}
		rows.push(row);
	}
	return { schemaVersion: 1, kind: verification.kind, rows };
}

export function classifyAvatarState(
	user: AvatarState,
	config: Pick<
		AvatarMediaCutoverConfig,
		| 'publicBaseUrl'
		| 'keyPrefix'
		| 'legacyPublicBaseUrl'
		| 'legacyKeyPrefix'
		| 'uploadsPublicBaseUrl'
	>
): AvatarManifestRow {
	const base = manifestRow(user);
	if (!user.avatarPath && !user.avatarObjectKey) {
		return classified(base, 'NONE');
	}
	if (!user.avatarPath) {
		return invalid(base, 'OBJECT_KEY_WITHOUT_URL');
	}
	const ownerFingerprint = sha256(user.id);
	const newUrlKey = keyFromPublicUrl(
		user.avatarPath,
		config.publicBaseUrl
	);
	if (newUrlKey?.startsWith(`${config.keyPrefix}/`)) {
		if (
			user.avatarObjectKey === newUrlKey &&
			isOwnedAvatarObjectKey(config.keyPrefix, newUrlKey, ownerFingerprint)
		) {
			return {
				...classified(base, 'NEW_MANAGED'),
				managedObjectKey: newUrlKey
			};
		}
		return invalid(base, 'NEW_URL_KEY_MISMATCH');
	}
	if (user.avatarObjectKey) {
		return invalid(base, 'UNTRUSTED_OBJECT_KEY');
	}
	const legacyUrlKey = keyFromPublicUrl(
		user.avatarPath,
		config.legacyPublicBaseUrl
	);
	const legacyKey = legacyUrlKey || rawLegacyKey(user.avatarPath);
	if (legacyKey && isKeyInsidePrefix(legacyKey, config.legacyKeyPrefix)) {
		return {
			...base,
			classification: 'LEGACY_S3',
			verification: 'UNAVAILABLE',
			source: { kind: 'S3', key: legacyKey }
		};
	}
	if (newUrlKey || legacyUrlKey) {
		return invalid(base, 'MANAGED_BASE_KEY_OUTSIDE_PREFIX');
	}
	const uploadKey = uploadsKey(
		user.avatarPath,
		config.uploadsPublicBaseUrl
	);
	if (uploadKey) {
		return {
			...base,
			classification: 'LEGACY_UPLOAD',
			verification: 'UNAVAILABLE',
			source: { kind: 'UPLOAD', key: uploadKey }
		};
	}
	if (safeExternalUrl(user.avatarPath)) {
		return classified(base, 'EXTERNAL');
	}
	return invalid(base, 'UNCLASSIFIED_AVATAR_PATH');
}

async function migrateManifest(
	prisma: PrismaClient,
	config: AvatarMediaCutoverConfig,
	manifest: AvatarMediaManifest
): Promise<{ migrated: number; alreadyResolved: number; failed: number }> {
	const client = migrationS3Client(config);
	const events = new IdentityEventsService();
	let migrated = 0;
	let alreadyResolved = 0;
	let failed = 0;
	for (const row of manifest.rows) {
		if (!['LEGACY_S3', 'LEGACY_UPLOAD'].includes(row.classification)) {
			continue;
		}
		if (
			row.verification !== 'VERIFIED' ||
			!row.source?.sourceSha256 ||
			!row.source.normalizedSha256
		) {
			failed += 1;
			continue;
		}
		try {
			const current = await prisma.user.findUnique({
				where: { id: row.userId },
				select: { id: true, avatarPath: true, avatarObjectKey: true }
			});
			if (!current) throw new AvatarMediaCutoverError('USER_MISSING');
			const currentClassification = classifyAvatarState(current, config);
			if (currentClassification.classification === 'NEW_MANAGED') {
				alreadyResolved += 1;
				continue;
			}
			if (
				digestNullable(current.avatarPath) !== row.avatarPathSha256 ||
				digestNullable(current.avatarObjectKey) !==
					row.avatarObjectKeySha256
			) {
				throw new AvatarMediaCutoverError('USER_STATE_DRIFT');
			}
			if (!current.avatarPath) {
				throw new AvatarMediaCutoverError('USER_AVATAR_PATH_MISSING');
			}
			const sourceBody = await readSource(row.source, config, client);
			if (sha256(sourceBody) !== row.source.sourceSha256) {
				throw new AvatarMediaCutoverError('SOURCE_DRIFT');
			}
			const normalized = await normalizeAvatarImage(sourceBody);
			if (sha256(normalized) !== row.source.normalizedSha256) {
				throw new AvatarMediaCutoverError('NORMALIZATION_DRIFT');
			}
			await migrateUserAvatar(
				prisma,
				events,
				client,
				config,
				{ ...current, avatarPath: current.avatarPath },
				normalized
			);
			migrated += 1;
		} catch {
			failed += 1;
		}
	}
	return { migrated, alreadyResolved, failed };
}

export function assertActivationEvidence(
	inventory: AvatarMediaManifest,
	status: AvatarMediaManifest
): void {
	validateManifest(inventory);
	validateManifest(status);
	if (inventory.kind !== 'INVENTORY' || status.kind !== 'STATUS') {
		throw new AvatarMediaCutoverError(
			'Activation requires INVENTORY and STATUS evidence'
		);
	}
	const inventorySummary = summarizeManifest(inventory);
	const statusSummary = summarizeManifest(status);
	if (
		inventorySummary.counts.INVALID !== 0 ||
		inventorySummary.verificationFailures !== 0
	) {
		throw new AvatarMediaCutoverError(
			'Inventory evidence contains invalid or unverified objects'
		);
	}
	if (
		statusSummary.unresolved !== 0 ||
		statusSummary.verificationFailures !== 0
	) {
		throw new AvatarMediaCutoverError(
			'Status evidence has unresolved or unverified objects'
		);
	}
	const inventoryIds = new Set(inventory.rows.map(row => row.userId));
	const statusByUser = new Map(status.rows.map(row => [row.userId, row]));
	for (const before of inventory.rows) {
		const after = statusByUser.get(before.userId);
		if (!after) {
			throw new AvatarMediaCutoverError(
				'Status evidence is missing an inventory user'
			);
		}
		if (
			before.classification === 'LEGACY_S3' ||
			before.classification === 'LEGACY_UPLOAD'
		) {
			if (
				before.verification !== 'VERIFIED' ||
				after.classification !== 'NEW_MANAGED' ||
				after.verification !== 'VERIFIED' ||
				!before.source?.normalizedSha256 ||
				after.managedObjectSha256 !== before.source.normalizedSha256
			) {
				throw new AvatarMediaCutoverError(
					'Migrated avatar content parity failed'
				);
			}
			continue;
		}
		if (
			before.classification !== after.classification ||
			before.avatarPathSha256 !== after.avatarPathSha256 ||
			before.avatarObjectKeySha256 !== after.avatarObjectKeySha256 ||
			(before.classification === 'NEW_MANAGED' &&
				(before.managedObjectKey !== after.managedObjectKey ||
					before.managedObjectSha256 !== after.managedObjectSha256))
		) {
			throw new AvatarMediaCutoverError(
				'Non-legacy avatar state changed during cutover'
			);
		}
	}
	for (const after of status.rows) {
		if (
			!inventoryIds.has(after.userId) &&
			!['NONE', 'EXTERNAL'].includes(after.classification)
		) {
			throw new AvatarMediaCutoverError(
				'Unexpected managed avatar appeared during cutover'
			);
		}
	}
}

export async function activateOwnership(
	prisma: PrismaClient,
	evidence: {
		revision: string;
		inventorySha256: string;
		statusSha256: string;
	}
) {
	return prisma.$transaction(
		async transaction => {
			await transaction.$queryRaw(
				Prisma.sql`SELECT "id" FROM "identity"."avatar_media_ownership" WHERE "id" = 'singleton' FOR UPDATE`
			);
			const current = await transaction.avatarMediaOwnership.findUnique({
				where: { id: 'singleton' }
			});
			if (!current) {
				throw new AvatarMediaCutoverError(
					'Avatar media ownership singleton is missing'
				);
			}
			if (current.phase === AvatarMediaOwnershipPhase.ACTIVE) {
				if (
					current.activatedRevision !== evidence.revision ||
					current.inventorySha256 !== evidence.inventorySha256 ||
					current.statusSha256 !== evidence.statusSha256
				) {
					throw new AvatarMediaCutoverError(
						'Avatar media ownership is already ACTIVE with different evidence'
					);
				}
				return ownershipView(current, true);
			}
			const activatedAt = new Date();
			const activated = await transaction.avatarMediaOwnership.updateMany({
				where: {
					id: 'singleton',
					phase: AvatarMediaOwnershipPhase.PREPARED,
					activatedRevision: null,
					inventorySha256: null,
					statusSha256: null,
					activatedAt: null
				},
				data: {
					phase: AvatarMediaOwnershipPhase.ACTIVE,
					activatedRevision: evidence.revision,
					inventorySha256: evidence.inventorySha256,
					statusSha256: evidence.statusSha256,
					activatedAt
				}
			});
			if (activated.count !== 1) {
				throw new AvatarMediaCutoverError(
					'Avatar media ownership activation CAS failed'
				);
			}
			return {
				phase: AvatarMediaOwnershipPhase.ACTIVE,
				activatedRevision: evidence.revision,
				inventorySha256: evidence.inventorySha256,
				statusSha256: evidence.statusSha256,
				activatedAt: activatedAt.toISOString(),
				idempotent: false
			};
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
}

async function readOwnership(prisma: PrismaClient) {
	const ownership = await prisma.avatarMediaOwnership.findUnique({
		where: { id: 'singleton' }
	});
	if (!ownership) {
		throw new AvatarMediaCutoverError(
			'Avatar media ownership singleton is missing'
		);
	}
	return ownershipView(ownership, false);
}

async function assertPrepared(prisma: PrismaClient): Promise<void> {
	const ownership = await readOwnership(prisma);
	if (ownership.phase !== AvatarMediaOwnershipPhase.PREPARED) {
		throw new AvatarMediaCutoverError(
			'Avatar media ownership must be PREPARED for this action'
		);
	}
}

function ownershipView(
	ownership: {
		phase: AvatarMediaOwnershipPhase;
		activatedRevision: string | null;
		inventorySha256: string | null;
		statusSha256: string | null;
		activatedAt: Date | null;
	},
	idempotent: boolean
) {
	return {
		phase: ownership.phase,
		activatedRevision: ownership.activatedRevision,
		inventorySha256: ownership.inventorySha256,
		statusSha256: ownership.statusSha256,
		activatedAt: ownership.activatedAt?.toISOString() || null,
		idempotent
	};
}

async function migrateUserAvatar(
	prisma: PrismaClient,
	events: IdentityEventsService,
	client: S3Client,
	config: AvatarMediaCutoverConfig,
	user: AvatarState & { avatarPath: string },
	body: Buffer
): Promise<void> {
	const ownerFingerprint = sha256(user.id);
	const objectKey = createAvatarObjectKey(
		config.keyPrefix,
		ownerFingerprint
	);
	const publicUrl = buildAvatarPublicUrl(config.publicBaseUrl, objectKey);
	const staging = await prisma.avatarCleanupJob.create({
		data: {
			objectKey,
			ownerFingerprint,
			kind: AvatarCleanupKind.STAGING,
			status: AvatarCleanupStatus.PENDING,
			availableAt: new Date(Date.now() + AVATAR_STAGING_GRACE_MS)
		}
	});
	await client.send(
		new PutObjectCommand({
			Bucket: config.bucket!,
			Key: objectKey,
			Body: body,
			ContentType: 'image/webp',
			ContentDisposition: 'inline',
			CacheControl: 'public, max-age=31536000, immutable'
		}),
		{ abortSignal: AbortSignal.timeout(15_000) }
	);
	await prisma.$transaction(
		async transaction => {
			await transaction.$queryRaw(
				Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity.user:${user.id}`}, 0))`
			);
			const consumed = await transaction.avatarCleanupJob.deleteMany({
				where: {
					id: staging.id,
					objectKey,
					kind: AvatarCleanupKind.STAGING,
					status: AvatarCleanupStatus.PENDING,
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
			if (consumed.count !== 1) {
				throw new AvatarMediaCutoverError('STAGING_LEASE_LOST');
			}
			const updated = await transaction.user.updateMany({
				where: {
					id: user.id,
					avatarPath: user.avatarPath,
					avatarObjectKey: null
				},
				data: { avatarPath: publicUrl, avatarObjectKey: objectKey }
			});
			if (updated.count !== 1) {
				throw new AvatarMediaCutoverError('USER_STATE_DRIFT');
			}
			await events.emitUserChanged(transaction, user.id);
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
	);
}

async function verifySource(
	row: AvatarManifestRow,
	config: AvatarMediaCutoverConfig,
	client: S3Client
): Promise<void> {
	try {
		const body = await readSource(row.source!, config, client);
		const normalized = await normalizeAvatarImage(body);
		row.source!.sourceSha256 = sha256(body);
		row.source!.normalizedSha256 = sha256(normalized);
		row.verification = 'VERIFIED';
		delete row.errorCode;
	} catch (error) {
		row.verification = missingSource(error) ? 'MISSING' : 'INVALID';
		row.errorCode = missingSource(error)
			? 'SOURCE_MISSING'
			: error instanceof AvatarMediaCutoverError
				? error.message
				: 'SOURCE_INVALID';
	}
}

async function verifyNewManagedObject(
	row: AvatarManifestRow,
	publicUrl: string,
	config: AvatarMediaCutoverConfig
): Promise<void> {
	try {
		const publicKey = keyFromPublicUrl(publicUrl, config.publicBaseUrl);
		if (!publicKey || publicKey !== row.managedObjectKey) {
			throw new AvatarMediaCutoverError('NEW_OBJECT_URL_INVALID');
		}
		const response = await fetch(publicUrl, {
			method: 'GET',
			redirect: 'error',
			signal: AbortSignal.timeout(15_000),
			headers: { accept: 'image/webp' }
		});
		if (!response.ok) {
			throw new AvatarMediaCutoverError(
				response.status === 404
					? 'NEW_OBJECT_MISSING'
					: 'NEW_OBJECT_HTTP_ERROR'
			);
		}
		const contentLength = Number(response.headers.get('content-length'));
		if (
			Number.isFinite(contentLength) &&
			contentLength > AVATAR_MAX_UPLOAD_BYTES
		) {
			throw new AvatarMediaCutoverError('NEW_OBJECT_TOO_LARGE');
		}
		const contentType = response.headers
			.get('content-type')
			?.split(';')[0];
		if (contentType !== 'image/webp') {
			throw new AvatarMediaCutoverError('NEW_OBJECT_CONTENT_TYPE_INVALID');
		}
		const body = await boundedSdkBody(response.body);
		await validateNormalizedAvatarImage(body);
		row.managedObjectSha256 = sha256(body);
		row.verification = 'VERIFIED';
		delete row.errorCode;
	} catch (error) {
		row.verification = newObjectMissing(error) ? 'MISSING' : 'INVALID';
		row.errorCode =
			error instanceof AvatarMediaCutoverError
				? error.message
				: 'NEW_OBJECT_INVALID';
	}
}

async function readSource(
	source: ManifestSource,
	config: AvatarMediaCutoverConfig,
	client: S3Client
): Promise<Buffer> {
	if (source.kind === 'UPLOAD') {
		if (!config.uploadsRoot) {
			throw new AvatarMediaCutoverError('UPLOADS_ROOT_UNAVAILABLE');
		}
		return readTrustedUpload(config.uploadsRoot, source.key);
	}
	const response = await client.send(
		new GetObjectCommand({ Bucket: config.bucket!, Key: source.key }),
		{ abortSignal: AbortSignal.timeout(15_000) }
	);
	if (
		response.ContentLength !== undefined &&
		response.ContentLength > AVATAR_MAX_UPLOAD_BYTES
	) {
		throw new AvatarMediaCutoverError('SOURCE_TOO_LARGE');
	}
	return boundedSdkBody(response.Body);
}

async function boundedSdkBody(body: unknown): Promise<Buffer> {
	if (
		!body ||
		typeof (body as { [Symbol.asyncIterator]?: unknown })[
			Symbol.asyncIterator
		] !== 'function'
	) {
		throw new AvatarMediaCutoverError('SOURCE_BODY_INVALID');
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of body as AsyncIterable<Uint8Array>) {
		const value = Buffer.from(chunk);
		size += value.length;
		if (size > AVATAR_MAX_UPLOAD_BYTES) {
			const destroy = (body as { destroy?: () => void }).destroy;
			if (typeof destroy === 'function') destroy.call(body);
			throw new AvatarMediaCutoverError('SOURCE_TOO_LARGE');
		}
		chunks.push(value);
	}
	if (!size) throw new AvatarMediaCutoverError('SOURCE_EMPTY');
	return Buffer.concat(chunks, size);
}

async function readTrustedUpload(
	root: string,
	key: string
): Promise<Buffer> {
	const trustedRoot = await realpath(root);
	const candidate = join(trustedRoot, ...key.split('/'));
	const metadata = await lstat(candidate);
	if (metadata.isSymbolicLink()) {
		throw new AvatarMediaCutoverError('UPLOAD_SYMLINK_REJECTED');
	}
	const resolved = await realpath(candidate);
	if (!resolved.startsWith(`${trustedRoot}${sep}`)) {
		throw new AvatarMediaCutoverError('UPLOAD_PATH_ESCAPE');
	}
	const handle = await open(
		resolved,
		constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
	);
	try {
		const stats = await handle.stat();
		if (
			!stats.isFile() ||
			stats.size < 1 ||
			stats.size > AVATAR_MAX_UPLOAD_BYTES
		) {
			throw new AvatarMediaCutoverError('UPLOAD_FILE_INVALID');
		}
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

export async function writeManifest(
	file: string,
	manifest: AvatarMediaManifest
): Promise<{ sha256: string }> {
	const body = `${canonicalJson(validateManifest(manifest))}\n`;
	const directory = dirname(file);
	const temporary = join(
		directory,
		`.${basename(file)}.${process.pid}.${randomUUID()}.tmp`
	);
	const handle = await open(
		temporary,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			(constants.O_NOFOLLOW || 0),
		0o600
	);
	let promoted = false;
	try {
		await handle.writeFile(body, 'utf8');
		await handle.sync();
		await handle.close();
		try {
			await link(temporary, file);
			promoted = true;
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== 'EEXIST' ||
				!(await existingManifestMatches(file, body))
			) {
				throw error;
			}
		}
		await unlink(temporary);
		const directoryHandle = await open(directory, constants.O_RDONLY);
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	} catch (error) {
		await handle.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
		if (promoted) {
			throw new AvatarMediaCutoverError(
				'Manifest promotion was not durably confirmed'
			);
		}
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			throw new AvatarMediaCutoverError(
				'Manifest path already exists with different content'
			);
		}
		throw error;
	}
	return { sha256: sha256(body) };
}

async function existingManifestMatches(
	file: string,
	expected: string
): Promise<boolean> {
	let handle;
	try {
		handle = await open(
			file,
			constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
		);
		const stats = await handle.stat();
		if (
			!stats.isFile() ||
			stats.size !== Buffer.byteLength(expected) ||
			(stats.mode & 0o777) !== 0o600
		) {
			return false;
		}
		return (await handle.readFile('utf8')) === expected;
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function loadManifest(
	file: string,
	expectedSha256: string
): Promise<{ value: AvatarMediaManifest; sha256: string }> {
	const handle = await open(
		file,
		constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
	);
	try {
		const stats = await handle.stat();
		if (
			!stats.isFile() ||
			stats.size < 2 ||
			stats.size > 128 * 1024 * 1024 ||
			(stats.mode & 0o777) !== 0o600
		) {
			throw new AvatarMediaCutoverError(
				'Manifest must be a bounded regular file with mode 0600'
			);
		}
		const body = await handle.readFile('utf8');
		const digest = sha256(body);
		if (digest !== expectedSha256) {
			throw new AvatarMediaCutoverError('Manifest SHA-256 mismatch');
		}
		const value = validateManifest(JSON.parse(body) as unknown);
		if (`${canonicalJson(value)}\n` !== body) {
			throw new AvatarMediaCutoverError('Manifest is not canonical JSON');
		}
		return { value, sha256: digest };
	} catch (error) {
		if (error instanceof AvatarMediaCutoverError) throw error;
		throw new AvatarMediaCutoverError('Manifest is invalid');
	} finally {
		await handle.close();
	}
}

export function validateManifest(value: unknown): AvatarMediaManifest {
	if (!value || typeof value !== 'object') {
		throw new AvatarMediaCutoverError('Manifest root is invalid');
	}
	const input = value as Record<string, unknown>;
	if (
		!hasExactKeys(input, ['schemaVersion', 'kind', 'rows']) ||
		input.schemaVersion !== 1 ||
		!['INVENTORY', 'STATUS'].includes(input.kind as string) ||
		!Array.isArray(input.rows)
	) {
		throw new AvatarMediaCutoverError('Manifest schema is invalid');
	}
	const rows = input.rows as AvatarManifestRow[];
	let previous = '';
	for (const row of rows) {
		if (
			!row ||
			typeof row !== 'object' ||
			typeof row.userId !== 'string' ||
			row.userId.length > 191 ||
			row.userId <= previous ||
			!CLASSIFICATIONS.includes(row.classification) ||
			!VERIFICATIONS.includes(row.verification) ||
			!nullableDigest(row.avatarPathSha256) ||
			!nullableDigest(row.avatarObjectKeySha256)
		) {
			throw new AvatarMediaCutoverError('Manifest row is invalid');
		}
		if (!hasExactKeys(row, manifestRowKeys(row))) {
			throw new AvatarMediaCutoverError('Manifest row is invalid');
		}
		if (
			['LEGACY_S3', 'LEGACY_UPLOAD'].includes(row.classification) !==
			Boolean(row.source)
		) {
			throw new AvatarMediaCutoverError('Manifest source is invalid');
		}
		if (row.source) validateManifestSource(row.source, row.classification);
		if (
			(row.managedObjectKey !== undefined &&
				(typeof row.managedObjectKey !== 'string' ||
					!safeKey(row.managedObjectKey))) ||
			(row.classification !== 'NEW_MANAGED' &&
				row.managedObjectKey !== undefined) ||
			(row.managedObjectSha256 !== undefined &&
				(typeof row.managedObjectSha256 !== 'string' ||
					!/^[a-f0-9]{64}$/.test(row.managedObjectSha256))) ||
			(row.classification !== 'NEW_MANAGED' &&
				row.managedObjectSha256 !== undefined)
		) {
			throw new AvatarMediaCutoverError(
				'Manifest object digest is invalid'
			);
		}
		validateManifestRowState(row);
		previous = row.userId;
	}
	return {
		schemaVersion: 1,
		kind: input.kind as ManifestKind,
		rows
	};
}

function validateManifestSource(
	source: ManifestSource,
	classification: Classification
): void {
	if (
		!source ||
		typeof source !== 'object' ||
		!hasExactKeys(source, [
			'kind',
			'key',
			...(source.sourceSha256 === undefined ? [] : ['sourceSha256']),
			...(source.normalizedSha256 === undefined
				? []
				: ['normalizedSha256'])
		]) ||
		typeof source.kind !== 'string' ||
		typeof source.key !== 'string' ||
		(classification === 'LEGACY_S3'
			? source.kind !== 'S3'
			: source.kind !== 'UPLOAD') ||
		!safeKey(source.key) ||
		(source.sourceSha256 !== undefined &&
			(typeof source.sourceSha256 !== 'string' ||
				!/^[a-f0-9]{64}$/.test(source.sourceSha256))) ||
		(source.normalizedSha256 !== undefined &&
			(typeof source.normalizedSha256 !== 'string' ||
				!/^[a-f0-9]{64}$/.test(source.normalizedSha256)))
	) {
		throw new AvatarMediaCutoverError('Manifest source is invalid');
	}
}

function validateManifestRowState(row: AvatarManifestRow): void {
	const hasError =
		typeof row.errorCode === 'string' &&
		/^[A-Z][A-Z0-9_]{0,99}$/.test(row.errorCode);
	const hasSourceDigests = Boolean(
		row.source?.sourceSha256 && row.source.normalizedSha256
	);
	const hasPartialSourceDigest = Boolean(
		row.source &&
		Boolean(row.source.sourceSha256) !==
			Boolean(row.source.normalizedSha256)
	);
	if (hasPartialSourceDigest) {
		throw new AvatarMediaCutoverError('Manifest source digest is invalid');
	}

	if (row.classification === 'NONE') {
		if (
			row.avatarPathSha256 !== null ||
			row.avatarObjectKeySha256 !== null ||
			row.verification !== 'NOT_APPLICABLE' ||
			row.errorCode !== undefined
		) {
			throw new AvatarMediaCutoverError('Manifest NONE row is invalid');
		}
		return;
	}

	if (row.classification === 'EXTERNAL') {
		if (
			row.avatarPathSha256 === null ||
			row.avatarObjectKeySha256 !== null ||
			row.verification !== 'NOT_APPLICABLE' ||
			row.errorCode !== undefined
		) {
			throw new AvatarMediaCutoverError(
				'Manifest EXTERNAL row is invalid'
			);
		}
		return;
	}

	if (row.classification === 'INVALID') {
		if (
			(row.avatarPathSha256 === null &&
				row.avatarObjectKeySha256 === null) ||
			row.verification !== 'NOT_APPLICABLE' ||
			!hasError ||
			!CLASSIFICATION_ERROR_CODES.has(row.errorCode!)
		) {
			throw new AvatarMediaCutoverError('Manifest INVALID row is invalid');
		}
		return;
	}

	if (
		row.avatarPathSha256 === null ||
		(row.classification === 'NEW_MANAGED') !==
			(row.avatarObjectKeySha256 !== null)
	) {
		throw new AvatarMediaCutoverError('Manifest managed row is invalid');
	}

	if (row.classification === 'NEW_MANAGED') {
		if (
			!row.managedObjectKey ||
			sha256(row.managedObjectKey) !== row.avatarObjectKeySha256 ||
			!manifestManagedKeyBelongsToUser(row.managedObjectKey, row.userId)
		) {
			throw new AvatarMediaCutoverError(
				'Manifest NEW_MANAGED object key is invalid'
			);
		}
		const verified =
			row.verification === 'VERIFIED' &&
			Boolean(row.managedObjectSha256) &&
			row.errorCode === undefined;
		const failed =
			row.managedObjectSha256 === undefined &&
			((row.verification === 'MISSING' &&
				row.errorCode === 'NEW_OBJECT_MISSING') ||
				(row.verification === 'INVALID' &&
					hasError &&
					NEW_OBJECT_INVALID_ERROR_CODES.has(row.errorCode!)));
		if (!verified && !failed) {
			throw new AvatarMediaCutoverError(
				'Manifest NEW_MANAGED verification is invalid'
			);
		}
		return;
	}

	const verified =
		row.verification === 'VERIFIED' &&
		hasSourceDigests &&
		row.errorCode === undefined;
	const failed =
		!hasSourceDigests &&
		((row.verification === 'MISSING' &&
			row.errorCode === 'SOURCE_MISSING') ||
			(row.verification === 'INVALID' &&
				hasError &&
				LEGACY_SOURCE_INVALID_ERROR_CODES.has(row.errorCode!)));
	const unavailable =
		row.verification === 'UNAVAILABLE' &&
		!hasSourceDigests &&
		row.errorCode === undefined;
	if (!verified && !failed && !unavailable) {
		throw new AvatarMediaCutoverError(
			'Manifest legacy verification is invalid'
		);
	}
}

function manifestRowKeys(row: AvatarManifestRow): string[] {
	return [
		'userId',
		'avatarPathSha256',
		'avatarObjectKeySha256',
		'classification',
		'verification',
		...(row.errorCode === undefined ? [] : ['errorCode']),
		...(row.managedObjectKey === undefined ? [] : ['managedObjectKey']),
		...(row.managedObjectSha256 === undefined
			? []
			: ['managedObjectSha256']),
		...(row.source === undefined ? [] : ['source'])
	];
}

function manifestManagedKeyBelongsToUser(
	objectKey: string,
	userId: string
): boolean {
	const ownerFingerprint = sha256(userId);
	const marker = `/${ownerFingerprint}/`;
	const markerIndex = objectKey.lastIndexOf(marker);
	if (markerIndex <= 0) return false;
	return isOwnedAvatarObjectKey(
		objectKey.slice(0, markerIndex),
		objectKey,
		ownerFingerprint
	);
}

function hasExactKeys(
	value: object,
	expected: readonly string[]
): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	);
}

export function summarizeManifest(manifest: AvatarMediaManifest) {
	const counts = Object.fromEntries(
		CLASSIFICATIONS.map(item => [item, 0])
	) as ManifestCounts;
	let verificationFailures = 0;
	for (const row of manifest.rows) {
		counts[row.classification] += 1;
		const expectedVerification = ['NONE', 'EXTERNAL', 'INVALID'].includes(
			row.classification
		)
			? 'NOT_APPLICABLE'
			: 'VERIFIED';
		if (row.verification !== expectedVerification) {
			verificationFailures += 1;
		}
	}
	return {
		users: manifest.rows.length,
		counts,
		verificationFailures,
		unresolved:
			counts.LEGACY_S3 +
			counts.LEGACY_UPLOAD +
			counts.INVALID +
			manifest.rows.filter(
				row =>
					row.classification === 'NEW_MANAGED' &&
					row.verification !== 'VERIFIED'
			).length
	};
}

function loadConfig(
	action: Action,
	environment: NodeJS.ProcessEnv
): AvatarMediaCutoverConfig {
	const needsStorage = action === 'inventory' || action === 'migrate';
	const keyPrefix = objectPrefix(
		required(environment, 'IDENTITY_AVATAR_S3_KEY_PREFIX'),
		'IDENTITY_AVATAR_S3_KEY_PREFIX'
	);
	const legacyKeyPrefix = objectPrefix(
		required(environment, 'IDENTITY_AVATAR_MIGRATION_LEGACY_KEY_PREFIX'),
		'IDENTITY_AVATAR_MIGRATION_LEGACY_KEY_PREFIX'
	);
	if (prefixesOverlap(keyPrefix, legacyKeyPrefix)) {
		throw new AvatarMediaCutoverError(
			'New and legacy avatar key prefixes must not overlap'
		);
	}
	const uploadsRoot =
		environment.IDENTITY_AVATAR_MIGRATION_UPLOADS_ROOT?.trim();
	if (uploadsRoot && !safeAbsolutePath(uploadsRoot)) {
		throw new AvatarMediaCutoverError(
			'IDENTITY_AVATAR_MIGRATION_UPLOADS_ROOT must be absolute'
		);
	}
	return {
		databaseUrl: required(environment, 'IDENTITY_DATABASE_URL'),
		endpoint: needsStorage
			? exactUrl(
					required(environment, 'IDENTITY_AVATAR_S3_ENDPOINT'),
					'IDENTITY_AVATAR_S3_ENDPOINT'
				).toString()
			: null,
		region: needsStorage
			? required(environment, 'IDENTITY_AVATAR_S3_REGION')
			: null,
		bucket: needsStorage
			? required(environment, 'IDENTITY_AVATAR_S3_BUCKET')
			: null,
		publicBaseUrl: publicBase(
			required(environment, 'IDENTITY_AVATAR_S3_PUBLIC_BASE_URL'),
			'IDENTITY_AVATAR_S3_PUBLIC_BASE_URL'
		),
		keyPrefix,
		legacyPublicBaseUrl: publicBase(
			required(
				environment,
				'IDENTITY_AVATAR_MIGRATION_LEGACY_PUBLIC_BASE_URL'
			),
			'IDENTITY_AVATAR_MIGRATION_LEGACY_PUBLIC_BASE_URL'
		),
		legacyKeyPrefix,
		uploadsPublicBaseUrl:
			environment.IDENTITY_AVATAR_MIGRATION_UPLOADS_PUBLIC_BASE_URL?.trim()
				? publicBase(
						environment.IDENTITY_AVATAR_MIGRATION_UPLOADS_PUBLIC_BASE_URL,
						'IDENTITY_AVATAR_MIGRATION_UPLOADS_PUBLIC_BASE_URL'
					)
				: null,
		uploadsRoot: uploadsRoot || null,
		forcePathStyle: strictBoolean(
			environment.IDENTITY_AVATAR_S3_FORCE_PATH_STYLE,
			true,
			'IDENTITY_AVATAR_S3_FORCE_PATH_STYLE'
		),
		accessKeyId: needsStorage
			? required(environment, 'IDENTITY_AVATAR_MIGRATION_S3_ACCESS_KEY_ID')
			: null,
		secretAccessKey: needsStorage
			? required(
					environment,
					'IDENTITY_AVATAR_MIGRATION_S3_SECRET_ACCESS_KEY'
				)
			: null
	};
}

function migrationS3Client(config: AvatarMediaCutoverConfig): S3Client {
	if (
		!config.endpoint ||
		!config.region ||
		!config.accessKeyId ||
		!config.secretAccessKey
	) {
		throw new AvatarMediaCutoverError(
			'Migration S3 access is unavailable'
		);
	}
	return new S3Client({
		endpoint: config.endpoint,
		region: config.region,
		forcePathStyle: config.forcePathStyle,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey
		},
		maxAttempts: 3
	});
}

function manifestRow(user: AvatarState) {
	return {
		userId: user.id,
		avatarPathSha256: digestNullable(user.avatarPath),
		avatarObjectKeySha256: digestNullable(user.avatarObjectKey)
	};
}

function classified(
	base: ReturnType<typeof manifestRow>,
	classification: Exclude<
		Classification,
		'INVALID' | 'LEGACY_S3' | 'LEGACY_UPLOAD'
	>
): AvatarManifestRow {
	return {
		...base,
		classification,
		verification: 'NOT_APPLICABLE'
	};
}

function invalid(
	base: ReturnType<typeof manifestRow>,
	errorCode: string
): AvatarManifestRow {
	return {
		...base,
		classification: 'INVALID',
		verification: 'NOT_APPLICABLE',
		errorCode
	};
}

function keyFromPublicUrl(
	value: string,
	publicBaseUrl: string
): string | null {
	try {
		const target = new URL(value);
		const base = new URL(`${publicBaseUrl.replace(/\/+$/, '')}/`);
		if (
			target.origin !== base.origin ||
			target.username ||
			target.password ||
			target.search ||
			target.hash ||
			!target.pathname.startsWith(base.pathname)
		) {
			return null;
		}
		const encoded = target.pathname.slice(base.pathname.length);
		const segments = encoded
			.split('/')
			.map(segment => decodeURIComponent(segment));
		if (
			!segments.length ||
			segments.some(segment => !safeSegment(segment))
		) {
			return null;
		}
		return segments.join('/');
	} catch {
		return null;
	}
}

function rawLegacyKey(value: string): string | null {
	return safeKey(value) ? value : null;
}

function uploadsKey(
	value: string,
	uploadsPublicBaseUrl: string | null
): string | null {
	const absoluteKey = uploadsPublicBaseUrl
		? keyFromPublicUrl(value, uploadsPublicBaseUrl)
		: null;
	const path = absoluteKey ? `/${absoluteKey}` : value;
	if (!path.startsWith('/uploads/user-avatar/')) return null;
	const key = path.slice('/uploads/'.length);
	return safeKey(key) ? key : null;
}

function safeExternalUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return (
			['http:', 'https:'].includes(parsed.protocol) &&
			!parsed.username &&
			!parsed.password
		);
	} catch {
		return false;
	}
}

function safeKey(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 1_024 &&
		!value.startsWith('/') &&
		value.split('/').every(safeSegment)
	);
}

function safeSegment(value: string): boolean {
	return (
		Boolean(value) &&
		value !== '.' &&
		value !== '..' &&
		!value.includes('\\') &&
		!value.includes('/') &&
		!/[\u0000-\u001f\u007f?#]/.test(value)
	);
}

function isKeyInsidePrefix(key: string, prefix: string): boolean {
	return safeKey(key) && key.startsWith(`${prefix}/`);
}

function prefixesOverlap(left: string, right: string): boolean {
	return (
		left === right ||
		left.startsWith(`${right}/`) ||
		right.startsWith(`${left}/`)
	);
}

function digestNullable(value: string | null): string | null {
	return value === null ? null : sha256(value);
}

function nullableDigest(value: unknown): boolean {
	return (
		value === null ||
		(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
	);
}

function missingSource(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const value = error as {
		name?: string;
		code?: string;
		$metadata?: { httpStatusCode?: number };
	};
	return (
		value.name === 'NoSuchKey' ||
		value.code === 'ENOENT' ||
		value.$metadata?.httpStatusCode === 404
	);
}

function newObjectMissing(error: unknown): boolean {
	return (
		error instanceof AvatarMediaCutoverError &&
		error.message === 'NEW_OBJECT_MISSING'
	);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new AvatarMediaCutoverError(`${name} is required`);
	return value;
}

function objectPrefix(value: string, name: string): string {
	const prefix = value.replace(/^\/+|\/+$/g, '');
	if (!safeKey(prefix)) {
		throw new AvatarMediaCutoverError(`${name} is invalid`);
	}
	return prefix;
}

function exactUrl(value: string, name: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new AvatarMediaCutoverError(`${name} must be an HTTP(S) URL`);
	}
	if (
		!['http:', 'https:'].includes(parsed.protocol) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new AvatarMediaCutoverError(
			`${name} must be an exact HTTP(S) URL`
		);
	}
	return parsed;
}

function publicBase(value: string, name: string): string {
	return exactUrl(value, name).toString().replace(/\/+$/, '');
}

function strictBoolean(
	value: string | undefined,
	fallback: boolean,
	name: string
): boolean {
	if (!value?.trim()) return fallback;
	if (value.trim().toLowerCase() === 'true') return true;
	if (value.trim().toLowerCase() === 'false') return false;
	throw new AvatarMediaCutoverError(`${name} must be true or false`);
}

function safeAbsolutePath(value: string | undefined): value is string {
	return Boolean(value && isAbsolute(value) && !value.includes('\0'));
}

function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new AvatarMediaCutoverError(
				'Manifest contains a non-finite number'
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJson(item)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0
			)
			.map(
				([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`
			)
			.join(',')}}`;
	}
	throw new AvatarMediaCutoverError(
		'Manifest contains an unsupported value'
	);
}

if (require.main === module) {
	runAvatarMediaCutover(parseAvatarMediaCutoverArgs(process.argv.slice(2)))
		.then(result => {
			process.stdout.write(`${JSON.stringify(result)}\n`);
			if (!result.ok) process.exitCode = 2;
		})
		.catch(error => {
			process.stderr.write(
				`${JSON.stringify({
					ok: false,
					error:
						error instanceof AvatarMediaCutoverError
							? error.message
							: 'Avatar media cutover failed'
				})}\n`
			);
			process.exitCode = 1;
		});
}
