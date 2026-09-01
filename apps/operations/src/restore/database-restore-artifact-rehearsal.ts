import { ConfigService } from '@nestjs/config';
import { DatabaseRestoreRecoveryActionType } from '@prisma/operations-client';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile
} from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { DatabaseBackupProvenanceService } from '../maintenance/database-backup-provenance.service';
import { DatabaseRestoreAclService } from './database-restore-acl.service';
import { DatabaseRestoreArtifactValidatorService } from './database-restore-artifact-validator.service';
import { DatabaseRestoreExecutorService } from './database-restore-executor.service';
import { DatabaseRestoreMigrationManifestService } from './database-restore-migration-manifest.service';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import { DatabaseRestoreRecoveryExecutorService } from './database-restore-recovery-executor.service';
import {
	DATABASE_RESTORE_TARGETS,
	DatabaseRestoreTarget
} from './database-restore.contract';
import { DatabaseRestoreTargetRegistryService } from './database-restore-target-registry.service';
import { DatabaseRestoreWriterFenceService } from './database-restore-writer-fence.service';

const REHEARSAL_DOMAIN =
	'winwidget.operations.database-restore-artifact-rehearsal.v1';
const EXPECTED_ALLOW_VALUE = 'true';
const EXPECTED_INPUT_DIRECTORY = '/artifacts';
const EXPECTED_WORK_DIRECTORY = '/work';
const EXPECTED_POSTGRES_USER = 'operations_restore_artifact_superuser';
const EXPECTED_POSTGRES_DATABASE = 'operations_restore_artifact_control';
const EXPECTED_POSTGRES_PASSWORD_FILE =
	'/run/secrets/rehearsal-postgres-password';
const EXPECTED_PROCESS_UID = 1001;
const EXPECTED_PROCESS_GID = 1001;
const POSTGRES_HOST = '127.0.0.1';
const POSTGRES_PORT = 5432;
const CONTROL_COMMAND_TIMEOUT_MS = 2 * 60_000;
const SERVICES_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SIDECAR_BYTES = 64 * 1024;

type ArtifactPair = {
	target: DatabaseRestoreTarget;
	dumpPath: string;
	sidecarPath: string;
	sourceSha256: string;
	fileSize: number;
	backupJobId: string;
	provenanceEnvelopeSha256: string;
	provenanceKeyId: string;
	migrationManifestSha: string;
	pgDumpVersion: string;
	pgRestoreVersion: string;
};

type RehearsalEnvironment = {
	servicesSha: string;
	inputDirectory: string;
	workDirectory: string;
	postgresUser: string;
	postgresDatabase: string;
	postgresPasswordFile: string;
	postgresPassword: string;
};

type RehearsalRecoveryActionEvidence = {
	action: DatabaseRestoreRecoveryActionType;
	phases: string[];
	artifactSha256: string | null;
	writerFenceReleaseEvidenceSha256: string;
};

type RehearsalTargetEvidence = {
	target: DatabaseRestoreTarget;
	backupJobId: string;
	artifactSha256: string;
	provenanceEnvelopeSha256: string;
	provenanceKeyId: string;
	migrationManifestSha: string;
	fileSize: number;
	normalRestorePhases: string[];
	normalSafetyBackupSha256: string;
	recoveryActions: RehearsalRecoveryActionEvidence[];
};

const quoteIdentifier = (value: string): string =>
	`"${value.replaceAll('"', '""')}"`;

const quoteLiteral = (value: string): string =>
	`'${value.replaceAll("'", "''")}'`;

const requiredExact = (key: string, expected: string): string => {
	const value = process.env[key]?.trim();
	if (value !== expected) throw new Error(`${key} has an invalid value`);
	return value;
};

const requiredServicesSha = (): string => {
	const value = process.env.APP_REVISION?.trim() ?? '';
	if (!SERVICES_SHA_PATTERN.test(value)) {
		throw new Error('APP_REVISION must be an exact services SHA');
	}
	return value;
};

