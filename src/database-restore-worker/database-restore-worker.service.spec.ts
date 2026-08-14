import {
	DatabaseRestoreCommandInput,
	DatabaseRestoreCommandRunner,
	DatabaseRestoreFileSystem
} from '@/database-restore-worker/database-restore-worker.adapters';
import { DatabaseRestoreWorkerConfig } from '@/database-restore-worker/database-restore-worker.config';
import { DatabaseRestoreWorkerService } from '@/database-restore-worker/database-restore-worker.service';
import {
	DATABASE_RESTORE_PUBLICATION_GRACE_MS,
	DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
	canonicalDatabaseRestoreJson,
	parseAndVerifyDatabaseRestoreGlobalGate,
	parseAndVerifyDatabaseRestoreJobManifest,
	parseAndVerifyDatabaseRestoreTargetLock,
	signDatabaseRestoreGlobalGate,
	signDatabaseRestoreJobPayload,
	signDatabaseRestoreProductionPermit,
	signDatabaseRestorePublishReceipt,
	signDatabaseRestoreTargetLock,
	signDatabaseRestoreTransitionGate
} from '@/dev-tools/database-restore-queue.contract';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const STORAGE = '/restore';
const JOB_ID = '0190f8d5-16d6-4b31-9b42-58ceea54f94d';
const OTHER_JOB_ID = '0190f8d5-16d6-4b31-9b42-58ceea54f95e';
const QUEUE_SECRET = 'restore-queue-secret-32-bytes-minimum';
const UPLOAD_SHA256 = 'a'.repeat(64);
const SAFETY_SHA256 = 'b'.repeat(64);
const MIGRATION_NAME = '20260730000000_init_campaigns';
const MIGRATION_CHECKSUM = 'c'.repeat(64);

type RestoreCheckpointPhase =
	| 'FENCING'
	| 'FENCED'
	| 'SAFETY_CREATED'
	| 'RESTORED'
	| 'REPAIRED'
	| 'VERIFIED'
	| 'REOPENED';

const RESTORE_CHECKPOINT_ORDER: readonly RestoreCheckpointPhase[] = [
	'FENCING',
	'FENCED',
	'SAFETY_CREATED',
	'RESTORED',
	'REPAIRED',
	'VERIFIED',
	'REOPENED'
];

function createConfig(
	productionMode = false
): DatabaseRestoreWorkerConfig {
	return new DatabaseRestoreWorkerConfig(
		{
			DATABASE_RESTORE_STORAGE_DIR: STORAGE,
			DATABASE_RESTORE_QUEUE_SECRET: QUEUE_SECRET,
			DATABASE_RESTORE_CORE_PORT: '55434',
			DATABASE_RESTORE_NOTIFICATION_DELIVERY_PORT: '55432',
			DATABASE_RESTORE_CAMPAIGNS_PORT: '55433',
			DATABASE_RESTORE_REPORTING_PORT: '55435',
			DATABASE_RESTORE_WIDGETS_PORT: '55436',
			DATABASE_RESTORE_BILLING_PORT: '55437',
			DATABASE_RESTORE_IDENTITY_PORT: '55438',
			DATABASE_RESTORE_CORE_ADMIN_PASSWORD_FILE: '/secrets/core',
			DATABASE_RESTORE_NOTIFICATION_DELIVERY_ADMIN_PASSWORD_FILE:
				'/secrets/notification-delivery',
			DATABASE_RESTORE_CAMPAIGNS_ADMIN_PASSWORD_FILE: '/secrets/campaigns',
			DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE: '/secrets/reporting',
			DATABASE_RESTORE_WIDGETS_ADMIN_PASSWORD_FILE: '/secrets/widgets',
			DATABASE_RESTORE_BILLING_ADMIN_PASSWORD_FILE: '/secrets/billing',
			DATABASE_RESTORE_IDENTITY_ADMIN_PASSWORD_FILE: '/secrets/identity',
			APP_REVISION: 'd'.repeat(40),
			NODE_ENV: productionMode ? 'production' : 'test'
		},
		'/app'
	);
}

function campaignsToc(): string {
	return [
		'1; 0 0 ENCODING - UTF8',
		'2; 2615 100 SCHEMA - campaigns winwidget_campaigns_migration',
		'3; 1259 101 TABLE campaigns _prisma_migrations winwidget_campaigns_migration',
		'4; 1259 102 TABLE campaigns campaigns winwidget_campaigns_migration',
		'5; 1259 103 TABLE campaigns deliveries winwidget_campaigns_migration'
	].join('\n');
}

function signedCampaignsFence(jobId: string): string {
	return JSON.stringify(
		signDatabaseRestoreTargetLock(
			{
				version: 1,
				target: 'campaigns',
				jobId,
				createdAt: '2026-07-31T12:01:00.000Z'
			},
			QUEUE_SECRET
		)
	);
}

interface Harness {
	service: DatabaseRestoreWorkerService;
	files: Map<string, string | Buffer>;
	fileSystem: jest.Mocked<DatabaseRestoreFileSystem>;
	commandRunner: jest.Mocked<DatabaseRestoreCommandRunner>;
	commands: DatabaseRestoreCommandInput[];
	events: string[];
}

