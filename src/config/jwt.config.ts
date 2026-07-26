import {
	createPrivateKey,
	createPublicKey,
	type JsonWebKey,
	type KeyObject
} from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtModuleOptions } from '@nestjs/jwt';

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900;
const MINIMUM_RSA_MODULUS_LENGTH = 2048;
const KID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PRIVATE_JWK_FIELDS = [
	'd',
	'p',
	'q',
	'dp',
	'dq',
	'qi',
	'oth'
] as const;

export interface AccessJwtPublicJwk {
	kty: 'RSA';
	kid: string;
	use: 'sig';
	alg: 'RS256';
	n: string;
	e: string;
	key_ops?: string[];
}

export interface AccessJwtConfig {
	privateKey: string;
	activeKid: string;
	issuer: string;
	audience: string;
	ttlSeconds: number;
	clockToleranceSeconds: number;
	publicJwks: {
		keys: AccessJwtPublicJwk[];
	};
	publicKeysByKid: ReadonlyMap<string, string>;
}

export const getJwtConfig = async (
	configService: ConfigService
): Promise<JwtModuleOptions> => {
	const config = loadAccessJwtConfig(configService);

	return {
		privateKey: config.privateKey,
		signOptions: {
			algorithm: 'RS256'
		}
	};
};

export const loadAccessJwtConfig = (
	configService: ConfigService
): AccessJwtConfig => {
	const privateKey = decodeBase64(
		requireConfig(configService, 'JWT_ACCESS_PRIVATE_KEY_BASE64'),
		'JWT_ACCESS_PRIVATE_KEY_BASE64'
	).toString('utf8');
	const jwksValue = decodeBase64(
		requireConfig(configService, 'JWT_ACCESS_JWKS_BASE64'),
		'JWT_ACCESS_JWKS_BASE64'
	).toString('utf8');
	const activeKid = requireConfig(configService, 'JWT_ACCESS_ACTIVE_KID');
	const issuer = requireConfig(configService, 'JWT_ISSUER');
	const audience = requireConfig(configService, 'JWT_AUDIENCE');
	const ttlSeconds = readIntegerInRange(
		configService.get<string>('JWT_ACCESS_TTL_SECONDS')?.trim() ||
			`${DEFAULT_ACCESS_TOKEN_TTL_SECONDS}`,
		'JWT_ACCESS_TTL_SECONDS',
		60,
		1800
	);
	const clockToleranceSeconds = readIntegerInRange(
		requireConfig(configService, 'JWT_CLOCK_TOLERANCE_SECONDS'),
		'JWT_CLOCK_TOLERANCE_SECONDS',
		0,
		60
	);
	const privateKeyObject = parsePrivateKey(privateKey);
	const publicJwks = parsePublicJwks(jwksValue);
	const publicKeysByKid = new Map(
		publicJwks.keys.map(jwk => [jwk.kid, publicKeyToPem(jwk)])
	);
	const activePublicKey = publicKeysByKid.get(activeKid);

	if (!activePublicKey) {
		throw new Error(
			'JWT_ACCESS_ACTIVE_KID must reference a key from JWT_ACCESS_JWKS_BASE64'
		);
	}

	assertPrivateKeyMatchesActivePublicKey(
		privateKeyObject,
		activePublicKey
	);

	return {
		privateKey,
		activeKid,
		issuer,
		audience,
		ttlSeconds,
		clockToleranceSeconds,
		publicJwks,
		publicKeysByKid
	};
};

const requireConfig = (configService: ConfigService, name: string) => {
	const value = configService.get<string>(name)?.trim();

	if (!value) {
		throw new Error(`${name} is required`);
	}

	return value;
};

const decodeBase64 = (value: string, name: string) => {
	const withoutPadding = value.replace(/=+$/, '');

	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
		throw new Error(`${name} must be valid base64`);
	}

	const decoded = Buffer.from(value, 'base64');
	const canonicalValue = decoded.toString('base64').replace(/=+$/, '');

	if (!decoded.length || canonicalValue !== withoutPadding) {
		throw new Error(`${name} must be valid base64`);
	}

	return decoded;
};

