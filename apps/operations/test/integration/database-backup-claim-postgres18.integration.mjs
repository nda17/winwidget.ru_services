import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Reuses only the labelled CI PostgreSQL container, never its existing database.
// SQL/passwords travel over stdin; Prisma URLs stay in process memory. This is
// a PostgreSQL claim/Outbox test, NOT evidence of broker ACKs, dumps or Telegram.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const container =
	process.env.OPERATIONS_BACKUP_CLAIM_TEST_CONTAINER_ID ?? '';
const bootstrapUser =
	process.env.OPERATIONS_BACKUP_CLAIM_TEST_POSTGRES_USER ?? '';
const port = process.env.OPERATIONS_BACKUP_CLAIM_TEST_POSTGRES_PORT ?? '';
const fixtureId = randomUUID().replaceAll('-', '');
const database = `ops_backup_claim_${fixtureId}`;
const migrationRole = `ops_claim_migration_${fixtureId}`;
const runtimeRole = `ops_claim_runtime_${fixtureId}`;
const runtimePassword = randomBytes(32).toString('hex');
const migrationPassword = randomBytes(32).toString('hex');
const timeoutMs = 15_000;
const rolesCreated = [];
const clients = [];
let databaseCreated = false;
let casesPassed = 0;

const docker = (args, input) => {
	const result = spawnSync('docker', args, {
		input,
		encoding: 'utf8',
		timeout: 30_000,
		maxBuffer: 8 * 1024 * 1024,
		env: {
			...process.env,
			DOCKER_HOST: undefined,
			DOCKER_CONTEXT: undefined
		}
	});
	assert.equal(
		result.status,
		0,
		'Isolated Docker/SQL fixture command failed'
	);
	return result.stdout.trim();
};
const sql = (statement, targetDatabase = database) => {
	assert.ok(targetDatabase === database || targetDatabase === 'postgres');
	return docker(
		[
			'exec',
			'-i',
			container,
			'psql',
			'--no-password',
			'-X',
			'-qAt',
			'--set',
			'ON_ERROR_STOP=1',
			'--host',
			'/var/run/postgresql',
			'--port',
			'5432',
			'--username',
			bootstrapUser,
			'--dbname',
			targetDatabase
		],
		statement
	);
};
const assertBoundary = () => {
	assert.equal(
		process.env.OPERATIONS_BACKUP_CLAIM_TEST_ALLOW_MUTATION,
		'true',
		'OPERATIONS_BACKUP_CLAIM_TEST_ALLOW_MUTATION=true is required'
	);
	assert.match(
		container,
		/^[a-f0-9]{12,64}$/,
		'Concrete fixture container ID is required'
	);
	assert.equal(bootstrapUser, 'operations_control_ledger_superuser');
	assert.match(port, /^[1-9]\d{0,4}$/);
	assert.ok(Number(port) <= 65_535);
	const context = docker(['context', 'show']);
	const endpoint = docker([
		'context',
		'inspect',
		context,
		'--format',
		'{{.Endpoints.docker.Host}}'
	]);
	assert.ok(
		endpoint.startsWith('unix://'),
		'Only local Unix-socket Docker is allowed'
	);
	const info = JSON.parse(docker(['inspect', container]))[0];
	assert.equal(info.State.Running, true);
	assert.equal(
		info.Config.Labels?.['winwidget.operations-control-ledger'],
		'true'
	);
	assert.ok(
		info.NetworkSettings.Ports?.['5432/tcp']?.some(
			binding =>
				binding.HostPort === port &&
				['0.0.0.0', '127.0.0.1', ''].includes(binding.HostIp)
		)
	);
	assert.match(sql('SHOW server_version_num;', 'postgres'), /^18\d{4}$/);
	assert.equal(
		sql("SELECT current_user || ':' || current_database();", 'postgres'),
		`${bootstrapUser}:postgres`
	);
	assert.equal(
		sql(
			`SELECT count(*) FROM pg_database WHERE datname = '${database}';`,
			'postgres'
		),
		'0'
	);
	assert.equal(
		sql(
			`SELECT count(*) FROM pg_roles WHERE rolname IN ('${migrationRole}', '${runtimeRole}');`,
			'postgres'
		),
		'0'
	);
};

