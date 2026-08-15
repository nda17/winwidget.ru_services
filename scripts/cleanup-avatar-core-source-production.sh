#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

AVATAR_SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
AVATAR_OWNERSHIP_REVISION="${AVATAR_OWNERSHIP_REVISION:-}"
AVATAR_CLIENT_REVISION="${AVATAR_CLIENT_REVISION:-}"
AVATAR_CLEANUP_CONFIRMATION="${AVATAR_CLEANUP_CONFIRMATION:-}"
AVATAR_PUBLIC_ORIGIN="${AVATAR_PUBLIC_ORIGIN:-https://winwidget.ru}"
AVATAR_API_ORIGIN="${AVATAR_API_ORIGIN:-https://api.winwidget.ru}"
AVATAR_RETIREMENT_CREDENTIAL_FILE="${AVATAR_RETIREMENT_CREDENTIAL_FILE:-/run/winwidget/avatar-retirement-credential-v1}"
AVATAR_RETIREMENT_REVOCATION_ROOT="${AVATAR_RETIREMENT_REVOCATION_ROOT:-$APP_ROOT/deploy/backend/avatar-retirement-credential-revocations-v1}"
AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE="${AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE:-$APP_ROOT/deploy/backend/avatar-retirement-infra-ed25519-public.pem}"
IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY="${IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY:-$APP_ROOT/deploy/backend/.identity-avatar-client-signing.public.pem}"
IDENTITY_AVATAR_SIGNING_PRIVATE_KEY="${IDENTITY_AVATAR_SIGNING_PRIVATE_KEY:-$APP_ROOT/deploy/backend/.identity-avatar-media-signing.private.pem}"
IDENTITY_AVATAR_SIGNING_PUBLIC_KEY="${IDENTITY_AVATAR_SIGNING_PUBLIC_KEY:-$APP_ROOT/deploy/backend/.identity-avatar-media-signing.public.pem}"

avatar_cleanup_root="${AVATAR_CORE_CLEANUP_ARTIFACT_ROOT:-$APP_ROOT/deploy/backend/avatar-core-cleanup-artifacts}"
avatar_cleanup_marker="${AVATAR_CORE_CLEANUP_MARKER:-$APP_ROOT/deploy/backend/.avatar-core-cleanup-v1}"
avatar_cleanup_signing_key="${AVATAR_CORE_CLEANUP_SIGNING_KEY:-$APP_ROOT/deploy/backend/.avatar-core-cleanup-signing-key-v1}"
avatar_cleanup_manifest="$avatar_cleanup_root/avatar-object-database-manifest.json"
avatar_cleanup_references="$avatar_cleanup_root/legacy-reference-scan.json"
avatar_cleanup_client="$avatar_cleanup_root/client-runtime-evidence.json"
avatar_cleanup_observation="$avatar_cleanup_root/legacy-http-observation.json"
avatar_cleanup_identity_backup="$avatar_cleanup_root/identity-pre-avatar-cleanup.dump"
avatar_cleanup_identity_backup_journal="${avatar_cleanup_identity_backup}.capture-v1"
avatar_cleanup_identity_restore="$avatar_cleanup_root/identity-pre-avatar-cleanup-restore.json"
avatar_cleanup_runtime="$avatar_cleanup_root/runtime-and-image-evidence.json"
avatar_cleanup_writer_fence="$avatar_cleanup_root/core-writer-fence-evidence.json"
avatar_cleanup_soak_timer_fence="$avatar_cleanup_root/soak-timer-fence-evidence.json"
avatar_cleanup_soak_timer_service='/etc/systemd/system/winwidget-identity-avatar-soak-heartbeat.service'
avatar_cleanup_soak_timer_unit='/etc/systemd/system/winwidget-identity-avatar-soak-heartbeat.timer'
avatar_cleanup_soak_timer_status_root="${IDENTITY_AVATAR_ARTIFACT_ROOT:-$APP_ROOT/deploy/backend/identity-avatar-media-artifacts}"
avatar_cleanup_retirement_inventory="$avatar_cleanup_root/legacy-s3-retirement-inventory.json"
avatar_cleanup_retirement_journal="$avatar_cleanup_root/legacy-s3-retirement-journal.jsonl"
avatar_cleanup_uploads_retirement_inventory="$avatar_cleanup_root/legacy-uploads-retirement-inventory.json"
avatar_cleanup_retirement="$avatar_cleanup_root/legacy-object-retirement-evidence.json"
avatar_cleanup_revocation="$avatar_cleanup_root/retirement-credential-revocation-evidence.json"
avatar_cleanup_retirement_consumer_recovery_root="$avatar_cleanup_root/retirement-consumer-recovery-v1"
avatar_cleanup_nginx="$avatar_cleanup_root/nginx-install-evidence.json"
avatar_cleanup_smoke="$avatar_cleanup_root/post-cleanup-smoke-evidence.json"
avatar_cleanup_complete_body="$avatar_cleanup_root/cleanup-complete-v1.json"
avatar_cleanup_complete_signature="${avatar_cleanup_complete_body}.sig"
avatar_cleanup_lifecycle_key_retirement_authorization="$avatar_cleanup_root/lifecycle-key-retirement-authorization-v1.json"
avatar_cleanup_lifecycle_key_retirement="$avatar_cleanup_root/lifecycle-key-retirement-evidence-v1.json"
avatar_cleanup_public_root='/var/lib/winwidget/identity-avatar-public'
avatar_cleanup_public_complete_body="$avatar_cleanup_public_root/cleanup-complete-v1.json"
avatar_cleanup_public_complete_signature="${avatar_cleanup_public_complete_body}.sig"
avatar_cleanup_public_client_ready_body="$avatar_cleanup_public_root/client-ready-v1.json"
avatar_cleanup_public_client_ready_signature="${avatar_cleanup_public_client_ready_body}.sig"
avatar_cleanup_public_client_retarget_ack_body="$avatar_cleanup_public_root/client-retarget-ack-v1.json"
avatar_cleanup_public_client_retarget_ack_signature="${avatar_cleanup_public_client_retarget_ack_body}.sig"
avatar_cleanup_public_runtime_stability_current_body="$avatar_cleanup_public_root/runtime-stability-current-v1.json"
avatar_cleanup_public_runtime_stability_current_signature="${avatar_cleanup_public_runtime_stability_current_body}.sig"
avatar_cleanup_public_frontend_rebind_ready_body="$avatar_cleanup_public_root/frontend-runtime-rebind-ready-v1.json"
avatar_cleanup_public_frontend_rebind_ready_signature="${avatar_cleanup_public_frontend_rebind_ready_body}.sig"
avatar_cleanup_public_nginx_target='/etc/nginx/winwidget-identity-avatar-client-ready/client-ready.conf'

readonly avatar_cleanup_confirmation='CLEANUP AVATAR CORE SOURCE'
readonly avatar_cleanup_avatar_migration='20260815010000_add_avatar_media_ownership'
readonly avatar_cleanup_retirement_credential_container_path='/run/secrets/winwidget-avatar-retirement-v1'
readonly avatar_cleanup_retirement_journal_key_container_path='/run/secrets/winwidget-avatar-retirement-journal-key-v1'
readonly avatar_cleanup_retirement_consumer_lifecycle='avatar-retirement-consumer-v1'
readonly avatar_cleanup_retirement_consumer_label='com.winwidget.lifecycle=avatar-retirement-consumer-v1'

# Reuse the already-reviewed crash-safe identity dump journal. Sourcing does not
# execute its entry point.
# shellcheck source=scripts/cleanup-identity-core-source-production.sh
source "$AVATAR_SCRIPT_ROOT/scripts/cleanup-identity-core-source-production.sh"

avatar_cleanup_fail() {
	printf 'avatar_core_cleanup_error=%s\n' "$1" >&2
	return 1
}

avatar_cleanup_sha256() {
	identity_cutover_sha256 "$1"
}

avatar_cleanup_stat_identity() {
	if [[ "$(uname -s)" == 'Darwin' ]]; then
		stat -f '%u:%g:%Lp' "$1"
	else
		stat -c '%u:%g:%a' "$1"
	fi
}

avatar_cleanup_validate_private_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	[[ "$(avatar_cleanup_stat_identity "$1")" == "$(id -u):$(id -g):600" ]] || return 1
	if [[ "$(uname -s)" == 'Darwin' ]]; then
		[[ "$(stat -f '%l' "$1")" == '1' ]] || return 1
	else
		[[ "$(stat -c '%h' "$1")" == '1' ]] || return 1
	fi
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(avatar_cleanup_stat_identity "$1")" == '0:0:600' ]] || return 1
	fi
}

avatar_cleanup_validate_public_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" &&
		"$(avatar_cleanup_stat_identity "$1")" == '0:0:644' ]] || return 1
	if [[ "$(uname -s)" == 'Darwin' ]]; then
		[[ "$(stat -f '%l' "$1")" == '1' ]]
	else
		[[ "$(stat -c '%h' "$1")" == '1' ]]
	fi
}

avatar_cleanup_require_root() {
	[[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]] ||
		avatar_cleanup_fail 'production cleanup requires Linux root'
}

avatar_cleanup_fsync_file_and_parent() {
	[[ $# -eq 1 ]] || return 1
	FSYNC_TARGET="$1" node <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const target = process.env.FSYNC_TARGET;
const stat = fs.lstatSync(target);
if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
let fd = fs.openSync(target, 'r');
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fd = fs.openSync(path.dirname(target), 'r');
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE
}

avatar_cleanup_fsync_directory() {
	[[ $# -eq 1 && -d "$1" && ! -L "$1" ]] || return 1
	FSYNC_DIRECTORY="$1" node <<'NODE' || return 1
const fs = require('node:fs');
const fd = fs.openSync(process.env.FSYNC_DIRECTORY, 'r');
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE
}

avatar_cleanup_require_artifact_root() {
	if [[ ! -e "$avatar_cleanup_root" && ! -L "$avatar_cleanup_root" ]]; then
		install -d -m 700 -o 0 -g 0 "$avatar_cleanup_root"
	fi
	[[ -d "$avatar_cleanup_root" && ! -L "$avatar_cleanup_root" &&
		"$(avatar_cleanup_stat_identity "$avatar_cleanup_root")" == '0:0:700' ]] ||
		avatar_cleanup_fail 'artifact directory must be root-owned mode 0700'
}

avatar_cleanup_create_signing_key() {
	if [[ -e "$avatar_cleanup_signing_key" || -L "$avatar_cleanup_signing_key" ]]; then
		avatar_cleanup_validate_private_file "$avatar_cleanup_signing_key" ||
			avatar_cleanup_fail 'cleanup signing key is unsafe' || return 1
	else
		local temporary="${avatar_cleanup_signing_key}.tmp.$$"
		[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
		node - "$temporary" <<'NODE' || return 1
const { closeSync, openSync, writeFileSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const path = process.argv[2];
const fd = openSync(path, 'wx', 0o600);
closeSync(fd);
writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
NODE
		chown 0:0 "$temporary" || return 1
		chmod 600 "$temporary" || return 1
		avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
		mv -f -- "$temporary" "$avatar_cleanup_signing_key" || return 1
		avatar_cleanup_fsync_file_and_parent "$avatar_cleanup_signing_key" || return 1
	fi
	SIGNING_KEY_FILE="$avatar_cleanup_signing_key" node <<'NODE' || return 1
const fs = require('node:fs');
const value = fs.readFileSync(process.env.SIGNING_KEY_FILE, 'utf8').trim();
if (!/^[0-9a-f]{64}$/.test(value) || /^0+$/.test(value)) process.exit(1);
NODE
}

avatar_cleanup_hmac() {
	[[ $# -eq 1 ]] || return 1
	SIGNING_KEY_FILE="$avatar_cleanup_signing_key" SIGNED_FILE="$1" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const key = Buffer.from(fs.readFileSync(process.env.SIGNING_KEY_FILE, 'utf8').trim(), 'hex');
process.stdout.write(crypto.createHmac('sha256', key).update(fs.readFileSync(process.env.SIGNED_FILE)).digest('hex'));
NODE
}

avatar_cleanup_sign_artifact() {
	[[ $# -eq 1 ]] || return 1
	local artifact="$1" signature="${1}.hmac-sha256" temporary="${1}.hmac-sha256.tmp.$$"
	avatar_cleanup_validate_private_file "$artifact" || return 1
	avatar_cleanup_create_signing_key || return 1
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	printf '%s\n' "$(avatar_cleanup_hmac "$artifact")" >"$temporary" || return 1
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -f -- "$temporary" "$signature" || return 1
	avatar_cleanup_fsync_file_and_parent "$signature" || return 1
	avatar_cleanup_verify_artifact "$artifact"
}

avatar_cleanup_verify_artifact() {
	[[ $# -eq 1 ]] || return 1
	local artifact="$1" signature="${1}.hmac-sha256"
	avatar_cleanup_validate_private_file "$artifact" || return 1
	avatar_cleanup_validate_private_file "$signature" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_signing_key" || return 1
	SIGNED_FILE="$artifact" SIGNATURE_FILE="$signature" SIGNING_KEY_FILE="$avatar_cleanup_signing_key" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const key = Buffer.from(fs.readFileSync(process.env.SIGNING_KEY_FILE, 'utf8').trim(), 'hex');
const expectedText = fs.readFileSync(process.env.SIGNATURE_FILE, 'utf8').trim();
if (!/^[0-9a-f]{64}$/.test(expectedText)) process.exit(1);
const expected = Buffer.from(expectedText, 'hex');
const actual = crypto.createHmac('sha256', key).update(fs.readFileSync(process.env.SIGNED_FILE)).digest();
if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) process.exit(1);
NODE
}

avatar_cleanup_write_json_artifact() {
	[[ $# -eq 2 ]] || return 1
	local destination="$1" source="$2" temporary="${1}.tmp.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	SOURCE_JSON="$source" DESTINATION_JSON="$temporary" node <<'NODE' || return 1
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.SOURCE_JSON, 'utf8'));
fs.writeFileSync(process.env.DESTINATION_JSON, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -f -- "$temporary" "$destination" || return 1
	avatar_cleanup_fsync_file_and_parent "$destination" || return 1
	avatar_cleanup_sign_artifact "$destination"
}

avatar_cleanup_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z0-9_]+$ ]] || return 1
	avatar_cleanup_validate_marker || return 1
	awk -F= -v key="$1" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$avatar_cleanup_marker"
}

avatar_cleanup_validate_marker() {
	[[ -f "$avatar_cleanup_marker" && ! -L "$avatar_cleanup_marker" ]] || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_marker" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_signing_key" || return 1
	MARKER_FILE="$avatar_cleanup_marker" SIGNING_KEY_FILE="$avatar_cleanup_signing_key" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const lines = fs.readFileSync(process.env.MARKER_FILE, 'utf8').trimEnd().split('\n');
const expectedKeys = [
  'version','phase','ownership_revision','cleanup_revision','ownership_marker_sha256',
  'current_runtime_revision','initial_client_revision','current_client_revision','identity_database_id',
  'runtime_stability_generation','runtime_stability_evidence_sha256',
  'runtime_stability_ledger_generation','runtime_stability_ledger_tail_state',
  'runtime_stability_ledger_tail_evidence_sha256','runtime_stability_current_evidence_sha256',
  'runtime_stability_current_signature_sha256','current_client_binding_evidence_sha256',
  'frontend_binding_sha256','runtime_stable_since',
  'identity_api_image_id','identity_worker_image_id','identity_outbox_image_id',
  'core_source_image_id','core_cleanup_image_id','client_evidence_sha256',
  'pre_client_reference_zero_evidence_sha256','client_ready_evidence_sha256',
  'client_ready_signature_sha256','predeploy_uploads_handoff_sha256',
  'cleanup_retarget_evidence_sha256',
  'runtime_evidence_sha256','manifest_evidence_sha256','reference_evidence_sha256',
  'observation_evidence_sha256','identity_backup_sha256','identity_restore_evidence_sha256',
  'writer_fence_evidence_sha256','retirement_evidence_sha256','revocation_evidence_sha256',
  'nginx_evidence_sha256','smoke_evidence_sha256','cleanup_complete_evidence_sha256',
  'cleanup_complete_signature_sha256','lifecycle_key_retirement_evidence_sha256',
  'updated_at','signature_hmac_sha256',
];
const entries = lines.map(line => {
  const at = line.indexOf('=');
  if (at < 1) process.exit(1);
  return [line.slice(0, at), line.slice(at + 1)];
});
if (entries.length !== expectedKeys.length || entries.some(([key], index) => key !== expectedKeys[index])) process.exit(1);
const values = Object.fromEntries(entries);
const sha40 = /^[0-9a-f]{40}$/;
const sha64 = /^[0-9a-f]{64}$/;
const image = /^sha256:[0-9a-f]{64}$/;
const hashOrPending = value => value === 'pending' || sha64.test(value);
const canonicalSeconds = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString().replace('.000Z','Z') === value;
const generation = value => /^(0|[1-9]|[1-5][0-9]|6[0-4])$/.test(value || '');
if (values.version !== '1' || !/^(verified|forward-only|complete)$/.test(values.phase) ||
    !sha40.test(values.ownership_revision) || !sha40.test(values.cleanup_revision) ||
    values.ownership_revision === values.cleanup_revision || !sha64.test(values.ownership_marker_sha256) ||
    !sha40.test(values.current_runtime_revision) || !sha40.test(values.initial_client_revision) ||
    !sha40.test(values.current_client_revision) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values.identity_database_id) ||
    !generation(values.runtime_stability_generation) || !sha64.test(values.runtime_stability_evidence_sha256) ||
    !generation(values.runtime_stability_ledger_generation) ||
    !/^(applied|adopted|aborted)$/.test(values.runtime_stability_ledger_tail_state) ||
    !sha64.test(values.runtime_stability_ledger_tail_evidence_sha256) ||
    !sha64.test(values.runtime_stability_current_evidence_sha256) ||
    !sha64.test(values.runtime_stability_current_signature_sha256) ||
    !sha64.test(values.current_client_binding_evidence_sha256) || !sha64.test(values.frontend_binding_sha256) ||
    !canonicalSeconds(values.runtime_stable_since) ||
    (values.runtime_stability_ledger_tail_state === 'aborted' ?
      (Number(values.runtime_stability_ledger_generation) !== Number(values.runtime_stability_generation) + 1 ||
        values.runtime_stability_ledger_tail_evidence_sha256 === values.runtime_stability_evidence_sha256) :
      (values.runtime_stability_ledger_generation !== values.runtime_stability_generation ||
        values.runtime_stability_ledger_tail_evidence_sha256 !== values.runtime_stability_evidence_sha256)) ||
    !image.test(values.identity_api_image_id) || !image.test(values.identity_worker_image_id) ||
    !image.test(values.identity_outbox_image_id) || !image.test(values.core_source_image_id) ||
    !image.test(values.core_cleanup_image_id) ||
    ['client_evidence_sha256','pre_client_reference_zero_evidence_sha256','client_ready_evidence_sha256',
     'client_ready_signature_sha256','predeploy_uploads_handoff_sha256','cleanup_retarget_evidence_sha256',
     'runtime_evidence_sha256','manifest_evidence_sha256',
     'reference_evidence_sha256','observation_evidence_sha256','identity_backup_sha256',
     'identity_restore_evidence_sha256'].some(key => !sha64.test(values[key])) ||
    ['writer_fence_evidence_sha256','retirement_evidence_sha256','revocation_evidence_sha256',
     'nginx_evidence_sha256','smoke_evidence_sha256','cleanup_complete_evidence_sha256',
     'cleanup_complete_signature_sha256','lifecycle_key_retirement_evidence_sha256']
      .some(key => !hashOrPending(values[key])) ||
    ((values.cleanup_complete_evidence_sha256 === 'pending') !==
      (values.cleanup_complete_signature_sha256 === 'pending')) ||
    (values.phase !== 'complete' && values.cleanup_complete_evidence_sha256 !== 'pending') ||
    (values.phase !== 'complete' && values.lifecycle_key_retirement_evidence_sha256 !== 'pending') ||
    (values.phase !== 'verified' && values.writer_fence_evidence_sha256 === 'pending') ||
    (values.phase === 'complete' && ['retirement_evidence_sha256','revocation_evidence_sha256',
      'nginx_evidence_sha256','smoke_evidence_sha256','cleanup_complete_evidence_sha256',
      'cleanup_complete_signature_sha256'].some(key => values[key] === 'pending')) ||
    !canonicalSeconds(values.updated_at) || Date.parse(values.updated_at) < Date.parse(values.runtime_stable_since) ||
    !sha64.test(values.signature_hmac_sha256)) process.exit(1);
const body = `${lines.slice(0, -1).join('\n')}\n`;
const key = Buffer.from(fs.readFileSync(process.env.SIGNING_KEY_FILE, 'utf8').trim(), 'hex');
const actual = crypto.createHmac('sha256', key).update(body).digest();
const expected = Buffer.from(values.signature_hmac_sha256, 'hex');
if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) process.exit(1);
NODE
}

avatar_cleanup_transition_allowed() {
	case "$1:$2" in
	absent:verified | verified:verified | verified:forward-only | \
		forward-only:forward-only | forward-only:complete | complete:complete) return 0 ;;
	*) return 1 ;;
	esac
}

avatar_cleanup_write_marker() {
	[[ $# -eq 30 ]] || return 1
	local current='absent' temporary="${avatar_cleanup_marker}.tmp.$$" body_hmac
	local ownership_marker_sha current_runtime initial_client current_client identity_database_id
	local stability_generation stability_sha ledger_generation ledger_state ledger_sha
	local current_sha current_signature_sha client_binding_sha frontend_binding_sha runtime_stable_since
	if [[ -e "$avatar_cleanup_marker" || -L "$avatar_cleanup_marker" ]]; then
		avatar_cleanup_validate_marker || return 1
		current="$(avatar_cleanup_marker_value phase)"
		ownership_marker_sha="$(avatar_cleanup_marker_value ownership_marker_sha256)"
		current_runtime="$(avatar_cleanup_marker_value current_runtime_revision)"
		initial_client="$(avatar_cleanup_marker_value initial_client_revision)"
		current_client="$(avatar_cleanup_marker_value current_client_revision)"
		identity_database_id="$(avatar_cleanup_marker_value identity_database_id)"
		stability_generation="$(avatar_cleanup_marker_value runtime_stability_generation)"
		stability_sha="$(avatar_cleanup_marker_value runtime_stability_evidence_sha256)"
		ledger_generation="$(avatar_cleanup_marker_value runtime_stability_ledger_generation)"
		ledger_state="$(avatar_cleanup_marker_value runtime_stability_ledger_tail_state)"
		ledger_sha="$(avatar_cleanup_marker_value runtime_stability_ledger_tail_evidence_sha256)"
		current_sha="$(avatar_cleanup_marker_value runtime_stability_current_evidence_sha256)"
		current_signature_sha="$(avatar_cleanup_marker_value runtime_stability_current_signature_sha256)"
		client_binding_sha="$(avatar_cleanup_marker_value current_client_binding_evidence_sha256)"
		frontend_binding_sha="$(avatar_cleanup_marker_value frontend_binding_sha256)"
		runtime_stable_since="$(avatar_cleanup_marker_value runtime_stable_since)"
	else
		ownership_marker_sha="${avatar_cleanup_ownership_marker_sha:-}"
		current_runtime="${avatar_cleanup_runtime_revision:-}"
		initial_client="${avatar_cleanup_initial_client_revision:-}"
		current_client="${avatar_cleanup_current_client_revision:-}"
		identity_database_id="${avatar_cleanup_identity_database_id:-}"
		stability_generation="${avatar_cleanup_runtime_stability_generation:-}"
		stability_sha="${avatar_cleanup_runtime_stability_evidence_sha:-}"
		ledger_generation="${avatar_cleanup_runtime_stability_ledger_generation:-}"
		ledger_state="${avatar_cleanup_runtime_stability_ledger_state:-}"
		ledger_sha="${avatar_cleanup_runtime_stability_ledger_sha:-}"
		current_sha="${avatar_cleanup_runtime_stability_current_sha:-}"
		current_signature_sha="${avatar_cleanup_runtime_stability_current_signature_sha:-}"
		client_binding_sha="${avatar_cleanup_current_client_binding_sha:-}"
		frontend_binding_sha="${avatar_cleanup_frontend_binding_sha:-}"
		runtime_stable_since="${avatar_cleanup_runtime_stable_since:-}"
	fi
	avatar_cleanup_transition_allowed "$current" "$1" || return 1
	[[ "$2" == "$AVATAR_OWNERSHIP_REVISION" && "$4" == "$current_client" &&
		"$ownership_marker_sha" =~ ^[0-9a-f]{64}$ && "$current_runtime" =~ ^[0-9a-f]{40}$ &&
		"$initial_client" =~ ^[0-9a-f]{40}$ && "$current_client" =~ ^[0-9a-f]{40}$ &&
		"$identity_database_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
		"$stability_generation" =~ ^(0|[1-9]|[1-5][0-9]|6[0-4])$ &&
		"$stability_sha" =~ ^[0-9a-f]{64}$ &&
		"$ledger_generation" =~ ^(0|[1-9]|[1-5][0-9]|6[0-4])$ &&
		"$ledger_state" =~ ^(applied|adopted|aborted)$ && "$ledger_sha" =~ ^[0-9a-f]{64}$ &&
		"$current_sha" =~ ^[0-9a-f]{64}$ && "$current_signature_sha" =~ ^[0-9a-f]{64}$ &&
		"$client_binding_sha" =~ ^[0-9a-f]{64}$ && "$frontend_binding_sha" =~ ^[0-9a-f]{64}$ &&
		"$runtime_stable_since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
	if [[ "$ledger_state" == 'aborted' ]]; then
		[[ "$ledger_generation" -eq $((stability_generation + 1)) && "$ledger_sha" != "$stability_sha" ]] || return 1
	else
		[[ "$ledger_generation" == "$stability_generation" && "$ledger_sha" == "$stability_sha" ]] || return 1
	fi
	avatar_cleanup_create_signing_key || return 1
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	{
		printf 'version=1\nphase=%s\nownership_revision=%s\ncleanup_revision=%s\n' "$1" "$2" "$3"
		printf 'ownership_marker_sha256=%s\ncurrent_runtime_revision=%s\n' "$ownership_marker_sha" "$current_runtime"
		printf 'initial_client_revision=%s\ncurrent_client_revision=%s\nidentity_database_id=%s\n' \
			"$initial_client" "$current_client" "$identity_database_id"
		printf 'runtime_stability_generation=%s\nruntime_stability_evidence_sha256=%s\n' \
			"$stability_generation" "$stability_sha"
		printf 'runtime_stability_ledger_generation=%s\nruntime_stability_ledger_tail_state=%s\n' \
			"$ledger_generation" "$ledger_state"
		printf 'runtime_stability_ledger_tail_evidence_sha256=%s\n' "$ledger_sha"
		printf 'runtime_stability_current_evidence_sha256=%s\n' "$current_sha"
		printf 'runtime_stability_current_signature_sha256=%s\n' "$current_signature_sha"
		printf 'current_client_binding_evidence_sha256=%s\nfrontend_binding_sha256=%s\n' \
			"$client_binding_sha" "$frontend_binding_sha"
		printf 'runtime_stable_since=%s\n' "$runtime_stable_since"
		printf 'identity_api_image_id=%s\nidentity_worker_image_id=%s\nidentity_outbox_image_id=%s\n' "$5" "$6" "$7"
		printf 'core_source_image_id=%s\ncore_cleanup_image_id=%s\n' "$8" "$9"
		printf 'client_evidence_sha256=%s\n' "${10}"
		printf 'pre_client_reference_zero_evidence_sha256=%s\nclient_ready_evidence_sha256=%s\n' "${11}" "${12}"
		printf 'client_ready_signature_sha256=%s\npredeploy_uploads_handoff_sha256=%s\n' "${13}" "${14}"
		printf 'cleanup_retarget_evidence_sha256=%s\n' "${15}"
		printf 'runtime_evidence_sha256=%s\nmanifest_evidence_sha256=%s\n' "${16}" "${17}"
		printf 'reference_evidence_sha256=%s\nobservation_evidence_sha256=%s\n' "${18}" "${19}"
		printf 'identity_backup_sha256=%s\nidentity_restore_evidence_sha256=%s\n' "${20}" "${21}"
		printf 'writer_fence_evidence_sha256=%s\nretirement_evidence_sha256=%s\nrevocation_evidence_sha256=%s\n' "${22}" "${23}" "${24}"
		printf 'nginx_evidence_sha256=%s\nsmoke_evidence_sha256=%s\n' "${25}" "${26}"
		printf 'cleanup_complete_evidence_sha256=%s\ncleanup_complete_signature_sha256=%s\n' "${27}" "${28}"
		printf 'lifecycle_key_retirement_evidence_sha256=%s\n' "${29}"
		printf 'updated_at=%s\n' "${30}"
	} >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	body_hmac="$(avatar_cleanup_hmac "$temporary")"
	printf 'signature_hmac_sha256=%s\n' "$body_hmac" >>"$temporary"
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -f -- "$temporary" "$avatar_cleanup_marker" || return 1
	avatar_cleanup_fsync_file_and_parent "$avatar_cleanup_marker" || return 1
	avatar_cleanup_validate_marker
}

avatar_cleanup_validate_clean_source_tree_at_root() {
	[[ $# -eq 1 ]] || return 1
	local source_root="$1"
	[[ -d "$source_root" && ! -L "$source_root" &&
		! -e "$source_root/src/file" && ! -L "$source_root/src/file" ]] || return 1
	[[ -f "$source_root/src/app.module.ts" && -f "$source_root/deploy/nginx.conf" &&
		-f "$source_root/package.json" && -f "$source_root/pnpm-lock.yaml" &&
		-f "$source_root/Dockerfile" && -f "$source_root/docker-entrypoint.sh" &&
		-f "$source_root/deploy/docker-compose.prod.yml" &&
		-f "$source_root/scripts/cleanup-avatar-core-source-production.sh" &&
		-f "$source_root/scripts/test-avatar-core-source-cleanup-rehearsal.sh" ]] || return 1
	[[ -f "$source_root/src/health/health.service.ts" &&
		! -L "$source_root/src/health/health.service.ts" ]] || return 1
	! grep -Eq 'FileModule|FileController|@Controller\(['"'"']files['"'"']\)' "$source_root/src/app.module.ts" || return 1
	! grep -R -I -E \
		"File(Module|Controller|Service)|ServeStaticModule|@Controller\\([[:space:]]*['\"]files['\"]|from[[:space:]]+['\"][^'\"]*/file(/|['\"])|@aws-sdk/client-s3|/api/v1/files|S3_(ENDPOINT|REGION|BUCKET|BUCKET_NAME|ACCESS_KEY_ID|SECRET_ACCESS_KEY|PUBLIC_BASE_URL|KEY_PREFIX|FORCE_PATH_STYLE)|S3Client|s3Client|checkS3|PutObjectCommand|DeleteObjectCommand|HeadObjectCommand|ListObjectsV2Command|public/uploads|/app/uploads" \
		"$source_root/src" >/dev/null 2>&1 || return 1
	! grep -Eq 'location[[:space:]]+([=~*^ ]+[[:space:]]*)?/uploads/' "$source_root/deploy/nginx.conf" || return 1
	[[ "$(grep -Fxc $'\tinclude /etc/nginx/winwidget-identity-avatar-client-ready/*.conf;' \
		"$source_root/deploy/nginx.conf")" == '1' ]] || return 1
	! grep -Fq '@aws-sdk/client-s3' "$source_root/pnpm-lock.yaml" || return 1
	! grep -Eq 'mkdir[^#]*(uploads)|/app/uploads|public/uploads' \
		"$source_root/Dockerfile" "$source_root/docker-entrypoint.sh" "$source_root/.dockerignore" || return 1
	ROOT_PACKAGE="$source_root/package.json" COMPOSE_SOURCE="$source_root/deploy/docker-compose.prod.yml" \
		DOCKER_SOURCE="$source_root/Dockerfile" ENTRYPOINT_SOURCE="$source_root/docker-entrypoint.sh" node <<'NODE'
const fs = require('node:fs');
const rootPackage = JSON.parse(fs.readFileSync(process.env.ROOT_PACKAGE, 'utf8'));
const retired = ['@aws-sdk/client-s3','@nestjs/serve-static','app-root-path','fs-extra','@types/app-root-path','@types/fs-extra'];
if (['dependencies','devDependencies'].some(section => retired.some(name =>
  Object.prototype.hasOwnProperty.call(rootPackage[section] || {}, name)))) process.exit(1);
const compose = fs.readFileSync(process.env.COMPOSE_SOURCE, 'utf8');
const apiStart = compose.indexOf('x-api-env: &api-env\n');
const apiEnd = compose.indexOf('\nx-api-gateway-env:', apiStart);
if (apiStart < 0 || apiEnd <= apiStart || /(?:^|\n)  S3_[A-Z0-9_]+:/.test(compose.slice(apiStart, apiEnd)) ||
    compose.includes('/app/uploads')) process.exit(1);
if (fs.readFileSync(process.env.DOCKER_SOURCE, 'utf8').includes('/app/uploads') ||
    fs.readFileSync(process.env.ENTRYPOINT_SOURCE, 'utf8').includes('/app/uploads')) process.exit(1);
NODE
}

avatar_cleanup_validate_clean_source_tree() {
	avatar_cleanup_validate_clean_source_tree_at_root "$SERVER_ROOT"
}

avatar_cleanup_require_common() {
	avatar_cleanup_require_root
	[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ &&
		"$AVATAR_OWNERSHIP_REVISION" =~ ^[0-9a-f]{40}$ &&
		"$AVATAR_CLIENT_REVISION" =~ ^[0-9a-f]{40}$ &&
		"$EXPECTED_REVISION" != "$AVATAR_OWNERSHIP_REVISION" &&
		"$AVATAR_PUBLIC_ORIGIN" == 'https://winwidget.ru' &&
		"$AVATAR_API_ORIGIN" == 'https://api.winwidget.ru' ]] ||
		avatar_cleanup_fail 'exact cleanup, avatar-ownership and client revisions are required' || return 1
	identity_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION" || return 1
	git -C "$SERVER_ROOT" merge-base --is-ancestor "$AVATAR_OWNERSHIP_REVISION" "$EXPECTED_REVISION" ||
		avatar_cleanup_fail 'cleanup revision must descend from the exact avatar ownership revision' || return 1
	avatar_cleanup_validate_clean_source_tree ||
		avatar_cleanup_fail 'legacy Core file source/runtime contract was reintroduced' || return 1
	[[ -f "$SERVER_ROOT/apps/identity/prisma/migrations/$avatar_cleanup_avatar_migration/migration.sql" &&
		! -L "$SERVER_ROOT/apps/identity/prisma/migrations/$avatar_cleanup_avatar_migration/migration.sql" ]] ||
		avatar_cleanup_fail 'avatar ownership migration is absent' || return 1
	[[ ! -e "$SERVER_ROOT/src/file" &&
		! -L "$SERVER_ROOT/src/file" ]] ||
		avatar_cleanup_fail 'legacy Core file module still exists' || return 1
	! grep -Eq 'FileModule|FileController|@Controller\(['"'"']files['"'"']\)' "$SERVER_ROOT/src/app.module.ts" ||
		avatar_cleanup_fail 'legacy Core /files source remains wired' || return 1
	! grep -Eq 'location[[:space:]]+([=~*^ ]+[[:space:]]*)?/uploads/' "$SERVER_ROOT/deploy/nginx.conf" ||
		avatar_cleanup_fail 'legacy /uploads nginx route remains' || return 1
	[[ "$(grep -Fxc $'\tinclude /etc/nginx/winwidget-identity-avatar-client-ready/*.conf;' \
		"$SERVER_ROOT/deploy/nginx.conf")" == '1' ]] ||
		avatar_cleanup_fail 'Identity avatar attestation nginx include is absent or duplicated' || return 1
	ROOT_PACKAGE="$SERVER_ROOT/package.json" node <<'NODE' ||
const value = require(process.env.ROOT_PACKAGE);
for (const section of ['dependencies', 'devDependencies']) {
  if (Object.prototype.hasOwnProperty.call(value[section] || {}, '@aws-sdk/client-s3')) process.exit(1);
}
NODE
		avatar_cleanup_fail 'legacy Core S3 dependency remains' || return 1
	! grep -Fq '@aws-sdk/client-s3' "$SERVER_ROOT/pnpm-lock.yaml" ||
		avatar_cleanup_fail 'legacy Core S3 dependency remains in the root lockfile' || return 1
	! grep -Eq 'mkdir[^#]*(uploads)|/app/uploads|public/uploads' \
		"$SERVER_ROOT/Dockerfile" "$SERVER_ROOT/docker-entrypoint.sh" "$SERVER_ROOT/.dockerignore" ||
		avatar_cleanup_fail 'legacy Core uploads filesystem contract remains' || return 1
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		config --format json | node -e '
let value = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => value += chunk);
process.stdin.on("end", () => {
  const services = JSON.parse(value)?.services || {};
  const core = services.api?.environment || {};
  const api = services["identity-api"]?.environment || {};
  const worker = services["identity-worker"]?.environment || {};
  const publisher = services["identity-outbox-publisher"]?.environment || {};
  const widgets = services["widgets-service"]?.environment || {};
  const generic = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_BUCKET_NAME", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
    "S3_PUBLIC_BASE_URL", "S3_KEY_PREFIX", "S3_FORCE_PATH_STYLE"];
  const widgetsRequired = generic.filter(key => key !== "S3_BUCKET_NAME");
  const common = ["IDENTITY_AVATAR_S3_ENDPOINT", "IDENTITY_AVATAR_S3_REGION", "IDENTITY_AVATAR_S3_BUCKET",
    "IDENTITY_AVATAR_S3_KEY_PREFIX", "IDENTITY_AVATAR_S3_FORCE_PATH_STYLE"];
  const apiOnly = ["IDENTITY_AVATAR_S3_PUBLIC_BASE_URL", "IDENTITY_AVATAR_S3_API_ACCESS_KEY_ID",
    "IDENTITY_AVATAR_S3_API_SECRET_ACCESS_KEY"];
  const workerOnly = ["IDENTITY_AVATAR_S3_WORKER_ACCESS_KEY_ID", "IDENTITY_AVATAR_S3_WORKER_SECRET_ACCESS_KEY"];
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const migrationPresent = object => Object.keys(object).some(key => key.startsWith("IDENTITY_AVATAR_MIGRATION_"));
  if (generic.some(key => has(core, key)) || [...common,...apiOnly,...workerOnly].some(key => has(core, key)) ||
      common.some(key => !has(api, key) || !has(worker, key)) || apiOnly.some(key => !has(api, key)) ||
      workerOnly.some(key => has(api, key)) || workerOnly.some(key => !has(worker, key)) || apiOnly.some(key => has(worker, key)) ||
      generic.some(key => has(api, key) || has(worker, key) || has(publisher, key)) ||
      [...common,...apiOnly,...workerOnly].some(key => has(publisher, key) || has(widgets, key)) ||
      widgetsRequired.some(key => !has(widgets, key)) || has(widgets, "S3_BUCKET_NAME") ||
      [core,api,worker,publisher,widgets].some(migrationPresent) ||
      api.IDENTITY_AVATAR_S3_KEY_PREFIX !== "identity/avatars" || worker.IDENTITY_AVATAR_S3_KEY_PREFIX !== "identity/avatars" ||
      api.IDENTITY_AVATAR_S3_ENDPOINT !== worker.IDENTITY_AVATAR_S3_ENDPOINT || api.IDENTITY_AVATAR_S3_ENDPOINT !== widgets.S3_ENDPOINT ||
      api.IDENTITY_AVATAR_S3_REGION !== worker.IDENTITY_AVATAR_S3_REGION || api.IDENTITY_AVATAR_S3_REGION !== widgets.S3_REGION ||
      api.IDENTITY_AVATAR_S3_BUCKET !== worker.IDENTITY_AVATAR_S3_BUCKET || api.IDENTITY_AVATAR_S3_BUCKET !== widgets.S3_BUCKET ||
      api.IDENTITY_AVATAR_S3_FORCE_PATH_STYLE !== worker.IDENTITY_AVATAR_S3_FORCE_PATH_STYLE ||
      api.IDENTITY_AVATAR_S3_FORCE_PATH_STYLE !== widgets.S3_FORCE_PATH_STYLE ||
      api.IDENTITY_AVATAR_S3_API_ACCESS_KEY_ID === worker.IDENTITY_AVATAR_S3_WORKER_ACCESS_KEY_ID ||
      api.IDENTITY_AVATAR_S3_API_ACCESS_KEY_ID === widgets.S3_ACCESS_KEY_ID ||
      worker.IDENTITY_AVATAR_S3_WORKER_ACCESS_KEY_ID === widgets.S3_ACCESS_KEY_ID ||
      api.IDENTITY_AVATAR_S3_API_SECRET_ACCESS_KEY === worker.IDENTITY_AVATAR_S3_WORKER_SECRET_ACCESS_KEY ||
      api.IDENTITY_AVATAR_S3_API_SECRET_ACCESS_KEY === widgets.S3_SECRET_ACCESS_KEY ||
      worker.IDENTITY_AVATAR_S3_WORKER_SECRET_ACCESS_KEY === widgets.S3_SECRET_ACCESS_KEY) process.exit(1);
});
' || avatar_cleanup_fail 'Core/Identity S3 credential boundary is invalid' || return 1
	[[ -f "$SERVER_ROOT/apps/identity/src/users/users.controller.ts" &&
		-f "$SERVER_ROOT/apps/identity/src/avatar/avatar.service.ts" &&
		-f "$SERVER_ROOT/apps/identity/src/avatar/avatar-storage.service.ts" ]] ||
		avatar_cleanup_fail 'Identity avatar ownership implementation is incomplete' || return 1
	grep -Fq "@Post('profile/avatar')" "$SERVER_ROOT/apps/identity/src/users/users.controller.ts" &&
		grep -Fq "@Delete('profile/avatar')" "$SERVER_ROOT/apps/identity/src/users/users.controller.ts" ||
		avatar_cleanup_fail 'profile avatar endpoint is absent' || return 1
	grep -Fq "@Post('user/:id/avatar')" "$SERVER_ROOT/apps/identity/src/users/users.controller.ts" &&
		grep -Fq "@Delete('user/:id/avatar')" "$SERVER_ROOT/apps/identity/src/users/users.controller.ts" ||
		avatar_cleanup_fail 'admin avatar endpoint is absent' || return 1
	[[ -f "$SERVER_ROOT/apps/identity/src/avatar/avatar-media-cutover-main.ts" &&
		-f "$SERVER_ROOT/scripts/identity-avatar-media-production.sh" ]] ||
		avatar_cleanup_fail 'avatar migration lifecycle is absent' || return 1
	[[ -f "$identity_cleanup_marker" && ! -L "$identity_cleanup_marker" ]] ||
		avatar_cleanup_fail 'Identity Core cleanup must be completed first' || return 1
	identity_cleanup_validate_marker ||
		avatar_cleanup_fail 'Identity Core cleanup marker is invalid' || return 1
	[[ "$(identity_cleanup_marker_value phase)" == 'complete' ]] ||
		avatar_cleanup_fail 'Identity Core cleanup is not complete' || return 1
	[[ "$(identity_database_current_phase)" == 'complete' ]] ||
		avatar_cleanup_fail 'Identity database lifecycle is not complete' || return 1
	avatar_cleanup_require_artifact_root
	avatar_cleanup_create_signing_key
}

avatar_cleanup_inspect_service() {
	[[ $# -eq 2 && "$2" =~ ^[0-9a-f]{40}$ ]] || return 1
	local service="$1" revision="$2" container image image_revision restart health started_at
	container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q "$service")" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ ]] ||
		avatar_cleanup_fail "$service must have exactly one running container" || return 1
	image="$(docker inspect --format '{{.Image}}' "$container")" || return 1
	image_revision="$(docker image inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' "$image")" || return 1
	restart="$(docker inspect --format '{{.RestartCount}}' "$container")" || return 1
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" || return 1
	started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container")" || return 1
	[[ "$image" =~ ^sha256:[0-9a-f]{64}$ && "$image_revision" == "$revision" &&
		"$restart" == '0' && "$health" == 'healthy' && "$started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] ||
		avatar_cleanup_fail "$service is not the exact healthy zero-restart revision $revision" || return 1
	avatar_cleanup_last_container_id="$container"
	avatar_cleanup_last_image_id="$image"
	avatar_cleanup_last_started_at="$started_at"
	avatar_cleanup_last_restart_count="$restart"
	avatar_cleanup_last_health="$health"
	avatar_cleanup_last_oci_revision="$image_revision"
}

avatar_cleanup_build_candidate() {
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" build api
	local expected_image="winwidget-api:git-$EXPECTED_REVISION" image_id revision
	image_id="$(docker image inspect --format '{{.Id}}' "$expected_image")" || return 1
	revision="$(docker image inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' "$image_id")" || return 1
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ && "$revision" == "$EXPECTED_REVISION" ]] ||
		avatar_cleanup_fail 'cleanup Core image is not bound to the exact cleanup revision' || return 1
	avatar_cleanup_candidate_image_id="$image_id"
}

avatar_cleanup_capture_runtime_evidence() {
	avatar_cleanup_require_ownership_artifacts || return 1
	local runtime_revision="$avatar_cleanup_runtime_revision"
	avatar_cleanup_inspect_service identity-api "$runtime_revision"
	avatar_cleanup_identity_api_container_id="$avatar_cleanup_last_container_id"
	avatar_cleanup_identity_api_image_id="$avatar_cleanup_last_image_id"
	avatar_cleanup_identity_api_started_at="$avatar_cleanup_last_started_at"
	avatar_cleanup_inspect_service identity-worker "$runtime_revision"
	avatar_cleanup_identity_worker_container_id="$avatar_cleanup_last_container_id"
	avatar_cleanup_identity_worker_image_id="$avatar_cleanup_last_image_id"
	avatar_cleanup_identity_worker_started_at="$avatar_cleanup_last_started_at"
	avatar_cleanup_inspect_service identity-outbox-publisher "$runtime_revision"
	avatar_cleanup_identity_outbox_container_id="$avatar_cleanup_last_container_id"
	avatar_cleanup_identity_outbox_image_id="$avatar_cleanup_last_image_id"
	avatar_cleanup_identity_outbox_started_at="$avatar_cleanup_last_started_at"
	avatar_cleanup_inspect_service api "$runtime_revision"
	avatar_cleanup_core_container_id="$avatar_cleanup_last_container_id"
	avatar_cleanup_core_source_image_id="$avatar_cleanup_last_image_id"
	avatar_cleanup_core_started_at="$avatar_cleanup_last_started_at"
	avatar_cleanup_inspect_service widgets-service "$runtime_revision"
	avatar_cleanup_widgets_container_id="$avatar_cleanup_last_container_id"
	avatar_cleanup_widgets_image_id="$avatar_cleanup_last_image_id"
	avatar_cleanup_widgets_started_at="$avatar_cleanup_last_started_at"
	avatar_cleanup_build_candidate
	local temporary="$avatar_cleanup_root/.runtime.$$"
	RUNTIME_OUTPUT="$temporary" OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" \
		CURRENT_RUNTIME_REVISION="$runtime_revision" \
		CLEANUP_REVISION="$EXPECTED_REVISION" \
		IDENTITY_API_CONTAINER="$avatar_cleanup_identity_api_container_id" \
		IDENTITY_API_IMAGE="$avatar_cleanup_identity_api_image_id" \
		IDENTITY_API_STARTED_AT="$avatar_cleanup_identity_api_started_at" \
		IDENTITY_WORKER_CONTAINER="$avatar_cleanup_identity_worker_container_id" \
		IDENTITY_WORKER_IMAGE="$avatar_cleanup_identity_worker_image_id" \
		IDENTITY_WORKER_STARTED_AT="$avatar_cleanup_identity_worker_started_at" \
		IDENTITY_OUTBOX_CONTAINER="$avatar_cleanup_identity_outbox_container_id" \
		IDENTITY_OUTBOX_IMAGE="$avatar_cleanup_identity_outbox_image_id" \
		IDENTITY_OUTBOX_STARTED_AT="$avatar_cleanup_identity_outbox_started_at" \
		CORE_CONTAINER="$avatar_cleanup_core_container_id" \
		CORE_SOURCE_IMAGE="$avatar_cleanup_core_source_image_id" \
		CORE_STARTED_AT="$avatar_cleanup_core_started_at" \
		WIDGETS_CONTAINER="$avatar_cleanup_widgets_container_id" \
		WIDGETS_IMAGE="$avatar_cleanup_widgets_image_id" \
		WIDGETS_STARTED_AT="$avatar_cleanup_widgets_started_at" \
		CORE_CLEANUP_IMAGE="$avatar_cleanup_candidate_image_id" node <<'NODE'
const fs = require('node:fs');
const evidence = {
  version: 1,
  action: 'avatar-core-source-runtime-verification',
  ownershipRevision: process.env.OWNERSHIP_REVISION,
  currentRuntimeRevision: process.env.CURRENT_RUNTIME_REVISION,
  cleanupRevision: process.env.CLEANUP_REVISION,
  services: {
    identityApi: { containerId: process.env.IDENTITY_API_CONTAINER, imageId: process.env.IDENTITY_API_IMAGE,
      ociRevision: process.env.CURRENT_RUNTIME_REVISION, startedAt: process.env.IDENTITY_API_STARTED_AT,
      restartCount: 0, health: 'healthy' },
    identityWorker: { containerId: process.env.IDENTITY_WORKER_CONTAINER, imageId: process.env.IDENTITY_WORKER_IMAGE,
      ociRevision: process.env.CURRENT_RUNTIME_REVISION, startedAt: process.env.IDENTITY_WORKER_STARTED_AT,
      restartCount: 0, health: 'healthy' },
    identityOutboxPublisher: { containerId: process.env.IDENTITY_OUTBOX_CONTAINER, imageId: process.env.IDENTITY_OUTBOX_IMAGE,
      ociRevision: process.env.CURRENT_RUNTIME_REVISION, startedAt: process.env.IDENTITY_OUTBOX_STARTED_AT,
      restartCount: 0, health: 'healthy' },
    coreSourceApi: { containerId: process.env.CORE_CONTAINER, imageId: process.env.CORE_SOURCE_IMAGE,
      ociRevision: process.env.CURRENT_RUNTIME_REVISION, startedAt: process.env.CORE_STARTED_AT,
      restartCount: 0, health: 'healthy' },
    widgets: { containerId: process.env.WIDGETS_CONTAINER, imageId: process.env.WIDGETS_IMAGE,
      ociRevision: process.env.CURRENT_RUNTIME_REVISION, startedAt: process.env.WIDGETS_STARTED_AT,
      restartCount: 0, health: 'healthy' },
  },
  candidateCoreImageId: process.env.CORE_CLEANUP_IMAGE,
  verifiedAt: new Date().toISOString(),
};
fs.writeFileSync(process.env.RUNTIME_OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -f -- "$temporary" "$avatar_cleanup_runtime" || return 1
	avatar_cleanup_fsync_file_and_parent "$avatar_cleanup_runtime" || return 1
	avatar_cleanup_sign_artifact "$avatar_cleanup_runtime"
}

avatar_cleanup_current_client_binding() (
	avatar_cleanup_require_ownership_artifacts || return 1
	[[ -n "${avatar_cleanup_frontend_binding:-}" ]] || return 1
	printf '%s' "$avatar_cleanup_frontend_binding"
)

avatar_cleanup_capture_client_evidence() {
	avatar_cleanup_require_ownership_artifacts || return 1
	local temporary_root release_url signature_url runtime_url release_status signature_status runtime_status evidence_file
	local current_binding
	current_binding="$(avatar_cleanup_current_client_binding)" || return 1
	temporary_root="$(mktemp -d "$avatar_cleanup_root/.client.XXXXXX")" || return 1
	chmod 700 "$temporary_root" || return 1
	chown 0:0 "$temporary_root" || return 1
	trap 'rm -rf -- "$temporary_root"' RETURN
	evidence_file="$temporary_root/evidence.json"
	release_url="$AVATAR_PUBLIC_ORIGIN/.well-known/winwidget/identity-avatar-client/$AVATAR_CLIENT_REVISION/release-evidence-v1.json"
	signature_url="${release_url}.sig"
	runtime_url="$AVATAR_PUBLIC_ORIGIN/.well-known/winwidget/identity-avatar-client/runtime-v1.json"
	release_status="$(curl --proto '=https' --tlsv1.2 --silent --show-error --connect-timeout 3 --max-time 30 \
		--dump-header "$temporary_root/release.headers" --output "$temporary_root/release.json" \
		--write-out '%{http_code}' "$release_url")" || return 1
	signature_status="$(curl --proto '=https' --tlsv1.2 --silent --show-error --connect-timeout 3 --max-time 30 \
		--dump-header "$temporary_root/signature.headers" --output "$temporary_root/release.json.sig" \
		--write-out '%{http_code}' "$signature_url")" || return 1
	runtime_status="$(curl --proto '=https' --tlsv1.2 --silent --show-error --connect-timeout 3 --max-time 30 \
		--dump-header "$temporary_root/runtime.headers" --output "$temporary_root/runtime.json" \
		--write-out '%{http_code}' "$runtime_url")" || return 1
	[[ "$release_status" == '200' && "$signature_status" == '200' && "$runtime_status" == '200' ]] ||
		avatar_cleanup_fail 'frontend release/runtime evidence endpoints must return exact 200 without redirects' || return 1
	CLIENT_ROOT="$temporary_root" CLIENT_REVISION="$AVATAR_CLIENT_REVISION" PUBLIC_ORIGIN="$AVATAR_PUBLIC_ORIGIN" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" OWNERSHIP_CLIENT="$avatar_cleanup_ownership_client_evidence" \
		CURRENT_CLIENT_BINDING="$current_binding" CURRENT_CLIENT_BINDING_SHA="$avatar_cleanup_current_client_binding_sha" \
		FRONTEND_BINDING_SHA="$avatar_cleanup_frontend_binding_sha" \
		CLIENT_PUBLIC_KEY="$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY" EVIDENCE_OUTPUT="$evidence_file" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const root = process.env.CLIENT_ROOT;
const releaseBytes = fs.readFileSync(`${root}/release.json`);
const signatureBytes = fs.readFileSync(`${root}/release.json.sig`);
const runtimeBytes = fs.readFileSync(`${root}/runtime.json`);
if (releaseBytes.length < 2 || releaseBytes.length > 64 * 1024 || signatureBytes.length < 2 ||
    signatureBytes.length > 256 || runtimeBytes.length < 2 || runtimeBytes.length > 65536) process.exit(1);
const decodeUtf8 = bytes => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { process.exit(1); }
};
const signatureText = decodeUtf8(signatureBytes);
if (!/^[A-Za-z0-9+/]+={0,2}\n$/.test(signatureText)) process.exit(1);
const signature = Buffer.from(signatureText.trim(), 'base64');
let clientKey;
try { clientKey = crypto.createPublicKey(fs.readFileSync(process.env.CLIENT_PUBLIC_KEY)); } catch { process.exit(1); }
if (clientKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64 ||
    !crypto.verify(null, releaseBytes, clientKey, signature)) process.exit(1);
let release;
let runtime;
let ownership;
let binding;
let releaseText;
let runtimeText;
try {
  releaseText = decodeUtf8(releaseBytes);
  runtimeText = decodeUtf8(runtimeBytes);
  release = JSON.parse(releaseText);
  runtime = JSON.parse(runtimeText);
  ownership = JSON.parse(decodeUtf8(fs.readFileSync(process.env.OWNERSHIP_CLIENT)));
  binding = JSON.parse(process.env.CURRENT_CLIENT_BINDING);
} catch { process.exit(1); }
const releaseKeys = ['schemaVersion','kind','clientRevision','nextBuildId','scanRoots','fileCount',
  'totalBytes','treeSha256','checks','fullManifestSha256','generatedAt'];
const runtimeKeys = ['schemaVersion','kind','clientRevision','processStartedAt','releaseEvidenceSha256',
  'releaseEvidenceSignatureSha256'];
const scanRoots = ['.next/server','.next/standalone','.next/static'];
const checks = ['full-next-server-tree-scanned','full-next-standalone-tree-scanned','full-next-static-tree-scanned',
  'legacy-api-v1-files-absent','legacy-uploads-absent','migration-credential-identifiers-absent',
  'identity-profile-avatar-api-present','identity-admin-avatar-api-present'];
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const bindingKeys = ['bindingKind','evidenceSha256','evidenceSignatureSha256','clientRevision','imageId',
  'releaseEvidenceSha256','releaseEvidenceSignatureSha256','releaseTreeSha256',
  'releaseFullManifestSha256','processStartedAt'];
const strictUtc = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
if (releaseText !== JSON.stringify(release) || runtimeText !== JSON.stringify(runtime) ||
    !exactKeys(binding, bindingKeys) ||
    !['initial-client-switch','client-code-retarget','frontend-runtime-rebind'].includes(binding.bindingKind) ||
    !sha(binding.evidenceSha256) || !sha(binding.evidenceSignatureSha256) ||
    binding.clientRevision !== process.env.CLIENT_REVISION || !/^sha256:[0-9a-f]{64}$/.test(binding.imageId || '') ||
    ![binding.releaseEvidenceSha256,binding.releaseEvidenceSignatureSha256,binding.releaseTreeSha256,
      binding.releaseFullManifestSha256,process.env.CURRENT_CLIENT_BINDING_SHA,process.env.FRONTEND_BINDING_SHA].every(sha) ||
    crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex') !== process.env.FRONTEND_BINDING_SHA ||
    !strictUtc(binding.processStartedAt) ||
    !exactKeys(release, releaseKeys) || release.schemaVersion !== 1 || release.kind !== 'identity-avatar-client-release' ||
    release.clientRevision !== process.env.CLIENT_REVISION || typeof release.nextBuildId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(release.nextBuildId) || JSON.stringify(release.scanRoots) !== JSON.stringify(scanRoots) ||
    !Number.isSafeInteger(release.fileCount) || release.fileCount < 1 || release.fileCount > 20000 ||
    !Number.isSafeInteger(release.totalBytes) || release.totalBytes < 1 ||
    release.totalBytes > 512 * 1024 * 1024 || !sha(release.treeSha256) || !sha(release.fullManifestSha256) ||
    JSON.stringify(release.checks) !== JSON.stringify(checks) || !strictUtc(release.generatedAt) ||
    Date.parse(release.generatedAt) > Date.now() + 300000) process.exit(1);
const releaseSha = crypto.createHash('sha256').update(releaseBytes).digest('hex');
const signatureSha = crypto.createHash('sha256').update(signatureBytes).digest('hex');
if (!exactKeys(runtime, runtimeKeys) || runtime.schemaVersion !== 1 || runtime.kind !== 'identity-avatar-client-runtime' ||
    runtime.clientRevision !== process.env.CLIENT_REVISION || !strictUtc(runtime.processStartedAt) ||
    Date.parse(runtime.processStartedAt) > Date.now() + 300000 || runtime.releaseEvidenceSha256 !== releaseSha ||
    runtime.releaseEvidenceSignatureSha256 !== signatureSha || binding.releaseEvidenceSha256 !== releaseSha ||
    binding.releaseEvidenceSignatureSha256 !== signatureSha || binding.releaseTreeSha256 !== release.treeSha256 ||
    binding.releaseFullManifestSha256 !== release.fullManifestSha256 ||
    binding.processStartedAt !== runtime.processStartedAt) process.exit(1);
const parseHeaders = (name, expectedContentType) => {
  const raw = fs.readFileSync(`${root}/${name}.headers`, 'utf8').replace(/\r/g, '');
  const blocks = raw.split('\n\n').filter(block => /^HTTP\//.test(block));
  if (blocks.length !== 1 || !/^HTTP\/\S+ 200(?: |$)/.test(blocks[0].split('\n')[0])) process.exit(1);
  const values = new Map();
  for (const line of blocks[0].split('\n').slice(1)) {
    const at = line.indexOf(':');
    if (at < 1) continue;
    const key = line.slice(0, at).toLowerCase();
    const items = values.get(key) || [];
    items.push(line.slice(at + 1).trim());
    values.set(key, items);
  }
  if (values.get('x-winwidget-revision')?.length !== 1 || values.get('x-winwidget-revision')[0] !== process.env.CLIENT_REVISION ||
      values.get('cache-control')?.length !== 1 || !values.get('cache-control')[0].toLowerCase().split(',').map(item => item.trim()).includes('no-store')) process.exit(1);
  if (expectedContentType && (values.get('content-type')?.length !== 1 ||
      values.get('content-type')[0].split(';')[0].trim().toLowerCase() !== expectedContentType)) process.exit(1);
  return crypto.createHash('sha256').update(raw).digest('hex');
};
const releaseHeadersSha256 = parseHeaders('release', 'application/json');
const signatureHeadersSha256 = parseHeaders('signature', 'application/octet-stream');
const runtimeHeadersSha256 = parseHeaders('runtime', 'application/json');
const evidence = {
  version: 1, action: 'avatar-client-cross-host-release-contract',
  ownershipRevision: process.env.OWNERSHIP_REVISION, clientRevision: process.env.CLIENT_REVISION,
  ownershipClientEvidenceSha256: crypto.createHash('sha256').update(fs.readFileSync(process.env.OWNERSHIP_CLIENT)).digest('hex'),
  currentClientBindingEvidenceSha256: process.env.CURRENT_CLIENT_BINDING_SHA,
  currentClientBindingKind: binding.bindingKind,
  frontendBindingSha256: process.env.FRONTEND_BINDING_SHA, frontendBinding: binding,
  releaseEvidenceUrl: `${process.env.PUBLIC_ORIGIN}/.well-known/winwidget/identity-avatar-client/${process.env.CLIENT_REVISION}/release-evidence-v1.json`,
  releaseEvidenceSha256: releaseSha, releaseEvidenceSignatureSha256: signatureSha,
  clientSigningPublicKeySha256: crypto.createHash('sha256').update(fs.readFileSync(process.env.CLIENT_PUBLIC_KEY)).digest('hex'),
  releaseTreeSha256: release.treeSha256, releaseFullManifestSha256: release.fullManifestSha256,
  releaseFileCount: release.fileCount, releaseTotalBytes: release.totalBytes,
  runtimeHealthUrl: `${process.env.PUBLIC_ORIGIN}/.well-known/winwidget/identity-avatar-client/runtime-v1.json`,
  clientProcessStartedAt: runtime.processStartedAt, releaseHeadersSha256, signatureHeadersSha256, runtimeHeadersSha256,
  exhaustiveBuildManifestPassed: true, detachedSignaturePassed: true, liveRuntimeBindingPassed: true,
  verifiedAt: new Date().toISOString(),
};
fs.writeFileSync(process.env.EVIDENCE_OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	avatar_cleanup_write_json_artifact "$avatar_cleanup_client" "$evidence_file" || return 1
	rm -rf -- "$temporary_root" || return 1
	trap - RETURN
}

avatar_cleanup_validate_ownership_marker() {
	local marker="${IDENTITY_AVATAR_MARKER:-$APP_ROOT/deploy/backend/.identity-avatar-media-v1}"
	local public_key="${IDENTITY_AVATAR_SIGNING_PUBLIC_KEY:-$APP_ROOT/deploy/backend/.identity-avatar-media-signing.public.pem}"
	avatar_cleanup_validate_private_file "$marker" || return 1
	avatar_cleanup_validate_private_file "$public_key" || return 1
	OWNERSHIP_MARKER="$marker" OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" \
		CURRENT_CLIENT_REVISION="$AVATAR_CLIENT_REVISION" OWNERSHIP_PUBLIC_KEY="$public_key" node <<'NODE' || return 1
const fs = require('node:fs');
const { createPublicKey, verify } = require('node:crypto');
const body = fs.readFileSync(process.env.OWNERSHIP_MARKER, 'utf8');
const lines = body.split('\n');
if (lines.at(-1) !== '' || lines.length !== 28) process.exit(1);
lines.pop();
const expected = ['version','phase','server_revision','runtime_revision','client_revision','current_client_revision',
  'runtime_stability_generation','runtime_stability_evidence_sha256','writer_fence_evidence_sha256',
  'storage_policy_evidence_sha256','uploads_snapshot_evidence_sha256','inventory_manifest_sha256',
  'migration_manifest_sha256','status_manifest_sha256','revocation_evidence_sha256',
  'authenticated_smoke_evidence_sha256','client_evidence_sha256','soak_evidence_sha256',
  'runtime_retarget_evidence_sha256','client_retarget_evidence_sha256','cleanup_retarget_evidence_sha256',
  'migration_ready_at','migrated_at','client_switched_at','soak_verified_at','updated_at','signature'];
const entries = lines.map(line => {
  const at = line.indexOf('=');
  if (at < 1) process.exit(1);
  return [line.slice(0, at), line.slice(at + 1)];
});
if (entries.length !== expected.length || entries.some(([key], index) => key !== expected[index])) process.exit(1);
const value = Object.fromEntries(entries);
const revision = /^[0-9a-f]{40}$/;
const sha = /^[0-9a-f]{64}$/;
const timestamp = item => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(item) &&
  Number.isFinite(Date.parse(item)) && new Date(Date.parse(item)).toISOString().replace('.000Z','Z') === item;
const exactHashes = ['writer_fence_evidence_sha256','storage_policy_evidence_sha256',
  'uploads_snapshot_evidence_sha256','inventory_manifest_sha256','migration_manifest_sha256',
  'status_manifest_sha256','revocation_evidence_sha256','authenticated_smoke_evidence_sha256',
  'client_evidence_sha256','soak_evidence_sha256','cleanup_retarget_evidence_sha256',
  'runtime_stability_evidence_sha256'];
if (value.version !== '3' || value.phase !== 'soak-complete' ||
    value.server_revision !== process.env.OWNERSHIP_REVISION || !revision.test(value.runtime_revision) ||
    !revision.test(value.client_revision) || value.current_client_revision !== process.env.CURRENT_CLIENT_REVISION ||
    !/^(0|[1-9]|[1-5][0-9]|6[0-4])$/.test(value.runtime_stability_generation) ||
    exactHashes.some(key => !sha.test(value[key])) ||
    !/^(pending|[0-9a-f]{64})$/.test(value.runtime_retarget_evidence_sha256) ||
    !/^(pending|[0-9a-f]{64})$/.test(value.client_retarget_evidence_sha256) ||
    (value.runtime_revision !== value.server_revision && !sha.test(value.runtime_retarget_evidence_sha256)) ||
    (value.current_client_revision !== value.client_revision && !sha.test(value.client_retarget_evidence_sha256)) ||
    ['migration_ready_at','migrated_at','client_switched_at','soak_verified_at','updated_at']
      .some(key => !timestamp(value[key])) ||
    !(Date.parse(value.migration_ready_at) <= Date.parse(value.migrated_at) &&
      Date.parse(value.migrated_at) <= Date.parse(value.client_switched_at) &&
      Date.parse(value.client_switched_at) <= Date.parse(value.soak_verified_at) &&
      Date.parse(value.soak_verified_at) <= Date.parse(value.updated_at)) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.signature)) process.exit(1);
let key;
try { key = createPublicKey(fs.readFileSync(process.env.OWNERSHIP_PUBLIC_KEY)); } catch { process.exit(1); }
const signature = Buffer.from(value.signature, 'base64');
const payload = `${lines.slice(0, -1).join('\n')}\n`;
if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 ||
    !verify(null, Buffer.from(payload), key, signature)) process.exit(1);
NODE
	avatar_cleanup_ownership_marker="$marker"
	avatar_cleanup_ownership_public_key="$public_key"
}

avatar_cleanup_ownership_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z0-9_]+$ ]] || return 1
	avatar_cleanup_validate_ownership_marker || return 1
	awk -F= -v key="$1" '$1 == key { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }' \
		"$avatar_cleanup_ownership_marker"
}

avatar_cleanup_materialize_lifecycle_validator() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
	local revision="$1" root path blob destination
	root="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-lifecycle-validator.XXXXXX")" || return 1
	chmod 700 "$root" || return 1
	mkdir -m 700 "$root/scripts" || return 1
	for path in scripts/identity-avatar-media-production.sh \
		scripts/identity-release-identity.sh scripts/production-deploy-lock.sh; do
		blob="$(git -C "$SERVER_ROOT" rev-parse "$revision:$path")" || return 1
		[[ "$blob" =~ ^[0-9a-f]{40,64}$ ]] || return 1
		destination="$root/$path"
		git -C "$SERVER_ROOT" cat-file blob "$blob" >"$destination" || return 1
		chmod 600 "$destination" || return 1
		[[ "$(git -C "$SERVER_ROOT" hash-object "$destination")" == "$blob" ]] || return 1
	done
	printf '%s\n' "$root"
}

avatar_cleanup_compute_ownership_context() (
	[[ $# -eq 1 && "$1" =~ ^(terminal-live|historical-finalized)$ &&
		"$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ &&
		"$AVATAR_OWNERSHIP_REVISION" =~ ^[0-9a-f]{40}$ &&
		"$AVATAR_CLIENT_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
	local validation_mode="$1" cleanup_revision="$EXPECTED_REVISION"
	local lifecycle_script validator_root='' tracked_blob actual_blob chain current_validation actual_server_root
	local owner runtime initial current generation terminal_sha current_body_sha current_signature_sha
	local archive_paths archive_body archive_signature frontend_binding
	avatar_cleanup_validate_ownership_marker || return 1
	owner="$(avatar_cleanup_ownership_marker_value server_revision)" || return 1
	runtime="$(avatar_cleanup_ownership_marker_value runtime_revision)" || return 1
	initial="$(avatar_cleanup_ownership_marker_value client_revision)" || return 1
	current="$(avatar_cleanup_ownership_marker_value current_client_revision)" || return 1
	generation="$(avatar_cleanup_ownership_marker_value runtime_stability_generation)" || return 1
	terminal_sha="$(avatar_cleanup_ownership_marker_value runtime_stability_evidence_sha256)" || return 1
	[[ "$owner" == "$AVATAR_OWNERSHIP_REVISION" && "$current" == "$AVATAR_CLIENT_REVISION" ]] || return 1
	if [[ "$validation_mode" == 'terminal-live' ]]; then
		lifecycle_script="$SERVER_ROOT/scripts/identity-avatar-media-production.sh"
		[[ -f "$lifecycle_script" && ! -L "$lifecycle_script" ]] || return 1
		tracked_blob="$(git -C "$SERVER_ROOT" rev-parse \
			"$cleanup_revision:scripts/identity-avatar-media-production.sh")" || return 1
		actual_blob="$(git -C "$SERVER_ROOT" hash-object "$lifecycle_script")" || return 1
		[[ "$actual_blob" == "$tracked_blob" ]] || return 1
	else
		validator_root="$(avatar_cleanup_materialize_lifecycle_validator "$cleanup_revision")" || return 1
		trap 'rm -rf -- "${validator_root:-}"' EXIT
		lifecycle_script="$validator_root/scripts/identity-avatar-media-production.sh"
	fi
	EXPECTED_REVISION="$runtime"
	IDENTITY_AVATAR_ARTIFACT_ROOT="${IDENTITY_AVATAR_ARTIFACT_ROOT:-$APP_ROOT/deploy/backend/identity-avatar-media-artifacts}"
	IDENTITY_AVATAR_MARKER="${IDENTITY_AVATAR_MARKER:-$APP_ROOT/deploy/backend/.identity-avatar-media-v1}"
	IDENTITY_AVATAR_SIGNING_PUBLIC_KEY="$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY"
	IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY="$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY"
	actual_server_root="$SERVER_ROOT"
	if [[ "$validation_mode" == 'historical-finalized' ]]; then
		SERVER_ROOT="$validator_root"
	fi
	# shellcheck source=scripts/identity-avatar-media-production.sh
	source "$lifecycle_script"
	SERVER_ROOT="$actual_server_root"
	identity_avatar_validate_marker || return 1
	identity_avatar_configure_revision_paths "$owner" "$runtime" "$initial" "$current" \
		"$generation" "$terminal_sha" || return 1
	if [[ "$validation_mode" == 'terminal-live' ]]; then
		chain="$(identity_avatar_validate_runtime_stability_chain terminal-live)" || return 1
	else
		chain="$(identity_avatar_validate_runtime_stability_chain bound)" || return 1
	fi
	IDENTITY_AVATAR_CLEANUP_CHAIN="$chain" IDENTITY_AVATAR_OWNER="$owner" \
		IDENTITY_AVATAR_RUNTIME="$runtime" IDENTITY_AVATAR_INITIAL_CLIENT="$initial" \
		IDENTITY_AVATAR_CURRENT_CLIENT="$current" IDENTITY_AVATAR_GENERATION="$generation" \
		IDENTITY_AVATAR_TERMINAL_SHA="$terminal_sha" node <<'NODE' || return 1
const chain=JSON.parse(process.env.IDENTITY_AVATAR_CLEANUP_CHAIN),terminal=chain.terminal;
const sha=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
if(!terminal||!['applied','adopted','aborted'].includes(chain.tailState)||
  terminal.ownershipRevision!==process.env.IDENTITY_AVATAR_OWNER||
  terminal.runtimeRevision!==process.env.IDENTITY_AVATAR_RUNTIME||
  terminal.initialClientRevision!==process.env.IDENTITY_AVATAR_INITIAL_CLIENT||
  terminal.currentClientRevision!==process.env.IDENTITY_AVATAR_CURRENT_CLIENT||
  terminal.generation!==Number(process.env.IDENTITY_AVATAR_GENERATION)||
  chain.terminalSha256!==process.env.IDENTITY_AVATAR_TERMINAL_SHA||
  !Number.isSafeInteger(chain.ledgerGeneration)||!sha(chain.ledgerSha256)||
  !['applied','adopted','aborted'].includes(chain.ledgerState))process.exit(1);
if(chain.tailState==='aborted'){
  if(chain.ledgerState!=='aborted'||chain.ledgerGeneration!==terminal.generation+1||
    chain.ledgerSha256!==chain.abortedSha256||chain.markerGeneration!==terminal.generation||
    chain.markerSha256!==chain.terminalSha256||!['applied','adopted'].includes(chain.markerState))process.exit(1);
}else if(chain.ledgerState!==chain.tailState||chain.ledgerGeneration!==terminal.generation||
  chain.ledgerSha256!==chain.terminalSha256||chain.markerGeneration!==terminal.generation||
  chain.markerSha256!==chain.terminalSha256||chain.markerState!==chain.tailState)process.exit(1);
NODE
	current_body_sha="$(identity_avatar_sha256 "$identity_avatar_runtime_stability_current_body")" || return 1
	current_signature_sha="$(identity_avatar_sha256 "$identity_avatar_runtime_stability_current_signature")" || return 1
	current_validation="$(identity_avatar_validate_runtime_stability_current_pair \
		"$identity_avatar_runtime_stability_current_body" \
		"$identity_avatar_runtime_stability_current_signature" "$chain")" || return 1
	archive_paths="$(identity_avatar_runtime_stability_current_archive_paths "$current_body_sha")" || return 1
	archive_body="$(printf '%s\n' "$archive_paths" | sed -n '1p')" || return 1
	archive_signature="$(printf '%s\n' "$archive_paths" | sed -n '2p')" || return 1
	identity_avatar_validate_runtime_stability_current_archive_pair "$archive_body" "$archive_signature" \
		"$current_body_sha" "$current_signature_sha" >/dev/null || return 1
	cmp -s "$identity_avatar_runtime_stability_current_body" "$archive_body" || return 1
	cmp -s "$identity_avatar_runtime_stability_current_signature" "$archive_signature" || return 1
	if [[ "$validation_mode" == 'terminal-live' ]]; then
		avatar_cleanup_validate_public_file "$identity_avatar_runtime_stability_current_public_body" || return 1
		avatar_cleanup_validate_public_file "$identity_avatar_runtime_stability_current_public_signature" || return 1
		[[ "$(identity_avatar_sha256 "$identity_avatar_runtime_stability_current_public_body")" == "$current_body_sha" &&
			"$(identity_avatar_sha256 "$identity_avatar_runtime_stability_current_public_signature")" == \
			"$current_signature_sha" ]] || return 1
	fi
	frontend_binding="$(IDENTITY_AVATAR_CLEANUP_CHAIN="$chain" node -e '
const value=JSON.parse(process.env.IDENTITY_AVATAR_CLEANUP_CHAIN).terminal?.frontendBinding;
if(!value)process.exit(1);process.stdout.write(JSON.stringify(value));')" || return 1
	IDENTITY_AVATAR_CLEANUP_CHAIN="$chain" IDENTITY_AVATAR_CURRENT_VALIDATION="$current_validation" \
		IDENTITY_AVATAR_FRONTEND_BINDING="$frontend_binding" IDENTITY_AVATAR_MARKER_FILE="$identity_avatar_marker" \
		IDENTITY_AVATAR_CURRENT_BODY_SHA="$current_body_sha" \
		IDENTITY_AVATAR_CURRENT_SIGNATURE_SHA="$current_signature_sha" \
		IDENTITY_AVATAR_WRITER_FILE="$identity_avatar_writer_fence_evidence" \
		IDENTITY_AVATAR_POLICY_FILE="$identity_avatar_policy_evidence" \
		IDENTITY_AVATAR_SNAPSHOT_FILE="$identity_avatar_uploads_snapshot_evidence" \
		IDENTITY_AVATAR_INVENTORY_FILE="$identity_avatar_inventory_manifest" \
		IDENTITY_AVATAR_MIGRATION_FILE="$identity_avatar_migration_manifest" \
		IDENTITY_AVATAR_STATUS_FILE="$identity_avatar_status_manifest" \
		IDENTITY_AVATAR_REVOCATION_FILE="$identity_avatar_revocation_evidence" \
		IDENTITY_AVATAR_SMOKE_FILE="$identity_avatar_authenticated_smoke_evidence" \
		IDENTITY_AVATAR_CLIENT_FILE="$identity_avatar_client_evidence" \
		IDENTITY_AVATAR_SOAK_FILE="$identity_avatar_soak_evidence" \
		IDENTITY_AVATAR_TIMER_STATUS_FILE="$identity_avatar_soak_timer_status" node <<'NODE'
const {createHash}=require('node:crypto');const {readFileSync}=require('node:fs');
const sha=value=>createHash('sha256').update(value).digest('hex');
const chain=JSON.parse(process.env.IDENTITY_AVATAR_CLEANUP_CHAIN),terminal=chain.terminal;
const current=JSON.parse(process.env.IDENTITY_AVATAR_CURRENT_VALIDATION).value;
const frontend=JSON.parse(process.env.IDENTITY_AVATAR_FRONTEND_BINDING);
const frontendKeys=['bindingKind','evidenceSha256','evidenceSignatureSha256','clientRevision','imageId',
  'releaseEvidenceSha256','releaseEvidenceSignatureSha256','releaseTreeSha256',
  'releaseFullManifestSha256','processStartedAt'];
if(JSON.stringify(Object.keys(frontend))!==JSON.stringify(frontendKeys)||
  JSON.stringify(frontend)!==JSON.stringify(terminal.frontendBinding)||
  JSON.stringify(current.frontendBinding)!==JSON.stringify(frontend))process.exit(1);
process.stdout.write(JSON.stringify({
  ownershipRevision:terminal.ownershipRevision,currentRuntimeRevision:terminal.runtimeRevision,
  initialClientRevision:terminal.initialClientRevision,currentClientRevision:terminal.currentClientRevision,
  identityDatabaseId:terminal.identityDatabaseId,ownershipMarkerSha256:sha(readFileSync(process.env.IDENTITY_AVATAR_MARKER_FILE)),
  runtimeStabilityGeneration:terminal.generation,runtimeStabilityEvidenceSha256:chain.terminalSha256,
  runtimeStabilityLedgerGeneration:chain.ledgerGeneration,runtimeStabilityLedgerTailState:chain.ledgerState,
  runtimeStabilityLedgerTailEvidenceSha256:chain.ledgerSha256,
  runtimeStabilityCurrentEvidenceSha256:process.env.IDENTITY_AVATAR_CURRENT_BODY_SHA,
  runtimeStabilityCurrentSignatureSha256:process.env.IDENTITY_AVATAR_CURRENT_SIGNATURE_SHA,
  currentClientBindingEvidenceSha256:terminal.clientBindingEvidenceSha256,
  frontendBindingSha256:sha(Buffer.from(JSON.stringify(frontend))),frontendBinding:frontend,
  runtimeStableSince:terminal.runtimeStableSince,writerFile:process.env.IDENTITY_AVATAR_WRITER_FILE,
  policyFile:process.env.IDENTITY_AVATAR_POLICY_FILE,snapshotFile:process.env.IDENTITY_AVATAR_SNAPSHOT_FILE,
  inventoryFile:process.env.IDENTITY_AVATAR_INVENTORY_FILE,migrationFile:process.env.IDENTITY_AVATAR_MIGRATION_FILE,
  statusFile:process.env.IDENTITY_AVATAR_STATUS_FILE,revocationFile:process.env.IDENTITY_AVATAR_REVOCATION_FILE,
  smokeFile:process.env.IDENTITY_AVATAR_SMOKE_FILE,clientFile:process.env.IDENTITY_AVATAR_CLIENT_FILE,
  soakFile:process.env.IDENTITY_AVATAR_SOAK_FILE,timerStatusFile:process.env.IDENTITY_AVATAR_TIMER_STATUS_FILE,
}));
NODE
)

avatar_cleanup_load_ownership_context() {
	[[ $# -eq 1 && "$1" =~ ^(terminal-live|historical-finalized)$ ]] || return 1
	local fields
	avatar_cleanup_ownership_context="$(avatar_cleanup_compute_ownership_context "$1")" || return 1
	fields="$(IDENTITY_AVATAR_CLEANUP_CONTEXT="$avatar_cleanup_ownership_context" node -e '
const value=JSON.parse(process.env.IDENTITY_AVATAR_CLEANUP_CONTEXT);const keys=[
"ownershipRevision","currentRuntimeRevision","initialClientRevision","currentClientRevision","identityDatabaseId",
"ownershipMarkerSha256","runtimeStabilityGeneration","runtimeStabilityEvidenceSha256",
"runtimeStabilityLedgerGeneration","runtimeStabilityLedgerTailState","runtimeStabilityLedgerTailEvidenceSha256",
"runtimeStabilityCurrentEvidenceSha256","runtimeStabilityCurrentSignatureSha256",
"currentClientBindingEvidenceSha256","frontendBindingSha256","runtimeStableSince","writerFile","policyFile",
"snapshotFile","inventoryFile","migrationFile","statusFile","revocationFile","smokeFile","clientFile","soakFile",
"timerStatusFile"];
if(keys.some(key=>typeof value[key]!=="string"&&!["runtimeStabilityGeneration","runtimeStabilityLedgerGeneration"].includes(key)))process.exit(1);
process.stdout.write(keys.map(key=>String(value[key])).join("\t"));')" || return 1
	IFS=$'\t' read -r avatar_cleanup_context_owner avatar_cleanup_runtime_revision \
		avatar_cleanup_initial_client_revision avatar_cleanup_current_client_revision \
		avatar_cleanup_identity_database_id avatar_cleanup_ownership_marker_sha \
		avatar_cleanup_runtime_stability_generation avatar_cleanup_runtime_stability_evidence_sha \
		avatar_cleanup_runtime_stability_ledger_generation avatar_cleanup_runtime_stability_ledger_state \
		avatar_cleanup_runtime_stability_ledger_sha avatar_cleanup_runtime_stability_current_sha \
		avatar_cleanup_runtime_stability_current_signature_sha avatar_cleanup_current_client_binding_sha \
		avatar_cleanup_frontend_binding_sha avatar_cleanup_runtime_stable_since \
		avatar_cleanup_writer_evidence avatar_cleanup_policy_evidence avatar_cleanup_uploads_snapshot_evidence \
		avatar_cleanup_inventory_manifest avatar_cleanup_migration_evidence avatar_cleanup_status_manifest \
		avatar_cleanup_migration_revocation_evidence avatar_cleanup_authenticated_smoke_evidence \
		avatar_cleanup_ownership_client_evidence avatar_cleanup_soak_evidence \
		avatar_cleanup_generation_timer_status_file <<<"$fields"
	avatar_cleanup_frontend_binding="$(IDENTITY_AVATAR_CLEANUP_CONTEXT="$avatar_cleanup_ownership_context" node -e '
const value=JSON.parse(process.env.IDENTITY_AVATAR_CLEANUP_CONTEXT).frontendBinding;
if(!value)process.exit(1);process.stdout.write(JSON.stringify(value));')" || return 1
	[[ "$(FRONTEND_BINDING="$avatar_cleanup_frontend_binding" node -e '
const {createHash}=require("node:crypto");process.stdout.write(createHash("sha256")
.update(process.env.FRONTEND_BINDING).digest("hex"));')" == "$avatar_cleanup_frontend_binding_sha" ]] || return 1
	[[ "$avatar_cleanup_context_owner" == "$AVATAR_OWNERSHIP_REVISION" &&
		"$avatar_cleanup_current_client_revision" == "$AVATAR_CLIENT_REVISION" ]] || return 1
}

avatar_cleanup_inherited_validation_mode() {
	if [[ -e "$avatar_cleanup_marker" || -L "$avatar_cleanup_marker" ]]; then
		avatar_cleanup_validate_marker || return 1
		case "$(avatar_cleanup_marker_value phase)" in
		verified) printf 'terminal-live\n' ;;
		forward-only | complete) printf 'historical-finalized\n' ;;
		*) return 1 ;;
		esac
	else
		printf 'terminal-live\n'
	fi
}

avatar_cleanup_validate_inherited_contract() (
	[[ $# -eq 1 && "$1" =~ ^(with-handoff|retarget-only)$ ]] || return 1
	[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ &&
		"$AVATAR_OWNERSHIP_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
	local cleanup_revision="$EXPECTED_REVISION"
	local validation_mode lifecycle_script validator_root='' tracked_blob actual_blob renamed_chain actual_server_root
	local owner runtime initial current generation terminal_sha
	validation_mode="$(avatar_cleanup_inherited_validation_mode)" || return 1
	avatar_cleanup_load_ownership_context "$validation_mode" || return 1
	owner="$avatar_cleanup_context_owner"
	runtime="$avatar_cleanup_runtime_revision"
	initial="$avatar_cleanup_initial_client_revision"
	current="$avatar_cleanup_current_client_revision"
	generation="$avatar_cleanup_runtime_stability_generation"
	terminal_sha="$avatar_cleanup_runtime_stability_evidence_sha"
	if [[ "$validation_mode" == 'terminal-live' ]]; then
		lifecycle_script="$SERVER_ROOT/scripts/identity-avatar-media-production.sh"
		[[ -f "$lifecycle_script" && ! -L "$lifecycle_script" ]] || return 1
		tracked_blob="$(git -C "$SERVER_ROOT" rev-parse \
			"$cleanup_revision:scripts/identity-avatar-media-production.sh")" || return 1
		actual_blob="$(git -C "$SERVER_ROOT" hash-object "$lifecycle_script")" || return 1
		[[ "$actual_blob" == "$tracked_blob" ]] || return 1
	else
		validator_root="$(avatar_cleanup_materialize_lifecycle_validator "$cleanup_revision")" || return 1
		trap 'rm -rf -- "${validator_root:-}"' EXIT
		lifecycle_script="$validator_root/scripts/identity-avatar-media-production.sh"
	fi
	EXPECTED_REVISION="$runtime"
	IDENTITY_AVATAR_ARTIFACT_ROOT="${IDENTITY_AVATAR_ARTIFACT_ROOT:-$APP_ROOT/deploy/backend/identity-avatar-media-artifacts}"
	IDENTITY_AVATAR_MARKER="${IDENTITY_AVATAR_MARKER:-$APP_ROOT/deploy/backend/.identity-avatar-media-v1}"
	IDENTITY_AVATAR_SIGNING_PUBLIC_KEY="$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY"
	IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY="$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY"
	actual_server_root="$SERVER_ROOT"
	if [[ "$validation_mode" == 'historical-finalized' ]]; then
		SERVER_ROOT="$validator_root"
	fi
	# shellcheck source=scripts/identity-avatar-media-production.sh
	source "$lifecycle_script"
	SERVER_ROOT="$actual_server_root"
	identity_avatar_validate_marker || return 1
	identity_avatar_configure_revision_paths "$owner" "$runtime" "$initial" "$current" \
		"$generation" "$terminal_sha" || return 1
	if [[ "$validation_mode" == 'historical-finalized' ]]; then
		# Reuse the immutable cleanup-revision chain parser and exact 23-key
		# cleanup-retarget validator. Only its live-state selector is narrowed to
		# the cryptographic `bound` mode after the forward-only boundary.
		renamed_chain="$(declare -f identity_avatar_validate_runtime_stability_chain | \
			sed '1s/^identity_avatar_validate_runtime_stability_chain /identity_avatar_validate_runtime_stability_chain_immutable /')" || return 1
		[[ "$renamed_chain" == identity_avatar_validate_runtime_stability_chain_immutable* ]] || return 1
		eval "$renamed_chain"
		identity_avatar_validate_runtime_stability_chain() {
			if [[ "${1:-bound}" == 'terminal-live' ]]; then
				identity_avatar_validate_runtime_stability_chain_immutable bound
			else
				identity_avatar_validate_runtime_stability_chain_immutable "$@"
			fi
		}
	fi
	if [[ "$1" == 'with-handoff' ]]; then
		identity_avatar_validate_predeploy_uploads_handoff || return 1
	fi
	identity_avatar_validate_cleanup_retarget_evidence "$cleanup_revision"
)

avatar_cleanup_validate_inherited_lifecycle_bundle() (
	avatar_cleanup_validate_inherited_contract with-handoff
)

avatar_cleanup_validate_inherited_cleanup_retarget() (
	avatar_cleanup_validate_inherited_contract retarget-only
)

avatar_cleanup_validate_ownership_client_artifact() {
	avatar_cleanup_validate_private_file "$avatar_cleanup_ownership_client_evidence" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_ownership_client_trust_bootstrap" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_pre_client_reference_zero_evidence" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_client_switch_reference_zero_evidence" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_historical_client_ready_body" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_historical_client_ready_signature" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_ownership_public_key" || return 1
	avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY" || return 1
	OWNERSHIP_CLIENT_FILE="$avatar_cleanup_ownership_client_evidence" \
		CLIENT_TRUST_BOOTSTRAP_FILE="$avatar_cleanup_ownership_client_trust_bootstrap" \
		REFERENCE_ZERO_FILE="$avatar_cleanup_pre_client_reference_zero_evidence" \
		CLIENT_SWITCH_REFERENCE_ZERO_FILE="$avatar_cleanup_client_switch_reference_zero_evidence" \
		CLIENT_READY_BODY="$avatar_cleanup_historical_client_ready_body" \
		CLIENT_READY_SIGNATURE="$avatar_cleanup_historical_client_ready_signature" \
		OWNERSHIP_PUBLIC_KEY="$avatar_cleanup_ownership_public_key" \
		CLIENT_PUBLIC_KEY="$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLIENT_REVISION="$avatar_cleanup_initial_client_revision" \
		PUBLIC_ORIGIN="$AVATAR_PUBLIC_ORIGIN" WRITER_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_initial_writer_evidence")" \
		POLICY_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_initial_policy_evidence")" \
		SNAPSHOT_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_uploads_snapshot_evidence")" \
		INVENTORY_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_inventory_manifest")" \
		MIGRATION_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_migration_evidence")" \
		STATUS_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_status_manifest")" \
		REVOCATION_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_migration_revocation_evidence")" \
		SMOKE_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_initial_authenticated_smoke_evidence")" \
		ACTIVATED_AT="$(avatar_cleanup_ownership_marker_value migrated_at)" \
		CLIENT_SWITCHED_AT="$(avatar_cleanup_ownership_marker_value client_switched_at)" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const decoder = new TextDecoder('utf-8', { fatal: true });
let value;
let bootstrap;
let reference;
let switchReference;
let ready;
let readyBody;
let readySignatureText;
try {
  value = JSON.parse(decoder.decode(fs.readFileSync(process.env.OWNERSHIP_CLIENT_FILE)));
  bootstrap = JSON.parse(decoder.decode(fs.readFileSync(process.env.CLIENT_TRUST_BOOTSTRAP_FILE)));
  reference = JSON.parse(decoder.decode(fs.readFileSync(process.env.REFERENCE_ZERO_FILE)));
  switchReference = JSON.parse(decoder.decode(fs.readFileSync(process.env.CLIENT_SWITCH_REFERENCE_ZERO_FILE)));
  readyBody = fs.readFileSync(process.env.CLIENT_READY_BODY);
  ready = JSON.parse(decoder.decode(readyBody));
  readySignatureText = decoder.decode(fs.readFileSync(process.env.CLIENT_READY_SIGNATURE));
} catch { process.exit(1); }
const keys = ['version','kind','serverRevision','clientRevision','deployedRevision','releaseEvidenceUrl',
  'releaseEvidenceSha256','releaseEvidenceSignatureSha256','clientSigningPublicKeySha256','releaseTreeSha256',
  'releaseFullManifestSha256','releaseFileCount','releaseTotalBytes','runtimeHealthUrl','clientProcessStartedAt',
  'clientTrustBootstrapEvidenceSha256','directUploadDeletePassed','legacyReferencesAbsent','fullBuildManifestPassed',
  'writerFenceEvidenceSha256','storagePolicyEvidenceSha256','authenticatedSmokeEvidenceSha256','identityDatabaseId',
  'preClientReferenceZeroEvidenceSha256','clientSwitchReferenceZeroEvidenceSha256',
  'clientSwitchReferenceZeroRecheckedAt','clientReadyEvidenceSha256','clientReadyEvidenceSignatureSha256',
  'preSwitchReferenceZeroRecheckPassed','verifiedAt','signature'];
const bootstrapKeys = ['version','kind','serverRevision','sourcePathSha256','sourcePublicKeySha256','destinationPath',
  'destinationPublicKeySha256','publicKeySpkiSha256','installedAt','signature'];
const referenceKeys = ['version','kind','serverRevision','writerFenceEvidenceSha256','storagePolicyEvidenceSha256',
  'inventoryManifestSha256','statusManifestSha256','pattern','columnLimitPerSchema','estimatedRowLimitPerSchema',
  'identity','core','widgets','legacyReferenceMatches','verifiedAt','signature'];
const readyKeys = ['schemaVersion','kind','serverRevision','ownershipPhase','identityDatabaseId',
  'writerFenceEvidenceSha256','storagePolicyEvidenceSha256','uploadsSnapshotEvidenceSha256',
  'inventoryManifestSha256','migrationManifestSha256','statusManifestSha256','revocationEvidenceSha256',
  'authenticatedSmokeEvidenceSha256','referenceZeroEvidenceSha256','legacyReferenceMatches',
  'legacyFileWriterFenced','ownershipActivatedAt','generatedAt','expiresAt'];
if (!value || typeof value !== 'object' || Array.isArray(value) ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(keys) || !bootstrap || typeof bootstrap !== 'object' ||
    Array.isArray(bootstrap) || JSON.stringify(Object.keys(bootstrap)) !== JSON.stringify(bootstrapKeys) ||
    JSON.stringify(Object.keys(reference || {})) !== JSON.stringify(referenceKeys) ||
    JSON.stringify(Object.keys(switchReference || {})) !== JSON.stringify(referenceKeys) ||
    JSON.stringify(Object.keys(ready || {})) !== JSON.stringify(readyKeys) ||
    decoder.decode(readyBody) !== JSON.stringify(ready)) process.exit(1);
const { signature, ...payload } = value;
const { signature: bootstrapSignature, ...bootstrapPayload } = bootstrap;
const { signature: referenceSignature, ...referencePayload } = reference;
const { signature: switchReferenceSignature, ...switchReferencePayload } = switchReference;
let ownershipKey;
let clientKey;
try {
  ownershipKey = crypto.createPublicKey(fs.readFileSync(process.env.OWNERSHIP_PUBLIC_KEY));
  clientKey = crypto.createPublicKey(fs.readFileSync(process.env.CLIENT_PUBLIC_KEY));
} catch { process.exit(1); }
const sha = item => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item);
const uuid = item => typeof item === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item);
const strictUtc = item => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item) &&
  Number.isFinite(Date.parse(item)) && new Date(Date.parse(item)).toISOString() === (item.includes('.') ? item : item.replace('Z','.000Z'));
const strictUtcSeconds = item => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(item) &&
  Number.isFinite(Date.parse(item)) && new Date(Date.parse(item)).toISOString().replace('.000Z','Z') === item;
const exact = (item, expected) => item && typeof item === 'object' && !Array.isArray(item) &&
  JSON.stringify(Object.keys(item)) === JSON.stringify(expected);
const fileSha = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const releaseUrl = `${process.env.PUBLIC_ORIGIN}/.well-known/winwidget/identity-avatar-client/${process.env.CLIENT_REVISION}/release-evidence-v1.json`;
const runtimeUrl = `${process.env.PUBLIC_ORIGIN}/.well-known/winwidget/identity-avatar-client/runtime-v1.json`;
const publicKeySha = crypto.createHash('sha256').update(fs.readFileSync(process.env.CLIENT_PUBLIC_KEY)).digest('hex');
const bootstrapSha = crypto.createHash('sha256').update(fs.readFileSync(process.env.CLIENT_TRUST_BOOTSTRAP_FILE)).digest('hex');
const publicKeySpkiSha = crypto.createHash('sha256').update(clientKey.export({ type: 'spki', format: 'der' })).digest('hex');
if (bootstrap.version !== 1 || bootstrap.kind !== 'identity-avatar-client-trust-bootstrap' ||
    bootstrap.serverRevision !== process.env.OWNERSHIP_REVISION || !sha(bootstrap.sourcePathSha256) ||
    bootstrap.sourcePublicKeySha256 !== publicKeySha ||
    bootstrap.destinationPath !== '/opt/winwidget/deploy/backend/.identity-avatar-client-signing.public.pem' ||
    bootstrap.destinationPublicKeySha256 !== publicKeySha || bootstrap.publicKeySpkiSha256 !== publicKeySpkiSha ||
    !strictUtcSeconds(bootstrap.installedAt) || Date.parse(bootstrap.installedAt) > Date.now() + 300000 ||
    ownershipKey.asymmetricKeyType !== 'ed25519' || clientKey.asymmetricKeyType !== 'ed25519' ||
    typeof bootstrapSignature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(bootstrapSignature) ||
    Buffer.from(bootstrapSignature, 'base64').length !== 64 ||
    !crypto.verify(null, Buffer.from(JSON.stringify(bootstrapPayload)), ownershipKey,
      Buffer.from(bootstrapSignature, 'base64'))) process.exit(1);
const scanKeys = ['schemaVersion','label','database','role','databaseTemporaryPrivilege','schemaCreatePrivilege',
  'schema','pattern','columnLimit','estimatedRowLimit','columnCount','estimatedRows','matches','columns'];
const compare = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
const identityKeys = ['schemaVersion','label','database','role','databaseTemporaryPrivilege','schemaCreatePrivilege',
  'schema','pattern','outboxMatches','consumerFailureMatches','databaseId'];
const validateReference = (candidate, expectedKind, candidateSignature, candidatePayload) => {
  for (const [scan,label,role,schema] of [[candidate.core,'core','winwidget_backup','public'],
      [candidate.widgets,'widgets','winwidget_widgets_backup','widgets']]) {
    if (!exact(scan, scanKeys) || scan.schemaVersion !== 1 || scan.label !== label || scan.role !== role ||
        !/^[A-Za-z0-9_-]+$/.test(scan.database || '') || scan.schema !== schema || scan.pattern !== '/uploads/' ||
        scan.databaseTemporaryPrivilege !== false ||
        scan.schemaCreatePrivilege !== false || scan.columnLimit !== 256 || scan.estimatedRowLimit !== 50000000 ||
        !Number.isSafeInteger(scan.columnCount) || scan.columnCount < 1 || scan.columnCount > 256 ||
        !Number.isSafeInteger(scan.estimatedRows) || scan.estimatedRows < 0 || scan.estimatedRows > 50000000 ||
        scan.matches !== 0 || !Array.isArray(scan.columns) || scan.columns.length !== scan.columnCount) process.exit(1);
    let previousTable = null;
    const identifiers = new Set();
    for (const column of scan.columns) {
      if (!exact(column, ['table','column','estimatedRows','matches']) || typeof column.table !== 'string' ||
          typeof column.column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(column.table) ||
          !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(column.column) ||
          !Number.isSafeInteger(column.estimatedRows) || column.estimatedRows < 0 ||
          column.estimatedRows > 50000000 || column.matches !== 0) process.exit(1);
      const identifier = `${column.table}\0${column.column}`;
      if (identifiers.has(identifier) || (previousTable !== null && compare(previousTable, column.table) > 0)) process.exit(1);
      identifiers.add(identifier);
      previousTable = column.table;
    }
  }
  if (candidate.version !== 1 || candidate.kind !== expectedKind ||
      candidate.serverRevision !== process.env.OWNERSHIP_REVISION ||
      candidate.writerFenceEvidenceSha256 !== process.env.WRITER_SHA ||
      candidate.storagePolicyEvidenceSha256 !== process.env.POLICY_SHA ||
      candidate.inventoryManifestSha256 !== process.env.INVENTORY_SHA ||
      candidate.statusManifestSha256 !== process.env.STATUS_SHA || candidate.pattern !== '/uploads/' ||
      candidate.columnLimitPerSchema !== 256 || candidate.estimatedRowLimitPerSchema !== 50000000 ||
      candidate.legacyReferenceMatches !== 0 || !strictUtcSeconds(candidate.verifiedAt) ||
      Date.parse(candidate.verifiedAt) > Date.now() + 120000 ||
      !exact(candidate.identity, identityKeys) || candidate.identity.schemaVersion !== 1 ||
      candidate.identity.label !== 'identity-replayable' || candidate.identity.role !== 'winwidget_identity_backup' ||
      candidate.identity.databaseTemporaryPrivilege !== false || candidate.identity.schemaCreatePrivilege !== false ||
      candidate.identity.schema !== 'identity' || candidate.identity.pattern !== '/uploads/' ||
      candidate.identity.outboxMatches !== 0 || candidate.identity.consumerFailureMatches !== 0 ||
      !/^[A-Za-z0-9_-]+$/.test(candidate.identity.database || '') ||
      !uuid(candidate.identity.databaseId) || typeof candidateSignature !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(candidateSignature) || Buffer.from(candidateSignature, 'base64').length !== 64 ||
      !crypto.verify(null, Buffer.from(JSON.stringify(candidatePayload)), ownershipKey,
        Buffer.from(candidateSignature, 'base64'))) process.exit(1);
};
validateReference(reference, 'identity-avatar-legacy-reference-zero', referenceSignature, referencePayload);
validateReference(switchReference, 'identity-avatar-client-switch-reference-zero',
  switchReferenceSignature, switchReferencePayload);
const referenceSha = fileSha(process.env.REFERENCE_ZERO_FILE);
const switchReferenceSha = fileSha(process.env.CLIENT_SWITCH_REFERENCE_ZERO_FILE);
const readySha = fileSha(process.env.CLIENT_READY_BODY);
const readySignatureSha = fileSha(process.env.CLIENT_READY_SIGNATURE);
if (!/^[A-Za-z0-9+/]{86}==\n$/.test(readySignatureText) ||
    !crypto.verify(null, readyBody, ownershipKey, Buffer.from(readySignatureText.trim(), 'base64')) ||
    ready.schemaVersion !== 1 || ready.kind !== 'identity-avatar-client-ready' ||
    ready.serverRevision !== process.env.OWNERSHIP_REVISION || ready.ownershipPhase !== 'ACTIVE' ||
    ready.identityDatabaseId !== reference.identity.databaseId ||
    switchReference.identity.databaseId !== reference.identity.databaseId ||
    ready.writerFenceEvidenceSha256 !== process.env.WRITER_SHA ||
    ready.storagePolicyEvidenceSha256 !== process.env.POLICY_SHA || ready.uploadsSnapshotEvidenceSha256 !== process.env.SNAPSHOT_SHA ||
    ready.inventoryManifestSha256 !== process.env.INVENTORY_SHA || ready.migrationManifestSha256 !== process.env.MIGRATION_SHA ||
    ready.statusManifestSha256 !== process.env.STATUS_SHA || ready.revocationEvidenceSha256 !== process.env.REVOCATION_SHA ||
    ready.authenticatedSmokeEvidenceSha256 !== process.env.SMOKE_SHA || ready.referenceZeroEvidenceSha256 !== referenceSha ||
    ready.legacyReferenceMatches !== 0 || ready.legacyFileWriterFenced !== true ||
    ready.ownershipActivatedAt !== process.env.ACTIVATED_AT || !strictUtcSeconds(ready.ownershipActivatedAt) ||
    !strictUtcSeconds(ready.generatedAt) || !strictUtcSeconds(ready.expiresAt) ||
    Date.parse(ready.expiresAt) - Date.parse(ready.generatedAt) !== 7200000 ||
    Date.parse(ready.ownershipActivatedAt) > Date.parse(reference.verifiedAt) ||
    Date.parse(reference.verifiedAt) > Date.parse(ready.generatedAt)) process.exit(1);
if (value.version !== 1 || value.kind !== 'identity-avatar-client-switch' ||
    value.serverRevision !== process.env.OWNERSHIP_REVISION || value.clientRevision !== process.env.CLIENT_REVISION ||
    value.deployedRevision !== process.env.CLIENT_REVISION || value.releaseEvidenceUrl !== releaseUrl ||
    value.runtimeHealthUrl !== runtimeUrl || !sha(value.releaseEvidenceSha256) ||
    !sha(value.releaseEvidenceSignatureSha256) || value.clientSigningPublicKeySha256 !== publicKeySha ||
    !sha(value.releaseTreeSha256) || !sha(value.releaseFullManifestSha256) || !Number.isSafeInteger(value.releaseFileCount) ||
    value.releaseFileCount < 1 || value.releaseFileCount > 20000 || !Number.isSafeInteger(value.releaseTotalBytes) ||
    value.releaseTotalBytes < 1 || value.releaseTotalBytes > 512 * 1024 * 1024 ||
    value.clientTrustBootstrapEvidenceSha256 !== bootstrapSha ||
    value.directUploadDeletePassed !== true || value.legacyReferencesAbsent !== true ||
    value.fullBuildManifestPassed !== true || value.writerFenceEvidenceSha256 !== process.env.WRITER_SHA ||
    value.storagePolicyEvidenceSha256 !== process.env.POLICY_SHA ||
    value.authenticatedSmokeEvidenceSha256 !== process.env.SMOKE_SHA ||
    value.identityDatabaseId !== reference.identity.databaseId || value.preClientReferenceZeroEvidenceSha256 !== referenceSha ||
    value.clientSwitchReferenceZeroEvidenceSha256 !== switchReferenceSha ||
    value.clientReadyEvidenceSha256 !== readySha || value.clientReadyEvidenceSignatureSha256 !== readySignatureSha ||
    value.preSwitchReferenceZeroRecheckPassed !== true ||
    !strictUtc(value.clientProcessStartedAt) || !strictUtcSeconds(value.clientSwitchReferenceZeroRecheckedAt) ||
    !strictUtcSeconds(value.verifiedAt) ||
    Date.parse(bootstrap.installedAt) > Date.parse(value.verifiedAt) ||
    Date.parse(value.clientProcessStartedAt) > Date.parse(value.verifiedAt) ||
    Date.parse(ready.generatedAt) > Date.parse(switchReference.verifiedAt) ||
    Date.parse(switchReference.verifiedAt) > Date.parse(value.clientSwitchReferenceZeroRecheckedAt) ||
    Date.parse(value.clientSwitchReferenceZeroRecheckedAt) > Date.parse(value.verifiedAt) ||
    Date.parse(value.verifiedAt) - Date.parse(value.clientSwitchReferenceZeroRecheckedAt) > 120000 ||
    Date.parse(ready.generatedAt) > Date.parse(value.verifiedAt) || value.verifiedAt !== process.env.CLIENT_SWITCHED_AT ||
    Date.parse(value.verifiedAt) > Date.now() + 300000 || ownershipKey.asymmetricKeyType !== 'ed25519' ||
    clientKey.asymmetricKeyType !== 'ed25519' || typeof signature !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || Buffer.from(signature, 'base64').length !== 64 ||
    !crypto.verify(null, Buffer.from(JSON.stringify(payload)), ownershipKey, Buffer.from(signature, 'base64'))) process.exit(1);
NODE
}

avatar_cleanup_require_ownership_artifacts() {
	avatar_cleanup_validate_ownership_marker ||
		avatar_cleanup_fail 'avatar ownership soak-complete marker is absent or invalid' || return 1
	local validation_mode
	validation_mode="$(avatar_cleanup_inherited_validation_mode)" || return 1
	avatar_cleanup_load_ownership_context "$validation_mode" || return 1
	local artifact_root="${IDENTITY_AVATAR_ARTIFACT_ROOT:-$APP_ROOT/deploy/backend/identity-avatar-media-artifacts}"
	local runtime_revision="$avatar_cleanup_runtime_revision"
	local initial_client_revision="$avatar_cleanup_initial_client_revision"
	local current_client_revision="$avatar_cleanup_current_client_revision"
	local stability_root="$artifact_root/runtime-stability-$AVATAR_OWNERSHIP_REVISION"
	local writer="$avatar_cleanup_writer_evidence"
	local initial_writer="$stability_root/generation-000000-writer-fence-v1.json"
	local snapshot="$avatar_cleanup_uploads_snapshot_evidence"
	local inventory="$avatar_cleanup_inventory_manifest"
	local migration="$avatar_cleanup_migration_evidence"
	local status="$avatar_cleanup_status_manifest"
	local soak="$avatar_cleanup_soak_evidence"
	local policy="$avatar_cleanup_policy_evidence"
	local initial_policy="$stability_root/generation-000000-storage-policy-v1.json"
	local revocation="$avatar_cleanup_migration_revocation_evidence"
	local authenticated_smoke="$avatar_cleanup_authenticated_smoke_evidence"
	local initial_authenticated_smoke="$stability_root/generation-000000-authenticated-smoke-v1.json"
	local client="$avatar_cleanup_ownership_client_evidence"
	local client_trust_bootstrap="$artifact_root/client-trust-bootstrap-$AVATAR_OWNERSHIP_REVISION.json"
	local reference_zero="$artifact_root/reference-zero-$AVATAR_OWNERSHIP_REVISION.json"
	local client_switch_reference_zero="$artifact_root/reference-zero-client-switch-$AVATAR_OWNERSHIP_REVISION.json"
	local client_ready="$artifact_root/client-ready-$AVATAR_OWNERSHIP_REVISION.json"
	local client_ready_signature="${client_ready}.sig"
	local predeploy_handoff="$artifact_root/predeploy-uploads-handoff-v1.json"
	local cleanup_retarget="$artifact_root/cleanup-retarget-v1.json"
	local runtime_retarget="$artifact_root/runtime-retarget-applied-$runtime_revision.json"
	local client_retarget="$artifact_root/client-soak-retarget-recorded-$current_client_revision.json"
	local client_retarget_frontend="$artifact_root/frontend-client-soak-retarget-$current_client_revision.json"
	local client_retarget_frontend_signature="${client_retarget_frontend}.sig"
	local client_retarget_reference="$artifact_root/reference-zero-client-retarget-$current_client_revision.json"
	local client_retarget_ack="$artifact_root/client-retarget-ack-$current_client_revision.json"
	local client_retarget_ack_signature="${client_retarget_ack}.sig"
	local pair
	for pair in \
		"$writer:writer_fence_evidence_sha256" \
		"$policy:storage_policy_evidence_sha256" \
		"$snapshot:uploads_snapshot_evidence_sha256" \
		"$inventory:inventory_manifest_sha256" \
		"$migration:migration_manifest_sha256" \
		"$status:status_manifest_sha256" \
		"$revocation:revocation_evidence_sha256" \
		"$authenticated_smoke:authenticated_smoke_evidence_sha256" \
		"$client:client_evidence_sha256" \
		"$soak:soak_evidence_sha256" \
		"$cleanup_retarget:cleanup_retarget_evidence_sha256"; do
		local file="${pair%%:*}" key="${pair##*:}"
		avatar_cleanup_validate_private_file "$file" ||
			avatar_cleanup_fail "avatar ownership artifact is unsafe: $(basename -- "$file")" || return 1
		[[ "$(avatar_cleanup_sha256 "$file")" == "$(avatar_cleanup_ownership_marker_value "$key")" ]] ||
			avatar_cleanup_fail "avatar ownership artifact hash mismatch: $(basename -- "$file")" || return 1
	done
	if [[ "$runtime_revision" == "$AVATAR_OWNERSHIP_REVISION" ]]; then
		[[ "$(avatar_cleanup_ownership_marker_value runtime_retarget_evidence_sha256)" == 'pending' ]] || return 1
	else
		avatar_cleanup_validate_private_file "$runtime_retarget" || return 1
		[[ "$(avatar_cleanup_sha256 "$runtime_retarget")" == \
			"$(avatar_cleanup_ownership_marker_value runtime_retarget_evidence_sha256)" ]] || return 1
	fi
	if [[ "$current_client_revision" == "$initial_client_revision" ]]; then
		[[ "$(avatar_cleanup_ownership_marker_value client_retarget_evidence_sha256)" == 'pending' ]] || return 1
	else
		for file in "$client_retarget" "$client_retarget_frontend" "$client_retarget_frontend_signature" \
			"$client_retarget_reference" "$client_retarget_ack" "$client_retarget_ack_signature"; do
			avatar_cleanup_validate_private_file "$file" || return 1
		done
		[[ "$(avatar_cleanup_sha256 "$client_retarget")" == \
			"$(avatar_cleanup_ownership_marker_value client_retarget_evidence_sha256)" ]] || return 1
	fi
	for file in "$client_trust_bootstrap" "$reference_zero" "$client_switch_reference_zero" "$client_ready" \
		"$client_ready_signature" "$predeploy_handoff" "$initial_writer" "$initial_policy" \
		"$initial_authenticated_smoke"; do
		avatar_cleanup_validate_private_file "$file" ||
			avatar_cleanup_fail "avatar ownership artifact is unsafe: $(basename -- "$file")" || return 1
	done
	OWNERSHIP_STATUS="$status" OWNERSHIP_INVENTORY="$inventory" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" node <<'NODE' || return 1
const fs = require('node:fs');
const status = JSON.parse(fs.readFileSync(process.env.OWNERSHIP_STATUS, 'utf8'));
const inventory = JSON.parse(fs.readFileSync(process.env.OWNERSHIP_INVENTORY, 'utf8'));
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const nullableSha = value => value === null || sha(value);
const exactKeys = (value, expected) => value && typeof value === 'object' &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const safeKey = key => typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.startsWith('/') &&
  key.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !segment.includes('\\'));
const validManifest = (value, expectedKind) => {
  if (!exactKeys(value, ['schemaVersion','kind','rows']) || value.schemaVersion !== 1 ||
			value.kind !== expectedKind || !Array.isArray(value.rows) || value.rows.length > 100000) return false;
  let previous = '';
  for (const row of value.rows) {
    if (!row || typeof row.userId !== 'string' || row.userId.length < 1 || row.userId.length > 191 ||
        row.userId <= previous || !/^(NONE|NEW_MANAGED|EXTERNAL|LEGACY_S3|LEGACY_UPLOAD|INVALID)$/.test(row.classification || '') ||
        !/^(NOT_APPLICABLE|VERIFIED|MISSING|INVALID|UNAVAILABLE)$/.test(row.verification || '') ||
        !nullableSha(row.avatarPathSha256) || !nullableSha(row.avatarObjectKeySha256)) return false;
    const rowKeys = ['userId','avatarPathSha256','avatarObjectKeySha256','classification','verification',
      ...(row.errorCode === undefined ? [] : ['errorCode']),
      ...(row.managedObjectSha256 === undefined ? [] : ['managedObjectSha256']),
      ...(row.source === undefined ? [] : ['source'])];
    if (!exactKeys(row, rowKeys) ||
        (row.managedObjectSha256 !== undefined && !sha(row.managedObjectSha256)) ||
        (row.classification !== 'NEW_MANAGED' && row.managedObjectSha256 !== undefined)) return false;
    const legacy = ['LEGACY_S3','LEGACY_UPLOAD'].includes(row.classification);
    if (legacy !== Boolean(row.source)) return false;
    if (row.source) {
      const sourceKeys = ['kind','key', ...(row.source.sourceSha256 === undefined ? [] : ['sourceSha256']),
        ...(row.source.normalizedSha256 === undefined ? [] : ['normalizedSha256'])];
      if (!exactKeys(row.source, sourceKeys) || !safeKey(row.source.key) ||
          row.source.kind !== (row.classification === 'LEGACY_S3' ? 'S3' : 'UPLOAD') ||
          (row.source.sourceSha256 !== undefined && !sha(row.source.sourceSha256)) ||
          (row.source.normalizedSha256 !== undefined && !sha(row.source.normalizedSha256)) ||
          Boolean(row.source.sourceSha256) !== Boolean(row.source.normalizedSha256)) return false;
    }
    const hasError = typeof row.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(row.errorCode);
    if (row.classification === 'NONE' && (row.avatarPathSha256 !== null || row.avatarObjectKeySha256 !== null ||
        row.verification !== 'NOT_APPLICABLE' || row.errorCode !== undefined)) return false;
    if (row.classification === 'EXTERNAL' && (row.avatarPathSha256 === null || row.avatarObjectKeySha256 !== null ||
        row.verification !== 'NOT_APPLICABLE' || row.errorCode !== undefined)) return false;
    if (row.classification === 'INVALID' && ((row.avatarPathSha256 === null && row.avatarObjectKeySha256 === null) ||
        row.verification !== 'NOT_APPLICABLE' || !hasError)) return false;
    if (!['NONE','EXTERNAL','INVALID'].includes(row.classification)) {
      if (row.avatarPathSha256 === null ||
          ((row.classification === 'NEW_MANAGED') !== (row.avatarObjectKeySha256 !== null))) return false;
      const verified = row.verification === 'VERIFIED' && row.errorCode === undefined &&
        (row.classification === 'NEW_MANAGED' ? sha(row.managedObjectSha256) :
          sha(row.source?.sourceSha256) && sha(row.source?.normalizedSha256));
      const failed = ['MISSING','INVALID','UNAVAILABLE'].includes(row.verification) && hasError &&
        row.managedObjectSha256 === undefined && !row.source?.sourceSha256 && !row.source?.normalizedSha256;
      if (!verified && !failed) return false;
    }
    previous = row.userId;
  }
  return true;
};
if (!validManifest(status, 'STATUS') || !validManifest(inventory, 'INVENTORY')) process.exit(1);
const unresolved = status.rows.filter(row => ['LEGACY_S3','LEGACY_UPLOAD','INVALID'].includes(row.classification));
if (unresolved.length !== 0 || status.rows.some(row => row.source)) process.exit(1);
const inventoryIds = inventory.rows.map(row => row.userId);
const statusIds = status.rows.map(row => row.userId);
if (JSON.stringify(inventoryIds) !== JSON.stringify([...inventoryIds].sort()) ||
    JSON.stringify(statusIds) !== JSON.stringify([...statusIds].sort()) ||
    new Set(inventoryIds).size !== inventoryIds.length || new Set(statusIds).size !== statusIds.length) process.exit(1);
const inventoryIdSet = new Set(inventoryIds);
const statusByUser = new Map(status.rows.map(row => [row.userId, row]));
for (const row of inventory.rows) {
  const after = statusByUser.get(row.userId);
  if (!after) process.exit(1);
  const legacy = ['LEGACY_S3','LEGACY_UPLOAD'].includes(row.classification);
  if (legacy && (row.verification !== 'VERIFIED' || !row.source ||
      !/^[0-9a-f]{64}$/.test(row.source.sourceSha256 || '') ||
      !/^[0-9a-f]{64}$/.test(row.source.normalizedSha256 || '') ||
      after.classification !== 'NEW_MANAGED' || after.verification !== 'VERIFIED' ||
      after.managedObjectSha256 !== row.source.normalizedSha256)) process.exit(1);
  if (!legacy && (row.classification !== after.classification ||
      row.avatarPathSha256 !== after.avatarPathSha256 ||
      row.avatarObjectKeySha256 !== after.avatarObjectKeySha256 ||
      (row.classification === 'NEW_MANAGED' && row.managedObjectSha256 !== after.managedObjectSha256))) process.exit(1);
}
for (const row of status.rows) {
  if (!inventoryIdSet.has(row.userId) && !['NONE','EXTERNAL'].includes(row.classification)) process.exit(1);
}
NODE
	avatar_cleanup_inventory_manifest="$inventory"
	avatar_cleanup_status_manifest="$status"
	avatar_cleanup_uploads_snapshot="$artifact_root/legacy-uploads-$AVATAR_OWNERSHIP_REVISION"
	avatar_cleanup_uploads_snapshot_evidence="$snapshot"
	avatar_cleanup_writer_evidence="$writer"
	avatar_cleanup_initial_writer_evidence="$initial_writer"
	avatar_cleanup_policy_evidence="$policy"
	avatar_cleanup_initial_policy_evidence="$initial_policy"
	avatar_cleanup_migration_evidence="$migration"
	avatar_cleanup_migration_revocation_evidence="$revocation"
	avatar_cleanup_authenticated_smoke_evidence="$authenticated_smoke"
	avatar_cleanup_initial_authenticated_smoke_evidence="$initial_authenticated_smoke"
	avatar_cleanup_ownership_client_evidence="$client"
	avatar_cleanup_ownership_client_trust_bootstrap="$client_trust_bootstrap"
	avatar_cleanup_pre_client_reference_zero_evidence="$reference_zero"
	avatar_cleanup_client_switch_reference_zero_evidence="$client_switch_reference_zero"
	avatar_cleanup_historical_client_ready_body="$client_ready"
	avatar_cleanup_historical_client_ready_signature="$client_ready_signature"
	avatar_cleanup_predeploy_uploads_handoff="$predeploy_handoff"
	avatar_cleanup_soak_evidence="$soak"
	avatar_cleanup_cleanup_retarget_evidence="$cleanup_retarget"
	avatar_cleanup_runtime_revision="$runtime_revision"
	avatar_cleanup_initial_client_revision="$initial_client_revision"
	avatar_cleanup_current_client_revision="$current_client_revision"
	avatar_cleanup_runtime_retarget_evidence="$runtime_retarget"
	avatar_cleanup_client_retarget_evidence="$client_retarget"
	avatar_cleanup_client_retarget_frontend_evidence="$client_retarget_frontend"
	avatar_cleanup_client_retarget_frontend_signature="$client_retarget_frontend_signature"
	avatar_cleanup_client_retarget_reference="$client_retarget_reference"
	avatar_cleanup_client_retarget_ack="$client_retarget_ack"
	avatar_cleanup_client_retarget_ack_signature="$client_retarget_ack_signature"
	avatar_cleanup_validate_ownership_client_artifact || return 1
	avatar_cleanup_validate_inherited_cleanup_retarget || return 1
	avatar_cleanup_ownership_bundle_sha="$({
		printf '%s\n' "$(avatar_cleanup_sha256 "$avatar_cleanup_ownership_marker")"
		printf '%s\n' "$(avatar_cleanup_sha256 "$avatar_cleanup_ownership_public_key")"
		printf '%s\n' "$(avatar_cleanup_sha256 "$writer")" "$(avatar_cleanup_sha256 "$policy")"
		if [[ "$runtime_revision" != "$AVATAR_OWNERSHIP_REVISION" ]]; then
			printf '%s\n' "$(avatar_cleanup_sha256 "$initial_writer")" "$(avatar_cleanup_sha256 "$initial_policy")" \
				"$(avatar_cleanup_sha256 "$initial_authenticated_smoke")"
		fi
		printf '%s\n' "$(avatar_cleanup_sha256 "$snapshot")" "$(avatar_cleanup_sha256 "$inventory")"
		printf '%s\n' "$(avatar_cleanup_sha256 "$migration")" "$(avatar_cleanup_sha256 "$status")"
		printf '%s\n' "$(avatar_cleanup_sha256 "$revocation")" "$(avatar_cleanup_sha256 "$authenticated_smoke")"
		printf '%s\n' "$(avatar_cleanup_sha256 "$client")" "$(avatar_cleanup_sha256 "$client_trust_bootstrap")"
		printf '%s\n' "$(avatar_cleanup_sha256 "$reference_zero")" \
			"$(avatar_cleanup_sha256 "$client_switch_reference_zero")" "$(avatar_cleanup_sha256 "$client_ready")"
		printf '%s\n' "$(avatar_cleanup_sha256 "$client_ready_signature")" "$(avatar_cleanup_sha256 "$predeploy_handoff")"
		printf '%s\n' "$(avatar_cleanup_sha256 "$soak")" "$(avatar_cleanup_sha256 "$cleanup_retarget")"
		if [[ "$runtime_revision" != "$AVATAR_OWNERSHIP_REVISION" ]]; then
			printf '%s\n' "$(avatar_cleanup_sha256 "$runtime_retarget")"
		fi
		if [[ "$current_client_revision" != "$initial_client_revision" ]]; then
			printf '%s\n' "$(avatar_cleanup_sha256 "$client_retarget")" \
				"$(avatar_cleanup_sha256 "$client_retarget_frontend")" \
				"$(avatar_cleanup_sha256 "$client_retarget_frontend_signature")" \
				"$(avatar_cleanup_sha256 "$client_retarget_reference")" \
				"$(avatar_cleanup_sha256 "$client_retarget_ack")" \
				"$(avatar_cleanup_sha256 "$client_retarget_ack_signature")"
		fi
	} | identity_cutover_text_sha256)"
}

avatar_cleanup_validate_current_soak_contract() (
	avatar_cleanup_require_ownership_artifacts || return 1
	avatar_cleanup_validate_inherited_lifecycle_bundle || return 1
	local cleanup_revision="$EXPECTED_REVISION"
	local artifact_root="${IDENTITY_AVATAR_ARTIFACT_ROOT:-$APP_ROOT/deploy/backend/identity-avatar-media-artifacts}"
	local writer_sha policy_sha inventory_sha migration_sha status_sha revocation_sha smoke_sha client_sha
	local boundary full_chain prefix_chain final_count prefix_root heartbeat_root credential_fields
	local runtime_revision initial_client_revision current_client_revision runtime_retarget_sha client_retarget_sha
	local client_release_sha client_release_signature_sha client_process_started_at client_verified_at
	local reset_anchor_sha client_record='' timer_render_root lifecycle_script_sha
	local stability_generation="$avatar_cleanup_runtime_stability_generation"
	local stability_sha="$avatar_cleanup_runtime_stability_evidence_sha"
	writer_sha="$(avatar_cleanup_ownership_marker_value writer_fence_evidence_sha256)" || return 1
	policy_sha="$(avatar_cleanup_ownership_marker_value storage_policy_evidence_sha256)" || return 1
	inventory_sha="$(avatar_cleanup_ownership_marker_value inventory_manifest_sha256)" || return 1
	migration_sha="$(avatar_cleanup_ownership_marker_value migration_manifest_sha256)" || return 1
	status_sha="$(avatar_cleanup_ownership_marker_value status_manifest_sha256)" || return 1
	revocation_sha="$(avatar_cleanup_ownership_marker_value revocation_evidence_sha256)" || return 1
	smoke_sha="$(avatar_cleanup_ownership_marker_value authenticated_smoke_evidence_sha256)" || return 1
	client_sha="$(avatar_cleanup_ownership_marker_value client_evidence_sha256)" || return 1
	runtime_revision="$(avatar_cleanup_ownership_marker_value runtime_revision)" || return 1
	initial_client_revision="$(avatar_cleanup_ownership_marker_value client_revision)" || return 1
	current_client_revision="$(avatar_cleanup_ownership_marker_value current_client_revision)" || return 1
	runtime_retarget_sha="$(avatar_cleanup_ownership_marker_value runtime_retarget_evidence_sha256)" || return 1
	client_retarget_sha="$(avatar_cleanup_ownership_marker_value client_retarget_evidence_sha256)" || return 1
	[[ "$current_client_revision" == "$AVATAR_CLIENT_REVISION" ]] || return 1

	EXPECTED_REVISION="$runtime_revision"
	IDENTITY_AVATAR_ARTIFACT_ROOT="$artifact_root"
	IDENTITY_AVATAR_MARKER="$avatar_cleanup_ownership_marker"
	IDENTITY_AVATAR_SIGNING_PUBLIC_KEY="$avatar_cleanup_ownership_public_key"
	IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY="$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY"
	# Consume the exact SHA-A validators from the ancestry-bound cleanup checkout;
	# they are pure for these calls and never fetch, publish, migrate, or restart.
	# shellcheck source=scripts/identity-avatar-media-production.sh
	source "$SERVER_ROOT/scripts/identity-avatar-media-production.sh"
	identity_avatar_validate_marker || return 1
	identity_avatar_validate_writer_fence_evidence "$identity_avatar_writer_fence_evidence" || return 1
	identity_avatar_validate_policy_evidence "$identity_avatar_policy_evidence" || return 1
	if [[ "$runtime_retarget_sha" == 'pending' ]]; then
		[[ "$runtime_revision" == "$AVATAR_OWNERSHIP_REVISION" ]] || return 1
	else
		identity_avatar_validate_runtime_retarget_applied_evidence "$runtime_revision" || return 1
	fi
	if [[ "$current_client_revision" == "$initial_client_revision" ]]; then
		[[ "$client_retarget_sha" == 'pending' ]] || return 1
		client_release_sha="$(identity_avatar_json_string_field \
			"$identity_avatar_client_evidence" releaseEvidenceSha256)" || return 1
		client_release_signature_sha="$(identity_avatar_json_string_field \
			"$identity_avatar_client_evidence" releaseEvidenceSignatureSha256)" || return 1
		client_process_started_at="$(identity_avatar_json_string_field \
			"$identity_avatar_client_evidence" clientProcessStartedAt)" || return 1
		client_verified_at="$(identity_avatar_json_string_field \
			"$identity_avatar_client_evidence" verifiedAt)" || return 1
	else
		client_record="$(identity_avatar_validate_client_retarget_chain \
			"$current_client_revision" "$client_retarget_sha")" || return 1
		identity_avatar_validate_client_retarget_ack "$current_client_revision" "$client_retarget_sha" || return 1
		identity_avatar_verify_public_client_retarget_ack "$current_client_revision" "$client_retarget_sha" || return 1
		read -r client_release_sha client_release_signature_sha client_process_started_at client_verified_at <<<"$(
			IDENTITY_AVATAR_CLIENT_RECORD="$client_record" node -e '
const value=JSON.parse(process.env.IDENTITY_AVATAR_CLIENT_RECORD);
process.stdout.write([value.releaseEvidenceSha256,value.releaseEvidenceSignatureSha256,
  value.clientProcessStartedAt,value.verifiedAt].join(" "));'
		)" || return 1
	fi
	boundary="$avatar_cleanup_runtime_stable_since"
	IDENTITY_AVATAR_CLIENT_BOUNDARY="$client_verified_at" IDENTITY_AVATAR_RUNTIME_BOUNDARY="$boundary" node -e '
const client=Date.parse(process.env.IDENTITY_AVATAR_CLIENT_BOUNDARY);
const runtime=Date.parse(process.env.IDENTITY_AVATAR_RUNTIME_BOUNDARY);
if(!Number.isFinite(client)||!Number.isFinite(runtime)||client>runtime||runtime>Date.now()+120000||
  new Date(runtime).toISOString().replace(".000Z","Z")!==process.env.IDENTITY_AVATAR_RUNTIME_BOUNDARY)process.exit(1);' || return 1
	reset_anchor_sha="$client_sha"
	[[ "$runtime_retarget_sha" == 'pending' ]] || reset_anchor_sha="$runtime_retarget_sha"
	if [[ "$client_retarget_sha" != 'pending' ]] &&
		[[ "$(IDENTITY_AVATAR_CLIENT_RECORD="$client_record" node -e '
const value=JSON.parse(process.env.IDENTITY_AVATAR_CLIENT_RECORD);
process.stdout.write(value.currentBackendRuntimeRevision);')" == "$runtime_revision" ]]; then
		reset_anchor_sha="$client_retarget_sha"
	fi
	lifecycle_script_sha="$(identity_avatar_sha256 "$SERVER_ROOT/scripts/identity-avatar-media-production.sh")" || return 1
	timer_render_root="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-timer-render.XXXXXX")" || return 1
	chmod 700 "$timer_render_root" || return 1
	chown 0:0 "$timer_render_root" || return 1
	identity_avatar_render_soak_timer_units "$timer_render_root" "$runtime_revision" "$lifecycle_script_sha" || return 1
	[[ "$(identity_avatar_sha256 "$timer_render_root/winwidget-identity-avatar-soak-heartbeat.service")" == \
		"$(identity_avatar_sha256 "$identity_avatar_soak_timer_service")" &&
		"$(identity_avatar_sha256 "$timer_render_root/winwidget-identity-avatar-soak-heartbeat.timer")" == \
		"$(identity_avatar_sha256 "$identity_avatar_soak_timer_unit")" ]] || return 1
	rm -rf -- "$timer_render_root" || return 1
	systemctl is-active --quiet winwidget-identity-avatar-soak-heartbeat.timer || return 1
	systemctl is-enabled --quiet winwidget-identity-avatar-soak-heartbeat.timer || return 1
	! systemctl is-active --quiet winwidget-identity-avatar-soak-heartbeat.service || return 1
	credential_fields="$(MIGRATION_FILE="$identity_avatar_migration_manifest" node <<'NODE'
const value = JSON.parse(require('node:fs').readFileSync(process.env.MIGRATION_FILE, 'utf8'));
if (!/^[0-9a-f]{64}$/.test(value.migrationCredentialAccessKeyIdSha256 || '') ||
    !/^[0-9a-f]{64}$/.test(value.migrationCredentialFileSha256 || '')) process.exit(1);
process.stdout.write(`${value.migrationCredentialAccessKeyIdSha256}\t${value.migrationCredentialFileSha256}`);
NODE
)" || return 1
	local credential_id_sha="${credential_fields%%$'\t'*}"
	local credential_file_sha="${credential_fields#*$'\t'}"
	identity_avatar_validate_migration_evidence "$inventory_sha" "$status_sha" \
		"$(avatar_cleanup_ownership_marker_value uploads_snapshot_evidence_sha256)" \
		"$writer_sha" "$policy_sha" "$credential_id_sha" "$credential_file_sha" || return 1
	identity_avatar_validate_signed_revocation_evidence "$inventory_sha" "$status_sha" \
		"$migration_sha" "$credential_id_sha" "$credential_file_sha" || return 1

	heartbeat_root="$identity_avatar_soak_heartbeat_root"
	full_chain="$(identity_avatar_validate_soak_heartbeat_chain "$current_client_revision" "$client_sha" \
		"$client_retarget_sha" "$runtime_retarget_sha" "$client_release_sha" \
		"$client_release_signature_sha" "$client_process_started_at" "$writer_sha" "$policy_sha" \
		"$inventory_sha" "$status_sha" "$revocation_sha" "$smoke_sha" "$boundary" \
		"$reset_anchor_sha" "$stability_generation" "$stability_sha")" || return 1
	identity_avatar_validate_soak_completion_window "$full_chain" "$boundary" || return 1
	final_count="$(SOAK_FILE="$identity_avatar_soak_evidence" node <<'NODE'
const value = JSON.parse(require('node:fs').readFileSync(process.env.SOAK_FILE, 'utf8'));
if (!Number.isSafeInteger(value.heartbeatCount) || value.heartbeatCount < 8 || value.heartbeatCount > 64) process.exit(1);
process.stdout.write(String(value.heartbeatCount));
NODE
)" || return 1
	prefix_root="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-soak-prefix.XXXXXX")" || return 1
	chmod 700 "$prefix_root" || return 1
	chown 0:0 "$prefix_root" || return 1
	trap 'rm -rf -- "$prefix_root"' EXIT
	local sequence source_file destination_file
	for ((sequence = 1; sequence <= final_count; sequence++)); do
		printf -v source_file '%s/heartbeat-%06d.json' "$heartbeat_root" "$sequence"
		printf -v destination_file '%s/heartbeat-%06d.json' "$prefix_root" "$sequence"
		[[ -f "$source_file" && ! -L "$source_file" ]] || return 1
		install -o root -g root -m 600 "$source_file" "$destination_file" || return 1
		[[ "$(avatar_cleanup_sha256 "$source_file")" == "$(avatar_cleanup_sha256 "$destination_file")" ]] || return 1
	done
	identity_avatar_soak_heartbeat_root="$prefix_root"
	prefix_chain="$(identity_avatar_validate_soak_heartbeat_chain "$current_client_revision" "$client_sha" \
		"$client_retarget_sha" "$runtime_retarget_sha" "$client_release_sha" \
		"$client_release_signature_sha" "$client_process_started_at" "$writer_sha" "$policy_sha" \
		"$inventory_sha" "$status_sha" "$revocation_sha" "$smoke_sha" "$boundary" \
		"$reset_anchor_sha" "$stability_generation" "$stability_sha")" || return 1
	identity_avatar_soak_heartbeat_root="$heartbeat_root"
	identity_avatar_validate_soak_completion_window "$prefix_chain" "$boundary" || return 1
	identity_avatar_validate_soak_evidence "$current_client_revision" "$client_sha" "$client_retarget_sha" \
		"$runtime_retarget_sha" "$writer_sha" "$policy_sha" "$inventory_sha" "$status_sha" \
		"$revocation_sha" "$smoke_sha" "$prefix_chain" "$stability_generation" "$stability_sha" || return 1

	ARCHIVE_ROOT="$identity_avatar_frontend_soak_archive" HEARTBEAT_ROOT="$heartbeat_root" \
		TIMER_STATUS_FILE="$identity_avatar_soak_timer_status" LIFECYCLE_SCRIPT="$SERVER_ROOT/scripts/identity-avatar-media-production.sh" \
		TIMER_SERVICE_FILE="$identity_avatar_soak_timer_service" TIMER_UNIT_FILE="$identity_avatar_soak_timer_unit" \
		CLIENT_PUBLIC_KEY="$identity_avatar_client_signing_public_key" SOAK_FILE="$identity_avatar_soak_evidence" \
		MARKER_FILE="$identity_avatar_marker" FULL_CHAIN="$full_chain" PREFIX_CHAIN="$prefix_chain" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$cleanup_revision" \
		RUNTIME_REVISION="$runtime_revision" INITIAL_CLIENT_REVISION="$initial_client_revision" \
		CLIENT_REVISION="$current_client_revision" CLIENT_SHA="$client_sha" \
		CLIENT_RETARGET_SHA="$client_retarget_sha" RUNTIME_RETARGET_SHA="$runtime_retarget_sha" \
		CLIENT_RELEASE_SHA="$client_release_sha" CLIENT_PROCESS_STARTED_AT="$client_process_started_at" \
		CLIENT_VERIFIED_AT="$client_verified_at" RUNTIME_STABLE_SINCE="$boundary" \
		RUNTIME_STABILITY_GENERATION="$stability_generation" RUNTIME_STABILITY_SHA="$stability_sha" \
		RESET_ANCHOR_SHA="$reset_anchor_sha" WRITER_SHA="$writer_sha" \
		POLICY_SHA="$policy_sha" INVENTORY_SHA="$inventory_sha" STATUS_SHA="$status_sha" \
		REVOCATION_SHA="$revocation_sha" SMOKE_SHA="$smoke_sha" BOUNDARY="$boundary" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const fail = () => process.exit(1);
const decode = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(); } };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const canonicalIso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const canonicalSeconds = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().replace('.000Z', 'Z') === value;
const fileSha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const safePrivate = file => {
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    (process.platform !== 'linux' || (stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o777) === 0o600));
};
const safeUnit = file => {
  const stat = fs.lstatSync(file);
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    (process.platform !== 'linux' || (stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o777) === 0o644));
};
let soak;
let full;
let prefix;
let timer;
try {
  soak = JSON.parse(decode(fs.readFileSync(process.env.SOAK_FILE)));
  full = JSON.parse(process.env.FULL_CHAIN);
  prefix = JSON.parse(process.env.PREFIX_CHAIN);
  timer = JSON.parse(decode(fs.readFileSync(process.env.TIMER_STATUS_FILE)));
} catch { fail(); }
const archiveStat = fs.lstatSync(process.env.ARCHIVE_ROOT);
if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink() ||
    (process.platform === 'linux' && (archiveStat.uid !== 0 || archiveStat.gid !== 0 ||
      (archiveStat.mode & 0o777) !== 0o700))) fail();
if (!Number.isSafeInteger(full.lastFrontendSequence) || full.lastFrontendSequence < 8 ||
    full.lastFrontendSequence > 64 || !Number.isSafeInteger(full.heartbeatCount) ||
    full.heartbeatCount < soak.heartbeatCount || full.heartbeatCount > 64) fail();
const timerKeys = ['version','kind','revision','scriptSha256','outcome','recordedAt'];
if (!safePrivate(process.env.TIMER_STATUS_FILE) || !exact(timer, timerKeys) || timer.version !== 1 ||
    timer.kind !== 'identity-avatar-soak-timer-status' || timer.revision !== process.env.RUNTIME_REVISION ||
    timer.scriptSha256 !== fileSha(process.env.LIFECYCLE_SCRIPT) || timer.outcome !== 'passed' ||
    !canonicalSeconds(timer.recordedAt) || Date.parse(timer.recordedAt) > Date.now() + 120000) fail();
if (!safeUnit(process.env.TIMER_SERVICE_FILE) || !safeUnit(process.env.TIMER_UNIT_FILE)) fail();
const expectedNames = [];
for (let sequence = 1; sequence <= full.lastFrontendSequence; sequence += 1) {
  expectedNames.push(`frontend-heartbeat-${String(sequence).padStart(6, '0')}.json`);
  expectedNames.push(`frontend-heartbeat-${String(sequence).padStart(6, '0')}.json.sig`);
}
const names = fs.readdirSync(process.env.ARCHIVE_ROOT).sort();
if (JSON.stringify(names) !== JSON.stringify(expectedNames.sort())) fail();
const evidenceKeys = ['schemaVersion','kind','clientRevision','releaseEvidenceSha256','processStartedAt',
  'logConfigurationSha256','sequence','previousEvidenceSha256','windowStartedAt','windowEndedAt','hosts',
  'probeClass','probeRequestCount','logFiles','logSetSha256','apiV1FilesRequestCount',
  'uploadsGetHeadRequestCount','uploadsSuccessfulGetHeadCount','rotationContinuityPassed','futureSkewPassed','generatedAt'];
const logKeys = ['pathSha256','device','inode','generation','firstByteOffset','lastByteOffset','bytes','sha256','mtime'];
let previousSha = process.env.CLIENT_RELEASE_SHA;
let previousEnded = null;
let firstStarted = null;
let logConfigurationSha256 = null;
let archiveBytes = 0;
const archiveTree = [];
let last = null;
const publicKey = crypto.createPublicKey(fs.readFileSync(process.env.CLIENT_PUBLIC_KEY));
if (publicKey.asymmetricKeyType !== 'ed25519') fail();
for (let sequence = 1; sequence <= full.lastFrontendSequence; sequence += 1) {
  const base = `frontend-heartbeat-${String(sequence).padStart(6, '0')}.json`;
  const bodyPath = path.join(process.env.ARCHIVE_ROOT, base);
  const signaturePath = `${bodyPath}.sig`;
  if (!safePrivate(bodyPath) || !safePrivate(signaturePath)) fail();
  const body = fs.readFileSync(bodyPath);
  const signatureBytes = fs.readFileSync(signaturePath);
  archiveBytes += body.length + signatureBytes.length;
  if (body.length < 2 || body.length > 4 * 1024 * 1024 || signatureBytes.length > 1024 ||
      archiveBytes > 256 * 1024 * 1024) fail();
  const text = decode(body);
  let value;
  try { value = JSON.parse(text); } catch { fail(); }
  if (text !== JSON.stringify(value)) fail();
  const signatureText = decode(signatureBytes);
  if (!/^[A-Za-z0-9+/]{86}==\n$/.test(signatureText) ||
      !crypto.verify(null, body, publicKey, Buffer.from(signatureText.trim(), 'base64'))) fail();
  if (!exact(value, evidenceKeys) || value.schemaVersion !== 1 || value.kind !== 'identity-avatar-client-log-soak' ||
      value.clientRevision !== process.env.CLIENT_REVISION || value.releaseEvidenceSha256 !== process.env.CLIENT_RELEASE_SHA ||
      value.processStartedAt !== process.env.CLIENT_PROCESS_STARTED_AT || !sha(value.logConfigurationSha256) ||
      value.sequence !== sequence || value.previousEvidenceSha256 !== previousSha ||
      JSON.stringify(value.hosts) !== JSON.stringify(['winwidget.ru','www.winwidget.ru']) ||
      value.probeClass !== 'soak-probe' || value.probeRequestCount !== 1 ||
      !Array.isArray(value.logFiles) || value.logFiles.length < 1 || value.logFiles.length > 16 ||
      !sha(value.logSetSha256) || value.apiV1FilesRequestCount !== 0 ||
      !Number.isSafeInteger(value.uploadsGetHeadRequestCount) || value.uploadsGetHeadRequestCount < 0 ||
      value.uploadsSuccessfulGetHeadCount !== 0 || value.rotationContinuityPassed !== true ||
      value.futureSkewPassed !== true) fail();
  let previousPath = '';
  for (const item of value.logFiles) {
    if (!exact(item, logKeys) || !sha(item.pathSha256) || item.pathSha256 <= previousPath ||
        !decimal(item.device) || !decimal(item.inode) || !decimal(item.generation) ||
        !decimal(item.firstByteOffset) || !decimal(item.lastByteOffset) || !decimal(item.bytes) ||
        BigInt(item.lastByteOffset) < BigInt(item.firstByteOffset) ||
        BigInt(item.bytes) !== BigInt(item.lastByteOffset) - BigInt(item.firstByteOffset) ||
        !sha(item.sha256) || !canonicalIso(item.mtime)) fail();
    previousPath = item.pathSha256;
  }
  if (crypto.createHash('sha256').update(JSON.stringify(value.logFiles)).digest('hex') !== value.logSetSha256 ||
      !canonicalIso(value.windowStartedAt) || !canonicalIso(value.windowEndedAt) || !canonicalIso(value.generatedAt) ||
      Date.parse(value.windowStartedAt) < Date.parse(process.env.CLIENT_PROCESS_STARTED_AT) ||
      Date.parse(value.windowStartedAt) >= Date.parse(value.windowEndedAt) ||
      Date.parse(value.windowEndedAt) - Date.parse(value.windowStartedAt) > 93600000 ||
      value.generatedAt !== value.windowEndedAt || Date.parse(value.windowEndedAt) > Date.now() + 120000 ||
      (previousEnded !== null && value.windowStartedAt !== previousEnded) ||
      (logConfigurationSha256 !== null && value.logConfigurationSha256 !== logConfigurationSha256)) fail();
  if (firstStarted === null) firstStarted = value.windowStartedAt;
  if (logConfigurationSha256 === null) logConfigurationSha256 = value.logConfigurationSha256;
  previousEnded = value.windowEndedAt;
  previousSha = crypto.createHash('sha256').update(body).digest('hex');
  last = { value, bodySha256: previousSha,
    signatureSha256: crypto.createHash('sha256').update(signatureBytes).digest('hex') };
  archiveTree.push({ path: base, bytes: body.length, sha256: previousSha },
    { path: `${base}.sig`, bytes: signatureBytes.length, sha256: last.signatureSha256 });
}
const boundary = Date.parse(process.env.BOUNDARY);
const fullEnded = Date.parse(full.lastObservedAt);
const prefixEnded = Date.parse(prefix.lastObservedAt);
const expectedBoundary = process.env.RUNTIME_STABLE_SINCE;
if (!last || !Number.isFinite(boundary) || !Number.isFinite(fullEnded) || !Number.isFinite(prefixEnded) ||
    process.env.BOUNDARY !== expectedBoundary || Date.parse(process.env.CLIENT_VERIFIED_AT) > boundary ||
    Date.parse(firstStarted) > boundary ||
    last.bodySha256 !== full.lastFrontendEvidenceSha256 ||
    last.signatureSha256 !== full.lastFrontendEvidenceSignatureSha256 ||
    last.value.windowEndedAt !== full.lastFrontendWindowEndedAt ||
    soak.observationStartedAt !== process.env.BOUNDARY || soak.heartbeatCount !== prefix.heartbeatCount ||
    soak.firstHeartbeatSha256 !== prefix.firstHeartbeatSha256 || soak.lastHeartbeatSha256 !== prefix.lastHeartbeatSha256 ||
    soak.lastFrontendLogEvidenceSha256 !== prefix.lastFrontendEvidenceSha256 ||
    soak.lastFrontendLogEvidenceSignatureSha256 !== prefix.lastFrontendEvidenceSignatureSha256 ||
    soak.lastFrontendLogSequence !== prefix.lastFrontendSequence || soak.verifiedAt !== prefix.lastObservedAt ||
    full.firstHeartbeatSha256 !== prefix.firstHeartbeatSha256 || full.heartbeatCount < prefix.heartbeatCount ||
    prefix.heartbeatCount < 8 || prefix.lastFrontendSequence < 8 || prefix.maximumGapSeconds > 93600 ||
    full.maximumGapSeconds > 93600 || prefixEnded - boundary < 604800000 ||
    Date.parse(prefix.lastFrontendWindowEndedAt) - boundary < 604800000 ||
    Date.now() - fullEnded > 93600000 || Date.now() - Date.parse(full.lastFrontendWindowEndedAt) > 93600000 ||
    Date.now() - Date.parse(full.lastBackendWindowEndedAt) > 93600000 ||
    Date.parse(timer.recordedAt) < boundary || Date.now() - Date.parse(timer.recordedAt) > 93600000) fail();
const marker = Object.fromEntries(decode(fs.readFileSync(process.env.MARKER_FILE)).trimEnd().split('\n')
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
if (marker.server_revision !== process.env.OWNERSHIP_REVISION || marker.runtime_revision !== process.env.RUNTIME_REVISION ||
    marker.client_revision !== process.env.INITIAL_CLIENT_REVISION ||
    marker.current_client_revision !== process.env.CLIENT_REVISION ||
    marker.client_evidence_sha256 !== process.env.CLIENT_SHA || marker.writer_fence_evidence_sha256 !== process.env.WRITER_SHA ||
    marker.storage_policy_evidence_sha256 !== process.env.POLICY_SHA || marker.inventory_manifest_sha256 !== process.env.INVENTORY_SHA ||
    marker.status_manifest_sha256 !== process.env.STATUS_SHA || marker.revocation_evidence_sha256 !== process.env.REVOCATION_SHA ||
    marker.authenticated_smoke_evidence_sha256 !== process.env.SMOKE_SHA ||
    marker.runtime_retarget_evidence_sha256 !== process.env.RUNTIME_RETARGET_SHA ||
    marker.client_retarget_evidence_sha256 !== process.env.CLIENT_RETARGET_SHA ||
    marker.soak_verified_at !== soak.verifiedAt ||
    marker.soak_evidence_sha256 !== fileSha(process.env.SOAK_FILE)) fail();
const heartbeatNames = fs.readdirSync(process.env.HEARTBEAT_ROOT).sort();
const heartbeatTree = heartbeatNames.map(name => {
  const file = path.join(process.env.HEARTBEAT_ROOT, name);
  let heartbeat;
  try { heartbeat = JSON.parse(decode(fs.readFileSync(file))); } catch { fail(); }
  if (!Array.isArray(heartbeat.backendLogEvidence?.logFiles) ||
      heartbeat.backendLogEvidence.logFiles.length < 1 || heartbeat.backendLogEvidence.logFiles.length > 16) fail();
  return { path: name, sha256: fileSha(file) };
});
process.stdout.write(`${JSON.stringify({
  version: 1, action: 'avatar-signed-cross-host-seven-day-observation',
  ownershipRevision: process.env.OWNERSHIP_REVISION, cleanupRevision: process.env.CLEANUP_REVISION,
  currentRuntimeRevision: process.env.RUNTIME_REVISION,
  initialClientRevision: process.env.INITIAL_CLIENT_REVISION,
  clientRevision: process.env.CLIENT_REVISION, clientEvidenceSha256: process.env.CLIENT_SHA,
  runtimeStabilityGeneration: Number(process.env.RUNTIME_STABILITY_GENERATION),
  runtimeStabilityEvidenceSha256: process.env.RUNTIME_STABILITY_SHA,
  runtimeStableSince: process.env.RUNTIME_STABLE_SINCE,
  clientRetargetEvidenceSha256: process.env.CLIENT_RETARGET_SHA,
  runtimeRetargetEvidenceSha256: process.env.RUNTIME_RETARGET_SHA,
  resetAnchorSha256: process.env.RESET_ANCHOR_SHA,
  clientReleaseEvidenceSha256: process.env.CLIENT_RELEASE_SHA,
  clientProcessStartedAt: process.env.CLIENT_PROCESS_STARTED_AT,
  writerFenceEvidenceSha256: process.env.WRITER_SHA, storagePolicyEvidenceSha256: process.env.POLICY_SHA,
  inventoryManifestSha256: process.env.INVENTORY_SHA, statusManifestSha256: process.env.STATUS_SHA,
  revocationEvidenceSha256: process.env.REVOCATION_SHA, authenticatedSmokeEvidenceSha256: process.env.SMOKE_SHA,
  soakEvidenceSha256: fileSha(process.env.SOAK_FILE), observationBoundaryAt: process.env.BOUNDARY,
  finalHeartbeatCount: prefix.heartbeatCount, currentHeartbeatCount: full.heartbeatCount,
  finalLastHeartbeatSha256: prefix.lastHeartbeatSha256, currentLastHeartbeatSha256: full.lastHeartbeatSha256,
  frontendLastSequence: full.lastFrontendSequence, frontendLastEvidenceSha256: full.lastFrontendEvidenceSha256,
  frontendLastEvidenceSignatureSha256: full.lastFrontendEvidenceSignatureSha256,
  frontendLogConfigurationSha256: logConfigurationSha256, frontendObservedThrough: full.lastFrontendWindowEndedAt,
  backendLogSetSha256: full.lastBackendLogSetSha256, backendObservedThrough: full.lastBackendWindowEndedAt,
  backendTimerStatusSha256: fileSha(process.env.TIMER_STATUS_FILE), backendTimerRecordedAt: timer.recordedAt,
  backendTimerServiceSha256: fileSha(process.env.TIMER_SERVICE_FILE),
  backendTimerUnitSha256: fileSha(process.env.TIMER_UNIT_FILE),
  heartbeatTreeSha256: crypto.createHash('sha256').update(JSON.stringify(heartbeatTree)).digest('hex'),
  frontendArchiveTreeSha256: crypto.createHash('sha256').update(JSON.stringify(archiveTree)).digest('hex'),
  maximumGapSeconds: full.maximumGapSeconds, requiredSeconds: 604800,
  signaturesVerified: true, runtimeContinuityVerified: true, frontendLogContinuityVerified: true,
  backendLogContinuityVerified: true, legacyApiCallsZero: true, successfulUploadsGetHeadZero: true,
  verifiedAt: new Date().toISOString(),
}, null, 2)}\n`);
NODE
)

avatar_cleanup_capture_signed_observation_evidence() {
	local temporary="$avatar_cleanup_root/.observation.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	avatar_cleanup_validate_current_soak_contract >"$temporary" || return 1
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	avatar_cleanup_write_json_artifact "$avatar_cleanup_observation" "$temporary" || return 1
	rm -f -- "$temporary" || return 1
}

avatar_cleanup_load_storage_environment() {
	AVATAR_AUDIT_ENDPOINT="$(identity_read_env_value "$ENV_FILE" IDENTITY_AVATAR_S3_ENDPOINT)" || return 1
	AVATAR_AUDIT_REGION="$(identity_read_env_value "$ENV_FILE" IDENTITY_AVATAR_S3_REGION)" || return 1
	AVATAR_AUDIT_BUCKET="$(identity_read_env_value "$ENV_FILE" IDENTITY_AVATAR_S3_BUCKET)" || return 1
	AVATAR_AUDIT_FORCE_PATH_STYLE="$(identity_read_env_value "$ENV_FILE" IDENTITY_AVATAR_S3_FORCE_PATH_STYLE)" || return 1
	AVATAR_AUDIT_PUBLIC_BASE_URL="$(identity_read_env_value "$ENV_FILE" IDENTITY_AVATAR_S3_PUBLIC_BASE_URL)" || return 1
	AVATAR_AUDIT_KEY_PREFIX="$(identity_read_env_value "$ENV_FILE" IDENTITY_AVATAR_S3_KEY_PREFIX)" || return 1
	local generic_prefix
	generic_prefix="$(identity_read_env_value "$ENV_FILE" S3_KEY_PREFIX)" || return 1
	AVATAR_AUDIT_LEGACY_KEY_PREFIX="$(AVATAR_GENERIC_PREFIX="$generic_prefix" node <<'NODE'
const raw = process.env.AVATAR_GENERIC_PREFIX || '';
const prefix = raw.replace(/^\/+|\/+$/g, '');
const safe = value => !value || value.split('/').every(segment =>
  segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment));
if (!safe(prefix)) process.exit(1);
process.stdout.write(prefix ? `${prefix}/user-avatar` : 'user-avatar');
NODE
)" || return 1
	[[ "$AVATAR_AUDIT_ENDPOINT" == https://* && "$AVATAR_AUDIT_ENDPOINT" != */ &&
		"$AVATAR_AUDIT_PUBLIC_BASE_URL" == https://* && "$AVATAR_AUDIT_PUBLIC_BASE_URL" != */ &&
		"$AVATAR_AUDIT_FORCE_PATH_STYLE" =~ ^(true|false)$ && "$AVATAR_AUDIT_KEY_PREFIX" == 'identity/avatars' &&
		"$AVATAR_AUDIT_LEGACY_KEY_PREFIX" =~ ^[A-Za-z0-9._/-]+$ &&
		"$AVATAR_AUDIT_LEGACY_KEY_PREFIX" != "$AVATAR_AUDIT_KEY_PREFIX" &&
		"$AVATAR_AUDIT_KEY_PREFIX" != "$AVATAR_AUDIT_LEGACY_KEY_PREFIX"/* &&
		"$AVATAR_AUDIT_LEGACY_KEY_PREFIX" != "$AVATAR_AUDIT_KEY_PREFIX"/* ]] ||
		avatar_cleanup_fail 'avatar audit database/storage environment is invalid' || return 1
	export AVATAR_AUDIT_ENDPOINT AVATAR_AUDIT_REGION AVATAR_AUDIT_BUCKET
	export AVATAR_AUDIT_FORCE_PATH_STYLE AVATAR_AUDIT_PUBLIC_BASE_URL AVATAR_AUDIT_KEY_PREFIX
	export AVATAR_AUDIT_LEGACY_KEY_PREFIX
}

avatar_cleanup_load_audit_environment() {
	AVATAR_AUDIT_DATABASE_URL="$(identity_read_env_value "$ENV_FILE" IDENTITY_BACKUP_URL)" || return 1
	avatar_cleanup_load_storage_environment || return 1
	export AVATAR_AUDIT_DATABASE_URL
}

avatar_cleanup_audit_node() {
	local image
	image="$(identity_release_image "$avatar_cleanup_runtime_revision")" || return 1
	docker run --rm --network host --read-only --cap-drop ALL \
		--security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=8m \
		--env AVATAR_AUDIT_DATABASE_URL --env AVATAR_AUDIT_PUBLIC_BASE_URL \
		--env AVATAR_AUDIT_KEY_PREFIX --env AVATAR_AUDIT_OWNERSHIP_BUNDLE_SHA \
		--env AVATAR_AUDIT_INVENTORY_SHA --env AVATAR_AUDIT_STATUS_SHA \
		--env AVATAR_AUDIT_OWNERSHIP_REVISION \
		--entrypoint node "$image" -
}

avatar_cleanup_capture_manifest() {
	avatar_cleanup_require_ownership_artifacts
	avatar_cleanup_load_audit_environment
	AVATAR_AUDIT_OWNERSHIP_BUNDLE_SHA="$avatar_cleanup_ownership_bundle_sha"
	AVATAR_AUDIT_INVENTORY_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_inventory_manifest")"
	AVATAR_AUDIT_STATUS_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_status_manifest")"
	AVATAR_AUDIT_OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION"
	export AVATAR_AUDIT_OWNERSHIP_BUNDLE_SHA AVATAR_AUDIT_INVENTORY_SHA
	export AVATAR_AUDIT_STATUS_SHA AVATAR_AUDIT_OWNERSHIP_REVISION
	local temporary="$avatar_cleanup_root/.manifest.$$"
	avatar_cleanup_audit_node >"$temporary" <<'NODE'
const { PrismaClient } = require('@prisma/identity-client');
const crypto = require('node:crypto');
const fail = message => { throw new Error(message); };
const required = name => { const value = process.env[name]; if (!value) fail(`${name} missing`); return value; };
const databaseUrl = required('AVATAR_AUDIT_DATABASE_URL');
const prefix = required('AVATAR_AUDIT_KEY_PREFIX').replace(/^\/+|\/+$/g, '');
const publicBase = required('AVATAR_AUDIT_PUBLIC_BASE_URL').replace(/\/+$/g, '');
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const canonical = value => JSON.stringify(value);
const snapshot = async () => ({
  ownership: await prisma.avatarMediaOwnership.findUnique({ where: { id: 'singleton' } }),
  users: await prisma.user.findMany({
    select: { id: true, avatarPath: true, avatarObjectKey: true }, orderBy: { id: 'asc' },
  }),
  jobs: await prisma.avatarCleanupJob.findMany({
    select: { id: true, objectKey: true, ownerFingerprint: true, kind: true, status: true,
      availableAt: true, leaseToken: true, leaseExpiresAt: true, attempts: true, lastError: true,
      deliveredAt: true, createdAt: true, updatedAt: true },
    orderBy: { id: 'asc' },
  }),
});
(async () => {
  const migration = await prisma.$queryRawUnsafe(`SELECT migration_name, checksum, finished_at, rolled_back_at
    FROM identity._prisma_migrations WHERE migration_name = '20260815010000_add_avatar_media_ownership' ORDER BY started_at`);
  if (migration.length !== 1 || !migration[0].finished_at || migration[0].rolled_back_at) fail('avatar migration ledger invalid');
  const before = await snapshot();
  if (!before.ownership || before.ownership.phase !== 'ACTIVE' ||
      before.ownership.activatedRevision !== required('AVATAR_AUDIT_OWNERSHIP_REVISION') ||
      before.ownership.inventorySha256 !== required('AVATAR_AUDIT_INVENTORY_SHA') ||
      before.ownership.statusSha256 !== required('AVATAR_AUDIT_STATUS_SHA') || !before.ownership.activatedAt) {
    fail('avatar ownership database binding is invalid');
  }
  if (before.jobs.some(job => job.status !== 'DELIVERED')) fail('avatar cleanup jobs are not drained');
  const after = await snapshot();
  if (canonical(before) !== canonical(after)) fail('Identity avatar state changed during manifest capture');
  const expected = new Map();
  let unresolved = 0;
  for (const user of after.users) {
    if (!user.avatarObjectKey) {
      if (!user.avatarPath || !/^https?:\/\//.test(user.avatarPath)) unresolved += 1;
      continue;
    }
    const fingerprint = crypto.createHash('sha256').update(user.id).digest('hex');
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${fingerprint}/[0-9a-f-]{36}\\.webp$`, 'i');
    const expectedUrl = `${publicBase}/${user.avatarObjectKey.split('/').map(encodeURIComponent).join('/')}`;
    if (!pattern.test(user.avatarObjectKey) || user.avatarPath !== expectedUrl || expected.has(user.avatarObjectKey)) unresolved += 1;
    expected.set(user.avatarObjectKey, user.id);
  }
  if (unresolved !== 0 || expected.size > 100000) fail('database/object manifest mismatch');
  const objects = [];
  for (const key of [...expected.keys()].sort()) {
    const url = `${publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetch(url, {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { accept: 'image/webp' },
    });
    const contentType = response.headers.get('content-type');
    const declaredLength = response.headers.get('content-length');
    if (response.status !== 200 || contentType !== 'image/webp' ||
        (declaredLength !== null && !/^[1-9][0-9]*$/.test(declaredLength))) fail('invalid managed avatar response');
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 12 || body.length > 5242880 ||
        body.subarray(0, 4).toString('ascii') !== 'RIFF' ||
        body.subarray(8, 12).toString('ascii') !== 'WEBP' ||
        body.readUInt32LE(4) + 8 !== body.length ||
        (declaredLength !== null && Number(declaredLength) !== body.length)) fail('invalid managed avatar bytes');
    objects.push({ key, publicUrl: url, contentLength: body.length, contentType,
      sha256: crypto.createHash('sha256').update(body).digest('hex') });
  }
  const hash = value => value === null ? null : crypto.createHash('sha256').update(value).digest('hex');
  const evidence = {
    version: 1, action: 'avatar-object-database-exact-manifest',
    ownershipEvidenceBundleSha256: required('AVATAR_AUDIT_OWNERSHIP_BUNDLE_SHA'), migration: {
      name: migration[0].migration_name, checksum: migration[0].checksum,
      finishedAt: migration[0].finished_at.toISOString(),
    }, ownership: { id: after.ownership.id, phase: after.ownership.phase,
      activatedRevision: after.ownership.activatedRevision, inventorySha256: after.ownership.inventorySha256,
      statusSha256: after.ownership.statusSha256, activatedAt: after.ownership.activatedAt.toISOString(),
      createdAt: after.ownership.createdAt.toISOString(), updatedAt: after.ownership.updatedAt.toISOString() }, unresolved,
    users: after.users.map(user => ({ userIdSha256: hash(user.id), avatarPathSha256: hash(user.avatarPath),
      avatarObjectKey: user.avatarObjectKey, avatarObjectKeySha256: hash(user.avatarObjectKey) })),
    cleanupJobs: after.jobs.map(job => ({ ...job, id: String(job.id), ownerFingerprint: job.ownerFingerprint,
      availableAt: job.availableAt.toISOString(), leaseExpiresAt: job.leaseExpiresAt?.toISOString() || null,
      deliveredAt: job.deliveredAt?.toISOString() || null, createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString() })),
    objects,
    orphanProof: 'database-expected-public-get-plus-drained-cleanup-jobs-and-bound-storage-policy',
    capturedAt: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
})().finally(() => prisma.$disconnect()).catch(() => process.exit(1));
NODE
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -f -- "$temporary" "$avatar_cleanup_manifest" || return 1
	avatar_cleanup_fsync_file_and_parent "$avatar_cleanup_manifest" || return 1
	avatar_cleanup_sign_artifact "$avatar_cleanup_manifest"
	unset AVATAR_AUDIT_DATABASE_URL AVATAR_AUDIT_ENDPOINT AVATAR_AUDIT_REGION AVATAR_AUDIT_BUCKET
	unset AVATAR_AUDIT_FORCE_PATH_STYLE AVATAR_AUDIT_PUBLIC_BASE_URL AVATAR_AUDIT_KEY_PREFIX
	unset AVATAR_AUDIT_LEGACY_KEY_PREFIX
	unset AVATAR_AUDIT_OWNERSHIP_BUNDLE_SHA AVATAR_AUDIT_INVENTORY_SHA
	unset AVATAR_AUDIT_STATUS_SHA AVATAR_AUDIT_OWNERSHIP_REVISION
}

avatar_cleanup_run_psql() {
	[[ $# -eq 1 && "$1" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 1
	local url image
	url="$(identity_read_env_value "$ENV_FILE" "$1")" || return 1
	image="$(identity_read_env_value "$ENV_FILE" CORE_POSTGRES_IMAGE)" || return 1
	[[ "$image" =~ ^postgres:18[^@]*@sha256:[0-9a-f]{64}$ ]] ||
		avatar_cleanup_fail 'pinned PostgreSQL 18 image is required for reference scans' || return 1
	AVATAR_SCAN_DATABASE_URL="$url"; export AVATAR_SCAN_DATABASE_URL
	docker run --rm -i --network host --read-only --cap-drop ALL \
		--security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=4m \
		--env AVATAR_SCAN_DATABASE_URL --entrypoint sh "$image" -euc '
      exec psql --no-psqlrc --no-password --quiet --tuples-only --no-align \
        --set ON_ERROR_STOP=1 "$AVATAR_SCAN_DATABASE_URL"
    '
	unset AVATAR_SCAN_DATABASE_URL
}

avatar_cleanup_scan_database_schema() {
	[[ $# -eq 4 && "$2" =~ ^[a-z_]+$ && "$3" =~ ^[a-z-]+$ ]] || return 1
	local url_key="$1" schema="$2" label="$3" output="$4" expected_role metadata scan_sql result
	case "$url_key:$schema:$label" in
	DATABASE_BACKUP_URL:public:core) expected_role='winwidget_backup' ;;
	WIDGETS_BACKUP_URL:widgets:widgets) expected_role='winwidget_widgets_backup' ;;
	*) return 1 ;;
	esac
	metadata="$(avatar_cleanup_run_psql "$url_key" <<SQL
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SELECT json_build_object(
  'schemaVersion', 1,
  'database', current_database(),
  'role', current_user,
  'schema', '$schema',
  'databaseTempPrivilege', has_database_privilege(current_user, current_database(), 'TEMP'),
  'schemaCreatePrivilege', has_schema_privilege(current_user, '$schema', 'CREATE'),
  'columnLimit', 256,
  'estimatedRowLimit', 50000000,
  'columnCount', count(*),
  'estimatedRows', (
    SELECT COALESCE(sum(GREATEST(relation.reltuples, 0)), 0)::bigint
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = '$schema' AND relation.relkind IN ('r', 'p')
  ),
  'columns', COALESCE(json_agg(json_build_object(
    'table', columns.table_name,
    'column', columns.column_name,
    'estimatedRows', GREATEST(relation.reltuples, 0)::bigint
  ) ORDER BY columns.table_name COLLATE "C", columns.column_name COLLATE "C"), '[]'::json)
)::text
FROM information_schema.columns columns
JOIN pg_catalog.pg_class relation ON relation.relname = columns.table_name
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  AND namespace.nspname = columns.table_schema
WHERE columns.table_schema = '$schema'
  AND columns.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')
  AND relation.relkind IN ('r', 'p')
  AND current_setting('transaction_read_only') = 'on'
  AND current_user = '$expected_role'
  AND NOT has_database_privilege(current_user, current_database(), 'TEMP')
  AND NOT has_schema_privilege(current_user, '$schema', 'CREATE');
COMMIT;
SQL
)" || return 1
	scan_sql="$(AVATAR_SCAN_METADATA="$metadata" AVATAR_SCAN_SCHEMA="$schema" \
		AVATAR_SCAN_LABEL="$label" AVATAR_SCAN_ROLE="$expected_role" node <<'NODE'
const metadata = JSON.parse(process.env.AVATAR_SCAN_METADATA);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const keys = ['schemaVersion','database','role','schema','databaseTempPrivilege','schemaCreatePrivilege',
  'columnLimit','estimatedRowLimit','columnCount','estimatedRows','columns'];
const identifier = value => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 63 || value.includes('\0')) process.exit(1);
  return `"${value.replaceAll('"', '""')}"`;
};
const literal = value => `'${value.replaceAll("'", "''")}'`;
const compare = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
if (!exact(metadata, keys) || metadata.schemaVersion !== 1 ||
    !/^[A-Za-z0-9_-]+$/.test(metadata.database || '') || metadata.role !== process.env.AVATAR_SCAN_ROLE ||
    metadata.schema !== process.env.AVATAR_SCAN_SCHEMA || metadata.databaseTempPrivilege !== false ||
    metadata.schemaCreatePrivilege !== false || metadata.columnLimit !== 256 || metadata.estimatedRowLimit !== 50000000 ||
    !Number.isSafeInteger(metadata.columnCount) || metadata.columnCount < 1 || metadata.columnCount > 256 ||
    !Number.isSafeInteger(metadata.estimatedRows) || metadata.estimatedRows < 0 || metadata.estimatedRows > 50000000 ||
    !Array.isArray(metadata.columns) || metadata.columns.length !== metadata.columnCount) process.exit(1);
let previous = null;
for (const item of metadata.columns) {
  if (!exact(item, ['table','column','estimatedRows']) || typeof item.table !== 'string' ||
      typeof item.column !== 'string' || !Number.isSafeInteger(item.estimatedRows) || item.estimatedRows < 0 ||
      item.estimatedRows > 50000000) process.exit(1);
  const current = `${item.table}\0${item.column}`;
  if (previous !== null && compare(current, previous) <= 0) process.exit(1);
  previous = current;
}
const schema = identifier(metadata.schema);
const scans = metadata.columns.map(item => `SELECT ${literal(item.table)}::text AS table_name,
  ${literal(item.column)}::text AS column_name, ${item.estimatedRows}::bigint AS estimated_rows,
  (SELECT count(*) FROM ONLY ${schema}.${identifier(item.table)}
    WHERE ${identifier(item.column)}::text LIKE '%/uploads/%')::bigint AS matches`).join('\nUNION ALL\n');
process.stdout.write(`BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '3s';
WITH scan AS (${scans}), catalog AS (
  SELECT columns.table_name, columns.column_name, GREATEST(relation.reltuples, 0)::bigint AS estimated_rows
  FROM information_schema.columns columns
  JOIN pg_catalog.pg_class relation ON relation.relname = columns.table_name
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    AND namespace.nspname = columns.table_schema
  WHERE columns.table_schema = ${literal(metadata.schema)}
    AND columns.data_type IN ('text','character varying','character','json','jsonb')
    AND relation.relkind IN ('r','p')
), bounds AS (
  SELECT COALESCE(sum(GREATEST(relation.reltuples, 0)), 0)::bigint AS estimated_rows
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = ${literal(metadata.schema)} AND relation.relkind IN ('r','p')
)
SELECT json_build_object(
  'schemaVersion',1,'label',${literal(process.env.AVATAR_SCAN_LABEL)},'database',current_database(),
  'role',current_user,'schema',${literal(metadata.schema)},'pattern','/uploads/',
  'databaseTempPrivilege',has_database_privilege(current_user,current_database(),'TEMP'),
  'schemaCreatePrivilege',has_schema_privilege(current_user,${literal(metadata.schema)},'CREATE'),
  'columnLimit',256,'estimatedRowLimit',50000000,'columnCount',(SELECT count(*) FROM scan),
  'estimatedRows',(SELECT estimated_rows FROM bounds),'matches',(SELECT COALESCE(sum(matches),0) FROM scan),
  'columns',(SELECT json_agg(json_build_object('table',table_name,'column',column_name,
    'estimatedRows',estimated_rows,'matches',matches) ORDER BY table_name COLLATE "C",column_name COLLATE "C") FROM scan),
  'catalogColumns',(SELECT json_agg(json_build_object('table',table_name,'column',column_name,
    'estimatedRows',estimated_rows) ORDER BY table_name COLLATE "C",column_name COLLATE "C") FROM catalog)
)::text
WHERE current_setting('transaction_read_only')='on' AND current_user=${literal(metadata.role)}
  AND NOT has_database_privilege(current_user,current_database(),'TEMP')
  AND NOT has_schema_privilege(current_user,${literal(metadata.schema)},'CREATE');
COMMIT;`);
NODE
)" || return 1
	result="$(printf '%s\n' "$scan_sql" | avatar_cleanup_run_psql "$url_key")" || return 1
	AVATAR_SCAN_METADATA="$metadata" AVATAR_SCAN_RESULT="$result" AVATAR_SCAN_SCHEMA="$schema" \
		AVATAR_SCAN_LABEL="$label" AVATAR_SCAN_ROLE="$expected_role" AVATAR_SCAN_OUTPUT="$output" node <<'NODE' || return 1
const fs = require('node:fs');
const metadata = JSON.parse(process.env.AVATAR_SCAN_METADATA);
const value = JSON.parse(process.env.AVATAR_SCAN_RESULT);
const exact = (item, keys) => item && typeof item === 'object' && !Array.isArray(item) &&
  JSON.stringify(Object.keys(item)) === JSON.stringify(keys);
const keys = ['schemaVersion','label','database','role','schema','pattern','databaseTempPrivilege',
  'schemaCreatePrivilege','columnLimit','estimatedRowLimit','columnCount','estimatedRows','matches','columns','catalogColumns'];
const compare = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
if (!exact(value, keys) || value.schemaVersion !== 1 || value.label !== process.env.AVATAR_SCAN_LABEL ||
    value.database !== metadata.database || value.role !== process.env.AVATAR_SCAN_ROLE ||
    value.schema !== process.env.AVATAR_SCAN_SCHEMA || value.pattern !== '/uploads/' ||
    value.databaseTempPrivilege !== false || value.schemaCreatePrivilege !== false || value.columnLimit !== 256 ||
    value.estimatedRowLimit !== 50000000 || value.columnCount !== metadata.columnCount ||
    value.estimatedRows !== metadata.estimatedRows || value.matches !== 0 || !Array.isArray(value.columns) ||
    value.columns.length !== value.columnCount || JSON.stringify(value.catalogColumns) !== JSON.stringify(metadata.columns)) process.exit(1);
let previous = null;
for (let index = 0; index < value.columns.length; index += 1) {
  const item = value.columns[index];
  const source = metadata.columns[index];
  if (!exact(item, ['table','column','estimatedRows','matches']) || item.table !== source.table ||
      item.column !== source.column || item.estimatedRows !== source.estimatedRows || item.matches !== 0) process.exit(1);
  const current = `${item.table}\0${item.column}`;
  if (previous !== null && compare(current, previous) <= 0) process.exit(1);
  previous = current;
}
delete value.catalogColumns;
fs.writeFileSync(process.env.AVATAR_SCAN_OUTPUT, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
NODE
	chmod 600 "$output" || return 1
	chown 0:0 "$output" || return 1
}

avatar_cleanup_capture_reference_evidence() {
	local temporary_root core widgets identity output
	temporary_root="$(mktemp -d "$avatar_cleanup_root/.references.XXXXXX")"
	chmod 700 "$temporary_root"
	chown 0:0 "$temporary_root"
	trap 'rm -rf -- "$temporary_root"' RETURN
	core="$temporary_root/core.json"
	widgets="$temporary_root/widgets.json"
	identity="$temporary_root/identity.json"
	output="$temporary_root/evidence.json"
	avatar_cleanup_scan_database_schema DATABASE_BACKUP_URL public core "$core"
	avatar_cleanup_scan_database_schema WIDGETS_BACKUP_URL widgets widgets "$widgets"
	avatar_cleanup_run_psql IDENTITY_BACKUP_URL >"$identity" <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SELECT json_build_object(
  'schemaVersion', 1,
  'label', 'identity-replayable',
  'database', current_database(),
  'role', current_user,
  'schema', 'identity',
  'pattern', '/uploads/',
  'databaseTempPrivilege', has_database_privilege(current_user, current_database(), 'TEMP'),
  'schemaCreatePrivilege', has_schema_privilege(current_user, 'identity', 'CREATE'),
  'outboxMatches', (
    SELECT count(*) FROM identity.outbox_events
    WHERE status::text IN ('PENDING', 'PROCESSING')
      AND (payload::text LIKE '%/uploads/%' OR headers::text LIKE '%/uploads/%')
  ),
  'consumerFailureMatches', (
    SELECT count(*) FROM identity.consumer_failures
    WHERE status::text <> 'RESOLVED'
      AND (payload::text LIKE '%/uploads/%' OR headers::text LIKE '%/uploads/%')
  ),
  'databaseId', (
    SELECT database_id::text FROM identity.service_identity
    WHERE id = 'singleton' AND service_name = 'identity-service' AND phase = 'ACTIVE'
  )
)::text
WHERE current_setting('transaction_read_only') = 'on'
  AND current_user = 'winwidget_identity_backup'
  AND NOT has_database_privilege(current_user, current_database(), 'TEMP')
  AND NOT has_schema_privilege(current_user, 'identity', 'CREATE');
COMMIT;
SQL
	CORE_SCAN="$core" WIDGETS_SCAN="$widgets" IDENTITY_SCAN="$identity" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
		OUTPUT="$output" node <<'NODE'
const fs = require('node:fs');
const parse = name => {
  const lines = fs.readFileSync(process.env[name], 'utf8').trim().split('\n');
  const line = [...lines].reverse().find(value => value.trim().startsWith('{'));
  if (!line) process.exit(1);
  return JSON.parse(line);
};
const core = parse('CORE_SCAN');
const widgets = parse('WIDGETS_SCAN');
const identity = parse('IDENTITY_SCAN');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const scanKeys = ['schemaVersion','label','database','role','schema','pattern','databaseTempPrivilege',
  'schemaCreatePrivilege','columnLimit','estimatedRowLimit','columnCount','estimatedRows','matches','columns'];
for (const [value,label,role,schema] of [[core,'core','winwidget_backup','public'],
    [widgets,'widgets','winwidget_widgets_backup','widgets']]) {
  if (!exact(value, scanKeys) || value.schemaVersion !== 1 || value.label !== label || value.role !== role ||
      value.schema !== schema || value.pattern !== '/uploads/' || value.databaseTempPrivilege !== false ||
      value.schemaCreatePrivilege !== false || value.columnLimit !== 256 || value.estimatedRowLimit !== 50000000 ||
      !Number.isSafeInteger(value.columnCount) || value.columnCount < 1 || value.columnCount > 256 ||
      !Number.isSafeInteger(value.estimatedRows) || value.estimatedRows < 0 || value.estimatedRows > 50000000 ||
      value.matches !== 0 || !Array.isArray(value.columns) || value.columns.length !== value.columnCount) process.exit(1);
}
const identityKeys = ['schemaVersion','label','database','role','schema','pattern','databaseTempPrivilege',
  'schemaCreatePrivilege','outboxMatches','consumerFailureMatches','databaseId'];
if (!exact(identity, identityKeys) || identity.schemaVersion !== 1 || identity.label !== 'identity-replayable' ||
    identity.role !== 'winwidget_identity_backup' || identity.schema !== 'identity' || identity.pattern !== '/uploads/' ||
    identity.databaseTempPrivilege !== false || identity.schemaCreatePrivilege !== false ||
    identity.outboxMatches !== 0 || identity.consumerFailureMatches !== 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity.databaseId || '')) process.exit(1);
const evidence = {
  version: 1,
  action: 'avatar-legacy-reference-scan',
  ownershipRevision: process.env.OWNERSHIP_REVISION,
  cleanupRevision: process.env.CLEANUP_REVISION,
  identity,
  core,
  widgets,
  verifiedAt: new Date().toISOString(),
};
fs.writeFileSync(process.env.OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	avatar_cleanup_write_json_artifact "$avatar_cleanup_references" "$output"
	rm -rf -- "$temporary_root"
	trap - RETURN
}

avatar_cleanup_capture_identity_backup_and_restore() {
	identity_cleanup_create_backup IDENTITY_BACKUP_URL identity \
		"$avatar_cleanup_identity_backup" "$avatar_cleanup_identity_backup_journal" \
		"$AVATAR_OWNERSHIP_REVISION"
	identity_cutover_validate_backup_file "$avatar_cleanup_identity_backup" ||
		avatar_cleanup_fail 'Identity avatar cleanup backup is invalid' || return 1
	identity_cutover_run_restore_rehearsal post-ownership \
		"$avatar_cleanup_identity_backup" "$avatar_cleanup_identity_restore"
	identity_cutover_restore_evidence_matches "$avatar_cleanup_identity_restore" \
		post-ownership "$(avatar_cleanup_sha256 "$avatar_cleanup_identity_backup")" ||
		avatar_cleanup_fail 'Identity clean-restore evidence is invalid' || return 1
	avatar_cleanup_sign_artifact "$avatar_cleanup_identity_backup"
	avatar_cleanup_sign_artifact "$avatar_cleanup_identity_restore"
}

avatar_cleanup_require_signed_hash() {
	[[ $# -eq 2 && "$2" =~ ^[0-9a-f]{64}$ ]] || return 1
	avatar_cleanup_verify_artifact "$1" || return 1
	[[ "$(avatar_cleanup_sha256 "$1")" == "$2" ]]
}

avatar_cleanup_require_verified_evidence() {
	avatar_cleanup_validate_marker || return 1
	[[ "$(avatar_cleanup_marker_value ownership_revision)" == "$AVATAR_OWNERSHIP_REVISION" &&
		"$(avatar_cleanup_marker_value cleanup_revision)" == "$EXPECTED_REVISION" &&
		"$(avatar_cleanup_marker_value current_client_revision)" == "$AVATAR_CLIENT_REVISION" ]] || return 1
	avatar_cleanup_require_ownership_artifacts || return 1
	[[ "$(avatar_cleanup_marker_value ownership_marker_sha256)" == "$avatar_cleanup_ownership_marker_sha" &&
		"$(avatar_cleanup_marker_value current_runtime_revision)" == "$avatar_cleanup_runtime_revision" &&
		"$(avatar_cleanup_marker_value initial_client_revision)" == "$avatar_cleanup_initial_client_revision" &&
		"$(avatar_cleanup_marker_value current_client_revision)" == "$avatar_cleanup_current_client_revision" &&
		"$(avatar_cleanup_marker_value identity_database_id)" == "$avatar_cleanup_identity_database_id" &&
		"$(avatar_cleanup_marker_value runtime_stability_generation)" == "$avatar_cleanup_runtime_stability_generation" &&
		"$(avatar_cleanup_marker_value runtime_stability_evidence_sha256)" == \
			"$avatar_cleanup_runtime_stability_evidence_sha" &&
		"$(avatar_cleanup_marker_value runtime_stability_ledger_generation)" == \
			"$avatar_cleanup_runtime_stability_ledger_generation" &&
		"$(avatar_cleanup_marker_value runtime_stability_ledger_tail_state)" == \
			"$avatar_cleanup_runtime_stability_ledger_state" &&
		"$(avatar_cleanup_marker_value runtime_stability_ledger_tail_evidence_sha256)" == \
			"$avatar_cleanup_runtime_stability_ledger_sha" &&
		"$(avatar_cleanup_marker_value runtime_stability_current_evidence_sha256)" == \
			"$avatar_cleanup_runtime_stability_current_sha" &&
		"$(avatar_cleanup_marker_value runtime_stability_current_signature_sha256)" == \
			"$avatar_cleanup_runtime_stability_current_signature_sha" &&
		"$(avatar_cleanup_marker_value current_client_binding_evidence_sha256)" == \
			"$avatar_cleanup_current_client_binding_sha" &&
		"$(avatar_cleanup_marker_value frontend_binding_sha256)" == "$avatar_cleanup_frontend_binding_sha" &&
		"$(avatar_cleanup_marker_value runtime_stable_since)" == "$avatar_cleanup_runtime_stable_since" ]] || return 1
	[[ "$(avatar_cleanup_marker_value pre_client_reference_zero_evidence_sha256)" == \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_pre_client_reference_zero_evidence")" &&
		"$(avatar_cleanup_marker_value client_ready_evidence_sha256)" == \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_historical_client_ready_body")" &&
		"$(avatar_cleanup_marker_value client_ready_signature_sha256)" == \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_historical_client_ready_signature")" &&
		"$(avatar_cleanup_marker_value predeploy_uploads_handoff_sha256)" == \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_predeploy_uploads_handoff")" &&
		"$(avatar_cleanup_marker_value cleanup_retarget_evidence_sha256)" == \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_cleanup_retarget_evidence")" ]] || return 1
	avatar_cleanup_require_signed_hash "$avatar_cleanup_client" \
		"$(avatar_cleanup_marker_value client_evidence_sha256)" || return 1
	avatar_cleanup_require_signed_hash "$avatar_cleanup_runtime" \
		"$(avatar_cleanup_marker_value runtime_evidence_sha256)" || return 1
	avatar_cleanup_require_signed_hash "$avatar_cleanup_manifest" \
		"$(avatar_cleanup_marker_value manifest_evidence_sha256)" || return 1
	avatar_cleanup_require_signed_hash "$avatar_cleanup_references" \
		"$(avatar_cleanup_marker_value reference_evidence_sha256)" || return 1
	avatar_cleanup_require_signed_hash "$avatar_cleanup_observation" \
		"$(avatar_cleanup_marker_value observation_evidence_sha256)" || return 1
	avatar_cleanup_require_signed_hash "$avatar_cleanup_identity_backup" \
		"$(avatar_cleanup_marker_value identity_backup_sha256)" || return 1
	avatar_cleanup_require_signed_hash "$avatar_cleanup_identity_restore" \
		"$(avatar_cleanup_marker_value identity_restore_evidence_sha256)" || return 1
	if [[ "$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" != 'pending' ]]; then
		avatar_cleanup_require_signed_hash "$avatar_cleanup_writer_fence" \
			"$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" || return 1
		local writer_phase
		writer_phase="$(avatar_cleanup_writer_evidence_phase)" || return 1
		avatar_cleanup_validate_writer_evidence_payload "$writer_phase" || return 1
		if [[ "$writer_phase" == 'prepared' ]]; then
			[[ "$(avatar_cleanup_marker_value phase)" == 'forward-only' &&
				"$(avatar_cleanup_marker_value retirement_evidence_sha256)" == 'pending' ]] || return 1
		fi
	fi
	if [[ "$(avatar_cleanup_marker_value retirement_evidence_sha256)" != 'pending' ]]; then
		avatar_cleanup_require_signed_hash "$avatar_cleanup_retirement" \
			"$(avatar_cleanup_marker_value retirement_evidence_sha256)" || return 1
		avatar_cleanup_require_ownership_artifacts || return 1
		avatar_cleanup_validate_retirement_evidence || return 1
	fi
	if [[ "$(avatar_cleanup_marker_value revocation_evidence_sha256)" != 'pending' ]]; then
		avatar_cleanup_require_signed_hash "$avatar_cleanup_revocation" \
			"$(avatar_cleanup_marker_value revocation_evidence_sha256)" || return 1
		avatar_cleanup_validate_revocation_evidence || return 1
	fi
	if [[ "$(avatar_cleanup_marker_value nginx_evidence_sha256)" != 'pending' ]]; then
		avatar_cleanup_require_signed_hash "$avatar_cleanup_nginx" \
			"$(avatar_cleanup_marker_value nginx_evidence_sha256)" || return 1
		avatar_cleanup_validate_nginx_evidence || return 1
	fi
	if [[ "$(avatar_cleanup_marker_value smoke_evidence_sha256)" != 'pending' ]]; then
		avatar_cleanup_require_signed_hash "$avatar_cleanup_smoke" \
			"$(avatar_cleanup_marker_value smoke_evidence_sha256)" || return 1
		avatar_cleanup_validate_smoke_evidence_payload || return 1
	fi
	if [[ "$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" != 'pending' ]]; then
		[[ "$(avatar_cleanup_sha256 "$avatar_cleanup_complete_body")" == \
			"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" &&
			"$(avatar_cleanup_sha256 "$avatar_cleanup_complete_signature")" == \
			"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)" ]] || return 1
		avatar_cleanup_validate_cleanup_complete_signature || return 1
	fi
	if [[ "$(avatar_cleanup_marker_value lifecycle_key_retirement_evidence_sha256)" != 'pending' ]]; then
		avatar_cleanup_require_signed_hash "$avatar_cleanup_lifecycle_key_retirement" \
			"$(avatar_cleanup_marker_value lifecycle_key_retirement_evidence_sha256)" || return 1
		avatar_cleanup_validate_lifecycle_key_retirement_evidence || return 1
	fi
}

avatar_cleanup_verify() {
	avatar_cleanup_require_common
	acquire_production_deploy_lock 'Avatar Core source cleanup verification'
	avatar_cleanup_validate_inherited_lifecycle_bundle ||
		avatar_cleanup_fail 'predeploy uploads handoff or cleanup retarget evidence is invalid' || return 1
	if [[ -e "$avatar_cleanup_marker" || -L "$avatar_cleanup_marker" ]]; then
		avatar_cleanup_validate_marker ||
			avatar_cleanup_fail 'existing avatar cleanup marker is invalid' || return 1
		case "$(avatar_cleanup_marker_value phase)" in
		verified)
			avatar_cleanup_require_verified_evidence ||
				avatar_cleanup_fail 'verified avatar cleanup evidence drifted' || return 1
			avatar_cleanup_validate_current_soak_contract >/dev/null ||
				avatar_cleanup_fail 'signed seven-day observation no longer validates' || return 1
			printf 'avatar_core_cleanup_phase=verified\n'
			return
			;;
		forward-only | complete)
			avatar_cleanup_fail 'cleanup already crossed the forward-only boundary; use deploy/forward-recovery'
			return 1
			;;
		esac
	fi
	avatar_cleanup_capture_runtime_evidence
	avatar_cleanup_capture_client_evidence
	avatar_cleanup_capture_signed_observation_evidence
	avatar_cleanup_capture_manifest
	avatar_cleanup_capture_reference_evidence
	avatar_cleanup_capture_identity_backup_and_restore
	avatar_cleanup_write_marker verified \
		"$AVATAR_OWNERSHIP_REVISION" "$EXPECTED_REVISION" "$AVATAR_CLIENT_REVISION" \
		"$avatar_cleanup_identity_api_image_id" "$avatar_cleanup_identity_worker_image_id" \
		"$avatar_cleanup_identity_outbox_image_id" "$avatar_cleanup_core_source_image_id" \
		"$avatar_cleanup_candidate_image_id" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_client")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_pre_client_reference_zero_evidence")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_historical_client_ready_body")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_historical_client_ready_signature")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_predeploy_uploads_handoff")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_cleanup_retarget_evidence")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_runtime")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_manifest")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_references")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_observation")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_identity_backup")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_identity_restore")" \
		pending pending pending pending pending pending pending pending \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'avatar_core_cleanup_phase=verified\n'
}

avatar_cleanup_update_forward_marker() {
	[[ ($# -eq 8 || $# -eq 9) && "$1" =~ ^(forward-only|complete)$ ]] || return 1
	local lifecycle_retirement_sha
	lifecycle_retirement_sha="${9:-$(avatar_cleanup_marker_value lifecycle_key_retirement_evidence_sha256)}" || return 1
	avatar_cleanup_write_marker "$1" \
		"$(avatar_cleanup_marker_value ownership_revision)" \
		"$(avatar_cleanup_marker_value cleanup_revision)" \
		"$(avatar_cleanup_marker_value current_client_revision)" \
		"$(avatar_cleanup_marker_value identity_api_image_id)" \
		"$(avatar_cleanup_marker_value identity_worker_image_id)" \
		"$(avatar_cleanup_marker_value identity_outbox_image_id)" \
		"$(avatar_cleanup_marker_value core_source_image_id)" \
		"$(avatar_cleanup_marker_value core_cleanup_image_id)" \
		"$(avatar_cleanup_marker_value client_evidence_sha256)" \
		"$(avatar_cleanup_marker_value pre_client_reference_zero_evidence_sha256)" \
		"$(avatar_cleanup_marker_value client_ready_evidence_sha256)" \
		"$(avatar_cleanup_marker_value client_ready_signature_sha256)" \
		"$(avatar_cleanup_marker_value predeploy_uploads_handoff_sha256)" \
		"$(avatar_cleanup_marker_value cleanup_retarget_evidence_sha256)" \
		"$(avatar_cleanup_marker_value runtime_evidence_sha256)" \
		"$(avatar_cleanup_marker_value manifest_evidence_sha256)" \
		"$(avatar_cleanup_marker_value reference_evidence_sha256)" \
		"$(avatar_cleanup_marker_value observation_evidence_sha256)" \
		"$(avatar_cleanup_marker_value identity_backup_sha256)" \
		"$(avatar_cleanup_marker_value identity_restore_evidence_sha256)" \
		"$2" "$3" "$4" "$5" "$6" "$7" "$8" "$lifecycle_retirement_sha" \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

avatar_cleanup_load_observation_timer_binding() {
	avatar_cleanup_require_signed_hash "$avatar_cleanup_observation" \
		"$(avatar_cleanup_marker_value observation_evidence_sha256)" || return 1
	local fields
	fields="$(OBSERVATION_FILE="$avatar_cleanup_observation" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
		RUNTIME_REVISION="$avatar_cleanup_runtime_revision" \
		INITIAL_CLIENT_REVISION="$avatar_cleanup_initial_client_revision" CLIENT_REVISION="$AVATAR_CLIENT_REVISION" \
		RUNTIME_STABILITY_GENERATION="$avatar_cleanup_runtime_stability_generation" \
		RUNTIME_STABILITY_SHA="$avatar_cleanup_runtime_stability_evidence_sha" \
		RUNTIME_STABLE_SINCE="$avatar_cleanup_runtime_stable_since" \
		CLIENT_RETARGET_SHA="$(avatar_cleanup_ownership_marker_value client_retarget_evidence_sha256)" \
		RUNTIME_RETARGET_SHA="$(avatar_cleanup_ownership_marker_value runtime_retarget_evidence_sha256)" node <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.OBSERVATION_FILE, 'utf8'));
const keys = [
		  'version','action','ownershipRevision','cleanupRevision','currentRuntimeRevision','initialClientRevision',
	  'clientRevision','runtimeStabilityGeneration','runtimeStabilityEvidenceSha256','runtimeStableSince',
	  'clientEvidenceSha256','clientRetargetEvidenceSha256','runtimeRetargetEvidenceSha256',
	  'resetAnchorSha256','clientReleaseEvidenceSha256','clientProcessStartedAt',
	  'writerFenceEvidenceSha256','storagePolicyEvidenceSha256','inventoryManifestSha256','statusManifestSha256',
  'revocationEvidenceSha256','authenticatedSmokeEvidenceSha256','soakEvidenceSha256','observationBoundaryAt',
  'finalHeartbeatCount','currentHeartbeatCount','finalLastHeartbeatSha256','currentLastHeartbeatSha256',
  'frontendLastSequence','frontendLastEvidenceSha256','frontendLastEvidenceSignatureSha256',
  'frontendLogConfigurationSha256','frontendObservedThrough','backendLogSetSha256','backendObservedThrough',
  'backendTimerStatusSha256','backendTimerRecordedAt','backendTimerServiceSha256','backendTimerUnitSha256',
  'heartbeatTreeSha256','frontendArchiveTreeSha256','maximumGapSeconds','requiredSeconds','signaturesVerified',
  'runtimeContinuityVerified','frontendLogContinuityVerified','backendLogContinuityVerified','legacyApiCallsZero',
  'successfulUploadsGetHeadZero','verifiedAt',
];
const sha = input => typeof input === 'string' && /^[0-9a-f]{64}$/.test(input);
	const date = input => typeof input === 'string' && Number.isFinite(Date.parse(input)) &&
	  new Date(Date.parse(input)).toISOString() === input;
	if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys) || value.version !== 1 ||
	    value.action !== 'avatar-signed-cross-host-seven-day-observation' ||
	    value.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
	    value.cleanupRevision !== process.env.CLEANUP_REVISION ||
	    value.currentRuntimeRevision !== process.env.RUNTIME_REVISION ||
	    value.initialClientRevision !== process.env.INITIAL_CLIENT_REVISION ||
	    value.clientRevision !== process.env.CLIENT_REVISION ||
	    value.runtimeStabilityGeneration !== Number(process.env.RUNTIME_STABILITY_GENERATION) ||
	    value.runtimeStabilityEvidenceSha256 !== process.env.RUNTIME_STABILITY_SHA ||
	    value.runtimeStableSince !== process.env.RUNTIME_STABLE_SINCE ||
	    value.clientRetargetEvidenceSha256 !== process.env.CLIENT_RETARGET_SHA ||
	    value.runtimeRetargetEvidenceSha256 !== process.env.RUNTIME_RETARGET_SHA ||
	    !sha(value.resetAnchorSha256) || !sha(value.clientReleaseEvidenceSha256) ||
	    !date(value.clientProcessStartedAt) ||
    !sha(value.backendTimerStatusSha256) || !sha(value.backendTimerServiceSha256) ||
    !sha(value.backendTimerUnitSha256) || !date(value.backendTimerRecordedAt) || !date(value.verifiedAt) ||
    value.requiredSeconds !== 604800 || value.signaturesVerified !== true ||
    value.runtimeContinuityVerified !== true || value.frontendLogContinuityVerified !== true ||
    value.backendLogContinuityVerified !== true || value.legacyApiCallsZero !== true ||
    value.successfulUploadsGetHeadZero !== true) process.exit(1);
process.stdout.write([value.backendTimerServiceSha256, value.backendTimerUnitSha256,
  value.backendTimerStatusSha256, value.backendTimerRecordedAt, value.verifiedAt].join('\t'));
NODE
)" || return 1
	IFS=$'\t' read -r avatar_cleanup_observed_timer_service_sha avatar_cleanup_observed_timer_unit_sha \
		avatar_cleanup_observed_timer_status_sha avatar_cleanup_observed_timer_recorded_at \
		avatar_cleanup_observation_verified_at <<<"$fields"
	[[ "$avatar_cleanup_observed_timer_service_sha" =~ ^[0-9a-f]{64}$ &&
		"$avatar_cleanup_observed_timer_unit_sha" =~ ^[0-9a-f]{64}$ &&
		"$avatar_cleanup_observed_timer_status_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	avatar_cleanup_observation_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_observation")" || return 1
}

avatar_cleanup_load_current_soak_timer_status() {
	[[ $# -eq 1 ]] || return 1
	local upper_bound="$1"
	local status_file="$avatar_cleanup_generation_timer_status_file"
	avatar_cleanup_validate_private_file "$status_file" || return 1
	local script_sha fields
	script_sha="$(avatar_cleanup_sha256 "$SERVER_ROOT/scripts/identity-avatar-media-production.sh")" || return 1
	fields="$(TIMER_STATUS_FILE="$status_file" RUNTIME_REVISION="$avatar_cleanup_runtime_revision" \
		SCRIPT_SHA="$script_sha" UPPER_BOUND="$upper_bound" node <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.TIMER_STATUS_FILE, 'utf8'));
const keys = ['version','kind','revision','scriptSha256','outcome','recordedAt'];
const recordedAt = Date.parse(value.recordedAt);
const upperBound = Date.parse(process.env.UPPER_BOUND);
if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys) || value.version !== 1 ||
	    value.kind !== 'identity-avatar-soak-timer-status' || value.revision !== process.env.RUNTIME_REVISION ||
    value.scriptSha256 !== process.env.SCRIPT_SHA || value.outcome !== 'passed' ||
    !Number.isFinite(recordedAt) || !Number.isFinite(upperBound) || recordedAt > upperBound ||
    upperBound - recordedAt > 93600000) process.exit(1);
process.stdout.write(value.recordedAt);
NODE
)" || return 1
	avatar_cleanup_current_timer_status_file="$status_file"
	avatar_cleanup_current_timer_status_sha="$(avatar_cleanup_sha256 "$status_file")" || return 1
	avatar_cleanup_current_timer_status_recorded_at="$fields"
}

avatar_cleanup_systemd_state() {
	[[ $# -eq 2 && "$1" =~ ^(is-enabled|is-active)$ ]] || return 1
	local state
	state="$(systemctl "$1" "$2" 2>/dev/null || true)"
	[[ "$state" != *$'\n'* && -n "$state" ]] || return 1
	printf '%s' "$state"
}

avatar_cleanup_validate_soak_timer_fence_payload() {
	avatar_cleanup_validate_private_file "$avatar_cleanup_soak_timer_fence" || return 1
	avatar_cleanup_load_observation_timer_binding || return 1
	local fence_fields forward_at
	forward_at="$(FENCE_FILE="$avatar_cleanup_soak_timer_fence" node -e '
const value=JSON.parse(require("node:fs").readFileSync(process.env.FENCE_FILE,"utf8"));
process.stdout.write(typeof value.forwardMarkerUpdatedAt === "string" ? value.forwardMarkerUpdatedAt : "");
')" || return 1
	avatar_cleanup_load_current_soak_timer_status "$forward_at" || return 1
	[[ -f "$avatar_cleanup_soak_timer_service" && ! -L "$avatar_cleanup_soak_timer_service" &&
		"$(avatar_cleanup_stat_identity "$avatar_cleanup_soak_timer_service")" == '0:0:644' &&
		"$(stat -c '%h' "$avatar_cleanup_soak_timer_service")" == '1' &&
		-f "$avatar_cleanup_soak_timer_unit" && ! -L "$avatar_cleanup_soak_timer_unit" &&
		"$(avatar_cleanup_stat_identity "$avatar_cleanup_soak_timer_unit")" == '0:0:644' &&
		"$(stat -c '%h' "$avatar_cleanup_soak_timer_unit")" == '1' &&
		"$(avatar_cleanup_sha256 "$avatar_cleanup_soak_timer_service")" == "$avatar_cleanup_observed_timer_service_sha" &&
		"$(avatar_cleanup_sha256 "$avatar_cleanup_soak_timer_unit")" == "$avatar_cleanup_observed_timer_unit_sha" ]] || return 1
	fence_fields="$(FENCE_FILE="$avatar_cleanup_soak_timer_fence" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
		OBSERVATION_SHA="$avatar_cleanup_observation_sha" OBSERVATION_VERIFIED_AT="$avatar_cleanup_observation_verified_at" \
		SERVICE_SHA="$avatar_cleanup_observed_timer_service_sha" UNIT_SHA="$avatar_cleanup_observed_timer_unit_sha" \
		STATUS_SHA="$avatar_cleanup_current_timer_status_sha" STATUS_RECORDED_AT="$avatar_cleanup_current_timer_status_recorded_at" \
		node <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.FENCE_FILE, 'utf8'));
const keys = ['version','action','ownershipRevision','cleanupRevision','observationEvidenceSha256',
  'timerServiceSha256','timerUnitSha256','timerStatusSha256','timerStatusRecordedAt','forwardMarkerUpdatedAt',
  'initialEnabledState','initialActiveState','finalEnabledState','finalActiveState','serviceActiveState','fencedAt'];
const forwardAt = Date.parse(value.forwardMarkerUpdatedAt);
const fencedAt = Date.parse(value.fencedAt);
const statusAt = Date.parse(value.timerStatusRecordedAt);
const observationAt = Date.parse(process.env.OBSERVATION_VERIFIED_AT);
const initialAllowed = (value.initialEnabledState === 'enabled' && value.initialActiveState === 'active') ||
  (value.initialEnabledState === 'disabled' && value.initialActiveState === 'inactive');
if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys) || value.version !== 1 ||
    value.action !== 'avatar-backend-soak-timer-fence' || value.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION || value.observationEvidenceSha256 !== process.env.OBSERVATION_SHA ||
    value.timerServiceSha256 !== process.env.SERVICE_SHA || value.timerUnitSha256 !== process.env.UNIT_SHA ||
    value.timerStatusSha256 !== process.env.STATUS_SHA || value.timerStatusRecordedAt !== process.env.STATUS_RECORDED_AT ||
    !initialAllowed || value.finalEnabledState !== 'disabled' || value.finalActiveState !== 'inactive' ||
    value.serviceActiveState !== 'inactive' || !Number.isFinite(forwardAt) || !Number.isFinite(fencedAt) ||
    !Number.isFinite(statusAt) || !Number.isFinite(observationAt) || observationAt > forwardAt ||
    statusAt > forwardAt || forwardAt - statusAt > 93600000 || forwardAt > fencedAt ||
    fencedAt > Date.now() + 120000) process.exit(1);
process.stdout.write(`${value.finalEnabledState}\t${value.finalActiveState}\t${value.serviceActiveState}`);
NODE
)" || return 1
	[[ "$fence_fields" == $'disabled\tinactive\tinactive' &&
		"$(avatar_cleanup_systemd_state is-enabled winwidget-identity-avatar-soak-heartbeat.timer)" == 'disabled' &&
		"$(avatar_cleanup_systemd_state is-active winwidget-identity-avatar-soak-heartbeat.timer)" == 'inactive' &&
		"$(avatar_cleanup_systemd_state is-active winwidget-identity-avatar-soak-heartbeat.service)" == 'inactive' ]] || return 1
}

avatar_cleanup_validate_soak_timer_fence_evidence() {
	avatar_cleanup_verify_artifact "$avatar_cleanup_soak_timer_fence" || return 1
	avatar_cleanup_validate_soak_timer_fence_payload
}

avatar_cleanup_fence_soak_timer() {
	[[ "$(avatar_cleanup_marker_value phase)" == 'forward-only' ]] || return 1
	if [[ -e "$avatar_cleanup_soak_timer_fence" || -L "$avatar_cleanup_soak_timer_fence" ]]; then
		if [[ ! -e "${avatar_cleanup_soak_timer_fence}.hmac-sha256" &&
			! -L "${avatar_cleanup_soak_timer_fence}.hmac-sha256" ]]; then
			avatar_cleanup_validate_soak_timer_fence_payload || return 1
			avatar_cleanup_sign_artifact "$avatar_cleanup_soak_timer_fence" || return 1
		fi
		avatar_cleanup_validate_soak_timer_fence_evidence ||
			avatar_cleanup_fail 'backend soak timer fence evidence is invalid or live timer was re-enabled' || return 1
		return
	fi
	avatar_cleanup_validate_writer_evidence_payload prepared || return 1
	avatar_cleanup_load_observation_timer_binding || return 1
	[[ -f "$avatar_cleanup_soak_timer_service" && ! -L "$avatar_cleanup_soak_timer_service" &&
		"$(avatar_cleanup_stat_identity "$avatar_cleanup_soak_timer_service")" == '0:0:644' &&
		"$(stat -c '%h' "$avatar_cleanup_soak_timer_service")" == '1' &&
		-f "$avatar_cleanup_soak_timer_unit" && ! -L "$avatar_cleanup_soak_timer_unit" &&
		"$(avatar_cleanup_stat_identity "$avatar_cleanup_soak_timer_unit")" == '0:0:644' &&
		"$(stat -c '%h' "$avatar_cleanup_soak_timer_unit")" == '1' &&
		"$(avatar_cleanup_sha256 "$avatar_cleanup_soak_timer_service")" == "$avatar_cleanup_observed_timer_service_sha" &&
		"$(avatar_cleanup_sha256 "$avatar_cleanup_soak_timer_unit")" == "$avatar_cleanup_observed_timer_unit_sha" ]] ||
		avatar_cleanup_fail 'backend soak timer units drifted before the forward-only fence' || return 1
	local forward_at initial_enabled initial_active service_active final_enabled final_active temporary
	forward_at="$(avatar_cleanup_marker_value updated_at)" || return 1
	avatar_cleanup_load_current_soak_timer_status "$forward_at" ||
		avatar_cleanup_fail 'last successful backend soak timer status is not bound to the forward marker' || return 1
	initial_enabled="$(avatar_cleanup_systemd_state is-enabled winwidget-identity-avatar-soak-heartbeat.timer)" || return 1
	initial_active="$(avatar_cleanup_systemd_state is-active winwidget-identity-avatar-soak-heartbeat.timer)" || return 1
	service_active="$(avatar_cleanup_systemd_state is-active winwidget-identity-avatar-soak-heartbeat.service)" || return 1
	[[ "$service_active" == 'inactive' &&
		( ( "$initial_enabled" == 'enabled' && "$initial_active" == 'active' ) ||
		  ( "$initial_enabled" == 'disabled' && "$initial_active" == 'inactive' ) ) ]] ||
		avatar_cleanup_fail 'backend soak timer is in an ambiguous pre-fence state' || return 1
	if [[ "$initial_enabled" == 'enabled' ]]; then
		systemctl disable --now winwidget-identity-avatar-soak-heartbeat.timer >/dev/null || return 1
	fi
	final_enabled="$(avatar_cleanup_systemd_state is-enabled winwidget-identity-avatar-soak-heartbeat.timer)" || return 1
	final_active="$(avatar_cleanup_systemd_state is-active winwidget-identity-avatar-soak-heartbeat.timer)" || return 1
	service_active="$(avatar_cleanup_systemd_state is-active winwidget-identity-avatar-soak-heartbeat.service)" || return 1
	[[ "$final_enabled" == 'disabled' && "$final_active" == 'inactive' && "$service_active" == 'inactive' ]] ||
		avatar_cleanup_fail 'backend soak timer did not reach the durable disabled/inactive state' || return 1
	temporary="$avatar_cleanup_root/.soak-timer-fence.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	TIMER_FENCE_OUTPUT="$temporary" OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" \
		CLEANUP_REVISION="$EXPECTED_REVISION" OBSERVATION_SHA="$avatar_cleanup_observation_sha" \
		SERVICE_SHA="$avatar_cleanup_observed_timer_service_sha" UNIT_SHA="$avatar_cleanup_observed_timer_unit_sha" \
		STATUS_SHA="$avatar_cleanup_current_timer_status_sha" STATUS_RECORDED_AT="$avatar_cleanup_current_timer_status_recorded_at" \
		FORWARD_AT="$forward_at" INITIAL_ENABLED="$initial_enabled" INITIAL_ACTIVE="$initial_active" node <<'NODE' || return 1
const fs = require('node:fs');
const value = {
  version: 1,
  action: 'avatar-backend-soak-timer-fence',
  ownershipRevision: process.env.OWNERSHIP_REVISION,
  cleanupRevision: process.env.CLEANUP_REVISION,
  observationEvidenceSha256: process.env.OBSERVATION_SHA,
  timerServiceSha256: process.env.SERVICE_SHA,
  timerUnitSha256: process.env.UNIT_SHA,
  timerStatusSha256: process.env.STATUS_SHA,
  timerStatusRecordedAt: process.env.STATUS_RECORDED_AT,
  forwardMarkerUpdatedAt: process.env.FORWARD_AT,
  initialEnabledState: process.env.INITIAL_ENABLED,
  initialActiveState: process.env.INITIAL_ACTIVE,
  finalEnabledState: 'disabled',
  finalActiveState: 'inactive',
  serviceActiveState: 'inactive',
  fencedAt: new Date().toISOString(),
};
fs.writeFileSync(process.env.TIMER_FENCE_OUTPUT, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	avatar_cleanup_write_json_artifact "$avatar_cleanup_soak_timer_fence" "$temporary" || return 1
	rm -f -- "$temporary" || return 1
	avatar_cleanup_validate_soak_timer_fence_evidence || return 1
}

avatar_cleanup_write_writer_evidence() {
	[[ $# -eq 2 && "$1" =~ ^(prepared|stopped)$ && "$2" =~ ^[0-9a-f]{64}$ ]] || return 1
	local temporary="$avatar_cleanup_root/.writer.$$" stopped_at=null timer_fence_sha=pending
	if [[ "$1" == 'stopped' ]]; then
		avatar_cleanup_validate_soak_timer_fence_evidence || return 1
		timer_fence_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_soak_timer_fence")" || return 1
		stopped_at="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
	fi
	WRITER_OUTPUT="$temporary" WRITER_PHASE="$1" WRITER_CONTAINER="$2" \
		SOURCE_IMAGE="$(avatar_cleanup_marker_value core_source_image_id)" \
		CLEANUP_IMAGE="$(avatar_cleanup_marker_value core_cleanup_image_id)" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
		TIMER_FENCE_SHA="$timer_fence_sha" STOPPED_AT_JSON="$stopped_at" node <<'NODE' || return 1
const fs = require('node:fs');
const evidence = {
  version: 1,
  action: 'avatar-core-writer-fence',
  phase: process.env.WRITER_PHASE,
  ownershipRevision: process.env.OWNERSHIP_REVISION,
  cleanupRevision: process.env.CLEANUP_REVISION,
  legacyContainerId: process.env.WRITER_CONTAINER,
  legacyImageId: process.env.SOURCE_IMAGE,
  cleanupImageId: process.env.CLEANUP_IMAGE,
  soakTimerFenceEvidenceSha256: process.env.TIMER_FENCE_SHA,
  stoppedAt: JSON.parse(process.env.STOPPED_AT_JSON),
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(process.env.WRITER_OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -f -- "$temporary" "$avatar_cleanup_writer_fence" || return 1
	avatar_cleanup_fsync_file_and_parent "$avatar_cleanup_writer_fence" || return 1
	avatar_cleanup_sign_artifact "$avatar_cleanup_writer_fence" || return 1
}

avatar_cleanup_writer_evidence_phase() {
	avatar_cleanup_validate_private_file "$avatar_cleanup_writer_fence" || return 1
	WRITER_FILE="$avatar_cleanup_writer_fence" node -e '
const value=JSON.parse(require("node:fs").readFileSync(process.env.WRITER_FILE,"utf8"));
if (!/^(prepared|stopped)$/.test(value.phase || "")) process.exit(1);
process.stdout.write(value.phase);
'
}

avatar_cleanup_validate_writer_evidence_payload() {
	[[ $# -eq 1 && "$1" =~ ^(prepared|stopped)$ ]] || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_writer_fence" || return 1
	WRITER_FILE="$avatar_cleanup_writer_fence" RUNTIME_FILE="$avatar_cleanup_runtime" \
		EXPECTED_PHASE="$1" OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" \
		CLEANUP_REVISION="$EXPECTED_REVISION" SOURCE_IMAGE="$(avatar_cleanup_marker_value core_source_image_id)" \
		CLEANUP_IMAGE="$(avatar_cleanup_marker_value core_cleanup_image_id)" \
		TIMER_FENCE_FILE="$avatar_cleanup_soak_timer_fence" node <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.WRITER_FILE, 'utf8'));
const runtime = JSON.parse(fs.readFileSync(process.env.RUNTIME_FILE, 'utf8'));
const keys = ['version','action','phase','ownershipRevision','cleanupRevision','legacyContainerId','legacyImageId',
  'cleanupImageId','soakTimerFenceEvidenceSha256','stoppedAt','updatedAt'];
const expectedTimerSha = value.phase === 'prepared' ? 'pending' :
  require('node:crypto').createHash('sha256').update(fs.readFileSync(process.env.TIMER_FENCE_FILE)).digest('hex');
if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys) || value.version !== 1 ||
    value.action !== 'avatar-core-writer-fence' || value.phase !== process.env.EXPECTED_PHASE ||
    value.ownershipRevision !== process.env.OWNERSHIP_REVISION || value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    value.legacyContainerId !== runtime.services?.coreSourceApi?.containerId ||
    value.legacyImageId !== process.env.SOURCE_IMAGE || value.cleanupImageId !== process.env.CLEANUP_IMAGE ||
    value.soakTimerFenceEvidenceSha256 !== expectedTimerSha ||
    !Number.isFinite(Date.parse(value.updatedAt)) || Date.parse(value.updatedAt) > Date.now() + 300000 ||
    (value.phase === 'prepared' ? value.stoppedAt !== null :
      (!Number.isFinite(Date.parse(value.stoppedAt)) || Date.parse(value.stoppedAt) > Date.parse(value.updatedAt)))) process.exit(1);
NODE
	if [[ "$1" == 'stopped' ]]; then
		avatar_cleanup_validate_soak_timer_fence_evidence || return 1
	fi
}

avatar_cleanup_recover_writer_fence_marker() {
	[[ "$(avatar_cleanup_marker_value phase)" == 'forward-only' ]] || return 0
	[[ -f "$avatar_cleanup_writer_fence" && ! -L "$avatar_cleanup_writer_fence" ]] || return 0
	local marker_sha actual_sha
	marker_sha="$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" || return 1
	actual_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_writer_fence")" || return 1
	[[ "$actual_sha" != "$marker_sha" ]] || return 0
	avatar_cleanup_validate_writer_evidence_payload stopped ||
		avatar_cleanup_fail 'writer-fence evidence drift is not a valid stopped-state recovery' || return 1
	if ! avatar_cleanup_verify_artifact "$avatar_cleanup_writer_fence"; then
		avatar_cleanup_sign_artifact "$avatar_cleanup_writer_fence" || return 1
	fi
	avatar_cleanup_update_forward_marker forward-only "$actual_sha" \
		"$(avatar_cleanup_marker_value retirement_evidence_sha256)" \
		"$(avatar_cleanup_marker_value revocation_evidence_sha256)" \
		"$(avatar_cleanup_marker_value nginx_evidence_sha256)" \
		"$(avatar_cleanup_marker_value smoke_evidence_sha256)" \
		"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" \
		"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)" || return 1
}

avatar_cleanup_stop_legacy_writer() {
	local old_container phase writer_phase writer_sha running_container
	phase="$(avatar_cleanup_marker_value phase)"
	[[ "$phase" =~ ^(verified|forward-only)$ ]] || return 1
	old_container="$(RUNTIME_FILE="$avatar_cleanup_runtime" node -e '
const value=require(process.env.RUNTIME_FILE);process.stdout.write(value.services.coreSourceApi.containerId);
')" || return 1
	[[ "$old_container" =~ ^[0-9a-f]{64}$ ]] || return 1
	running_container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api 2>/dev/null || true)"
	[[ -z "$running_container" || "$running_container" =~ ^[0-9a-f]{64}$ ]] ||
		avatar_cleanup_fail 'Core writer runtime is ambiguous' || return 1
	if [[ "$phase" == 'verified' && "$running_container" != "$old_container" ]]; then
		avatar_cleanup_fail 'verified Core writer container changed or stopped before the durable fence' || return 1
	fi
	[[ -z "$running_container" || "$running_container" == "$old_container" ]] ||
		avatar_cleanup_fail 'an unbound Core writer container is running' || return 1
	if [[ "$phase" == 'verified' ]]; then
		avatar_cleanup_write_writer_evidence prepared "$old_container" || return 1
		writer_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_writer_fence")" || return 1
		avatar_cleanup_update_forward_marker forward-only "$writer_sha" \
			pending pending pending pending pending pending || return 1
	fi
	writer_phase="$(avatar_cleanup_writer_evidence_phase)" || return 1
	avatar_cleanup_validate_writer_evidence_payload "$writer_phase" || return 1
	if [[ "$writer_phase" == 'stopped' ]]; then
		[[ -z "$running_container" ]] ||
			avatar_cleanup_fail 'legacy Core writer restarted after the durable stopped evidence' || return 1
		return
	fi
	avatar_cleanup_fence_soak_timer || return 1
	if [[ "$running_container" == "$old_container" ]]; then
		[[ "$(docker inspect --format '{{.Image}}' "$old_container")" == \
			"$(avatar_cleanup_marker_value core_source_image_id)" ]] ||
			avatar_cleanup_fail 'legacy Core writer container identity drifted' || return 1
		docker stop --time 30 "$old_container" >/dev/null || return 1
		[[ "$(docker inspect --format '{{.State.Running}}' "$old_container")" == 'false' ]] || return 1
	fi
	running_container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api 2>/dev/null || true)"
	[[ -z "$running_container" ]] || avatar_cleanup_fail 'Core writer remained running after the fence' || return 1
	avatar_cleanup_write_writer_evidence stopped "$old_container" || return 1
	writer_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_writer_fence")" || return 1
	avatar_cleanup_update_forward_marker forward-only "$writer_sha" \
		"$(avatar_cleanup_marker_value retirement_evidence_sha256)" \
		"$(avatar_cleanup_marker_value revocation_evidence_sha256)" \
		"$(avatar_cleanup_marker_value nginx_evidence_sha256)" \
		"$(avatar_cleanup_marker_value smoke_evidence_sha256)" \
		"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" \
		"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)" || return 1
}

avatar_cleanup_start_clean_core() {
	local expected_image_id container image revision health restart adopted=false
	expected_image_id="$(avatar_cleanup_marker_value core_cleanup_image_id)"
	[[ "$(docker image inspect --format '{{.Id}}' "winwidget-api:git-$EXPECTED_REVISION")" == "$expected_image_id" ]] ||
		avatar_cleanup_fail 'verified cleanup Core image is absent or drifted' || return 1
	container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api 2>/dev/null || true)"
	if [[ "$container" =~ ^[0-9a-f]{64}$ &&
		"$(docker inspect --format '{{.Image}}' "$container")" == "$expected_image_id" ]]; then
		image="$expected_image_id"
		adopted=true
	else
		[[ -z "$container" ]] || avatar_cleanup_fail 'an unexpected Core API is running after the forward-only fence' || return 1
		identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build --force-recreate api
		container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			ps --status running -q api)" || return 1
		[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
		image="$(docker inspect --format '{{.Image}}' "$container")" || return 1
	fi
	revision="$(docker image inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' "$image")" || return 1
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" || return 1
	restart="$(docker inspect --format '{{.RestartCount}}' "$container")" || return 1
	[[ "$image" == "$expected_image_id" && "$revision" == "$EXPECTED_REVISION" && "$health" == 'healthy' &&
		( ( "$adopted" == 'false' && "$restart" == '0' ) ||
		  ( "$adopted" == 'true' && "$restart" =~ ^(0|[1-9][0-9]*)$ ) ) ]] ||
		avatar_cleanup_fail 'cleanup Core is not the exact healthy cleanup image' || return 1
	identity_cutover_wait_url http://127.0.0.1:4200/api/v1/health/ready 'clean Core API'
}

avatar_cleanup_capture_clean_core_runtime() {
	avatar_cleanup_validate_writer_evidence_payload stopped || return 1
	avatar_cleanup_verify_artifact "$avatar_cleanup_writer_fence" || return 1
	[[ "$(avatar_cleanup_sha256 "$avatar_cleanup_writer_fence")" == \
		"$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" ]] || return 1
	local container image revision health restart started_at expected_image
	container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
	image="$(docker inspect --format '{{.Image}}' "$container")" || return 1
	revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" || return 1
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" || return 1
	restart="$(docker inspect --format '{{.RestartCount}}' "$container")" || return 1
	started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container")" || return 1
	expected_image="$(avatar_cleanup_marker_value core_cleanup_image_id)" || return 1
	[[ "$image" == "$expected_image" && "$revision" == "$EXPECTED_REVISION" &&
		"$health" == 'healthy' && "$restart" =~ ^(0|[1-9][0-9]*)$ &&
		"$started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$ ]] ||
		avatar_cleanup_fail 'cleanup Core runtime is not the exact healthy writer-fenced runtime' || return 1
	CORE_CONTAINER="$container" CORE_IMAGE="$image" CORE_REVISION="$revision" \
		CORE_STARTED_AT="$started_at" CORE_RESTART="$restart" CORE_HEALTH="$health" node -e '
const value={containerId:process.env.CORE_CONTAINER,imageId:process.env.CORE_IMAGE,
  ociRevision:process.env.CORE_REVISION,startedAt:process.env.CORE_STARTED_AT,
  restartCount:Number(process.env.CORE_RESTART),health:process.env.CORE_HEALTH};
process.stdout.write(JSON.stringify(value));'
}

avatar_cleanup_validate_smoke_evidence_payload() {
	avatar_cleanup_verify_artifact "$avatar_cleanup_smoke" || return 1
	SMOKE_FILE="$avatar_cleanup_smoke" CLEANUP_REVISION="$EXPECTED_REVISION" \
		WRITER_FENCE_SHA="$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
		CORE_IMAGE_ID="$(avatar_cleanup_marker_value core_cleanup_image_id)" node <<'NODE'
const fs=require('node:fs');
let value;try{value=JSON.parse(fs.readFileSync(process.env.SMOKE_FILE,'utf8'));}catch{process.exit(1);}
const keys=['version','action','cleanupRevision','writerFenceEvidenceSha256','coreRuntime','checks','verifiedAt'];
const runtimeKeys=['containerId','imageId','ociRevision','startedAt','restartCount','health'];
const runtime=value?.coreRuntime;
const timestamp=item=>typeof item==='string'&&Number.isFinite(Date.parse(item))&&Date.parse(item)<=Date.now()+300000;
if(JSON.stringify(Object.keys(value||{}))!==JSON.stringify(keys)||value.version!==1||
  value.action!=='avatar-core-cleanup-smoke'||value.cleanupRevision!==process.env.CLEANUP_REVISION||
  value.writerFenceEvidenceSha256!==process.env.WRITER_FENCE_SHA||
  !/^[0-9a-f]{64}$/.test(value.writerFenceEvidenceSha256||'')||
  JSON.stringify(Object.keys(runtime||{}))!==JSON.stringify(runtimeKeys)||
  !/^[0-9a-f]{64}$/.test(runtime.containerId||'')||runtime.imageId!==process.env.CORE_IMAGE_ID||
  !/^sha256:[0-9a-f]{64}$/.test(runtime.imageId||'')||runtime.ociRevision!==process.env.CLEANUP_REVISION||
  !timestamp(runtime.startedAt)||!Number.isSafeInteger(runtime.restartCount)||runtime.restartCount<0||
  runtime.health!=='healthy'||!Array.isArray(value.checks)||value.checks.length!==27||!timestamp(value.verifiedAt))process.exit(1);
NODE
}

avatar_cleanup_smoke_core_runtime() {
	avatar_cleanup_validate_smoke_evidence_payload || return 1
	SMOKE_FILE="$avatar_cleanup_smoke" node -e '
const value=JSON.parse(require("node:fs").readFileSync(process.env.SMOKE_FILE,"utf8"));
process.stdout.write(JSON.stringify(value.coreRuntime));'
}

avatar_cleanup_assert_completion_runtime_fence() {
	[[ $# -eq 1 ]] || return 1
	local expected_core="$1" actual_core
	avatar_cleanup_assert_public_client_revision forward || return 1
	avatar_cleanup_assert_forward_identity_runtime || return 1
	actual_core="$(avatar_cleanup_capture_clean_core_runtime)" || return 1
	[[ "$actual_core" == "$expected_core" ]] ||
		avatar_cleanup_fail 'cleanup Core runtime tuple drifted inside the final completion fence' || return 1
}

avatar_cleanup_install_nginx() {
	local source="$SERVER_ROOT/deploy/nginx.conf"
	local target="${AVATAR_NGINX_TARGET:-/etc/nginx/sites-available/api.winwidget.ru}"
	local enabled="${AVATAR_NGINX_ENABLED:-/etc/nginx/sites-enabled/api.winwidget.ru}"
	local staged="${target}.avatar-cleanup-stage"
	local backup="${target}.avatar-cleanup-previous"
	local restore_stage="${target}.avatar-cleanup-restore"
	local source_sha target_sha previous_sha phase='installed' temporary="$avatar_cleanup_root/.nginx.$$"
	[[ -f "$source" && ! -L "$source" && -f "$target" && ! -L "$target" &&
		-L "$enabled" && "$(readlink -f "$enabled")" == "$target" ]] ||
		avatar_cleanup_fail 'nginx source/live boundary is unsafe' || return 1
	if [[ -e "$backup" || -L "$backup" ]]; then
		[[ -f "$backup" && ! -L "$backup" && "$(avatar_cleanup_stat_identity "$backup")" == '0:0:600' ]] ||
			avatar_cleanup_fail 'nginx cleanup backup is unsafe' || return 1
	fi
	if [[ -e "$staged" || -L "$staged" ]]; then
		[[ -f "$staged" && ! -L "$staged" && "$(avatar_cleanup_stat_identity "$staged")" == '0:0:644' ]] ||
			avatar_cleanup_fail 'nginx cleanup candidate staging file is unsafe' || return 1
	fi
	source_sha="$(avatar_cleanup_sha256 "$source")"
	target_sha="$(avatar_cleanup_sha256 "$target")"
	if [[ -e "$restore_stage" || -L "$restore_stage" ]]; then
		[[ -f "$restore_stage" && ! -L "$restore_stage" &&
			"$(avatar_cleanup_stat_identity "$restore_stage")" == '0:0:644' &&
			-f "$backup" && "$(avatar_cleanup_sha256 "$restore_stage")" == "$(avatar_cleanup_sha256 "$backup")" &&
			"$target_sha" == "$source_sha" ]] ||
			avatar_cleanup_fail 'ambiguous nginx rollback crash-recovery state' || return 1
		mv -fT "$restore_stage" "$target" || return 1
		avatar_cleanup_fsync_file_and_parent "$target" || return 1
		nginx -t && systemctl reload nginx && systemctl is-active --quiet nginx ||
			avatar_cleanup_fail 'nginx rollback crash recovery failed' || return 1
		rm -f -- "$staged" "$backup" || return 1
		avatar_cleanup_fsync_directory "$(dirname -- "$target")" || return 1
		avatar_cleanup_fail 'recovered an interrupted nginx rollback; rerun cleanup deployment'
		return 1
	fi
	if [[ "$target_sha" == "$source_sha" ]]; then
		if [[ -e "$staged" || -L "$staged" ]]; then
			[[ -f "$backup" && "$(avatar_cleanup_sha256 "$staged")" == "$(avatar_cleanup_sha256 "$backup")" ]] ||
				avatar_cleanup_fail 'ambiguous nginx crash-recovery state' || return 1
		fi
		previous_sha="$(if [[ -f "$backup" ]]; then avatar_cleanup_sha256 "$backup"; else printf '%s' "$target_sha"; fi)"
		if ! nginx -t; then
			[[ -f "$backup" ]] || avatar_cleanup_fail 'installed cleanup nginx config is invalid and has no exact rollback copy' || return 1
			install -o root -g root -m 644 "$backup" "$restore_stage" || return 1
			avatar_cleanup_fsync_file_and_parent "$restore_stage" || return 1
			mv -fT "$restore_stage" "$target" || return 1
			avatar_cleanup_fsync_file_and_parent "$target" || return 1
			nginx -t && systemctl reload nginx && systemctl is-active --quiet nginx ||
				avatar_cleanup_fail 'nginx config recovery failed' || return 1
			rm -f -- "$staged" "$backup" || return 1
			avatar_cleanup_fsync_directory "$(dirname -- "$target")" || return 1
			avatar_cleanup_fail 'cleanup nginx candidate failed validation and only the config was rolled back'
			return 1
		fi
		if ! systemctl reload nginx; then
			[[ -f "$backup" ]] || avatar_cleanup_fail 'cleanup nginx reload failed without an exact rollback copy' || return 1
			install -o root -g root -m 644 "$backup" "$restore_stage" || return 1
			avatar_cleanup_fsync_file_and_parent "$restore_stage" || return 1
			mv -fT "$restore_stage" "$target" || return 1
			avatar_cleanup_fsync_file_and_parent "$target" || return 1
			nginx -t && systemctl reload nginx && systemctl is-active --quiet nginx ||
				avatar_cleanup_fail 'nginx restoration failed after reload error' || return 1
			rm -f -- "$staged" "$backup" || return 1
			avatar_cleanup_fsync_directory "$(dirname -- "$target")" || return 1
			avatar_cleanup_fail 'nginx reload failed and only the config was rolled back'
			return 1
		fi
		systemctl is-active --quiet nginx || return 1
		rm -f -- "$staged" "$backup" || return 1
		avatar_cleanup_fsync_directory "$(dirname -- "$target")" || return 1
		phase='reloaded-existing-or-recovered'
	else
		previous_sha="$target_sha"
		if [[ -f "$backup" ]]; then
			[[ "$(avatar_cleanup_sha256 "$backup")" == "$target_sha" ]] ||
				avatar_cleanup_fail 'nginx cleanup backup does not match the live pre-cleanup config' || return 1
		else
			install -o root -g root -m 600 "$target" "$backup" || return 1
			avatar_cleanup_fsync_file_and_parent "$backup" || return 1
		fi
		if [[ -f "$staged" ]]; then
			[[ "$(avatar_cleanup_sha256 "$staged")" == "$source_sha" ]] ||
				avatar_cleanup_fail 'nginx cleanup staged candidate drifted' || return 1
		else
			install -o root -g root -m 644 "$source" "$staged" || return 1
			avatar_cleanup_fsync_file_and_parent "$staged" || return 1
		fi
		mv -fT "$staged" "$target" || return 1
		avatar_cleanup_fsync_file_and_parent "$target" || return 1
		if ! nginx -t; then
			install -o root -g root -m 644 "$backup" "$restore_stage" || return 1
			avatar_cleanup_fsync_file_and_parent "$restore_stage" || return 1
			mv -fT "$restore_stage" "$target" || return 1
			avatar_cleanup_fsync_file_and_parent "$target" || return 1
			nginx -t && systemctl reload nginx && systemctl is-active --quiet nginx ||
				avatar_cleanup_fail 'nginx rollback validation/reload failed' || return 1
			rm -f -- "$backup" || return 1
			avatar_cleanup_fsync_directory "$(dirname -- "$target")" || return 1
			avatar_cleanup_fail 'cleanup nginx candidate failed validation and only the config was rolled back'
			return 1
		fi
		if ! systemctl reload nginx; then
			install -o root -g root -m 644 "$backup" "$restore_stage" || return 1
			avatar_cleanup_fsync_file_and_parent "$restore_stage" || return 1
			mv -fT "$restore_stage" "$target" || return 1
			avatar_cleanup_fsync_file_and_parent "$target" || return 1
			nginx -t && systemctl reload nginx && systemctl is-active --quiet nginx ||
				avatar_cleanup_fail 'nginx restoration failed after reload error' || return 1
			rm -f -- "$backup" || return 1
			avatar_cleanup_fsync_directory "$(dirname -- "$target")" || return 1
			avatar_cleanup_fail 'nginx reload failed and only the config was rolled back'
			return 1
		fi
		systemctl is-active --quiet nginx || return 1
		[[ "$(avatar_cleanup_sha256 "$target")" == "$source_sha" ]] || return 1
		rm -f -- "$backup" || return 1
		avatar_cleanup_fsync_directory "$(dirname -- "$target")" || return 1
	fi
	NGINX_OUTPUT="$temporary" NGINX_PHASE="$phase" SOURCE_SHA="$source_sha" PREVIOUS_SHA="$previous_sha" \
		CLEANUP_REVISION="$EXPECTED_REVISION" node <<'NODE'
const fs = require('node:fs');
const evidence = { version: 1, action: 'avatar-nginx-clean-route-install', phase: process.env.NGINX_PHASE,
  cleanupRevision: process.env.CLEANUP_REVISION, sourceSha256: process.env.SOURCE_SHA,
  previousSha256: process.env.PREVIOUS_SHA, validated: true, reloaded: true,
  completedAt: new Date().toISOString() };
fs.writeFileSync(process.env.NGINX_OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$temporary"; chown 0:0 "$temporary"
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -f -- "$temporary" "$avatar_cleanup_nginx" || return 1
	avatar_cleanup_fsync_file_and_parent "$avatar_cleanup_nginx" || return 1
	avatar_cleanup_sign_artifact "$avatar_cleanup_nginx"
}

avatar_cleanup_validate_nginx_evidence() {
	avatar_cleanup_verify_artifact "$avatar_cleanup_nginx" || return 1
	local source="$SERVER_ROOT/deploy/nginx.conf"
	local target="${AVATAR_NGINX_TARGET:-/etc/nginx/sites-available/api.winwidget.ru}"
	local enabled="${AVATAR_NGINX_ENABLED:-/etc/nginx/sites-enabled/api.winwidget.ru}"
	[[ -f "$source" && ! -L "$source" && -f "$target" && ! -L "$target" &&
		-L "$enabled" && "$(readlink -f "$enabled")" == "$target" &&
		"$(avatar_cleanup_sha256 "$source")" == "$(avatar_cleanup_sha256 "$target")" ]] || return 1
	NGINX_EVIDENCE="$avatar_cleanup_nginx" SOURCE_SHA="$(avatar_cleanup_sha256 "$source")" \
		CLEANUP_REVISION="$EXPECTED_REVISION" node <<'NODE' || return 1
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.NGINX_EVIDENCE, 'utf8'));
const keys = ['version','action','phase','cleanupRevision','sourceSha256','previousSha256','validated','reloaded','completedAt'];
if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys) || value.version !== 1 ||
    value.action !== 'avatar-nginx-clean-route-install' ||
    !['installed','reloaded-existing-or-recovered'].includes(value.phase) ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION || value.sourceSha256 !== process.env.SOURCE_SHA ||
    !/^[0-9a-f]{64}$/.test(value.previousSha256 || '') || value.validated !== true || value.reloaded !== true ||
    !Number.isFinite(Date.parse(value.completedAt)) || Date.parse(value.completedAt) > Date.now() + 300000) process.exit(1);
NODE
	nginx -t >/dev/null 2>&1 && systemctl is-active --quiet nginx
}

avatar_cleanup_http_status() {
	[[ $# -ge 2 && $# -le 3 ]] || return 1
	curl --silent --show-error --output /dev/null --max-time 15 \
		--request "$1" --write-out '%{http_code}' "${3:-$2}"
}

avatar_cleanup_capture_smokes() {
	local nonce temporary="$avatar_cleanup_root/.smoke.$$" results='' core_runtime
	nonce="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
	local method path actual
	actual="$(avatar_cleanup_http_status GET 'http://127.0.0.1:4200/api/v1/health/ready')"; [[ "$actual" == '200' ]] || return 1
	results+="GET direct-core /api/v1/health/ready $actual"$'\n'
	actual="$(avatar_cleanup_http_status GET 'http://127.0.0.1:4100/health/ready')"; [[ "$actual" == '200' ]] || return 1
	results+="GET direct-gateway /health/ready $actual"$'\n'
	actual="$(avatar_cleanup_http_status GET "$AVATAR_API_ORIGIN/api/v1/health/ready")"; [[ "$actual" == '200' ]] || return 1
	results+="GET public /api/v1/health/ready $actual"$'\n'
	for method in POST DELETE; do
		for path in /api/v1/users/profile/avatar /api/v1/users/user/00000000-0000-4000-8000-000000000000/avatar; do
			actual="$(avatar_cleanup_http_status "$method" "http://127.0.0.1:4900$path")"; [[ "$actual" == '401' ]] || return 1
			results+="$method direct-identity $path $actual"$'\n'
			actual="$(avatar_cleanup_http_status "$method" "$AVATAR_API_ORIGIN$path")"; [[ "$actual" == '401' ]] || return 1
			results+="$method public $path $actual"$'\n'
			actual="$(avatar_cleanup_http_status "$method" "http://127.0.0.1:4200$path")"; [[ "$actual" == '404' || "$actual" == '410' ]] || return 1
			results+="$method direct-core $path $actual"$'\n'
		done
	done
	for method in POST DELETE; do
		if [[ "$method" == 'POST' ]]; then
			path="/api/v1/files?folder=avatar-cleanup-$nonce"
		else
			path="/api/v1/files?filePath=avatar-cleanup-$nonce.webp"
		fi
		actual="$(avatar_cleanup_http_status "$method" "http://127.0.0.1:4200$path")"; [[ "$actual" == '404' || "$actual" == '410' ]] || return 1
		results+="$method direct-core $path $actual"$'\n'
		actual="$(avatar_cleanup_http_status "$method" "$AVATAR_API_ORIGIN$path")"; [[ "$actual" == '404' || "$actual" == '410' ]] || return 1
		results+="$method public $path $actual"$'\n'
		actual="$(avatar_cleanup_http_status "$method" "$AVATAR_PUBLIC_ORIGIN$path")"; [[ "$actual" == '404' || "$actual" == '410' ]] || return 1
		results+="$method public-client $path $actual"$'\n'
	done
	for method in GET HEAD; do
		path="/uploads/avatar-cleanup-$nonce.webp"
		actual="$(avatar_cleanup_http_status "$method" "http://127.0.0.1:4200$path")"; [[ "$actual" == '404' || "$actual" == '410' ]] || return 1
		results+="$method direct-core $path $actual"$'\n'
		actual="$(avatar_cleanup_http_status "$method" "$AVATAR_API_ORIGIN$path")"; [[ "$actual" == '404' || "$actual" == '410' ]] || return 1
		results+="$method public $path $actual"$'\n'
		actual="$(avatar_cleanup_http_status "$method" "$AVATAR_PUBLIC_ORIGIN$path")"; [[ "$actual" == '404' || "$actual" == '410' ]] || return 1
		results+="$method public-client $path $actual"$'\n'
	done
	core_runtime="$(avatar_cleanup_capture_clean_core_runtime)" || return 1
	SMOKE_RESULTS="$results" SMOKE_OUTPUT="$temporary" CLEANUP_REVISION="$EXPECTED_REVISION" \
		WRITER_FENCE_SHA="$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
		CORE_RUNTIME="$core_runtime" node <<'NODE'
const fs = require('node:fs');
const checks = process.env.SMOKE_RESULTS.trim().split('\n').map(line => {
  const [method, surface, path, status] = line.split(' ');
  return { method, surface, path, status: Number(status) };
});
if (checks.length !== 27) process.exit(1);
const evidence = { version: 1, action: 'avatar-core-cleanup-smoke', cleanupRevision: process.env.CLEANUP_REVISION,
  writerFenceEvidenceSha256: process.env.WRITER_FENCE_SHA, coreRuntime: JSON.parse(process.env.CORE_RUNTIME),
  checks, verifiedAt: new Date().toISOString() };
fs.writeFileSync(process.env.SMOKE_OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$temporary"; chown 0:0 "$temporary"
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -f -- "$temporary" "$avatar_cleanup_smoke" || return 1
	avatar_cleanup_fsync_file_and_parent "$avatar_cleanup_smoke" || return 1
	avatar_cleanup_sign_artifact "$avatar_cleanup_smoke" || return 1
	avatar_cleanup_validate_smoke_evidence_payload
}

avatar_cleanup_promote_immutable_file() {
	[[ $# -eq 2 && "$1" == "${2}.prepared" ]] || return 1
	local prepared="$1" target="$2"
	PROMOTION_PREPARED="$prepared" PROMOTION_TARGET="$target" node <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const prepared = process.env.PROMOTION_PREPARED;
const target = process.env.PROMOTION_TARGET;
const syncDirectory = () => {
  const fd = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const source = fs.lstatSync(prepared);
if (!source.isFile() || source.isSymbolicLink()) process.exit(1);
if (fs.existsSync(target)) {
  const destination = fs.lstatSync(target);
  if (!destination.isFile() || destination.isSymbolicLink() || source.dev !== destination.dev ||
      source.ino !== destination.ino || source.nlink !== 2 || destination.nlink !== 2) process.exit(1);
} else {
  if (source.nlink !== 1) process.exit(1);
  fs.linkSync(prepared, target);
  syncDirectory();
}
fs.unlinkSync(prepared);
syncDirectory();
const final = fs.lstatSync(target);
if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1) process.exit(1);
NODE
}

avatar_cleanup_load_cleanup_complete_context() {
	avatar_cleanup_require_ownership_artifacts || return 1
	local reference_database_id
	reference_database_id="$(CLEANUP_REFERENCE_FILE="$avatar_cleanup_references" \
		OWNERSHIP_CLIENT_FILE="$avatar_cleanup_ownership_client_evidence" node <<'NODE'
const fs = require('node:fs');
let current;
let client;
try {
  current = JSON.parse(fs.readFileSync(process.env.CLEANUP_REFERENCE_FILE, 'utf8'));
  client = JSON.parse(fs.readFileSync(process.env.OWNERSHIP_CLIENT_FILE, 'utf8'));
} catch { process.exit(1); }
const value = current?.identity?.databaseId;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value || '') ||
    client.identityDatabaseId !== value) process.exit(1);
process.stdout.write(value);
NODE
)" || return 1
	[[ "$reference_database_id" == "$avatar_cleanup_identity_database_id" ]] || return 1
	avatar_cleanup_frontend_binding="$(IDENTITY_AVATAR_CLEANUP_CONTEXT="$avatar_cleanup_ownership_context" node -e '
const value=JSON.parse(process.env.IDENTITY_AVATAR_CLEANUP_CONTEXT).frontendBinding;
if(!value)process.exit(1);process.stdout.write(JSON.stringify(value));')" || return 1
}

avatar_cleanup_validate_cleanup_complete_body() {
	[[ $# -eq 1 || $# -eq 2 ]] || return 1
	local body="$1" identity_database_id="${2:-}" retirement_sha
	[[ -f "$body" && ! -L "$body" ]] || return 1
	if [[ -z "$identity_database_id" ]]; then
		avatar_cleanup_load_cleanup_complete_context || return 1
		identity_database_id="$avatar_cleanup_identity_database_id"
	fi
	retirement_sha="$(avatar_cleanup_marker_value retirement_evidence_sha256)" || return 1
	avatar_cleanup_load_retirement_consumer_recovery_binding "$retirement_sha" || return 1
	CLEANUP_COMPLETE_BODY="$body" OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" \
		CURRENT_RUNTIME_REVISION="$(avatar_cleanup_marker_value current_runtime_revision)" \
		CLEANUP_REVISION="$EXPECTED_REVISION" \
		INITIAL_CLIENT_REVISION="$(avatar_cleanup_marker_value initial_client_revision)" \
		CURRENT_CLIENT_REVISION="$(avatar_cleanup_marker_value current_client_revision)" \
		IDENTITY_DATABASE_ID="$identity_database_id" \
		OWNERSHIP_MARKER_SHA="$(avatar_cleanup_marker_value ownership_marker_sha256)" \
		RUNTIME_CURRENT_SHA="$(avatar_cleanup_marker_value runtime_stability_current_evidence_sha256)" \
		RUNTIME_CURRENT_SIGNATURE_SHA="$(avatar_cleanup_marker_value runtime_stability_current_signature_sha256)" \
		RUNTIME_GENERATION="$(avatar_cleanup_marker_value runtime_stability_generation)" \
		RUNTIME_EVIDENCE_SHA="$(avatar_cleanup_marker_value runtime_stability_evidence_sha256)" \
		LEDGER_GENERATION="$(avatar_cleanup_marker_value runtime_stability_ledger_generation)" \
		LEDGER_STATE="$(avatar_cleanup_marker_value runtime_stability_ledger_tail_state)" \
		LEDGER_SHA="$(avatar_cleanup_marker_value runtime_stability_ledger_tail_evidence_sha256)" \
		RUNTIME_STABLE_SINCE="$(avatar_cleanup_marker_value runtime_stable_since)" \
		CURRENT_CLIENT_BINDING_SHA="$(avatar_cleanup_marker_value current_client_binding_evidence_sha256)" \
		RUNTIME_RETARGET_SHA="$(avatar_cleanup_ownership_marker_value runtime_retarget_evidence_sha256)" \
		CLIENT_RETARGET_SHA="$(avatar_cleanup_ownership_marker_value client_retarget_evidence_sha256)" \
		FRONTEND_BINDING_SHA="$(avatar_cleanup_marker_value frontend_binding_sha256)" \
		CLIENT_READY_SHA="$(avatar_cleanup_marker_value client_ready_evidence_sha256)" \
		CLIENT_READY_SIGNATURE_SHA="$(avatar_cleanup_marker_value client_ready_signature_sha256)" \
		CLIENT_SWITCH_SHA="$(avatar_cleanup_ownership_marker_value client_evidence_sha256)" \
		SOAK_SHA="$(avatar_cleanup_ownership_marker_value soak_evidence_sha256)" \
		PRE_CLIENT_REFERENCE_SHA="$(avatar_cleanup_marker_value pre_client_reference_zero_evidence_sha256)" \
		PREDEPLOY_HANDOFF_SHA="$(avatar_cleanup_marker_value predeploy_uploads_handoff_sha256)" \
		CLEANUP_RETARGET_SHA="$(avatar_cleanup_marker_value cleanup_retarget_evidence_sha256)" \
		CLEANUP_REFERENCE_SHA="$(avatar_cleanup_marker_value reference_evidence_sha256)" \
		WRITER_FENCE_SHA="$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
		RETIREMENT_SHA="$retirement_sha" \
		RETIREMENT_RECOVERY_COUNT="$avatar_cleanup_retirement_recovery_count" \
		RETIREMENT_RECOVERY_AGGREGATE_SHA="$avatar_cleanup_retirement_recovery_aggregate_sha" \
		REVOCATION_SHA="$(avatar_cleanup_marker_value revocation_evidence_sha256)" \
		NGINX_SHA="$(avatar_cleanup_marker_value nginx_evidence_sha256)" \
		SMOKE_SHA="$(avatar_cleanup_marker_value smoke_evidence_sha256)" \
		CORE_IMAGE_ID="$(avatar_cleanup_marker_value core_cleanup_image_id)" node <<'NODE'
const fs = require('node:fs');
const { TextDecoder } = require('node:util');
let bytes;
let value;
let text;
try {
  bytes = fs.readFileSync(process.env.CLEANUP_COMPLETE_BODY);
  text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  value = JSON.parse(text);
} catch { process.exit(1); }
const keys = ['schemaVersion','kind','cleanupPhase','ownershipRevision','currentRuntimeRevision','cleanupRevision',
  'initialClientRevision','currentClientRevision','identityDatabaseId','ownershipMarkerSha256',
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
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const revision = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const generation = value => Number.isSafeInteger(value) && value >= 0 && value <= 64;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().replace('.000Z','Z') === value;
const millis = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const frontendKeys = ['bindingKind','evidenceSha256','evidenceSignatureSha256','clientRevision','imageId',
  'releaseEvidenceSha256','releaseEvidenceSignatureSha256','releaseTreeSha256',
  'releaseFullManifestSha256','processStartedAt'];
const expected = {
  ownershipMarkerSha256: process.env.OWNERSHIP_MARKER_SHA,
  runtimeStabilityCurrentEvidenceSha256: process.env.RUNTIME_CURRENT_SHA,
  runtimeStabilityCurrentEvidenceSignatureSha256: process.env.RUNTIME_CURRENT_SIGNATURE_SHA,
  runtimeStabilityEvidenceSha256: process.env.RUNTIME_EVIDENCE_SHA,
  runtimeStabilityLedgerTailEvidenceSha256: process.env.LEDGER_SHA,
  currentClientBindingEvidenceSha256: process.env.CURRENT_CLIENT_BINDING_SHA,
  clientReadyEvidenceSha256: process.env.CLIENT_READY_SHA,
  clientReadyEvidenceSignatureSha256: process.env.CLIENT_READY_SIGNATURE_SHA,
  clientSwitchEvidenceSha256: process.env.CLIENT_SWITCH_SHA,
  soakEvidenceSha256: process.env.SOAK_SHA,
  preClientReferenceZeroEvidenceSha256: process.env.PRE_CLIENT_REFERENCE_SHA,
  predeployUploadsHandoffSha256: process.env.PREDEPLOY_HANDOFF_SHA,
  cleanupRetargetEvidenceSha256: process.env.CLEANUP_RETARGET_SHA,
  cleanupReferenceZeroEvidenceSha256: process.env.CLEANUP_REFERENCE_SHA,
  writerFenceEvidenceSha256: process.env.WRITER_FENCE_SHA,
  retirementEvidenceSha256: process.env.RETIREMENT_SHA,
  revocationEvidenceSha256: process.env.REVOCATION_SHA,
  nginxEvidenceSha256: process.env.NGINX_SHA,
  smokeEvidenceSha256: process.env.SMOKE_SHA,
};
if (bytes.length < 2 || bytes.length > 16384 || text !== JSON.stringify(value) ||
    JSON.stringify(Object.keys(value || {})) !== JSON.stringify(keys) || value.schemaVersion !== 1 ||
    value.kind !== 'identity-avatar-core-cleanup-complete' || value.cleanupPhase !== 'COMPLETE' ||
    value.ownershipRevision !== process.env.OWNERSHIP_REVISION || !revision(value.ownershipRevision) ||
    value.currentRuntimeRevision !== process.env.CURRENT_RUNTIME_REVISION || !revision(value.currentRuntimeRevision) ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION || !revision(value.cleanupRevision) ||
    value.ownershipRevision === value.cleanupRevision ||
    value.initialClientRevision !== process.env.INITIAL_CLIENT_REVISION || !revision(value.initialClientRevision) ||
    value.currentClientRevision !== process.env.CURRENT_CLIENT_REVISION || !revision(value.currentClientRevision) ||
    value.identityDatabaseId !== process.env.IDENTITY_DATABASE_ID ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.identityDatabaseId || '') ||
    Object.entries(expected).some(([key, item]) => !hash(item) || value[key] !== item) ||
    !generation(value.runtimeStabilityGeneration) || String(value.runtimeStabilityGeneration) !== process.env.RUNTIME_GENERATION ||
    !generation(value.runtimeStabilityLedgerGeneration) || String(value.runtimeStabilityLedgerGeneration) !== process.env.LEDGER_GENERATION ||
    value.runtimeStabilityLedgerTailState !== process.env.LEDGER_STATE ||
    !['applied','adopted','aborted'].includes(value.runtimeStabilityLedgerTailState) ||
    (value.runtimeStabilityLedgerTailState === 'aborted' ?
      (value.runtimeStabilityLedgerGeneration !== value.runtimeStabilityGeneration + 1 ||
        value.runtimeStabilityLedgerTailEvidenceSha256 === value.runtimeStabilityEvidenceSha256) :
      (value.runtimeStabilityLedgerGeneration !== value.runtimeStabilityGeneration ||
        value.runtimeStabilityLedgerTailEvidenceSha256 !== value.runtimeStabilityEvidenceSha256)) ||
    value.runtimeStableSince !== process.env.RUNTIME_STABLE_SINCE || !timestamp(value.runtimeStableSince) ||
    !/^(pending|[0-9a-f]{64})$/.test(value.runtimeRetargetEvidenceSha256 || '') ||
    value.runtimeRetargetEvidenceSha256 !== process.env.RUNTIME_RETARGET_SHA ||
    !/^(pending|[0-9a-f]{64})$/.test(value.clientRetargetEvidenceSha256 || '') ||
    value.clientRetargetEvidenceSha256 !== process.env.CLIENT_RETARGET_SHA ||
    (value.currentRuntimeRevision !== value.ownershipRevision && !hash(value.runtimeRetargetEvidenceSha256)) ||
    (value.currentClientRevision !== value.initialClientRevision && !hash(value.clientRetargetEvidenceSha256)) ||
    JSON.stringify(Object.keys(value.frontendBinding || {})) !== JSON.stringify(frontendKeys) ||
    !['initial-client-switch','client-code-retarget','frontend-runtime-rebind'].includes(value.frontendBinding.bindingKind) ||
    ![value.frontendBinding.evidenceSha256,value.frontendBinding.evidenceSignatureSha256,
      value.frontendBinding.releaseEvidenceSha256,value.frontendBinding.releaseEvidenceSignatureSha256,
      value.frontendBinding.releaseTreeSha256,value.frontendBinding.releaseFullManifestSha256].every(hash) ||
    value.frontendBinding.clientRevision !== value.currentClientRevision ||
    !/^sha256:[0-9a-f]{64}$/.test(value.frontendBinding.imageId || '') || !millis(value.frontendBinding.processStartedAt) ||
    require('node:crypto').createHash('sha256').update(JSON.stringify(value.frontendBinding)).digest('hex') !== process.env.FRONTEND_BINDING_SHA ||
    !Number.isSafeInteger(value.retirementConsumerRecoveryEvidenceCount) ||
    value.retirementConsumerRecoveryEvidenceCount < 0 || value.retirementConsumerRecoveryEvidenceCount > 64 ||
    String(value.retirementConsumerRecoveryEvidenceCount) !== process.env.RETIREMENT_RECOVERY_COUNT ||
    value.retirementConsumerRecoveryEvidenceAggregateSha256 !== process.env.RETIREMENT_RECOVERY_AGGREGATE_SHA ||
    !hash(value.retirementConsumerRecoveryEvidenceAggregateSha256) ||
    value.coreCleanupImageId !== process.env.CORE_IMAGE_ID || !/^sha256:[0-9a-f]{64}$/.test(value.coreCleanupImageId || '') ||
    value.legacyReferencesAbsent !== true || value.legacyRoutesAbsent !== true ||
    value.legacyObjectsRetired !== true || value.ownershipActive !== true || !timestamp(value.completedAt) ||
    Date.parse(value.completedAt) < Date.parse(value.runtimeStableSince) + 604800000 ||
    Date.parse(value.completedAt) > Date.now() + 120000) process.exit(1);
NODE
}

avatar_cleanup_validate_cleanup_complete_signature() {
	[[ $# -le 1 ]] || return 1
	avatar_cleanup_validate_cleanup_complete_body "$avatar_cleanup_complete_body" "${1:-}" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_complete_body" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_complete_signature" || return 1
	avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" || return 1
	CLEANUP_COMPLETE_BODY="$avatar_cleanup_complete_body" \
		CLEANUP_COMPLETE_SIGNATURE="$avatar_cleanup_complete_signature" \
		LIFECYCLE_PUBLIC_KEY="$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
let text;
let signature;
let key;
try {
  text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(process.env.CLEANUP_COMPLETE_SIGNATURE));
  key = crypto.createPublicKey(fs.readFileSync(process.env.LIFECYCLE_PUBLIC_KEY));
} catch { process.exit(1); }
if (!/^[A-Za-z0-9+/]{86}==\n$/.test(text) || key.asymmetricKeyType !== 'ed25519') process.exit(1);
signature = Buffer.from(text.trim(), 'base64');
if (signature.length !== 64 || !crypto.verify(null, fs.readFileSync(process.env.CLEANUP_COMPLETE_BODY), key, signature)) process.exit(1);
NODE
}

# This guard intentionally validates only durable local evidence. Routine
# checkout protection must not depend on the public origin being reachable and
# must remain usable after the lifecycle private key has been retired.
avatar_cleanup_validate_guard_phase_evidence() (
	avatar_cleanup_validate_marker || return 1
	local phase ownership_revision cleanup_revision client_revision retarget_root retarget
	local retarget_sha reference_sha identity_database_id lifecycle_retirement_sha
	phase="$(avatar_cleanup_marker_value phase)" || return 1
	ownership_revision="$(avatar_cleanup_marker_value ownership_revision)" || return 1
	cleanup_revision="$(avatar_cleanup_marker_value cleanup_revision)" || return 1
	client_revision="$(avatar_cleanup_marker_value current_client_revision)" || return 1
	AVATAR_OWNERSHIP_REVISION="$ownership_revision"
	EXPECTED_REVISION="$cleanup_revision"
	AVATAR_CLIENT_REVISION="$client_revision"

	avatar_cleanup_validate_ownership_marker || return 1
	retarget_root="${IDENTITY_AVATAR_ARTIFACT_ROOT:-$APP_ROOT/deploy/backend/identity-avatar-media-artifacts}"
	retarget="$retarget_root/cleanup-retarget-v1.json"
	retarget_sha="$(avatar_cleanup_marker_value cleanup_retarget_evidence_sha256)" || return 1
	avatar_cleanup_validate_private_file "$retarget" || return 1
	[[ "$(avatar_cleanup_sha256 "$retarget")" == "$retarget_sha" &&
		"$(avatar_cleanup_ownership_marker_value cleanup_retarget_evidence_sha256)" == "$retarget_sha" ]] || return 1

	[[ "$phase" == 'complete' ]] || return 0
	avatar_cleanup_require_ownership_artifacts || return 1
	[[ "$(avatar_cleanup_marker_value ownership_marker_sha256)" == "$avatar_cleanup_ownership_marker_sha" &&
		"$(avatar_cleanup_marker_value current_runtime_revision)" == "$avatar_cleanup_runtime_revision" &&
		"$(avatar_cleanup_marker_value initial_client_revision)" == "$avatar_cleanup_initial_client_revision" &&
		"$(avatar_cleanup_marker_value current_client_revision)" == "$avatar_cleanup_current_client_revision" &&
		"$(avatar_cleanup_marker_value identity_database_id)" == "$avatar_cleanup_identity_database_id" &&
		"$(avatar_cleanup_marker_value runtime_stability_generation)" == "$avatar_cleanup_runtime_stability_generation" &&
		"$(avatar_cleanup_marker_value runtime_stability_evidence_sha256)" == \
			"$avatar_cleanup_runtime_stability_evidence_sha" &&
		"$(avatar_cleanup_marker_value runtime_stability_ledger_generation)" == \
			"$avatar_cleanup_runtime_stability_ledger_generation" &&
		"$(avatar_cleanup_marker_value runtime_stability_ledger_tail_state)" == \
			"$avatar_cleanup_runtime_stability_ledger_state" &&
		"$(avatar_cleanup_marker_value runtime_stability_ledger_tail_evidence_sha256)" == \
			"$avatar_cleanup_runtime_stability_ledger_sha" &&
		"$(avatar_cleanup_marker_value runtime_stability_current_evidence_sha256)" == \
			"$avatar_cleanup_runtime_stability_current_sha" &&
		"$(avatar_cleanup_marker_value runtime_stability_current_signature_sha256)" == \
			"$avatar_cleanup_runtime_stability_current_signature_sha" &&
		"$(avatar_cleanup_marker_value current_client_binding_evidence_sha256)" == \
			"$avatar_cleanup_current_client_binding_sha" &&
		"$(avatar_cleanup_marker_value frontend_binding_sha256)" == "$avatar_cleanup_frontend_binding_sha" &&
		"$(avatar_cleanup_marker_value runtime_stable_since)" == "$avatar_cleanup_runtime_stable_since" ]] || return 1
	reference_sha="$(avatar_cleanup_marker_value reference_evidence_sha256)" || return 1
	avatar_cleanup_verify_artifact "$avatar_cleanup_references" || return 1
	[[ "$(avatar_cleanup_sha256 "$avatar_cleanup_references")" == "$reference_sha" ]] || return 1
	identity_database_id="$(CLEANUP_REFERENCE_FILE="$avatar_cleanup_references" node <<'NODE'
const fs = require('node:fs');
let value;
try { value = JSON.parse(fs.readFileSync(process.env.CLEANUP_REFERENCE_FILE, 'utf8')); }
catch { process.exit(1); }
const databaseId = value?.identity?.databaseId;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(databaseId || ''))
  process.exit(1);
process.stdout.write(databaseId);
NODE
)" || return 1
	avatar_cleanup_validate_cleanup_complete_signature "$identity_database_id" || return 1
	[[ "$(avatar_cleanup_sha256 "$avatar_cleanup_complete_body")" == \
		"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" &&
		"$(avatar_cleanup_sha256 "$avatar_cleanup_complete_signature")" == \
		"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)" ]] || return 1
	lifecycle_retirement_sha="$(avatar_cleanup_marker_value lifecycle_key_retirement_evidence_sha256)" || return 1
	[[ "$lifecycle_retirement_sha" == 'pending' ]] && return 0
	[[ "$lifecycle_retirement_sha" =~ ^[0-9a-f]{64}$ &&
		"$(avatar_cleanup_sha256 "$avatar_cleanup_lifecycle_key_retirement")" == "$lifecycle_retirement_sha" ]] || return 1
	avatar_cleanup_validate_lifecycle_key_retirement_evidence_local || return 1
	[[ ! -e "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" && ! -L "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" ]]
)

avatar_cleanup_revision_available() {
	[[ $# -eq 1 ]] || return 1
	git -C "$SERVER_ROOT" cat-file -e "$1^{commit}" 2>/dev/null
}

avatar_cleanup_revision_descends_from() {
	[[ $# -eq 2 ]] || return 1
	git -C "$SERVER_ROOT" merge-base --is-ancestor "$1" "$2"
}

avatar_cleanup_validate_candidate_root_src_contract() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
	local revision="$1" grep_status
	avatar_cleanup_revision_available "$revision" || return 1
	git -C "$SERVER_ROOT" cat-file -e \
		"$revision:src/health/health.service.ts" 2>/dev/null || return 1
	if git -C "$SERVER_ROOT" grep -q -I -E \
		-e "File(Module|Controller|Service)|ServeStaticModule|@Controller\\([[:space:]]*['\"]files['\"]|from[[:space:]]+['\"][^'\"]*/file(/|['\"])|@aws-sdk/client-s3|/api/v1/files|S3_(ENDPOINT|REGION|BUCKET|BUCKET_NAME|ACCESS_KEY_ID|SECRET_ACCESS_KEY|PUBLIC_BASE_URL|KEY_PREFIX|FORCE_PATH_STYLE)|S3Client|s3Client|checkS3|PutObjectCommand|DeleteObjectCommand|HeadObjectCommand|ListObjectsV2Command|public/uploads|/app/uploads" \
		"$revision" -- src >/dev/null 2>&1; then
		return 1
	else
		grep_status=$?
		[[ "$grep_status" == '1' ]] || return 1
	fi
}

avatar_cleanup_guard_contract_sha256() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	GUARD_CONTRACT_SOURCE="$1" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const source = fs.readFileSync(process.env.GUARD_CONTRACT_SOURCE, 'utf8').replace(/\r\n/g, '\n');
const names = [
  'avatar_cleanup_sha256',
  'avatar_cleanup_validate_private_file',
  'avatar_cleanup_verify_artifact',
  'avatar_cleanup_marker_value',
  'avatar_cleanup_validate_marker',
  'avatar_cleanup_validate_clean_source_tree_at_root',
  'avatar_cleanup_validate_ownership_marker',
  'avatar_cleanup_ownership_marker_value',
  'avatar_cleanup_materialize_lifecycle_validator',
  'avatar_cleanup_compute_ownership_context',
  'avatar_cleanup_load_ownership_context',
  'avatar_cleanup_inherited_validation_mode',
  'avatar_cleanup_validate_inherited_contract',
  'avatar_cleanup_validate_inherited_lifecycle_bundle',
  'avatar_cleanup_validate_inherited_cleanup_retarget',
  'avatar_cleanup_validate_ownership_client_artifact',
  'avatar_cleanup_require_ownership_artifacts',
  'avatar_cleanup_validate_retirement_consumer_recovery',
  'avatar_cleanup_retirement_consumer_recovery_binding',
  'avatar_cleanup_load_retirement_consumer_recovery_binding',
  'avatar_cleanup_validate_retirement_evidence',
  'avatar_cleanup_validate_cleanup_complete_body',
  'avatar_cleanup_validate_cleanup_complete_signature',
  'avatar_cleanup_render_complete_nginx',
  'avatar_cleanup_validate_complete_nginx_config',
  'avatar_cleanup_validate_temporary_public_files_absent',
  'avatar_cleanup_validate_lifecycle_key_retirement_authorization',
  'avatar_cleanup_validate_lifecycle_key_retirement_evidence_payload',
  'avatar_cleanup_validate_lifecycle_key_retirement_evidence_local',
  'avatar_cleanup_validate_lifecycle_key_retirement_evidence',
  'avatar_cleanup_validate_guard_phase_evidence',
  'avatar_cleanup_revision_available',
  'avatar_cleanup_revision_descends_from',
  'avatar_cleanup_validate_candidate_root_src_contract',
  'avatar_cleanup_guard_contract_sha256',
  'avatar_cleanup_validate_permanent_guard_contract',
  'avatar_cleanup_validate_candidate_clean_source_tree',
  'avatar_cleanup_guard_revision',
];
const blocks = [];
for (const name of names) {
  const startPattern = new RegExp(`^${name}\\(\\) [({]$`, 'gm');
  const matches = [...source.matchAll(startPattern)];
  if (matches.length !== 1) process.exit(1);
  const match = matches[0];
  const start = match.index;
  const tail = source.slice(start + match[0].length);
  const next = /^avatar_cleanup_[a-z0-9_]+\(\) [({]$/m.exec(tail);
  const end = next ? start + match[0].length + next.index : source.length;
  blocks.push(source.slice(start, end).split('\n').map(line => line.trimEnd()).join('\n').trimEnd());
}
const dispatchStart = source.indexOf('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then');
if (dispatchStart < 0) process.exit(1);
blocks.push(source.slice(dispatchStart).split('\n').map(line => line.trimEnd()).join('\n').trimEnd());
process.stdout.write(crypto.createHash('sha256').update(`${blocks.join('\n\n')}\n`).digest('hex'));
NODE
}

avatar_cleanup_validate_permanent_guard_contract() {
	[[ $# -eq 1 && -d "$1" && ! -L "$1" ]] || return 1
	local source_root="$1"
	CANDIDATE_CLEANUP="$source_root/scripts/cleanup-avatar-core-source-production.sh" \
		CANDIDATE_WORKFLOW="$source_root/.github/workflows/deploy-production.yml" \
		CANDIDATE_DEPLOY="$source_root/scripts/deploy-production.sh" node <<'NODE'
const fs = require('node:fs');
const cleanup = fs.readFileSync(process.env.CANDIDATE_CLEANUP, 'utf8');
const workflow = fs.readFileSync(process.env.CANDIDATE_WORKFLOW, 'utf8');
const deploy = fs.readFileSync(process.env.CANDIDATE_DEPLOY, 'utf8');
const lines = workflow.split('\n').map(line => line.trim());
const count = needle => lines.filter(line => line === needle).length;
const between = (value, startNeedle, endNeedle, offset = 0) => {
  const start = value.indexOf(startNeedle, offset);
  const end = value.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end <= start) process.exit(1);
  return value.slice(start, end);
};
if (!cleanup.includes('avatar_cleanup_guard_revision() {') ||
    !cleanup.includes('--guard-before-fetch-revision | --guard-before-checkout-revision)') ||
    count('guard_avatar_cleanup_checkout_before_pull() {') !== 2 ||
    count('echo "Automatic backend deploy is verified but deferred: the active Avatar Core cleanup checkout guard rejects $EXPECTED_REVISION."') !== 1) process.exit(1);

const preflight = between(workflow, '\n  lifecycle_checkout_preflight:', '\n  verify:');
const preflightFunction = preflight.indexOf('guard_avatar_cleanup_checkout_before_pull() {');
const preflightCurrent = preflight.indexOf('guard_avatar_cleanup_checkout_before_pull "$current_revision"', preflightFunction);
const preflightExpected = preflight.indexOf('guard_avatar_cleanup_checkout_before_pull "$EXPECTED_REVISION"', preflightCurrent);
if (preflightFunction < 0 || preflightCurrent <= preflightFunction || preflightExpected <= preflightCurrent) process.exit(1);

const deployJob = workflow.slice(workflow.indexOf('\n  deploy:'));
if (!deployJob.startsWith('\n  deploy:') || count('guard_avatar_cleanup_checkout_before_pull() {') !== 2) process.exit(1);
const checkout = between(deployJob, 'checkout_verified_prod_revision() {', '\n          checkout_retargeted_billing_cleanup_revision() {');
const checkoutPre = checkout.lastIndexOf('guard_avatar_cleanup_checkout_before_pull "$expected_revision"');
const checkoutFetch = checkout.indexOf('git fetch origin prod');
const checkoutPost = checkout.indexOf('guard_avatar_cleanup_checkout_before_pull \\\n              "$expected_revision" --guard-before-checkout-revision', checkoutFetch);
const checkoutMutation = checkout.indexOf('git checkout prod', checkoutFetch);
if (checkoutPre < 0 || checkoutFetch <= checkoutPre || checkoutPost <= checkoutFetch || checkoutMutation <= checkoutPost) process.exit(1);

const retargetCheckout = between(deployJob, 'checkout_retargeted_billing_cleanup_revision() {', '\n          current_revision="$(git rev-parse HEAD)"');
const retargetPre = retargetCheckout.lastIndexOf('guard_avatar_cleanup_checkout_before_pull "$expected_revision"');
const retargetPost = retargetCheckout.indexOf('guard_avatar_cleanup_checkout_before_pull \\\n              "$expected_revision" --guard-before-checkout-revision');
const retargetMutation = retargetCheckout.indexOf('git checkout prod');
if (retargetPre < 0 || retargetPost <= retargetPre || retargetMutation <= retargetPost) process.exit(1);

const automatic = between(deployJob,
  'if [[ "$AUTOMATIC_PROD_PUSH" == "true" &&', '\n          case "$DEPLOY_TARGET" in');
const automaticAvatar = automatic.indexOf('if ! guard_avatar_cleanup_checkout_before_pull \\\n              "$EXPECTED_REVISION"');
if (automaticAvatar < 0 || automatic.indexOf('exit 0', automaticAvatar) <= automaticAvatar ||
    automatic.includes('git fetch origin prod') || automatic.includes('git checkout prod')) process.exit(1);

const cleanupDispatch = between(deployJob, '\n            billing-cleanup)', '\n            identity)');
const retargetFetch = cleanupDispatch.indexOf('git fetch origin prod');
const retargetPreFetch = cleanupDispatch.lastIndexOf('guard_avatar_cleanup_checkout_before_pull "$EXPECTED_REVISION"', retargetFetch);
const retargetPostFetch = cleanupDispatch.indexOf('guard_avatar_cleanup_checkout_before_pull \\\n                    "$EXPECTED_REVISION" --guard-before-checkout-revision', retargetFetch);
const retargetMarkerMutation = cleanupDispatch.indexOf('retarget_billing_cleanup_revision', retargetFetch);
const stageStart = cleanupDispatch.indexOf('if [[ "$BILLING_CLEANUP_ACTION" == \'stage\'');
const stageFetch = cleanupDispatch.indexOf('git fetch origin prod', stageStart);
const stagePreFetch = cleanupDispatch.lastIndexOf('guard_avatar_cleanup_checkout_before_pull "$EXPECTED_REVISION"', stageFetch);
const stagePostFetch = cleanupDispatch.indexOf('guard_avatar_cleanup_checkout_before_pull \\\n                  "$EXPECTED_REVISION" --guard-before-checkout-revision', stageFetch);
const stageMutation = cleanupDispatch.indexOf('stage_billing_cleanup_revision_with_container_node', stageFetch);
if (retargetFetch < 0 || retargetPreFetch < 0 || retargetPreFetch >= retargetFetch ||
    retargetPostFetch <= retargetFetch || retargetMarkerMutation <= retargetPostFetch ||
    stageStart < 0 || stageFetch <= stageStart || stagePreFetch < stageStart || stagePreFetch >= stageFetch ||
    stagePostFetch <= stageFetch || stageMutation <= stagePostFetch) process.exit(1);

const deployGuard = deploy.indexOf('--guard-before-checkout-revision "$deploy_revision"');
const routineBoundary = deploy.indexOf('widgets_automatic_prod_push=', deployGuard);
if (deployGuard < 0 || routineBoundary <= deployGuard ||
    !deploy.includes('$1 == "current_client_revision"') || deploy.includes('$1 == "client_revision"') ||
    !deploy.includes('$1 == "lifecycle_key_retirement_evidence_sha256"') ||
    !deploy.includes('Completed Avatar cleanup descendant deployment is blocked until the SHA-A lifecycle bypass integration is present.') ||
    deploy.includes('avatar_cleanup_completed_descendant')) process.exit(1);
NODE
}

avatar_cleanup_validate_candidate_clean_source_tree() (
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{40}$ && "$2" =~ ^[0-9a-f]{40}$ ]] || return 1
	local revision="$1" cleanup_revision="$2" temporary path entry mode kind object returned_path
	local candidate_guard_sha cleanup_guard_sha
	local -a paths=(
		.dockerignore
		.github/workflows/deploy-production.yml
		Dockerfile
		deploy/docker-compose.prod.yml
		deploy/nginx.conf
		docker-entrypoint.sh
		package.json
		pnpm-lock.yaml
		scripts/cleanup-avatar-core-source-production.sh
		scripts/deploy-production.sh
		scripts/test-avatar-core-source-cleanup-rehearsal.sh
		src/app.module.ts
		src/health/health.service.ts
	)
	avatar_cleanup_revision_available "$revision" || return 1
	avatar_cleanup_validate_candidate_root_src_contract "$revision" || return 1
	if git -C "$SERVER_ROOT" cat-file -e "$revision:src/file" 2>/dev/null; then
		return 1
	fi
	temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-guard-tree.XXXXXX")"
	chmod 700 "$temporary"
	trap 'rm -rf -- "$temporary"' EXIT
	for path in "${paths[@]}"; do
		entry="$(git -C "$SERVER_ROOT" ls-tree "$revision" -- "$path")" || return 1
		IFS=$' \t' read -r mode kind object returned_path <<<"$entry"
		[[ "$mode" =~ ^100(644|755)$ && "$kind" == 'blob' ]] || return 1
		mkdir -p -- "$temporary/$(dirname -- "$path")" || return 1
		git -C "$SERVER_ROOT" show "$revision:$path" >"$temporary/$path" || return 1
	done
	avatar_cleanup_validate_clean_source_tree_at_root "$temporary" || return 1
	avatar_cleanup_validate_permanent_guard_contract "$temporary" || return 1
	git -C "$SERVER_ROOT" show \
		"$cleanup_revision:scripts/cleanup-avatar-core-source-production.sh" \
		>"$temporary/.cleanup-bound-guard.sh" || return 1
	chmod 600 "$temporary/.cleanup-bound-guard.sh" || return 1
	candidate_guard_sha="$(avatar_cleanup_guard_contract_sha256 \
		"$temporary/scripts/cleanup-avatar-core-source-production.sh")" || return 1
	cleanup_guard_sha="$(avatar_cleanup_guard_contract_sha256 \
		"$temporary/.cleanup-bound-guard.sh")" || return 1
	[[ "$candidate_guard_sha" == "$cleanup_guard_sha" ]]
)

avatar_cleanup_guard_revision() {
	[[ $# -eq 2 && "$1" =~ ^--guard-before-(fetch|checkout)-revision$ &&
		"$2" =~ ^[0-9a-f]{40}$ ]] || return 1
	local guard_action="$1" expected_revision="$2" phase cleanup_revision lifecycle_retirement_sha
	if [[ ! -e "$avatar_cleanup_marker" && ! -L "$avatar_cleanup_marker" ]]; then
		return 0
	fi
	avatar_cleanup_validate_guard_phase_evidence ||
		avatar_cleanup_fail 'Avatar Core cleanup marker/retarget/completion evidence is invalid' || return 1
	phase="$(avatar_cleanup_marker_value phase)" || return 1
	cleanup_revision="$(avatar_cleanup_marker_value cleanup_revision)" || return 1
	case "$phase" in
	verified | forward-only)
		[[ "$expected_revision" == "$cleanup_revision" ]] ||
			avatar_cleanup_fail "Avatar Core cleanup phase=$phase pins deployment to revision $cleanup_revision" || return 1
		;;
	complete)
		lifecycle_retirement_sha="$(avatar_cleanup_marker_value lifecycle_key_retirement_evidence_sha256)" || return 1
		if [[ "$lifecycle_retirement_sha" == 'pending' ]]; then
			[[ "$expected_revision" == "$cleanup_revision" ]] ||
				avatar_cleanup_fail "Avatar Core cleanup publication recovery pins deployment to revision $cleanup_revision" || return 1
			return 0
		fi
		if [[ "$guard_action" == '--guard-before-fetch-revision' ]] &&
			! avatar_cleanup_revision_available "$expected_revision"; then
			# Fetching an immutable object is safe; the post-fetch guard below must
			# prove ancestry and the retained source-removal contract before checkout.
			return 0
		fi
		avatar_cleanup_revision_available "$expected_revision" ||
			avatar_cleanup_fail 'Avatar cleanup target revision is unavailable after fetch' || return 1
		avatar_cleanup_revision_descends_from "$cleanup_revision" "$expected_revision" ||
			avatar_cleanup_fail 'Target revision would downgrade past the completed Avatar Core cleanup' || return 1
		avatar_cleanup_validate_candidate_clean_source_tree "$expected_revision" "$cleanup_revision" ||
			avatar_cleanup_fail 'Target revision reintroduces Avatar Core source or removes its permanent checkout guard' || return 1
		;;
	*) return 1 ;;
	esac
}

avatar_cleanup_create_cleanup_complete_evidence() {
	local retirement_sha
	avatar_cleanup_load_cleanup_complete_context || return 1
	retirement_sha="$(avatar_cleanup_marker_value retirement_evidence_sha256)" || return 1
	avatar_cleanup_load_retirement_consumer_recovery_binding "$retirement_sha" || return 1
	avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" || return 1
	avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" || return 1
	local body_prepared="${avatar_cleanup_complete_body}.prepared"
	local signature_prepared="${avatar_cleanup_complete_signature}.prepared"
	if [[ -f "$avatar_cleanup_complete_body" && ! -L "$avatar_cleanup_complete_body" &&
		-f "$body_prepared" && ! -L "$body_prepared" ]]; then
		avatar_cleanup_promote_immutable_file "$body_prepared" "$avatar_cleanup_complete_body" || return 1
	fi
	if [[ ! -e "$avatar_cleanup_complete_body" && ! -L "$avatar_cleanup_complete_body" ]]; then
		if [[ ! -e "$body_prepared" && ! -L "$body_prepared" ]]; then
			CLEANUP_COMPLETE_BODY="$body_prepared" OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" \
				CURRENT_RUNTIME_REVISION="$avatar_cleanup_runtime_revision" \
				CLEANUP_REVISION="$EXPECTED_REVISION" \
				INITIAL_CLIENT_REVISION="$avatar_cleanup_initial_client_revision" \
				CURRENT_CLIENT_REVISION="$avatar_cleanup_current_client_revision" \
				IDENTITY_DATABASE_ID="$avatar_cleanup_identity_database_id" \
				OWNERSHIP_MARKER_SHA="$avatar_cleanup_ownership_marker_sha" \
				RUNTIME_CURRENT_SHA="$avatar_cleanup_runtime_stability_current_sha" \
				RUNTIME_CURRENT_SIGNATURE_SHA="$avatar_cleanup_runtime_stability_current_signature_sha" \
				RUNTIME_GENERATION="$avatar_cleanup_runtime_stability_generation" \
				RUNTIME_EVIDENCE_SHA="$avatar_cleanup_runtime_stability_evidence_sha" \
				LEDGER_GENERATION="$avatar_cleanup_runtime_stability_ledger_generation" \
				LEDGER_STATE="$avatar_cleanup_runtime_stability_ledger_state" \
				LEDGER_SHA="$avatar_cleanup_runtime_stability_ledger_sha" \
				RUNTIME_STABLE_SINCE="$avatar_cleanup_runtime_stable_since" \
				CURRENT_CLIENT_BINDING_SHA="$avatar_cleanup_current_client_binding_sha" \
				RUNTIME_RETARGET_SHA="$(avatar_cleanup_ownership_marker_value runtime_retarget_evidence_sha256)" \
				CLIENT_RETARGET_SHA="$(avatar_cleanup_ownership_marker_value client_retarget_evidence_sha256)" \
				FRONTEND_BINDING="$avatar_cleanup_frontend_binding" \
				CLIENT_READY_SHA="$(avatar_cleanup_marker_value client_ready_evidence_sha256)" \
				CLIENT_READY_SIGNATURE_SHA="$(avatar_cleanup_marker_value client_ready_signature_sha256)" \
				CLIENT_SWITCH_SHA="$(avatar_cleanup_ownership_marker_value client_evidence_sha256)" \
				SOAK_SHA="$(avatar_cleanup_ownership_marker_value soak_evidence_sha256)" \
				PRE_CLIENT_REFERENCE_SHA="$(avatar_cleanup_marker_value pre_client_reference_zero_evidence_sha256)" \
				PREDEPLOY_HANDOFF_SHA="$(avatar_cleanup_marker_value predeploy_uploads_handoff_sha256)" \
				CLEANUP_RETARGET_SHA="$(avatar_cleanup_marker_value cleanup_retarget_evidence_sha256)" \
				CLEANUP_REFERENCE_SHA="$(avatar_cleanup_marker_value reference_evidence_sha256)" \
				WRITER_FENCE_SHA="$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
				RETIREMENT_SHA="$retirement_sha" \
				RETIREMENT_RECOVERY_COUNT="$avatar_cleanup_retirement_recovery_count" \
				RETIREMENT_RECOVERY_AGGREGATE_SHA="$avatar_cleanup_retirement_recovery_aggregate_sha" \
				REVOCATION_SHA="$(avatar_cleanup_marker_value revocation_evidence_sha256)" \
				NGINX_SHA="$(avatar_cleanup_marker_value nginx_evidence_sha256)" \
				SMOKE_SHA="$(avatar_cleanup_marker_value smoke_evidence_sha256)" \
				CORE_IMAGE_ID="$(avatar_cleanup_marker_value core_cleanup_image_id)" \
				COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" node <<'NODE' || return 1
const fs = require('node:fs');
const value = {
  schemaVersion: 1, kind: 'identity-avatar-core-cleanup-complete', cleanupPhase: 'COMPLETE',
  ownershipRevision: process.env.OWNERSHIP_REVISION,
  currentRuntimeRevision: process.env.CURRENT_RUNTIME_REVISION,
  cleanupRevision: process.env.CLEANUP_REVISION,
  initialClientRevision: process.env.INITIAL_CLIENT_REVISION,
  currentClientRevision: process.env.CURRENT_CLIENT_REVISION,
  identityDatabaseId: process.env.IDENTITY_DATABASE_ID,
  ownershipMarkerSha256: process.env.OWNERSHIP_MARKER_SHA,
  runtimeStabilityCurrentEvidenceSha256: process.env.RUNTIME_CURRENT_SHA,
  runtimeStabilityCurrentEvidenceSignatureSha256: process.env.RUNTIME_CURRENT_SIGNATURE_SHA,
  runtimeStabilityGeneration: Number(process.env.RUNTIME_GENERATION),
  runtimeStabilityEvidenceSha256: process.env.RUNTIME_EVIDENCE_SHA,
  runtimeStabilityLedgerGeneration: Number(process.env.LEDGER_GENERATION),
  runtimeStabilityLedgerTailState: process.env.LEDGER_STATE,
  runtimeStabilityLedgerTailEvidenceSha256: process.env.LEDGER_SHA,
  runtimeStableSince: process.env.RUNTIME_STABLE_SINCE,
  currentClientBindingEvidenceSha256: process.env.CURRENT_CLIENT_BINDING_SHA,
  runtimeRetargetEvidenceSha256: process.env.RUNTIME_RETARGET_SHA,
  clientRetargetEvidenceSha256: process.env.CLIENT_RETARGET_SHA,
  frontendBinding: JSON.parse(process.env.FRONTEND_BINDING),
  clientReadyEvidenceSha256: process.env.CLIENT_READY_SHA,
  clientReadyEvidenceSignatureSha256: process.env.CLIENT_READY_SIGNATURE_SHA,
  clientSwitchEvidenceSha256: process.env.CLIENT_SWITCH_SHA, soakEvidenceSha256: process.env.SOAK_SHA,
  preClientReferenceZeroEvidenceSha256: process.env.PRE_CLIENT_REFERENCE_SHA,
  predeployUploadsHandoffSha256: process.env.PREDEPLOY_HANDOFF_SHA,
  cleanupRetargetEvidenceSha256: process.env.CLEANUP_RETARGET_SHA,
  cleanupReferenceZeroEvidenceSha256: process.env.CLEANUP_REFERENCE_SHA,
  writerFenceEvidenceSha256: process.env.WRITER_FENCE_SHA, retirementEvidenceSha256: process.env.RETIREMENT_SHA,
  retirementConsumerRecoveryEvidenceCount: Number(process.env.RETIREMENT_RECOVERY_COUNT),
  retirementConsumerRecoveryEvidenceAggregateSha256: process.env.RETIREMENT_RECOVERY_AGGREGATE_SHA,
  revocationEvidenceSha256: process.env.REVOCATION_SHA, nginxEvidenceSha256: process.env.NGINX_SHA,
  smokeEvidenceSha256: process.env.SMOKE_SHA, coreCleanupImageId: process.env.CORE_IMAGE_ID,
  legacyReferencesAbsent: true, legacyRoutesAbsent: true, legacyObjectsRetired: true, ownershipActive: true,
  completedAt: process.env.COMPLETED_AT,
};
const fd = fs.openSync(process.env.CLEANUP_COMPLETE_BODY, 'wx', 0o600);
try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE
			chown 0:0 "$body_prepared" || return 1
		fi
		avatar_cleanup_validate_cleanup_complete_body "$body_prepared" || return 1
		avatar_cleanup_promote_immutable_file "$body_prepared" "$avatar_cleanup_complete_body" || return 1
	fi
	avatar_cleanup_validate_cleanup_complete_body "$avatar_cleanup_complete_body" || return 1
	if [[ -f "$avatar_cleanup_complete_signature" && ! -L "$avatar_cleanup_complete_signature" &&
		-f "$signature_prepared" && ! -L "$signature_prepared" ]]; then
		avatar_cleanup_promote_immutable_file "$signature_prepared" "$avatar_cleanup_complete_signature" || return 1
	fi
	if [[ ! -e "$avatar_cleanup_complete_signature" && ! -L "$avatar_cleanup_complete_signature" ]]; then
		if [[ ! -e "$signature_prepared" && ! -L "$signature_prepared" ]]; then
			CLEANUP_COMPLETE_BODY="$avatar_cleanup_complete_body" CLEANUP_COMPLETE_SIGNATURE="$signature_prepared" \
				LIFECYCLE_PRIVATE_KEY="$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
let key;
try { key = crypto.createPrivateKey(fs.readFileSync(process.env.LIFECYCLE_PRIVATE_KEY)); } catch { process.exit(1); }
if (key.asymmetricKeyType !== 'ed25519') process.exit(1);
const signature = crypto.sign(null, fs.readFileSync(process.env.CLEANUP_COMPLETE_BODY), key);
if (signature.length !== 64) process.exit(1);
const fd = fs.openSync(process.env.CLEANUP_COMPLETE_SIGNATURE, 'wx', 0o600);
try { fs.writeFileSync(fd, `${signature.toString('base64')}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE
			chown 0:0 "$signature_prepared" || return 1
		fi
		[[ -f "$signature_prepared" && ! -L "$signature_prepared" ]] || return 1
		avatar_cleanup_promote_immutable_file "$signature_prepared" "$avatar_cleanup_complete_signature" || return 1
	fi
	avatar_cleanup_validate_cleanup_complete_signature
}

avatar_cleanup_publish_public_copy() {
	[[ $# -eq 2 ]] || return 1
	local source="$1" target="$2" prepared="${2}.prepared"
	avatar_cleanup_validate_private_file "$source" || return 1
	[[ -d "$(dirname -- "$target")" && ! -L "$(dirname -- "$target")" ]] || return 1
	if [[ -f "$target" && ! -L "$target" && -f "$prepared" && ! -L "$prepared" ]]; then
		avatar_cleanup_promote_immutable_file "$prepared" "$target" || return 1
	fi
	if [[ -e "$target" || -L "$target" ]]; then
		avatar_cleanup_validate_public_file "$target" && [[ "$(avatar_cleanup_sha256 "$target")" == \
			"$(avatar_cleanup_sha256 "$source")" ]] || return 1
		return
	fi
	if [[ ! -e "$prepared" && ! -L "$prepared" ]]; then
		install -o root -g root -m 644 "$source" "$prepared" || return 1
		avatar_cleanup_fsync_file_and_parent "$prepared" || return 1
	fi
	[[ -f "$prepared" && ! -L "$prepared" && "$(avatar_cleanup_stat_identity "$prepared")" == '0:0:644' &&
		"$(avatar_cleanup_sha256 "$prepared")" == "$(avatar_cleanup_sha256 "$source")" ]] || return 1
	avatar_cleanup_promote_immutable_file "$prepared" "$target" || return 1
	avatar_cleanup_validate_public_file "$target" &&
		[[ "$(avatar_cleanup_sha256 "$target")" == "$(avatar_cleanup_sha256 "$source")" ]]
}

avatar_cleanup_render_complete_nginx() {
	[[ $# -eq 1 && "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
	local output="$1"
	CLEANUP_NGINX_OUTPUT="$output" CLEANUP_REVISION="$EXPECTED_REVISION" node <<'NODE'
const fs = require('node:fs');
const revision = process.env.CLEANUP_REVISION;
const text = `location = /.well-known/winwidget/identity-avatar-media/cleanup-complete-v1.json {\n` +
  `\talias /var/lib/winwidget/identity-avatar-public/cleanup-complete-v1.json;\n` +
  `\tdefault_type application/json;\n` +
  `\tcharset utf-8;\n` +
  `\tcharset_types application/json;\n` +
  `\tadd_header Cache-Control "no-store, max-age=0" always;\n` +
  `\tadd_header X-Content-Type-Options "nosniff" always;\n` +
  `\tadd_header X-Winwidget-Revision "${revision}" always;\n` +
  `\tlimit_except GET { deny all; }\n}\n\n` +
  `location = /.well-known/winwidget/identity-avatar-media/cleanup-complete-v1.json.sig {\n` +
  `\talias /var/lib/winwidget/identity-avatar-public/cleanup-complete-v1.json.sig;\n` +
  `\tdefault_type application/octet-stream;\n` +
  `\tadd_header Cache-Control "no-store, max-age=0" always;\n` +
  `\tadd_header X-Content-Type-Options "nosniff" always;\n` +
  `\tadd_header X-Winwidget-Revision "${revision}" always;\n` +
  `\tlimit_except GET { deny all; }\n}\n`;
const fd = fs.openSync(process.env.CLEANUP_NGINX_OUTPUT, 'wx', 0o644);
try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE
}

avatar_cleanup_validate_temporary_nginx_config() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	TEMPORARY_NGINX_CONFIG="$1" node <<'NODE'
const fs=require('node:fs');
const text=fs.readFileSync(process.env.TEMPORARY_NGINX_CONFIG,'utf8');
const names=['client-ready-v1.json','client-retarget-ack-v1.json','runtime-stability-current-v1.json',
  'frontend-runtime-rebind-ready-v1.json'];
const count=needle=>text.split(needle).length-1;
if((text.match(/^location = /gm)||[]).length!==8||names.some(name=>count(`/${name}`)!==4)||
  count('/cleanup-complete-v1.json')!==0)process.exit(1);
NODE
}

avatar_cleanup_validate_complete_nginx_config() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	local temporary
	temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-nginx-contract.XXXXXX")" || return 1
	chmod 700 "$temporary" || return 1
	trap 'rm -rf -- "$temporary"' RETURN
	avatar_cleanup_render_complete_nginx "$temporary/complete.conf" || return 1
	cmp -s "$1" "$temporary/complete.conf" || return 1
	rm -rf -- "$temporary" || return 1
	trap - RETURN
}

avatar_cleanup_install_complete_nginx() {
	local target="$avatar_cleanup_public_nginx_target" parent rendered backup restore source_sha target_sha
	parent="$(dirname -- "$target")" || return 1
	[[ -d "$parent" && ! -L "$parent" && "$(avatar_cleanup_stat_identity "$parent")" == '0:0:755' ]] || return 1
	rendered="${target}.cleanup-prepared"
	backup="${target}.client-ready-backup"
	restore="${target}.restore-prepared"
	if [[ ! -e "$rendered" && ! -L "$rendered" ]]; then
		avatar_cleanup_render_complete_nginx "$rendered" || return 1
		chown 0:0 "$rendered" || return 1
	fi
	[[ -f "$rendered" && ! -L "$rendered" && "$(avatar_cleanup_stat_identity "$rendered")" == '0:0:644' ]] || return 1
	source_sha="$(avatar_cleanup_sha256 "$rendered")" || return 1
	if [[ ! -e "$target" && ! -L "$target" ]]; then
		avatar_cleanup_validate_temporary_nginx_config "$backup" ||
			avatar_cleanup_fail 'avatar attestation nginx target is absent without a recoverable client-ready backup' || return 1
		install -o root -g root -m 644 "$backup" "$restore" || return 1
		avatar_cleanup_fsync_file_and_parent "$restore" || return 1
		mv -fT -- "$restore" "$target" || return 1
		avatar_cleanup_fsync_file_and_parent "$target" || return 1
	fi
	[[ -f "$target" && ! -L "$target" ]] || return 1
	target_sha="$(avatar_cleanup_sha256 "$target")" || return 1
	if [[ "$target_sha" == "$source_sha" ]]; then
		if ! nginx -t >/dev/null 2>&1 || ! systemctl reload nginx || ! systemctl is-active --quiet nginx; then
			avatar_cleanup_validate_temporary_nginx_config "$backup" ||
				avatar_cleanup_fail 'cleanup-complete nginx config failed without a recoverable client-ready backup' || return 1
			install -o root -g root -m 644 "$backup" "$restore" || return 1
			avatar_cleanup_fsync_file_and_parent "$restore" || return 1
			mv -fT -- "$restore" "$target" || return 1
			avatar_cleanup_fsync_file_and_parent "$target" || return 1
			nginx -t >/dev/null 2>&1 && systemctl reload nginx && systemctl is-active --quiet nginx ||
				avatar_cleanup_fail 'avatar attestation nginx rollback failed' || return 1
			rm -f -- "$backup" || return 1
			avatar_cleanup_fsync_directory "$parent" || return 1
			avatar_cleanup_fail 'cleanup-complete nginx config failed and only the config was rolled back'
			return 1
		fi
		rm -f -- "$rendered" || return 1
		avatar_cleanup_validate_complete_nginx_config "$target" || return 1
		if [[ -e "$backup" || -L "$backup" ]]; then
			avatar_cleanup_validate_temporary_nginx_config "$backup" || return 1
			rm -f -- "$backup" || return 1
		fi
		avatar_cleanup_fsync_directory "$parent"
		return
	fi
	avatar_cleanup_validate_temporary_nginx_config "$target" ||
		avatar_cleanup_fail 'live avatar attestation nginx config is neither exact client-ready nor cleanup-complete' || return 1
	if [[ ! -e "$backup" && ! -L "$backup" ]]; then
		install -o root -g root -m 600 "$target" "$backup" || return 1
		avatar_cleanup_fsync_file_and_parent "$backup" || return 1
	fi
	[[ -f "$backup" && ! -L "$backup" && "$(avatar_cleanup_sha256 "$backup")" == "$target_sha" ]] || return 1
	mv -fT -- "$rendered" "$target" || return 1
	avatar_cleanup_fsync_file_and_parent "$target" || return 1
	if ! nginx -t >/dev/null 2>&1 || ! systemctl reload nginx || ! systemctl is-active --quiet nginx; then
		install -o root -g root -m 644 "$backup" "$restore" || return 1
		avatar_cleanup_fsync_file_and_parent "$restore" || return 1
		mv -fT -- "$restore" "$target" || return 1
		avatar_cleanup_fsync_file_and_parent "$target" || return 1
		nginx -t >/dev/null 2>&1 && systemctl reload nginx && systemctl is-active --quiet nginx ||
			avatar_cleanup_fail 'avatar attestation nginx rollback failed' || return 1
		rm -f -- "$backup" || return 1
		avatar_cleanup_fsync_directory "$parent" || return 1
		avatar_cleanup_fail 'cleanup-complete nginx config failed and only the config was rolled back'
		return 1
	fi
	[[ "$(avatar_cleanup_sha256 "$target")" == "$source_sha" ]] || return 1
	avatar_cleanup_validate_complete_nginx_config "$target" || return 1
	rm -f -- "$backup" || return 1
	avatar_cleanup_fsync_directory "$parent"
}

avatar_cleanup_validate_public_headers() {
	[[ $# -eq 2 ]] || return 1
	PUBLIC_HEADERS_FILE="$1" EXPECTED_CONTENT_TYPE="$2" CLEANUP_REVISION="$EXPECTED_REVISION" node <<'NODE'
const fs = require('node:fs');
const { TextDecoder } = require('node:util');
let text;
try { text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(process.env.PUBLIC_HEADERS_FILE)); }
catch { process.exit(1); }
const blocks = text.trim().split(/\r?\n\r?\n/);
if (blocks.length !== 1) process.exit(1);
const lines = blocks[0].split(/\r?\n/);
if (!/^HTTP\/\S+ 200(?: |$)/.test(lines.shift() || '')) process.exit(1);
const headers = new Map();
for (const line of lines) {
  const at = line.indexOf(':');
  if (at <= 0) process.exit(1);
  const key = line.slice(0, at).trim().toLowerCase();
  if (headers.has(key)) process.exit(1);
  headers.set(key, line.slice(at + 1).trim());
}
const cache = (headers.get('cache-control') || '').toLowerCase().split(',').map(item => item.trim());
const contentType = (headers.get('content-type') || '').toLowerCase();
const expectedContentType = process.env.EXPECTED_CONTENT_TYPE === 'application/json' ?
  'application/json; charset=utf-8' : process.env.EXPECTED_CONTENT_TYPE;
if (headers.get('x-winwidget-revision') !== process.env.CLEANUP_REVISION ||
    headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff' ||
    JSON.stringify(cache) !== JSON.stringify(['no-store','max-age=0']) ||
    contentType !== expectedContentType) process.exit(1);
NODE
}

avatar_cleanup_verify_public_cleanup_complete() {
	local temporary body_one body_two signature body_status signature_status second_status
	temporary="$(mktemp -d "$avatar_cleanup_root/.cleanup-public.XXXXXX")" || return 1
	chmod 700 "$temporary"; chown 0:0 "$temporary"
	trap 'rm -rf -- "$temporary"' RETURN
	body_one="$temporary/body-one.json"; body_two="$temporary/body-two.json"; signature="$temporary/body.sig"
	body_status="$(curl --proto '=https' --tlsv1.2 --silent --show-error --connect-timeout 5 --max-time 15 \
		--max-filesize 16384 --dump-header "$temporary/body.headers" --output "$body_one" --write-out '%{http_code}' \
		"$AVATAR_API_ORIGIN/.well-known/winwidget/identity-avatar-media/cleanup-complete-v1.json")" || return 1
	signature_status="$(curl --proto '=https' --tlsv1.2 --silent --show-error --connect-timeout 5 --max-time 15 \
		--max-filesize 1024 --dump-header "$temporary/signature.headers" --output "$signature" --write-out '%{http_code}' \
		"$AVATAR_API_ORIGIN/.well-known/winwidget/identity-avatar-media/cleanup-complete-v1.json.sig")" || return 1
	second_status="$(curl --proto '=https' --tlsv1.2 --silent --show-error --connect-timeout 5 --max-time 15 \
		--max-filesize 16384 --dump-header "$temporary/body-two.headers" --output "$body_two" --write-out '%{http_code}' \
		"$AVATAR_API_ORIGIN/.well-known/winwidget/identity-avatar-media/cleanup-complete-v1.json")" || return 1
	[[ "$body_status" == '200' && "$signature_status" == '200' && "$second_status" == '200' &&
		"$(avatar_cleanup_sha256 "$body_one")" == "$(avatar_cleanup_sha256 "$avatar_cleanup_complete_body")" &&
		"$(avatar_cleanup_sha256 "$body_two")" == "$(avatar_cleanup_sha256 "$avatar_cleanup_complete_body")" &&
		"$(avatar_cleanup_sha256 "$signature")" == "$(avatar_cleanup_sha256 "$avatar_cleanup_complete_signature")" ]] || return 1
	avatar_cleanup_validate_public_headers "$temporary/body.headers" application/json || return 1
	avatar_cleanup_validate_public_headers "$temporary/body-two.headers" application/json || return 1
	avatar_cleanup_validate_public_headers "$temporary/signature.headers" application/octet-stream || return 1
	rm -rf -- "$temporary" || return 1
	trap - RETURN
}

avatar_cleanup_validate_absent_route_headers() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	ABSENT_ROUTE_HEADERS="$1" node <<'NODE'
const fs=require('node:fs');
const text=fs.readFileSync(process.env.ABSENT_ROUTE_HEADERS,'utf8').replace(/\r/g,'');
const blocks=text.split('\n\n').filter(block=>/^HTTP\//.test(block));
if(blocks.length!==1||!/^HTTP\/\S+ 404(?: |$)/.test(blocks[0].split('\n')[0])||
  blocks[0].split('\n').slice(1).some(line=>/^location\s*:/i.test(line)))process.exit(1);
NODE
}

avatar_cleanup_verify_temporary_routes_absent() {
	local temporary attempt index suffix status headers
	temporary="$(mktemp -d "$avatar_cleanup_root/.temporary-routes-absent.XXXXXX")" || return 1
	chmod 700 "$temporary"; chown 0:0 "$temporary"
	trap 'rm -rf -- "$temporary"' RETURN
	for attempt in 1 2; do
		index=0
		for suffix in \
			client-ready-v1.json.sig client-ready-v1.json \
			client-retarget-ack-v1.json.sig client-retarget-ack-v1.json \
			runtime-stability-current-v1.json.sig runtime-stability-current-v1.json \
			frontend-runtime-rebind-ready-v1.json.sig frontend-runtime-rebind-ready-v1.json; do
			index=$((index + 1))
			headers="$temporary/attempt-$attempt-route-$index.headers"
			status="$(curl --proto '=https' --tlsv1.2 --silent --show-error --connect-timeout 5 --max-time 15 \
				--max-redirs 0 --dump-header "$headers" --output /dev/null --write-out '%{http_code}' \
				"$AVATAR_API_ORIGIN/.well-known/winwidget/identity-avatar-media/$suffix")" || return 1
			[[ "$status" == '404' ]] || return 1
			avatar_cleanup_validate_absent_route_headers "$headers" || return 1
		done
	done
	rm -rf -- "$temporary" || return 1
	trap - RETURN
}

avatar_cleanup_validate_temporary_public_files_absent() {
	local target
	for target in \
		"$avatar_cleanup_public_client_ready_signature" \
		"$avatar_cleanup_public_client_retarget_ack_signature" \
		"$avatar_cleanup_public_runtime_stability_current_signature" \
		"$avatar_cleanup_public_frontend_rebind_ready_signature" \
		"$avatar_cleanup_public_client_ready_body" \
		"$avatar_cleanup_public_client_retarget_ack_body" \
		"$avatar_cleanup_public_runtime_stability_current_body" \
		"$avatar_cleanup_public_frontend_rebind_ready_body"; do
		[[ ! -e "$target" && ! -L "$target" ]] || return 1
	done
	avatar_cleanup_validate_complete_nginx_config "$avatar_cleanup_public_nginx_target"
}

avatar_cleanup_remove_temporary_public_pairs() {
	local target
	# All detached signatures are withdrawn first. The corresponding bodies are
	# removed only after no temporary pair can still be verified as current.
	for target in \
		"$avatar_cleanup_public_client_ready_signature" \
		"$avatar_cleanup_public_client_retarget_ack_signature" \
		"$avatar_cleanup_public_runtime_stability_current_signature" \
		"$avatar_cleanup_public_frontend_rebind_ready_signature" \
		"$avatar_cleanup_public_client_ready_body" \
		"$avatar_cleanup_public_client_retarget_ack_body" \
		"$avatar_cleanup_public_runtime_stability_current_body" \
		"$avatar_cleanup_public_frontend_rebind_ready_body"; do
		if [[ -e "$target" || -L "$target" ]]; then
			[[ -f "$target" && ! -L "$target" ]] || return 1
			rm -f -- "$target" || return 1
			[[ ! -e "$target" && ! -L "$target" ]] || return 1
			avatar_cleanup_fsync_directory "$avatar_cleanup_public_root" || return 1
		fi
	done
}

avatar_cleanup_publish_cleanup_complete() {
	avatar_cleanup_validate_cleanup_complete_signature || return 1
	[[ "$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" == \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_complete_body")" &&
		"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)" == \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_complete_signature")" ]] || return 1
	if [[ ! -e "$avatar_cleanup_public_root" && ! -L "$avatar_cleanup_public_root" ]]; then
		install -d -o root -g root -m 755 "$avatar_cleanup_public_root" || return 1
	fi
	[[ -d "$avatar_cleanup_public_root" && ! -L "$avatar_cleanup_public_root" &&
		"$(avatar_cleanup_stat_identity "$avatar_cleanup_public_root")" == '0:0:755' ]] || return 1
	avatar_cleanup_publish_public_copy "$avatar_cleanup_complete_signature" \
		"$avatar_cleanup_public_complete_signature" || return 1
	avatar_cleanup_publish_public_copy "$avatar_cleanup_complete_body" \
		"$avatar_cleanup_public_complete_body" || return 1
	avatar_cleanup_install_complete_nginx || return 1
	avatar_cleanup_verify_public_cleanup_complete || return 1
	avatar_cleanup_verify_temporary_routes_absent || return 1
	avatar_cleanup_remove_temporary_public_pairs || return 1
	avatar_cleanup_verify_public_cleanup_complete || return 1
	avatar_cleanup_verify_temporary_routes_absent
}

avatar_cleanup_validate_lifecycle_key_retirement_authorization() {
	[[ $# -eq 1 ]] || return 1
	local authorization="$1"
	avatar_cleanup_validate_private_file "$authorization" || return 1
	avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" || return 1
	if [[ -e "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" || -L "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" ]]; then
		avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" || return 1
	fi
	LIFECYCLE_RETIREMENT_AUTHORIZATION="$authorization" \
		LIFECYCLE_PUBLIC_KEY="$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" \
		LIFECYCLE_PRIVATE_KEY="$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
		CLIENT_REVISION="$AVATAR_CLIENT_REVISION" \
		CLEANUP_COMPLETE_SHA="$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" \
		CLEANUP_COMPLETE_SIGNATURE_SHA="$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
let value;let text;
try { text=new TextDecoder('utf-8',{fatal:true}).decode(
  fs.readFileSync(process.env.LIFECYCLE_RETIREMENT_AUTHORIZATION));value=JSON.parse(text); } catch { process.exit(1); }
const keys=['version','kind','ownershipRevision','cleanupRevision','clientRevision','cleanupCompleteEvidenceSha256',
  'cleanupCompleteSignatureSha256','lifecyclePublicKeyPath','lifecyclePublicKeySha256',
  'lifecyclePublicKeySpkiSha256','lifecyclePrivateKeyPathSha256','lifecyclePrivateKeySha256',
  'privatePublicKeySpkiSha256','authorizedAt','signature'];
if (text!==JSON.stringify(value)||JSON.stringify(Object.keys(value || {})) !== JSON.stringify(keys)) process.exit(1);
const {signature,...payload}=value;
const sha=item=>typeof item==='string'&&/^[0-9a-f]{64}$/.test(item);
const timestamp=item=>typeof item==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(item)&&
  Number.isFinite(Date.parse(item))&&new Date(Date.parse(item)).toISOString().replace('.000Z','Z')===item;
let publicKey;
try { publicKey=crypto.createPublicKey(fs.readFileSync(process.env.LIFECYCLE_PUBLIC_KEY)); }
catch { process.exit(1); }
const publicBytes=fs.readFileSync(process.env.LIFECYCLE_PUBLIC_KEY);
const publicSha=crypto.createHash('sha256').update(publicBytes).digest('hex');
const publicSpkiSha=crypto.createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
if (value.version!==1||value.kind!=='identity-avatar-lifecycle-key-retirement-authorization'||
    value.ownershipRevision!==process.env.OWNERSHIP_REVISION||value.cleanupRevision!==process.env.CLEANUP_REVISION||
    value.ownershipRevision===value.cleanupRevision||value.clientRevision!==process.env.CLIENT_REVISION||
    value.cleanupCompleteEvidenceSha256!==process.env.CLEANUP_COMPLETE_SHA||
    value.cleanupCompleteSignatureSha256!==process.env.CLEANUP_COMPLETE_SIGNATURE_SHA||
    value.lifecyclePublicKeyPath!=='/opt/winwidget/deploy/backend/.identity-avatar-media-signing.public.pem'||
    value.lifecyclePublicKeySha256!==publicSha||value.lifecyclePublicKeySpkiSha256!==publicSpkiSha||
    value.lifecyclePrivateKeyPathSha256!==crypto.createHash('sha256').update(process.env.LIFECYCLE_PRIVATE_KEY).digest('hex')||
    !sha(value.lifecyclePrivateKeySha256)||value.privatePublicKeySpkiSha256!==publicSpkiSha||
    !timestamp(value.authorizedAt)||Date.parse(value.authorizedAt)>Date.now()+120000||
    publicKey.asymmetricKeyType!=='ed25519'||typeof signature!=='string'||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)||Buffer.from(signature,'base64').length!==64||
    Buffer.from(signature,'base64').toString('base64')!==signature||
    !crypto.verify(null,Buffer.from(JSON.stringify(payload)),publicKey,Buffer.from(signature,'base64'))) process.exit(1);
if (fs.existsSync(process.env.LIFECYCLE_PRIVATE_KEY)) {
  let privateKey;
  try { privateKey=crypto.createPrivateKey(fs.readFileSync(process.env.LIFECYCLE_PRIVATE_KEY)); }
  catch { process.exit(1); }
  const privateSha=crypto.createHash('sha256').update(fs.readFileSync(process.env.LIFECYCLE_PRIVATE_KEY)).digest('hex');
  const privateSpkiSha=crypto.createHash('sha256').update(
    crypto.createPublicKey(privateKey).export({type:'spki',format:'der'})).digest('hex');
  if (privateKey.asymmetricKeyType!=='ed25519'||value.lifecyclePrivateKeySha256!==privateSha||
      value.privatePublicKeySpkiSha256!==privateSpkiSha) process.exit(1);
}
NODE
}

avatar_cleanup_create_lifecycle_key_retirement_authorization() {
	local target="$avatar_cleanup_lifecycle_key_retirement_authorization" prepared="${avatar_cleanup_lifecycle_key_retirement_authorization}.prepared"
	if [[ -f "$target" && ! -L "$target" && -f "$prepared" && ! -L "$prepared" ]]; then
		avatar_cleanup_promote_immutable_file "$prepared" "$target" || return 1
	fi
	if [[ ! -e "$target" && ! -L "$target" ]]; then
		avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" || return 1
		avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" || return 1
		if [[ ! -e "$prepared" && ! -L "$prepared" ]]; then
			LIFECYCLE_RETIREMENT_AUTHORIZATION="$prepared" \
				LIFECYCLE_PUBLIC_KEY="$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" \
				LIFECYCLE_PRIVATE_KEY="$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" \
				OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
				CLIENT_REVISION="$AVATAR_CLIENT_REVISION" \
				CLEANUP_COMPLETE_SHA="$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" \
				CLEANUP_COMPLETE_SIGNATURE_SHA="$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)" \
				AUTHORIZED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" node <<'NODE' || return 1
const fs=require('node:fs');const crypto=require('node:crypto');
let privateKey,publicKey;
try {
  privateKey=crypto.createPrivateKey(fs.readFileSync(process.env.LIFECYCLE_PRIVATE_KEY));
  publicKey=crypto.createPublicKey(fs.readFileSync(process.env.LIFECYCLE_PUBLIC_KEY));
} catch { process.exit(1); }
if(privateKey.asymmetricKeyType!=='ed25519'||publicKey.asymmetricKeyType!=='ed25519')process.exit(1);
const privateBytes=fs.readFileSync(process.env.LIFECYCLE_PRIVATE_KEY);
const publicBytes=fs.readFileSync(process.env.LIFECYCLE_PUBLIC_KEY);
const publicSpki=publicKey.export({type:'spki',format:'der'});
const privateSpki=crypto.createPublicKey(privateKey).export({type:'spki',format:'der'});
if(!Buffer.from(publicSpki).equals(Buffer.from(privateSpki)))process.exit(1);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const payload={version:1,kind:'identity-avatar-lifecycle-key-retirement-authorization',
  ownershipRevision:process.env.OWNERSHIP_REVISION,cleanupRevision:process.env.CLEANUP_REVISION,
  clientRevision:process.env.CLIENT_REVISION,cleanupCompleteEvidenceSha256:process.env.CLEANUP_COMPLETE_SHA,
  cleanupCompleteSignatureSha256:process.env.CLEANUP_COMPLETE_SIGNATURE_SHA,
  lifecyclePublicKeyPath:'/opt/winwidget/deploy/backend/.identity-avatar-media-signing.public.pem',
  lifecyclePublicKeySha256:sha(publicBytes),lifecyclePublicKeySpkiSha256:sha(publicSpki),
  lifecyclePrivateKeyPathSha256:sha(process.env.LIFECYCLE_PRIVATE_KEY),
  lifecyclePrivateKeySha256:sha(privateBytes),privatePublicKeySpkiSha256:sha(privateSpki),
  authorizedAt:process.env.AUTHORIZED_AT};
const signature=crypto.sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString('base64');
const fd=fs.openSync(process.env.LIFECYCLE_RETIREMENT_AUTHORIZATION,'wx',0o600);
try{fs.writeFileSync(fd,JSON.stringify({...payload,signature}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
NODE
			chown 0:0 "$prepared" || return 1
		fi
		avatar_cleanup_validate_lifecycle_key_retirement_authorization "$prepared" || return 1
		avatar_cleanup_promote_immutable_file "$prepared" "$target" || return 1
	fi
	avatar_cleanup_validate_lifecycle_key_retirement_authorization "$target"
}

avatar_cleanup_validate_lifecycle_key_retirement_evidence_payload() {
	avatar_cleanup_validate_lifecycle_key_retirement_authorization \
		"$avatar_cleanup_lifecycle_key_retirement_authorization" || return 1
	[[ ! -e "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" && ! -L "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" ]] || return 1
	avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" || return 1
	avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY" || return 1
	avatar_cleanup_validate_ownership_client_artifact || return 1
	avatar_cleanup_validate_cleanup_complete_signature || return 1
	[[ "$(avatar_cleanup_sha256 "$avatar_cleanup_complete_body")" == \
		"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" &&
		"$(avatar_cleanup_sha256 "$avatar_cleanup_complete_signature")" == \
		"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)" ]] || return 1
	avatar_cleanup_validate_temporary_public_files_absent || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_lifecycle_key_retirement" || return 1
	LIFECYCLE_RETIREMENT_EVIDENCE="$avatar_cleanup_lifecycle_key_retirement" \
		LIFECYCLE_RETIREMENT_AUTHORIZATION="$avatar_cleanup_lifecycle_key_retirement_authorization" \
		LIFECYCLE_PUBLIC_KEY="$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" \
		FRONTEND_PUBLIC_KEY="$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY" \
		LIFECYCLE_PRIVATE_KEY="$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
		CLIENT_REVISION="$AVATAR_CLIENT_REVISION" node <<'NODE'
const fs=require('node:fs');const crypto=require('node:crypto');
let value,authorization;
try{value=JSON.parse(fs.readFileSync(process.env.LIFECYCLE_RETIREMENT_EVIDENCE,'utf8'));
  authorization=JSON.parse(fs.readFileSync(process.env.LIFECYCLE_RETIREMENT_AUTHORIZATION,'utf8'));}
catch{process.exit(1);}
const keys=['version','action','ownershipRevision','cleanupRevision','clientRevision','authorizationEvidenceSha256',
  'lifecyclePublicKeySha256','lifecyclePublicKeySpkiSha256','lifecyclePrivateKeyPathSha256',
  'lifecyclePrivateKeySha256','privateKeyAbsent','publicCleanupCompleteVerified','temporaryBackendRoutesAbsent',
  'lifecyclePublicKeyRetained','frontendPublicKeyRetained','retiredAt'];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const timestamp=item=>typeof item==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(item)&&
  Number.isFinite(Date.parse(item))&&new Date(Date.parse(item)).toISOString().replace('.000Z','Z')===item;
let publicKey,frontendKey;try{publicKey=crypto.createPublicKey(fs.readFileSync(process.env.LIFECYCLE_PUBLIC_KEY));
  frontendKey=crypto.createPublicKey(fs.readFileSync(process.env.FRONTEND_PUBLIC_KEY));}catch{process.exit(1);}
if(JSON.stringify(Object.keys(value||{}))!==JSON.stringify(keys)||value.version!==1||
  value.action!=='avatar-lifecycle-signing-key-retirement'||value.ownershipRevision!==process.env.OWNERSHIP_REVISION||
  value.cleanupRevision!==process.env.CLEANUP_REVISION||value.ownershipRevision===value.cleanupRevision||
  value.clientRevision!==process.env.CLIENT_REVISION||
  value.authorizationEvidenceSha256!==sha(fs.readFileSync(process.env.LIFECYCLE_RETIREMENT_AUTHORIZATION))||
  value.lifecyclePublicKeySha256!==sha(fs.readFileSync(process.env.LIFECYCLE_PUBLIC_KEY))||
  value.lifecyclePublicKeySpkiSha256!==sha(publicKey.export({type:'spki',format:'der'}))||
  value.lifecyclePrivateKeyPathSha256!==sha(process.env.LIFECYCLE_PRIVATE_KEY)||
  value.lifecyclePrivateKeySha256!==authorization.lifecyclePrivateKeySha256||value.privateKeyAbsent!==true||
  value.publicCleanupCompleteVerified!==true||value.temporaryBackendRoutesAbsent!==true||
  value.lifecyclePublicKeyRetained!==true||value.frontendPublicKeyRetained!==true||
  publicKey.asymmetricKeyType!=='ed25519'||frontendKey.asymmetricKeyType!=='ed25519'||!timestamp(value.retiredAt)||
  Date.parse(value.retiredAt)<Date.parse(authorization.authorizedAt)||Date.parse(value.retiredAt)>Date.now()+120000)
  process.exit(1);
NODE
}

avatar_cleanup_validate_lifecycle_key_retirement_evidence_local() {
	avatar_cleanup_validate_lifecycle_key_retirement_evidence_payload || return 1
	avatar_cleanup_verify_artifact "$avatar_cleanup_lifecycle_key_retirement"
}

avatar_cleanup_validate_lifecycle_key_retirement_evidence() {
	avatar_cleanup_validate_lifecycle_key_retirement_evidence_local || return 1
	avatar_cleanup_verify_public_cleanup_complete || return 1
	avatar_cleanup_verify_temporary_routes_absent
}

avatar_cleanup_retire_lifecycle_signing_key() {
	avatar_cleanup_verify_public_cleanup_complete || return 1
	avatar_cleanup_verify_temporary_routes_absent || return 1
	avatar_cleanup_create_lifecycle_key_retirement_authorization || return 1
	if [[ -e "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" || -L "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" ]]; then
		avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" || return 1
		rm -f -- "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" || return 1
		avatar_cleanup_fsync_directory "$(dirname -- "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY")" || return 1
	fi
	[[ ! -e "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" && ! -L "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" ]] || return 1
	avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" || return 1
	avatar_cleanup_validate_private_file "$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY" || return 1
	avatar_cleanup_validate_ownership_client_artifact || return 1
	avatar_cleanup_validate_temporary_public_files_absent || return 1
	if [[ ! -e "$avatar_cleanup_lifecycle_key_retirement" && ! -L "$avatar_cleanup_lifecycle_key_retirement" ]]; then
		local source="$avatar_cleanup_root/.lifecycle-key-retirement.$$"
		LIFECYCLE_RETIREMENT_SOURCE="$source" \
			LIFECYCLE_RETIREMENT_AUTHORIZATION="$avatar_cleanup_lifecycle_key_retirement_authorization" \
			LIFECYCLE_PUBLIC_KEY="$IDENTITY_AVATAR_SIGNING_PUBLIC_KEY" \
			FRONTEND_PUBLIC_KEY="$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY" \
			LIFECYCLE_PRIVATE_KEY="$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" \
			OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
			CLIENT_REVISION="$AVATAR_CLIENT_REVISION" RETIRED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" node <<'NODE' || return 1
const fs=require('node:fs');const crypto=require('node:crypto');
const authorization=JSON.parse(fs.readFileSync(process.env.LIFECYCLE_RETIREMENT_AUTHORIZATION,'utf8'));
const publicKey=crypto.createPublicKey(fs.readFileSync(process.env.LIFECYCLE_PUBLIC_KEY));
const frontendKey=crypto.createPublicKey(fs.readFileSync(process.env.FRONTEND_PUBLIC_KEY));
if(publicKey.asymmetricKeyType!=='ed25519'||frontendKey.asymmetricKeyType!=='ed25519')process.exit(1);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const value={version:1,action:'avatar-lifecycle-signing-key-retirement',
  ownershipRevision:process.env.OWNERSHIP_REVISION,cleanupRevision:process.env.CLEANUP_REVISION,
  clientRevision:process.env.CLIENT_REVISION,
  authorizationEvidenceSha256:sha(fs.readFileSync(process.env.LIFECYCLE_RETIREMENT_AUTHORIZATION)),
  lifecyclePublicKeySha256:sha(fs.readFileSync(process.env.LIFECYCLE_PUBLIC_KEY)),
  lifecyclePublicKeySpkiSha256:sha(publicKey.export({type:'spki',format:'der'})),
  lifecyclePrivateKeyPathSha256:sha(process.env.LIFECYCLE_PRIVATE_KEY),
  lifecyclePrivateKeySha256:authorization.lifecyclePrivateKeySha256,privateKeyAbsent:true,
  publicCleanupCompleteVerified:true,temporaryBackendRoutesAbsent:true,lifecyclePublicKeyRetained:true,
  frontendPublicKeyRetained:true,retiredAt:process.env.RETIRED_AT};
fs.writeFileSync(process.env.LIFECYCLE_RETIREMENT_SOURCE,`${JSON.stringify(value)}\n`,{mode:0o600,flag:'wx'});
NODE
		chown 0:0 "$source" || return 1
		avatar_cleanup_write_json_artifact "$avatar_cleanup_lifecycle_key_retirement" "$source" || return 1
		rm -f -- "$source" || return 1
	fi
	if ! avatar_cleanup_verify_artifact "$avatar_cleanup_lifecycle_key_retirement"; then
		avatar_cleanup_validate_lifecycle_key_retirement_evidence_payload || return 1
		avatar_cleanup_sign_artifact "$avatar_cleanup_lifecycle_key_retirement" || return 1
	fi
	avatar_cleanup_validate_lifecycle_key_retirement_evidence
}

avatar_cleanup_bind_lifecycle_key_retirement() {
	[[ "$(avatar_cleanup_marker_value phase)" == 'complete' ]] || return 1
	avatar_cleanup_retire_lifecycle_signing_key || return 1
	local evidence_sha
	evidence_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_lifecycle_key_retirement")" || return 1
	if [[ "$(avatar_cleanup_marker_value lifecycle_key_retirement_evidence_sha256)" == 'pending' ]]; then
		avatar_cleanup_update_forward_marker complete \
			"$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
			"$(avatar_cleanup_marker_value retirement_evidence_sha256)" \
			"$(avatar_cleanup_marker_value revocation_evidence_sha256)" \
			"$(avatar_cleanup_marker_value nginx_evidence_sha256)" \
			"$(avatar_cleanup_marker_value smoke_evidence_sha256)" \
			"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" \
			"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)" \
			"$evidence_sha" || return 1
	fi
	[[ "$(avatar_cleanup_marker_value lifecycle_key_retirement_evidence_sha256)" == "$evidence_sha" ]] || return 1
	avatar_cleanup_validate_lifecycle_key_retirement_evidence
}

avatar_cleanup_unset_audit_environment() {
	unset AVATAR_AUDIT_DATABASE_URL AVATAR_AUDIT_ENDPOINT AVATAR_AUDIT_REGION AVATAR_AUDIT_BUCKET
	unset AVATAR_AUDIT_FORCE_PATH_STYLE AVATAR_AUDIT_PUBLIC_BASE_URL AVATAR_AUDIT_KEY_PREFIX
	unset AVATAR_AUDIT_LEGACY_KEY_PREFIX
}

avatar_cleanup_durable_unlink_private_file() {
	[[ $# -eq 1 ]] || return 1
	local target="$1"
	if [[ ! -e "$target" && ! -L "$target" ]]; then
		return
	fi
	avatar_cleanup_validate_private_file "$target" || return 1
	rm -f -- "$target" || return 1
	avatar_cleanup_fsync_directory "$(dirname -- "$target")"
}

avatar_cleanup_require_retirement_tmpfs() {
	local parent filesystem
	parent="$(dirname -- "$AVATAR_RETIREMENT_CREDENTIAL_FILE")" || return 1
	[[ "$parent" == '/run/winwidget' && -d "$parent" && ! -L "$parent" &&
		"$(avatar_cleanup_stat_identity "$parent")" == '0:0:700' ]] ||
		avatar_cleanup_fail 'retirement credential must be isolated in /run/winwidget mode 0700' || return 1
	filesystem="$(findmnt -n -o FSTYPE --target "$parent")" || return 1
	[[ "$filesystem" == 'tmpfs' ]] ||
		avatar_cleanup_fail 'retirement credential directory must be backed by tmpfs' || return 1
}

avatar_cleanup_load_retirement_credential() {
	avatar_cleanup_require_retirement_tmpfs || return 1
	avatar_cleanup_validate_private_file "$AVATAR_RETIREMENT_CREDENTIAL_FILE" ||
		avatar_cleanup_fail 'a root-owned mode-600 one-use retirement credential file is required' || return 1
	avatar_cleanup_retirement_access_key_sha="$(RETIREMENT_FILE="$AVATAR_RETIREMENT_CREDENTIAL_FILE" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const bytes = fs.readFileSync(process.env.RETIREMENT_FILE);
if (bytes.length < 74 || bytes.length > 1024) process.exit(1);
let text;
try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { process.exit(1); }
const match = /^access_key_id=([A-Za-z0-9._-]{8,256})\nsecret_access_key=([A-Za-z0-9+\/_=-]{32,512})\n$/.exec(text);
if (!match || Buffer.byteLength(text) !== bytes.length) process.exit(1);
process.stdout.write(crypto.createHash('sha256').update(match[1]).digest('hex'));
NODE
)" || return 1
	[[ "$avatar_cleanup_retirement_access_key_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
}

avatar_cleanup_require_retirement_deploy_lock() {
	local lock_file descriptor
	lock_file="${PRODUCTION_DEPLOY_LOCK_FILE:-${APP_ROOT:-/opt/winwidget}/deploy/backend/.production-deploy.lock}"
	[[ "${PRODUCTION_DEPLOY_LOCK_FD:-}" =~ ^[0-9]+$ &&
		"${WINWIDGET_PRODUCTION_DEPLOY_LOCK_HELD:-}" == "$lock_file" ]] || return 1
	descriptor="$(readlink "/proc/$$/fd/$PRODUCTION_DEPLOY_LOCK_FD" 2>/dev/null || true)"
	[[ "$descriptor" == "$lock_file" ]]
}

avatar_cleanup_validate_retirement_image() {
	[[ $# -eq 1 && "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local image="$1" expected_image expected_runtime_sha record
	expected_image="$(avatar_cleanup_marker_value identity_api_image_id)" || return 1
	[[ "$image" == "$expected_image" ]] || return 1
	expected_runtime_sha="$(avatar_cleanup_marker_value runtime_evidence_sha256)" || return 1
	avatar_cleanup_require_signed_hash "$avatar_cleanup_runtime" "$expected_runtime_sha" || return 1
	RUNTIME_FILE="$avatar_cleanup_runtime" IMAGE_ID="$image" RUNTIME_REVISION="$avatar_cleanup_runtime_revision" node <<'NODE' || return 1
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.RUNTIME_FILE, 'utf8'));
if (value?.version !== 1 || value.action !== 'avatar-core-source-runtime-verification' ||
    value.currentRuntimeRevision !== process.env.RUNTIME_REVISION ||
    value.services?.identityApi?.imageId !== process.env.IMAGE_ID ||
    value.services.identityApi.ociRevision !== process.env.RUNTIME_REVISION) process.exit(1);
NODE
	record="$(docker image inspect --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.title"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" || return 1
	[[ "$record" == "$image|winwidget-identity|$avatar_cleanup_runtime_revision" ]]
}

avatar_cleanup_retirement_image_id() {
	local image
	image="$(avatar_cleanup_marker_value identity_api_image_id)" || return 1
	avatar_cleanup_validate_retirement_image "$image" || return 1
	printf '%s\n' "$image"
}

avatar_cleanup_retirement_consumer_name() {
	[[ $# -eq 1 && "$1" =~ ^(inventory|delete)$ && "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
	printf 'winwidget-avatar-retirement-%s-%s\n' "$1" "${EXPECTED_REVISION:0:12}"
}

avatar_cleanup_retirement_consumer_cidfile() {
	[[ $# -eq 1 && "$1" =~ ^(inventory|delete)$ ]] || return 1
	printf '%s/.retirement-consumer-%s.cid\n' "$avatar_cleanup_root" "$1"
}

avatar_cleanup_read_retirement_consumer_cidfile() {
	[[ $# -eq 1 && "$1" =~ ^(inventory|delete)$ ]] || return 1
	local cidfile
	cidfile="$(avatar_cleanup_retirement_consumer_cidfile "$1")" || return 1
	avatar_cleanup_validate_private_file "$cidfile" || return 1
	RETIREMENT_CIDFILE="$cidfile" node <<'NODE'
const fs=require('node:fs');const bytes=fs.readFileSync(process.env.RETIREMENT_CIDFILE);
if(bytes.length!==64||!new TextDecoder('utf-8',{fatal:true}).decode(bytes).match(/^[0-9a-f]{64}$/))process.exit(1);
process.stdout.write(bytes);
NODE
}

avatar_cleanup_persist_retirement_consumer_cidfile() {
	[[ $# -eq 2 && "$1" =~ ^(inventory|delete)$ && "$2" =~ ^[0-9a-f]{64}$ ]] || return 1
	local operation="$1" container="$2" cidfile actual
	cidfile="$(avatar_cleanup_retirement_consumer_cidfile "$operation")" || return 1
	if [[ ! -e "$cidfile" && ! -L "$cidfile" ]]; then
		RETIREMENT_CIDFILE="$cidfile" RETIREMENT_CONTAINER_ID="$container" node <<'NODE' || return 1
const fs=require('node:fs');const path=require('node:path');const bytes=Buffer.from(process.env.RETIREMENT_CONTAINER_ID);
if(bytes.length!==64||!/^[0-9a-f]{64}$/.test(bytes.toString('utf8')))process.exit(1);
const fd=fs.openSync(process.env.RETIREMENT_CIDFILE,'wx',0o600);
try{let offset=0;while(offset<bytes.length){const written=fs.writeSync(fd,bytes,offset,bytes.length-offset);
 if(written<=0)process.exit(1);offset+=written;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
const directory=fs.openSync(path.dirname(process.env.RETIREMENT_CIDFILE),'r');
try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
NODE
		chmod 600 "$cidfile" || return 1
		chown 0:0 "$cidfile" || return 1
		avatar_cleanup_fsync_file_and_parent "$cidfile" || return 1
	fi
	actual="$(avatar_cleanup_read_retirement_consumer_cidfile "$operation")" || return 1
	[[ "$actual" == "$container" ]] || return 1
	avatar_cleanup_fsync_file_and_parent "$cidfile"
}

avatar_cleanup_verify_timeweb_provider_evidence() {
	[[ $# -eq 4 && "$4" =~ ^avatar-retirement-credential-(policy|revocation)$ ]] || return 1
	local evidence="$1" signature="$2" public_key="$3" expected_action="$4"
	[[ -f "$evidence" && ! -L "$evidence" && -f "$signature" && ! -L "$signature" &&
		-f "$public_key" && ! -L "$public_key" ]] || return 1
	openssl pkeyutl -verify -pubin -inkey "$public_key" \
		-rawin -sigfile "$signature" -in "$evidence" >/dev/null 2>&1 || return 1
	SIGNED_PROVIDER_FILE="$evidence" EXPECTED_PROVIDER_ACTION="$expected_action" node <<'NODE'
const value = JSON.parse(require('node:fs').readFileSync(process.env.SIGNED_PROVIDER_FILE, 'utf8'));
if (!value || typeof value !== 'object' || Array.isArray(value) ||
    value.action !== process.env.EXPECTED_PROVIDER_ACTION || value.provider !== 'timeweb-s3') process.exit(1);
NODE
}

avatar_cleanup_require_retirement_policy_evidence() {
	[[ $# -le 1 && "${1:-archived}" =~ ^(active|archived)$ ]] || return 1
	local policy_mode="${1:-archived}"
	[[ "$avatar_cleanup_retirement_access_key_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	avatar_cleanup_validate_private_file "$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" || return 1
	[[ -d "$AVATAR_RETIREMENT_REVOCATION_ROOT" && ! -L "$AVATAR_RETIREMENT_REVOCATION_ROOT" &&
		"$(avatar_cleanup_stat_identity "$AVATAR_RETIREMENT_REVOCATION_ROOT")" == '0:0:700' ]] || return 1
	local evidence="$AVATAR_RETIREMENT_REVOCATION_ROOT/$avatar_cleanup_retirement_access_key_sha.policy.json"
	local signature="${evidence}.sig"
	avatar_cleanup_validate_private_file "$evidence" || return 1
	avatar_cleanup_validate_private_file "$signature" || return 1
	POLICY_PUBLIC_KEY="$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" node -e '
const {createPublicKey}=require("node:crypto");const fs=require("node:fs");
const key=createPublicKey(fs.readFileSync(process.env.POLICY_PUBLIC_KEY));
if(key.asymmetricKeyType!=="ed25519")process.exit(1);' || return 1
	avatar_cleanup_verify_timeweb_provider_evidence "$evidence" "$signature" \
		"$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" avatar-retirement-credential-policy || return 1
	local endpoint_sha public_base_sha
	endpoint_sha="$(printf '%s' "$AVATAR_AUDIT_ENDPOINT" | identity_cutover_text_sha256)" || return 1
	public_base_sha="$(printf '%s' "$AVATAR_AUDIT_PUBLIC_BASE_URL" | identity_cutover_text_sha256)" || return 1
	POLICY_FILE="$evidence" POLICY_SIGNATURE="$signature" POLICY_PUBLIC_KEY="$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" \
		EXPECTED_KEY_SHA="$avatar_cleanup_retirement_access_key_sha" \
		POLICY_MODE="$policy_mode" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
		ENDPOINT_SHA="$endpoint_sha" PUBLIC_BASE_SHA="$public_base_sha" REGION="$AVATAR_AUDIT_REGION" \
		BUCKET="$AVATAR_AUDIT_BUCKET" FORCE_PATH_STYLE="$AVATAR_AUDIT_FORCE_PATH_STYLE" \
		NEW_PREFIX="$AVATAR_AUDIT_KEY_PREFIX" LEGACY_PREFIX="$AVATAR_AUDIT_LEGACY_KEY_PREFIX" node <<'NODE' || return 1
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.env.POLICY_FILE, 'utf8'));
const exact = (item, keys) => item && typeof item === 'object' && !Array.isArray(item) &&
  JSON.stringify(Object.keys(item)) === JSON.stringify(keys);
const keys = ['version','action','provider','ownershipRevision','cleanupRevision','retirementAccessKeyIdSha256',
  'endpointSha256','publicBaseUrlSha256','region','bucket','forcePathStyle','newPrefix','legacyPrefix',
  'allowedBucketActions','allowedObjectActions','deniedActions','scopeExact','newPrefixDenied',
  'outsideLegacyPrefixDenied','otherBucketsDenied','exactLegacyPrefixConditionSha256','policyDocumentSha256',
  'temporary','issuedAt','expiresAt','verificationIdSha256'];
const bucketActions = ['s3:GetBucketVersioning','s3:ListBucket','s3:ListBucketVersions'];
const objectActions = ['s3:GetObject','s3:GetObjectVersion','s3:DeleteObject','s3:DeleteObjectVersion'];
const deniedActions = ['s3:PutObject'];
const issued = Date.parse(value?.issuedAt);
const expires = Date.parse(value?.expiresAt);
const now = Date.now();
if (!exact(value, keys) || value.version !== 1 || value.action !== 'avatar-retirement-credential-policy' ||
    value.provider !== 'timeweb-s3' || value.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    value.retirementAccessKeyIdSha256 !== process.env.EXPECTED_KEY_SHA ||
    value.endpointSha256 !== process.env.ENDPOINT_SHA || value.publicBaseUrlSha256 !== process.env.PUBLIC_BASE_SHA ||
    value.region !== process.env.REGION || value.bucket !== process.env.BUCKET ||
    value.forcePathStyle !== (process.env.FORCE_PATH_STYLE === 'true') || value.newPrefix !== process.env.NEW_PREFIX ||
    value.legacyPrefix !== process.env.LEGACY_PREFIX ||
    JSON.stringify(value.allowedBucketActions) !== JSON.stringify(bucketActions) ||
    JSON.stringify(value.allowedObjectActions) !== JSON.stringify(objectActions) ||
    JSON.stringify(value.deniedActions) !== JSON.stringify(deniedActions) || value.scopeExact !== true ||
    value.newPrefixDenied !== true || value.outsideLegacyPrefixDenied !== true || value.otherBucketsDenied !== true ||
    !/^[0-9a-f]{64}$/.test(value.exactLegacyPrefixConditionSha256 || '') ||
    !/^[0-9a-f]{64}$/.test(value.policyDocumentSha256 || '') || value.temporary !== true ||
    !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 300000 ||
    (process.env.POLICY_MODE === 'active' && expires <= now) ||
    expires - issued > 86400000 || !/^[0-9a-f]{64}$/.test(value.verificationIdSha256 || '')) process.exit(1);
NODE
	avatar_cleanup_retirement_policy_evidence="$evidence"
	avatar_cleanup_retirement_policy_signature="$signature"
	avatar_cleanup_retirement_policy_sha="$(avatar_cleanup_sha256 "$evidence")" || return 1
	avatar_cleanup_retirement_policy_signature_sha="$(avatar_cleanup_sha256 "$signature")" || return 1
	avatar_cleanup_storage_endpoint_sha="$endpoint_sha"
	avatar_cleanup_storage_public_base_sha="$public_base_sha"
}

avatar_cleanup_record_retirement_attempt() {
	[[ $# -eq 1 && ( "$1" == 'pending' || "$1" =~ ^[0-9a-f]{64}$ ) ]] || return 1
	[[ "$avatar_cleanup_retirement_access_key_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	local attempt="$avatar_cleanup_root/retirement-credential-attempt-$avatar_cleanup_retirement_access_key_sha.json"
	[[ ! -e "$attempt" && ! -L "$attempt" &&
		! -e "${attempt}.hmac-sha256" && ! -L "${attempt}.hmac-sha256" ]] ||
		avatar_cleanup_fail 'one-use retirement credential was already attempted and must not be reused' || return 1
	local temporary="$avatar_cleanup_root/.retirement-attempt.$$"
	ATTEMPT_OUTPUT="$temporary" ACCESS_KEY_SHA="$avatar_cleanup_retirement_access_key_sha" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
		INVENTORY_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_inventory_manifest")" \
		SEALED_INVENTORY_SHA="$1" POLICY_SHA="$avatar_cleanup_retirement_policy_sha" \
		POLICY_SIGNATURE_SHA="$avatar_cleanup_retirement_policy_signature_sha" \
		ENDPOINT_SHA="$avatar_cleanup_storage_endpoint_sha" PUBLIC_BASE_SHA="$avatar_cleanup_storage_public_base_sha" \
		REGION="$AVATAR_AUDIT_REGION" BUCKET="$AVATAR_AUDIT_BUCKET" FORCE_PATH_STYLE="$AVATAR_AUDIT_FORCE_PATH_STYLE" \
		NEW_PREFIX="$AVATAR_AUDIT_KEY_PREFIX" LEGACY_PREFIX="$AVATAR_AUDIT_LEGACY_KEY_PREFIX" node <<'NODE' || return 1
const fs = require('node:fs');
const value = { version: 1, action: 'avatar-retirement-credential-attempt',
  ownershipRevision: process.env.OWNERSHIP_REVISION, cleanupRevision: process.env.CLEANUP_REVISION,
  inventoryManifestSha256: process.env.INVENTORY_SHA,
  sealedInventorySha256: process.env.SEALED_INVENTORY_SHA,
  retirementPolicyEvidenceSha256: process.env.POLICY_SHA,
  retirementPolicySignatureSha256: process.env.POLICY_SIGNATURE_SHA,
  storageEndpointSha256: process.env.ENDPOINT_SHA, storagePublicBaseUrlSha256: process.env.PUBLIC_BASE_SHA,
  storageRegion: process.env.REGION, storageBucket: process.env.BUCKET,
  storageForcePathStyle: process.env.FORCE_PATH_STYLE === 'true', newPrefix: process.env.NEW_PREFIX,
  legacyPrefix: process.env.LEGACY_PREFIX,
  retirementAccessKeyIdSha256: process.env.ACCESS_KEY_SHA, attemptedAt: new Date().toISOString() };
fs.writeFileSync(process.env.ATTEMPT_OUTPUT, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -f -- "$temporary" "$attempt" || return 1
	avatar_cleanup_fsync_file_and_parent "$attempt" || return 1
	avatar_cleanup_sign_artifact "$attempt" || return 1
	avatar_cleanup_retirement_attempt="$attempt"
}

avatar_cleanup_recover_retirement_attempt_signature() (
	[[ $# -eq 2 && "$2" =~ ^[0-9a-f]{64}$ ]] || return 1
	local attempt="$1" key_sha="$2"
	avatar_cleanup_validate_private_file "$attempt" || return 1
	avatar_cleanup_load_storage_environment || return 1
	local avatar_cleanup_retirement_access_key_sha="$key_sha"
	local avatar_cleanup_retirement_policy_evidence avatar_cleanup_retirement_policy_signature
	local avatar_cleanup_retirement_policy_sha avatar_cleanup_retirement_policy_signature_sha
	local avatar_cleanup_storage_endpoint_sha avatar_cleanup_storage_public_base_sha
	avatar_cleanup_require_retirement_policy_evidence archived || return 1
	ATTEMPT_FILE="$attempt" KEY_SHA="$key_sha" INVENTORY_FILE="$avatar_cleanup_inventory_manifest" \
		SEALED_FILE="$avatar_cleanup_retirement_inventory" OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" \
		CLEANUP_REVISION="$EXPECTED_REVISION" POLICY_FILE="$avatar_cleanup_retirement_policy_evidence" \
		POLICY_SHA="$avatar_cleanup_retirement_policy_sha" POLICY_SIGNATURE_SHA="$avatar_cleanup_retirement_policy_signature_sha" \
		ENDPOINT_SHA="$avatar_cleanup_storage_endpoint_sha" PUBLIC_BASE_SHA="$avatar_cleanup_storage_public_base_sha" \
		REGION="$AVATAR_AUDIT_REGION" BUCKET="$AVATAR_AUDIT_BUCKET" FORCE_PATH_STYLE="$AVATAR_AUDIT_FORCE_PATH_STYLE" \
		NEW_PREFIX="$AVATAR_AUDIT_KEY_PREFIX" LEGACY_PREFIX="$AVATAR_AUDIT_LEGACY_KEY_PREFIX" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const value = JSON.parse(fs.readFileSync(process.env.ATTEMPT_FILE, 'utf8'));
const policy = JSON.parse(fs.readFileSync(process.env.POLICY_FILE, 'utf8'));
const keys = ['version','action','ownershipRevision','cleanupRevision','inventoryManifestSha256','sealedInventorySha256',
  'retirementPolicyEvidenceSha256','retirementPolicySignatureSha256','storageEndpointSha256','storagePublicBaseUrlSha256',
  'storageRegion','storageBucket','storageForcePathStyle','newPrefix','legacyPrefix','retirementAccessKeyIdSha256','attemptedAt'];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sealedExpected = fs.existsSync(process.env.SEALED_FILE) ? sha(process.env.SEALED_FILE) : null;
if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys) || value.version !== 1 ||
    value.action !== 'avatar-retirement-credential-attempt' || value.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION || value.inventoryManifestSha256 !== sha(process.env.INVENTORY_FILE) ||
    !(value.sealedInventorySha256 === 'pending' || (sealedExpected && value.sealedInventorySha256 === sealedExpected)) ||
    value.retirementPolicyEvidenceSha256 !== process.env.POLICY_SHA ||
    value.retirementPolicySignatureSha256 !== process.env.POLICY_SIGNATURE_SHA ||
    value.storageEndpointSha256 !== process.env.ENDPOINT_SHA || value.storagePublicBaseUrlSha256 !== process.env.PUBLIC_BASE_SHA ||
    value.storageRegion !== process.env.REGION || value.storageBucket !== process.env.BUCKET ||
    value.storageForcePathStyle !== (process.env.FORCE_PATH_STYLE === 'true') || value.newPrefix !== process.env.NEW_PREFIX ||
    value.legacyPrefix !== process.env.LEGACY_PREFIX || value.retirementAccessKeyIdSha256 !== process.env.KEY_SHA ||
    !Number.isFinite(Date.parse(value.attemptedAt)) || Date.parse(value.attemptedAt) < Date.parse(policy.issuedAt) ||
    Date.parse(value.attemptedAt) > Date.parse(policy.expiresAt) || Date.parse(value.attemptedAt) > Date.now() + 300000) process.exit(1);
NODE
	if [[ -e "${attempt}.hmac-sha256" || -L "${attempt}.hmac-sha256" ]]; then
		avatar_cleanup_verify_artifact "$attempt"
	else
		avatar_cleanup_sign_artifact "$attempt"
	fi
)

avatar_cleanup_set_retirement_journal_scope() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{64}$ ]] || return 1
	avatar_cleanup_retirement_access_key_sha="$1"
	avatar_cleanup_retirement_attempt="$avatar_cleanup_root/retirement-credential-attempt-$1.json"
	avatar_cleanup_retirement_journal_key="$avatar_cleanup_root/retirement-journal-key-$1"
	avatar_cleanup_retirement_journal_key_context="$avatar_cleanup_root/retirement-journal-key-context-$1.json"
}

avatar_cleanup_retirement_journal_scope_json() {
	[[ "$avatar_cleanup_retirement_access_key_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	avatar_cleanup_verify_artifact "$avatar_cleanup_retirement_attempt" || return 1
	avatar_cleanup_validate_retirement_inventory || return 1
	avatar_cleanup_require_retirement_policy_evidence archived || return 1
	JOURNAL_SCOPE_ACCESS_SHA="$avatar_cleanup_retirement_access_key_sha" \
		JOURNAL_SCOPE_ATTEMPT_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_attempt")" \
		JOURNAL_SCOPE_POLICY_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_policy_evidence")" \
		JOURNAL_SCOPE_POLICY_SIGNATURE_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_policy_signature")" \
		JOURNAL_SCOPE_INVENTORY_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_inventory_manifest")" \
		JOURNAL_SCOPE_SEALED_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_inventory")" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" node <<'NODE'
const value = { version: 1, action: 'avatar-retirement-journal-key-scope',
  ownershipRevision: process.env.OWNERSHIP_REVISION, cleanupRevision: process.env.CLEANUP_REVISION,
  retirementAccessKeyIdSha256: process.env.JOURNAL_SCOPE_ACCESS_SHA,
  retirementAttemptEvidenceSha256: process.env.JOURNAL_SCOPE_ATTEMPT_SHA,
  retirementPolicyEvidenceSha256: process.env.JOURNAL_SCOPE_POLICY_SHA,
  retirementPolicySignatureSha256: process.env.JOURNAL_SCOPE_POLICY_SIGNATURE_SHA,
  inventoryManifestSha256: process.env.JOURNAL_SCOPE_INVENTORY_SHA,
  sealedInventorySha256: process.env.JOURNAL_SCOPE_SEALED_SHA };
process.stdout.write(JSON.stringify(value));
NODE
}

avatar_cleanup_prepare_retirement_journal_key() {
	[[ "$avatar_cleanup_retirement_access_key_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	local scope temporary_key temporary_context
	scope="$(avatar_cleanup_retirement_journal_scope_json)" || return 1
	temporary_key="${avatar_cleanup_retirement_journal_key}.tmp.$$"
	temporary_context="${avatar_cleanup_retirement_journal_key_context}.source.$$"
	trap 'rm -f -- "$temporary_key" "$temporary_context"' RETURN
	if [[ ! -e "$avatar_cleanup_retirement_journal_key" && ! -L "$avatar_cleanup_retirement_journal_key" ]]; then
		JOURNAL_SCOPE_JSON="$scope" SIGNING_KEY_FILE="$avatar_cleanup_signing_key" \
			JOURNAL_KEY_FILE="$temporary_key" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const master = Buffer.from(fs.readFileSync(process.env.SIGNING_KEY_FILE, 'utf8').trim(), 'hex');
if (master.length !== 32) process.exit(1);
const key = crypto.createHmac('sha256', master).update('winwidget-avatar-retirement-journal-key-v1\0')
  .update(process.env.JOURNAL_SCOPE_JSON).digest('hex');
fs.writeFileSync(process.env.JOURNAL_KEY_FILE, `${key}\n`, { mode: 0o600, flag: 'wx' });
NODE
		chmod 600 "$temporary_key" || return 1
		chown 0:0 "$temporary_key" || return 1
		avatar_cleanup_fsync_file_and_parent "$temporary_key" || return 1
		mv -- "$temporary_key" "$avatar_cleanup_retirement_journal_key" || return 1
		avatar_cleanup_fsync_file_and_parent "$avatar_cleanup_retirement_journal_key" || return 1
	fi
	if [[ ! -e "$avatar_cleanup_retirement_journal_key_context" &&
		! -L "$avatar_cleanup_retirement_journal_key_context" ]]; then
		JOURNAL_SCOPE_JSON="$scope" JOURNAL_KEY_FILE="$avatar_cleanup_retirement_journal_key" \
			JOURNAL_CONTEXT_FILE="$temporary_context" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const scope = JSON.parse(process.env.JOURNAL_SCOPE_JSON);
const key = fs.readFileSync(process.env.JOURNAL_KEY_FILE);
if (key.length !== 65 || !/^[0-9a-f]{64}\n$/.test(key.toString('utf8'))) process.exit(1);
const value = { ...scope, derivation: 'hmac-sha256-v1',
  journalKeySha256: crypto.createHash('sha256').update(Buffer.from(key.toString('utf8').trim(), 'hex')).digest('hex'),
  createdAt: new Date().toISOString() };
fs.writeFileSync(process.env.JOURNAL_CONTEXT_FILE, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
		chmod 600 "$temporary_context" || return 1
		chown 0:0 "$temporary_context" || return 1
		avatar_cleanup_write_json_artifact "$avatar_cleanup_retirement_journal_key_context" "$temporary_context" || return 1
		rm -f -- "$temporary_context" || return 1
	fi
	trap - RETURN
	avatar_cleanup_validate_retirement_journal_key
}

avatar_cleanup_validate_retirement_journal_key() {
	local scope
	scope="$(avatar_cleanup_retirement_journal_scope_json)" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_retirement_journal_key" || return 1
	avatar_cleanup_verify_artifact "$avatar_cleanup_retirement_journal_key_context" || return 1
	JOURNAL_SCOPE_JSON="$scope" JOURNAL_KEY_FILE="$avatar_cleanup_retirement_journal_key" \
		JOURNAL_CONTEXT_FILE="$avatar_cleanup_retirement_journal_key_context" \
		SIGNING_KEY_FILE="$avatar_cleanup_signing_key" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const scope = JSON.parse(process.env.JOURNAL_SCOPE_JSON);
const context = JSON.parse(fs.readFileSync(process.env.JOURNAL_CONTEXT_FILE, 'utf8'));
const keyBytes = fs.readFileSync(process.env.JOURNAL_KEY_FILE);
const exactKeys = [...Object.keys(scope),'derivation','journalKeySha256','createdAt'];
if (JSON.stringify(Object.keys(context)) !== JSON.stringify(exactKeys) ||
    Object.keys(scope).some(name => context[name] !== scope[name]) || context.derivation !== 'hmac-sha256-v1' ||
    keyBytes.length !== 65 || !/^[0-9a-f]{64}\n$/.test(keyBytes.toString('utf8')) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(context.createdAt) ||
    !Number.isFinite(Date.parse(context.createdAt)) || Date.parse(context.createdAt) > Date.now() + 300000) process.exit(1);
const master = Buffer.from(fs.readFileSync(process.env.SIGNING_KEY_FILE, 'utf8').trim(), 'hex');
const expected = crypto.createHmac('sha256', master).update('winwidget-avatar-retirement-journal-key-v1\0')
  .update(process.env.JOURNAL_SCOPE_JSON).digest();
const actual = Buffer.from(keyBytes.toString('utf8').trim(), 'hex');
if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual) ||
    context.journalKeySha256 !== crypto.createHash('sha256').update(actual).digest('hex')) process.exit(1);
NODE
}

avatar_cleanup_retirement_key_sha256() {
	avatar_cleanup_validate_retirement_journal_key || return 1
	JOURNAL_KEY_FILE="$avatar_cleanup_retirement_journal_key" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const text = fs.readFileSync(process.env.JOURNAL_KEY_FILE, 'utf8');
if (!/^[0-9a-f]{64}\n$/.test(text)) process.exit(1);
process.stdout.write(crypto.createHash('sha256').update(Buffer.from(text.trim(), 'hex')).digest('hex'));
NODE
}

avatar_cleanup_retirement_consumer_ids() {
	local operation name
	docker ps -a --no-trunc --filter "label=$avatar_cleanup_retirement_consumer_label" \
		--format '{{.ID}}' || return 1
	for operation in inventory delete; do
		name="$(avatar_cleanup_retirement_consumer_name "$operation")" || return 1
		docker inspect --format '{{.Id}}' "$name" 2>/dev/null || true
	done
}

avatar_cleanup_validate_retirement_consumer_identity() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{64}$ ]] || return 1
	local container="$1" record expected_name attempt expected_input expected_key_sha
	record="$(docker inspect --format '{{.Id}}|{{.Name}}|{{.Image}}|{{.State.Status}}|{{index .Config.Labels "com.winwidget.lifecycle"}}|{{index .Config.Labels "com.winwidget.cleanup-revision"}}|{{index .Config.Labels "com.winwidget.retirement-operation"}}|{{index .Config.Labels "com.winwidget.retirement-access-key-sha256"}}|{{index .Config.Labels "com.winwidget.retirement-attempt-sha256"}}|{{index .Config.Labels "com.winwidget.retirement-input-sha256"}}|{{index .Config.Labels "com.winwidget.retirement-journal-key-sha256"}}|{{index .Config.Labels "com.winwidget.retirement-image-id"}}' "$container")" || return 1
	IFS='|' read -r avatar_cleanup_retirement_orphan_id avatar_cleanup_retirement_orphan_name \
		avatar_cleanup_retirement_orphan_image avatar_cleanup_retirement_orphan_state \
		avatar_cleanup_retirement_orphan_lifecycle avatar_cleanup_retirement_orphan_cleanup_revision \
		avatar_cleanup_retirement_orphan_operation avatar_cleanup_retirement_orphan_access_sha \
		avatar_cleanup_retirement_orphan_attempt_sha avatar_cleanup_retirement_orphan_input_sha \
		avatar_cleanup_retirement_orphan_journal_key_sha avatar_cleanup_retirement_orphan_image_label <<<"$record"
	[[ "$avatar_cleanup_retirement_orphan_id" == "$container" &&
		"$avatar_cleanup_retirement_orphan_lifecycle" == "$avatar_cleanup_retirement_consumer_lifecycle" &&
		"$avatar_cleanup_retirement_orphan_cleanup_revision" == "$EXPECTED_REVISION" &&
		"$avatar_cleanup_retirement_orphan_operation" =~ ^(inventory|delete)$ &&
		"$avatar_cleanup_retirement_orphan_access_sha" =~ ^[0-9a-f]{64}$ &&
		"$avatar_cleanup_retirement_orphan_attempt_sha" =~ ^[0-9a-f]{64}$ &&
		"$avatar_cleanup_retirement_orphan_input_sha" =~ ^[0-9a-f]{64}$ &&
		"$avatar_cleanup_retirement_orphan_journal_key_sha" =~ ^(pending|[0-9a-f]{64})$ &&
		"$avatar_cleanup_retirement_orphan_image_label" == "$avatar_cleanup_retirement_orphan_image" &&
		"$avatar_cleanup_retirement_orphan_state" =~ ^(created|running|paused|restarting|removing|exited|dead)$ ]] || return 1
	expected_name="/$(avatar_cleanup_retirement_consumer_name "$avatar_cleanup_retirement_orphan_operation")" || return 1
	[[ "$avatar_cleanup_retirement_orphan_name" == "$expected_name" ]] || return 1
	avatar_cleanup_validate_retirement_image "$avatar_cleanup_retirement_orphan_image" || return 1
	attempt="$avatar_cleanup_root/retirement-credential-attempt-$avatar_cleanup_retirement_orphan_access_sha.json"
	avatar_cleanup_recover_retirement_attempt_signature "$attempt" \
		"$avatar_cleanup_retirement_orphan_access_sha" || return 1
	[[ "$(avatar_cleanup_sha256 "$attempt")" == "$avatar_cleanup_retirement_orphan_attempt_sha" ]] || return 1
	case "$avatar_cleanup_retirement_orphan_operation" in
	inventory)
		expected_input="$(avatar_cleanup_sha256 "$avatar_cleanup_inventory_manifest")" || return 1
		[[ "$avatar_cleanup_retirement_orphan_journal_key_sha" == 'pending' ]] || return 1
		;;
	delete)
		avatar_cleanup_validate_retirement_inventory || return 1
		expected_input="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_inventory")" || return 1
		avatar_cleanup_set_retirement_journal_scope "$avatar_cleanup_retirement_orphan_access_sha" || return 1
		avatar_cleanup_prepare_retirement_journal_key || return 1
		expected_key_sha="$(avatar_cleanup_retirement_key_sha256)" || return 1
		[[ "$avatar_cleanup_retirement_orphan_journal_key_sha" == "$expected_key_sha" ]] || return 1
		;;
	esac
	[[ "$avatar_cleanup_retirement_orphan_input_sha" == "$expected_input" ]]
}

avatar_cleanup_validate_retirement_consumer_recovery() {
	[[ $# -eq 1 ]] || return 1
	local evidence="$1" name recovery_id evidence_root recovery_root
	evidence_root="$(cd -- "$(dirname -- "$evidence")" 2>/dev/null && pwd -P)" || return 1
	recovery_root="$(cd -- "$avatar_cleanup_retirement_consumer_recovery_root" 2>/dev/null && pwd -P)" || return 1
	[[ "$evidence_root" == "$recovery_root" ]] || return 1
	name="$(basename -- "$evidence")" || return 1
	[[ "$name" =~ ^([0-9a-f]{64})\.json$ ]] || return 1
	recovery_id="${BASH_REMATCH[1]}"
	avatar_cleanup_verify_artifact "$evidence" || return 1
	RECOVERY_FILE="$evidence" EXPECTED_RECOVERY_ID="$recovery_id" CLEANUP_REVISION="$EXPECTED_REVISION" node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
let bytes;
let text;
let value;
try {
  bytes = fs.readFileSync(process.env.RECOVERY_FILE);
  text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  value = JSON.parse(text);
} catch { process.exit(1); }
const exact = ['version','action','cleanupRevision','recoveryIdSha256','operation','reason','containerObserved',
  'containerId','cidfileResidueIdSha256','identityValidated','containerRemoved','expectedContainerName',
  'expectedImageId','observedImageId','observedState','retirementAccessKeyIdSha256',
  'retirementAttemptEvidenceSha256','inputEvidenceSha256','journalKeySha256',
  'credentialFileDurablyRemoved','recoveredAt'];
const sha = item => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item);
const nullableSha = item => item === null || sha(item);
const context = value && typeof value === 'object' && !Array.isArray(value) ? {
  version: value.version, action: value.action, cleanupRevision: value.cleanupRevision, operation: value.operation,
  reason: value.reason, containerObserved: value.containerObserved, containerId: value.containerId,
  cidfileResidueIdSha256: value.cidfileResidueIdSha256, identityValidated: value.identityValidated,
  containerRemoved: value.containerRemoved, expectedContainerName: value.expectedContainerName,
  expectedImageId: value.expectedImageId, observedImageId: value.observedImageId,
  observedState: value.observedState, retirementAccessKeyIdSha256: value.retirementAccessKeyIdSha256,
  retirementAttemptEvidenceSha256: value.retirementAttemptEvidenceSha256,
  inputEvidenceSha256: value.inputEvidenceSha256, journalKeySha256: value.journalKeySha256,
  credentialFileDurablyRemoved: value.credentialFileDurablyRemoved,
} : null;
const expectedRecoveryId = context ? crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex') : '';
if (bytes.length < 2 || bytes.length > 8192 || text !== `${JSON.stringify(value, null, 2)}\n` ||
    !value || typeof value !== 'object' || Array.isArray(value) ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(exact) || value.version !== 1 ||
    value.action !== 'avatar-retirement-consumer-recovery' || value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    value.recoveryIdSha256 !== process.env.EXPECTED_RECOVERY_ID || value.recoveryIdSha256 !== expectedRecoveryId ||
    !/^(inventory|delete)$/.test(value.operation || '') ||
    !/^(startup-orphan|active-command-failed|signal-or-exit|cidfile-residue)$/.test(value.reason || '') ||
    typeof value.containerObserved !== 'boolean' ||
    (value.containerObserved ? !sha(value.containerId) : value.containerId !== null) ||
    !nullableSha(value.cidfileResidueIdSha256) ||
    value.identityValidated !== value.containerObserved || value.containerRemoved !== value.containerObserved ||
    (value.reason === 'startup-orphan' && !value.containerObserved) ||
    (value.reason === 'cidfile-residue' && (value.containerObserved || !sha(value.cidfileResidueIdSha256))) ||
    value.expectedContainerName !== `winwidget-avatar-retirement-${value.operation}-${value.cleanupRevision.slice(0, 12)}` ||
    !(value.expectedImageId === null || /^sha256:[0-9a-f]{64}$/.test(value.expectedImageId || '')) ||
    (value.containerObserved && !/^sha256:[0-9a-f]{64}$/.test(value.expectedImageId || '')) ||
    value.observedImageId !== (value.containerObserved ? value.expectedImageId : null) ||
    (value.containerObserved ? !/^(created|running|paused|restarting|removing|exited|dead)$/.test(value.observedState || '') :
      value.observedState !== 'absent') ||
    ![value.retirementAccessKeyIdSha256,value.retirementAttemptEvidenceSha256,value.inputEvidenceSha256]
      .every(nullableSha) || !(value.journalKeySha256 === null || value.journalKeySha256 === 'pending' ||
      sha(value.journalKeySha256)) ||
    (value.containerObserved && (!sha(value.retirementAccessKeyIdSha256) ||
      !sha(value.retirementAttemptEvidenceSha256) || !sha(value.inputEvidenceSha256) ||
      (value.operation === 'inventory' ? value.journalKeySha256 !== 'pending' : !sha(value.journalKeySha256)))) ||
    value.credentialFileDurablyRemoved !== true ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.recoveredAt || '') ||
    !Number.isFinite(Date.parse(value.recoveredAt)) || new Date(Date.parse(value.recoveredAt)).toISOString() !== value.recoveredAt ||
    Date.parse(value.recoveredAt) > Date.now() + 300000) process.exit(1);
NODE
}

avatar_cleanup_record_retirement_consumer_recovery() {
	[[ $# -eq 4 && "$1" =~ ^(inventory|delete)$ &&
		"$2" =~ ^(startup-orphan|active-command-failed|signal-or-exit|cidfile-residue)$ &&
		( "$3" == 'absent' || "$3" =~ ^[0-9a-f]{64}$ ) &&
		( "$4" == 'none' || "$4" =~ ^[0-9a-f]{64}$ ) ]] || return 1
	local operation="$1" reason="$2" observed_container="$3" cidfile_residue="$4"
	local observed=false identity_validated=false container_removed=false container_id='' residue_sha=''
	local expected_name expected_image='' observed_image='' observed_state='absent'
	local access_sha='' attempt_sha='' input_sha='' journal_key_sha='' recovery_id evidence source context
	expected_name="$(avatar_cleanup_retirement_consumer_name "$operation")" || return 1
	if [[ "$cidfile_residue" != 'none' ]]; then
		residue_sha="$(printf '%s' "$cidfile_residue" | identity_cutover_text_sha256)" || return 1
	fi
	if [[ "$observed_container" != 'absent' ]]; then
		[[ "${avatar_cleanup_retirement_orphan_identity_validated:-false}" == true &&
			"${avatar_cleanup_retirement_orphan_id:-}" == "$observed_container" &&
			"${avatar_cleanup_retirement_orphan_operation:-}" == "$operation" ]] || return 1
		observed=true
		identity_validated=true
		container_removed=true
		container_id="$observed_container"
		expected_image="${avatar_cleanup_retirement_orphan_image:-}"
		observed_image="$expected_image"
		observed_state="${avatar_cleanup_retirement_orphan_state:-}"
		access_sha="${avatar_cleanup_retirement_orphan_access_sha:-}"
		attempt_sha="${avatar_cleanup_retirement_orphan_attempt_sha:-}"
		input_sha="${avatar_cleanup_retirement_orphan_input_sha:-}"
		journal_key_sha="${avatar_cleanup_retirement_orphan_journal_key_sha:-}"
	else
		expected_image="${avatar_cleanup_active_retirement_image:-}"
		access_sha="${avatar_cleanup_retirement_access_key_sha:-}"
		attempt_sha="${avatar_cleanup_active_retirement_attempt_sha:-}"
		input_sha="${avatar_cleanup_active_retirement_input_sha:-}"
		journal_key_sha="${avatar_cleanup_active_retirement_journal_key_sha:-}"
	fi
	[[ ! -e "$AVATAR_RETIREMENT_CREDENTIAL_FILE" && ! -L "$AVATAR_RETIREMENT_CREDENTIAL_FILE" ]] || return 1
	context="$(RECOVERY_OPERATION="$operation" RECOVERY_REASON="$reason" CONTAINER_OBSERVED="$observed" \
		CONTAINER_ID="$container_id" CIDFILE_RESIDUE_SHA="$residue_sha" IDENTITY_VALIDATED="$identity_validated" \
		CONTAINER_REMOVED="$container_removed" EXPECTED_NAME="$expected_name" EXPECTED_IMAGE="$expected_image" \
		OBSERVED_IMAGE="$observed_image" OBSERVED_STATE="$observed_state" ACCESS_SHA="$access_sha" \
		ATTEMPT_SHA="$attempt_sha" INPUT_SHA="$input_sha" JOURNAL_KEY_SHA="$journal_key_sha" \
		CLEANUP_REVISION="$EXPECTED_REVISION" node <<'NODE'
const optional=value=>value||null;
const value={version:1,action:'avatar-retirement-consumer-recovery',cleanupRevision:process.env.CLEANUP_REVISION,
 operation:process.env.RECOVERY_OPERATION,reason:process.env.RECOVERY_REASON,
 containerObserved:process.env.CONTAINER_OBSERVED==='true',containerId:optional(process.env.CONTAINER_ID),
 cidfileResidueIdSha256:optional(process.env.CIDFILE_RESIDUE_SHA),
 identityValidated:process.env.IDENTITY_VALIDATED==='true',containerRemoved:process.env.CONTAINER_REMOVED==='true',
 expectedContainerName:process.env.EXPECTED_NAME,expectedImageId:optional(process.env.EXPECTED_IMAGE),
 observedImageId:optional(process.env.OBSERVED_IMAGE),observedState:process.env.OBSERVED_STATE,
 retirementAccessKeyIdSha256:optional(process.env.ACCESS_SHA),retirementAttemptEvidenceSha256:optional(process.env.ATTEMPT_SHA),
 inputEvidenceSha256:optional(process.env.INPUT_SHA),journalKeySha256:optional(process.env.JOURNAL_KEY_SHA),
 credentialFileDurablyRemoved:true};process.stdout.write(JSON.stringify(value));
NODE
)" || return 1
	recovery_id="$(printf '%s' "$context" | identity_cutover_text_sha256)" || return 1
	[[ "$recovery_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	if [[ ! -e "$avatar_cleanup_retirement_consumer_recovery_root" &&
		! -L "$avatar_cleanup_retirement_consumer_recovery_root" ]]; then
		install -d -o 0 -g 0 -m 700 "$avatar_cleanup_retirement_consumer_recovery_root" || return 1
	fi
	[[ -d "$avatar_cleanup_retirement_consumer_recovery_root" &&
		! -L "$avatar_cleanup_retirement_consumer_recovery_root" &&
		"$(avatar_cleanup_stat_identity "$avatar_cleanup_retirement_consumer_recovery_root")" == '0:0:700' ]] || return 1
	evidence="$avatar_cleanup_retirement_consumer_recovery_root/$recovery_id.json"
	if [[ -e "$evidence" || -L "$evidence" ]]; then
		avatar_cleanup_validate_retirement_consumer_recovery "$evidence"
		return
	fi
	source="$avatar_cleanup_retirement_consumer_recovery_root/.recovery-$recovery_id.$$"
	RECOVERY_OUTPUT="$source" RECOVERY_ID="$recovery_id" RECOVERY_CONTEXT="$context" node <<'NODE' || return 1
const fs = require('node:fs');
const context=JSON.parse(process.env.RECOVERY_CONTEXT);
const value={version:context.version,action:context.action,cleanupRevision:context.cleanupRevision,
  recoveryIdSha256:process.env.RECOVERY_ID,operation:context.operation,reason:context.reason,
  containerObserved:context.containerObserved,containerId:context.containerId,
  cidfileResidueIdSha256:context.cidfileResidueIdSha256,identityValidated:context.identityValidated,
  containerRemoved:context.containerRemoved,expectedContainerName:context.expectedContainerName,
  expectedImageId:context.expectedImageId,observedImageId:context.observedImageId,observedState:context.observedState,
  retirementAccessKeyIdSha256:context.retirementAccessKeyIdSha256,
  retirementAttemptEvidenceSha256:context.retirementAttemptEvidenceSha256,
  inputEvidenceSha256:context.inputEvidenceSha256,journalKeySha256:context.journalKeySha256,
  credentialFileDurablyRemoved:context.credentialFileDurablyRemoved,recoveredAt:new Date().toISOString()};
fs.writeFileSync(process.env.RECOVERY_OUTPUT, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$source" || return 1
	chown 0:0 "$source" || return 1
	avatar_cleanup_write_json_artifact "$evidence" "$source" || return 1
	rm -f -- "$source" || return 1
	avatar_cleanup_validate_retirement_consumer_recovery "$evidence"
}

avatar_cleanup_retirement_consumer_recovery_binding() {
	local expected="${1:-}" temporary files count total file name recovery_id
	local empty='[]'
	if [[ ! -e "$avatar_cleanup_retirement_consumer_recovery_root" &&
		! -L "$avatar_cleanup_retirement_consumer_recovery_root" ]]; then
		RECOVERY_ROWS="$empty" EXPECTED_BINDING="$expected" node <<'NODE'
const crypto=require('node:crypto');const value={count:0,
 aggregateSha256:crypto.createHash('sha256').update('[]').digest('hex'),artifacts:[]};
if(process.env.EXPECTED_BINDING&&JSON.stringify(value)!==process.env.EXPECTED_BINDING)process.exit(1);
process.stdout.write(JSON.stringify(value));
NODE
		return
	fi
	[[ -d "$avatar_cleanup_retirement_consumer_recovery_root" &&
		! -L "$avatar_cleanup_retirement_consumer_recovery_root" &&
		"$(avatar_cleanup_stat_identity "$avatar_cleanup_retirement_consumer_recovery_root")" == '0:0:700' ]] || return 1
	temporary="$(mktemp "$avatar_cleanup_root/.recovery-binding.XXXXXX")" || return 1
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	trap 'rm -f -- "$temporary"' RETURN
	files="$(find "$avatar_cleanup_retirement_consumer_recovery_root" -mindepth 1 -maxdepth 1 -type f \
		-name '????????????????????????????????????????????????????????????????.json' -print | LC_ALL=C sort)" || return 1
	count="$(printf '%s\n' "$files" | awk 'NF { count += 1 } END { print count + 0 }')" || return 1
	total="$(find "$avatar_cleanup_retirement_consumer_recovery_root" -mindepth 1 -maxdepth 1 -print |
		awk 'NF { count += 1 } END { print count + 0 }')" || return 1
	[[ "$count" -le 64 && "$total" -eq $((count * 2)) ]] || return 1
	while IFS= read -r file; do
		[[ -n "$file" ]] || continue
		avatar_cleanup_validate_retirement_consumer_recovery "$file" || return 1
		name="$(basename -- "$file")" || return 1
		recovery_id="${name%.json}"
		printf '%s\t%s\t%s\n' "$recovery_id" "$(avatar_cleanup_sha256 "$file")" \
			"$(avatar_cleanup_sha256 "${file}.hmac-sha256")" >>"$temporary" || return 1
	done <<<"$files"
	RECOVERY_ROWS_FILE="$temporary" EXPECTED_BINDING="$expected" node <<'NODE' || return 1
const fs=require('node:fs');const crypto=require('node:crypto');const rows=fs.readFileSync(process.env.RECOVERY_ROWS_FILE,'utf8')
 .trim().split('\n').filter(Boolean).map(line=>line.split('\t'));
if(rows.some((row,index)=>row.length!==3||!row.every(item=>/^[0-9a-f]{64}$/.test(item))||
 (index>0&&row[0]<=rows[index-1][0])))process.exit(1);
const artifacts=rows.map(([recoveryIdSha256,evidenceSha256,evidenceHmacSha256])=>
 ({recoveryIdSha256,evidenceSha256,evidenceHmacSha256}));
const value={count:artifacts.length,aggregateSha256:crypto.createHash('sha256').update(JSON.stringify(artifacts)).digest('hex'),artifacts};
if(process.env.EXPECTED_BINDING&&JSON.stringify(value)!==process.env.EXPECTED_BINDING)process.exit(1);
process.stdout.write(JSON.stringify(value));
NODE
	rm -f -- "$temporary" || return 1
	trap - RETURN
}

avatar_cleanup_load_retirement_consumer_recovery_binding() {
	[[ $# -le 1 && ( -z "${1:-}" || "$1" =~ ^[0-9a-f]{64}$ ) ]] || return 1
	local expected_retirement_sha="${1:-}" binding result
	avatar_cleanup_verify_artifact "$avatar_cleanup_retirement" || return 1
	if [[ -n "$expected_retirement_sha" ]]; then
		[[ "$(avatar_cleanup_sha256 "$avatar_cleanup_retirement")" == "$expected_retirement_sha" ]] || return 1
	fi
	binding="$(avatar_cleanup_retirement_consumer_recovery_binding)" || return 1
	result="$(RETIREMENT_FILE="$avatar_cleanup_retirement" RECOVERY_BINDING="$binding" node <<'NODE'
const fs = require('node:fs');
let value;
let binding;
try {
  value = JSON.parse(fs.readFileSync(process.env.RETIREMENT_FILE, 'utf8'));
  binding = JSON.parse(process.env.RECOVERY_BINDING);
} catch { process.exit(1); }
const hash = item => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item);
const artifact = item => item && typeof item === 'object' && !Array.isArray(item) &&
  JSON.stringify(Object.keys(item)) === JSON.stringify(['recoveryIdSha256','evidenceSha256','evidenceHmacSha256']) &&
  hash(item.recoveryIdSha256) && hash(item.evidenceSha256) && hash(item.evidenceHmacSha256);
if (!Number.isSafeInteger(binding.count) || binding.count < 0 || binding.count > 64 ||
    !hash(binding.aggregateSha256) || !Array.isArray(binding.artifacts) ||
    binding.artifacts.length !== binding.count || binding.artifacts.some((item, index) =>
      !artifact(item) || (index > 0 && item.recoveryIdSha256 <= binding.artifacts[index - 1].recoveryIdSha256)) ||
    value.retirementConsumerRecoveryEvidenceCount !== binding.count ||
    value.retirementConsumerRecoveryEvidenceAggregateSha256 !== binding.aggregateSha256 ||
    JSON.stringify(value.retirementConsumerRecoveryEvidenceArtifacts) !== JSON.stringify(binding.artifacts)) process.exit(1);
process.stdout.write(`${binding.count}\t${binding.aggregateSha256}`);
NODE
)" || return 1
	IFS=$'\t' read -r avatar_cleanup_retirement_recovery_count \
		avatar_cleanup_retirement_recovery_aggregate_sha <<<"$result"
	[[ "$avatar_cleanup_retirement_recovery_count" =~ ^([0-9]|[1-5][0-9]|6[0-4])$ &&
		"$avatar_cleanup_retirement_recovery_aggregate_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
}

avatar_cleanup_remove_retirement_consumer() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{64}$ ]] || return 1
	local container="$1" state
	state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
	if [[ "$state" =~ ^(running|paused|restarting)$ ]]; then
		docker stop --time 15 "$container" >/dev/null 2>&1 || return 1
		if ! docker wait "$container" >/dev/null 2>&1; then
			! docker inspect "$container" >/dev/null 2>&1 || return 1
		fi
	fi
	if ! docker rm -f "$container" >/dev/null 2>&1; then
		! docker inspect "$container" >/dev/null 2>&1 || return 1
	fi
	! docker inspect "$container" >/dev/null 2>&1
}

avatar_cleanup_reconcile_retirement_consumers() {
	avatar_cleanup_require_retirement_deploy_lock || return 1
	local ids count container operation cidfile cid cidfile_residue='none' residue=false
	ids="$(avatar_cleanup_retirement_consumer_ids | awk 'NF { if ($0 !~ /^[0-9a-f]{64}$/) exit 1; print }' | LC_ALL=C sort -u)" || return 1
	count="$(printf '%s\n' "$ids" | awk 'NF { count += 1 } END { print count + 0 }')" || return 1
	[[ "$count" -le 1 ]] ||
		avatar_cleanup_fail 'multiple avatar retirement consumers exist; refusing ambiguous reconciliation' || return 1
	if [[ "$count" == '1' ]]; then
		container="$ids"
		avatar_cleanup_validate_retirement_consumer_identity "$container" ||
			avatar_cleanup_fail 'avatar retirement orphan identity is invalid' || return 1
		avatar_cleanup_retirement_orphan_identity_validated=true
		operation="$avatar_cleanup_retirement_orphan_operation"
		cidfile="$(avatar_cleanup_retirement_consumer_cidfile "$operation")" || return 1
		avatar_cleanup_persist_retirement_consumer_cidfile "$operation" "$container" || return 1
		cidfile_residue="$container"
		avatar_cleanup_remove_retirement_consumer "$container" || return 1
		avatar_cleanup_durable_unlink_private_file "$AVATAR_RETIREMENT_CREDENTIAL_FILE" || return 1
		avatar_cleanup_record_retirement_consumer_recovery "$operation" startup-orphan \
			"$container" "$cidfile_residue" || return 1
		avatar_cleanup_durable_unlink_private_file "$cidfile" || return 1
		return 75
	fi
	for operation in inventory delete; do
		cidfile="$(avatar_cleanup_retirement_consumer_cidfile "$operation")" || return 1
		if [[ -e "$cidfile" || -L "$cidfile" ]]; then
			residue=true
			cid="$(avatar_cleanup_read_retirement_consumer_cidfile "$operation")" || return 1
			if docker inspect "$cid" >/dev/null 2>&1; then
				avatar_cleanup_validate_retirement_consumer_identity "$cid" ||
					avatar_cleanup_fail 'cidfile points at a live foreign retirement container' || return 1
				[[ "$avatar_cleanup_retirement_orphan_operation" == "$operation" ]] || return 1
				avatar_cleanup_retirement_orphan_identity_validated=true
				avatar_cleanup_persist_retirement_consumer_cidfile "$operation" "$cid" || return 1
				avatar_cleanup_remove_retirement_consumer "$cid" || return 1
				avatar_cleanup_durable_unlink_private_file "$AVATAR_RETIREMENT_CREDENTIAL_FILE" || return 1
				avatar_cleanup_record_retirement_consumer_recovery "$operation" startup-orphan "$cid" "$cid" || return 1
				avatar_cleanup_durable_unlink_private_file "$cidfile" || return 1
				return 75
			fi
			avatar_cleanup_retirement_orphan_identity_validated=false
			avatar_cleanup_active_retirement_image=''
			avatar_cleanup_active_retirement_attempt_sha=''
			avatar_cleanup_active_retirement_input_sha=''
			avatar_cleanup_active_retirement_journal_key_sha=''
			avatar_cleanup_retirement_access_key_sha=''
			avatar_cleanup_durable_unlink_private_file "$AVATAR_RETIREMENT_CREDENTIAL_FILE" || return 1
			avatar_cleanup_record_retirement_consumer_recovery "$operation" cidfile-residue absent "$cid" || return 1
			avatar_cleanup_durable_unlink_private_file "$cidfile" || return 1
		fi
	done
	[[ "$residue" == false ]] || return 75
}

avatar_cleanup_assert_no_retirement_consumer() {
	local ids operation cidfile name
	ids="$(avatar_cleanup_retirement_consumer_ids | awk 'NF { if ($0 !~ /^[0-9a-f]{64}$/) exit 1; print }' | LC_ALL=C sort -u)" || return 1
	[[ -z "$ids" ]] || return 1
	for operation in inventory delete; do
		cidfile="$(avatar_cleanup_retirement_consumer_cidfile "$operation")" || return 1
		name="$(avatar_cleanup_retirement_consumer_name "$operation")" || return 1
		[[ ! -e "$cidfile" && ! -L "$cidfile" ]] || return 1
		! docker inspect "$name" >/dev/null 2>&1 || return 1
	done
}

avatar_cleanup_run_retirement_node() {
	[[ $# -ge 5 && "$1" =~ ^(inventory|delete)$ && "$2" =~ ^sha256:[0-9a-f]{64}$ &&
		"$3" =~ ^[0-9a-f]{64}$ && "$4" =~ ^[0-9a-f]{64}$ &&
		"$5" =~ ^(pending|[0-9a-f]{64})$ ]] || return 1
	local operation="$1" image="$2" input_sha="$3" attempt_sha="$4" journal_key_sha="$5"
	shift 5
	local argument name cidfile status cid
	local -a docker_arguments
	for argument in "$@"; do
		[[ "$argument" != '--pull' && "$argument" != '--name' && "$argument" != '--cidfile' &&
			"$argument" != '--label' && "$argument" != '--user' && "$argument" != '--entrypoint' &&
			"$argument" != *"$avatar_cleanup_retirement_credential_container_path"* &&
			"$argument" != *"$avatar_cleanup_retirement_journal_key_container_path"* ]] || return 1
	done
	avatar_cleanup_require_retirement_deploy_lock || return 1
	avatar_cleanup_validate_retirement_image "$image" || return 1
	avatar_cleanup_assert_no_retirement_consumer || return 1
	avatar_cleanup_require_retirement_tmpfs || return 1
	avatar_cleanup_validate_private_file "$AVATAR_RETIREMENT_CREDENTIAL_FILE" || return 1
	if [[ "$operation" == 'delete' ]]; then
		[[ "$journal_key_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
		avatar_cleanup_validate_retirement_journal_key || return 1
		[[ "$(avatar_cleanup_retirement_key_sha256)" == "$journal_key_sha" ]] || return 1
	else
		[[ "$journal_key_sha" == 'pending' ]] || return 1
	fi
	name="$(avatar_cleanup_retirement_consumer_name "$operation")" || return 1
	cidfile="$(avatar_cleanup_retirement_consumer_cidfile "$operation")" || return 1
	[[ ! -e "$cidfile" && ! -L "$cidfile" ]] || return 1
	avatar_cleanup_active_retirement_container_name="$name"
	avatar_cleanup_active_retirement_cidfile="$cidfile"
	avatar_cleanup_active_retirement_operation="$operation"
	avatar_cleanup_active_retirement_image="$image"
	avatar_cleanup_active_retirement_input_sha="$input_sha"
	avatar_cleanup_active_retirement_attempt_sha="$attempt_sha"
	avatar_cleanup_active_retirement_journal_key_sha="$journal_key_sha"
	set +e
	docker_arguments=(run --pull never --rm -i --name "$name" --cidfile "$cidfile" \
		--label "$avatar_cleanup_retirement_consumer_label" \
		--label "com.winwidget.cleanup-revision=$EXPECTED_REVISION" \
		--label "com.winwidget.retirement-operation=$operation" \
		--label "com.winwidget.retirement-access-key-sha256=$avatar_cleanup_retirement_access_key_sha" \
		--label "com.winwidget.retirement-attempt-sha256=$attempt_sha" \
		--label "com.winwidget.retirement-input-sha256=$input_sha" \
		--label "com.winwidget.retirement-journal-key-sha256=$journal_key_sha" \
		--label "com.winwidget.retirement-image-id=$image" \
		--network host --read-only --user 0:0 --cap-drop ALL \
		--security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=8m \
		--mount "type=bind,source=$AVATAR_RETIREMENT_CREDENTIAL_FILE,target=$avatar_cleanup_retirement_credential_container_path,readonly")
	if [[ "$operation" == 'delete' ]]; then
		docker_arguments+=(--mount \
			"type=bind,source=$avatar_cleanup_retirement_journal_key,target=$avatar_cleanup_retirement_journal_key_container_path,readonly")
	fi
	docker "${docker_arguments[@]}" "$@" --entrypoint node "$image" -
	status=$?
	set -e
	[[ "$status" -eq 0 ]] || return "$status"
	cid="$(avatar_cleanup_read_retirement_consumer_cidfile "$operation")" || return 1
	! docker inspect "$name" >/dev/null 2>&1 || return 1
	avatar_cleanup_durable_unlink_private_file "$cidfile" || return 1
	avatar_cleanup_active_retirement_container_name=''
	avatar_cleanup_active_retirement_cidfile=''
	avatar_cleanup_active_retirement_operation=''
	avatar_cleanup_active_retirement_image=''
	avatar_cleanup_active_retirement_input_sha=''
	avatar_cleanup_active_retirement_attempt_sha=''
	avatar_cleanup_active_retirement_journal_key_sha=''
}

avatar_cleanup_reconcile_active_retirement_consumer() {
	[[ -n "${avatar_cleanup_active_retirement_container_name:-}" &&
		"${avatar_cleanup_active_retirement_operation:-}" =~ ^(inventory|delete)$ ]] || return 0
	local container='' observed_container='absent' cidfile_residue='none'
	if [[ -n "${avatar_cleanup_active_retirement_cidfile:-}" &&
		( -e "$avatar_cleanup_active_retirement_cidfile" || -L "$avatar_cleanup_active_retirement_cidfile" ) ]]; then
		container="$(avatar_cleanup_read_retirement_consumer_cidfile \
			"$avatar_cleanup_active_retirement_operation")" || return 1
		cidfile_residue="$container"
	else
		container="$(docker inspect --format '{{.Id}}' "$avatar_cleanup_active_retirement_container_name" 2>/dev/null || true)"
		[[ -z "$container" || "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
	fi
	if [[ -n "$container" ]] && docker inspect "$container" >/dev/null 2>&1; then
		avatar_cleanup_validate_retirement_consumer_identity "$container" || return 1
		avatar_cleanup_retirement_orphan_identity_validated=true
		avatar_cleanup_persist_retirement_consumer_cidfile \
			"$avatar_cleanup_active_retirement_operation" "$container" || return 1
		cidfile_residue="$container"
		avatar_cleanup_remove_retirement_consumer "$container" || return 1
		observed_container="$container"
	else
		avatar_cleanup_retirement_orphan_identity_validated=false
	fi
	avatar_cleanup_durable_unlink_private_file "$AVATAR_RETIREMENT_CREDENTIAL_FILE" || return 1
	avatar_cleanup_record_retirement_consumer_recovery "$avatar_cleanup_active_retirement_operation" \
		"${avatar_cleanup_retirement_exit_reason:-active-command-failed}" \
		"$observed_container" "$cidfile_residue" || return 1
	avatar_cleanup_durable_unlink_private_file "$avatar_cleanup_active_retirement_cidfile" || return 1
	avatar_cleanup_active_retirement_container_name=''
	avatar_cleanup_active_retirement_cidfile=''
	avatar_cleanup_active_retirement_operation=''
	avatar_cleanup_active_retirement_image=''
	avatar_cleanup_active_retirement_input_sha=''
	avatar_cleanup_active_retirement_attempt_sha=''
	avatar_cleanup_active_retirement_journal_key_sha=''
}

avatar_cleanup_retirement_exit_cleanup() {
	local status=$? cleanup_status=0
	trap - EXIT HUP INT TERM
	set +e
	avatar_cleanup_reconcile_active_retirement_consumer || cleanup_status=1
	avatar_cleanup_durable_unlink_private_file "$AVATAR_RETIREMENT_CREDENTIAL_FILE" || cleanup_status=1
	if [[ -n "${avatar_cleanup_retirement_temporary_root:-}" &&
		-d "$avatar_cleanup_retirement_temporary_root" && ! -L "$avatar_cleanup_retirement_temporary_root" ]]; then
		rm -rf -- "$avatar_cleanup_retirement_temporary_root" || cleanup_status=1
	fi
	avatar_cleanup_unset_audit_environment
	if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
		return 1
	fi
	return "$status"
}

avatar_cleanup_install_retirement_exit_traps() {
	trap avatar_cleanup_retirement_exit_cleanup EXIT
	trap 'avatar_cleanup_retirement_exit_reason=signal-or-exit; exit 129' HUP
	trap 'avatar_cleanup_retirement_exit_reason=signal-or-exit; exit 130' INT
	trap 'avatar_cleanup_retirement_exit_reason=signal-or-exit; exit 143' TERM
}

avatar_cleanup_seal_json_artifact() {
	[[ $# -eq 2 && -f "$1" && ! -L "$1" && ! -e "$2" && ! -L "$2" ]] || return 1
	avatar_cleanup_create_signing_key || return 1
	local source="$1" destination="$2" temporary="${2}.tmp.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	SOURCE_JSON="$source" DESTINATION_JSON="$temporary" SIGNING_KEY_FILE="$avatar_cleanup_signing_key" \
		node <<'NODE' || { rm -f -- "$temporary"; return 1; }
const fs = require('node:fs');
const crypto = require('node:crypto');
const value = JSON.parse(fs.readFileSync(process.env.SOURCE_JSON, 'utf8'));
if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.prototype.hasOwnProperty.call(value, 'signatureHmacSha256')) process.exit(1);
const key = Buffer.from(fs.readFileSync(process.env.SIGNING_KEY_FILE, 'utf8').trim(), 'hex');
const signatureHmacSha256 = crypto.createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
fs.writeFileSync(process.env.DESTINATION_JSON,
  `${JSON.stringify({ ...value, signatureHmacSha256 }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -- "$temporary" "$destination" || return 1
	avatar_cleanup_fsync_file_and_parent "$destination" || return 1
	avatar_cleanup_verify_embedded_hmac_json "$destination"
}

avatar_cleanup_verify_embedded_hmac_json() {
	[[ $# -eq 1 ]] || return 1
	avatar_cleanup_validate_private_file "$1" || return 1
	avatar_cleanup_validate_private_file "$avatar_cleanup_signing_key" || return 1
	SIGNED_FILE="$1" SIGNING_KEY_FILE="$avatar_cleanup_signing_key" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const value = JSON.parse(fs.readFileSync(process.env.SIGNED_FILE, 'utf8'));
if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !/^[0-9a-f]{64}$/.test(value.signatureHmacSha256 || '')) process.exit(1);
const signature = Buffer.from(value.signatureHmacSha256, 'hex');
delete value.signatureHmacSha256;
const key = Buffer.from(fs.readFileSync(process.env.SIGNING_KEY_FILE, 'utf8').trim(), 'hex');
const actual = crypto.createHmac('sha256', key).update(JSON.stringify(value)).digest();
if (signature.length !== actual.length || !crypto.timingSafeEqual(signature, actual)) process.exit(1);
NODE
}

avatar_cleanup_prepare_uploads_retirement_inventory() {
	if [[ -e "$avatar_cleanup_uploads_retirement_inventory" ||
		-L "$avatar_cleanup_uploads_retirement_inventory" ]]; then
		avatar_cleanup_validate_uploads_retirement_inventory
		return
	fi
	local temporary="$avatar_cleanup_root/.uploads-retirement-inventory.$$"
	COPY_ROOT="$avatar_cleanup_uploads_snapshot" INVENTORY_FILE="$avatar_cleanup_inventory_manifest" \
		SNAPSHOT_FILE="$avatar_cleanup_uploads_snapshot_evidence" OUTPUT_FILE="$temporary" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
		OWNERSHIP_BUNDLE_SHA="$avatar_cleanup_ownership_bundle_sha" node <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.env.COPY_ROOT;
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
const inventory = JSON.parse(fs.readFileSync(process.env.INVENTORY_FILE, 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(process.env.SNAPSHOT_FILE, 'utf8'));
if (!fs.existsSync(root)) {
  if (snapshot.entries !== 0 || snapshot.files !== 0 || snapshot.bytes !== 0 ||
      snapshot.treeSha256 !== crypto.createHash('sha256').update('[]').digest('hex')) process.exit(1);
}
const directories = [];
const objects = [];
let entries = 0;
let totalBytes = 0;
if (fs.existsSync(root)) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0 || (rootStat.mode & 0o077) !== 0) process.exit(1);
  const walk = directory => {
    for (const name of fs.readdirSync(directory).sort(compareUtf8)) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) process.exit(1);
      const entry = path.join(directory, name);
      const stat = fs.lstatSync(entry);
      const key = path.relative(root, entry).split(path.sep).join('/');
      entries += 1;
      if (entries > 10000 || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 ||
          key.split('/').length > 32) process.exit(1);
      if (stat.isDirectory()) {
        directories.push(key);
        walk(entry);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) process.exit(1);
        const body = fs.readFileSync(entry);
        totalBytes += body.length;
        if (totalBytes > 512 * 1024 * 1024) process.exit(1);
        objects.push({ key, size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') });
      } else process.exit(1);
    }
  };
  walk(root);
}
directories.sort(compareUtf8);
objects.sort((left, right) => compareUtf8(left.key, right.key));
const rows = objects.map(item => [item.key, item.size, item.sha256]);
const treeSha256 = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
if (entries !== snapshot.entries || objects.length !== snapshot.files || totalBytes !== snapshot.bytes ||
    treeSha256 !== snapshot.treeSha256 || entries !== directories.length + objects.length) process.exit(1);
const references = inventory.rows.filter(row => row.classification === 'LEGACY_UPLOAD').map(row => row.source);
const byKey = new Map(objects.map(item => [item.key, item]));
for (const source of references) {
  const object = byKey.get(source?.key);
  if (source?.kind !== 'UPLOAD' || !object || object.sha256 !== source.sourceSha256) process.exit(1);
}
const value = {
  version: 1, action: 'avatar-legacy-uploads-sealed-inventory',
  ownershipRevision: process.env.OWNERSHIP_REVISION, cleanupRevision: process.env.CLEANUP_REVISION,
  ownershipEvidenceBundleSha256: process.env.OWNERSHIP_BUNDLE_SHA,
  inventoryManifestSha256: crypto.createHash('sha256').update(fs.readFileSync(process.env.INVENTORY_FILE)).digest('hex'),
  snapshotEvidenceSha256: crypto.createHash('sha256').update(fs.readFileSync(process.env.SNAPSHOT_FILE)).digest('hex'),
  rootBasename: path.basename(root), entries, directoryCount: directories.length, objectCount: objects.length,
  totalBytes, treeSha256, expectedLegacyReferences: references.length, directories, objects,
  capturedAt: new Date().toISOString(),
};
fs.writeFileSync(process.env.OUTPUT_FILE, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	avatar_cleanup_seal_json_artifact "$temporary" "$avatar_cleanup_uploads_retirement_inventory" || return 1
	rm -f -- "$temporary" || return 1
	avatar_cleanup_validate_uploads_retirement_inventory
}

avatar_cleanup_validate_uploads_retirement_inventory() {
	avatar_cleanup_verify_embedded_hmac_json "$avatar_cleanup_uploads_retirement_inventory" || return 1
	UPLOADS_SEALED="$avatar_cleanup_uploads_retirement_inventory" \
		INVENTORY_FILE="$avatar_cleanup_inventory_manifest" SNAPSHOT_FILE="$avatar_cleanup_uploads_snapshot_evidence" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
		OWNERSHIP_BUNDLE_SHA="$avatar_cleanup_ownership_bundle_sha" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const value = JSON.parse(fs.readFileSync(process.env.UPLOADS_SEALED, 'utf8'));
const inventory = JSON.parse(fs.readFileSync(process.env.INVENTORY_FILE, 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(process.env.SNAPSHOT_FILE, 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exact = (item, keys) => item && typeof item === 'object' && !Array.isArray(item) &&
  JSON.stringify(Object.keys(item).sort()) === JSON.stringify([...keys].sort());
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
if (!exact(value, ['version','action','ownershipRevision','cleanupRevision','ownershipEvidenceBundleSha256',
    'inventoryManifestSha256','snapshotEvidenceSha256','rootBasename','entries','directoryCount','objectCount',
    'totalBytes','treeSha256','expectedLegacyReferences','directories','objects','capturedAt','signatureHmacSha256']) ||
    value.version !== 1 || value.action !== 'avatar-legacy-uploads-sealed-inventory' ||
    value.ownershipRevision !== process.env.OWNERSHIP_REVISION || value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    value.ownershipEvidenceBundleSha256 !== process.env.OWNERSHIP_BUNDLE_SHA ||
    value.inventoryManifestSha256 !== sha(process.env.INVENTORY_FILE) || value.snapshotEvidenceSha256 !== sha(process.env.SNAPSHOT_FILE) ||
    value.rootBasename !== `legacy-uploads-${process.env.OWNERSHIP_REVISION}` || !Number.isFinite(Date.parse(value.capturedAt)) ||
    ![value.entries,value.directoryCount,value.objectCount,value.totalBytes,value.expectedLegacyReferences]
      .every(item => Number.isSafeInteger(item) && item >= 0) || value.entries > 10000 || value.totalBytes > 512 * 1024 * 1024 ||
    !/^[0-9a-f]{64}$/.test(value.treeSha256 || '') || !Array.isArray(value.directories) || !Array.isArray(value.objects) ||
    value.entries !== value.directoryCount + value.objectCount || value.directoryCount !== value.directories.length ||
    value.objectCount !== value.objects.length || value.entries !== snapshot.entries || value.objectCount !== snapshot.files ||
    value.totalBytes !== snapshot.bytes || value.treeSha256 !== snapshot.treeSha256) process.exit(1);
const safe = key => typeof key === 'string' && key.length > 0 && key.length <= 1024 && !key.startsWith('/') &&
  key.split('/').length <= 32 && key.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'));
if (value.directories.some((key, index) => !safe(key) ||
    (index > 0 && compareUtf8(key, value.directories[index - 1]) <= 0))) process.exit(1);
let total = 0;
for (let index = 0; index < value.objects.length; index += 1) {
  const object = value.objects[index];
  if (!exact(object, ['key','size','sha256']) || !safe(object.key) || !Number.isSafeInteger(object.size) || object.size < 0 ||
      !/^[0-9a-f]{64}$/.test(object.sha256 || '') ||
      (index > 0 && compareUtf8(object.key, value.objects[index - 1].key) <= 0)) process.exit(1);
  total += object.size;
}
const rows = value.objects.map(item => [item.key,item.size,item.sha256]);
if (total !== value.totalBytes || crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') !== value.treeSha256) process.exit(1);
const references = inventory.rows.filter(row => row.classification === 'LEGACY_UPLOAD').map(row => row.source);
const byKey = new Map(value.objects.map(item => [item.key,item]));
if (references.length !== value.expectedLegacyReferences || references.some(source => {
  const object = byKey.get(source?.key);
  return source?.kind !== 'UPLOAD' || !object || object.sha256 !== source.sourceSha256;
})) process.exit(1);
NODE
}

avatar_cleanup_remove_uploads_copy() {
	[[ $# -eq 1 ]] || return 1
	avatar_cleanup_prepare_uploads_retirement_inventory || return 1
	local copy_root="$avatar_cleanup_uploads_snapshot" result="$1"
	[[ "$copy_root" == "$APP_ROOT/deploy/backend/identity-avatar-media-artifacts/legacy-uploads-$AVATAR_OWNERSHIP_REVISION" ]] ||
		avatar_cleanup_fail 'legacy uploads snapshot root is outside the exact guarded target' || return 1
	COPY_ROOT="$copy_root" SEALED_FILE="$avatar_cleanup_uploads_retirement_inventory" RESULT_FILE="$result" node <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sealed = JSON.parse(fs.readFileSync(process.env.SEALED_FILE, 'utf8'));
const root = process.env.COPY_ROOT;
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
const expected = new Map(sealed.objects.map(item => [item.key, item]));
const expectedDirectories = new Set(sealed.directories);
const result = {
  sealedInventorySha256: crypto.createHash('sha256').update(fs.readFileSync(process.env.SEALED_FILE)).digest('hex'),
  sealedEntries: sealed.entries, sealedDirectories: sealed.directoryCount, sealedObjects: sealed.objectCount,
  sealedBytes: sealed.totalBytes, sealedTreeSha256: sealed.treeSha256,
  expectedLegacyReferences: sealed.expectedLegacyReferences, verifiedAndDeleted: 0,
  alreadyAbsent: 0, treeAbsent: false,
};
if (fs.existsSync(root)) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0 || (rootStat.mode & 0o077) !== 0) process.exit(1);
  const files = [];
  const directories = [];
  const walk = directory => {
    for (const name of fs.readdirSync(directory).sort(compareUtf8)) {
      const entry = path.join(directory, name);
      const stat = fs.lstatSync(entry);
      const key = path.relative(root, entry).split(path.sep).join('/');
      if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || key.split('/').length > 32) process.exit(1);
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(key)) process.exit(1);
        directories.push({ key, entry });
        walk(entry);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) process.exit(1);
        const sealedObject = expected.get(key);
        if (!sealedObject || stat.size !== sealedObject.size) process.exit(1);
        const body = fs.readFileSync(entry);
        if (crypto.createHash('sha256').update(body).digest('hex') !== sealedObject.sha256) process.exit(1);
        files.push({ key, entry });
      } else process.exit(1);
    }
  };
  walk(root);
  for (const file of files) {
    fs.unlinkSync(file.entry);
    result.verifiedAndDeleted += 1;
  }
  directories.sort((left, right) => right.key.split('/').length - left.key.split('/').length ||
    compareUtf8(right.key, left.key));
  for (const directory of directories) fs.rmdirSync(directory.entry);
  fs.rmdirSync(root);
  result.alreadyAbsent = sealed.objectCount - files.length;
} else {
  result.alreadyAbsent = sealed.objectCount;
}
if (fs.existsSync(root)) process.exit(1);
const parentFd = fs.openSync(path.dirname(root), 'r');
try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
result.treeAbsent = true;
fs.writeFileSync(process.env.RESULT_FILE, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	[[ ! -e "$copy_root" && ! -L "$copy_root" ]] ||
		avatar_cleanup_fail 'legacy uploads snapshot tree was not fully removed'
	avatar_cleanup_fsync_directory "$(dirname -- "$copy_root")" || return 1
}

avatar_cleanup_capture_widgets_storage_denial() {
	[[ $# -eq 2 && "$2" =~ ^(before-retirement|after-retirement)$ ]] || return 1
	local output="$1" phase="$2" container image_id revision health restarts started_at legacy_probe new_probe
	container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q widgets-service)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
	image_id="$(docker inspect --format '{{.Image}}' "$container")" || return 1
	revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" || return 1
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" || return 1
	restarts="$(docker inspect --format '{{.RestartCount}}' "$container")" || return 1
	started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container")" || return 1
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ && "$revision" == "$avatar_cleanup_runtime_revision" &&
		"$health" == 'healthy' && "$restarts" =~ ^(0|[1-9][0-9]*)$ ]] ||
		avatar_cleanup_fail 'live Widgets runtime is not an exact healthy immutable image' || return 1
	legacy_probe="$(SEALED_FILE="$avatar_cleanup_retirement_inventory" node -e '
const value=JSON.parse(require("node:fs").readFileSync(process.env.SEALED_FILE,"utf8"));
const entry=value.versions?.[0];process.stdout.write(entry?.key||`${value.legacyPrefix}/_widgets-real-key-absence-probe`);')" || return 1
	new_probe="$(MANAGED_FILE="$avatar_cleanup_manifest" NEW_PREFIX="$AVATAR_AUDIT_KEY_PREFIX" node -e '
const value=JSON.parse(require("node:fs").readFileSync(process.env.MANAGED_FILE,"utf8"));
process.stdout.write(value.objects?.[0]?.key||`${process.env.NEW_PREFIX}/_widgets-real-key-absence-probe`);')" || return 1
	docker exec -i \
		--env "AVATAR_EXPECTED_ENDPOINT_SHA=$avatar_cleanup_storage_endpoint_sha" \
		--env "AVATAR_EXPECTED_REGION=$AVATAR_AUDIT_REGION" \
		--env "AVATAR_EXPECTED_BUCKET=$AVATAR_AUDIT_BUCKET" \
		--env "AVATAR_EXPECTED_FORCE_PATH_STYLE=$AVATAR_AUDIT_FORCE_PATH_STYLE" \
		--env "AVATAR_EXPECTED_LEGACY_PREFIX=$AVATAR_AUDIT_LEGACY_KEY_PREFIX" \
		--env "AVATAR_EXPECTED_NEW_PREFIX=$AVATAR_AUDIT_KEY_PREFIX" \
		--env "AVATAR_REAL_LEGACY_PROBE_KEY=$legacy_probe" --env "AVATAR_REAL_NEW_PROBE_KEY=$new_probe" \
		--env "AVATAR_SHA_A_POLICY_EVIDENCE_SHA=$(avatar_cleanup_sha256 "$avatar_cleanup_policy_evidence")" \
		--env "AVATAR_POLICY_PHASE=$phase" --env "AVATAR_WIDGETS_CONTAINER=$container" \
		--env "AVATAR_WIDGETS_IMAGE=$image_id" --env "AVATAR_WIDGETS_REVISION=$revision" \
		--env "AVATAR_WIDGETS_STARTED_AT=$started_at" --env "AVATAR_WIDGETS_RESTARTS=$restarts" \
		"$container" node - >"$output" 2>/dev/null <<'NODE' || return 1
const crypto = require('node:crypto');
const {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand,
  PutObjectCommand, S3Client,
} = require('@aws-sdk/client-s3');
const fail = () => process.exit(1);
const required = name => { const value = process.env[name]; if (!value) fail(); return value; };
if (Object.keys(process.env).some(key => key.startsWith('IDENTITY_AVATAR_S3_') ||
    key.startsWith('IDENTITY_AVATAR_MIGRATION_'))) fail();
const endpoint = new URL(required('S3_ENDPOINT'));
const endpointValue = endpoint.toString().replace(/\/$/, '');
if (endpoint.protocol !== 'https:' || required('S3_BUCKET') !== required('AVATAR_EXPECTED_BUCKET') ||
    crypto.createHash('sha256').update(endpointValue).digest('hex') !== required('AVATAR_EXPECTED_ENDPOINT_SHA') ||
    required('S3_REGION') !== required('AVATAR_EXPECTED_REGION') ||
    (required('S3_FORCE_PATH_STYLE') === 'true') !== (required('AVATAR_EXPECTED_FORCE_PATH_STYLE') === 'true')) fail();
const genericPrefix = (process.env.S3_KEY_PREFIX || '').replace(/^\/+|\/+$/g, '');
const legacyPrefix = genericPrefix ? `${genericPrefix}/user-avatar` : 'user-avatar';
const expectedLegacy = required('AVATAR_EXPECTED_LEGACY_PREFIX');
const newPrefix = required('AVATAR_EXPECTED_NEW_PREFIX');
if (legacyPrefix !== expectedLegacy || !newPrefix || legacyPrefix === newPrefix) fail();
const accessKeyId = required('S3_ACCESS_KEY_ID');
const client = new S3Client({
  endpoint: endpoint.toString().replace(/\/$/, ''), region: required('S3_REGION'),
  forcePathStyle: required('S3_FORCE_PATH_STYLE') === 'true', maxAttempts: 3,
  credentials: { accessKeyId, secretAccessKey: required('S3_SECRET_ACCESS_KEY') },
});
const denied = async (operation, cleanup) => {
  try {
    await operation();
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 403 || ['AccessDenied','Forbidden'].includes(error?.name) ||
        ['AccessDenied','Forbidden'].includes(error?.Code)) return;
    fail();
  }
  if (cleanup) { try { await cleanup(); } catch {} }
  fail();
};
const nonce = crypto.randomUUID();
const body = Buffer.from([0]);
const legacyKey = required('AVATAR_REAL_LEGACY_PROBE_KEY');
const newKey = required('AVATAR_REAL_NEW_PROBE_KEY');
const legacyMutationKey = `${legacyPrefix}/_widgets-retirement-deny-canary/${nonce}.bin`;
const newMutationKey = `${newPrefix}/_widgets-retirement-deny-canary/${nonce}.bin`;
const checks = [];
const verifyPrefix = async (label, prefix, probeKey, mutationKey) => {
  if (!probeKey.startsWith(`${prefix}/`)) fail();
  await denied(() => client.send(new HeadObjectCommand({ Bucket: required('S3_BUCKET'), Key: probeKey }))); checks.push(`${label}-head-denied`);
  await denied(() => client.send(new GetObjectCommand({ Bucket: required('S3_BUCKET'), Key: probeKey }))); checks.push(`${label}-get-denied`);
  await denied(() => client.send(new PutObjectCommand({ Bucket: required('S3_BUCKET'), Key: mutationKey, Body: body })),
    () => client.send(new DeleteObjectCommand({ Bucket: required('S3_BUCKET'), Key: mutationKey }))); checks.push(`${label}-put-denied`);
  await denied(() => client.send(new DeleteObjectCommand({ Bucket: required('S3_BUCKET'), Key: mutationKey }))); checks.push(`${label}-delete-denied`);
  await denied(() => client.send(new ListObjectsV2Command({ Bucket: required('S3_BUCKET'), Prefix: `${prefix}/`, MaxKeys: 1 })));
  checks.push(`${label}-list-denied`);
  await denied(() => client.send(new ListObjectVersionsCommand({ Bucket: required('S3_BUCKET'), Prefix: `${prefix}/`, MaxKeys: 1 })));
  checks.push(`${label}-version-list-denied`);
};
(async () => {
  await verifyPrefix('legacy', legacyPrefix, legacyKey, legacyMutationKey);
  await verifyPrefix('new', newPrefix, newKey, newMutationKey);
  process.stdout.write(`${JSON.stringify({
    version: 1, action: 'avatar-live-widgets-storage-denial', phase: required('AVATAR_POLICY_PHASE'),
		containerId: required('AVATAR_WIDGETS_CONTAINER'), imageId: required('AVATAR_WIDGETS_IMAGE'),
		revision: required('AVATAR_WIDGETS_REVISION'),
		startedAt: required('AVATAR_WIDGETS_STARTED_AT'), restartCount: Number(required('AVATAR_WIDGETS_RESTARTS')), healthy: true,
    accessKeyIdSha256: crypto.createHash('sha256').update(accessKeyId).digest('hex'),
    storageEndpointSha256: crypto.createHash('sha256').update(endpointValue).digest('hex'),
    storageRegion: required('S3_REGION'), storageBucket: required('S3_BUCKET'),
    storageForcePathStyle: required('S3_FORCE_PATH_STYLE') === 'true',
    legacyPrefixSha256: crypto.createHash('sha256').update(legacyPrefix).digest('hex'),
    newPrefixSha256: crypto.createHash('sha256').update(newPrefix).digest('hex'),
    legacyProbeKeySha256: crypto.createHash('sha256').update(legacyKey).digest('hex'),
    newProbeKeySha256: crypto.createHash('sha256').update(newKey).digest('hex'),
    shaAStoragePolicyEvidenceSha256: required('AVATAR_SHA_A_POLICY_EVIDENCE_SHA'), checks,
    verifiedAt: new Date().toISOString(),
  })}\n`);
})().catch(fail);
NODE
	chmod 600 "$output" || return 1
	chown 0:0 "$output" || return 1
}

avatar_cleanup_validate_retirement_inventory() {
	avatar_cleanup_verify_embedded_hmac_json "$avatar_cleanup_retirement_inventory" || return 1
	local capture_key_sha capture_attempt
	capture_key_sha="$(SEALED_FILE="$avatar_cleanup_retirement_inventory" node -e '
const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.env.SEALED_FILE,"utf8"));
	if(!/^[0-9a-f]{64}$/.test(value.capturedByRetirementAccessKeyIdSha256||""))process.exit(1);
process.stdout.write(value.capturedByRetirementAccessKeyIdSha256);')" || return 1
	local avatar_cleanup_retirement_access_key_sha="$capture_key_sha"
	local avatar_cleanup_retirement_policy_evidence avatar_cleanup_retirement_policy_signature
	local avatar_cleanup_retirement_policy_sha avatar_cleanup_retirement_policy_signature_sha
	local avatar_cleanup_storage_endpoint_sha avatar_cleanup_storage_public_base_sha
	avatar_cleanup_require_retirement_policy_evidence || return 1
	capture_attempt="$avatar_cleanup_root/retirement-credential-attempt-$capture_key_sha.json"
	avatar_cleanup_verify_artifact "$capture_attempt" || return 1
	SEALED_FILE="$avatar_cleanup_retirement_inventory" INVENTORY_FILE="$avatar_cleanup_inventory_manifest" \
		CAPTURE_ATTEMPT_FILE="$capture_attempt" OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" \
		CLEANUP_REVISION="$EXPECTED_REVISION" OWNERSHIP_BUNDLE_SHA="$avatar_cleanup_ownership_bundle_sha" \
		ENDPOINT_SHA="$avatar_cleanup_storage_endpoint_sha" PUBLIC_BASE_SHA="$avatar_cleanup_storage_public_base_sha" \
		REGION="$AVATAR_AUDIT_REGION" BUCKET="$AVATAR_AUDIT_BUCKET" FORCE_PATH_STYLE="$AVATAR_AUDIT_FORCE_PATH_STYLE" \
		NEW_PREFIX="$AVATAR_AUDIT_KEY_PREFIX" LEGACY_PREFIX="$AVATAR_AUDIT_LEGACY_KEY_PREFIX" \
		POLICY_SHA="$avatar_cleanup_retirement_policy_sha" \
		POLICY_SIGNATURE_SHA="$avatar_cleanup_retirement_policy_signature_sha" \
		POLICY_FILE="$avatar_cleanup_retirement_policy_evidence" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const value = JSON.parse(fs.readFileSync(process.env.SEALED_FILE, 'utf8'));
const inventory = JSON.parse(fs.readFileSync(process.env.INVENTORY_FILE, 'utf8'));
const attempt = JSON.parse(fs.readFileSync(process.env.CAPTURE_ATTEMPT_FILE, 'utf8'));
const policy = JSON.parse(fs.readFileSync(process.env.POLICY_FILE, 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exact = (item, keys) => item && typeof item === 'object' && !Array.isArray(item) &&
  JSON.stringify(Object.keys(item).sort()) === JSON.stringify([...keys].sort());
const checks = ['missing-legacy-head-allowed','missing-legacy-get-allowed','missing-legacy-delete-allowed','legacy-put-denied',
  'legacy-exact-prefix-list-allowed','legacy-exact-prefix-version-list-allowed',
  'outside-prefix-list-denied','outside-prefix-version-list-denied','new-head-denied','new-get-denied',
  'new-put-denied','new-list-denied','new-version-list-denied',
  'bucket-versioning-state-captured'];
if (!exact(value, ['version','action','ownershipRevision','cleanupRevision','ownershipEvidenceBundleSha256',
    'inventoryManifestSha256','storageEndpointSha256','storagePublicBaseUrlSha256','storageRegion','storageBucket',
    'storageForcePathStyle','newPrefix','legacyPrefix','bucketVersioningStatus','retirementPolicyEvidenceSha256',
    'retirementPolicySignatureSha256','capturedByRetirementAccessKeyIdSha256','captureAttemptEvidenceSha256',
    'expectedLegacyReferences','referencedObjectCount','orphanObjectCount','objectCount','totalBytes',
    'legacyKeysSha256','objectsSha256','versionEntryCount','objectVersionCount','deleteMarkerCount',
    'versionTotalBytes','versionsSha256','policyChecks','objects','versions','capturedAt','signatureHmacSha256']) ||
    value.version !== 1 || value.action !== 'avatar-legacy-s3-sealed-inventory' ||
    value.ownershipRevision !== process.env.OWNERSHIP_REVISION || value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    value.ownershipEvidenceBundleSha256 !== process.env.OWNERSHIP_BUNDLE_SHA ||
    value.inventoryManifestSha256 !== sha(process.env.INVENTORY_FILE) ||
    value.storageEndpointSha256 !== process.env.ENDPOINT_SHA ||
    value.storagePublicBaseUrlSha256 !== process.env.PUBLIC_BASE_SHA || value.storageRegion !== process.env.REGION ||
    value.storageBucket !== process.env.BUCKET || value.storageForcePathStyle !== (process.env.FORCE_PATH_STYLE === 'true') ||
    value.newPrefix !== process.env.NEW_PREFIX || value.legacyPrefix !== process.env.LEGACY_PREFIX ||
    !['NEVER_ENABLED','Enabled','Suspended'].includes(value.bucketVersioningStatus) ||
    value.retirementPolicyEvidenceSha256 !== process.env.POLICY_SHA ||
    value.retirementPolicySignatureSha256 !== process.env.POLICY_SIGNATURE_SHA ||
    !/^[0-9a-f]{64}$/.test(value.capturedByRetirementAccessKeyIdSha256 || '') ||
    value.captureAttemptEvidenceSha256 !== sha(process.env.CAPTURE_ATTEMPT_FILE) ||
    ![value.expectedLegacyReferences,value.referencedObjectCount,value.orphanObjectCount,value.objectCount,value.totalBytes]
      .every(item => Number.isSafeInteger(item) && item >= 0) || value.objectCount > 100000 || value.totalBytes > 5 * 1024 * 1024 * 1024 ||
    value.referencedObjectCount + value.orphanObjectCount !== value.objectCount ||
    !/^[0-9a-f]{64}$/.test(value.legacyKeysSha256 || '') || !/^[0-9a-f]{64}$/.test(value.objectsSha256 || '') ||
    JSON.stringify(value.policyChecks) !== JSON.stringify(checks) || !Array.isArray(value.objects) ||
    value.objects.length !== value.objectCount || !Array.isArray(value.versions) ||
    ![value.versionEntryCount,value.objectVersionCount,value.deleteMarkerCount,value.versionTotalBytes]
      .every(item => Number.isSafeInteger(item) && item >= 0) || value.versionEntryCount > 100000 ||
    value.versionTotalBytes > 5 * 1024 * 1024 * 1024 || value.versions.length !== value.versionEntryCount ||
    value.objectVersionCount + value.deleteMarkerCount !== value.versionEntryCount ||
    !/^[0-9a-f]{64}$/.test(value.versionsSha256 || '') || !Number.isFinite(Date.parse(value.capturedAt))) process.exit(1);
if (!exact(attempt, ['version','action','ownershipRevision','cleanupRevision','inventoryManifestSha256',
    'sealedInventorySha256','retirementPolicyEvidenceSha256','retirementPolicySignatureSha256',
    'storageEndpointSha256','storagePublicBaseUrlSha256','storageRegion','storageBucket','storageForcePathStyle',
    'newPrefix','legacyPrefix','retirementAccessKeyIdSha256','attemptedAt']) || attempt.version !== 1 ||
    attempt.action !== 'avatar-retirement-credential-attempt' || attempt.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
    attempt.cleanupRevision !== process.env.CLEANUP_REVISION || attempt.inventoryManifestSha256 !== value.inventoryManifestSha256 ||
    attempt.sealedInventorySha256 !== 'pending' || attempt.retirementPolicyEvidenceSha256 !== value.retirementPolicyEvidenceSha256 ||
    attempt.retirementPolicySignatureSha256 !== value.retirementPolicySignatureSha256 ||
    attempt.storageEndpointSha256 !== value.storageEndpointSha256 ||
    attempt.storagePublicBaseUrlSha256 !== value.storagePublicBaseUrlSha256 ||
    attempt.storageRegion !== value.storageRegion || attempt.storageBucket !== value.storageBucket ||
    attempt.storageForcePathStyle !== value.storageForcePathStyle || attempt.newPrefix !== value.newPrefix ||
    attempt.legacyPrefix !== value.legacyPrefix ||
    attempt.retirementAccessKeyIdSha256 !== value.capturedByRetirementAccessKeyIdSha256 ||
    !Number.isFinite(Date.parse(attempt.attemptedAt)) || Date.parse(attempt.attemptedAt) > Date.parse(value.capturedAt) ||
    Date.parse(attempt.attemptedAt) < Date.parse(policy.issuedAt) ||
    Date.parse(attempt.attemptedAt) > Date.parse(policy.expiresAt)) process.exit(1);
const safe = key => typeof key === 'string' && key.length > 0 && key.length <= 1024 &&
  key.startsWith(`${value.legacyPrefix}/`) && key.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'));
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
let total = 0;
for (let index = 0; index < value.objects.length; index += 1) {
  const object = value.objects[index];
  if (!exact(object, ['key','size','sha256']) || !safe(object.key) || !Number.isSafeInteger(object.size) ||
      object.size < 0 || object.size > 100 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(object.sha256 || '') ||
      (index > 0 && compareUtf8(object.key, value.objects[index - 1].key) <= 0)) process.exit(1);
  total += object.size;
}
if (total !== value.totalBytes ||
    crypto.createHash('sha256').update(`${value.objects.map(item => item.key).join('\n')}\n`).digest('hex') !== value.legacyKeysSha256 ||
    crypto.createHash('sha256').update(JSON.stringify(value.objects)).digest('hex') !== value.objectsSha256) process.exit(1);
let versionTotal = 0;
let objectVersions = 0;
let deleteMarkers = 0;
const currentVersions = new Map();
const versionIds = new Set();
for (let index = 0; index < value.versions.length; index += 1) {
  const entry = value.versions[index];
  if (!exact(entry, ['key','versionId','kind','isLatest','size','sha256','lastModified']) || !safe(entry.key) ||
      typeof entry.versionId !== 'string' || entry.versionId.length < 1 || entry.versionId.length > 1024 ||
      !/^(OBJECT|DELETE_MARKER)$/.test(entry.kind || '') || typeof entry.isLatest !== 'boolean' ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 100 * 1024 * 1024 ||
      !Number.isFinite(Date.parse(entry.lastModified))) process.exit(1);
  const entryId = JSON.stringify([entry.key,entry.versionId,entry.kind]);
  if (versionIds.has(entryId)) process.exit(1);
  versionIds.add(entryId);
  if (index > 0) {
    const previous = value.versions[index - 1];
    const order = compareUtf8(entry.key, previous.key) || compareUtf8(entry.versionId, previous.versionId) ||
      compareUtf8(entry.kind, previous.kind);
    if (order <= 0) process.exit(1);
  }
  if (entry.kind === 'OBJECT') {
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 || '')) process.exit(1);
    objectVersions += 1;
    versionTotal += entry.size;
    if (entry.isLatest) currentVersions.set(entry.key, entry);
  } else {
    if (entry.size !== 0 || entry.sha256 !== null) process.exit(1);
    deleteMarkers += 1;
  }
}
if (value.bucketVersioningStatus === 'NEVER_ENABLED' &&
    (value.versions.length !== value.objects.length || value.deleteMarkerCount !== 0 ||
      value.versions.some(entry => entry.kind !== 'OBJECT' || entry.versionId !== 'null' || entry.isLatest !== true) ||
      currentVersions.size !== value.objects.length)) process.exit(1);
if (versionTotal !== value.versionTotalBytes || objectVersions !== value.objectVersionCount ||
    deleteMarkers !== value.deleteMarkerCount ||
    crypto.createHash('sha256').update(JSON.stringify(value.versions)).digest('hex') !== value.versionsSha256 ||
    currentVersions.size !== value.objects.length ||
    value.objects.some(object => {
      const current = currentVersions.get(object.key);
      return !current || current.size !== object.size || current.sha256 !== object.sha256;
    })) process.exit(1);
const references = inventory.rows.filter(row => row.classification === 'LEGACY_S3').map(row => row.source);
const byKey = new Map(value.objects.map(item => [item.key,item]));
const referenced = new Set();
for (const source of references) {
  const object = byKey.get(source?.key);
  if (source?.kind !== 'S3' || !object || object.sha256 !== source.sourceSha256) process.exit(1);
  referenced.add(source.key);
}
if (references.length !== value.expectedLegacyReferences || referenced.size !== value.referencedObjectCount ||
    value.orphanObjectCount !== value.objectCount - referenced.size) process.exit(1);
NODE
}

avatar_cleanup_prepare_retirement_inventory() {
	[[ $# -eq 1 ]] || return 1
	if [[ -e "$avatar_cleanup_retirement_inventory" || -L "$avatar_cleanup_retirement_inventory" ]]; then
		avatar_cleanup_validate_retirement_inventory
		return
	fi
	local image="$1" raw="$avatar_cleanup_root/.legacy-s3-inventory.$$" attempt_sha input_sha
	attempt_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_attempt")" || return 1
	input_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_inventory_manifest")" || return 1
	avatar_cleanup_run_retirement_node inventory "$image" "$input_sha" "$attempt_sha" pending \
		--env AVATAR_AUDIT_ENDPOINT --env AVATAR_AUDIT_REGION --env AVATAR_AUDIT_BUCKET \
		--env AVATAR_AUDIT_FORCE_PATH_STYLE --env AVATAR_AUDIT_PUBLIC_BASE_URL --env AVATAR_AUDIT_KEY_PREFIX \
		--env AVATAR_AUDIT_LEGACY_KEY_PREFIX \
		--env "AVATAR_OWNERSHIP_REVISION=$AVATAR_OWNERSHIP_REVISION" \
		--env "AVATAR_CLEANUP_REVISION=$EXPECTED_REVISION" \
		--env "AVATAR_OWNERSHIP_BUNDLE_SHA=$avatar_cleanup_ownership_bundle_sha" \
		--env "AVATAR_CAPTURE_ACCESS_KEY_SHA=$avatar_cleanup_retirement_access_key_sha" \
		--env "AVATAR_CAPTURE_ATTEMPT_SHA=$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_attempt")" \
		--env "AVATAR_RETIREMENT_POLICY_SHA=$avatar_cleanup_retirement_policy_sha" \
		--env "AVATAR_RETIREMENT_POLICY_SIGNATURE_SHA=$avatar_cleanup_retirement_policy_signature_sha" \
		--mount "type=bind,source=$avatar_cleanup_inventory_manifest,target=/evidence/inventory.json,readonly" \
		>"$raw" <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  DeleteObjectCommand, GetBucketVersioningCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  ListObjectVersionsCommand, PutObjectCommand, S3Client,
} = require('@aws-sdk/client-s3');
const fail = () => process.exit(1);
const required = name => { const value = process.env[name]; if (!value) fail(); return value; };
const readRetirementCredentials = () => {
  const bytes = fs.readFileSync('/run/secrets/winwidget-avatar-retirement-v1');
  if (bytes.length < 74 || bytes.length > 1024) fail();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(); }
  const match = /^access_key_id=([A-Za-z0-9._-]{8,256})\nsecret_access_key=([A-Za-z0-9+\/_=-]{32,512})\n$/.exec(text);
  if (!match || Buffer.byteLength(text) !== bytes.length) fail();
  return Object.freeze({ accessKeyId: match[1], secretAccessKey: match[2] });
};
const client = new S3Client({
  endpoint: required('AVATAR_AUDIT_ENDPOINT'), region: required('AVATAR_AUDIT_REGION'),
  forcePathStyle: required('AVATAR_AUDIT_FORCE_PATH_STYLE') === 'true', maxAttempts: 3,
  credentials: readRetirementCredentials(),
});
const bucket = required('AVATAR_AUDIT_BUCKET');
const newPrefix = required('AVATAR_AUDIT_KEY_PREFIX').replace(/^\/+|\/+$/g, '');
const legacyPrefix = required('AVATAR_AUDIT_LEGACY_KEY_PREFIX').replace(/^\/+|\/+$/g, '');
if (!newPrefix || !legacyPrefix || newPrefix === legacyPrefix || newPrefix.startsWith(`${legacyPrefix}/`) || legacyPrefix.startsWith(`${newPrefix}/`)) fail();
const safeLegacyKey = key => typeof key === 'string' && key.length > legacyPrefix.length + 1 && key.length <= 1024 &&
  key.startsWith(`${legacyPrefix}/`) && key.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'));
const denied = async (operation, cleanup) => {
	try { await operation(); } catch (error) {
		if (error?.$metadata?.httpStatusCode !== 403 && !['AccessDenied','Forbidden'].includes(error?.name) &&
				!['AccessDenied','Forbidden'].includes(error?.Code)) fail();
		return;
	}
	if (cleanup) { try { await cleanup(); } catch {} }
	fail();
};
const missing = async operation => {
  try { await operation(); return false; } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || ['NotFound','NoSuchKey'].includes(error?.name)) return true;
    throw error;
  }
};
const hashBody = async body => {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of body) { const value = Buffer.from(chunk); size += value.length; if (size > 100 * 1024 * 1024) fail(); hash.update(value); }
  return { size, sha256: hash.digest('hex') };
};
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
const inventory = JSON.parse(fs.readFileSync('/evidence/inventory.json', 'utf8'));
const references = inventory.rows.filter(row => row.classification === 'LEGACY_S3').map(row => row.source);
(async () => {
  const nonce = crypto.randomUUID();
  const legacyCanary = `${legacyPrefix}/_retirement-canary/${nonce}.bin`;
  const newCanary = `${newPrefix}/_retirement-canary/${nonce}.bin`;
  if (!(await missing(() => client.send(new HeadObjectCommand({ Bucket: bucket, Key: legacyCanary }))))) fail();
  if (!(await missing(() => client.send(new GetObjectCommand({ Bucket: bucket, Key: legacyCanary }))))) fail();
	await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: legacyCanary }));
  if (!(await missing(() => client.send(new HeadObjectCommand({ Bucket: bucket, Key: legacyCanary }))))) fail();
  if (!(await missing(() => client.send(new GetObjectCommand({ Bucket: bucket, Key: legacyCanary }))))) fail();
	await denied(() => client.send(new PutObjectCommand({ Bucket: bucket, Key: legacyCanary, Body: Buffer.from([0]) })),
		undefined);
  await denied(() => client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${legacyPrefix}-outside/`, MaxKeys: 1 })));
  await denied(() => client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `${legacyPrefix}-outside/`, MaxKeys: 1 })));
  await denied(() => client.send(new HeadObjectCommand({ Bucket: bucket, Key: newCanary })));
  await denied(() => client.send(new GetObjectCommand({ Bucket: bucket, Key: newCanary })));
	await denied(() => client.send(new PutObjectCommand({ Bucket: bucket, Key: newCanary, Body: Buffer.from([0]) })),
		undefined);
  await denied(() => client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${newPrefix}/`, MaxKeys: 1 })));
	await denied(() => client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `${newPrefix}/`, MaxKeys: 1 })));
	const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
	const bucketVersioningStatus = versioning.Status === undefined ? 'NEVER_ENABLED' : versioning.Status;
	if (!['NEVER_ENABLED','Enabled','Suspended'].includes(bucketVersioningStatus)) fail();
	const versionRows = [];
	let versionBytes = 0;
	let keyMarker;
	let versionIdMarker;
	do {
		const page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `${legacyPrefix}/`,
			KeyMarker: keyMarker, VersionIdMarker: versionIdMarker, MaxKeys: 1000 }));
		for (const item of page.Versions || []) {
			if (!safeLegacyKey(item.Key) || typeof item.VersionId !== 'string' || !item.VersionId || item.VersionId.length > 1024 ||
					!Number.isSafeInteger(item.Size) || item.Size < 0 || item.Size > 100 * 1024 * 1024 ||
					typeof item.IsLatest !== 'boolean' || !(item.LastModified instanceof Date)) fail();
			const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.Key, VersionId: item.VersionId }));
			const digest = await hashBody(object.Body);
			if (digest.size !== item.Size || (object.ContentLength !== undefined && object.ContentLength !== digest.size)) fail();
			versionBytes += digest.size;
			versionRows.push({ key: item.Key, versionId: item.VersionId, kind: 'OBJECT', isLatest: item.IsLatest,
				size: digest.size, sha256: digest.sha256, lastModified: item.LastModified.toISOString() });
		}
		for (const item of page.DeleteMarkers || []) {
			if (!safeLegacyKey(item.Key) || typeof item.VersionId !== 'string' || !item.VersionId || item.VersionId.length > 1024 ||
					typeof item.IsLatest !== 'boolean' || !(item.LastModified instanceof Date)) fail();
			versionRows.push({ key: item.Key, versionId: item.VersionId, kind: 'DELETE_MARKER', isLatest: item.IsLatest,
				size: 0, sha256: null, lastModified: item.LastModified.toISOString() });
		}
		if (versionRows.length > 100000 || versionBytes > 5 * 1024 * 1024 * 1024) fail();
		keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
		versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
		if (page.IsTruncated && (!keyMarker || !versionIdMarker)) fail();
	} while (keyMarker);
	versionRows.sort((left, right) => compareUtf8(left.key, right.key) ||
		compareUtf8(left.versionId, right.versionId) || compareUtf8(left.kind, right.kind));
	if (versionRows.some((item, index) => !item.key.startsWith(`${legacyPrefix}/`) ||
		item.key.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) ||
		(index > 0 && item.key === versionRows[index - 1].key && item.versionId === versionRows[index - 1].versionId &&
			item.kind === versionRows[index - 1].kind))) fail();
	const listed = [];
	let listedBytes = 0;
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${legacyPrefix}/`,
      ContinuationToken: token, MaxKeys: 1000 }));
		for (const item of page.Contents || []) {
			if (!safeLegacyKey(item.Key) || !Number.isSafeInteger(item.Size) || item.Size < 0 || item.Size > 100 * 1024 * 1024) fail();
			listed.push({ key: item.Key, size: item.Size });
			listedBytes += item.Size;
			if (listed.length > 100000 || listedBytes > 5 * 1024 * 1024 * 1024) fail();
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !token) fail();
  } while (token);
  listed.sort((left, right) => compareUtf8(left.key, right.key));
  if (listed.some((item, index) => !item.key.startsWith(`${legacyPrefix}/`) ||
      item.key.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) ||
      (index > 0 && compareUtf8(item.key, listed[index - 1].key) <= 0))) fail();
  const objects = [];
  let totalBytes = 0;
  for (const listedObject of listed) {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: listedObject.key }));
    const digest = await hashBody(object.Body);
    if (digest.size !== listedObject.size || (object.ContentLength !== undefined && object.ContentLength !== digest.size)) fail();
    totalBytes += digest.size;
    objects.push({ key: listedObject.key, size: digest.size, sha256: digest.sha256 });
  }
  const byKey = new Map(objects.map(item => [item.key,item]));
	const currentVersions = new Map(versionRows.filter(item => item.kind === 'OBJECT' && item.isLatest)
		.map(item => [item.key,item]));
	if (currentVersions.size !== objects.length) fail();
	if (bucketVersioningStatus === 'NEVER_ENABLED' &&
		(versionRows.some(item => item.kind !== 'OBJECT' || item.versionId !== 'null' || item.isLatest !== true) ||
			versionRows.length !== objects.length || currentVersions.size !== objects.length)) fail();
	if (objects.some(item => {
		const version = currentVersions.get(item.key);
		return !version || version.size !== item.size || version.sha256 !== item.sha256;
	})) fail();
  const referenced = new Set();
  for (const source of references) {
    const object = byKey.get(source?.key);
    if (source?.kind !== 'S3' || !object || object.sha256 !== source.sourceSha256) fail();
    referenced.add(source.key);
  }
  const value = {
    version: 1, action: 'avatar-legacy-s3-sealed-inventory',
    ownershipRevision: required('AVATAR_OWNERSHIP_REVISION'), cleanupRevision: required('AVATAR_CLEANUP_REVISION'),
    ownershipEvidenceBundleSha256: required('AVATAR_OWNERSHIP_BUNDLE_SHA'),
    inventoryManifestSha256: crypto.createHash('sha256').update(fs.readFileSync('/evidence/inventory.json')).digest('hex'),
    storageEndpointSha256: crypto.createHash('sha256').update(required('AVATAR_AUDIT_ENDPOINT')).digest('hex'),
    storagePublicBaseUrlSha256: crypto.createHash('sha256').update(required('AVATAR_AUDIT_PUBLIC_BASE_URL')).digest('hex'),
    storageRegion: required('AVATAR_AUDIT_REGION'), storageBucket: bucket,
    storageForcePathStyle: required('AVATAR_AUDIT_FORCE_PATH_STYLE') === 'true', newPrefix,
    legacyPrefix, bucketVersioningStatus,
    retirementPolicyEvidenceSha256: required('AVATAR_RETIREMENT_POLICY_SHA'),
    retirementPolicySignatureSha256: required('AVATAR_RETIREMENT_POLICY_SIGNATURE_SHA'),
    capturedByRetirementAccessKeyIdSha256: required('AVATAR_CAPTURE_ACCESS_KEY_SHA'),
    captureAttemptEvidenceSha256: required('AVATAR_CAPTURE_ATTEMPT_SHA'),
    expectedLegacyReferences: references.length, referencedObjectCount: referenced.size,
    orphanObjectCount: objects.length - referenced.size, objectCount: objects.length, totalBytes,
    legacyKeysSha256: crypto.createHash('sha256').update(`${objects.map(item => item.key).join('\n')}\n`).digest('hex'),
    objectsSha256: crypto.createHash('sha256').update(JSON.stringify(objects)).digest('hex'),
    versionEntryCount: versionRows.length,
    objectVersionCount: versionRows.filter(item => item.kind === 'OBJECT').length,
    deleteMarkerCount: versionRows.filter(item => item.kind === 'DELETE_MARKER').length,
    versionTotalBytes: versionBytes,
    versionsSha256: crypto.createHash('sha256').update(JSON.stringify(versionRows)).digest('hex'),
    policyChecks: ['missing-legacy-head-allowed','missing-legacy-get-allowed','missing-legacy-delete-allowed',
      'legacy-put-denied','legacy-exact-prefix-list-allowed','legacy-exact-prefix-version-list-allowed',
      'outside-prefix-list-denied','outside-prefix-version-list-denied','new-head-denied','new-get-denied',
      'new-put-denied','new-list-denied','new-version-list-denied',
      'bucket-versioning-state-captured'],
    objects, versions: versionRows, capturedAt: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
})().catch(fail);
NODE
	chmod 600 "$raw" || return 1
	chown 0:0 "$raw" || return 1
	avatar_cleanup_seal_json_artifact "$raw" "$avatar_cleanup_retirement_inventory" || return 1
	rm -f -- "$raw" || return 1
	avatar_cleanup_validate_retirement_inventory
}

avatar_cleanup_recover_retirement_journal_publication() {
	avatar_cleanup_validate_private_file "$avatar_cleanup_retirement_journal" || return 1
	JOURNAL_FILE="$avatar_cleanup_retirement_journal" node <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const journal = process.env.JOURNAL_FILE;
const stat = fs.lstatSync(journal);
if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
if (stat.nlink === 1) process.exit(0);
if (stat.nlink !== 2) process.exit(1);
const directoryPath = path.dirname(journal);
const prefix = `${path.basename(journal)}.tmp.`;
const candidates = fs.readdirSync(directoryPath).filter(name => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9]+$`).test(name))
  .filter(name => {
    const candidate = fs.lstatSync(path.join(directoryPath, name));
    return candidate.isFile() && !candidate.isSymbolicLink() && candidate.dev === stat.dev && candidate.ino === stat.ino &&
      candidate.uid === stat.uid && candidate.gid === stat.gid && (candidate.mode & 0o777) === 0o600;
  });
if (candidates.length !== 1) process.exit(1);
fs.unlinkSync(path.join(directoryPath, candidates[0]));
const directory = fs.openSync(directoryPath, 'r');
fs.fsyncSync(directory);
fs.closeSync(directory);
if (fs.lstatSync(journal).nlink !== 1) process.exit(1);
NODE
}

avatar_cleanup_prepare_retirement_journal() {
	avatar_cleanup_validate_retirement_inventory || return 1
	avatar_cleanup_prepare_retirement_journal_key || return 1
	if [[ -e "$avatar_cleanup_retirement_journal" || -L "$avatar_cleanup_retirement_journal" ]]; then
		avatar_cleanup_recover_retirement_journal_publication || return 1
		return
	fi
	avatar_cleanup_create_signing_key || return 1
	local sealed_policy_sha temporary
	temporary="${avatar_cleanup_retirement_journal}.tmp.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	trap 'rm -f -- "$temporary"' RETURN
	sealed_policy_sha="$(SEALED_FILE="$avatar_cleanup_retirement_inventory" node -e '
const value=JSON.parse(require("node:fs").readFileSync(process.env.SEALED_FILE,"utf8"));
if(!/^[0-9a-f]{64}$/.test(value.retirementPolicyEvidenceSha256||""))process.exit(1);
process.stdout.write(value.retirementPolicyEvidenceSha256);')" || return 1
	JOURNAL_FILE="$temporary" JOURNAL_KEY_FILE="$avatar_cleanup_retirement_journal_key" \
		SEALED_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_inventory")" \
		POLICY_SHA="$sealed_policy_sha" ENDPOINT_SHA="$avatar_cleanup_storage_endpoint_sha" \
		PUBLIC_BASE_SHA="$avatar_cleanup_storage_public_base_sha" REGION="$AVATAR_AUDIT_REGION" \
		BUCKET="$AVATAR_AUDIT_BUCKET" FORCE_PATH_STYLE="$AVATAR_AUDIT_FORCE_PATH_STYLE" \
		NEW_PREFIX="$AVATAR_AUDIT_KEY_PREFIX" LEGACY_PREFIX="$AVATAR_AUDIT_LEGACY_KEY_PREFIX" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const key = Buffer.from(fs.readFileSync(process.env.JOURNAL_KEY_FILE, 'utf8').trim(), 'hex');
const payload = { version: 1, action: 'avatar-legacy-s3-retirement-journal-header', sequence: 0,
  sealedInventorySha256: process.env.SEALED_SHA, retirementPolicyEvidenceSha256: process.env.POLICY_SHA,
  storageEndpointSha256: process.env.ENDPOINT_SHA, storagePublicBaseUrlSha256: process.env.PUBLIC_BASE_SHA,
  storageRegion: process.env.REGION, storageBucket: process.env.BUCKET,
  storageForcePathStyle: process.env.FORCE_PATH_STYLE === 'true', newPrefix: process.env.NEW_PREFIX,
  legacyPrefix: process.env.LEGACY_PREFIX, previousRecordSha256: null, recordedAt: new Date().toISOString() };
const recordHmacSha256 = crypto.createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
const fd = fs.openSync(process.env.JOURNAL_FILE, 'wx', 0o600);
const body = Buffer.from(`${JSON.stringify({ ...payload, recordHmacSha256 })}\n`);
let offset = 0;
while (offset < body.length) {
  const written = fs.writeSync(fd, body, offset, body.length - offset);
  if (!Number.isSafeInteger(written) || written <= 0) process.exit(1);
  offset += written;
}
fs.fsyncSync(fd);
fs.closeSync(fd);
NODE
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	JOURNAL_TEMPORARY="$temporary" JOURNAL_FILE="$avatar_cleanup_retirement_journal" node <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
fs.linkSync(process.env.JOURNAL_TEMPORARY, process.env.JOURNAL_FILE);
const directory = fs.openSync(path.dirname(process.env.JOURNAL_FILE), 'r');
fs.fsyncSync(directory);
fs.closeSync(directory);
fs.unlinkSync(process.env.JOURNAL_TEMPORARY);
const directoryAfterUnlink = fs.openSync(path.dirname(process.env.JOURNAL_FILE), 'r');
fs.fsyncSync(directoryAfterUnlink);
fs.closeSync(directoryAfterUnlink);
NODE
	trap - RETURN
	avatar_cleanup_validate_private_file "$avatar_cleanup_retirement_journal" || return 1
}

avatar_cleanup_delete_sealed_legacy_objects() {
	[[ $# -eq 2 ]] || return 1
	local image="$1" output="$2" attempt_sha input_sha journal_key_sha
	avatar_cleanup_validate_retirement_inventory || return 1
	avatar_cleanup_prepare_retirement_journal || return 1
	attempt_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_attempt")" || return 1
	input_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_inventory")" || return 1
	journal_key_sha="$(avatar_cleanup_retirement_key_sha256)" || return 1
	avatar_cleanup_run_retirement_node delete "$image" "$input_sha" "$attempt_sha" "$journal_key_sha" \
		--env AVATAR_AUDIT_ENDPOINT --env AVATAR_AUDIT_REGION --env AVATAR_AUDIT_BUCKET \
		--env AVATAR_AUDIT_FORCE_PATH_STYLE --env AVATAR_AUDIT_PUBLIC_BASE_URL \
		--env AVATAR_AUDIT_KEY_PREFIX --env AVATAR_AUDIT_LEGACY_KEY_PREFIX \
		--env "AVATAR_SEALED_INVENTORY_SHA=$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_inventory")" \
		--mount "type=bind,source=$avatar_cleanup_retirement_inventory,target=/evidence/sealed.json,readonly" \
		--mount "type=bind,source=$avatar_cleanup_manifest,target=/evidence/managed.json,readonly" \
		--mount "type=bind,source=$avatar_cleanup_retirement_journal,target=/evidence/journal.jsonl" \
		>"$output" <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  DeleteObjectCommand, GetBucketVersioningCommand, GetObjectCommand, HeadObjectCommand,
  ListObjectsV2Command, ListObjectVersionsCommand, PutObjectCommand, S3Client,
} = require('@aws-sdk/client-s3');
const fail = () => process.exit(1);
const required = name => { const value = process.env[name]; if (!value) fail(); return value; };
const readRetirementCredentials = () => {
  const bytes = fs.readFileSync('/run/secrets/winwidget-avatar-retirement-v1');
  if (bytes.length < 74 || bytes.length > 1024) fail();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(); }
  const match = /^access_key_id=([A-Za-z0-9._-]{8,256})\nsecret_access_key=([A-Za-z0-9+\/_=-]{32,512})\n$/.exec(text);
  if (!match || Buffer.byteLength(text) !== bytes.length) fail();
  return Object.freeze({ accessKeyId: match[1], secretAccessKey: match[2] });
};
const client = new S3Client({ endpoint: required('AVATAR_AUDIT_ENDPOINT'), region: required('AVATAR_AUDIT_REGION'),
  forcePathStyle: required('AVATAR_AUDIT_FORCE_PATH_STYLE') === 'true', maxAttempts: 3,
  credentials: readRetirementCredentials() });
const bucket = required('AVATAR_AUDIT_BUCKET');
const sealedBytes = fs.readFileSync('/evidence/sealed.json');
if (crypto.createHash('sha256').update(sealedBytes).digest('hex') !== required('AVATAR_SEALED_INVENTORY_SHA')) fail();
const sealed = JSON.parse(sealedBytes);
const managed = JSON.parse(fs.readFileSync('/evidence/managed.json', 'utf8'));
const legacyPrefix = required('AVATAR_AUDIT_LEGACY_KEY_PREFIX').replace(/^\/+|\/+$/g, '');
const newPrefix = required('AVATAR_AUDIT_KEY_PREFIX').replace(/^\/+|\/+$/g, '');
const publicBase = required('AVATAR_AUDIT_PUBLIC_BASE_URL').replace(/\/+$/g, '');
const endpointSha = crypto.createHash('sha256').update(required('AVATAR_AUDIT_ENDPOINT')).digest('hex');
const publicBaseSha = crypto.createHash('sha256').update(required('AVATAR_AUDIT_PUBLIC_BASE_URL')).digest('hex');
if (sealed.legacyPrefix !== legacyPrefix || sealed.newPrefix !== newPrefix || newPrefix === legacyPrefix ||
    sealed.storageEndpointSha256 !== endpointSha || sealed.storagePublicBaseUrlSha256 !== publicBaseSha ||
    sealed.storageRegion !== required('AVATAR_AUDIT_REGION') || sealed.storageBucket !== bucket ||
    sealed.storageForcePathStyle !== (required('AVATAR_AUDIT_FORCE_PATH_STYLE') === 'true')) fail();
const denied = async (operation, cleanup) => { try { await operation(); } catch (error) {
	if (error?.$metadata?.httpStatusCode !== 403 && !['AccessDenied','Forbidden'].includes(error?.name) &&
			!['AccessDenied','Forbidden'].includes(error?.Code)) fail(); return; }
	if (cleanup) { try { await cleanup(); } catch {} }
	fail(); };
const missing = async operation => { try { await operation(); return false; } catch (error) {
  if (error?.$metadata?.httpStatusCode === 404 || ['NotFound','NoSuchKey'].includes(error?.name)) return true; throw error; } };
const hashBody = async body => { const hash = crypto.createHash('sha256'); let size = 0;
  for await (const chunk of body) { const value = Buffer.from(chunk); size += value.length; if (size > 100 * 1024 * 1024) fail(); hash.update(value); }
  return { size, sha256: hash.digest('hex') }; };
const compareUtf8 = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
const verifyManagedObjects = async () => {
  for (const object of managed.objects || []) {
    if (object.publicUrl !== `${publicBase}/${object.key.split('/').map(encodeURIComponent).join('/')}` ||
        object.contentType !== 'image/webp' || !Number.isSafeInteger(object.contentLength) ||
        object.contentLength < 12 || object.contentLength > 5242880 || !/^[0-9a-f]{64}$/.test(object.sha256 || '')) fail();
    const response = await fetch(object.publicUrl, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { accept: 'image/webp' } });
    if (response.status !== 200 || response.headers.get('content-type') !== object.contentType) fail();
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length !== object.contentLength || body.subarray(0,4).toString('ascii') !== 'RIFF' ||
        body.subarray(8,12).toString('ascii') !== 'WEBP' || body.readUInt32LE(4) + 8 !== body.length ||
        crypto.createHash('sha256').update(body).digest('hex') !== object.sha256) fail();
  }
  return (managed.objects || []).length;
};
const journalKey = Buffer.from(fs.readFileSync('/run/secrets/winwidget-avatar-retirement-journal-key-v1', 'utf8').trim(), 'hex');
if (journalKey.length !== 32) fail();
const journalPath = '/evidence/journal.jsonl';
const journalBytes = fs.readFileSync(journalPath);
if (journalBytes.length < 2 || journalBytes.length > 128 * 1024 * 1024) fail();
const completeEnd = journalBytes.lastIndexOf(10) + 1;
if (completeEnd < 2) fail();
const hasPartialTail = completeEnd !== journalBytes.length;
const completeJournalBytes = journalBytes.subarray(0, completeEnd);
const journalLines = completeJournalBytes.toString('utf8').trimEnd().split('\n');
const journalExact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const recordHmacValid = value => {
  const { recordHmacSha256, ...payload } = value;
  if (!/^[0-9a-f]{64}$/.test(recordHmacSha256 || '')) return false;
  const actual = crypto.createHmac('sha256', journalKey).update(JSON.stringify(payload)).digest();
  const expected = Buffer.from(recordHmacSha256, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};
let previousRecordSha256 = null;
let nextSequence = 0;
let preflight = null;
const states = new Map();
const entryId = entry => crypto.createHash('sha256').update(JSON.stringify([entry.key,entry.versionId,entry.kind])).digest('hex');
const headerKeys = ['version','action','sequence','sealedInventorySha256','retirementPolicyEvidenceSha256',
  'storageEndpointSha256','storagePublicBaseUrlSha256','storageRegion','storageBucket','storageForcePathStyle',
  'newPrefix','legacyPrefix','previousRecordSha256','recordedAt','recordHmacSha256'];
const mutationKeys = ['version','action','sequence','sealedInventorySha256','entryIdSha256','entryKind',
  'previousRecordSha256','recordedAt','recordHmacSha256'];
const preflightKeys = ['version','action','sequence','sealedInventorySha256','managedManifestSha256',
  'managedObjectsVerified','legacyObjectVersionsVerified','previousRecordSha256','recordedAt','recordHmacSha256'];
for (let index = 0; index < journalLines.length; index += 1) {
  let value;
  try { value = JSON.parse(journalLines[index]); } catch { fail(); }
  if (!recordHmacValid(value) || value.version !== 1 || value.sequence !== index ||
      value.previousRecordSha256 !== previousRecordSha256 || !Number.isFinite(Date.parse(value.recordedAt)) ||
      Date.parse(value.recordedAt) > Date.now() + 300000) fail();
  if (index === 0) {
    if (!journalExact(value, headerKeys) || value.action !== 'avatar-legacy-s3-retirement-journal-header' ||
        value.sealedInventorySha256 !== required('AVATAR_SEALED_INVENTORY_SHA') ||
        value.retirementPolicyEvidenceSha256 !== sealed.retirementPolicyEvidenceSha256 ||
        value.storageEndpointSha256 !== sealed.storageEndpointSha256 ||
        value.storagePublicBaseUrlSha256 !== sealed.storagePublicBaseUrlSha256 ||
        value.storageRegion !== sealed.storageRegion || value.storageBucket !== sealed.storageBucket ||
        value.storageForcePathStyle !== sealed.storageForcePathStyle || value.newPrefix !== newPrefix ||
        value.legacyPrefix !== legacyPrefix || value.previousRecordSha256 !== null) fail();
  } else if (value.action === 'avatar-legacy-s3-retirement-preflight') {
    if (!journalExact(value, preflightKeys) || preflight || states.size !== 0 ||
        value.sealedInventorySha256 !== required('AVATAR_SEALED_INVENTORY_SHA') ||
        value.managedManifestSha256 !== crypto.createHash('sha256').update(fs.readFileSync('/evidence/managed.json')).digest('hex') ||
        value.managedObjectsVerified !== (managed.objects || []).length ||
        value.legacyObjectVersionsVerified !== sealed.objectVersionCount) fail();
    preflight = value;
  } else {
    if (!journalExact(value, mutationKeys) || !preflight ||
        value.sealedInventorySha256 !== required('AVATAR_SEALED_INVENTORY_SHA') ||
        !/^[0-9a-f]{64}$/.test(value.entryIdSha256 || '') || !/^(OBJECT|DELETE_MARKER)$/.test(value.entryKind || '')) fail();
    const source = sealed.versions.find(entry => entryId(entry) === value.entryIdSha256);
    if (!source || source.kind !== value.entryKind) fail();
    const state = states.get(value.entryIdSha256);
    if (value.action === 'avatar-legacy-s3-retirement-intent' && state === undefined) states.set(value.entryIdSha256, 'intent');
    else if (value.action === 'avatar-legacy-s3-retirement-confirmed' && state === 'intent') states.set(value.entryIdSha256, 'confirmed');
    else fail();
  }
  previousRecordSha256 = crypto.createHash('sha256').update(`${journalLines[index]}\n`).digest('hex');
  nextSequence = index + 1;
}
if (hasPartialTail) {
  const fd = fs.openSync(journalPath, 'r+');
  fs.ftruncateSync(fd, completeEnd);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}
const appendJournal = payload => {
  const record = { ...payload, previousRecordSha256, recordedAt: new Date().toISOString() };
  const recordHmacSha256 = crypto.createHmac('sha256', journalKey).update(JSON.stringify(record)).digest('hex');
  const line = Buffer.from(`${JSON.stringify({ ...record, recordHmacSha256 })}\n`);
	const fd = fs.openSync(journalPath, 'a');
	let offset = 0;
	while (offset < line.length) {
	  const written = fs.writeSync(fd, line, offset, line.length - offset);
	  if (!Number.isSafeInteger(written) || written <= 0) fail();
	  offset += written;
	}
	fs.fsyncSync(fd);
	fs.closeSync(fd);
  previousRecordSha256 = crypto.createHash('sha256').update(line).digest('hex');
  nextSequence += 1;
};
const listVersions = async () => {
  const rows = [];
  let keyMarker;
  let versionIdMarker;
  do {
    const page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `${legacyPrefix}/`,
      KeyMarker: keyMarker, VersionIdMarker: versionIdMarker, MaxKeys: 1000 }));
    for (const item of page.Versions || []) rows.push({ key: item.Key, versionId: item.VersionId, kind: 'OBJECT',
      size: item.Size, lastModified: item.LastModified?.toISOString() });
    for (const item of page.DeleteMarkers || []) rows.push({ key: item.Key, versionId: item.VersionId,
      kind: 'DELETE_MARKER', size: 0, lastModified: item.LastModified?.toISOString() });
    if (rows.length > 100000) fail();
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    if (page.IsTruncated && (typeof keyMarker !== 'string' || typeof versionIdMarker !== 'string')) fail();
  } while (keyMarker !== undefined);
  rows.sort((left, right) => compareUtf8(left.key, right.key) || compareUtf8(left.versionId, right.versionId) ||
    compareUtf8(left.kind, right.kind));
  const ids = new Set();
  if (rows.some((row, index) => {
      const id = JSON.stringify([row.key,row.versionId,row.kind]);
      const invalid = typeof row.key !== 'string' || typeof row.versionId !== 'string' || !row.versionId ||
        !row.key.startsWith(`${legacyPrefix}/`) || !/^(OBJECT|DELETE_MARKER)$/.test(row.kind || '') ||
        !Number.isSafeInteger(row.size) || row.size < 0 || row.size > 100 * 1024 * 1024 ||
        !Number.isFinite(Date.parse(row.lastModified)) || ids.has(id) ||
        (index > 0 && (compareUtf8(row.key, rows[index - 1].key) ||
          compareUtf8(row.versionId, rows[index - 1].versionId) || compareUtf8(row.kind, rows[index - 1].kind)) <= 0);
      ids.add(id);
      return invalid;
    })) fail();
  return rows;
};
(async () => {
  const nonce = crypto.randomUUID();
  const legacyCanary = `${legacyPrefix}/_retirement-delete-canary/${nonce}.bin`;
  const newCanary = `${newPrefix}/_retirement-delete-canary/${nonce}.bin`;
  if (!(await missing(() => client.send(new HeadObjectCommand({ Bucket: bucket, Key: legacyCanary }))))) fail();
  if (!(await missing(() => client.send(new GetObjectCommand({ Bucket: bucket, Key: legacyCanary }))))) fail();
	await denied(() => client.send(new PutObjectCommand({ Bucket: bucket, Key: legacyCanary, Body: Buffer.from([0]) })),
		undefined);
  await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${legacyPrefix}/`, MaxKeys: 1 }));
	await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `${legacyPrefix}/`, MaxKeys: 1 }));
  await denied(() => client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${legacyPrefix}-outside/`, MaxKeys: 1 })));
	await denied(() => client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `${legacyPrefix}-outside/`, MaxKeys: 1 })));
  await denied(() => client.send(new HeadObjectCommand({ Bucket: bucket, Key: newCanary })));
  await denied(() => client.send(new GetObjectCommand({ Bucket: bucket, Key: newCanary })));
  await denied(() => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: newCanary })));
	await denied(() => client.send(new PutObjectCommand({ Bucket: bucket, Key: newCanary, Body: Buffer.from([0]) })),
		undefined);
  await denied(() => client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${newPrefix}/`, MaxKeys: 1 })));
	await denied(() => client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: `${newPrefix}/`, MaxKeys: 1 })));
	const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
	const versioningStatus = versioning.Status === undefined ? 'NEVER_ENABLED' : versioning.Status;
	if (versioningStatus !== sealed.bucketVersioningStatus) fail();
  // This is the last reversible gate. Never delete a legacy source until every
  // managed replacement still matches the sealed public byte manifest.
  const managedObjectsPreflightVerified = await verifyManagedObjects();
  const live = await listVersions();
  const sealedById = new Map(sealed.versions.map(entry => [entryId(entry),entry]));
  const liveById = new Map(live.map(entry => [entryId(entry),entry]));
  if (sealedById.size !== sealed.versionEntryCount || liveById.size !== live.length ||
      live.some(entry => !sealedById.has(entryId(entry))) ||
      (versioningStatus === 'NEVER_ENABLED' &&
        (live.length !== sealed.objectCount || live.some(entry => entry.kind !== 'OBJECT' || entry.versionId !== 'null')))) fail();
  let legacyObjectVersionsPreflightVerified = 0;
  for (const source of sealed.versions) {
    const id = entryId(source);
    const current = liveById.get(id);
    if (!current) {
      if (!preflight || !['intent','confirmed'].includes(states.get(id))) fail();
      continue;
    }
    if (source.kind === 'OBJECT') {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: source.key, VersionId: source.versionId }));
      const digest = await hashBody(object.Body);
      if (digest.size !== source.size || digest.sha256 !== source.sha256 ||
          (object.ContentLength !== undefined && object.ContentLength !== source.size)) fail();
      legacyObjectVersionsPreflightVerified += 1;
    }
  }
  if (!preflight) {
    if (legacyObjectVersionsPreflightVerified !== sealed.objectVersionCount || live.length !== sealed.versionEntryCount) fail();
    appendJournal({ version: 1, action: 'avatar-legacy-s3-retirement-preflight', sequence: nextSequence,
      sealedInventorySha256: required('AVATAR_SEALED_INVENTORY_SHA'),
      managedManifestSha256: crypto.createHash('sha256').update(fs.readFileSync('/evidence/managed.json')).digest('hex'),
      managedObjectsVerified: managedObjectsPreflightVerified,
      legacyObjectVersionsVerified: legacyObjectVersionsPreflightVerified });
    preflight = true;
  }
  let verifiedAndDeleted = 0;
  let resumedAfterIntent = 0;
  let alreadyConfirmed = 0;
  const deletedThisRun = [];
  for (const source of sealed.versions) {
    const id = entryId(source);
    const current = liveById.get(id);
    let state = states.get(id);
    if (!current) {
      if (state === 'intent') {
        appendJournal({ version: 1, action: 'avatar-legacy-s3-retirement-confirmed', sequence: nextSequence,
          sealedInventorySha256: required('AVATAR_SEALED_INVENTORY_SHA'), entryIdSha256: id, entryKind: source.kind });
        states.set(id, 'confirmed');
        resumedAfterIntent += 1;
      } else if (state === 'confirmed') alreadyConfirmed += 1;
      else fail();
      continue;
    }
    if (state === 'confirmed') fail();
    if (state === undefined) {
      appendJournal({ version: 1, action: 'avatar-legacy-s3-retirement-intent', sequence: nextSequence,
        sealedInventorySha256: required('AVATAR_SEALED_INVENTORY_SHA'), entryIdSha256: id, entryKind: source.kind });
      states.set(id, 'intent');
    } else if (state !== 'intent') fail();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: source.key, VersionId: source.versionId }));
    deletedThisRun.push({ id, kind: source.kind });
    verifiedAndDeleted += 1;
  }
  if ((await listVersions()).length !== 0) fail();
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${legacyPrefix}/`,
      ContinuationToken: token, MaxKeys: 1000 }));
    if ((page.Contents || []).length !== 0 || (page.CommonPrefixes || []).length !== 0) fail();
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !token) fail();
  } while (token);
  for (const source of sealed.objects) {
    if (!(await missing(() => client.send(new HeadObjectCommand({ Bucket: bucket, Key: source.key })))) ||
        !(await missing(() => client.send(new GetObjectCommand({ Bucket: bucket, Key: source.key }))))) fail();
  }
  for (const deleted of deletedThisRun) {
    if (states.get(deleted.id) !== 'intent') fail();
    appendJournal({ version: 1, action: 'avatar-legacy-s3-retirement-confirmed', sequence: nextSequence,
      sealedInventorySha256: required('AVATAR_SEALED_INVENTORY_SHA'), entryIdSha256: deleted.id,
      entryKind: deleted.kind });
    states.set(deleted.id, 'confirmed');
  }
  if (sealed.versions.some(source => states.get(entryId(source)) !== 'confirmed')) fail();
  const managedObjectsPostDeleteVerified = await verifyManagedObjects();
  const finalJournal = fs.readFileSync(journalPath);
  process.stdout.write(`${JSON.stringify({
    sealedInventorySha256: required('AVATAR_SEALED_INVENTORY_SHA'), sealedObjectCount: sealed.objectCount,
    sealedTotalBytes: sealed.totalBytes, expectedLegacyReferences: sealed.expectedLegacyReferences,
    referencedObjects: sealed.referencedObjectCount, orphanObjects: sealed.orphanObjectCount,
    sealedVersionEntryCount: sealed.versionEntryCount, sealedObjectVersionCount: sealed.objectVersionCount,
    sealedDeleteMarkerCount: sealed.deleteMarkerCount, sealedVersionTotalBytes: sealed.versionTotalBytes,
    verifiedAndDeleted, resumedAfterIntent, alreadyConfirmed, managedObjectsPreflightVerified,
    legacyObjectVersionsPreflightVerified, managedObjectsPostDeleteVerified,
    journalSha256: crypto.createHash('sha256').update(finalJournal).digest('hex'), journalRecordCount: nextSequence,
    legacyPrefixEmpty: true, legacyVersionsEmpty: true,
    policyChecks: ['missing-legacy-head-allowed','missing-legacy-get-allowed','legacy-put-denied',
      'legacy-exact-prefix-list-allowed','legacy-exact-prefix-version-list-allowed',
      'outside-prefix-list-denied','outside-prefix-version-list-denied',
      'new-head-denied','new-get-denied','new-delete-denied','new-put-denied','new-list-denied','new-version-list-denied',
      'bucket-versioning-state-revalidated','managed-public-bytes-preflight-intact','legacy-version-bytes-preflight-intact',
      'legacy-sealed-objects-absent','legacy-exact-prefix-empty',
      'legacy-exact-prefix-versions-empty','durable-per-version-journal-complete','managed-public-bytes-post-delete-intact'],
  })}\n`);
})().catch(fail);
NODE
	chmod 600 "$output" || return 1
	chown 0:0 "$output" || return 1
	avatar_cleanup_sign_artifact "$avatar_cleanup_retirement_journal" || return 1
}

avatar_cleanup_validate_retirement_journal() {
	avatar_cleanup_verify_artifact "$avatar_cleanup_retirement_journal" || return 1
	avatar_cleanup_validate_retirement_journal_key || return 1
	JOURNAL_FILE="$avatar_cleanup_retirement_journal" SEALED_FILE="$avatar_cleanup_retirement_inventory" \
		MANAGED_FILE="$avatar_cleanup_manifest" JOURNAL_KEY_FILE="$avatar_cleanup_retirement_journal_key" \
		SEALED_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_inventory")" \
		ENDPOINT_SHA="$avatar_cleanup_storage_endpoint_sha" \
		PUBLIC_BASE_SHA="$avatar_cleanup_storage_public_base_sha" REGION="$AVATAR_AUDIT_REGION" \
		BUCKET="$AVATAR_AUDIT_BUCKET" FORCE_PATH_STYLE="$AVATAR_AUDIT_FORCE_PATH_STYLE" \
		NEW_PREFIX="$AVATAR_AUDIT_KEY_PREFIX" LEGACY_PREFIX="$AVATAR_AUDIT_LEGACY_KEY_PREFIX" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const bytes = fs.readFileSync(process.env.JOURNAL_FILE);
if (bytes.length < 2 || bytes.length > 128 * 1024 * 1024 || bytes.at(-1) !== 10) process.exit(1);
const lines = bytes.toString('utf8').trimEnd().split('\n');
const sealed = JSON.parse(fs.readFileSync(process.env.SEALED_FILE, 'utf8'));
const managedSha = crypto.createHash('sha256').update(fs.readFileSync(process.env.MANAGED_FILE)).digest('hex');
const key = Buffer.from(fs.readFileSync(process.env.JOURNAL_KEY_FILE, 'utf8').trim(), 'hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const headerKeys = ['version','action','sequence','sealedInventorySha256','retirementPolicyEvidenceSha256',
  'storageEndpointSha256','storagePublicBaseUrlSha256','storageRegion','storageBucket','storageForcePathStyle',
  'newPrefix','legacyPrefix','previousRecordSha256','recordedAt','recordHmacSha256'];
const preflightKeys = ['version','action','sequence','sealedInventorySha256','managedManifestSha256',
  'managedObjectsVerified','legacyObjectVersionsVerified','previousRecordSha256','recordedAt','recordHmacSha256'];
const mutationKeys = ['version','action','sequence','sealedInventorySha256','entryIdSha256','entryKind',
  'previousRecordSha256','recordedAt','recordHmacSha256'];
const entryId = entry => crypto.createHash('sha256').update(JSON.stringify([entry.key,entry.versionId,entry.kind])).digest('hex');
const sealedById = new Map(sealed.versions.map(entry => [entryId(entry),entry]));
if (sealedById.size !== sealed.versionEntryCount || lines.length !== 2 + sealed.versionEntryCount * 2) process.exit(1);
let previous = null;
let preflight = false;
const states = new Map();
for (let index = 0; index < lines.length; index += 1) {
  let value;
  try { value = JSON.parse(lines[index]); } catch { process.exit(1); }
  const { recordHmacSha256, ...payload } = value;
  const actual = crypto.createHmac('sha256', key).update(JSON.stringify(payload)).digest();
  const expected = Buffer.from(recordHmacSha256 || '', 'hex');
  if (!/^[0-9a-f]{64}$/.test(recordHmacSha256 || '') || expected.length !== actual.length ||
      !crypto.timingSafeEqual(expected, actual) || value.version !== 1 || value.sequence !== index ||
      value.previousRecordSha256 !== previous || !Number.isFinite(Date.parse(value.recordedAt)) ||
      Date.parse(value.recordedAt) > Date.now() + 300000) process.exit(1);
  if (index === 0) {
    if (!exact(value, headerKeys) || value.action !== 'avatar-legacy-s3-retirement-journal-header' ||
        value.sealedInventorySha256 !== process.env.SEALED_SHA ||
        value.retirementPolicyEvidenceSha256 !== sealed.retirementPolicyEvidenceSha256 ||
        value.storageEndpointSha256 !== process.env.ENDPOINT_SHA ||
        value.storagePublicBaseUrlSha256 !== process.env.PUBLIC_BASE_SHA || value.storageRegion !== process.env.REGION ||
        value.storageBucket !== process.env.BUCKET || value.storageForcePathStyle !== (process.env.FORCE_PATH_STYLE === 'true') ||
        value.newPrefix !== process.env.NEW_PREFIX || value.legacyPrefix !== process.env.LEGACY_PREFIX ||
        value.previousRecordSha256 !== null) process.exit(1);
  } else if (index === 1) {
    if (!exact(value, preflightKeys) || value.action !== 'avatar-legacy-s3-retirement-preflight' ||
        value.sealedInventorySha256 !== process.env.SEALED_SHA || value.managedManifestSha256 !== managedSha ||
        value.managedObjectsVerified !== (JSON.parse(fs.readFileSync(process.env.MANAGED_FILE, 'utf8')).objects || []).length ||
        value.legacyObjectVersionsVerified !== sealed.objectVersionCount) process.exit(1);
    preflight = true;
  } else {
    if (!preflight || !exact(value, mutationKeys) || value.sealedInventorySha256 !== process.env.SEALED_SHA ||
        !sealedById.has(value.entryIdSha256) || sealedById.get(value.entryIdSha256).kind !== value.entryKind) process.exit(1);
    const state = states.get(value.entryIdSha256);
    if (value.action === 'avatar-legacy-s3-retirement-intent' && state === undefined) states.set(value.entryIdSha256, 'intent');
    else if (value.action === 'avatar-legacy-s3-retirement-confirmed' && state === 'intent') states.set(value.entryIdSha256, 'confirmed');
    else process.exit(1);
  }
  previous = crypto.createHash('sha256').update(`${lines[index]}\n`).digest('hex');
}
if (!preflight || [...sealedById.keys()].some(id => states.get(id) !== 'confirmed')) process.exit(1);
NODE
}


avatar_cleanup_retire_legacy_objects() (
	local avatar_cleanup_retirement_temporary_root=''
	local avatar_cleanup_active_retirement_container_name=''
	local avatar_cleanup_active_retirement_cidfile=''
	local avatar_cleanup_active_retirement_operation=''
	local avatar_cleanup_active_retirement_image=''
	local avatar_cleanup_active_retirement_input_sha=''
	local avatar_cleanup_active_retirement_attempt_sha=''
	local avatar_cleanup_active_retirement_journal_key_sha=''
	local avatar_cleanup_retirement_exit_reason='active-command-failed'
	avatar_cleanup_install_retirement_exit_traps
	avatar_cleanup_require_ownership_artifacts || return 1
	avatar_cleanup_load_storage_environment || return 1
	avatar_cleanup_require_retirement_tmpfs || return 1
	local reconciliation_status=0
	avatar_cleanup_reconcile_retirement_consumers || reconciliation_status=$?
	if [[ "$reconciliation_status" -eq 75 ]]; then
		avatar_cleanup_fail 'retirement consumer crash state was reconciled; install a newly issued credential and rerun' || true
		return 75
	fi
	[[ "$reconciliation_status" -eq 0 ]] || return "$reconciliation_status"
	avatar_cleanup_load_retirement_credential || return 1
	avatar_cleanup_require_retirement_policy_evidence active ||
		avatar_cleanup_fail 'signed exact-scope retirement credential policy evidence is required' || return 1
	local temporary_root s3_result uploads_result widgets_before widgets_after output image sealed_sha recovery_binding
	temporary_root="$(mktemp -d "$avatar_cleanup_root/.retirement.XXXXXX")" || return 1
	avatar_cleanup_retirement_temporary_root="$temporary_root"
	chmod 700 "$temporary_root" || return 1
	chown 0:0 "$temporary_root" || return 1
	s3_result="$temporary_root/s3.json"
	uploads_result="$temporary_root/uploads.json"
	widgets_before="$temporary_root/widgets-before.json"
	widgets_after="$temporary_root/widgets-after.json"
	output="$temporary_root/evidence.json"
	if [[ -e "$avatar_cleanup_retirement_inventory" || -L "$avatar_cleanup_retirement_inventory" ]]; then
		avatar_cleanup_validate_retirement_inventory || return 1
		sealed_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_inventory")"
	else
		sealed_sha='pending'
	fi
	avatar_cleanup_record_retirement_attempt "$sealed_sha" || return 1
	image="$(avatar_cleanup_retirement_image_id)" || return 1
	avatar_cleanup_prepare_retirement_inventory "$image" || return 1
	avatar_cleanup_set_retirement_journal_scope "$avatar_cleanup_retirement_access_key_sha" || return 1
	avatar_cleanup_prepare_retirement_journal_key || return 1
	avatar_cleanup_capture_widgets_storage_denial "$widgets_before" before-retirement ||
		avatar_cleanup_fail 'live Widgets credential can access a retired/new avatar prefix' || return 1
	avatar_cleanup_delete_sealed_legacy_objects "$image" "$s3_result" || return 1
	avatar_cleanup_validate_retirement_journal || return 1
	avatar_cleanup_remove_uploads_copy "$uploads_result" || return 1
	avatar_cleanup_capture_widgets_storage_denial "$widgets_after" after-retirement ||
		avatar_cleanup_fail 'live Widgets credential can access a retired/new avatar prefix after deletion' || return 1
	recovery_binding="$(avatar_cleanup_retirement_consumer_recovery_binding)" || return 1
	RETIREMENT_S3="$s3_result" RETIREMENT_UPLOADS="$uploads_result" \
		RETIREMENT_WIDGETS_BEFORE="$widgets_before" RETIREMENT_WIDGETS_AFTER="$widgets_after" \
		RETIREMENT_OUTPUT="$output" ACCESS_KEY_SHA="$avatar_cleanup_retirement_access_key_sha" \
		RECOVERY_BINDING="$recovery_binding" \
			OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
			CURRENT_RUNTIME_REVISION="$avatar_cleanup_runtime_revision" \
		OWNERSHIP_BUNDLE_SHA="$avatar_cleanup_ownership_bundle_sha" \
		INVENTORY_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_inventory_manifest")" \
		MANAGED_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_manifest")" \
		SEALED_S3_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_inventory")" \
		RETIREMENT_JOURNAL_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_journal")" \
		SEALED_UPLOADS_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_uploads_retirement_inventory")" \
		POLICY_SHA="$avatar_cleanup_retirement_policy_sha" \
		POLICY_SIGNATURE_SHA="$avatar_cleanup_retirement_policy_signature_sha" \
		ATTEMPT_SHA="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_attempt")" node <<'NODE' || return 1
const fs = require('node:fs');
const recovery = JSON.parse(process.env.RECOVERY_BINDING);
const evidence = {
  version: 1, action: 'avatar-legacy-object-retirement',
  ownershipRevision: process.env.OWNERSHIP_REVISION, cleanupRevision: process.env.CLEANUP_REVISION,
  ownershipEvidenceBundleSha256: process.env.OWNERSHIP_BUNDLE_SHA,
  inventoryManifestSha256: process.env.INVENTORY_SHA, managedManifestSha256: process.env.MANAGED_SHA,
  sealedS3InventorySha256: process.env.SEALED_S3_SHA,
  retirementJournalSha256: process.env.RETIREMENT_JOURNAL_SHA,
  sealedUploadsInventorySha256: process.env.SEALED_UPLOADS_SHA,
  retirementPolicyEvidenceSha256: process.env.POLICY_SHA,
  retirementPolicySignatureSha256: process.env.POLICY_SIGNATURE_SHA,
  retirementAttemptEvidenceSha256: process.env.ATTEMPT_SHA,
  retirementAccessKeyIdSha256: process.env.ACCESS_KEY_SHA,
  retirementConsumerRecoveryEvidenceCount: recovery.count,
  retirementConsumerRecoveryEvidenceAggregateSha256: recovery.aggregateSha256,
  retirementConsumerRecoveryEvidenceArtifacts: recovery.artifacts,
  widgetsRuntimePolicyBefore: JSON.parse(fs.readFileSync(process.env.RETIREMENT_WIDGETS_BEFORE, 'utf8')),
  s3: JSON.parse(fs.readFileSync(process.env.RETIREMENT_S3, 'utf8')),
  uploadsCopy: JSON.parse(fs.readFileSync(process.env.RETIREMENT_UPLOADS, 'utf8')),
  widgetsRuntimePolicyAfter: JSON.parse(fs.readFileSync(process.env.RETIREMENT_WIDGETS_AFTER, 'utf8')),
  completedAt: new Date().toISOString(),
};
fs.writeFileSync(process.env.RETIREMENT_OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	avatar_cleanup_write_json_artifact "$avatar_cleanup_retirement" "$output" || return 1
	avatar_cleanup_validate_retirement_evidence || return 1
	avatar_cleanup_durable_unlink_private_file "$AVATAR_RETIREMENT_CREDENTIAL_FILE" || return 1
	avatar_cleanup_retirement_exit_reason='completed'
	avatar_cleanup_update_forward_marker forward-only \
		"$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_retirement")" pending \
		"$(avatar_cleanup_marker_value nginx_evidence_sha256)" \
		"$(avatar_cleanup_marker_value smoke_evidence_sha256)" \
		"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" \
		"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)"
)


avatar_cleanup_validate_retirement_evidence() (
	avatar_cleanup_verify_artifact "$avatar_cleanup_retirement" || return 1
	avatar_cleanup_load_storage_environment || return 1
	avatar_cleanup_validate_retirement_inventory || return 1
	avatar_cleanup_validate_uploads_retirement_inventory || return 1
	local access_key_sha attempt recovery_binding
	access_key_sha="$(RETIREMENT_FILE="$avatar_cleanup_retirement" node -e '
const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.env.RETIREMENT_FILE,"utf8"));
if(!/^[0-9a-f]{64}$/.test(value.retirementAccessKeyIdSha256||""))process.exit(1);
process.stdout.write(value.retirementAccessKeyIdSha256);')" || return 1
	avatar_cleanup_retirement_access_key_sha="$access_key_sha"
	avatar_cleanup_require_retirement_policy_evidence || return 1
	attempt="$avatar_cleanup_root/retirement-credential-attempt-$access_key_sha.json"
	avatar_cleanup_verify_artifact "$attempt" || return 1
	avatar_cleanup_set_retirement_journal_scope "$access_key_sha" || return 1
	avatar_cleanup_validate_retirement_journal_key || return 1
	avatar_cleanup_validate_retirement_journal || return 1
	recovery_binding="$(avatar_cleanup_retirement_consumer_recovery_binding)" || return 1
	RETIREMENT_FILE="$avatar_cleanup_retirement" INVENTORY_FILE="$avatar_cleanup_inventory_manifest" \
		MANAGED_FILE="$avatar_cleanup_manifest" SEALED_S3_FILE="$avatar_cleanup_retirement_inventory" \
		RETIREMENT_JOURNAL_FILE="$avatar_cleanup_retirement_journal" \
		SEALED_UPLOADS_FILE="$avatar_cleanup_uploads_retirement_inventory" ATTEMPT_FILE="$attempt" \
		POLICY_FILE="$avatar_cleanup_retirement_policy_evidence" \
		POLICY_SIGNATURE_FILE="$avatar_cleanup_retirement_policy_signature" \
			SHA_A_POLICY_FILE="$avatar_cleanup_policy_evidence" \
			OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" \
			CURRENT_RUNTIME_REVISION="$avatar_cleanup_runtime_revision" \
			OWNERSHIP_BUNDLE_SHA="$avatar_cleanup_ownership_bundle_sha" \
			RECOVERY_BINDING="$recovery_binding" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exact = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const value = JSON.parse(fs.readFileSync(process.env.RETIREMENT_FILE, 'utf8'));
const inventory = JSON.parse(fs.readFileSync(process.env.INVENTORY_FILE, 'utf8'));
const managed = JSON.parse(fs.readFileSync(process.env.MANAGED_FILE, 'utf8'));
const sealedS3 = JSON.parse(fs.readFileSync(process.env.SEALED_S3_FILE, 'utf8'));
const sealedUploads = JSON.parse(fs.readFileSync(process.env.SEALED_UPLOADS_FILE, 'utf8'));
const attempt = JSON.parse(fs.readFileSync(process.env.ATTEMPT_FILE, 'utf8'));
const policy = JSON.parse(fs.readFileSync(process.env.POLICY_FILE, 'utf8'));
const recovery = JSON.parse(process.env.RECOVERY_BINDING);
if (!exact(value, ['version','action','ownershipRevision','cleanupRevision','ownershipEvidenceBundleSha256',
    'inventoryManifestSha256','managedManifestSha256','sealedS3InventorySha256','retirementJournalSha256',
    'sealedUploadsInventorySha256','retirementPolicyEvidenceSha256','retirementPolicySignatureSha256',
    'retirementAttemptEvidenceSha256','retirementAccessKeyIdSha256',
    'retirementConsumerRecoveryEvidenceCount','retirementConsumerRecoveryEvidenceAggregateSha256',
    'retirementConsumerRecoveryEvidenceArtifacts','widgetsRuntimePolicyBefore','s3',
    'uploadsCopy','widgetsRuntimePolicyAfter','completedAt']) || value.version !== 1 ||
    value.action !== 'avatar-legacy-object-retirement' || value.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION || value.ownershipEvidenceBundleSha256 !== process.env.OWNERSHIP_BUNDLE_SHA ||
    value.inventoryManifestSha256 !== sha(process.env.INVENTORY_FILE) || value.managedManifestSha256 !== sha(process.env.MANAGED_FILE) ||
    value.sealedS3InventorySha256 !== sha(process.env.SEALED_S3_FILE) ||
    value.retirementJournalSha256 !== sha(process.env.RETIREMENT_JOURNAL_FILE) ||
    value.sealedUploadsInventorySha256 !== sha(process.env.SEALED_UPLOADS_FILE) ||
    value.retirementPolicyEvidenceSha256 !== sha(process.env.POLICY_FILE) ||
    value.retirementPolicySignatureSha256 !== sha(process.env.POLICY_SIGNATURE_FILE) ||
    value.retirementConsumerRecoveryEvidenceCount !== recovery.count ||
    value.retirementConsumerRecoveryEvidenceAggregateSha256 !== recovery.aggregateSha256 ||
    JSON.stringify(value.retirementConsumerRecoveryEvidenceArtifacts) !== JSON.stringify(recovery.artifacts) ||
    !/^[0-9a-f]{64}$/.test(value.retirementAccessKeyIdSha256 || '') || !Number.isFinite(Date.parse(value.completedAt)) ||
    Date.parse(value.completedAt) > Date.now() + 300000 ||
    Date.parse(value.completedAt) > Date.parse(policy.expiresAt)) process.exit(1);
if (value.retirementAttemptEvidenceSha256 !== sha(process.env.ATTEMPT_FILE)) process.exit(1);
if (!exact(attempt, ['version','action','ownershipRevision','cleanupRevision','inventoryManifestSha256',
    'sealedInventorySha256','retirementPolicyEvidenceSha256','retirementPolicySignatureSha256',
    'storageEndpointSha256','storagePublicBaseUrlSha256','storageRegion','storageBucket','storageForcePathStyle',
    'newPrefix','legacyPrefix','retirementAccessKeyIdSha256','attemptedAt']) || attempt.version !== 1 ||
    attempt.action !== 'avatar-retirement-credential-attempt' || attempt.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
    attempt.cleanupRevision !== process.env.CLEANUP_REVISION || attempt.inventoryManifestSha256 !== value.inventoryManifestSha256 ||
    !['pending',value.sealedS3InventorySha256].includes(attempt.sealedInventorySha256) ||
    attempt.retirementPolicyEvidenceSha256 !== value.retirementPolicyEvidenceSha256 ||
    attempt.retirementPolicySignatureSha256 !== value.retirementPolicySignatureSha256 ||
    attempt.storageEndpointSha256 !== sealedS3.storageEndpointSha256 ||
    attempt.storagePublicBaseUrlSha256 !== sealedS3.storagePublicBaseUrlSha256 ||
    attempt.storageRegion !== sealedS3.storageRegion || attempt.storageBucket !== sealedS3.storageBucket ||
    attempt.storageForcePathStyle !== sealedS3.storageForcePathStyle || attempt.newPrefix !== sealedS3.newPrefix ||
    attempt.legacyPrefix !== sealedS3.legacyPrefix ||
    attempt.retirementAccessKeyIdSha256 !== value.retirementAccessKeyIdSha256 ||
    !Number.isFinite(Date.parse(attempt.attemptedAt)) || Date.parse(attempt.attemptedAt) > Date.parse(value.completedAt) ||
    Date.parse(attempt.attemptedAt) < Date.parse(policy.issuedAt) ||
    Date.parse(attempt.attemptedAt) > Date.parse(policy.expiresAt)) process.exit(1);
const widgetsChecks = ['legacy-head-denied','legacy-get-denied','legacy-put-denied','legacy-delete-denied','legacy-list-denied',
  'legacy-version-list-denied','new-head-denied','new-get-denied','new-put-denied','new-delete-denied',
  'new-list-denied','new-version-list-denied'];
const validateWidgets = (policy, phase) => exact(policy, ['version','action','phase','containerId','imageId','revision',
		'startedAt','restartCount','healthy','accessKeyIdSha256','storageEndpointSha256','storageRegion','storageBucket',
		'storageForcePathStyle','legacyPrefixSha256','newPrefixSha256','legacyProbeKeySha256','newProbeKeySha256',
		'shaAStoragePolicyEvidenceSha256','checks','verifiedAt']) && policy.version === 1 &&
	  policy.action === 'avatar-live-widgets-storage-denial' && policy.phase === phase && /^[0-9a-f]{64}$/.test(policy.containerId || '') &&
		/^sha256:[0-9a-f]{64}$/.test(policy.imageId || '') && policy.revision === process.env.CURRENT_RUNTIME_REVISION &&
	Number.isFinite(Date.parse(policy.startedAt)) && Number.isSafeInteger(policy.restartCount) &&
	policy.restartCount >= 0 && policy.healthy === true &&
  [policy.accessKeyIdSha256,policy.storageEndpointSha256,policy.legacyPrefixSha256,policy.newPrefixSha256,
    policy.legacyProbeKeySha256,policy.newProbeKeySha256,policy.shaAStoragePolicyEvidenceSha256]
    .every(item => /^[0-9a-f]{64}$/.test(item || '')) &&
  policy.storageEndpointSha256 === sealedS3.storageEndpointSha256 && policy.storageRegion === sealedS3.storageRegion &&
  policy.storageBucket === sealedS3.storageBucket && policy.storageForcePathStyle === sealedS3.storageForcePathStyle &&
  policy.legacyPrefixSha256 === crypto.createHash('sha256').update(sealedS3.legacyPrefix).digest('hex') &&
  policy.newPrefixSha256 === crypto.createHash('sha256').update(sealedS3.newPrefix).digest('hex') &&
  policy.legacyProbeKeySha256 === crypto.createHash('sha256').update(sealedS3.versions[0]?.key ||
    `${sealedS3.legacyPrefix}/_widgets-real-key-absence-probe`).digest('hex') &&
  policy.newProbeKeySha256 === crypto.createHash('sha256').update(managed.objects[0]?.key ||
    `${sealedS3.newPrefix}/_widgets-real-key-absence-probe`).digest('hex') &&
  policy.shaAStoragePolicyEvidenceSha256 === sha(process.env.SHA_A_POLICY_FILE) &&
  JSON.stringify(policy.checks) === JSON.stringify(widgetsChecks) && Number.isFinite(Date.parse(policy.verifiedAt));
if (!validateWidgets(value.widgetsRuntimePolicyBefore, 'before-retirement') ||
    !validateWidgets(value.widgetsRuntimePolicyAfter, 'after-retirement') ||
    value.widgetsRuntimePolicyBefore.containerId !== value.widgetsRuntimePolicyAfter.containerId ||
    value.widgetsRuntimePolicyBefore.imageId !== value.widgetsRuntimePolicyAfter.imageId ||
		value.widgetsRuntimePolicyBefore.revision !== value.widgetsRuntimePolicyAfter.revision ||
		value.widgetsRuntimePolicyBefore.startedAt !== value.widgetsRuntimePolicyAfter.startedAt ||
		value.widgetsRuntimePolicyBefore.restartCount !== value.widgetsRuntimePolicyAfter.restartCount ||
    value.widgetsRuntimePolicyBefore.accessKeyIdSha256 !== value.widgetsRuntimePolicyAfter.accessKeyIdSha256 ||
    value.widgetsRuntimePolicyBefore.legacyPrefixSha256 !== value.widgetsRuntimePolicyAfter.legacyPrefixSha256 ||
    value.widgetsRuntimePolicyBefore.newPrefixSha256 !== value.widgetsRuntimePolicyAfter.newPrefixSha256 ||
    Date.parse(value.widgetsRuntimePolicyBefore.verifiedAt) > Date.parse(value.widgetsRuntimePolicyAfter.verifiedAt) ||
    Date.parse(value.widgetsRuntimePolicyAfter.verifiedAt) > Date.parse(value.completedAt)) process.exit(1);
const s3Checks = ['missing-legacy-head-allowed','missing-legacy-get-allowed','legacy-put-denied',
  'legacy-exact-prefix-list-allowed','legacy-exact-prefix-version-list-allowed',
  'outside-prefix-list-denied','outside-prefix-version-list-denied','new-head-denied','new-get-denied',
  'new-delete-denied','new-put-denied','new-list-denied','new-version-list-denied',
  'bucket-versioning-state-revalidated','managed-public-bytes-preflight-intact','legacy-version-bytes-preflight-intact',
  'legacy-sealed-objects-absent','legacy-exact-prefix-empty','legacy-exact-prefix-versions-empty',
  'durable-per-version-journal-complete','managed-public-bytes-post-delete-intact'];
const s3 = value.s3;
if (!exact(s3, ['sealedInventorySha256','sealedObjectCount','sealedTotalBytes','expectedLegacyReferences',
    'referencedObjects','orphanObjects','sealedVersionEntryCount','sealedObjectVersionCount',
    'sealedDeleteMarkerCount','sealedVersionTotalBytes','verifiedAndDeleted','resumedAfterIntent','alreadyConfirmed',
    'managedObjectsPreflightVerified','legacyObjectVersionsPreflightVerified','managedObjectsPostDeleteVerified',
    'journalSha256','journalRecordCount','legacyPrefixEmpty','legacyVersionsEmpty','policyChecks']) ||
    s3.sealedInventorySha256 !== value.sealedS3InventorySha256 ||
    s3.sealedObjectCount !== sealedS3.objectCount || s3.sealedTotalBytes !== sealedS3.totalBytes ||
    s3.expectedLegacyReferences !== sealedS3.expectedLegacyReferences || s3.referencedObjects !== sealedS3.referencedObjectCount ||
    s3.orphanObjects !== sealedS3.orphanObjectCount ||
    s3.sealedVersionEntryCount !== sealedS3.versionEntryCount ||
    s3.sealedObjectVersionCount !== sealedS3.objectVersionCount ||
    s3.sealedDeleteMarkerCount !== sealedS3.deleteMarkerCount ||
    s3.sealedVersionTotalBytes !== sealedS3.versionTotalBytes ||
    ![s3.verifiedAndDeleted,s3.resumedAfterIntent,s3.alreadyConfirmed,s3.managedObjectsPreflightVerified,
      s3.legacyObjectVersionsPreflightVerified,s3.managedObjectsPostDeleteVerified,s3.journalRecordCount]
      .every(item => Number.isSafeInteger(item) && item >= 0) ||
    s3.verifiedAndDeleted + s3.resumedAfterIntent + s3.alreadyConfirmed !== sealedS3.versionEntryCount ||
    s3.managedObjectsPreflightVerified !== managed.objects.length ||
    s3.legacyObjectVersionsPreflightVerified > sealedS3.objectVersionCount ||
    s3.managedObjectsPostDeleteVerified !== managed.objects.length ||
    s3.journalSha256 !== value.retirementJournalSha256 ||
    s3.journalRecordCount !== 2 + sealedS3.versionEntryCount * 2 ||
    s3.legacyPrefixEmpty !== true || s3.legacyVersionsEmpty !== true ||
    JSON.stringify(s3.policyChecks) !== JSON.stringify(s3Checks)) process.exit(1);
if (sealedS3.expectedLegacyReferences !== inventory.rows.filter(row => row.classification === 'LEGACY_S3').length) process.exit(1);
const uploads = value.uploadsCopy;
if (!exact(uploads, ['sealedInventorySha256','sealedEntries','sealedDirectories','sealedObjects','sealedBytes',
    'sealedTreeSha256','expectedLegacyReferences','verifiedAndDeleted','alreadyAbsent','treeAbsent']) ||
    uploads.sealedInventorySha256 !== value.sealedUploadsInventorySha256 || uploads.sealedEntries !== sealedUploads.entries ||
    uploads.sealedDirectories !== sealedUploads.directoryCount || uploads.sealedObjects !== sealedUploads.objectCount ||
    uploads.sealedBytes !== sealedUploads.totalBytes || uploads.sealedTreeSha256 !== sealedUploads.treeSha256 ||
    uploads.expectedLegacyReferences !== sealedUploads.expectedLegacyReferences ||
    ![uploads.verifiedAndDeleted,uploads.alreadyAbsent].every(item => Number.isSafeInteger(item) && item >= 0) ||
    uploads.verifiedAndDeleted + uploads.alreadyAbsent !== sealedUploads.objectCount || uploads.treeAbsent !== true ||
    sealedUploads.expectedLegacyReferences !== inventory.rows.filter(row => row.classification === 'LEGACY_UPLOAD').length) process.exit(1);
NODE
)

avatar_cleanup_require_revocation_evidence() {
	avatar_cleanup_validate_private_file "$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" || return 1
	[[ -d "$AVATAR_RETIREMENT_REVOCATION_ROOT" && ! -L "$AVATAR_RETIREMENT_REVOCATION_ROOT" &&
		"$(avatar_cleanup_stat_identity "$AVATAR_RETIREMENT_REVOCATION_ROOT")" == '0:0:700' ]] || return 1
	local temporary_root attempts_list bundle_lines temporary attempt name key_sha statement signature count=0
	temporary_root="$(mktemp -d "$avatar_cleanup_root/.revocations.XXXXXX")" || return 1
	chmod 700 "$temporary_root" || return 1
	chown 0:0 "$temporary_root" || return 1
	attempts_list="$temporary_root/attempts.list"
	bundle_lines="$temporary_root/bundle.jsonl"
	temporary="$temporary_root/evidence.json"
	trap 'rm -rf -- "$temporary_root"' RETURN
	find "$avatar_cleanup_root" -maxdepth 1 -type f \
		-name 'retirement-credential-attempt-????????????????????????????????????????????????????????????????.json' \
		-print | LC_ALL=C sort >"$attempts_list" || return 1
	while IFS= read -r attempt; do
		[[ -n "$attempt" ]] || continue
		count=$((count + 1))
		[[ "$count" -le 16 ]] || return 1
		name="$(basename -- "$attempt")"
		key_sha="${name#retirement-credential-attempt-}"
		key_sha="${key_sha%.json}"
		[[ "$key_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
		avatar_cleanup_recover_retirement_attempt_signature "$attempt" "$key_sha" || return 1
		avatar_cleanup_verify_artifact "$attempt" || return 1
		statement="$AVATAR_RETIREMENT_REVOCATION_ROOT/$key_sha.json"
		signature="${statement}.sig"
		avatar_cleanup_validate_private_file "$statement" || return 1
		avatar_cleanup_validate_private_file "$signature" || return 1
		avatar_cleanup_verify_timeweb_provider_evidence "$statement" "$signature" \
			"$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" avatar-retirement-credential-revocation || return 1
		ATTEMPT_FILE="$attempt" REVOCATION_FILE="$statement" REVOCATION_SIG="$signature" \
			REVOCATION_KEY="$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" EXPECTED_KEY_SHA="$key_sha" \
			OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" node <<'NODE' >>"$bundle_lines" || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const attempt = JSON.parse(fs.readFileSync(process.env.ATTEMPT_FILE, 'utf8'));
const value = JSON.parse(fs.readFileSync(process.env.REVOCATION_FILE, 'utf8'));
if (!exact(attempt, ['version','action','ownershipRevision','cleanupRevision','inventoryManifestSha256',
			'sealedInventorySha256','retirementPolicyEvidenceSha256','retirementPolicySignatureSha256',
			'storageEndpointSha256','storagePublicBaseUrlSha256','storageRegion','storageBucket','storageForcePathStyle',
			'newPrefix','legacyPrefix','retirementAccessKeyIdSha256','attemptedAt']) || attempt.version !== 1 ||
    attempt.action !== 'avatar-retirement-credential-attempt' ||
    attempt.ownershipRevision !== process.env.OWNERSHIP_REVISION || attempt.cleanupRevision !== process.env.CLEANUP_REVISION ||
    attempt.retirementAccessKeyIdSha256 !== process.env.EXPECTED_KEY_SHA ||
			!/^[0-9a-f]{64}$/.test(attempt.inventoryManifestSha256 || '') ||
			!(attempt.sealedInventorySha256 === 'pending' || /^[0-9a-f]{64}$/.test(attempt.sealedInventorySha256 || '')) ||
			!/^([0-9a-f]{64})$/.test(attempt.retirementPolicyEvidenceSha256 || '') ||
			!/^([0-9a-f]{64})$/.test(attempt.retirementPolicySignatureSha256 || '') ||
			!/^([0-9a-f]{64})$/.test(attempt.storageEndpointSha256 || '') ||
			!/^([0-9a-f]{64})$/.test(attempt.storagePublicBaseUrlSha256 || '') ||
			typeof attempt.storageRegion !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(attempt.storageRegion) ||
			typeof attempt.storageBucket !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/.test(attempt.storageBucket) ||
			typeof attempt.storageForcePathStyle !== 'boolean' ||
			typeof attempt.newPrefix !== 'string' || typeof attempt.legacyPrefix !== 'string' ||
			attempt.newPrefix === attempt.legacyPrefix ||
			!Number.isFinite(Date.parse(attempt.attemptedAt))) process.exit(1);
const expected = ['action','cleanupRevision','ownershipRevision','provider','retirementAccessKeyIdSha256',
  'revokedAt','status','verificationIdSha256','version'];
if (!exact(value, expected) || value.version !== 1 || value.action !== 'avatar-retirement-credential-revocation' ||
    value.status !== 'revoked' || value.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION || value.retirementAccessKeyIdSha256 !== process.env.EXPECTED_KEY_SHA ||
    value.provider !== 'timeweb-s3' ||
    !/^[0-9a-f]{64}$/.test(value.verificationIdSha256 || '') || !Number.isFinite(Date.parse(value.revokedAt)) ||
    Date.parse(value.revokedAt) < Date.parse(attempt.attemptedAt) ||
    Date.parse(value.revokedAt) > Date.now() + 300000) process.exit(1);
process.stdout.write(`${JSON.stringify({ retirementAccessKeyIdSha256: process.env.EXPECTED_KEY_SHA,
  attemptEvidenceSha256: sha(process.env.ATTEMPT_FILE), statementSha256: sha(process.env.REVOCATION_FILE),
  signatureSha256: sha(process.env.REVOCATION_SIG), provider: value.provider,
  verificationIdSha256: value.verificationIdSha256, revokedAt: value.revokedAt })}\n`);
NODE
	done <"$attempts_list"
	[[ "$count" -ge 1 ]] || return 1
	REVOCATION_LINES="$bundle_lines" REVOCATION_KEY="$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" OUTPUT="$temporary" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const attempts = fs.readFileSync(process.env.REVOCATION_LINES, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
if (attempts.length < 1 || attempts.length > 16 ||
    attempts.some((item, index) => index > 0 && item.retirementAccessKeyIdSha256 <= attempts[index - 1].retirementAccessKeyIdSha256)) process.exit(1);
const evidence = { version: 1, action: 'avatar-retirement-revocation-binding',
  ownershipRevision: process.env.OWNERSHIP_REVISION, cleanupRevision: process.env.CLEANUP_REVISION,
  publicKeySha256: sha(process.env.REVOCATION_KEY), attempts, verifiedAt: new Date().toISOString() };
fs.writeFileSync(process.env.OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
NODE
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	avatar_cleanup_fsync_file_and_parent "$temporary" || return 1
	mv -f -- "$temporary" "$avatar_cleanup_revocation" || return 1
	avatar_cleanup_fsync_file_and_parent "$avatar_cleanup_revocation" || return 1
	avatar_cleanup_sign_artifact "$avatar_cleanup_revocation" || return 1
	rm -rf -- "$temporary_root" || return 1
	trap - RETURN
	avatar_cleanup_validate_revocation_evidence
}

avatar_cleanup_validate_revocation_evidence() {
	avatar_cleanup_verify_artifact "$avatar_cleanup_revocation" || return 1
	avatar_cleanup_validate_private_file "$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" || return 1
	[[ -d "$AVATAR_RETIREMENT_REVOCATION_ROOT" && ! -L "$AVATAR_RETIREMENT_REVOCATION_ROOT" &&
		"$(avatar_cleanup_stat_identity "$AVATAR_RETIREMENT_REVOCATION_ROOT")" == '0:0:700' ]] || return 1
	local temporary attempts_list attempt name key_sha statement signature count=0
	temporary="$(mktemp "$avatar_cleanup_root/.revocation-coverage.XXXXXX")" || return 1
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	attempts_list="${temporary}.attempts"
	trap 'rm -f -- "$temporary" "$attempts_list"' RETURN
	find "$avatar_cleanup_root" -maxdepth 1 -type f \
		-name 'retirement-credential-attempt-????????????????????????????????????????????????????????????????.json' \
		-print | LC_ALL=C sort >"$attempts_list" || return 1
	while IFS= read -r attempt; do
		[[ -n "$attempt" ]] || continue
		count=$((count + 1))
		[[ "$count" -le 16 ]] || return 1
		name="$(basename -- "$attempt")"
		key_sha="${name#retirement-credential-attempt-}"
		key_sha="${key_sha%.json}"
		[[ "$key_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
		# Re-evaluate the exact, provider-signed policy for every historical
		# credential attempt. The local HMAC proves attempt immutability, but is
		# not a substitute for the external policy statement it hashes.
		avatar_cleanup_recover_retirement_attempt_signature "$attempt" "$key_sha" || return 1
		statement="$AVATAR_RETIREMENT_REVOCATION_ROOT/$key_sha.json"
		signature="${statement}.sig"
		avatar_cleanup_validate_private_file "$statement" || return 1
		avatar_cleanup_validate_private_file "$signature" || return 1
		avatar_cleanup_verify_timeweb_provider_evidence "$statement" "$signature" \
			"$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" avatar-retirement-credential-revocation || return 1
		printf '%s\t%s\t%s\t%s\n' "$key_sha" "$(avatar_cleanup_sha256 "$attempt")" \
			"$(avatar_cleanup_sha256 "$statement")" "$(avatar_cleanup_sha256 "$signature")" >>"$temporary" || return 1
	done <"$attempts_list"
	[[ "$count" -ge 1 ]] || return 1
	REVOCATION_FILE="$avatar_cleanup_revocation" COVERAGE_FILE="$temporary" \
		PUBLIC_KEY_FILE="$AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE" \
		OWNERSHIP_REVISION="$AVATAR_OWNERSHIP_REVISION" CLEANUP_REVISION="$EXPECTED_REVISION" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const value = JSON.parse(fs.readFileSync(process.env.REVOCATION_FILE, 'utf8'));
const exact = (item, keys) => item && typeof item === 'object' && !Array.isArray(item) &&
  JSON.stringify(Object.keys(item)) === JSON.stringify(keys);
const keys = ['version','action','ownershipRevision','cleanupRevision','publicKeySha256','attempts','verifiedAt'];
const attemptKeys = ['retirementAccessKeyIdSha256','attemptEvidenceSha256','statementSha256','signatureSha256',
  'provider','verificationIdSha256','revokedAt'];
const coverage = fs.readFileSync(process.env.COVERAGE_FILE, 'utf8').trim().split('\n').filter(Boolean)
  .map(line => line.split('\t'));
if (!exact(value, keys) || value.version !== 1 || value.action !== 'avatar-retirement-revocation-binding' ||
    value.ownershipRevision !== process.env.OWNERSHIP_REVISION || value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    value.publicKeySha256 !== crypto.createHash('sha256').update(fs.readFileSync(process.env.PUBLIC_KEY_FILE)).digest('hex') ||
    !Array.isArray(value.attempts) || value.attempts.length !== coverage.length || value.attempts.length < 1 ||
    value.attempts.length > 16 || !Number.isFinite(Date.parse(value.verifiedAt)) ||
    Date.parse(value.verifiedAt) > Date.now() + 300000) process.exit(1);
for (let index = 0; index < value.attempts.length; index += 1) {
  const item = value.attempts[index];
  const row = coverage[index];
  if (!exact(item, attemptKeys) || !row || row.length !== 4 ||
      item.retirementAccessKeyIdSha256 !== row[0] || item.attemptEvidenceSha256 !== row[1] ||
      item.statementSha256 !== row[2] || item.signatureSha256 !== row[3] ||
      (index > 0 && item.retirementAccessKeyIdSha256 <= value.attempts[index - 1].retirementAccessKeyIdSha256) ||
      item.provider !== 'timeweb-s3' ||
      !/^[0-9a-f]{64}$/.test(item.verificationIdSha256 || '') || !Number.isFinite(Date.parse(item.revokedAt)) ||
      Date.parse(item.revokedAt) > Date.now() + 300000 ||
      Date.parse(item.revokedAt) > Date.parse(value.verifiedAt)) process.exit(1);
}
NODE
	rm -f -- "$temporary" "$attempts_list" || return 1
	trap - RETURN
}

avatar_cleanup_assert_public_client_revision() {
	[[ $# -le 1 && "${1:-strict}" =~ ^(strict|forward)$ ]] || return 1
	local runtime_mode="${1:-strict}"
	avatar_cleanup_require_ownership_artifacts || return 1
	local temporary_root release_url status name url output current_binding
	current_binding="$(avatar_cleanup_current_client_binding)" || return 1
	temporary_root="$(mktemp -d "$avatar_cleanup_root/.live-client.XXXXXX")" || return 1
	chmod 700 "$temporary_root" || return 1
	chown 0:0 "$temporary_root" || return 1
	trap 'rm -rf -- "$temporary_root"' RETURN
	release_url="$AVATAR_PUBLIC_ORIGIN/.well-known/winwidget/identity-avatar-client/$AVATAR_CLIENT_REVISION/release-evidence-v1.json"
	for name in root release signature runtime; do
		case "$name" in
		root) url="$AVATAR_PUBLIC_ORIGIN/" ;;
		release) url="$release_url" ;;
		signature) url="${release_url}.sig" ;;
		runtime) url="$AVATAR_PUBLIC_ORIGIN/.well-known/winwidget/identity-avatar-client/runtime-v1.json" ;;
		esac
		output="$temporary_root/$name.body"
		status="$(curl --proto '=https' --tlsv1.2 --silent --show-error --connect-timeout 5 --max-time 30 \
			--dump-header "$temporary_root/$name.headers" --output "$output" --write-out '%{http_code}' "$url")" || return 1
		[[ "$status" == '200' ]] || avatar_cleanup_fail "public frontend $name evidence is not exact 200" || return 1
	done
	CLIENT_ROOT="$temporary_root" CLIENT_REVISION="$AVATAR_CLIENT_REVISION" \
		CURRENT_CLIENT_BINDING="$current_binding" CURRENT_CLIENT_BINDING_SHA="$avatar_cleanup_current_client_binding_sha" \
		FRONTEND_BINDING_SHA="$avatar_cleanup_frontend_binding_sha" \
		CLIENT_PUBLIC_KEY="$IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY" RUNTIME_MODE="$runtime_mode" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const root = process.env.CLIENT_ROOT;
const decode = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { process.exit(1); } };
const release = fs.readFileSync(`${root}/release.body`);
const signatureBytes = fs.readFileSync(`${root}/signature.body`);
const runtimeBytes = fs.readFileSync(`${root}/runtime.body`);
const binding = JSON.parse(process.env.CURRENT_CLIENT_BINDING);
const runtime = JSON.parse(decode(runtimeBytes));
const signatureText = decode(signatureBytes);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const runtimeKeys = ['schemaVersion','kind','clientRevision','processStartedAt','releaseEvidenceSha256',
  'releaseEvidenceSignatureSha256'];
const bindingKeys = ['bindingKind','evidenceSha256','evidenceSignatureSha256','clientRevision','imageId',
  'releaseEvidenceSha256','releaseEvidenceSignatureSha256','releaseTreeSha256',
  'releaseFullManifestSha256','processStartedAt'];
const processStartedAt = Date.parse(runtime.processStartedAt);
if (JSON.stringify(Object.keys(binding)) !== JSON.stringify(bindingKeys) ||
    !['initial-client-switch','client-code-retarget','frontend-runtime-rebind'].includes(binding.bindingKind) ||
    ![binding.evidenceSha256,binding.evidenceSignatureSha256,binding.releaseEvidenceSha256,
      binding.releaseEvidenceSignatureSha256,binding.releaseTreeSha256,binding.releaseFullManifestSha256,
      process.env.CURRENT_CLIENT_BINDING_SHA,process.env.FRONTEND_BINDING_SHA]
      .every(value => /^[0-9a-f]{64}$/.test(value || '')) ||
    binding.clientRevision !== process.env.CLIENT_REVISION || !/^sha256:[0-9a-f]{64}$/.test(binding.imageId || '') ||
    sha(Buffer.from(JSON.stringify(binding))) !== process.env.FRONTEND_BINDING_SHA ||
    JSON.stringify(Object.keys(runtime)) !== JSON.stringify(runtimeKeys) || runtime.schemaVersion !== 1 ||
    runtime.kind !== 'identity-avatar-client-runtime' || runtime.clientRevision !== process.env.CLIENT_REVISION ||
    !Number.isFinite(processStartedAt) || new Date(processStartedAt).toISOString() !== runtime.processStartedAt ||
    processStartedAt > Date.now() + 120000 ||
    runtime.processStartedAt !== binding.processStartedAt ||
    !['strict','forward'].includes(process.env.RUNTIME_MODE) ||
	    runtime.releaseEvidenceSha256 !== binding.releaseEvidenceSha256 ||
	    runtime.releaseEvidenceSignatureSha256 !== binding.releaseEvidenceSignatureSha256 ||
	    sha(release) !== binding.releaseEvidenceSha256 || sha(signatureBytes) !== binding.releaseEvidenceSignatureSha256 ||
    !/^[A-Za-z0-9+/]{86}==\n$/.test(signatureText)) process.exit(1);
const key = crypto.createPublicKey(fs.readFileSync(process.env.CLIENT_PUBLIC_KEY));
if (key.asymmetricKeyType !== 'ed25519' ||
    !crypto.verify(null, release, key, Buffer.from(signatureText.trim(), 'base64'))) process.exit(1);
for (const name of ['root','release','signature','runtime']) {
  const raw = fs.readFileSync(`${root}/${name}.headers`, 'utf8').replace(/\r/g, '');
  const blocks = raw.split('\n\n').filter(block => /^HTTP\//.test(block));
  if (blocks.length !== 1 || !/^HTTP\/\S+ 200(?: |$)/.test(blocks[0].split('\n')[0])) process.exit(1);
  const headers = new Map();
  for (const line of blocks[0].split('\n').slice(1)) {
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 1) process.exit(1);
    const keyName = line.slice(0, at).toLowerCase();
    const values = headers.get(keyName) || [];
    values.push(line.slice(at + 1).trim());
    headers.set(keyName, values);
  }
  if (headers.get('x-winwidget-revision')?.length !== 1 ||
      headers.get('x-winwidget-revision')[0] !== process.env.CLIENT_REVISION ||
      (name !== 'root' && (headers.get('cache-control')?.length !== 1 ||
        !headers.get('cache-control')[0].toLowerCase().split(',').map(item => item.trim()).includes('no-store'))) ||
      (['release','runtime'].includes(name) &&
        (headers.get('content-type')?.length !== 1 ||
          headers.get('content-type')[0].split(';')[0].trim().toLowerCase() !== 'application/json')) ||
      (name === 'signature' && (headers.get('content-type')?.length !== 1 ||
        headers.get('content-type')[0].split(';')[0].trim().toLowerCase() !== 'application/octet-stream'))) process.exit(1);
}
NODE
	rm -rf -- "$temporary_root" || return 1
	trap - RETURN
}

avatar_cleanup_assert_runtime_service() {
	[[ $# -eq 2 ]] || return 1
	local service="$1" evidence_key="$2" expected
	expected="$(RUNTIME_FILE="$avatar_cleanup_runtime" EVIDENCE_KEY="$evidence_key" node <<'NODE'
const value = JSON.parse(require('node:fs').readFileSync(process.env.RUNTIME_FILE, 'utf8'));
const runtime = value.services?.[process.env.EVIDENCE_KEY];
const keys = ['containerId','imageId','ociRevision','startedAt','restartCount','health'];
if (!runtime || JSON.stringify(Object.keys(runtime)) !== JSON.stringify(keys)) process.exit(1);
process.stdout.write(JSON.stringify(runtime));
NODE
)" || return 1
	avatar_cleanup_inspect_service "$service" "$avatar_cleanup_runtime_revision" || return 1
	EXPECTED_RUNTIME="$expected" ACTUAL_CONTAINER="$avatar_cleanup_last_container_id" \
		ACTUAL_IMAGE="$avatar_cleanup_last_image_id" ACTUAL_REVISION="$avatar_cleanup_last_oci_revision" \
		ACTUAL_STARTED_AT="$avatar_cleanup_last_started_at" ACTUAL_RESTART="$avatar_cleanup_last_restart_count" \
		ACTUAL_HEALTH="$avatar_cleanup_last_health" node <<'NODE'
const expected = JSON.parse(process.env.EXPECTED_RUNTIME);
const actual = { containerId: process.env.ACTUAL_CONTAINER, imageId: process.env.ACTUAL_IMAGE,
  ociRevision: process.env.ACTUAL_REVISION, startedAt: process.env.ACTUAL_STARTED_AT,
  restartCount: Number(process.env.ACTUAL_RESTART), health: process.env.ACTUAL_HEALTH };
if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(1);
NODE
}

avatar_cleanup_assert_identity_runtime() {
	avatar_cleanup_assert_runtime_service identity-api identityApi || return 1
	avatar_cleanup_assert_runtime_service identity-worker identityWorker || return 1
	avatar_cleanup_assert_runtime_service identity-outbox-publisher identityOutboxPublisher || return 1
	avatar_cleanup_assert_runtime_service widgets-service widgets || return 1
}

avatar_cleanup_assert_forward_identity_runtime() {
	# No lifecycle generation may be adopted after the timer fence and the
	# irreversible forward-only boundary. Keep every live ownership service on
	# the exact signed container/image/revision/start/restart/health tuple that
	# established runtimeStableSince.
	avatar_cleanup_assert_identity_runtime ||
		avatar_cleanup_fail 'ownership runtime tuple drifted after the forward-only boundary' || return 1
}

avatar_cleanup_assert_post_retirement_core_runtime() {
	[[ "$(avatar_cleanup_marker_value retirement_evidence_sha256)" != 'pending' ]] || return 1
	avatar_cleanup_validate_writer_evidence_payload stopped ||
		avatar_cleanup_fail 'post-retirement recovery requires the exact stopped writer evidence' || return 1
	avatar_cleanup_verify_artifact "$avatar_cleanup_writer_fence" || return 1
	local container expected_image image revision health restart
	container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api 2>/dev/null || true)"
	[[ -z "$container" || "$container" =~ ^[0-9a-f]{64}$ ]] ||
		avatar_cleanup_fail 'post-retirement Core runtime is ambiguous' || return 1
	[[ -n "$container" ]] || return 0
	expected_image="$(avatar_cleanup_marker_value core_cleanup_image_id)"
	image="$(docker inspect --format '{{.Image}}' "$container")" || return 1
	revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" || return 1
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" || return 1
	restart="$(docker inspect --format '{{.RestartCount}}' "$container")" || return 1
	[[ "$image" == "$expected_image" && "$revision" == "$EXPECTED_REVISION" &&
		"$health" == 'healthy' && "$restart" =~ ^(0|[1-9][0-9]*)$ ]] ||
		avatar_cleanup_fail 'post-retirement Core is not the exact healthy cleanup image' || return 1
}

avatar_cleanup_deploy() {
	local phase completion_core_runtime
	avatar_cleanup_require_common
	[[ "$AVATAR_CLEANUP_CONFIRMATION" == "$avatar_cleanup_confirmation" ]] ||
		avatar_cleanup_fail "confirmation must be exactly: $avatar_cleanup_confirmation" || return 1
	acquire_production_deploy_lock 'Avatar Core source cleanup forward-only deployment'
	avatar_cleanup_validate_marker ||
		avatar_cleanup_fail 'run the manual verify action before cleanup deployment' || return 1
	avatar_cleanup_recover_writer_fence_marker || return 1
	avatar_cleanup_require_verified_evidence ||
		avatar_cleanup_fail 'signed cleanup evidence is missing or drifted' || return 1
	if [[ "$(avatar_cleanup_marker_value phase)" == 'complete' ]]; then
		# The durable COMPLETE marker already binds the body/signature produced
		# inside the two-sided runtime fence below. Publication and lifecycle-key
		# retirement recovery consume that historical proof; later healthy process
		# restarts cannot retroactively invalidate it.
		avatar_cleanup_publish_cleanup_complete ||
			avatar_cleanup_fail 'permanent cleanup-complete publication is incomplete' || return 1
		avatar_cleanup_bind_lifecycle_key_retirement ||
			avatar_cleanup_fail 'lifecycle signing key retirement is incomplete' || return 1
		avatar_cleanup_status
		return
	fi
	phase="$(avatar_cleanup_marker_value phase)" || return 1
	case "$phase" in
	verified)
		avatar_cleanup_validate_current_soak_contract >/dev/null ||
			avatar_cleanup_fail 'signed seven-day observation is stale or invalid' || return 1
		avatar_cleanup_assert_public_client_revision strict || return 1
		avatar_cleanup_assert_identity_runtime || return 1
		;;
	forward-only)
		# The immutable observation and timer fence are consumed below. Requiring a
		# still-running evidence timer here would deadlock every crash recovery after Core is stopped.
		avatar_cleanup_assert_public_client_revision forward || return 1
		avatar_cleanup_assert_forward_identity_runtime || return 1
		;;
	*) return 1 ;;
	esac
	if [[ "$(avatar_cleanup_marker_value retirement_evidence_sha256)" == 'pending' ]]; then
		avatar_cleanup_stop_legacy_writer
	else
		avatar_cleanup_assert_post_retirement_core_runtime
	fi

	if [[ "$(avatar_cleanup_marker_value retirement_evidence_sha256)" == 'pending' ]]; then
		if [[ -f "$avatar_cleanup_retirement" && ! -L "$avatar_cleanup_retirement" ]] &&
			avatar_cleanup_require_ownership_artifacts &&
			avatar_cleanup_validate_retirement_evidence; then
			avatar_cleanup_update_forward_marker forward-only \
				"$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
				"$(avatar_cleanup_sha256 "$avatar_cleanup_retirement")" pending \
				"$(avatar_cleanup_marker_value nginx_evidence_sha256)" \
				"$(avatar_cleanup_marker_value smoke_evidence_sha256)" \
				"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" \
				"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)"
		else
			avatar_cleanup_retire_legacy_objects
		fi
	fi
	if [[ "$(avatar_cleanup_marker_value revocation_evidence_sha256)" == 'pending' ]]; then
		if ! avatar_cleanup_require_revocation_evidence; then
			printf 'avatar_core_cleanup_phase=forward-only\n'
			printf 'avatar_core_cleanup_blocker=retirement credential must be externally revoked and signed infra evidence installed\n' >&2
			return 75
		fi
		avatar_cleanup_validate_revocation_evidence || return 1
		avatar_cleanup_update_forward_marker forward-only \
			"$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
			"$(avatar_cleanup_marker_value retirement_evidence_sha256)" \
			"$(avatar_cleanup_sha256 "$avatar_cleanup_revocation")" \
			"$(avatar_cleanup_marker_value nginx_evidence_sha256)" \
			"$(avatar_cleanup_marker_value smoke_evidence_sha256)" \
			"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" \
			"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)"
	fi
	[[ ! -e "$AVATAR_RETIREMENT_CREDENTIAL_FILE" && ! -L "$AVATAR_RETIREMENT_CREDENTIAL_FILE" ]] ||
		avatar_cleanup_fail 'one-use retirement credential file unexpectedly remains' || return 1
	avatar_cleanup_start_clean_core

	if [[ "$(avatar_cleanup_marker_value nginx_evidence_sha256)" == 'pending' ]]; then
		avatar_cleanup_install_nginx
		avatar_cleanup_update_forward_marker forward-only \
			"$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
			"$(avatar_cleanup_marker_value retirement_evidence_sha256)" \
			"$(avatar_cleanup_marker_value revocation_evidence_sha256)" \
			"$(avatar_cleanup_sha256 "$avatar_cleanup_nginx")" \
			"$(avatar_cleanup_marker_value smoke_evidence_sha256)" \
			"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" \
			"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)"
	fi
	if [[ "$(avatar_cleanup_marker_value smoke_evidence_sha256)" == 'pending' ]]; then
		avatar_cleanup_capture_smokes
		avatar_cleanup_update_forward_marker forward-only \
			"$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
			"$(avatar_cleanup_marker_value retirement_evidence_sha256)" \
			"$(avatar_cleanup_marker_value revocation_evidence_sha256)" \
			"$(avatar_cleanup_marker_value nginx_evidence_sha256)" \
			"$(avatar_cleanup_sha256 "$avatar_cleanup_smoke")" \
			"$(avatar_cleanup_marker_value cleanup_complete_evidence_sha256)" \
			"$(avatar_cleanup_marker_value cleanup_complete_signature_sha256)"
	fi

	completion_core_runtime="$(avatar_cleanup_smoke_core_runtime)" || return 1
	avatar_cleanup_assert_completion_runtime_fence "$completion_core_runtime" ||
		avatar_cleanup_fail 'final runtime fence failed before cleanup-complete signing' || return 1
	avatar_cleanup_create_cleanup_complete_evidence || return 1
	avatar_cleanup_assert_completion_runtime_fence "$completion_core_runtime" ||
		avatar_cleanup_fail 'final runtime fence drifted while cleanup-complete was signed' || return 1
	avatar_cleanup_update_forward_marker complete \
		"$(avatar_cleanup_marker_value writer_fence_evidence_sha256)" \
		"$(avatar_cleanup_marker_value retirement_evidence_sha256)" \
		"$(avatar_cleanup_marker_value revocation_evidence_sha256)" \
		"$(avatar_cleanup_marker_value nginx_evidence_sha256)" \
		"$(avatar_cleanup_marker_value smoke_evidence_sha256)" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_complete_body")" \
		"$(avatar_cleanup_sha256 "$avatar_cleanup_complete_signature")"
	avatar_cleanup_publish_cleanup_complete ||
		avatar_cleanup_fail 'cleanup is complete locally; rerun forward-recovery to finish permanent publication' || return 1
	avatar_cleanup_bind_lifecycle_key_retirement ||
		avatar_cleanup_fail 'cleanup is public; rerun forward-recovery to finish lifecycle signing key retirement' || return 1
	printf 'avatar_core_cleanup_phase=complete\n'
}

avatar_cleanup_status() {
	if [[ ! -e "$avatar_cleanup_marker" && ! -L "$avatar_cleanup_marker" ]]; then
		printf 'avatar_core_cleanup_phase=absent\n'
		return
	fi
	avatar_cleanup_validate_marker ||
		avatar_cleanup_fail 'avatar cleanup marker is invalid' || return 1
	if [[ -z "$EXPECTED_REVISION" ]]; then
		EXPECTED_REVISION="$(avatar_cleanup_marker_value cleanup_revision)"
	fi
	if [[ -z "$AVATAR_OWNERSHIP_REVISION" ]]; then
		AVATAR_OWNERSHIP_REVISION="$(avatar_cleanup_marker_value ownership_revision)"
	fi
	if [[ -z "$AVATAR_CLIENT_REVISION" ]]; then
		AVATAR_CLIENT_REVISION="$(avatar_cleanup_marker_value current_client_revision)"
	fi
	# A completed marker is not permission to reintroduce any removed Core
	# source, dependency, storage credential, filesystem or route contract.
	# This check intentionally accepts a later descendant checkout; the routine
	# deploy guard separately proves ancestry from the marker-bound SHA-B.
	avatar_cleanup_validate_clean_source_tree ||
		avatar_cleanup_fail 'legacy Core file source/runtime contract was reintroduced' || return 1
	avatar_cleanup_require_verified_evidence ||
		avatar_cleanup_fail 'avatar cleanup evidence is invalid' || return 1
	if [[ "$(avatar_cleanup_marker_value phase)" == 'complete' ]]; then
		[[ "$(avatar_cleanup_marker_value lifecycle_key_retirement_evidence_sha256)" != 'pending' ]] ||
			avatar_cleanup_fail 'lifecycle signing key retirement is not bound' || return 1
		avatar_cleanup_validate_lifecycle_key_retirement_evidence ||
			avatar_cleanup_fail 'lifecycle signing key retirement evidence is invalid' || return 1
		[[ ! -e "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" && ! -L "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY" ]] ||
			avatar_cleanup_fail 'retired lifecycle signing private key is still present' || return 1
		avatar_cleanup_verify_public_cleanup_complete ||
			avatar_cleanup_fail 'permanent cleanup-complete attestation is not live' || return 1
		avatar_cleanup_verify_temporary_routes_absent ||
			avatar_cleanup_fail 'temporary lifecycle attestations are still public' || return 1
	fi
	printf 'avatar_core_cleanup_phase=%s\n' "$(avatar_cleanup_marker_value phase)"
	printf 'avatar_core_cleanup_revision=%s\n' "$(avatar_cleanup_marker_value cleanup_revision)"
	printf 'avatar_core_cleanup_ownership_revision=%s\n' "$(avatar_cleanup_marker_value ownership_revision)"
	printf 'avatar_core_cleanup_initial_client_revision=%s\n' "$(avatar_cleanup_marker_value initial_client_revision)"
	printf 'avatar_core_cleanup_current_client_revision=%s\n' "$(avatar_cleanup_marker_value current_client_revision)"
}

avatar_cleanup_self_test() {
	local owner='1111111111111111111111111111111111111111'
	local cleanup='2222222222222222222222222222222222222222'
	local client='3333333333333333333333333333333333333333'
	local image='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	local hash='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	AVATAR_OWNERSHIP_REVISION="$owner"
	AVATAR_CLIENT_REVISION="$client"
	avatar_cleanup_ownership_marker_sha="$hash"
	avatar_cleanup_runtime_revision="$owner"
	avatar_cleanup_initial_client_revision="$client"
	avatar_cleanup_current_client_revision="$client"
	avatar_cleanup_identity_database_id='11111111-1111-4111-8111-111111111111'
	avatar_cleanup_runtime_stability_generation='0'
	avatar_cleanup_runtime_stability_evidence_sha="$hash"
	avatar_cleanup_runtime_stability_ledger_generation='0'
	avatar_cleanup_runtime_stability_ledger_state='applied'
	avatar_cleanup_runtime_stability_ledger_sha="$hash"
	avatar_cleanup_runtime_stability_current_sha="$hash"
	avatar_cleanup_runtime_stability_current_signature_sha="$hash"
	avatar_cleanup_current_client_binding_sha="$hash"
	avatar_cleanup_frontend_binding_sha="$hash"
	avatar_cleanup_runtime_stable_since='2026-08-08T00:00:00Z'
	(
		local temporary artifact sealed source_json ownership_marker ownership_public_key
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-self-test.XXXXXX")"
		chmod 700 "$temporary"
		trap 'rm -rf -- "$temporary"' EXIT
		avatar_cleanup_marker="$temporary/marker"
		avatar_cleanup_signing_key="$temporary/signing-key"
		avatar_cleanup_root="$temporary/artifacts"
		mkdir -m 700 "$avatar_cleanup_root"
		if [[ "$(id -u)" != '0' ]]; then chown() { :; }; fi
		avatar_cleanup_create_signing_key
		avatar_cleanup_write_marker verified "$owner" "$cleanup" "$client" \
			"$image" "$image" "$image" "$image" "$image" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" \
			pending pending pending pending pending pending pending pending '2026-08-15T00:00:00Z'
		avatar_cleanup_validate_marker
		[[ "$(avatar_cleanup_marker_value phase)" == 'verified' ]]
		! avatar_cleanup_write_marker complete "$owner" "$cleanup" "$client" \
			"$image" "$image" "$image" "$image" "$image" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" '2026-08-15T00:00:01Z'
		avatar_cleanup_write_marker forward-only "$owner" "$cleanup" "$client" \
			"$image" "$image" "$image" "$image" "$image" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" pending pending pending pending pending pending pending '2026-08-15T00:00:02Z'
		avatar_cleanup_write_marker complete "$owner" "$cleanup" "$client" \
			"$image" "$image" "$image" "$image" "$image" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" '2026-08-15T00:00:03Z'
		avatar_cleanup_validate_marker
		printf 'tamper\n' >>"$avatar_cleanup_marker"
		! avatar_cleanup_validate_marker
		avatar_cleanup_marker="$temporary/aborted-marker"
		avatar_cleanup_runtime_stability_ledger_generation='1'
		avatar_cleanup_runtime_stability_ledger_state='aborted'
		avatar_cleanup_runtime_stability_ledger_sha='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
		avatar_cleanup_write_marker verified "$owner" "$cleanup" "$client" \
			"$image" "$image" "$image" "$image" "$image" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" \
			pending pending pending pending pending pending pending pending '2026-08-15T00:00:04Z'
		avatar_cleanup_validate_marker
		avatar_cleanup_marker="$temporary/impossible-aborted-marker"
		avatar_cleanup_runtime_stability_ledger_sha="$hash"
		! avatar_cleanup_write_marker verified "$owner" "$cleanup" "$client" \
			"$image" "$image" "$image" "$image" "$image" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" \
			pending pending pending pending pending pending pending pending '2026-08-15T00:00:05Z'
		artifact="$temporary/artifact.json"
		source_json="$temporary/source.json"
		printf '{"version":1,"ok":true}\n' >"$source_json"
		chmod 600 "$source_json"
		avatar_cleanup_write_json_artifact "$artifact" "$source_json"
		avatar_cleanup_verify_artifact "$artifact"
		printf 'drift\n' >>"$artifact"
		! avatar_cleanup_verify_artifact "$artifact"
		sealed="$temporary/sealed.json"
		avatar_cleanup_seal_json_artifact "$source_json" "$sealed"
		avatar_cleanup_verify_embedded_hmac_json "$sealed"
		SEALED_FILE="$sealed" node -e '
const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.env.SEALED_FILE,"utf8"));
value.ok=false;fs.writeFileSync(process.env.SEALED_FILE,`${JSON.stringify(value)}\n`);'
		! avatar_cleanup_verify_embedded_hmac_json "$sealed"
		ownership_marker="$temporary/ownership-marker"
		ownership_public_key="$temporary/ownership-public.pem"
		OWNERSHIP_MARKER="$ownership_marker" OWNERSHIP_PUBLIC_KEY="$ownership_public_key" \
			OWNER_REVISION="$owner" CLIENT_REVISION="$client" EVIDENCE_SHA="$hash" node <<'NODE'
const fs = require('node:fs');
const { generateKeyPairSync, sign } = require('node:crypto');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const payload = [
	  'version=3', 'phase=soak-complete', `server_revision=${process.env.OWNER_REVISION}`,
	  `runtime_revision=${process.env.OWNER_REVISION}`, `client_revision=${process.env.CLIENT_REVISION}`,
	  `current_client_revision=${process.env.CLIENT_REVISION}`,
  'runtime_stability_generation=0',
  `runtime_stability_evidence_sha256=${process.env.EVIDENCE_SHA}`,
  `writer_fence_evidence_sha256=${process.env.EVIDENCE_SHA}`,
  `storage_policy_evidence_sha256=${process.env.EVIDENCE_SHA}`,
  `uploads_snapshot_evidence_sha256=${process.env.EVIDENCE_SHA}`,
  `inventory_manifest_sha256=${process.env.EVIDENCE_SHA}`,
  `migration_manifest_sha256=${process.env.EVIDENCE_SHA}`,
  `status_manifest_sha256=${process.env.EVIDENCE_SHA}`,
  `revocation_evidence_sha256=${process.env.EVIDENCE_SHA}`,
  `authenticated_smoke_evidence_sha256=${process.env.EVIDENCE_SHA}`,
	  `client_evidence_sha256=${process.env.EVIDENCE_SHA}`,
	  `soak_evidence_sha256=${process.env.EVIDENCE_SHA}`,
	  'runtime_retarget_evidence_sha256=pending', 'client_retarget_evidence_sha256=pending',
	  `cleanup_retarget_evidence_sha256=${process.env.EVIDENCE_SHA}`,
  'migration_ready_at=2026-08-01T00:00:00Z', 'migrated_at=2026-08-01T00:01:00Z',
  'client_switched_at=2026-08-01T00:02:00Z', 'soak_verified_at=2026-08-08T00:02:00Z',
  'updated_at=2026-08-08T00:02:01Z',
].join('\n') + '\n';
const signature = sign(null, Buffer.from(payload), privateKey).toString('base64');
fs.writeFileSync(process.env.OWNERSHIP_MARKER, `${payload}signature=${signature}\n`, { mode: 0o600 });
fs.writeFileSync(process.env.OWNERSHIP_PUBLIC_KEY,
  publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
NODE
		chmod 600 "$ownership_marker" "$ownership_public_key"
		AVATAR_OWNERSHIP_REVISION="$owner"
		AVATAR_CLIENT_REVISION="$client"
		IDENTITY_AVATAR_MARKER="$ownership_marker" \
			IDENTITY_AVATAR_SIGNING_PUBLIC_KEY="$ownership_public_key" \
			avatar_cleanup_validate_ownership_marker
		printf 'tamper\n' >>"$ownership_marker"
		! IDENTITY_AVATAR_MARKER="$ownership_marker" \
			IDENTITY_AVATAR_SIGNING_PUBLIC_KEY="$ownership_public_key" \
			avatar_cleanup_validate_ownership_marker
	)
	(
		local frontend_binding current_binding
		frontend_binding="$(HASH="$hash" CLIENT="$client" IMAGE="$image" node -e '
const value={bindingKind:"frontend-runtime-rebind",evidenceSha256:process.env.HASH,
evidenceSignatureSha256:process.env.HASH,clientRevision:process.env.CLIENT,imageId:process.env.IMAGE,
releaseEvidenceSha256:process.env.HASH,releaseEvidenceSignatureSha256:process.env.HASH,
releaseTreeSha256:process.env.HASH,releaseFullManifestSha256:process.env.HASH,
processStartedAt:"2026-08-15T00:00:00.000Z"};process.stdout.write(JSON.stringify(value));')"
		avatar_cleanup_require_ownership_artifacts() { :; }
		avatar_cleanup_frontend_binding="$frontend_binding"
		current_binding="$(avatar_cleanup_current_client_binding)" || return 1
		CURRENT_BINDING="$current_binding" node <<'NODE'
const value=JSON.parse(process.env.CURRENT_BINDING);
const keys=['bindingKind','evidenceSha256','evidenceSignatureSha256','clientRevision','imageId',
  'releaseEvidenceSha256','releaseEvidenceSignatureSha256','releaseTreeSha256',
  'releaseFullManifestSha256','processStartedAt'];
if(JSON.stringify(Object.keys(value))!==JSON.stringify(keys)||value.bindingKind!=='frontend-runtime-rebind')process.exit(1);
NODE
	)
	(
		local temporary drift='none'
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-runtime-fence-self-test.XXXXXX")"
		trap 'rm -rf -- "$temporary"' EXIT
		avatar_cleanup_runtime="$temporary/runtime.json"
		avatar_cleanup_runtime_revision="$owner"
		RUNTIME_FILE="$avatar_cleanup_runtime" OWNER="$owner" IMAGE="$image" node <<'NODE'
const fs=require('node:fs');
const runtime=(container,started)=>({containerId:container.repeat(64),imageId:process.env.IMAGE,
  ociRevision:process.env.OWNER,startedAt:started,restartCount:0,health:'healthy'});
const value={services:{identityApi:runtime('1','2026-08-15T00:00:00.000Z'),
  identityWorker:runtime('2','2026-08-15T00:00:01.000Z'),
  identityOutboxPublisher:runtime('3','2026-08-15T00:00:02.000Z'),
  widgets:runtime('4','2026-08-15T00:00:03.000Z')}};
fs.writeFileSync(process.env.RUNTIME_FILE,JSON.stringify(value));
NODE
		avatar_cleanup_inspect_service() {
			local evidence_key
			case "$1" in
			identity-api) evidence_key='identityApi' ;;
			identity-worker) evidence_key='identityWorker' ;;
			identity-outbox-publisher) evidence_key='identityOutboxPublisher' ;;
			widgets-service) evidence_key='widgets' ;;
			*) return 1 ;;
			esac
			local fields
			fields="$(RUNTIME_FILE="$avatar_cleanup_runtime" EVIDENCE_KEY="$evidence_key" node -e '
const value=JSON.parse(require("node:fs").readFileSync(process.env.RUNTIME_FILE,"utf8")).services[process.env.EVIDENCE_KEY];
process.stdout.write([value.containerId,value.imageId,value.ociRevision,value.startedAt,value.restartCount,value.health].join("\t"));')" || return 1
			IFS=$'\t' read -r avatar_cleanup_last_container_id avatar_cleanup_last_image_id \
				avatar_cleanup_last_oci_revision avatar_cleanup_last_started_at \
				avatar_cleanup_last_restart_count avatar_cleanup_last_health <<<"$fields"
			if [[ "$drift" == 'restart' && "$1" == 'identity-worker' ]]; then
				avatar_cleanup_last_restart_count='1'
			elif [[ "$drift" == 'container' && "$1" == 'widgets-service' ]]; then
				avatar_cleanup_last_container_id='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
			fi
		}
		avatar_cleanup_assert_forward_identity_runtime
		drift='restart'
		! avatar_cleanup_assert_forward_identity_runtime 2>/dev/null
		drift='container'
		! avatar_cleanup_assert_forward_identity_runtime 2>/dev/null
	)
	(
		local expected_core current_core
		expected_core="$(OWNER="$cleanup" IMAGE="$image" node -e '
process.stdout.write(JSON.stringify({containerId:"5".repeat(64),imageId:process.env.IMAGE,
  ociRevision:process.env.OWNER,startedAt:"2026-08-15T00:00:04.000Z",restartCount:0,health:"healthy"}));')"
		current_core="$expected_core"
		avatar_cleanup_assert_public_client_revision() { :; }
		avatar_cleanup_assert_forward_identity_runtime() { :; }
		avatar_cleanup_capture_clean_core_runtime() { printf '%s' "$current_core"; }
		avatar_cleanup_assert_completion_runtime_fence "$expected_core"
		current_core="$(OWNER="$cleanup" IMAGE="$image" node -e '
process.stdout.write(JSON.stringify({containerId:"6".repeat(64),imageId:process.env.IMAGE,
  ociRevision:process.env.OWNER,startedAt:"2026-08-15T00:00:05.000Z",restartCount:1,health:"healthy"}));')"
		! avatar_cleanup_assert_completion_runtime_fence "$expected_core" 2>/dev/null
	)
	(
		local marker_valid='true' frozen_pair_valid='true' recovery_log=''
		AVATAR_CLEANUP_CONFIRMATION="$avatar_cleanup_confirmation"
		avatar_cleanup_require_common() { :; }
		acquire_production_deploy_lock() { :; }
		avatar_cleanup_validate_marker() { [[ "$marker_valid" == 'true' ]]; }
		avatar_cleanup_recover_writer_fence_marker() { :; }
		avatar_cleanup_require_verified_evidence() { [[ "$frozen_pair_valid" == 'true' ]]; }
		avatar_cleanup_marker_value() {
			case "$1" in
			phase) printf 'complete\n' ;;
			*) printf '%s\n' "$hash" ;;
			esac
		}
		avatar_cleanup_assert_completion_runtime_fence() { return 1; }
		avatar_cleanup_publish_cleanup_complete() { recovery_log+='publish '; }
		avatar_cleanup_bind_lifecycle_key_retirement() { recovery_log+='retire '; }
		avatar_cleanup_status() { recovery_log+='status'; }
		avatar_cleanup_fail() { return 1; }
		avatar_cleanup_deploy
		[[ "$recovery_log" == 'publish retire status' ]]
		recovery_log=''
		marker_valid='false'
		! avatar_cleanup_deploy >/dev/null 2>&1
		[[ -z "$recovery_log" ]]
		marker_valid='true'
		frozen_pair_valid='false'
		! avatar_cleanup_deploy >/dev/null 2>&1
		[[ -z "$recovery_log" ]]
	)
	(
		local temporary private_key public_key valid_policy invalid_policy valid_revocation invalid_revocation fixture
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-retirement-provider-self-test.XXXXXX")"
		chmod 700 "$temporary"
		trap 'rm -rf -- "$temporary"' EXIT
		private_key="$temporary/private.pem"
		public_key="$temporary/public.pem"
		valid_policy="$temporary/policy-valid.json"
		invalid_policy="$temporary/policy-invalid-provider.json"
		valid_revocation="$temporary/revocation-valid.json"
		invalid_revocation="$temporary/revocation-invalid-provider.json"
		openssl genpkey -algorithm ED25519 -out "$private_key" >/dev/null 2>&1
		openssl pkey -in "$private_key" -pubout -out "$public_key" >/dev/null 2>&1
		PROVIDER_FIXTURE_ROOT="$temporary" node <<'NODE'
const fs = require('node:fs');
for (const [name, action, provider] of [
  ['policy-valid.json', 'avatar-retirement-credential-policy', 'timeweb-s3'],
  ['policy-invalid-provider.json', 'avatar-retirement-credential-policy', 'other-s3'],
  ['revocation-valid.json', 'avatar-retirement-credential-revocation', 'timeweb-s3'],
  ['revocation-invalid-provider.json', 'avatar-retirement-credential-revocation', 'other-s3'],
]) fs.writeFileSync(`${process.env.PROVIDER_FIXTURE_ROOT}/${name}`, `${JSON.stringify({ action, provider })}\n`, { mode: 0o600 });
NODE
		for fixture in "$valid_policy" "$invalid_policy" "$valid_revocation" "$invalid_revocation"; do
			openssl pkeyutl -sign -inkey "$private_key" -rawin -in "$fixture" \
				-out "${fixture}.sig" >/dev/null 2>&1
		done
		avatar_cleanup_verify_timeweb_provider_evidence "$valid_policy" "${valid_policy}.sig" \
			"$public_key" avatar-retirement-credential-policy
		! avatar_cleanup_verify_timeweb_provider_evidence "$invalid_policy" "${invalid_policy}.sig" \
			"$public_key" avatar-retirement-credential-policy
		avatar_cleanup_verify_timeweb_provider_evidence "$valid_revocation" "${valid_revocation}.sig" \
			"$public_key" avatar-retirement-credential-revocation
		! avatar_cleanup_verify_timeweb_provider_evidence "$invalid_revocation" "${invalid_revocation}.sig" \
			"$public_key" avatar-retirement-credential-revocation
	)
	(
		local temporary provider_root private_key public_key policy policy_signature policy_backup policy_signature_backup
		local attempt revocation revocation_signature revocation_backup revocation_signature_backup aggregate_backup
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-retirement-validator-self-test.XXXXXX")" || return 1
		chmod 700 "$temporary" || return 1
		trap "rm -rf -- '$temporary'" EXIT
		provider_root="$temporary/provider"
		private_key="$temporary/private.pem"
		public_key="$temporary/public.pem"
		mkdir -m 700 "$temporary/artifacts" "$provider_root" || return 1
		avatar_cleanup_root="$temporary/artifacts"
		avatar_cleanup_signing_key="$temporary/cleanup-hmac-key"
		avatar_cleanup_inventory_manifest="$avatar_cleanup_root/inventory.json"
		avatar_cleanup_retirement_inventory="$avatar_cleanup_root/sealed.json"
		avatar_cleanup_revocation="$avatar_cleanup_root/revocation-binding.json"
		AVATAR_RETIREMENT_REVOCATION_ROOT="$provider_root"
		AVATAR_RETIREMENT_INFRA_PUBLIC_KEY_FILE="$public_key"
		AVATAR_OWNERSHIP_REVISION="$owner"
		EXPECTED_REVISION="$cleanup"
		avatar_cleanup_retirement_access_key_sha='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
		AVATAR_AUDIT_ENDPOINT='https://storage.invalid'
		AVATAR_AUDIT_REGION='ru-1'
		AVATAR_AUDIT_BUCKET='avatar-retirement-test'
		AVATAR_AUDIT_FORCE_PATH_STYLE='false'
		AVATAR_AUDIT_PUBLIC_BASE_URL='https://cdn.invalid'
		AVATAR_AUDIT_KEY_PREFIX='identity/avatars'
		AVATAR_AUDIT_LEGACY_KEY_PREFIX='user-avatar'
		if [[ "$(id -u)" != '0' ]]; then chown() { :; }; fi
		avatar_cleanup_stat_identity() {
			if [[ -d "$1" ]]; then printf '0:0:700\n'; else printf '%s:%s:600\n' "$(id -u)" "$(id -g)"; fi
		}
		avatar_cleanup_load_storage_environment() { :; }
		KEY_PRIVATE="$private_key" KEY_PUBLIC="$public_key" node <<'NODE' || return 1
const fs=require('node:fs');const crypto=require('node:crypto');const pair=crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(process.env.KEY_PRIVATE,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
fs.writeFileSync(process.env.KEY_PUBLIC,pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o600,flag:'wx'});
NODE
		printf '{"rows":[]}\n' >"$avatar_cleanup_inventory_manifest"
		chmod 600 "$avatar_cleanup_inventory_manifest" "$public_key" "$private_key" || return 1
		avatar_cleanup_create_signing_key || return 1
		policy="$provider_root/$avatar_cleanup_retirement_access_key_sha.policy.json"
		policy_signature="${policy}.sig"
		write_policy_fixture() {
			POLICY_FILE="$policy" MODE="$1" EXPECTED_ACCESS="$avatar_cleanup_retirement_access_key_sha" \
				OWNER="$owner" CLEANUP="$cleanup" ENDPOINT="$AVATAR_AUDIT_ENDPOINT" \
				PUBLIC_BASE="$AVATAR_AUDIT_PUBLIC_BASE_URL" REGION="$AVATAR_AUDIT_REGION" \
				BUCKET="$AVATAR_AUDIT_BUCKET" NEW_PREFIX="$AVATAR_AUDIT_KEY_PREFIX" \
				LEGACY_PREFIX="$AVATAR_AUDIT_LEGACY_KEY_PREFIX" HASH="$hash" node <<'NODE' || return 1
const fs=require('node:fs');const crypto=require('node:crypto');const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const mode=process.env.MODE;const issued=new Date(Date.now()-60000).toISOString();const expires=new Date(Date.now()+3600000).toISOString();
const value={version:1,action:'avatar-retirement-credential-policy',provider:mode==='other'?'other-s3':'timeweb-s3',
 ownershipRevision:process.env.OWNER,cleanupRevision:process.env.CLEANUP,
 retirementAccessKeyIdSha256:mode==='mismatch'?'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee':process.env.EXPECTED_ACCESS,
 endpointSha256:sha(process.env.ENDPOINT),publicBaseUrlSha256:sha(process.env.PUBLIC_BASE),region:process.env.REGION,
 bucket:process.env.BUCKET,forcePathStyle:false,newPrefix:process.env.NEW_PREFIX,legacyPrefix:process.env.LEGACY_PREFIX,
 allowedBucketActions:['s3:GetBucketVersioning','s3:ListBucket','s3:ListBucketVersions'],
 allowedObjectActions:['s3:GetObject','s3:GetObjectVersion','s3:DeleteObject','s3:DeleteObjectVersion'],deniedActions:['s3:PutObject'],
 scopeExact:true,newPrefixDenied:true,outsideLegacyPrefixDenied:true,otherBucketsDenied:true,
 exactLegacyPrefixConditionSha256:process.env.HASH,policyDocumentSha256:process.env.HASH,temporary:true,
 issuedAt:issued,expiresAt:expires,verificationIdSha256:process.env.HASH};
fs.writeFileSync(process.env.POLICY_FILE,JSON.stringify(value)+'\n',{mode:0o600});
NODE
			openssl pkeyutl -sign -inkey "$private_key" -rawin -in "$policy" \
				-out "$policy_signature" >/dev/null 2>&1 || return 1
			chmod 600 "$policy" "$policy_signature" || return 1
		}
		write_policy_fixture valid || return 1
		policy_backup="$temporary/policy.valid"
		policy_signature_backup="$temporary/policy.valid.sig"
		cp "$policy" "$policy_backup" || return 1
		cp "$policy_signature" "$policy_signature_backup" || return 1
		avatar_cleanup_require_retirement_policy_evidence active || return 1
		write_policy_fixture other || return 1
		if avatar_cleanup_require_retirement_policy_evidence active; then return 1; fi
		cp "$policy_backup" "$policy" || return 1
		cp "$policy_signature_backup" "$policy_signature" || return 1
		printf 'tamper\n' >>"$policy"
		if avatar_cleanup_require_retirement_policy_evidence active; then return 1; fi
		write_policy_fixture mismatch || return 1
		if avatar_cleanup_require_retirement_policy_evidence active; then return 1; fi
		cp "$policy_backup" "$policy" || return 1
		cp "$policy_signature_backup" "$policy_signature" || return 1
		chmod 600 "$policy" "$policy_signature" || return 1
		avatar_cleanup_require_retirement_policy_evidence active || return 1
		avatar_cleanup_record_retirement_attempt pending || return 1
		attempt="$avatar_cleanup_retirement_attempt"
		revocation="$provider_root/$avatar_cleanup_retirement_access_key_sha.json"
		revocation_signature="${revocation}.sig"
		write_revocation_fixture() {
			REVOCATION_FILE="$revocation" ATTEMPT_FILE="$attempt" MODE="$1" \
				EXPECTED_ACCESS="$avatar_cleanup_retirement_access_key_sha" OWNER="$owner" CLEANUP="$cleanup" HASH="$hash" node <<'NODE' || return 1
const fs=require('node:fs');const attempt=JSON.parse(fs.readFileSync(process.env.ATTEMPT_FILE,'utf8'));const mode=process.env.MODE;
const value={version:1,action:'avatar-retirement-credential-revocation',provider:mode==='other'?'other-s3':'timeweb-s3',
 ownershipRevision:process.env.OWNER,cleanupRevision:process.env.CLEANUP,
 retirementAccessKeyIdSha256:mode==='mismatch'?'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee':process.env.EXPECTED_ACCESS,
 revokedAt:new Date(Math.max(Date.now(),Date.parse(attempt.attemptedAt)+1)).toISOString(),status:'revoked',verificationIdSha256:process.env.HASH};
fs.writeFileSync(process.env.REVOCATION_FILE,JSON.stringify(value)+'\n',{mode:0o600});
NODE
			openssl pkeyutl -sign -inkey "$private_key" -rawin -in "$revocation" \
				-out "$revocation_signature" >/dev/null 2>&1 || return 1
			chmod 600 "$revocation" "$revocation_signature" || return 1
		}
		write_revocation_fixture valid || return 1
		revocation_backup="$temporary/revocation.valid"
		revocation_signature_backup="$temporary/revocation.valid.sig"
		cp "$revocation" "$revocation_backup" || return 1
		cp "$revocation_signature" "$revocation_signature_backup" || return 1
		write_revocation_fixture other || return 1
		if avatar_cleanup_require_revocation_evidence; then return 1; fi
		cp "$revocation_backup" "$revocation" || return 1
		cp "$revocation_signature_backup" "$revocation_signature" || return 1
		printf 'tamper\n' >>"$revocation_signature"
		if avatar_cleanup_require_revocation_evidence; then return 1; fi
		write_revocation_fixture mismatch || return 1
		if avatar_cleanup_require_revocation_evidence; then return 1; fi
		cp "$revocation_backup" "$revocation" || return 1
		cp "$revocation_signature_backup" "$revocation_signature" || return 1
		chmod 600 "$revocation" "$revocation_signature" || return 1
		avatar_cleanup_require_revocation_evidence || return 1
		avatar_cleanup_validate_revocation_evidence || return 1
		aggregate_backup="$temporary/aggregate.valid"
		cp "$avatar_cleanup_revocation" "$aggregate_backup" || return 1
		cp "${avatar_cleanup_revocation}.hmac-sha256" "${aggregate_backup}.hmac-sha256" || return 1
		restore_aggregate_fixture() {
			cp "$aggregate_backup" "$avatar_cleanup_revocation" || return 1
			cp "${aggregate_backup}.hmac-sha256" "${avatar_cleanup_revocation}.hmac-sha256" || return 1
			chmod 600 "$avatar_cleanup_revocation" "${avatar_cleanup_revocation}.hmac-sha256" || return 1
		}
		mutate_aggregate_fixture() {
			AGGREGATE_FILE="$avatar_cleanup_revocation" MODE="$1" HASH="$hash" node <<'NODE' || return 1
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.AGGREGATE_FILE,'utf8'));
if(process.env.MODE==='other')value.attempts[0].provider='other-s3';
else value.attempts[0].statementSha256=process.env.HASH;
fs.writeFileSync(process.env.AGGREGATE_FILE,JSON.stringify(value)+'\n',{mode:0o600});
NODE
			rm -f -- "${avatar_cleanup_revocation}.hmac-sha256" || return 1
			avatar_cleanup_sign_artifact "$avatar_cleanup_revocation" || return 1
		}
		restore_aggregate_fixture || return 1
		mutate_aggregate_fixture other || return 1
		if avatar_cleanup_validate_revocation_evidence; then return 1; fi
		restore_aggregate_fixture || return 1
		printf 'tamper\n' >>"$avatar_cleanup_revocation"
		if avatar_cleanup_validate_revocation_evidence; then return 1; fi
		restore_aggregate_fixture || return 1
		mutate_aggregate_fixture mismatch || return 1
		if avatar_cleanup_validate_revocation_evidence; then return 1; fi
		restore_aggregate_fixture || return 1
		avatar_cleanup_validate_revocation_evidence || return 1
	)
	(
		local temporary capture_root credential_file preload image_b image_label_mode operation runtime_sha
		local recovery_file absent_binding
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-retirement-channel-self-test.XXXXXX")" || return 1
		chmod 700 "$temporary" || return 1
		trap 'rm -rf -- "$temporary"' EXIT
		capture_root="$temporary/capture"
		credential_file="$temporary/avatar-retirement-credential-v1"
		preload="$temporary/container-preload.cjs"
		mkdir -m 700 "$capture_root" "$temporary/artifacts" || return 1
		AVATAR_RETIREMENT_CREDENTIAL_FILE="$credential_file"
		avatar_cleanup_root="$temporary/artifacts"
		avatar_cleanup_signing_key="$temporary/cleanup-master-key"
		avatar_cleanup_inventory_manifest="$avatar_cleanup_root/inventory.json"
		avatar_cleanup_manifest="$avatar_cleanup_root/managed.json"
		avatar_cleanup_retirement_inventory="$avatar_cleanup_root/sealed.json"
		avatar_cleanup_retirement_journal="$avatar_cleanup_root/journal.jsonl"
		avatar_cleanup_retirement_consumer_recovery_root="$avatar_cleanup_root/retirement-consumer-recovery-v1"
		avatar_cleanup_runtime="$avatar_cleanup_root/runtime.json"
		avatar_cleanup_runtime_revision="$owner"
		avatar_cleanup_retirement_attempt=''
		avatar_cleanup_retirement_access_key_sha="$hash"
		avatar_cleanup_ownership_bundle_sha="$hash"
		avatar_cleanup_retirement_policy_sha="$hash"
		avatar_cleanup_retirement_policy_signature_sha="$hash"
		AVATAR_OWNERSHIP_REVISION="$owner"
		EXPECTED_REVISION="$cleanup"
		AVATAR_AUDIT_ENDPOINT='https://storage.invalid'
		AVATAR_AUDIT_REGION='ru-1'
		AVATAR_AUDIT_BUCKET='avatar-retirement-test'
		AVATAR_AUDIT_FORCE_PATH_STYLE='false'
		AVATAR_AUDIT_PUBLIC_BASE_URL='https://cdn.invalid'
		AVATAR_AUDIT_KEY_PREFIX='identity/avatars'
		AVATAR_AUDIT_LEGACY_KEY_PREFIX='user-avatar'
		export AVATAR_AUDIT_ENDPOINT AVATAR_AUDIT_REGION AVATAR_AUDIT_BUCKET AVATAR_AUDIT_FORCE_PATH_STYLE
		export AVATAR_AUDIT_PUBLIC_BASE_URL AVATAR_AUDIT_KEY_PREFIX AVATAR_AUDIT_LEGACY_KEY_PREFIX
		if [[ "$(id -u)" != '0' ]]; then chown() { :; }; fi
		avatar_cleanup_stat_identity() {
			if [[ -d "$1" ]]; then printf '0:0:700\n'; else printf '%s:%s:600\n' "$(id -u)" "$(id -g)"; fi
		}
		avatar_cleanup_require_retirement_tmpfs() { :; }
		avatar_cleanup_require_retirement_deploy_lock() { :; }
		RETIREMENT_CREDENTIAL_FIXTURE="$credential_file" RETIREMENT_EXPECTED="$temporary/expected.json" node <<'NODE' || return 1
const fs = require('node:fs');
const crypto = require('node:crypto');
const access = `retirement-${crypto.randomBytes(12).toString('hex')}`;
const secret = crypto.randomBytes(32).toString('base64url');
fs.writeFileSync(process.env.RETIREMENT_CREDENTIAL_FIXTURE,
  `access_key_id=${access}\nsecret_access_key=${secret}\n`, { mode: 0o600, flag: 'wx' });
fs.writeFileSync(process.env.RETIREMENT_EXPECTED, JSON.stringify({
  accessSha256: crypto.createHash('sha256').update(access).digest('hex'),
  pairSha256: crypto.createHash('sha256').update(access).update('\0').update(secret).digest('hex'),
}) + '\n', { mode: 0o600, flag: 'wx' });
NODE
		avatar_cleanup_load_retirement_credential || return 1
		[[ "$avatar_cleanup_retirement_access_key_sha" == "$(EXPECTED_FILE="$temporary/expected.json" node -e \
			'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.EXPECTED_FILE,"utf8")).accessSha256)' )" ]] || return 1
		printf ' ' >>"$credential_file"
		if avatar_cleanup_load_retirement_credential; then return 1; fi
		RETIREMENT_CREDENTIAL_FIXTURE="$credential_file" node <<'NODE' || return 1
const fs=require('node:fs');const bytes=fs.readFileSync(process.env.RETIREMENT_CREDENTIAL_FIXTURE);
fs.writeFileSync(process.env.RETIREMENT_CREDENTIAL_FIXTURE,bytes.subarray(0,bytes.length-1),{mode:0o600});
NODE
		avatar_cleanup_load_retirement_credential || return 1
		RETIREMENT_CREDENTIAL_FIXTURE="$credential_file" node <<'NODE' || return 1
const fs=require('node:fs');const bytes=fs.readFileSync(process.env.RETIREMENT_CREDENTIAL_FIXTURE);
if(bytes.at(-1)!==10)process.exit(1);
fs.writeFileSync(process.env.RETIREMENT_CREDENTIAL_FIXTURE,bytes.subarray(0,bytes.length-1),{mode:0o600});
NODE
		if avatar_cleanup_load_retirement_credential; then return 1; fi
		printf '\n' >>"$credential_file"
		avatar_cleanup_load_retirement_credential || return 1
		printf '\n' >>"$credential_file"
		if avatar_cleanup_load_retirement_credential; then return 1; fi
		RETIREMENT_CREDENTIAL_FIXTURE="$credential_file" node <<'NODE' || return 1
const fs=require('node:fs');const bytes=fs.readFileSync(process.env.RETIREMENT_CREDENTIAL_FIXTURE);
fs.writeFileSync(process.env.RETIREMENT_CREDENTIAL_FIXTURE,bytes.subarray(0,bytes.length-1),{mode:0o600});
NODE
		avatar_cleanup_load_retirement_credential || return 1
		avatar_cleanup_retirement_attempt="$avatar_cleanup_root/retirement-credential-attempt-$avatar_cleanup_retirement_access_key_sha.json"
		printf '{"rows":[]}\n' >"$avatar_cleanup_inventory_manifest"
		printf '{"objects":[]}\n' >"$avatar_cleanup_manifest"
		printf '{"version":1}\n' >"$avatar_cleanup_retirement_attempt"
		chmod 600 "$avatar_cleanup_inventory_manifest" "$avatar_cleanup_manifest" \
			"$avatar_cleanup_retirement_attempt" || return 1
		avatar_cleanup_create_signing_key || return 1
		RUNTIME_FILE="$avatar_cleanup_runtime" IMAGE_ID="$image" REVISION="$owner" node <<'NODE' || return 1
const fs=require('node:fs');const value={version:1,action:'avatar-core-source-runtime-verification',
 currentRuntimeRevision:process.env.REVISION,services:{identityApi:{imageId:process.env.IMAGE_ID,ociRevision:process.env.REVISION}}};
fs.writeFileSync(process.env.RUNTIME_FILE,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
NODE
		avatar_cleanup_sign_artifact "$avatar_cleanup_runtime" || return 1
		runtime_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_runtime")" || return 1
		RETIREMENT_PRELOAD="$preload" node <<'NODE' || return 1
const fs = require('node:fs');
fs.writeFileSync(process.env.RETIREMENT_PRELOAD, String.raw`const fs=require('node:fs');
const crypto=require('node:crypto');const Module=require('node:module');
const originalRead=fs.readFileSync.bind(fs);const originalWrite=fs.writeFileSync.bind(fs);
const mapping=new Map([
 ['/run/secrets/winwidget-avatar-retirement-v1',process.env.RETIREMENT_TEST_CREDENTIAL_SOURCE],
 ['/run/secrets/winwidget-avatar-retirement-journal-key-v1',process.env.RETIREMENT_TEST_JOURNAL_KEY_SOURCE],
 ['/evidence/inventory.json',process.env.RETIREMENT_TEST_INVENTORY_SOURCE],
 ['/evidence/sealed.json',process.env.RETIREMENT_TEST_SEALED_SOURCE],
 ['/evidence/managed.json',process.env.RETIREMENT_TEST_MANAGED_SOURCE],
 ['/evidence/journal.jsonl',process.env.RETIREMENT_TEST_JOURNAL_SOURCE],
]);
fs.readFileSync=function(target,...rest){const mapped=mapping.get(String(target))||target;const value=originalRead(mapped,...rest);
 if(String(target)==='/run/secrets/winwidget-avatar-retirement-journal-key-v1'){
  const raw=Buffer.isBuffer(value)?value:Buffer.from(value);const secret=raw.toString('utf8').trim();
  if(JSON.stringify(process.argv).includes(secret)||JSON.stringify(process.env).includes(secret))process.exit(92);
  originalWrite(process.env.RETIREMENT_TEST_CAPTURE+'/journal-'+process.env.RETIREMENT_TEST_OPERATION+'.sha256',crypto.createHash('sha256').update(raw).digest('hex')+'\n',{mode:0o600});}
 return value;};
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){if(request!=='@aws-sdk/client-s3')return originalLoad.apply(this,arguments);
 class Command{constructor(input){this.input=input;}}
 class S3Client{constructor(config){const access=config&&config.credentials&&config.credentials.accessKeyId;
  const secret=config&&config.credentials&&config.credentials.secretAccessKey;
  if(typeof access!=='string'||typeof secret!=='string'||JSON.stringify(process.argv).includes(access)||
    JSON.stringify(process.argv).includes(secret)||JSON.stringify(process.env).includes(access)||JSON.stringify(process.env).includes(secret))process.exit(91);
  originalWrite(process.env.RETIREMENT_TEST_CAPTURE+'/aws-'+process.env.RETIREMENT_TEST_OPERATION+'.json',JSON.stringify({
    pairSha256:crypto.createHash('sha256').update(access).update('\0').update(secret).digest('hex'),constructed:true})+'\n',{mode:0o600});}
  async send(command){originalWrite(process.env.RETIREMENT_TEST_CAPTURE+'/send-'+process.env.RETIREMENT_TEST_OPERATION+'.json',
    JSON.stringify({command:command.constructor.name,called:true})+'\n',{mode:0o600});const error=new Error('offline');error.$metadata={httpStatusCode:500};throw error;}}
 const names=['DeleteObjectCommand','GetBucketVersioningCommand','GetObjectCommand','HeadObjectCommand','ListObjectsV2Command','ListObjectVersionsCommand','PutObjectCommand'];
 return Object.fromEntries([['S3Client',S3Client],...names.map(name=>[name,class extends Command{}])]);};
`, { mode: 0o600, flag: 'wx' });
NODE
		image_b='sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
		image_label_mode='valid'
		avatar_cleanup_marker_value() {
			case "$1" in
			identity_api_image_id) printf '%s\n' "$image" ;;
			runtime_evidence_sha256) printf '%s\n' "$runtime_sha" ;;
			*) return 1 ;;
			esac
		}
		docker() {
			if [[ "$1" == 'image' && "$2" == 'inspect' ]]; then
				[[ "$image_label_mode" == 'valid' ]] || { printf '%s|wrong-title|%s\n' "$image" "$owner"; return; }
				[[ "${@: -1}" == "$image" ]] || return 1
				printf '%s|winwidget-identity|%s\n' "$image" "$owner"
				return
			fi
			if [[ "$1" == 'ps' ]]; then return; fi
			if [[ "$1" == 'inspect' ]]; then return 1; fi
			[[ "$1" == 'run' ]] || return 1
			shift
			local script="$capture_root/script-${operation}.js" config="$capture_root/config-${operation}.json"
			local specification source target name value
			local credential_source='' journal_key_source='' inventory_source='' sealed_source='' managed_source='' journal_source=''
			RETIREMENT_SCRIPT="$script" node -e \
				'require("node:fs").writeFileSync(process.env.RETIREMENT_SCRIPT,require("node:fs").readFileSync(0),{mode:0o600})' || return 1
			RETIREMENT_CONFIG="$config" node -e '
const fs=require("node:fs");const args=process.argv.slice(1);const mounts=[],labels={},env=[];let name=null,cidfile=null,image=null;
for(let i=0;i<args.length;i++){if(args[i]==="--mount")mounts.push(args[++i]);else if(args[i]==="--label"){const item=args[++i],at=item.indexOf("=");labels[item.slice(0,at)]=item.slice(at+1);}else if(args[i]==="--env"){const item=args[++i],at=item.indexOf("=");const key=at<0?item:item.slice(0,at);env.push(key+"="+(at<0?(process.env[key]||""):item.slice(at+1)));}else if(args[i]==="--name")name=args[++i];else if(args[i]==="--cidfile")cidfile=args[++i];}
image=args.at(-2);if(args[0]!=="--pull"||args[1]!=="never"||!args.includes("--rm")||!args.includes("-i")||args.at(-1)!=="-"||!/^sha256:[0-9a-f]{64}$/.test(image||""))process.exit(1);
fs.writeFileSync(process.env.RETIREMENT_CONFIG,JSON.stringify({Argv:args,Config:{Image:image,User:"0:0",Env:env,Cmd:["node","-"],Labels:labels,OpenStdin:true},HostConfig:{AutoRemove:true,ReadonlyRootfs:true,CapDrop:["ALL"],SecurityOpt:["no-new-privileges"]},Name:name,Cidfile:cidfile,Mounts:mounts})+"\n",{mode:0o600});' -- "$@" || return 1
			for (( index=1; index<=$#; index++ )); do
				if [[ "${!index}" == '--env' ]]; then
					index=$((index + 1)); specification="${!index}"
					if [[ "$specification" == *=* ]]; then export "$specification"; fi
				elif [[ "${!index}" == '--label' ]]; then
					index=$((index + 1)); specification="${!index}"
					[[ "$specification" != com.winwidget.retirement-operation=* ]] || operation="${specification#*=}"
				elif [[ "${!index}" == '--mount' ]]; then
					index=$((index + 1)); specification="${!index}"
					source="${specification#type=bind,source=}"; source="${source%%,target=*}"
					target="${specification#*,target=}"; target="${target%%,*}"
					case "$target" in
					/run/secrets/winwidget-avatar-retirement-v1) credential_source="$source" ;;
					/run/secrets/winwidget-avatar-retirement-journal-key-v1) journal_key_source="$source" ;;
					/evidence/inventory.json) inventory_source="$source" ;;
					/evidence/sealed.json) sealed_source="$source" ;;
					/evidence/managed.json) managed_source="$source" ;;
					/evidence/journal.jsonl) journal_source="$source" ;;
					esac
				fi
			done
			[[ "$credential_source" == "$credential_file" && "$operation" =~ ^(inventory|delete)$ ]] || return 1
			if RETIREMENT_TEST_CAPTURE="$capture_root" RETIREMENT_TEST_OPERATION="$operation" \
				RETIREMENT_TEST_CREDENTIAL_SOURCE="$credential_source" RETIREMENT_TEST_JOURNAL_KEY_SOURCE="$journal_key_source" \
				RETIREMENT_TEST_INVENTORY_SOURCE="$inventory_source" RETIREMENT_TEST_SEALED_SOURCE="$sealed_source" \
				RETIREMENT_TEST_MANAGED_SOURCE="$managed_source" RETIREMENT_TEST_JOURNAL_SOURCE="$journal_source" \
				NODE_OPTIONS="--require $preload" node "$script" >"$capture_root/stdout-$operation" 2>"$capture_root/stderr-$operation"; then
				return 0
			fi
			return $?
		}
		avatar_cleanup_validate_retirement_image "$image" || return 1
		if avatar_cleanup_validate_retirement_image 'winwidget-identity:test'; then return 1; fi
		if avatar_cleanup_validate_retirement_image "$image_b"; then return 1; fi
		image_label_mode='wrong'
		if avatar_cleanup_validate_retirement_image "$image"; then return 1; fi
		image_label_mode='valid'
		avatar_cleanup_assert_no_retirement_consumer || return 1
		operation='inventory'
		if avatar_cleanup_prepare_retirement_inventory "$image"; then return 1; fi
		[[ -f "$capture_root/aws-inventory.json" && -f "$capture_root/send-inventory.json" ]] || return 1
		avatar_cleanup_active_retirement_container_name=''
		avatar_cleanup_active_retirement_cidfile=''
		avatar_cleanup_active_retirement_operation=''
		avatar_cleanup_create_signing_key || return 1
		avatar_cleanup_set_retirement_journal_scope "$avatar_cleanup_retirement_access_key_sha" || return 1
		avatar_cleanup_retirement_journal_scope_json() {
			SCOPE_ACCESS="$avatar_cleanup_retirement_access_key_sha" OWNER="$owner" CLEANUP="$cleanup" HASH="$hash" node -e '
const value={version:1,action:"avatar-retirement-journal-key-scope",ownershipRevision:process.env.OWNER,
cleanupRevision:process.env.CLEANUP,retirementAccessKeyIdSha256:process.env.SCOPE_ACCESS,
retirementAttemptEvidenceSha256:process.env.HASH,retirementPolicyEvidenceSha256:process.env.HASH,
retirementPolicySignatureSha256:process.env.HASH,inventoryManifestSha256:process.env.HASH,sealedInventorySha256:process.env.HASH};
process.stdout.write(JSON.stringify(value));'
		}
		avatar_cleanup_prepare_retirement_journal_key || return 1
		avatar_cleanup_validate_retirement_journal_key || return 1
		SEALED_FILE="$avatar_cleanup_retirement_inventory" ENDPOINT="$AVATAR_AUDIT_ENDPOINT" \
			PUBLIC_BASE="$AVATAR_AUDIT_PUBLIC_BASE_URL" REGION="$AVATAR_AUDIT_REGION" BUCKET="$AVATAR_AUDIT_BUCKET" \
			NEW_PREFIX="$AVATAR_AUDIT_KEY_PREFIX" LEGACY_PREFIX="$AVATAR_AUDIT_LEGACY_KEY_PREFIX" HASH="$hash" node <<'NODE' || return 1
const fs=require('node:fs');const crypto=require('node:crypto');const value={legacyPrefix:process.env.LEGACY_PREFIX,
 newPrefix:process.env.NEW_PREFIX,storageEndpointSha256:crypto.createHash('sha256').update(process.env.ENDPOINT).digest('hex'),
 storagePublicBaseUrlSha256:crypto.createHash('sha256').update(process.env.PUBLIC_BASE).digest('hex'),storageRegion:process.env.REGION,
 storageBucket:process.env.BUCKET,storageForcePathStyle:false,retirementPolicyEvidenceSha256:process.env.HASH,
 objectVersionCount:0,versionEntryCount:0,objectCount:0,versions:[]};
fs.writeFileSync(process.env.SEALED_FILE,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
NODE
		JOURNAL_FILE="$avatar_cleanup_retirement_journal" KEY_FILE="$avatar_cleanup_retirement_journal_key" \
			SEALED_FILE="$avatar_cleanup_retirement_inventory" HASH="$hash" ENDPOINT="$AVATAR_AUDIT_ENDPOINT" \
			PUBLIC_BASE="$AVATAR_AUDIT_PUBLIC_BASE_URL" REGION="$AVATAR_AUDIT_REGION" BUCKET="$AVATAR_AUDIT_BUCKET" \
			NEW_PREFIX="$AVATAR_AUDIT_KEY_PREFIX" LEGACY_PREFIX="$AVATAR_AUDIT_LEGACY_KEY_PREFIX" node <<'NODE' || return 1
const fs=require('node:fs');const crypto=require('node:crypto');const key=Buffer.from(fs.readFileSync(process.env.KEY_FILE,'utf8').trim(),'hex');
const sealedSha=crypto.createHash('sha256').update(fs.readFileSync(process.env.SEALED_FILE)).digest('hex');
const payload={version:1,action:'avatar-legacy-s3-retirement-journal-header',sequence:0,sealedInventorySha256:sealedSha,
 retirementPolicyEvidenceSha256:process.env.HASH,storageEndpointSha256:crypto.createHash('sha256').update(process.env.ENDPOINT).digest('hex'),
 storagePublicBaseUrlSha256:crypto.createHash('sha256').update(process.env.PUBLIC_BASE).digest('hex'),storageRegion:process.env.REGION,
 storageBucket:process.env.BUCKET,storageForcePathStyle:false,newPrefix:process.env.NEW_PREFIX,legacyPrefix:process.env.LEGACY_PREFIX,
 previousRecordSha256:null,recordedAt:new Date().toISOString()};
const recordHmacSha256=crypto.createHmac('sha256',key).update(JSON.stringify(payload)).digest('hex');
fs.writeFileSync(process.env.JOURNAL_FILE,JSON.stringify({...payload,recordHmacSha256})+'\n',{mode:0o600,flag:'wx'});
NODE
		avatar_cleanup_validate_retirement_inventory() { :; }
		avatar_cleanup_prepare_retirement_journal() { :; }
		operation='delete'
		if avatar_cleanup_delete_sealed_legacy_objects "$image" "$capture_root/delete-output"; then return 1; fi
		[[ -f "$capture_root/aws-delete.json" && -f "$capture_root/send-delete.json" &&
			-f "$capture_root/journal-delete.sha256" ]] || return 1
		RETIREMENT_SCAN_ROOT="$temporary" RETIREMENT_CAPTURE="$capture_root" CREDENTIAL_FILE="$credential_file" \
			JOURNAL_KEY_FILE="$avatar_cleanup_retirement_journal_key" MASTER_KEY_FILE="$avatar_cleanup_signing_key" \
			EXPECTED_FILE="$temporary/expected.json" EXPECTED_ACCESS_SHA="$avatar_cleanup_retirement_access_key_sha" \
			EXPECTED_IMAGE="$image" EXPECTED_CLEANUP="$cleanup" node <<'NODE' || return 1
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const fail=stage=>{console.error('retirement_channel_self_test_stage='+stage);process.exit(1);};
const credential=fs.readFileSync(process.env.CREDENTIAL_FILE,'utf8');const match=/^access_key_id=([^\n]+)\nsecret_access_key=([^\n]+)\n$/.exec(credential);
if(!match)fail('credential-shape');const journal=fs.readFileSync(process.env.JOURNAL_KEY_FILE,'utf8').trim();
const master=fs.readFileSync(process.env.MASTER_KEY_FILE,'utf8').trim();const forbidden=[match[1],match[2],journal,master];
if(forbidden.some(value=>value&&(JSON.stringify(process.argv).includes(value)||JSON.stringify(process.env).includes(value))))fail('host-argv-env');
const skip=new Set([process.env.CREDENTIAL_FILE,process.env.JOURNAL_KEY_FILE,process.env.MASTER_KEY_FILE].map(item=>path.resolve(item)));
const walk=directory=>{for(const name of fs.readdirSync(directory)){const item=path.join(directory,name);const stat=fs.lstatSync(item);
 if(stat.isDirectory())walk(item);else if(stat.isFile()&&!skip.has(path.resolve(item))){const bytes=fs.readFileSync(item);
  const at=forbidden.findIndex(value=>value&&bytes.includes(Buffer.from(value)));if(at>=0)fail('artifact-secret-'+at+'-'+path.relative(process.env.RETIREMENT_SCAN_ROOT,item));}}};walk(process.env.RETIREMENT_SCAN_ROOT);
for(const operation of ['inventory','delete']){const config=JSON.parse(fs.readFileSync(path.join(process.env.RETIREMENT_CAPTURE,'config-'+operation+'.json'),'utf8'));
 const checks=[
  ['env',!config.Config.Env.some(item=>/SECRET_ACCESS_KEY|RETIREMENT_(ACCESS|SECRET)/.test(item))],
  ['argv',Array.isArray(config.Argv)&&config.Argv[0]==='--pull'&&config.Argv[1]==='never'],
  ['credential-mount',config.Mounts.filter(item=>item.includes('target=/run/secrets/winwidget-avatar-retirement-v1,readonly')).length===1],
  ['master-absent',!config.Mounts.some(item=>item.includes(process.env.MASTER_KEY_FILE))],
  ['image',config.Config.Image===process.env.EXPECTED_IMAGE],
  ['name',config.Name==='winwidget-avatar-retirement-'+operation+'-'+process.env.EXPECTED_CLEANUP.slice(0,12)],
  ['cidfile',path.resolve(config.Cidfile)===path.resolve(process.env.RETIREMENT_SCAN_ROOT,'artifacts','.retirement-consumer-'+operation+'.cid')],
  ['lifecycle',config.Config.Labels['com.winwidget.lifecycle']==='avatar-retirement-consumer-v1'],
  ['cleanup',config.Config.Labels['com.winwidget.cleanup-revision']===process.env.EXPECTED_CLEANUP],
  ['operation',config.Config.Labels['com.winwidget.retirement-operation']===operation],
  ['access',config.Config.Labels['com.winwidget.retirement-access-key-sha256']===process.env.EXPECTED_ACCESS_SHA],
  ['attempt',/^[0-9a-f]{64}$/.test(config.Config.Labels['com.winwidget.retirement-attempt-sha256']||'')],
  ['input',/^[0-9a-f]{64}$/.test(config.Config.Labels['com.winwidget.retirement-input-sha256']||'')],
  ['image-label',config.Config.Labels['com.winwidget.retirement-image-id']===process.env.EXPECTED_IMAGE],
  ['journal-label',config.Config.Labels['com.winwidget.retirement-journal-key-sha256']===(operation==='inventory'?'pending':
    crypto.createHash('sha256').update(Buffer.from(journal,'hex')).digest('hex'))],
  ['host',config.HostConfig.AutoRemove===true&&config.HostConfig.ReadonlyRootfs===true&&
    JSON.stringify(config.HostConfig.CapDrop)===JSON.stringify(['ALL'])&&
    JSON.stringify(config.HostConfig.SecurityOpt)===JSON.stringify(['no-new-privileges'])],
  ['journal-mount',config.Mounts.filter(item=>item.includes('target=/run/secrets/winwidget-avatar-retirement-journal-key-v1,readonly')).length===(operation==='delete'?1:0)],
 ];
 const invalid=checks.find(([,valid])=>!valid);if(invalid)fail('inspect-'+operation+'-'+invalid[0]);
 if(fs.statSync(path.join(process.env.RETIREMENT_CAPTURE,'stdout-'+operation)).size||
   fs.statSync(path.join(process.env.RETIREMENT_CAPTURE,'stderr-'+operation)).size)fail('stdio-'+operation);
 const aws=JSON.parse(fs.readFileSync(path.join(process.env.RETIREMENT_CAPTURE,'aws-'+operation+'.json'),'utf8'));
 if(!aws.constructed||aws.pairSha256!==JSON.parse(fs.readFileSync(process.env.EXPECTED_FILE,'utf8')).pairSha256)fail('aws-'+operation);}
const expectedJournal=crypto.createHash('sha256').update(fs.readFileSync(process.env.JOURNAL_KEY_FILE)).digest('hex');
if(fs.readFileSync(path.join(process.env.RETIREMENT_CAPTURE,'journal-delete.sha256'),'utf8').trim()!==expectedJournal)fail('journal');
NODE
		mkdir -m 700 "$avatar_cleanup_retirement_consumer_recovery_root" || return 1
		avatar_cleanup_active_retirement_container_name="$(avatar_cleanup_retirement_consumer_name delete)" || return 1
		avatar_cleanup_active_retirement_cidfile="$(avatar_cleanup_retirement_consumer_cidfile delete)" || return 1
		avatar_cleanup_active_retirement_operation='delete'
		avatar_cleanup_active_retirement_image="$image"
		avatar_cleanup_active_retirement_attempt_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_attempt")" || return 1
		avatar_cleanup_active_retirement_input_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_inventory")" || return 1
		avatar_cleanup_active_retirement_journal_key_sha="$(avatar_cleanup_retirement_key_sha256)" || return 1
		avatar_cleanup_retirement_exit_reason='active-command-failed'
		avatar_cleanup_reconcile_active_retirement_consumer || return 1
		[[ ! -e "$credential_file" && ! -L "$credential_file" ]] || return 1
		[[ "$(find "$avatar_cleanup_retirement_consumer_recovery_root" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')" == '1' ]] || return 1
		recovery_file="$(find "$avatar_cleanup_retirement_consumer_recovery_root" -maxdepth 1 -type f -name '*.json' -print)" || return 1
		RECOVERY_FILE="$recovery_file" node <<'NODE' || return 1
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.RECOVERY_FILE,'utf8'));
if(value.reason!=='active-command-failed'||value.containerObserved!==false||value.containerId!==null||
 value.cidfileResidueIdSha256!==null||value.identityValidated!==false||value.containerRemoved!==false||
 value.observedImageId!==null||value.observedState!=='absent')process.exit(1);
NODE
		absent_binding="$(avatar_cleanup_retirement_consumer_recovery_binding)" || return 1
		RECOVERY_BINDING="$absent_binding" node -e \
			'const v=JSON.parse(process.env.RECOVERY_BINDING);if(v.count!==1||v.artifacts.length!==1)process.exit(1)' || return 1
	)
	(
		local temporary credential_file actions retirement_source recovery_file recovery_backup recovery_hmac_backup
		local attempt_sha input_sha docker_name cidfile status owned_binding current_binding recovery_count
		local owned_id='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
		local absent_id='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
		local foreign_id='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
		local signal_id='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
		local docker_id='' docker_state='absent' docker_live=false docker_owned=true
		local docker_ps_visible=false docker_name_visible=false
		local fsync_interrupt_once=false
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-retirement-orphan-self-test.XXXXXX")" || return 1
		chmod 700 "$temporary" || return 1
		trap 'rm -rf -- "$temporary"' EXIT
		avatar_cleanup_root="$temporary/artifacts"
		avatar_cleanup_signing_key="$temporary/cleanup-hmac-key"
		avatar_cleanup_inventory_manifest="$avatar_cleanup_root/inventory.json"
		avatar_cleanup_retirement_inventory="$avatar_cleanup_root/sealed.json"
		avatar_cleanup_retirement="$avatar_cleanup_root/retirement.json"
		avatar_cleanup_retirement_consumer_recovery_root="$avatar_cleanup_root/retirement-consumer-recovery-v1"
		avatar_cleanup_retirement_attempt="$avatar_cleanup_root/retirement-credential-attempt-$hash.json"
		credential_file="$temporary/avatar-retirement-credential-v1"
		actions="$temporary/docker-actions"
		AVATAR_RETIREMENT_CREDENTIAL_FILE="$credential_file"
		AVATAR_OWNERSHIP_REVISION="$owner"
		EXPECTED_REVISION="$cleanup"
		avatar_cleanup_retirement_access_key_sha="$hash"
		avatar_cleanup_retirement_temporary_root=''
		mkdir -m 700 "$avatar_cleanup_root" "$avatar_cleanup_retirement_consumer_recovery_root" || return 1
		printf '{"rows":[]}\n' >"$avatar_cleanup_inventory_manifest"
		printf '{"version":1}\n' >"$avatar_cleanup_retirement_attempt"
		: >"$actions"
		chmod 600 "$avatar_cleanup_inventory_manifest" "$avatar_cleanup_retirement_attempt" "$actions" || return 1
		if [[ "$(id -u)" != '0' ]]; then chown() { :; }; fi
		avatar_cleanup_stat_identity() {
			if [[ -d "$1" ]]; then
				printf '0:0:700\n'
			else
				printf '%s:%s:600\n' "$(id -u)" "$(id -g)"
			fi
		}
		avatar_cleanup_require_retirement_deploy_lock() { :; }
		avatar_cleanup_validate_retirement_image() { [[ "$1" == "$image" ]]; }
		avatar_cleanup_recover_retirement_attempt_signature() {
			[[ "$1" == "$avatar_cleanup_retirement_attempt" && "$2" == "$hash" ]]
		}
		avatar_cleanup_create_signing_key || return 1
		node() {
			command node "$@" || return $?
			if [[ -n "${FSYNC_TARGET:-}" && "${cidfile:-}" == "$FSYNC_TARGET" ]]; then
				printf 'fsync-file\nfsync-parent\n' >>"$actions" || return 1
				if [[ "$fsync_interrupt_once" == true ]]; then
					fsync_interrupt_once=false
					return 137
				fi
			fi
		}
		attempt_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement_attempt")" || return 1
		input_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_inventory_manifest")" || return 1
		docker_name="$(avatar_cleanup_retirement_consumer_name inventory)" || return 1
		docker() {
			local command="${1:-}" template='' target=''
			case "$command" in
			ps)
				if [[ "$docker_live" == true && "$docker_ps_visible" == true ]]; then
					printf '%s\n' "$docker_id"
				fi
				return 0
				;;
			inspect)
				if [[ "${2:-}" == '--format' ]]; then
					template="${3:-}"
					target="${4:-}"
					[[ "$docker_live" == true ]] || return 1
					if [[ "$template" == '{{.Id}}' ]]; then
						if [[ "$target" == "$docker_id" || ( "$target" == "$docker_name" && "$docker_name_visible" == true ) ]]; then
							printf '%s\n' "$docker_id"
							return 0
						fi
						return 1
					fi
					[[ "$target" == "$docker_id" ]] || return 1
					if [[ "$template" == *'Config.Labels'* ]]; then
						if [[ "$docker_owned" == true ]]; then
							printf '%s|/%s|%s|%s|%s|%s|inventory|%s|%s|%s|pending|%s\n' \
								"$docker_id" "$docker_name" "$image" "$docker_state" \
								"$avatar_cleanup_retirement_consumer_lifecycle" "$cleanup" "$hash" \
								"$attempt_sha" "$input_sha" "$image"
						else
							printf '%s|/foreign-retirement|%s|%s|foreign-lifecycle|%s|inventory|%s|%s|%s|pending|%s\n' \
								"$docker_id" "$image" "$docker_state" "$cleanup" "$hash" \
								"$attempt_sha" "$input_sha" "$image"
						fi
						return 0
					fi
					if [[ "$template" == '{{.State.Status}}' ]]; then
						printf '%s\n' "$docker_state"
						return 0
					fi
					return 1
				fi
				target="${2:-}"
				[[ "$docker_live" == true &&
					( "$target" == "$docker_id" || ( "$target" == "$docker_name" && "$docker_name_visible" == true ) ) ]]
				;;
			stop)
				[[ "$docker_live" == true && "${2:-}" == '--time' && "${3:-}" == '15' && "${4:-}" == "$docker_id" ]] || return 1
				printf 'stop\n' >>"$actions"
				docker_state='exited'
				;;
			wait)
				[[ "$docker_live" == true && "${2:-}" == "$docker_id" ]] || return 1
				printf 'wait\n' >>"$actions"
				printf '0\n'
				;;
			rm)
				[[ "$docker_live" == true && "${2:-}" == '-f' && "${3:-}" == "$docker_id" ]] || return 1
				printf 'rm\n' >>"$actions"
				docker_live=false
				docker_state='absent'
				;;
			run)
				printf 'run\n' >>"$actions"
				return 0
				;;
			*) return 1 ;;
			esac
		}
		write_retirement_credential_fixture() {
			[[ ! -e "$credential_file" && ! -L "$credential_file" ]] || return 1
			printf 'access_key_id=offline-new-access\nsecret_access_key=offline-new-secret\n' >"$credential_file"
			chmod 600 "$credential_file"
		}
		write_retirement_cid_fixture() {
			[[ $# -eq 1 ]] || return 1
			cidfile="$(avatar_cleanup_retirement_consumer_cidfile inventory)" || return 1
			printf '%s' "$1" >"$cidfile"
			chmod 600 "$cidfile"
		}
		recovery_for_reason() {
			[[ $# -eq 1 ]] || return 1
			RECOVERY_ROOT="$avatar_cleanup_retirement_consumer_recovery_root" RECOVERY_REASON="$1" node <<'NODE'
const fs=require('node:fs');const path=require('node:path');const matches=fs.readdirSync(process.env.RECOVERY_ROOT)
 .filter(name=>name.endsWith('.json')).map(name=>path.join(process.env.RECOVERY_ROOT,name))
 .filter(file=>JSON.parse(fs.readFileSync(file,'utf8')).reason===process.env.RECOVERY_REASON);
if(matches.length!==1)process.exit(1);process.stdout.write(matches[0]);
NODE
		}
		assert_docker_cleanup_actions() {
			[[ $# -eq 1 ]] || return 1
			DOCKER_ACTIONS="$actions" EXPECTED_ACTIONS="$1" node -e \
				'if(require("node:fs").readFileSync(process.env.DOCKER_ACTIONS,"utf8")!==process.env.EXPECTED_ACTIONS)process.exit(1)'
		}

		# Simulate an uncatchable crash: a valid owned container, its CID, and a
		# newly installed one-use credential all survive into the next locked run.
		docker_id="$owned_id"
		docker_state='running'
		docker_live=true
		docker_owned=true
		docker_ps_visible=true
		docker_name_visible=true
		write_retirement_credential_fixture || return 1
		write_retirement_cid_fixture "$owned_id" || return 1
		if avatar_cleanup_assert_no_retirement_consumer; then return 1; fi
		if avatar_cleanup_run_retirement_node inventory "$image" "$input_sha" "$attempt_sha" pending; then return 1; fi
		[[ ! -s "$actions" ]] || return 1
		fsync_interrupt_once=true
		status=0
		avatar_cleanup_reconcile_retirement_consumers || status=$?
		[[ "$status" == '1' && "$docker_live" == true &&
			-e "$credential_file" && -e "$cidfile" ]] || return 1
		[[ "$(avatar_cleanup_read_retirement_consumer_cidfile inventory)" == "$owned_id" ]] || return 1
		assert_docker_cleanup_actions $'fsync-file\nfsync-parent\n' || return 1
		[[ "$(find "$avatar_cleanup_retirement_consumer_recovery_root" -maxdepth 1 -type f -name '*.json' |
			wc -l | tr -d ' ')" == '0' ]] || return 1
		status=0
		avatar_cleanup_reconcile_retirement_consumers || status=$?
		[[ "$status" == '75' && "$docker_live" == false &&
			! -e "$credential_file" && ! -L "$credential_file" && ! -e "$cidfile" && ! -L "$cidfile" ]] || return 1
		assert_docker_cleanup_actions $'fsync-file\nfsync-parent\nfsync-file\nfsync-parent\nstop\nwait\nrm\n' || return 1
		recovery_file="$(recovery_for_reason startup-orphan)" || return 1
		RECOVERY_FILE="$recovery_file" EXPECTED_CONTAINER="$owned_id" EXPECTED_IMAGE="$image" \
			EXPECTED_RESIDUE_SHA="$(printf '%s' "$owned_id" | identity_cutover_text_sha256)" node <<'NODE' || return 1
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.RECOVERY_FILE,'utf8'));
if(value.containerObserved!==true||value.containerId!==process.env.EXPECTED_CONTAINER||value.identityValidated!==true||
 value.containerRemoved!==true||value.cidfileResidueIdSha256!==process.env.EXPECTED_RESIDUE_SHA||
 value.expectedImageId!==process.env.EXPECTED_IMAGE||value.observedImageId!==process.env.EXPECTED_IMAGE||
 value.observedState!=='running'||value.credentialFileDurablyRemoved!==true)process.exit(1);
NODE
		owned_binding="$(avatar_cleanup_retirement_consumer_recovery_binding)" || return 1
		RECOVERY_BINDING="$owned_binding" node -e \
			'const v=JSON.parse(process.env.RECOVERY_BINDING);if(v.count!==1||v.artifacts.length!==1)process.exit(1)' || return 1

		# The retirement/complete transitive loader must accept exactly the bound
		# set, then reject either artifact tampering or deletion.
		retirement_source="$temporary/retirement-source.json"
		RECOVERY_BINDING="$owned_binding" RETIREMENT_SOURCE="$retirement_source" node <<'NODE' || return 1
const fs=require('node:fs');const binding=JSON.parse(process.env.RECOVERY_BINDING);
const value={retirementConsumerRecoveryEvidenceCount:binding.count,
 retirementConsumerRecoveryEvidenceAggregateSha256:binding.aggregateSha256,
 retirementConsumerRecoveryEvidenceArtifacts:binding.artifacts};
fs.writeFileSync(process.env.RETIREMENT_SOURCE,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
NODE
		avatar_cleanup_write_json_artifact "$avatar_cleanup_retirement" "$retirement_source" || return 1
		avatar_cleanup_load_retirement_consumer_recovery_binding || return 1
		[[ "$avatar_cleanup_retirement_recovery_count" == '1' ]] || return 1
		recovery_backup="$temporary/recovery.valid.json"
		recovery_hmac_backup="$temporary/recovery.valid.hmac"
		cp "$recovery_file" "$recovery_backup" || return 1
		cp "${recovery_file}.hmac-sha256" "$recovery_hmac_backup" || return 1
		printf 'tamper\n' >>"$recovery_file"
		if avatar_cleanup_load_retirement_consumer_recovery_binding >/dev/null 2>&1; then return 1; fi
		cp "$recovery_backup" "$recovery_file" || return 1
		cp "$recovery_hmac_backup" "${recovery_file}.hmac-sha256" || return 1
		chmod 600 "$recovery_file" "${recovery_file}.hmac-sha256" || return 1
		avatar_cleanup_load_retirement_consumer_recovery_binding || return 1
		rm -f -- "$recovery_file" "${recovery_file}.hmac-sha256" || return 1
		if avatar_cleanup_load_retirement_consumer_recovery_binding >/dev/null 2>&1; then return 1; fi
		cp "$recovery_backup" "$recovery_file" || return 1
		cp "$recovery_hmac_backup" "${recovery_file}.hmac-sha256" || return 1
		chmod 600 "$recovery_file" "${recovery_file}.hmac-sha256" || return 1
		avatar_cleanup_load_retirement_consumer_recovery_binding || return 1

		# A CID residue for an already auto-removed container is not evidence that
		# any container was observed, identity-validated, or removed.
		: >"$actions"
		docker_id="$absent_id"
		docker_state='absent'
		docker_live=false
		docker_owned=true
		docker_ps_visible=false
		docker_name_visible=false
		write_retirement_credential_fixture || return 1
		write_retirement_cid_fixture "$absent_id" || return 1
		status=0
		avatar_cleanup_reconcile_retirement_consumers || status=$?
		[[ "$status" == '75' && ! -s "$actions" &&
			! -e "$credential_file" && ! -L "$credential_file" && ! -e "$cidfile" && ! -L "$cidfile" ]] || return 1
		recovery_file="$(recovery_for_reason cidfile-residue)" || return 1
		RECOVERY_FILE="$recovery_file" EXPECTED_RESIDUE_SHA="$(printf '%s' "$absent_id" | identity_cutover_text_sha256)" \
			node <<'NODE' || return 1
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.RECOVERY_FILE,'utf8'));
if(value.containerObserved!==false||value.containerId!==null||value.cidfileResidueIdSha256!==process.env.EXPECTED_RESIDUE_SHA||
 value.identityValidated!==false||value.containerRemoved!==false||value.observedImageId!==null||
 value.observedState!=='absent')process.exit(1);
NODE
		current_binding="$(avatar_cleanup_retirement_consumer_recovery_binding)" || return 1
		recovery_count="$(RECOVERY_BINDING="$current_binding" node -e 'process.stdout.write(String(JSON.parse(process.env.RECOVERY_BINDING).count))')" || return 1
		[[ "$recovery_count" == '2' ]] || return 1

		# A live foreign CID fails closed before stop/rm, credential deletion, or a
		# success recovery record.
		: >"$actions"
		docker_id="$foreign_id"
		docker_state='running'
		docker_live=true
		docker_owned=false
		docker_ps_visible=false
		docker_name_visible=false
		write_retirement_credential_fixture || return 1
		write_retirement_cid_fixture "$foreign_id" || return 1
		status=0
		avatar_cleanup_reconcile_retirement_consumers >/dev/null 2>&1 || status=$?
		[[ "$status" == '1' && -e "$credential_file" && -e "$cidfile" && ! -s "$actions" ]] || return 1
		[[ "$(avatar_cleanup_retirement_consumer_recovery_binding)" == "$current_binding" ]] || return 1
		docker_live=false
		avatar_cleanup_durable_unlink_private_file "$cidfile" || return 1
		avatar_cleanup_durable_unlink_private_file "$credential_file" || return 1

		# Exercise the production TERM trap installer and real EXIT reconciliation.
		: >"$actions"
		docker_id="$signal_id"
		docker_state='running'
		docker_live=true
		docker_owned=true
		docker_ps_visible=true
		docker_name_visible=true
		write_retirement_credential_fixture || return 1
		write_retirement_cid_fixture "$signal_id" || return 1
		avatar_cleanup_active_retirement_container_name="$docker_name"
		avatar_cleanup_active_retirement_cidfile="$cidfile"
		avatar_cleanup_active_retirement_operation='inventory'
		avatar_cleanup_active_retirement_image="$image"
		avatar_cleanup_active_retirement_input_sha="$input_sha"
		avatar_cleanup_active_retirement_attempt_sha="$attempt_sha"
		avatar_cleanup_active_retirement_journal_key_sha='pending'
		avatar_cleanup_retirement_exit_reason='active-command-failed'
		avatar_cleanup_retirement_signal_self_test() (
			avatar_cleanup_install_retirement_exit_traps
			node -e 'process.kill(process.ppid,"SIGTERM")'
			return 99
		)
		status=0
		avatar_cleanup_retirement_signal_self_test || status=$?
		[[ "$status" == '143' && ! -e "$credential_file" && ! -L "$credential_file" &&
			! -e "$cidfile" && ! -L "$cidfile" ]] || return 1
		assert_docker_cleanup_actions $'fsync-file\nfsync-parent\nstop\nwait\nrm\n' || return 1
		docker_live=false
		recovery_file="$(recovery_for_reason signal-or-exit)" || return 1
		RECOVERY_FILE="$recovery_file" EXPECTED_CONTAINER="$signal_id" node <<'NODE' || return 1
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.RECOVERY_FILE,'utf8'));
if(value.containerObserved!==true||value.containerId!==process.env.EXPECTED_CONTAINER||
 value.identityValidated!==true||value.containerRemoved!==true||value.credentialFileDurablyRemoved!==true)process.exit(1);
NODE
		current_binding="$(avatar_cleanup_retirement_consumer_recovery_binding)" || return 1
		RECOVERY_BINDING="$current_binding" node -e \
			'const v=JSON.parse(process.env.RECOVERY_BINDING);if(v.count!==3||v.artifacts.length!==3)process.exit(1)' || return 1
	)
	(
		local temporary moving='4444444444444444444444444444444444444444'
		local unavailable='5555555555555555555555555555555555555555'
		local dirty='6666666666666666666666666666666666666666'
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-guard-self-test.XXXXXX")"
		chmod 700 "$temporary"
		trap 'rm -rf -- "$temporary"' EXIT
		avatar_cleanup_marker="$temporary/marker"
		avatar_cleanup_signing_key="$temporary/signing-key"
		if [[ "$(id -u)" != '0' ]]; then chown() { :; }; fi
		avatar_cleanup_create_signing_key
		avatar_cleanup_validate_guard_phase_evidence() { avatar_cleanup_validate_marker; }
		avatar_cleanup_revision_available() {
			[[ "$1" == "$cleanup" || "$1" == "$owner" || "$1" == "$moving" || "$1" == "$dirty" ]]
		}
		avatar_cleanup_revision_descends_from() {
			[[ "$1" == "$cleanup" && ( "$2" == "$cleanup" || "$2" == "$moving" || "$2" == "$dirty" ) ]]
		}
		avatar_cleanup_validate_candidate_clean_source_tree() {
			[[ "$1" == "$cleanup" || "$1" == "$moving" ]]
		}
		avatar_cleanup_write_marker verified "$owner" "$cleanup" "$client" \
			"$image" "$image" "$image" "$image" "$image" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" \
			pending pending pending pending pending pending pending pending '2026-08-15T00:00:00Z'
		avatar_cleanup_guard_revision --guard-before-fetch-revision "$cleanup"
		! avatar_cleanup_guard_revision --guard-before-fetch-revision "$moving" >/dev/null 2>&1
		avatar_cleanup_write_marker forward-only "$owner" "$cleanup" "$client" \
			"$image" "$image" "$image" "$image" "$image" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" pending pending pending pending pending pending pending '2026-08-15T00:00:01Z'
		avatar_cleanup_guard_revision --guard-before-checkout-revision "$cleanup"
		! avatar_cleanup_guard_revision --guard-before-checkout-revision "$moving" >/dev/null 2>&1
		avatar_cleanup_write_marker complete "$owner" "$cleanup" "$client" \
			"$image" "$image" "$image" "$image" "$image" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" pending '2026-08-15T00:00:02Z'
		avatar_cleanup_guard_revision --guard-before-checkout-revision "$cleanup"
		! avatar_cleanup_guard_revision --guard-before-fetch-revision "$moving" >/dev/null 2>&1
		! avatar_cleanup_guard_revision --guard-before-fetch-revision "$unavailable" >/dev/null 2>&1
		avatar_cleanup_write_marker complete "$owner" "$cleanup" "$client" \
			"$image" "$image" "$image" "$image" "$image" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" \
			"$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" "$hash" '2026-08-15T00:00:03Z'
		avatar_cleanup_guard_revision --guard-before-fetch-revision "$unavailable"
		! avatar_cleanup_guard_revision --guard-before-checkout-revision "$unavailable" >/dev/null 2>&1
		avatar_cleanup_guard_revision --guard-before-checkout-revision "$moving"
		! avatar_cleanup_guard_revision --guard-before-checkout-revision "$owner" >/dev/null 2>&1
		! avatar_cleanup_guard_revision --guard-before-checkout-revision "$dirty" >/dev/null 2>&1
		printf 'crash-tail\n' >>"$avatar_cleanup_marker"
		! avatar_cleanup_guard_revision --guard-before-fetch-revision "$cleanup" >/dev/null 2>&1
	)
	(
		local temporary clean_revision reintroduced_revision
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-src-guard-self-test.XXXXXX")"
		chmod 700 "$temporary"
		trap 'rm -rf -- "$temporary"' EXIT
		mkdir -p "$temporary/src/health"
		printf 'export class HealthService {}\n' >"$temporary/src/health/health.service.ts"
		git -C "$temporary" init -q
		git -C "$temporary" config user.name 'Avatar cleanup self-test'
		git -C "$temporary" config user.email 'avatar-cleanup-self-test@invalid.local'
		git -C "$temporary" config commit.gpgsign false
		git -C "$temporary" add src/health/health.service.ts
		git -C "$temporary" commit -q -m 'clean root source fixture'
		clean_revision="$(git -C "$temporary" rev-parse HEAD)"
		SERVER_ROOT="$temporary"
		avatar_cleanup_validate_candidate_root_src_contract "$clean_revision"
		mkdir -p "$temporary/src/legacy-avatar"
		printf "import { Controller } from '@nestjs/common';\n@Controller('files')\nexport class LegacyAvatarController {}\n" \
			>"$temporary/src/legacy-avatar/legacy-avatar.controller.ts"
		git -C "$temporary" add src/legacy-avatar/legacy-avatar.controller.ts
		git -C "$temporary" commit -q -m 'reintroduce legacy route under a new path'
		reintroduced_revision="$(git -C "$temporary" rev-parse HEAD)"
		avatar_cleanup_revision_descends_from "$clean_revision" "$reintroduced_revision"
		! avatar_cleanup_validate_candidate_root_src_contract "$reintroduced_revision"
	)
	(
		local temporary cleanup_revision validator_root actual_server_root result
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-historical-validator-self-test.XXXXXX")"
		chmod 700 "$temporary"
		trap 'rm -rf -- "$temporary"' EXIT
		mkdir -m 700 "$temporary/scripts"
		printf '%s\n' \
			'source "$SERVER_ROOT/scripts/identity-release-identity.sh"' \
			'identity_avatar_historical_fixture() {' \
			'  printf "%s|%s" "$(identity_release_historical_fixture)" "$SERVER_ROOT"' \
			'}' >"$temporary/scripts/identity-avatar-media-production.sh"
		printf '%s\n' \
			'identity_release_historical_fixture() {' \
			"  printf '%s' immutable-cleanup-revision" \
			'}' >"$temporary/scripts/identity-release-identity.sh"
		printf '%s\n' '# immutable production deploy lock dependency fixture' \
			>"$temporary/scripts/production-deploy-lock.sh"
		git -C "$temporary" init -q
		git -C "$temporary" config user.name 'Avatar cleanup self-test'
		git -C "$temporary" config user.email 'avatar-cleanup-self-test@invalid.local'
		git -C "$temporary" config commit.gpgsign false
		git -C "$temporary" add scripts
		git -C "$temporary" commit -q -m 'immutable lifecycle validator fixture'
		cleanup_revision="$(git -C "$temporary" rev-parse HEAD)"
		printf '%s\n' \
			'identity_release_historical_fixture() {' \
			"  printf '%s' tampered-descendant-worktree" \
			'}' >"$temporary/scripts/identity-release-identity.sh"
		SERVER_ROOT="$temporary"
		validator_root="$(avatar_cleanup_materialize_lifecycle_validator "$cleanup_revision")" || return 1
		actual_server_root="$SERVER_ROOT"
		SERVER_ROOT="$validator_root"
		# shellcheck source=/dev/null
		source "$validator_root/scripts/identity-avatar-media-production.sh"
		SERVER_ROOT="$actual_server_root"
		result="$(identity_avatar_historical_fixture)" || return 1
		[[ "$result" == "immutable-cleanup-revision|$temporary" ]] || return 1
		rm -rf -- "$validator_root"
	)
	(
		local temporary
		avatar_cleanup_validate_permanent_guard_contract "$AVATAR_SCRIPT_ROOT"
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-dead-guard-self-test.XXXXXX")"
		chmod 700 "$temporary"
		trap 'rm -rf -- "$temporary"' EXIT
		mkdir -p "$temporary/.github/workflows" "$temporary/scripts"
		cp "$AVATAR_SCRIPT_ROOT/.github/workflows/deploy-production.yml" \
			"$temporary/.github/workflows/deploy-production.yml"
		cp "$AVATAR_SCRIPT_ROOT/scripts/cleanup-avatar-core-source-production.sh" \
			"$temporary/scripts/cleanup-avatar-core-source-production.sh"
		cp "$AVATAR_SCRIPT_ROOT/scripts/deploy-production.sh" \
			"$temporary/scripts/deploy-production.sh"
		DEAD_GUARD_WORKFLOW="$temporary/.github/workflows/deploy-production.yml" node <<'NODE'
const fs = require('node:fs');
const path = process.env.DEAD_GUARD_WORKFLOW;
let value = fs.readFileSync(path, 'utf8');
const deployStart = value.indexOf('\n  deploy:');
const checkoutStart = value.indexOf('checkout_verified_prod_revision() {', deployStart);
const checkoutEnd = value.indexOf('\n          checkout_retargeted_billing_cleanup_revision() {', checkoutStart);
const needle = '            guard_avatar_cleanup_checkout_before_pull \\\n              "$expected_revision" --guard-before-checkout-revision\n';
const block = value.slice(checkoutStart, checkoutEnd);
if (deployStart < 0 || checkoutStart < 0 || checkoutEnd <= checkoutStart ||
    block.split(needle).length !== 2) process.exit(1);
value = `${value.slice(0, checkoutStart)}${block.replace(needle, '')}${value.slice(checkoutEnd)}`;
value += `\n# dead guard strings intentionally outside checkout execution\n# guard_avatar_cleanup_checkout_before_pull \\\n#   "$expected_revision" --guard-before-checkout-revision\n`;
fs.writeFileSync(path, value);
NODE
		! avatar_cleanup_validate_permanent_guard_contract "$temporary"
	)
	(
		local temporary body valid_uuid invalid_uuid retirement_source fixture_retirement_sha
		local frontend_binding frontend_binding_sha runtime_stable_since
		local fixture_ledger_generation='0' fixture_ledger_state='applied' fixture_ledger_sha
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-complete-self-test.XXXXXX")"
		trap 'rm -rf -- "$temporary"' EXIT
		body="$temporary/cleanup-complete-v1.json"
		valid_uuid='123e4567-e89b-42d3-a456-426614174000'
		invalid_uuid='123e4567-e89b-02d3-a456-426614174000'
		AVATAR_OWNERSHIP_REVISION="$owner"
		EXPECTED_REVISION="$cleanup"
		AVATAR_CLIENT_REVISION="$client"
		avatar_cleanup_root="$temporary/artifacts"
		avatar_cleanup_signing_key="$temporary/cleanup-hmac-key"
		avatar_cleanup_retirement="$avatar_cleanup_root/retirement.json"
		avatar_cleanup_retirement_consumer_recovery_root="$avatar_cleanup_root/retirement-consumer-recovery-v1"
		retirement_source="$temporary/retirement-source.json"
		mkdir -m 700 "$avatar_cleanup_root"
		if [[ "$(id -u)" != '0' ]]; then chown() { :; }; fi
		avatar_cleanup_create_signing_key
		printf '%s\n' \
			'{"retirementConsumerRecoveryEvidenceCount":0,"retirementConsumerRecoveryEvidenceAggregateSha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","retirementConsumerRecoveryEvidenceArtifacts":[]}' \
			>"$retirement_source"
		chmod 600 "$retirement_source"
		avatar_cleanup_write_json_artifact "$avatar_cleanup_retirement" "$retirement_source"
		fixture_retirement_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_retirement")"
		fixture_ledger_sha="$hash"
		frontend_binding="$(HASH="$hash" CLIENT="$client" IMAGE="$image" node -e '
const value={bindingKind:"initial-client-switch",evidenceSha256:process.env.HASH,
evidenceSignatureSha256:process.env.HASH,clientRevision:process.env.CLIENT,imageId:process.env.IMAGE,
releaseEvidenceSha256:process.env.HASH,releaseEvidenceSignatureSha256:process.env.HASH,
releaseTreeSha256:process.env.HASH,releaseFullManifestSha256:process.env.HASH,
processStartedAt:"2026-08-01T00:00:00.000Z"};process.stdout.write(JSON.stringify(value));')"
		frontend_binding_sha="$(FRONTEND_BINDING="$frontend_binding" node -e '
const {createHash}=require("node:crypto");process.stdout.write(createHash("sha256")
.update(process.env.FRONTEND_BINDING).digest("hex"));')"
		runtime_stable_since="$(node -e 'process.stdout.write(new Date(Math.floor((Date.now()-691200000)/1000)*1000).toISOString().replace(".000Z","Z"))')"
		avatar_cleanup_load_cleanup_complete_context() {
			avatar_cleanup_identity_database_id="$valid_uuid"
		}
		avatar_cleanup_marker_value() {
			case "$1" in
			core_cleanup_image_id) printf '%s\n' "$image" ;;
			retirement_evidence_sha256) printf '%s\n' "$fixture_retirement_sha" ;;
			current_runtime_revision) printf '%s\n' "$owner" ;;
			initial_client_revision | current_client_revision) printf '%s\n' "$client" ;;
			runtime_stability_generation) printf '0\n' ;;
			runtime_stability_ledger_generation) printf '%s\n' "$fixture_ledger_generation" ;;
			runtime_stability_ledger_tail_state) printf '%s\n' "$fixture_ledger_state" ;;
			runtime_stability_ledger_tail_evidence_sha256) printf '%s\n' "$fixture_ledger_sha" ;;
			runtime_stable_since) printf '%s\n' "$runtime_stable_since" ;;
			frontend_binding_sha256) printf '%s\n' "$frontend_binding_sha" ;;
			*) printf '%s\n' "$hash" ;;
			esac
		}
		avatar_cleanup_ownership_marker_value() { printf '%s\n' "$hash"; }
		CLEANUP_COMPLETE_FIXTURE="$body" OWNER="$owner" CLEANUP="$cleanup" CLIENT="$client" \
			DATABASE_ID="$valid_uuid" HASH="$hash" IMAGE="$image" RETIREMENT_SHA="$fixture_retirement_sha" \
			FRONTEND_BINDING="$frontend_binding" RUNTIME_STABLE_SINCE="$runtime_stable_since" node <<'NODE'
const fs = require('node:fs');
const value = {
  schemaVersion:1,kind:'identity-avatar-core-cleanup-complete',cleanupPhase:'COMPLETE',
  ownershipRevision:process.env.OWNER,currentRuntimeRevision:process.env.OWNER,cleanupRevision:process.env.CLEANUP,
  initialClientRevision:process.env.CLIENT,currentClientRevision:process.env.CLIENT,
  identityDatabaseId:process.env.DATABASE_ID,ownershipMarkerSha256:process.env.HASH,
  runtimeStabilityCurrentEvidenceSha256:process.env.HASH,
  runtimeStabilityCurrentEvidenceSignatureSha256:process.env.HASH,runtimeStabilityGeneration:0,
  runtimeStabilityEvidenceSha256:process.env.HASH,runtimeStabilityLedgerGeneration:0,
  runtimeStabilityLedgerTailState:'applied',runtimeStabilityLedgerTailEvidenceSha256:process.env.HASH,
  runtimeStableSince:process.env.RUNTIME_STABLE_SINCE,currentClientBindingEvidenceSha256:process.env.HASH,
  runtimeRetargetEvidenceSha256:process.env.HASH,clientRetargetEvidenceSha256:process.env.HASH,
  frontendBinding:JSON.parse(process.env.FRONTEND_BINDING),clientReadyEvidenceSha256:process.env.HASH,
  clientReadyEvidenceSignatureSha256:process.env.HASH,clientSwitchEvidenceSha256:process.env.HASH,
  soakEvidenceSha256:process.env.HASH,preClientReferenceZeroEvidenceSha256:process.env.HASH,
  predeployUploadsHandoffSha256:process.env.HASH,cleanupRetargetEvidenceSha256:process.env.HASH,
  cleanupReferenceZeroEvidenceSha256:process.env.HASH,writerFenceEvidenceSha256:process.env.HASH,
  retirementEvidenceSha256:process.env.RETIREMENT_SHA,retirementConsumerRecoveryEvidenceCount:0,
  retirementConsumerRecoveryEvidenceAggregateSha256:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  revocationEvidenceSha256:process.env.HASH,
  nginxEvidenceSha256:process.env.HASH,smokeEvidenceSha256:process.env.HASH,
  coreCleanupImageId:process.env.IMAGE,legacyReferencesAbsent:true,legacyRoutesAbsent:true,
  legacyObjectsRetired:true,ownershipActive:true,completedAt:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),
};
fs.writeFileSync(process.env.CLEANUP_COMPLETE_FIXTURE, JSON.stringify(value));
NODE
		avatar_cleanup_validate_cleanup_complete_body "$body"
		fixture_ledger_generation='1'
		fixture_ledger_state='aborted'
		CLEANUP_COMPLETE_FIXTURE="$body" HASH="$hash" node <<'NODE'
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,'utf8'));
value.runtimeStabilityLedgerGeneration=1;value.runtimeStabilityLedgerTailState='aborted';
value.runtimeStabilityLedgerTailEvidenceSha256=process.env.HASH;
fs.writeFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,JSON.stringify(value));
NODE
		! avatar_cleanup_validate_cleanup_complete_body "$body"
		fixture_ledger_sha='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
		CLEANUP_COMPLETE_FIXTURE="$body" LEDGER_SHA="$fixture_ledger_sha" node <<'NODE'
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,'utf8'));
value.runtimeStabilityLedgerTailEvidenceSha256=process.env.LEDGER_SHA;
fs.writeFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,JSON.stringify(value));
NODE
		avatar_cleanup_validate_cleanup_complete_body "$body"
		fixture_ledger_generation='0'
		fixture_ledger_state='applied'
		fixture_ledger_sha="$hash"
		CLEANUP_COMPLETE_FIXTURE="$body" HASH="$hash" node <<'NODE'
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,'utf8'));
value.runtimeStabilityLedgerGeneration=0;value.runtimeStabilityLedgerTailState='applied';
value.runtimeStabilityLedgerTailEvidenceSha256=process.env.HASH;
fs.writeFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,JSON.stringify(value));
NODE
		CLEANUP_COMPLETE_FIXTURE="$body" INVALID_UUID="$invalid_uuid" node <<'NODE'
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,'utf8'));
value.identityDatabaseId=process.env.INVALID_UUID;fs.writeFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,JSON.stringify(value));
NODE
		! avatar_cleanup_validate_cleanup_complete_body "$body"
		CLEANUP_COMPLETE_FIXTURE="$body" DATABASE_ID="$valid_uuid" node <<'NODE'
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,'utf8'));
value.identityDatabaseId=process.env.DATABASE_ID;value.completedAt='2026-02-30T00:00:00Z';
fs.writeFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,JSON.stringify(value));
NODE
		! avatar_cleanup_validate_cleanup_complete_body "$body"
		CLEANUP_COMPLETE_FIXTURE="$body" DATABASE_ID="$valid_uuid" CLEANUP="$cleanup" node <<'NODE'
const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,'utf8'));
value.identityDatabaseId=process.env.DATABASE_ID;value.completedAt='2026-08-15T00:00:00Z';
value.ownershipRevision=process.env.CLEANUP;
fs.writeFileSync(process.env.CLEANUP_COMPLETE_FIXTURE,JSON.stringify(value));
NODE
		AVATAR_OWNERSHIP_REVISION="$cleanup"
		! avatar_cleanup_validate_cleanup_complete_body "$body"
	)
	(
		local temporary removal_log rm_calls=0 rm_fail_at=0 target
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-temp-withdrawal-self-test.XXXXXX")"
		chmod 700 "$temporary"
		trap 'command rm -rf -- "$temporary"' EXIT
		avatar_cleanup_public_root="$temporary/public"
		mkdir -m 700 "$avatar_cleanup_public_root"
		avatar_cleanup_public_client_ready_body="$avatar_cleanup_public_root/client-ready-v1.json"
		avatar_cleanup_public_client_ready_signature="${avatar_cleanup_public_client_ready_body}.sig"
		avatar_cleanup_public_client_retarget_ack_body="$avatar_cleanup_public_root/client-retarget-ack-v1.json"
		avatar_cleanup_public_client_retarget_ack_signature="${avatar_cleanup_public_client_retarget_ack_body}.sig"
		avatar_cleanup_public_runtime_stability_current_body="$avatar_cleanup_public_root/runtime-stability-current-v1.json"
		avatar_cleanup_public_runtime_stability_current_signature="${avatar_cleanup_public_runtime_stability_current_body}.sig"
		avatar_cleanup_public_frontend_rebind_ready_body="$avatar_cleanup_public_root/frontend-runtime-rebind-ready-v1.json"
		avatar_cleanup_public_frontend_rebind_ready_signature="${avatar_cleanup_public_frontend_rebind_ready_body}.sig"
		removal_log="$temporary/removal.log"
		avatar_cleanup_fsync_directory() { :; }
		rm() {
			local removal_target="${@: -1}"
			if [[ "$1" == '-f' && "$2" == '--' && "$removal_target" == "$avatar_cleanup_public_root/"* ]]; then
				rm_calls=$((rm_calls + 1))
				printf '%s\n' "$(basename -- "$removal_target")" >>"$removal_log"
				if [[ "$rm_fail_at" -gt 0 && "$rm_calls" -eq "$rm_fail_at" ]]; then
					return 1
				fi
			fi
			command rm "$@"
		}
		for target in \
			"$avatar_cleanup_public_client_ready_signature" "$avatar_cleanup_public_client_retarget_ack_signature" \
			"$avatar_cleanup_public_runtime_stability_current_signature" "$avatar_cleanup_public_frontend_rebind_ready_signature" \
			"$avatar_cleanup_public_client_ready_body" "$avatar_cleanup_public_client_retarget_ack_body" \
			"$avatar_cleanup_public_runtime_stability_current_body" "$avatar_cleanup_public_frontend_rebind_ready_body"; do
			printf 'fixture\n' >"$target"
		done
		avatar_cleanup_remove_temporary_public_pairs
		[[ "$(<"$removal_log")" == $'client-ready-v1.json.sig\nclient-retarget-ack-v1.json.sig\nruntime-stability-current-v1.json.sig\nfrontend-runtime-rebind-ready-v1.json.sig\nclient-ready-v1.json\nclient-retarget-ack-v1.json\nruntime-stability-current-v1.json\nfrontend-runtime-rebind-ready-v1.json' ]]
		for target in \
			"$avatar_cleanup_public_client_ready_signature" "$avatar_cleanup_public_client_retarget_ack_signature" \
			"$avatar_cleanup_public_runtime_stability_current_signature" "$avatar_cleanup_public_frontend_rebind_ready_signature" \
			"$avatar_cleanup_public_client_ready_body" "$avatar_cleanup_public_client_retarget_ack_body" \
			"$avatar_cleanup_public_runtime_stability_current_body" "$avatar_cleanup_public_frontend_rebind_ready_body"; do
			[[ ! -e "$target" && ! -L "$target" ]]
		done
		: >"$removal_log"
		for target in \
			"$avatar_cleanup_public_client_ready_signature" "$avatar_cleanup_public_client_retarget_ack_signature" \
			"$avatar_cleanup_public_runtime_stability_current_signature" "$avatar_cleanup_public_frontend_rebind_ready_signature" \
			"$avatar_cleanup_public_client_ready_body" "$avatar_cleanup_public_client_retarget_ack_body" \
			"$avatar_cleanup_public_runtime_stability_current_body" "$avatar_cleanup_public_frontend_rebind_ready_body"; do
			printf 'fixture\n' >"$target"
		done
		rm_calls=0
		rm_fail_at=3
		! avatar_cleanup_remove_temporary_public_pairs
		[[ ! -e "$avatar_cleanup_public_client_ready_signature" &&
			! -e "$avatar_cleanup_public_client_retarget_ack_signature" &&
			-e "$avatar_cleanup_public_runtime_stability_current_signature" &&
			-e "$avatar_cleanup_public_frontend_rebind_ready_signature" &&
			-e "$avatar_cleanup_public_client_ready_body" && -e "$avatar_cleanup_public_client_retarget_ack_body" &&
			-e "$avatar_cleanup_public_runtime_stability_current_body" &&
			-e "$avatar_cleanup_public_frontend_rebind_ready_body" ]]
		rm_calls=0
		rm_fail_at=0
		avatar_cleanup_remove_temporary_public_pairs
		for target in \
			"$avatar_cleanup_public_client_ready_signature" "$avatar_cleanup_public_client_retarget_ack_signature" \
			"$avatar_cleanup_public_runtime_stability_current_signature" "$avatar_cleanup_public_frontend_rebind_ready_signature" \
			"$avatar_cleanup_public_client_ready_body" "$avatar_cleanup_public_client_retarget_ack_body" \
			"$avatar_cleanup_public_runtime_stability_current_body" "$avatar_cleanup_public_frontend_rebind_ready_body"; do
			[[ ! -e "$target" && ! -L "$target" ]]
		done
	)
	(
		local temporary lifecycle_private lifecycle_public complete_body_sha complete_signature_sha
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-key-retirement-self-test.XXXXXX")"
		chmod 700 "$temporary"
		trap 'rm -rf -- "$temporary"' EXIT
		avatar_cleanup_root="$temporary"
		avatar_cleanup_signing_key="$temporary/cleanup-hmac-key"
		avatar_cleanup_lifecycle_key_retirement_authorization="$temporary/authorization.json"
		avatar_cleanup_lifecycle_key_retirement="$temporary/evidence.json"
		avatar_cleanup_complete_body="$temporary/complete.json"
		avatar_cleanup_complete_signature="$temporary/complete.json.sig"
		lifecycle_private="$temporary/lifecycle-private.pem"
		lifecycle_public="$temporary/lifecycle-public.pem"
		IDENTITY_AVATAR_SIGNING_PRIVATE_KEY="$lifecycle_private"
		IDENTITY_AVATAR_SIGNING_PUBLIC_KEY="$lifecycle_public"
		IDENTITY_AVATAR_CLIENT_SIGNING_PUBLIC_KEY="$lifecycle_public"
		AVATAR_OWNERSHIP_REVISION="$owner"
		EXPECTED_REVISION="$cleanup"
		AVATAR_CLIENT_REVISION="$client"
		if [[ "$(id -u)" != '0' ]]; then chown() { :; }; fi
		LIFECYCLE_PRIVATE="$lifecycle_private" LIFECYCLE_PUBLIC="$lifecycle_public" node <<'NODE'
const fs=require('node:fs');const crypto=require('node:crypto');
const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(process.env.LIFECYCLE_PRIVATE,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
fs.writeFileSync(process.env.LIFECYCLE_PUBLIC,publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
NODE
		printf '{"schemaVersion":1}\n' >"$avatar_cleanup_complete_body"
		printf 'fixture-signature\n' >"$avatar_cleanup_complete_signature"
		chmod 600 "$avatar_cleanup_complete_body" "$avatar_cleanup_complete_signature"
		complete_body_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_complete_body")"
		complete_signature_sha="$(avatar_cleanup_sha256 "$avatar_cleanup_complete_signature")"
		avatar_cleanup_marker_value() {
			case "$1" in
			cleanup_complete_evidence_sha256) printf '%s\n' "$complete_body_sha" ;;
			cleanup_complete_signature_sha256) printf '%s\n' "$complete_signature_sha" ;;
			*) printf '%s\n' "$hash" ;;
			esac
		}
		avatar_cleanup_verify_public_cleanup_complete() { :; }
		avatar_cleanup_verify_temporary_routes_absent() { :; }
		avatar_cleanup_validate_temporary_public_files_absent() { :; }
		avatar_cleanup_validate_ownership_client_artifact() { :; }
		avatar_cleanup_validate_cleanup_complete_signature() { :; }
		avatar_cleanup_create_signing_key
		avatar_cleanup_create_lifecycle_key_retirement_authorization
		avatar_cleanup_validate_lifecycle_key_retirement_authorization \
			"$avatar_cleanup_lifecycle_key_retirement_authorization"
		# Crash after the signed authorization and durable private-key unlink but
		# before the HMAC retirement evidence must recover from public data only.
		rm -f -- "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY"
		avatar_cleanup_fsync_directory "$temporary"
		avatar_cleanup_retire_lifecycle_signing_key
		avatar_cleanup_validate_lifecycle_key_retirement_evidence
		rm -f -- "${avatar_cleanup_lifecycle_key_retirement}.hmac-sha256"
		avatar_cleanup_retire_lifecycle_signing_key
		avatar_cleanup_validate_lifecycle_key_retirement_evidence
		printf 'tamper\n' >>"$avatar_cleanup_lifecycle_key_retirement"
		rm -f -- "${avatar_cleanup_lifecycle_key_retirement}.hmac-sha256"
		! avatar_cleanup_retire_lifecycle_signing_key
	)
	(
		local temporary headers rendered invalid_rendered
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/avatar-cleanup-public-headers-self-test.XXXXXX")"
		trap 'rm -rf -- "$temporary"' EXIT
		headers="$temporary/headers"
		EXPECTED_REVISION="$cleanup"
		printf 'HTTP/2 200\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store, max-age=0\r\nX-Content-Type-Options: nosniff\r\nX-Winwidget-Revision: %s\r\n\r\n' \
			"$cleanup" >"$headers"
		avatar_cleanup_validate_public_headers "$headers" application/json
		printf 'HTTP/2 200\r\nContent-Type: application/json\r\nCache-Control: no-store, max-age=0, public\r\nX-Content-Type-Options: nosniff\r\nX-Winwidget-Revision: %s\r\n\r\n' \
			"$cleanup" >"$headers"
		! avatar_cleanup_validate_public_headers "$headers" application/json
		printf 'HTTP/2 200\r\nContent-Type: application/json\r\nCache-Control: no-store, max-age=0\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Winwidget-Revision: %s\r\n\r\n' \
			"$cleanup" >"$headers"
		! avatar_cleanup_validate_public_headers "$headers" application/json
		printf 'HTTP/2 404\r\nContent-Type: text/html\r\n\r\n' >"$headers"
		avatar_cleanup_validate_absent_route_headers "$headers"
		printf 'HTTP/2 302\r\nLocation: /elsewhere\r\n\r\n' >"$headers"
		! avatar_cleanup_validate_absent_route_headers "$headers"
		printf 'HTTP/2 404\r\nLocation: /elsewhere\r\n\r\n' >"$headers"
		! avatar_cleanup_validate_absent_route_headers "$headers"
		printf 'HTTP/2 404\r\n\r\nHTTP/2 404\r\n\r\n' >"$headers"
		! avatar_cleanup_validate_absent_route_headers "$headers"
		rendered="$temporary/complete.conf"
		invalid_rendered="$temporary/complete-without-charset.conf"
		avatar_cleanup_render_complete_nginx "$rendered"
		avatar_cleanup_validate_complete_nginx_config "$rendered"
		RENDERED="$rendered" node -e '
const value=require("node:fs").readFileSync(process.env.RENDERED,"utf8");
if((value.match(/default_type application\/json;/g)||[]).length!==1||
  (value.match(/charset utf-8;/g)||[]).length!==1||
  (value.match(/charset_types application\/json;/g)||[]).length!==1)process.exit(1);'
		sed '/charset utf-8;/d' "$rendered" >"$invalid_rendered"
		! avatar_cleanup_validate_complete_nginx_config "$invalid_rendered"
	)
	local source deploy_source nginx_source complete_nginx_source smoke_source observation_source retirement_source common_source audit_source client_source timer_source writer_source complete_source runtime_fence_source historical_source
	source="$(declare -f avatar_cleanup_require_common avatar_cleanup_capture_runtime_evidence \
		avatar_cleanup_capture_client_evidence avatar_cleanup_capture_manifest \
		avatar_cleanup_capture_reference_evidence avatar_cleanup_capture_identity_backup_and_restore \
		avatar_cleanup_require_verified_evidence avatar_cleanup_deploy)"
	deploy_source="$(declare -f avatar_cleanup_deploy)"
	nginx_source="$(declare -f avatar_cleanup_install_nginx)"
	complete_nginx_source="$(declare -f avatar_cleanup_install_complete_nginx)"
	smoke_source="$(declare -f avatar_cleanup_capture_clean_core_runtime \
		avatar_cleanup_validate_smoke_evidence_payload avatar_cleanup_smoke_core_runtime \
		avatar_cleanup_assert_completion_runtime_fence avatar_cleanup_capture_smokes)"
	observation_source="$(declare -f avatar_cleanup_validate_current_soak_contract \
		avatar_cleanup_capture_signed_observation_evidence)"
	retirement_source="$(declare -f avatar_cleanup_retire_legacy_objects \
		avatar_cleanup_load_retirement_credential avatar_cleanup_run_retirement_node \
		avatar_cleanup_verify_timeweb_provider_evidence \
		avatar_cleanup_prepare_retirement_inventory avatar_cleanup_validate_retirement_inventory \
		avatar_cleanup_prepare_retirement_journal avatar_cleanup_delete_sealed_legacy_objects \
		avatar_cleanup_validate_retirement_journal avatar_cleanup_prepare_uploads_retirement_inventory \
		avatar_cleanup_remove_uploads_copy avatar_cleanup_capture_widgets_storage_denial \
		avatar_cleanup_require_retirement_policy_evidence avatar_cleanup_recover_retirement_attempt_signature \
		avatar_cleanup_require_revocation_evidence \
		avatar_cleanup_validate_revocation_evidence)"
	common_source="$(declare -f avatar_cleanup_require_common)"
	audit_source="$(declare -f avatar_cleanup_load_storage_environment \
		avatar_cleanup_load_audit_environment avatar_cleanup_capture_manifest)"
	client_source="$(declare -f avatar_cleanup_validate_ownership_client_artifact \
		avatar_cleanup_capture_client_evidence)"
	timer_source="$(declare -f avatar_cleanup_load_observation_timer_binding \
		avatar_cleanup_load_current_soak_timer_status avatar_cleanup_validate_soak_timer_fence_payload \
		avatar_cleanup_validate_soak_timer_fence_evidence \
		avatar_cleanup_fence_soak_timer)"
	writer_source="$(declare -f avatar_cleanup_write_writer_evidence avatar_cleanup_validate_writer_evidence_payload \
		avatar_cleanup_recover_writer_fence_marker avatar_cleanup_stop_legacy_writer)"
	complete_source="$(declare -f avatar_cleanup_create_cleanup_complete_evidence \
		avatar_cleanup_validate_cleanup_complete_body avatar_cleanup_validate_cleanup_complete_signature \
		avatar_cleanup_publish_cleanup_complete avatar_cleanup_install_complete_nginx \
		avatar_cleanup_render_complete_nginx avatar_cleanup_validate_complete_nginx_config \
		avatar_cleanup_validate_public_headers avatar_cleanup_verify_public_cleanup_complete \
		avatar_cleanup_validate_absent_route_headers \
		avatar_cleanup_verify_temporary_routes_absent avatar_cleanup_validate_temporary_public_files_absent \
		avatar_cleanup_remove_temporary_public_pairs \
		avatar_cleanup_create_lifecycle_key_retirement_authorization \
		avatar_cleanup_validate_lifecycle_key_retirement_authorization \
		avatar_cleanup_retire_lifecycle_signing_key avatar_cleanup_bind_lifecycle_key_retirement \
		avatar_cleanup_validate_lifecycle_key_retirement_evidence_payload \
		avatar_cleanup_validate_lifecycle_key_retirement_evidence_local \
		avatar_cleanup_validate_lifecycle_key_retirement_evidence)"
	runtime_fence_source="$(declare -f avatar_cleanup_assert_runtime_service \
		avatar_cleanup_assert_identity_runtime avatar_cleanup_assert_forward_identity_runtime \
		avatar_cleanup_capture_clean_core_runtime avatar_cleanup_assert_completion_runtime_fence)"
	historical_source="$(declare -f avatar_cleanup_materialize_lifecycle_validator \
		avatar_cleanup_compute_ownership_context avatar_cleanup_validate_inherited_contract)"
	[[ "$source" == *'merge-base --is-ancestor'* &&
		( "$source" == *'identity_avatar_media'* || "$source" == *'identity-avatar-media'* ) ]] || return 1
	[[ "$source" == *'avatar_cleanup_capture_identity_backup_and_restore'* &&
		"$source" == *'identity_cutover_run_restore_rehearsal post-ownership'* &&
		"$source" == *'identity.outbox_events'* && "$source" == *'identity.consumer_failures'* &&
		"$source" == *'WIDGETS_BACKUP_URL'* && "$source" == *'DATABASE_BACKUP_URL'* &&
		"$source" == *"fetch(url"* && "$source" == *"contentType !== 'image/webp'"* &&
		"$source" == *"body.subarray(8, 12).toString('ascii') !== 'WEBP'"* ]] || return 1
	[[ "$audit_source" == *'IDENTITY_AVATAR_S3_ENDPOINT'* &&
		"$audit_source" == *'S3_KEY_PREFIX'* &&
		"$audit_source" != *'S3_ACCESS_KEY_ID'* && "$audit_source" != *'S3_SECRET_ACCESS_KEY'* &&
		"$audit_source" != *'ListObjectsV2Command'* ]] || return 1
	[[ "$common_source" == *'legacy Core file module still exists'* &&
		"$common_source" == *'legacy Core S3 dependency remains'* &&
		"$common_source" == *'legacy Core uploads filesystem contract remains'* &&
		"$common_source" == *'Identity avatar attestation nginx include is absent or duplicated'* &&
		"$common_source" == *"@Post('profile/avatar')"* &&
		"$common_source" == *"@Delete('user/:id/avatar')"* ]] || return 1
	[[ "$observation_source" == *'identity_avatar_validate_soak_heartbeat_chain'* &&
		"$observation_source" == *'identity_avatar_validate_soak_evidence'* &&
		"$observation_source" == *'identity-avatar-client-log-soak'* &&
		"$observation_source" == *'logConfigurationSha256'* &&
		"$observation_source" == *"JSON.stringify(value.hosts) !== JSON.stringify(['winwidget.ru','www.winwidget.ru'])"* &&
		"$observation_source" == *'value.apiV1FilesRequestCount !== 0'* &&
		"$observation_source" == *'value.uploadsSuccessfulGetHeadCount !== 0'* &&
		"$observation_source" == *'604800000'* && "$observation_source" == *'93600'* &&
		"$observation_source" != *'LOG_ROOT='* && "$observation_source" != *'MIN_SECONDS='* ]] || return 1
	[[ "$smoke_source" == *'/api/v1/files?folder='* &&
		"$smoke_source" == *'/api/v1/files?filePath='* &&
		"$smoke_source" == *'/uploads/avatar-cleanup-'* &&
		"$smoke_source" == *'AVATAR_PUBLIC_ORIGIN'* &&
		"$smoke_source" == *"'writerFenceEvidenceSha256','coreRuntime','checks','verifiedAt'"* &&
		"$smoke_source" == *'avatar_cleanup_assert_completion_runtime_fence'* &&
		"$smoke_source" != *'/api/v1/files/avatar-cleanup-'* ]] || return 1
	[[ "$runtime_fence_source" == *"['containerId','imageId','ociRevision','startedAt','restartCount','health']"* &&
		"$runtime_fence_source" == *'JSON.stringify(actual) !== JSON.stringify(expected)'* &&
		"$runtime_fence_source" == *'avatar_cleanup_assert_public_client_revision forward'* &&
		"$runtime_fence_source" == *'avatar_cleanup_assert_forward_identity_runtime'* &&
		"$runtime_fence_source" == *'avatar_cleanup_capture_clean_core_runtime'* ]] || return 1
	[[ "$historical_source" == *'SERVER_ROOT="$validator_root"'* &&
		"$historical_source" == *'SERVER_ROOT="$actual_server_root"'* &&
		"$historical_source" == *'identity_avatar_validate_runtime_stability_chain bound'* &&
		"$historical_source" == *'identity_avatar_validate_cleanup_retarget_evidence "$cleanup_revision"'* ]] || return 1
	[[ "$retirement_source" == *'AVATAR_RETIREMENT_CREDENTIAL_FILE'* &&
		"$retirement_source" == *'missing-legacy-head-allowed'* && "$retirement_source" == *'new-delete-denied'* &&
		"$retirement_source" == *'missing-legacy-delete-allowed'* &&
		"$retirement_source" == *'managed-public-bytes-preflight-intact'* &&
		"$retirement_source" == *'avatar-legacy-s3-sealed-inventory'* &&
		"$retirement_source" == *'legacy-exact-prefix-list-allowed'* &&
		"$retirement_source" == *'legacy-exact-prefix-version-list-allowed'* &&
		"$retirement_source" == *'ListObjectVersionsCommand'* && "$retirement_source" == *'VersionId: source.versionId'* &&
		"$retirement_source" == *"versionId !== 'null'"* && "$retirement_source" == *'compareUtf8'* &&
		"$retirement_source" == *'legacyVersionsEmpty'* &&
		"$retirement_source" == *'avatar-legacy-s3-retirement-journal-header'* &&
		"$retirement_source" == *'avatar-legacy-s3-retirement-preflight'* &&
		"$retirement_source" == *'avatar-legacy-s3-retirement-intent'* &&
		"$retirement_source" == *'avatar-legacy-s3-retirement-confirmed'* &&
		"$retirement_source" == *'storageEndpointSha256'* &&
		"$retirement_source" == *'retirementPolicyEvidenceSha256'* &&
		"$retirement_source" == *'orphanObjectCount'* &&
		"$retirement_source" == *'legacy-exact-prefix-empty'* &&
		"$retirement_source" == *'avatar-live-widgets-storage-denial'* &&
		"$retirement_source" == *'avatar_cleanup_recover_retirement_attempt_signature'* &&
		"$retirement_source" == *"verifyPrefix('legacy'"* &&
		"$retirement_source" == *'ListObjectsV2Command'* && "$retirement_source" == *'openssl pkeyutl -verify'* &&
		"$retirement_source" == *"value.provider !== 'timeweb-s3'"* &&
		"$retirement_source" == *'target=$avatar_cleanup_retirement_credential_container_path,readonly'* &&
		"$retirement_source" == *'--user 0:0'* && "$retirement_source" == *'--rm -i'* &&
		"$retirement_source" == *"readFileSync('/run/secrets/winwidget-avatar-retirement-v1'"* &&
		"$retirement_source" != *'AVATAR_AUDIT_ACCESS_KEY_ID'* &&
		"$retirement_source" != *'AVATAR_RETIREMENT_ACCESS_KEY_ID'* &&
		"$retirement_source" != *'AVATAR_RETIREMENT_SECRET_ACCESS_KEY'* &&
		"$retirement_source" == *'-rawin'* ]] || return 1
	[[ "$client_source" == *'clientTrustBootstrapEvidenceSha256'* &&
		"$client_source" == *'releaseFullManifestSha256'* &&
		"$client_source" == *'preClientReferenceZeroEvidenceSha256'* &&
		"$client_source" == *'clientSwitchReferenceZeroEvidenceSha256'* &&
		"$client_source" == *'identity-avatar-client-switch-reference-zero'* &&
		"$client_source" == *'clientReadyEvidenceSignatureSha256'* &&
		"$client_source" == *'identity-avatar-client-trust-bootstrap'* &&
		"$client_source" == *'/opt/winwidget/deploy/backend/.identity-avatar-client-signing.public.pem'* &&
		"$client_source" != *'Date.now() >= Date.parse(value.expiresAt)'* ]] || return 1
	[[ "$complete_source" == *'identity-avatar-core-cleanup-complete'* &&
		"$complete_source" == *"'clientReadyEvidenceSignatureSha256'"* &&
		"$complete_source" == *"'predeployUploadsHandoffSha256'"* &&
		"$complete_source" == *"'cleanupRetargetEvidenceSha256'"* &&
		"$complete_source" == *'cleanup-complete-v1.json.sig'* &&
		"$complete_source" == *'application/json; charset=utf-8'* &&
		"$complete_source" == *'--max-redirs 0'* &&
		"$complete_source" == *'client-ready-v1.json.sig'* &&
		"$complete_source" == *'target is absent without a recoverable client-ready backup'* &&
		"$complete_source" == *"JSON.stringify(['no-store','max-age=0'])"* &&
		"$complete_source" == *'identity-avatar-lifecycle-key-retirement-authorization'* &&
		"$complete_source" == *'avatar-lifecycle-signing-key-retirement'* &&
		"$complete_source" == *'rm -f -- "$IDENTITY_AVATAR_SIGNING_PRIVATE_KEY"'* ]] || return 1
	[[ "$timer_source" == *'avatar-backend-soak-timer-fence'* &&
		"$timer_source" == *'identity-avatar-soak-timer-status'* &&
		"$timer_source" == *'systemctl disable --now winwidget-identity-avatar-soak-heartbeat.timer'* &&
		"$timer_source" == *"== 'disabled'"* && "$timer_source" == *"== 'inactive'"* &&
		"$timer_source" == *'observationEvidenceSha256'* && "$timer_source" == *'timerStatusSha256'* ]] || return 1
	[[ "$writer_source" == *'soakTimerFenceEvidenceSha256'* &&
		"$writer_source" == *'avatar_cleanup_fence_soak_timer'* ]] || return 1
	[[ "$nginx_source" == *'nginx -t'* && "$nginx_source" == *'systemctl reload nginx'* &&
		"$nginx_source" == *'ambiguous nginx crash-recovery state'* &&
		"$nginx_source" == *'only the config was rolled back'* ]] || return 1
	COMPLETE_NGINX_SOURCE="$complete_nginx_source" node <<'NODE' || return 1
const value=process.env.COMPLETE_NGINX_SOURCE;
const missing=value.indexOf('target is absent without a recoverable client-ready backup');
const restoreMissing=value.indexOf('install -o root -g root -m 644 "$backup" "$restore"',missing);
const fast=value.indexOf('if [[ "$target_sha" == "$source_sha" ]]');
const test=value.indexOf('nginx -t',fast);
const remove=value.indexOf('rm -f -- "$backup"',test);
if([missing,restoreMissing,fast,test,remove].some(item=>item<0)||
  !(missing<restoreMissing&&restoreMissing<fast&&fast<test&&test<remove))process.exit(1);
NODE
	CLEANUP_SOURCE_FILE="$AVATAR_SCRIPT_ROOT/scripts/cleanup-avatar-core-source-production.sh" node <<'NODE' || return 1
const fs=require('node:fs');
const source=fs.readFileSync(process.env.CLEANUP_SOURCE_FILE,'utf8');
const functionBlock=name=>{
  const start=source.indexOf(`${name}() {`);
  if(start<0)process.exit(1);
  const next=/^avatar_cleanup_[a-z0-9_]+\(\) [({]$/m.exec(source.slice(start+name.length+5));
  return source.slice(start,next?start+name.length+5+next.index:source.length);
};
const literalArray=(block,marker)=>{
  const start=block.indexOf(marker);const end=block.indexOf('];',start);
  if(start<0||end<=start)process.exit(1);
  return [...block.slice(start+marker.length,end).matchAll(/'([^']+)'/g)].map(match=>match[1]);
};
const expectedComplete=['schemaVersion','kind','cleanupPhase','ownershipRevision','currentRuntimeRevision',
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
const expectedFrontend=['bindingKind','evidenceSha256','evidenceSignatureSha256','clientRevision','imageId',
  'releaseEvidenceSha256','releaseEvidenceSignatureSha256','releaseTreeSha256',
  'releaseFullManifestSha256','processStartedAt'];
const validator=functionBlock('avatar_cleanup_validate_cleanup_complete_body');
if(JSON.stringify(literalArray(validator,'const keys = ['))!==JSON.stringify(expectedComplete)||
  JSON.stringify(literalArray(validator,'const frontendKeys = ['))!==JSON.stringify(expectedFrontend))process.exit(1);
const producer=functionBlock('avatar_cleanup_create_cleanup_complete_evidence');
const objectStart=producer.indexOf('const value = {');const objectEnd=producer.indexOf('\n};',objectStart);
if(objectStart<0||objectEnd<=objectStart)process.exit(1);
const producerKeys=[...producer.slice(objectStart,objectEnd).matchAll(/(?:\{|,)\s*([A-Za-z][A-Za-z0-9]*)\s*:/g)]
  .map(match=>match[1]);
if(JSON.stringify(producerKeys)!==JSON.stringify(expectedComplete))process.exit(1);
const expectedAuthorization=['version','kind','ownershipRevision','cleanupRevision','clientRevision',
  'cleanupCompleteEvidenceSha256','cleanupCompleteSignatureSha256','lifecyclePublicKeyPath',
  'lifecyclePublicKeySha256','lifecyclePublicKeySpkiSha256','lifecyclePrivateKeyPathSha256',
  'lifecyclePrivateKeySha256','privatePublicKeySpkiSha256','authorizedAt','signature'];
const authorization=functionBlock('avatar_cleanup_validate_lifecycle_key_retirement_authorization');
if(JSON.stringify(literalArray(authorization,'const keys=['))!==JSON.stringify(expectedAuthorization))process.exit(1);
const expectedRetirement=['version','action','ownershipRevision','cleanupRevision','clientRevision',
  'authorizationEvidenceSha256','lifecyclePublicKeySha256','lifecyclePublicKeySpkiSha256',
  'lifecyclePrivateKeyPathSha256','lifecyclePrivateKeySha256','privateKeyAbsent','publicCleanupCompleteVerified',
  'temporaryBackendRoutesAbsent','lifecyclePublicKeyRetained','frontendPublicKeyRetained','retiredAt'];
const retirement=functionBlock('avatar_cleanup_validate_lifecycle_key_retirement_evidence_payload');
if(JSON.stringify(literalArray(retirement,'const keys=['))!==JSON.stringify(expectedRetirement))process.exit(1);
const publish=functionBlock('avatar_cleanup_publish_cleanup_complete');
const signature=publish.indexOf('avatar_cleanup_publish_public_copy "$avatar_cleanup_complete_signature"');
const body=publish.indexOf('avatar_cleanup_publish_public_copy "$avatar_cleanup_complete_body"',signature);
const install=publish.indexOf('avatar_cleanup_install_complete_nginx',body);
const permanentOne=publish.indexOf('avatar_cleanup_verify_public_cleanup_complete',install);
const temporaryOne=publish.indexOf('avatar_cleanup_verify_temporary_routes_absent',permanentOne);
const remove=publish.indexOf('avatar_cleanup_remove_temporary_public_pairs',temporaryOne);
const permanentTwo=publish.indexOf('avatar_cleanup_verify_public_cleanup_complete',remove);
const temporaryTwo=publish.indexOf('avatar_cleanup_verify_temporary_routes_absent',permanentTwo);
if([signature,body,install,permanentOne,temporaryOne,remove,permanentTwo,temporaryTwo].some(index=>index<0)||
  !(signature<body&&body<install&&install<permanentOne&&permanentOne<temporaryOne&&temporaryOne<remove&&
    remove<permanentTwo&&permanentTwo<temporaryTwo))process.exit(1);
const withdrawal=functionBlock('avatar_cleanup_remove_temporary_public_pairs');
const signatureNames=['avatar_cleanup_public_client_ready_signature','avatar_cleanup_public_client_retarget_ack_signature',
  'avatar_cleanup_public_runtime_stability_current_signature','avatar_cleanup_public_frontend_rebind_ready_signature'];
const bodyNames=['avatar_cleanup_public_client_ready_body','avatar_cleanup_public_client_retarget_ack_body',
  'avatar_cleanup_public_runtime_stability_current_body','avatar_cleanup_public_frontend_rebind_ready_body'];
const signaturePositions=signatureNames.map(name=>withdrawal.indexOf(name));
const bodyPositions=bodyNames.map(name=>withdrawal.indexOf(name));
if([...signaturePositions,...bodyPositions].some(index=>index<0)||
  Math.max(...signaturePositions)>=Math.min(...bodyPositions))process.exit(1);
const deploy=functionBlock('avatar_cleanup_deploy');
const create=deploy.lastIndexOf('avatar_cleanup_create_cleanup_complete_evidence');
const fenceBefore=deploy.lastIndexOf('avatar_cleanup_assert_completion_runtime_fence',create);
const fenceAfter=deploy.indexOf('avatar_cleanup_assert_completion_runtime_fence',create);
const markComplete=deploy.indexOf('avatar_cleanup_update_forward_marker complete',fenceAfter);
const publishComplete=deploy.indexOf('avatar_cleanup_publish_cleanup_complete',markComplete);
const recoveryStart=deploy.indexOf('if [[ "$(avatar_cleanup_marker_value phase)" == \'complete\' ]]');
const recoveryEnd=deploy.indexOf('\n\tfi',recoveryStart);
const recovery=recoveryStart>=0&&recoveryEnd>recoveryStart?deploy.slice(recoveryStart,recoveryEnd):'';
if([create,fenceBefore,fenceAfter,markComplete,publishComplete].some(index=>index<0)||
  !(fenceBefore<create&&create<fenceAfter&&fenceAfter<markComplete&&markComplete<publishComplete)||
  !recovery.includes('avatar_cleanup_publish_cleanup_complete')||
  !recovery.includes('avatar_cleanup_bind_lifecycle_key_retirement')||
  recovery.includes('avatar_cleanup_assert_completion_runtime_fence'))process.exit(1);
NODE
	DEPLOY_SOURCE="$deploy_source" node <<'NODE' || return 1
const value = process.env.DEPLOY_SOURCE;
const evidence = value.indexOf('avatar_cleanup_require_verified_evidence');
const verifiedSoak = value.indexOf('avatar_cleanup_validate_current_soak_contract', evidence);
const forwardCase = value.indexOf('forward-only)', verifiedSoak);
const stop = value.indexOf('avatar_cleanup_stop_legacy_writer', evidence);
const retire = value.indexOf('avatar_cleanup_retire_legacy_objects', stop);
const revocation = value.indexOf('avatar_cleanup_require_revocation_evidence', retire);
const start = value.indexOf('avatar_cleanup_start_clean_core', revocation);
const nginx = value.indexOf('avatar_cleanup_install_nginx', start);
const smoke = value.indexOf('avatar_cleanup_capture_smokes', nginx);
const localComplete = value.indexOf('avatar_cleanup_create_cleanup_complete_evidence', smoke);
const complete = value.indexOf('avatar_cleanup_update_forward_marker complete', smoke);
const publicComplete = value.indexOf('avatar_cleanup_publish_cleanup_complete', complete);
const retireLifecycleKey = value.indexOf('avatar_cleanup_bind_lifecycle_key_retirement', publicComplete);
if ([evidence, verifiedSoak, forwardCase, stop, retire, start, nginx, smoke, revocation,
    localComplete, complete, publicComplete, retireLifecycleKey].some(item => item < 0) ||
    !(evidence < verifiedSoak && verifiedSoak < forwardCase && forwardCase < stop) ||
    !(evidence < stop && stop < retire && retire < revocation && revocation < start && start < nginx &&
      nginx < smoke && smoke < localComplete && localComplete < complete && complete < publicComplete &&
      publicComplete < retireLifecycleKey) ||
    /\bmigrate\s+(?:deploy|dev|reset)\b/.test(value) || value.includes('--profile migration')) process.exit(1);
NODE
	printf 'avatar_core_cleanup_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--verify) avatar_cleanup_verify ;;
	--deploy | --forward-recovery) avatar_cleanup_deploy ;;
	--status) avatar_cleanup_status ;;
	--guard-before-fetch-revision | --guard-before-checkout-revision)
		[[ $# -eq 2 ]] || exit 1
		avatar_cleanup_guard_revision "$1" "$2"
		;;
	--self-test) avatar_cleanup_self_test ;;
	*) avatar_cleanup_fail 'Usage: cleanup-avatar-core-source-production.sh --verify|--deploy|--forward-recovery|--status|--guard-before-fetch-revision SHA|--guard-before-checkout-revision SHA|--self-test' ;;
	esac
fi
