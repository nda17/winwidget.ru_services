import {
	createHash,
	generateKeyPairSync,
	sign as signEd25519,
	type KeyObject
} from 'node:crypto';
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	canonicalizeDatabaseBackupProvenanceEnvelope,
	DATABASE_BACKUP_PROVENANCE_DOMAIN,
	DatabaseBackupProvenanceService,
	parseDatabaseBackupProvenancePublicKeyring,
	type DatabaseBackupProvenanceEvidence,
	type SignedDatabaseBackupProvenance
} from './database-backup-provenance.service';

const KEY_ID = 'operations-backup-test-v1';
const PRIVATE_KEY_FILE = 'private-key.pem';
const KEYRING_FILE = 'public-keyring.json';

const evidence = (): DatabaseBackupProvenanceEvidence => ({
	backupJobId: '123e4567-e89b-42d3-a456-426614174000',
	target: 'reporting',
	databaseName: 'winwidget_reporting',
	schema: 'reporting',
	fileName: 'winwidget-reporting-db-2026-08-31T10-01-00-000Z.dump',
	fileSize: 1024,
	artifactSha256: 'a'.repeat(64),
	artifactCreatedAt: '2026-08-31T10:01:00.000Z',
	backupJobCreatedAt: '2026-08-31T10:00:00.000Z',
	servicesSha: 'b'.repeat(40),
	migrationManifestSha: 'c'.repeat(64),
	imageRevision: 'b'.repeat(40),
	pgDumpVersion: 'pg_dump (PostgreSQL) 18.1 (Debian 18.1-1.pgdg120+1)',
	pgRestoreVersion:
		'pg_restore (PostgreSQL) 18.1 (Debian 18.1-1.pgdg120+1)'
});

