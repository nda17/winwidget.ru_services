import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	JwksStore,
	JwksUnavailableError,
	UnknownSigningKeyError
} from '../src/jwks';
import { JwtValidationError, verifyAccessToken } from '../src/jwt';
import {
	createJwksFetch,
	createSigningFixture,
	createTestConfig,
	signAccessToken,
	silentLogger
} from './helpers';

const createStore = (
	fetch: ReturnType<typeof createJwksFetch>,
	now?: () => number
) => {
	const config = createTestConfig();
	return new JwksStore({
		url: config.jwksUrl,
		fetchTimeoutMs: config.jwksFetchTimeoutMs,
		refreshMinIntervalMs: config.jwksRefreshMinIntervalMs,
		cacheTtlMs: config.jwksCacheTtlMs,
		maxStaleMs: config.jwksMaxStaleMs,
		maxBytes: config.jwksMaxBytes,
		logger: silentLogger,
		fetch,
		now
	});
};

describe('JWT access validation', () => {
	it('accepts only the exact RS256 access-token contract', async () => {
		const key = createSigningFixture('key-1');
		const store = createStore(createJwksFetch(() => [key.publicJwk]));
		assert.equal(await store.initialize(), true);

		const claims = await verifyAccessToken(
			signAccessToken(key),
			store,
			createTestConfig()
		);

		assert.equal(claims.sub, 'user-1');
		assert.equal(claims.sid, '11111111-1111-4111-8111-111111111111');
		assert.deepEqual(claims.roles, ['USER']);
	});

	it('rejects refresh tokens and wrong token contexts', async () => {
		const key = createSigningFixture('key-1');
		const store = createStore(createJwksFetch(() => [key.publicJwk]));
		await store.initialize();

		await assert.rejects(
			verifyAccessToken(
				signAccessToken(key, { token_use: 'refresh' }),
				store,
				createTestConfig()
			),
			JwtValidationError
		);
		await assert.rejects(
			verifyAccessToken(
				signAccessToken(key, { aud: 'another-api' }),
				store,
				createTestConfig()
			),
			JwtValidationError
		);
		await assert.rejects(
			verifyAccessToken(
				signAccessToken(key, {}, { typ: 'JWT' }),
				store,
				createTestConfig()
			),
			JwtValidationError
		);
	});

	it('rejects missing or invalid identity, time and role claims', async () => {
		const key = createSigningFixture('key-1');
		const store = createStore(createJwksFetch(() => [key.publicJwk]));
		await store.initialize();
		const now = Math.floor(Date.now() / 1000);
		const invalidOverrides: Record<string, unknown>[] = [
			{ iat: undefined },
			{ iat: 'now' },
			{ jti: undefined },
			{ jti: 'not-a-uuid' },
			{ sid: undefined },
			{ sid: 'not-a-uuid' },
			{ roles: undefined },
			{ roles: [] },
			{ roles: ['USER', 'USER'] },
			{ roles: ['OWNER'] },
			{ aud: ['https://api.winwidget.test'] },
			{ iat: now, nbf: now - 1 },
			{ iat: now, exp: now + 3601 }
		];

		for (const overrides of invalidOverrides) {
			await assert.rejects(
				verifyAccessToken(
					signAccessToken(key, overrides),
					store,
					createTestConfig()
				),
				JwtValidationError
			);
		}
	});

	it('rejects HS256 even when the token is structurally valid', async () => {
		const key = createSigningFixture('key-1');
		const store = createStore(createJwksFetch(() => [key.publicJwk]));
		await store.initialize();
		const now = Math.floor(Date.now() / 1000);
		const header = Buffer.from(
			JSON.stringify({ alg: 'HS256', kid: 'key-1', typ: 'at+jwt' })
		).toString('base64url');
		const payload = Buffer.from(
			JSON.stringify({
				iss: 'https://api.winwidget.test/auth',
				aud: 'https://api.winwidget.test',
				sub: 'user-1',
				sid: '11111111-1111-4111-8111-111111111111',
				roles: ['USER'],
				token_use: 'access',
				jti: '22222222-2222-4222-8222-222222222222',
				iat: now,
				nbf: now,
				exp: now + 600
			})
		).toString('base64url');
		const input = `${header}.${payload}`;
		const signature = createHmac('sha256', 'not-a-valid-key')
			.update(input)
			.digest('base64url');

		await assert.rejects(
			verifyAccessToken(
				`${input}.${signature}`,
				store,
				createTestConfig()
			),
			JwtValidationError
		);
	});
});

describe('JWKS lifecycle', () => {
	it('refreshes an unknown kid once and keeps the refresh bounded', async () => {
		const firstKey = createSigningFixture('key-1');
		const secondKey = createSigningFixture('key-2');
		let keys = [firstKey.publicJwk];
		let now = 1000;
		let fetchCalls = 0;
		const fetch = createJwksFetch(
			() => keys,
			() => true,
			() => {
				fetchCalls += 1;
			}
		);
		const store = createStore(fetch, () => now);
		await store.initialize();
		keys = [firstKey.publicJwk, secondKey.publicJwk];
		now += 100;

		await verifyAccessToken(
			signAccessToken(secondKey),
			store,
			createTestConfig()
		);
		assert.equal(fetchCalls, 2);

		await assert.rejects(
			store.getKey('unknown-key'),
			UnknownSigningKeyError
		);
		assert.equal(fetchCalls, 2);
	});

	it('uses a warm known-key cache during outage and fails closed when cold', async () => {
		const key = createSigningFixture('key-1');
		let available = true;
		let now = 1000;
		const fetch = createJwksFetch(
			() => [key.publicJwk],
			() => available
		);
		const warmStore = createStore(fetch, () => now);
		assert.equal(await warmStore.initialize(), true);

		available = false;
		now += 2000;
		assert.equal(await warmStore.ensureReady(), true);
		assert.ok(await warmStore.getKey(key.kid));

		const coldStore = createStore(fetch, () => now);
		assert.equal(await coldStore.initialize(), false);
		await assert.rejects(coldStore.getKey(key.kid), JwksUnavailableError);
	});
});
