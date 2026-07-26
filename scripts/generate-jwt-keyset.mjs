import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	sign,
	verify
} from 'node:crypto';
import {
	chmod,
	readFile,
	rename,
	stat,
	unlink,
	writeFile
} from 'node:fs/promises';
import { resolve } from 'node:path';

const parseArguments = values => {
	const result = new Map();

	for (let index = 0; index < values.length; index += 1) {
		const argument = values[index];
		if (argument === '--') continue;
		if (!argument.startsWith('--')) {
			throw new Error(`Unexpected argument: ${argument}`);
		}

		const separatorIndex = argument.indexOf('=');
		if (separatorIndex !== -1) {
			result.set(
				argument.slice(2, separatorIndex),
				argument.slice(separatorIndex + 1)
			);
			continue;
		}

		const name = argument.slice(2);
		const value = values[index + 1];
		if (!value || value.startsWith('--')) {
			throw new Error(`Missing value for --${name}`);
		}

		result.set(name, value);
		index += 1;
	}

	return result;
};

const requireArgument = (argumentsMap, name) => {
	const value = argumentsMap.get(name)?.trim();
	if (!value) {
		throw new Error(`Missing required --${name}`);
	}
	return value;
};

const parseEnv = content => {
	const values = new Map();

	for (const [index, line] of content.split(/\r?\n/).entries()) {
		const match = line.match(
			/^[\t ]*([A-Za-z_][A-Za-z0-9_]*)[\t ]*=(.*)$/
		);
		if (!match) continue;
		if (values.has(match[1])) {
			throw new Error(
				`Duplicate environment key ${match[1]} at line ${index + 1}`
			);
		}

		let value = match[2].trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		values.set(match[1], value);
	}

	return values;
};

const replaceEnvValues = (content, updates, removedKeys = []) => {
	const managedKeys = new Set([...updates.keys(), ...removedKeys]);
	const lines = content.split(/\r?\n/);
	let insertionIndex = lines.findIndex(line => {
		const match = line.match(/^[\t ]*([A-Za-z_][A-Za-z0-9_]*)[\t ]*=/);
		return match ? managedKeys.has(match[1]) : false;
	});

	if (insertionIndex === -1) {
		insertionIndex = lines.length;
	}

	const retainedLines = [];
	let retainedBeforeInsertion = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index].match(
			/^[\t ]*([A-Za-z_][A-Za-z0-9_]*)[\t ]*=/
		);
		if (match && managedKeys.has(match[1])) {
			continue;
		}
		if (index < insertionIndex) retainedBeforeInsertion += 1;
		retainedLines.push(lines[index]);
	}

	const replacementLines = [...updates].map(
		([name, value]) => `${name}=${value}`
	);
	retainedLines.splice(retainedBeforeInsertion, 0, ...replacementLines);

	return `${retainedLines.join('\n').replace(/\n+$/, '')}\n`;
};

