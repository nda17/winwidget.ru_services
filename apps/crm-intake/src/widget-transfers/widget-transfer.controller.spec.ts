import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WidgetTransferController } from './widget-transfer.controller';
import { WidgetTransferService } from './widget-transfer.service';
import { IntakeController } from '../intake/intake.controller';
import { IntakeService } from '../intake/intake.service';
import { IntakeAuthorizationClient } from '../access/intake-authorization.client';
import { AcceptanceController } from '../acceptance/acceptance.controller';
import { AcceptanceService } from '../acceptance/acceptance.service';
describe('Widgets transfer actual HTTP contracts', () => {
	const workspaceId = randomUUID(),
		sourceId = randomUUID(),
		entryId = randomUUID(),
		transferId = randomUUID(),
		commandId = randomUUID();
	let app: NestExpressApplication, origin: string;
	const context = { workspaceId, subject: 'reader' };
	const authorization = {
		authorize: jest.fn().mockResolvedValue(context)
	};
	const service = {
		list: jest.fn().mockResolvedValue({
			schemaVersion: 1,
			items: [],
			page: 1,
			pageSize: 25,
			total: 0
		}),
		retry: jest.fn().mockResolvedValue({
			schemaVersion: 1,
			command: { id: commandId, state: 'QUEUED' }
		})
	};
	const intake = {
		widgetDetails: jest.fn().mockResolvedValue({
			schemaVersion: 1,
			workspaceId,
			entryId,
			sourceId,
			payload: {}
		})
	};
	const acceptance = {
		accept: jest.fn().mockResolvedValue({ schemaVersion: 1 })
	};
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [
				WidgetTransferController,
				IntakeController,
				AcceptanceController
			],
			providers: [
				{ provide: WidgetTransferService, useValue: service },
				{ provide: IntakeService, useValue: intake },
				{ provide: IntakeAuthorizationClient, useValue: authorization },
				{ provide: AcceptanceService, useValue: acceptance }
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
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
	const base = () => origin + '/api/v1/crm/intake';
	const retry = (change: Record<string, unknown> = {}, key = commandId) =>
		fetch(
			base() +
				'/widget-sources/' +
				sourceId +
				'/transfers/' +
				transferId +
				'/retry',
			{
				method: 'POST',
				headers: {
					authorization: 'Bearer user',
					'content-type': 'application/json',
					'idempotency-key': key
				},
				body: JSON.stringify({
					schemaVersion: 1,
					workspaceId,
					commandId,
					expectedVersion: 1,
					...change
				})
			}
		);
	test('retry202 is only durable queued acknowledgement with exact key', async () => {
		const r = await retry();
		expect(r.status).toBe(202);
		expect(r.headers.get('cache-control')).toBe('no-store');
		await r.body?.cancel();
		expect(service.retry).toHaveBeenCalledWith(
			'Bearer user',
			sourceId,
			transferId,
			{ schemaVersion: 1, workspaceId, commandId, expectedVersion: 1 }
		);
		const invalid = await retry({}, randomUUID());
		expect(invalid.status).toBe(400);
		await invalid.body?.cancel();
	});
	test.each([
		{ actorSubject: 'private-value' },
		{ ownerSubject: 'private-value' },
		{ payload: 'private-value' },
		{ generation: 2 },
		{ expectedVersion: 0 }
	])('rejects public authority/payload override %j', async body => {
		const r = await retry(body);
		expect(r.status).toBe(400);
		expect(await r.text()).not.toContain('private-value');
		expect(service.retry).not.toHaveBeenCalled();
	});
	test('server pagination is bounded without source actor overrides', async () => {
		const r = await fetch(
			base() +
				'/widget-sources/' +
				sourceId +
				'/transfers?workspaceId=' +
				workspaceId +
				'&page=2&pageSize=10'
		);
		expect(r.status).toBe(200);
		await r.body?.cancel();
		expect(service.list).toHaveBeenCalledWith(undefined, sourceId, {
			workspaceId,
			page: 2,
			pageSize: 10
		});
		const bad = await fetch(
			base() +
				'/widget-sources/' +
				sourceId +
				'/transfers?workspaceId=' +
				workspaceId +
				'&pageSize=101'
		);
		expect(bad.status).toBe(400);
		await bad.body?.cancel();
	});
	test('details reauthorize user on each request, and denial never reads saved data', async () => {
		const url =
			base() +
			'/inbox/' +
			entryId +
			'/widget-details?workspaceId=' +
			workspaceId;
		const r = await fetch(url, {
			headers: { authorization: 'Bearer current' }
		});
		expect(r.status).toBe(200);
		expect(r.headers.get('cache-control')).toBe('no-store');
		await r.body?.cancel();
		expect(intake.widgetDetails).toHaveBeenCalledWith(
			context,
			workspaceId,
			entryId
		);
		intake.widgetDetails.mockClear();
		authorization.authorize.mockRejectedValueOnce(
			new ForbiddenException()
		);
		const denied = await fetch(url);
		expect(denied.status).toBe(403);
		await denied.body?.cancel();
		expect(intake.widgetDetails).not.toHaveBeenCalled();
	});
	test('nested optional contact.name is accepted by transport, but no arbitrary DTO fields', async () => {
		const dto = {
			schemaVersion: 1,
			workspaceId,
			commandId,
			expectedVersion: 1,
			contact: { mode: 'CREATE_FROM_ENTRY', name: 'Анна' },
			deal: {
				title: 'Deal',
				currency: 'RUB',
				amountMinor: 0,
				pipelineId: randomUUID(),
				stageId: randomUUID(),
				nextTask: { title: 'Call', dueAt: '2026-09-01T00:00:00.000Z' }
			}
		};
		const send = (body: unknown) =>
			fetch(base() + '/inbox/' + entryId + '/accept', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'idempotency-key': commandId
				},
				body: JSON.stringify(body)
			});
		const r = await send(dto);
		expect(r.status).toBe(202);
		await r.body?.cancel();
		expect(acceptance.accept).toHaveBeenCalledWith(context, entryId, dto);
		const bad = await send({
			...dto,
			contact: { ...dto.contact, ownerSubject: 'private-value' }
		});
		expect(bad.status).toBe(400);
		expect(await bad.text()).not.toContain('private-value');
	});
});
