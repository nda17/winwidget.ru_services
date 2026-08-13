import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma, PrismaClient } from '@prisma/client';

const lifecyclePath = fileURLToPath(
	new URL('./reporting-producer-lifecycle.sh', import.meta.url)
);
const prismaCliPath = fileURLToPath(
	new URL('../node_modules/prisma/build/index.js', import.meta.url)
);
const prismaSchemaPath = fileURLToPath(
	new URL('../prisma/schema.prisma', import.meta.url)
);
const activeChildren = new Set();
let aggregateType = 'reporting.settings';
const aggregateId = 'singleton';
let eventType = 'reporting.settings.changed.v1';
let settingsTopologyMode = 'transition';
const identityAggregateType = 'identity.user';
const identityEventType = 'identity.user.changed.v1';
const lifecycleLockMarker = 'winwidget.reporting.producer.lifecycle.v1';
const producerFunctionSignatures = [
	'public.reporting_producers_enabled()',
	'public.reporting_iso_timestamp(timestamp without time zone)',
	'public.reporting_record_projection_event(text,text,text,text,jsonb,boolean)',
	'public.reporting_emit_user_projection(text,boolean)',
	'public.reporting_user_projection_trigger()',
	'public.reporting_auth_identity_projection_trigger()',
	'public.reporting_settings_projection_trigger()'
];
const legacyWidgetsProducerTables = [
	'widgets',
	'quizzes',
	'callbacks',
	'countdown_timers',
	'stop_offers',
	'online_consultants',
	'calculators',
	'leads',
	'quiz_leads',
	'callback_leads',
	'countdown_timer_leads',
	'stop_offer_leads',
	'online_consultant_leads',
	'calculator_leads'
];
const producerFunctionSqlArray = producerFunctionSignatures
	.map(signature => `'${signature}'`)
	.join(',\n        ');
const restoreProducerFunctionAclSql = `
DO $reporting_restore_acl$
DECLARE
    function_signature TEXT;
    function_oid REGPROCEDURE;
    present_function_count INTEGER;
BEGIN
    SELECT count(*)
    INTO present_function_count
    FROM unnest(ARRAY[
        ${producerFunctionSqlArray}
    ]) AS expected(signature)
    WHERE to_regprocedure(expected.signature) IS NOT NULL;

    IF present_function_count NOT IN (0, ${producerFunctionSignatures.length}) THEN
        RAISE EXCEPTION
            'Incomplete Reporting producer function set after restore: % of ${producerFunctionSignatures.length}',
            present_function_count;
    END IF;

    FOREACH function_signature IN ARRAY ARRAY[
        ${producerFunctionSqlArray}
    ] LOOP
        function_oid := to_regprocedure(function_signature);
        IF function_oid IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE format(
            'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',
            function_oid
        );
        IF EXISTS (
            SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_api_runtime'
        ) THEN
            EXECUTE format(
                'GRANT EXECUTE ON FUNCTION %s TO %I',
                function_oid,
                'winwidget_api_runtime'
            );
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
            ${producerFunctionSqlArray}
        ]) AS expected(signature)
        JOIN pg_proc procedure
            ON procedure.oid = to_regprocedure(expected.signature)
        CROSS JOIN LATERAL aclexplode(
            COALESCE(
                procedure.proacl,
                acldefault('f', procedure.proowner)
            )
        ) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION
            'Reporting producer functions remain executable by PUBLIC after restore';
    END IF;
END
$reporting_restore_acl$;
`;

const sleep = milliseconds =>
	new Promise(resolve => setTimeout(resolve, milliseconds));

const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, reject, resolve };
};

const requireTestDatabaseUrl = () => {
	const rawUrl = process.env.REPORTING_PRODUCER_TEST_DATABASE_URL;
	if (!rawUrl) {
		throw new Error(
			'REPORTING_PRODUCER_TEST_DATABASE_URL is required and must point to a loopback CI/test PostgreSQL database'
		);
	}

	for (const [key, value] of Object.entries(process.env)) {
		if (key.includes('PRODUCTION') && value === rawUrl) {
			throw new Error(
				`REPORTING_PRODUCER_TEST_DATABASE_URL must not reuse ${key}`
			);
		}
	}

	const url = new URL(rawUrl);
	if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
		throw new Error(
			'REPORTING_PRODUCER_TEST_DATABASE_URL must use PostgreSQL'
		);
	}
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
		throw new Error(
			'REPORTING_PRODUCER_TEST_DATABASE_URL must use a loopback host'
		);
	}
	const databaseName = decodeURIComponent(url.pathname.slice(1));
	if (!/^[a-zA-Z0-9_]*(?:_ci|_test)$/.test(databaseName)) {
		throw new Error(
			'REPORTING_PRODUCER_TEST_DATABASE_URL database name must end with _ci or _test'
		);
	}
	return url;
};

const functionBlock = (source, name, nextName) => {
	const start = source.indexOf(`${name}() {`);
	const end = source.indexOf(`${nextName}() {`, start + 1);
	if (start < 0 || end < 0) {
		throw new Error(
			`Cannot locate ${name} in Reporting producer lifecycle`
		);
	}
	return source.slice(start, end);
};

const coreHeredoc = block => {
	const commandStart = block.search(/reporting_core_(?:migration_)?psql/);
	const sqlStartMarker = "<<'SQL'\n";
	const sqlStart = block.indexOf(sqlStartMarker, commandStart);
	const sqlEnd = block.indexOf(
		'\nSQL\n',
		sqlStart + sqlStartMarker.length
	);
	if (commandStart < 0 || sqlStart < 0 || sqlEnd < 0) {
		throw new Error('Cannot extract Core PostgreSQL lifecycle heredoc');
	}
	return block.slice(sqlStart + sqlStartMarker.length, sqlEnd).trim();
};

const shellSingleQuotedCommand = block => {
	const marker =
		"reporting_core_migration_psql --tuples-only --no-align --command '\n";
	const sqlStart = block.indexOf(marker);
	const sqlEnd = block.indexOf('\n\')"', sqlStart + marker.length);
	if (sqlStart < 0 || sqlEnd < 0) {
		throw new Error('Cannot extract Core PostgreSQL lifecycle command');
	}
	return block
		.slice(sqlStart + marker.length, sqlEnd)
		.replaceAll(`'"'"'`, `'`)
		.trim();
};