const writeEnvAtomically = async (filePath, content) => {
	const absolutePath = resolve(filePath);
	await stat(absolutePath);
	const temporaryPath = `${absolutePath}.jwt-${process.pid}-${Date.now()}`;

	try {
		await writeFile(temporaryPath, content, {
			encoding: 'utf8',
			mode: 0o600
		});
		await rename(temporaryPath, absolutePath);
		await chmod(absolutePath, 0o600);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
};

const decodePreviousKeys = (backendEnv, keepPrevious) => {
	if (keepPrevious === 0) return [];

	const encodedJwks = backendEnv.get('JWT_ACCESS_JWKS_BASE64');
	if (!encodedJwks) return [];

	try {
		const parsed = JSON.parse(
			Buffer.from(encodedJwks, 'base64').toString('utf8')
		);
		if (!Array.isArray(parsed?.keys)) return [];

		return parsed.keys
			.filter(
				key =>
					key &&
					key.kty === 'RSA' &&
					key.use === 'sig' &&
					key.alg === 'RS256' &&
					typeof key.kid === 'string' &&
					key.kid.length > 0 &&
					typeof key.n === 'string' &&
					typeof key.e === 'string' &&
					!('d' in key)
			)
			.slice(0, keepPrevious);
	} catch {
		throw new Error(
			'Existing JWT_ACCESS_JWKS_BASE64 is not a valid public JWKS'
		);
	}
};

const argumentsMap = parseArguments(process.argv.slice(2));
const backendEnvPath = requireArgument(argumentsMap, 'backend-env');
const frontendEnvPath = argumentsMap.get('frontend-env')?.trim();
const issuer = requireArgument(argumentsMap, 'issuer');
const audience = requireArgument(argumentsMap, 'audience');
const publicJwksUrl = argumentsMap.get('jwks-url')?.trim();
const kidPrefix = requireArgument(argumentsMap, 'kid-prefix');
const keepPrevious = Number.parseInt(
	argumentsMap.get('keep-previous') ?? '1',
	10
);

if (
	!Number.isInteger(keepPrevious) ||
	keepPrevious < 0 ||
	keepPrevious > 3
) {
	throw new Error('--keep-previous must be an integer between 0 and 3');
}
if (!/^[A-Za-z0-9._:-]{1,80}$/.test(kidPrefix)) {
	throw new Error(
		'--kid-prefix must contain 1-80 safe alphanumeric/._:- characters'
	);
}
if (frontendEnvPath && !publicJwksUrl) {
	throw new Error('--jwks-url is required together with --frontend-env');
}

const backendContent = await readFile(resolve(backendEnvPath), 'utf8');
const backendEnv = parseEnv(backendContent);
const previousKeys = decodePreviousKeys(backendEnv, keepPrevious);
const timestamp = new Date()
	.toISOString()
	.replace(/[-:]/g, '')
	.replace(/\.\d{3}Z$/, 'Z');
const kid = `${kidPrefix}-${timestamp}-${randomBytes(4).toString('hex')}`;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 3072,
	publicExponent: 0x10001
});
const privatePem = privateKey.export({
	format: 'pem',
	type: 'pkcs8'
});
const publicJwk = {
	...publicKey.export({ format: 'jwk' }),
	kid,
	use: 'sig',
	alg: 'RS256',
	key_ops: ['verify']
};
const jwks = {
	keys: [
		publicJwk,
		...previousKeys.filter(previousKey => previousKey.kid !== kid)
	]
};

const validationPayload = randomBytes(64);
const signature = sign(
	'sha256',
	validationPayload,
	createPrivateKey(privatePem)
);
const exportedPublicKey = createPublicKey({
	key: publicJwk,
	format: 'jwk'
});
if (!verify('sha256', validationPayload, exportedPublicKey, signature)) {
	throw new Error('Generated private key does not match the public JWK');
}

const backendUpdates = new Map([
	[
		'JWT_ACCESS_PRIVATE_KEY_BASE64',
		Buffer.from(privatePem).toString('base64')
	],
	[
		'JWT_ACCESS_JWKS_BASE64',
		Buffer.from(JSON.stringify(jwks)).toString('base64')
	],
	['JWT_ACCESS_ACTIVE_KID', kid],
	['JWT_ISSUER', issuer],
	['JWT_AUDIENCE', audience],
	['JWT_ACCESS_TTL_SECONDS', '900'],
	['JWT_CLOCK_TOLERANCE_SECONDS', '5']
]);
await writeEnvAtomically(
	backendEnvPath,
	replaceEnvValues(backendContent, backendUpdates, ['JWT_SECRET'])
);

if (frontendEnvPath) {
	const frontendContent = await readFile(resolve(frontendEnvPath), 'utf8');
	parseEnv(frontendContent);
	const frontendUpdates = new Map([
		['JWT_JWKS_URL', publicJwksUrl],
		['JWT_ISSUER', issuer],
		['JWT_AUDIENCE', audience],
		['JWT_CLOCK_TOLERANCE_SECONDS', '5'],
		['JWT_MAX_TOKEN_LIFETIME_SECONDS', '900']
	]);
	await writeEnvAtomically(
		frontendEnvPath,
		replaceEnvValues(frontendContent, frontendUpdates, ['JWT_SECRET'])
	);
}

console.log(
	`Generated RS256 key ${kid}; private material was written only to ${resolve(backendEnvPath)}`
);
