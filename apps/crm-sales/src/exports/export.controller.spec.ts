import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { SalesExportController } from './export.controller';
import { SalesExportService } from './export.service';
import { EXPORT_EXPOSE_HEADERS, exportActorHash } from './export-format';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const body = Buffer.from(
	JSON.stringify({
		schemaVersion: 1,
		workspaceId,
		entity: 'deals',
		snapshotAt: '2026-09-05T00:00:00.000Z',
		rowCount: 0,
		items: []
	})
);
describe('Sales export actual HTTP contract', () => {
	let app: NestExpressApplication;
	let origin: string;
	const prepare = jest.fn().mockResolvedValue({
		workspaceId,
		entity: 'deals',
		format: 'json',
		snapshotAt: '2026-09-05T00:00:00.000Z',
		rowCount: 0,
		actorHash: exportActorHash('owner'),
		body
	});
	const tasksBody = Buffer.from(
		JSON.stringify({
			schemaVersion: 2,
			workspaceId,
			entity: 'tasks',
			snapshotAt: '2026-09-05T00:00:00.000Z',
			rowCount: 0,
			items: []
		})
	);
	const prepareTasksV2 = jest
		.fn()
		.mockImplementation(async (_bearer, _workspace, format) => ({
			schemaVersion: 2,
			workspaceId,
			entity: 'tasks',
			format,
			snapshotAt: '2026-09-05T00:00:00.000Z',
			rowCount: 0,
			actorHash: exportActorHash('owner'),
			body:
				format === 'json'
					? tasksBody
					: Buffer.from('\uFEFF"id","workspaceId"\r\n')
		}));
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [SalesExportController],
			providers: [
				{
					provide: SalesExportService,
					useValue: { prepare, prepareTasksV2 }
				}
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
		entity = 'deals',
		query = 'workspaceId=' + workspaceId + '&format=json'
	) => origin + '/api/v1/crm/sales/exports/' + entity + '?' + query;
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
			'attachment; filename="wincrm-deals.json"'
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
		const response = await fetch(url('deals', query), {
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
	test.each(['json', 'csv'])(
		'serves v2 tasks with distinct %s headers and no v1 routing',
		async format => {
			const previous = prepare.mock.calls.length;
			const response = await fetch(
				url('v2/tasks', `workspaceId=${workspaceId}&format=${format}`),
				{
					headers: {
						authorization: 'Bearer user',
						origin: 'http://127.0.0.1:3001'
					}
				}
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('content-disposition')).toBe(
				`attachment; filename="wincrm-tasks-v2.${format}"`
			);
			expect(response.headers.get('x-wincrm-export-schema')).toBe('2');
			expect(response.headers.get('x-wincrm-export-entity')).toBe('tasks');
			expect(response.headers.get('x-wincrm-workspace-id')).toBe(
				workspaceId
			);
			expect(response.headers.get('x-wincrm-export-actor-sha256')).toBe(
				exportActorHash('owner')
			);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('x-content-type-options')).toBe(
				'nosniff'
			);
			expect(
				response.headers.get('access-control-expose-headers')
			).toContain('x-wincrm-export-schema');
			const bytes = Buffer.from(await response.arrayBuffer());
			expect(response.headers.get('x-wincrm-export-bytes')).toBe(
				String(bytes.byteLength)
			);
			if (format === 'json') expect(bytes).toEqual(tasksBody);
			expect(prepare.mock.calls.length).toBe(previous);
			expect(prepareTasksV2).toHaveBeenLastCalledWith(
				'Bearer user',
				workspaceId,
				format,
				expect.any(AbortSignal)
			);
		}
	);
	test('v2 rejects period/scope/status/body-binding overrides, invalid route and anonymous sessions', async () => {
		const before = prepareTasksV2.mock.calls.length;
		for (const suffix of [
			'&period=TODAY',
			'&scope=ALL',
			'&status=OPEN',
			'&actor=secret',
			'&teamId=bad'
		]) {
			const response = await fetch(
				url('v2/tasks', `workspaceId=${workspaceId}&format=json${suffix}`),
				{ headers: { authorization: 'Bearer user' } }
			);
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain('secret');
		}
		const anonymous = await fetch(url('v2/tasks'));
		expect(anonymous.status).toBe(401);
		await anonymous.body?.cancel();
		const other = await fetch(url('v2/deals'), {
			headers: { authorization: 'Bearer user' }
		});
		expect(other.status).toBe(404);
		await other.body?.cancel();
		expect(prepareTasksV2.mock.calls.length).toBe(before);
	});
});
