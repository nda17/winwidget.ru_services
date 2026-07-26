import { AccessJwtService } from '@/auth/access-jwt.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import {
	generateKeyPairSync,
	randomUUID,
	type JsonWebKey,
	type KeyObject
} from 'node:crypto';

interface TestKeyPair {
	privateKey: string;
	publicJwk: JsonWebKey & {
		kid: string;
		use: 'sig';
		alg: 'RS256';
		key_ops: ['verify'];
	};
}

describe('AccessJwtService', () => {
	const jwt = new JwtService();
	const issuer = 'https://api.example.test';
	const audience = 'winwidget-api';
	let activeKey: TestKeyPair;
	let previousKey: TestKeyPair;
	let service: AccessJwtService;

	beforeAll(() => {
		activeKey = createKeyPair('access-key-2026-07');
		previousKey = createKeyPair('access-key-previous');
		service = createService(activeKey.privateKey, [
			activeKey.publicJwk,
			previousKey.publicJwk
		]);
	});

	it('issues an RS256 access token with the required header and claims', () => {
		const sessionId = randomUUID();
		const token = service.issueAccessToken(
			'user-id',
			[Role.USER, Role.ADMIN],
			sessionId
		);
		const decoded = jwt.decode<{
			header: Record<string, unknown>;
			payload: Record<string, unknown>;
		}>(token, { complete: true });

		expect(decoded.header).toEqual({
			alg: 'RS256',
			typ: 'at+jwt',
			kid: activeKey.publicJwk.kid
		});
		expect(decoded.payload).toMatchObject({
			iss: issuer,
			aud: audience,
			sub: 'user-id',
			sid: sessionId,
			roles: [Role.USER, Role.ADMIN],
			token_use: 'access'
		});
		expect(decoded.payload.jti).toEqual(expect.any(String));
		expect(decoded.payload.iat).toEqual(expect.any(Number));
		expect(decoded.payload.nbf).toBe(decoded.payload.iat);
		expect(
			(decoded.payload.exp as number) - (decoded.payload.iat as number)
		).toBe(900);
		expect(service.verifyAccessToken(token)).toEqual(decoded.payload);
	});

	it.each([
		['algorithm', { algorithm: 'RS512' as const }],
		['audience', { audience: 'another-audience' }],
		['issuer', { issuer: 'https://another-issuer.test' }],
		['token type', { tokenType: 'refresh' }],
		['protected-header type', { headerType: 'JWT' }],
		['protected-header kid', { headerKid: '' }]
	])('rejects a token with the wrong %s', (_name, overrides) => {
		const token = signTestToken(activeKey, overrides);

		expect(() => service.verifyAccessToken(token)).toThrow(
			'Invalid access token'
		);
	});

	it('rejects a token signed by another key under the active kid', () => {
		const token = signTestToken(previousKey, {
			headerKid: activeKey.publicJwk.kid
		});

		expect(() => service.verifyAccessToken(token)).toThrow(
			'Invalid access token'
		);
	});

	it.each([
		['empty roles', { roles: [] }],
		['duplicate roles', { roles: [Role.USER, Role.USER] }],
		['an excessive token lifetime', { expiresInSeconds: 901 }]
	])('rejects a token with %s', (_name, overrides) => {
		const token = signTestToken(activeKey, overrides);

		expect(() => service.verifyAccessToken(token)).toThrow(
			'Invalid access token'
		);
	});

	it('normalizes duplicate roles when issuing a token', () => {
		const token = service.issueAccessToken(
			'user-id',
			[Role.USER, Role.USER],
			randomUUID()
		);
		const payload = service.verifyAccessToken(token);

		expect(payload.roles).toEqual([Role.USER]);
	});

	it('does not issue an access token without roles', () => {
		expect(() =>
			service.issueAccessToken('user-id', [], randomUUID())
		).toThrow('Cannot issue an access token without roles');
	});

	it('rejects opaque refresh tokens and legacy bearer JWTs', () => {
		const opaqueRefresh = `${randomUUID()}.${Buffer.alloc(32, 1).toString(
			'base64url'
		)}`;
		const legacyJwt = jwt.sign(
			{
				id: 'user-id',
				rights: [Role.USER],
				sessionId: randomUUID()
			},
			{ secret: 'legacy-secret', algorithm: 'HS256' }
		);

		expect(() => service.verifyAccessToken(opaqueRefresh)).toThrow(
			'Invalid access token'
		);
		expect(() => service.verifyAccessToken(legacyJwt)).toThrow(
			'Invalid access token'
		);
	});

	it('exposes only public JWKS fields', () => {
		const jwks = service.getPublicJwks();

		expect(jwks.keys).toHaveLength(2);
		for (const key of jwks.keys) {
			expect(key).toMatchObject({
				kty: 'RSA',
				use: 'sig',
				alg: 'RS256',
				key_ops: ['verify']
			});
			expect(key).not.toHaveProperty('d');
			expect(key).not.toHaveProperty('p');
			expect(key).not.toHaveProperty('q');
		}
	});

	it('fails fast when the private key does not match the active JWK', () => {
		expect(() =>
			createService(previousKey.privateKey, [activeKey.publicJwk])
		).toThrow(
			'JWT access private key does not match the active public JWK'
		);
	});

	it('fails fast when required JWT configuration is missing or malformed', () => {
		expect(() =>
			createService(activeKey.privateKey, [activeKey.publicJwk], {
				JWT_ISSUER: undefined
			})
		).toThrow('JWT_ISSUER is required');
		expect(() =>
			createService(activeKey.privateKey, [activeKey.publicJwk], {
				JWT_ACCESS_JWKS_BASE64: Buffer.from('not-json').toString('base64')
			})
		).toThrow('JWT_ACCESS_JWKS_BASE64 must contain valid JSON');
		expect(() =>
			createService(activeKey.privateKey, [activeKey.publicJwk], {
				JWT_ACCESS_TTL_SECONDS: '1801'
			})
		).toThrow(
			'JWT_ACCESS_TTL_SECONDS must be an integer between 60 and 1800'
		);
		expect(() =>
			createService(activeKey.privateKey, [activeKey.publicJwk], {
				JWT_CLOCK_TOLERANCE_SECONDS: '61'
			})
		).toThrow(
			'JWT_CLOCK_TOLERANCE_SECONDS must be an integer between 0 and 60'
		);
	});

	const createService = (
		privateKey: string,
		publicKeys: TestKeyPair['publicJwk'][],
		overrides: Record<string, string | undefined> = {}
	) => {
		const values: Record<string, string | undefined> = {
			JWT_ACCESS_PRIVATE_KEY_BASE64:
				Buffer.from(privateKey).toString('base64'),
			JWT_ACCESS_JWKS_BASE64: Buffer.from(
				JSON.stringify({ keys: publicKeys })
			).toString('base64'),
			JWT_ACCESS_ACTIVE_KID: activeKey?.publicJwk.kid ?? publicKeys[0].kid,
			JWT_ISSUER: issuer,
			JWT_AUDIENCE: audience,
			JWT_ACCESS_TTL_SECONDS: undefined,
			JWT_CLOCK_TOLERANCE_SECONDS: '5',
			...overrides
		};
		const configService = {
			get: (name: string) => values[name]
		} as ConfigService;

		return new AccessJwtService(jwt, configService);
	};

	const signTestToken = (
		key: TestKeyPair,
		overrides: {
			algorithm?: 'RS256' | 'RS512';
			audience?: string;
			issuer?: string;
			tokenType?: string;
			headerType?: string;
			headerKid?: string;
			roles?: Role[];
			expiresInSeconds?: number;
		} = {}
	) => {
		const issuedAt = Math.floor(Date.now() / 1000);

		return jwt.sign(
			{
				iss: overrides.issuer ?? issuer,
				aud: overrides.audience ?? audience,
				sub: 'user-id',
				sid: randomUUID(),
				roles: overrides.roles ?? [Role.USER],
				token_use: overrides.tokenType ?? 'access',
				jti: randomUUID(),
				iat: issuedAt,
				nbf: issuedAt,
				exp: issuedAt + (overrides.expiresInSeconds ?? 900)
			},
			{
				privateKey: key.privateKey,
				algorithm: overrides.algorithm ?? 'RS256',
				header: {
					alg: overrides.algorithm ?? 'RS256',
					typ: overrides.headerType ?? 'at+jwt',
					kid: overrides.headerKid ?? key.publicJwk.kid
				}
			}
		);
	};
});

const createKeyPair = (kid: string): TestKeyPair => {
	const pair = generateKeyPairSync('rsa', {
		modulusLength: 2048
	});
	const publicJwk = pair.publicKey.export({
		format: 'jwk'
	}) as JsonWebKey;

	return {
		privateKey: exportPrivateKey(pair.privateKey),
		publicJwk: {
			...publicJwk,
			kid,
			use: 'sig',
			alg: 'RS256',
			key_ops: ['verify']
		}
	};
};

const exportPrivateKey = (privateKey: KeyObject) =>
	privateKey.export({
		format: 'pem',
		type: 'pkcs8'
	}) as string;