function createHarness(
	options: {
		availableBytes?: number;
		cancelDuringPreflight?: boolean;
		databaseSizeBytes?: number;
		failSafetyDump?: boolean;
		productionMode?: boolean;
	} = {}
): Harness {
	const config = createConfig(options.productionMode);
	const files = new Map<string, string | Buffer>();
	const queuedManifest = signDatabaseRestoreJobPayload(
		{
			version: 1,
			jobId: JOB_ID,
			target: 'campaigns',
			status: 'QUEUED',
			uploadFileName: `${JOB_ID}.dump`,
			originalFileName: 'campaigns.dump',
			fileSize: 4,
			sha256: UPLOAD_SHA256,
			requestedBy: 'dev-user',
			requestedAt: '2026-07-31T12:00:00.000Z',
			startedAt: null,
			finishedAt: null,
			attempt: 0,
			error: null,
			result: null
		},
		QUEUE_SECRET
	);
	const targetLock = signDatabaseRestoreTargetLock(
		{
			version: 1,
			target: 'campaigns',
			jobId: JOB_ID,
			createdAt: '2026-07-31T12:00:00.000Z'
		},
		QUEUE_SECRET
	);
	const transitionGate = signDatabaseRestoreTransitionGate(
		{
			version: 1,
			kind: 'DATABASE_RESTORE_TRANSITION_GATE',
			target: 'campaigns',
			jobId: JOB_ID,
			createdAt: '2026-07-31T12:00:00.000Z'
		},
		QUEUE_SECRET
	);
	files.set(
		join(STORAGE, 'queued', `${JOB_ID}.json`),
		JSON.stringify(queuedManifest)
	);
	files.set(
		join(STORAGE, 'uploads', `${JOB_ID}.dump`),
		Buffer.from('dump')
	);
	files.set(
		join(STORAGE, 'locks', 'campaigns.lock'),
		JSON.stringify(targetLock)
	);
	files.set(
		join(STORAGE, 'gates', `${JOB_ID}.cancellable`),
		JSON.stringify(transitionGate)
	);
	const events: string[] = [];

	const fileSystem = {
		ensurePrivateDirectory: jest.fn().mockResolvedValue(undefined),
		listFileNames: jest.fn(async (directory: string) =>
			[...files.keys()]
				.filter(path => dirname(path) === directory)
				.map(path => path.slice(directory.length + 1))
				.sort()
		),
		readUtf8File: jest.fn(async (path: string) => {
			const value = files.get(path);
			if (value === undefined) throw nodeError('ENOENT');
			return Buffer.isBuffer(value) ? value.toString('utf8') : value;
		}),
		readSecretFile: jest.fn().mockResolvedValue('admin-password'),
		fileInfo: jest.fn(async (path: string) => {
			const value = files.get(path);
			if (value === undefined) throw nodeError('ENOENT');
			return {
				size: Buffer.byteLength(value),
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false
			};
		}),
		pathExists: jest.fn(async (path: string) => files.has(path)),
		rename: jest.fn(async (source: string, destination: string) => {
			const value = files.get(source);
			if (value === undefined) throw nodeError('ENOENT');
			files.set(destination, value);
			files.delete(source);
			events.push(`rename:${destination}`);
		}),
		removeFile: jest.fn(async (path: string) => {
			files.delete(path);
		}),
		availableBytes: jest
			.fn()
			.mockResolvedValue(options.availableBytes ?? 1024 * 1024 * 1024),
		calculateSha256: jest.fn(async (path: string) =>
			path.endsWith(`${JOB_ID}.dump`) && path.includes('/uploads/')
				? UPLOAD_SHA256
				: SAFETY_SHA256
		),
		readMigrationChecksums: jest.fn().mockResolvedValue([
			{
				migrationName: MIGRATION_NAME,
				checksum: MIGRATION_CHECKSUM
			}
		]),
		atomicWriteJson: jest.fn(async (path: string, value: unknown) => {
			files.set(path, JSON.stringify(value));
			events.push(`write:${path}`);
		}),
		atomicCreateJson: jest.fn(async (path: string, value: unknown) => {
			if (files.has(path)) return false;
			files.set(path, JSON.stringify(value));
			return true;
		}),
		isNodeError: jest.fn(
			(error: unknown, code: string) =>
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code === code
		)
	} as unknown as jest.Mocked<DatabaseRestoreFileSystem>;

	const commands: DatabaseRestoreCommandInput[] = [];
	const commandRunner = {
		run: jest.fn(async (input: DatabaseRestoreCommandInput) => {
			commands.push(input);
			events.push(
				`command:${input.command}:${input.args.some(argument => argument.includes('REVOKE CONNECT')) ? 'fence' : 'other'}`
			);
			if (input.command === 'pg_dump') {
				if (options.failSafetyDump && !input.args.includes('--version')) {
					throw new Error('pg_dump failed');
				}
				if (input.args.includes('--version')) return { stdout: '' };
				const outputPath = input.args[input.args.indexOf('--file') + 1];
				files.set(outputPath, Buffer.from('safety'));
				return { stdout: '' };
			}
			if (
				input.command === 'pg_restore' &&
				input.args.includes('--list')
			) {
				if (options.cancelDuringPreflight) {
					const cancellablePath = join(
						STORAGE,
						'gates',
						`${JOB_ID}.cancellable`
					);
					const cancelledPath = join(
						STORAGE,
						'gates',
						`${JOB_ID}.cancelled`
					);
					files.set(cancelledPath, files.get(cancellablePath)!);
					files.delete(cancellablePath);
				}
				return { stdout: campaignsToc() };
			}
			if (
				input.command === 'psql' &&
				input.args.some(argument =>
					argument.includes('database_restore_preflight')
				)
			) {
				return {
					stdout: `DO\n${options.databaseSizeBytes ?? 1048576}\n`
				};
			}
			if (
				input.command === 'psql' &&
				input.args.some(argument =>
					argument.includes('SELECT migration_name')
				)
			) {
				return {
					stdout: `${MIGRATION_NAME}\t${MIGRATION_CHECKSUM}\tapplied\n`
				};
			}
			return { stdout: '' };
		})
	} as unknown as jest.Mocked<DatabaseRestoreCommandRunner>;

	return {
		service: new DatabaseRestoreWorkerService(
			config,
			fileSystem,
			commandRunner
		),
		files,
		fileSystem,
		commandRunner,
		commands,
		events
	};
}

function seedProductionPublication(
	harness: Harness,
	options: { receipt?: boolean } = {}
): void {
	const manifest = parseAndVerifyDatabaseRestoreJobManifest(
		String(harness.files.get(join(STORAGE, 'queued', `${JOB_ID}.json`))),
		QUEUE_SECRET
	);
	const permit = signDatabaseRestoreProductionPermit(
		{
			version: DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
			kind: 'DATABASE_RESTORE_PRODUCTION_PERMIT',
			appRevision: 'd'.repeat(40),
			target: 'campaigns',
			jobId: JOB_ID,
			expiresAt: '2099-01-01T00:00:00.000Z',
			runId: 'worker-production-publication-test',
			evidence: 'worker-production-publication-evidence',
			incident: 'incident-2024'
		},
		QUEUE_SECRET
	);
	harness.files.set(
		join(STORAGE, 'locks', 'global.lock'),
		JSON.stringify(
			signDatabaseRestoreGlobalGate(
				{
					version: 1,
					kind: 'DATABASE_RESTORE_GLOBAL_GATE',
					target: 'campaigns',
					jobId: JOB_ID,
					createdAt: manifest.requestedAt
				},
				QUEUE_SECRET
			)
		)
	);
	if (options.receipt === false) return;
	harness.files.set(
		join(STORAGE, 'receipts', `${JOB_ID}.json`),
		JSON.stringify(
			signDatabaseRestorePublishReceipt(
				{
					version: 1,
					kind: 'DATABASE_RESTORE_PUBLISH_RECEIPT',
					jobId: JOB_ID,
					target: 'campaigns',
					manifestStatus: 'QUEUED',
					manifestSignature: manifest.signature,
					publishedAt: '2026-07-31T12:00:01.000Z',
					auditEventId: `database_restore_publish_${JOB_ID}`,
					appRevision: 'd'.repeat(40),
					permitSignature: permit.signature,
					permitExpiresAt: permit.expiresAt,
					runId: permit.runId,
					evidence: permit.evidence,
					incident: permit.incident
				},
				QUEUE_SECRET
			)
		)
	);
}

