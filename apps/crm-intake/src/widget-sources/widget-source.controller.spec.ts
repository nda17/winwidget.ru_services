import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WidgetSourceController } from './widget-source.controller';
import { WidgetSourceService } from './widget-source.service';
const workspaceId = randomUUID(),
	commandId = randomUUID(),
	sourceId = randomUUID();
describe('Managed source actual HTTP contract', () => {
	let app: NestExpressApplication;
	let origin: string;
	const sources = {
		create: jest.fn().mockResolvedValue({
			schemaVersion: 1,
			command: { id: commandId, state: 'QUEUED' }
		}),
		configure: jest.fn().mockResolvedValue({ schemaVersion: 1 }),
		retry: jest.fn().mockResolvedValue({ schemaVersion: 1 }),
		list: jest.fn().mockResolvedValue({
			schemaVersion: 1,
			items: [],
			page: 1,
			pageSize: 25,
			total: 0
		}),
		get: jest.fn().mockResolvedValue({ schemaVersion: 1 }),
		candidates: jest
			.fn()
			.mockResolvedValue({ schemaVersion: 1, items: [] })
	};
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [WidgetSourceController],
			providers: [{ provide: WidgetSourceService, useValue: sources }]
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
		await app.listen(0, '127.0.0.1');
		origin =
			'http://127.0.0.1:' +
			(app.getHttpServer().address() as AddressInfo).port;
	});
	afterAll(async () => {
		await app.close();
	});
	beforeEach(() => jest.clearAllMocks());
	const create = () => ({
		schemaVersion: 1,
		workspaceId,
		commandId,
		name: 'Опрос',
		widgetType: 'QUIZ',
		widgetId: 'opaque-widget',
		teamId: null
	});
	const send = (body: unknown, path = '', key = commandId) =>
		fetch(origin + '/api/v1/crm/intake/widget-sources' + path, {
			method: 'POST',
			headers: {
				authorization: 'Bearer user',
				'content-type': 'application/json',
				'idempotency-key': key
			},
			body: JSON.stringify(body)
		});
	test('creates only a queued202 command, never claims synchronized immediately', async () => {
		const response = await send(create());
		expect(response.status).toBe(202);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			command: { id: commandId, state: 'QUEUED' }
		});
		expect(sources.create).toHaveBeenCalledWith('Bearer user', create());
	});
	test.each([
		{ ownerSubject: 'private-owner' },
		{ actorSubject: 'private-actor' },
		{ connectorId: randomUUID() },
		{ widgetType: 'AI_CONSULTANT' },
		{ teamId: undefined },
		{ name: '\u0000private-value' }
	])(
		'strict DTO refuses owner/delegate/connector override and malformed text %p',
		async change => {
			const response = await send({ ...create(), ...change });
			expect(response.status).toBe(400);
			expect(await response.text()).not.toMatch(
				/private-(?:owner|actor|value)/
			);
			expect(sources.create).not.toHaveBeenCalled();
		}
	);
	test('requires exact Idempotency-Key', async () => {
		const response = await send(create(), '', randomUUID());
		expect(response.status).toBe(400);
		await response.body?.cancel();
		expect(sources.create).not.toHaveBeenCalled();
	});
	test('configure is versioned and only toggles enabled', async () => {
		const dto = {
			schemaVersion: 1,
			workspaceId,
			commandId,
			expectedVersion: 1,
			enabled: false
		};
		const response = await send(dto, '/' + sourceId + '/configure');
		expect(response.status).toBe(202);
		await response.body?.cancel();
		expect(sources.configure).toHaveBeenCalledWith(
			'Bearer user',
			sourceId,
			dto
		);
		const invalid = await send(
			{ ...dto, ownerSubject: 'private-owner' },
			'/' + sourceId + '/configure'
		);
		expect(invalid.status).toBe(400);
		expect(await invalid.text()).not.toContain('private-owner');
	});
	test('server pagination parses numbers, rejects overrides, and resolves candidates before :id', async () => {
		const valid = await fetch(
			origin +
				'/api/v1/crm/intake/widget-sources/candidates?workspaceId=' +
				workspaceId +
				'&page=2&pageSize=10'
		);
		expect(valid.status).toBe(200);
		await valid.body?.cancel();
		expect(sources.candidates).toHaveBeenCalledWith(undefined, {
			workspaceId,
			page: 2,
			pageSize: 10
		});
		const bad = await fetch(
			origin +
				'/api/v1/crm/intake/widget-sources?workspaceId=' +
				workspaceId +
				'&ownerSubject=private-owner'
		);
		expect(bad.status).toBe(400);
		expect(await bad.text()).not.toContain('private-owner');
	});
});
