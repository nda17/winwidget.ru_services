#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

IDENTITY_SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
IDENTITY_CORE_CLEANUP_MIGRATION="${IDENTITY_CORE_CLEANUP_MIGRATION:-20260815000000_remove_legacy_identity_core_source}"
IDENTITY_CORE_CLEANUP_MIGRATION_SHA256="${IDENTITY_CORE_CLEANUP_MIGRATION_SHA256:-}"
IDENTITY_CORE_CLEANUP_SOAK_SECONDS="${IDENTITY_CORE_CLEANUP_SOAK_SECONDS:-}"
IDENTITY_ENV_EXPECTED_SHA256="${IDENTITY_ENV_EXPECTED_SHA256:-}"
identity_cleanup_root="${IDENTITY_CORE_CLEANUP_ARTIFACT_ROOT:-$APP_ROOT/deploy/backend/identity-core-cleanup-artifacts}"
identity_cleanup_marker="${IDENTITY_CORE_CLEANUP_MARKER:-$APP_ROOT/deploy/backend/.identity-core-cleanup-v1}"
identity_cleanup_signing_marker="${IDENTITY_CORE_SIGNING_ENV_MARKER:-$APP_ROOT/deploy/backend/.identity-core-signing-env-removal-v1}"
identity_cleanup_signing_candidate="${identity_cleanup_signing_marker}.prepared-env"
identity_cleanup_core_backup="$identity_cleanup_root/core-frozen-pre-cleanup.dump"
identity_cleanup_identity_backup="$identity_cleanup_root/identity-pre-core-cleanup.dump"
identity_cleanup_identity_restore="$identity_cleanup_root/identity-pre-core-cleanup-restore.json"
identity_cleanup_queue_evidence="$identity_cleanup_root/queue-drain-evidence.json"
identity_cleanup_stopped_writers_evidence="$identity_cleanup_root/stopped-writers-evidence.json"
identity_cleanup_soak_evidence="$identity_cleanup_root/soak-stable-runtime-evidence.json"
identity_cleanup_post_core_backup="$identity_cleanup_root/core-post-cleanup.dump"
identity_cleanup_core_backup_journal="${identity_cleanup_core_backup}.capture-v1"
identity_cleanup_identity_backup_journal="${identity_cleanup_identity_backup}.capture-v1"
identity_cleanup_post_core_backup_journal="${identity_cleanup_post_core_backup}.capture-v1"

readonly identity_cleanup_confirmation='CLEANUP IDENTITY CORE SOURCE'

# shellcheck source=scripts/identity-cutover-production.sh
source "$IDENTITY_SCRIPT_ROOT/scripts/identity-cutover-production.sh"

identity_cleanup_fail() {
	printf 'identity_core_cleanup_error=%s\n' "$1" >&2
	return 1
}

identity_cleanup_validate_signing_marker() {
	[[ -f "$identity_cleanup_signing_marker" && ! -L "$identity_cleanup_signing_marker" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_cleanup_signing_marker")" == '0:0:600' ]] || return 1
	fi
	awk -F= '
	    $1 !~ /^(version|phase|cleanup_revision|source_sha256|result_sha256|updated_at)$/ { exit 1 }
	    { count[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
	    END {
	      for (key in count) if (count[key] != 1) exit 1
	      if (NR != 6 || value["version"] != "1" ||
	          value["phase"] !~ /^(prepared|complete)$/ ||
	          value["cleanup_revision"] !~ /^[0-9a-f]{40}$/ ||
	          value["source_sha256"] !~ /^[0-9a-f]{64}$/ ||
	          value["result_sha256"] !~ /^[0-9a-f]{64}$/ ||
	          value["source_sha256"] == sprintf("%064d", 0) ||
	          value["result_sha256"] == sprintf("%064d", 0) ||
	          value["source_sha256"] == value["result_sha256"] ||
	          value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
    }
  ' "$identity_cleanup_signing_marker"
}

identity_cleanup_write_signing_marker() {
	[[ $# -eq 3 && "$1" =~ ^(prepared|complete)$ && "$2" =~ ^[0-9a-f]{64}$ &&
		"$3" =~ ^[0-9a-f]{64}$ && "$2" != "$3" ]] || return 1
	local current='absent' temporary="${identity_cleanup_signing_marker}.tmp.$$"
	if [[ -e "$identity_cleanup_signing_marker" || -L "$identity_cleanup_signing_marker" ]]; then
		identity_cleanup_validate_signing_marker || return 1
		current="$(identity_cleanup_signing_marker_value phase)"
		[[ "$(identity_cleanup_signing_marker_value cleanup_revision)" == "$EXPECTED_REVISION" &&
			"$(identity_cleanup_signing_marker_value source_sha256)" == "$2" &&
			"$(identity_cleanup_signing_marker_value result_sha256)" == "$3" ]] || return 1
	fi
	case "$current:$1" in
	absent:prepared | prepared:prepared | prepared:complete | complete:complete) ;;
	*) return 1 ;;
	esac
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	{
		printf 'version=1\nphase=%s\ncleanup_revision=%s\n' "$1" "$EXPECTED_REVISION"
		printf 'source_sha256=%s\nresult_sha256=%s\n' "$2" "$3"
		printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$identity_cleanup_signing_marker"
	identity_cleanup_validate_signing_marker
}

identity_cleanup_signing_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z0-9_]+$ ]] || return 1
	identity_cleanup_validate_signing_marker || return 1
	awk -F= -v key="$1" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$identity_cleanup_signing_marker"
}

identity_cleanup_env_sha256() {
	identity_cutover_sha256 "$ENV_FILE"
}