const prepareDatabase = () => {
	sql(`CREATE DATABASE "${database}";`, 'postgres');
	databaseCreated = true;
	for (const [role, password] of [
		[migrationRole, migrationPassword],
		[runtimeRole, runtimePassword]
	]) {
		sql(
			`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
			'postgres'
		);
		rolesCreated.push(role);
	}
	sql(`
		REVOKE ALL ON DATABASE "${database}" FROM PUBLIC;
		GRANT CONNECT ON DATABASE "${database}" TO "${migrationRole}", "${runtimeRole}";
		REVOKE ALL ON SCHEMA public FROM PUBLIC;
		CREATE SCHEMA operations AUTHORIZATION "${migrationRole}";
		CREATE SCHEMA foreign_service_guard;
		CREATE TABLE foreign_service_guard.sentinel (id integer PRIMARY KEY);
		REVOKE ALL ON SCHEMA foreign_service_guard FROM PUBLIC;
		REVOKE ALL ON ALL TABLES IN SCHEMA foreign_service_guard FROM PUBLIC;
	`);
	// Same restricted SET ROLE/full SQL migration-chain pattern as the existing
	// Operations Backlog integration. No fabricated Prisma migration receipts.
	const migrations = new URL('../../prisma/migrations/', import.meta.url);
	const entries = readdirSync(migrations, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort();
	assert.ok(entries.length > 0);
	for (const name of entries) {
		assert.match(name, /^\d{14}_[a-z0-9_]+$/);
		sql(
			`SET ROLE "${migrationRole}";\n${readFileSync(new URL(`${name}/migration.sql`, migrations), 'utf8')}`
		);
	}
	sql(`
		GRANT USAGE ON SCHEMA operations TO "${runtimeRole}";
		GRANT SELECT, INSERT, UPDATE, DELETE ON
			operations.scheduled_job_runs, operations.outbox_events,
			operations.operational_alerts TO "${runtimeRole}";
		GRANT SELECT ON operations.service_identity TO "${runtimeRole}";
	`);
};

const within = async (promise, label) => {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Timed out: ${label}`)),
					timeoutMs
				);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
};
const deferred = () => {
	let release;
	const promise = new Promise(resolve => {
		release = resolve;
	});
	return { promise, release };
};
const boundValue = (target, key) => {
	const value = Reflect.get(target, key);
	return typeof value === 'function' ? value.bind(target) : value;
};
const transactionProxy = (prisma, model, method, intercept) => ({
	$transaction: (callback, options) =>
		prisma.$transaction(
			transaction =>
				callback(
					new Proxy(transaction, {
						get(target, key) {
							if (key !== model) return boundValue(target, key);
							return new Proxy(target[model], {
								get(delegate, operation) {
									if (operation !== method)
										return boundValue(delegate, operation);
									return args =>
										intercept(args, () => delegate[method](args));
								}
							});
						}
					})
				),
			options
		)
});
const pauseCas = (prisma, jobId) => {
	const entered = deferred(),
		resume = deferred();
	let calls = 0,
		affected;
	const proxy = transactionProxy(
		prisma,
		'scheduledJobRun',
		'updateMany',
		async (args, run) => {
			assert.equal(args.where.id, jobId);
			assert.equal(
				++calls,
				1,
				'CAS barrier must intercept exactly one real update'
			);
			entered.release(args.where);
			await within(resume.promise, 'release CAS barrier');
			const result = await run();
			affected = result.count;
			return result;
		}
	);
	return {
		proxy,
		entered: entered.promise,
		release: resume.release,
		count: () => affected
	};
};

