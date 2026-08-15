import {
	DeleteObjectCommand,
	ListObjectVersionsCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { sha256 } from '../common/identity.util';
import { IdentityRuntimeService } from '../runtime/identity-runtime.service';

export const AVATAR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const AVATAR_MAX_INPUT_PIXELS = 4096 * 4096;
export const AVATAR_OUTPUT_MAX_DIMENSION = 1024;
export const AVATAR_STAGING_GRACE_MS = 15 * 60_000;

const AVATAR_CONTENT_TYPE = 'image/webp';
const AVATAR_UPLOAD_TIMEOUT_MS = 15_000;
const AVATAR_DELETE_TIMEOUT_MS = 10_000;
const AVATAR_VERSION_LIST_PAGE_LIMIT = 100;
const AVATAR_VERSION_ENTRY_LIMIT = 100;
const AVATAR_VERSION_LIST_SCAN_LIMIT = 10_000;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AvatarInputFormat = 'jpeg' | 'png' | 'webp';
type AvatarCleanupLeaseHeartbeat = () => Promise<void>;

export interface PreparedAvatar {
	objectKey: string;
	ownerFingerprint: string;
	publicUrl: string;
	body: Buffer;
}

@Injectable()
export class AvatarStorageService {
	private readonly client: S3Client;
	private readonly bucket: string;
	private readonly publicBaseUrl: string | null;
	private readonly keyPrefix: string;

	constructor(
		config: ConfigService,
		private readonly runtime: IdentityRuntimeService
	) {
		if (!runtime.apiEnabled && !runtime.workerEnabled) {
			throw new Error(
				'Avatar storage may only run in Identity API or worker roles'
			);
		}
		const endpoint = required(config, 'IDENTITY_AVATAR_S3_ENDPOINT');
		const region = required(config, 'IDENTITY_AVATAR_S3_REGION');
		this.bucket = required(config, 'IDENTITY_AVATAR_S3_BUCKET');
		this.publicBaseUrl = runtime.apiEnabled
			? publicBaseUrl(
					required(config, 'IDENTITY_AVATAR_S3_PUBLIC_BASE_URL'),
					config.get<string>('MODE')
				)
			: null;
		this.keyPrefix = objectPrefix(
			required(config, 'IDENTITY_AVATAR_S3_KEY_PREFIX'),
			'IDENTITY_AVATAR_S3_KEY_PREFIX'
		);
		const accessKey = required(
			config,
			runtime.apiEnabled
				? 'IDENTITY_AVATAR_S3_API_ACCESS_KEY_ID'
				: 'IDENTITY_AVATAR_S3_WORKER_ACCESS_KEY_ID'
		);
		const secretKey = required(
			config,
			runtime.apiEnabled
				? 'IDENTITY_AVATAR_S3_API_SECRET_ACCESS_KEY'
				: 'IDENTITY_AVATAR_S3_WORKER_SECRET_ACCESS_KEY'
		);
		const endpointUrl = exactUrl(endpoint, 'IDENTITY_AVATAR_S3_ENDPOINT');
		if (
			config.get<string>('MODE') === 'production' &&
			endpointUrl.protocol !== 'https:'
		) {
			throw new Error(
				'IDENTITY_AVATAR_S3_ENDPOINT must use HTTPS in production'
			);
		}
		this.client = new S3Client({
			endpoint: endpointUrl.toString().replace(/\/$/, ''),
			region,
			forcePathStyle: strictBoolean(
				config.get<string>('IDENTITY_AVATAR_S3_FORCE_PATH_STYLE'),
				true,
				'IDENTITY_AVATAR_S3_FORCE_PATH_STYLE'
			),
			credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
			maxAttempts: 3
		});
	}

	async prepare(
		userId: string,
		file?: Express.Multer.File
	): Promise<PreparedAvatar> {
		if (!this.runtime.apiEnabled) {
			throw new Error('Only Identity API may prepare avatar uploads');
		}
		if (!file?.buffer?.length) {
			throw new BadRequestException('Avatar file is required');
		}
		let body: Buffer;
		try {
			body = await normalizeAvatarImage(file.buffer, file.mimetype);
		} catch {
			throw new BadRequestException(
				'Avatar image is invalid, animated or too large'
			);
		}

		const ownerFingerprint = sha256(userId);
		const objectKey = createAvatarObjectKey(
			this.keyPrefix,
			ownerFingerprint
		);
		return {
			objectKey,
			ownerFingerprint,
			publicUrl: this.url(objectKey),
			body
		};
	}

	async upload(prepared: PreparedAvatar): Promise<void> {
		if (!this.runtime.apiEnabled) {
			throw new Error('Only Identity API may upload avatars');
		}
		if (!this.isOwnedKey(prepared.objectKey, prepared.ownerFingerprint)) {
			throw new Error('Refusing to upload an invalid avatar object key');
		}
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: prepared.objectKey,
				Body: prepared.body,
				ContentType: AVATAR_CONTENT_TYPE,
				ContentDisposition: 'inline',
				CacheControl: 'public, max-age=31536000, immutable'
			}),
			{ abortSignal: AbortSignal.timeout(AVATAR_UPLOAD_TIMEOUT_MS) }
		);
	}

	async delete(
		objectKey: string,
		ownerFingerprint: string,
		beforeRequest: AvatarCleanupLeaseHeartbeat = async () => undefined
	): Promise<void> {
		if (!this.runtime.workerEnabled) {
			throw new Error('Only Identity worker may delete avatar objects');
		}
		if (!this.isOwnedKey(objectKey, ownerFingerprint)) {
			throw new UnsafeAvatarObjectKeyError();
		}
		let versions = await this.listExactObjectVersions(
			this.client,
			this.bucket,
			objectKey,
			beforeRequest
		);
		if (!versions.length) {
			await beforeRequest();
			await this.client.send(
				new DeleteObjectCommand({
					Bucket: this.bucket,
					Key: objectKey
				}),
				{ abortSignal: AbortSignal.timeout(AVATAR_DELETE_TIMEOUT_MS) }
			);
			versions = await this.listExactObjectVersions(
				this.client,
				this.bucket,
				objectKey,
				beforeRequest
			);
			if (!versions.length) return;
		}
		for (const version of versions) {
			await beforeRequest();
			await this.client.send(
				new DeleteObjectCommand({
					Bucket: this.bucket,
					Key: objectKey,
					VersionId: version.versionId
				}),
				{ abortSignal: AbortSignal.timeout(AVATAR_DELETE_TIMEOUT_MS) }
			);
		}
		if (
			(
				await this.listExactObjectVersions(
					this.client,
					this.bucket,
					objectKey,
					beforeRequest
				)
			).length
		) {
			throw new Error('Avatar object versions remain after cleanup');
		}
	}

	isOwnedKey(objectKey: string, ownerFingerprint: string): boolean {
		return isOwnedAvatarObjectKey(
			this.keyPrefix,
			objectKey,
			ownerFingerprint
		);
	}

	private url(objectKey: string): string {
		if (!this.publicBaseUrl) {
			throw new Error(
				'Avatar public URL is unavailable outside Identity API'
			);
		}
		return buildAvatarPublicUrl(this.publicBaseUrl, objectKey);
	}

	private async listExactObjectVersions(
		client: S3Client,
		bucket: string,
		objectKey: string,
		beforeRequest: AvatarCleanupLeaseHeartbeat
	): Promise<Array<{ versionId: string }>> {
		const versions = new Map<string, { versionId: string }>();
		const seenMarkers = new Set<string>();
		let keyMarker: string | undefined;
		let versionIdMarker: string | undefined;
		let scanned = 0;
		for (let page = 0; page < AVATAR_VERSION_LIST_PAGE_LIMIT; page += 1) {
			await beforeRequest();
			const result = await client.send(
				new ListObjectVersionsCommand({
					Bucket: bucket,
					Prefix: objectKey,
					KeyMarker: keyMarker,
					VersionIdMarker: versionIdMarker,
					MaxKeys: 1_000
				}),
				{ abortSignal: AbortSignal.timeout(AVATAR_DELETE_TIMEOUT_MS) }
			);
			const entries = [
				...(result.Versions || []),
				...(result.DeleteMarkers || [])
			];
			scanned += entries.length;
			if (scanned > AVATAR_VERSION_LIST_SCAN_LIMIT) {
				throw new UnsafeAvatarObjectVersionStateError();
			}
			for (const entry of entries) {
				if (!entry.Key || !entry.VersionId) {
					throw new UnsafeAvatarObjectVersionStateError();
				}
				if (entry.Key !== objectKey) continue;
				versions.set(entry.VersionId, { versionId: entry.VersionId });
				if (versions.size > AVATAR_VERSION_ENTRY_LIMIT) {
					throw new UnsafeAvatarObjectVersionStateError();
				}
			}
			if (!result.IsTruncated) return [...versions.values()];
			if (!result.NextKeyMarker) {
				throw new UnsafeAvatarObjectVersionStateError();
			}
			const marker = `${result.NextKeyMarker}\u0000${result.NextVersionIdMarker || ''}`;
			if (seenMarkers.has(marker)) {
				throw new UnsafeAvatarObjectVersionStateError();
			}
			seenMarkers.add(marker);
			keyMarker = result.NextKeyMarker;
			versionIdMarker = result.NextVersionIdMarker;
		}
		throw new UnsafeAvatarObjectVersionStateError();
	}
}