const loadLifecycleSql = async () => {
	const source = await readFile(lifecyclePath, 'utf8');
	const migrationGuardSql = coreHeredoc(
		functionBlock(
			source,
			'reporting_require_core_producer_migration',
			'reporting_require_core_producer_acl'
		)
	);
	const aclGuardSql = coreHeredoc(
		functionBlock(
			source,
			'reporting_require_core_producer_acl',
			'reporting_require_source_data_preflight'
		)
	);
	const enableSql = coreHeredoc(
		functionBlock(
			source,
			'reporting_enable_producers',
			'reporting_disable_producers'
		)
	);
	const disableSql = shellSingleQuotedCommand(
		functionBlock(
			source,
			'reporting_disable_producers',
			'reporting_require_reset_queue_boundary'
		)
	);
	const resetSql = coreHeredoc(
		functionBlock(
			source,
			'reporting_reset_projection_target',
			'reporting_producer_lifecycle_self_test'
		)
	);

	for (const [name, sql] of [
		['enable', enableSql],
		['disable', disableSql],
		['reset', resetSql]
	]) {
		assert.match(
			sql,
			/BEGIN;/,
			`${name} boundary must start a transaction`
		);
		assert.match(
			sql,
			/COMMIT;/,
			`${name} boundary must commit explicitly`
		);
		assert.ok(
			sql.includes(lifecycleLockMarker),
			`${name} boundary must take the lifecycle advisory lock`
		);
		assert.ok(
			sql.indexOf('LOCK TABLE') < sql.indexOf('FOR UPDATE'),
			`${name} boundary must lock source tables before producer state`
		);
		assert.match(
			sql,
			/IN SHARE MODE;/,
			`${name} boundary must fence source writers`
		);
		for (const tableName of legacyWidgetsProducerTables) {
			assert.ok(
				!sql.includes(`"${tableName}"`),
				`${name} boundary must not lock removed Widgets table ${tableName}`
			);
		}
	}
	assert.match(
		enableSql,
		/fenced target reset is required before reactivation/i
	);
	assert.match(
		enableSql,
		/database_backup_time[\s\S]*ARRAY\[0, 15, 30, 45\]/i,
		'Activation must recheck every delayed backup schedule under the writer barrier'
	);
	assert.doesNotMatch(
		resetSql,
		/reporting_projection_versions[^;]*DELETE/i
	);
	assert.doesNotMatch(
		resetSql,
		/DELETE\s+FROM\s+"reporting_projection_versions"/i
	);
	assert.match(resetSql, /SET\s+"activated_at"\s*=\s*NULL/i);
	assert.match(
		migrationGuardSql,
		/JOIN pg_namespace function_namespace\s+ON function_namespace\.oid = procedure\.pronamespace/i,
		'Core producer guard must resolve the trigger function namespace independently from the table namespace'
	);
	assert.match(
		migrationGuardSql,
		/function_namespace\.nspname AS function_namespace/i,
		'Core producer guard must compare the actual trigger function namespace'
	);
	assert.match(
		migrationGuardSql,
		/trigger_name, table_name, function_namespace, function_name/i,
		'Core producer guard must require the expected public function namespace'
	);
	assert.match(
		migrationGuardSql,
		/\(SELECT count\(\*\) FROM expected\)\s*=\s*3[\s\S]*\(SELECT count\(\*\) FROM actual\)\s*=\s*3/i,
		'Core producer guard must require the exact three steady-state triggers'
	);
	for (const removedBillingSource of [
		'payments',
		'subscriptions',
		'reporting_payment_projection_trigger',
		'reporting_subscription_projection_trigger'
	]) {
		assert.doesNotMatch(
			`${migrationGuardSql}\n${aclGuardSql}\n${enableSql}\n${disableSql}\n${resetSql}`,
			new RegExp(removedBillingSource, 'i'),
			`Reporting lifecycle must not require removed Billing source ${removedBillingSource}`
		);
	}
	assert.doesNotMatch(
		migrationGuardSql,
		/reporting_(?:widget|lead)_projection_trigger/i,
		'Core producer guard must not retain removed Widgets trigger functions'
	);
	assert.match(
		aclGuardSql,
		/aclexplode\([\s\S]*privilege\.grantee\s*=\s*0[\s\S]*privilege\.privilege_type\s*=\s*'EXECUTE'/i,
		'Core producer ACL guard must fail closed when PUBLIC can execute a producer function'
	);
	assert.match(
		aclGuardSql,
		/\('winwidget_maintenance'\)[\s\S]*\('winwidget_backup'\)[\s\S]*has_function_privilege/i,
		'Core producer ACL guard must reject execute access for restricted service roles'
	);
	assert.doesNotMatch(
		aclGuardSql,
		/reporting_(?:widget|lead)_projection_trigger/i,
		'Core producer ACL guard must not retain removed Widgets functions'
	);

	return { disableSql, enableSql, resetSql };
};

const startPrismaCommand = ({ args, databaseUrl, input, label }) => {
	const child = spawn(process.execPath, [prismaCliPath, ...args], {
		cwd: fileURLToPath(new URL('..', import.meta.url)),
		env: {
			...process.env,
			DATABASE_URL: databaseUrl
		},
		stdio: ['pipe', 'pipe', 'pipe']
	});
	activeChildren.add(child);
	let settled = false;
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		stdout += chunk;
	});
	child.stderr.on('data', chunk => {
		stderr += chunk;
	});
	if (input === undefined) child.stdin.end();
	else child.stdin.end(input);

	const result = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code, signal) => {
			settled = true;
			activeChildren.delete(child);
			resolve({ code, label, signal, stderr, stdout });
		});
	});

	return {
		child,
		get settled() {
			return settled;
		},
		result
	};
};

const commandFailure = result => {
	const output = `${result.stderr}\n${result.stdout}`.trim();
	return new Error(
		`${result.label} failed (code=${result.code}, signal=${
			result.signal || 'none'
		}): ${output.slice(-4000)}`
	);
};

const expectCommandSuccess = async operation => {
	const result = await operation.result;
	if (result.code !== 0) throw commandFailure(result);
	return result;
};

const startSql = (databaseUrl, sql, label) =>
	startPrismaCommand({
		args: ['db', 'execute', '--stdin', '--schema', prismaSchemaPath],
		databaseUrl,
		input: `${sql}\n`,
		label
	});

const runSql = (databaseUrl, sql, label) =>
	expectCommandSuccess(startSql(databaseUrl, sql, label));

const runExternalCommand = ({ command, args, label }) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		activeChildren.add(child);
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => {
			stdout += chunk;
		});
		child.stderr.on('data', chunk => {
			stderr += chunk;
		});
		child.once('error', error => {
			activeChildren.delete(child);
			reject(new Error(`${label} could not start: ${error.message}`));
		});
		child.once('close', (code, signal) => {
			activeChildren.delete(child);
			const result = { code, label, signal, stderr, stdout };
			if (code === 0) resolve(result);
			else reject(commandFailure(result));
		});
	});

const postgresCommandUrl = databaseUrl => {
	const url = new URL(databaseUrl);
	url.searchParams.delete('schema');
	url.searchParams.delete('options');
	return url.toString();
};