async function verifyClaims() {
	const require = createRequire(import.meta.url);
	require('reflect-metadata');
	const { PrismaClient } = require('@prisma/operations-client');
	const { ScheduledJobsService } = require(
		resolve(appRoot, 'dist/src/scheduled-jobs/scheduled-jobs.service.js')
	);
	const { OperationsOutboxService } = require(
		resolve(appRoot, 'dist/src/messaging/operations-outbox.service.js')
	);
	const { OperationalAlertService } = require(
		resolve(appRoot, 'dist/src/monitoring/operational-alert.service.js')
	);
	const { DATABASE_BACKUP_TARGETS, databaseBackupJobType } = require(
		resolve(appRoot, 'dist/src/scheduled-jobs/scheduled-jobs.types.js')
	);
	const {
		OPERATIONS_SCHEDULED_JOB_EVENT_TYPE,
		OPERATIONS_SCHEDULED_JOB_ROUTING_KEY
	} = require(
		resolve(
			appRoot,
			'dist/src/messaging/operations-messaging.constants.js'
		)
	);
	const runtimeUrl = `postgresql://${runtimeRole}:${runtimePassword}@127.0.0.1:${port}/${database}?schema=operations&sslmode=disable&connection_limit=2`;
	for (let index = 0; index < 2; index++) {
		const client = new PrismaClient({
			datasources: { db: { url: runtimeUrl } },
			log: [],
			transactionOptions: { maxWait: timeoutMs, timeout: timeoutMs }
		});
		clients.push(client);
		await client.$connect();
		const [identity] = await client.$queryRawUnsafe(`SELECT
			current_user AS "role", session_user AS "sessionRole", current_database() AS "database",
			NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit
				AND NOT rolreplication AND NOT rolbypassrls AS "restricted",
			NOT has_database_privilege(current_user, current_database(), 'CREATE') AS "noDatabaseCreate",
			NOT has_schema_privilege(current_user, 'operations', 'CREATE') AS "noSchemaCreate",
			NOT has_schema_privilege(current_user, 'foreign_service_guard', 'USAGE') AS "noForeignSchema",
			(SELECT NOT has_table_privilege(current_user, tables.oid, 'SELECT')
				FROM pg_class AS tables JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
				WHERE schemas.nspname = 'foreign_service_guard' AND tables.relname = 'sentinel') AS "noForeignRead",
			NOT has_table_privilege(current_user, 'operations.database_restore_jobs', 'UPDATE') AS "noRestoreWrite"
			FROM pg_roles WHERE rolname = current_user`);
		assert.deepEqual(identity, {
			role: runtimeRole,
			sessionRole: runtimeRole,
			database,
			restricted: true,
			noDatabaseCreate: true,
			noSchemaCreate: true,
			noForeignSchema: true,
			noForeignRead: true,
			noRestoreWrite: true
		});
		const serviceIdentity = await client.serviceIdentity.findUniqueOrThrow(
			{ where: { id: 'singleton' } }
		);
		assert.equal(serviceIdentity.serviceName, 'operations-service');
	}
	const [a, b] = clients;
	const service = prisma =>
		new ScheduledJobsService(
			prisma,
			new OperationsOutboxService(),
			new OperationalAlertService(prisma)
		);
	const first = service(a),
		second = service(b);
	const seed = async (target = 'crm-access', patch = {}) => {
		const job = await a.scheduledJobRun.create({
			data: {
				jobType: databaseBackupJobType(target),
				scheduleKey: `claim-ci:${randomUUID()}`,
				scheduledFor: new Date(Date.now() - 60_000),
				availableAt: new Date(Date.now() - 60_000),
				input: {
					schemaVersion: 1,
					target,
					trigger: 'MANUAL',
					chatId: 'synthetic'
				},
				trigger: 'MANUAL',
				...patch
			}
		});
		return {
			job,
			event: { eventId: randomUUID(), jobId: job.id, jobType: job.jobType }
		};
	};
	const row = id => a.scheduledJobRun.findUniqueOrThrow({ where: { id } });
	const events = id =>
		a.outboxEvent.findMany({
			where: { aggregateId: id },
			orderBy: { createdAt: 'asc' }
		});
	const claim = (svc, event, worker = 'claim-ci-worker') =>
		svc.claimBackup(event, worker, 60_000);
	const runCase = async (name, callback) => {
		try {
			await callback();
		} catch (error) {
			throw new Error(`Case ${name}: ${error.message}`, { cause: error });
		}
		casesPassed++;
		process.stdout.write(`backup_claim_case=${name}:passed\n`);
	};

	await runCase('target-contract', async () => {
		assert.deepEqual(DATABASE_BACKUP_TARGETS, [
			'notification-delivery',
			'campaigns',
			'reporting',
			'widgets',
			'billing',
			'identity',
			'platform',
			'support',
			'operations',
			'crm-access',
			'crm-intake',
			'crm-customers',
			'crm-sales'
		]);
		for (const target of DATABASE_BACKUP_TARGETS) {
			const { job, event } = await seed(target);
			const result = await claim(first, event);
			assert.equal(result.status, 'CLAIMED');
			assert.equal(result.job.attempts, 1);
			assert.equal((await row(job.id)).leaseToken, result.leaseToken);
		}
		const { job, event } = await seed();
		for (const invalid of [
			{ ...event, jobType: 'DATABASE_RESTORE' },
			{ ...event, jobType: 'CRM_SALES_DATABASE_BACKUP' },
			{ ...event, jobId: randomUUID() }
		])
			assert.deepEqual(await claim(first, invalid), { status: 'REJECT' });
		assert.deepEqual(await row(job.id), job);
		assert.deepEqual(await events(job.id), []);
	});

	await runCase('competing-claims-real-cas', async () => {
		const { job, event } = await seed();
		const gate = pauseCas(a, job.id);
		const pending = claim(service(gate.proxy), event, 'losing-worker');
		pending.catch(() => {});
		try {
			await within(gate.entered, 'first claimant read');
			const winner = await claim(second, event, 'winning-worker');
			assert.equal(winner.status, 'CLAIMED');
			gate.release();
			assert.deepEqual(await pending, { status: 'REQUEUE' });
			assert.equal(gate.count(), 0);
			const after = await row(job.id);
			assert.equal(after.attempts, 1);
			assert.equal(after.leaseOwner, 'winning-worker');
			assert.equal(after.leaseToken, winner.leaseToken);
		} finally {
			gate.release();
			await pending.catch(() => {});
		}
	});

	await runCase('availability-real-cas', async () => {
		const { job, event } = await seed();
		const gate = pauseCas(a, job.id);
		const pending = claim(service(gate.proxy), event);
		pending.catch(() => {});
		try {
			await within(gate.entered, 'availability claimant read');
			const changed = await b.scheduledJobRun.update({
				where: { id: job.id },
				data: { availableAt: new Date(Date.now() + 60_000) }
			});
			gate.release();
			assert.deepEqual(await pending, { status: 'REQUEUE' });
			assert.equal(gate.count(), 0);
			assert.deepEqual(await row(job.id), changed);
		} finally {
			gate.release();
			await pending.catch(() => {});
		}
	});

	for (const attempts of [1, 4])
		await runCase(
			`uncommitted-heartbeat-fences-attempt-${attempts}`,
			async () => {
				const { job, event } = await seed('crm-sales', {
					status: 'PROCESSING',
					attempts,
					leaseOwner: 'original-worker',
					leaseToken: randomUUID(),
					leaseExpiresAt: new Date(Date.now() - 1_000)
				});
				// Seed first, then establish a fresh committed lease window. Its
				// duration includes CI scheduling slack before the genuine renewal.
				const oldExpiry = new Date(Date.now() + 5_000);
				await a.scheduledJobRun.update({
					where: { id: job.id },
					data: { leaseExpiresAt: oldExpiry }
				});
				const renewed = deferred(),
					commitHeartbeat = deferred();
				// Renew while the old lease is VALID, hold its row lock/commit, then let
				// claimBackup read the old committed row after that original expiry.
				const heartbeat = b.$transaction(async transaction => {
					assert.equal(
						await service(transaction).renewLease(
							job.id,
							job.leaseToken,
							60_000
						),
						true
					);
					renewed.release();
					await within(
						commitHeartbeat.promise,
						'heartbeat commit barrier'
					);
				});
				heartbeat.catch(() => {});
				const gate = pauseCas(a, job.id);
				let pending;
				try {
					await within(
						Promise.race([
							renewed.promise,
							heartbeat.then(() => {
								throw new Error('Heartbeat ended before barrier');
							})
						]),
						'heartbeat update'
					);
					await delay(Math.max(0, oldExpiry.getTime() - Date.now() + 20));
					pending = claim(service(gate.proxy), event, 'stale-claimant');
					pending.catch(() => {});
					const snapshot = await within(
						gate.entered,
						'expired committed snapshot'
					);
					assert.equal(snapshot.leaseToken, job.leaseToken);
					commitHeartbeat.release();
					await heartbeat;
					gate.release();
					assert.deepEqual(await pending, { status: 'REQUEUE' });
					assert.equal(gate.count(), 0);
					const after = await row(job.id);
					assert.equal(after.status, 'PROCESSING');
					assert.equal(after.attempts, attempts);
					assert.equal(after.leaseToken, job.leaseToken);
					assert.ok(after.leaseExpiresAt > oldExpiry);
					assert.equal(
						await a.operationalAlert.count({
							where: { referenceId: job.id }
						}),
						0
					);
				} finally {
					commitHeartbeat.release();
					gate.release();
					await heartbeat.catch(() => {});
					await pending?.catch(() => {});
				}
			}
		);

	await runCase(
		'durable-deferral-and-published-recovery-replay',
		async () => {
			const { job, event } = await seed();
			const original = await claim(first, event);
			assert.equal(original.status, 'CLAIMED');
			const before = await row(job.id);
			assert.deepEqual(await claim(second, event), { status: 'DEFERRED' });
			const [recovery] = await events(job.id);
			assert.ok(recovery.availableAt >= before.leaseExpiresAt);
			// Simulates publisher state only. No claim of real broker publication.
			await a.outboxEvent.update({
				where: { id: recovery.id },
				data: { status: 'PUBLISHED', publishedAt: new Date() }
			});
			assert.deepEqual(await claim(second, event), { status: 'DEFERRED' });
			assert.deepEqual(await claim(second, recovery.payload), {
				status: 'DEFERRED'
			});
			const triggers = await events(job.id);
			assert.equal(triggers.length, 3);
			assert.equal(new Set(triggers.map(item => item.eventId)).size, 3);
			assert.equal(
				new Set(triggers.map(item => item.deduplicationKey)).size,
				3
			);
			assert.equal(
				triggers.filter(item => item.status === 'PENDING').length,
				2
			);
			for (const trigger of triggers) {
				assert.equal(
					trigger.eventType,
					OPERATIONS_SCHEDULED_JOB_EVENT_TYPE
				);
				assert.equal(
					trigger.routingKey,
					OPERATIONS_SCHEDULED_JOB_ROUTING_KEY
				);
				assert.deepEqual(trigger.payload, {
					schemaVersion: 1,
					eventId: trigger.eventId,
					jobId: job.id,
					jobType: job.jobType
				});
				assert.ok(trigger.availableAt >= before.leaseExpiresAt);
			}
			assert.deepEqual(await row(job.id), before);
			// Deterministic fixture expiry; real heartbeat concurrency is covered above.
			await a.scheduledJobRun.update({
				where: { id: job.id },
				data: { leaseExpiresAt: new Date(Date.now() - 1_000) }
			});
			const replacement = await claim(
				second,
				recovery.payload,
				'replacement-worker'
			);
			assert.equal(replacement.status, 'CLAIMED');
			assert.equal(replacement.job.attempts, 2);
			assert.notEqual(replacement.leaseToken, original.leaseToken);
			assert.equal(
				await first.complete(job.id, original.leaseToken, {}),
				false
			);
			assert.equal(
				await second.complete(job.id, replacement.leaseToken, {}),
				true
			);
			assert.deepEqual(await claim(first, event), { status: 'TERMINAL' });
		}
	);

	await runCase('future-queued-deferral-preserves-attempt', async () => {
		const { job, event } = await seed('crm-intake', {
			availableAt: new Date(Date.now() + 120_000)
		});
		assert.deepEqual(await claim(first, event), { status: 'DEFERRED' });
		assert.deepEqual(await row(job.id), job);
		assert.equal(
			(await events(job.id))[0].availableAt.getTime(),
			job.availableAt.getTime()
		);
	});

	for (const operation of ['create', 'updateMany'])
		await runCase(`outbox-${operation}-rollback`, async () => {
			const { job, event } = await seed('crm-customers', {
				availableAt: new Date(Date.now() + 120_000)
			});
			const broken = transactionProxy(
				a,
				'outboxEvent',
				operation,
				async (_args, run) => {
					await run(); // The real write MUST roll back, not merely a fake failure before SQL.
					throw new Error('Injected Outbox transaction failure');
				}
			);
			await assert.rejects(
				claim(service(broken), event),
				/Injected Outbox transaction failure/
			);
			assert.deepEqual(await events(job.id), []);
			assert.deepEqual(await row(job.id), job);
		});

	await runCase('exhaustion-and-alert-atomicity', async () => {
		const expired = {
			status: 'PROCESSING',
			attempts: 4,
			leaseOwner: 'expired-worker',
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() - 1_000)
		};
		const { job, event } = await seed('crm-customers', expired);
		const broken = transactionProxy(
			a,
			'operationalAlert',
			'upsert',
			async (_args, run) => {
				await run();
				throw new Error('Injected alert transaction failure');
			}
		);
		await assert.rejects(
			claim(service(broken), event),
			/Injected alert transaction failure/
		);
		assert.deepEqual(await row(job.id), job);
		assert.equal(
			await a.operationalAlert.count({ where: { referenceId: job.id } }),
			0
		);
		assert.deepEqual(await claim(first, event), { status: 'TERMINAL' });
		const after = await row(job.id);
		assert.equal(after.status, 'FAILED');
		assert.equal(after.attempts, 4);
		assert.equal(after.leaseToken, null);
		assert.equal(after.leaseExpiresAt, null);
		assert.ok(after.finishedAt instanceof Date);
		const alert = await a.operationalAlert.findUniqueOrThrow({
			where: { deduplicationKey: 'database-backup:crm-customers' }
		});
		assert.equal(alert.referenceId, job.id);
		assert.equal(alert.severity, 'HIGH');
		assert.deepEqual(await claim(first, event), { status: 'TERMINAL' });
		assert.equal(
			await a.operationalAlert.count({ where: { referenceId: job.id } }),
			1
		);
		assert.deepEqual(await events(job.id), []);
	});
}

