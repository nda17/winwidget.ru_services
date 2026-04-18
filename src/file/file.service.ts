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

@Injectable()
export class FileService {
	private s3Client: S3Client | null = null;

	async saveFiles(
		files: Express.Multer.File[],
		folder: string = 'default'
	): Promise<IFileResponse[]> {
		const safeFolder = this.normalizeFolder(folder);
		if (this.isS3Storage()) {
			return Promise.all(
				files.map(file => this.saveFileToS3(file, safeFolder))
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

	async deleteFile(filePath: string): Promise<void> {
		if (this.isS3Storage()) {
			await this.deleteFileFromS3(filePath);
		} else {
			await this.deleteFileFromDisk(filePath);
		}
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
		folder: string
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
				ContentType: file.mimetype || 'application/octet-stream'
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