const runPostgresTool = (command, args, label) => {
	const containerId =
		process.env.REPORTING_PRODUCER_TEST_POSTGRES_CONTAINER_ID?.trim();
	if (containerId) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerId)) {
			throw new Error(
				'REPORTING_PRODUCER_TEST_POSTGRES_CONTAINER_ID is invalid'
			);
		}
		return runExternalCommand({
			command: 'docker',
			args: ['exec', containerId, command, ...args],
			label
		});
	}
	return runExternalCommand({ command, args, label });
};

const waitFor = async (condition, label, timeoutMs = 15_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await condition();
		if (value) return value;
		await sleep(50);
	}
	throw new Error(`Timed out waiting for ${label}`);
};

const prepareFixture = async prisma => {
	await prisma.$transaction(async transaction => {
		await transaction.$executeRawUnsafe(`
			UPDATE "reporting_producer_state"
			SET "enabled" = false,
				"activated_at" = NULL,
				"daily_summary_owner" = 'CORE',
				"daily_summary_schedule_time" = '01:50',
				"daily_summary_schedule_generation" = 0,
				"updated_at" = CURRENT_TIMESTAMP
			WHERE "id" = 'singleton'
		`);
		await transaction.$executeRawUnsafe(`
			DELETE FROM "outbox_events"
			WHERE "event_type" = '${eventType}'
		`);
		await transaction.$executeRawUnsafe(`
			DELETE FROM "reporting_projection_versions"
			WHERE "aggregate_type" = '${aggregateType}'
				AND "aggregate_id" = '${aggregateId}'
		`);
		if (settingsTopologyMode === 'transition') {
			await transaction.$executeRawUnsafe(`
				UPDATE "telegram_bot_settings"
				SET "daily_summary_enabled" = false,
					"daily_summary_chat_id" = '',
					"reports_thread_id" = NULL,
					"operational_alerts_thread_id" = 5,
					"daily_summary_time" = '01:50',
					"database_backup_time" = '01:45',
					"updated_at" = CURRENT_TIMESTAMP
				WHERE "id" = 'singleton'
			`);
		} else {
			await transaction.$executeRawUnsafe(`
				UPDATE "telegram_bot_settings"
				SET "daily_summary_chat_id" = '',
					"operational_alerts_thread_id" = 5,
					"database_backup_time" = '01:45',
					"updated_at" = CURRENT_TIMESTAMP
				WHERE "id" = 'singleton'
			`);
		}
	});
};

const producerState = async prisma => {
	const rows = await prisma.$queryRawUnsafe(`
		SELECT "enabled", "activated_at" AS "activatedAt"
		FROM "reporting_producer_state"
		WHERE "id" = 'singleton'
	`);
	assert.equal(rows.length, 1);
	return rows[0];
};

const settingsTime = async prisma => {
	const rows = await prisma.$queryRawUnsafe(`
		SELECT "daily_summary_time" AS "dailySummaryTime"
		FROM "telegram_bot_settings"
		WHERE "id" = 'singleton'
	`);
	assert.equal(rows.length, 1);
	return rows[0].dailySummaryTime;
};

const projectionArtifacts = async prisma => {
	const versions = await prisma.$queryRawUnsafe(`
		SELECT "version", "source_sequence" AS "sourceSequence"
		FROM "reporting_projection_versions"
		WHERE "aggregate_type" = '${aggregateType}'
			AND "aggregate_id" = '${aggregateId}'
	`);
	const events = await prisma.$queryRawUnsafe(`
		SELECT "deduplication_key" AS "deduplicationKey", "payload", "status"::TEXT
		FROM "outbox_events"
		WHERE "event_type" = '${eventType}'
		ORDER BY ("payload"->>'aggregateVersion')::BIGINT
	`);
	return { events, versions };
};

const sourceSequenceValue = async prisma => {
	const rows = await prisma.$queryRawUnsafe(`
		SELECT "last_value" AS "lastValue", "is_called" AS "isCalled"
		FROM "reporting_source_sequence"
	`);
	assert.equal(rows.length, 1);
	return rows[0];
};

const identityProjectionArtifacts = async (prisma, userId) => {
	const versions = await prisma.$queryRawUnsafe(`
		SELECT "version", "source_sequence" AS "sourceSequence"
		FROM "reporting_projection_versions"
		WHERE "aggregate_type" = '${identityAggregateType}'
			AND "aggregate_id" = '${userId}'
	`);
	const events = await prisma.$queryRawUnsafe(`
		SELECT
			("payload"->>'aggregateVersion')::BIGINT AS "aggregateVersion",
			("payload"->>'sourceSequence')::BIGINT AS "sourceSequence",
			("payload"->'state'->>'hasEmailIdentity')::BOOLEAN AS "hasEmailIdentity",
			("payload"->'state'->>'hasPhoneIdentity')::BOOLEAN AS "hasPhoneIdentity",
			("payload"->'state'->>'loginMethodCount')::INTEGER AS "loginMethodCount"
		FROM "outbox_events"
		WHERE "event_type" = '${identityEventType}'
			AND "payload"->>'aggregateId' = '${userId}'
		ORDER BY ("payload"->>'aggregateVersion')::BIGINT
	`);
	return { events, versions };
};

const updateSettingsTime = (prisma, value) =>
	prisma.$executeRawUnsafe(`
		UPDATE "telegram_bot_settings"
		SET "daily_summary_time" = '${value}',
			"updated_at" = CURRENT_TIMESTAMP
		WHERE "id" = 'singleton'
	`);

const updateOperationalAlertsThread = (prisma, value) =>
	prisma.$executeRawUnsafe(`
		UPDATE "telegram_bot_settings"
		SET "operational_alerts_thread_id" = ${value},
			"updated_at" = CURRENT_TIMESTAMP
		WHERE "id" = 'singleton'
	`);

const enableSteadyStateProducers = prisma =>
	prisma.$executeRawUnsafe(`
		UPDATE "reporting_producer_state"
		SET "enabled" = true,
			"activated_at" = CURRENT_TIMESTAMP,
			"daily_summary_owner" = 'REPORTING',
			"daily_summary_switch_generation" = 1,
			"daily_summary_switched_at" = CURRENT_TIMESTAMP,
			"updated_at" = CURRENT_TIMESTAMP
		WHERE "id" = 'singleton'
	`);

const verifySteadyStateSettingsProducer = async observer => {
	await prepareFixture(observer);
	await enableSteadyStateProducers(observer);
	await updateOperationalAlertsThread(observer, 6);
	let artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions.length, 1);
	assert.equal(artifacts.versions[0]?.version, 1n);
	assert.equal(artifacts.events.length, 1);
	assert.equal(artifacts.events[0]?.payload?.eventType, eventType);
	assert.deepEqual(artifacts.events[0]?.payload?.state, {
		id: 'singleton',
		coreOperationalAlertsDestinationChatId: '',
		coreOperationalAlertsThreadId: 6
	});
	await observer.$executeRawUnsafe(`
		UPDATE "reporting_producer_state"
		SET "enabled" = false, "updated_at" = CURRENT_TIMESTAMP
		WHERE "id" = 'singleton'
	`);
	await updateOperationalAlertsThread(observer, 7);
	artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions[0]?.version, 1n);
	assert.equal(artifacts.events.length, 1);
};