export function isOwnedAvatarObjectKey(
	keyPrefix: string,
	objectKey: string,
	ownerFingerprint: string
): boolean {
	if (!/^[a-f0-9]{64}$/.test(ownerFingerprint)) return false;
	const prefix = `${keyPrefix}/${ownerFingerprint}/`;
	if (!objectKey.startsWith(prefix)) return false;
	const name = objectKey.slice(prefix.length);
	return name.endsWith('.webp') && UUID.test(name.slice(0, -5));
}

export function createAvatarObjectKey(
	keyPrefix: string,
	ownerFingerprint: string
): string {
	if (!/^[a-f0-9]{64}$/.test(ownerFingerprint)) {
		throw new Error('Avatar owner fingerprint is invalid');
	}
	return `${keyPrefix}/${ownerFingerprint}/${randomUUID()}.webp`;
}

export function buildAvatarPublicUrl(
	publicBaseUrl: string,
	objectKey: string
): string {
	return `${publicBaseUrl.replace(/\/+$/, '')}/${objectKey
		.split('/')
		.map(encodeURIComponent)
		.join('/')}`;
}

export async function normalizeAvatarImage(
	body: Buffer,
	declaredMime?: string
): Promise<Buffer> {
	if (!body.length || body.length > AVATAR_MAX_UPLOAD_BYTES) {
		throw new AvatarImageValidationError();
	}
	const declared = declaredMime ? declaredFormat(declaredMime) : null;
	const detected = detectFormat(body);
	if (!detected || (declaredMime && declared !== detected)) {
		throw new AvatarImageValidationError();
	}
	const metadata = await sharp(body, {
		animated: true,
		failOn: 'warning',
		limitInputPixels: AVATAR_MAX_INPUT_PIXELS
	}).metadata();
	if (
		metadata.format !== detected ||
		!metadata.width ||
		!metadata.height ||
		metadata.width * metadata.height > AVATAR_MAX_INPUT_PIXELS ||
		(metadata.pages || 1) !== 1
	) {
		throw new AvatarImageValidationError();
	}
	const normalized = await sharp(body, {
		animated: false,
		failOn: 'warning',
		limitInputPixels: AVATAR_MAX_INPUT_PIXELS
	})
		.rotate()
		.resize({
			width: AVATAR_OUTPUT_MAX_DIMENSION,
			height: AVATAR_OUTPUT_MAX_DIMENSION,
			fit: 'inside',
			withoutEnlargement: true
		})
		.webp({ quality: 85, effort: 4 })
		.toBuffer();
	if (!normalized.length || normalized.length > AVATAR_MAX_UPLOAD_BYTES) {
		throw new AvatarImageValidationError();
	}
	return normalized;
}

