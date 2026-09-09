import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import {
	BadRequestException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';

export const SUPPORT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_PIXELS = 40_000_000;
export const SUPPORT_UPLOAD_LIMITS = {
	fieldNameSize: 64,
	fieldSize: 256,
	fields: 4,
	fileSize: SUPPORT_ATTACHMENT_BYTES,
	files: 1,
	parts: 5,
	fieldNestingDepth: 0
};

@Injectable()
export class SupportAttachmentStorageService {
	private client: S3Client | null = null;
	private bucket = '';
	private activeDecodes = 0;
	constructor(private readonly config: ConfigService) {}
	async prepare(file: Express.Multer.File | undefined) {
		if (
			!file?.buffer?.length ||
			file.size !== file.buffer.length ||
			file.size > SUPPORT_ATTACHMENT_BYTES
		)
			throw new BadRequestException(
				'Изображение должно быть не больше 5 МБ'
			);
		if (this.activeDecodes >= 2)
			throw new ServiceUnavailableException(
				'Обработка изображений занята. Повторите загрузку.'
			);
		this.activeDecodes++;
		try {
			const decoder = sharp(file.buffer, {
				limitInputPixels: SUPPORT_ATTACHMENT_PIXELS,
				failOn: 'warning',
				animated: true
			});
			const metadata = await decoder.metadata();
			if (
				!metadata.format ||
				!['png', 'jpeg', 'webp'].includes(metadata.format) ||
				!metadata.width ||
				!metadata.height ||
				metadata.width * metadata.height > SUPPORT_ATTACHMENT_PIXELS ||
				(metadata.pages ?? 1) !== 1
			)
				throw new Error('Invalid image');
			const mediaType =
				metadata.format === 'jpeg'
					? 'image/jpeg'
					: `image/${metadata.format}`;
			if (file.mimetype !== mediaType) throw new Error('MIME mismatch');
			// Full decode/re-encode validates the image and removes metadata and trailing data.
			const body = await decoder.rotate().toBuffer();
			const actual = await sharp(body, {
				limitInputPixels: SUPPORT_ATTACHMENT_PIXELS
			}).metadata();
			if (
				body.length > SUPPORT_ATTACHMENT_BYTES ||
				!actual.width ||
				!actual.height
			)
				throw new Error('Oversize');
			const stem =
				file.originalname
					.replace(/[\x00-\x1f\x7f/\\<>\u202a-\u202e\u2066-\u2069]/g, '')
					.replace(/\.[^.]*$/, '')
					.slice(0, 120)
					.trim() || 'screenshot';
			return {
				body,
				mediaType,
				width: actual.width,
				height: actual.height,
				byteSize: body.length,
				fileName: `${stem}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`,
				contentHash: createHash('sha256').update(body).digest('hex'),
				sourceHash: createHash('sha256').update(file.buffer).digest('hex')
			};
		} catch (error) {
			if (error instanceof BadRequestException) throw error;
			throw new BadRequestException(
				'Не удалось прочитать PNG, JPEG или WebP. Анимация и слишком большие размеры запрещены.'
			);
		} finally {
			this.activeDecodes--;
		}
	}
	async put(
		key: string,
		body: Buffer,
		contentType: string
	): Promise<void> {
		this.assertKey(key);
		try {
			await this.s3().send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: key,
					Body: body,
					ContentType: contentType,
					ContentLength: body.length,
					CacheControl: 'private, no-store',
					ContentDisposition: 'inline'
				}),
				{ abortSignal: AbortSignal.timeout(15000) }
			);
		} catch {
			throw new ServiceUnavailableException(
				'Хранилище изображений временно недоступно'
			);
		}
	}
	async get(key: string, signal: AbortSignal): Promise<Readable> {
		this.assertKey(key);
		try {
			const value = await this.s3().send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key }),
				{ abortSignal: signal }
			);
			if (!(value.Body instanceof Readable))
				throw new Error('Invalid body');
			return value.Body;
		} catch {
			throw new ServiceUnavailableException(
				'Изображение временно недоступно'
			);
		}
	}
	async delete(key: string): Promise<void> {
		this.assertKey(key);
		try {
			await this.s3().send(
				new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
				{ abortSignal: AbortSignal.timeout(10000) }
			);
		} catch {
			throw new ServiceUnavailableException(
				'Хранилище изображений временно недоступно'
			);
		}
	}
	private assertKey(key: string): void {
		if (!/^support\/attachments\/[0-9a-f-]{36}$/.test(key))
			throw new Error('Invalid Support object key');
	}
	private s3(): S3Client {
		if (this.client) return this.client;
		const required = (name: string) => {
			const value = this.config.get<string>(name)?.trim();
			if (!value)
				throw new ServiceUnavailableException(
					'Хранилище изображений не настроено'
				);
			return value;
		};
		try {
			const endpoint = new URL(required('SUPPORT_S3_ENDPOINT'));
			if (
				endpoint.protocol !== 'https:' ||
				endpoint.username ||
				endpoint.password ||
				endpoint.search ||
				endpoint.hash ||
				endpoint.pathname !== '/'
			)
				throw new Error('Invalid endpoint');
			this.bucket = required('SUPPORT_S3_BUCKET');
			const forcePathStyle = required('SUPPORT_S3_FORCE_PATH_STYLE');
			if (!['true', 'false'].includes(forcePathStyle))
				throw new Error('Invalid path style');
			this.client = new S3Client({
				endpoint: endpoint.origin,
				region: required('SUPPORT_S3_REGION'),
				forcePathStyle: forcePathStyle === 'true',
				credentials: {
					accessKeyId: required('SUPPORT_S3_ACCESS_KEY_ID'),
					secretAccessKey: required('SUPPORT_S3_SECRET_ACCESS_KEY')
				},
				maxAttempts: 3
			});
			return this.client;
		} catch {
			throw new ServiceUnavailableException(
				'Хранилище изображений не настроено'
			);
		}
	}
}
