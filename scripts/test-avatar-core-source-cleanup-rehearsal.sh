#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

fail() {
	printf 'avatar_core_cleanup_rehearsal_error=%s\n' "$1" >&2
	exit 1
}

bash -n "$SOURCE_ROOT/scripts/cleanup-avatar-core-source-production.sh"
bash "$SOURCE_ROOT/scripts/cleanup-avatar-core-source-production.sh" --self-test

[[ ! -e "$SOURCE_ROOT/src/file" && ! -L "$SOURCE_ROOT/src/file" ]] ||
	fail 'legacy Core file source directory remains'
! rg -n 'FileModule|FileController' "$SOURCE_ROOT/src/app.module.ts" >/dev/null ||
	fail 'legacy Core file module remains wired'
! rg -n 'location[[:space:]]+([=~*^ ]+[[:space:]]*)?/uploads/' \
	"$SOURCE_ROOT/deploy/nginx.conf" >/dev/null ||
	fail 'legacy /uploads nginx route remains'
! rg -n 'mkdir.*uploads|/app/uploads|public/uploads' \
	"$SOURCE_ROOT/Dockerfile" "$SOURCE_ROOT/docker-entrypoint.sh" \
	"$SOURCE_ROOT/.dockerignore" >/dev/null ||
	fail 'legacy uploads filesystem contract remains'
ROOT_PACKAGE="$SOURCE_ROOT/package.json" node <<'NODE'
const value = require(process.env.ROOT_PACKAGE);
for (const section of ['dependencies', 'devDependencies']) {
  if (Object.prototype.hasOwnProperty.call(value[section] || {}, '@aws-sdk/client-s3')) process.exit(1);
}
NODE

(
	# The production backup roles intentionally have neither database TEMP nor
	# schema CREATE. Exercise the exact two-query scanner without granting either
	# privilege and prove that a discovered replayable legacy reference blocks.
	# shellcheck source=scripts/cleanup-avatar-core-source-production.sh
	source "$SOURCE_ROOT/scripts/cleanup-avatar-core-source-production.sh"
	if [[ "$(id -u)" != '0' ]]; then chown() { :; }; fi
	fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/avatar-reference-scan-rehearsal.XXXXXX")"
	trap 'rm -rf -- "$fixture_root"' EXIT
	fixture_metadata='{"schemaVersion":1,"database":"winwidget","role":"winwidget_backup","schema":"public","databaseTempPrivilege":false,"schemaCreatePrivilege":false,"columnLimit":256,"estimatedRowLimit":50000000,"columnCount":1,"estimatedRows":10,"columns":[{"table":"users","column":"avatar_path","estimatedRows":10}]}'
	result_zero='{"schemaVersion":1,"label":"core","database":"winwidget","role":"winwidget_backup","schema":"public","pattern":"/uploads/","databaseTempPrivilege":false,"schemaCreatePrivilege":false,"columnLimit":256,"estimatedRowLimit":50000000,"columnCount":1,"estimatedRows":10,"matches":0,"columns":[{"table":"users","column":"avatar_path","estimatedRows":10,"matches":0}],"catalogColumns":[{"table":"users","column":"avatar_path","estimatedRows":10}]}'
	result_match='{"schemaVersion":1,"label":"core","database":"winwidget","role":"winwidget_backup","schema":"public","pattern":"/uploads/","databaseTempPrivilege":false,"schemaCreatePrivilege":false,"columnLimit":256,"estimatedRowLimit":50000000,"columnCount":1,"estimatedRows":10,"matches":1,"columns":[{"table":"users","column":"avatar_path","estimatedRows":10,"matches":1}],"catalogColumns":[{"table":"users","column":"avatar_path","estimatedRows":10}]}'
	fixture_result="$result_zero"
	avatar_cleanup_run_psql() {
		[[ "$1" == 'DATABASE_BACKUP_URL' ]] || return 1
		local sql
		sql="$(command cat)" || return 1
		[[ "$sql" != *'CREATE TEMP'* && "$sql" != *'CREATE TABLE'* ]] || return 1
		if [[ "$sql" == *'WITH scan AS'* ]]; then
			[[ "$sql" == *'FROM ONLY "public"."users"'* &&
				"$sql" == *"NOT has_database_privilege(current_user,current_database(),'TEMP')"* ]] || return 1
			printf '%s\n' "$fixture_result"
		else
			[[ "$sql" == *"NOT has_database_privilege(current_user, current_database(), 'TEMP')"* ]] || return 1
			printf '%s\n' "$fixture_metadata"
		fi
	}
	avatar_cleanup_scan_database_schema DATABASE_BACKUP_URL public core "$fixture_root/zero.json"
	SCAN_RESULT="$fixture_root/zero.json" node <<'NODE'
const value = JSON.parse(require('node:fs').readFileSync(process.env.SCAN_RESULT, 'utf8'));
if (value.databaseTempPrivilege !== false || value.schemaCreatePrivilege !== false || value.matches !== 0 ||
    value.columns?.[0]?.matches !== 0) process.exit(1);
NODE
	fixture_result="$result_match"
	! avatar_cleanup_scan_database_schema DATABASE_BACKUP_URL public core "$fixture_root/match.json"
	[[ ! -e "$fixture_root/match.json" ]]
)