const assertBoundaryIsWaiting = async (observer, operation, label) => {
	await waitFor(async () => {
		if (operation.settled) {
			const result = await operation.result;
			if (result.code !== 0) throw commandFailure(result);
			throw new Error(`${label} crossed an in-flight source writer`);
		}
		const rows = await observer.$queryRawUnsafe(`
			SELECT 1
			FROM pg_stat_activity
			WHERE datname = current_database()
				AND pid <> pg_backend_pid()
				AND query LIKE '%${lifecycleLockMarker}%'
				AND wait_event_type = 'Lock'
		`);
		return rows.length > 0;
	}, `${label} PostgreSQL lock wait`);
};

const verifyInFlightWriterBoundary = async ({
	boundarySql,
	databaseUrl,
	expectedEnabled,
	label,
	observer,
	writer
}) => {
	const writerUpdated = deferred();
	const releaseWriter = deferred();
	const writerPromise = writer
		.$transaction(
			async transaction => {
				await updateSettingsTime(transaction, '01:51');
				writerUpdated.resolve();
				await releaseWriter.promise;
			},
			{ maxWait: 5_000, timeout: 20_000 }
		)
		.catch(error => {
			writerUpdated.reject(error);
			throw error;
		});

	await writerUpdated.promise;
	const boundary = startSql(databaseUrl, boundarySql, label);
	try {
		await assertBoundaryIsWaiting(observer, boundary, label);
		const stateWhileWaiting = await producerState(observer);
		assert.equal(stateWhileWaiting.enabled, !expectedEnabled);
	} finally {
		releaseWriter.resolve();
	}
	await writerPromise;
	await expectCommandSuccess(boundary);
	const finalState = await producerState(observer);
	assert.equal(finalState.enabled, expectedEnabled);
};

const verifyOrdinaryWriters = async ({
	databaseUrl,
	disableSql,
	enableSql,
	observer,
	writer
}) => {
	await prepareFixture(observer);
	await verifyInFlightWriterBoundary({
		boundarySql: enableSql,
		databaseUrl,
		expectedEnabled: true,
		label: 'Reporting producer activation',
		observer,
		writer
	});
	assert.equal(await settingsTime(observer), '01:51');
	let artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions.length, 0);
	assert.equal(artifacts.events.length, 0);
	await updateSettingsTime(observer, '01:52');
	artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions[0]?.version, 1n);
	assert.equal(artifacts.events.length, 1);
	assert.equal(
		artifacts.events[0]?.payload?.state?.coreOperationalAlertsThreadId,
		5
	);
	await updateOperationalAlertsThread(observer, 6);
	artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions[0]?.version, 2n);
	assert.equal(artifacts.events.length, 2);
	assert.equal(
		artifacts.events[1]?.payload?.state?.coreOperationalAlertsThreadId,
		6
	);
	assert.equal(artifacts.events[1]?.payload?.state?.messageThreadId, null);

	await prepareFixture(observer);
	await runSql(
		databaseUrl,
		enableSql,
		'Reporting producer activation setup'
	);
	await verifyInFlightWriterBoundary({
		boundarySql: disableSql,
		databaseUrl,
		expectedEnabled: false,
		label: 'Reporting producer disable',
		observer,
		writer
	});
	artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions[0]?.version, 1n);
	assert.equal(artifacts.events.length, 1);
	await updateSettingsTime(observer, '01:52');
	const disabledArtifacts = await projectionArtifacts(observer);
	assert.equal(disabledArtifacts.versions[0]?.version, 1n);
	assert.equal(disabledArtifacts.events.length, 1);
};

const scheduleMinutes = value => {
	const [hour, minute] = value.split(':').map(Number);
	return hour * 60 + minute;
};

const scheduleConflictsWithBackups = (summaryTime, backupTime) => {
	const summary = scheduleMinutes(summaryTime);
	const backup = scheduleMinutes(backupTime);
	return [0, 15, 30, 45].some(delay => {
		const target = (backup + delay) % (24 * 60);
		const direct = Math.abs(summary - target);
		return Math.min(direct, 24 * 60 - direct) < 5;
	});
};

const verifyScheduleAuthoritySerialization = async ({
	observer,
	writer,
	staleClient
}) => {
	await prepareFixture(observer);
	const authorityLocked = deferred();
	const releaseAuthority = deferred();
	const authorityUpdate = writer.$transaction(
		async transaction => {
			await transaction.$queryRawUnsafe(`
				SELECT "id"
				FROM "telegram_bot_settings"
				WHERE "id" = 'singleton'
				FOR UPDATE /* winwidget.reporting.schedule.authority.test */
			`);
			await transaction.$queryRawUnsafe(`
				SELECT "daily_summary_schedule_time"
				FROM "reporting_producer_state"
				WHERE "id" = 'singleton'
				FOR UPDATE
			`);
			authorityLocked.resolve();
			await releaseAuthority.promise;
			await transaction.$executeRawUnsafe(`
				UPDATE "reporting_producer_state"
				SET "daily_summary_schedule_time" = '02:32',
					"daily_summary_schedule_generation" =
						"daily_summary_schedule_generation" + 1,
					"updated_at" = CURRENT_TIMESTAMP
				WHERE "id" = 'singleton'
			`);
		},
		{ maxWait: 5_000, timeout: 20_000 }
	);
	await authorityLocked.promise;

	let backupSettled = false;
	const backupUpdate = staleClient
		.$transaction(
			async transaction => {
				await transaction.$queryRawUnsafe(`
					SELECT "id"
					FROM "telegram_bot_settings"
					WHERE "id" = 'singleton'
					FOR UPDATE /* winwidget.reporting.schedule.authority.test */
				`);
				const rows = await transaction.$queryRawUnsafe(`
					SELECT "daily_summary_schedule_time" AS "scheduleTime"
					FROM "reporting_producer_state"
					WHERE "id" = 'singleton'
					FOR UPDATE
				`);
				if (scheduleConflictsWithBackups(rows[0]?.scheduleTime, '01:48')) {
					throw new Error('EXPECTED_SCHEDULE_CONFLICT');
				}
				await transaction.$executeRawUnsafe(`
					UPDATE "telegram_bot_settings"
					SET "database_backup_time" = '01:48',
						"updated_at" = CURRENT_TIMESTAMP
					WHERE "id" = 'singleton'
				`);
			},
			{ maxWait: 5_000, timeout: 20_000 }
		)
		.then(
			() => {
				backupSettled = true;
				return 'committed';
			},
			error => {
				backupSettled = true;
				if (!error?.message?.includes('EXPECTED_SCHEDULE_CONFLICT')) {
					throw error;
				}
				return 'rejected';
			}
		);
	try {
		await waitFor(async () => {
			if (backupSettled) {
				throw new Error(
					'Core backup update bypassed the schedule authority lock'
				);
			}
			const rows = await observer.$queryRawUnsafe(`
				SELECT 1
				FROM pg_stat_activity
				WHERE datname = current_database()
					AND pid <> pg_backend_pid()
					AND query LIKE
						'%winwidget.reporting.schedule.authority.test%'
					AND wait_event_type = 'Lock'
			`);
			return rows.length > 0;
		}, 'Core and Reporting schedule authority serialization');
	} finally {
		releaseAuthority.resolve();
	}
	await authorityUpdate;
	assert.equal(await backupUpdate, 'rejected');
	const state = await observer.$queryRawUnsafe(`
		SELECT
			state."daily_summary_schedule_time" AS "scheduleTime",
			settings."database_backup_time" AS "backupTime"
		FROM "reporting_producer_state" state
		CROSS JOIN "telegram_bot_settings" settings
		WHERE state."id" = 'singleton' AND settings."id" = 'singleton'
	`);
	assert.deepEqual(state, [
		{ scheduleTime: '02:32', backupTime: '01:45' }
	]);
};

