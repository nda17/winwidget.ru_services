import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { AccessJwtService } from './access-jwt.service';

function key(kid: string) {
	const pair = generateKeyPairSync('rsa', { modulusLength: 2_048 });
	return {
		privateKey: pair.privateKey
			.export({ format: 'pem', type: 'pkcs8' })
			.toString(),
		publicJwk: {
			...(pair.publicKey.export({ format: 'jwk' }) as JsonWebKey),
			kid,
			use: 'sig',
			alg: 'RS256',
			key_ops: ['verify']
		}
	};
}

function service(
	privateKey: string,
	keys: Array<Record<string, unknown>>,
	activeKid = String(keys[0]?.kid)
) {
	const values: Record<string, string> = {
		JWT_ACCESS_PRIVATE_KEY_BASE64:
			Buffer.from(privateKey).toString('base64'),
		JWT_ACCESS_JWKS_BASE64: Buffer.from(JSON.stringify({ keys })).toString(
			'base64'
		),
		JWT_ACCESS_ACTIVE_KID: activeKid,
		JWT_ISSUER: 'https://identity.winwidget.ru',
		JWT_AUDIENCE: 'winwidget-api'
	};
	return new AccessJwtService(new JwtService(), {
		get: (name: string) => values[name]
	} as ConfigService);
}

describe('Identity access JWT key configuration', () => {
	it('fails closed on duplicate kid values before building the verification map', () => {
		const active = key('active-key');
		const other = key('active-key');
		expect(() =>
			service(active.privateKey, [active.publicJwk, other.publicJwk])
		).toThrow('duplicate kid values');
	});

	it.each([
		['sign-only', ['sign']],
		['missing verify', []],
		['verify plus sign', ['verify', 'sign']],
		['wrong type', 'verify']
	])('rejects incompatible optional key_ops: %s', (_label, keyOps) => {
		const active = key('active-key');
		expect(() =>
			service(active.privateKey, [
				{ ...active.publicJwk, key_ops: keyOps }
			])
		).toThrow('key_ops must contain only verify');
	});

	it('publishes a sanitized verify-only JWK', () => {
		const active = key('active-key');
		const value = service(active.privateKey, [
			{ ...active.publicJwk, unrelated: 'must-not-leak' }
		]);
		expect(value.getPublicJwks().keys).toEqual([
			expect.objectContaining({
				kid: 'active-key',
				kty: 'RSA',
				alg: 'RS256',
				use: 'sig',
				key_ops: ['verify']
			})
		]);
		expect(value.getPublicJwks().keys[0]).not.toHaveProperty('unrelated');
	});
});