const readSecret = async (path: string): Promise<string> => {
	const handle = await open(
		path,
		fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
	);
	try {
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.size < 16 ||
			metadata.size > 4096 ||
			metadata.nlink !== 1 ||
			metadata.uid !== EXPECTED_PROCESS_UID ||
			metadata.gid !== EXPECTED_PROCESS_GID ||
			(metadata.mode & 0o777) !== 0o400
		) {
			throw new Error('Rehearsal PostgreSQL password file is unsafe');
		}
		const value = (await handle.readFile('utf8')).replace(/\r?\n$/, '');
		if (!value || value !== value.trim() || /[\u0000\r\n]/.test(value)) {
			throw new Error('Rehearsal PostgreSQL password is invalid');
		}
		return value;
	} finally {
		await handle.close();
	}
};

const canonicalDirectory = async (
	key: string,
	expected: string,
	expectedMode: number
): Promise<string> => {
	const configured = requiredExact(key, expected);
	if (!isAbsolute(configured)) throw new Error(`${key} must be absolute`);
	const metadata = await lstat(configured);
	if (
		metadata.isSymbolicLink() ||
		!metadata.isDirectory() ||
		metadata.uid !== EXPECTED_PROCESS_UID ||
		metadata.gid !== EXPECTED_PROCESS_GID ||
		(metadata.mode & 0o777) !== expectedMode
	) {
		throw new Error(`${key} must be a regular directory`);
	}
	const canonical = await realpath(configured);
	if (canonical !== expected) throw new Error(`${key} must be canonical`);
	return canonical;
};

export const readRehearsalEnvironment =
	async (): Promise<RehearsalEnvironment> => {
		requiredExact(
			'OPERATIONS_RESTORE_ARTIFACT_REHEARSAL_ALLOW_MUTATION',
			EXPECTED_ALLOW_VALUE
		);
		if (process.getuid?.() !== EXPECTED_PROCESS_UID) {
			throw new Error('Artifact rehearsal must run as the Operations UID');
		}
		if (process.getgid?.() !== EXPECTED_PROCESS_GID) {
			throw new Error('Artifact rehearsal must run as the Operations GID');
		}
		if ((await realpath(process.cwd())) !== '/app') {
			throw new Error('Artifact rehearsal must run from immutable /app');
		}
		requiredExact('DATABASE_RESTORE_ENABLED', 'false');
		const [inputDirectory, workDirectory] = await Promise.all([
			canonicalDirectory(
				'OPERATIONS_RESTORE_ARTIFACT_DIR',
				EXPECTED_INPUT_DIRECTORY,
				0o500
			),
			canonicalDirectory(
				'OPERATIONS_RESTORE_ARTIFACT_WORK_DIR',
				EXPECTED_WORK_DIRECTORY,
				0o700
			)
		]);
		const postgresUser = requiredExact(
			'OPERATIONS_RESTORE_ARTIFACT_POSTGRES_USER',
			EXPECTED_POSTGRES_USER
		);
		const postgresDatabase = requiredExact(
			'OPERATIONS_RESTORE_ARTIFACT_POSTGRES_DB',
			EXPECTED_POSTGRES_DATABASE
		);
		const postgresPasswordFile = requiredExact(
			'OPERATIONS_RESTORE_ARTIFACT_POSTGRES_PASSWORD_FILE',
			EXPECTED_POSTGRES_PASSWORD_FILE
		);
		return {
			servicesSha: requiredServicesSha(),
			inputDirectory,
			workDirectory,
			postgresUser,
			postgresDatabase,
			postgresPasswordFile,
			postgresPassword: await readSecret(postgresPasswordFile)
		};
	};

const run = async (
	command: string,
	args: string[],
	options: { password?: string; input?: string } = {}
): Promise<string> =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: {
				PATH: process.env.PATH,
				LANG: 'C',
				LC_ALL: 'C',
				...(options.password ? { PGPASSWORD: options.password } : {})
			},
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		const timeout = setTimeout(() => {
			child.kill('SIGKILL');
		}, CONTROL_COMMAND_TIMEOUT_MS);
		timeout.unref();
		child.stdout.on('data', value => {
			stdout = `${stdout}${Buffer.from(value).toString('utf8')}`.slice(
				-64 * 1024
			);
		});
		child.stderr.on('data', value => {
			stderr = `${stderr}${Buffer.from(value).toString('utf8')}`.slice(
				-64 * 1024
			);
		});
		child.once('error', error => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once('exit', code => {
			clearTimeout(timeout);
			if (code === 0) resolve(stdout.trim());
			else {
				reject(
					new Error(
						`${command} failed (${code ?? 'signal'}): ${createHash(
							'sha256'
						)
							.update(stderr || stdout)
							.digest('hex')}`
					)
				);
			}
		});
		child.stdin.on('error', () => undefined);
		child.stdin.end(options.input);
	});