node <<'NODE'
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
const validateVersionInventory = ({ status, current, versions }) => {
  const ordered = [...versions].sort((left, right) => compareUtf8(left.key, right.key) ||
    compareUtf8(left.versionId, right.versionId) || compareUtf8(left.kind, right.kind));
  const ids = new Set(ordered.map(entry => JSON.stringify([entry.key,entry.versionId,entry.kind])));
  if (ids.size !== ordered.length) return false;
  const latest = new Map(ordered.filter(entry => entry.kind === 'OBJECT' && entry.isLatest)
    .map(entry => [entry.key,entry]));
  if (latest.size !== current.length || current.some(object => {
    const version = latest.get(object.key);
    return !version || version.size !== object.size || version.sha256 !== object.sha256;
  })) return false;
  if (status === 'NEVER_ENABLED' && (ordered.length !== current.length ||
      ordered.some(entry => entry.kind !== 'OBJECT' || entry.versionId !== 'null' || entry.isLatest !== true))) return false;
  return ['NEVER_ENABLED','Enabled','Suspended'].includes(status);
};
const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
if (!validateVersionInventory({ status: 'NEVER_ENABLED', current: [{ key: 'legacy/я.webp', size: 12, sha256: shaA }],
  versions: [{ key: 'legacy/я.webp', versionId: 'null', kind: 'OBJECT', isLatest: true, size: 12, sha256: shaA }] })) process.exit(1);
if (validateVersionInventory({ status: 'NEVER_ENABLED', current: [{ key: 'legacy/a.webp', size: 12, sha256: shaA }],
  versions: [] })) process.exit(1);
if (!validateVersionInventory({ status: 'Enabled', current: [{ key: 'legacy/a.webp', size: 13, sha256: shaB }],
  versions: [
    { key: 'legacy/a.webp', versionId: 'v1', kind: 'OBJECT', isLatest: false, size: 12, sha256: shaA },
    { key: 'legacy/a.webp', versionId: 'v2', kind: 'OBJECT', isLatest: true, size: 13, sha256: shaB },
    { key: 'legacy/deleted.webp', versionId: 'v3', kind: 'DELETE_MARKER', isLatest: true, size: 0, sha256: null },
  ] })) process.exit(1);
if (!validateVersionInventory({ status: 'Suspended', current: [{ key: 'legacy/a.webp', size: 12, sha256: shaA }],
  versions: [{ key: 'legacy/a.webp', versionId: 'null', kind: 'OBJECT', isLatest: true, size: 12, sha256: shaA }] })) process.exit(1);
if (validateVersionInventory({ status: 'Enabled', current: [], versions: [
  { key: 'legacy/a.webp', versionId: 'v1', kind: 'DELETE_MARKER', isLatest: true, size: 0, sha256: null },
  { key: 'legacy/a.webp', versionId: 'v1', kind: 'DELETE_MARKER', isLatest: true, size: 0, sha256: null },
] })) process.exit(1);
if (!validateVersionInventory({ status: 'Enabled', current: [], versions: [] })) process.exit(1);
const unicode = ['legacy/я.webp','legacy/z.webp'].sort(compareUtf8);
if (compareUtf8(unicode[0], unicode[1]) >= 0) process.exit(1);
NODE

node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-retirement-journal-rehearsal-'));
try {
  const key = crypto.randomBytes(32);
  const journal = path.join(root, 'journal.jsonl');
  const temporary = `${journal}.tmp.123`;
  let previous = null;
  const encode = payload => {
    const record = { ...payload, previousRecordSha256: previous, recordedAt: '2026-08-15T00:00:00.000Z' };
    const recordHmacSha256 = crypto.createHmac('sha256', key).update(JSON.stringify(record)).digest('hex');
    const line = Buffer.from(`${JSON.stringify({ ...record, recordHmacSha256 })}\n`);
    previous = crypto.createHash('sha256').update(line).digest('hex');
    return line;
  };
  const writeAll = (file, buffer, flag) => {
    const fd = fs.openSync(file, flag, 0o600);
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, Math.min(7, buffer.length - offset));
      if (written <= 0) throw new Error('short write');
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  };
  writeAll(temporary, encode({ version: 1, action: 'header', sequence: 0 }), 'wx');
  fs.linkSync(temporary, journal);
  if (fs.lstatSync(journal).nlink !== 2) throw new Error('publication fixture did not create split hardlink state');
  fs.unlinkSync(temporary);
  if (fs.lstatSync(journal).nlink !== 1) throw new Error('split publication recovery failed');
  writeAll(journal, encode({ version: 1, action: 'preflight', sequence: 1 }), 'a');
  writeAll(journal, encode({ version: 1, action: 'intent', sequence: 2 }), 'a');
  const validIntentLength = fs.statSync(journal).size;
  writeAll(journal, Buffer.from('{"version":1,"action":"confirmed"'), 'a');

  const readAndRepair = () => {
    const bytes = fs.readFileSync(journal);
    const completeEnd = bytes.lastIndexOf(10) + 1;
    if (completeEnd < 2) throw new Error('no complete record');
    const lines = bytes.subarray(0, completeEnd).toString('utf8').trimEnd().split('\n');
    let prior = null;
    for (let index = 0; index < lines.length; index += 1) {
      const value = JSON.parse(lines[index]);
      const { recordHmacSha256, ...payload } = value;
      const actual = crypto.createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
      if (value.sequence !== index || value.previousRecordSha256 !== prior || actual !== recordHmacSha256) {
        throw new Error('invalid complete HMAC chain');
      }
      prior = crypto.createHash('sha256').update(`${lines[index]}\n`).digest('hex');
    }
    if (completeEnd !== bytes.length) {
      const fd = fs.openSync(journal, 'r+');
      fs.ftruncateSync(fd, completeEnd);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }
    previous = prior;
    return lines.map(line => JSON.parse(line));
  };
  let records = readAndRepair();
  if (records.at(-1).action !== 'intent' || fs.statSync(journal).size !== validIntentLength) {
    throw new Error('partial confirmation was not recovered to durable intent');
  }
  // Live object absence after the durable intent is the only condition that
  // permits the retry to append the missing confirmation.
  writeAll(journal, encode({ version: 1, action: 'confirmed', sequence: 3 }), 'a');
  writeAll(journal, Buffer.from('{"partial":true'), 'a');
  records = readAndRepair();
  if (records.at(-1).action !== 'confirmed' || records.length !== 4) throw new Error('confirmed retry recovery failed');
  writeAll(journal, Buffer.from('{}\n'), 'a');
  let malformedRejected = false;
  try { readAndRepair(); } catch { malformedRejected = true; }
  if (!malformedRejected) throw new Error('malformed complete line was weakened into tail recovery');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