const verifyScheduleApiRevalidatesAfterActivation = async ({
	databaseUrl,
	enableSql,
	observer,
	writer
}) => {
	await prepareFixture(observer);
	const settingsLocked = deferred();
	const releaseSettings = deferred();
	const apiUpdate = writer.$transaction(
		async transaction => {
			await transaction.$queryRawUnsafe(`
				SELECT "id"
				FROM "telegram_bot_settings"
				WHERE "id" = 'singleton'
				FOR UPDATE /* winwidget.reporting.schedule.api.activation.test */
			`);
			settingsLocked.resolve();
			await releaseSettings.promise;
			const authorities = await transaction.$queryRawUnsafe(`
				SELECT
					"enabled",
					"daily_summary_schedule_time" AS "scheduleTime"
				FROM "reporting_producer_state"
				WHERE "id" = 'singleton'
				FOR UPDATE
			`);
			assert.equal(authorities.length, 1);
			assert.equal(
				authorities[0]?.enabled,
				true,
				'The schedule API did not observe the committed Reporting activation'
			);
			assert.equal(
				scheduleConflictsWithBackups(
					authorities[0]?.scheduleTime,
					'23:55'
				),
				false
			);
			await transaction.$executeRawUnsafe(`
				UPDATE "telegram_bot_settings"
				SET "database_backup_time" = '23:55',
					"updated_at" = CURRENT_TIMESTAMP
				WHERE "id" = 'singleton'
			`);
		},
		{ maxWait: 5_000, timeout: 20_000 }
	);
	await settingsLocked.promise;
	const activation = startSql(
		databaseUrl,
		enableSql,
		'Reporting activation against schedule API lock order'
	);
	let activationError = null;
	try {
		// SELECT ... FOR UPDATE holds ROW SHARE and has not written the source
		// table yet. Activation may commit first; the API must then lock and
		// validate the fresh producer state before its eventual source UPDATE.
		await expectCommandSuccess(activation);
		assert.equal((await producerState(observer)).enabled, true);
	} catch (error) {
		activationError = error;
	} finally {
		releaseSettings.resolve();
	}
	let apiError = null;
	try {
		await apiUpdate;
	} catch (error) {
		apiError = error;
	}
	if (activationError) throw activationError;
	if (apiError) throw apiError;
	const [state, settings] = await Promise.all([
		producerState(observer),
		observer.$queryRawUnsafe(`
			SELECT "database_backup_time" AS "databaseBackupTime"
			FROM "telegram_bot_settings"
			WHERE "id" = 'singleton'
		`)
	]);
	assert.equal(state.enabled, true);
	assert.equal(settings[0]?.databaseBackupTime, '23:55');
};

const verifyInvalidBackupScheduleBlocksActivation = async ({
	databaseUrl,
	enableSql,
	observer
}) => {
	for (const [backupTime, label] of [
		['99:99', 'malformed backup time'],
		['01:48', 'backup collision']
	]) {
		await prepareFixture(observer);
		await observer.$executeRawUnsafe(`
			UPDATE "telegram_bot_settings"
			SET "database_backup_time" = '${backupTime}',
				"updated_at" = CURRENT_TIMESTAMP
			WHERE "id" = 'singleton'
		`);
		const result = await startSql(
			databaseUrl,
			enableSql,
			`Reporting activation with ${label}`
		).result;
		assert.notEqual(result.code, 0, `Activation accepted ${label}`);
		assert.match(
			`${result.stderr}\n${result.stdout}`,
			/conflict-free backup schedule/i
		);
		assert.equal((await producerState(observer)).enabled, false);
	}
};

const isSerializationFailure = error => {
	const details = `${error?.code || ''} ${error?.message || ''} ${JSON.stringify(
		error?.meta || {}
	)}`;
	return (
		error?.code === 'P2034' ||
		/40001|could not serialize access|write conflict|deadlock/i.test(
			details
		)
	);
};

const verifyStaleSnapshot = async ({
	boundarySql,
	databaseUrl,
	expectedBefore,
	isolationLevel,
	label,
	observer,
	staleClient
}) => {
	const snapshotOpened = deferred();
	const continueWriter = deferred();
	const staleTransaction = staleClient
		.$transaction(
			async transaction => {
				const rows = await transaction.$queryRawUnsafe(`
					SELECT "enabled"
					FROM "reporting_producer_state"
					WHERE "id" = 'singleton'
				`);
				assert.equal(rows[0]?.enabled, expectedBefore);
				snapshotOpened.resolve();
				await continueWriter.promise;
				await updateSettingsTime(transaction, '01:51');
			},
			{ isolationLevel, maxWait: 5_000, timeout: 20_000 }
		)
		.catch(error => {
			snapshotOpened.reject(error);
			throw error;
		});

	await snapshotOpened.promise;
	await runSql(databaseUrl, boundarySql, label);
	continueWriter.resolve();
	let failure;
	try {
		await staleTransaction;
	} catch (error) {
		failure = error;
	}
	assert.ok(
		failure && isSerializationFailure(failure),
		`${label} allowed a stale ${isolationLevel} source writer`
	);
	assert.equal(await settingsTime(observer), '01:50');
	const artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions.length, 0);
	assert.equal(artifacts.events.length, 0);
};