const postgresArgs = (
	environment: RehearsalEnvironment,
	database = environment.postgresDatabase,
	user = environment.postgresUser
): string[] => [
	'--no-password',
	'--set',
	'ON_ERROR_STOP=1',
	'--host',
	POSTGRES_HOST,
	'--port',
	String(POSTGRES_PORT),
	'--username',
	user,
	'--dbname',
	database
];

const controlSql = async (
	environment: RehearsalEnvironment,
	sql: string,
	database = environment.postgresDatabase,
	user = environment.postgresUser,
	password = environment.postgresPassword
): Promise<void> => {
	await run(
		'psql',
		[...postgresArgs(environment, database, user), '--file=-'],
		{ password, input: sql }
	);
};

const assertPostgresIdentity = async (
	environment: RehearsalEnvironment
): Promise<string> => {
	const version = await run(
		'psql',
		[
			...postgresArgs(environment),
			'--tuples-only',
			'--no-align',
			'--command',
			`SELECT current_user || '|' || current_database() || '|' ||
				current_setting('server_version_num') || '|' ||
				(SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user) || '|' ||
				(SELECT rolcanlogin::text FROM pg_roles WHERE rolname = current_user) || '|' ||
				(SELECT (datdba = current_user::regrole)::text FROM pg_database WHERE datname = current_database()) || '|' ||
				(SELECT count(*)::text FROM pg_roles WHERE rolcanlogin AND rolsuper AND rolname <> current_user);`
		],
		{ password: environment.postgresPassword }
	);
	const fields = version.split('|');
	if (
		fields.length !== 7 ||
		fields[0] !== EXPECTED_POSTGRES_USER ||
		fields[1] !== EXPECTED_POSTGRES_DATABASE ||
		!fields[2].startsWith('18') ||
		fields[3] !== 't' ||
		fields[4] !== 't' ||
		fields[5] !== 't' ||
		fields[6] !== '0'
	) {
		throw new Error('Ephemeral PostgreSQL identity is invalid');
	}
	return fields[2];
};

const toolVersion = async (command: 'pg_dump' | 'pg_restore') => {
	const output = await run(command, ['--version']);
	if (!new RegExp(`^${command} \\(PostgreSQL\\) 18\\.`).test(output)) {
		throw new Error(`${command} must be PostgreSQL 18`);
	}
	return output;
};

const assertReadOnlyArtifact = async (
	path: string,
	expectedSize?: number
): Promise<Awaited<ReturnType<typeof lstat>>> => {
	const metadata = await lstat(path);
	if (
		metadata.isSymbolicLink() ||
		!metadata.isFile() ||
		metadata.nlink !== 1 ||
		metadata.uid !== EXPECTED_PROCESS_UID ||
		metadata.gid !== EXPECTED_PROCESS_GID ||
		(metadata.mode & 0o777) !== 0o400 ||
		(expectedSize !== undefined && metadata.size !== expectedSize)
	) {
		throw new Error('Backup artifact metadata is invalid');
	}
	return metadata;
};

