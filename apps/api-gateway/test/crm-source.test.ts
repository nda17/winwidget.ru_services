import assert from 'node:assert/strict';
import {
	request as httpRequest,
	type IncomingHttpHeaders
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { CRM_SOURCE_INGEST_PREFIX, loadConfig } from '../src/config';
import { createGateway } from '../src/server';
import {
	closeServer,
	createJwksFetch,
	createServer,
	createSigningFixture,
	createTestConfig,
	createTestRoute,
	listenServer,
	makeRequest,
	signAccessToken
} from './helpers';

const sourcePath = `${CRM_SOURCE_INGEST_PREFIX}/11111111-1111-4111-8111-111111111111`;
const tildaPath = `${sourcePath}/tilda`;
// Synthetic credentials only; no private fixture or production environment.
const sourceKey = Buffer.alloc(32, 17).toString('base64url');
const credentials = { authorization: `Bearer ${sourceKey}` };
const tildaCredentials = { 'x-wincrm-source-token': sourceKey };

describe('WinCRM source credential route configuration', () => {
	const configFor = (pathPrefix: string) =>
		loadConfig({
			JWT_JWKS_URL: 'http://127.0.0.1:4299/jwks',
			JWT_ISSUER: 'http://localhost:4100/auth',
			JWT_AUDIENCE: 'http://localhost:4100',
			CORS_ALLOWED_ORIGINS: 'http://localhost:3001',
			GATEWAY_ROUTES_JSON: JSON.stringify([
				{
					id: 'crm-ingest',
					pathPrefix,
					upstreamUrl: 'http://127.0.0.1:5310',
					authPolicy: 'crm-source',
					timeoutMs: 1000
				}
			])
		});

	it('permits exactly the explicit ingest prefix', () => {
		assert.equal(
			configFor(CRM_SOURCE_INGEST_PREFIX).routes[0].authPolicy,
			'crm-source'
		);
	});

	for (const prefix of [
		'/api/v1/crm/intake',
		'/api/v1/users',
		'/api/v1/crm/intake/ingest-extra',
		`${CRM_SOURCE_INGEST_PREFIX}/nested`
	])
		it(`rejects delegated credentials on ${prefix}`, () => {
			assert.throws(() => configFor(prefix), /policy is restricted/);
		});
});

describe('WinCRM source credential gateway boundary', () => {
	const signing = createSigningFixture('crm-source-jwt-test');
	const captured: {
		url: string;
		headers: IncomingHttpHeaders;
		body: string;
	}[] = [];
	let jwksCalls = 0;
	const logs: unknown[] = [];
	const upstream = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', chunk => chunks.push(Buffer.from(chunk)));
		request.on('end', () => {
			captured.push({
				url: request.url ?? '',
				headers: request.headers,
				body: Buffer.concat(chunks).toString('utf8')
			});
			response.writeHead(request.method === 'OPTIONS' ? 204 : 200, {
				'content-type': 'application/json'
			});
			response.end(
				request.method === 'OPTIONS' ? undefined : '{"ok":true}'
			);
		});
	});
	let gateway: ReturnType<typeof createGateway>;
	let base: URL;
	before(async () => {
		const upstreamUrl = await listenServer(upstream);
		gateway = createGateway(
			createTestConfig({
				routes: [
					createTestRoute({
						id: 'crm-ingest',
						pathPrefix: CRM_SOURCE_INGEST_PREFIX,
						authPolicy: 'crm-source',
						upstreamUrl
					}),
					createTestRoute({
						id: 'crm-intake',
						pathPrefix: '/api/v1/crm/intake',
						authPolicy: 'required',
						upstreamUrl
					}),
					createTestRoute({
						id: 'existing-optional',
						pathPrefix: '/api/v1/test',
						authPolicy: 'optional',
						upstreamUrl
					})
				]
			}),
			{
				logger: {
					log(level, event, fields) {
						logs.push({ level, event, fields });
					}
				},
				fetch: createJwksFetch(
					() => [signing.publicJwk],
					() => true,
					() => {
						jwksCalls += 1;
					}
				)
			}
		);
		await gateway.listen(0);
		base = new URL(
			`http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`
		);
	});
	after(async () => {
		await gateway?.close();
		await closeServer(upstream);
	});

	it('forwards the exact source credential and body without JWT introspection', async () => {
		const before = jwksCalls;
		const body = JSON.stringify({
			schemaVersion: 1,
			title: 'Synthetic lead'
		});
		const response = await makeRequest(new URL(sourcePath, base), {
			method: 'POST',
			headers: {
				...credentials,
				'content-type': 'application/json',
				'idempotency-key': '22222222-2222-4222-8222-222222222222',
				'x-user-id': 'forged-owner',
				'x-auth-role': 'OWNER',
				'x-internal-caller': 'crm-access',
				'x-winwidget-internal-token': 'synthetic-forged-internal-token',
				cookie: 'refreshToken=synthetic-refresh; ui=light'
			},
			body
		});
		assert.equal(response.statusCode, 200);
		assert.equal(jwksCalls, before);
		const result = captured.at(-1)!;
		assert.equal(result.url, sourcePath);
		assert.equal(result.body, body);
		assert.equal(result.headers.authorization, credentials.authorization);
		assert.equal(
			result.headers['idempotency-key'],
			'22222222-2222-4222-8222-222222222222'
		);
		for (const key of [
			'x-user-id',
			'x-auth-role',
			'x-internal-caller',
			'x-winwidget-internal-token'
		])
			assert.equal(result.headers[key], undefined);
		assert.equal(result.headers.cookie, 'ui=light');
	});

	it('canonicalizes only the delegated source Bearer scheme for the Intake contract', async () => {
		const response = await makeRequest(new URL(sourcePath, base), {
			method: 'POST',
			headers: { authorization: `bEaReR ${sourceKey}` }
		});
		assert.equal(response.statusCode, 200);
		assert.equal(
			captured.at(-1)!.headers.authorization,
			credentials.authorization
		);
	});

	it('forwards only the Tilda source header and both media types unchanged without JWKS', async () => {
		const before = jwksCalls;
		for (const [contentType, body] of [
			[
				'application/x-www-form-urlencoded',
				'Name=Synthetic+lead&formid=form123&tranid=123%3A456'
			],
			[
				'application/json',
				JSON.stringify({
					Name: 'Synthetic lead',
					formid: 'form123',
					tranid: '123:456'
				})
			]
		]) {
			const response = await makeRequest(new URL(tildaPath, base), {
				method: 'POST',
				headers: {
					...tildaCredentials,
					'content-type': contentType,
					'x-user-id': 'forged-owner',
					'x-winwidget-internal-token': 'synthetic-forged-internal-token'
				},
				body
			});
			assert.equal(response.statusCode, 200);
			const actual = captured.at(-1)!;
			assert.equal(actual.url, tildaPath);
			assert.equal(actual.body, body);
			assert.equal(actual.headers['content-type'], contentType);
			assert.equal(actual.headers['x-wincrm-source-token'], sourceKey);
			assert.equal(actual.headers.authorization, undefined);
			assert.equal(actual.headers['x-user-id'], undefined);
			assert.equal(
				actual.headers['x-winwidget-internal-token'],
				undefined
			);
		}
		assert.equal(jwksCalls, before);
		assert.ok(!JSON.stringify(logs).includes(sourceKey));
	});

	it('rejects absent, malformed, duplicate and Bearer Tilda credentials without proxying or logging secrets', async () => {
		const before = captured.length;
		const jwksBefore = jwksCalls;
		for (const headers of [
			{},
			credentials,
			{ ...tildaCredentials, ...credentials },
			{ authorization: `Bearer ${signAccessToken(signing)}` },
			{ 'x-wincrm-source-token': '' },
			{ 'x-wincrm-source-token': `Bearer ${sourceKey}` },
			{ 'x-wincrm-source-token': `${sourceKey}=` },
			{ 'x-wincrm-source-token': `${sourceKey.slice(0, -1)}F` },
			{ 'x-wincrm-source-token': signAccessToken(signing) }
		]) {
			const response = await makeRequest(new URL(tildaPath, base), {
				method: 'POST',
				headers
			});
			assert.equal(response.statusCode, 401);
		}
		const duplicateStatus = await new Promise<number>(
			(resolve, reject) => {
				const request = httpRequest(
					new URL(tildaPath, base),
					{
						method: 'POST',
						headers: [
							'X-WinCRM-Source-Token',
							sourceKey,
							'x-wincrm-source-token',
							sourceKey,
							'Host',
							base.host,
							'Content-Length',
							'0'
						]
					},
					response => {
						response.resume();
						response.once('end', () => resolve(response.statusCode ?? 0));
					}
				);
				request.once('error', reject);
				request.end();
			}
		);
		assert.equal(duplicateStatus, 401);
		assert.equal(captured.length, before);
		assert.equal(jwksCalls, jwksBefore);
		assert.ok(!JSON.stringify(logs).includes(sourceKey));
	});

	it('keeps the Tilda route POST-only and rejects query, encoded and nested paths before proxying', async () => {
		const before = captured.length;
		for (const [method, path] of [
			['GET', tildaPath],
			['OPTIONS', tildaPath],
			['PUT', tildaPath],
			['POST', `${tildaPath}/`],
			['POST', `${tildaPath}/nested`],
			['POST', `${tildaPath}?token=${sourceKey}`],
			['POST', tildaPath.replace('/tilda', '/%74ilda')],
			['POST', tildaPath.replace('4111', '5111')]
		]) {
			const response = await makeRequest(new URL(path, base), {
				method,
				headers: tildaCredentials
			});
			assert.equal(response.statusCode, 404);
		}
		assert.equal(captured.length, before);
		assert.ok(!JSON.stringify(logs).includes(sourceKey));
	});

	it('never authorizes neighbouring routes or forwards the Tilda credential outside its exact route', async () => {
		for (const path of [sourcePath, '/api/v1/crm/intake/inbox']) {
			const before = captured.length;
			assert.equal(
				(
					await makeRequest(new URL(path, base), {
						method: 'POST',
						headers: tildaCredentials
					})
				).statusCode,
				401
			);
			assert.equal(captured.length, before);
		}
		for (const [path, headers] of [
			[sourcePath, { ...credentials, ...tildaCredentials }],
			[
				'/api/v1/crm/intake/inbox',
				{
					authorization: `Bearer ${signAccessToken(signing)}`,
					...tildaCredentials
				}
			],
			['/api/v1/test', tildaCredentials]
		] as const) {
			assert.equal(
				(
					await makeRequest(new URL(path, base), {
						method: 'POST',
						headers
					})
				).statusCode,
				200
			);
			assert.equal(
				captured.at(-1)!.headers['x-wincrm-source-token'],
				undefined
			);
		}
	});

	it('permits unauthenticated canonical preflight but not an unauthenticated POST', async () => {
		const preflight = await makeRequest(new URL(sourcePath, base), {
			method: 'OPTIONS'
		});
		assert.equal(preflight.statusCode, 204);
		const before = captured.length;
		const response = await makeRequest(new URL(sourcePath, base), {
			method: 'POST'
		});
		assert.equal(response.statusCode, 401);
		assert.equal(captured.length, before);
	});

	it('rejects malformed, duplicate, noncanonical and JWT credentials before proxying', async () => {
		const before = captured.length;
		for (const authorization of [
			'Basic invalid',
			'Bearer invalid',
			`Bearer ${sourceKey}=`,
			`Bearer ${sourceKey.slice(0, -1)}F`,
			`Bearer ${signAccessToken(signing)}`
		]) {
			const response = await makeRequest(new URL(sourcePath, base), {
				method: 'POST',
				headers: { authorization }
			});
			assert.equal(response.statusCode, 401);
		}
		const duplicateStatus = await new Promise<number>(
			(resolve, reject) => {
				const request = httpRequest(
					new URL(sourcePath, base),
					{
						method: 'POST',
						headers: [
							'Authorization',
							credentials.authorization,
							'authorization',
							credentials.authorization,
							'Host',
							base.host,
							'Content-Length',
							'0'
						]
					},
					response => {
						response.resume();
						response.once('end', () => resolve(response.statusCode ?? 0));
					}
				);
				request.once('error', reject);
				request.end();
			}
		);
		assert.equal(duplicateStatus, 401);
		assert.equal(captured.length, before);
	});

	it('never delegates GET, query, encoded, nested or noncanonical paths', async () => {
		const before = captured.length;
		for (const [method, path] of [
			['GET', sourcePath],
			['PUT', sourcePath],
			['DELETE', sourcePath],
			['POST', CRM_SOURCE_INGEST_PREFIX],
			['POST', `${sourcePath}/`],
			['POST', `${sourcePath}/rotate`],
			['POST', `${sourcePath}?token=invalid`],
			['POST', sourcePath.replace('/ingest/', '/%69ngest/')],
			['POST', sourcePath.replace('4111', '5111')]
		]) {
			const response = await makeRequest(new URL(path, base), {
				method,
				headers: credentials
			});
			assert.equal(response.statusCode, 404);
		}
		assert.equal(captured.length, before);
	});

	it('preserves required and optional JWT validation on every neighbouring route', async () => {
		const before = captured.length;
		for (const path of [
			'/api/v1/crm/intake/inbox',
			'/api/v1/crm/intake/ingest-extra',
			'/api/v1/test'
		]) {
			const response = await makeRequest(new URL(path, base), {
				headers: credentials
			});
			assert.equal(response.statusCode, 401);
		}
		assert.equal(captured.length, before);
		assert.equal(
			(await makeRequest(new URL('/api/v1/test', base))).statusCode,
			200
		);
		assert.equal(
			(
				await makeRequest(new URL('/api/v1/crm/intake/inbox', base), {
					headers: { authorization: `Bearer ${signAccessToken(signing)}` }
				})
			).statusCode,
			200
		);
		assert.ok(jwksCalls > 0);
	});
});