NODE

workflow="$SOURCE_ROOT/.github/workflows/deploy-production.yml"
deploy="$SOURCE_ROOT/scripts/deploy-production.sh"
for needle in \
	'avatar-cleanup' \
	'avatar_cleanup_action' \
	'avatar_cleanup_confirmation' \
	'avatar_ownership_revision' \
	'avatar_client_revision' \
	'cleanup-avatar-core-source-production.sh' \
	'guard_avatar_cleanup_checkout_before_pull' \
	'--guard-before-fetch-revision' \
	'--guard-before-checkout-revision' \
	'Avatar Core cleanup checkout guard rejects' \
	'test-avatar-core-source-cleanup-rehearsal.sh'; do
	rg -F -- "$needle" "$workflow" >/dev/null || fail "workflow wiring is missing: $needle"
done
for needle in \
	'.avatar-core-cleanup-v1' \
	'cleanup-avatar-core-source-production.sh' \
	'--guard-before-checkout-revision "$deploy_revision"' \
	'Automatic backend revision' \
	'avatar-cleanup'; do
	rg -F -- "$needle" "$deploy" >/dev/null || fail "routine deploy guard is missing: $needle"
done

WORKFLOW_FILE="$workflow" DEPLOY_FILE="$deploy" node <<'NODE'
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const workflow = fs.readFileSync(process.env.WORKFLOW_FILE, 'utf8');
const deploy = fs.readFileSync(process.env.DEPLOY_FILE, 'utf8');
const cleanup = fs.readFileSync(process.env.DEPLOY_FILE.replace('deploy-production.sh', 'cleanup-avatar-core-source-production.sh'), 'utf8');
const avatarStateParser = /avatar_cleanup_state="\$\(awk -F= '\n([\s\S]*?)\n  ' "\$avatar_cleanup_marker"\)"/.exec(deploy);
if (!avatarStateParser) process.exit(1);
const parseAvatarState = marker => spawnSync('awk', ['-F=', avatarStateParser[1]], {
  input: marker, encoding: 'utf8', stdio: ['pipe','pipe','pipe'],
});
const parserFixture = [
  'phase=complete', `ownership_revision=${'1'.repeat(40)}`, `cleanup_revision=${'2'.repeat(40)}`,
  `current_client_revision=${'3'.repeat(40)}`, `lifecycle_key_retirement_evidence_sha256=${'b'.repeat(64)}`,
].join('\n') + '\n';
const parsedFixture = parseAvatarState(parserFixture);
const obsoleteFixture = parseAvatarState(parserFixture.replace('current_client_revision=', 'client_revision='));
const pendingFixture = parseAvatarState(parserFixture.replace('b'.repeat(64), 'pending'));
if (parsedFixture.status !== 0 || parsedFixture.stdout !==
    `complete|${'2'.repeat(40)}|${'b'.repeat(64)}` || obsoleteFixture.status === 0 ||
    pendingFixture.status !== 0 || pendingFixture.stdout !== `complete|${'2'.repeat(40)}|pending`) process.exit(1);