export const loadArtifactPairs = async (
	environment: RehearsalEnvironment,
	provenance: DatabaseBackupProvenanceService,
	artifacts: DatabaseRestoreArtifactValidatorService,
	manifests: DatabaseRestoreMigrationManifestService,
	versions: { pgDump: string; pgRestore: string }
): Promise<ArtifactPair[]> => {
	const entries = await readdir(environment.inputDirectory, {
		withFileTypes: true
	});
	if (
		entries.length !== DATABASE_RESTORE_TARGETS.length * 2 ||
		entries.some(entry => !entry.isFile() || entry.isSymbolicLink())
	) {
		throw new Error(
			'Artifact directory must contain exactly seven file pairs'
		);
	}
	const sidecars = entries.filter(entry =>
		entry.name.endsWith('.dump.provenance.json')
	);
	if (sidecars.length !== DATABASE_RESTORE_TARGETS.length) {
		throw new Error('Artifact directory contains an invalid sidecar set');
	}
	const pairs = new Map<DatabaseRestoreTarget, ArtifactPair>();
	const backupJobIds = new Set<string>();
	for (const entry of sidecars) {
		const sidecarPath = join(environment.inputDirectory, entry.name);
		const sidecarMetadata = await assertReadOnlyArtifact(sidecarPath);
		if (
			sidecarMetadata.size < 2 ||
			sidecarMetadata.size > MAX_SIDECAR_BYTES
		) {
			throw new Error('Backup provenance sidecar size is invalid');
		}
		let signed: unknown;
		try {
			signed = JSON.parse(await readFile(sidecarPath, 'utf8')) as unknown;
		} catch {
			throw new Error('Backup provenance sidecar JSON is invalid');
		}
		const envelope = await provenance.verify(signed);
		const evidence = envelope.evidence;
		if (pairs.has(evidence.target)) {
			throw new Error('Artifact directory contains a duplicate target');
		}
		if (backupJobIds.has(evidence.backupJobId)) {
			throw new Error(
				'Artifact directory contains a duplicate backup job'
			);
		}
		if (entry.name !== `${evidence.fileName}.provenance.json`) {
			throw new Error('Backup provenance sidecar filename is invalid');
		}
		if (
			evidence.servicesSha !== environment.servicesSha ||
			evidence.imageRevision !== environment.servicesSha
		) {
			throw new Error('Backup provenance revision binding is invalid');
		}
		const manifestSha = manifests.sha256(evidence.target);
		if (evidence.migrationManifestSha !== manifestSha) {
			throw new Error('Backup provenance migration binding is invalid');
		}
		if (
			evidence.pgDumpVersion !== versions.pgDump ||
			evidence.pgRestoreVersion !== versions.pgRestore
		) {
			throw new Error(
				'Backup provenance PostgreSQL tool binding is invalid'
			);
		}
		const dumpPath = join(environment.inputDirectory, evidence.fileName);
		if (basename(dumpPath) !== evidence.fileName) {
			throw new Error('Backup provenance filename is unsafe');
		}
		const dumpMetadata = await assertReadOnlyArtifact(
			dumpPath,
			evidence.fileSize
		);
		const sourceSha256 = await artifacts.sha256(dumpPath);
		artifacts.assertChecksum(sourceSha256, evidence.artifactSha256);
		const dumpMetadataAfterHash = await assertReadOnlyArtifact(
			dumpPath,
			evidence.fileSize
		);
		if (
			dumpMetadata.dev !== dumpMetadataAfterHash.dev ||
			dumpMetadata.ino !== dumpMetadataAfterHash.ino ||
			dumpMetadata.mtimeMs !== dumpMetadataAfterHash.mtimeMs
		) {
			throw new Error('Backup artifact changed during verification');
		}
		const record = signed as {
			envelopeSha256?: unknown;
		};
		if (
			typeof record.envelopeSha256 !== 'string' ||
			!SHA256_PATTERN.test(record.envelopeSha256)
		) {
			throw new Error('Backup provenance envelope SHA-256 is invalid');
		}
		pairs.set(evidence.target, {
			target: evidence.target,
			dumpPath,
			sidecarPath,
			sourceSha256,
			fileSize: evidence.fileSize,
			backupJobId: evidence.backupJobId,
			provenanceEnvelopeSha256: record.envelopeSha256,
			provenanceKeyId: envelope.keyId,
			migrationManifestSha: manifestSha,
			pgDumpVersion: evidence.pgDumpVersion,
			pgRestoreVersion: evidence.pgRestoreVersion
		});
		backupJobIds.add(evidence.backupJobId);
	}
	const ordered = DATABASE_RESTORE_TARGETS.map(target =>
		pairs.get(target)
	);
	if (ordered.some(pair => !pair)) {
		throw new Error('Artifact directory is missing a restore target');
	}
	return ordered as ArtifactPair[];
};

const createTargetPasswords = async (
	workDirectory: string,
	registrySeed: Record<string, string>
): Promise<void> => {
	const secretsDirectory = join(workDirectory, 'target-secrets');
	await mkdir(secretsDirectory, { mode: 0o700 });
	const provisionalRegistry = new DatabaseRestoreTargetRegistryService(
		new ConfigService(registrySeed)
	);
	for (const targetName of DATABASE_RESTORE_TARGETS) {
		const target = provisionalRegistry.get(targetName);
		const password = randomBytes(36).toString('base64url');
		const passwordFile = join(secretsDirectory, `${targetName}.password`);
		await writeFile(passwordFile, `${password}\n`, {
			encoding: 'utf8',
			flag: 'wx',
			mode: 0o400
		});
		registrySeed[`${target.environmentPrefix}_POSTGRES_ADMIN_USER`] =
			target.adminRole;
		registrySeed[`${target.environmentPrefix}_POSTGRES_PORT`] =
			String(POSTGRES_PORT);
		registrySeed[
			`DATABASE_RESTORE_${target.environmentPrefix}_ADMIN_PASSWORD_FILE`
		] = passwordFile;
	}
};

