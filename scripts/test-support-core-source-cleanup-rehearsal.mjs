import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const revision = 'a'.repeat(40);
const sourceFingerprint = 'b'.repeat(64);
const sourceSnapshotSha256 = 'c'.repeat(64);
const core = {
	action: 'status',
	ownership: 'SUPPORT',
	admissionEnabled: false,
	reconcilerEnabled: false,
	activeTaskCount: 0,
	generation: '1',
	preparedRevision: revision,
	sourceRevision: revision,
	ownershipRevision: revision,
	sourceDatabaseSystemId: '123456789',
	sourceFingerprint,
	sourceSnapshotSha256,
	sourceMappingCount: '2',
	sourceHighWatermark: '987654321',
	fencedAt: '2026-08-24T10:00:00.000Z',
	exportedAt: '2026-08-24T10:01:00.000Z',
	activatedAt: '2026-08-24T10:02:00.000Z'
};
const target = {
	action: 'status',
	databaseId: '11111111-1111-4111-8111-111111111111',
	phase: 'ACTIVE',
	ownershipGeneration: '1',
	sourceDatabaseSystemId: core.sourceDatabaseSystemId,
	sourceRevision: revision,
	ownershipRevision: revision,
	sourceFingerprint,
	sourceSnapshotSha256,
	sourceHighWatermark: core.sourceHighWatermark,
	activatedAt: '2026-08-24T10:02:00.000Z',
	counts: { mappings: 2, inbox: 0, outbox: 0, receipts: 0, failures: 0 }
};

export function verifySupportCleanupAttestation(
	source,
	destination,
	expected
) {
	const hash = value =>
		typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
	const uuid = value =>
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			value
		);
	if (
		source.action !== 'status' ||
		source.ownership !== 'SUPPORT' ||
		source.admissionEnabled !== false ||
		source.reconcilerEnabled !== false ||
		source.activeTaskCount !== 0 ||
		!/^[1-9][0-9]*$/.test(source.generation) ||
		source.preparedRevision !== expected ||
		source.sourceRevision !== expected ||
		source.ownershipRevision !== expected ||
		destination.action !== 'status' ||
		destination.phase !== 'ACTIVE' ||
		!/^[1-9][0-9]*$/.test(destination.ownershipGeneration) ||
		destination.sourceRevision !== expected ||
		destination.ownershipRevision !== expected ||
		!uuid(destination.databaseId) ||
		source.sourceDatabaseSystemId !== destination.sourceDatabaseSystemId ||
		source.sourceFingerprint !== destination.sourceFingerprint ||
		source.sourceSnapshotSha256 !== destination.sourceSnapshotSha256 ||
		source.sourceMappingCount !== String(destination.counts?.mappings) ||
		source.sourceHighWatermark !== destination.sourceHighWatermark ||
		!hash(source.sourceFingerprint) ||
		!hash(source.sourceSnapshotSha256) ||
		!source.fencedAt ||
		!source.exportedAt ||
		!source.activatedAt ||
		!destination.activatedAt
	) {
		throw new Error('Support cleanup attestation mismatch');
	}
	return true;
}

assert.equal(
	verifySupportCleanupAttestation(core, target, revision),
	true
);
for (const [label, nextCore, nextTarget] of [
	['Core still owns admission', { ...core, ownership: 'CORE' }, target],
	['Core task is active', { ...core, activeTaskCount: 1 }, target],
	['target remains shadow', core, { ...target, phase: 'SHADOW' }],
	[
		'revision differs',
		core,
		{ ...target, ownershipRevision: 'd'.repeat(40) }
	],
	[
		'system identifier differs',
		core,
		{ ...target, sourceDatabaseSystemId: '7' }
	],
	[
		'fingerprint differs',
		core,
		{ ...target, sourceFingerprint: 'd'.repeat(64) }
	],
	[
		'snapshot differs',
		core,
		{ ...target, sourceSnapshotSha256: 'd'.repeat(64) }
	],
	[
		'mapping count differs',
		core,
		{ ...target, counts: { ...target.counts, mappings: 3 } }
	],
	[
		'high watermark differs',
		core,
		{ ...target, sourceHighWatermark: '987654322' }
	],
	[
		'missing source attestation',
		{ ...core, sourceFingerprint: null },
		target
	],
	[
		'missing target database identity',
		core,
		{ ...target, databaseId: null }
	]
]) {
	assert.throws(
		() => verifySupportCleanupAttestation(nextCore, nextTarget, revision),
		/attestation mismatch/,
		label
	);
}

