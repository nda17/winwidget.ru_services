import {
	type INestApplication,
	RequestMethod,
	ValidationPipe
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import {
	request as httpRequest,
	type IncomingHttpHeaders
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { CrmAccessHttpExceptionFilter } from '../common/crm-access-http-exception.filter';
import { crmAccessRequestContextMiddleware } from '../common/crm-access-request-context';
import { CrmAuthorizationController } from './crm-authorization.controller';
import { CrmAuthorizationService } from './crm-authorization.service';
import { CRM_CALLERS, CrmInternalGuard } from './crm-internal.guard';

const PATH = '/internal/v1/crm-access/authorize-widget-source';
const BODY = {
	schemaVersion: 1,
	workspaceId: '11111111-1111-4111-8111-111111111111',
	subject: 'qa-delegated-actor-private-marker'
};
const OWNER = 'qa-owner-private-marker@example.test';
const credentials = Object.fromEntries(
	Object.keys(CRM_CALLERS).map(caller => [
		caller,
		randomBytes(48).toString('base64url')
	])
);
const values = Object.fromEntries(
	Object.entries(CRM_CALLERS).map(([caller, key]) => [
		key,
		credentials[caller]
	])
);
const trustedHeaders = () => [
	'x-winwidget-service',
	'crm-intake',
	'x-winwidget-internal-token',
	credentials['crm-intake']
];
const outcome = {
	...BODY,
	role: 'CRM_ADMIN',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['intake:manage-sources'],
	ownerSubject: OWNER
};

describe('CRM widget source authority actual HTTP boundary', () => {
	let app: INestApplication;
	let port: number;
	const authorization = {
		authorizeWidgetSource: jest.fn(),
		authorizeSource: jest.fn()
	};
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [CrmAuthorizationController],
			providers: [
				CrmInternalGuard,
				{
					provide: ConfigService,
					useValue: { get: (name: string) => values[name] }
				},
				{ provide: CrmAuthorizationService, useValue: authorization }
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
		app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
		// Match main.ts without importing its bootstrapping side effect.
		app.setGlobalPrefix('api/v1', {
			exclude: [
				{ path: 'health/live', method: RequestMethod.GET },
				{ path: 'health/ready', method: RequestMethod.GET },
				...[
					'authorize',
					'authorize-source',
					'authorize-widget-source',
					'authorize-workflow'
				].map(name => ({
					path: `internal/v1/crm-access/${name}`,
					method: RequestMethod.POST
				}))
			]
		});
		app.use(crmAccessRequestContextMiddleware);
		app.useGlobalPipes(
			new ValidationPipe({
				whitelist: true,
				forbidNonWhitelisted: true,
				forbidUnknownValues: true,
				transform: true
			})
		);
		app.useGlobalFilters(new CrmAccessHttpExceptionFilter());
		await app.listen(0, '127.0.0.1');
		port = (app.getHttpServer().address() as AddressInfo).port;
	});
	beforeEach(() => {
		jest.clearAllMocks();
		authorization.authorizeWidgetSource.mockResolvedValue(outcome);
		authorization.authorizeSource.mockResolvedValue({
			...outcome,
			ownerSubject: undefined
		});
	});
	afterAll(async () => {
		if (app) await app.close();
	});
	function send(
		options: {
			method?: string;
			path?: string;
			headers?: string[];
			body?: unknown;
		} = {}
	) {
		const body = JSON.stringify(
			options.body === undefined ? BODY : options.body
		);
		return new Promise<{
			status: number;
			headers: IncomingHttpHeaders;
			body: unknown;
			text: string;
		}>((resolve, reject) => {
			const request = httpRequest(
				{
					host: '127.0.0.1',
					port,
					method: options.method || 'POST',
					path: options.path || PATH,
					agent: false,
					headers: [
						'Host',
						`127.0.0.1:${port}`,
						'Content-Type',
						'application/json',
						'Content-Length',
						String(Buffer.byteLength(body)),
						...(options.headers || [])
					]
				},
				response => {
					const chunks: Buffer[] = [];
					let size = 0;
					response.on('data', (chunk: Buffer) => {
						size += chunk.length;
						if (size > 16_384) {
							response.destroy(
								new Error('Unexpected HTTP test response size')
							);
							return;
						}
						chunks.push(chunk);
					});
					response.on('error', reject);
					response.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8');
						try {
							resolve({
								status: response.statusCode || 0,
								headers: response.headers,
								body: JSON.parse(text),
								text
							});
						} catch {
							reject(new Error('Expected a JSON HTTP response'));
						}
					});
				}
			);
			request.setTimeout(3_000, () =>
				request.destroy(new Error('Local HTTP test timed out'))
			);
			request.on('error', reject);
			request.end(body);
		});
	}
	function denied(
		response: Awaited<ReturnType<typeof send>>,
		status: number
	) {
		expect(response.status).toBe(status);
		expect(response.body).toMatchObject({ statusCode: status });
		for (const value of [
			BODY.subject,
			BODY.workspaceId,
			OWNER,
			...Object.values(credentials)
		])
			expect(response.text.includes(value)).toBe(false);
		expect(response.body).not.toHaveProperty('stack');
		expect(authorization.authorizeWidgetSource).not.toHaveBeenCalled();
	}
	it('authorizes the exact Intake call with no-store and canonical service arguments', async () => {
		const response = await send({ headers: trustedHeaders() });
		expect(response.status).toBe(200);
		expect(response.headers['cache-control']).toBe('no-store');
		expect(response.body).toEqual(outcome);
		expect(authorization.authorizeWidgetSource).toHaveBeenCalledTimes(1);
		expect(authorization.authorizeWidgetSource).toHaveBeenCalledWith(
			BODY.workspaceId,
			BODY.subject
		);
	});
	it.each(['crm-sales', 'crm-customers'])(
		'rejects correctly authenticated %s at the Intake-only controller boundary',
		async caller =>
			denied(
				await send({
					headers: [
						'x-winwidget-service',
						caller,
						'x-winwidget-internal-token',
						credentials[caller]
					]
				}),
				403
			)
	);
	it.each([
		{ name: 'anonymous', headers: [] },
		{
			name: 'user Bearer only',
			headers: ['Authorization', 'Bearer synthetic-user-access-token']
		},
		{
			name: 'wrong token',
			headers: [
				'x-winwidget-service',
				'crm-intake',
				'x-winwidget-internal-token',
				credentials['crm-sales']
			]
		},
		{
			name: 'missing caller',
			headers: ['x-winwidget-internal-token', credentials['crm-intake']]
		},
		{
			name: 'unknown caller',
			headers: [
				'x-winwidget-service',
				'widgets',
				'x-winwidget-internal-token',
				credentials['crm-intake']
			]
		},
		{
			name: 'forged forwarded credentials and IP',
			headers: [
				'X-Forwarded-For',
				'127.0.0.1',
				'Forwarded',
				'for=127.0.0.1;proto=https',
				'X-Forwarded-WinWidget-Service',
				'crm-intake',
				'X-Forwarded-WinWidget-Internal-Token',
				credentials['crm-intake']
			]
		}
	])(
		'rejects $name without reflecting private input',
		async ({ headers }) => denied(await send({ headers }), 403)
	);
	it.each(['caller', 'token'] as const)(
		'rejects duplicate %s header lines over the real socket',
		async field =>
			denied(
				await send({
					headers: [
						...trustedHeaders(),
						...(field === 'caller'
							? ['X-WinWidget-Service', 'crm-intake']
							: ['X-WinWidget-Internal-Token', credentials['crm-intake']])
					]
				}),
				403
			)
	);
	it.each([
		{
			name: 'forged ownerSubject',
			body: { ...BODY, ownerSubject: OWNER }
		},
		{ name: 'unknown field', body: { ...BODY, actor: OWNER } },
		{ name: 'schema string', body: { ...BODY, schemaVersion: '1' } },
		{ name: 'unsupported schema', body: { ...BODY, schemaVersion: 2 } },
		{
			name: 'invalid workspace',
			body: { ...BODY, workspaceId: 'not-a-uuid' }
		},
		{
			name: 'non-v4 workspace',
			body: {
				...BODY,
				workspaceId: '11111111-1111-1111-8111-111111111111'
			}
		},
		{
			name: 'missing subject',
			body: { schemaVersion: 1, workspaceId: BODY.workspaceId }
		},
		{ name: 'empty subject', body: { ...BODY, subject: '' } },
		{
			name: 'whitespace subject',
			body: { ...BODY, subject: 'invalid subject' }
		},
		{
			name: 'oversized subject',
			body: { ...BODY, subject: 'x'.repeat(257) }
		},
		{ name: 'array instead of DTO', body: [BODY] }
	])('rejects $name before business authorization', async ({ body }) =>
		denied(await send({ headers: trustedHeaders(), body }), 400)
	);
	it.each([
		{ method: 'POST', path: `/api/v1${PATH}` },
		{ method: 'GET', path: PATH },
		{ method: 'GET', path: `/api/v1${PATH}` }
	])('does not expose $method $path', async options =>
		denied(await send({ ...options, headers: trustedHeaders() }), 404)
	);
	it('keeps the existing authorize-source route separately callable', async () => {
		const response = await send({
			path: '/internal/v1/crm-access/authorize-source',
			headers: trustedHeaders()
		});
		expect(response.status).toBe(200);
		expect(authorization.authorizeSource).toHaveBeenCalledWith(
			BODY.workspaceId,
			BODY.subject
		);
		expect(authorization.authorizeWidgetSource).not.toHaveBeenCalled();
	});
});
