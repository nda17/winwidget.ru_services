import { Injectable, Inject, Optional } from '@nestjs/common';
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as signEd25519,
	timingSafeEqual,
	verify as verifyEd25519,
	type KeyObject
} from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	DATABASE_RESTORE_TARGETS,
	type DatabaseRestoreTarget
} from '../restore/database-restore.contract';

export const DATABASE_BACKUP_PROVENANCE_DOMAIN =
	'winwidget.operations.database-backup-provenance.v1';
export const DATABASE_BACKUP_PROVENANCE_SCHEMA_VERSION = 1 as const;
export const DATABASE_BACKUP_PROVENANCE_ALGORITHM = 'Ed25519' as const;
export const DATABASE_BACKUP_PROVENANCE_PUBLIC_KEYRING_PATH = Symbol(
	'DATABASE_BACKUP_PROVENANCE_PUBLIC_KEYRING_PATH'
);

const DEFAULT_PUBLIC_KEYRING_PATH = join(
	process.cwd(),
	'restore-manifests',
	'database-backup-provenance-public-keys.json'
);
const MAX_PUBLIC_KEYRING_BYTES = 64 * 1024;
const MAX_PUBLIC_KEYS = 16;
const MIN_PRIVATE_KEY_BYTES = 64;
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const PRIVATE_KEY_HEADER = Buffer.from('-----BEGIN PRIVATE KEY-----\n');
const PRIVATE_KEY_FOOTER = Buffer.from('-----END PRIVATE KEY-----');
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SERVICES_SHA_PATTERN = /^[0-9a-f]{40}$/;
const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}\.dump$/;
const ISO_TIMESTAMP_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const TARGET_DATABASES: Readonly<
	Record<DatabaseRestoreTarget, { databaseName: string; schema: string }>
> = Object.freeze({
	'notification-delivery': Object.freeze({
		databaseName: 'winwidget_notification_delivery',
		schema: 'notification_delivery'
	}),
	campaigns: Object.freeze({
		databaseName: 'winwidget_campaigns',
		schema: 'campaigns'
	}),
	reporting: Object.freeze({
		databaseName: 'winwidget_reporting',
		schema: 'reporting'
	}),
	widgets: Object.freeze({
		databaseName: 'winwidget_widgets',
		schema: 'widgets'
	}),
	identity: Object.freeze({
		databaseName: 'winwidget_identity',
		schema: 'identity'
	}),
	platform: Object.freeze({
		databaseName: 'winwidget_platform',
		schema: 'platform'
	}),
	support: Object.freeze({
		databaseName: 'winwidget_support',
		schema: 'support'
	})
});

export interface DatabaseBackupProvenanceEvidence {
	backupJobId: string;
	target: DatabaseRestoreTarget;
	databaseName: string;
	schema: string;
	fileName: string;
	fileSize: number;
	artifactSha256: string;
	artifactCreatedAt: string;
	backupJobCreatedAt: string;
	servicesSha: string;
	migrationManifestSha: string;
	imageRevision: string;
	pgDumpVersion: string;
	pgRestoreVersion: string;
}

export interface DatabaseBackupProvenanceEnvelope {
	domain: typeof DATABASE_BACKUP_PROVENANCE_DOMAIN;
	schemaVersion: typeof DATABASE_BACKUP_PROVENANCE_SCHEMA_VERSION;
	signatureAlgorithm: typeof DATABASE_BACKUP_PROVENANCE_ALGORITHM;
	keyId: string;
	evidence: DatabaseBackupProvenanceEvidence;
}

export interface SignedDatabaseBackupProvenance {
	envelope: DatabaseBackupProvenanceEnvelope;
	envelopeSha256: string;
	signatureEd25519Base64: string;
}

export interface DatabaseBackupProvenancePublicKey {
	keyId: string;
	publicKeySpkiDerBase64: string;
}

export interface DatabaseBackupProvenancePublicKeyring {
	schemaVersion: typeof DATABASE_BACKUP_PROVENANCE_SCHEMA_VERSION;
	domain: typeof DATABASE_BACKUP_PROVENANCE_DOMAIN;
	keys: ReadonlyArray<DatabaseBackupProvenancePublicKey>;
}

const EVIDENCE_KEYS = [
	'artifactCreatedAt',
	'artifactSha256',
	'backupJobCreatedAt',
	'backupJobId',
	'databaseName',
	'fileName',
	'fileSize',
	'imageRevision',
	'migrationManifestSha',
	'pgDumpVersion',
	'pgRestoreVersion',
	'schema',
	'servicesSha',
	'target'
] as const;

