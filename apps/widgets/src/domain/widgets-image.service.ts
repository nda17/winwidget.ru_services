import {
	DeleteObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export const WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES = 200 * 1024;
const MAX_DIMENSION = 320;

@Injectable()
export class WidgetsImageService {
	private s3: S3Client | null = null;

	constructor(private readonly config: ConfigService) {}

	async save(
		file: Express.Multer.File | undefined,
		widgetType: string,
		widgetId: string
	): Promise<string> {
		this.validate(file);
		const name = `${Date.now()}-${randomBytes(6).toString('hex')}.png`;
		const key = [
			this.config
				.get<string>('S3_KEY_PREFIX')
				?.trim()
				.replace(/^\/+|\/+$/g, ''),
			'widget-buttons',
			widgetType,
			widgetId,
			name
		]
			.filter(Boolean)
			.join('/');
		if (this.productionStorage) {
			await this.s3Client.send(
				new PutObjectCommand({
					Bucket: this.required('S3_BUCKET'),
					Key: key,
					Body: file.buffer,
					ContentType: 'image/png',
					CacheControl: 'public, max-age=31536000, immutable'
				})
			);
			return `${this.publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;
		}
		const root = resolve(
			this.config.get<string>('WIDGETS_UPLOADS_DIR') || 'uploads'
		);
		const folder = join(root, 'widget-buttons', widgetType, widgetId);
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, name), file.buffer, { flag: 'wx' });
		return `/uploads/widget-buttons/${widgetType}/${widgetId}/${name}`;
	}

	async delete(url: unknown): Promise<void> {
		if (typeof url !== 'string' || !url.includes('/widget-buttons/'))
			return;
		if (this.productionStorage) {
			const base = this.publicBase;
			if (!url.startsWith(`${base}/`)) return;
			const key = url
				.slice(base.length + 1)
				.split('/')
				.map(decodeURIComponent)
				.join('/');
			await this.s3Client.send(
				new DeleteObjectCommand({
					Bucket: this.required('S3_BUCKET'),
					Key: key
				})
			);
			return;
		}
		const root = resolve(
			this.config.get<string>('WIDGETS_UPLOADS_DIR') || 'uploads'
		);
		const relative = url.replace(/^\/uploads\//, '').replace(/^\/+/, '');
		const absolute = resolve(root, relative);
		if (!absolute.startsWith(`${root}/`)) return;
		await unlink(absolute).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		});
	}

	isManaged(url: unknown): url is string {
		return typeof url === 'string' && url.includes('/widget-buttons/');
	}

	private validate(
		file: Express.Multer.File | undefined
	): asserts file is Express.Multer.File {
		if (!file) throw new BadRequestException('Файл не передан');
		if (file.size > WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES) {
			throw new BadRequestException(
				'Картинка кнопки должна быть не больше 200 КБ'
			);
		}
		if (
			file.mimetype !== 'image/png' ||
			extname(file.originalname).toLowerCase() !== '.png'
		) {
			throw new BadRequestException(
				'Картинка кнопки должна быть в формате PNG'
			);
		}
		const signature = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
		]);
		if (
			file.buffer.length < 33 ||
			!file.buffer.subarray(0, 8).equals(signature) ||
			file.buffer.toString('ascii', 12, 16) !== 'IHDR'
		) {
			throw new BadRequestException(
				'Картинка кнопки должна быть валидным PNG'
			);
		}
		const png = this.pngInfo(file.buffer);
		const { width, height, bitDepth } = png;
		if (
			!width ||
			!height ||
			width > MAX_DIMENSION ||
			height > MAX_DIMENSION
		) {
			throw new BadRequestException(
				'Размер картинки кнопки должен быть не больше 320x320 px'
			);
		}
		if (bitDepth !== 8)
			throw new BadRequestException(
				'Картинка кнопки должна быть 8-битным PNG'
			);
		if (!png.hasTransparentPixel) {
			throw new BadRequestException(
				'Фон картинки кнопки должен быть прозрачным'
			);
		}
	}

	private pngInfo(buffer: Buffer) {
		let offset = 8;
		let width = 0;
		let height = 0;
		let bitDepth = 0;
		let colorType = 0;
		let transparency: Buffer | null = null;
		const idat: Buffer[] = [];
		while (offset + 8 <= buffer.length) {
			const length = buffer.readUInt32BE(offset);
			const type = buffer.toString('ascii', offset + 4, offset + 8);
			const start = offset + 8;
			const end = start + length;
			if (end + 4 > buffer.length)
				throw new BadRequestException(
					'Картинка кнопки должна быть валидным PNG'
				);
			const data = buffer.subarray(start, end);
			if (type === 'IHDR') {
				width = data.readUInt32BE(0);
				height = data.readUInt32BE(4);
				bitDepth = data[8];
				colorType = data[9];
			} else if (type === 'IDAT') idat.push(data);
			else if (type === 'tRNS') transparency = data;
			offset = end + 4;
			if (type === 'IEND') break;
		}
		if (!width || !height || !idat.length)
			throw new BadRequestException(
				'Картинка кнопки должна быть валидным PNG'
			);
		return {
			width,
			height,
			bitDepth,
			hasTransparentPixel: this.hasTransparent(
				Buffer.concat(idat),
				width,
				height,
				bitDepth,
				colorType,
				transparency
			)
		};
	}

	private hasTransparent(
		compressed: Buffer,
		width: number,
		height: number,
		bitDepth: number,
		colorType: number,
		transparency: Buffer | null
	): boolean {
		if (bitDepth !== 8) return false;
		const channels = (
			{ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>
		)[colorType];
		if (
			!channels ||
			(![3, 4, 6].includes(colorType) && !transparency) ||
			(colorType === 3 && !transparency)
		)
			return false;
		const rowLength = width * channels;
		const expectedLength = (rowLength + 1) * height;
		let raw: Buffer;
		try {
			raw = inflateSync(compressed, { maxOutputLength: expectedLength });
		} catch {
			throw new BadRequestException(
				'Картинка кнопки должна быть валидным PNG'
			);
		}
		if (raw.length !== expectedLength) {
			throw new BadRequestException(
				'Картинка кнопки должна быть валидным PNG'
			);
		}
		let offset = 0;
		let previous: Buffer<ArrayBufferLike> = Buffer.alloc(rowLength);
		for (let y = 0; y < height; y += 1) {
			if (offset + rowLength + 1 > raw.length)
				throw new BadRequestException(
					'Картинка кнопки должна быть валидным PNG'
				);
			const filter = raw[offset++];
			const row = this.unfilter(
				raw.subarray(offset, offset + rowLength),
				previous,
				filter,
				channels
			);
			offset += rowLength;
			if (
				colorType === 6 &&
				row.some((value, index) => index % 4 === 3 && value < 255)
			)
				return true;
			if (
				colorType === 4 &&
				row.some((value, index) => index % 2 === 1 && value < 255)
			)
				return true;
			if (
				colorType === 3 &&
				transparency &&
				row.some(value => (transparency?.[value] ?? 255) < 255)
			)
				return true;
			if (
				colorType === 2 &&
				transparency?.length &&
				row.some(
					(_value, index) =>
						index % 3 === 0 &&
						row[index] === transparency.readUInt16BE(0) &&
						row[index + 1] === transparency.readUInt16BE(2) &&
						row[index + 2] === transparency.readUInt16BE(4)
				)
			)
				return true;
			if (
				colorType === 0 &&
				transparency?.length &&
				row.some(value => value === transparency.readUInt16BE(0))
			)
				return true;
			previous = row;
		}
		return false;
	}

	private unfilter(
		filtered: Buffer,
		previous: Buffer,
		filter: number,
		bytesPerPixel: number
	): Buffer {
		const row = Buffer.alloc(filtered.length);
		for (let index = 0; index < filtered.length; index += 1) {
			const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
			const up = previous[index] || 0;
			const upLeft =
				index >= bytesPerPixel ? previous[index - bytesPerPixel] || 0 : 0;
			if (filter === 0) row[index] = filtered[index];
			else if (filter === 1) row[index] = (filtered[index] + left) & 0xff;
			else if (filter === 2) row[index] = (filtered[index] + up) & 0xff;
			else if (filter === 3)
				row[index] =
					(filtered[index] + Math.floor((left + up) / 2)) & 0xff;
			else if (filter === 4)
				row[index] =
					(filtered[index] + this.paeth(left, up, upLeft)) & 0xff;
			else
				throw new BadRequestException(
					'Картинка кнопки должна быть валидным PNG'
				);
		}
		return row;
	}

	private paeth(left: number, up: number, upLeft: number): number {
		const estimate = left + up - upLeft;
		const dl = Math.abs(estimate - left);
		const du = Math.abs(estimate - up);
		const dul = Math.abs(estimate - upLeft);
		return dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
	}

	private get productionStorage(): boolean {
		return (
			this.config.get<string>('MODE')?.trim().toLowerCase() ===
			'production'
		);
	}

	private get s3Client(): S3Client {
		if (!this.s3) {
			this.s3 = new S3Client({
				endpoint:
					this.config.get<string>('S3_ENDPOINT') ||
					'https://s3.twcstorage.ru',
				region: this.config.get<string>('S3_REGION') || 'ru-1',
				forcePathStyle:
					this.config.get<string>('S3_FORCE_PATH_STYLE') !== 'false',
				credentials: {
					accessKeyId: this.required('S3_ACCESS_KEY_ID'),
					secretAccessKey: this.required('S3_SECRET_ACCESS_KEY')
				}
			});
		}
		return this.s3;
	}

	private get publicBase(): string {
		return (
			this.config.get<string>('S3_PUBLIC_BASE_URL') ||
			`${this.config.get<string>('S3_ENDPOINT') || 'https://s3.twcstorage.ru'}/${this.required('S3_BUCKET')}`
		).replace(/\/+$/, '');
	}

	private required(name: string): string {
		const value = this.config.get<string>(name)?.trim();
		if (!value) throw new Error(`${name} is required`);
		return value;
	}
}