identity_cleanup_require_env_source_sha() {
	[[ "$IDENTITY_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
		identity_cleanup_fail 'exact local canonical backend env SHA-256 is required' || return 1
	local current_sha
	current_sha="$(identity_cleanup_env_sha256)" || return 1
	if [[ -e "$identity_cleanup_signing_marker" || -L "$identity_cleanup_signing_marker" ]]; then
		identity_cleanup_validate_signing_marker || return 1
		local phase source_sha result_sha
		phase="$(identity_cleanup_signing_marker_value phase)"
		source_sha="$(identity_cleanup_signing_marker_value source_sha256)"
		result_sha="$(identity_cleanup_signing_marker_value result_sha256)"
		[[ "$(identity_cleanup_signing_marker_value cleanup_revision)" == "$EXPECTED_REVISION" &&
			( "$IDENTITY_ENV_EXPECTED_SHA256" == "$source_sha" ||
				"$IDENTITY_ENV_EXPECTED_SHA256" == "$result_sha" ) &&
			( ( "$phase" == 'prepared' && ( "$current_sha" == "$source_sha" || "$current_sha" == "$result_sha" ) ) ||
				( "$phase" == 'complete' && "$current_sha" == "$result_sha" ) ) ]] ||
			identity_cleanup_fail 'backend env drifted after Core signing-key removal' || return 1
	else
		[[ "$current_sha" == "$IDENTITY_ENV_EXPECTED_SHA256" ]] ||
			identity_cleanup_fail 'server backend env differs from the local canonical source copy' || return 1
	fi
}

identity_cleanup_build_signing_candidate() {
	[[ $# -eq 2 && -f "$1" && ! -L "$1" && ! -e "$2" && ! -L "$2" ]] || return 1
	node - "$1" "$2" <<'NODE'
const { chmodSync, chownSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const source = process.argv[2];
const destination = process.argv[3];
const content = readFileSync(source, 'utf8');
const remove = new Set(['JWT_ACCESS_PRIVATE_KEY_BASE64', 'JWT_ACCESS_JWKS_BASE64', 'JWT_ACCESS_ACTIVE_KID']);
const identity = new Set(['IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64', 'IDENTITY_JWT_ACCESS_JWKS_BASE64', 'IDENTITY_JWT_ACCESS_ACTIVE_KID']);
const counts = new Map();
const values = new Map();
const retained = [];
for (const line of content.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!match) { retained.push(line); continue; }
  counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  values.set(match[1], match[2].replace(/\r$/, '').trim());
  if (!remove.has(match[1])) retained.push(line);
}
if ([...counts.values()].some(count => count !== 1) ||
    [...remove].some(key => counts.get(key) !== 1 || !values.get(key)) ||
    [...identity].some(key => counts.get(key) !== 1 || !values.get(key))) process.exit(1);
const output = `${retained.join('\n').replace(/\n+$/, '')}\n`;
try {
  writeFileSync(destination, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  if (typeof process.getuid !== 'function' || process.getuid() === 0) chownSync(destination, 0, 0);
  chmodSync(destination, 0o600);
} catch (error) {
  try { unlinkSync(destination); } catch {}
  throw error;
}
NODE
	identity_cutover_validate_private_file "$2"
}

identity_cleanup_validate_backup_journal() {
	[[ $# -eq 6 ]] || return 1
	local journal="$1" url_key="$2" schema="$3" destination="$4" ownership_revision="$5" cleanup_revision="$6"
	identity_cutover_validate_private_file "$journal" || return 1
	awk -F= '
	    $1 !~ /^(version|phase|url_key|schema|artifact_name|ownership_revision|cleanup_revision|sha256|updated_at)$/ { exit 1 }
	    { count[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
	    END {
	      for (key in count) if (count[key] != 1) exit 1
	      if (NR != 9 || value["version"] != "1" ||
	          value["phase"] !~ /^(prepared|complete)$/ ||
	          value["url_key"] !~ /^(DATABASE_BACKUP_URL|IDENTITY_BACKUP_URL)$/ ||
	          value["schema"] !~ /^(public|identity)$/ ||
	          value["artifact_name"] !~ /^[A-Za-z0-9._-]+$/ ||
	          value["ownership_revision"] !~ /^[0-9a-f]{40}$/ ||
	          value["cleanup_revision"] !~ /^[0-9a-f]{40}$/ ||
	          value["sha256"] !~ /^[0-9a-f]{64}$/ ||
	          value["sha256"] == sprintf("%064d", 0) ||
	          value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
	    }
	  ' "$journal" || return 1
	[[ "$(identity_cleanup_backup_journal_value "$journal" url_key)" == "$url_key" &&
		"$(identity_cleanup_backup_journal_value "$journal" schema)" == "$schema" &&
		"$(identity_cleanup_backup_journal_value "$journal" artifact_name)" == "$(basename -- "$destination")" &&
		"$(identity_cleanup_backup_journal_value "$journal" ownership_revision)" == "$ownership_revision" &&
		"$(identity_cleanup_backup_journal_value "$journal" cleanup_revision)" == "$cleanup_revision" ]]
}

identity_cleanup_backup_journal_value() {
	[[ $# -eq 2 && "$2" =~ ^[a-z0-9_]+$ ]] || return 1
	awk -F= -v key="$2" '
	    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
	    END { exit(found == 1 ? 0 : 1) }
	  ' "$1"
}

identity_cleanup_write_backup_journal() {
	[[ $# -eq 7 && "$2" =~ ^(prepared|complete)$ && "$6" =~ ^[0-9a-f]{40}$ &&
		"$7" =~ ^[0-9a-f]{64}$ ]] || return 1
	local journal="$1" phase="$2" url_key="$3" schema="$4" destination="$5"
	local ownership_revision="$6" artifact_sha="$7" current='absent'
	local temporary="${journal}.tmp.$$"
	if [[ -e "$journal" || -L "$journal" ]]; then
		identity_cleanup_validate_backup_journal "$journal" "$url_key" "$schema" "$destination" \
			"$ownership_revision" "$EXPECTED_REVISION" || return 1
		current="$(identity_cleanup_backup_journal_value "$journal" phase)"
		if [[ "$current" == 'complete' || "$phase" == 'complete' ]]; then
			[[ "$(identity_cleanup_backup_journal_value "$journal" sha256)" == "$artifact_sha" ]] || return 1
		fi
	fi
	case "$current:$phase" in
	absent:prepared | prepared:prepared | prepared:complete | complete:complete) ;;
	*) return 1 ;;
	esac
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	{
		printf 'version=1\nphase=%s\nurl_key=%s\nschema=%s\n' "$phase" "$url_key" "$schema"
		printf 'artifact_name=%s\nownership_revision=%s\ncleanup_revision=%s\n' \
			"$(basename -- "$destination")" "$ownership_revision" "$EXPECTED_REVISION"
		printf 'sha256=%s\nupdated_at=%s\n' "$artifact_sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$journal"
	identity_cleanup_validate_backup_journal "$journal" "$url_key" "$schema" "$destination" \
		"$ownership_revision" "$EXPECTED_REVISION"
}

identity_cleanup_create_backup() (
	[[ $# -eq 5 && "$5" =~ ^[0-9a-f]{40}$ ]] || return 1
	local url_key="$1" schema="$2" destination="$3" journal="$4" ownership_revision="$5"
	local phase artifact_sha staging="${destination}.prepared"
	identity_cutover_cleanup_backup_partials "$destination" || return 1
	if [[ -e "$journal" || -L "$journal" ]]; then
		identity_cleanup_validate_backup_journal "$journal" "$url_key" "$schema" "$destination" \
			"$ownership_revision" "$EXPECTED_REVISION" || return 1
		phase="$(identity_cleanup_backup_journal_value "$journal" phase)"
		artifact_sha="$(identity_cleanup_backup_journal_value "$journal" sha256)"
		if [[ -e "$destination" || -L "$destination" ]]; then
			[[ ! -e "$staging" && ! -L "$staging" ]] || return 1
			identity_cutover_validate_backup_file "$destination" || return 1
			[[ "$(identity_cutover_sha256 "$destination")" == "$artifact_sha" ]] || return 1
			if [[ "$phase" == 'prepared' ]]; then
				identity_cleanup_write_backup_journal "$journal" complete "$url_key" "$schema" \
					"$destination" "$ownership_revision" "$artifact_sha"
			fi
			return
		fi
		[[ "$phase" == 'prepared' && -f "$staging" && ! -L "$staging" ]] || return 1
		identity_cutover_validate_backup_file "$staging" || return 1
		[[ "$(identity_cutover_sha256 "$staging")" == "$artifact_sha" ]] || return 1
		mv -f -- "$staging" "$destination"
		identity_cleanup_write_backup_journal "$journal" complete "$url_key" "$schema" \
			"$destination" "$ownership_revision" "$artifact_sha"
		return
	fi
	[[ ! -e "$destination" && ! -L "$destination" ]] || return 1
	if [[ -e "$staging" || -L "$staging" ]]; then
		identity_cutover_validate_private_file "$staging" || return 1
		rm -f -- "$staging"
	fi
	node - "$staging" <<'NODE'
const { closeSync, openSync } = require('node:fs');
const path = process.argv[2];
const descriptor = openSync(path, 'wx', 0o600);
closeSync(descriptor);
NODE
	trap 'if [[ ! -e "$journal" && ! -L "$journal" ]]; then rm -f -- "$staging"; fi' EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	identity_cutover_capture_backup_file "$url_key" "$schema" "$staging" || return 1
	artifact_sha="$(identity_cutover_sha256 "$staging")"
	identity_cleanup_write_backup_journal "$journal" prepared "$url_key" "$schema" \
		"$destination" "$ownership_revision" "$artifact_sha"
	mv -f -- "$staging" "$destination"
	identity_cleanup_write_backup_journal "$journal" complete "$url_key" "$schema" \
		"$destination" "$ownership_revision" "$artifact_sha"
	trap - EXIT INT TERM
	identity_cutover_validate_backup_file "$destination"
)

identity_cleanup_assert_candidate_signing_boundary() {
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		config --format json | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const compose = JSON.parse(input);
  const services = compose?.services || {};
  const core = services.api?.environment || {};
  const identity = services["identity-api"]?.environment || {};
  const signingKeys = ["JWT_ACCESS_PRIVATE_KEY_BASE64", "JWT_ACCESS_JWKS_BASE64", "JWT_ACCESS_ACTIVE_KID"];
  const identityProviderKeys = [
    "RECAPTCHA_SECRET_KEY", "RECAPTCHA_CLIENT_URL", "RECAPTCHA_ENABLED", "RECAPTCHA_MIN_SCORE",
    "SMTP_LOGIN", "SMTP_PASSWORD", "SMTP_SERVER", "SMTP_CONNECTION_TIMEOUT_MS",
    "SMTP_GREETING_TIMEOUT_MS", "SMTP_SOCKET_TIMEOUT_MS",
    "SMSAERO_EMAIL", "SMSAERO_API_KEY", "SMSAERO_SIGN",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_CALLBACK_URL",
    "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_CALLBACK_URL",
    "YANDEX_CLIENT_ID", "YANDEX_CLIENT_SECRET", "YANDEX_CALLBACK_URL",
    "VK_CLIENT_ID", "VK_CLIENT_SECRET", "VK_SERVICE_TOKEN", "VK_CALLBACK_URL",
    "TELEGRAM_AUTH_BOT_TOKEN", "TELEGRAM_AUTH_BOT_USERNAME", "TELEGRAM_AUTH_BOT_WEBHOOK_SECRET",
    "TELEGRAM_INFO_BOT_WEBHOOK_SECRET",
  ];
  const identityInfoWebhookKeys = [
    "TELEGRAM_WEBHOOK_HOST", "TELEGRAM_INFO_BOT_TOKEN", "TELEGRAM_INFO_BOT_USERNAME",
    "TELEGRAM_INFO_BOT_WEBHOOK_SECRET",
  ];
  const coreTelegramKeys = [
    "TELEGRAM_INFO_BOT_TOKEN", "TELEGRAM_INFO_BOT_USERNAME",
    "TELEGRAM_SUPPORT_BOT_TOKEN", "TELEGRAM_SUPPORT_BOT_USERNAME", "TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET",
  ];
  if ([...signingKeys, ...identityProviderKeys].some(key => Object.prototype.hasOwnProperty.call(core, key)) ||
      [...signingKeys, ...identityProviderKeys].some(key => !Object.prototype.hasOwnProperty.call(identity, key)) ||
      identityInfoWebhookKeys.some(key => !Object.prototype.hasOwnProperty.call(identity, key)) ||
      coreTelegramKeys.some(key => !Object.prototype.hasOwnProperty.call(core, key))) process.exit(1);
  for (const [name, service] of Object.entries(services)) {
    if (name === "identity-api") continue;
    if (signingKeys.some(key => Object.prototype.hasOwnProperty.call(service?.environment || {}, key))) process.exit(1);
  }
});
' || identity_cleanup_fail 'cleanup candidate violates the Core/Identity credential boundary'
}

identity_cleanup_export_env_if_requested() {
	[[ -n "${IDENTITY_ENV_EXPORT_CERTIFICATE_FILE:-}" ||
		-n "${IDENTITY_ENV_EXPORT_FILE:-}" ]] || return 0
	[[ -n "${IDENTITY_ENV_EXPORT_CERTIFICATE_FILE:-}" &&
		-n "${IDENTITY_ENV_EXPORT_FILE:-}" ]] || return 1
	APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" EXPECTED_REVISION="$EXPECTED_REVISION" \
		IDENTITY_ENV_EXPORT_CERTIFICATE_FILE="$IDENTITY_ENV_EXPORT_CERTIFICATE_FILE" \
		IDENTITY_ENV_EXPORT_FILE="$IDENTITY_ENV_EXPORT_FILE" \
		bash "$IDENTITY_SCRIPT_ROOT/scripts/identity-production-env-control.sh" \
			--export-encrypted
}

identity_cleanup_remove_core_signing_env() {
	identity_cleanup_require_env_source_sha
	local phase source_sha result_sha current_sha
	if [[ -e "$identity_cleanup_signing_marker" || -L "$identity_cleanup_signing_marker" ]]; then
		identity_cleanup_validate_signing_marker
		phase="$(identity_cleanup_signing_marker_value phase)"
		source_sha="$(identity_cleanup_signing_marker_value source_sha256)"
		result_sha="$(identity_cleanup_signing_marker_value result_sha256)"
		current_sha="$(identity_cleanup_env_sha256)"
		if [[ "$phase" == 'complete' ]]; then
			[[ "$current_sha" == "$result_sha" ]] || return 1
			identity_cleanup_export_env_if_requested
			return
		fi
		if [[ "$current_sha" == "$source_sha" ]]; then
			if [[ -e "$identity_cleanup_signing_candidate" || -L "$identity_cleanup_signing_candidate" ]]; then
				identity_cutover_validate_private_file "$identity_cleanup_signing_candidate" || return 1
				[[ "$(identity_cutover_sha256 "$identity_cleanup_signing_candidate")" == "$result_sha" ]] || return 1
			else
				identity_cleanup_build_signing_candidate "$ENV_FILE" "$identity_cleanup_signing_candidate" || return 1
				[[ "$(identity_cutover_sha256 "$identity_cleanup_signing_candidate")" == "$result_sha" ]] || {
					rm -f -- "$identity_cleanup_signing_candidate"
					return 1
				}
			fi
			mv -f -- "$identity_cleanup_signing_candidate" "$ENV_FILE"
			chmod 600 "$ENV_FILE"
			chown 0:0 "$ENV_FILE"
			current_sha="$(identity_cleanup_env_sha256)"
		fi
		[[ "$current_sha" == "$result_sha" ]] || return 1
		if [[ -e "$identity_cleanup_signing_candidate" || -L "$identity_cleanup_signing_candidate" ]]; then
			identity_cutover_validate_private_file "$identity_cleanup_signing_candidate" || return 1
			[[ "$(identity_cutover_sha256 "$identity_cleanup_signing_candidate")" == "$result_sha" ]] || return 1
			rm -f -- "$identity_cleanup_signing_candidate"
		fi
		identity_cleanup_write_signing_marker complete "$source_sha" "$result_sha"
	else
		source_sha="$(identity_cleanup_env_sha256)"
		if [[ -e "$identity_cleanup_signing_candidate" || -L "$identity_cleanup_signing_candidate" ]]; then
			identity_cutover_validate_private_file "$identity_cleanup_signing_candidate" || return 1
			rm -f -- "$identity_cleanup_signing_candidate"
		fi
		identity_cleanup_build_signing_candidate "$ENV_FILE" "$identity_cleanup_signing_candidate" || return 1
		result_sha="$(identity_cutover_sha256 "$identity_cleanup_signing_candidate")"
		[[ "$result_sha" =~ ^[0-9a-f]{64}$ && "$result_sha" != "$source_sha" ]] || {
			rm -f -- "$identity_cleanup_signing_candidate"
			return 1
		}
		identity_cleanup_write_signing_marker prepared "$source_sha" "$result_sha"
		mv -f -- "$identity_cleanup_signing_candidate" "$ENV_FILE"
		chmod 600 "$ENV_FILE"
		chown 0:0 "$ENV_FILE"
		[[ "$(identity_cleanup_env_sha256)" == "$result_sha" ]] || return 1
		identity_cleanup_write_signing_marker complete "$source_sha" "$result_sha"
	fi
	printf 'identity_core_signing_env_removed=true\n'
	printf 'identity_production_env_sha256=%s\n' "$result_sha"
	identity_cleanup_export_env_if_requested
}

identity_cleanup_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z0-9_]+$ ]] || return 1
	identity_cleanup_validate_marker || return 1
	awk -F= -v key="$1" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$identity_cleanup_marker"
}

identity_cleanup_validate_marker() {
	[[ -f "$identity_cleanup_marker" && ! -L "$identity_cleanup_marker" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_cleanup_marker")" == '0:0:600' ]] || return 1
	fi
	awk -F= '
    $1 !~ /^(version|phase|ownership_revision|cleanup_revision|migration|migration_sha256|core_backup_sha256|identity_backup_sha256|identity_restore_evidence_sha256|queue_drain_evidence_sha256|stopped_writers_evidence_sha256|soak_evidence_sha256|post_core_backup_sha256|updated_at)$/ { exit 1 }
    { count[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
    END {
      for (key in count) if (count[key] != 1) exit 1
      if (NR != 14 || value["version"] != "1" ||
          value["phase"] !~ /^(verified|forward-only|complete)$/ ||
          value["ownership_revision"] !~ /^[0-9a-f]{40}$/ ||
          value["cleanup_revision"] !~ /^[0-9a-f]{40}$/ ||
          value["ownership_revision"] == sprintf("%040d", 0) ||
          value["cleanup_revision"] == sprintf("%040d", 0) ||
          value["ownership_revision"] == value["cleanup_revision"] ||
          value["migration"] != "20260815000000_remove_legacy_identity_core_source" ||
          value["migration_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["migration_sha256"] == sprintf("%064d", 0) ||
          value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
      for (key in value) if (key ~ /_backup_sha256$|_evidence_sha256$/ &&
          value[key] !~ /^(pending|[0-9a-f]{64})$/) exit 1
      for (key in value) if (key ~ /_backup_sha256$|_evidence_sha256$/ &&
          value[key] ~ /^[0-9a-f]{64}$/ && value[key] == sprintf("%064d", 0)) exit 1
      if (value["core_backup_sha256"] == "pending" ||
          value["identity_backup_sha256"] == "pending" ||
          value["identity_restore_evidence_sha256"] == "pending" ||
          value["queue_drain_evidence_sha256"] == "pending" ||
          value["soak_evidence_sha256"] == "pending") exit 1
      if (value["phase"] != "verified" &&
          value["stopped_writers_evidence_sha256"] == "pending") exit 1
      if (value["phase"] == "complete" && value["post_core_backup_sha256"] == "pending") exit 1
    }
  ' "$identity_cleanup_marker"
}

identity_cleanup_transition_allowed() {
	case "$1:$2" in
	absent:verified | verified:verified | verified:forward-only | \
		forward-only:forward-only | forward-only:complete | complete:complete) return 0 ;;
	*) return 1 ;;
	esac
}

identity_cleanup_write_marker() {
	[[ $# -eq 13 ]] || return 1
	local current='absent' temporary="${identity_cleanup_marker}.tmp.$$"
	if [[ -e "$identity_cleanup_marker" || -L "$identity_cleanup_marker" ]]; then
		identity_cleanup_validate_marker || return 1
		current="$(identity_cleanup_marker_value phase)"
	fi
	identity_cleanup_transition_allowed "$current" "$1" || return 1
	{
		printf 'version=1\nphase=%s\nownership_revision=%s\ncleanup_revision=%s\n' "$1" "$2" "$3"
		printf 'migration=%s\nmigration_sha256=%s\n' "$4" "$5"
		printf 'core_backup_sha256=%s\nidentity_backup_sha256=%s\n' "$6" "$7"
		printf 'identity_restore_evidence_sha256=%s\nqueue_drain_evidence_sha256=%s\n' "$8" "$9"
		printf 'stopped_writers_evidence_sha256=%s\nsoak_evidence_sha256=%s\n' "${10}" "${11}"
		printf 'post_core_backup_sha256=%s\nupdated_at=%s\n' "${12}" "${13}"
	} >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$identity_cleanup_marker"
	identity_cleanup_validate_marker
}

identity_cleanup_require_migration() {
	local migration_file="$SERVER_ROOT/prisma/migrations/$IDENTITY_CORE_CLEANUP_MIGRATION/migration.sql"
	[[ "$IDENTITY_CORE_CLEANUP_MIGRATION" == '20260815000000_remove_legacy_identity_core_source' &&
		"$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" =~ ^[0-9a-f]{64}$ &&
		-f "$migration_file" && ! -L "$migration_file" &&
		"$(identity_cutover_sha256 "$migration_file")" == "$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" ]] ||
		identity_cleanup_fail 'exact reviewed Identity Core cleanup migration/SHA-256 is required' || return 1
	local ownership_revision changed_migrations
	ownership_revision="$(identity_cutover_marker_value revision)"
	git -C "$SERVER_ROOT" merge-base --is-ancestor "$ownership_revision" "$EXPECTED_REVISION" ||
		identity_cleanup_fail 'cleanup revision must descend from the ownership revision' || return 1
	changed_migrations="$(git -C "$SERVER_ROOT" diff --name-only \
		"$ownership_revision" "$EXPECTED_REVISION" -- prisma/migrations)"
	[[ "$changed_migrations" == "prisma/migrations/$IDENTITY_CORE_CLEANUP_MIGRATION/migration.sql" ]] ||
		identity_cleanup_fail 'cleanup revision must add exactly the reviewed Identity Core cleanup migration' || return 1
}

identity_cleanup_require_soak() {
	local soak_seconds="$IDENTITY_CORE_CLEANUP_SOAK_SECONDS" updated_at
	if [[ -z "$soak_seconds" ]]; then
		soak_seconds="$(identity_read_env_value "$ENV_FILE" IDENTITY_CORE_CLEANUP_SOAK_SECONDS 2>/dev/null || printf '900')"
	fi
	[[ "$soak_seconds" =~ ^[0-9]+$ && "$soak_seconds" -ge 900 &&
		"$soak_seconds" -le 86400 ]] ||
		identity_cleanup_fail 'Identity cleanup soak must be between 900 and 86400 seconds' || return 1
	updated_at="$(identity_cutover_marker_value updated_at)" || return 1
	CUTOVER_UPDATED_AT="$updated_at" SOAK_SECONDS="$soak_seconds" node -e '
const updated = Date.parse(process.env.CUTOVER_UPDATED_AT || "");
const soakMs = Number(process.env.SOAK_SECONDS) * 1000;
const now = Date.now();
if (!Number.isFinite(updated) || !Number.isSafeInteger(soakMs) || updated > now || now - updated < soakMs) process.exit(1);
' || identity_cleanup_fail "Identity cleanup requires the completed cutover soak window ($soak_seconds seconds)"
	identity_cleanup_verified_soak_seconds="$soak_seconds"
	identity_cleanup_cutover_updated_at="$updated_at"
}

identity_cleanup_runtime_has_soaked() {
	[[ $# -ge 2 && $# -le 3 && "$2" =~ ^[0-9]+$ ]] || return 1
	STARTED_AT="$1" SOAK_SECONDS="$2" OBSERVED_AT="${3:-}" node <<'NODE'
const startedAt = Date.parse(process.env.STARTED_AT || '');
const observedAt = process.env.OBSERVED_AT ? Date.parse(process.env.OBSERVED_AT) : Date.now();
const soakMs = Number(process.env.SOAK_SECONDS) * 1000;
if (!Number.isFinite(startedAt) || !Number.isFinite(observedAt) ||
    !Number.isSafeInteger(soakMs) || soakMs < 900000 || soakMs > 86400000 ||
    startedAt > observedAt || observedAt - startedAt < soakMs) process.exit(1);
NODE
}

identity_cleanup_assert_identity_runtime_stable() {
	local ownership_revision spec service port container_id image_id revision restart_count health started_at
	ownership_revision="$(identity_cutover_marker_value revision)" || return 1
	for spec in 'identity-api:4900' 'identity-worker:4901' 'identity-outbox-publisher:4902'; do
		service="${spec%%:*}"
		port="${spec##*:}"
		container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			ps --status running -q "$service")" || return 1
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
			identity_cleanup_fail "$service must have exactly one running instance" || return 1
		image_id="$(docker inspect --format '{{.Image}}' "$container_id")" || return 1
		revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" || return 1
		restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")" || return 1
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" || return 1
		started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container_id")" || return 1
		[[ "$image_id" == "$(identity_cutover_marker_value identity_image_id)" &&
			"$revision" == "$ownership_revision" && "$restart_count" == '0' &&
			"$health" == 'healthy' ]] ||
			identity_cleanup_fail "$service is not a stable zero-restart ownership runtime" || return 1
		identity_cleanup_runtime_has_soaked "$started_at" "$identity_cleanup_verified_soak_seconds" ||
			identity_cleanup_fail "$service was recreated inside the required cleanup soak window" || return 1
		identity_cutover_wait_url "http://127.0.0.1:$port/health/ready" "$service"
		case "$service" in
		identity-api)
			identity_cleanup_api_container_id="$container_id"
			identity_cleanup_api_image_id="$image_id"
			identity_cleanup_api_started_at="$started_at"
			;;
		identity-worker)
			identity_cleanup_worker_container_id="$container_id"
			identity_cleanup_worker_image_id="$image_id"
			identity_cleanup_worker_started_at="$started_at"
			;;
		identity-outbox-publisher)
			identity_cleanup_publisher_container_id="$container_id"
			identity_cleanup_publisher_image_id="$image_id"
			identity_cleanup_publisher_started_at="$started_at"
			;;
		esac
	done
	identity_cutover_wait_url http://127.0.0.1:4100/health/ready 'API Gateway before Identity cleanup'
	identity_cutover_wait_url http://127.0.0.1:4900/api/v1/auth/settings 'direct Identity auth health'
	identity_cutover_wait_url https://api.winwidget.ru/api/v1/auth/settings 'public Identity auth health'
	identity_cutover_wait_url http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json 'direct Identity JWKS before cleanup'
	identity_cutover_wait_url https://api.winwidget.ru/api/v1/auth/.well-known/jwks.json 'public Identity JWKS before cleanup'
	local direct_sha public_sha
	direct_sha="$(curl -fsS --connect-timeout 3 --max-time 10 \
		http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json | identity_cutover_text_sha256)"
	public_sha="$(curl -fsS --connect-timeout 3 --max-time 10 \
		https://api.winwidget.ru/api/v1/auth/.well-known/jwks.json | identity_cutover_text_sha256)"
	[[ "$direct_sha" =~ ^[0-9a-f]{64}$ && "$direct_sha" == "$public_sha" ]] ||
		identity_cleanup_fail 'public and direct Identity JWKS differ before cleanup'
	identity_cutover_assert_info_webhook_owner
	identity_cleanup_jwks_sha256="$direct_sha"
}

identity_cleanup_validate_soak_evidence() {
	local evidence="${1:-$identity_cleanup_soak_evidence}"
	identity_cutover_validate_private_file "$evidence" || return 1
	OWNERSHIP_REVISION="$(identity_cutover_marker_value revision)" \
		CLEANUP_REVISION="$EXPECTED_REVISION" node - "$evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const exactKeys = (item, keys) => item && typeof item === 'object' &&
  !Array.isArray(item) && JSON.stringify(Object.keys(item).sort()) ===
  JSON.stringify([...keys].sort());
const isSha = item => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item) && !/^0+$/.test(item);
const isContainer = item => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item);
const isImage = item => typeof item === 'string' && /^sha256:[0-9a-f]{64}$/.test(item);
const expectedServices = ['identity-api', 'identity-outbox-publisher', 'identity-worker'];
if (!exactKeys(value, ['schemaVersion', 'action', 'ownershipRevision',
    'cleanupRevision', 'cutoverCompletedAt', 'minimumSoakSeconds', 'runtimes',
    'jwksSha256', 'observedAt']) || value.schemaVersion !== 1 ||
    value.action !== 'identity-core-cleanup-soak-stable-runtime' ||
    value.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    !Number.isSafeInteger(value.minimumSoakSeconds) || value.minimumSoakSeconds < 900 ||
    value.minimumSoakSeconds > 86400 || !isSha(value.jwksSha256) ||
    !Number.isFinite(Date.parse(value.cutoverCompletedAt)) ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    Date.parse(value.observedAt) - Date.parse(value.cutoverCompletedAt) <
      value.minimumSoakSeconds * 1000 || !Array.isArray(value.runtimes) ||
    value.runtimes.map(runtime => runtime.service).sort().join(',') !==
      expectedServices.join(',') || value.runtimes.some(runtime =>
	      !exactKeys(runtime, ['service', 'containerId', 'imageId', 'imageRevision',
	        'restartCount', 'health', 'startedAt']) || !isContainer(runtime.containerId) ||
	      !isImage(runtime.imageId) || runtime.imageRevision !== process.env.OWNERSHIP_REVISION ||
	      runtime.restartCount !== 0 || runtime.health !== 'healthy' ||
	      !Number.isFinite(Date.parse(runtime.startedAt)) ||
	      Date.parse(runtime.startedAt) > Date.parse(value.observedAt) ||
	      Date.parse(value.observedAt) - Date.parse(runtime.startedAt) <
	        value.minimumSoakSeconds * 1000)) process.exit(1);
NODE
}

identity_cleanup_capture_soak_evidence() {
	local partial="${identity_cleanup_soak_evidence}.partial.$$"
	[[ "$identity_cleanup_verified_soak_seconds" =~ ^[0-9]+$ &&
		"$identity_cleanup_cutover_updated_at" =~ ^[0-9TZ:.-]+$ &&
		"$identity_cleanup_jwks_sha256" =~ ^[0-9a-f]{64}$ &&
		! -e "$partial" && ! -L "$partial" ]] || return 1
	OWNERSHIP_REVISION="$(identity_cutover_marker_value revision)" \
		CLEANUP_REVISION="$EXPECTED_REVISION" \
		CUTOVER_UPDATED_AT="$identity_cleanup_cutover_updated_at" \
		SOAK_SECONDS="$identity_cleanup_verified_soak_seconds" \
		JWKS_SHA256="$identity_cleanup_jwks_sha256" \
		IDENTITY_API_CONTAINER_ID="$identity_cleanup_api_container_id" \
		IDENTITY_API_IMAGE_ID="$identity_cleanup_api_image_id" \
		IDENTITY_API_STARTED_AT="$identity_cleanup_api_started_at" \
		IDENTITY_WORKER_CONTAINER_ID="$identity_cleanup_worker_container_id" \
		IDENTITY_WORKER_IMAGE_ID="$identity_cleanup_worker_image_id" \
		IDENTITY_WORKER_STARTED_AT="$identity_cleanup_worker_started_at" \
		IDENTITY_PUBLISHER_CONTAINER_ID="$identity_cleanup_publisher_container_id" \
		IDENTITY_PUBLISHER_IMAGE_ID="$identity_cleanup_publisher_image_id" \
		IDENTITY_PUBLISHER_STARTED_AT="$identity_cleanup_publisher_started_at" \
			node <<'NODE' >"$partial"
const runtimes = [
  ['identity-api', process.env.IDENTITY_API_CONTAINER_ID, process.env.IDENTITY_API_IMAGE_ID,
    process.env.IDENTITY_API_STARTED_AT],
  ['identity-worker', process.env.IDENTITY_WORKER_CONTAINER_ID, process.env.IDENTITY_WORKER_IMAGE_ID,
    process.env.IDENTITY_WORKER_STARTED_AT],
  ['identity-outbox-publisher', process.env.IDENTITY_PUBLISHER_CONTAINER_ID,
    process.env.IDENTITY_PUBLISHER_IMAGE_ID, process.env.IDENTITY_PUBLISHER_STARTED_AT],
].map(([service, containerId, imageId, startedAt]) => ({ service, containerId, imageId,
  imageRevision: process.env.OWNERSHIP_REVISION, restartCount: 0, health: 'healthy', startedAt }));
process.stdout.write(`${JSON.stringify({ schemaVersion: 1,
  action: 'identity-core-cleanup-soak-stable-runtime',
  ownershipRevision: process.env.OWNERSHIP_REVISION,
  cleanupRevision: process.env.CLEANUP_REVISION,
  cutoverCompletedAt: process.env.CUTOVER_UPDATED_AT,
  minimumSoakSeconds: Number(process.env.SOAK_SECONDS), runtimes,
  jwksSha256: process.env.JWKS_SHA256, observedAt: new Date().toISOString() })}\n`);
NODE
	chmod 600 "$partial"
	chown 0:0 "$partial"
	identity_cleanup_validate_soak_evidence "$partial"
	mv -f -- "$partial" "$identity_cleanup_soak_evidence"
	identity_cleanup_validate_soak_evidence
}

identity_cleanup_validate_queue_evidence() {
	local evidence="${1:-$identity_cleanup_queue_evidence}"
	identity_cutover_validate_private_file "$evidence" || return 1
	OWNERSHIP_REVISION="$(identity_cutover_marker_value revision)" \
		CLEANUP_REVISION="$EXPECTED_REVISION" node - "$evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const projections = [
  'winwidget.billing.identity.v1',
  'winwidget.reporting.identity-user',
  'winwidget.widgets.identity-user',
].sort();
const main = 'winwidget.notification.telegram-destination-unavailable';
const destinations = [main, `${main}.dead-letter`, `${main}.retry-v2.1`,
  `${main}.retry-v2.2`, `${main}.retry-v2.3`].sort();
const exactKeys = (item, keys) => item && typeof item === 'object' &&
  !Array.isArray(item) && JSON.stringify(Object.keys(item).sort()) ===
  JSON.stringify([...keys].sort());
const validQueue = queue => exactKeys(queue,
  ['name', 'messages', 'messagesReady', 'messagesUnacknowledged', 'consumers']) &&
  typeof queue.name === 'string' &&
  [queue.messages, queue.messagesReady, queue.messagesUnacknowledged,
    queue.consumers].every(Number.isSafeInteger) && queue.messages === 0 &&
  queue.messagesReady === 0 && queue.messagesUnacknowledged === 0;
if (!exactKeys(value, ['schemaVersion', 'action', 'ownershipRevision',
    'cleanupRevision', 'projectionQueues', 'destinationQueues', 'observedAt']) ||
    value.schemaVersion !== 1 || value.action !== 'identity-core-cleanup-queue-drain' ||
    value.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !Array.isArray(value.projectionQueues) ||
    value.projectionQueues.map(queue => queue.name).sort().join(',') !== projections.join(',') ||
    value.projectionQueues.some(queue => !validQueue(queue) || queue.consumers !== 1) ||
    !Array.isArray(value.destinationQueues) ||
    value.destinationQueues.map(queue => queue.name).sort().join(',') !== destinations.join(',') ||
    value.destinationQueues.some(queue => !validQueue(queue) ||
      queue.consumers !== (queue.name === main ? 1 : 0))) process.exit(1);
NODE
}

identity_cleanup_assert_identity_queues_drained() {
	local destination="${1:-$identity_cleanup_queue_evidence}"
	local partial="${destination}.partial.$$"
	[[ ! -e "$partial" && ! -L "$partial" ]] || return 1
	REVISION="$EXPECTED_REVISION" \
	OWNERSHIP_REVISION="$(identity_cutover_marker_value revision)" \
		docker run --rm --network host --env-file "$ENV_FILE" \
		-e REVISION -e OWNERSHIP_REVISION --entrypoint node \
		"winwidget-api:git-$EXPECTED_REVISION" -e '
class QueueError extends Error {}
const run = async () => {
  const baseUrl = String(process.env.RABBITMQ_MANAGEMENT_URL || "http://127.0.0.1:15672").replace(/\/$/, "");
  const vhost = process.env.RABBITMQ_VHOST || "winwidget";
  const adminUser = process.env.RABBITMQ_ADMIN_USER;
  const adminPassword = process.env.RABBITMQ_ADMIN_PASSWORD;
  if (!adminUser || !adminPassword ||
      !/^[0-9a-f]{40}$/.test(process.env.REVISION || "") ||
      !/^[0-9a-f]{40}$/.test(process.env.OWNERSHIP_REVISION || "")) {
    throw new QueueError("Identity cleanup queue evidence inputs are invalid");
  }
  const decodeUser = name => {
    try {
      const user = decodeURIComponent(new URL(process.env[name] || "").username);
      if (!user) throw new Error();
      return user;
    } catch { throw new QueueError(`${name} is invalid`); }
  };
  const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
  const request = async path => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: authorization }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new QueueError(`RabbitMQ Management returned HTTP ${response.status}`);
    }
    return response.json();
  };
  const connections = await request("/api/connections");
  if (!Array.isArray(connections)) throw new QueueError("RabbitMQ connections response is invalid");
  const bySocketName = new Map(connections.map(connection => [connection.name, connection]));
  const contracts = [
    ["winwidget.reporting.identity-user", "RABBITMQ_REPORTING_URL", "winwidget-reporting-service"],
    ["winwidget.widgets.identity-user", "RABBITMQ_WIDGETS_URL", "winwidget-widgets-service"],
    ["winwidget.billing.identity.v1", "RABBITMQ_BILLING_WORKER_URL", "winwidget-billing-worker"],
    ["winwidget.notification.telegram-destination-unavailable", "RABBITMQ_IDENTITY_WORKER_URL", "winwidget-identity-worker"],
  ].map(([name, urlKey, connectionName]) => ({
    name, connectionName, expectedUser: decodeUser(urlKey),
  }));
  const readQueue = async (name, expectedConsumers, contract) => {
    const value = await request(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(name)}`);
    const details = Array.isArray(value?.consumer_details) ? value.consumer_details : [];
    if (![value?.messages, value?.messages_ready, value?.messages_unacknowledged,
        value?.consumers].every(Number.isSafeInteger) || value.messages !== 0 ||
        value.messages_ready !== 0 || value.messages_unacknowledged !== 0 ||
        value.consumers !== expectedConsumers || details.length !== expectedConsumers) {
      throw new QueueError(`Identity cleanup queue is not drained: ${name}`);
    }
    if (contract) {
      const connection = bySocketName.get(details[0]?.channel_details?.connection_name);
      if (connection?.user !== contract.expectedUser ||
          connection?.client_properties?.connection_name !== contract.connectionName) {
        throw new QueueError(`Identity cleanup queue owner drifted: ${name}`);
      }
    }
    return { name, messages: value.messages, messagesReady: value.messages_ready,
      messagesUnacknowledged: value.messages_unacknowledged, consumers: value.consumers };
  };
  const projectionQueues = await Promise.all(contracts.slice(0, 3).map(contract =>
    readQueue(contract.name, 1, contract)));
  const main = contracts[3];
  const destinationQueues = [await readQueue(main.name, 1, main)];
  for (const suffix of [".dead-letter", ".retry-v2.1", ".retry-v2.2", ".retry-v2.3"]) {
    destinationQueues.push(await readQueue(main.name + suffix, 0));
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1,
    action: "identity-core-cleanup-queue-drain",
    ownershipRevision: process.env.OWNERSHIP_REVISION,
    cleanupRevision: process.env.REVISION,
    projectionQueues, destinationQueues,
    observedAt: new Date().toISOString() })}\n`);
};
run().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Identity cleanup queue check failed"}\n`);
  process.exit(1);
});
' >"$partial"
	chmod 600 "$partial"
	chown 0:0 "$partial"
	identity_cleanup_validate_queue_evidence "$partial"
	mv -f -- "$partial" "$destination"
	identity_cleanup_validate_queue_evidence "$destination"
}

identity_cleanup_assert_live_queue_boundary() {
	local evidence="$identity_cleanup_root/.queue-live.$$.json"
	[[ ! -e "$evidence" && ! -L "$evidence" ]] || return 1
	if ! identity_cleanup_assert_identity_queues_drained "$evidence"; then
		rm -f -- "$evidence" "${evidence}.partial.$$"
		return 1
	fi
	rm -f -- "$evidence"
}

identity_cleanup_validate_stopped_writers_evidence() {
	local evidence="${1:-$identity_cleanup_stopped_writers_evidence}"
	identity_cutover_validate_private_file "$evidence" || return 1
	OWNERSHIP_REVISION="$(identity_cutover_marker_value revision)" \
		CLEANUP_REVISION="$EXPECTED_REVISION" node - "$evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const exactKeys = (item, keys) => item && typeof item === 'object' &&
  !Array.isArray(item) && JSON.stringify(Object.keys(item).sort()) ===
  JSON.stringify([...keys].sort());
const services = ['api', 'database-restore-worker', 'integration-worker',
  'maintenance-worker', 'outbox-publisher'];
if (!exactKeys(value, ['schemaVersion', 'action', 'ownershipRevision',
    'cleanupRevision', 'services', 'databaseSessions', 'sourceFence',
    'fenceGeneration', 'observedAt']) || value.schemaVersion !== 1 ||
    value.action !== 'identity-core-cleanup-stopped-writers' ||
    value.ownershipRevision !== process.env.OWNERSHIP_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    value.databaseSessions !== 0 || value.sourceFence !== 'FENCED' ||
    !Number.isSafeInteger(value.fenceGeneration) || value.fenceGeneration < 1 ||
    !Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.services) ||
    value.services.map(service => service.service).sort().join(',') !== services.join(',') ||
    value.services.some(service => !exactKeys(service,
      ['service', 'containerId', 'imageId', 'imageRevision', 'state', 'running']) ||
      !/^[0-9a-f]{64}$/.test(service.containerId) ||
      !/^sha256:[0-9a-f]{64}$/.test(service.imageId) ||
      service.imageRevision !== process.env.OWNERSHIP_REVISION ||
      service.state !== 'exited' || service.running !== false)) process.exit(1);
NODE
}