const verifyPreopenedTransactions = async ({
	databaseUrl,
	disableSql,
	enableSql,
	observer,
	staleClient
}) => {
	for (const isolationLevel of [
		Prisma.TransactionIsolationLevel.RepeatableRead,
		Prisma.TransactionIsolationLevel.Serializable
	]) {
		await prepareFixture(observer);
		await verifyStaleSnapshot({
			boundarySql: enableSql,
			databaseUrl,
			expectedBefore: false,
			isolationLevel,
			label: `Enable against pre-opened ${isolationLevel}`,
			observer,
			staleClient
		});
		assert.equal((await producerState(observer)).enabled, true);

		await prepareFixture(observer);
		await runSql(
			databaseUrl,
			enableSql,
			'Reporting producer activation setup'
		);
		await verifyStaleSnapshot({
			boundarySql: disableSql,
			databaseUrl,
			expectedBefore: true,
			isolationLevel,
			label: `Disable against pre-opened ${isolationLevel}`,
			observer,
			staleClient
		});
		assert.equal((await producerState(observer)).enabled, false);
	}
};

const verifyResetRequired = async ({
	databaseUrl,
	disableSql,
	enableSql,
	observer,
	resetSql
}) => {
	await prepareFixture(observer);
	await runSql(databaseUrl, enableSql, 'Initial Reporting activation');
	await updateSettingsTime(observer, '01:51');
	let artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions[0]?.version, 1n);
	assert.equal(artifacts.events.length, 1);
	await observer.$executeRawUnsafe(`
		UPDATE "outbox_events"
		SET "status" = 'PUBLISHED'::"OutboxEventStatus",
			"published_at" = CURRENT_TIMESTAMP,
			"updated_at" = CURRENT_TIMESTAMP
		WHERE "event_type" = '${eventType}'
	`);
	const sequenceBeforeReset = await sourceSequenceValue(observer);
	assert.equal(sequenceBeforeReset.isCalled, true);

	await runSql(databaseUrl, disableSql, 'Reporting disable before reset');
	await updateSettingsTime(observer, '01:52');
	artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions[0]?.version, 1n);
	assert.equal(artifacts.events.length, 1);
	assert.equal(artifacts.events[0]?.status, 'PUBLISHED');
	assert.deepEqual(
		await sourceSequenceValue(observer),
		sequenceBeforeReset
	);

	const rejectedEnable = await startSql(
		databaseUrl,
		enableSql,
		'Plain Reporting re-enable'
	).result;
	assert.notEqual(rejectedEnable.code, 0);
	assert.match(
		`${rejectedEnable.stderr}\n${rejectedEnable.stdout}`,
		/fenced target reset|required before reactivation/i
	);
	let state = await producerState(observer);
	assert.equal(state.enabled, false);
	assert.ok(state.activatedAt);

	await runSql(databaseUrl, resetSql, 'Fenced Reporting Core reset');
	state = await producerState(observer);
	assert.equal(state.enabled, false);
	assert.equal(state.activatedAt, null);
	artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions[0]?.version, 1n);
	assert.equal(artifacts.events.length, 1);
	assert.equal(artifacts.events[0]?.status, 'PUBLISHED');
	assert.deepEqual(
		await sourceSequenceValue(observer),
		sequenceBeforeReset
	);

	await runSql(databaseUrl, enableSql, 'Reporting activation after reset');
	await updateSettingsTime(observer, '01:53');
	artifacts = await projectionArtifacts(observer);
	assert.equal(artifacts.versions[0]?.version, 2n);
	assert.equal(artifacts.events.length, 2);
	assert.ok(
		artifacts.versions[0]?.sourceSequence > sequenceBeforeReset.lastValue
	);
	assert.deepEqual(
		artifacts.events.map(event => event.status),
		['PUBLISHED', 'PENDING']
	);
	assert.deepEqual(
		artifacts.events.map(event => event.deduplicationKey),
		[
			'reporting:reporting.settings:singleton:1',
			'reporting:reporting.settings:singleton:2'
		]
	);
};