const assertNoTargetConfigurationEnvironment = (
	registrySeed: Record<string, string>
): void => {
	if (
		Object.keys(registrySeed).some(key =>
			Object.prototype.hasOwnProperty.call(process.env, key)
		)
	) {
		throw new Error(
			'Production restore target configuration must not enter the rehearsal'
		);
	}
};

const bootstrapTargets = async (
	environment: RehearsalEnvironment,
	registry: DatabaseRestoreTargetRegistryService
): Promise<void> => {
	for (const targetName of DATABASE_RESTORE_TARGETS) {
		const target = registry.get(targetName);
		const connection = await registry.connection(target);
		await controlSql(
			environment,
			[
				'BEGIN;',
				`CREATE ROLE ${quoteIdentifier(target.adminRole)} NOLOGIN SUPERUSER PASSWORD ${quoteLiteral(connection.password)};`,
				`CREATE ROLE ${quoteIdentifier(target.migrationRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(randomBytes(36).toString('base64url'))};`,
				`CREATE ROLE ${quoteIdentifier(target.runtimeRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(randomBytes(36).toString('base64url'))};`,
				`CREATE ROLE ${quoteIdentifier(target.backupRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(randomBytes(36).toString('base64url'))};`,
				'COMMIT;'
			].join('\n')
		);
		await controlSql(
			environment,
			`CREATE DATABASE ${quoteIdentifier(target.database)} OWNER ${quoteIdentifier(target.adminRole)};`
		);
		await controlSql(
			environment,
			[
				'BEGIN;',
				`SET ROLE ${quoteIdentifier(target.adminRole)};`,
				`REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdentifier(target.database)} FROM PUBLIC;`,
				`GRANT CONNECT ON DATABASE ${quoteIdentifier(target.database)} TO ${quoteIdentifier(target.migrationRole)}, ${quoteIdentifier(target.runtimeRole)}, ${quoteIdentifier(target.backupRole)};`,
				'COMMIT;'
			].join('\n'),
			target.database
		);
	}
};

const assertCleanFixtureState = async (
	environment: RehearsalEnvironment,
	registry: DatabaseRestoreTargetRegistryService
): Promise<void> => {
	const fixtureNames = registry
		.all()
		.flatMap(target => [
			target.database,
			target.adminRole,
			target.migrationRole,
			target.runtimeRole,
			target.backupRole
		]);
	const existing = await run(
		'psql',
		[
			...postgresArgs(environment),
			'--tuples-only',
			'--no-align',
			'--command',
			`SELECT name FROM (
				SELECT datname AS name FROM pg_database
				UNION ALL SELECT rolname AS name FROM pg_roles
			) AS names WHERE name IN (${fixtureNames
				.map(quoteLiteral)
				.join(', ')}) LIMIT 1;`
		],
		{ password: environment.postgresPassword }
	);
	if (existing) {
		throw new Error('Ephemeral PostgreSQL contains restore fixture state');
	}
};

const selectTargetAdmin = async (
	environment: RehearsalEnvironment,
	registry: DatabaseRestoreTargetRegistryService,
	next: DatabaseRestoreTarget,
	active: DatabaseRestoreTarget | null
): Promise<DatabaseRestoreTarget> => {
	const nextTarget = registry.get(next);
	if (!active) {
		await controlSql(
			environment,
			`BEGIN;
			ALTER ROLE ${quoteIdentifier(nextTarget.adminRole)} LOGIN;
			ALTER ROLE ${quoteIdentifier(environment.postgresUser)} NOLOGIN;
			COMMIT;`
		);
		return next;
	}
	const previousTarget = registry.get(active);
	const previousConnection = await registry.connection(previousTarget);
	await controlSql(
		environment,
		`BEGIN;
		ALTER ROLE ${quoteIdentifier(nextTarget.adminRole)} LOGIN;
		ALTER ROLE ${quoteIdentifier(previousTarget.adminRole)} NOLOGIN;
		COMMIT;`,
		previousTarget.database,
		previousTarget.adminRole,
		previousConnection.password
	);
	return next;
};

