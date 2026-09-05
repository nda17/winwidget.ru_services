import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { CustomersExportController } from './export.controller';
import { CustomersExportService } from './export.service';
import { EXPORT_EXPOSE_HEADERS, exportActorHash } from './export-format';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const body = Buffer.from(
	JSON.stringify({
		schemaVersion: 1,
		workspaceId,
		entity: 'contacts',
		snapshotAt: '2026-09-05T00:00:00.000Z',
		rowCount: 0,
		items: []
	})
);
describe('Customers export actual HTTP contract', () => {
	let app: NestExpressApplication;
	let origin: string;
	const prepare = jest.fn().mockResolvedValue({
		workspaceId,
		entity: 'contacts',
		format: 'json',
		snapshotAt: '2026-09-05T00:00:00.000Z',
		rowCount: 0,
		actorHash: exportActorHash('owner'),
		body
	});
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [CustomersExportController],
			providers: [
				{ provide: CustomersExportService, useValue: { prepare } }
			]
		}).compile();
		app = module.createNestApplication<NestExpressApplication>({
			logger: false
		});
		app.setGlobalPrefix('api/v1');
		app.useGlobalPipes(
			new ValidationPipe({
				transform: true,
				whitelist: true,
				forbidNonWhitelisted: true,
				validationError: { target: false, value: false }
			})
		);
		app.enableCors({
			origin: ['http://127.0.0.1:3001'],
			credentials: true,
			exposedHeaders: EXPORT_EXPOSE_HEADERS
		});
		await app.listen(0, '127.0.0.1');
		origin =
			'http://127.0.0.1:' +
			(app.getHttpServer().address() as AddressInfo).port;
	});
	afterAll(async () => {
		await app?.close();
	});
	const url = (
		entity = 'contacts',
		query = 'workspaceId=' + workspaceId + '&format=json'
	) => origin + '/api/v1/crm/customers/exports/' + entity + '?' + query;
	test('sends whole attachment with exact logical byte metadata and CORS exposure', async () => {
		const response = await fetch(url(), {
			headers: {
				authorization: 'Bearer user',
				origin: 'http://127.0.0.1:3001'
			}
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe(
			String(body.byteLength)
		);
		expect(response.headers.get('x-wincrm-export-bytes')).toBe(
			String(body.byteLength)
		);
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="wincrm-contacts.json"'
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(
			response.headers.get('access-control-expose-headers')
		).toContain('x-wincrm-export-actor-sha256');
		expect(
			response.headers.get('access-control-expose-headers')
		).toContain('x-content-type-options');
		expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
	});
	test.each([
		'workspaceId=' + workspaceId,
		'workspaceId=' + workspaceId + '&format=xml',
		'workspaceId=' + workspaceId + '&format=json&actor=secret',
		'workspaceId=bad&format=json'
	])('strict query rejected without echoing values', async query => {
		const response = await fetch(url('contacts', query), {
			headers: { authorization: 'Bearer user' }
		});
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain('secret');
	});
	test('unsupported entity and missing user session rejected', async () => {
		const invalid = await fetch(url('secrets'), {
			headers: { authorization: 'Bearer user' }
		});
		expect(invalid.status).toBe(400);
		await invalid.body?.cancel();
		const anonymous = await fetch(url());
		expect(anonymous.status).toBe(401);
		await anonymous.body?.cancel();
	});
});