function seedRestoreCheckpoint(
	harness: Harness,
	phase: RestoreCheckpointPhase,
	options: { fenceSentinel?: boolean } = {}
): void {
	const queuedPath = join(STORAGE, 'queued', `${JOB_ID}.json`);
	const processingPath = join(STORAGE, 'processing', `${JOB_ID}.json`);
	const queued = parseAndVerifyDatabaseRestoreJobManifest(
		String(harness.files.get(queuedPath)),
		QUEUE_SECRET
	);
	const processingPayload = { ...queued };
	delete (processingPayload as Partial<typeof queued>).signature;
	const processing = signDatabaseRestoreJobPayload(
		{
			...processingPayload,
			status: 'PROCESSING',
			startedAt: '2026-07-31T12:00:01.000Z',
			attempt: 1
		},
		QUEUE_SECRET
	);
	harness.files.delete(queuedPath);
	harness.files.set(processingPath, JSON.stringify(processing));

	const cancellablePath = join(STORAGE, 'gates', `${JOB_ID}.cancellable`);
	const destructivePath = join(STORAGE, 'gates', `${JOB_ID}.destructive`);
	harness.files.set(
		destructivePath,
		String(harness.files.get(cancellablePath))
	);
	harness.files.delete(cancellablePath);

	const phaseIndex = RESTORE_CHECKPOINT_ORDER.indexOf(phase);
	const hasSafetyBackup =
		phaseIndex >= RESTORE_CHECKPOINT_ORDER.indexOf('SAFETY_CREATED');
	const hasRestoredAt =
		phaseIndex >= RESTORE_CHECKPOINT_ORDER.indexOf('RESTORED');
	const hasVerifiedAt =
		phaseIndex >= RESTORE_CHECKPOINT_ORDER.indexOf('VERIFIED');
	const progressPayload = {
		version: 1 as const,
		jobId: JOB_ID,
		target: 'campaigns' as const,
		phase,
		safetyBackupFileName: hasSafetyBackup ? `safety-${JOB_ID}.dump` : null,
		safetyBackupSha256: hasSafetyBackup ? SAFETY_SHA256 : null,
		restoredAt: hasRestoredAt ? '2026-07-31T12:00:02.000Z' : null,
		verifiedAt: hasVerifiedAt ? '2026-07-31T12:00:03.000Z' : null,
		updatedAt: '2026-07-31T12:00:04.000Z'
	};
	const progress = {
		...progressPayload,
		signature: createHmac('sha256', QUEUE_SECRET)
			.update(canonicalDatabaseRestoreJson(progressPayload))
			.digest('hex')
	};
	harness.files.set(
		join(STORAGE, 'processing', `${JOB_ID}.state`),
		JSON.stringify(progress)
	);
	if (hasSafetyBackup) {
		harness.files.set(
			join(STORAGE, 'processing', `safety-${JOB_ID}.dump`),
			Buffer.from('safety')
		);
	}
	if (options.fenceSentinel ?? phase !== 'REOPENED') {
		harness.files.set(
			join(STORAGE, 'fences', 'campaigns.json'),
			signedCampaignsFence(JOB_ID)
		);
	}
}

function writtenRestoreCheckpointPhases(
	harness: Harness
): RestoreCheckpointPhase[] {
	const progressPath = join(STORAGE, 'processing', `${JOB_ID}.state`);
	return harness.fileSystem.atomicWriteJson.mock.calls
		.filter(([path]) => path === progressPath)
		.map(
			([, value]) => (value as { phase: RestoreCheckpointPhase }).phase
		);
}

function destructiveRestoreCommands(
	harness: Harness
): DatabaseRestoreCommandInput[] {
	return harness.commands.filter(
		command =>
			command.command === 'pg_restore' && command.args.includes('--clean')
	);
}