const restoreControlLogin = async (
	environment: RehearsalEnvironment,
	registry: DatabaseRestoreTargetRegistryService,
	active: DatabaseRestoreTarget | null
): Promise<void> => {
	if (!active) return;
	const target = registry.get(active);
	const connection = await registry.connection(target);
	await controlSql(
		environment,
		`BEGIN;
		ALTER ROLE ${quoteIdentifier(environment.postgresUser)} LOGIN;
		ALTER ROLE ${quoteIdentifier(target.adminRole)} NOLOGIN;
		COMMIT;`,
		target.database,
		target.adminRole,
		connection.password
	);
};

const cleanupTargets = async (
	environment: RehearsalEnvironment,
	registry: DatabaseRestoreTargetRegistryService
): Promise<void> => {
	for (const targetName of [...DATABASE_RESTORE_TARGETS].reverse()) {
		const target = registry.get(targetName);
		await controlSql(
			environment,
			`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(target.database)} AND pid <> pg_backend_pid();`
		);
		await controlSql(
			environment,
			`DROP DATABASE IF EXISTS ${quoteIdentifier(target.database)};`
		);
		await controlSql(
			environment,
			[
				'BEGIN;',
				`DROP ROLE IF EXISTS ${quoteIdentifier(target.backupRole)};`,
				`DROP ROLE IF EXISTS ${quoteIdentifier(target.runtimeRole)};`,
				`DROP ROLE IF EXISTS ${quoteIdentifier(target.migrationRole)};`,
				`DROP ROLE IF EXISTS ${quoteIdentifier(target.adminRole)};`,
				'COMMIT;'
			].join('\n')
		);
	}
};

const seedTarget = async (
	pair: ArtifactPair,
	registry: DatabaseRestoreTargetRegistryService,
	processService: DatabaseRestoreProcessService,
	acl: DatabaseRestoreAclService,
	manifests: DatabaseRestoreMigrationManifestService,
	source: string
): Promise<void> => {
	const target = registry.get(pair.target);
	const connection = await registry.connection(target);
	await processService.executeSql(
		connection,
		`CREATE SCHEMA ${quoteIdentifier(target.schema)} AUTHORIZATION ${quoteIdentifier(target.migrationRole)};`
	);
	await processService.restoreSchema(connection, target, source);
	await acl.reconcileAndVerify(connection, target);
	manifests.assertDatabaseLedger(
		pair.target,
		await processService.readMigrationLedger(connection, target)
	);
};

const validateCopiedArtifact = async (
	pair: ArtifactPair,
	registry: DatabaseRestoreTargetRegistryService,
	processService: DatabaseRestoreProcessService,
	artifacts: DatabaseRestoreArtifactValidatorService,
	manifests: DatabaseRestoreMigrationManifestService,
	source: string
): Promise<void> => {
	const target = registry.get(pair.target);
	const connection = await registry.connection(target);
	const sourceSha256 = await artifacts.sha256(source);
	artifacts.assertChecksum(sourceSha256, pair.sourceSha256);
	artifacts.assertTableOfContents(
		await processService.listDump(source, connection.password),
		target
	);
	manifests.assertDumpLedger(
		pair.target,
		target.schema,
		await processService.extractMigrationLedger(source, target)
	);
};

