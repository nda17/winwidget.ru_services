import 'reflect-metadata';
import {
	ExecutionContext,
	INestApplication,
	RequestMethod
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';
import {
	WidgetsWincrmBillingClient,
	WidgetsWincrmConfig,
	WidgetsWincrmGuard
} from './widgets-wincrm.config';
import { WidgetsWincrmController } from './widgets-wincrm.controller';
import { WidgetsWincrmService } from './widgets-wincrm.service';

const INTAKE = 'widgets-intake-http-test-credential-1234567890';
const BILLING = 'widgets-billing-http-test-credential-1234567890';
const configValues = {
	WIDGETS_WINCRM_CONNECTOR_ENABLED: 'true',
	WIDGETS_CRM_INTAKE_TOKEN: INTAKE,
	BILLING_WINCRM_WIDGETS_TOKEN: BILLING,
	BILLING_INTERNAL_BASE_URL: 'http://127.0.0.1:4700'
};
const makeConfig = (
	values: Record<string, unknown> = configValues,
	apiEnabled = true
) =>
	new WidgetsWincrmConfig(
		{ get: (key: string) => values[key] } as ConfigService,
		{ apiEnabled } as WidgetsRuntimeService
	);

describe('Widgets native connector runtime credentials', () => {
	it('default off and publisher-only need no new credentials or origins', () => {
		expect(makeConfig({}).enabled).toBe(false);
		expect(
			makeConfig({ WIDGETS_WINCRM_CONNECTOR_ENABLED: 'true' }, false)
				.apiEnabled
		).toBe(false);
	});
	it.each([
		{ WIDGETS_WINCRM_CONNECTOR_ENABLED: '1' },
		{ WIDGETS_CRM_INTAKE_TOKEN: '' },
		{ WIDGETS_CRM_INTAKE_TOKEN: BILLING },
		{ WIDGETS_IDENTITY_TOKEN: INTAKE },
		{ BILLING_INTERNAL_BASE_URL: 'https://billing.example.test/path' },
		{
			BILLING_INTERNAL_BASE_URL:
				'https://user:password@billing.example.test'
		},
		{ BILLING_INTERNAL_BASE_URL: 'http://billing.example.test' },
		{ BILLING_INTERNAL_BASE_URL: 'https://billing.example.test/' },
		{ WIDGETS_WINCRM_HTTP_TIMEOUT_MS: '10000' }
	])('rejects invalid opt-in runtime configuration', patch =>
		expect(() => makeConfig({ ...configValues, ...patch })).toThrow()
	);
	it('does not trust forwarded loopback addresses or duplicate internal headers', () => {
		const guard = new WidgetsWincrmGuard(makeConfig());
		const request = {
			rawHeaders: [
				'x-winwidget-service',
				'crm-intake',
				'x-winwidget-internal-token',
				INTAKE
			],
			headers: {
				'x-winwidget-service': 'crm-intake',
				'x-winwidget-internal-token': INTAKE,
				'x-forwarded-for': '127.0.0.1'
			},
			socket: { remoteAddress: '192.0.2.5' }
		};
		const context = {
			switchToHttp: () => ({ getRequest: () => request })
		} as ExecutionContext;
		expect(() => guard.canActivate(context)).toThrow();
		request.socket.remoteAddress = '::ffff:127.0.0.1';
		expect(guard.canActivate(context)).toBe(true);
		request.rawHeaders.push('x-winwidget-service', 'crm-intake');
		expect(() => guard.canActivate(context)).toThrow();
	});
	it('uses fresh bounded no-redirect Billing HTTP and hides transport diagnostics', async () => {
		const now = Date.now();
		const checkedAt = new Date(now).toISOString();
		const payload = {
			schemaVersion: 1,
			ownerSubject: 'owner',
			eligible: false,
			reason: 'NO_SUBSCRIPTION',
			subscriptionId: null,
			version: null,
			plan: null,
			startsAt: null,
			expiresAt: null,
			checkedAt,
			validUntil: checkedAt
		};
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(payload), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		try {
			const client = new WidgetsWincrmBillingClient(makeConfig());
			expect(await client.eligibility('owner')).toEqual(payload);
			expect(fetchMock).toHaveBeenCalledWith(
				'http://127.0.0.1:4700/internal/v1/billing/widgets/wincrm-eligibility',
				expect.objectContaining({
					redirect: 'error',
					cache: 'no-store',
					body: JSON.stringify({
						schemaVersion: 1,
						ownerSubject: 'owner'
					}),
					headers: expect.objectContaining({
						'x-winwidget-service': 'widgets',
						'x-winwidget-internal-token': BILLING
					})
				})
			);
			fetchMock.mockRejectedValueOnce(new Error('private diagnostic'));
			await expect(client.eligibility('owner')).rejects.toMatchObject({
				response: { code: 'widgets_wincrm_billing_unavailable' }
			});
			fetchMock.mockResolvedValueOnce(
				new Response('x'.repeat(8193), {
					headers: { 'content-type': 'application/json' }
				})
			);
			await expect(client.eligibility('owner')).rejects.toMatchObject({
				status: 503
			});
		} finally {
			fetchMock.mockRestore();
		}
	});
});

describe('Widgets native connector real HTTP boundary', () => {
	let app: INestApplication;
	let origin: string;
	const service = {
		candidates: jest
			.fn()
			.mockResolvedValue({ schemaVersion: 1, items: [] }),
		configure: jest.fn().mockResolvedValue({ schemaVersion: 1 }),
		context: jest.fn().mockResolvedValue({ schemaVersion: 1 })
	};
	const start = async (enabled = true) => {
		const module = await Test.createTestingModule({
			controllers: [WidgetsWincrmController],
			providers: [
				WidgetsWincrmGuard,
				WidgetsWincrmConfig,
				{
					provide: ConfigService,
					useValue: {
						get: (key: keyof typeof configValues) =>
							enabled ? configValues[key] : undefined
					}
				},
				{ provide: WidgetsRuntimeService, useValue: { apiEnabled: true } },
				{ provide: WidgetsWincrmService, useValue: service }
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
		app.setGlobalPrefix('api/v1', {
			exclude: [
				{
					path: 'internal/v1/crm-intake/widget-connectors/candidates',
					method: RequestMethod.POST
				},
				{
					path: 'internal/v1/crm-intake/widget-connectors/:connectorId/configure',
					method: RequestMethod.POST
				},
				{
					path: 'internal/v1/crm-intake/widget-transfers/:transferId/context',
					method: RequestMethod.POST
				}
			]
		});
		await app.listen(0, '127.0.0.1');
		origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
	};
	const request = (
		path: string,
		body: unknown,
		caller = 'crm-intake',
		token = INTAKE,
		key?: string
	) =>
		fetch(`${origin}${path}`, {
			method: 'POST',
			redirect: 'error',
			headers: {
				'content-type': 'application/json',
				'x-winwidget-service': caller,
				'x-winwidget-internal-token': token,
				...(key ? { 'idempotency-key': key } : {})
			},
			body: JSON.stringify(body)
		});
	const path = '/internal/v1/crm-intake/widget-connectors/candidates';
	const body = {
		schemaVersion: 1,
		ownerSubject: 'owner',
		page: 1,
		pageSize: 20
	};
	beforeAll(() => start());
	beforeEach(() => jest.clearAllMocks());
	afterAll(async () => app?.close());
	it('exposes only exact scoped internal POST and no-store, not a public alias', async () => {
		const result = await request(path, body);
		expect(result.status).toBe(200);
		expect(result.headers.get('cache-control')).toBe('no-store');
		expect(service.candidates).toHaveBeenCalledWith('owner', 1, 20);
		expect((await request(`/api/v1${path}`, body)).status).toBe(404);
		expect((await fetch(`${origin}${path}`)).status).toBe(404);
	});
	it.each([
		['crm-access', INTAKE],
		['crm-intake', BILLING],
		['', '']
	])(
		'rejects cross-scoped pair before service calls',
		async (caller, token) => {
			expect((await request(path, body, caller, token)).status).toBe(403);
			expect(service.candidates).not.toHaveBeenCalled();
		}
	);
	it.each([
		{ ...body, page: 0 },
		{ ...body, pageSize: 101 },
		{ ...body, ownerSubject: ' owner' },
		{ ...body, ownerSubject: 'x'.repeat(257) },
		{ ...body, schemaVersion: '1' },
		{ ...body, widgetId: 'forbidden' }
	])('rejects malformed exact body before calls', async invalid => {
		expect((await request(path, invalid)).status).toBe(400);
		expect(service.candidates).not.toHaveBeenCalled();
	});
	it('requires configure UUID idempotency header and strict transfer binding', async () => {
		const commandId = randomUUID();
		const connectorId = randomUUID();
		const workspaceId = randomUUID();
		const sourceId = randomUUID();
		const command = {
			schemaVersion: 1,
			commandId,
			workspaceId,
			sourceId,
			ownerSubject: 'owner',
			widgetType: 'WHEEL',
			widgetId: 'cmwidget',
			controlVersion: 1,
			generation: 1,
			enabled: true
		};
		const configure = `/internal/v1/crm-intake/widget-connectors/${connectorId}/configure`;
		expect((await request(configure, command)).status).toBe(400);
		expect(service.configure).not.toHaveBeenCalled();
		expect(
			(await request(configure, command, 'crm-intake', INTAKE, commandId))
				.status
		).toBe(200);
		const transfer = `/internal/v1/crm-intake/widget-transfers/${randomUUID()}/context`;
		const binding = {
			schemaVersion: 1,
			eventId: randomUUID(),
			connectorId,
			workspaceId,
			sourceId,
			generation: 1
		};
		expect(
			(
				await request(transfer, {
					...binding,
					ownerSubject: 'not-allowed'
				})
			).status
		).toBe(400);
		expect((await request(transfer, binding)).status).toBe(200);
	});
	it('default off returns 404 without new credentials or service calls', async () => {
		await app.close();
		await start(false);
		expect((await request(path, body)).status).toBe(404);
		expect(service.candidates).not.toHaveBeenCalled();
	});
});
