import {
	BadRequestException,
	type INestApplication
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
	WidgetsApiGuard,
	WidgetsAuthGuard
} from '../auth/widgets-auth.guard';
import { WidgetsDeliveryFailuresController } from '../delivery-failures/widgets-delivery-failures.controller';
import { WidgetsDeliveryFailuresService } from '../delivery-failures/widgets-delivery-failures.service';
import {
	transformWidgetUploadException,
	WIDGETS_SCALAR_QUERY_PIPE
} from './widgets-http.util';

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

	it('accepts one scalar query value and rejects arrays or objects', () => {
		expect(WIDGETS_SCALAR_QUERY_PIPE.transform('value', {} as never)).toBe(
			'value'
		);
		expect(
			WIDGETS_SCALAR_QUERY_PIPE.transform(undefined, {} as never)
		).toBeUndefined();
		for (const value of [['first', 'second'], { nested: 'value' }]) {
			expect(() =>
				WIDGETS_SCALAR_QUERY_PIPE.transform(value, {} as never)
			).toThrow(BadRequestException);
		}
	});
});

describe('Widgets scalar query HTTP contract', () => {
	let app: INestApplication;
	let baseUrl: string;
	const failures = {
		list: jest.fn().mockResolvedValue({ items: [] })
	};

	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [WidgetsDeliveryFailuresController],
			providers: [
				{ provide: WidgetsDeliveryFailuresService, useValue: failures }
			]
		})
			.overrideGuard(WidgetsApiGuard)
			.useValue({ canActivate: () => true })
			.overrideGuard(WidgetsAuthGuard)
			.useValue({ canActivate: () => true })
			.compile();
		app = module.createNestApplication();
		await app.listen(0, '127.0.0.1');
		baseUrl = await app.getUrl();
	});

	afterAll(() => app.close());

	beforeEach(() => jest.clearAllMocks());

	it('rejects repeated filters before calling the service', async () => {
		const response = await fetch(
			`${baseUrl}/widgets/admin/delivery-failures?integration=EMAIL&integration=TELEGRAM`
		);
		expect(response.status).toBe(400);
		expect(failures.list).not.toHaveBeenCalled();
	});

	it('passes scalar filters to the service', async () => {
		const response = await fetch(
			`${baseUrl}/widgets/admin/delivery-failures?integration=EMAIL`
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ items: [] });
		expect(failures.list).toHaveBeenCalledWith(1, 20, {
			category: undefined,
			integration: 'EMAIL',
			status: undefined
		});
	});
});
