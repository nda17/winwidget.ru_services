import {
	BadRequestException,
	CallHandler,
	ExecutionContext,
	NestInterceptor,
	Type
} from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { Readable } from 'node:stream';
import { lastValueFrom, of } from 'rxjs';
import { DATABASE_RESTORE_UPLOAD_LIMITS } from './database-restore.contract';
import {
	DatabaseRestoreController,
	transformDatabaseRestoreUploadException
} from './database-restore.controller';

type MultipartPart = {
	name: string;
	value: Buffer;
	filename?: string;
	contentType?: string;
};

const multipartBody = (boundary: string, parts: MultipartPart[]): Buffer =>
	Buffer.concat([
		...parts.flatMap(part => {
			const disposition = part.filename
				? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
				: `Content-Disposition: form-data; name="${part.name}"\r\n`;
			const contentType = part.contentType
				? `Content-Type: ${part.contentType}\r\n`
				: '';
			return [
				Buffer.from(`--${boundary}\r\n${disposition}${contentType}\r\n`),
				part.value,
				Buffer.from('\r\n')
			];
		}),
		Buffer.from(`--${boundary}--\r\n`)
	]);

const field = (name: string, value: string): MultipartPart => ({
	name,
	value: Buffer.from(value)
});

const file = (): MultipartPart => ({
	name: 'file',
	filename: 'operations.dump',
	contentType: 'application/octet-stream',
	value: Buffer.from('PGDMP')
});

const parseMultipart = async (parts: MultipartPart[]) => {
	const boundary = 'operations-restore-test-boundary';
	const body = multipartBody(boundary, parts);
	const request = Object.assign(Readable.from(body), {
		headers: {
			'content-type': `multipart/form-data; boundary=${boundary}`,
			'content-length': String(body.length)
		},
		method: 'POST'
	});
	const context = {
		switchToHttp: () => ({
			getRequest: () => request,
			getResponse: () => ({})
		})
	} as unknown as ExecutionContext;
	const next = {
		handle: jest.fn(() => of('handled'))
	} as CallHandler;
	const [Interceptor] = Reflect.getMetadata(
		INTERCEPTORS_METADATA,
		DatabaseRestoreController.prototype.enqueue
	) as Type<NestInterceptor>[];
	const interceptor = new Interceptor();
	const result = await lastValueFrom(
		await interceptor.intercept(context, next)
	);
	return { next, request, result };
};

describe('Database restore upload contract', () => {
	it('accepts the documented restore multipart shape', async () => {
		const parsed = await parseMultipart([
			field('confirmation', 'ВОССТАНОВИТЬ OPERATIONS'),
			field('requestId', '123e4567-e89b-42d3-a456-426614174000'),
			file()
		]);

		expect(parsed.result).toBe('handled');
		expect(parsed.next.handle).toHaveBeenCalledTimes(1);
		expect(parsed.request).toMatchObject({
			body: {
				confirmation: 'ВОССТАНОВИТЬ OPERATIONS',
				requestId: '123e4567-e89b-42d3-a456-426614174000'
			},
			file: {
				originalname: 'operations.dump',
				size: 5
			}
		});
	});

	it('rejects multipart requests that exceed the field/part limits', async () => {
		await expect(
			parseMultipart([
				field('confirmation', 'ВОССТАНОВИТЬ OPERATIONS'),
				field('requestId', '123e4567-e89b-42d3-a456-426614174000'),
				field('extra', 'unexpected'),
				file()
			])
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it('rejects nested multipart fields with HTTP 400', async () => {
		await expect(
			parseMultipart([
				field('confirmation', 'ВОССТАНОВИТЬ OPERATIONS'),
				field('requestId[nested]', '123e4567-e89b-42d3-a456-426614174000'),
				file()
			])
		).rejects.toMatchObject({ status: 400 });
	});

	it('keeps every multipart resource limit finite', () => {
		expect(DATABASE_RESTORE_UPLOAD_LIMITS).toEqual({
			fieldNameSize: 64,
			fieldSize: 1024,
			fields: 2,
			fileSize: 49 * 1024 * 1024,
			files: 1,
			parts: 4,
			fieldNestingDepth: 0
		});
	});

	it('maps Multer field nesting errors to HTTP 400', () => {
		const error = Object.assign(new Error('Field name nesting too deep'), {
			code: 'LIMIT_FIELD_NESTING'
		});

		const transformed = transformDatabaseRestoreUploadException(error);

		expect(transformed).toBeInstanceOf(BadRequestException);
		expect((transformed as BadRequestException).getStatus()).toBe(400);
	});

	it('does not hide unrelated upload errors', () => {
		const error = new Error('Unexpected upload failure');

		expect(transformDatabaseRestoreUploadException(error)).toBe(error);
	});
});
