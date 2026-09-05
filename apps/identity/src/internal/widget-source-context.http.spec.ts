import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import {
	request as httpRequest,
	type IncomingHttpHeaders
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { IdentityHttpExceptionFilter } from '../common/http-exception.filter';
import { identityRequestContext } from '../common/request-context';
import { IdentityProviderHealthService } from '../health/identity-provider-health.service';
import { IDENTITY_GLOBAL_PREFIX_EXCLUDES } from '../runtime/identity-http.config';
import { IdentityInternalController } from './internal.controller';
import {
	IDENTITY_INTERNAL_SERVICES,
	IdentityInternalGuard
} from './internal.guard';
import { IdentityInternalService } from './internal.service';

const PATH = '/internal/v1/crm-access/widget-source-context';
const BODY = {
	schemaVersion: 1,
	workspaceId: '11111111-1111-4111-8111-111111111111',
	subject: 'qa-delegated-actor-private-marker'
};
const OWNER = 'qa-owner-private-marker@example.test';
const credentials = Object.fromEntries(
	IDENTITY_INTERNAL_SERVICES.map(service => [
		service,
		randomBytes(48).toString('base64url')
	])
);
const values = {
	WINCRM_INVITATION_EMAIL_ENABLED: 'true',
	...Object.fromEntries(
		IDENTITY_INTERNAL_SERVICES.map(service => [
			`IDENTITY_${service.replace(/-/g, '_').toUpperCase()}_TOKEN`,
			credentials[service]
		])
	)
} as Record<string, string>;
const trustedHeaders = () => [
	'x-winwidget-service',
	'crm-access',
	'x-winwidget-internal-token',
	credentials['crm-access']
];
const outcome = {
	...BODY,
	membership: {
		membershipId: '22222222-2222-4222-8222-222222222222',
		workspaceId: BODY.workspaceId,
		role: 'MEMBER'
	},
	ownerSubject: OWNER
};

describe('Identity widget source context actual HTTP boundary', () => {
	let app: INestApplication;
	let port: number;
	const internal = {
		crmWidgetSourceContext: jest.fn(),
		crmSourceContext: jest.fn()
	};

	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [IdentityInternalController],
			providers: [
				IdentityInternalGuard,
				{
					provide: ConfigService,
					useValue: { get: (name: string) => values[name] }
				},
				{ provide: IdentityInternalService, useValue: internal },
				{ provide: IdentityProviderHealthService, useValue: {} }
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
		app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
		app.setGlobalPrefix('api/v1', {
			exclude: [...IDENTITY_GLOBAL_PREFIX_EXCLUDES]
		});
		app.use(identityRequestContext);
		// Keep the production global whitelist: the endpoint must detect original extra keys.
		app.useGlobalPipes(
			new ValidationPipe({ transform: true, whitelist: true })
		);
		app.useGlobalFilters(new IdentityHttpExceptionFilter());
		await app.listen(0, '127.0.0.1');
		port = (app.getHttpServer().address() as AddressInfo).port;
	});
	beforeEach(() => {
		jest.clearAllMocks();
		internal.crmWidgetSourceContext.mockResolvedValue(outcome);
		internal.crmSourceContext.mockResolvedValue({
			...BODY,
			membership: null
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
		expect(internal.crmWidgetSourceContext).not.toHaveBeenCalled();
	}

	it('accepts only the exact trusted service and body with a no-store response', async () => {
		const response = await send({ headers: trustedHeaders() });
		expect(response.status).toBe(200);
		expect(response.headers['cache-control']).toBe('no-store');
		expect(response.body).toEqual(outcome);
		expect(internal.crmWidgetSourceContext).toHaveBeenCalledTimes(1);
		expect(internal.crmWidgetSourceContext).toHaveBeenCalledWith(
			BODY.workspaceId,
			BODY.subject
		);
	});
	it.each(
		IDENTITY_INTERNAL_SERVICES.filter(service => service !== 'crm-access')
	)(
		'rejects valid but differently scoped %s credentials',
		async caller => {
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
			);
		}
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
				'crm-access',
				'x-winwidget-internal-token',
				credentials.widgets
			]
		},
		{
			name: 'missing caller',
			headers: ['x-winwidget-internal-token', credentials['crm-access']]
		},
		{
			name: 'unknown caller',
			headers: [
				'x-winwidget-service',
				'untrusted',
				'x-winwidget-internal-token',
				credentials['crm-access']
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
				'crm-access',
				'X-Forwarded-WinWidget-Internal-Token',
				credentials['crm-access']
			]
		}
	])(
		'rejects $name without reflecting private input',
		async ({ headers }) => denied(await send({ headers }), 403)
	);
	it.each(['caller', 'token'] as const)(
		'rejects duplicated %s header lines sent over the real socket',
		async field => {
			denied(
				await send({
					headers: [
						...trustedHeaders(),
						...(field === 'caller'
							? ['X-WinWidget-Service', 'crm-access']
							: ['X-WinWidget-Internal-Token', credentials['crm-access']])
					]
				}),
				403
			);
		}
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
	it('keeps the existing source-context endpoint separately routed', async () => {
		const response = await send({
			path: '/internal/v1/crm-access/source-context',
			headers: trustedHeaders()
		});
		expect(response.status).toBe(200);
		expect(internal.crmSourceContext).toHaveBeenCalledWith(
			BODY.workspaceId,
			BODY.subject
		);
		expect(internal.crmWidgetSourceContext).not.toHaveBeenCalled();
	});
});
