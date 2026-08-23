import {
	DeleteObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

export const AVATAR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const AVATAR_MIME_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp'
] as const;

type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];

export type PreparedAvatarUpload = {
	id: string;
	userId: string;
	objectKey: string;
	avatarPath: string;
	body: Buffer;
	contentType: AvatarMimeType;
};

export type OwnedAvatarObject = {
	id: string;
	objectKey: string;
};

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Injectable()
export class AvatarStorageService {
	private readonly client: S3Client;
	private readonly bucket: string;
	private readonly publicBaseUrl: URL;

	constructor(config: ConfigService) {
		const endpoint = exactHttpUrl(
			required(config, 'IDENTITY_AVATAR_S3_ENDPOINT'),
			'IDENTITY_AVATAR_S3_ENDPOINT'
		);
		this.publicBaseUrl = exactHttpUrl(
			required(config, 'IDENTITY_AVATAR_S3_PUBLIC_BASE_URL'),
			'IDENTITY_AVATAR_S3_PUBLIC_BASE_URL'
		);
		if (
			config.get<string>('MODE') === 'production' &&
			(endpoint.protocol !== 'https:' ||
				this.publicBaseUrl.protocol !== 'https:')
		) {
			throw new Error('Identity avatar storage URLs must use HTTPS');
		}
		this.bucket = required(config, 'IDENTITY_AVATAR_S3_BUCKET');
		this.client = new S3Client({
			endpoint: endpoint.toString().replace(/\/$/, ''),
			region: required(config, 'IDENTITY_AVATAR_S3_REGION'),
			forcePathStyle: strictBoolean(
				config.get<string>('IDENTITY_AVATAR_S3_FORCE_PATH_STYLE'),
				true,
				'IDENTITY_AVATAR_S3_FORCE_PATH_STYLE'
			),
			credentials: {
				accessKeyId: required(config, 'IDENTITY_AVATAR_S3_ACCESS_KEY_ID'),
				secretAccessKey: required(
					config,
					'IDENTITY_AVATAR_S3_SECRET_ACCESS_KEY'
				)
			},
			maxAttempts: 3
		});
	}

	prepare(
		userId: string,
		file: Express.Multer.File | undefined
	): PreparedAvatarUpload {
		const id = randomUUID();
		const objectKey = avatarObjectKey(userId, id);
		const contentType = validateAvatarFile(file);
		return {
			id,
			userId,
			objectKey,
			avatarPath: this.objectUrl(objectKey),
			body: file!.buffer,
			contentType
		};
	}

	async upload(prepared: PreparedAvatarUpload): Promise<void> {
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: prepared.objectKey,
				Body: prepared.body,
				ContentType: prepared.contentType,
				ContentDisposition: 'inline',
				CacheControl: 'public, max-age=31536000, immutable'
			}),
			{ abortSignal: AbortSignal.timeout(15_000) }
		);
	}

	async deleteObject(objectKey: string): Promise<void> {
		parseAvatarObjectKey(objectKey);
		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: objectKey
			}),
			{ abortSignal: AbortSignal.timeout(10_000) }
		);
	}

	ownedObject(
		userId: string,
		value: string | null
	): OwnedAvatarObject | null {
		if (!value) return null;
		try {
			const actual = new URL(value);
			if (actual.search || actual.hash) return null;
			const marker = randomUUID();
			const markerUrl = new URL(
				this.objectUrl(avatarObjectKey(userId, marker))
			);
			const suffix = `/${marker}`;
			if (!markerUrl.pathname.endsWith(suffix)) return null;
			const prefix = markerUrl.pathname.slice(0, -marker.length);
			if (
				actual.origin !== markerUrl.origin ||
				!actual.pathname.startsWith(prefix)
			) {
				return null;
			}
			const id = actual.pathname.slice(prefix.length);
			if (!UUID_PATTERN.test(id)) return null;
			const objectKey = avatarObjectKey(userId, id);
			const expected = new URL(this.objectUrl(objectKey));
			return actual.toString() === expected.toString()
				? { id, objectKey }
				: null;
		} catch {
			return null;
		}
	}

	isOwnedUrl(userId: string, value: string | null): boolean {
		return this.ownedObject(userId, value) !== null;
	}

	private objectUrl(key: string): string {
		const base = this.publicBaseUrl.toString().replace(/\/$/, '');
		return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
	}
}

export function avatarObjectKey(userId: string, id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
		throw new BadRequestException('Invalid avatar owner');
	}
	if (!UUID_PATTERN.test(id)) {
		throw new BadRequestException('Invalid avatar object');
	}
	return `identity/avatars/${userId}/${id}`;
}

function parseAvatarObjectKey(objectKey: string): void {
	const match =
		/^identity\/avatars\/([A-Za-z0-9_-]+)\/([0-9a-f-]{36})$/.exec(
			objectKey
		);
	if (!match) throw new BadRequestException('Invalid avatar object');
	if (avatarObjectKey(match[1]!, match[2]!) !== objectKey) {
		throw new BadRequestException('Invalid avatar object');
	}
}

export function validateAvatarFile(
	file: Express.Multer.File | undefined
): AvatarMimeType {
	if (
		!file?.buffer?.length ||
		file.buffer.length > AVATAR_MAX_UPLOAD_BYTES ||
		file.size !== file.buffer.length
	) {
		throw new BadRequestException(
			`Avatar must be a JPEG, PNG or WebP image up to ${AVATAR_MAX_UPLOAD_BYTES} bytes`
		);
	}
	const detected = detectAvatarMime(file.buffer);
	if (!detected || detected !== file.mimetype) {
		throw new BadRequestException(
			'Avatar MIME type does not match its contents'
		);
	}
	return detected;
}

function detectAvatarMime(body: Buffer): AvatarMimeType | null {
	if (
		body.length >= 4 &&
		body[0] === 0xff &&
		body[1] === 0xd8 &&
		body[2] === 0xff &&
		body[body.length - 2] === 0xff &&
		body[body.length - 1] === 0xd9
	) {
		return 'image/jpeg';
	}
	if (
		body.length >= 24 &&
		body
			.subarray(0, 8)
			.equals(
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
			) &&
		body.subarray(12, 16).toString('ascii') === 'IHDR'
	) {
		return 'image/png';
	}
	if (
		body.length >= 16 &&
		body.subarray(0, 4).toString('ascii') === 'RIFF' &&
		body.subarray(8, 12).toString('ascii') === 'WEBP' &&
		['VP8 ', 'VP8L', 'VP8X'].includes(
			body.subarray(12, 16).toString('ascii')
		)
	) {
		return 'image/webp';
	}
	return null;
}

function required(config: ConfigService, name: string): string {
	const value = config.get<string>(name)?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function exactHttpUrl(value: string, name: string): URL {
	const url = new URL(value);
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(`${name} must be an exact HTTP(S) URL`);
	}
	return url;
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