const ENVELOPE_KEYS = [
	'domain',
	'evidence',
	'keyId',
	'schemaVersion',
	'signatureAlgorithm'
] as const;

export const parseDatabaseBackupProvenanceEvidence = (
	value: unknown
): DatabaseBackupProvenanceEvidence => {
	const record = exactRecord(
		value,
		EVIDENCE_KEYS,
		'backup provenance evidence'
	);
	const target = restoreTarget(record.target);
	const expected = TARGET_DATABASES[target];
	const databaseName = boundedString(
		record.databaseName,
		'databaseName',
		1,
		80
	);
	const schema = boundedString(record.schema, 'schema', 1, 63);
	if (
		databaseName !== expected.databaseName ||
		schema !== expected.schema
	) {
		throw new Error('Backup provenance database binding is invalid');
	}
	const fileName = boundedString(record.fileName, 'fileName', 1, 185);
	if (
		!FILE_NAME_PATTERN.test(fileName) ||
		!fileName.startsWith(`winwidget-${target}-db-`)
	) {
		throw new Error('Backup provenance fileName is invalid');
	}
	if (
		!Number.isSafeInteger(record.fileSize) ||
		Number(record.fileSize) < 5 ||
		Number(record.fileSize) > DATABASE_RESTORE_MAX_FILE_SIZE_BYTES
	) {
		throw new Error('Backup provenance fileSize is invalid');
	}
	const artifactCreatedAt = timestamp(
		record.artifactCreatedAt,
		'artifactCreatedAt'
	);
	const backupJobCreatedAt = timestamp(
		record.backupJobCreatedAt,
		'backupJobCreatedAt'
	);
	if (Date.parse(artifactCreatedAt) < Date.parse(backupJobCreatedAt)) {
		throw new Error('Backup provenance timestamps are out of order');
	}
	const servicesSha = patternString(
		record.servicesSha,
		'servicesSha',
		SERVICES_SHA_PATTERN
	);
	const imageRevision = patternString(
		record.imageRevision,
		'imageRevision',
		SERVICES_SHA_PATTERN
	);
	if (servicesSha !== imageRevision) {
		throw new Error('Backup provenance image revision binding is invalid');
	}

	return Object.freeze({
		backupJobId: patternString(
			record.backupJobId,
			'backupJobId',
			UUID_V4_PATTERN
		),
		target,
		databaseName,
		schema,
		fileName,
		fileSize: Number(record.fileSize),
		artifactSha256: patternString(
			record.artifactSha256,
			'artifactSha256',
			SHA256_PATTERN
		),
		artifactCreatedAt,
		backupJobCreatedAt,
		servicesSha,
		migrationManifestSha: patternString(
			record.migrationManifestSha,
			'migrationManifestSha',
			SHA256_PATTERN
		),
		imageRevision,
		pgDumpVersion: postgresToolVersion(record.pgDumpVersion, 'pg_dump'),
		pgRestoreVersion: postgresToolVersion(
			record.pgRestoreVersion,
			'pg_restore'
		)
	});
};

export const parseDatabaseBackupProvenanceEnvelope = (
	value: unknown
): DatabaseBackupProvenanceEnvelope => {
	const record = exactRecord(
		value,
		ENVELOPE_KEYS,
		'backup provenance envelope'
	);
	if (
		record.domain !== DATABASE_BACKUP_PROVENANCE_DOMAIN ||
		record.schemaVersion !== DATABASE_BACKUP_PROVENANCE_SCHEMA_VERSION ||
		record.signatureAlgorithm !== DATABASE_BACKUP_PROVENANCE_ALGORITHM
	) {
		throw new Error('Backup provenance envelope contract is invalid');
	}
	return Object.freeze({
		domain: DATABASE_BACKUP_PROVENANCE_DOMAIN,
		schemaVersion: DATABASE_BACKUP_PROVENANCE_SCHEMA_VERSION,
		signatureAlgorithm: DATABASE_BACKUP_PROVENANCE_ALGORITHM,
		keyId: patternString(record.keyId, 'keyId', KEY_ID_PATTERN),
		evidence: parseDatabaseBackupProvenanceEvidence(record.evidence)
	});
};