describe('DatabaseBackupProvenanceService', () => {
	let directory: string;
	let privateKeyPath: string;
	let keyringPath: string;
	let privateKey: KeyObject;
	let publicKeySpkiDerBase64: string;
	let service: DatabaseBackupProvenanceService;

	beforeEach(async () => {
		directory = await mkdtemp(
			join(tmpdir(), 'operations-provenance-test-')
		);
		privateKeyPath = join(directory, PRIVATE_KEY_FILE);
		keyringPath = join(directory, KEYRING_FILE);
		const pair = generateKeyPairSync('ed25519');
		privateKey = pair.privateKey;
		const privatePem = pair.privateKey.export({
			format: 'pem',
			type: 'pkcs8'
		});
		const publicDer = pair.publicKey.export({
			format: 'der',
			type: 'spki'
		});
		if (typeof privatePem !== 'string' || !Buffer.isBuffer(publicDer)) {
			throw new Error('Unexpected test key export');
		}
		publicKeySpkiDerBase64 = publicDer.toString('base64');
		await writeFile(privateKeyPath, privatePem, {
			flag: 'wx',
			mode: 0o600
		});
		await writeKeyring([{ keyId: KEY_ID, publicKeySpkiDerBase64 }]);
		service = new DatabaseBackupProvenanceService(keyringPath);
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	const writeKeyring = async (
		keys: Array<{ keyId: string; publicKeySpkiDerBase64: string }>
	) => {
		await writeFile(
			keyringPath,
			JSON.stringify({
				schemaVersion: 1,
				domain: DATABASE_BACKUP_PROVENANCE_DOMAIN,
				keys
			})
		);
	};

	it('signs a canonical domain-separated envelope and verifies without the private key file', async () => {
		const signed = await service.sign(evidence(), KEY_ID, privateKeyPath);
		await unlink(privateKeyPath);

		await expect(service.verify(signed)).resolves.toEqual(signed.envelope);
		expect(signed.envelope.domain).toBe(DATABASE_BACKUP_PROVENANCE_DOMAIN);
		expect(signed.envelope.signatureAlgorithm).toBe('Ed25519');
		expect(signed.envelopeSha256).toBe(
			createHash('sha256')
				.update(
					canonicalizeDatabaseBackupProvenanceEnvelope(signed.envelope)
				)
				.digest('hex')
		);
		expect(
			Buffer.from(signed.signatureEd25519Base64, 'base64')
		).toHaveLength(64);
	});

	it('produces the same deterministic signature for reordered evidence keys', async () => {
		const original = evidence();
		const reordered = Object.fromEntries(
			Object.entries(original).reverse()
		) as unknown as DatabaseBackupProvenanceEvidence;

		const [first, second] = await Promise.all([
			service.sign(original, KEY_ID, privateKeyPath),
			service.sign(reordered, KEY_ID, privateKeyPath)
		]);

		expect(second).toEqual(first);
	});

	it('rejects payload tampering even when an attacker recomputes the envelope SHA', async () => {
		const signed = JSON.parse(
			JSON.stringify(
				await service.sign(evidence(), KEY_ID, privateKeyPath)
			)
		) as SignedDatabaseBackupProvenance;
		signed.envelope.evidence.artifactSha256 = 'd'.repeat(64);
		signed.envelopeSha256 = createHash('sha256')
			.update(
				canonicalizeDatabaseBackupProvenanceEnvelope(signed.envelope)
			)
			.digest('hex');

		await expect(service.verify(signed)).rejects.toThrow(
			'Ed25519 signature is invalid'
		);
	});

	it('rejects a valid Ed25519 signature that omits the domain separator', async () => {
		const signed = JSON.parse(
			JSON.stringify(
				await service.sign(evidence(), KEY_ID, privateKeyPath)
			)
		) as SignedDatabaseBackupProvenance;
		const canonical = canonicalizeDatabaseBackupProvenanceEnvelope(
			signed.envelope
		);
		signed.signatureEd25519Base64 = signEd25519(
			null,
			Buffer.from(canonical),
			privateKey
		).toString('base64');

		await expect(service.verify(signed)).rejects.toThrow(
			'Ed25519 signature is invalid'
		);
	});

	it.each([
		['an extra evidence key', { ...evidence(), extra: true }],
		[
			'a database/target mismatch',
			{ ...evidence(), databaseName: 'winwidget_campaigns' }
		],
		[
			'an oversized artifact',
			{ ...evidence(), fileSize: 50 * 1024 * 1024 }
		],
		[
			'an artifact older than its job',
			{
				...evidence(),
				artifactCreatedAt: '2026-08-31T09:59:59.000Z'
			}
		],
		[
			'a revision mismatch',
			{ ...evidence(), imageRevision: 'd'.repeat(40) }
		],
		[
			'a non-PostgreSQL-18 tool',
			{ ...evidence(), pgDumpVersion: 'pg_dump 17' }
		]
	])('rejects %s before signing', async (_label, invalid) => {
		await expect(
			service.sign(invalid, KEY_ID, privateKeyPath)
		).rejects.toThrow();
	});

	it('rejects unexpected signed-envelope keys and non-canonical signatures', async () => {
		const signed = await service.sign(evidence(), KEY_ID, privateKeyPath);

		await expect(
			service.verify({ ...signed, unexpected: true })
		).rejects.toThrow('unexpected keys');
		await expect(
			service.verify({
				...signed,
				signatureEd25519Base64: `${signed.signatureEd25519Base64}\n`
			})
		).rejects.toThrow('signatureEd25519Base64 is invalid');
	});

	it('loads the tracked public-only keyring and rejects an untrusted test key', async () => {
		const trackedKeyringPath = join(
			__dirname,
			'..',
			'..',
			'restore-manifests',
			'database-backup-provenance-public-keys.json'
		);
		const tracked = parseDatabaseBackupProvenancePublicKeyring(
			JSON.parse(await readFile(trackedKeyringPath, 'utf8'))
		);
		expect(tracked.keys.length).toBeGreaterThan(0);
		expect(await readFile(trackedKeyringPath, 'utf8')).not.toContain(
			'PRIVATE KEY'
		);

		const trackedKeyringService = new DatabaseBackupProvenanceService(
			trackedKeyringPath
		);
		await expect(
			trackedKeyringService.sign(evidence(), KEY_ID, privateKeyPath)
		).rejects.toThrow('signing key is not trusted');
	});

	it('rejects malformed, duplicate and non-Ed25519 public key entries', () => {
		expect(() =>
			parseDatabaseBackupProvenancePublicKeyring({
				schemaVersion: 1,
				domain: DATABASE_BACKUP_PROVENANCE_DOMAIN,
				keys: [],
				extra: true
			})
		).toThrow('unexpected keys');
		expect(() =>
			parseDatabaseBackupProvenancePublicKeyring({
				schemaVersion: 1,
				domain: DATABASE_BACKUP_PROVENANCE_DOMAIN,
				keys: [
					{ keyId: KEY_ID, publicKeySpkiDerBase64 },
					{ keyId: KEY_ID, publicKeySpkiDerBase64 }
				]
			})
		).toThrow('contains duplicates');
		const nonEd25519 = generateKeyPairSync('x25519');
		const nonEd25519Der = nonEd25519.publicKey.export({
			format: 'der',
			type: 'spki'
		});
		expect(() =>
			parseDatabaseBackupProvenancePublicKeyring({
				schemaVersion: 1,
				domain: DATABASE_BACKUP_PROVENANCE_DOMAIN,
				keys: [
					{
						keyId: 'rsa-key',
						publicKeySpkiDerBase64:
							Buffer.from(nonEd25519Der).toString('base64')
					}
				]
			})
		).toThrow('canonical Ed25519 SPKI');
	});

	it('rejects a private key that does not match the trusted public key', async () => {
		const other = generateKeyPairSync('ed25519').privateKey.export({
			format: 'pem',
			type: 'pkcs8'
		});
		await writeFile(privateKeyPath, other, { flag: 'w', mode: 0o600 });

		await expect(
			service.sign(evidence(), KEY_ID, privateKeyPath)
		).rejects.toThrow('does not match public keyring');
	});

	it('opens the private key with O_NOFOLLOW and rejects unsafe metadata', async () => {
		const linkPath = join(directory, 'private-key-link.pem');
		await symlink(privateKeyPath, linkPath);
		await expect(
			service.sign(evidence(), KEY_ID, linkPath)
		).rejects.toThrow('private key is unavailable');

		await chmod(privateKeyPath, 0o622);
		await expect(
			service.sign(evidence(), KEY_ID, privateKeyPath)
		).rejects.toThrow('unsafe file metadata');
	});

	it('rejects non-PKCS8 and oversized private-key files', async () => {
		await writeFile(privateKeyPath, 'x'.repeat(17 * 1024), { flag: 'w' });
		await expect(
			service.sign(evidence(), KEY_ID, privateKeyPath)
		).rejects.toThrow('unsafe file metadata');

		await writeFile(privateKeyPath, 'x'.repeat(128), { flag: 'w' });
		await chmod(privateKeyPath, 0o600);
		await expect(
			service.sign(evidence(), KEY_ID, privateKeyPath)
		).rejects.toThrow('must be PKCS8 PEM');
	});
});
