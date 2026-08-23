import {
	DeleteObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	AVATAR_MAX_UPLOAD_BYTES,
	AvatarStorageService,
	avatarObjectKey,
	validateAvatarFile
} from './avatar-storage.service';

const USER_ID = 'user-1';
const OBJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
const KEY = `identity/avatars/${USER_ID}/${OBJECT_ID}`;

function config(values: Record<string, string> = {}) {
	return new ConfigService({
		MODE: 'test',
		IDENTITY_AVATAR_S3_ENDPOINT: 'https://storage.example.test',
		IDENTITY_AVATAR_S3_REGION: 'test-1',
		IDENTITY_AVATAR_S3_BUCKET: 'avatars',
		IDENTITY_AVATAR_S3_ACCESS_KEY_ID: 'access-key',
		IDENTITY_AVATAR_S3_SECRET_ACCESS_KEY: 'secret-key',
		IDENTITY_AVATAR_S3_PUBLIC_BASE_URL: 'https://cdn.example.test/bucket',
		IDENTITY_AVATAR_S3_FORCE_PATH_STYLE: 'true',
		...values
	});
}

function multerFile(
	buffer: Buffer,
	mimetype: string
): Express.Multer.File {
	return {
		fieldname: 'file',
		originalname: 'avatar',
		encoding: '7bit',
		mimetype,
		size: buffer.length,
		buffer,
		stream: undefined as never,
		destination: '',
		filename: '',
		path: ''
	};
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]);
const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(4),
	Buffer.from('IHDR'),
	Buffer.alloc(8)
]);
const WEBP = Buffer.concat([
	Buffer.from('RIFF'),
	Buffer.alloc(4),
	Buffer.from('WEBP'),
	Buffer.from('VP8 '),
	Buffer.alloc(4)
]);

describe('AvatarStorageService', () => {
	afterEach(() => jest.restoreAllMocks());

	it.each([
		['image/jpeg', JPEG],
		['image/png', PNG],
		['image/webp', WEBP]
	])('accepts %s only when MIME and magic agree', (mimetype, body) => {
		expect(validateAvatarFile(multerFile(body, mimetype))).toBe(mimetype);
	});

	it('puts the exact server-owned key and returns a cache-busted URL', async () => {
		const send = jest
			.spyOn(S3Client.prototype, 'send')
			.mockResolvedValue({} as never);
		const service = new AvatarStorageService(config());

		const prepared = service.prepare(
			USER_ID,
			multerFile(PNG, 'image/png')
		);
		await service.upload(prepared);

		expect(prepared.objectKey).toMatch(
			/^identity\/avatars\/user-1\/[0-9a-f-]{36}$/
		);
		expect(prepared.avatarPath).toBe(
			`https://cdn.example.test/bucket/${prepared.objectKey}`
		);
		const command = send.mock.calls[0]?.[0];
		expect(command).toBeInstanceOf(PutObjectCommand);
		expect((command as PutObjectCommand).input).toEqual({
			Bucket: 'avatars',
			Key: prepared.objectKey,
			Body: PNG,
			ContentType: 'image/png',
			ContentDisposition: 'inline',
			CacheControl: 'public, max-age=31536000, immutable'
		});
	});

	it('creates a distinct immutable object for every upload', () => {
		const service = new AvatarStorageService(config());
		const first = service.prepare(USER_ID, multerFile(PNG, 'image/png'));
		const second = service.prepare(USER_ID, multerFile(PNG, 'image/png'));
		expect(first.objectKey).not.toBe(second.objectKey);
		expect(first.avatarPath).not.toBe(second.avatarPath);
	});

	it('rejects spoofed, missing, inconsistent and oversized files', () => {
		expect(() =>
			validateAvatarFile(multerFile(PNG, 'image/jpeg'))
		).toThrow(BadRequestException);
		expect(() => validateAvatarFile(undefined)).toThrow(
			BadRequestException
		);
		const inconsistent = multerFile(PNG, 'image/png');
		inconsistent.size += 1;
		expect(() => validateAvatarFile(inconsistent)).toThrow(
			BadRequestException
		);
		expect(() =>
			validateAvatarFile(
				multerFile(Buffer.alloc(AVATAR_MAX_UPLOAD_BYTES + 1), 'image/png')
			)
		).toThrow(BadRequestException);
	});

	it('deletes only the key derived from the authenticated target', async () => {
		const send = jest
			.spyOn(S3Client.prototype, 'send')
			.mockResolvedValue({} as never);
		const service = new AvatarStorageService(config());

		await service.deleteObject(KEY);

		const command = send.mock.calls[0]?.[0];
		expect(command).toBeInstanceOf(DeleteObjectCommand);
		expect((command as DeleteObjectCommand).input).toEqual({
			Bucket: 'avatars',
			Key: KEY
		});
	});

	it('recognizes only its exact user URL and preserves provider URLs', () => {
		const service = new AvatarStorageService(config());
		expect(
			service.isOwnedUrl(USER_ID, `https://cdn.example.test/bucket/${KEY}`)
		).toBe(true);
		expect(
			service.isOwnedUrl(
				USER_ID,
				'https://avatars.githubusercontent.com/u/1'
			)
		).toBe(false);
		expect(
			service.isOwnedUrl(
				'another-user',
				`https://cdn.example.test/bucket/${KEY}`
			)
		).toBe(false);
		expect(
			service.isOwnedUrl(
				USER_ID,
				`https://cdn.example.test/bucket/${KEY}?version=1`
			)
		).toBe(false);
	});

	it('builds only exact server-owned versioned keys', () => {
		expect(avatarObjectKey(USER_ID, OBJECT_ID)).toBe(KEY);
		expect(() => avatarObjectKey(USER_ID, 'avatar')).toThrow(
			BadRequestException
		);
	});

	it('requires HTTPS storage endpoints in production', () => {
		expect(
			() =>
				new AvatarStorageService(
					config({
						MODE: 'production',
						IDENTITY_AVATAR_S3_ENDPOINT: 'http://storage.example.test'
					})
				)
		).toThrow('Identity avatar storage URLs must use HTTPS');
	});
});