identity_cleanup_capture_stopped_writers_evidence() {
	local service container_id image_id image_revision state running
	local partial="${identity_cleanup_stopped_writers_evidence}.partial.$$"
	local database_state database_sessions source_fence fence_revision fence_generation
	for service in api integration-worker outbox-publisher maintenance-worker database-restore-worker; do
		container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			ps -a -q "$service")" || return 1
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
			identity_cleanup_fail "stopped writer evidence requires one $service container" || return 1
		image_id="$(docker inspect --format '{{.Image}}' "$container_id")" || return 1
		image_revision="$(docker image inspect --format \
			'{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" || return 1
		state="$(docker inspect --format '{{.State.Status}}' "$container_id")" || return 1
		running="$(docker inspect --format '{{.State.Running}}' "$container_id")" || return 1
		[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$image_revision" == "$(identity_cutover_marker_value revision)" &&
			"$state" == 'exited' && "$running" == 'false' ]] ||
			identity_cleanup_fail "$service is not stopped at the exact ownership revision" || return 1
		case "$service" in
		api) identity_cleanup_stopped_api="$container_id|$image_id" ;;
		integration-worker) identity_cleanup_stopped_integration="$container_id|$image_id" ;;
		outbox-publisher) identity_cleanup_stopped_outbox="$container_id|$image_id" ;;
		maintenance-worker) identity_cleanup_stopped_maintenance="$container_id|$image_id" ;;
		database-restore-worker) identity_cleanup_stopped_restore="$container_id|$image_id" ;;
		esac
	done
	local PGURL core_postgres_image
	PGURL="$(identity_read_env_value "$ENV_FILE" DATABASE_MIGRATION_URL_PRODUCTION)" || return 1
	PGURL="$(identity_cutover_psql_url "$PGURL")" || return 1
	core_postgres_image="$CORE_POSTGRES_IMAGE"
	export PGURL
	database_state="$(docker run --rm -i --network host -e PGURL "$core_postgres_image" \
		sh -euc 'psql --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align --field-separator="|" "$PGURL"' <<'SQL'
