import { IFileResponse } from '@/file/file.interface';
import {
	DeleteObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { BadRequestException, Injectable } from '@nestjs/common';
import { path } from 'app-root-path';
import { ensureDir, remove, writeFile } from 'fs-extra';
import { extname, join } from 'path';
import { inflateSync } from 'zlib';

export const WIDGET_BUTTON_IMAGE_MAX_DIMENSION = 320;
export const WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES = 200 * 1024;

interface ISaveFilesOptions {
	cacheControl?: string;
}

interface IPngInfo {
	width: number;
	height: number;
	bitDepth: number;
	colorType: number;
	hasTransparentPixel: boolean;
}

@Injectable()
export class FileService {
	private s3Client: S3Client | null = null;

	async saveFiles(
		files: Express.Multer.File[],
		folder: string = 'default',
		options: ISaveFilesOptions = {}
	): Promise<IFileResponse[]> {
		const safeFolder = this.normalizeFolder(folder);
		if (this.isS3Storage()) {
			return Promise.all(
				files.map(file => this.saveFileToS3(file, safeFolder, options))
			);
		}

		const uploadFolder = join(path, 'uploads', safeFolder);
		await ensureDir(uploadFolder);

		const res: IFileResponse[] = await Promise.all(
			files.map(async file => {
				const decodedOriginalName = this.decodeOriginalName(
					file.originalname
				);
				const safeFileName = this.createSafeFileName(
					decodedOriginalName,
					file.originalname
				);

				await writeFile(join(uploadFolder, safeFileName), file.buffer);

				return {
					url: `/uploads/${safeFolder}/${safeFileName}`,
					name: decodedOriginalName
				};
			})
		);

		return res;
	}

	async saveWidgetButtonImage(
		file: Express.Multer.File | undefined,
		widgetType: string,
		widgetId: string
	): Promise<IFileResponse> {
		this.validateWidgetButtonImage(file);

		const [savedFile] = await this.saveFiles(
			[file],
			`widget-buttons/${widgetType}/${widgetId}`,
			{ cacheControl: 'public, max-age=31536000, immutable' }
		);

		return savedFile;
	}

	async deleteFile(filePath: string): Promise<void> {
		if (this.isS3Storage()) {
			await this.deleteFileFromS3(filePath);
		} else {
			await this.deleteFileFromDisk(filePath);
		}
	}

	async deleteWidgetButtonImage(filePath?: string | null): Promise<void> {
		if (!this.isManagedWidgetButtonImage(filePath)) return;
		await this.deleteFile(filePath);
	}

	getWidgetButtonImageUrl(
		filePath: unknown,
		isHardPlanAllowed: boolean
	): string {
		if (!isHardPlanAllowed || !this.isManagedWidgetButtonImage(filePath)) {
			return '';
		}

		return filePath.trim();
	}

	private validateWidgetButtonImage(
		file: Express.Multer.File | undefined
	): asserts file is Express.Multer.File {
		if (!file) {
			throw new BadRequestException('Файл не передан');
		}

		if (file.size > WIDGET_BUTTON_IMAGE_MAX_SIZE_BYTES) {
			throw new BadRequestException(
				'Картинка кнопки должна быть не больше 200 КБ'
			);
		}

		const originalName = this.decodeOriginalName(file.originalname);
		if (
			file.mimetype !== 'image/png' ||
			extname(originalName).toLowerCase() !== '.png'
		) {
			throw new BadRequestException(
				'Картинка кнопки должна быть в формате PNG'
			);
		}

		let png: IPngInfo;
		try {
			png = this.readPngInfo(file.buffer);
		} catch (error) {
			if (error instanceof BadRequestException) throw error;
			throw new BadRequestException(
				'Картинка кнопки должна быть валидным PNG'
			);
		}
		if (
			png.width > WIDGET_BUTTON_IMAGE_MAX_DIMENSION ||
			png.height > WIDGET_BUTTON_IMAGE_MAX_DIMENSION
		) {
			throw new BadRequestException(
				'Размер картинки кнопки должен быть не больше 320x320 px'
			);
		}

		if (png.bitDepth !== 8) {
			throw new BadRequestException(
				'Картинка кнопки должна быть 8-битным PNG'
			);
		}

		if (!png.hasTransparentPixel) {
			throw new BadRequestException(
				'Фон картинки кнопки должен быть прозрачным'
			);
		}
	}

	private readPngInfo(buffer: Buffer): IPngInfo {
		const signature = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
		]);

		if (
			buffer.length < signature.length ||
			!buffer.subarray(0, 8).equals(signature)
		) {
			throw new BadRequestException(
				'Картинка кнопки должна быть валидным PNG'
			);
		}

		let offset = 8;
		let width = 0;
		let height = 0;
		let bitDepth = 0;
		let colorType = 0;
		let transparencyChunk: Buffer | null = null;
		const idatChunks: Buffer[] = [];

		while (offset + 8 <= buffer.length) {
			const length = buffer.readUInt32BE(offset);
			const type = buffer.toString('ascii', offset + 4, offset + 8);
			const dataStart = offset + 8;
			const dataEnd = dataStart + length;

			if (dataEnd + 4 > buffer.length) {
				throw new BadRequestException(
					'Картинка кнопки должна быть валидным PNG'
				);
			}

			const data = buffer.subarray(dataStart, dataEnd);

			if (type === 'IHDR') {
				width = data.readUInt32BE(0);
				height = data.readUInt32BE(4);
				bitDepth = data[8];
				colorType = data[9];
			}

			if (type === 'IDAT') {
				idatChunks.push(data);
			}

			if (type === 'tRNS') {
				transparencyChunk = data;
			}

			offset = dataEnd + 4;

			if (type === 'IEND') break;
		}

		if (!width || !height || !idatChunks.length) {
			throw new BadRequestException(
				'Картинка кнопки должна быть валидным PNG'
			);
		}

		return {
			width,
			height,
			bitDepth,
			colorType,
			hasTransparentPixel: this.hasTransparentPngPixel(
				Buffer.concat(idatChunks),
				width,
				height,
				bitDepth,
				colorType,
				transparencyChunk
			)
		};
	}

	private hasTransparentPngPixel(
		compressedData: Buffer,
		width: number,
		height: number,
		bitDepth: number,
		colorType: number,
		transparencyChunk: Buffer | null
	): boolean {
		if (bitDepth !== 8) return false;

		const channelsByColorType: Record<number, number> = {
			0: 1,
			2: 3,
			3: 1,
			4: 2,
			6: 4
		};
		const channels = channelsByColorType[colorType];

		if (!channels) {
			throw new BadRequestException(
				'PNG должен быть сохранён в поддерживаемом цветовом режиме'
			);
		}

		if (![3, 4, 6].includes(colorType) && !transparencyChunk) {
			return false;
		}

		const raw = inflateSync(compressedData);
		const rowLength = width * channels;
		let rawOffset = 0;
		let previousRow = Buffer.alloc(rowLength);

		for (let y = 0; y < height; y++) {
			if (rawOffset + rowLength + 1 > raw.length) {
				throw new BadRequestException(
					'Картинка кнопки должна быть валидным PNG'
				);
			}

			const filterType = raw[rawOffset++];
			const filteredRow = raw.subarray(rawOffset, rawOffset + rowLength);
			const row = this.unfilterPngRow(
				filteredRow,
				previousRow,
				filterType,
				channels
			);
			rawOffset += rowLength;

			if (this.rowHasTransparentPixel(row, colorType, transparencyChunk)) {
				return true;
			}

			previousRow = row;
		}

		return false;
	}

	private unfilterPngRow(
		filteredRow: Buffer,
		previousRow: Buffer,
		filterType: number,
		bytesPerPixel: number
	) {
		const row = Buffer.alloc(filteredRow.length);

		for (let index = 0; index < filteredRow.length; index++) {
			const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
			const up = previousRow[index] || 0;
			const upLeft =
				index >= bytesPerPixel
					? previousRow[index - bytesPerPixel] || 0
					: 0;

			switch (filterType) {
				case 0:
					row[index] = filteredRow[index];
					break;
				case 1:
					row[index] = (filteredRow[index] + left) & 0xff;
					break;
				case 2:
					row[index] = (filteredRow[index] + up) & 0xff;
					break;
				case 3:
					row[index] =
						(filteredRow[index] + Math.floor((left + up) / 2)) & 0xff;
					break;
				case 4:
					row[index] =
						(filteredRow[index] + this.paethPredictor(left, up, upLeft)) &
						0xff;
					break;
				default:
					throw new BadRequestException(
						'Картинка кнопки должна быть валидным PNG'
					);
			}
		}

		return row;
	}

	private rowHasTransparentPixel(
		row: Buffer,
		colorType: number,
		transparencyChunk: Buffer | null
	) {
		if (colorType === 6) {
			for (let index = 3; index < row.length; index += 4) {
				if (row[index] < 255) return true;
			}
			return false;
		}

		if (colorType === 4) {
			for (let index = 1; index < row.length; index += 2) {
				if (row[index] < 255) return true;
			}
			return false;
		}

		if (colorType === 3 && transparencyChunk) {
			for (const paletteIndex of row) {
				const alpha = transparencyChunk[paletteIndex] ?? 255;
				if (alpha < 255) return true;
			}
			return false;
		}

		if (colorType === 2 && transparencyChunk?.length >= 6) {
			const transparentRed = transparencyChunk.readUInt16BE(0);
			const transparentGreen = transparencyChunk.readUInt16BE(2);
			const transparentBlue = transparencyChunk.readUInt16BE(4);

			for (let index = 0; index < row.length; index += 3) {
				if (
					row[index] === transparentRed &&
					row[index + 1] === transparentGreen &&
					row[index + 2] === transparentBlue
				) {
					return true;
				}
			}
		}

		if (colorType === 0 && transparencyChunk?.length >= 2) {
			const transparentGray = transparencyChunk.readUInt16BE(0);
			for (const value of row) {
				if (value === transparentGray) return true;
			}
		}

		return false;
	}

	private paethPredictor(left: number, up: number, upLeft: number) {
		const estimate = left + up - upLeft;
		const distanceLeft = Math.abs(estimate - left);
		const distanceUp = Math.abs(estimate - up);
		const distanceUpLeft = Math.abs(estimate - upLeft);

		if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) {
			return left;
		}

		if (distanceUp <= distanceUpLeft) return up;

		return upLeft;
	}

	private isManagedWidgetButtonImage(
		filePath: unknown
	): filePath is string {
		return (
			typeof filePath === 'string' &&
			filePath.trim().length > 0 &&
			filePath.includes('/widget-buttons/')
		);
	}

	private async deleteFileFromDisk(filePath: string): Promise<void> {
		const relative = filePath.startsWith('/')
			? filePath.slice(1)
			: filePath;
		const absolute = join(path, relative);
		const uploadsDir = join(path, 'uploads');
		if (!absolute.startsWith(uploadsDir + '/')) {
			throw new BadRequestException('Invalid file path');
		}
		await remove(absolute);
	}

	private async deleteFileFromS3(filePath: string): Promise<void> {
		const publicBase = this.buildPublicS3Url('').replace(/\/$/, '');
		let key: string;
		if (filePath.startsWith(publicBase + '/')) {
			key = filePath
				.slice(publicBase.length + 1)
				.split('/')
				.map(decodeURIComponent)
				.join('/');
		} else {
			key = filePath;
		}
		await this.getS3Client().send(
			new DeleteObjectCommand({
				Bucket: this.getRequiredEnv('S3_BUCKET'),
				Key: key
			})
		);
	}

	private async saveFileToS3(
		file: Express.Multer.File,
		folder: string,
		options: ISaveFilesOptions = {}
	): Promise<IFileResponse> {
		const decodedOriginalName = this.decodeOriginalName(file.originalname);
		const safeFileName = this.createSafeFileName(
			decodedOriginalName,
			file.originalname
		);
		const keyPrefix = this.normalizeFolder(
			process.env.S3_KEY_PREFIX || ''
		);
		const key = [keyPrefix, folder, safeFileName]
			.filter(Boolean)
			.join('/');

		await this.getS3Client().send(
			new PutObjectCommand({
				Bucket: this.getRequiredEnv('S3_BUCKET'),
				Key: key,
				Body: file.buffer,
				ContentType: file.mimetype || 'application/octet-stream',
				...(options.cacheControl && {
					CacheControl: options.cacheControl
				})
			})
		);

		return {
			url: this.buildPublicS3Url(key),
			name: decodedOriginalName
		};
	}

	private getS3Client() {
		if (this.s3Client) return this.s3Client;

		this.s3Client = new S3Client({
			endpoint: process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru',
			region: process.env.S3_REGION || 'ru-1',
			forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
			credentials: {
				accessKeyId: this.getRequiredEnv('S3_ACCESS_KEY_ID'),
				secretAccessKey: this.getRequiredEnv('S3_SECRET_ACCESS_KEY')
			}
		});

		return this.s3Client;
	}

	private buildPublicS3Url(key: string) {
		const publicBaseUrl =
			process.env.S3_PUBLIC_BASE_URL ||
			`${this.trimTrailingSlash(
				process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru'
			)}/${this.getRequiredEnv('S3_BUCKET')}`;

		return `${this.trimTrailingSlash(publicBaseUrl)}/${this.encodeS3Key(key)}`;
	}

	private isS3Storage() {
		return process.env.MODE?.trim().toLowerCase() === 'production';
	}

	private decodeOriginalName(originalName: string) {
		return Buffer.from(originalName, 'latin1').toString('utf8');
	}

	private createSafeFileName(
		decodedOriginalName: string,
		originalName: string
	) {
		const fileExtension =
			extname(decodedOriginalName) || extname(originalName);

		return `${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 10)}${fileExtension.toLowerCase()}`;
	}

	private normalizeFolder(folder: string) {
		return folder
			.split('/')
			.map(part => part.trim())
			.filter(Boolean)
			.map(part => part.replace(/[^a-zA-Z0-9._-]/g, '-'))
			.filter(part => part !== '.' && part !== '..')
			.join('/');
	}

	private encodeS3Key(key: string) {
		return key.split('/').map(encodeURIComponent).join('/');
	}

	private trimTrailingSlash(value: string) {
		return value.replace(/\/+$/, '');
	}

	private getRequiredEnv(name: string) {
		const value = process.env[name];
		if (!value) {
			throw new Error(`${name} is required`);
		}
		return value;
	}
}