const runTarget = async (
	pair: ArtifactPair,
	environment: RehearsalEnvironment,
	registry: DatabaseRestoreTargetRegistryService,
	processService: DatabaseRestoreProcessService,
	artifacts: DatabaseRestoreArtifactValidatorService,
	acl: DatabaseRestoreAclService,
	manifests: DatabaseRestoreMigrationManifestService,
	executor: DatabaseRestoreExecutorService,
	recovery: DatabaseRestoreRecoveryExecutorService
): Promise<RehearsalTargetEvidence> => {
	const targetWorkDirectory = join(environment.workDirectory, pair.target);
	await mkdir(targetWorkDirectory, { mode: 0o700 });
	const source = join(targetWorkDirectory, 'source.dump');
	await copyFile(pair.dumpPath, source, fsConstants.COPYFILE_EXCL);
	await chmod(source, 0o600);
	await validateCopiedArtifact(
		pair,
		registry,
		processService,
		artifacts,
		manifests,
		source
	);
	await seedTarget(pair, registry, processService, acl, manifests, source);
	const controller = new AbortController();
	const normalRestorePhases: string[] = [];
	const normal = await executor.restore({
		jobId: randomUUID(),
		target: pair.target,
		source,
		expectedSha256: pair.sourceSha256,
		migrationManifestSha: pair.migrationManifestSha,
		signal: controller.signal,
		checkpoint: async checkpoint => {
			normalRestorePhases.push(checkpoint.phase);
		}
	});
	const expectedNormalPhases = [
		'FENCING',
		'FENCED',
		'SAFETY_READY',
		'MUTATING',
		'VERIFIED',
		'UNFENCING',
		'UNFENCED'
	];
	if (normalRestorePhases.join('|') !== expectedNormalPhases.join('|')) {
		throw new Error('Normal restore checkpoint sequence is invalid');
	}
	if (
		normal.target !== pair.target ||
		!SHA256_PATTERN.test(normal.safetyBackupSha256)
	) {
		throw new Error('Normal restore result is invalid');
	}
	const recoveryActions: RehearsalRecoveryActionEvidence[] = [];
	for (const action of [
		DatabaseRestoreRecoveryActionType.VERIFY_AS_IS,
		DatabaseRestoreRecoveryActionType.ROLL_BACK_SAFETY,
		DatabaseRestoreRecoveryActionType.ROLL_FORWARD_SOURCE
	]) {
		const phases: string[] = [];
		const outcome = await recovery.execute({
			actionId: randomUUID(),
			action,
			target: pair.target,
			source,
			sourceSha256: pair.sourceSha256,
			safetyBackupSha256: normal.safetyBackupSha256,
			migrationManifestSha: pair.migrationManifestSha,
			signal: controller.signal,
			checkpoint: async checkpoint => {
				phases.push(checkpoint.phase);
			}
		});
		const expectedRecoveryPhases = [
			'FENCING',
			'FENCED',
			...(action === DatabaseRestoreRecoveryActionType.VERIFY_AS_IS
				? []
				: ['MUTATING']),
			'VERIFYING',
			'VERIFIED',
			'UNFENCING'
		];
		if (phases.join('|') !== expectedRecoveryPhases.join('|')) {
			throw new Error('Recovery checkpoint sequence is invalid');
		}
		const expectedArtifactSha256: string | null =
			action === DatabaseRestoreRecoveryActionType.VERIFY_AS_IS
				? null
				: action === DatabaseRestoreRecoveryActionType.ROLL_BACK_SAFETY
					? normal.safetyBackupSha256
					: pair.sourceSha256;
		const artifactSha256 = outcome.result.artifactSha256;
		const writerFenceReleaseEvidenceSha256 =
			outcome.writerFenceReleaseEvidenceSha256;
		if (
			outcome.result.target !== pair.target ||
			outcome.result.action !== action ||
			artifactSha256 !== expectedArtifactSha256 ||
			(artifactSha256 !== null && !SHA256_PATTERN.test(artifactSha256)) ||
			!SHA256_PATTERN.test(writerFenceReleaseEvidenceSha256)
		) {
			throw new Error('Recovery result is invalid');
		}
		recoveryActions.push({
			action,
			phases,
			artifactSha256,
			writerFenceReleaseEvidenceSha256
		});
	}
	const target = registry.get(pair.target);
	const connection = await registry.connection(target);
	await acl.verify(connection, target);
	manifests.assertDatabaseLedger(
		pair.target,
		await processService.readMigrationLedger(connection, target)
	);
	return {
		target: pair.target,
		backupJobId: pair.backupJobId,
		artifactSha256: pair.sourceSha256,
		provenanceEnvelopeSha256: pair.provenanceEnvelopeSha256,
		provenanceKeyId: pair.provenanceKeyId,
		migrationManifestSha: pair.migrationManifestSha,
		fileSize: pair.fileSize,
		normalRestorePhases,
		normalSafetyBackupSha256: normal.safetyBackupSha256,
		recoveryActions
	};
};

