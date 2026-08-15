import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	DeleteObjectCommand,
	ListObjectVersionsCommand,
	S3Client
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { sha256 } from '../common/identity.util';
import {
	AVATAR_MAX_INPUT_PIXELS,
	AVATAR_MAX_UPLOAD_BYTES,
	AvatarStorageService,
	UnsafeAvatarObjectVersionStateError,
	isOwnedAvatarObjectKey,
	normalizeAvatarImage
} from './avatar-storage.service';

const USER_ID = 'user-1';
const OWNER_FINGERPRINT = sha256(USER_ID);
const OWNED_OBJECT_KEY = `identity/avatars/${OWNER_FINGERPRINT}/00000000-0000-4000-8000-000000000001.webp`;

function config(values: Record<string, string> = {}) {
	return new ConfigService({
		MODE: 'test',
		IDENTITY_AVATAR_S3_ENDPOINT: 'https://storage.example.test',
		IDENTITY_AVATAR_S3_REGION: 'test-1',
		IDENTITY_AVATAR_S3_BUCKET: 'avatars',
		IDENTITY_AVATAR_S3_PUBLIC_BASE_URL: 'https://cdn.example.test/avatars',
		IDENTITY_AVATAR_S3_KEY_PREFIX: 'identity/avatars',
		IDENTITY_AVATAR_S3_FORCE_PATH_STYLE: 'true',
		IDENTITY_AVATAR_S3_API_ACCESS_KEY_ID: 'api-key',
		IDENTITY_AVATAR_S3_API_SECRET_ACCESS_KEY: 'api-secret',
		IDENTITY_AVATAR_S3_WORKER_ACCESS_KEY_ID: 'worker-key',
		IDENTITY_AVATAR_S3_WORKER_SECRET_ACCESS_KEY: 'worker-secret',
		...values
	});
}