for (const snippet of [
  'bash -n scripts/cleanup-avatar-core-source-production.sh',
  'bash scripts/cleanup-avatar-core-source-production.sh --self-test',
  'bash -n scripts/test-avatar-core-source-cleanup-rehearsal.sh',
  'bash scripts/test-avatar-core-source-cleanup-rehearsal.sh',
  'CLEANUP AVATAR CORE SOURCE',
  '--forward-recovery',
  'X-Winwidget-Revision',
  '/api/v1/files?folder=',
  '/api/v1/files?filePath=',
  'avatar-legacy-s3-sealed-inventory',
  'orphanObjectCount',
  'ListObjectVersionsCommand',
  'VersionId: source.versionId',
  "versionId !== 'null'",
  'compareUtf8',
  'missing-legacy-delete-allowed',
  'legacyVersionsEmpty',
  'avatar-legacy-s3-retirement-journal-header',
  'avatar-legacy-s3-retirement-preflight',
  'avatar-legacy-s3-retirement-intent',
  'avatar-legacy-s3-retirement-confirmed',
  'avatar_cleanup_recover_retirement_journal_publication',
  'avatar_cleanup_recover_retirement_attempt_signature',
  'avatar_cleanup_verify_timeweb_provider_evidence',
  'avatar_cleanup_run_retirement_node',
  'avatar_cleanup_validate_retirement_image',
  'avatar_cleanup_reconcile_retirement_consumers',
  'avatar_cleanup_read_retirement_consumer_cidfile',
  'avatar_cleanup_persist_retirement_consumer_cidfile',
  'avatar_cleanup_retirement_exit_cleanup',
  'avatar_cleanup_install_retirement_exit_traps',
  'avatar_cleanup_validate_retirement_consumer_recovery',
  'avatar_cleanup_retirement_consumer_recovery_binding',
  'avatar_cleanup_load_retirement_consumer_recovery_binding',
  'cidfileResidueIdSha256',
  'retirementConsumerRecoveryEvidenceArtifacts',
  'retirementConsumerRecoveryEvidenceAggregateSha256',
  'avatar_cleanup_prepare_retirement_journal_key',
  'avatar_cleanup_validate_retirement_journal_key',
  '/run/secrets/winwidget-avatar-retirement-v1',
  '/run/secrets/winwidget-avatar-retirement-journal-key-v1',
  'winwidget-avatar-retirement-journal-key-v1\\0',
  'com.winwidget.lifecycle=avatar-retirement-consumer-v1',
  'com.winwidget.retirement-attempt-sha256',
  'com.winwidget.retirement-input-sha256',
  'com.winwidget.retirement-journal-key-sha256',
  'docker_arguments=(run --pull never --rm -i',
  'findmnt -n -o FSTYPE --target',
  'avatar_cleanup_durable_unlink_private_file',
  'fs.linkSync(process.env.JOURNAL_TEMPORARY, process.env.JOURNAL_FILE)',
  'fs.ftruncateSync(fd, completeEnd)',
  'while (offset < line.length)',
  'retirementPolicyEvidenceSha256',
  'storageEndpointSha256',
  'managed-public-bytes-preflight-intact',
  'clientTrustBootstrapEvidenceSha256',
  'releaseFullManifestSha256',
  'avatar-backend-soak-timer-fence',
  'soakTimerFenceEvidenceSha256',
  'systemctl disable --now winwidget-identity-avatar-soak-heartbeat.timer',
  'legacy-exact-prefix-empty',
  'avatar-live-widgets-storage-denial',
  "verifyPrefix('legacy'",
  'avatar_cleanup_guard_revision',
  'avatar_cleanup_validate_guard_phase_evidence',
  'avatar_cleanup_validate_candidate_clean_source_tree',
]) {
  if (!workflow.includes(snippet) && !cleanup.includes(snippet)) process.exit(1);
}
if ((cleanup.match(/value\.provider !== 'timeweb-s3'/g) || []).length < 4 ||
    cleanup.includes("--env AVATAR_RETIREMENT_ACCESS_KEY_ID") ||
    cleanup.includes("--env AVATAR_RETIREMENT_SECRET_ACCESS_KEY") ||
    cleanup.includes("export AVATAR_RETIREMENT_ACCESS_KEY_ID") ||
    cleanup.includes("export AVATAR_RETIREMENT_SECRET_ACCESS_KEY") ||
    cleanup.includes("!/^[A-Za-z0-9._-]{2,64}$/.test(value.provider)") ||
    (cleanup.match(/const readRetirementCredentials = \(\) =>/g) || []).length !== 2 ||
    (cleanup.match(/\^access_key_id=\(\[A-Za-z0-9\._-\]\{8,256\}\)\\nsecret_access_key=/g) || []).length !== 3 ||
    cleanup.includes('target=/evidence/signing-key') ||
    cleanup.includes('identity_release_image "$avatar_cleanup_runtime_revision"') &&
      cleanup.slice(cleanup.indexOf('avatar_cleanup_retire_legacy_objects()'), cleanup.indexOf('avatar_cleanup_validate_retirement_evidence()'))
        .includes('identity_release_image') ||
    !cleanup.includes('other-s3')) process.exit(1);