SELECT
  count(*) FILTER (
    WHERE pid <> pg_backend_pid()
      AND datname = current_database()
      AND usename IN (
        'winwidget_api_runtime',
        'winwidget_maintenance',
        'winwidget_backup',
        'gen_user'
      )
  )::TEXT,
  ownership::TEXT,
  COALESCE(fenced_revision, ''),
  generation::TEXT
FROM pg_stat_activity
CROSS JOIN public.identity_core_source_state
WHERE id = 'singleton'
GROUP BY ownership, fenced_revision, generation;
SQL
)" || return 1
	unset PGURL
	IFS='|' read -r database_sessions source_fence fence_revision fence_generation <<<"$database_state"
	[[ "$database_sessions" == '0' && "$source_fence" == 'FENCED' &&
		"$fence_revision" == "$(identity_cutover_marker_value revision)" &&
		"$fence_generation" =~ ^[1-9][0-9]*$ ]] ||
		identity_cleanup_fail 'Core writer sessions or source fence changed after stop' || return 1
	[[ ! -e "$partial" && ! -L "$partial" ]] || return 1
	OWNERSHIP_REVISION="$(identity_cutover_marker_value revision)" \
		CLEANUP_REVISION="$EXPECTED_REVISION" FENCE_GENERATION="$fence_generation" \
		STOPPED_API="$identity_cleanup_stopped_api" \
		STOPPED_INTEGRATION="$identity_cleanup_stopped_integration" \
		STOPPED_OUTBOX="$identity_cleanup_stopped_outbox" \
		STOPPED_MAINTENANCE="$identity_cleanup_stopped_maintenance" \
		STOPPED_RESTORE="$identity_cleanup_stopped_restore" node <<'NODE' >"$partial"
const parse = (service, value) => {
  const [containerId, imageId] = String(value || '').split('|');
  return { service, containerId, imageId,
    imageRevision: process.env.OWNERSHIP_REVISION, state: 'exited', running: false };
};
const services = [
  parse('api', process.env.STOPPED_API),
  parse('integration-worker', process.env.STOPPED_INTEGRATION),
  parse('outbox-publisher', process.env.STOPPED_OUTBOX),
  parse('maintenance-worker', process.env.STOPPED_MAINTENANCE),
  parse('database-restore-worker', process.env.STOPPED_RESTORE),
];
process.stdout.write(`${JSON.stringify({ schemaVersion: 1,
  action: 'identity-core-cleanup-stopped-writers',
  ownershipRevision: process.env.OWNERSHIP_REVISION,
  cleanupRevision: process.env.CLEANUP_REVISION, services, databaseSessions: 0,
  sourceFence: 'FENCED', fenceGeneration: Number(process.env.FENCE_GENERATION),
  observedAt: new Date().toISOString() })}\n`);
NODE
	chmod 600 "$partial"
	chown 0:0 "$partial"
	identity_cleanup_validate_stopped_writers_evidence "$partial"
	mv -f -- "$partial" "$identity_cleanup_stopped_writers_evidence"
	identity_cleanup_validate_stopped_writers_evidence
}

identity_cleanup_require_artifact_sha() {
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{64}$ && ! "$1" =~ ^0+$ &&
		-f "$2" && ! -L "$2" && "$(identity_cutover_sha256 "$2")" == "$1" ]]
}

identity_cleanup_require_bound_evidence() {
	identity_cleanup_validate_marker || return 1
	[[ "$(identity_cleanup_marker_value ownership_revision)" == \
		"$(identity_cutover_marker_value revision)" &&
		"$(identity_cleanup_marker_value cleanup_revision)" == "$EXPECTED_REVISION" &&
		"$(identity_cleanup_marker_value migration)" == "$IDENTITY_CORE_CLEANUP_MIGRATION" ]] || return 1
	local key file expected
	for key in core_backup_sha256 identity_backup_sha256 \
		identity_restore_evidence_sha256 queue_drain_evidence_sha256 \
		soak_evidence_sha256; do
		case "$key" in
		core_backup_sha256) file="$identity_cleanup_core_backup" ;;
		identity_backup_sha256) file="$identity_cleanup_identity_backup" ;;
		identity_restore_evidence_sha256) file="$identity_cleanup_identity_restore" ;;
		queue_drain_evidence_sha256) file="$identity_cleanup_queue_evidence" ;;
		soak_evidence_sha256) file="$identity_cleanup_soak_evidence" ;;
		esac
		expected="$(identity_cleanup_marker_value "$key")" || return 1
		identity_cleanup_require_artifact_sha "$expected" "$file" || return 1
	done
	identity_cutover_validate_private_file "$identity_cleanup_core_backup" || return 1
	identity_cutover_validate_private_file "$identity_cleanup_identity_backup" || return 1
	identity_cutover_validate_private_file "$identity_cleanup_identity_restore" || return 1
	identity_cleanup_validate_queue_evidence || return 1
	identity_cleanup_validate_soak_evidence || return 1
	if [[ "$(identity_cleanup_marker_value stopped_writers_evidence_sha256)" != 'pending' ]]; then
		expected="$(identity_cleanup_marker_value stopped_writers_evidence_sha256)" || return 1
		identity_cleanup_require_artifact_sha "$expected" \
			"$identity_cleanup_stopped_writers_evidence" || return 1
		identity_cleanup_validate_stopped_writers_evidence || return 1
	fi
	[[ "$(identity_cleanup_marker_value migration_sha256)" == \
		"$(identity_cutover_sha256 "$SERVER_ROOT/prisma/migrations/$IDENTITY_CORE_CLEANUP_MIGRATION/migration.sql")" ]]
}