function file(buffer: Buffer, mimetype: string): Express.Multer.File {
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

describe('AvatarStorageService image boundary', () => {
	it('normalizes a decoded image to metadata-free bounded WebP', async () => {
		const input = await sharp({
			create: {
				width: 1_500,
				height: 900,
				channels: 4,
				background: '#336699'
			}
		})
			.withMetadata({ orientation: 6 })
			.png()
			.toBuffer();
		const output = await normalizeAvatarImage(input, 'image/png');
		const metadata = await sharp(output).metadata();

		expect(metadata).toMatchObject({
			format: 'webp',
			width: 614,
			height: 1024
		});
		expect(metadata.orientation).toBeUndefined();
		expect(metadata.exif).toBeUndefined();
		expect(output.length).toBeLessThanOrEqual(AVATAR_MAX_UPLOAD_BYTES);
	});

	it('rejects MIME/magic mismatch, SVG and oversized bodies', async () => {
		const png = await sharp({
			create: {
				width: 2,
				height: 2,
				channels: 3,
				background: '#fff'
			}
		})
			.png()
			.toBuffer();
		await expect(
			normalizeAvatarImage(png, 'image/jpeg')
		).rejects.toThrow();
		await expect(
			normalizeAvatarImage(Buffer.from('<svg></svg>'))
		).rejects.toThrow();
		await expect(
			normalizeAvatarImage(Buffer.alloc(AVATAR_MAX_UPLOAD_BYTES + 1))
		).rejects.toThrow();
	});

	it('rejects animated WebP and images above the decoded pixel limit', async () => {
		const frames = Buffer.concat([
			Buffer.alloc(2 * 2 * 4, 0xff),
			Buffer.alloc(2 * 2 * 4, 0x00)
		]);
		const animated = await sharp(frames, {
			raw: { width: 2, height: 4, channels: 4, pageHeight: 2 },
			animated: true
		})
			.webp({ loop: 0, delay: [100, 100] })
			.toBuffer();
		await expect(
			normalizeAvatarImage(animated, 'image/webp')
		).rejects.toThrow();

		const side = Math.floor(Math.sqrt(AVATAR_MAX_INPUT_PIXELS)) + 1;
		const oversizedPixels = await sharp({
			create: {
				width: side,
				height: side,
				channels: 3,
				background: '#000'
			}
		})
			.png()
			.toBuffer();
		await expect(
			normalizeAvatarImage(oversizedPixels, 'image/png')
		).rejects.toThrow();
	}, 30_000);

	it('generates an owned server key and a narrow public URL', async () => {
		const service = new AvatarStorageService(config(), {
			apiEnabled: true,
			workerEnabled: false
		} as any);
		const png = await sharp({
			create: {
				width: 4,
				height: 4,
				channels: 3,
				background: '#fff'
			}
		})
			.png()
			.toBuffer();
		const prepared = await service.prepare(
			USER_ID,
			file(png, 'image/png')
		);

		expect(
			isOwnedAvatarObjectKey(
				'identity/avatars',
				prepared.objectKey,
				sha256(USER_ID)
			)
		).toBe(true);
		expect(prepared.publicUrl).toBe(
			`https://cdn.example.test/avatars/${prepared.objectKey}`
		);
		expect(await sharp(prepared.body).metadata()).toMatchObject({
			format: 'webp'
		});
	});

	it('does not require the public URL or API credential in worker role', () => {
		const values = config({
			IDENTITY_AVATAR_S3_PUBLIC_BASE_URL: '',
			IDENTITY_AVATAR_S3_API_ACCESS_KEY_ID: '',
			IDENTITY_AVATAR_S3_API_SECRET_ACCESS_KEY: ''
		});
		expect(
			() =>
				new AvatarStorageService(values, {
					apiEnabled: false,
					workerEnabled: true
				} as any)
		).not.toThrow();
	});

	it('fails closed if constructed outside API and worker roles', () => {
		expect(
			() =>
				new AvatarStorageService(new ConfigService({}), {
					apiEnabled: false,
					workerEnabled: false
				} as any)
		).toThrow(
			'Avatar storage may only run in Identity API or worker roles'
		);
	});

	it('removes every version and delete marker for an owned avatar key', async () => {
		const send = jest
			.spyOn(S3Client.prototype as any, 'send')
			.mockResolvedValueOnce({
				Versions: [{ Key: OWNED_OBJECT_KEY, VersionId: 'version-1' }],
				DeleteMarkers: [
					{ Key: OWNED_OBJECT_KEY, VersionId: 'delete-marker-1' }
				],
				IsTruncated: false
			})
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ Versions: [], DeleteMarkers: [] });
		const service = new AvatarStorageService(config(), {
			apiEnabled: false,
			workerEnabled: true
		} as any);
		const renewLease = jest.fn().mockResolvedValue(undefined);

		await service.delete(OWNED_OBJECT_KEY, OWNER_FINGERPRINT, renewLease);

		expect(send).toHaveBeenCalledTimes(4);
		expect(renewLease).toHaveBeenCalledTimes(4);
		expect(send.mock.calls[0][0]).toBeInstanceOf(
			ListObjectVersionsCommand
		);
		expect(send.mock.calls.slice(1, 3).map(call => call[0])).toEqual([
			expect.objectContaining({
				input: expect.objectContaining({ VersionId: 'version-1' })
			}),
			expect.objectContaining({
				input: expect.objectContaining({ VersionId: 'delete-marker-1' })
			})
		]);
		expect(send.mock.calls[3][0]).toBeInstanceOf(
			ListObjectVersionsCommand
		);
		send.mockRestore();
	});

	it('deletes an unversioned object and proves that no versions remain', async () => {
		const send = jest
			.spyOn(S3Client.prototype as any, 'send')
			.mockResolvedValueOnce({ Versions: [], DeleteMarkers: [] })
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ Versions: [], DeleteMarkers: [] });
		const service = new AvatarStorageService(config(), {
			apiEnabled: false,
			workerEnabled: true
		} as any);
		const renewLease = jest.fn().mockResolvedValue(undefined);

		await service.delete(OWNED_OBJECT_KEY, OWNER_FINGERPRINT, renewLease);

		expect(send).toHaveBeenCalledTimes(3);
		expect(renewLease).toHaveBeenCalledTimes(3);
		expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
		expect(
			(send.mock.calls[1][0] as DeleteObjectCommand).input.VersionId
		).toBeUndefined();
		send.mockRestore();
	});

	it('fails closed on an invalid version-list pagination state', async () => {
		const send = jest
			.spyOn(S3Client.prototype as any, 'send')
			.mockResolvedValueOnce({ IsTruncated: true });
		const service = new AvatarStorageService(config(), {
			apiEnabled: false,
			workerEnabled: true
		} as any);

		await expect(
			service.delete(OWNED_OBJECT_KEY, OWNER_FINGERPRINT)
		).rejects.toBeInstanceOf(UnsafeAvatarObjectVersionStateError);
		send.mockRestore();
	});

	it('fails closed on a malformed object-version entry', async () => {
		const send = jest
			.spyOn(S3Client.prototype as any, 'send')
			.mockResolvedValueOnce({
				Versions: [{ Key: OWNED_OBJECT_KEY }],
				IsTruncated: false
			});
		const service = new AvatarStorageService(config(), {
			apiEnabled: false,
			workerEnabled: true
		} as any);

		await expect(
			service.delete(OWNED_OBJECT_KEY, OWNER_FINGERPRINT)
		).rejects.toBeInstanceOf(UnsafeAvatarObjectVersionStateError);
		send.mockRestore();
	});

	it('maps invalid API image input to a 400 response', async () => {
		const service = new AvatarStorageService(config(), {
			apiEnabled: true,
			workerEnabled: false
		} as any);
		await expect(
			service.prepare(USER_ID, file(Buffer.from('<svg/>'), 'image/jpeg'))
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