export const parseDatabaseBackupProvenancePublicKeyring = (
	value: unknown
): DatabaseBackupProvenancePublicKeyring => {
	const record = exactRecord(
		value,
		['domain', 'keys', 'schemaVersion'],
		'backup provenance public keyring'
	);
	if (
		record.domain !== DATABASE_BACKUP_PROVENANCE_DOMAIN ||
		record.schemaVersion !== DATABASE_BACKUP_PROVENANCE_SCHEMA_VERSION ||
		!Array.isArray(record.keys) ||
		record.keys.length > MAX_PUBLIC_KEYS
	) {
		throw new Error(
			'Backup provenance public keyring contract is invalid'
		);
	}
	const keyIds = new Set<string>();
	const publicKeys = new Set<string>();
	const keys = record.keys.map((value, index) => {
		const key = exactRecord(
			value,
			['keyId', 'publicKeySpkiDerBase64'],
			`backup provenance public key ${index}`
		);
		const keyId = patternString(key.keyId, 'keyId', KEY_ID_PATTERN);
		const publicKeySpkiDerBase64 = canonicalBase64(
			key.publicKeySpkiDerBase64,
			'publicKeySpkiDerBase64',
			32,
			128
		);
		if (keyIds.has(keyId) || publicKeys.has(publicKeySpkiDerBase64)) {
			throw new Error(
				'Backup provenance public keyring contains duplicates'
			);
		}
		const publicKeyDer = Buffer.from(publicKeySpkiDerBase64, 'base64');
		let publicKey: KeyObject;
		try {
			publicKey = createPublicKey({
				key: publicKeyDer,
				format: 'der',
				type: 'spki'
			});
		} catch {
			throw new Error('Backup provenance public key is invalid');
		}
		const canonicalDer = publicKey.export({ format: 'der', type: 'spki' });
		if (
			publicKey.asymmetricKeyType !== 'ed25519' ||
			!Buffer.isBuffer(canonicalDer) ||
			!buffersEqual(canonicalDer, publicKeyDer)
		) {
			throw new Error(
				'Backup provenance public key must be canonical Ed25519 SPKI'
			);
		}
		keyIds.add(keyId);
		publicKeys.add(publicKeySpkiDerBase64);
		return Object.freeze({ keyId, publicKeySpkiDerBase64 });
	});
	return Object.freeze({
		schemaVersion: DATABASE_BACKUP_PROVENANCE_SCHEMA_VERSION,
		domain: DATABASE_BACKUP_PROVENANCE_DOMAIN,
		keys: Object.freeze(keys)
	});
};

export const canonicalizeDatabaseBackupProvenanceEnvelope = (
	value: unknown
): string => canonicalize(parseDatabaseBackupProvenanceEnvelope(value));

@Injectable()
export class DatabaseBackupProvenanceService {
	private readonly publicKeyringPath: string;

	constructor(
		@Optional()
		@Inject(DATABASE_BACKUP_PROVENANCE_PUBLIC_KEYRING_PATH)
		publicKeyringPath?: string
	) {
		this.publicKeyringPath =
			publicKeyringPath ?? DEFAULT_PUBLIC_KEYRING_PATH;
	}

	async sign(
		evidenceInput: unknown,
		keyIdInput: string,
		privateKeyFile: string
	): Promise<SignedDatabaseBackupProvenance> {
		const evidence = parseDatabaseBackupProvenanceEvidence(evidenceInput);
		const keyId = patternString(keyIdInput, 'keyId', KEY_ID_PATTERN);
		const privateKey = await this.signingKey(keyId, privateKeyFile);
		const envelope = Object.freeze({
			domain: DATABASE_BACKUP_PROVENANCE_DOMAIN,
			schemaVersion: DATABASE_BACKUP_PROVENANCE_SCHEMA_VERSION,
			signatureAlgorithm: DATABASE_BACKUP_PROVENANCE_ALGORITHM,
			keyId,
			evidence
		});
		const canonicalEnvelope = canonicalize(envelope);
		const envelopeSha256 = sha256(canonicalEnvelope);
		const signature = signEd25519(
			null,
			domainSeparatedMessage(canonicalEnvelope),
			privateKey
		);
		return Object.freeze({
			envelope,
			envelopeSha256,
			signatureEd25519Base64: signature.toString('base64')
		});
	}

	async assertSigningKey(
		keyIdInput: string,
		privateKeyFile: string
	): Promise<void> {
		await this.signingKey(keyIdInput, privateKeyFile);
	}