export async function validateNormalizedAvatarImage(
	body: Buffer
): Promise<void> {
	if (
		!body.length ||
		body.length > AVATAR_MAX_UPLOAD_BYTES ||
		detectFormat(body) !== 'webp'
	) {
		throw new AvatarImageValidationError();
	}
	const metadata = await sharp(body, {
		animated: true,
		failOn: 'warning',
		limitInputPixels: AVATAR_MAX_INPUT_PIXELS
	}).metadata();
	if (
		metadata.format !== 'webp' ||
		!metadata.width ||
		!metadata.height ||
		metadata.width > AVATAR_OUTPUT_MAX_DIMENSION ||
		metadata.height > AVATAR_OUTPUT_MAX_DIMENSION ||
		(metadata.pages || 1) !== 1 ||
		metadata.exif ||
		metadata.icc ||
		metadata.iptc ||
		metadata.xmp
	) {
		throw new AvatarImageValidationError();
	}
}

export class AvatarImageValidationError extends Error {
	constructor() {
		super('Avatar image is invalid, animated or too large');
		this.name = 'AvatarImageValidationError';
	}
}

export class UnsafeAvatarObjectKeyError extends Error {
	constructor() {
		super('Avatar cleanup object key is outside owned prefixes');
		this.name = 'UnsafeAvatarObjectKeyError';
	}
}