const readIntegerInRange = (
	value: string,
	name: string,
	min: number,
	max: number
) => {
	const parsed = Number(value);

	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(
			`${name} must be an integer between ${min} and ${max}`
		);
	}

	return parsed;
};

const parsePrivateKey = (privateKey: string) => {
	let key: KeyObject;

	try {
		key = createPrivateKey(privateKey);
	} catch {
		throw new Error(
			'JWT_ACCESS_PRIVATE_KEY_BASE64 must contain a valid private key'
		);
	}

	assertRsaKey(key, 'JWT_ACCESS_PRIVATE_KEY_BASE64');
	return key;
};

const parsePublicJwks = (value: string): AccessJwtConfig['publicJwks'] => {
	let parsed: unknown;

	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error('JWT_ACCESS_JWKS_BASE64 must contain valid JSON');
	}

	if (
		!isRecord(parsed) ||
		!Array.isArray(parsed.keys) ||
		parsed.keys.length === 0
	) {
		throw new Error(
			'JWT_ACCESS_JWKS_BASE64 must contain a non-empty JWKS keys array'
		);
	}

	const keys = parsed.keys.map(parsePublicJwk);
	const uniqueKids = new Set(keys.map(key => key.kid));

	if (uniqueKids.size !== keys.length) {
		throw new Error(
			'JWT_ACCESS_JWKS_BASE64 contains duplicate kid values'
		);
	}

	return { keys };
};

const parsePublicJwk = (value: unknown): AccessJwtPublicJwk => {
	if (
		!isRecord(value) ||
		value.kty !== 'RSA' ||
		value.use !== 'sig' ||
		value.alg !== 'RS256' ||
		typeof value.kid !== 'string' ||
		!KID_PATTERN.test(value.kid) ||
		typeof value.n !== 'string' ||
		!value.n ||
		typeof value.e !== 'string' ||
		!value.e ||
		PRIVATE_JWK_FIELDS.some(field => field in value)
	) {
		throw new Error(
			'JWT_ACCESS_JWKS_BASE64 must contain public RSA RS256 signing keys with kid'
		);
	}

	if (
		value.key_ops !== undefined &&
		(!Array.isArray(value.key_ops) ||
			!value.key_ops.every(operation => typeof operation === 'string') ||
			!value.key_ops.includes('verify') ||
			value.key_ops.some(operation => operation !== 'verify'))
	) {
		throw new Error('JWT access JWK key_ops must contain only verify');
	}

	const jwk: AccessJwtPublicJwk = {
		kty: 'RSA',
		kid: value.kid,
		use: 'sig',
		alg: 'RS256',
		n: value.n,
		e: value.e
	};

	if (value.key_ops) {
		jwk.key_ops = ['verify'];
	}

	return jwk;
};

const publicKeyToPem = (jwk: AccessJwtPublicJwk) => {
	let key: KeyObject;

	try {
		key = createPublicKey({
			key: jwk as unknown as JsonWebKey,
			format: 'jwk'
		});
	} catch {
		throw new Error(`JWT access JWK ${jwk.kid} is malformed`);
	}

	assertRsaKey(key, `JWT access JWK ${jwk.kid}`);

	return key.export({
		format: 'pem',
		type: 'spki'
	}) as string;
};

const assertRsaKey = (key: KeyObject, name: string) => {
	if (
		key.asymmetricKeyType !== 'rsa' ||
		(key.asymmetricKeyDetails?.modulusLength ?? 0) <
			MINIMUM_RSA_MODULUS_LENGTH
	) {
		throw new Error(`${name} must be an RSA key of at least 2048 bits`);
	}
};

const assertPrivateKeyMatchesActivePublicKey = (
	privateKey: KeyObject,
	activePublicKey: string
) => {
	const derivedPublicKey = createPublicKey(privateKey).export({
		format: 'der',
		type: 'spki'
	});
	const configuredPublicKey = createPublicKey(activePublicKey).export({
		format: 'der',
		type: 'spki'
	});

	if (!derivedPublicKey.equals(configuredPublicKey)) {
		throw new Error(
			'JWT access private key does not match the active public JWK'
		);
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