async function main() {
	try {
		assertBoundary();
		prepareDatabase();
		await verifyClaims();
	} finally {
		const failures = [];
		for (const client of clients) {
			try {
				await client.$disconnect();
			} catch {
				failures.push('disconnect');
			}
		}
		// Names are generated here and validated again at the destructive boundary.
		if (databaseCreated) {
			assert.equal(database, `ops_backup_claim_${fixtureId}`);
			assert.match(database, /^ops_backup_claim_[a-f0-9]{32}$/);
			try {
				sql(`DROP DATABASE "${database}";`, 'postgres');
			} catch {
				failures.push('database cleanup');
			}
		}
		for (const role of rolesCreated.reverse()) {
			assert.ok(role === migrationRole || role === runtimeRole);
			assert.match(role, /^ops_claim_(?:migration|runtime)_[a-f0-9]{32}$/);
			try {
				sql(`DROP ROLE "${role}";`, 'postgres');
			} catch {
				failures.push('role cleanup');
			}
		}
		if (databaseCreated && failures.length === 0) {
			assert.equal(
				sql(
					`SELECT count(*) FROM pg_database WHERE datname = '${database}';`,
					'postgres'
				),
				'0'
			);
			assert.equal(
				sql(
					`SELECT count(*) FROM pg_roles WHERE rolname IN ('${migrationRole}', '${runtimeRole}');`,
					'postgres'
				),
				'0'
			);
		}
		assert.deepEqual(
			failures,
			[],
			'Isolated claim fixture cleanup failed'
		);
	}
	process.stdout.write(
		`operations_backup_claim_postgres18=passed cases=${casesPassed}; fixture=removed; broker_delivery=not_tested\n`
	);
}

main().catch(error => {
	// Do not print raw subprocess stderr, connection URLs, SQL or credentials.
	const message = String(error?.message ?? 'Unknown integration error')
		.replaceAll(runtimePassword, '[redacted]')
		.replaceAll(migrationPassword, '[redacted]')
		.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/g, '[redacted-url]')
		.slice(0, 2_000);
	process.stderr.write(
		`operations_backup_claim_postgres18=failed: ${message}\n`
	);
	process.exitCode = 1;
});