	private async signingKey(
		keyIdInput: string,
		privateKeyFile: string
	): Promise<KeyObject> {
		const keyId = patternString(keyIdInput, 'keyId', KEY_ID_PATTERN);
		const publicKey = await this.publicKey(keyId);
		const privateKey = await this.readPrivateKey(privateKeyFile);
		const derivedSpki = createPublicKey(privateKey).export({
			format: 'der',
			type: 'spki'
		});
		if (
			!Buffer.isBuffer(derivedSpki) ||
			!buffersEqual(derivedSpki, publicKey.der)
		) {
			throw new Error(
				'Backup provenance private key does not match public keyring'
			);
		}
		return privateKey;
	}

	async verify(value: unknown): Promise<DatabaseBackupProvenanceEnvelope> {
		const record = exactRecord(
			value,
			['envelope', 'envelopeSha256', 'signatureEd25519Base64'],
			'signed backup provenance'
		);
		const envelope = parseDatabaseBackupProvenanceEnvelope(
			record.envelope
		);
		const envelopeSha256 = patternString(
			record.envelopeSha256,
			'envelopeSha256',
			SHA256_PATTERN
		);
		const signature = Buffer.from(
			canonicalBase64(
				record.signatureEd25519Base64,
				'signatureEd25519Base64',
				64,
				64
			),
			'base64'
		);
		const canonicalEnvelope = canonicalize(envelope);
		if (!hexEqual(envelopeSha256, sha256(canonicalEnvelope))) {
			throw new Error('Backup provenance envelope SHA-256 is invalid');
		}
		const publicKey = await this.publicKey(envelope.keyId);
		if (
			!verifyEd25519(
				null,
				domainSeparatedMessage(canonicalEnvelope),
				publicKey.key,
				signature
			)
		) {
			throw new Error('Backup provenance Ed25519 signature is invalid');
		}
		return envelope;
	}

	private async publicKey(
		keyId: string
	): Promise<{ key: KeyObject; der: Buffer }> {
		const contents = await readBoundedRegularFile(
			this.publicKeyringPath,
			MAX_PUBLIC_KEYRING_BYTES,
			'Backup provenance public keyring'
		);
		let value: unknown;
		try {
			value = JSON.parse(contents.toString('utf8')) as unknown;
		} catch {
			throw new Error('Backup provenance public keyring JSON is invalid');
		}
		const keyring = parseDatabaseBackupProvenancePublicKeyring(value);
		const selected = keyring.keys.find(key => key.keyId === keyId);
		if (!selected) {
			throw new Error('Backup provenance signing key is not trusted');
		}
		const der = Buffer.from(selected.publicKeySpkiDerBase64, 'base64');
		return {
			der,
			key: createPublicKey({ key: der, format: 'der', type: 'spki' })
		};
	}

	private async readPrivateKey(path: string): Promise<KeyObject> {
		const contents = await readBoundedRegularFile(
			path,
			MAX_PRIVATE_KEY_BYTES,
			'Backup provenance private key',
			MIN_PRIVATE_KEY_BYTES,
			true
		);
		try {
			if (
				!contents
					.subarray(0, PRIVATE_KEY_HEADER.length)
					.equals(PRIVATE_KEY_HEADER) ||
				!hasPemFooter(contents)
			) {
				throw new Error('Backup provenance private key must be PKCS8 PEM');
			}
			let privateKey: KeyObject;
			try {
				privateKey = createPrivateKey(contents);
			} catch {
				throw new Error('Backup provenance private key is invalid');
			}
			if (privateKey.asymmetricKeyType !== 'ed25519') {
				throw new Error('Backup provenance private key must be Ed25519');
			}
			return privateKey;
		} finally {
			contents.fill(0);
		}
	}
}