export class UnsafeAvatarObjectVersionStateError extends Error {
	constructor() {
		super(
			'Avatar object version state exceeds the cleanup safety boundary'
		);
		this.name = 'UnsafeAvatarObjectVersionStateError';
	}
}

function declaredFormat(
	mime: string | undefined
): AvatarInputFormat | null {
	if (mime === 'image/jpeg') return 'jpeg';
	if (mime === 'image/png') return 'png';
	if (mime === 'image/webp') return 'webp';
	return null;
}

function detectFormat(body: Buffer): AvatarInputFormat | null {
	if (
		body.length >= 3 &&
		body[0] === 0xff &&
		body[1] === 0xd8 &&
		body[2] === 0xff
	) {
		return 'jpeg';
	}
	if (
		body.length >= 8 &&
		body
			.subarray(0, 8)
			.equals(
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
			)
	) {
		return 'png';
	}
	if (
		body.length >= 12 &&
		body.subarray(0, 4).toString('ascii') === 'RIFF' &&
		body.subarray(8, 12).toString('ascii') === 'WEBP'
	) {
		return 'webp';
	}
	return null;
}

function required(config: ConfigService, name: string): string {
	const value = config.get<string>(name)?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function objectPrefix(value: string, name: string): string {
	const prefix = value.replace(/^\/+|\/+$/g, '');
	const segments = prefix.split('/');
	if (
		!prefix ||
		segments.some(
			segment =>
				!segment ||
				segment === '.' ||
				segment === '..' ||
				!/^[a-zA-Z0-9._-]+$/.test(segment)
		)
	) {
		throw new Error(`${name} is invalid`);
	}
	return prefix;
}

function exactUrl(value: string, name: string): URL {
	const parsed = new URL(value);
	if (
		!['http:', 'https:'].includes(parsed.protocol) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error(`${name} must be an exact HTTP(S) URL`);
	}
	return parsed;
}

function publicBaseUrl(value: string, mode: string | undefined): string {
	const parsed = exactUrl(value, 'IDENTITY_AVATAR_S3_PUBLIC_BASE_URL');
	if (mode === 'production' && parsed.protocol !== 'https:') {
		throw new Error(
			'IDENTITY_AVATAR_S3_PUBLIC_BASE_URL must use HTTPS in production'
		);
	}
	return parsed.toString().replace(/\/$/, '');
}

function strictBoolean(
	value: string | undefined,
	fallback: boolean,
	name: string
): boolean {
	if (!value?.trim()) return fallback;
	if (value.trim().toLowerCase() === 'true') return true;
	if (value.trim().toLowerCase() === 'false') return false;
	throw new Error(`${name} must be true or false`);
}