const retirementStart = cleanup.indexOf('avatar_cleanup_retire_legacy_objects()');
const retirementEnd = cleanup.indexOf('avatar_cleanup_validate_retirement_evidence()', retirementStart);
const retirement = cleanup.slice(retirementStart, retirementEnd);
const wrapperStart = cleanup.indexOf('avatar_cleanup_run_retirement_node()');
const wrapperEnd = cleanup.indexOf('avatar_cleanup_reconcile_active_retirement_consumer()', wrapperStart);
const wrapper = cleanup.slice(wrapperStart, wrapperEnd);
if (retirementStart < 0 || retirementEnd <= retirementStart || wrapperStart < 0 || wrapperEnd <= wrapperStart ||
    !retirement.includes('avatar_cleanup_load_storage_environment') || retirement.includes('avatar_cleanup_load_audit_environment') ||
    retirement.includes('AVATAR_AUDIT_DATABASE_URL') || !retirement.includes('avatar_cleanup_reconcile_retirement_consumers') ||
    retirement.indexOf('avatar_cleanup_reconcile_retirement_consumers') > retirement.indexOf('avatar_cleanup_load_retirement_credential') ||
    !retirement.includes('image="$(avatar_cleanup_retirement_image_id)"') ||
    !wrapper.includes('docker_arguments=(run --pull never --rm -i') || !wrapper.includes('--name "$name" --cidfile "$cidfile"') ||
    !wrapper.includes('avatar_cleanup_validate_retirement_image "$image"') ||
    wrapper.indexOf('avatar_cleanup_validate_retirement_image "$image"') > wrapper.indexOf('target=$avatar_cleanup_retirement_credential_container_path') ||
    wrapper.includes('avatar_cleanup_signing_key,target=') ||
    !cleanup.includes("avatar_cleanup_prepare_retirement_inventory \"$image\"") ||
    !cleanup.includes("avatar_cleanup_delete_sealed_legacy_objects \"$image\"") ||
    !cleanup.includes("RETIREMENT_TEST_CAPTURE") || !cleanup.includes("journal-delete.sha256") ||
    !cleanup.includes("retirement_channel_self_test_stage=") ||
    !cleanup.includes('avatar-retirement-orphan-self-test') ||
    !cleanup.includes("value.containerObserved!==false||value.containerId!==null") ||
    !cleanup.includes("value.containerObserved!==true||value.containerId!==process.env.EXPECTED_CONTAINER") ||
    !cleanup.includes("avatar_cleanup_retirement_signal_self_test") ||
    !cleanup.includes("value.retirementConsumerRecoveryEvidenceCount !== recovery.count") ||
    !cleanup.includes("JSON.stringify(value.retirementConsumerRecoveryEvidenceArtifacts) !== JSON.stringify(recovery.artifacts)")) process.exit(1);
const retirementValidatorStart = cleanup.indexOf('avatar_cleanup_validate_retirement_evidence()');
const retirementValidatorEnd = cleanup.indexOf('avatar_cleanup_require_revocation_evidence()', retirementValidatorStart);
const retirementValidator = cleanup.slice(retirementValidatorStart, retirementValidatorEnd);
const completeValidatorStart = cleanup.indexOf('avatar_cleanup_validate_cleanup_complete_body()');
const completeValidatorEnd = cleanup.indexOf('avatar_cleanup_validate_cleanup_complete_signature()', completeValidatorStart);
const completeValidator = cleanup.slice(completeValidatorStart, completeValidatorEnd);
if (retirementValidatorStart < 0 || retirementValidatorEnd <= retirementValidatorStart ||
    completeValidatorStart < 0 || completeValidatorEnd <= completeValidatorStart ||
    !retirementValidator.includes('recovery_binding="$(avatar_cleanup_retirement_consumer_recovery_binding)"') ||
    !completeValidator.includes('avatar_cleanup_load_retirement_consumer_recovery_binding') ||
    !completeValidator.includes("'retirementConsumerRecoveryEvidenceAggregateSha256'")) process.exit(1);
const persistStart = cleanup.indexOf('avatar_cleanup_persist_retirement_consumer_cidfile()');
const persistEnd = cleanup.indexOf('avatar_cleanup_verify_timeweb_provider_evidence()', persistStart);
const persist = cleanup.slice(persistStart, persistEnd);
const persistExactMatch = persist.indexOf('[[ "$actual" == "$container" ]] || return 1');
const persistDurableBarrier = persist.indexOf('avatar_cleanup_fsync_file_and_parent "$cidfile"', persistExactMatch);
if (persistStart < 0 || persistEnd <= persistStart || persistExactMatch < 0 ||
    persistDurableBarrier <= persistExactMatch || !cleanup.includes("fsync_interrupt_once=true") ||
    !cleanup.includes("fsync-file\\nfsync-parent\\nfsync-file\\nfsync-parent\\nstop\\nwait\\nrm\\n")) process.exit(1);