const exactRecord = <T extends readonly string[]>(
	value: unknown,
	keys: T,
	label: string
): Record<T[number], unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${label} must be a plain object`);
	}
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error(`${label} has unexpected keys`);
	}
	return value as Record<T[number], unknown>;
};

const restoreTarget = (value: unknown): DatabaseRestoreTarget => {
	if (
		typeof value !== 'string' ||
		!DATABASE_RESTORE_TARGETS.includes(value as DatabaseRestoreTarget)
	) {
		throw new Error('Backup provenance target is invalid');
	}
	return value as DatabaseRestoreTarget;
};

const boundedString = (
	value: unknown,
	label: string,
	minimum: number,
	maximum: number
): string => {
	if (
		typeof value !== 'string' ||
		value.length < minimum ||
		value.length > maximum
	) {
		throw new Error(`Backup provenance ${label} is invalid`);
	}
	return value;
};

const patternString = (
	value: unknown,
	label: string,
	pattern: RegExp
): string => {
	const result = boundedString(value, label, 1, 256);
	if (!pattern.test(result)) {
		throw new Error(`Backup provenance ${label} is invalid`);
	}
	return result;
};

const timestamp = (value: unknown, label: string): string => {
	const result = boundedString(value, label, 24, 24);
	if (
		!ISO_TIMESTAMP_PATTERN.test(result) ||
		new Date(result).toISOString() !== result
	) {
		throw new Error(`Backup provenance ${label} is invalid`);
	}
	return result;
};

const postgresToolVersion = (
	value: unknown,
	command: 'pg_dump' | 'pg_restore'
): string => {
	const result = boundedString(value, `${command} version`, 26, 180);
	const pattern = new RegExp(
		`^${command} \\(PostgreSQL\\) 18\\.[0-9]+(?:\\.[0-9]+)?(?: \\([\\x20-\\x7e]{1,120}\\))?$`
	);
	if (!pattern.test(result)) {
		throw new Error(`Backup provenance ${command} version is invalid`);
	}
	return result;
};

const canonicalBase64 = (
	value: unknown,
	label: string,
	minimumBytes: number,
	maximumBytes: number
): string => {
	const result = boundedString(value, label, 4, maximumBytes * 2);
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(result) || result.length % 4 !== 0) {
		throw new Error(`Backup provenance ${label} is invalid`);
	}
	const decoded = Buffer.from(result, 'base64');
	if (
		decoded.length < minimumBytes ||
		decoded.length > maximumBytes ||
		decoded.toString('base64') !== result
	) {
		throw new Error(`Backup provenance ${label} is invalid`);
	}
	return result;
};

const canonicalize = (value: unknown): string => {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) {
			throw new Error(
				'Backup provenance canonical JSON number is invalid'
			);
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
			.join(',')}}`;
	}
	throw new Error('Backup provenance canonical JSON value is invalid');
};

const domainSeparatedMessage = (canonicalEnvelope: string): Buffer =>
	Buffer.concat([
		Buffer.from(DATABASE_BACKUP_PROVENANCE_DOMAIN, 'ascii'),
		Buffer.from([0]),
		Buffer.from(canonicalEnvelope, 'utf8')
	]);

const sha256 = (value: string): string =>
	createHash('sha256').update(value, 'utf8').digest('hex');

const hexEqual = (left: string, right: string): boolean =>
	buffersEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));

const buffersEqual = (left: Buffer, right: Buffer): boolean =>
	left.length === right.length && timingSafeEqual(left, right);

const hasPemFooter = (value: Buffer): boolean => {
	let end = value.length;
	while (end > 0 && (value[end - 1] === 0x0a || value[end - 1] === 0x0d))
		end--;
	return (
		end >= PRIVATE_KEY_FOOTER.length &&
		value
			.subarray(end - PRIVATE_KEY_FOOTER.length, end)
			.equals(PRIVATE_KEY_FOOTER)
	);
};

const readBoundedRegularFile = async (
	path: string,
	maximumBytes: number,
	label: string,
	minimumBytes = 2,
	privateFile = false
): Promise<Buffer> => {
	if (!isAbsolute(path) || path.includes('\0')) {
		throw new Error(`${label} path is invalid`);
	}
	let handle: FileHandle;
	try {
		handle = await open(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
		);
	} catch {
		throw new Error(`${label} is unavailable`);
	}
	try {
		const before = await handle.stat({ bigint: true });
		if (
			!before.isFile() ||
			before.size < BigInt(minimumBytes) ||
			before.size > BigInt(maximumBytes) ||
			(privateFile &&
				(before.nlink !== 1n || Number(before.mode & 0o22n) !== 0))
		) {
			throw new Error(`${label} has unsafe file metadata`);
		}
		const contents = Buffer.alloc(Number(before.size));
		let offset = 0;
		while (offset < contents.length) {
			const { bytesRead } = await handle.read(
				contents,
				offset,
				contents.length - offset,
				offset
			);
			if (bytesRead === 0)
				throw new Error(`${label} changed while reading`);
			offset += bytesRead;
		}
		const probe = Buffer.alloc(1);
		const extra = await handle.read(probe, 0, 1, contents.length);
		const after = await handle.stat({ bigint: true });
		if (
			extra.bytesRead !== 0 ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs
		) {
			contents.fill(0);
			throw new Error(`${label} changed while reading`);
		}
		return contents;
	} finally {
		await handle.close();
	}
};