describe('DatabaseRestoreWorkerService', () => {
	it('keeps a production job non-destructive until its signed publish receipt exists', async () => {
		const harness = createHarness({ productionMode: true });
		seedProductionPublication(harness, { receipt: false });

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		expect(harness.commands).toHaveLength(0);
		expect(
			harness.files.has(join(STORAGE, 'queued', `${JOB_ID}.json`))
		).toBe(true);
		expect(
			harness.files.has(join(STORAGE, 'processing', `${JOB_ID}.json`))
		).toBe(false);
		expect(harness.files.has(join(STORAGE, 'locks', 'global.lock'))).toBe(
			true
		);
	});

	it('starts safely with a production job awaiting publication confirmation', async () => {
		const harness = createHarness({ productionMode: true });
		seedProductionPublication(harness, { receipt: false });

		await harness.service.onModuleInit();

		expect(
			harness.commands.filter(
				command => !command.args.includes('--version')
			)
		).toHaveLength(0);
		expect(harness.files.has(join(STORAGE, 'worker-ready.json'))).toBe(
			true
		);
		const readiness = JSON.parse(
			String(harness.files.get(join(STORAGE, 'worker-ready.json')))
		) as { targets: string[] };
		expect(readiness.targets).toEqual([
			'billing',
			'campaigns',
			'core',
			'identity',
			'notification-delivery',
			'reporting',
			'widgets'
		]);
		await harness.service.beforeApplicationShutdown();
	});

	it('processes a production job only after exact receipt validation and releases the global gate', async () => {
		const harness = createHarness({ productionMode: true });
		seedProductionPublication(harness);

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(
				harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
			),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('SUCCEEDED');
		expect(harness.files.has(join(STORAGE, 'locks', 'global.lock'))).toBe(
			false
		);
		expect(
			harness.files.has(
				join(STORAGE, 'processing', `${JOB_ID}.publication`)
			)
		).toBe(false);
		expect(
			harness.fileSystem.atomicCreateJson.mock.calls.filter(
				([path]) =>
					path === join(STORAGE, 'processing', `${JOB_ID}.publication`)
			)
		).toHaveLength(2);
	});

	it('does not let an older same-target terminal job release the locks of the next production job', async () => {
		const harness = createHarness({ productionMode: true });
		seedProductionPublication(harness, { receipt: false });
		const previousTerminal = signDatabaseRestoreJobPayload(
			{
				version: 1,
				jobId: OTHER_JOB_ID,
				target: 'campaigns',
				status: 'CANCELLED',
				uploadFileName: `${OTHER_JOB_ID}.dump`,
				originalFileName: 'campaigns.dump',
				fileSize: 4,
				sha256: UPLOAD_SHA256,
				requestedBy: 'dev-user',
				requestedAt: '2026-07-31T11:00:00.000Z',
				startedAt: '2026-07-31T11:00:01.000Z',
				finishedAt: '2026-07-31T11:00:02.000Z',
				attempt: 1,
				error: null,
				result: null
			},
			QUEUE_SECRET
		);
		harness.files.set(
			join(STORAGE, 'terminal', `${OTHER_JOB_ID}.json`),
			JSON.stringify(previousTerminal)
		);

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const targetLock = parseAndVerifyDatabaseRestoreTargetLock(
			String(harness.files.get(join(STORAGE, 'locks', 'campaigns.lock'))),
			QUEUE_SECRET
		);
		const globalGate = parseAndVerifyDatabaseRestoreGlobalGate(
			String(harness.files.get(join(STORAGE, 'locks', 'global.lock'))),
			QUEUE_SECRET
		);
		expect(targetLock.jobId).toBe(JOB_ID);
		expect(globalGate.jobId).toBe(JOB_ID);
		expect(harness.commands).toHaveLength(0);
		expect(
			harness.files.has(join(STORAGE, 'queued', `${JOB_ID}.json`))
		).toBe(true);
	});

	it('rejects an orphan signed global gate during a polling cycle without PostgreSQL commands', async () => {
		const harness = createHarness({ productionMode: true });
		harness.files.delete(join(STORAGE, 'queued', `${JOB_ID}.json`));
		harness.files.delete(join(STORAGE, 'locks', 'campaigns.lock'));
		harness.files.set(
			join(STORAGE, 'locks', 'global.lock'),
			JSON.stringify(
				signDatabaseRestoreGlobalGate(
					{
						version: 1,
						kind: 'DATABASE_RESTORE_GLOBAL_GATE',
						target: 'campaigns',
						jobId: OTHER_JOB_ID,
						createdAt: '2026-07-31T11:00:00.000Z'
					},
					QUEUE_SECRET
				)
			)
		);

		await expect(harness.service.processNextJob()).rejects.toThrow(
			`Orphan database restore global gate requires manual reconciliation jobId=${OTHER_JOB_ID}`
		);

		expect(harness.commands).toHaveLength(0);
		expect(harness.files.has(join(STORAGE, 'locks', 'global.lock'))).toBe(
			true
		);
	});

	it('accepts a signed global gate at the exact publication grace boundary without PostgreSQL commands', async () => {
		const harness = createHarness({ productionMode: true });
		const now = Date.parse('2026-08-02T12:00:00.000Z');
		const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
		harness.files.delete(join(STORAGE, 'queued', `${JOB_ID}.json`));
		harness.files.delete(join(STORAGE, 'locks', 'campaigns.lock'));
		harness.files.delete(join(STORAGE, 'gates', `${JOB_ID}.cancellable`));
		harness.files.set(
			join(STORAGE, 'locks', 'global.lock'),
			JSON.stringify(
				signDatabaseRestoreGlobalGate(
					{
						version: 1,
						kind: 'DATABASE_RESTORE_GLOBAL_GATE',
						target: 'campaigns',
						jobId: JOB_ID,
						createdAt: new Date(
							now - DATABASE_RESTORE_PUBLICATION_GRACE_MS
						).toISOString()
					},
					QUEUE_SECRET
				)
			)
		);

		try {
			await expect(harness.service.processNextJob()).resolves.toBe(false);
		} finally {
			nowSpy.mockRestore();
		}

		expect(harness.commands).toHaveLength(0);
		expect(harness.files.has(join(STORAGE, 'locks', 'global.lock'))).toBe(
			true
		);
	});

	it.each([
		{
			caseName: 'one millisecond beyond the publication grace limit',
			createdAtOffsetMs: -DATABASE_RESTORE_PUBLICATION_GRACE_MS - 1
		},
		{
			caseName: 'one millisecond in the future',
			createdAtOffsetMs: 1
		}
	])(
		'rejects an orphan signed global gate $caseName without PostgreSQL commands',
		async ({ createdAtOffsetMs }) => {
			const harness = createHarness({ productionMode: true });
			const now = Date.parse('2026-08-02T12:00:00.000Z');
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
			harness.files.delete(join(STORAGE, 'queued', `${JOB_ID}.json`));
			harness.files.delete(join(STORAGE, 'locks', 'campaigns.lock'));
			harness.files.delete(
				join(STORAGE, 'gates', `${JOB_ID}.cancellable`)
			);
			harness.files.set(
				join(STORAGE, 'locks', 'global.lock'),
				JSON.stringify(
					signDatabaseRestoreGlobalGate(
						{
							version: 1,
							kind: 'DATABASE_RESTORE_GLOBAL_GATE',
							target: 'campaigns',
							jobId: JOB_ID,
							createdAt: new Date(now + createdAtOffsetMs).toISOString()
						},
						QUEUE_SECRET
					)
				)
			);

			try {
				await expect(harness.service.processNextJob()).rejects.toThrow(
					`Orphan database restore global gate requires manual reconciliation jobId=${JOB_ID}`
				);
			} finally {
				nowSpy.mockRestore();
			}

			expect(harness.commands).toHaveLength(0);
			expect(
				harness.files.has(join(STORAGE, 'locks', 'global.lock'))
			).toBe(true);
		}
	);

	it('rejects mismatched pending publication locks without PostgreSQL commands', async () => {
		const harness = createHarness({ productionMode: true });
		const now = Date.parse('2026-08-02T12:00:00.000Z');
		const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
		const globalCreatedAt = new Date(now).toISOString();
		harness.files.delete(join(STORAGE, 'queued', `${JOB_ID}.json`));
		harness.files.set(
			join(STORAGE, 'locks', 'global.lock'),
			JSON.stringify(
				signDatabaseRestoreGlobalGate(
					{
						version: 1,
						kind: 'DATABASE_RESTORE_GLOBAL_GATE',
						target: 'campaigns',
						jobId: JOB_ID,
						createdAt: globalCreatedAt
					},
					QUEUE_SECRET
				)
			)
		);

		try {
			await expect(harness.service.processNextJob()).rejects.toThrow(
				'Unpublished database restore lock requires manual reconciliation'
			);
		} finally {
			nowSpy.mockRestore();
		}

		expect(harness.commands).toHaveLength(0);
		expect(harness.files.has(join(STORAGE, 'locks', 'global.lock'))).toBe(
			true
		);
		expect(
			harness.files.has(join(STORAGE, 'locks', 'campaigns.lock'))
		).toBe(true);
	});

	it('accepts coherent fresh publication locks during startup without destructive PostgreSQL commands', async () => {
		const harness = createHarness({ productionMode: true });
		const createdAt = new Date().toISOString();
		harness.files.delete(join(STORAGE, 'queued', `${JOB_ID}.json`));
		harness.files.set(
			join(STORAGE, 'locks', 'campaigns.lock'),
			JSON.stringify(
				signDatabaseRestoreTargetLock(
					{
						version: 1,
						target: 'campaigns',
						jobId: JOB_ID,
						createdAt
					},
					QUEUE_SECRET
				)
			)
		);
		harness.files.set(
			join(STORAGE, 'locks', 'global.lock'),
			JSON.stringify(
				signDatabaseRestoreGlobalGate(
					{
						version: 1,
						kind: 'DATABASE_RESTORE_GLOBAL_GATE',
						target: 'campaigns',
						jobId: JOB_ID,
						createdAt
					},
					QUEUE_SECRET
				)
			)
		);
		harness.files.set(
			join(STORAGE, 'gates', `${JOB_ID}.cancellable`),
			JSON.stringify(
				signDatabaseRestoreTransitionGate(
					{
						version: 1,
						kind: 'DATABASE_RESTORE_TRANSITION_GATE',
						target: 'campaigns',
						jobId: JOB_ID,
						createdAt
					},
					QUEUE_SECRET
				)
			)
		);

		await harness.service.onModuleInit();

		expect(
			harness.commands.filter(
				command => !command.args.includes('--version')
			)
		).toHaveLength(0);
		expect(harness.files.has(join(STORAGE, 'worker-ready.json'))).toBe(
			true
		);
		await harness.service.beforeApplicationShutdown();
	});

	it('preserves a tampered orphan global gate and stays non-destructive', async () => {
		const harness = createHarness({ productionMode: true });
		harness.files.delete(join(STORAGE, 'queued', `${JOB_ID}.json`));
		harness.files.delete(join(STORAGE, 'locks', 'campaigns.lock'));
		const tamperedGate = signDatabaseRestoreGlobalGate(
			{
				version: 1,
				kind: 'DATABASE_RESTORE_GLOBAL_GATE',
				target: 'campaigns',
				jobId: OTHER_JOB_ID,
				createdAt: '2026-07-31T11:00:00.000Z'
			},
			QUEUE_SECRET
		);
		tamperedGate.signature = '0'.repeat(64);
		const rawTamperedGate = JSON.stringify(tamperedGate);
		harness.files.set(
			join(STORAGE, 'locks', 'global.lock'),
			rawTamperedGate
		);

		await expect(harness.service.processNextJob()).rejects.toThrow();

		expect(harness.commands).toHaveLength(0);
		expect(harness.files.get(join(STORAGE, 'locks', 'global.lock'))).toBe(
			rawTamperedGate
		);
	});

	it('claims one job, fences before safety dump and reopens only after verification', async () => {
		const harness = createHarness();

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const fenceIndex = harness.commands.findIndex(
			command =>
				command.command === 'psql' &&
				command.args.some(argument => argument.includes('REVOKE CONNECT'))
		);
		const safetyIndex = harness.commands.findIndex(
			command => command.command === 'pg_dump'
		);
		const restoreCommand = harness.commands.find(
			command =>
				command.command === 'pg_restore' &&
				command.args.includes('--clean')
		);
		const reopenIndex = harness.commands.findIndex(
			command =>
				command.command === 'psql' &&
				command.args.some(argument => argument.includes('GRANT CONNECT'))
		);

		expect(fenceIndex).toBeGreaterThan(-1);
		const preflightIndex = harness.commands.findIndex(
			command =>
				command.command === 'psql' &&
				command.args.some(argument =>
					argument.includes('database_restore_preflight')
				)
		);
		expect(preflightIndex).toBeGreaterThan(-1);
		expect(
			harness.events.indexOf(
				`rename:${join(STORAGE, 'gates', `${JOB_ID}.destructive`)}`
			)
		).toBeLessThan(harness.events.indexOf('command:psql:fence'));
		expect(preflightIndex).toBeLessThan(fenceIndex);
		expect(safetyIndex).toBeGreaterThan(fenceIndex);
		expect(reopenIndex).toBeGreaterThan(safetyIndex);
		expect(restoreCommand?.args).toEqual(
			expect.arrayContaining([
				'--single-transaction',
				'--clean',
				'--schema',
				'campaigns'
			])
		);
		expect(
			restoreCommand?.args.some(argument => argument.startsWith('--role'))
		).toBe(false);
		expect(
			harness.commands
				.flatMap(command => [...command.args])
				.some(argument => argument.includes('admin-password'))
		).toBe(false);

		const terminalPath = join(STORAGE, 'terminal', `${JOB_ID}.json`);
		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(harness.files.get(terminalPath)),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('SUCCEEDED');
		expect(terminal.result).toEqual(
			expect.objectContaining({ safetyBackupSha256: SAFETY_SHA256 })
		);
		expect(
			harness.files.has(join(STORAGE, 'locks', 'campaigns.lock'))
		).toBe(false);
		expect(
			harness.files.has(join(STORAGE, 'fences', 'campaigns.json'))
		).toBe(false);
		expect(
			harness.files.has(join(STORAGE, 'uploads', `${JOB_ID}.dump`))
		).toBe(false);
		expect(
			harness.files.has(join(STORAGE, 'gates', `${JOB_ID}.destructive`))
		).toBe(false);
	});

	it.each<{
		phase: 'FENCING' | 'FENCED' | 'SAFETY_CREATED';
		expectedSafetyDumps: number;
	}>([
		{ phase: 'FENCING', expectedSafetyDumps: 1 },
		{ phase: 'FENCED', expectedSafetyDumps: 1 },
		{ phase: 'SAFETY_CREATED', expectedSafetyDumps: 0 }
	])(
		'resumes $phase without moving progress backwards',
		async ({ phase, expectedSafetyDumps }) => {
			const harness = createHarness();
			seedRestoreCheckpoint(harness, phase);

			await expect(harness.service.processNextJob()).resolves.toBe(true);

			expect(
				harness.commands.filter(
					command =>
						command.command === 'pg_dump' &&
						!command.args.includes('--version')
				)
			).toHaveLength(expectedSafetyDumps);
			expect(destructiveRestoreCommands(harness)).toHaveLength(1);
			expect(harness.commands[0]).toEqual(
				expect.objectContaining({
					command: 'psql',
					args: expect.arrayContaining([
						expect.stringContaining('REVOKE CONNECT')
					])
				})
			);
			const initialIndex = RESTORE_CHECKPOINT_ORDER.indexOf(phase);
			for (const writtenPhase of writtenRestoreCheckpointPhases(harness)) {
				expect(
					RESTORE_CHECKPOINT_ORDER.indexOf(writtenPhase)
				).toBeGreaterThan(initialIndex);
			}
			const terminal = parseAndVerifyDatabaseRestoreJobManifest(
				String(
					harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
				),
				QUEUE_SECRET
			);
			expect(terminal.status).toBe('SUCCEEDED');
		}
	);

	it('continues RESTORED with ACL repair and never replays the uploaded dump', async () => {
		const harness = createHarness();
		seedRestoreCheckpoint(harness, 'RESTORED');
		harness.files.delete(join(STORAGE, 'uploads', `${JOB_ID}.dump`));

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		expect(
			harness.commands.some(command => command.command === 'pg_restore')
		).toBe(false);
		expect(
			harness.commands.some(command => command.command === 'pg_dump')
		).toBe(false);
		const fenceIndex = harness.commands.findIndex(command =>
			command.args.some(argument => argument.includes('REVOKE CONNECT'))
		);
		const repairIndex = harness.commands.findIndex(command =>
			command.args.some(argument =>
				argument.includes('$database_restore_owners$')
			)
		);
		const verifyIndex = harness.commands.findIndex(command =>
			command.args.some(argument =>
				argument.includes('SELECT migration_name')
			)
		);
		const reopenIndex = harness.commands.findIndex(command =>
			command.args.some(argument => argument.includes('GRANT CONNECT'))
		);
		expect(fenceIndex).toBe(0);
		expect(repairIndex).toBeGreaterThan(fenceIndex);
		expect(verifyIndex).toBeGreaterThan(repairIndex);
		expect(reopenIndex).toBeGreaterThan(verifyIndex);
		expect(writtenRestoreCheckpointPhases(harness)).toEqual([
			'REPAIRED',
			'VERIFIED',
			'REOPENED'
		]);
	});

	it('continues REPAIRED with verification and skips restore and ACL repair', async () => {
		const harness = createHarness();
		seedRestoreCheckpoint(harness, 'REPAIRED');

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		expect(destructiveRestoreCommands(harness)).toHaveLength(0);
		expect(
			harness.commands.some(command => command.command === 'pg_dump')
		).toBe(false);
		expect(
			harness.commands.some(command =>
				command.args.some(argument =>
					argument.includes('$database_restore_owners$')
				)
			)
		).toBe(false);
		expect(harness.commands[0].args).toEqual(
			expect.arrayContaining([expect.stringContaining('REVOKE CONNECT')])
		);
		expect(writtenRestoreCheckpointPhases(harness)).toEqual([
			'VERIFIED',
			'REOPENED'
		]);
	});

	it('re-fences and re-verifies VERIFIED after a crash following GRANT CONNECT', async () => {
		const harness = createHarness();
		seedRestoreCheckpoint(harness, 'VERIFIED', { fenceSentinel: true });

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		expect(destructiveRestoreCommands(harness)).toHaveLength(0);
		expect(
			harness.commands.some(command => command.command === 'pg_dump')
		).toBe(false);
		const fenceIndex = harness.commands.findIndex(command =>
			command.args.some(argument => argument.includes('REVOKE CONNECT'))
		);
		const migrationVerifyIndex = harness.commands.findIndex(command =>
			command.args.some(argument =>
				argument.includes('SELECT migration_name')
			)
		);
		const fencedDatabaseVerifyIndex = harness.commands.findIndex(command =>
			command.args.some(argument =>
				argument.includes('$database_restore_verify$')
			)
		);
		const reopenIndex = harness.commands.findIndex(command =>
			command.args.some(argument => argument.includes('GRANT CONNECT'))
		);
		expect(fenceIndex).toBe(0);
		expect(migrationVerifyIndex).toBeGreaterThan(fenceIndex);
		expect(fencedDatabaseVerifyIndex).toBeGreaterThan(
			migrationVerifyIndex
		);
		expect(reopenIndex).toBeGreaterThan(fencedDatabaseVerifyIndex);
		expect(writtenRestoreCheckpointPhases(harness)).toEqual([
			'VERIFIED',
			'REOPENED'
		]);
		expect(
			harness.files.has(join(STORAGE, 'fences', 'campaigns.json'))
		).toBe(false);
	});

	it('recreates a missing VERIFIED sentinel before re-fencing and verification', async () => {
		const harness = createHarness();
		seedRestoreCheckpoint(harness, 'VERIFIED', { fenceSentinel: false });
		const fencePath = join(STORAGE, 'fences', 'campaigns.json');

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		expect(harness.fileSystem.atomicCreateJson).toHaveBeenCalledWith(
			fencePath,
			expect.objectContaining({ jobId: JOB_ID, target: 'campaigns' })
		);
		expect(harness.commands[0].args).toEqual(
			expect.arrayContaining([expect.stringContaining('REVOKE CONNECT')])
		);
		expect(destructiveRestoreCommands(harness)).toHaveLength(0);
		expect(
			harness.files.has(join(STORAGE, 'terminal', `${JOB_ID}.json`))
		).toBe(true);
	});

	it('restores the durable sentinel and FAILED_FENCED state when REOPENED persistence fails', async () => {
		const harness = createHarness();
		seedRestoreCheckpoint(harness, 'VERIFIED', { fenceSentinel: true });
		const progressPath = join(STORAGE, 'processing', `${JOB_ID}.state`);
		harness.fileSystem.atomicWriteJson.mockImplementation(
			async (path: string, value: unknown) => {
				if (
					path === progressPath &&
					(value as { phase?: string }).phase === 'REOPENED'
				) {
					throw new Error('simulated progress fsync failure');
				}
				harness.files.set(path, JSON.stringify(value));
				harness.events.push(`write:${path}`);
			}
		);

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(
				harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
			),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('FAILED_FENCED');
		expect(terminal.error?.code).toBe('DATABASE_REOPEN_FAILED');
		expect(destructiveRestoreCommands(harness)).toHaveLength(0);
		expect(
			harness.commands.filter(command =>
				command.args.some(argument => argument.includes('REVOKE CONNECT'))
			)
		).toHaveLength(2);
		expect(
			harness.files.has(join(STORAGE, 'fences', 'campaigns.json'))
		).toBe(true);
		expect(
			harness.files.has(join(STORAGE, 'locks', 'campaigns.lock'))
		).toBe(true);
	});

	it('finalizes REOPENED without database commands or earlier checkpoint replay', async () => {
		const harness = createHarness();
		seedRestoreCheckpoint(harness, 'REOPENED', { fenceSentinel: false });
		harness.files.delete(join(STORAGE, 'uploads', `${JOB_ID}.dump`));

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		expect(harness.commands).toHaveLength(0);
		expect(writtenRestoreCheckpointPhases(harness)).toHaveLength(0);
		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(
				harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
			),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('SUCCEEDED');
	});

	it('rejects insufficient safety-backup space before the destructive gate', async () => {
		const harness = createHarness({
			availableBytes: 300 * 1024 * 1024,
			databaseSizeBytes: 100 * 1024 * 1024
		});

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(
				harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
			),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('FAILED');
		expect(terminal.error?.code).toBe('INSUFFICIENT_RESTORE_SPACE');
		expect(
			harness.files.has(join(STORAGE, 'gates', `${JOB_ID}.destructive`))
		).toBe(false);
		expect(
			harness.commands.some(command =>
				command.args.some(argument => argument.includes('REVOKE CONNECT'))
			)
		).toBe(false);
	});

	it('cancels a queued job without running PostgreSQL commands', async () => {
		const harness = createHarness();
		const cancellablePath = join(
			STORAGE,
			'gates',
			`${JOB_ID}.cancellable`
		);
		const cancelledPath = join(STORAGE, 'gates', `${JOB_ID}.cancelled`);
		harness.files.set(cancelledPath, harness.files.get(cancellablePath)!);
		harness.files.delete(cancellablePath);

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(
				harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
			),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('CANCELLED');
		expect(terminal.error).toBeNull();
		expect(harness.commands).toHaveLength(0);
		expect(harness.files.has(cancelledPath)).toBe(false);
		expect(
			harness.files.has(join(STORAGE, 'locks', 'campaigns.lock'))
		).toBe(false);
		expect(
			harness.files.has(join(STORAGE, 'uploads', `${JOB_ID}.dump`))
		).toBe(false);
	});

	it('honors cancellation that wins during preflight before fencing', async () => {
		const harness = createHarness({ cancelDuringPreflight: true });

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(
				harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
			),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('CANCELLED');
		expect(
			harness.commands.some(command =>
				command.args.some(argument => argument.includes('REVOKE CONNECT'))
			)
		).toBe(false);
		expect(
			harness.commands.some(command => command.command === 'pg_dump')
		).toBe(false);
	});

	it('pauses a job while cancellation audit is pending', async () => {
		const harness = createHarness();
		const cancellablePath = join(
			STORAGE,
			'gates',
			`${JOB_ID}.cancellable`
		);
		const pendingPath = join(STORAGE, 'gates', `${JOB_ID}.cancel-pending`);
		harness.files.set(pendingPath, harness.files.get(cancellablePath)!);
		harness.files.delete(cancellablePath);

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		expect(harness.commands).toHaveLength(0);
		expect(
			harness.files.has(join(STORAGE, 'processing', `${JOB_ID}.json`))
		).toBe(true);
		expect(harness.files.has(pendingPath)).toBe(true);
		expect(
			harness.files.has(join(STORAGE, 'locks', 'campaigns.lock'))
		).toBe(true);
		expect(
			harness.files.has(join(STORAGE, 'terminal', `${JOB_ID}.json`))
		).toBe(false);
	});

	it('accepts an existing signed fence owned by the same job idempotently', async () => {
		const harness = createHarness();
		const fencePath = join(STORAGE, 'fences', 'campaigns.json');
		harness.files.set(fencePath, signedCampaignsFence(JOB_ID));

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(
				harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
			),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('SUCCEEDED');
		expect(harness.fileSystem.atomicCreateJson).toHaveBeenCalledWith(
			fencePath,
			expect.objectContaining({ jobId: JOB_ID, target: 'campaigns' })
		);
	});

	it('refuses an existing signed fence owned by another job without PostgreSQL commands', async () => {
		const harness = createHarness();
		const fencePath = join(STORAGE, 'fences', 'campaigns.json');
		const foreignFence = signedCampaignsFence(OTHER_JOB_ID);
		harness.files.set(fencePath, foreignFence);

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(
				harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
			),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('FAILED_FENCED');
		expect(harness.commands).toHaveLength(0);
		expect(harness.files.get(fencePath)).toBe(foreignFence);
		expect(harness.fileSystem.atomicCreateJson).toHaveBeenCalledTimes(1);
	});

	it('does not overwrite a foreign fence that wins the create race', async () => {
		const harness = createHarness();
		const fencePath = join(STORAGE, 'fences', 'campaigns.json');
		const foreignFence = signedCampaignsFence(OTHER_JOB_ID);
		harness.fileSystem.atomicCreateJson.mockImplementation(
			async (path: string, value: unknown) => {
				if (path !== fencePath) {
					harness.files.set(path, JSON.stringify(value));
					return true;
				}
				if (!harness.files.has(path)) {
					harness.files.set(path, foreignFence);
				}
				return false;
			}
		);

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(
				harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
			),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('FAILED_FENCED');
		expect(harness.files.get(fencePath)).toBe(foreignFence);
		expect(
			harness.commands.some(command =>
				command.args.some(argument => argument.includes('REVOKE CONNECT'))
			)
		).toBe(false);
		expect(
			harness.commands.some(command => command.command === 'pg_dump')
		).toBe(false);
		expect(harness.fileSystem.atomicCreateJson).toHaveBeenCalledTimes(2);
	});

	it('keeps the database fenced and the input dump when safety backup fails', async () => {
		const harness = createHarness({ failSafetyDump: true });

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		const terminal = parseAndVerifyDatabaseRestoreJobManifest(
			String(
				harness.files.get(join(STORAGE, 'terminal', `${JOB_ID}.json`))
			),
			QUEUE_SECRET
		);
		expect(terminal.status).toBe('FAILED_FENCED');
		expect(terminal.error?.code).toBe('SAFETY_BACKUP_FAILED');
		expect(
			harness.commands.filter(
				command =>
					command.command === 'psql' &&
					command.args.some(argument =>
						argument.includes('REVOKE CONNECT')
					)
			)
		).toHaveLength(2);
		expect(
			harness.commands.some(
				command =>
					command.command === 'psql' &&
					command.args.some(argument => argument.includes('GRANT CONNECT'))
			)
		).toBe(false);
		expect(
			harness.files.has(join(STORAGE, 'uploads', `${JOB_ID}.dump`))
		).toBe(true);
		expect(
			harness.files.has(join(STORAGE, 'locks', 'campaigns.lock'))
		).toBe(true);
		expect(
			harness.files.has(join(STORAGE, 'fences', 'campaigns.json'))
		).toBe(true);

		await harness.service.onModuleInit();
		expect(
			harness.files.has(join(STORAGE, 'locks', 'campaigns.lock'))
		).toBe(true);
		await harness.service.beforeApplicationShutdown();
	});

	it('quarantines an unauthenticated manifest without legitimizing or executing it', async () => {
		const harness = createHarness();
		const queuedPath = join(STORAGE, 'queued', `${JOB_ID}.json`);
		const tampered = JSON.parse(String(harness.files.get(queuedPath))) as {
			signature: string;
		};
		tampered.signature = '0'.repeat(64);
		harness.files.set(queuedPath, JSON.stringify(tampered));

		await expect(harness.service.processNextJob()).resolves.toBe(true);

		expect(harness.commands).toHaveLength(0);
		expect(
			harness.files.has(
				join(STORAGE, 'terminal', `${JOB_ID}.invalid-manifest`)
			)
		).toBe(true);
		expect(
			harness.files.has(join(STORAGE, 'terminal', `${JOB_ID}.json`))
		).toBe(false);
		expect(
			harness.files.has(join(STORAGE, 'locks', 'campaigns.lock'))
		).toBe(true);
	});

	it('fails startup readiness when a signed lock has no published manifest', async () => {
		const harness = createHarness();
		harness.files.delete(join(STORAGE, 'queued', `${JOB_ID}.json`));

		await expect(harness.service.onModuleInit()).rejects.toThrow(
			'Unpublished database restore lock requires manual reconciliation'
		);
		expect(harness.files.has(join(STORAGE, 'worker-ready.json'))).toBe(
			false
		);
	});

	it('reconciles terminal cancellation artifacts after a worker crash', async () => {
		const harness = createHarness();
		const queuedPath = join(STORAGE, 'queued', `${JOB_ID}.json`);
		const queued = parseAndVerifyDatabaseRestoreJobManifest(
			String(harness.files.get(queuedPath)),
			QUEUE_SECRET
		);
		const payload = { ...queued };
		delete (payload as Partial<typeof queued>).signature;
		const terminal = signDatabaseRestoreJobPayload(
			{
				...payload,
				status: 'CANCELLED',
				startedAt: '2026-07-31T12:00:01.000Z',
				finishedAt: '2026-07-31T12:00:02.000Z',
				attempt: 1
			},
			QUEUE_SECRET
		);
		harness.files.delete(queuedPath);
		harness.files.set(
			join(STORAGE, 'terminal', `${JOB_ID}.json`),
			JSON.stringify(terminal)
		);
		const cancellablePath = join(
			STORAGE,
			'gates',
			`${JOB_ID}.cancellable`
		);
		const cancelledPath = join(STORAGE, 'gates', `${JOB_ID}.cancelled`);
		harness.files.set(cancelledPath, harness.files.get(cancellablePath)!);
		harness.files.delete(cancellablePath);

		await harness.service.onModuleInit();

		expect(
			harness.files.has(join(STORAGE, 'locks', 'campaigns.lock'))
		).toBe(false);
		expect(harness.files.has(cancelledPath)).toBe(false);
		expect(
			harness.files.has(join(STORAGE, 'uploads', `${JOB_ID}.dump`))
		).toBe(false);
		await harness.service.beforeApplicationShutdown();
	});

	it('keeps the standalone polling timer referenced until shutdown', async () => {
		const harness = createHarness();

		await harness.service.onModuleInit();
		const timer = (
			harness.service as unknown as { timer: NodeJS.Timeout | null }
		).timer;
		expect(timer?.hasRef()).toBe(true);

		await harness.service.beforeApplicationShutdown();
	});

	it('reconfirms a signed durable fence before startup readiness and polling', async () => {
		const harness = createHarness();
		seedRestoreCheckpoint(harness, 'VERIFIED', { fenceSentinel: true });

		await harness.service.onModuleInit();

		const fenceEventIndex = harness.events.indexOf('command:psql:fence');
		const readinessEventIndex = harness.events.indexOf(
			`write:${join(STORAGE, 'worker-ready.json')}`
		);
		expect(fenceEventIndex).toBe(0);
		expect(readinessEventIndex).toBeGreaterThan(fenceEventIndex);
		expect(
			harness.commands.some(
				command =>
					command.command === 'pg_restore' &&
					command.args.includes('--list')
			)
		).toBe(false);
		const readiness = JSON.parse(
			String(harness.files.get(join(STORAGE, 'worker-ready.json')))
		) as { fencedTargets: string[] };
		expect(readiness.fencedTargets).toEqual(['campaigns']);

		await harness.service.beforeApplicationShutdown();
	});

	it('exposes a valid durable fence in readiness without deleting it', async () => {
		const harness = createHarness();
		harness.files.set(
			join(STORAGE, 'fences', 'campaigns.json'),
			signedCampaignsFence(JOB_ID)
		);

		await harness.service.onModuleInit();
		const readiness = JSON.parse(
			String(harness.files.get(join(STORAGE, 'worker-ready.json')))
		) as { fencedTargets: string[] };
		expect(readiness.fencedTargets).toEqual(['campaigns']);
		expect(
			harness.files.has(join(STORAGE, 'fences', 'campaigns.json'))
		).toBe(true);
		await harness.service.beforeApplicationShutdown();
	});

	it('fails startup when a signed fence belongs to a different job than the target lock', async () => {
		const harness = createHarness();
		const fencePath = join(STORAGE, 'fences', 'campaigns.json');
		const foreignFence = signedCampaignsFence(OTHER_JOB_ID);
		harness.files.set(fencePath, foreignFence);

		await expect(harness.service.onModuleInit()).rejects.toThrow(
			'Database restore fence belongs to another job for campaigns'
		);
		expect(harness.files.get(fencePath)).toBe(foreignFence);
		expect(harness.files.has(join(STORAGE, 'worker-ready.json'))).toBe(
			false
		);
		expect(harness.commands).toHaveLength(0);
	});

	it('fails startup when a signed fence target does not match its path', async () => {
		const harness = createHarness();
		const fencePath = join(STORAGE, 'fences', 'campaigns.json');
		harness.files.set(
			fencePath,
			JSON.stringify(
				signDatabaseRestoreTargetLock(
					{
						version: 1,
						target: 'reporting',
						jobId: JOB_ID,
						createdAt: '2026-07-31T12:01:00.000Z'
					},
					QUEUE_SECRET
				)
			)
		);

		await expect(harness.service.onModuleInit()).rejects.toThrow(
			'Database restore fence sentinel path mismatch for campaigns'
		);
		expect(harness.files.has(join(STORAGE, 'worker-ready.json'))).toBe(
			false
		);
		expect(harness.commands).toHaveLength(0);
	});
});

describe('DatabaseRestoreFileSystem.atomicCreateJson', () => {
	it('preserves exactly one winner when two fence creators race', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'winwidget-restore-fence-')
		);
		const fencePath = join(directory, 'campaigns.json');
		const first = { target: 'campaigns', jobId: JOB_ID };
		const second = { target: 'campaigns', jobId: OTHER_JOB_ID };
		const fileSystem = new DatabaseRestoreFileSystem();

		try {
			const [firstCreated, secondCreated] = await Promise.all([
				fileSystem.atomicCreateJson(fencePath, first),
				fileSystem.atomicCreateJson(fencePath, second)
			]);

			expect([firstCreated, secondCreated].sort()).toEqual([false, true]);
			expect(JSON.parse(await readFile(fencePath, 'utf8'))).toEqual(
				firstCreated ? first : second
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function nodeError(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}