identity_cleanup_build_migration_url() {
	[[ $# -eq 10 ]] || return 1
	IDENTITY_CLEANUP_BASE_URL="$1" IDENTITY_OWNERSHIP_REVISION="$2" \
		IDENTITY_CLEANUP_REVISION="$3" IDENTITY_MIGRATION_SHA="$4" \
		IDENTITY_CORE_BACKUP_SHA="$5" IDENTITY_BACKUP_SHA="$6" \
		IDENTITY_RESTORE_SHA="$7" IDENTITY_QUEUE_SHA="$8" \
		IDENTITY_WRITERS_SHA="$9" IDENTITY_SOAK_SHA="${10}" node <<'NODE'
const revision = value => /^[0-9a-f]{40}$/.test(value || '') && !/^0+$/.test(value);
const sha = value => /^[0-9a-f]{64}$/.test(value || '') && !/^0+$/.test(value);
const ownership = process.env.IDENTITY_OWNERSHIP_REVISION;
const cleanup = process.env.IDENTITY_CLEANUP_REVISION;
const hashes = [process.env.IDENTITY_MIGRATION_SHA, process.env.IDENTITY_CORE_BACKUP_SHA,
  process.env.IDENTITY_BACKUP_SHA, process.env.IDENTITY_RESTORE_SHA,
  process.env.IDENTITY_QUEUE_SHA, process.env.IDENTITY_WRITERS_SHA,
  process.env.IDENTITY_SOAK_SHA];
if (!revision(ownership) || !revision(cleanup) || ownership === cleanup ||
    hashes.some(value => !sha(value))) process.exit(1);
let url;
try { url = new URL(process.env.IDENTITY_CLEANUP_BASE_URL || ''); }
catch { process.exit(1); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username ||
    !url.password || !url.hostname || url.pathname !== '/default_db') process.exit(1);
const existingOptions = url.searchParams.getAll('options');
if (existingOptions.length > 1) process.exit(1);
const settings = [
  ['winwidget.identity_core_source_cleanup', 'production-destructive-approved'],
  ['winwidget.identity_ownership_phase', 'complete'],
  ['winwidget.identity_ownership_revision', ownership],
  ['winwidget.identity_cleanup_revision', cleanup],
  ['winwidget.identity_cleanup_migration_sha256', hashes[0]],
  ['winwidget.identity_core_backup_sha256', hashes[1]],
  ['winwidget.identity_backup_sha256', hashes[2]],
  ['winwidget.identity_restore_evidence_sha256', hashes[3]],
  ['winwidget.identity_queue_drain_evidence_sha256', hashes[4]],
  ['winwidget.identity_stopped_writers_evidence_sha256', hashes[5]],
  ['winwidget.identity_soak_evidence_sha256', hashes[6]],
];
const cleanupOptions = settings.map(([name, value]) => `-c ${name}=${value}`).join(' ');
const existing = existingOptions[0]?.trim();
url.searchParams.set('options', [existing, cleanupOptions].filter(Boolean).join(' '));
const serialized = url.toString().replace(
  /([?&]options=)([^&#]*)/,
  (_, prefix, value) => `${prefix}${value.replace(/\+/g, '%20')}`,
);
process.stdout.write(serialized);
NODE
}

identity_cleanup_migration_url() {
	identity_cleanup_require_bound_evidence || return 1
	local base_url
	base_url="$(identity_read_env_value "$ENV_FILE" DATABASE_MIGRATION_URL_PRODUCTION)" || return 1
	identity_cleanup_build_migration_url "$base_url" \
		"$(identity_cleanup_marker_value ownership_revision)" \
		"$(identity_cleanup_marker_value cleanup_revision)" \
		"$(identity_cleanup_marker_value migration_sha256)" \
		"$(identity_cleanup_marker_value core_backup_sha256)" \
		"$(identity_cleanup_marker_value identity_backup_sha256)" \
		"$(identity_cleanup_marker_value identity_restore_evidence_sha256)" \
		"$(identity_cleanup_marker_value queue_drain_evidence_sha256)" \
		"$(identity_cleanup_marker_value stopped_writers_evidence_sha256)" \
		"$(identity_cleanup_marker_value soak_evidence_sha256)"
}

identity_cleanup_require_common() {
	[[ $# -eq 1 && "$1" =~ ^(healthy-required|identity-if-present)$ ]] || return 1
	local restore_guard_mode="$1"
	identity_database_require_root
	identity_release_validate_revision "$EXPECTED_REVISION"
	identity_release_validate_file "$ENV_FILE"
	identity_release_validate_file "$COMPOSE_FILE"
	identity_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION"
	identity_cutover_prepare_node_runtime ||
		identity_cleanup_fail 'could not attest the cleanup Node runtime before stopping Core workers' || return 1
	identity_cleanup_require_env_source_sha
	database_restore_guard_assert_before_mutation "$restore_guard_mode" "$ENV_FILE"
	identity_cutover_require_route_contract || return 1
	identity_cutover_require_tokens || return 1
	identity_database_validate_marker || return 1
	identity_cutover_validate_marker || return 1
	[[ "$(identity_database_current_phase)" == 'complete' &&
		"$(identity_cutover_marker_value phase)" == 'complete' &&
		"$(identity_database_marker_value ownership_revision)" == "$(identity_cutover_marker_value revision)" ]] ||
		identity_cleanup_fail 'Identity ownership and recovery gates must be complete before Core cleanup' || return 1
	identity_cleanup_require_soak
	identity_cleanup_require_migration
	if [[ ! -e "$identity_cleanup_root" && ! -L "$identity_cleanup_root" ]]; then
		mkdir -m 700 "$identity_cleanup_root"
		chown 0:0 "$identity_cleanup_root"
	fi
	[[ -d "$identity_cleanup_root" && ! -L "$identity_cleanup_root" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_cleanup_root")" == '0:0:700' ]] || return 1
	fi
}

identity_cleanup_verify() {
	identity_cleanup_require_common healthy-required
	acquire_production_deploy_lock 'Identity Core cleanup verification'
	if [[ -e "$identity_cleanup_marker" || -L "$identity_cleanup_marker" ]]; then
		identity_cleanup_validate_marker || return 1
		[[ "$(identity_cleanup_marker_value cleanup_revision)" == "$EXPECTED_REVISION" ]] || return 1
		printf 'identity_core_cleanup_phase=%s\n' "$(identity_cleanup_marker_value phase)"
		return
	fi
	identity_cleanup_assert_candidate_signing_boundary
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		build --pull api maintenance-worker database-restore-worker
	identity_cutover_verify_image "winwidget-api:git-$EXPECTED_REVISION" "$EXPECTED_REVISION"
	identity_cutover_require_core_fenced_live
	identity_cleanup_assert_identity_runtime_stable
	identity_cleanup_capture_soak_evidence
	identity_cleanup_assert_identity_queues_drained
	identity_cleanup_create_backup DATABASE_BACKUP_URL public "$identity_cleanup_core_backup" \
		"$identity_cleanup_core_backup_journal" "$(identity_cutover_marker_value revision)"
	identity_cleanup_create_backup IDENTITY_BACKUP_URL identity "$identity_cleanup_identity_backup" \
		"$identity_cleanup_identity_backup_journal" "$(identity_cutover_marker_value revision)"
	identity_cutover_run_restore_rehearsal pre-cutover "$identity_cleanup_identity_backup" \
		"$identity_cleanup_identity_restore"
	identity_cleanup_write_marker verified "$(identity_cutover_marker_value revision)" \
		"$EXPECTED_REVISION" "$IDENTITY_CORE_CLEANUP_MIGRATION" \
		"$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" \
		"$(identity_cutover_sha256 "$identity_cleanup_core_backup")" \
		"$(identity_cutover_sha256 "$identity_cleanup_identity_backup")" \
		"$(identity_cutover_sha256 "$identity_cleanup_identity_restore")" \
		"$(identity_cutover_sha256 "$identity_cleanup_queue_evidence")" pending \
		"$(identity_cutover_sha256 "$identity_cleanup_soak_evidence")" pending \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'identity_core_cleanup_phase=verified\n'
}

identity_cleanup_source_state() {
	local -x IDENTITY_CLEANUP_LEDGER_URL IDENTITY_CLEANUP_LEDGER_MIGRATION_NAME
	local -x IDENTITY_CLEANUP_LEDGER_MIGRATION_SHA
	local core_postgres_image state
	IDENTITY_CLEANUP_LEDGER_URL="$(identity_read_env_value "$ENV_FILE" DATABASE_MIGRATION_URL_PRODUCTION)" || return 1
	IDENTITY_CLEANUP_LEDGER_URL="$(identity_cutover_psql_url "$IDENTITY_CLEANUP_LEDGER_URL")" || return 1
	IDENTITY_CLEANUP_LEDGER_MIGRATION_NAME="$IDENTITY_CORE_CLEANUP_MIGRATION"
	IDENTITY_CLEANUP_LEDGER_MIGRATION_SHA="$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256"
	[[ "$IDENTITY_CLEANUP_LEDGER_MIGRATION_NAME" == '20260815000000_remove_legacy_identity_core_source' &&
		"$IDENTITY_CLEANUP_LEDGER_MIGRATION_SHA" =~ ^[0-9a-f]{64}$ ]] || return 1
	core_postgres_image="$CORE_POSTGRES_IMAGE"
	state="$(docker run --rm -i --network host \
		-e IDENTITY_CLEANUP_LEDGER_URL \
		-e IDENTITY_CLEANUP_LEDGER_MIGRATION_NAME \
		-e IDENTITY_CLEANUP_LEDGER_MIGRATION_SHA \
		"$core_postgres_image" sh -euc \
		'psql --no-psqlrc --set ON_ERROR_STOP=1 --set migration_name="$IDENTITY_CLEANUP_LEDGER_MIGRATION_NAME" --set migration_sha="$IDENTITY_CLEANUP_LEDGER_MIGRATION_SHA" --tuples-only --no-align "$IDENTITY_CLEANUP_LEDGER_URL"' <<'SQL'
WITH expected_functions(value) AS (
  VALUES
    ('public.billing_emit_identity_projection(text,boolean)'),
    ('public.billing_identity_auth_projection_trigger()'),
    ('public.billing_identity_telegram_projection_trigger()'),
    ('public.billing_identity_user_projection_trigger()'),
    ('public.fence_identity_core_source(text)'),
    ('public.identity_core_source_is_open()'),
    ('public.lock_identity_core_source_open()'),
    ('public.reject_fenced_identity_auth_settings_write()'),
    ('public.reject_fenced_identity_core_source_write()'),
    ('public.reporting_auth_identity_projection_trigger()'),
    ('public.reporting_emit_user_projection(text,boolean)'),
    ('public.reporting_user_projection_trigger()'),
    ('public.unfence_identity_core_source(text)')
),
expected_triggers(value) AS (
  VALUES
    ('User:billing_identity_user_projection'),
    ('User:identity_core_source_write_fence'),
    ('User:reporting_user_projection'),
    ('auth_identities:billing_identity_auth_projection'),
    ('auth_identities:identity_core_source_write_fence'),
    ('auth_identities:reporting_auth_identity_projection'),
    ('site_settings:identity_core_auth_settings_write_fence'),
    ('telegram_notification_channels:billing_identity_telegram_projection'),
    ('telegram_notification_channels:identity_core_source_write_fence'),
    ('user_sessions:identity_core_source_write_fence'),
    ('verification_challenges:identity_core_source_write_fence')
),
actual_functions AS (
  SELECT array_agg(
    format('%s.%s(%s)', namespace.nspname, routine.proname,
      replace(pg_catalog.oidvectortypes(routine.proargtypes), ' ', ''))
    ORDER BY format('%s.%s(%s)', namespace.nspname, routine.proname,
      replace(pg_catalog.oidvectortypes(routine.proargtypes), ' ', '')) COLLATE "C") AS value
  FROM pg_catalog.pg_proc routine
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
  WHERE namespace.nspname = 'public'
    AND (starts_with(routine.proname, 'billing_identity_')
      OR (starts_with(routine.proname, 'reporting_') AND position('identity' IN routine.proname) > 0)
      OR starts_with(routine.proname, 'identity_core_')
      OR starts_with(routine.proname, 'reject_fenced_identity_')
      OR starts_with(routine.proname, 'lock_identity_core_source')
      OR starts_with(routine.proname, 'fence_identity_core_source')
      OR starts_with(routine.proname, 'unfence_identity_core_source')
      OR starts_with(routine.proname, 'reporting_emit_user_projection')
      OR starts_with(routine.proname, 'reporting_user_projection')
      OR starts_with(routine.proname, 'billing_emit_identity_projection'))
),
actual_triggers AS (
  SELECT array_agg(format('%s:%s', relation.relname, trigger.tgname)
    ORDER BY format('%s:%s', relation.relname, trigger.tgname) COLLATE "C") AS value
  FROM pg_catalog.pg_trigger trigger
  JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public' AND NOT trigger.tgisinternal
    AND (relation.relname = ANY(ARRAY['User','auth_identities','telegram_notification_channels',
      'user_sessions','verification_challenges','identity_core_source_state'])
      OR (relation.relname = 'site_settings' AND trigger.tgname LIKE 'identity_core_%'))
),
shape AS (
  SELECT
    current_database() = 'default_db' AS target_database,
    (SELECT count(*) FROM unnest(ARRAY['User','auth_identities','telegram_notification_channels',
      'user_sessions','verification_challenges','identity_core_source_state']) AS target(relation_name)
      WHERE to_regclass(format('public.%I', relation_name)) IS NOT NULL) AS table_count,
    (SELECT count(*) FROM unnest(ARRAY['Role','UserStatus','AuthIdentityType',
      'VerificationChallengeType','VerificationChallengePurpose']) AS target(type_name)
      WHERE to_regtype(format('public.%I', type_name)) IS NOT NULL) AS type_count,
    (SELECT count(*) FROM pg_catalog.pg_attribute attribute
      JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = 'site_settings'
        AND attribute.attname = ANY(ARRAY['recaptcha_enabled','google_auth_enabled','yandex_auth_enabled',
          'github_auth_enabled','vk_auth_enabled','telegram_auth_enabled'])
        AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS column_count,
    (SELECT value FROM actual_functions) AS function_set,
    (SELECT array_agg(value ORDER BY value COLLATE "C") FROM expected_functions) AS expected_function_set,
    (SELECT value FROM actual_triggers) AS trigger_set,
    (SELECT array_agg(value ORDER BY value COLLATE "C") FROM expected_triggers) AS expected_trigger_set
),
ledger AS (
  SELECT
    count(*) FILTER (WHERE checksum <> :'migration_sha') AS mismatched,
    count(*) FILTER (WHERE checksum = :'migration_sha' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
    count(*) FILTER (WHERE checksum = :'migration_sha' AND finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished,
    count(*) FILTER (WHERE checksum = :'migration_sha' AND finished_at IS NULL AND rolled_back_at IS NOT NULL) AS rolled_back,
    count(*) FILTER (WHERE checksum = :'migration_sha') AS exact
  FROM public."_prisma_migrations"
  WHERE migration_name = :'migration_name'
),
classified AS (
  SELECT shape.*, ledger.*,
    ledger.applied + ledger.unfinished + ledger.rolled_back = ledger.exact AS exact_ledger,
    shape.table_count = 0 AND shape.type_count = 0 AND shape.column_count = 0
      AND shape.function_set IS NULL AND shape.trigger_set IS NULL AS source_absent,
    shape.table_count = 6 AND shape.type_count = 5 AND shape.column_count = 6
      AND shape.function_set IS NOT DISTINCT FROM shape.expected_function_set
      AND shape.trigger_set IS NOT DISTINCT FROM shape.expected_trigger_set AS source_present
  FROM shape CROSS JOIN ledger
)
SELECT CASE
  WHEN target_database AND mismatched = 0 AND exact_ledger AND source_absent
    AND applied = 1 AND unfinished = 0 THEN 'absent|applied'
  WHEN target_database AND mismatched = 0 AND exact_ledger AND source_present
    AND applied = 0 AND unfinished = 0 THEN 'present|pending'
  WHEN target_database AND mismatched = 0 AND exact_ledger AND source_present
    AND applied = 0 AND unfinished = 1 THEN 'present|failed'
  ELSE 'unsafe'
END
FROM classified;
SQL
	)" || return 1
	[[ "$state" =~ ^(absent\|applied|present\|pending|present\|failed|unsafe)$ ]] || return 1
	printf '%s' "$state"
}

identity_cleanup_core_container_id() {
	[[ $# -eq 1 ]] || return 1
	case "$1" in
	api | integration-worker | outbox-publisher | maintenance-worker | database-restore-worker) ;;
	*) return 1 ;;
	esac
	local container_id
	container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps -a -q "$1")" || return 1
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s' "$container_id"
}

identity_cleanup_core_service_image() {
	[[ $# -eq 1 ]] || return 1
	case "$1" in
	api | integration-worker | outbox-publisher | maintenance-worker | database-restore-worker) ;;
	*) return 1 ;;
	esac
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		config --format json | CORE_SERVICE="$1" node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const service = process.env.CORE_SERVICE;
  const image = JSON.parse(input)?.services?.[service]?.image;
  if (typeof image !== "string" || !image || /[\r\n]/.test(image)) process.exit(1);
  process.stdout.write(image);
});
'
}

identity_cleanup_core_container_hostname() {
	[[ $# -eq 1 ]] || return 1
	local container_id hostname
	container_id="$(identity_cleanup_core_container_id "$1")" || return 1
	hostname="$(docker inspect --format '{{.Config.Hostname}}' "$container_id")" || return 1
	[[ "$hostname" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || return 1
	printf '%s' "$hostname"
}

identity_cleanup_verify_started_core_containers() {
	[[ $# -eq 1 && "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || return 1
	local started_after="$1" service container_id expected_image container_image
	local image_id expected_image_id image_revision state running restart_count health container_started_at
	local container_ids=''
	for service in api integration-worker outbox-publisher maintenance-worker database-restore-worker; do
		container_id="$(identity_cleanup_core_container_id "$service")" || return 1
		expected_image="$(identity_cleanup_core_service_image "$service")" || return 1
		container_image="$(docker inspect --format '{{.Config.Image}}' "$container_id")" || return 1
		image_id="$(docker inspect --format '{{.Image}}' "$container_id")" || return 1
		expected_image_id="$(docker image inspect --format '{{.Id}}' "$expected_image")" || return 1
		image_revision="$(docker image inspect --format \
			'{{index .Config.Labels "org.opencontainers.image.revision"}}' "$expected_image")" || return 1
		state="$(docker inspect --format '{{.State.Status}}' "$container_id")" || return 1
		running="$(docker inspect --format '{{.State.Running}}' "$container_id")" || return 1
		restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")" || return 1
		health="$(docker inspect --format \
			'{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")" || return 1
		container_started_at="$(docker inspect --format '{{.State.StartedAt}}' "$container_id")" || return 1
		[[ "$container_image" == "$expected_image" && "$image_id" == "$expected_image_id" &&
			"$image_id" =~ ^sha256:[0-9a-f]{64}$ && "$image_revision" == "$EXPECTED_REVISION" &&
			"$state" == 'running' && "$running" == 'true' && "$restart_count" == '0' ]] || return 1
		case "$service:$health" in
		api:healthy | maintenance-worker:healthy | database-restore-worker:healthy | \
			integration-worker:none | outbox-publisher:none) ;;
		*) return 1 ;;
		esac
		CONTAINER_STARTED_AT="$container_started_at" STARTED_AFTER="$started_after" node -e '
const startedAt = Date.parse(process.env.CONTAINER_STARTED_AT || "");
const startedAfter = Date.parse(process.env.STARTED_AFTER || "");
if (!Number.isFinite(startedAt) || !Number.isFinite(startedAfter) || startedAt < startedAfter) process.exit(1);
' || return 1
		container_ids+="$container_id"$'\n'
	done
	[[ "$(sed '/^$/d' <<<"$container_ids" | LC_ALL=C sort -u | wc -l | tr -d ' ')" == '5' ]] || return 1
	curl -fsS --connect-timeout 2 --max-time 5 \
		http://127.0.0.1:4200/api/v1/health/ready >/dev/null || return 1
	curl -fsS --connect-timeout 2 --max-time 5 \
		http://127.0.0.1:4300/health/ready >/dev/null || return 1
}

identity_cleanup_verify_started_core_heartbeats() {
	[[ $# -eq 1 && "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || return 1
	local PGURL STARTED_AT OUTBOX_HOST INTEGRATION_HOST MAINTENANCE_HOST core_postgres_image result
	PGURL="$(identity_read_env_value "$ENV_FILE" DATABASE_MIGRATION_URL_PRODUCTION)" || return 1
	PGURL="$(identity_cutover_psql_url "$PGURL")" || return 1
	STARTED_AT="$1"
	OUTBOX_HOST="$(identity_cleanup_core_container_hostname outbox-publisher)" || return 1
	INTEGRATION_HOST="$(identity_cleanup_core_container_hostname integration-worker)" || return 1
	MAINTENANCE_HOST="$(identity_cleanup_core_container_hostname maintenance-worker)" || return 1
	core_postgres_image="$CORE_POSTGRES_IMAGE"
	export PGURL STARTED_AT OUTBOX_HOST INTEGRATION_HOST MAINTENANCE_HOST
	result="$(docker run --rm -i --network host \
		-e PGURL -e STARTED_AT -e OUTBOX_HOST -e INTEGRATION_HOST -e MAINTENANCE_HOST \
		"$core_postgres_image" sh -euc '
psql --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align \
  --set started_at="$STARTED_AT" --set outbox_host="$OUTBOX_HOST" \
  --set integration_host="$INTEGRATION_HOST" --set maintenance_host="$MAINTENANCE_HOST" "$PGURL"
' <<'SQL'
WITH required(service, hostname) AS (
  VALUES
    ('outbox-publisher', :'outbox_host'),
    ('integration-worker', :'integration_host'),
    ('maintenance-worker', :'maintenance_host')
)
SELECT count(*)
FROM required
WHERE (
  SELECT count(*)
  FROM public.messaging_heartbeats heartbeat
  WHERE heartbeat.service = required.service
    AND heartbeat.metadata->>'hostname' = required.hostname
    AND heartbeat.last_seen_at >= :'started_at'::timestamptz
    AND heartbeat.last_seen_at >= clock_timestamp() - interval '90 seconds'
) = 1;
SQL
	)" || return 1
	unset PGURL STARTED_AT OUTBOX_HOST INTEGRATION_HOST MAINTENANCE_HOST
	[[ "$result" == '3' ]]
}

identity_cleanup_verify_started_core_rabbitmq() {
	local core_image expected_kinds integration_queues integration_container_hostname
	core_image="winwidget-api:git-$EXPECTED_REVISION"
	expected_kinds="$(identity_read_env_value "$ENV_FILE" INTEGRATION_WORKER_KINDS)" || return 1
	[[ -n "$expected_kinds" ]] || return 1
	integration_container_hostname="$(identity_cleanup_core_container_hostname integration-worker)" || return 1
	integration_queues="$(docker run --rm --network none \
		-e "EXPECTED_INTEGRATION_KINDS=$expected_kinds" --entrypoint node "$core_image" -e '
const { MESSAGING_QUEUE_NAMES, MONOLITH_INTEGRATION_KINDS } = require("./dist/src/messaging/messaging.constants.js");
const kinds = String(process.env.EXPECTED_INTEGRATION_KINDS || "").split(",").map(value => value.trim()).filter(Boolean);
if (kinds.length !== MONOLITH_INTEGRATION_KINDS.length || new Set(kinds).size !== kinds.length ||
    JSON.stringify(kinds) !== JSON.stringify(MONOLITH_INTEGRATION_KINDS)) process.exit(1);
const queues = kinds.map(kind => MESSAGING_QUEUE_NAMES[kind]);
if (queues.some(queue => typeof queue !== "string" || !queue) || new Set(queues).size !== queues.length) process.exit(1);
process.stdout.write(JSON.stringify(queues));
')" || return 1
	INTEGRATION_QUEUES_JSON="$integration_queues" \
		INTEGRATION_CONTAINER_HOST="$integration_container_hostname" REVISION="$EXPECTED_REVISION" \
		docker run --rm --network host --env-file "$ENV_FILE" \
		-e INTEGRATION_QUEUES_JSON -e INTEGRATION_CONTAINER_HOST -e REVISION \
		--entrypoint node "$core_image" -e '
class ReadinessError extends Error {}
const parseQueues = () => {
  let value;
  try { value = JSON.parse(process.env.INTEGRATION_QUEUES_JSON || ""); }
  catch { throw new ReadinessError("Core integration queue contract is invalid"); }
  if (!Array.isArray(value) || !value.length || value.some(queue => typeof queue !== "string" || !queue) ||
      new Set(value).size !== value.length) throw new ReadinessError("Core integration queue contract is incomplete");
  return value;
};
const decodeUser = name => {
  try {
    const user = decodeURIComponent(new URL(process.env[name] || "").username);
    if (!user) throw new Error();
    return user;
  } catch { throw new ReadinessError(`${name} user is invalid`); }
};
const run = async () => {
  const baseUrl = String(process.env.RABBITMQ_MANAGEMENT_URL || "http://127.0.0.1:15672").replace(/\/$/, "");
  const vhost = process.env.RABBITMQ_VHOST;
  const adminUser = process.env.RABBITMQ_ADMIN_USER;
  const adminPassword = process.env.RABBITMQ_ADMIN_PASSWORD;
  const revision = process.env.REVISION;
  const hostname = process.env.INTEGRATION_CONTAINER_HOST;
  if (vhost !== "winwidget" || !adminUser || !adminPassword || !/^[0-9a-f]{40}$/.test(revision || "") ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(hostname || "")) throw new ReadinessError("Core RabbitMQ readiness inputs are invalid");
  const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
  const request = async path => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: authorization }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReadinessError(`RabbitMQ Management returned HTTP ${response.status}`);
    }
    return response.json();
  };
  const nodes = await request("/api/nodes");
  if (!Array.isArray(nodes) || !nodes.length || nodes.some(node => node.running === false ||
      node.mem_alarm === true || node.disk_free_alarm === true ||
      (Array.isArray(node.partitions) && node.partitions.length))) {
    throw new ReadinessError("RabbitMQ node is not healthy");
  }
  const connections = await request("/api/connections");
  if (!Array.isArray(connections)) throw new ReadinessError("RabbitMQ connections response is invalid");
  const integrationUser = decodeUser("RABBITMQ_INTEGRATION_WORKER_URL");
  const publisherUser = decodeUser("RABBITMQ_PUBLISHER_URL");
  const exactConnection = (name, user) => {
    const matches = connections.filter(connection => connection?.client_properties?.connection_name === name);
    if (matches.length !== 1 || matches[0]?.user !== user || matches[0]?.state !== "running") {
      throw new ReadinessError(`RabbitMQ connection ${name} is not uniquely ready`);
    }
    return matches[0];
  };
  const integration = exactConnection("winwidget-integration-worker", integrationUser);
  exactConnection("winwidget-outbox-publisher", publisherUser);
  for (const queue of parseQueues()) {
    for (const name of [queue, `${queue}.dead-letter`]) {
      const state = await request(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(name)}`);
      const consumers = Array.isArray(state?.consumer_details) ? state.consumer_details : [];
      const expectedTag = `winwidget-integration-worker:${revision}:${hostname}:${name}`;
      if (state?.consumers !== 1 || consumers.length !== 1 || consumers[0]?.consumer_tag !== expectedTag ||
          consumers[0]?.channel_details?.connection_name !== integration.name) {
        throw new ReadinessError(`RabbitMQ queue ${name} is not owned by the restarted Core integration worker`);
      }
    }
  }
};
run().catch(error => {
  process.stderr.write(`${error instanceof ReadinessError ? error.message : "Core RabbitMQ readiness failed"}\n`);
  process.exitCode = 1;
});
'
}

identity_cleanup_wait_started_core_ready() {
	[[ $# -eq 1 ]] || return 1
	local attempt
	for ((attempt = 1; attempt <= 60; attempt++)); do
		if identity_cleanup_verify_started_core_containers "$1" &&
			identity_cleanup_verify_started_core_heartbeats "$1" &&
			identity_cleanup_verify_started_core_rabbitmq; then
			return 0
		fi
		sleep 2
	done
	identity_cleanup_fail 'restarted Core processes did not satisfy the exact runtime and messaging readiness contract'
}

identity_cleanup_start_core() {
	local started_at status
	started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate \
		api integration-worker outbox-publisher maintenance-worker database-restore-worker
	identity_cleanup_wait_started_core_ready "$started_at"
	for path in /api/v1/auth/settings /api/v1/users/me /api/v1/telegram-auth/admin/status; do
		status="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 \
			"http://127.0.0.1:4200$path" || true)"
		[[ "$status" =~ ^(404|410)$ ]] ||
			identity_cleanup_fail "legacy Core Identity route remains active: $path status=$status" || return 1
	done
	identity_cutover_wait_url https://api.winwidget.ru/api/v1/auth/.well-known/jwks.json \
		'public Identity JWKS after Core cleanup'
	identity_cutover_assert_info_webhook_owner
	local core_container identity_container core_keys identity_keys
	core_container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api)" || return 1
	identity_container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q identity-api)" || return 1
	[[ "$core_container" =~ ^[0-9a-f]{64}$ && "$identity_container" =~ ^[0-9a-f]{64}$ ]] || return 1
	core_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$core_container" |
		awk -F= '{ print $1 }' | LC_ALL=C sort -u)" || return 1
	identity_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$identity_container" |
		awk -F= '{ print $1 }' | LC_ALL=C sort -u)" || return 1
	for key in JWT_ACCESS_PRIVATE_KEY_BASE64 JWT_ACCESS_JWKS_BASE64 JWT_ACCESS_ACTIVE_KID \
		RECAPTCHA_SECRET_KEY RECAPTCHA_CLIENT_URL RECAPTCHA_ENABLED RECAPTCHA_MIN_SCORE \
		SMTP_LOGIN SMTP_PASSWORD SMTP_SERVER SMTP_CONNECTION_TIMEOUT_MS \
		SMTP_GREETING_TIMEOUT_MS SMTP_SOCKET_TIMEOUT_MS \
		SMSAERO_EMAIL SMSAERO_API_KEY SMSAERO_SIGN \
		GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_CALLBACK_URL \
		GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_CALLBACK_URL \
		YANDEX_CLIENT_ID YANDEX_CLIENT_SECRET YANDEX_CALLBACK_URL \
		VK_CLIENT_ID VK_CLIENT_SECRET VK_SERVICE_TOKEN VK_CALLBACK_URL \
		TELEGRAM_AUTH_BOT_TOKEN TELEGRAM_AUTH_BOT_USERNAME TELEGRAM_AUTH_BOT_WEBHOOK_SECRET \
		TELEGRAM_INFO_BOT_WEBHOOK_SECRET; do
		! grep -Fxq "$key" <<<"$core_keys" ||
			identity_cleanup_fail "clean Core container still receives Identity-owned $key" || return 1
		grep -Fxq "$key" <<<"$identity_keys" ||
			identity_cleanup_fail "Identity API lost required Identity-owned key $key" || return 1
	done
	for key in TELEGRAM_INFO_BOT_TOKEN TELEGRAM_INFO_BOT_USERNAME \
		TELEGRAM_SUPPORT_BOT_TOKEN TELEGRAM_SUPPORT_BOT_USERNAME TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET; do
		grep -Fxq "$key" <<<"$core_keys" ||
			identity_cleanup_fail "clean Core container lost required $key" || return 1
	done
	for key in TELEGRAM_WEBHOOK_HOST TELEGRAM_INFO_BOT_TOKEN TELEGRAM_INFO_BOT_USERNAME \
		TELEGRAM_INFO_BOT_WEBHOOK_SECRET; do
		grep -Fxq "$key" <<<"$identity_keys" ||
			identity_cleanup_fail "Identity API lost required Info webhook setting $key" || return 1
	done
	for key in JWT_ACCESS_PRIVATE_KEY_BASE64 JWT_ACCESS_JWKS_BASE64 JWT_ACCESS_ACTIVE_KID; do
		awk -F= -v key="$key" '$1 == key { found += 1 } END { exit(found == 0 ? 0 : 1) }' "$ENV_FILE" ||
			identity_cleanup_fail "legacy Core signing key remains in backend production env: $key" || return 1
	done
}

identity_cleanup_deploy() {
	[[ "${IDENTITY_CORE_CLEANUP_CONFIRMATION:-}" == "$identity_cleanup_confirmation" ]] ||
		identity_cleanup_fail 'Core source cleanup requires exact confirmation' || return 1
	identity_cleanup_require_common identity-if-present
	acquire_production_deploy_lock 'Identity Core source cleanup'
	identity_cleanup_validate_marker || return 1
	[[ "$(identity_cleanup_marker_value phase)" =~ ^(verified|forward-only)$ &&
		"$(identity_cleanup_marker_value cleanup_revision)" == "$EXPECTED_REVISION" ]] || return 1
	identity_cleanup_require_bound_evidence || return 1
	identity_cleanup_assert_identity_runtime_stable
	identity_cleanup_assert_candidate_signing_boundary
	local source_state cleanup_migration_url
	source_state="$(identity_cleanup_source_state)" || return 1
	case "$source_state" in
	present\|pending | present\|failed)
		identity_cutover_require_core_fenced_live
		identity_cleanup_assert_live_queue_boundary
		if [[ "$(identity_cleanup_marker_value phase)" == 'verified' ]]; then
			identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
				stop --timeout 90 api integration-worker outbox-publisher maintenance-worker \
				database-restore-worker
		fi
		identity_cleanup_capture_stopped_writers_evidence
		identity_cleanup_write_marker forward-only "$(identity_cleanup_marker_value ownership_revision)" \
			"$EXPECTED_REVISION" "$IDENTITY_CORE_CLEANUP_MIGRATION" \
			"$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" \
			"$(identity_cleanup_marker_value core_backup_sha256)" \
			"$(identity_cleanup_marker_value identity_backup_sha256)" \
			"$(identity_cleanup_marker_value identity_restore_evidence_sha256)" \
			"$(identity_cleanup_marker_value queue_drain_evidence_sha256)" \
			"$(identity_cutover_sha256 "$identity_cleanup_stopped_writers_evidence")" \
			"$(identity_cleanup_marker_value soak_evidence_sha256)" pending \
			"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		identity_cleanup_require_bound_evidence || return 1
		identity_cleanup_remove_core_signing_env
		cleanup_migration_url="$(identity_cleanup_migration_url)" ||
			identity_cleanup_fail 'could not derive evidence-bound Identity cleanup migration URL' || return 1
		if [[ "$source_state" == 'present|failed' ]]; then
			DATABASE_URL="$cleanup_migration_url" \
				identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
				--profile migration run --rm -T --no-deps -e DATABASE_URL migrate \
				migrate resolve --rolled-back "$IDENTITY_CORE_CLEANUP_MIGRATION"
		fi
		DATABASE_URL="$cleanup_migration_url" \
			identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			--profile migration run --rm -T --no-deps -e DATABASE_URL migrate
		unset cleanup_migration_url
		[[ "$(identity_cleanup_source_state)" == 'absent|applied' ]] ||
			identity_cleanup_fail 'Identity Core source cleanup did not reach absent|applied' || return 1
		;;
	absent\|applied)
		[[ "$(identity_cleanup_marker_value phase)" == 'forward-only' ]] ||
			identity_cleanup_fail 'applied cleanup requires the forward-only marker' || return 1
		identity_cleanup_remove_core_signing_env
		;;
	*)
		identity_cleanup_fail "Identity Core source/ledger state is unsafe: $source_state" || return 1
		;;
	esac
	identity_cleanup_start_core
	identity_cleanup_create_backup DATABASE_BACKUP_URL public "$identity_cleanup_post_core_backup" \
		"$identity_cleanup_post_core_backup_journal" "$(identity_cutover_marker_value revision)"
	identity_database_mark_cleanup "$EXPECTED_REVISION"
	identity_cleanup_write_marker complete "$(identity_cleanup_marker_value ownership_revision)" \
		"$EXPECTED_REVISION" "$IDENTITY_CORE_CLEANUP_MIGRATION" \
		"$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" \
		"$(identity_cleanup_marker_value core_backup_sha256)" \
		"$(identity_cleanup_marker_value identity_backup_sha256)" \
		"$(identity_cleanup_marker_value identity_restore_evidence_sha256)" \
		"$(identity_cleanup_marker_value queue_drain_evidence_sha256)" \
		"$(identity_cleanup_marker_value stopped_writers_evidence_sha256)" \
		"$(identity_cleanup_marker_value soak_evidence_sha256)" \
		"$(identity_cutover_sha256 "$identity_cleanup_post_core_backup")" \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'identity_core_cleanup_phase=complete\n'
}

identity_cleanup_status() {
	if [[ ! -e "$identity_cleanup_marker" && ! -L "$identity_cleanup_marker" ]]; then
		printf 'identity_core_cleanup_phase=absent\n'
		return
	fi
	identity_cleanup_validate_marker || return 1
	printf 'identity_core_cleanup_phase=%s\n' "$(identity_cleanup_marker_value phase)"
	printf 'identity_core_cleanup_revision=%s\n' "$(identity_cleanup_marker_value cleanup_revision)"
}

identity_cleanup_self_test() {
	identity_cleanup_transition_allowed absent verified
	identity_cleanup_transition_allowed verified forward-only
	identity_cleanup_transition_allowed forward-only complete
	! identity_cleanup_transition_allowed complete verified
	local base_url ownership_revision cleanup_revision evidence_sha migration_url psql_url
	base_url='postgresql://self-test:password@127.0.0.1:5432/default_db?schema=public&options=-c%20existing.setting%3Dretained'
	ownership_revision='1111111111111111111111111111111111111111'
	cleanup_revision='2222222222222222222222222222222222222222'
	evidence_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	migration_url="$(identity_cleanup_build_migration_url "$base_url" \
		"$ownership_revision" "$cleanup_revision" "$evidence_sha" "$evidence_sha" \
		"$evidence_sha" "$evidence_sha" "$evidence_sha" "$evidence_sha" "$evidence_sha")"
	psql_url="$(identity_cutover_psql_url "$migration_url")"
	PSQL_URL="$psql_url" node <<'NODE'
const url = new URL(process.env.PSQL_URL || '');
if (url.pathname !== '/default_db' || url.searchParams.has('schema') ||
    !url.searchParams.get('options')?.includes('winwidget.identity_core_source_cleanup')) process.exit(1);
NODE
	MIGRATION_URL="$migration_url" OWNERSHIP_REVISION="$ownership_revision" \
		CLEANUP_REVISION="$cleanup_revision" EVIDENCE_SHA="$evidence_sha" node <<'NODE'
const url = new URL(process.env.MIGRATION_URL || '');
const options = url.searchParams.get('options') || '';
const entries = [...options.matchAll(/(?:^|\s)-c\s+([^=\s]+)=([^\s]+)/g)]
  .map(match => [match[1], match[2]]);
const expected = new Map([
  ['winwidget.identity_core_source_cleanup', 'production-destructive-approved'],
  ['winwidget.identity_ownership_phase', 'complete'],
  ['winwidget.identity_ownership_revision', process.env.OWNERSHIP_REVISION],
  ['winwidget.identity_cleanup_revision', process.env.CLEANUP_REVISION],
  ['winwidget.identity_cleanup_migration_sha256', process.env.EVIDENCE_SHA],
  ['winwidget.identity_core_backup_sha256', process.env.EVIDENCE_SHA],
  ['winwidget.identity_backup_sha256', process.env.EVIDENCE_SHA],
  ['winwidget.identity_restore_evidence_sha256', process.env.EVIDENCE_SHA],
  ['winwidget.identity_queue_drain_evidence_sha256', process.env.EVIDENCE_SHA],
  ['winwidget.identity_stopped_writers_evidence_sha256', process.env.EVIDENCE_SHA],
  ['winwidget.identity_soak_evidence_sha256', process.env.EVIDENCE_SHA],
]);
const actual = new Map(entries.filter(([key]) => key.startsWith('winwidget.identity_')));
if (url.searchParams.get('schema') !== 'public' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname !== '/default_db' || process.env.MIGRATION_URL.includes('+') ||
    entries.length !== 12 || entries[0]?.[0] !== 'existing.setting' ||
    entries[0]?.[1] !== 'retained' || actual.size !== 11 ||
    [...expected].some(([key, value]) => actual.get(key) !== value)) process.exit(1);
NODE
	node <<'NODE'
const checksum = 'a'.repeat(64);
const wrongChecksum = 'b'.repeat(64);
const applied = value => ({
  checksum: value,
  finished_at: '2026-08-15T00:00:00Z',
  rolled_back_at: null,
  logs: null,
});
const failed = value => ({
  checksum: value,
  finished_at: null,
  rolled_back_at: null,
  logs: 'migration failed',
});
const rolledBack = value => ({
  checksum: value,
  finished_at: null,
  rolled_back_at: '2026-08-15T00:01:00Z',
  logs: 'migration failed',
});
const classify = (migration, boundary) => {
  const exact = migration.filter(row => row.checksum === checksum);
  const mismatched = migration.filter(row => row.checksum !== checksum);
  const finished = exact.filter(row => row.finished_at && !row.rolled_back_at);
  const unfinished = exact.filter(row => !row.finished_at && !row.rolled_back_at);
  const rolled = exact.filter(row => !row.finished_at && row.rolled_back_at);
  const valid = mismatched.length === 0 &&
    finished.length + unfinished.length + rolled.length === exact.length;
  if (valid && boundary === 'absent' && finished.length === 1 && unfinished.length === 0) {
    return 'absent|applied';
  }
  if (valid && boundary === 'present' && finished.length === 0 && unfinished.length === 0) {
    return 'present|pending';
  }
  if (valid && boundary === 'present' && finished.length === 0 && unfinished.length === 1) {
    return 'present|failed';
  }
  return 'unsafe';
};
const cases = [
  [classify([applied(checksum)], 'absent'), 'absent|applied'],
  [classify([rolledBack(checksum), applied(checksum)], 'absent'), 'absent|applied'],
  [classify([applied(wrongChecksum)], 'absent'), 'unsafe'],
  [classify([applied(checksum), applied(checksum)], 'absent'), 'unsafe'],
  [classify([rolledBack(checksum)], 'present'), 'present|pending'],
  [classify([failed(checksum)], 'present'), 'present|failed'],
  [classify([failed(wrongChecksum)], 'present'), 'unsafe'],
  [classify([{ ...failed(checksum), finished_at: '2026-08-15T00:00:00Z', rolled_back_at: '2026-08-15T00:01:00Z' }], 'present'), 'unsafe'],
];
if (cases.some(([actual, expected]) => actual !== expected)) process.exit(1);
NODE
	identity_cleanup_runtime_has_soaked '2026-08-15T00:00:00Z' 900 '2026-08-15T00:15:00Z'
	! identity_cleanup_runtime_has_soaked '2026-08-15T00:14:01Z' 900 '2026-08-15T00:15:00Z'
	! identity_cleanup_runtime_has_soaked '2026-08-15T00:16:00Z' 900 '2026-08-15T00:15:00Z'
	! identity_cleanup_runtime_has_soaked 'invalid' 900 '2026-08-15T00:15:00Z'
	! identity_cleanup_build_migration_url "$base_url" "$ownership_revision" \
		"$ownership_revision" "$evidence_sha" "$evidence_sha" "$evidence_sha" \
		"$evidence_sha" "$evidence_sha" "$evidence_sha" "$evidence_sha" >/dev/null 2>&1
	! identity_cleanup_build_migration_url "$base_url" 'not-a-revision' \
		"$cleanup_revision" "$evidence_sha" "$evidence_sha" "$evidence_sha" \
		"$evidence_sha" "$evidence_sha" "$evidence_sha" "$evidence_sha" >/dev/null 2>&1
	! identity_cleanup_build_migration_url "$base_url" "$ownership_revision" \
		"$cleanup_revision" "$(printf '%064d' 0)" "$evidence_sha" "$evidence_sha" \
		"$evidence_sha" "$evidence_sha" "$evidence_sha" "$evidence_sha" >/dev/null 2>&1
	! identity_cleanup_build_migration_url "$base_url" "$ownership_revision" \
		"$cleanup_revision" "${evidence_sha%?}" "$evidence_sha" "$evidence_sha" \
		"$evidence_sha" "$evidence_sha" "$evidence_sha" "$evidence_sha" >/dev/null 2>&1
	! identity_cleanup_build_migration_url "$base_url" "$ownership_revision" \
		"$cleanup_revision" "$evidence_sha" "$evidence_sha" "$evidence_sha" \
		"$evidence_sha" "$evidence_sha" "$evidence_sha" >/dev/null 2>&1
	! identity_cleanup_build_migration_url \
		'postgresql://self-test:password@127.0.0.1:5432/default_db?options=-c%20one%3D1&options=-c%20two%3D2' \
		"$ownership_revision" "$cleanup_revision" "$evidence_sha" "$evidence_sha" \
		"$evidence_sha" "$evidence_sha" "$evidence_sha" "$evidence_sha" "$evidence_sha" >/dev/null 2>&1
	! identity_cleanup_build_migration_url \
		'postgresql://self-test:password@127.0.0.1:5432/not_default_db' \
		"$ownership_revision" "$cleanup_revision" "$evidence_sha" "$evidence_sha" \
		"$evidence_sha" "$evidence_sha" "$evidence_sha" "$evidence_sha" "$evidence_sha" >/dev/null 2>&1
	(
		local temporary artifact artifact_sha
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/identity-cleanup-self-test.XXXXXX")"
		artifact="$temporary/evidence"
		trap 'rm -f -- "$artifact"; rmdir -- "$temporary"' EXIT
		printf 'reviewed-evidence\n' >"$artifact"
		artifact_sha="$(identity_cutover_sha256 "$artifact")"
		identity_cleanup_require_artifact_sha "$artifact_sha" "$artifact"
		printf 'drift\n' >>"$artifact"
		! identity_cleanup_require_artifact_sha "$artifact_sha" "$artifact"
	)
	for signing_crash_point in before-env-rename after-env-rename; do
		(
			local temporary source_sha result_sha
			temporary="$(mktemp -d "${TMPDIR:-/tmp}/identity-signing-journal-self-test.XXXXXX")"
			trap 'rm -f -- "$ENV_FILE" "$identity_cleanup_signing_candidate" "$identity_cleanup_signing_marker"; rmdir -- "$temporary"' EXIT
			ENV_FILE="$temporary/backend.env"
			identity_cleanup_signing_marker="$temporary/signing-journal"
			identity_cleanup_signing_candidate="${identity_cleanup_signing_marker}.prepared-env"
			EXPECTED_REVISION="$cleanup_revision"
			printf '%s\n' \
				'JWT_ACCESS_PRIVATE_KEY_BASE64=legacy-private' \
				'JWT_ACCESS_JWKS_BASE64=legacy-jwks' \
				'JWT_ACCESS_ACTIVE_KID=legacy-kid' \
				'IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64=identity-private' \
				'IDENTITY_JWT_ACCESS_JWKS_BASE64=identity-jwks' \
				'IDENTITY_JWT_ACCESS_ACTIVE_KID=identity-kid' \
				'RETAINED_KEY=retained-value' >"$ENV_FILE"
			chmod 600 "$ENV_FILE"
			if [[ "$(id -u)" != '0' ]]; then chown() { :; }; fi
			source_sha="$(identity_cleanup_env_sha256)"
			IDENTITY_ENV_EXPECTED_SHA256="$source_sha"
			identity_cleanup_build_signing_candidate "$ENV_FILE" "$identity_cleanup_signing_candidate"
			result_sha="$(identity_cutover_sha256 "$identity_cleanup_signing_candidate")"
			identity_cleanup_write_signing_marker prepared "$source_sha" "$result_sha"
			if [[ "$signing_crash_point" == 'after-env-rename' ]]; then
				mv -f -- "$identity_cleanup_signing_candidate" "$ENV_FILE"
			fi
			identity_cleanup_remove_core_signing_env >/dev/null
			[[ "$(identity_cleanup_signing_marker_value phase)" == 'complete' &&
				"$(identity_cleanup_env_sha256)" == "$result_sha" &&
				! -e "$identity_cleanup_signing_candidate" ]]
			! awk -F= '$1 ~ /^JWT_ACCESS_(PRIVATE_KEY_BASE64|JWKS_BASE64|ACTIVE_KID)$/ { found = 1 } END { exit(found ? 0 : 1) }' "$ENV_FILE"
			awk -F= '$1 ~ /^IDENTITY_JWT_ACCESS_(PRIVATE_KEY_BASE64|JWKS_BASE64|ACTIVE_KID)$/ { found += 1 } END { exit(found == 3 ? 0 : 1) }' "$ENV_FILE"
		)
	done
	(
		local temporary destination journal staging backup_ownership_revision artifact_sha
		temporary="$(mktemp -d "${TMPDIR:-/tmp}/identity-backup-journal-self-test.XXXXXX")"
		destination="$temporary/identity.dump"
		journal="${destination}.capture-v1"
		staging="${destination}.prepared"
		backup_ownership_revision="$ownership_revision"
		EXPECTED_REVISION="$cleanup_revision"
		trap 'rm -f -- "$destination" "$journal" "$staging" "${destination}.partial"; rmdir -- "$temporary"' EXIT
		if [[ "$(id -u)" != '0' ]]; then chown() { :; }; fi
		identity_release_compose() {
			if [[ "${IDENTITY_BACKUP_SELF_TEST_MODE:-}" == 'success' ]]; then
				printf 'PGDMP-self-test-backup\n'
				return 0
			fi
			printf 'failed-partial\n'
			return 1
		}
		IDENTITY_BACKUP_SELF_TEST_MODE=failed
		! identity_cleanup_create_backup IDENTITY_BACKUP_URL identity "$destination" "$journal" \
			"$backup_ownership_revision"
		[[ ! -e "$destination" && ! -e "$journal" && ! -e "$staging" ]]
		printf 'orphaned-partial\n' >"${destination}.partial"
		chmod 600 "${destination}.partial"
		IDENTITY_BACKUP_SELF_TEST_MODE=success
		identity_cleanup_create_backup IDENTITY_BACKUP_URL identity "$destination" "$journal" \
			"$backup_ownership_revision"
		[[ ! -e "${destination}.partial" &&
			"$(identity_cleanup_backup_journal_value "$journal" phase)" == 'complete' ]]
		artifact_sha="$(identity_cleanup_backup_journal_value "$journal" sha256)"
		[[ "$(identity_cutover_sha256 "$destination")" == "$artifact_sha" ]]
		IDENTITY_BACKUP_SELF_TEST_MODE=failed
		identity_cleanup_create_backup IDENTITY_BACKUP_URL identity "$destination" "$journal" \
			"$backup_ownership_revision"
		rm -f -- "$destination" "$journal"
		printf 'PGDMP-stale-valid-unbound\n' >"$destination"
		chmod 600 "$destination"
		! identity_cleanup_create_backup IDENTITY_BACKUP_URL identity "$destination" "$journal" \
			"$backup_ownership_revision"
		rm -f -- "$destination"
		printf 'PGDMP-prepared-crash\n' >"$staging"
		chmod 600 "$staging"
		artifact_sha="$(identity_cutover_sha256 "$staging")"
		identity_cleanup_write_backup_journal "$journal" prepared IDENTITY_BACKUP_URL identity \
			"$destination" "$backup_ownership_revision" "$artifact_sha"
		identity_cleanup_create_backup IDENTITY_BACKUP_URL identity "$destination" "$journal" \
			"$backup_ownership_revision"
		[[ ! -e "$staging" && "$(identity_cleanup_backup_journal_value "$journal" phase)" == 'complete' &&
			"$(identity_cutover_sha256 "$destination")" == "$artifact_sha" ]]
	)
	(
		identity_cleanup_require_bound_evidence() { return 1; }
		! identity_cleanup_migration_url
	)
	local source source_state_source deploy_source verify_source candidate_boundary_source live_boundary_source
	local common_source
	source="$(declare -f identity_cleanup_require_migration identity_cleanup_require_common \
		identity_cleanup_require_soak identity_cleanup_runtime_has_soaked \
		identity_cleanup_assert_identity_runtime_stable identity_cleanup_validate_soak_evidence \
		identity_cutover_assert_info_webhook_owner \
		identity_cleanup_capture_soak_evidence \
		identity_cleanup_assert_identity_queues_drained identity_cleanup_assert_candidate_signing_boundary \
		identity_cleanup_capture_stopped_writers_evidence identity_cleanup_require_bound_evidence \
		identity_cleanup_build_migration_url identity_cleanup_remove_core_signing_env \
		identity_cleanup_core_container_id identity_cleanup_core_service_image \
		identity_cleanup_core_container_hostname \
		identity_cleanup_verify_started_core_containers \
		identity_cleanup_verify_started_core_heartbeats \
		identity_cleanup_verify_started_core_rabbitmq identity_cleanup_wait_started_core_ready \
		identity_cleanup_start_core identity_cleanup_deploy identity_cleanup_source_state)"
	source_state_source="$(declare -f identity_cleanup_source_state)"
	common_source="$(declare -f identity_cleanup_require_common)"
	verify_source="$(declare -f identity_cleanup_verify)"
	deploy_source="$(declare -f identity_cleanup_deploy)"
	COMMON_SOURCE="$common_source" VERIFY_SOURCE="$verify_source" DEPLOY_SOURCE="$deploy_source" node -e '
const source = process.env.COMMON_SOURCE || "";
const verify = process.env.VERIFY_SOURCE || "";
const deploy = process.env.DEPLOY_SOURCE || "";
const prepare = source.indexOf("identity_cutover_prepare_node_runtime");
const firstNodeConsumer = source.indexOf("identity_cutover_require_route_contract");
if (prepare < 0 || firstNodeConsumer <= prepare ||
    !source.includes("could not attest the cleanup Node runtime before stopping Core workers") ||
    !source.includes("database_restore_guard_assert_before_mutation \"$restore_guard_mode\"") ||
    !verify.includes("identity_cleanup_require_common healthy-required")) process.exit(1);
const confirmation = deploy.indexOf("IDENTITY_CORE_CLEANUP_CONFIRMATION");
const recoveryCommon = deploy.indexOf("identity_cleanup_require_common identity-if-present");
if (confirmation < 0 || recoveryCommon <= confirmation) process.exit(1);
'
	candidate_boundary_source="$(declare -f identity_cleanup_assert_candidate_signing_boundary)"
	live_boundary_source="$(declare -f identity_cleanup_start_core)"
	CANDIDATE_BOUNDARY_SOURCE="$candidate_boundary_source" \
		LIVE_BOUNDARY_SOURCE="$live_boundary_source" node <<'NODE'
const candidate = process.env.CANDIDATE_BOUNDARY_SOURCE || '';
const live = process.env.LIVE_BOUNDARY_SOURCE || '';
const section = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) process.exit(1);
  return source.slice(from, to);
};
const identityProviders = section(candidate, 'const identityProviderKeys', 'const identityInfoWebhookKeys');
const identityInfo = section(candidate, 'const identityInfoWebhookKeys', 'const coreTelegramKeys');
const coreTelegram = section(candidate, 'const coreTelegramKeys', 'if (');
if (!identityProviders.includes('TELEGRAM_INFO_BOT_WEBHOOK_SECRET') ||
    !identityInfo.includes('TELEGRAM_WEBHOOK_HOST') ||
    !identityInfo.includes('TELEGRAM_INFO_BOT_TOKEN') ||
    !identityInfo.includes('TELEGRAM_INFO_BOT_USERNAME') ||
    !identityInfo.includes('TELEGRAM_INFO_BOT_WEBHOOK_SECRET') ||
    coreTelegram.includes('TELEGRAM_INFO_BOT_WEBHOOK_SECRET')) process.exit(1);
const identityOnlyLoop = section(live, 'for key in JWT_ACCESS_PRIVATE_KEY_BASE64', 'done');
const coreTelegramLoop = section(live, 'for key in TELEGRAM_INFO_BOT_TOKEN', 'done');
const identityInfoLoop = section(
  live.slice(live.indexOf('done', live.indexOf('for key in TELEGRAM_INFO_BOT_TOKEN')) + 4),
  'for key in TELEGRAM_WEBHOOK_HOST',
  'done',
);
if (!identityOnlyLoop.includes('TELEGRAM_INFO_BOT_WEBHOOK_SECRET') ||
    coreTelegramLoop.includes('TELEGRAM_INFO_BOT_WEBHOOK_SECRET') ||
    !identityInfoLoop.includes('TELEGRAM_INFO_BOT_TOKEN') ||
    !identityInfoLoop.includes('TELEGRAM_INFO_BOT_USERNAME') ||
    !identityInfoLoop.includes('TELEGRAM_INFO_BOT_WEBHOOK_SECRET')) process.exit(1);
NODE
	[[ "$source" == *'merge-base --is-ancestor'* &&
		"$source" == *'must add exactly the reviewed Identity Core cleanup migration'* &&
		"$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *'soak must be between 900 and 86400 seconds'* &&
		"$source" == *'RestartCount'* && "$source" == *'.State.StartedAt'* &&
		"$source" == *'minimumSoakSeconds'* && "$source" == *"'startedAt'"* &&
		"$source" == *'health/ready'* &&
		"$source" == *'legacy Core Info_bot webhook remains reachable'* &&
		"$source" == *'messages_unacknowledged !== 0'* &&
		"$source" == *'database-restore-worker'* && "$source" == *"'gen_user'"* &&
		"$source" == *'identity_cleanup_require_artifact_sha'* &&
		"$source" == *'winwidget.identity_core_source_cleanup'* &&
		"$source" == *'winwidget.identity_stopped_writers_evidence_sha256'* &&
		"$source_state_source" == *'DATABASE_MIGRATION_URL_PRODUCTION'* &&
		"$source_state_source" == *'CORE_POSTGRES_IMAGE'* &&
		"$source_state_source" == *'psql --no-psqlrc --set ON_ERROR_STOP=1'* &&
		"$source_state_source" == *"current_database() = 'default_db'"* &&
		"$source_state_source" == *"relation.relname, trigger.tgname"* &&
		"$source_state_source" == *"mismatched = 0 AND exact_ledger"* &&
		"$source_state_source" != *'DATABASE_URL_PRODUCTION'* &&
		"$source_state_source" != *'PrismaClient'* &&
		"$source" == *'api integration-worker outbox-publisher maintenance-worker database-restore-worker'* &&
		"$source" == *'.State.Health'* && "$source" == *'.RestartCount'* &&
		"$source" == *'org.opencontainers.image.revision'* &&
		"$source" == *'.Config.Hostname'* &&
		"$source" == *'messaging_heartbeats'* && "$source" == *"metadata->>'hostname'"* &&
		"$source" == *'consumer_details'* && "$source" == *'consumer_tag'* &&
		"$source" == *'winwidget-integration-worker'* &&
		"$source" == *'winwidget-outbox-publisher'* &&
		"$source" == *'RABBITMQ_INTEGRATION_WORKER_URL'* &&
		"$source" == *'RABBITMQ_PUBLISHER_URL'* &&
		"$source" == *'http://127.0.0.1:4300/health/ready'* &&
		"$source" == *'identity_cleanup_wait_started_core_ready "$started_at"'* &&
		"$source" == *'identity-api'* && "$source" == *'JWT_ACCESS_PRIVATE_KEY_BASE64'* &&
		"$source" == *'present|failed'* && "$source" == *'absent|applied'* &&
		"$source" == *'migrate resolve --rolled-back'* &&
		"$source" == *'identity_database_mark_cleanup'* ]] || return 1
	deploy_source="$(declare -f identity_cleanup_deploy)"
	DEPLOY_SOURCE="$deploy_source" node -e '
const value = process.env.DEPLOY_SOURCE || "";
const bound = value.lastIndexOf("identity_cleanup_require_bound_evidence");
const url = value.indexOf("identity_cleanup_migration_url", bound);
const migrate = value.indexOf("--profile migration run", url);
const startCore = value.indexOf("identity_cleanup_start_core", migrate);
const postBackup = value.indexOf("identity_cleanup_post_core_backup", startCore);
const cleanupMarker = value.indexOf("identity_database_mark_cleanup", postBackup);
const completeMarker = value.indexOf("identity_cleanup_write_marker complete", cleanupMarker);
if (bound < 0 || url < bound || migrate < url || startCore < migrate || postBackup < startCore ||
    cleanupMarker < postBackup || completeMarker < cleanupMarker ||
    !value.includes("-e DATABASE_URL migrate")) process.exit(1);
'
	printf 'identity_core_cleanup_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--verify) identity_cleanup_verify ;;
	--deploy | --forward-recovery) identity_cleanup_deploy ;;
	--status) identity_cleanup_status ;;
	--self-test) identity_cleanup_self_test ;;
	*) identity_cleanup_fail 'Usage: cleanup-identity-core-source-production.sh --verify|--deploy|--forward-recovery|--status|--self-test' ;;
	esac
fi