const initial = readFileSync(
	resolve(
		root,
		'prisma/migrations/20260824020000_prepare_support_service_ownership/migration.sql'
	),
	'utf8'
);
const targetInitial = readFileSync(
	resolve(
		root,
		'apps/support/prisma/migrations/20260824010000_init_support/migration.sql'
	),
	'utf8'
);
const cleanup = readFileSync(
	resolve(
		root,
		'prisma/post-cutover/support/20260824030000_remove_legacy_support_core_source.sql'
	),
	'utf8'
);
const cleanupRunner = readFileSync(
	resolve(root, 'scripts/cleanup-support-core-source-production.sh'),
	'utf8'
);
assert.equal(
	cleanupRunner.includes(
		'backend_env="${BACKEND_ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"'
	),
	true,
	'cleanup must default to the canonical APP_ROOT backend env'
);
for (const productionGuard of [
	"acquire_production_deploy_lock 'Support Core source cleanup'",
	'$(uname -s)',
	'$(id -u)',
	'$(docker context show)',
	"$(docker context inspect default --format '{{.Endpoints.docker.Host}}')",
	"$(docker info --format '{{.OSType}}')"
]) {
	assert.equal(
		cleanupRunner.includes(productionGuard),
		true,
		`missing production guard: ${productionGuard}`
	);
}
for (const sourcedGuard of [
	'production-deploy-lock.sh',
	'database-restore-production-guard.sh'
]) {
	assert.match(
		cleanupRunner,
		new RegExp(
			`^source "\\$server_root/scripts/${sourcedGuard.replaceAll('.', '\\.')}"$`,
			'm'
		),
		`cleanup must source ${sourcedGuard}`
	);
}
const restoreGuard =
	'database_restore_guard_assert_before_mutation healthy-required "$backend_env"';
assert.equal(
	cleanupRunner.split(restoreGuard).length - 1,
	2,
	'restore guard must run before validation and immediately before SQL'
);
assert.match(
	cleanupRunner,
	new RegExp(
		`${restoreGuard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n` +
			'\\s*docker run --rm --network host --env-file "\\$backend_env"'
	),
	'restore guard must be the final command before destructive SQL'
);
assert.equal(
	cleanupRunner.includes('SUPPORT_CORE_SOURCE_CLEANUP_CORE_BACKUP_'),
	false,
	'Core backup must not gate direct Support hard cutover cleanup'
);
for (const retainedEvidence of [
	'SUPPORT_CORE_SOURCE_CLEANUP_SUPPORT_BACKUP_FILE',
	'SUPPORT_CORE_SOURCE_CLEANUP_SUPPORT_BACKUP_SHA256',
	'SUPPORT_CORE_SOURCE_CLEANUP_RESTORE_EVIDENCE_FILE',
	'SUPPORT_CORE_SOURCE_CLEANUP_RESTORE_EVIDENCE_SHA256'
]) {
	assert.equal(
		cleanupRunner.includes(retainedEvidence),
		true,
		`missing retained Support recovery evidence: ${retainedEvidence}`
	);
}
for (const destructive of [
	'DROP TABLE "telegram_support_messages"',
	'DROP COLUMN "support_thread_id"'
]) {
	assert.equal(initial.includes(destructive), false);
	assert.equal(cleanup.includes(destructive), true);
}
for (const guard of [
	'DROP LEGACY SUPPORT CORE SOURCE',
	'pg_advisory_xact_lock',
	'marker."ownership" <> \'SUPPORT\'',
	'marker."active_task_count" <> 0',
	'marker."source_snapshot_sha256" IS DISTINCT FROM',
	'CREATE TABLE "support_core_cleanup_state"'
]) {
	assert.equal(
		cleanup.includes(guard),
		true,
		`missing cleanup guard: ${guard}`
	);
}

const optionalGucBindings = [
	'cleanup_revision',
	'target_database_id',
	'source_database_system_id',
	'source_fingerprint',
	'source_snapshot_sha256',
	'source_mapping_count',
	'source_high_watermark'
];
for (const binding of optionalGucBindings) {
	assert.match(
		cleanup,
		new RegExp(`\\b${binding} IS NULL\\s+OR\\s+${binding} !~`),
		`missing-GUC must fail closed for ${binding}`
	);
}
for (const requiredMarkerTimestamp of ['exported_at', 'activated_at']) {
	assert.equal(
		cleanup.includes(`marker."${requiredMarkerTimestamp}" IS NULL`),
		true,
		`missing marker timestamp must fail closed: ${requiredMarkerTimestamp}`
	);
}
for (const requiredRootAnchor of [
	'prepared_revision',
	'source_revision',
	'ownership_revision',
	'source_database_system_id',
	'source_fingerprint',
	'source_snapshot_sha256',
	'source_mapping_count',
	'source_high_watermark',
	'exported_at',
	'activated_at'
]) {
	assert.equal(
		initial.includes(`"${requiredRootAnchor}" IS NOT NULL`),
		true,
		`Support ownership CHECK must reject NULL ${requiredRootAnchor}`
	);
}
for (const requiredTargetAnchor of [
	'source_database_system_id',
	'source_revision',
	'ownership_revision',
	'source_fingerprint',
	'source_snapshot_sha256',
	'source_snapshot_counts',
	'source_high_watermark',
	'imported_at',
	'activated_at'
]) {
	assert.equal(
		targetInitial.includes(`"${requiredTargetAnchor}" IS NOT NULL`),
		true,
		`Support ACTIVE CHECK must reject NULL ${requiredTargetAnchor}`
	);
}

const coreService = readFileSync(
	resolve(root, 'src/telegram-bot/telegram-bot.service.ts'),
	'utf8'
);
const coreController = readFileSync(
	resolve(root, 'src/telegram-bot/telegram-bot.controller.ts'),
	'utf8'
);
for (const forbidden of [
	'handleSupportWebhook',
	'TELEGRAM_SUPPORT_BOT',
	'telegramSupportMessage',
	'setImmediate'
]) {
	assert.equal(coreService.includes(forbidden), false, forbidden);
}
assert.equal(coreController.includes("@Post('support-webhook')"), false);

process.stdout.write(
	'Support cleanup rehearsal passed: 1 valid and 11 rejected ownership states; missing GUCs fail closed\n'
);