const reconcileStart = cleanup.indexOf('avatar_cleanup_reconcile_retirement_consumers()');
const reconcileEnd = cleanup.indexOf('avatar_cleanup_assert_no_retirement_consumer()', reconcileStart);
const reconcile = cleanup.slice(reconcileStart, reconcileEnd);
const ownedStart = reconcile.indexOf("if [[ \"$count\" == '1' ]]");
const persistCid = reconcile.indexOf('avatar_cleanup_persist_retirement_consumer_cidfile', ownedStart);
const removeOwned = reconcile.indexOf('avatar_cleanup_remove_retirement_consumer', persistCid);
const removeCredential = reconcile.indexOf('avatar_cleanup_durable_unlink_private_file "$AVATAR_RETIREMENT_CREDENTIAL_FILE"', removeOwned);
const recordOwned = reconcile.indexOf('avatar_cleanup_record_retirement_consumer_recovery', removeCredential);
const removeCid = reconcile.indexOf('avatar_cleanup_durable_unlink_private_file "$cidfile"', recordOwned);
const activeStart = cleanup.indexOf('avatar_cleanup_reconcile_active_retirement_consumer()');
const activeEnd = cleanup.indexOf('avatar_cleanup_retirement_exit_cleanup()', activeStart);
const active = cleanup.slice(activeStart, activeEnd);
const activePersist = active.indexOf('avatar_cleanup_persist_retirement_consumer_cidfile');
const activeRemove = active.indexOf('avatar_cleanup_remove_retirement_consumer', activePersist);
const activeCredential = active.indexOf('avatar_cleanup_durable_unlink_private_file "$AVATAR_RETIREMENT_CREDENTIAL_FILE"', activeRemove);
const activeRecord = active.indexOf('avatar_cleanup_record_retirement_consumer_recovery', activeCredential);
const activeCid = active.indexOf('avatar_cleanup_durable_unlink_private_file "$avatar_cleanup_active_retirement_cidfile"', activeRecord);
if ([reconcileStart,reconcileEnd,ownedStart,persistCid,removeOwned,removeCredential,recordOwned,removeCid,
     activeStart,activeEnd,activePersist,activeRemove,activeCredential,activeRecord,activeCid].some(item=>item<0) ||
    !(persistCid<removeOwned&&removeOwned<removeCredential&&removeCredential<recordOwned&&recordOwned<removeCid) ||
    !(activePersist<activeRemove&&activeRemove<activeCredential&&activeCredential<activeRecord&&activeRecord<activeCid)) process.exit(1);
if (!cleanup.includes("'fullManifestSha256','generatedAt'") ||
	    !cleanup.includes('binding.releaseFullManifestSha256 !== release.fullManifestSha256') ||
	    !cleanup.includes('releaseBytes.length > 64 * 1024') ||
    !cleanup.includes('releaseText !== JSON.stringify(release)') || cleanup.includes('release.files')) process.exit(1);
const stopFunction = cleanup.indexOf('avatar_cleanup_stop_legacy_writer()');
const timerFence = cleanup.indexOf('avatar_cleanup_fence_soak_timer', stopFunction);
const dockerStop = cleanup.indexOf('docker stop --time 30', stopFunction);
const deployFunction = cleanup.indexOf('avatar_cleanup_deploy()');
const verifiedSoak = cleanup.indexOf('avatar_cleanup_validate_current_soak_contract', deployFunction);
const forwardCase = cleanup.indexOf('forward-only)', verifiedSoak);
if ([stopFunction,timerFence,dockerStop,deployFunction,verifiedSoak,forwardCase].some(index => index < 0) ||
    !(stopFunction < timerFence && timerFence < dockerStop) || !(deployFunction < verifiedSoak && verifiedSoak < forwardCase) ||
    !cleanup.includes('avatar_cleanup_assert_public_client_revision forward') ||
    !cleanup.includes('avatar_cleanup_assert_forward_identity_runtime')) process.exit(1);
const guard = deploy.indexOf('avatar_cleanup_marker');
const localGuard = deploy.indexOf('--guard-before-checkout-revision "$deploy_revision"', guard);
const migration = deploy.indexOf('migrate', guard);
const restart = deploy.indexOf('up -d', guard);
const defer = deploy.indexOf('destructive Avatar Core cleanup is deferred', guard);
if (guard < 0 || localGuard <= guard || defer < guard ||
	    (migration >= 0 && defer > migration) ||
	    (restart >= 0 && defer > restart) ||
    !deploy.includes('$1 == "current_client_revision"') || deploy.includes('$1 == "client_revision"') ||
    !deploy.includes('$1 == "lifecycle_key_retirement_evidence_sha256"') ||
    !deploy.includes('Completed Avatar cleanup descendant deployment is blocked until the SHA-A lifecycle bypass integration is present.') ||
    deploy.includes('avatar_cleanup_completed_descendant')) process.exit(1);
const workflowLines = workflow.split('\n').map(line => line.trim());
const avatarGuardFunctions = workflowLines.filter(line => line === 'guard_avatar_cleanup_checkout_before_pull() {').length;
const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'));
const checkoutStart = deployJob.indexOf('checkout_verified_prod_revision() {');
const checkoutEnd = deployJob.indexOf('checkout_retargeted_billing_cleanup_revision() {', checkoutStart);
const checkout = deployJob.slice(checkoutStart, checkoutEnd);
const prefetch = checkout.lastIndexOf('guard_avatar_cleanup_checkout_before_pull "$expected_revision"');
const fetch = checkout.indexOf('git fetch origin prod');
const postfetch = checkout.indexOf('guard_avatar_cleanup_checkout_before_pull', fetch);
const checkoutMutation = checkout.indexOf('git checkout prod', fetch);
const automaticStart = deployJob.indexOf('if [[ "$AUTOMATIC_PROD_PUSH" == "true"', checkoutEnd);
const automaticEnd = deployJob.indexOf('case "$DEPLOY_TARGET" in', automaticStart);
const automatic = deployJob.slice(automaticStart, automaticEnd);
if (avatarGuardFunctions !== 2 || checkoutStart < 0 || checkoutEnd <= checkoutStart ||
    prefetch < 0 || fetch <= prefetch || postfetch <= fetch || checkoutMutation <= postfetch ||
    automaticStart < 0 || automaticEnd <= automaticStart ||
    !automatic.includes('if ! guard_avatar_cleanup_checkout_before_pull') ||
    automatic.includes('git fetch origin prod') || automatic.includes('git checkout prod')) process.exit(1);