const main = async (): Promise<void> => {
	const environment = await readRehearsalEnvironment();
	const postgresVersion = await assertPostgresIdentity(environment);
	const versions = {
		pgDump: await toolVersion('pg_dump'),
		pgRestore: await toolVersion('pg_restore')
	};
	const provenance = new DatabaseBackupProvenanceService();
	const artifacts = new DatabaseRestoreArtifactValidatorService();
	const manifests = new DatabaseRestoreMigrationManifestService();
	const pairs = await loadArtifactPairs(
		environment,
		provenance,
		artifacts,
		manifests,
		versions
	);
	const runEnvironment: RehearsalEnvironment = {
		...environment,
		workDirectory: join(
			environment.workDirectory,
			`artifact-rehearsal-${randomUUID()}`
		)
	};
	const registrySeed: Record<string, string> = {};
	let registry: DatabaseRestoreTargetRegistryService | null = null;
	let active: DatabaseRestoreTarget | null = null;
	let cleanupEligible = false;
	let runDirectoryCreated = false;
	const evidence: RehearsalTargetEvidence[] = [];
	try {
		await mkdir(runEnvironment.workDirectory, { mode: 0o700 });
		runDirectoryCreated = true;
		await createTargetPasswords(
			runEnvironment.workDirectory,
			registrySeed
		);
		assertNoTargetConfigurationEnvironment(registrySeed);
		registry = new DatabaseRestoreTargetRegistryService(
			new ConfigService(registrySeed)
		);
		const processService = new DatabaseRestoreProcessService();
		const acl = new DatabaseRestoreAclService(processService);
		const writerFence = new DatabaseRestoreWriterFenceService(
			processService
		);
		const executor = new DatabaseRestoreExecutorService(
			registry,
			artifacts,
			processService,
			acl,
			manifests,
			writerFence
		);
		const recovery = new DatabaseRestoreRecoveryExecutorService(
			registry,
			artifacts,
			processService,
			acl,
			manifests,
			writerFence
		);
		await assertCleanFixtureState(runEnvironment, registry);
		cleanupEligible = true;
		await bootstrapTargets(runEnvironment, registry);
		for (const pair of pairs) {
			active = await selectTargetAdmin(
				runEnvironment,
				registry,
				pair.target,
				active
			);
			evidence.push(
				await runTarget(
					pair,
					runEnvironment,
					registry,
					processService,
					artifacts,
					acl,
					manifests,
					executor,
					recovery
				)
			);
		}
	} finally {
		const cleanupFailures: string[] = [];
		if (registry) {
			await restoreControlLogin(runEnvironment, registry, active).catch(
				() => {
					cleanupFailures.push('restore-control-login');
				}
			);
			if (cleanupEligible) {
				await cleanupTargets(runEnvironment, registry).catch(() => {
					cleanupFailures.push('drop-fixture-state');
				});
			}
		}
		if (runDirectoryCreated) {
			await rm(runEnvironment.workDirectory, {
				recursive: true,
				force: true
			}).catch(() => {
				cleanupFailures.push('remove-work-directory');
			});
		}
		if (cleanupFailures.length > 0) {
			throw new Error(
				`Artifact rehearsal cleanup failed: ${cleanupFailures.join(',')}`
			);
		}
	}
	console.log(
		JSON.stringify({
			domain: REHEARSAL_DOMAIN,
			schemaVersion: 1,
			status: 'SUCCEEDED',
			servicesSha: environment.servicesSha,
			postgresVersion,
			pgDumpVersion: versions.pgDump,
			pgRestoreVersion: versions.pgRestore,
			completedAt: new Date().toISOString(),
			proofScope: {
				isolatedPostgresOnly: true,
				productionRestoreGateEnabled: false,
				covered: [
					'signed-artifact-provenance',
					'exact-revision-binding',
					'toc-and-migration-ledger',
					'acl-and-writer-fence',
					'normal-executor',
					'all-recovery-executors'
				],
				excluded: [
					'dual-approval',
					'permit-outbox-worker-cas',
					'signed-terminal-receipts',
					'restart-and-redelivery',
					'retention-and-alerts'
				]
			},
			targets: evidence
		})
	);
};

if (require.main === module) {
	main().catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			JSON.stringify({
				domain: REHEARSAL_DOMAIN,
				status: 'FAILED',
				errorSha256: createHash('sha256').update(message).digest('hex')
			})
		);
		process.exitCode = 1;
	});
}
