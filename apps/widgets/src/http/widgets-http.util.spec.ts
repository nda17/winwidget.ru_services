import { BadRequestException } from '@nestjs/common';
import { transformWidgetUploadException } from './widgets-http.util';

describe('Widgets HTTP upload utilities', () => {
	it('maps Multer field nesting limit errors to HTTP 400', () => {
		const error = Object.assign(new Error('Field name nesting too deep'), {
			code: 'LIMIT_FIELD_NESTING'
		});

		const transformed = transformWidgetUploadException(error);

		expect(transformed).toBeInstanceOf(BadRequestException);
		expect((transformed as BadRequestException).getStatus()).toBe(400);
	});

	it('does not hide unrelated upload errors', () => {
		const error = new Error('Unexpected upload failure');

		expect(transformWidgetUploadException(error)).toBe(error);
	});
});