NODE

CLEANUP_FILE="$SOURCE_ROOT/scripts/cleanup-avatar-core-source-production.sh" node <<'NODE'
const fs=require('node:fs');
const source=fs.readFileSync(process.env.CLEANUP_FILE,'utf8');
const block=name=>{
  const match=new RegExp(`^${name}\\(\\) [({]$`,'m').exec(source);
  if(!match)process.exit(1);
  const start=match.index;const bodyStart=start+match[0].length;
  const tail=source.slice(bodyStart);
  const next=/^avatar_cleanup_[a-z0-9_]+\(\) [({]$/m.exec(tail);
  return source.slice(start,next?bodyStart+next.index:source.length);
};
const array=(value,marker)=>{
  const start=value.indexOf(marker);const end=value.indexOf('];',start);
  if(start<0||end<=start)process.exit(1);
  return [...value.slice(start+marker.length,end).matchAll(/'([^']+)'/g)].map(match=>match[1]);
};
const ownershipKeys=['version','phase','server_revision','runtime_revision','client_revision','current_client_revision',
  'runtime_stability_generation','runtime_stability_evidence_sha256','writer_fence_evidence_sha256',
  'storage_policy_evidence_sha256','uploads_snapshot_evidence_sha256','inventory_manifest_sha256',
  'migration_manifest_sha256','status_manifest_sha256','revocation_evidence_sha256',
  'authenticated_smoke_evidence_sha256','client_evidence_sha256','soak_evidence_sha256',
  'runtime_retarget_evidence_sha256','client_retarget_evidence_sha256','cleanup_retarget_evidence_sha256',
  'migration_ready_at','migrated_at','client_switched_at','soak_verified_at','updated_at','signature'];
const ownership=block('avatar_cleanup_validate_ownership_marker');
if(JSON.stringify(array(ownership,'const expected = ['))!==JSON.stringify(ownershipKeys)||
  !ownership.includes("value.version !== '3'")||ownership.includes("value.version !== '2'"))process.exit(1);
const markerKeys=['version','phase','ownership_revision','cleanup_revision','ownership_marker_sha256',
  'current_runtime_revision','initial_client_revision','current_client_revision','identity_database_id',
  'runtime_stability_generation','runtime_stability_evidence_sha256','runtime_stability_ledger_generation',
  'runtime_stability_ledger_tail_state','runtime_stability_ledger_tail_evidence_sha256',
  'runtime_stability_current_evidence_sha256','runtime_stability_current_signature_sha256',
  'current_client_binding_evidence_sha256','frontend_binding_sha256','runtime_stable_since',
  'identity_api_image_id','identity_worker_image_id','identity_outbox_image_id','core_source_image_id',
  'core_cleanup_image_id','client_evidence_sha256','pre_client_reference_zero_evidence_sha256',
  'client_ready_evidence_sha256','client_ready_signature_sha256','predeploy_uploads_handoff_sha256',
  'cleanup_retarget_evidence_sha256','runtime_evidence_sha256','manifest_evidence_sha256',
  'reference_evidence_sha256','observation_evidence_sha256','identity_backup_sha256',
  'identity_restore_evidence_sha256','writer_fence_evidence_sha256','retirement_evidence_sha256',
  'revocation_evidence_sha256','nginx_evidence_sha256','smoke_evidence_sha256',
  'cleanup_complete_evidence_sha256','cleanup_complete_signature_sha256',
  'lifecycle_key_retirement_evidence_sha256','updated_at','signature_hmac_sha256'];
const marker=block('avatar_cleanup_validate_marker');
if(JSON.stringify(array(marker,'const expectedKeys = ['))!==JSON.stringify(markerKeys)||
  !marker.includes('values.runtime_stability_ledger_tail_evidence_sha256 === values.runtime_stability_evidence_sha256'))
  process.exit(1);
const completeKeys=['schemaVersion','kind','cleanupPhase','ownershipRevision','currentRuntimeRevision',
  'cleanupRevision','initialClientRevision','currentClientRevision','identityDatabaseId','ownershipMarkerSha256',
  'runtimeStabilityCurrentEvidenceSha256','runtimeStabilityCurrentEvidenceSignatureSha256',
  'runtimeStabilityGeneration','runtimeStabilityEvidenceSha256','runtimeStabilityLedgerGeneration',
  'runtimeStabilityLedgerTailState','runtimeStabilityLedgerTailEvidenceSha256','runtimeStableSince',
  'currentClientBindingEvidenceSha256','runtimeRetargetEvidenceSha256','clientRetargetEvidenceSha256',
  'frontendBinding','clientReadyEvidenceSha256','clientReadyEvidenceSignatureSha256',
  'clientSwitchEvidenceSha256','soakEvidenceSha256','preClientReferenceZeroEvidenceSha256',
  'predeployUploadsHandoffSha256','cleanupRetargetEvidenceSha256','cleanupReferenceZeroEvidenceSha256',
  'writerFenceEvidenceSha256','retirementEvidenceSha256','retirementConsumerRecoveryEvidenceCount',
  'retirementConsumerRecoveryEvidenceAggregateSha256','revocationEvidenceSha256','nginxEvidenceSha256',
  'smokeEvidenceSha256','coreCleanupImageId','legacyReferencesAbsent','legacyRoutesAbsent',
  'legacyObjectsRetired','ownershipActive','completedAt'];
const frontendKeys=['bindingKind','evidenceSha256','evidenceSignatureSha256','clientRevision','imageId',
  'releaseEvidenceSha256','releaseEvidenceSignatureSha256','releaseTreeSha256',
  'releaseFullManifestSha256','processStartedAt'];
const complete=block('avatar_cleanup_validate_cleanup_complete_body');
if(JSON.stringify(array(complete,'const keys = ['))!==JSON.stringify(completeKeys)||
  JSON.stringify(array(complete,'const frontendKeys = ['))!==JSON.stringify(frontendKeys)||
  !complete.includes("['initial-client-switch','client-code-retarget','frontend-runtime-rebind']")||
  !complete.includes('/^(pending|[0-9a-f]{64})$/')||!complete.includes('604800000')||
  !complete.includes('Date.now() + 120000'))process.exit(1);
const normalized=source.replace(/\\\n/g,' ').replace(/\s+/g,' ');
const heartbeat='identity_avatar_validate_soak_heartbeat_chain "$current_client_revision" "$client_sha" "$client_retarget_sha" "$runtime_retarget_sha" "$client_release_sha" "$client_release_signature_sha" "$client_process_started_at" "$writer_sha" "$policy_sha" "$inventory_sha" "$status_sha" "$revocation_sha" "$smoke_sha" "$boundary" "$reset_anchor_sha" "$stability_generation" "$stability_sha"';
const soak='identity_avatar_validate_soak_evidence "$current_client_revision" "$client_sha" "$client_retarget_sha" "$runtime_retarget_sha" "$writer_sha" "$policy_sha" "$inventory_sha" "$status_sha" "$revocation_sha" "$smoke_sha" "$prefix_chain" "$stability_generation" "$stability_sha"';
if(normalized.split(heartbeat).length-1!==2||normalized.split(soak).length-1!==1)process.exit(1);
const currentBinding=block('avatar_cleanup_current_client_binding');
const captureClient=block('avatar_cleanup_capture_client_evidence');
if(!currentBinding.includes('avatar_cleanup_frontend_binding')||
  !captureClient.includes("['bindingKind','evidenceSha256','evidenceSignatureSha256','clientRevision','imageId'")||
  !captureClient.includes("'frontend-runtime-rebind'")||captureClient.includes("'client-soak-retarget'"))process.exit(1);
const compute=block('avatar_cleanup_compute_ownership_context');
const inherited=block('avatar_cleanup_validate_inherited_contract');
if(!compute.includes('identity_avatar_validate_runtime_stability_chain bound')||
  !inherited.includes('identity_avatar_validate_runtime_stability_chain_immutable bound')||
  !compute.includes('SERVER_ROOT="$validator_root"')||!compute.includes('SERVER_ROOT="$actual_server_root"')||
  !inherited.includes('SERVER_ROOT="$validator_root"')||!inherited.includes('SERVER_ROOT="$actual_server_root"'))process.exit(1);
const publish=block('avatar_cleanup_publish_cleanup_complete');
const firstPermanent=publish.indexOf('avatar_cleanup_verify_public_cleanup_complete');
const firstAbsent=publish.indexOf('avatar_cleanup_verify_temporary_routes_absent',firstPermanent);
const unlink=publish.indexOf('avatar_cleanup_remove_temporary_public_pairs',firstAbsent);
const secondPermanent=publish.indexOf('avatar_cleanup_verify_public_cleanup_complete',unlink);
const secondAbsent=publish.indexOf('avatar_cleanup_verify_temporary_routes_absent',secondPermanent);
if(!(firstPermanent>=0&&firstPermanent<firstAbsent&&firstAbsent<unlink&&unlink<secondPermanent&&
  secondPermanent<secondAbsent)||
  publish.indexOf('avatar_cleanup_publish_public_copy "$avatar_cleanup_complete_signature"')>
    publish.indexOf('avatar_cleanup_publish_public_copy "$avatar_cleanup_complete_body"'))process.exit(1);
const deploy=block('avatar_cleanup_deploy');
const create=deploy.lastIndexOf('avatar_cleanup_create_cleanup_complete_evidence');
const before=deploy.lastIndexOf('avatar_cleanup_assert_completion_runtime_fence',create);
const after=deploy.indexOf('avatar_cleanup_assert_completion_runtime_fence',create);
const completeMarker=deploy.indexOf('avatar_cleanup_update_forward_marker complete',after);
if(!(before>=0&&before<create&&create<after&&after<completeMarker))process.exit(1);
NODE

printf 'avatar_core_cleanup_rehearsal=passed\n'