const verifyConcurrentIdentitySnapshots = async ({
	databaseUrl,
	enableSql,
	observer,
	firstWriter,
	secondWriter
}) => {
	await prepareFixture(observer);
	const suffix = randomBytes(8).toString('hex');
	const userId = `reporting-identity-${suffix}`;
	const emailIdentityId = `reporting-email-${suffix}`;
	const phoneIdentityId = `reporting-phone-${suffix}`;
	const emailValue = `reporting-${suffix}@example.test`;
	const phoneValue = `+7999${suffix.slice(0, 7)}`;
	await observer.$transaction(async transaction => {
		await transaction.$executeRawUnsafe(`
			INSERT INTO "User" (
				"id", "password", "status", "rights", "created_at", "updated_at"
			) VALUES (
				'${userId}', 'reporting-test-password',
				'ACTIVE'::"UserStatus", ARRAY['USER'::"Role"],
				CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			)
		`);
		await transaction.$executeRawUnsafe(`
			INSERT INTO "auth_identities" (
				"id", "user_id", "type", "value", "verified_at",
				"created_at", "updated_at"
			) VALUES
				(
					'${emailIdentityId}', '${userId}', 'EMAIL'::"AuthIdentityType",
					'${emailValue}', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
				),
				(
					'${phoneIdentityId}', '${userId}', 'PHONE'::"AuthIdentityType",
					'${phoneValue}', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
				)
		`);
	});
	if (settingsTopologyMode === 'transition') {
		await runSql(
			databaseUrl,
			enableSql,
			'Reporting activation for concurrent AuthIdentity writers'
		);
	} else {
		await enableSteadyStateProducers(observer);
	}

	const firstUpdated = deferred();
	const releaseFirst = deferred();
	const first = firstWriter
		.$transaction(
			async transaction => {
				await transaction.$executeRawUnsafe(
					`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
					`reporting:identity.user:${userId}`
				);
				await transaction.$executeRawUnsafe(`
				UPDATE "auth_identities"
				SET "verified_at" = CURRENT_TIMESTAMP,
					"updated_at" = CURRENT_TIMESTAMP
				WHERE "id" = '${emailIdentityId}'
			`);
				firstUpdated.resolve();
				await releaseFirst.promise;
			},
			{ maxWait: 5_000, timeout: 20_000 }
		)
		.catch(error => {
			firstUpdated.reject(error);
			throw error;
		});
	await firstUpdated.promise;
	let secondSettled = false;
	const second = Promise.resolve(
		secondWriter.$executeRawUnsafe(`
			UPDATE "auth_identities"
			SET "verified_at" = CURRENT_TIMESTAMP,
				"updated_at" = CURRENT_TIMESTAMP
			WHERE "id" = '${phoneIdentityId}'
		`)
	).finally(() => {
		secondSettled = true;
	});
	second.catch(() => undefined);
	try {
		await waitFor(async () => {
			if (secondSettled) {
				throw new Error(
					'Second AuthIdentity writer crossed the per-user advisory lock'
				);
			}
			const rows = await observer.$queryRawUnsafe(`
				SELECT count(*)::INTEGER AS "waiting"
				FROM pg_locks
				WHERE locktype = 'advisory'
					AND database = (
						SELECT oid FROM pg_database WHERE datname = current_database()
					)
					AND NOT granted
			`);
			return rows[0]?.waiting > 0;
		}, 'second AuthIdentity writer advisory lock wait');
	} finally {
		releaseFirst.resolve();
	}
	await Promise.all([first, second]);

	const artifacts = await identityProjectionArtifacts(observer, userId);
	assert.equal(artifacts.versions.length, 1);
	assert.equal(artifacts.versions[0]?.version, 2n);
	assert.equal(artifacts.events.length, 2);
	assert.deepEqual(
		artifacts.events.map(event => event.aggregateVersion),
		[1n, 2n]
	);
	assert.ok(
		artifacts.events[1].sourceSequence > artifacts.events[0].sourceSequence
	);
	assert.deepEqual(artifacts.events[0], {
		aggregateVersion: 1n,
		sourceSequence: artifacts.events[0].sourceSequence,
		hasEmailIdentity: true,
		hasPhoneIdentity: true,
		loginMethodCount: 1
	});
	assert.deepEqual(artifacts.events[1], {
		aggregateVersion: 2n,
		sourceSequence: artifacts.events[1].sourceSequence,
		hasEmailIdentity: true,
		hasPhoneIdentity: true,
		loginMethodCount: 2
	});
	assert.equal(
		artifacts.versions[0].sourceSequence,
		artifacts.events[1].sourceSequence
	);
};

const producerFunctionAclState = async prisma => {
	const rows = await prisma.$queryRawUnsafe(`
		WITH expected(signature) AS (
			SELECT unnest(ARRAY[
				${producerFunctionSqlArray}
			])
		)
		SELECT
			expected.signature,
			EXISTS (
				SELECT 1
				FROM aclexplode(
					COALESCE(
						procedure.proacl,
						acldefault('f', procedure.proowner)
					)
				) privilege
				WHERE privilege.grantee = 0
					AND privilege.privilege_type = 'EXECUTE'
			) AS "publicExecute",
			has_function_privilege(
				'winwidget_api_runtime', procedure.oid, 'EXECUTE'
			) AS "runtimeExecute",
			has_function_privilege(
				'winwidget_backup', procedure.oid, 'EXECUTE'
			) AS "backupExecute",
			has_function_privilege(
				'winwidget_maintenance', procedure.oid, 'EXECUTE'
			) AS "maintenanceExecute"
		FROM expected
		JOIN pg_proc procedure
			ON procedure.oid = to_regprocedure(expected.signature)
		ORDER BY expected.signature
	`);
	assert.equal(
		rows.length,
		producerFunctionSignatures.length,
		'Restored database must contain the complete Reporting producer function set'
	);
	return rows;
};

const verifyNoPrivilegesRestoreAcl = async ({
	admin,
	databaseUrl,
	observer,
	suffix
}) => {
	const restoreDatabaseName = `winwidget_rp_restore_${suffix}_test`;
	const restoreUrl = new URL(databaseUrl);
	restoreUrl.pathname = `/${restoreDatabaseName}`;
	const containerId =
		process.env.REPORTING_PRODUCER_TEST_POSTGRES_CONTAINER_ID?.trim();
	let dumpDirectory = null;
	const dumpPath = containerId
		? `/tmp/winwidget-rp-boundary-${suffix}.dump`
		: join(
				await mkdtemp(
					join(tmpdir(), 'winwidget-reporting-producer-restore-')
				),
				'core.dump'
			);
	if (!containerId)
		dumpDirectory = dumpPath.slice(0, dumpPath.lastIndexOf('/'));
	const requiredRoles = [
		'winwidget_api_runtime',
		'winwidget_backup',
		'winwidget_maintenance'
	];
	const createdRoles = [];
	let restoreDatabaseCreated = false;
	let restored = null;
	try {
		const roleCapability = await admin.$queryRawUnsafe(`
			SELECT rolcreaterole OR rolsuper AS "canCreateRole"
			FROM pg_roles
			WHERE rolname = current_user
		`);
		assert.equal(
			roleCapability[0]?.canCreateRole,
			true,
			'Test PostgreSQL role must be able to create isolated ACL probe roles'
		);
		for (const role of requiredRoles) {
			const existing = await admin.$queryRawUnsafe(`
				SELECT 1 FROM pg_roles WHERE rolname = '${role}'
			`);
			if (existing.length) continue;
			await admin.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
			createdRoles.push(role);
		}

		const sourceAcl = await producerFunctionAclState(observer);
		assert.ok(
			sourceAcl.every(entry => !entry.publicExecute),
			'Source migration must revoke Reporting producer execution from PUBLIC'
		);

		await runPostgresTool(
			'pg_dump',
			[
				'--format=custom',
				'--no-owner',
				'--no-privileges',
				'--schema=public',
				`--file=${dumpPath}`,
				`--dbname=${postgresCommandUrl(databaseUrl)}`
			],
			'Core no-privileges restore regression dump'
		);
		await runPostgresTool(
			'pg_restore',
			['--list', dumpPath],
			'Core no-privileges restore regression archive verification'
		);
		await admin.$executeRawUnsafe(
			`CREATE DATABASE "${restoreDatabaseName}" TEMPLATE template0 ENCODING 'UTF8'`
		);
		restoreDatabaseCreated = true;
		await runPostgresTool(
			'pg_restore',
			[
				'--exit-on-error',
				'--single-transaction',
				'--clean',
				'--if-exists',
				'--no-owner',
				'--no-privileges',
				'--schema=public',
				`--dbname=${postgresCommandUrl(restoreUrl.toString())}`,
				dumpPath
			],
			'Core no-privileges restore regression restore'
		);
		restored = new PrismaClient({
			datasources: { db: { url: restoreUrl.toString() } }
		});
		await restored.$connect();
		const beforeRepair = await producerFunctionAclState(restored);
		assert.ok(
			beforeRepair.every(entry => entry.publicExecute),
			'Raw --no-privileges restore must reproduce PostgreSQL default PUBLIC EXECUTE before the repair gate'
		);
		await runSql(
			restoreUrl.toString(),
			restoreProducerFunctionAclSql,
			'Core restore Reporting producer ACL repair'
		);
		const afterRepair = await producerFunctionAclState(restored);
		assert.ok(afterRepair.every(entry => !entry.publicExecute));
		assert.ok(afterRepair.every(entry => entry.runtimeExecute));
		assert.ok(afterRepair.every(entry => !entry.backupExecute));
		assert.ok(afterRepair.every(entry => !entry.maintenanceExecute));
	} finally {
		if (restored) await restored.$disconnect().catch(() => undefined);
		if (restoreDatabaseCreated) {
			await admin
				.$executeRawUnsafe(
					`DROP DATABASE "${restoreDatabaseName}" WITH (FORCE)`
				)
				.catch(() => undefined);
		}
		for (const role of createdRoles.reverse()) {
			await admin
				.$executeRawUnsafe(`DROP ROLE "${role}"`)
				.catch(() => undefined);
		}
		if (containerId) {
			await runPostgresTool(
				'rm',
				['-f', dumpPath],
				'Core no-privileges restore regression dump cleanup'
			).catch(() => undefined);
		} else if (dumpDirectory) {
			await rm(dumpDirectory, { recursive: true, force: true });
		}
	}
};

const migrationDatabaseUrl = databaseUrl => {
	const url = new URL(databaseUrl);
	url.searchParams.delete('options');
	const base = url.toString();
	const separator = base.includes('?') ? '&' : '?';
	const options = [
		'-c winwidget.campaigns_contract_cutover=production-destructive-approved',
		'-c winwidget.campaigns_forward_boundary=forward-only',
		`-c winwidget.campaigns_source_manifest_sha256=${'0'.repeat(64)}`,
		'-c winwidget.campaigns_telegram_audit_decision=completed',
		'-c winwidget.campaigns_telegram_audit_reference=reporting-boundary-ci'
	].join(' ');
	return `${base}${separator}options=${encodeURIComponent(options)}`;
};

const main = async () => {
	await access(prismaCliPath);
	await access(prismaSchemaPath);
	const lifecycleSql = await loadLifecycleSql();
	const baseUrl = requireTestDatabaseUrl();
	const suffix = `${process.pid}_${randomBytes(6).toString('hex')}`;
	const temporaryDatabaseName = `winwidget_rp_boundary_${suffix}`;
	assert.match(
		temporaryDatabaseName,
		/^winwidget_rp_boundary_[0-9]+_[0-9a-f]{12}$/
	);

	const adminUrl = new URL(baseUrl);
	adminUrl.pathname = '/postgres';
	adminUrl.searchParams.delete('schema');
	adminUrl.searchParams.delete('options');
	const databaseUrl = new URL(baseUrl);
	databaseUrl.pathname = `/${temporaryDatabaseName}`;
	databaseUrl.searchParams.set('schema', 'public');
	databaseUrl.searchParams.delete('options');

	const admin = new PrismaClient({
		datasources: { db: { url: adminUrl.toString() } }
	});
	const clients = [];
	let databaseCreated = false;
	try {
		await admin.$connect();
		const roles = await admin.$queryRawUnsafe(`
			SELECT rolcreatedb OR rolsuper AS "canCreateDatabase"
			FROM pg_roles
			WHERE rolname = current_user
		`);
		assert.equal(
			roles[0]?.canCreateDatabase,
			true,
			'Test PostgreSQL role must be able to create an isolated database'
		);
		await admin.$executeRawUnsafe(
			`CREATE DATABASE "${temporaryDatabaseName}" TEMPLATE template0 ENCODING 'UTF8'`
		);
		databaseCreated = true;

		const migration = startPrismaCommand({
			args: ['migrate', 'deploy', '--schema', prismaSchemaPath],
			databaseUrl: migrationDatabaseUrl(databaseUrl.toString()),
			label: 'Temporary Reporting producer database migration'
		});
		await expectCommandSuccess(migration);

		for (let index = 0; index < 3; index += 1) {
			const client = new PrismaClient({
				datasources: { db: { url: databaseUrl.toString() } }
			});
			await client.$connect();
			clients.push(client);
		}
		const [observer, writer, staleClient] = clients;
		assert.equal(
			(
				await observer.$queryRawUnsafe('SELECT current_database() AS name')
			)[0]?.name,
			temporaryDatabaseName
		);
		await verifyNoPrivilegesRestoreAcl({
			admin,
			databaseUrl: databaseUrl.toString(),
			observer,
			suffix
		});
		const legacyColumns = await observer.$queryRawUnsafe(`
			SELECT count(*)::INTEGER AS count
			FROM information_schema.columns
			WHERE table_schema = 'public'
				AND table_name = 'telegram_bot_settings'
				AND column_name IN (
					'daily_summary_enabled', 'reports_thread_id',
					'daily_summary_time',
					'daily_summary_last_sent_period_start',
					'daily_summary_last_sent_at'
				)
		`);
		assert.ok(
			legacyColumns[0]?.count === 5 || legacyColumns[0]?.count === 0,
			'Core Reporting settings schema must be wholly transitional or steady-state'
		);
		if (legacyColumns[0].count === 0) {
			settingsTopologyMode = 'steady';
			aggregateType = 'reporting.core-operational-routing.changed.v1';
			eventType = 'reporting.core-operational-routing.changed.v1';
			await verifySteadyStateSettingsProducer(observer);
		} else {
			await verifyOrdinaryWriters({
				databaseUrl: databaseUrl.toString(),
				...lifecycleSql,
				observer,
				writer
			});
			await verifyScheduleAuthoritySerialization({
				observer,
				writer,
				staleClient
			});
			await verifyScheduleApiRevalidatesAfterActivation({
				databaseUrl: databaseUrl.toString(),
				enableSql: lifecycleSql.enableSql,
				observer,
				writer
			});
			await verifyInvalidBackupScheduleBlocksActivation({
				databaseUrl: databaseUrl.toString(),
				enableSql: lifecycleSql.enableSql,
				observer
			});
			await verifyPreopenedTransactions({
				databaseUrl: databaseUrl.toString(),
				...lifecycleSql,
				observer,
				staleClient
			});
			await verifyResetRequired({
				databaseUrl: databaseUrl.toString(),
				...lifecycleSql,
				observer
			});
		}
		await verifyConcurrentIdentitySnapshots({
			databaseUrl: databaseUrl.toString(),
			enableSql: lifecycleSql.enableSql,
			observer,
			firstWriter: writer,
			secondWriter: staleClient
		});

		process.stdout.write(
			'reporting_producer_postgresql_boundaries=passed\n'
		);
	} finally {
		for (const child of activeChildren) child.kill('SIGTERM');
		await Promise.allSettled(clients.map(client => client.$disconnect()));
		if (databaseCreated) {
			await admin.$executeRawUnsafe(
				`DROP DATABASE "${temporaryDatabaseName}" WITH (FORCE)`
			);
		}
		await admin.$disconnect();
	}
};

main().catch(error => {
	process.stderr.write(
		`Reporting producer PostgreSQL boundary test failed: ${
			error instanceof Error ? error.stack || error.message : String(error)
		}\n`
	);
	process.exitCode = 1;
});
