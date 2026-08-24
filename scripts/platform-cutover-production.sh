#!/usr/bin/env bash

# Forward-only Platform ownership lifecycle. A separate Billing readiness
# checkpoint first deploys only the candidate Billing API and a phase-A Gateway:
# Billing settings are service-owned while Platform content routes still resolve
# through Core. The byte-identical final env is installed before --prepare, but
# that env is not applied to the running Gateway until target ownership is active.

set -Eeuo pipefail
umask 077
export LC_ALL=C

PLATFORM_CUTOVER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
PLATFORM_ENV_EXPECTED_SHA256="${PLATFORM_ENV_EXPECTED_SHA256:-}"
platform_cutover_marker="${PLATFORM_CUTOVER_MARKER:-$APP_ROOT/deploy/backend/.platform-cutover-v1}"
platform_evidence_parent="${PLATFORM_EVIDENCE_ROOT:-$APP_ROOT/deploy/backend/.production-evidence}"
platform_billing_readiness_receipt="${PLATFORM_BILLING_READINESS_RECEIPT:-$APP_ROOT/deploy/backend/.platform-billing-readiness-v1}"
platform_phase_a_intent="${PLATFORM_PHASE_A_INTENT:-$APP_ROOT/deploy/backend/.platform-phase-a-intent-v1}"
platform_phase_a_env_artifact="${PLATFORM_PHASE_A_ENV_ARTIFACT:-$APP_ROOT/deploy/backend/.platform-phase-a-env-v1}"
readonly PLATFORM_CUTOVER_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly PLATFORM_BILLING_OFFER_V1_QUEUE='winwidget.billing.offer.v1'
readonly PLATFORM_BILLING_OFFER_V2_QUEUE='winwidget.billing.offer.v2'
readonly PLATFORM_BILLING_OFFER_V2_EVENT='billing.offer.changed.v2'
readonly PLATFORM_CORE_PREPARE_MIGRATION='20260824000000_prepare_platform_service_ownership'
readonly PLATFORM_ADMIN_AUDIT_QUEUE='winwidget.admin.audit.platform.v1'
readonly PLATFORM_ADMIN_AUDIT_EVENT='admin.audit.platform.v1'
readonly PLATFORM_ADMIN_AUDIT_KIND='platform-admin-audit'
readonly PLATFORM_LEGACY_SETTINGS_QUEUE_PATTERN='^(winwidget\.core\.billing\.settings\.v1|winwidget\.billing\.settings-source\.v1)(\.|$)'
readonly PLATFORM_STEADY_INTEGRATION_KINDS='campaign-admin-audit,reporting-admin-audit,widgets-admin-audit,billing-admin-audit,identity-admin-audit,platform-admin-audit,billing-payment-projection,billing-subscription-projection,billing-affiliate-projection'
readonly PLATFORM_STEADY_INTEGRATION_CONFIGURE='^$'
readonly PLATFORM_STEADY_INTEGRATION_WRITE='^(winwidget\.retry|winwidget\.dead-letter)$'
readonly PLATFORM_STEADY_INTEGRATION_READ='^winwidget\.(admin\.audit\.(campaigns|reporting|widgets|billing|identity|platform)\.v1|core\.billing\.(payment-details|subscription-details|affiliate)\.v1)(\.dead-letter)?$'
readonly PLATFORM_PUBLISHER_TOPIC_WRITE='^(admin\.audit\.platform\.v1|billing\.offer\.changed\.v2)$'
readonly PLATFORM_BILLING_WORKER_CONFIGURE='^winwidget\.(billing\.(retry|dead-letter)|billing\.(identity|notification-routing|trial|referral|lifecycle-repair)\.v1(\.retry\.[123]|\.dead-letter)?|billing\.offer\.v2(\.retry\.[123]|\.dead-letter)?|billing\.notification-delivery-outcome(\.retry\.[123]|\.dead-letter)?|payment\.auto-renewal(\.retry\.[123]|\.dead-letter)?)$'
readonly PLATFORM_BILLING_WORKER_WRITE="$PLATFORM_BILLING_WORKER_CONFIGURE"
readonly PLATFORM_BILLING_WORKER_READ='^winwidget\.(events|billing\.(retry|dead-letter)|billing\.(identity|notification-routing|trial|referral|lifecycle-repair)\.v1(\.retry\.[123]|\.dead-letter)?|billing\.offer\.v2(\.retry\.[123]|\.dead-letter)?|billing\.notification-delivery-outcome(\.retry\.[123]|\.dead-letter)?|payment\.auto-renewal(\.retry\.[123]|\.dead-letter)?)$'
readonly PLATFORM_BILLING_WORKER_TOPIC_READ='^(billing\.identity\.changed\.v1|billing\.notification-routing\.changed\.v1|billing\.trial\.requested\.v1|billing\.referral\.requested\.v1|billing\.offer\.changed\.v2|billing\.lifecycle-repair\.requested\.v1|payment\.auto-renewal\.charge\.requested\.v1|notification\.delivery\.outcome\.v1)$'

# shellcheck source=scripts/platform-release-identity.sh
declare -F platform_release_compose >/dev/null ||
	source "$PLATFORM_CUTOVER_ROOT/scripts/platform-release-identity.sh"
# shellcheck source=scripts/platform-database-lifecycle.sh
declare -F platform_database_prepare >/dev/null ||
	source "$PLATFORM_CUTOVER_ROOT/scripts/platform-database-lifecycle.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
declare -F database_restore_guard_assert_before_mutation >/dev/null ||
	source "$PLATFORM_CUTOVER_ROOT/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/core-database-production-guard.sh
declare -F assert_core_database_production_boundary >/dev/null ||
	source "$PLATFORM_CUTOVER_ROOT/scripts/core-database-production-guard.sh"
# shellcheck source=scripts/platform-frontend-runtime-attestation.sh
declare -F platform_frontend_attestation_validate >/dev/null ||
	source "$PLATFORM_CUTOVER_ROOT/scripts/platform-frontend-runtime-attestation.sh"
# shellcheck source=scripts/production-deploy-lock.sh
declare -F acquire_production_deploy_lock >/dev/null ||
	source "$PLATFORM_CUTOVER_ROOT/scripts/production-deploy-lock.sh"

platform_cutover_fail() {
	printf 'platform_cutover_error=%s\n' "$1" >&2
	return 1
}

platform_cutover_rabbitmq_password_command() {
	[[ $# -eq 4 ]] || return 1
	[[ "$1" =~ ^[0-9a-f]{64}$ &&
		"$2" =~ ^(add_user|change_password|authenticate_user)$ &&
		"$3" =~ ^[A-Za-z0-9._-]+$ && ${#4} -ge 32 ]] || return 1
	local container="$1" action="$2" username="$3" password="$4"
	local image management_url admin_user admin_password vhost
	[[ "$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
		"$container")" == healthy ]] || return 1
	image="$(platform_cutover_expected_release_image_id core)" || return 1
	platform_cutover_assert_release_image_id core "$image" || return 1
	management_url="$(platform_read_env_value "$ENV_FILE" RABBITMQ_MANAGEMENT_URL)" || return 1
	admin_user="$(platform_read_env_value "$ENV_FILE" RABBITMQ_ADMIN_USER)" || return 1
	admin_password="$(platform_read_env_value "$ENV_FILE" RABBITMQ_ADMIN_PASSWORD)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	[[ "$management_url" == http://127.0.0.1:15672 && "$admin_user" == winwidget-admin &&
		${#admin_password} -ge 32 && "$vhost" == winwidget ]] || return 1
	RABBITMQ_USER_ACTION="$action" RABBITMQ_TARGET_USER="$username" \
	RABBITMQ_TARGET_PASSWORD="$password" RABBITMQ_ADMIN_USER="$admin_user" \
	RABBITMQ_ADMIN_PASSWORD="$admin_password" RABBITMQ_MANAGEMENT_URL="$management_url" \
	RABBITMQ_PROVISION_VHOST="$vhost" platform_database_docker run --rm --network host --read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --cap-drop ALL \
		--security-opt no-new-privileges --pids-limit 64 --log-driver none \
		--env RABBITMQ_USER_ACTION --env RABBITMQ_TARGET_USER --env RABBITMQ_TARGET_PASSWORD \
		--env RABBITMQ_ADMIN_USER --env RABBITMQ_ADMIN_PASSWORD --env RABBITMQ_MANAGEMENT_URL \
		--env RABBITMQ_PROVISION_VHOST --entrypoint node "$image" -e '
const amqp = require("amqplib");
const required = [
  "RABBITMQ_USER_ACTION", "RABBITMQ_TARGET_USER", "RABBITMQ_TARGET_PASSWORD",
  "RABBITMQ_ADMIN_USER", "RABBITMQ_ADMIN_PASSWORD", "RABBITMQ_MANAGEMENT_URL",
  "RABBITMQ_PROVISION_VHOST",
];
if (required.some(key => !process.env[key])) process.exit(1);
const action = process.env.RABBITMQ_USER_ACTION;
if (!["add_user", "change_password", "authenticate_user"].includes(action)) process.exit(1);
(async () => {
  if (action !== "authenticate_user") {
    const authorization = `Basic ${Buffer.from(`${process.env.RABBITMQ_ADMIN_USER}:${process.env.RABBITMQ_ADMIN_PASSWORD}`).toString("base64")}`;
    const response = await fetch(`${process.env.RABBITMQ_MANAGEMENT_URL}/api/users/${encodeURIComponent(process.env.RABBITMQ_TARGET_USER)}`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ password: process.env.RABBITMQ_TARGET_PASSWORD, tags: "" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (![201, 204].includes(response.status)) throw new Error("user update failed");
  }
  const connection = await amqp.connect({
    protocol: "amqp",
    hostname: "127.0.0.1",
    port: 5672,
    username: process.env.RABBITMQ_TARGET_USER,
    password: process.env.RABBITMQ_TARGET_PASSWORD,
    vhost: process.env.RABBITMQ_PROVISION_VHOST,
  }, { timeout: 10_000 });
  await connection.close();
})().catch(() => {
  process.stderr.write("RabbitMQ credential operation failed\n");
  process.exitCode = 1;
});
'
	local result=$?
	unset password admin_password
	return "$result"
}

platform_cutover_require_root() {
	[[ "$(id -u)" == 0 ]] ||
		platform_cutover_fail 'Platform cutover must run as root.'
}

platform_cutover_require_inputs() {
	[[ $# -le 1 && "${1:-cutover}" =~ ^(cutover|abort)$ ]] || return 1
	local mode="${1:-cutover}" database_phase
	platform_cutover_require_root
	platform_cutover_validate_paths
	platform_database_require_inputs
	database_phase="$(platform_database_current_phase)" || return 1
	if [[ "$mode" == abort ]]; then
		[[ "$database_phase" =~ ^(prepared|aborted)$ ]] ||
			platform_cutover_fail 'Platform abort requires a prepared or already-aborted database.' || return 1
	else
		[[ "$database_phase" =~ ^(prepared|active|complete)$ ]] ||
			platform_cutover_fail 'Platform database must be prepared first.' || return 1
	fi
	[[ "$(platform_database_marker_value revision)" == "$EXPECTED_REVISION" ]] ||
		platform_cutover_fail 'Platform database marker belongs to another revision.' || return 1
	platform_database_assert_marker_identity
	if [[ "$(platform_cutover_current_phase)" != absent ]]; then
		[[ "$(platform_cutover_marker_value generation)" == "$(platform_database_marker_value generation)" &&
			"$(platform_cutover_marker_value image_id)" == "$(platform_database_marker_value image_id)" &&
			"$(platform_cutover_marker_value database_id)" == "$(platform_database_marker_value database_id)" &&
			"$(platform_cutover_marker_value database_system_identifier)" == "$(platform_database_marker_value database_system_identifier)" ]] ||
			platform_cutover_fail 'Platform cutover and database identity markers differ.' || return 1
	fi
	local key
	for key in DATABASE_URL_PRODUCTION DATABASE_MIGRATION_URL_PRODUCTION DATABASE_BACKUP_URL GATEWAY_ROUTES_JSON RABBITMQ_VHOST \
		RABBITMQ_ADMIN_USER RABBITMQ_ADMIN_PASSWORD RABBITMQ_MANAGEMENT_URL RABBITMQ_PLATFORM_PUBLISHER_URL \
		RABBITMQ_INTEGRATION_WORKER_URL BILLING_BACKUP_URL; do
		[[ -n "$(platform_read_env_value "$ENV_FILE" "$key")" ]] ||
			platform_cutover_fail "Platform cutover env key is missing: $key" || return 1
	done
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
}

platform_cutover_require_billing_readiness_inputs() {
	platform_cutover_require_root || return 1
	platform_cutover_validate_paths || return 1
	platform_release_validate_revision "$EXPECTED_REVISION" || return 1
	platform_release_validate_file "$ENV_FILE" || return 1
	platform_release_validate_file "$COMPOSE_FILE" || return 1
	platform_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION" || return 1
	platform_database_require_marker_path || return 1
	platform_database_require_no_ambient_env_overrides || return 1
	platform_database_require_local_docker || return 1
	[[ "${PRODUCTION_DEPLOY_LOCK_FILE:-$APP_ROOT/deploy/backend/.production-deploy.lock}" == \
		"$APP_ROOT/deploy/backend/.production-deploy.lock" ]] || return 1
	[[ -n "$(platform_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON)" ]] || return 1
}

platform_cutover_validate_paths() {
	local approved_parent="$APP_ROOT/deploy/backend" canonical metadata owner group mode
	[[ "$APP_ROOT" == /* && "$APP_ROOT" != *$'\n'* &&
		"$platform_cutover_marker" == "$approved_parent/.platform-cutover-v1" &&
		"$platform_billing_readiness_receipt" == "$approved_parent/.platform-billing-readiness-v1" &&
		"$platform_phase_a_intent" == "$approved_parent/.platform-phase-a-intent-v1" &&
		"$platform_phase_a_env_artifact" == "$approved_parent/.platform-phase-a-env-v1" &&
		"$platform_evidence_parent" == "$approved_parent/.production-evidence" &&
		-d "$approved_parent" && ! -L "$approved_parent" ]] ||
		platform_cutover_fail 'Platform lifecycle paths are outside the approved deployment directory.' || return 1
	canonical="$(realpath -- "$approved_parent")" || return 1
	[[ "$canonical" == "$approved_parent" ]] ||
		platform_cutover_fail 'Platform deployment directory is not canonical.' || return 1
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then
		metadata="$(stat -c '%u:%g:%a' "$approved_parent")" || return 1
		IFS=: read -r owner group mode <<<"$metadata"
		[[ "$owner" == 0 && "$group" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
		(( (8#$mode & 0022) == 0 )) ||
			platform_cutover_fail 'Platform deployment directory permissions are unsafe.' || return 1
	fi
	if [[ -e "$platform_evidence_parent" || -L "$platform_evidence_parent" ]]; then
		platform_cutover_validate_private_directory "$platform_evidence_parent"
	fi
}

platform_cutover_validate_private_directory() {
	[[ $# -eq 1 && "$1" == /* && "$1" != *$'\n'* && -d "$1" && ! -L "$1" ]] || return 1
	[[ "$(realpath -- "$1")" == "$1" ]] || return 1
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then
		[[ "$(stat -c '%u:%g:%a' "$1")" == '0:0:700' ]] || return 1
	fi
}

platform_cutover_validate_private_file() {
	[[ $# -eq 1 && "$1" == /* && "$1" != *$'\n'* && -f "$1" && ! -L "$1" && -s "$1" ]] || return 1
	[[ "$(realpath -- "$1")" == "$1" ]] || return 1
	platform_cutover_validate_private_directory "$(dirname -- "$1")" || return 1
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then
		[[ "$(stat -c '%u:%g:%a' "$1")" == '0:0:600' ]] || return 1
	fi
}

platform_cutover_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z0-9_]+$ && -f "$platform_cutover_marker" &&
		! -L "$platform_cutover_marker" ]] || return 1
	awk -F= -v key="$1" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$platform_cutover_marker"
}

platform_cutover_validate_marker() {
	[[ -f "$platform_cutover_marker" && ! -L "$platform_cutover_marker" ]] || return 1
	if [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]]; then
		[[ "$(stat -c '%u:%g:%a' "$platform_cutover_marker")" == '0:0:600' ]] || return 1
	fi
	awk -F= '
		function is_hex(value, size) { return length(value) == size && value ~ /^[0-9a-f]+$/ }
		function is_sha256(value) { return substr(value, 1, 7) == "sha256:" && is_hex(substr(value, 8), 64) }
		function is_pending_or_hex(value) { return value == "pending" || is_hex(value, 64) }
		function is_generation(value) { return length(value) <= 18 && value ~ /^[1-9][0-9]*$/ }
		function is_database_id(value) { return length(value) == 36 && value ~ /^[0-9a-f-]+$/ }
		$1 !~ /^(version|phase|revision|generation|image_id|database_id|database_system_identifier|snapshot_sha256|source_fingerprint|source_high_watermark|imported_backup_sha256|imported_restore_evidence_sha256|active_backup_sha256|active_restore_evidence_sha256|updated_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			if (NR != 15 || seen["version"] != 1 || value["version"] != "1" ||
				seen["phase"] != 1 || value["phase"] !~ /^(prepared|source-fenced|imported|restore-verified|target-active|consumer-v2|core-active|complete|aborted)$/ ||
				seen["revision"] != 1 || !is_hex(value["revision"], 40) ||
				seen["generation"] != 1 || !is_generation(value["generation"]) ||
				seen["image_id"] != 1 || !is_sha256(value["image_id"]) ||
				seen["database_id"] != 1 || !is_database_id(value["database_id"]) ||
				seen["database_system_identifier"] != 1 || value["database_system_identifier"] !~ /^[1-9][0-9]*$/ ||
				seen["snapshot_sha256"] != 1 || !is_pending_or_hex(value["snapshot_sha256"]) ||
				seen["source_fingerprint"] != 1 || !is_pending_or_hex(value["source_fingerprint"]) ||
				seen["source_high_watermark"] != 1 || value["source_high_watermark"] !~ /^(pending|[1-9][0-9]*)$/ ||
				seen["imported_backup_sha256"] != 1 || !is_pending_or_hex(value["imported_backup_sha256"]) ||
				seen["imported_restore_evidence_sha256"] != 1 || !is_pending_or_hex(value["imported_restore_evidence_sha256"]) ||
				seen["active_backup_sha256"] != 1 || !is_pending_or_hex(value["active_backup_sha256"]) ||
				seen["active_restore_evidence_sha256"] != 1 || !is_pending_or_hex(value["active_restore_evidence_sha256"]) ||
				seen["updated_at"] != 1 || value["updated_at"] !~ /^[-0-9TZ:.]+$/) exit 1
			if (is_hex(value["imported_restore_evidence_sha256"], 64) &&
				!is_hex(value["imported_backup_sha256"], 64)) exit 1
			if (is_hex(value["active_restore_evidence_sha256"], 64) &&
				!is_hex(value["active_backup_sha256"], 64)) exit 1
			if (value["phase"] == "prepared" &&
				(value["snapshot_sha256"] != "pending" || value["source_fingerprint"] != "pending" ||
				 value["source_high_watermark"] != "pending" ||
				 value["imported_backup_sha256"] != "pending" || value["imported_restore_evidence_sha256"] != "pending" ||
				 value["active_backup_sha256"] != "pending" || value["active_restore_evidence_sha256"] != "pending")) exit 1
			if (value["phase"] ~ /^(source-fenced|imported|restore-verified|target-active|consumer-v2|core-active|complete)$/ &&
				(!is_hex(value["snapshot_sha256"], 64) || !is_hex(value["source_fingerprint"], 64) ||
				 value["source_high_watermark"] !~ /^[1-9][0-9]*$/)) exit 1
			if (value["phase"] == "source-fenced" &&
				(value["imported_backup_sha256"] != "pending" || value["imported_restore_evidence_sha256"] != "pending" ||
				 value["active_backup_sha256"] != "pending" || value["active_restore_evidence_sha256"] != "pending")) exit 1
			if (value["phase"] ~ /^(restore-verified|target-active|consumer-v2|core-active|complete)$/ &&
				(!is_hex(value["imported_backup_sha256"], 64) ||
				 !is_hex(value["imported_restore_evidence_sha256"], 64))) exit 1
			if (value["phase"] ~ /^(imported|restore-verified|target-active|consumer-v2)$/ &&
				(value["active_backup_sha256"] != "pending" || value["active_restore_evidence_sha256"] != "pending")) exit 1
			if (value["phase"] == "complete" &&
				(!is_hex(value["active_backup_sha256"], 64) ||
				 !is_hex(value["active_restore_evidence_sha256"], 64))) exit 1
		}
	' "$platform_cutover_marker"
}

platform_cutover_current_phase() {
	if [[ ! -e "$platform_cutover_marker" && ! -L "$platform_cutover_marker" ]]; then
		printf 'absent\n'
		return 0
	fi
	platform_cutover_validate_marker || return 1
	platform_cutover_marker_value phase
}

platform_cutover_transition_allowed() {
	case "$1:$2" in
	absent:prepared | prepared:prepared | prepared:source-fenced | \
		source-fenced:source-fenced | source-fenced:imported | \
		imported:imported | imported:restore-verified | \
		restore-verified:restore-verified | restore-verified:target-active | \
		target-active:target-active | target-active:consumer-v2 | \
		consumer-v2:consumer-v2 | consumer-v2:core-active | \
		core-active:core-active | core-active:complete | complete:complete | \
		prepared:aborted | source-fenced:aborted | imported:aborted | \
		restore-verified:aborted | aborted:aborted) return 0 ;;
	*) return 1 ;;
	esac
}

platform_cutover_write_marker() {
	[[ $# -eq 13 && "$3" =~ ^[1-9][0-9]{0,17}$ ]] || return 1
	local phase="$1" revision="$2" generation="$3" image_id="$4" database_id="$5" system_id="$6"
	local snapshot_sha="$7" fingerprint="$8" highwater="$9"
	local imported_sha="${10}" imported_restore_sha="${11}"
	local active_sha="${12}" active_restore_sha="${13}" current temporary directory
	if [[ ! -e "$platform_cutover_marker" && ! -L "$platform_cutover_marker" ]]; then
		current=absent
	else
		current="$(platform_cutover_current_phase)" ||
			platform_cutover_fail 'Existing Platform cutover marker is invalid; refusing to treat it as absent.' || return 1
	fi
	platform_cutover_transition_allowed "$current" "$phase" ||
		platform_cutover_fail "Unsafe Platform cutover transition: $current -> $phase" || return 1
	if [[ "$current" == absent ]]; then
		[[ "$generation" == "$(platform_database_marker_value generation)" ]] ||
			platform_cutover_fail 'Platform cutover generation differs from the database generation.' || return 1
	else
		[[ "$generation" == "$(platform_cutover_marker_value generation)" ]] ||
			platform_cutover_fail 'Platform cutover generation cannot change within an attempt.' || return 1
	fi
	directory="$(dirname -- "$platform_cutover_marker")"
	temporary="$(mktemp "$directory/.platform-cutover-v1.tmp.XXXXXX")" || return 1
	if ! {
		printf 'version=1\nphase=%s\nrevision=%s\ngeneration=%s\nimage_id=%s\n' "$phase" "$revision" "$generation" "$image_id"
		printf 'database_id=%s\ndatabase_system_identifier=%s\n' "$database_id" "$system_id"
		printf 'snapshot_sha256=%s\nsource_fingerprint=%s\nsource_high_watermark=%s\n' "$snapshot_sha" "$fingerprint" "$highwater"
		printf 'imported_backup_sha256=%s\nimported_restore_evidence_sha256=%s\n' "$imported_sha" "$imported_restore_sha"
		printf 'active_backup_sha256=%s\nactive_restore_evidence_sha256=%s\n' "$active_sha" "$active_restore_sha"
		printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"; then
		rm -f -- "$temporary"
		return 1
	fi
	if ! chmod 600 "$temporary" ||
		! { [[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]] || chown 0:0 "$temporary"; } ||
		! sync -f "$temporary" || ! mv -f -- "$temporary" "$platform_cutover_marker" ||
		! sync -f "$directory" || ! platform_cutover_validate_marker; then
		rm -f -- "$temporary"
		return 1
	fi
}

platform_cutover_rewrite_phase() {
	[[ $# -eq 1 ]] || return 1
	platform_cutover_write_marker "$1" \
		"$(platform_cutover_marker_value revision)" \
		"$(platform_cutover_marker_value generation)" \
		"$(platform_cutover_marker_value image_id)" \
		"$(platform_cutover_marker_value database_id)" \
		"$(platform_cutover_marker_value database_system_identifier)" \
		"$(platform_cutover_marker_value snapshot_sha256)" \
		"$(platform_cutover_marker_value source_fingerprint)" \
		"$(platform_cutover_marker_value source_high_watermark)" \
		"$(platform_cutover_marker_value imported_backup_sha256)" \
		"$(platform_cutover_marker_value imported_restore_evidence_sha256)" \
		"$(platform_cutover_marker_value active_backup_sha256)" \
		"$(platform_cutover_marker_value active_restore_evidence_sha256)"
}

platform_cutover_update_evidence() {
	[[ $# -eq 5 ]] || return 1
	local phase="$1" imported_sha="$2" imported_restore_sha="$3"
	local active_sha="$4" active_restore_sha="$5"
	platform_cutover_write_marker "$phase" \
		"$(platform_cutover_marker_value revision)" \
		"$(platform_cutover_marker_value generation)" \
		"$(platform_cutover_marker_value image_id)" \
		"$(platform_cutover_marker_value database_id)" \
		"$(platform_cutover_marker_value database_system_identifier)" \
		"$(platform_cutover_marker_value snapshot_sha256)" \
		"$(platform_cutover_marker_value source_fingerprint)" \
		"$(platform_cutover_marker_value source_high_watermark)" \
		"$imported_sha" "$imported_restore_sha" \
		"$active_sha" "$active_restore_sha"
}

platform_cutover_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
	fi
}

platform_cutover_text_sha256() {
	[[ $# -eq 1 ]] || return 1
	printf '%s' "$1" | platform_cutover_sha256 /dev/stdin
}

platform_cutover_require_expected_env_sha() {
	[[ "$PLATFORM_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
		platform_cutover_fail 'Exact local canonical backend env SHA-256 is required.' || return 1
	platform_release_validate_file "$ENV_FILE" || return 1
	[[ "$(platform_cutover_sha256 "$ENV_FILE")" == "$PLATFORM_ENV_EXPECTED_SHA256" ]] ||
		platform_cutover_fail 'Server backend env is not byte-identical to the expected local canonical file.'
}

platform_cutover_require_abort_env_sha() {
	[[ "$PLATFORM_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
		platform_cutover_fail 'Exact reviewed final backend env SHA-256 is required for abort.' || return 1
	platform_release_validate_file "$ENV_FILE" || return 1
	platform_cutover_validate_billing_readiness_receipt || return 1
	platform_cutover_validate_phase_a_env_artifact || return 1
	local current_sha phase_a_sha
	current_sha="$(platform_cutover_sha256 "$ENV_FILE")" || return 1
	phase_a_sha="$(platform_cutover_billing_readiness_value phase_a_env_sha256)" || return 1
	[[ "$current_sha" == "$PLATFORM_ENV_EXPECTED_SHA256" || "$current_sha" == "$phase_a_sha" ]] ||
		platform_cutover_fail 'Abort backend env is neither the reviewed final env nor the receipt-bound phase-A env.'
}

platform_cutover_canonical_env_without_routes_sha256() {
	[[ $# -eq 1 ]] || return 1
	platform_release_validate_file "$1" || return 1
	awk '
		/^[[:space:]]*($|#)/ { next }
		$0 !~ /^[A-Z][A-Z0-9_]*=/ { exit 1 }
		{
			separator = index($0, "=")
			key = substr($0, 1, separator - 1)
			if (seen[key]++) exit 1
			if (key != "GATEWAY_ROUTES_JSON") print $0
		}
	' "$1" | LC_ALL=C sort | platform_cutover_sha256 /dev/stdin
}

platform_cutover_container_env_sha256() {
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{64}$ &&
		( "$2" == '-' || "$2" =~ ^[A-Z][A-Z0-9_]*$ ) ]] || return 1
	platform_database_docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" |
		awk -F= -v excluded="$2" '
			$0 == "" {
				if (saw_terminator) exit 1
				saw_terminator = 1
				next
			}
			saw_terminator || index($0, "=") <= 1 ||
				$1 !~ /^[A-Z_][A-Z0-9_]*$/ { exit 1 }
			{
				if (seen[$1]++) exit 1
				if ($1 != excluded) print
			}
			END { if (!saw_terminator) exit 1 }
		' | LC_ALL=C sort | platform_cutover_sha256 /dev/stdin
}

platform_cutover_validate_phase_a_env_artifact() {
	platform_cutover_validate_private_file "$platform_phase_a_env_artifact" || return 1
	local artifact_sha
	artifact_sha="$(platform_cutover_sha256 "$platform_phase_a_env_artifact")" || return 1
	if [[ -e "$platform_billing_readiness_receipt" && ! -L "$platform_billing_readiness_receipt" ]]; then
		[[ "$artifact_sha" == "$(platform_cutover_billing_readiness_value phase_a_env_artifact_sha256)" &&
			"$artifact_sha" == "$(platform_cutover_billing_readiness_value phase_a_env_sha256)" ]] ||
			platform_cutover_fail 'Recoverable phase-A env differs from its immutable readiness receipt.' || return 1
	fi
}

platform_cutover_install_phase_a_env_artifact() {
	local current_sha directory temporary
	current_sha="$(platform_cutover_sha256 "$ENV_FILE")" || return 1
	if [[ -e "$platform_phase_a_env_artifact" || -L "$platform_phase_a_env_artifact" ]]; then
		platform_cutover_validate_phase_a_env_artifact || return 1
		[[ "$(platform_cutover_sha256 "$platform_phase_a_env_artifact")" == "$current_sha" ]] ||
			platform_cutover_fail 'Existing recoverable phase-A env belongs to another environment.' || return 1
		return
	fi
	directory="$(dirname -- "$platform_phase_a_env_artifact")"
	temporary="$(mktemp "$directory/.platform-phase-a-env-v1.tmp.XXXXXX")" || return 1
	if ! cp -- "$ENV_FILE" "$temporary" || ! chmod 600 "$temporary" ||
		! { [[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]] || chown 0:0 "$temporary"; } ||
		! sync -f "$temporary" || [[ -e "$platform_phase_a_env_artifact" || -L "$platform_phase_a_env_artifact" ]] ||
		! ln -- "$temporary" "$platform_phase_a_env_artifact" || ! rm -f -- "$temporary" ||
		! sync -f "$platform_phase_a_env_artifact" || ! sync -f "$directory" ||
		! platform_cutover_validate_phase_a_env_artifact ||
		[[ "$(platform_cutover_sha256 "$platform_phase_a_env_artifact")" != "$current_sha" ]]; then
		rm -f -- "$temporary"
		return 1
	fi
}

platform_cutover_restore_phase_a_env() {
	platform_cutover_validate_billing_readiness_receipt || return 1
	platform_cutover_validate_phase_a_env_artifact || return 1
	local expected_sha directory temporary
	expected_sha="$(platform_cutover_billing_readiness_value phase_a_env_sha256)" || return 1
	if [[ "$(platform_cutover_sha256 "$ENV_FILE")" == "$expected_sha" ]]; then
		return
	fi
	directory="$(dirname -- "$ENV_FILE")"
	temporary="$(mktemp "$directory/.env.production.platform-abort.XXXXXX")" || return 1
	if ! cp -- "$platform_phase_a_env_artifact" "$temporary" || ! chmod 600 "$temporary" ||
		! { [[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]] || chown 0:0 "$temporary"; } ||
		! sync -f "$temporary" || ! mv -f -- "$temporary" "$ENV_FILE" ||
		! sync -f "$ENV_FILE" || ! sync -f "$directory" ||
		[[ "$(platform_cutover_sha256 "$ENV_FILE")" != "$expected_sha" ]]; then
		rm -f -- "$temporary"
		platform_cutover_fail 'Abort could not restore the byte-identical phase-A backend env.'
		return 1
	fi
}

platform_cutover_require_frontend_attestation_inputs() {
	[[ "${PLATFORM_FRONTEND_REVISION:-}" =~ ^[0-9a-f]{40}$ &&
		"${PLATFORM_FRONTEND_RUNTIME_CHALLENGE:-}" =~ ^[0-9a-f]{64}$ &&
		"${PLATFORM_FRONTEND_ORIGIN:-}" =~ ^https://[a-z0-9.-]+(:[1-9][0-9]{0,4})?$ &&
		"${PLATFORM_FRONTEND_EXPECTED_ATTESTATION_SHA256:-}" =~ ^[0-9a-f]{64}$ &&
		"${PLATFORM_FRONTEND_EXPECTED_SIGNATURE_SHA256:-}" =~ ^[0-9a-f]{64}$ &&
		"${PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] ||
		platform_cutover_fail 'Pinned fresh Platform frontend attestation inputs are required.' || return 1
	if [[ -e "$platform_billing_readiness_receipt" && ! -L "$platform_billing_readiness_receipt" ]]; then
		[[ "$(platform_cutover_billing_readiness_value frontend_revision)" == "$PLATFORM_FRONTEND_REVISION" &&
			"$(platform_cutover_billing_readiness_value frontend_challenge)" == "$PLATFORM_FRONTEND_RUNTIME_CHALLENGE" &&
			"$(platform_cutover_billing_readiness_value frontend_origin_sha256)" == \
				"$(platform_cutover_text_sha256 "$PLATFORM_FRONTEND_ORIGIN")" &&
			"$(platform_cutover_billing_readiness_value trusted_public_key_sha256)" == \
				"$PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" ]] ||
			platform_cutover_fail 'Frontend attestation identity differs from the phase-A readiness generation.' || return 1
	fi
}

platform_cutover_validate_frontend_attestation() {
	[[ $# -eq 1 && "$1" =~ ^[1-9][0-9]{0,17}$ ]] || return 1
	platform_cutover_require_frontend_attestation_inputs || return 1
	local validator_image
	validator_image="$(platform_cutover_expected_release_image_id billing)" || return 1
	platform_cutover_assert_release_image_id billing "$validator_image" || return 1
	PLATFORM_BACKEND_REVISION="$EXPECTED_REVISION" \
		PLATFORM_CUTOVER_GENERATION="$1" \
		PLATFORM_FRONTEND_ATTESTATION_ROOT="$APP_ROOT/deploy/backend" \
		PLATFORM_FRONTEND_ATTESTATION_PUBLIC_KEY="$APP_ROOT/deploy/backend/platform-frontend-runtime-attestation-v2.public.pem" \
		PLATFORM_FRONTEND_ATTESTATION_FILE="$APP_ROOT/deploy/backend/platform-frontend-runtime-attestation-v2.json" \
		PLATFORM_FRONTEND_ATTESTATION_SIGNATURE="$APP_ROOT/deploy/backend/platform-frontend-runtime-attestation-v2.sig" \
		PLATFORM_FRONTEND_ATTESTATION_VALIDATOR_IMAGE="$validator_image" \
		PLATFORM_FRONTEND_ATTESTATION_MAX_AGE_SECONDS=600 \
		platform_frontend_attestation_validate >/dev/null
}

platform_cutover_phase_a_intent_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z0-9_]+$ && -f "$platform_phase_a_intent" &&
		! -L "$platform_phase_a_intent" ]] || return 1
	awk -F= -v key="$1" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$platform_phase_a_intent"
}

platform_cutover_validate_phase_a_intent() {
	platform_cutover_validate_private_file "$platform_phase_a_intent" || return 1
	awk -F= '
		function is_hex(value, size) { return length(value) == size && value ~ /^[0-9a-f]+$/ }
		$1 !~ /^(version|phase|revision|generation|phase_a_env_sha256|phase_a_routes_sha256|frontend_revision|frontend_challenge|frontend_origin_sha256|trusted_public_key_sha256|created_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			if (NR != 11 || seen["version"] != 1 || value["version"] != "1" ||
				seen["phase"] != 1 || value["phase"] != "preparing" ||
				seen["revision"] != 1 || !is_hex(value["revision"], 40) ||
				seen["generation"] != 1 || value["generation"] != "1" ||
				seen["phase_a_env_sha256"] != 1 || !is_hex(value["phase_a_env_sha256"], 64) ||
				seen["phase_a_routes_sha256"] != 1 || !is_hex(value["phase_a_routes_sha256"], 64) ||
				seen["frontend_revision"] != 1 || !is_hex(value["frontend_revision"], 40) ||
				seen["frontend_challenge"] != 1 || !is_hex(value["frontend_challenge"], 64) ||
				seen["frontend_origin_sha256"] != 1 || !is_hex(value["frontend_origin_sha256"], 64) ||
				seen["trusted_public_key_sha256"] != 1 || !is_hex(value["trusted_public_key_sha256"], 64) ||
				seen["created_at"] != 1 || value["created_at"] !~ /^[-0-9TZ:.]+$/) exit 1
		}
	' "$platform_phase_a_intent"
}

platform_cutover_write_phase_a_intent() {
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{64}$ && "$2" =~ ^[0-9a-f]{64}$ &&
		! -e "$platform_phase_a_intent" && ! -L "$platform_phase_a_intent" ]] || return 1
	local env_sha="$1" routes_sha="$2" directory temporary origin_sha
	origin_sha="$(platform_cutover_text_sha256 "$PLATFORM_FRONTEND_ORIGIN")" || return 1
	directory="$(dirname -- "$platform_phase_a_intent")" || return 1
	temporary="$(mktemp "$directory/.platform-phase-a-intent-v1.tmp.XXXXXX")" || return 1
	if ! {
		printf 'version=1\nphase=preparing\nrevision=%s\ngeneration=1\n' "$EXPECTED_REVISION"
		printf 'phase_a_env_sha256=%s\nphase_a_routes_sha256=%s\n' "$env_sha" "$routes_sha"
		printf 'frontend_revision=%s\nfrontend_challenge=%s\nfrontend_origin_sha256=%s\n' \
			"$PLATFORM_FRONTEND_REVISION" "$PLATFORM_FRONTEND_RUNTIME_CHALLENGE" "$origin_sha"
		printf 'trusted_public_key_sha256=%s\n' "$PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256"
		printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"; then
		rm -f -- "$temporary"
		return 1
	fi
	if ! chmod 600 "$temporary" ||
		! { [[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]] || chown 0:0 "$temporary"; } ||
		! sync -f "$temporary" || [[ -e "$platform_phase_a_intent" || -L "$platform_phase_a_intent" ]] ||
		! ln -- "$temporary" "$platform_phase_a_intent" || ! rm -f -- "$temporary" ||
		! sync -f "$platform_phase_a_intent" || ! sync -f "$directory" ||
		! platform_cutover_validate_phase_a_intent; then
		rm -f -- "$temporary"
		return 1
	fi
}

platform_cutover_assert_phase_a_intent_matches() {
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{64}$ && "$2" =~ ^[0-9a-f]{64}$ ]] || return 1
	platform_cutover_validate_phase_a_intent || return 1
	[[ "$(platform_cutover_phase_a_intent_value revision)" == "$EXPECTED_REVISION" &&
		"$(platform_cutover_phase_a_intent_value generation)" == 1 &&
		"$(platform_cutover_phase_a_intent_value phase_a_env_sha256)" == "$1" &&
		"$(platform_cutover_phase_a_intent_value phase_a_routes_sha256)" == "$2" &&
		"$(platform_cutover_phase_a_intent_value frontend_revision)" == "$PLATFORM_FRONTEND_REVISION" &&
		"$(platform_cutover_phase_a_intent_value frontend_challenge)" == "$PLATFORM_FRONTEND_RUNTIME_CHALLENGE" &&
		"$(platform_cutover_phase_a_intent_value frontend_origin_sha256)" == \
			"$(platform_cutover_text_sha256 "$PLATFORM_FRONTEND_ORIGIN")" &&
		"$(platform_cutover_phase_a_intent_value trusted_public_key_sha256)" == \
			"$PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" ]] ||
		platform_cutover_fail 'Phase-A preparing intent differs from the reviewed release inputs.'
}

platform_cutover_validate_phase_a_env_against_intent() {
	platform_cutover_validate_phase_a_intent || return 1
	platform_cutover_validate_private_file "$platform_phase_a_env_artifact" || return 1
	[[ "$(platform_cutover_sha256 "$platform_phase_a_env_artifact")" == \
		"$(platform_cutover_phase_a_intent_value phase_a_env_sha256)" ]] ||
		platform_cutover_fail 'Phase-A env artifact differs from its preparing intent.'
}

platform_cutover_finalize_phase_a_intent() {
	[[ $# -le 1 ]] || return 1
	local receipt="${1:-$platform_billing_readiness_receipt}" directory field
	[[ "$receipt" == /* && "$receipt" != *$'\n'* ]] || return 1
	platform_cutover_validate_billing_readiness_receipt_file "$receipt" || return 1
	if [[ ! -e "$platform_phase_a_intent" && ! -L "$platform_phase_a_intent" ]]; then
		return 0
	fi
	platform_cutover_validate_phase_a_intent || return 1
	for field in revision generation phase_a_env_sha256 phase_a_routes_sha256 \
		frontend_revision frontend_challenge frontend_origin_sha256 trusted_public_key_sha256; do
		[[ "$(platform_cutover_phase_a_intent_value "$field")" == \
			"$(platform_cutover_receipt_value_from_file "$receipt" "$field")" ]] ||
			platform_cutover_fail 'Final phase-A receipt differs from its durable preparing intent.' || return 1
	done
	directory="$(dirname -- "$platform_phase_a_intent")" || return 1
	rm -f -- "$platform_phase_a_intent" || return 1
	sync -f "$directory" || return 1
	[[ ! -e "$platform_phase_a_intent" && ! -L "$platform_phase_a_intent" ]]
}

platform_cutover_receipt_value_from_file() {
	[[ $# -eq 2 && "$1" == /* && "$1" != *$'\n'* && "$2" =~ ^[a-z0-9_]+$ &&
		-f "$1" && ! -L "$1" ]] || return 1
	awk -F= -v key="$2" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$1"
}

platform_cutover_billing_readiness_value() {
	[[ $# -eq 1 ]] || return 1
	platform_cutover_receipt_value_from_file "$platform_billing_readiness_receipt" "$1"
}

platform_cutover_validate_billing_readiness_receipt_file() {
	[[ $# -eq 1 ]] || return 1
	platform_cutover_validate_private_file "$1" || return 1
	awk -F= '
		function is_hex(value, size) { return length(value) == size && value ~ /^[0-9a-f]+$/ }
		function is_sha256(value) { return substr(value, 1, 7) == "sha256:" && is_hex(substr(value, 8), 64) }
		function is_generation(value) { return length(value) <= 18 && value ~ /^[1-9][0-9]*$/ }
		$1 !~ /^(version|phase|revision|generation|phase_a_env_sha256|phase_a_env_artifact_sha256|phase_a_env_non_route_sha256|phase_a_routes_sha256|core_api_container_id|core_api_image_id|core_api_env_sha256|billing_api_container_id|billing_api_image_id|billing_api_env_sha256|gateway_container_id|gateway_image_id|gateway_non_route_env_sha256|frontend_revision|frontend_challenge|frontend_origin_sha256|trusted_public_key_sha256|created_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			if (NR != 22 || seen["version"] != 1 || value["version"] != "1" ||
				seen["phase"] != 1 || value["phase"] != "phase-a" ||
				seen["revision"] != 1 || !is_hex(value["revision"], 40) ||
				seen["generation"] != 1 || !is_generation(value["generation"]) ||
				seen["phase_a_env_sha256"] != 1 || !is_hex(value["phase_a_env_sha256"], 64) ||
				seen["phase_a_env_artifact_sha256"] != 1 || value["phase_a_env_artifact_sha256"] != value["phase_a_env_sha256"] ||
				seen["phase_a_env_non_route_sha256"] != 1 || !is_hex(value["phase_a_env_non_route_sha256"], 64) ||
				seen["phase_a_routes_sha256"] != 1 || !is_hex(value["phase_a_routes_sha256"], 64) ||
				seen["core_api_container_id"] != 1 || !is_hex(value["core_api_container_id"], 64) ||
				seen["core_api_image_id"] != 1 || !is_sha256(value["core_api_image_id"]) ||
				seen["core_api_env_sha256"] != 1 || !is_hex(value["core_api_env_sha256"], 64) ||
				seen["billing_api_container_id"] != 1 || !is_hex(value["billing_api_container_id"], 64) ||
				seen["billing_api_image_id"] != 1 || !is_sha256(value["billing_api_image_id"]) ||
				seen["billing_api_env_sha256"] != 1 || !is_hex(value["billing_api_env_sha256"], 64) ||
				seen["gateway_container_id"] != 1 || !is_hex(value["gateway_container_id"], 64) ||
				seen["gateway_image_id"] != 1 || !is_sha256(value["gateway_image_id"]) ||
				seen["gateway_non_route_env_sha256"] != 1 || !is_hex(value["gateway_non_route_env_sha256"], 64) ||
				seen["frontend_revision"] != 1 || !is_hex(value["frontend_revision"], 40) ||
				seen["frontend_challenge"] != 1 || !is_hex(value["frontend_challenge"], 64) ||
				seen["frontend_origin_sha256"] != 1 || !is_hex(value["frontend_origin_sha256"], 64) ||
				seen["trusted_public_key_sha256"] != 1 || !is_hex(value["trusted_public_key_sha256"], 64) ||
				seen["created_at"] != 1 || value["created_at"] !~ /^[-0-9TZ:.]+$/) exit 1
		}
	' "$1"

}

platform_cutover_validate_billing_readiness_receipt() {
	platform_cutover_validate_billing_readiness_receipt_file "$platform_billing_readiness_receipt"
}

platform_cutover_receipt_is_present() {
	[[ -e "$platform_billing_readiness_receipt" || -L "$platform_billing_readiness_receipt" ]]
}

platform_cutover_assert_completed_marker_identity() {
	[[ "$(platform_cutover_current_phase)" == complete &&
		"$(platform_database_current_phase)" == complete ]] ||
		platform_cutover_fail 'Both Platform lifecycle markers must be complete.' || return 1
	[[ "$(platform_cutover_marker_value revision)" == "$(platform_database_marker_value revision)" &&
		"$(platform_cutover_marker_value generation)" == "$(platform_database_marker_value generation)" &&
		"$(platform_cutover_marker_value image_id)" == "$(platform_database_marker_value image_id)" &&
		"$(platform_cutover_marker_value database_id)" == "$(platform_database_marker_value database_id)" &&
		"$(platform_cutover_marker_value database_system_identifier)" == \
			"$(platform_database_marker_value database_system_identifier)" ]] ||
		platform_cutover_fail 'Completed Platform lifecycle marker identities differ.'
}

platform_cutover_completed_evidence_dir() {
	platform_cutover_assert_completed_marker_identity || return 1
	local revision generation directory
	revision="$(platform_cutover_marker_value revision)" || return 1
	generation="$(platform_cutover_marker_value generation)" || return 1
	[[ "$revision" =~ ^[0-9a-f]{40}$ && "$generation" =~ ^[1-9][0-9]{0,17}$ ]] || return 1
	directory="$platform_evidence_parent/platform-$revision-generation-$generation"
	[[ "$directory" == /* && "$directory" != *$'\n'* &&
		"$(dirname -- "$directory")" == "$platform_evidence_parent" ]] || return 1
	platform_cutover_validate_private_directory "$directory" || return 1
	printf '%s\n' "$directory"
}

platform_cutover_archived_readiness_receipt() {
	local directory
	directory="$(platform_cutover_completed_evidence_dir)" || return 1
	printf '%s/platform-phase-a-readiness-v1.receipt\n' "$directory"
}

platform_cutover_validate_archived_readiness_receipt() {
	local archive marker_revision marker_generation
	archive="$(platform_cutover_archived_readiness_receipt)" || return 1
	platform_cutover_validate_billing_readiness_receipt_file "$archive" || return 1
	marker_revision="$(platform_cutover_marker_value revision)" || return 1
	marker_generation="$(platform_cutover_marker_value generation)" || return 1
	[[ "$(platform_cutover_receipt_value_from_file "$archive" revision)" == "$marker_revision" &&
		"$(platform_cutover_receipt_value_from_file "$archive" generation)" == "$marker_generation" ]] ||
		platform_cutover_fail 'Archived phase-A receipt differs from the completed lifecycle.'
}

platform_cutover_assert_phase_a_artifacts_retired() {
	platform_cutover_validate_archived_readiness_receipt || return 1
	[[ ! -e "$platform_billing_readiness_receipt" && ! -L "$platform_billing_readiness_receipt" &&
		! -e "$platform_phase_a_intent" && ! -L "$platform_phase_a_intent" &&
		! -e "$platform_phase_a_env_artifact" && ! -L "$platform_phase_a_env_artifact" ]] ||
		platform_cutover_fail 'Active phase-A artifacts were not retired.'
}

platform_cutover_expected_release_image_id() {
	[[ $# -eq 1 && "$1" =~ ^(core|billing|gateway)$ ]] || return 1
	local kind="$1" key image receipt_revision cutover_phase archive marker_revision
	case "$kind" in
	core) key=core_api_image_id ;;
	billing) key=billing_api_image_id ;;
	gateway) key=gateway_image_id ;;
	esac
	if platform_cutover_receipt_is_present; then
		platform_cutover_validate_billing_readiness_receipt || return 1
		receipt_revision="$(platform_cutover_billing_readiness_value revision)" || return 1
		[[ "$receipt_revision" == "$EXPECTED_REVISION" ]] ||
			platform_cutover_fail 'Platform readiness receipt belongs to another active revision.' || return 1
		platform_cutover_billing_readiness_value "$key"
		return
	fi
	cutover_phase="$(platform_cutover_current_phase)" || return 1
	if [[ "$cutover_phase" == complete ]]; then
		platform_cutover_validate_archived_readiness_receipt || return 1
		archive="$(platform_cutover_archived_readiness_receipt)" || return 1
		marker_revision="$(platform_cutover_marker_value revision)" || return 1
		if [[ "$EXPECTED_REVISION" == "$marker_revision" ]]; then
			platform_cutover_receipt_value_from_file "$archive" "$key"
			return
		fi
		platform_cutover_assert_phase_a_artifacts_retired || return 1
	elif [[ "$cutover_phase" != absent ]]; then
		platform_cutover_fail 'Active Platform cutover lost its immutable phase-A receipt.'
		return 1
	elif [[ -e "$platform_phase_a_intent" || -L "$platform_phase_a_intent" ]]; then
		platform_cutover_validate_phase_a_intent || return 1
		[[ "$(platform_cutover_phase_a_intent_value revision)" == "$EXPECTED_REVISION" ]] ||
			platform_cutover_fail 'Phase-A preparing intent belongs to another revision.' || return 1
		if [[ -e "$platform_phase_a_env_artifact" || -L "$platform_phase_a_env_artifact" ]]; then
			platform_cutover_validate_phase_a_env_against_intent || return 1
		fi
	elif [[ -e "$platform_phase_a_env_artifact" || -L "$platform_phase_a_env_artifact" ]]; then
		platform_cutover_fail 'Orphan phase-A env artifact has no durable intent or final receipt.'
		return 1
	fi
	case "$kind" in
	core) image="winwidget-api:git-$EXPECTED_REVISION" ;;
	billing) image="winwidget-billing:git-$EXPECTED_REVISION" ;;
	gateway) image="winwidget-api-gateway:git-$EXPECTED_REVISION" ;;
	esac
	platform_database_docker image inspect --format '{{.Id}}' "$image"
}

platform_cutover_finalize_phase_a_artifacts() {
	platform_cutover_assert_completed_marker_identity || return 1
	local marker_revision marker_generation archive artifact_sha directory
	local receipt_present=false artifact_present=false archive_present=false
	marker_revision="$(platform_cutover_marker_value revision)" || return 1
	marker_generation="$(platform_cutover_marker_value generation)" || return 1
	archive="$(platform_cutover_archived_readiness_receipt)" || return 1
	directory="$(dirname -- "$platform_billing_readiness_receipt")" || return 1
	[[ "$directory" == "$(dirname -- "$platform_phase_a_env_artifact")" ]] || return 1
	[[ ! -e "$platform_billing_readiness_receipt" && ! -L "$platform_billing_readiness_receipt" ]] || receipt_present=true
	[[ ! -e "$platform_phase_a_env_artifact" && ! -L "$platform_phase_a_env_artifact" ]] || artifact_present=true
	[[ ! -e "$archive" && ! -L "$archive" ]] || archive_present=true

	if [[ "$receipt_present" == true ]]; then
		platform_cutover_validate_billing_readiness_receipt || return 1
		[[ "$artifact_present" == true ]] ||
			platform_cutover_fail 'Active phase-A receipt has no bound env artifact.' || return 1
		platform_cutover_validate_phase_a_env_artifact || return 1
		[[ "$(platform_cutover_billing_readiness_value revision)" == "$marker_revision" &&
			"$(platform_cutover_billing_readiness_value generation)" == "$marker_generation" ]] ||
			platform_cutover_fail 'Active phase-A receipt differs from the completed lifecycle.' || return 1
		if [[ "$archive_present" == false ]]; then
			ln -- "$platform_billing_readiness_receipt" "$archive" || return 1
			sync -f "$archive" || return 1
			sync -f "$(dirname -- "$archive")" || return 1
			archive_present=true
		else
			platform_cutover_validate_archived_readiness_receipt || return 1
			[[ "$platform_billing_readiness_receipt" -ef "$archive" ]] ||
				platform_cutover_fail 'Active and archived phase-A receipts are not the same sealed inode.' || return 1
		fi
	fi
	[[ "$archive_present" == true ]] ||
		platform_cutover_fail 'Completed Platform lifecycle has no archived phase-A receipt.' || return 1
	platform_cutover_validate_archived_readiness_receipt || return 1
	platform_cutover_finalize_phase_a_intent "$archive" || return 1
	if [[ "$artifact_present" == true ]]; then
		platform_cutover_validate_private_file "$platform_phase_a_env_artifact" || return 1
		artifact_sha="$(platform_cutover_sha256 "$platform_phase_a_env_artifact")" || return 1
		[[ "$artifact_sha" == "$(platform_cutover_receipt_value_from_file "$archive" phase_a_env_sha256)" &&
			"$artifact_sha" == "$(platform_cutover_receipt_value_from_file "$archive" phase_a_env_artifact_sha256)" ]] ||
			platform_cutover_fail 'Phase-A env artifact differs from the archived receipt.' || return 1
	fi
	if [[ "$receipt_present" == true ]]; then
		rm -f -- "$platform_billing_readiness_receipt" || return 1
		sync -f "$directory" || return 1
	fi
	if [[ "$artifact_present" == true ]]; then
		rm -f -- "$platform_phase_a_env_artifact" || return 1
		sync -f "$directory" || return 1
	fi
	platform_cutover_assert_phase_a_artifacts_retired
}

platform_cutover_assert_release_image_id() {
	[[ $# -eq 2 && "$1" =~ ^(core|billing|gateway)$ && "$2" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local kind="$1" image_id="$2" expected_user metadata
	case "$kind" in
	core) expected_user=nestjs ;;
	billing) expected_user=billing ;;
	gateway) expected_user=node ;;
	esac
	metadata="$(platform_database_docker image inspect --format \
		'{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' \
		"$image_id")" || return 1
	[[ "$metadata" == "$image_id|$EXPECTED_REVISION|$expected_user" ]] ||
		platform_cutover_fail "Receipt-bound $kind image metadata is invalid."
}

platform_cutover_prepare_receipt_image_aliases() {
	platform_cutover_validate_billing_readiness_receipt || return 1
	[[ "$(platform_cutover_billing_readiness_value revision)" == "$EXPECTED_REVISION" ]] || return 1
	local generation tag core_id billing_id gateway_id alias actual kind image_id
	generation="$(platform_cutover_billing_readiness_value generation)" || return 1
	tag="cutover-$EXPECTED_REVISION-g$generation"
	core_id="$(platform_cutover_billing_readiness_value core_api_image_id)" || return 1
	billing_id="$(platform_cutover_billing_readiness_value billing_api_image_id)" || return 1
	gateway_id="$(platform_cutover_billing_readiness_value gateway_image_id)" || return 1
	platform_cutover_assert_release_image_id core "$core_id" || return 1
	platform_cutover_assert_release_image_id billing "$billing_id" || return 1
	platform_cutover_assert_release_image_id gateway "$gateway_id" || return 1
	while IFS='|' read -r kind image_id alias; do
		[[ -n "$kind" && -n "$image_id" && -n "$alias" ]] || return 1
		actual="$(platform_database_docker image inspect --format '{{.Id}}' "$alias" 2>/dev/null || true)"
		if [[ -z "$actual" ]]; then
			platform_database_docker image tag "$image_id" "$alias" || return 1
		elif [[ "$actual" != "$image_id" ]]; then
			platform_cutover_fail "Receipt image alias drifted for $kind."
			return 1
		fi
		[[ "$(platform_database_docker image inspect --format '{{.Id}}' "$alias")" == "$image_id" ]] || return 1
	done <<EOF
core|$core_id|winwidget-api:$tag
billing|$billing_id|winwidget-billing:$tag
gateway|$gateway_id|winwidget-api-gateway:$tag
EOF
	printf '%s|%s\n' "$tag" "winwidget-billing:$tag"
}

platform_cutover_compose_with_receipt_images() {
	[[ $# -ge 1 ]] || return 1
	local aliases app_version billing_image
	aliases="$(platform_cutover_prepare_receipt_image_aliases)" || return 1
	IFS='|' read -r app_version billing_image <<<"$aliases"
	[[ -n "$app_version" && -n "$billing_image" ]] || return 1
	PLATFORM_RELEASE_APP_VERSION_OVERRIDE="$app_version" \
		PLATFORM_RELEASE_BILLING_IMAGE_OVERRIDE="$billing_image" \
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" "$@"
}

platform_cutover_write_billing_readiness_receipt() {
	[[ $# -eq 12 && "$1" =~ ^[0-9a-f]{64}$ && "$2" =~ ^[0-9a-f]{64}$ &&
		"$3" =~ ^[0-9a-f]{64}$ && "$4" =~ ^[0-9a-f]{64}$ &&
		"$5" =~ ^sha256:[0-9a-f]{64}$ && "$6" =~ ^[0-9a-f]{64}$ &&
		"$7" =~ ^[0-9a-f]{64}$ && "$8" =~ ^sha256:[0-9a-f]{64}$ && "$9" =~ ^[0-9a-f]{64}$ &&
		"${10}" =~ ^[0-9a-f]{64}$ && "${11}" =~ ^sha256:[0-9a-f]{64}$ &&
		"${12}" =~ ^[0-9a-f]{64}$ ]] || return 1
	[[ ! -e "$platform_billing_readiness_receipt" &&
		! -L "$platform_billing_readiness_receipt" ]] || return 1
	local env_sha="$1" env_non_route_sha="$2" routes_sha="$3"
	local core_container="$4" core_image="$5" core_env_sha="$6"
	local billing_container="$7" billing_image="$8" billing_env_sha="$9"
	local gateway_container="${10}" gateway_image="${11}" gateway_env_sha="${12}"
	local directory temporary origin_sha
	origin_sha="$(platform_cutover_text_sha256 "$PLATFORM_FRONTEND_ORIGIN")" || return 1
	directory="$(dirname -- "$platform_billing_readiness_receipt")"
	temporary="$(mktemp "$directory/.platform-billing-readiness-v1.tmp.XXXXXX")" || return 1
	if ! {
		printf 'version=1\nphase=phase-a\nrevision=%s\ngeneration=1\n' "$EXPECTED_REVISION"
		printf 'phase_a_env_sha256=%s\nphase_a_env_artifact_sha256=%s\n' "$env_sha" "$env_sha"
		printf 'phase_a_env_non_route_sha256=%s\nphase_a_routes_sha256=%s\n' "$env_non_route_sha" "$routes_sha"
		printf 'core_api_container_id=%s\ncore_api_image_id=%s\ncore_api_env_sha256=%s\n' \
			"$core_container" "$core_image" "$core_env_sha"
		printf 'billing_api_container_id=%s\nbilling_api_image_id=%s\nbilling_api_env_sha256=%s\n' \
			"$billing_container" "$billing_image" "$billing_env_sha"
		printf 'gateway_container_id=%s\ngateway_image_id=%s\ngateway_non_route_env_sha256=%s\n' \
			"$gateway_container" "$gateway_image" "$gateway_env_sha"
		printf 'frontend_revision=%s\nfrontend_challenge=%s\nfrontend_origin_sha256=%s\n' \
			"$PLATFORM_FRONTEND_REVISION" "$PLATFORM_FRONTEND_RUNTIME_CHALLENGE" "$origin_sha"
		printf 'trusted_public_key_sha256=%s\n' "$PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256"
		printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"; then
		rm -f -- "$temporary"
		return 1
	fi
	if ! chmod 600 "$temporary" ||
		! { [[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]] || chown 0:0 "$temporary"; } ||
		! sync -f "$temporary" || [[ -e "$platform_billing_readiness_receipt" || -L "$platform_billing_readiness_receipt" ]] ||
		! ln -- "$temporary" "$platform_billing_readiness_receipt" || ! rm -f -- "$temporary" ||
		! sync -f "$platform_billing_readiness_receipt" || ! sync -f "$directory" ||
		! platform_cutover_validate_billing_readiness_receipt; then
		rm -f -- "$temporary"
		return 1
	fi
}

platform_cutover_bind_database_url_parser_image() {
	local image_id
	image_id="$(platform_cutover_expected_release_image_id core)" || return 1
	platform_cutover_assert_release_image_id core "$image_id" || return 1
	PLATFORM_DATABASE_URL_PARSER_CORE_IMAGE_ID="$image_id"
	export PLATFORM_DATABASE_URL_PARSER_CORE_IMAGE_ID
}

platform_cutover_query() {
	[[ $# -eq 2 && "$1" =~ ^(DATABASE_URL_PRODUCTION|DATABASE_MIGRATION_URL_PRODUCTION|DATABASE_BACKUP_URL|BILLING_BACKUP_URL|PLATFORM_BACKUP_URL)$ ]] || return 1
	local url_key="$1" sql="$2" username password hostname port database
	platform_cutover_bind_database_url_parser_image || return 1
	username="$(platform_database_url_field "$url_key" username)" || return 1
	password="$(platform_database_url_field "$url_key" password)" || return 1
	hostname="$(platform_database_url_field "$url_key" hostname)" || return 1
	port="$(platform_database_url_field "$url_key" port)" || return 1
	database="$(platform_database_url_field "$url_key" database)" || return 1
	PGPASSWORD="$password" platform_database_docker run --rm --network host --read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --cap-drop ALL \
		--security-opt no-new-privileges --pids-limit 64 --env PGPASSWORD \
		--entrypoint psql "$PLATFORM_CUTOVER_POSTGRES_IMAGE" --no-psqlrc \
		--no-password --tuples-only --no-align --set ON_ERROR_STOP=1 \
		--host "$hostname" --port "$port" --username "$username" \
		--dbname "$database" --command "$sql"
	unset password
}

platform_cutover_assert_core_database_urls_match() {
	local runtime_identity migration_identity backup_identity
	runtime_identity="$(platform_cutover_query DATABASE_URL_PRODUCTION \
		"SELECT current_database() || '|' || (pg_control_system()).system_identifier::text;")" || return 1
	migration_identity="$(platform_cutover_query DATABASE_MIGRATION_URL_PRODUCTION \
		"SELECT current_database() || '|' || (pg_control_system()).system_identifier::text;")" || return 1
	backup_identity="$(platform_cutover_query DATABASE_BACKUP_URL \
		"SELECT current_database() || '|' || (pg_control_system()).system_identifier::text;")" || return 1
	[[ "$runtime_identity" =~ ^[A-Za-z0-9_-]+\|[1-9][0-9]*$ &&
		"$runtime_identity" == "$migration_identity" && "$runtime_identity" == "$backup_identity" ]] ||
		platform_cutover_fail 'Core runtime, migration, and backup URLs do not identify the same database cluster.'
}

platform_cutover_core_migration_manifest() {
	local root="$SERVER_ROOT/prisma/migrations" directory name migration_sql checksum count=0
	[[ -d "$root" && ! -L "$root" ]] || return 1
	while IFS= read -r directory; do
		[[ -d "$directory" && ! -L "$directory" && "$(dirname -- "$directory")" == "$root" ]] || return 1
		name="$(basename -- "$directory")"
		[[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || return 1
		migration_sql="$directory/migration.sql"
		[[ -f "$migration_sql" && ! -L "$migration_sql" ]] || return 1
		checksum="$(platform_cutover_sha256 "$migration_sql")" || return 1
		[[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || return 1
		printf '%s|%s\n' "$name" "$checksum"
		count=$((count + 1))
	done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -print | sort)
	((count > 0))
}

platform_cutover_core_migration_ledger_is_exact() {
	[[ $# -eq 3 && "$1" =~ ^(before|after)$ ]] || return 1
	local mode="$1" repository_manifest="$2" ledger_manifest="$3"
	{
		printf '%s\n' "$repository_manifest"
		printf '%s\n' '---LEDGER---'
		printf '%s\n' "$ledger_manifest"
	} | awk -F'|' -v mode="$mode" -v expected="$PLATFORM_CORE_PREPARE_MIGRATION" '
		function is_hex(value, size) { return length(value) == size && value ~ /^[0-9a-f]+$/ }
		function is_migration_name(value, prefix, suffix) {
			if (length(value) < 16 || substr(value, 15, 1) != "_") return 0
			prefix = substr(value, 1, 14)
			suffix = substr(value, 16)
			return prefix ~ /^[0-9]+$/ && suffix ~ /^[a-z0-9_]+$/
		}
		$0 == "---LEDGER---" { section = 1; next }
		section == 0 && NF {
			if (NF != 2 || !is_migration_name($1) || !is_hex($2, 64) ||
				repository[$1] || (last != "" && $1 <= last)) invalid = 1
			repository[$1] = $2
			last = $1
			next
		}
		section == 1 && NF {
			if (NF != 3 || !is_migration_name($1) || !is_hex($2, 64) ||
				$3 !~ /^(applied|incomplete)$/ || ledger[$1]) invalid = 1
			ledger[$1] = $2
			state[$1] = $3
			next
		}
		END {
			if (invalid || !(expected in repository) || last != expected) exit 1
			for (name in repository) {
				if (mode == "before" && name == expected) {
					if (name in ledger) exit 1
				} else if (!(name in ledger) || state[name] != "applied" || ledger[name] != repository[name]) {
					exit 1
				}
			}
			for (name in ledger) if (!(name in repository)) exit 1
		}
	'
}

platform_cutover_assert_core_migration_ledger() {
	[[ $# -eq 1 && "$1" =~ ^(before|after)$ ]] || return 1
	[[ "$(platform_cutover_core_migration_ledger_state)" == "$1" ]] ||
		platform_cutover_fail "Core Prisma migration ledger is not exact for Platform $1-migration gate."
}

platform_cutover_core_migration_ledger_state() {
	local repository_manifest ledger_manifest
	repository_manifest="$(platform_cutover_core_migration_manifest)" || return 1
	ledger_manifest="$(platform_cutover_query DATABASE_MIGRATION_URL_PRODUCTION '
SELECT migration_name || '\''|'\'' || checksum || '\''|'\'' ||
       CASE WHEN finished_at IS NOT NULL AND applied_steps_count > 0
            THEN '\''applied'\'' ELSE '\''incomplete'\'' END
FROM "_prisma_migrations"
WHERE rolled_back_at IS NULL
ORDER BY migration_name, started_at;
')" || return 1
	if platform_cutover_core_migration_ledger_is_exact after "$repository_manifest" "$ledger_manifest"; then
		printf 'after\n'
	elif platform_cutover_core_migration_ledger_is_exact before "$repository_manifest" "$ledger_manifest"; then
		printf 'before\n'
	else
		platform_cutover_fail 'Core Prisma migration ledger is neither an exact before nor after Platform state.'
	fi
}

platform_cutover_assert_core_post_migration_catalog() {
	[[ $# -eq 1 && "$1" =~ ^(initial|structure)$ ]] || return 1
	local mode="$1" catalog_state
	catalog_state="$(platform_cutover_query DATABASE_MIGRATION_URL_PRODUCTION "
WITH expected_constraints(name, kind, validated, is_deferrable, is_deferred, key_columns, definition_sha256) AS (
  VALUES
    ('platform_core_state_boundary_check', 'c', true, false, false, '2,4,8,19,3,17,12,7,6,18,5,9,10,11', '2b204d0169901b6fced6657e6b1fa4746cf88a760666db000a59901df3e4641d'),
    ('platform_core_state_export_anchor_check', 'c', true, false, false, '7,9,10,11,18', '6b4b61b00474130a56dc74e6c8d901c483c959cdc4425706e3463fe152541d08'),
    ('platform_core_state_fingerprint_check', 'c', true, false, false, '9,10,16,11', 'a8012b88ca39e8ce0bb8a2a76f258a1471c9e41f5147c1002ad10ee9b824dab8'),
    ('platform_core_state_generation_check', 'c', true, false, false, '5', 'b00904438eeaafc5c69707ae1d5459a14627e32c4db0b0487caff0cb501717db'),
    ('platform_core_state_generation_not_null', 'n', true, false, false, '5', '718fc335c083f4ad6e204710c7c39ceee255d271f30cacad05398924d8dcd31a'),
    ('platform_core_state_id_not_null', 'n', true, false, false, '1', '6d7506d8233cbea9d9fe6b8d8f27f360db0fbffb967f9b95f57bf6ecda6cbe3a'),
    ('platform_core_state_legacy_routes_enabled_not_null', 'n', true, false, false, '4', 'ba8a2f25aedcbe9ff8c1c3544ea79700fac1dd1a8b676c2705fc1039c5ce166c'),
    ('platform_core_state_offer_fence_check', 'c', true, false, false, '12,13,14,15,16', 'cfee2afdf355e4fde5668fdf6e1387cb9f38e5fa2777188df784a658a20098db'),
    ('platform_core_state_ownership_not_null', 'n', true, false, false, '2', '53c6f2103143c709a8d93908527c1baf7de9cde55649cf1931597b3b542467c6'),
    ('platform_core_state_pkey', 'p', true, false, false, '1', '8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5'),
    ('platform_core_state_revision_check', 'c', true, false, false, '6,7,8', 'bd0571d415572d9403609c613d1ff6a77c09cafb03b28cd47964a95f76314e26'),
    ('platform_core_state_singleton_check', 'c', true, false, false, '1', 'c87caaf531a9ab4eec397d61d3f1b012b4ebd9bfe462031a081830ecfbc5e1b6'),
    ('platform_core_state_source_writes_enabled_not_null', 'n', true, false, false, '3', 'ae4ea08a41b3d3181a1acf48e4faed86ce4929d831b39194435d61c10ca7a140'),
    ('platform_core_state_updated_at_not_null', 'n', true, false, false, '20', '85acee4d0e8f8bc395e6bac7d6c61b52547b7b9a33e62132df1d5ddaa61479c8')
), actual_constraints(name, kind, validated, is_deferrable, is_deferred, key_columns, definition_sha256) AS (
  SELECT constraint_entry.conname, constraint_entry.contype::text,
         constraint_entry.convalidated, constraint_entry.condeferrable,
         constraint_entry.condeferred,
         COALESCE(array_to_string(constraint_entry.conkey, ','), ''),
         encode(sha256(convert_to(pg_get_constraintdef(constraint_entry.oid, false), 'UTF8')), 'hex')
  FROM pg_catalog.pg_constraint constraint_entry
  WHERE constraint_entry.conrelid = to_regclass('public.platform_core_state')
), expected_columns(column_name, position, type_schema, type_name, type_modifier, not_null, default_expression, column_acl_is_null) AS (
  VALUES
    ('id', 1, 'pg_catalog', 'text', -1, true, '''singleton''::text', true),
    ('ownership', 2, 'public', 'PlatformCoreOwnership', -1, true, '''CORE''::\"PlatformCoreOwnership\"', true),
    ('source_writes_enabled', 3, 'pg_catalog', 'bool', -1, true, 'true', true),
    ('legacy_routes_enabled', 4, 'pg_catalog', 'bool', -1, true, 'true', true),
    ('generation', 5, 'pg_catalog', 'int8', -1, true, '0', true),
    ('prepared_revision', 6, 'pg_catalog', 'text', -1, false, '', true),
    ('source_revision', 7, 'pg_catalog', 'text', -1, false, '', true),
    ('ownership_revision', 8, 'pg_catalog', 'text', -1, false, '', true),
    ('source_fingerprint', 9, 'pg_catalog', 'text', -1, false, '', true),
    ('source_snapshot_sha256', 10, 'pg_catalog', 'text', -1, false, '', true),
    ('source_high_watermark', 11, 'pg_catalog', 'int8', -1, false, '', true),
    ('billing_offer_contract_version', 12, 'pg_catalog', 'int4', -1, false, '', true),
    ('billing_offer_sequence_scope', 13, 'pg_catalog', 'text', -1, false, '', true),
    ('billing_offer_aggregate_version', 14, 'pg_catalog', 'int8', -1, false, '', true),
    ('billing_offer_source_sequence', 15, 'pg_catalog', 'int8', -1, false, '', true),
    ('billing_offer_fence_fingerprint', 16, 'pg_catalog', 'text', -1, false, '', true),
    ('fenced_at', 17, 'pg_catalog', 'timestamp', 3, false, '', true),
    ('exported_at', 18, 'pg_catalog', 'timestamp', 3, false, '', true),
    ('activated_at', 19, 'pg_catalog', 'timestamp', 3, false, '', true),
    ('updated_at', 20, 'pg_catalog', 'timestamp', 3, true, 'CURRENT_TIMESTAMP', true)
), actual_columns(column_name, position, type_schema, type_name, type_modifier, not_null, default_expression, column_acl_is_null) AS (
  SELECT attribute.attname, attribute.attnum::integer, type_namespace.nspname,
         type_entry.typname, attribute.atttypmod, attribute.attnotnull,
         COALESCE(pg_get_expr(default_entry.adbin, default_entry.adrelid, false), ''),
         attribute.attacl IS NULL
  FROM pg_catalog.pg_attribute attribute
  JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace relation_namespace ON relation_namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_type type_entry ON type_entry.oid = attribute.atttypid
  JOIN pg_catalog.pg_namespace type_namespace ON type_namespace.oid = type_entry.typnamespace
  LEFT JOIN pg_catalog.pg_attrdef default_entry
    ON default_entry.adrelid = attribute.attrelid AND default_entry.adnum = attribute.attnum
  WHERE relation_namespace.nspname = 'public'
    AND relation.relname = 'platform_core_state'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
), expected_triggers(relation_name, trigger_name, trigger_type, enabled, function_namespace, function_name, argument_count, attribute_columns, predicate_is_null) AS (
  VALUES
    ('platform_core_state', 'platform_core_state_transition_guard', 19, 'O', 'public', 'platform_core_state_transition_guard', 0, '', true),
    ('site_settings', 'platform_site_settings_write_fence', 31, 'O', 'public', 'platform_assert_core_write_enabled', 0, '', true),
    ('legal_pages', 'platform_legal_pages_write_fence', 31, 'O', 'public', 'platform_assert_core_write_enabled', 0, '', true),
    ('home_page_content', 'platform_home_page_content_write_fence', 31, 'O', 'public', 'platform_assert_core_write_enabled', 0, '', true)
), actual_triggers(relation_name, trigger_name, trigger_type, enabled, function_namespace, function_name, argument_count, attribute_columns, predicate_is_null) AS (
  SELECT relation.relname, trigger_entry.tgname, trigger_entry.tgtype::integer,
         trigger_entry.tgenabled::text, procedure_namespace.nspname,
         procedure_entry.proname, trigger_entry.tgnargs::integer,
         COALESCE(array_to_string(trigger_entry.tgattr, ','), ''),
         trigger_entry.tgqual IS NULL
  FROM pg_catalog.pg_trigger trigger_entry
  JOIN pg_catalog.pg_class relation ON relation.oid = trigger_entry.tgrelid
  JOIN pg_catalog.pg_namespace namespace_entry ON namespace_entry.oid = relation.relnamespace
  JOIN pg_catalog.pg_proc procedure_entry ON procedure_entry.oid = trigger_entry.tgfoid
  JOIN pg_catalog.pg_namespace procedure_namespace ON procedure_namespace.oid = procedure_entry.pronamespace
  WHERE namespace_entry.nspname = 'public'
    AND relation.relname IN ('platform_core_state', 'site_settings', 'legal_pages', 'home_page_content')
    AND NOT trigger_entry.tgisinternal
), expected_functions(function_name, result_type, arguments, language_name, volatility, security_definer, leakproof, parallel_mode, config_values, owner_name, source_sha256) AS (
  VALUES
    ('platform_core_state_transition_guard', 'trigger', '', 'plpgsql', 'v', false, false, 'u', '', 'gen_user', 'e314f75657241f0d289ad0867de784f80e83de172b190abb36ddb6ed58fe3af0'),
    ('platform_core_source_writes_enabled', 'boolean', '', 'plpgsql', 'v', true, false, 'u', 'search_path=pg_catalog, public', 'gen_user', 'acaef477f299b38739331c4d09319510461e37f30f5b31a9bcce75932172490d'),
    ('platform_assert_core_write_enabled', 'trigger', '', 'plpgsql', 'v', false, false, 'u', '', 'gen_user', 'a4cc6f6c76ddabc02c5bf4f9891361251279a1eb9e007eea447b0e533d4d602b')
), actual_functions(function_name, result_type, arguments, language_name, volatility, security_definer, leakproof, parallel_mode, config_values, owner_name, source_sha256) AS (
  SELECT procedure_entry.proname, pg_get_function_result(procedure_entry.oid),
         pg_get_function_identity_arguments(procedure_entry.oid), language_entry.lanname,
         procedure_entry.provolatile::text, procedure_entry.prosecdef,
         procedure_entry.proleakproof, procedure_entry.proparallel::text,
         COALESCE(array_to_string(procedure_entry.proconfig, E'\n'), ''), owner_entry.rolname,
         encode(sha256(convert_to(procedure_entry.prosrc, 'UTF8')), 'hex')
  FROM pg_catalog.pg_proc procedure_entry
  JOIN pg_catalog.pg_namespace namespace_entry ON namespace_entry.oid = procedure_entry.pronamespace
  JOIN pg_catalog.pg_language language_entry ON language_entry.oid = procedure_entry.prolang
  JOIN pg_catalog.pg_roles owner_entry ON owner_entry.oid = procedure_entry.proowner
  WHERE namespace_entry.nspname = 'public'
    AND left(procedure_entry.proname, 9) = 'platform_'
), expected_table_acl(role_name, privilege_type, is_grantable) AS (
	VALUES
		('winwidget_api_runtime', 'SELECT', false),
		('winwidget_backup', 'SELECT', false),
    ('winwidget_maintenance', 'SELECT', false)
), actual_table_acl(role_name, privilege_type, is_grantable) AS (
  SELECT COALESCE(role_entry.rolname, 'PUBLIC'), acl_entry.privilege_type, acl_entry.is_grantable
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace_entry ON namespace_entry.oid = relation.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) acl_entry
  LEFT JOIN pg_catalog.pg_roles role_entry ON role_entry.oid = acl_entry.grantee
  WHERE namespace_entry.nspname = 'public'
    AND relation.relname = 'platform_core_state'
    AND acl_entry.grantee <> relation.relowner
), expected_function_acl(function_name, role_name, privilege_type, is_grantable) AS (
  VALUES
    ('platform_core_source_writes_enabled', 'winwidget_api_runtime', 'EXECUTE', false),
    ('platform_assert_core_write_enabled', 'winwidget_api_runtime', 'EXECUTE', false)
), actual_function_acl(function_name, role_name, privilege_type, is_grantable) AS (
  SELECT procedure_entry.proname, COALESCE(role_entry.rolname, 'PUBLIC'),
         acl_entry.privilege_type, acl_entry.is_grantable
  FROM pg_catalog.pg_proc procedure_entry
  JOIN pg_catalog.pg_namespace namespace_entry ON namespace_entry.oid = procedure_entry.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(procedure_entry.proacl, acldefault('f', procedure_entry.proowner))) acl_entry
  LEFT JOIN pg_catalog.pg_roles role_entry ON role_entry.oid = acl_entry.grantee
  WHERE namespace_entry.nspname = 'public'
    AND left(procedure_entry.proname, 9) = 'platform_'
    AND acl_entry.grantee <> procedure_entry.proowner
), state_exact AS (
  SELECT count(*) = 1 AND bool_and(
    id = 'singleton'
    AND ownership::text = 'CORE'
    AND source_writes_enabled
    AND legacy_routes_enabled
    AND generation = 0
    AND prepared_revision IS NULL
    AND source_revision IS NULL
    AND ownership_revision IS NULL
    AND source_fingerprint IS NULL
    AND source_snapshot_sha256 IS NULL
    AND source_high_watermark IS NULL
    AND billing_offer_contract_version IS NULL
    AND billing_offer_sequence_scope IS NULL
    AND billing_offer_aggregate_version IS NULL
    AND billing_offer_source_sequence IS NULL
    AND billing_offer_fence_fingerprint IS NULL
    AND fenced_at IS NULL
    AND exported_at IS NULL
    AND activated_at IS NULL
    AND updated_at IS NOT NULL
  ) AS valid
  FROM public.platform_core_state
), enum_exact AS (
  SELECT COALESCE(array_agg(enum_entry.enumlabel::text ORDER BY enum_entry.enumsortorder), ARRAY[]::text[]) =
         ARRAY['CORE', 'PLATFORM']::text[] AS valid
  FROM pg_catalog.pg_type type_entry
  JOIN pg_catalog.pg_namespace namespace_entry ON namespace_entry.oid = type_entry.typnamespace
  LEFT JOIN pg_catalog.pg_enum enum_entry ON enum_entry.enumtypid = type_entry.oid
  WHERE namespace_entry.nspname = 'public'
    AND type_entry.typname = 'PlatformCoreOwnership'
), object_owner_exact AS (
  SELECT
    COALESCE((
      SELECT owner_entry.rolname = 'gen_user'
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relrowsecurity
        AND NOT relation.relforcerowsecurity
        AND NOT relation.relispartition
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace_entry ON namespace_entry.oid = relation.relnamespace
      JOIN pg_catalog.pg_roles owner_entry ON owner_entry.oid = relation.relowner
      WHERE namespace_entry.nspname = 'public' AND relation.relname = 'platform_core_state'
    ), false)
    AND COALESCE((
      SELECT owner_entry.rolname = 'gen_user' AND type_entry.typtype = 'e'
      FROM pg_catalog.pg_type type_entry
      JOIN pg_catalog.pg_namespace namespace_entry ON namespace_entry.oid = type_entry.typnamespace
      JOIN pg_catalog.pg_roles owner_entry ON owner_entry.oid = type_entry.typowner
      WHERE namespace_entry.nspname = 'public' AND type_entry.typname = 'PlatformCoreOwnership'
    ), false) AS valid
)
SELECT CASE WHEN
  COALESCE((SELECT valid FROM enum_exact), false)
  AND COALESCE((SELECT valid FROM object_owner_exact), false)
  AND NOT EXISTS (SELECT * FROM expected_columns EXCEPT SELECT * FROM actual_columns)
  AND NOT EXISTS (SELECT * FROM actual_columns EXCEPT SELECT * FROM expected_columns)
  AND NOT EXISTS (SELECT * FROM expected_constraints EXCEPT SELECT * FROM actual_constraints)
  AND NOT EXISTS (SELECT * FROM actual_constraints EXCEPT SELECT * FROM expected_constraints)
  AND NOT EXISTS (SELECT * FROM expected_triggers EXCEPT SELECT * FROM actual_triggers)
  AND NOT EXISTS (SELECT * FROM actual_triggers EXCEPT SELECT * FROM expected_triggers)
  AND NOT EXISTS (SELECT * FROM expected_functions EXCEPT SELECT * FROM actual_functions)
  AND NOT EXISTS (SELECT * FROM actual_functions EXCEPT SELECT * FROM expected_functions)
  AND NOT EXISTS (SELECT * FROM expected_table_acl EXCEPT SELECT * FROM actual_table_acl)
  AND NOT EXISTS (SELECT * FROM actual_table_acl EXCEPT SELECT * FROM expected_table_acl)
  AND NOT EXISTS (SELECT * FROM expected_function_acl EXCEPT SELECT * FROM actual_function_acl)
  AND NOT EXISTS (SELECT * FROM actual_function_acl EXCEPT SELECT * FROM expected_function_acl)
THEN CASE WHEN COALESCE((SELECT valid FROM state_exact), false)
          THEN 'exact-initial' ELSE 'exact-structure' END
ELSE 'not-exact' END;
")" || return 1
	[[ "$catalog_state" =~ ^exact-(initial|structure)$ &&
		( "$mode" == structure || "$catalog_state" == exact-initial ) ]] ||
		platform_cutover_fail 'Core Platform post-migration catalog, initial state, or ACL is not exact.'
}

platform_cutover_billing_offer_queues_drained() {
	local container vhost listing queue expected_consumers
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$vhost" == winwidget &&
		"$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" == healthy ]] || return 1
	listing="$(platform_database_docker exec "$container" rabbitmqctl --silent list_queues -p "$vhost" \
		name durable messages_ready messages_unacknowledged consumers)" || return 1
	for queue in winwidget.billing.offer.v1 \
		winwidget.billing.offer.v1.retry.1 winwidget.billing.offer.v1.retry.2 \
		winwidget.billing.offer.v1.retry.3 winwidget.billing.offer.v1.dead-letter; do
		expected_consumers=0
		[[ "$queue" == winwidget.billing.offer.v1 ]] && expected_consumers=1
		awk -v queue="$queue" -v consumers="$expected_consumers" '
			$1 == queue {
				seen += 1
				if ($2 == "true" && $3 == 0 && $4 == 0 && $5 == consumers) valid += 1
			}
			END { exit(seen == 1 && valid == 1 ? 0 : 1) }
		' <<<"$listing" || return 1
	done
}

platform_cutover_billing_offer_v1_listing_is_retirable() {
	[[ $# -eq 1 ]] || return 1
	awk -v prefix="$PLATFORM_BILLING_OFFER_V1_QUEUE" '
		BEGIN {
			expected[prefix] = 1
			for (attempt = 1; attempt <= 3; attempt += 1) expected[prefix ".retry." attempt] = 1
			expected[prefix ".dead-letter"] = 1
		}
		$1 == prefix || index($1, prefix ".") == 1 {
			seen[$1] += 1
			if (!expected[$1] || seen[$1] != 1 || $2 != "true" || $3 != 0 || $4 != 0 || $5 != 0) invalid = 1
		}
		END { exit(invalid ? 1 : 0) }
	' <<<"$1"
}

platform_cutover_billing_offer_v2_listing_is_exact() {
	[[ $# -eq 1 ]] || return 1
	awk -v old_prefix="$PLATFORM_BILLING_OFFER_V1_QUEUE" \
		-v prefix="$PLATFORM_BILLING_OFFER_V2_QUEUE" '
		BEGIN {
			expected[prefix] = 1
			for (attempt = 1; attempt <= 3; attempt += 1) expected[prefix ".retry." attempt] = 1
			expected[prefix ".dead-letter"] = 1
		}
		$1 == old_prefix || index($1, old_prefix ".") == 1 { invalid = 1 }
		$1 == prefix || index($1, prefix ".") == 1 {
			seen[$1] += 1
			consumers = ($1 == prefix ? 1 : 0)
			if (!expected[$1] || seen[$1] != 1 || $2 != "true" || $3 != 0 || $4 != 0 || $5 != consumers) invalid = 1
		}
		END {
			for (queue in expected) if (seen[queue] != 1) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' <<<"$1"
}

platform_cutover_billing_offer_v2_bindings_are_exact() {
	[[ $# -eq 1 ]] || return 1
	awk -v old_prefix="$PLATFORM_BILLING_OFFER_V1_QUEUE" \
		-v prefix="$PLATFORM_BILLING_OFFER_V2_QUEUE" \
		-v event="$PLATFORM_BILLING_OFFER_V2_EVENT" '
		BEGIN {
			expected["winwidget.events|" prefix "|queue|" event] = 1
			expected["winwidget.billing.retry|" prefix "|queue|" event] = 1
			expected["winwidget.billing.dead-letter|" prefix ".dead-letter|queue|offer.dead-letter"] = 1
			for (attempt = 1; attempt <= 3; attempt += 1) {
				expected["winwidget.billing.retry|" prefix ".retry." attempt "|queue|offer.retry." attempt] = 1
			}
		}
		{
			key = $1 "|" $2 "|" $3 "|" $4
			if ($1 == old_prefix || index($1, old_prefix ".") == 1 ||
				$2 == old_prefix || index($2, old_prefix ".") == 1) invalid = 1
			if ($2 == prefix || index($2, prefix ".") == 1) {
				seen[key] += 1
				if (!expected[key] || seen[key] != 1) invalid = 1
			}
		}
		END {
			for (binding in expected) if (seen[binding] != 1) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' <<<"$1"
}

platform_cutover_billing_offer_v2_queue_details_are_exact() {
	[[ $# -eq 1 && -n "$1" ]] || return 1
	PLATFORM_QUEUE_DETAILS_JSON="$1" \
		PLATFORM_QUEUE_PREFIX="$PLATFORM_BILLING_OFFER_V2_QUEUE" \
		PLATFORM_QUEUE_EVENT="$PLATFORM_BILLING_OFFER_V2_EVENT" node -e '
const rows = JSON.parse(process.env.PLATFORM_QUEUE_DETAILS_JSON);
const prefix = process.env.PLATFORM_QUEUE_PREFIX;
const event = process.env.PLATFORM_QUEUE_EVENT;
const expected = new Map([
  [prefix, {}],
  [`${prefix}.dead-letter`, {}],
  [`${prefix}.retry.1`, {
    "x-message-ttl": 60_000,
    "x-dead-letter-exchange": "winwidget.billing.retry",
    "x-dead-letter-routing-key": event,
  }],
  [`${prefix}.retry.2`, {
    "x-message-ttl": 300_000,
    "x-dead-letter-exchange": "winwidget.billing.retry",
    "x-dead-letter-routing-key": event,
  }],
  [`${prefix}.retry.3`, {
    "x-message-ttl": 1_800_000,
    "x-dead-letter-exchange": "winwidget.billing.retry",
    "x-dead-letter-routing-key": event,
  }],
]);
if (!Array.isArray(rows) || rows.length !== expected.size) process.exit(1);
const seen = new Set();
for (const row of rows) {
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      !expected.has(row.name) || seen.has(row.name) || row.vhost !== "winwidget" ||
      row.durable !== true || row.auto_delete !== false || row.exclusive !== false ||
      !row.arguments || typeof row.arguments !== "object" || Array.isArray(row.arguments)) {
    process.exit(1);
  }
  seen.add(row.name);
  const actualArguments = Object.entries(row.arguments).sort(([left], [right]) => left.localeCompare(right));
  const expectedArguments = Object.entries(expected.get(row.name)).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(actualArguments) !== JSON.stringify(expectedArguments)) process.exit(1);
}
if (seen.size !== expected.size) process.exit(1);
'
}

platform_cutover_platform_admin_audit_queue_listing_is_exact() {
	[[ $# -eq 1 ]] || return 1
	awk -v prefix="$PLATFORM_ADMIN_AUDIT_QUEUE" '
		BEGIN {
			expected[prefix] = 1
			expected[prefix ".dead-letter"] = 1
			for (attempt = 1; attempt <= 3; attempt += 1) {
				expected[prefix ".retry-v2." attempt] = 1
			}
		}
		$1 == prefix || index($1, prefix ".") == 1 {
			seen[$1] += 1
			if (!expected[$1] || seen[$1] != 1 || $2 != "true" ||
				$3 != "false" || $4 != "false") invalid = 1
		}
		END {
			for (queue in expected) if (seen[queue] != 1) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' <<<"$1"
}

platform_cutover_platform_admin_audit_bindings_are_exact() {
	[[ $# -eq 1 ]] || return 1
	awk -v prefix="$PLATFORM_ADMIN_AUDIT_QUEUE" \
		-v event="$PLATFORM_ADMIN_AUDIT_EVENT" -v kind="$PLATFORM_ADMIN_AUDIT_KIND" '
		BEGIN {
			expected["winwidget.events|" prefix "|queue|" event] = 1
			expected["winwidget.events|" prefix "|queue|manual." kind] = 1
			expected["winwidget.manual-retry|" prefix "|queue|" kind] = 1
			expected["winwidget.dead-letter|" prefix ".dead-letter|queue|" kind ".dead-letter"] = 1
			expected["winwidget.events|" prefix ".dead-letter|queue|" kind ".dead-letter"] = 1
			for (attempt = 1; attempt <= 3; attempt += 1) {
				expected["winwidget.retry|" prefix ".retry-v2." attempt "|queue|" kind ".retry." attempt] = 1
			}
		}
		{
			key = $1 "|" $2 "|" $3 "|" $4
			if ($2 == prefix || index($2, prefix ".") == 1) {
				seen[key] += 1
				if (!expected[key] || seen[key] != 1) invalid = 1
			}
		}
		END {
			for (binding in expected) if (seen[binding] != 1) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' <<<"$1"
}

platform_cutover_platform_admin_audit_queue_details_are_exact() {
	[[ $# -eq 1 && -n "$1" ]] || return 1
	PLATFORM_QUEUE_DETAILS_JSON="$1" \
		PLATFORM_QUEUE_PREFIX="$PLATFORM_ADMIN_AUDIT_QUEUE" \
		PLATFORM_QUEUE_KIND="$PLATFORM_ADMIN_AUDIT_KIND" node -e '
const rows = JSON.parse(process.env.PLATFORM_QUEUE_DETAILS_JSON);
const prefix = process.env.PLATFORM_QUEUE_PREFIX;
const kind = process.env.PLATFORM_QUEUE_KIND;
const expected = new Map([
  [prefix, {}],
  [`${prefix}.dead-letter`, {}],
  [`${prefix}.retry-v2.1`, {
    "x-message-ttl": 30_000,
    "x-dead-letter-exchange": "winwidget.manual-retry",
    "x-dead-letter-routing-key": kind,
  }],
  [`${prefix}.retry-v2.2`, {
    "x-message-ttl": 300_000,
    "x-dead-letter-exchange": "winwidget.manual-retry",
    "x-dead-letter-routing-key": kind,
  }],
  [`${prefix}.retry-v2.3`, {
    "x-message-ttl": 1_800_000,
    "x-dead-letter-exchange": "winwidget.manual-retry",
    "x-dead-letter-routing-key": kind,
  }],
]);
if (!Array.isArray(rows) || rows.length !== expected.size) process.exit(1);
const seen = new Set();
for (const row of rows) {
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      !expected.has(row.name) || seen.has(row.name) || row.vhost !== "winwidget" ||
      row.durable !== true || row.auto_delete !== false || row.exclusive !== false ||
      !row.arguments || typeof row.arguments !== "object" || Array.isArray(row.arguments)) {
    process.exit(1);
  }
  seen.add(row.name);
  const actualArguments = Object.entries(row.arguments).sort(([left], [right]) => left.localeCompare(right));
  const expectedArguments = Object.entries(expected.get(row.name)).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(actualArguments) !== JSON.stringify(expectedArguments)) process.exit(1);
}
if (seen.size !== expected.size) process.exit(1);
'
}

platform_cutover_assert_billing_worker_image() {
	local image_id
	image_id="$(platform_cutover_expected_release_image_id billing)" || return 1
	platform_cutover_assert_release_image_id billing "$image_id"
}

platform_cutover_assert_billing_api_candidate() {
	local container image_id metadata app_revision process_role env_sha
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q billing-api)" || return 1
	image_id="$(platform_cutover_expected_release_image_id billing)" || return 1
	platform_cutover_assert_release_image_id billing "$image_id" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	metadata="$(platform_database_docker inspect --format \
		'{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.Config.User}}' \
		"$container")" || return 1
	app_revision="$(platform_database_docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$container" | awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); seen += 1 } END { exit(seen == 1 ? 0 : 1) }')" || return 1
	process_role="$(platform_database_docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$container" | awk -F= '$1 == "BILLING_PROCESS_ROLE" { print substr($0, index($0, "=") + 1); seen += 1 } END { exit(seen == 1 ? 0 : 1) }')" || return 1
	[[ "$metadata" == "$image_id|$EXPECTED_REVISION|running|true|healthy|0|winwidget|billing-api|False|billing" &&
		"$app_revision" == "$EXPECTED_REVISION" && "$process_role" == api ]] ||
		platform_cutover_fail 'Billing API candidate runtime identity failed.' || return 1
	if platform_cutover_receipt_is_present; then
		env_sha="$(platform_cutover_container_env_sha256 "$container" -)" || return 1
		[[ "$container" == "$(platform_cutover_billing_readiness_value billing_api_container_id)" &&
			"$env_sha" == "$(platform_cutover_billing_readiness_value billing_api_env_sha256)" ]] ||
			platform_cutover_fail 'Billing API drifted from its immutable phase-A receipt.' || return 1
	fi
	curl --fail --silent --show-error http://127.0.0.1:4800/health/ready >/dev/null || return 1
	printf '%s\n' "$container"
}

platform_cutover_ensure_billing_api_candidate() {
	local container
	if container="$(platform_cutover_assert_billing_api_candidate 2>/dev/null)"; then
		printf '%s\n' "$container"
		return
	fi
	if platform_cutover_receipt_is_present; then
		platform_cutover_fail 'Receipt-bound Billing API is unavailable or drifted; automatic recreation is forbidden.'
		return 1
	fi
	platform_cutover_assert_billing_worker_image || return 1
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --force-recreate billing-api || return 1
	for _ in {1..60}; do
		if container="$(platform_cutover_assert_billing_api_candidate 2>/dev/null)"; then
			printf '%s\n' "$container"
			return
		fi
		sleep 2
	done
	platform_cutover_fail 'Billing API candidate did not become healthy.'
}

platform_cutover_assert_billing_worker_candidate() {
	local container image_id metadata environment
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q billing-worker)" || return 1
	image_id="$(platform_cutover_expected_release_image_id billing)" || return 1
	platform_cutover_assert_release_image_id billing "$image_id" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	metadata="$(platform_database_docker inspect --format \
		'{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.Config.User}}' \
		"$container")" || return 1
	environment="$(platform_database_docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$container" | awk -F= '
		$1 == "APP_REVISION" || $1 == "BILLING_PROCESS_ROLE" { print; seen[$1] += 1 }
		END { exit(seen["APP_REVISION"] == 1 && seen["BILLING_PROCESS_ROLE"] == 1 ? 0 : 1) }
	')" || return 1
	[[ "$metadata" == "$image_id|$EXPECTED_REVISION|running|true|healthy|0|winwidget|billing-worker|False|billing" &&
		"$environment" == *"APP_REVISION=$EXPECTED_REVISION"* &&
		"$environment" == *'BILLING_PROCESS_ROLE=worker'* ]] ||
		platform_cutover_fail 'Billing worker candidate runtime identity failed.' || return 1
	curl --fail --silent --show-error http://127.0.0.1:4802/health/ready >/dev/null
}

platform_cutover_provision_billing_offer_v2_permissions() {
	local container vhost username permissions topics
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	vhost="$(platform_database_url_field RABBITMQ_BILLING_WORKER_URL database)" || return 1
	username="$(platform_database_url_field RABBITMQ_BILLING_WORKER_URL username)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$vhost" == winwidget &&
		"$vhost" == "$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" &&
		"$username" == winwidget-billing-worker &&
		"$(platform_database_url_field RABBITMQ_BILLING_WORKER_URL protocol)" == amqp: &&
		"$(platform_database_url_field RABBITMQ_BILLING_WORKER_URL hostname)" == 127.0.0.1 &&
		"$(platform_database_url_field RABBITMQ_BILLING_WORKER_URL port)" == 5672 &&
		"$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" == healthy ]] ||
		platform_cutover_fail 'Billing worker RabbitMQ identity is invalid.' || return 1
	platform_database_docker exec "$container" rabbitmqctl set_permissions -p "$vhost" "$username" \
		"$PLATFORM_BILLING_WORKER_CONFIGURE" "$PLATFORM_BILLING_WORKER_WRITE" \
		"$PLATFORM_BILLING_WORKER_READ" >/dev/null
	platform_database_docker exec "$container" rabbitmqctl clear_topic_permissions -p "$vhost" "$username" >/dev/null
	platform_database_docker exec "$container" rabbitmqctl set_topic_permissions -p "$vhost" "$username" \
		winwidget.events '^$' "$PLATFORM_BILLING_WORKER_TOPIC_READ" >/dev/null
	permissions="$(platform_database_docker exec "$container" rabbitmqctl --silent list_permissions -p "$vhost" \
		user configure write read | awk -v user="$username" '
		$1 == user { print $1 "|" $2 "|" $3 "|" $4; count += 1 }
		END { if (count != 1) exit 1 }
	')" || return 1
	topics="$(platform_database_docker exec "$container" rabbitmqctl --silent list_topic_permissions -p "$vhost" \
		user exchange write read | awk -v user="$username" '
		$1 == user { print $1 "|" $2 "|" $3 "|" $4; count += 1 }
		END { if (count != 1) exit 1 }
	')" || return 1
	[[ "$permissions" == "$username|$PLATFORM_BILLING_WORKER_CONFIGURE|$PLATFORM_BILLING_WORKER_WRITE|$PLATFORM_BILLING_WORKER_READ" &&
		"$topics" == "$username|winwidget.events|^$|$PLATFORM_BILLING_WORKER_TOPIC_READ" ]] ||
		platform_cutover_fail 'Billing worker v2 RabbitMQ permissions are not exact.'
}

platform_cutover_retire_billing_offer_v1() {
	local container vhost listing queue
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$vhost" == winwidget ]] || return 1
	listing="$(platform_database_docker exec "$container" rabbitmqctl --silent list_queues -p "$vhost" \
		name durable messages_ready messages_unacknowledged consumers)" || return 1
	platform_cutover_billing_offer_v1_listing_is_retirable "$listing" ||
		platform_cutover_fail 'Legacy Billing offer v1 topology is not empty and unused.' || return 1
	for queue in "$PLATFORM_BILLING_OFFER_V1_QUEUE" \
		"$PLATFORM_BILLING_OFFER_V1_QUEUE.retry.1" "$PLATFORM_BILLING_OFFER_V1_QUEUE.retry.2" \
		"$PLATFORM_BILLING_OFFER_V1_QUEUE.retry.3" "$PLATFORM_BILLING_OFFER_V1_QUEUE.dead-letter"; do
		if awk -v queue="$queue" '$1 == queue { found += 1 } END { exit(found == 1 ? 0 : 1) }' <<<"$listing"; then
			platform_database_docker exec "$container" rabbitmqctl --silent delete_queue \
				-p "$vhost" "$queue" --if-empty --if-unused >/dev/null || return 1
		fi
	done
}

platform_cutover_verify_billing_offer_v2_boundary() {
	local container vhost username listing bindings permissions topics
	local management_url admin_user admin_password image queue_details
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	username="$(platform_database_url_field RABBITMQ_BILLING_WORKER_URL username)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$vhost" == winwidget &&
		"$username" == winwidget-billing-worker &&
		"$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" == healthy ]] || return 1
	listing="$(platform_database_docker exec "$container" rabbitmqctl --silent list_queues -p "$vhost" \
		name durable messages_ready messages_unacknowledged consumers)" || return 1
	platform_cutover_billing_offer_v2_listing_is_exact "$listing" ||
		platform_cutover_fail 'Billing offer v2 queues are not exact, empty, and exclusively consumed.' || return 1
	bindings="$(platform_database_docker exec "$container" rabbitmqctl --silent list_bindings -p "$vhost" \
		source_name destination_name destination_kind routing_key)" || return 1
	platform_cutover_billing_offer_v2_bindings_are_exact "$bindings" ||
		platform_cutover_fail 'Billing offer v2 bindings are not exact or legacy v1 bindings remain.' || return 1
	management_url="$(platform_read_env_value "$ENV_FILE" RABBITMQ_MANAGEMENT_URL)" || return 1
	admin_user="$(platform_read_env_value "$ENV_FILE" RABBITMQ_ADMIN_USER)" || return 1
	admin_password="$(platform_read_env_value "$ENV_FILE" RABBITMQ_ADMIN_PASSWORD)" || return 1
	image="$(platform_cutover_expected_release_image_id billing)" || return 1
	platform_cutover_assert_release_image_id billing "$image" || return 1
	[[ "$management_url" == http://127.0.0.1:15672 && "$admin_user" == winwidget-admin &&
		${#admin_password} -ge 32 ]] || return 1
	if ! queue_details="$(RABBITMQ_MANAGEMENT_URL="$management_url" \
		RABBITMQ_ADMIN_USER="$admin_user" RABBITMQ_ADMIN_PASSWORD="$admin_password" \
		RABBITMQ_PROVISION_VHOST="$vhost" platform_database_docker run --rm --network host --read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --cap-drop ALL \
		--security-opt no-new-privileges --pids-limit 64 \
		--env RABBITMQ_MANAGEMENT_URL --env RABBITMQ_ADMIN_USER --env RABBITMQ_ADMIN_PASSWORD \
		--env RABBITMQ_PROVISION_VHOST --entrypoint node "$image" -e '
const prefix = "winwidget.billing.offer.v2";
const names = [prefix, `${prefix}.dead-letter`, ...[1, 2, 3].map(index => `${prefix}.retry.${index}`)];
(async () => {
  const authorization = `Basic ${Buffer.from(`${process.env.RABBITMQ_ADMIN_USER}:${process.env.RABBITMQ_ADMIN_PASSWORD}`).toString("base64")}`;
  const rows = [];
  for (const name of names) {
    const response = await fetch(`${process.env.RABBITMQ_MANAGEMENT_URL}/api/queues/${encodeURIComponent(process.env.RABBITMQ_PROVISION_VHOST)}/${encodeURIComponent(name)}`, {
      headers: { authorization },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("queue lookup failed");
    const row = await response.json();
    rows.push({
      name: row.name,
      vhost: row.vhost,
      durable: row.durable,
      auto_delete: row.auto_delete,
      exclusive: row.exclusive,
      arguments: row.arguments,
    });
  }
  process.stdout.write(JSON.stringify(rows));
})().catch(() => {
  process.stderr.write("Billing offer v2 queue argument verification failed\n");
  process.exitCode = 1;
});
')"; then
		unset admin_password
		return 1
	fi
	unset admin_password
	platform_cutover_billing_offer_v2_queue_details_are_exact "$queue_details" ||
		platform_cutover_fail 'Billing offer v2 queue arguments are not exact.' || return 1
	permissions="$(platform_database_docker exec "$container" rabbitmqctl --silent list_permissions -p "$vhost" \
		user configure write read | awk -v user="$username" '
		$1 == user { print $1 "|" $2 "|" $3 "|" $4; count += 1 }
		END { if (count != 1) exit 1 }
	')" || return 1
	topics="$(platform_database_docker exec "$container" rabbitmqctl --silent list_topic_permissions -p "$vhost" \
		user exchange write read | awk -v user="$username" '
		$1 == user { print $1 "|" $2 "|" $3 "|" $4; count += 1 }
		END { if (count != 1) exit 1 }
	')" || return 1
	[[ "$permissions" == "$username|$PLATFORM_BILLING_WORKER_CONFIGURE|$PLATFORM_BILLING_WORKER_WRITE|$PLATFORM_BILLING_WORKER_READ" &&
		"$topics" == "$username|winwidget.events|^$|$PLATFORM_BILLING_WORKER_TOPIC_READ" ]] ||
		platform_cutover_fail 'Billing offer v2 worker permissions drifted.' || return 1
	platform_cutover_assert_billing_worker_candidate
}

platform_cutover_switch_billing_offer_consumer_v2() {
	platform_cutover_assert_billing_worker_image || return 1
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop --timeout 90 billing-worker || return 1
	local container vhost listing
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	listing="$(platform_database_docker exec "$container" rabbitmqctl --silent list_queues -p "$vhost" \
		name durable messages_ready messages_unacknowledged consumers)" || return 1
	platform_cutover_billing_offer_v1_listing_is_retirable "$listing" ||
		platform_cutover_fail 'Legacy Billing offer v1 queues changed after stopping their consumer.' || return 1
	platform_cutover_provision_billing_offer_v2_permissions || return 1
	platform_cutover_compose_with_receipt_images \
		up -d --no-deps --force-recreate billing-worker || return 1
	for _ in {1..60}; do
		if platform_cutover_assert_billing_worker_candidate >/dev/null 2>&1; then
			break
		fi
		sleep 2
	done
	platform_cutover_assert_billing_worker_candidate || return 1
	platform_cutover_retire_billing_offer_v1 || return 1
	platform_cutover_verify_billing_offer_v2_boundary
}

platform_cutover_assert_core_image() {
	local image_id
	image_id="$(platform_cutover_expected_release_image_id core)" || return 1
	platform_cutover_assert_release_image_id core "$image_id"
}

platform_cutover_assert_core_api_candidate() {
	[[ $# -le 1 && ( -z "${1:-}" || "${1:-}" =~ ^[0-9a-f]{64}$ ) ]] || return 1
	local expected_container="${1:-}" container image_id metadata environment env_sha
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api)" || return 1
	image_id="$(platform_cutover_expected_release_image_id core)" || return 1
	platform_cutover_assert_release_image_id core "$image_id" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		( -z "$expected_container" || "$container" == "$expected_container" ) ]] || return 1
	metadata="$(platform_database_docker inspect --format \
		'{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.Config.User}}' \
		"$container")" || return 1
	environment="$(platform_database_docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$container" | awk -F= '
		$1 == "APP_REVISION" { print; seen += 1 }
		END { exit(seen == 1 ? 0 : 1) }
	')" || return 1
	[[ "$metadata" == "$image_id|$EXPECTED_REVISION|running|true|healthy|0|winwidget|api|False|nestjs" &&
		"$environment" == "APP_REVISION=$EXPECTED_REVISION" ]] ||
		platform_cutover_fail 'Core API candidate runtime identity failed.' || return 1
	if platform_cutover_receipt_is_present; then
		env_sha="$(platform_cutover_container_env_sha256 "$container" -)" || return 1
		[[ "$container" == "$(platform_cutover_billing_readiness_value core_api_container_id)" &&
			"$env_sha" == "$(platform_cutover_billing_readiness_value core_api_env_sha256)" ]] ||
			platform_cutover_fail 'Core API drifted from its immutable phase-A receipt.' || return 1
	fi
	curl --fail --silent --show-error http://127.0.0.1:4200/api/v1/health/ready >/dev/null || return 1
	printf '%s\n' "$container"
}

platform_cutover_ensure_core_api_candidate() {
	local container
	if container="$(platform_cutover_assert_core_api_candidate 2>/dev/null)"; then
		printf '%s\n' "$container"
		return
	fi
	if platform_cutover_receipt_is_present; then
		platform_cutover_fail 'Receipt-bound Core API is unavailable or drifted; automatic recreation is forbidden.'
		return 1
	fi
	platform_cutover_assert_core_image || return 1
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --force-recreate api || return 1
	for _ in {1..60}; do
		if container="$(platform_cutover_assert_core_api_candidate 2>/dev/null)"; then
			printf '%s\n' "$container"
			return
		fi
		sleep 2
	done
	platform_cutover_fail 'Core API candidate did not become healthy.'
}

platform_cutover_assert_platform_admin_audit_topology() {
	local container image vhost management_url admin_user admin_password listing bindings queue_details
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	image="$(platform_cutover_expected_release_image_id core)" || return 1
	platform_cutover_assert_release_image_id core "$image" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	management_url="$(platform_read_env_value "$ENV_FILE" RABBITMQ_MANAGEMENT_URL)" || return 1
	admin_user="$(platform_read_env_value "$ENV_FILE" RABBITMQ_ADMIN_USER)" || return 1
	admin_password="$(platform_read_env_value "$ENV_FILE" RABBITMQ_ADMIN_PASSWORD)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$vhost" == winwidget &&
		"$management_url" == http://127.0.0.1:15672 && "$admin_user" == winwidget-admin &&
		${#admin_password} -ge 32 &&
		"$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" == healthy &&
		"$(platform_database_docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$EXPECTED_REVISION" ]] ||
		platform_cutover_fail 'RabbitMQ is not healthy for Platform audit topology verification.' || return 1
	listing="$(platform_database_docker exec "$container" rabbitmqctl --silent list_queues -p "$vhost" \
		name durable auto_delete exclusive)" || return 1
	bindings="$(platform_database_docker exec "$container" rabbitmqctl --silent list_bindings -p "$vhost" \
		source_name destination_name destination_kind routing_key)" || return 1
	platform_cutover_platform_admin_audit_queue_listing_is_exact "$listing" ||
		platform_cutover_fail 'Platform admin-audit queue family is not exact.' || return 1
	platform_cutover_platform_admin_audit_bindings_are_exact "$bindings" ||
		platform_cutover_fail 'Platform admin-audit bindings are not exact.' || return 1
	if ! queue_details="$(RABBITMQ_MANAGEMENT_URL="$management_url" \
		RABBITMQ_ADMIN_USER="$admin_user" RABBITMQ_ADMIN_PASSWORD="$admin_password" \
		RABBITMQ_PROVISION_VHOST="$vhost" platform_database_docker run --rm --network host --read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --cap-drop ALL \
		--security-opt no-new-privileges --pids-limit 64 \
		--env RABBITMQ_MANAGEMENT_URL --env RABBITMQ_ADMIN_USER --env RABBITMQ_ADMIN_PASSWORD \
		--env RABBITMQ_PROVISION_VHOST --entrypoint node "$image" -e '
const prefix = "winwidget.admin.audit.platform.v1";
const names = [prefix, `${prefix}.dead-letter`, ...[1, 2, 3].map(index => `${prefix}.retry-v2.${index}`)];
(async () => {
  const authorization = `Basic ${Buffer.from(`${process.env.RABBITMQ_ADMIN_USER}:${process.env.RABBITMQ_ADMIN_PASSWORD}`).toString("base64")}`;
  const rows = [];
  for (const name of names) {
    const response = await fetch(`${process.env.RABBITMQ_MANAGEMENT_URL}/api/queues/${encodeURIComponent(process.env.RABBITMQ_PROVISION_VHOST)}/${encodeURIComponent(name)}`, {
      headers: { authorization },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("queue lookup failed");
    const row = await response.json();
    rows.push({
      name: row.name,
      vhost: row.vhost,
      durable: row.durable,
      auto_delete: row.auto_delete,
      exclusive: row.exclusive,
      arguments: row.arguments,
    });
  }
  process.stdout.write(JSON.stringify(rows));
})().catch(() => {
  process.stderr.write("Platform audit queue argument verification failed\n");
  process.exitCode = 1;
});
')"; then
		unset admin_password
		return 1
	fi
	unset admin_password
	platform_cutover_platform_admin_audit_queue_details_are_exact "$queue_details" ||
		platform_cutover_fail 'Platform admin-audit queue arguments are not exact.'
}

platform_cutover_provision_platform_admin_audit_topology() {
	local container image admin_user admin_password vhost
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	image="$(platform_cutover_expected_release_image_id core)" || return 1
	platform_cutover_assert_release_image_id core "$image" || return 1
	admin_user="$(platform_read_env_value "$ENV_FILE" RABBITMQ_ADMIN_USER)" || return 1
	admin_password="$(platform_read_env_value "$ENV_FILE" RABBITMQ_ADMIN_PASSWORD)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$admin_user" == winwidget-admin &&
		${#admin_password} -ge 32 && "$vhost" == winwidget &&
		"$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" == healthy &&
		"$(platform_database_docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$EXPECTED_REVISION" ]] ||
		platform_cutover_fail 'Platform audit topology provisioning identity is invalid.' || return 1
	RABBITMQ_ADMIN_USER="$admin_user" RABBITMQ_ADMIN_PASSWORD="$admin_password" \
		RABBITMQ_PROVISION_VHOST="$vhost" platform_database_docker run --rm --network host --read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --cap-drop ALL \
		--security-opt no-new-privileges --pids-limit 64 \
		--env RABBITMQ_ADMIN_USER --env RABBITMQ_ADMIN_PASSWORD --env RABBITMQ_PROVISION_VHOST \
		--env "APP_REVISION=$EXPECTED_REVISION" --entrypoint node "$image" -e '
const amqp = require("amqplib");
const queue = "winwidget.admin.audit.platform.v1";
const kind = "platform-admin-audit";
const delays = [30_000, 300_000, 1_800_000];
(async () => {
  const connection = await amqp.connect({
    protocol: "amqp",
    hostname: "127.0.0.1",
    port: 5672,
    username: process.env.RABBITMQ_ADMIN_USER,
    password: process.env.RABBITMQ_ADMIN_PASSWORD,
    vhost: process.env.RABBITMQ_PROVISION_VHOST,
    clientProperties: {
      connection_name: `winwidget-platform-cutover-topology-${process.env.APP_REVISION}`,
    },
  }, { timeout: 10_000 });
  try {
    const channel = await connection.createConfirmChannel();
    try {
      await channel.assertExchange("winwidget.events", "topic", { durable: true });
      await channel.assertExchange("winwidget.retry", "direct", { durable: true });
      await channel.assertExchange("winwidget.dead-letter", "topic", { durable: true });
      await channel.assertExchange("winwidget.manual-retry", "direct", { durable: true });
      await channel.assertQueue(queue, { durable: true });
      await channel.bindQueue(queue, "winwidget.events", "admin.audit.platform.v1");
      await channel.bindQueue(queue, "winwidget.events", `manual.${kind}`);
      await channel.bindQueue(queue, "winwidget.manual-retry", kind);
      await channel.assertQueue(`${queue}.dead-letter`, { durable: true });
      await channel.bindQueue(`${queue}.dead-letter`, "winwidget.dead-letter", `${kind}.dead-letter`);
      await channel.bindQueue(`${queue}.dead-letter`, "winwidget.events", `${kind}.dead-letter`);
      for (const [index, delay] of delays.entries()) {
        const retryQueue = `${queue}.retry-v2.${index + 1}`;
        await channel.assertQueue(retryQueue, {
          durable: true,
          messageTtl: delay,
          deadLetterExchange: "winwidget.manual-retry",
          deadLetterRoutingKey: kind,
        });
        await channel.bindQueue(retryQueue, "winwidget.retry", `${kind}.retry.${index + 1}`);
      }
    } finally {
      await channel.close();
    }
  } finally {
    await connection.close();
  }
})().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Platform audit topology provisioning failed"}\n`);
  process.exitCode = 1;
});
' >/dev/null || {
		unset admin_password
		platform_cutover_fail 'Platform admin-audit topology provisioning failed.'
		return 1
	}
	unset admin_password
	platform_cutover_assert_platform_admin_audit_topology
}

platform_cutover_assert_integration_worker_permissions() {
	local container url username password vhost protocol hostname port
	local permissions topic_permissions user_row
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ &&
		"$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" == healthy ]] ||
		platform_cutover_fail 'RabbitMQ is not healthy for the integration worker.' || return 1
	url=RABBITMQ_INTEGRATION_WORKER_URL
	username="$(platform_database_url_field "$url" username)" || return 1
	password="$(platform_database_url_field "$url" password)" || return 1
	vhost="$(platform_database_url_field "$url" database)" || return 1
	protocol="$(platform_database_url_field "$url" protocol)" || return 1
	hostname="$(platform_database_url_field "$url" hostname)" || return 1
	port="$(platform_database_url_field "$url" port)" || return 1
	[[ "$protocol" == amqp: && "$hostname" == 127.0.0.1 && "$port" == 5672 &&
		"$vhost" == winwidget && "$vhost" == "$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" &&
		"$username" == winwidget-integration && ${#password} -ge 32 ]] ||
		platform_cutover_fail 'Integration-worker RabbitMQ URL identity is invalid.' || return 1
	platform_cutover_rabbitmq_password_command "$container" authenticate_user "$username" "$password" >/dev/null || {
		unset password
		platform_cutover_fail 'Integration-worker RabbitMQ credentials do not authenticate.'
		return 1
	}
	permissions="$(platform_database_docker exec "$container" rabbitmqctl --silent \
		list_user_permissions "$username" | awk 'NF == 4 { print $1 "|" $2 "|" $3 "|" $4 }')" || return 1
	topic_permissions="$(platform_database_docker exec "$container" rabbitmqctl --silent \
		list_user_topic_permissions "$username" | awk 'NF == 4 { print $1 "|" $2 "|" $3 "|" $4 }')" || return 1
	user_row="$(platform_database_docker exec "$container" rabbitmqctl --silent list_users | awk -v user="$username" '
		$1 == user {
			matched += 1
			if (matched == 1) {
				tags = $0
				sub(/^[^[:space:]]+[[:space:]]+/, "", tags)
				print $1 "|" tags
			}
		}
		END { exit(matched == 1 ? 0 : 1) }
	')" || return 1
	unset password
	[[ "$permissions" == "$vhost|$PLATFORM_STEADY_INTEGRATION_CONFIGURE|$PLATFORM_STEADY_INTEGRATION_WRITE|$PLATFORM_STEADY_INTEGRATION_READ" &&
		-z "$topic_permissions" && "$user_row" == "$username|[]" ]] ||
		platform_cutover_fail 'Integration-worker RabbitMQ permissions are not exact.'
}

platform_cutover_provision_integration_worker_permissions() {
	local container url username password vhost protocol hostname port vhosts other_vhost
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ &&
		"$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" == healthy ]] ||
		platform_cutover_fail 'RabbitMQ is not healthy for integration-worker provisioning.' || return 1
	url=RABBITMQ_INTEGRATION_WORKER_URL
	username="$(platform_database_url_field "$url" username)" || return 1
	password="$(platform_database_url_field "$url" password)" || return 1
	vhost="$(platform_database_url_field "$url" database)" || return 1
	protocol="$(platform_database_url_field "$url" protocol)" || return 1
	hostname="$(platform_database_url_field "$url" hostname)" || return 1
	port="$(platform_database_url_field "$url" port)" || return 1
	[[ "$protocol" == amqp: && "$hostname" == 127.0.0.1 && "$port" == 5672 &&
		"$vhost" == winwidget && "$vhost" == "$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" &&
		"$username" == winwidget-integration && ${#password} -ge 32 ]] ||
		platform_cutover_fail 'Integration-worker RabbitMQ URL identity is invalid.' || return 1
	if platform_database_docker exec "$container" rabbitmqctl --silent list_users | awk '{ print $1 }' | grep -Fxq "$username"; then
		platform_cutover_rabbitmq_password_command "$container" change_password "$username" "$password" >/dev/null || return 1
	else
		platform_cutover_rabbitmq_password_command "$container" add_user "$username" "$password" >/dev/null || return 1
	fi
	vhosts="$(platform_database_docker exec "$container" rabbitmqctl --silent list_vhosts name)" || return 1
	while IFS= read -r other_vhost; do
		[[ -n "$other_vhost" ]] || continue
		if [[ "$other_vhost" != "$vhost" ]]; then
			platform_database_docker exec "$container" rabbitmqctl clear_permissions \
				-p "$other_vhost" "$username" >/dev/null 2>&1 || true
			platform_database_docker exec "$container" rabbitmqctl clear_topic_permissions \
				-p "$other_vhost" "$username" >/dev/null 2>&1 || true
		fi
	done <<<"$vhosts"
	platform_database_docker exec "$container" rabbitmqctl set_permissions -p "$vhost" "$username" \
		"$PLATFORM_STEADY_INTEGRATION_CONFIGURE" "$PLATFORM_STEADY_INTEGRATION_WRITE" \
		"$PLATFORM_STEADY_INTEGRATION_READ" >/dev/null || return 1
	platform_database_docker exec "$container" rabbitmqctl clear_topic_permissions \
		-p "$vhost" "$username" >/dev/null 2>&1 || true
	platform_database_docker exec "$container" rabbitmqctl set_user_tags "$username" >/dev/null || return 1
	platform_cutover_rabbitmq_password_command "$container" authenticate_user "$username" "$password" >/dev/null || return 1
	unset password
	platform_cutover_assert_integration_worker_permissions
}

platform_cutover_assert_integration_worker_candidate() {
	local container image_id metadata app_revision kinds
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q integration-worker)" || return 1
	image_id="$(platform_cutover_expected_release_image_id core)" || return 1
	platform_cutover_assert_release_image_id core "$image_id" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	metadata="$(platform_database_docker inspect --format \
		'{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Status}}|{{.State.Running}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.Config.User}}' \
		"$container")" || return 1
	app_revision="$(platform_database_docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$container" | awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); seen += 1 } END { exit(seen == 1 ? 0 : 1) }')" || return 1
	kinds="$(platform_database_docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$container" | awk -F= '$1 == "INTEGRATION_WORKER_KINDS" { print substr($0, index($0, "=") + 1); seen += 1 } END { exit(seen == 1 ? 0 : 1) }')" || return 1
	[[ "$metadata" == "$image_id|$EXPECTED_REVISION|running|true|0|winwidget|integration-worker|False|nestjs" &&
		"$app_revision" == "$EXPECTED_REVISION" &&
		"$kinds" == "$PLATFORM_STEADY_INTEGRATION_KINDS" ]] ||
		platform_cutover_fail 'Core integration-worker candidate runtime identity failed.' || return 1
	platform_cutover_assert_integration_worker_permissions || return 1
	platform_cutover_assert_platform_admin_audit_topology
}

platform_cutover_legacy_settings_queue_listing_is_drained() {
	[[ $# -eq 1 ]] || return 1
	PLATFORM_AWK_LEGACY_PATTERN="$PLATFORM_LEGACY_SETTINGS_QUEUE_PATTERN" awk '
		BEGIN { pattern = ENVIRON["PLATFORM_AWK_LEGACY_PATTERN"] }
		$1 ~ pattern {
			seen[$1] += 1
			if (NF != 5 || seen[$1] != 1 || $2 != "true" ||
				$3 != 0 || $4 != 0 || $5 != 0) invalid = 1
		}
		END { exit(invalid ? 1 : 0) }
	' <<<"$1"
}

platform_cutover_core_route_status() {
	[[ $# -eq 2 && "$1" =~ ^(GET|PATCH)$ ]] || return 1
	local method="$1" path="$2"
	case "$method:$path" in
	GET:/site-settings | GET:/legal-pages | GET:/legal-pages/oferta | GET:/home-page-content | \
		PATCH:/site-settings | PATCH:/legal-pages/oferta | PATCH:/home-page-content) ;;
	*) return 1 ;;
	esac
	if [[ "$method" == PATCH ]]; then
		curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
			--max-time 10 --request PATCH --header 'content-type: application/json' \
			--data '{}' "http://127.0.0.1:4200/api/v1$path"
	else
		curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
			--max-time 10 "http://127.0.0.1:4200/api/v1$path"
	fi
}

platform_cutover_assert_core_routes() {
	[[ $# -eq 2 && "$1" =~ ^(removed|fenced|retired)$ && "$2" =~ ^[0-9a-f]{64}$ ]] || return 1
	local state="$1" container="$2" path
	platform_cutover_assert_core_api_candidate "$container" >/dev/null || return 1
	for path in /site-settings /legal-pages /legal-pages/oferta /home-page-content; do
		[[ "$(platform_cutover_core_route_status GET "$path")" == 404 ]] ||
			platform_cutover_fail "Core route state is not $state for GET $path." || return 1
	done
	for path in /site-settings /legal-pages/oferta /home-page-content; do
		[[ "$(platform_cutover_core_route_status PATCH "$path")" == 404 ]] ||
			platform_cutover_fail "Core route state is not $state for PATCH $path." || return 1
	done
}

platform_cutover_settings_projection_topology_is_absent() {
	local container vhost listing bindings
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$vhost" == winwidget ]] || return 1
	listing="$(platform_database_docker exec "$container" rabbitmqctl --silent list_queues -p "$vhost" name)" || return 1
	! PLATFORM_AWK_LEGACY_PATTERN="$PLATFORM_LEGACY_SETTINGS_QUEUE_PATTERN" awk \
		'BEGIN { pattern = ENVIRON["PLATFORM_AWK_LEGACY_PATTERN"] }
		 $1 ~ pattern { found = 1 } END { exit(found ? 0 : 1) }' <<<"$listing" || return 1
	bindings="$(platform_database_docker exec "$container" rabbitmqctl --silent list_bindings -p "$vhost" \
		source_name destination_name routing_key)" || return 1
	! PLATFORM_AWK_LEGACY_PATTERN="$PLATFORM_LEGACY_SETTINGS_QUEUE_PATTERN" awk \
		'BEGIN { pattern = ENVIRON["PLATFORM_AWK_LEGACY_PATTERN"] }
		 $1 ~ pattern || $2 ~ pattern { found = 1 } END { exit(found ? 0 : 1) }' <<<"$bindings"
}

platform_cutover_retire_settings_projection() {
	[[ $# -le 1 && "${1:-ready}" =~ ^(hold-billing|ready)$ ]] || return 1
	local mode="${1:-ready}" container vhost listing queue running_billing unpublished
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	vhost="$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$vhost" == winwidget ]] || return 1
	listing="$(platform_database_docker exec "$container" rabbitmqctl --silent list_queues -p "$vhost" \
		name durable messages_ready messages_unacknowledged consumers)" || return 1
	if PLATFORM_AWK_LEGACY_PATTERN="$PLATFORM_LEGACY_SETTINGS_QUEUE_PATTERN" awk \
		'BEGIN { pattern = ENVIRON["PLATFORM_AWK_LEGACY_PATTERN"] }
		 $1 ~ pattern { found = 1 } END { exit(found ? 0 : 1) }' <<<"$listing"; then
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			stop --timeout 90 integration-worker billing-worker || return 1
		listing="$(platform_database_docker exec "$container" rabbitmqctl --silent list_queues -p "$vhost" \
			name durable messages_ready messages_unacknowledged consumers)" || return 1
		platform_cutover_legacy_settings_queue_listing_is_drained "$listing" ||
			platform_cutover_fail 'Legacy Billing settings queues are not empty and unused.' || return 1
		unpublished="$(platform_cutover_query DATABASE_BACKUP_URL \
			"SELECT count(*) FROM public.outbox_events
			 WHERE event_type = 'billing.settings.source.changed.v1'
			   AND status::text <> 'PUBLISHED';")" || return 1
		[[ "$unpublished" == 0 ]] ||
			platform_cutover_fail 'Legacy Billing settings Outbox is not fully published.' || return 1
		platform_cutover_verify_gateway_routes || return 1
		while IFS=' ' read -r queue _; do
			[[ "$queue" =~ $PLATFORM_LEGACY_SETTINGS_QUEUE_PATTERN ]] || continue
			platform_database_docker exec "$container" rabbitmqctl --silent delete_queue \
				-p "$vhost" "$queue" --if-empty --if-unused >/dev/null || return 1
			done <<<"$listing"
	fi
	platform_cutover_provision_platform_admin_audit_topology || return 1
	platform_cutover_provision_integration_worker_permissions || return 1
	if [[ "$mode" == hold-billing ]]; then
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			stop --timeout 90 billing-worker || return 1
		if ! platform_cutover_assert_integration_worker_candidate >/dev/null 2>&1; then
			platform_cutover_compose_with_receipt_images \
				up -d --no-deps --force-recreate integration-worker || return 1
		fi
		for _ in {1..60}; do
			if platform_cutover_assert_integration_worker_candidate >/dev/null 2>&1; then
				break
			fi
			sleep 2
		done
		platform_cutover_assert_integration_worker_candidate || return 1
		running_billing="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			ps --status running -q billing-worker)" || return 1
		[[ -z "$running_billing" ]] ||
			platform_cutover_fail 'Billing worker must remain stopped until offer-v2 permissions are installed.' || return 1
		platform_cutover_settings_projection_topology_is_absent || return 1
		return 0
	fi
	if ! platform_cutover_assert_integration_worker_candidate >/dev/null 2>&1 ||
		! platform_cutover_assert_billing_worker_candidate >/dev/null 2>&1; then
		platform_cutover_compose_with_receipt_images \
			up -d --no-deps --force-recreate integration-worker billing-worker || return 1
	fi
	for _ in {1..60}; do
		if platform_cutover_assert_integration_worker_candidate >/dev/null 2>&1 &&
			platform_cutover_assert_billing_worker_candidate >/dev/null 2>&1; then
			break
		fi
		sleep 2
	done
	platform_cutover_assert_integration_worker_candidate || return 1
	platform_cutover_assert_billing_worker_candidate || return 1
	platform_cutover_settings_projection_topology_is_absent
}

platform_cutover_billing_offer_projection_matches() {
	local core billing core_version core_sequence core_updated core_content
	local billing_version billing_sequence billing_updated billing_content billing_sha
	local tombstone billing_next expected_sha
	core="$(platform_cutover_query DATABASE_BACKUP_URL \
		"SELECT aggregate.version::text || '|' || aggregate.source_sequence::text || '|' ||
			to_char(page.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') || '|' ||
			replace(encode(convert_to(page.content, 'UTF8'), 'base64'), E'\\n', '')
		 FROM public.billing_source_aggregate_versions aggregate
		 JOIN public.legal_pages page ON page.slug = 'oferta'
		 WHERE aggregate.aggregate_type = 'billing.offer' AND aggregate.aggregate_id = 'offer';")" || return 1
	billing="$(platform_cutover_query BILLING_BACKUP_URL \
		"SELECT projection.projection_version::text || '|' || projection.source_sequence::text || '|' ||
			to_char(projection.source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') || '|' ||
			replace(encode(convert_to(projection.content, 'UTF8'), 'base64'), E'\\n', '') || '|' ||
			projection.sha256 || '|' || projection.tombstone::text || '|' || sequence.next_value::text
		 FROM billing.offer_projections projection
		 JOIN billing.source_sequences sequence ON sequence.id = 'billing'
		 WHERE projection.id = 'offer';")" || return 1
	IFS='|' read -r core_version core_sequence core_updated core_content <<<"$core"
	IFS='|' read -r billing_version billing_sequence billing_updated billing_content \
		billing_sha tombstone billing_next <<<"$billing"
	[[ "$core_version" =~ ^[1-9][0-9]*$ && "$core_sequence" =~ ^[1-9][0-9]*$ &&
		"$billing_next" =~ ^[1-9][0-9]*$ && "$billing_sha" =~ ^[0-9a-f]{64}$ &&
		"$core_version|$core_sequence|$core_updated|$core_content" == "$billing_version|$billing_sequence|$billing_updated|$billing_content" &&
		"$tombstone" == false ]] || return 1
	expected_sha="$(printf '%s' "$core_content" | base64 -d | platform_cutover_sha256 /dev/stdin)" || return 1
	[[ "$expected_sha" == "$billing_sha" ]] || return 1
	[[ ${#billing_next} -gt ${#billing_sequence} ||
		( ${#billing_next} -eq ${#billing_sequence} && "$billing_next" > "$billing_sequence" ) ]]
}

platform_cutover_wait_billing_offer_boundary() {
	local attempt core_unpublished billing_unresolved billing_in_flight
	for ((attempt = 1; attempt <= 90; attempt++)); do
		core_unpublished="$(platform_cutover_query DATABASE_BACKUP_URL \
			"SELECT count(*) FROM public.outbox_events WHERE routing_key = 'billing.offer.changed.v1' AND status <> 'PUBLISHED';")" || return 1
		billing_unresolved="$(platform_cutover_query BILLING_BACKUP_URL \
			"SELECT count(*) FROM billing.integration_delivery_failures WHERE consumer = 'offer' AND resolved_at IS NULL;")" || return 1
		billing_in_flight="$(platform_cutover_query BILLING_BACKUP_URL \
			"SELECT count(*) FROM billing.integration_delivery_receipts WHERE consumer = 'offer' AND status IN ('PROCESSING', 'RETRY_SCHEDULED');")" || return 1
		if [[ "$core_unpublished|$billing_unresolved|$billing_in_flight" == '0|0|0' ]] &&
			platform_cutover_billing_offer_queues_drained &&
			platform_cutover_billing_offer_projection_matches; then
			return
		fi
		sleep 2
	done
	platform_cutover_fail 'Billing offer Outbox, RabbitMQ queues, or projection did not reach the frozen boundary.'
}

platform_cutover_evidence_dir() {
	local generation
	if [[ "$(platform_cutover_current_phase)" == absent ]]; then
		generation="$(platform_database_marker_value generation)" || return 1
	else
		generation="$(platform_cutover_marker_value generation)" || return 1
	fi
	[[ "$generation" =~ ^[1-9][0-9]{0,17}$ ]] || return 1
	printf '%s/platform-%s-generation-%s\n' "$platform_evidence_parent" "$EXPECTED_REVISION" "$generation"
}

platform_cutover_prepare_evidence_dir() {
	local directory approved_parent
	directory="$(platform_cutover_evidence_dir)"
	approved_parent="$(dirname -- "$platform_evidence_parent")"
	[[ "$directory" == /* && "$directory" != *$'\n'* &&
		"$(dirname -- "$directory")" == "$platform_evidence_parent" ]] || return 1
	if [[ ! -e "$platform_evidence_parent" && ! -L "$platform_evidence_parent" ]]; then
		mkdir -- "$platform_evidence_parent" || return 1
		chmod 700 "$platform_evidence_parent" || return 1
		[[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]] ||
			chown 0:0 "$platform_evidence_parent" || return 1
		sync -f "$approved_parent" || return 1
	fi
	platform_cutover_validate_private_directory "$platform_evidence_parent" || return 1
	if [[ ! -e "$directory" && ! -L "$directory" ]]; then
		mkdir -- "$directory" || return 1
		chmod 700 "$directory" || return 1
		[[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]] || chown 0:0 "$directory" || return 1
		sync -f "$platform_evidence_parent" || return 1
	fi
	platform_cutover_validate_private_directory "$directory" || return 1
	printf '%s\n' "$directory"
}

platform_cutover_cli() {
	[[ $# -ge 2 && "$1" =~ ^(core|target)$ ]] || return 1
	local scope="$1" image_id url_key entrypoint
	shift
	image_id="$(platform_cutover_marker_value image_id)"
	if [[ "$scope" == core ]]; then
		url_key=DATABASE_MIGRATION_URL_PRODUCTION
		entrypoint=dist/src/cutover/core-main.js
	else
		url_key=PLATFORM_MIGRATION_DATABASE_URL
		entrypoint=dist/src/cutover/main.js
	fi
	local url snapshot directory mount_args=()
	local PLATFORM_CORE_DATABASE_URL PLATFORM_DATABASE_URL
	url="$(platform_read_env_value "$ENV_FILE" "$url_key")" || return 1
	directory="$(platform_cutover_evidence_dir)"
	if [[ -d "$directory" ]]; then
		platform_cutover_validate_private_directory "$directory" || return 1
		mount_args=(--mount "type=bind,source=$directory,target=/evidence")
	fi
	if [[ "$scope" == core ]]; then
		PLATFORM_CORE_DATABASE_URL="$url"
		export PLATFORM_CORE_DATABASE_URL
		platform_database_docker run --rm --network host --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 \
			--cap-drop ALL --security-opt no-new-privileges --pids-limit 128 \
			--user 0:0 "${mount_args[@]}" --env PLATFORM_CORE_DATABASE_URL \
			--entrypoint node "$image_id" "$entrypoint" "$@"
	else
		snapshot="$directory/platform-snapshot.json"
		[[ -f "$snapshot" && ! -L "$snapshot" ]] || {
			case "${1:-}" in status | verify | validate-shadow | abort) ;; *) return 1 ;; esac
		}
		PLATFORM_DATABASE_URL="$url"
		export PLATFORM_DATABASE_URL
		platform_database_docker run --rm --network host --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 \
			--cap-drop ALL --security-opt no-new-privileges --pids-limit 128 \
			--user 0:0 "${mount_args[@]}" --env PLATFORM_DATABASE_URL \
			--entrypoint node "$image_id" "$entrypoint" "$@"
	fi
}

platform_cutover_snapshot_field() {
	[[ $# -eq 1 && "$1" =~ ^(sourceFingerprint|platformHighWater)$ ]] || return 1
	local snapshot field="$1" image_id
	snapshot="$(platform_cutover_evidence_dir)/platform-snapshot.json"
	platform_cutover_validate_private_file "$snapshot" || return 1
	image_id="$(platform_cutover_marker_value image_id)"
	platform_database_docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
		--mount "type=bind,source=$snapshot,target=/snapshot.json,readonly" \
		--entrypoint node "$image_id" -e '
const fs = require("node:fs");
const snapshot = JSON.parse(fs.readFileSync("/snapshot.json", "utf8"));
const fields = {
  sourceFingerprint: snapshot.sourceFingerprint,
  platformHighWater: snapshot.platformHighWater,
};
const value = fields[process.argv[1]];
if (typeof value !== "string") process.exit(1);
if (/Fingerprint$/.test(process.argv[1]) && !/^[0-9a-f]{64}$/.test(value)) process.exit(1);
if (!/Fingerprint$/.test(process.argv[1]) && !/^[1-9][0-9]*$/.test(value)) process.exit(1);
process.stdout.write(value);
' "$field"
}

platform_cutover_dump() {
	[[ $# -eq 4 ]] || return 1
	local url_key="$1" schema="$2" output="$3" expected="$4" directory temporary
	directory="$(dirname -- "$output")"
	platform_cutover_validate_private_directory "$directory" || return 1
	if [[ -f "$output" && ! -L "$output" ]]; then
		local existing
		platform_cutover_validate_private_file "$output" || return 1
		[[ "$(head -c 5 "$output")" == PGDMP ]] ||
			platform_cutover_fail 'Existing Platform lifecycle dump is not a custom pg_dump archive.' || return 1
		existing="$(platform_cutover_sha256 "$output")"
		[[ "$expected" == pending || "$existing" == "$expected" ]] ||
			platform_cutover_fail 'Existing Platform lifecycle dump has another SHA-256.' || return 1
		printf '%s\n' "$existing"
		return
	fi
	[[ ! -e "$output" && ! -L "$output" ]] || return 1
	local username password hostname port database
	username="$(platform_database_url_field "$url_key" username)"
	password="$(platform_database_url_field "$url_key" password)"
	hostname="$(platform_database_url_field "$url_key" hostname)"
	port="$(platform_database_url_field "$url_key" port)"
	database="$(platform_database_url_field "$url_key" database)"
	temporary="$(mktemp "$directory/.$(basename -- "$output").partial.XXXXXX")" || return 1
	if ! PGPASSWORD="$password" platform_database_docker run --rm --network host --env PGPASSWORD \
		--mount "type=bind,source=$directory,target=/output" \
		--entrypoint pg_dump "$PLATFORM_CUTOVER_POSTGRES_IMAGE" \
		--host "$hostname" --port "$port" --username "$username" --dbname "$database" \
		--format custom --compress=9 --no-owner --no-acl --schema "$schema" \
		--file "/output/$(basename -- "$temporary")"; then
		rm -f -- "$temporary"
		unset password
		return 1
	fi
	unset password
	if [[ ! -s "$temporary" || "$(head -c 5 "$temporary")" != PGDMP ]] ||
		! chmod 600 "$temporary" ||
		! { [[ "$(uname -s)" != Linux || "$(id -u)" != 0 ]] || chown 0:0 "$temporary"; } ||
		! sync -f "$temporary" || [[ -e "$output" || -L "$output" ]] ||
		! ln -- "$temporary" "$output" || ! rm -f -- "$temporary" ||
		! sync -f "$output" || ! sync -f "$directory" ||
		! platform_cutover_validate_private_file "$output"; then
		rm -f -- "$temporary"
		return 1
	fi
	platform_cutover_sha256 "$output"
}

platform_cutover_validate_gateway_manifest() {
	[[ $# -le 2 ]] || return 1
	local routes image_id env_file="${2:-$ENV_FILE}"
	routes="$(platform_read_env_value "$env_file" GATEWAY_ROUTES_JSON)" || return 1
	image_id="${1:-$(platform_cutover_expected_release_image_id gateway)}"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	platform_cutover_assert_release_image_id gateway "$image_id" || return 1
	platform_database_docker run --rm --network none --read-only \
		--env "ROUTES=$routes" --env CONTRACT_MODE=final \
		--entrypoint node "$image_id" -e '
const { loadConfig } = require("/app/dist/src/config.js");
const { matchGatewayRoute } = require("/app/dist/src/server.js");
const source = JSON.parse(process.env.ROUTES);
const base = {
  JWT_JWKS_URL: "http://127.0.0.1:4900/.well-known/jwks.json",
  JWT_ISSUER: "https://winwidget.ru",
  JWT_AUDIENCE: "winwidget",
  CORS_ALLOWED_ORIGINS: "https://winwidget.ru",
};
const parsed = document => loadConfig({ ...base, GATEWAY_ROUTES_JSON: JSON.stringify(document) }).routes;
const expected = [
  ["platform-site-settings", "/api/v1/site-settings", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-legal-pages", "/api/v1/legal-pages", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-home-page-content", "/api/v1/home-page-content", "http://127.0.0.1:5000", "optional", 60000],
  ["billing-settings-public", "/api/v1/billing-settings/public", "http://127.0.0.1:4800", "optional", 30000],
  ["billing-settings-admin", "/api/v1/billing-settings/admin", "http://127.0.0.1:4800", "required", 30000],
];
const interceptPrefixes = ["/api/v1/site-settings", "/api/v1/legal-pages", "/api/v1/home-page-content", "/api/v1/billing-settings"];
const contract = document => {
  let routes;
  try { routes = parsed(document); } catch { return false; }
  const monolithIndex = document.findIndex(route => route?.id === "monolith");
  const monolith = document[monolithIndex];
  if (monolithIndex < 0 || monolith?.pathPrefix !== "/api/v1" ||
      monolith?.upstreamUrl !== "http://127.0.0.1:4200" ||
      monolith?.authPolicy !== "optional" || monolith?.timeoutMs !== 60000) return false;
  for (const [id, pathPrefix, upstreamUrl, authPolicy, timeoutMs] of expected) {
    const matches = document.filter(route => route?.id === id);
    if (matches.length !== 1) return false;
    const route = matches[0];
    if (route.pathPrefix !== pathPrefix || route.upstreamUrl !== upstreamUrl ||
        route.authPolicy !== authPolicy || route.timeoutMs !== timeoutMs ||
        document.indexOf(route) >= monolithIndex) return false;
  }
  const exactPaths = new Set(expected.map(([, path]) => path));
  if (document.some(route => interceptPrefixes.some(prefix =>
      (route?.pathPrefix === prefix || route?.pathPrefix?.startsWith(`${prefix}/`)) &&
      !exactPaths.has(route.pathPrefix)))) return false;
  const matrix = [
    ["/api/v1/site-settings", "platform-site-settings"],
    ["/api/v1/site-settings/admin", "platform-site-settings"],
    ["/api/v1/legal-pages/terms", "platform-legal-pages"],
    ["/api/v1/home-page-content/admin", "platform-home-page-content"],
    ["/api/v1/billing-settings/public", "billing-settings-public"],
    ["/api/v1/billing-settings/admin/private", "billing-settings-admin"],
    ["/api/v1/site-settings-shadow", "monolith"],
  ];
  return matrix.every(([path, id]) => matchGatewayRoute(path, routes)?.id === id);
};
if (!contract(source)) process.exit(1);
const clone = value => JSON.parse(JSON.stringify(value));
const first = source.findIndex(route => route?.id === "platform-site-settings");
if (first < 0) process.exit(1);
for (const mutate of [
  document => document.push({ ...document[first], pathPrefix: "/api/v1/phase-a-duplicate" }),
  document => { document[first].unknown = true; },
  document => { delete document[first].timeoutMs; },
]) {
  const candidate = clone(source); mutate(candidate);
  let rejected = false;
  try { parsed(candidate); } catch { rejected = true; }
  if (!rejected) process.exit(1);
}
for (const mutate of [
  document => { document[first].upstreamUrl = "http://127.0.0.1:4200"; },
  document => { document[first].authPolicy = "required"; },
  document => { document[first].timeoutMs = 30000; },
  document => document.splice(first, 0, { id: "platform-interceptor", pathPrefix: "/api/v1/site-settings/private", upstreamUrl: "http://127.0.0.1:5000", authPolicy: "optional", timeoutMs: 60000 }),
]) {
  const candidate = clone(source); mutate(candidate);
  if (contract(candidate)) process.exit(1);
}
'
}

platform_cutover_validate_phase_a_gateway_manifest() {
	[[ $# -ge 1 && $# -le 2 && "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local routes image_id="$1" env_file="${2:-$platform_phase_a_env_artifact}"
	routes="$(platform_read_env_value "$env_file" GATEWAY_ROUTES_JSON)" || return 1
	platform_database_docker run --rm --network none --read-only \
		--env "ROUTES=$routes" --env CONTRACT_MODE=phase-a \
		--entrypoint node "$image_id" -e '
const { loadConfig } = require("/app/dist/src/config.js");
const { matchGatewayRoute } = require("/app/dist/src/server.js");
const source = JSON.parse(process.env.ROUTES);
const base = { JWT_JWKS_URL: "http://127.0.0.1:4900/.well-known/jwks.json", JWT_ISSUER: "https://winwidget.ru", JWT_AUDIENCE: "winwidget", CORS_ALLOWED_ORIGINS: "https://winwidget.ru" };
const parsed = document => loadConfig({ ...base, GATEWAY_ROUTES_JSON: JSON.stringify(document) }).routes;
const billing = [
  ["billing-settings-public", "/api/v1/billing-settings/public", "http://127.0.0.1:4800", "optional", 30000],
  ["billing-settings-admin", "/api/v1/billing-settings/admin", "http://127.0.0.1:4800", "required", 30000],
];
const platformIds = new Set([
  "platform-site-settings", "platform-legal-pages", "platform-home-page-content",
]);
const platformPrefixes = [
  "/api/v1/site-settings", "/api/v1/legal-pages", "/api/v1/home-page-content",
];
if (!Array.isArray(source)) process.exit(1);
let routes;
try { routes = parsed(source); } catch { process.exit(1); }
const monolithMatches = source.filter(route => route?.id === "monolith");
if (monolithMatches.length !== 1) process.exit(1);
const monolith = monolithMatches[0];
const monolithIndex = source.indexOf(monolith);
if (monolith.pathPrefix !== "/api/v1" ||
    monolith.upstreamUrl !== "http://127.0.0.1:4200" ||
    monolith.authPolicy !== "optional" || monolith.timeoutMs !== 60000) process.exit(1);
for (const [id, pathPrefix, upstreamUrl, authPolicy, timeoutMs] of billing) {
  const matching = source.filter(route => route?.id === id);
  if (matching.length !== 1) process.exit(1);
  const route = matching[0];
  if (route.pathPrefix !== pathPrefix || route.upstreamUrl !== upstreamUrl ||
      route.authPolicy !== authPolicy || route.timeoutMs !== timeoutMs ||
      source.indexOf(route) >= monolithIndex) process.exit(1);
}
if (source.filter(route => route?.pathPrefix === "/api/v1/billing-settings" ||
    route?.pathPrefix?.startsWith("/api/v1/billing-settings/")).length !== 2) process.exit(1);
if (source.some(route => platformIds.has(route?.id) ||
    route?.upstreamUrl === "http://127.0.0.1:5000" ||
    platformPrefixes.some(prefix => route?.pathPrefix === prefix ||
      route?.pathPrefix?.startsWith(`${prefix}/`)))) process.exit(1);
const matrix = [
  ["/api/v1/site-settings", "monolith"],
  ["/api/v1/legal-pages/terms", "monolith"],
  ["/api/v1/home-page-content/admin", "monolith"],
  ["/api/v1/billing-settings/public", "billing-settings-public"],
  ["/api/v1/billing-settings/admin/private", "billing-settings-admin"],
];
if (!matrix.every(([path, id]) => matchGatewayRoute(path, routes)?.id === id)) process.exit(1);
'
}

platform_cutover_validate_exact_route_delta() {
	[[ $# -eq 1 && "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local phase_routes final_routes
	phase_routes="$(platform_read_env_value "$platform_phase_a_env_artifact" GATEWAY_ROUTES_JSON)" || return 1
	final_routes="$(platform_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON)" || return 1
	platform_database_docker run --rm --network none --read-only \
		--env "PHASE_ROUTES=$phase_routes" --env "FINAL_ROUTES=$final_routes" \
		--entrypoint node "$1" -e '
const phase = JSON.parse(process.env.PHASE_ROUTES);
const final = JSON.parse(process.env.FINAL_ROUTES);
const ids = new Set(["platform-site-settings", "platform-legal-pages", "platform-home-page-content"]);
const expected = [
  ["platform-site-settings", "/api/v1/site-settings", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-legal-pages", "/api/v1/legal-pages", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-home-page-content", "/api/v1/home-page-content", "http://127.0.0.1:5000", "optional", 60000],
];
if (!Array.isArray(phase) || !Array.isArray(final) || phase.some(route => ids.has(route?.id))) process.exit(1);
const stripped = final.filter(route => !ids.has(route?.id));
if (JSON.stringify(stripped) !== JSON.stringify(phase)) process.exit(1);
const monolith = final.findIndex(route => route?.id === "monolith");
for (const [id, pathPrefix, upstreamUrl, authPolicy, timeoutMs] of expected) {
  const matches = final.filter(route => route?.id === id);
  if (matches.length !== 1) process.exit(1);
  const route = matches[0];
  if (route.pathPrefix !== pathPrefix || route.upstreamUrl !== upstreamUrl ||
      route.authPolicy !== authPolicy || route.timeoutMs !== timeoutMs ||
      final.indexOf(route) >= monolith) process.exit(1);
}
' >/dev/null
}

platform_cutover_assert_gateway_image() {
	local image_id
	image_id="$(platform_cutover_expected_release_image_id gateway)" || return 1
	platform_cutover_assert_release_image_id gateway "$image_id"
}

platform_cutover_assert_platform_runtime() {
	[[ $# -eq 3 && "$1" =~ ^platform-(api|outbox-publisher)$ &&
		"$2" =~ ^(api|outbox-publisher)$ && "$3" =~ ^[1-9][0-9]*$ ]] || return 1
	local service="$1" purpose="$2" port="$3" container expected_image metadata
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q "$service")" || return 1
	expected_image="$(platform_cutover_marker_value image_id)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
	metadata="$(platform_database_docker inspect --format \
		'{{.Image}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}' \
		"$container")" || return 1
	[[ "$metadata" == "$expected_image|running|true|healthy|0|winwidget|$service|platform|$purpose" ]] ||
		platform_cutover_fail "Platform runtime identity failed for $service." || return 1
	curl --fail --silent --show-error "http://127.0.0.1:$port/health/ready" >/dev/null
}

platform_cutover_assert_gateway_receipt_identity() {
	local container image_id metadata env_sha
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q api-gateway)" || return 1
	image_id="$(platform_cutover_expected_release_image_id gateway)" || return 1
	platform_cutover_assert_release_image_id gateway "$image_id" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	metadata="$(platform_database_docker inspect --format \
		'{{.Image}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
		"$container")" || return 1
	[[ "$metadata" == "$image_id|running|true|healthy|0|winwidget|api-gateway" ]] ||
		platform_cutover_fail 'Gateway runtime identity failed.' || return 1
	if platform_cutover_receipt_is_present; then
		env_sha="$(platform_cutover_container_env_sha256 "$container" GATEWAY_ROUTES_JSON)" || return 1
		[[ "$env_sha" == "$(platform_cutover_billing_readiness_value gateway_non_route_env_sha256)" ]] ||
			platform_cutover_fail 'Gateway non-route env drifted from its immutable phase-A receipt.' || return 1
	fi
	printf '%s\n' "$container"
}

platform_cutover_assert_gateway_runtime() {
	local container routes
	container="$(platform_cutover_assert_gateway_receipt_identity)" || return 1
	routes="$(platform_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON)" || return 1
EXPECTED_ROUTES="$routes" platform_database_docker exec --env EXPECTED_ROUTES "$container" node -e '
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
  value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
if (canonical(JSON.parse(process.env.GATEWAY_ROUTES_JSON || "null")) !==
    canonical(JSON.parse(process.env.EXPECTED_ROUTES || "null"))) process.exit(1);
' >/dev/null || return 1
	printf '%s\n' "$container"
}

platform_cutover_container_env_value() {
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{64}$ && "$2" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 1
	platform_database_docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" |
		awk -F= -v key="$2" '
			$1 == key { print substr($0, index($0, "=") + 1); seen += 1 }
			END { exit(seen == 1 ? 0 : 1) }
		'
}

platform_cutover_assert_no_platform_runtime() {
	local service ids
	for service in platform-api platform-outbox-publisher; do
		ids="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			ps --status running -q "$service")" || return 1
		[[ -z "$ids" ]] ||
			platform_cutover_fail "Platform runtime must remain stopped during Billing readiness: $service" || return 1
	done
}

platform_cutover_assert_phase_a_runtime_from_receipt() {
	platform_cutover_validate_billing_readiness_receipt || return 1
	platform_cutover_validate_phase_a_env_artifact || return 1
	[[ "$(platform_cutover_billing_readiness_value revision)" == "$EXPECTED_REVISION" &&
		"$(platform_cutover_billing_readiness_value generation)" == 1 &&
		"$(platform_cutover_canonical_env_without_routes_sha256 "$platform_phase_a_env_artifact")" == \
			"$(platform_cutover_billing_readiness_value phase_a_env_non_route_sha256)" ]] || return 1
	local core_container core_image core_env_sha billing_container billing_image billing_env_sha
	local gateway_container gateway_image gateway_env_sha
	local metadata runtime_routes routes_sha
	platform_cutover_assert_gateway_image || return 1
	core_container="$(platform_cutover_assert_core_api_candidate)" || return 1
	core_image="$(platform_database_docker inspect --format '{{.Image}}' "$core_container")" || return 1
	core_env_sha="$(platform_cutover_container_env_sha256 "$core_container" -)" || return 1
	billing_container="$(platform_cutover_assert_billing_api_candidate)" || return 1
	billing_image="$(platform_database_docker inspect --format '{{.Image}}' "$billing_container")" || return 1
	billing_env_sha="$(platform_cutover_container_env_sha256 "$billing_container" -)" || return 1
	gateway_container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api-gateway)" || return 1
	gateway_image="$(platform_database_docker inspect --format '{{.Image}}' "$gateway_container")" || return 1
	[[ "$gateway_container" =~ ^[0-9a-f]{64}$ && "$gateway_image" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	metadata="$(platform_database_docker inspect --format \
		'{{.Image}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
		"$gateway_container")" || return 1
	[[ "$metadata" == "$gateway_image|running|true|healthy|0|winwidget|api-gateway" ]] || return 1
	runtime_routes="$(platform_cutover_container_env_value "$gateway_container" GATEWAY_ROUTES_JSON)" || return 1
	routes_sha="$(platform_cutover_text_sha256 "$runtime_routes")" || return 1
	gateway_env_sha="$(platform_cutover_container_env_sha256 "$gateway_container" GATEWAY_ROUTES_JSON)" || return 1
	[[ "$core_container" == "$(platform_cutover_billing_readiness_value core_api_container_id)" &&
		"$core_image" == "$(platform_cutover_billing_readiness_value core_api_image_id)" &&
		"$core_env_sha" == "$(platform_cutover_billing_readiness_value core_api_env_sha256)" &&
		"$billing_container" == "$(platform_cutover_billing_readiness_value billing_api_container_id)" &&
		"$billing_image" == "$(platform_cutover_billing_readiness_value billing_api_image_id)" &&
		"$billing_env_sha" == "$(platform_cutover_billing_readiness_value billing_api_env_sha256)" &&
		"$gateway_container" == "$(platform_cutover_billing_readiness_value gateway_container_id)" &&
		"$gateway_image" == "$(platform_cutover_billing_readiness_value gateway_image_id)" &&
		"$gateway_env_sha" == "$(platform_cutover_billing_readiness_value gateway_non_route_env_sha256)" &&
		"$routes_sha" == "$(platform_cutover_billing_readiness_value phase_a_routes_sha256)" ]] ||
		platform_cutover_fail 'Running Billing/Gateway readiness identity differs from its immutable receipt.' || return 1
	platform_cutover_validate_phase_a_gateway_manifest "$gateway_image" "$platform_phase_a_env_artifact" || return 1
	platform_cutover_assert_no_platform_runtime || return 1
	printf '%s\n' "$gateway_container"
}

platform_cutover_verify_phase_a_gateway_routes() {
	local path core_status gateway_status headers service_header
	for path in site-settings legal-pages legal-pages/oferta home-page-content; do
		core_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
			--max-time 10 "http://127.0.0.1:4200/api/v1/$path")" || return 1
		gateway_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
			--max-time 10 "http://127.0.0.1:4100/api/v1/$path")" || return 1
		[[ "$core_status|$gateway_status" == '404|404' ]] ||
			platform_cutover_fail "Phase-A removed Core content route is not an exact 404: $path" || return 1
		headers="$(curl --silent --show-error --dump-header - --output /dev/null \
			"http://127.0.0.1:4100/api/v1/$path" | tr -d '\r')" || return 1
		service_header="$(awk -F: 'tolower($1) == "x-winwidget-service" { value=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); print tolower(value); count += 1 } END { if (count > 1) exit 1 }' <<<"$headers")" || return 1
		[[ -z "$service_header" ]] ||
			platform_cutover_fail "Phase-A Gateway content unexpectedly identifies a service owner: $path" || return 1
	done
	local billing_direct billing_gateway billing_admin_status gateway_admin_status
	billing_direct="$(curl --fail --silent --show-error \
		http://127.0.0.1:4800/api/v1/billing-settings/public)" || return 1
	billing_gateway="$(curl --fail --silent --show-error \
		http://127.0.0.1:4100/api/v1/billing-settings/public)" || return 1
	[[ -n "$billing_direct" && "$billing_gateway" == "$billing_direct" ]] || return 1
	billing_admin_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
		--max-time 10 http://127.0.0.1:4800/api/v1/billing-settings/admin)" || return 1
	gateway_admin_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
		--max-time 10 http://127.0.0.1:4100/api/v1/billing-settings/admin)" || return 1
	[[ "$billing_admin_status" == 401 && "$gateway_admin_status" == 401 ]] ||
		platform_cutover_fail 'Phase-A direct and Gateway Billing admin settings routes are not protected.'
}

platform_cutover_phase_a_runtime_is_ready() {
	platform_cutover_assert_core_api_candidate >/dev/null || return 1
	platform_cutover_assert_billing_api_candidate >/dev/null || return 1
	platform_cutover_assert_gateway_runtime >/dev/null || return 1
	platform_cutover_assert_no_platform_runtime || return 1
	platform_cutover_verify_phase_a_gateway_routes
}

platform_cutover_assert_gateway_provenance() {
	[[ $# -eq 1 && "$1" == http://127.0.0.1:4100/api/v1/* ]] || return 1
	local headers
	headers="$(curl --fail --silent --show-error --dump-header - --output /dev/null "$1" | tr -d '\r')" || return 1
	[[ "$(awk -F: 'tolower($1) == "x-winwidget-service" { value=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); print tolower(value); count += 1 } END { if (count != 1) exit 1 }' <<<"$headers")" == platform ]]
}

platform_cutover_verify_gateway_routes() {
	local billing_direct billing_gateway billing_admin_status gateway_admin_status
	curl --fail --silent --show-error http://127.0.0.1:4100/api/v1/site-settings >/dev/null || return 1
	curl --fail --silent --show-error http://127.0.0.1:4100/api/v1/legal-pages >/dev/null || return 1
	curl --fail --silent --show-error http://127.0.0.1:4100/api/v1/legal-pages/oferta >/dev/null || return 1
	curl --fail --silent --show-error http://127.0.0.1:4100/api/v1/home-page-content >/dev/null || return 1
	platform_cutover_assert_gateway_provenance http://127.0.0.1:4100/api/v1/site-settings || return 1
	platform_cutover_assert_gateway_provenance http://127.0.0.1:4100/api/v1/legal-pages || return 1
	platform_cutover_assert_gateway_provenance http://127.0.0.1:4100/api/v1/legal-pages/oferta || return 1
	platform_cutover_assert_gateway_provenance http://127.0.0.1:4100/api/v1/home-page-content || return 1
	billing_direct="$(curl --fail --silent --show-error \
		http://127.0.0.1:4800/api/v1/billing-settings/public)" || return 1
	billing_gateway="$(curl --fail --silent --show-error \
		http://127.0.0.1:4100/api/v1/billing-settings/public)" || return 1
	[[ -n "$billing_direct" && "$billing_gateway" == "$billing_direct" ]] ||
		platform_cutover_fail 'Gateway Billing public settings route is not the exact Billing response.' || return 1
	billing_admin_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
		--max-time 10 http://127.0.0.1:4800/api/v1/billing-settings/admin)" || return 1
	gateway_admin_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
		--max-time 10 http://127.0.0.1:4100/api/v1/billing-settings/admin)" || return 1
	[[ "$billing_admin_status" == 401 && "$gateway_admin_status" == 401 ]] ||
		platform_cutover_fail 'Direct and Gateway Billing admin settings routes are not protected.'
}

platform_cutover_gateway_boundary_is_ready() {
	platform_cutover_assert_gateway_image || return 1
	platform_cutover_assert_billing_api_candidate >/dev/null || return 1
	platform_cutover_validate_gateway_manifest || return 1
	platform_cutover_assert_publisher || return 1
	platform_cutover_assert_platform_runtime platform-api api 5000 || return 1
	platform_cutover_assert_platform_runtime platform-outbox-publisher outbox-publisher 5001 || return 1
	platform_cutover_assert_gateway_runtime || return 1
	platform_cutover_verify_gateway_routes
}

platform_cutover_ensure_gateway_boundary() {
	platform_cutover_ensure_billing_api_candidate >/dev/null || return 1
	if platform_cutover_gateway_boundary_is_ready >/dev/null 2>&1; then
		return
	fi
	platform_cutover_provision_publisher || return 1
	platform_cutover_compose_with_receipt_images \
		up -d --no-deps --force-recreate platform-api platform-outbox-publisher api-gateway || return 1
	for _ in {1..60}; do
		if platform_cutover_gateway_boundary_is_ready >/dev/null 2>&1; then
			return
		fi
		sleep 2
	done
	platform_cutover_fail 'Platform and Gateway candidate runtimes did not become ready.'
}
	platform_cutover_provision_publisher() {
	local container url username password vhost protocol hostname port permissions exchange user_row
	local topic_permissions vhosts other_vhost
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)"
	[[ "$container" =~ ^[0-9a-f]{64}$ &&
		"$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" == healthy ]] ||
		platform_cutover_fail 'RabbitMQ is not healthy.' || return 1
	url=RABBITMQ_PLATFORM_PUBLISHER_URL
	username="$(platform_database_url_field "$url" username)"
	password="$(platform_database_url_field "$url" password)"
	vhost="$(platform_database_url_field "$url" database)"
	protocol="$(platform_database_url_field "$url" protocol)"
	hostname="$(platform_database_url_field "$url" hostname)"
	port="$(platform_database_url_field "$url" port)"
	[[ "$protocol" == amqp: && "$hostname" == 127.0.0.1 && "$port" == 5672 &&
		"$vhost" == winwidget && "$vhost" == "$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" &&
		"$username" == winwidget-platform-publisher && ${#password} -ge 32 ]] ||
		platform_cutover_fail 'Platform RabbitMQ publisher URL identity is invalid.' || return 1
	if platform_database_docker exec "$container" rabbitmqctl list_users --silent | awk '{print $1}' | grep -Fxq "$username"; then
		platform_cutover_rabbitmq_password_command "$container" change_password "$username" "$password" >/dev/null
	else
		platform_cutover_rabbitmq_password_command "$container" add_user "$username" "$password" >/dev/null
	fi
	vhosts="$(platform_database_docker exec "$container" rabbitmqctl --silent list_vhosts name)" || return 1
	while IFS= read -r other_vhost; do
		[[ -n "$other_vhost" ]] || continue
		if [[ "$other_vhost" != "$vhost" ]]; then
			platform_database_docker exec "$container" rabbitmqctl clear_permissions \
				-p "$other_vhost" "$username" >/dev/null 2>&1 || true
			platform_database_docker exec "$container" rabbitmqctl clear_topic_permissions \
				-p "$other_vhost" "$username" >/dev/null 2>&1 || true
		fi
	done <<<"$vhosts"
	platform_database_docker exec "$container" rabbitmqctl clear_permissions -p "$vhost" "$username" >/dev/null 2>&1 || true
	platform_database_docker exec "$container" rabbitmqctl set_permissions -p "$vhost" "$username" \
		'^$' '^winwidget\.events$' '^$' >/dev/null
	platform_database_docker exec "$container" rabbitmqctl clear_topic_permissions \
		-p "$vhost" "$username" >/dev/null 2>&1 || true
	platform_database_docker exec "$container" rabbitmqctl set_topic_permissions -p "$vhost" "$username" \
		winwidget.events "$PLATFORM_PUBLISHER_TOPIC_WRITE" '^$' >/dev/null
	platform_database_docker exec "$container" rabbitmqctl set_user_tags "$username" >/dev/null
	platform_cutover_rabbitmq_password_command "$container" authenticate_user "$username" "$password" >/dev/null || return 1
	permissions="$(platform_database_docker exec "$container" rabbitmqctl --silent \
		list_user_permissions "$username" | awk 'NF == 4 { print $1 "|" $2 "|" $3 "|" $4 }')" || return 1
	topic_permissions="$(platform_database_docker exec "$container" rabbitmqctl --silent \
		list_user_topic_permissions "$username" | awk 'NF == 4 { print $1 "|" $2 "|" $3 "|" $4 }')" || return 1
	user_row="$(platform_database_docker exec "$container" rabbitmqctl --silent list_users | \
		awk -v user="$username" '$1 == user { print; count += 1 } END { if (count != 1) exit 1 }')" || return 1
	exchange="$(platform_database_docker exec "$container" rabbitmqctl --silent list_exchanges -p "$vhost" \
		name type durable auto_delete internal | \
		awk '$1 == "winwidget.events" { print $1 "|" $2 "|" $3 "|" $4 "|" $5; count += 1 } END { if (count != 1) exit 1 }')" || return 1
	unset password
	[[ "$permissions" == "$vhost|^$|^winwidget\.events$|^$" &&
		"$topic_permissions" == "$vhost|winwidget.events|$PLATFORM_PUBLISHER_TOPIC_WRITE|^$" &&
		"$user_row" == "$username"*'[]'* &&
		"$exchange" == 'winwidget.events|topic|true|false|false' ]] ||
		platform_cutover_fail 'Platform RabbitMQ publisher permissions or exchange are not exact.'
}

platform_cutover_assert_publisher() {
	local container url username password vhost protocol hostname port permissions exchange user_row topic_permissions
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q rabbitmq)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ &&
		"$(platform_database_docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" == healthy ]] ||
		platform_cutover_fail 'RabbitMQ is not healthy.' || return 1
	url=RABBITMQ_PLATFORM_PUBLISHER_URL
	username="$(platform_database_url_field "$url" username)" || return 1
	password="$(platform_database_url_field "$url" password)" || return 1
	vhost="$(platform_database_url_field "$url" database)" || return 1
	protocol="$(platform_database_url_field "$url" protocol)" || return 1
	hostname="$(platform_database_url_field "$url" hostname)" || return 1
	port="$(platform_database_url_field "$url" port)" || return 1
	[[ "$protocol" == amqp: && "$hostname" == 127.0.0.1 && "$port" == 5672 &&
		"$vhost" == winwidget && "$vhost" == "$(platform_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" &&
		"$username" == winwidget-platform-publisher && ${#password} -ge 32 ]] ||
		platform_cutover_fail 'Platform RabbitMQ publisher URL identity is invalid.' || return 1
	platform_cutover_rabbitmq_password_command "$container" authenticate_user "$username" "$password" >/dev/null || return 1
	permissions="$(platform_database_docker exec "$container" rabbitmqctl --silent \
		list_user_permissions "$username" | awk 'NF == 4 { print $1 "|" $2 "|" $3 "|" $4 }')" || return 1
	topic_permissions="$(platform_database_docker exec "$container" rabbitmqctl --silent \
		list_user_topic_permissions "$username" | awk 'NF == 4 { print $1 "|" $2 "|" $3 "|" $4 }')" || return 1
	user_row="$(platform_database_docker exec "$container" rabbitmqctl --silent list_users | \
		awk -v user="$username" '$1 == user { print; count += 1 } END { if (count != 1) exit 1 }')" || return 1
	exchange="$(platform_database_docker exec "$container" rabbitmqctl --silent list_exchanges -p "$vhost" \
		name type durable auto_delete internal | \
		awk '$1 == "winwidget.events" { print $1 "|" $2 "|" $3 "|" $4 "|" $5; count += 1 } END { if (count != 1) exit 1 }')" || return 1
	unset password
	[[ "$permissions" == "$vhost|^$|^winwidget\.events$|^$" &&
		"$topic_permissions" == "$vhost|winwidget.events|$PLATFORM_PUBLISHER_TOPIC_WRITE|^$" &&
		"$user_row" == "$username"*'[]'* &&
		"$exchange" == 'winwidget.events|topic|true|false|false' ]] ||
		platform_cutover_fail 'Platform RabbitMQ publisher permissions or exchange are not exact.'
}

platform_cutover_verify_runtime_and_routes() {
	local core_container
	platform_cutover_verify_billing_offer_v2_boundary || return 1
	platform_cutover_assert_publisher || return 1
	platform_cutover_assert_platform_runtime platform-api api 5000 || return 1
	platform_cutover_assert_platform_runtime platform-outbox-publisher outbox-publisher 5001 || return 1
	platform_cutover_assert_gateway_runtime || return 1
	platform_cutover_verify_gateway_routes || return 1
	platform_cutover_assert_integration_worker_candidate || return 1
	platform_cutover_settings_projection_topology_is_absent || return 1
	core_container="$(platform_cutover_assert_core_api_candidate)" || return 1
	platform_cutover_assert_core_routes retired "$core_container" || return 1
	platform_cutover_cli target verify >/dev/null || return 1
	platform_cutover_cli core status >/dev/null
}

platform_cutover_verify_complete_noop() {
	[[ "$(platform_cutover_current_phase)" == complete &&
		"$(platform_database_current_phase)" == complete ]] ||
		platform_cutover_fail 'Platform COMPLETE verification requires both durable markers to be complete.' || return 1
	platform_cutover_revalidate_phase complete || return 1
	platform_cutover_assert_gateway_image || return 1
	platform_cutover_validate_gateway_manifest || return 1
	platform_cutover_verify_runtime_and_routes
}

platform_cutover_prepare_billing_readiness() {
	local database_phase cutover_phase routes routes_sha env_non_route_sha gateway_image
	local core_container core_image core_env_sha billing_container billing_image billing_env_sha
	local gateway_container gateway_env_sha
	platform_cutover_require_root
	acquire_production_deploy_lock 'Platform Billing settings readiness'
	[[ "${PLATFORM_CONFIRMATION:-}" == 'PREPARE PLATFORM BILLING READINESS' ]] ||
		platform_cutover_fail 'Platform Billing readiness requires exact confirmation.' || return 1
	platform_cutover_require_billing_readiness_inputs || return 1
	platform_cutover_require_expected_env_sha || return 1
	platform_cutover_require_frontend_attestation_inputs || return 1
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
	database_phase="$(platform_database_current_phase)" || return 1
	cutover_phase="$(platform_cutover_current_phase)" || return 1
	[[ "$database_phase" == absent && "$cutover_phase" == absent ]] ||
		platform_cutover_fail 'Billing readiness is only available before Platform database/ownership preparation.' || return 1
	if [[ -d "$platform_evidence_parent" ]] &&
		[[ -n "$(find "$platform_evidence_parent" -mindepth 1 -maxdepth 1 \
			-name "platform-$EXPECTED_REVISION-generation-*" -print -quit)" ]]; then
		platform_cutover_fail 'Generation-scoped Platform evidence exists before Billing readiness.'
		return 1
	fi
	routes="$(platform_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON)" || return 1
	routes_sha="$(platform_cutover_text_sha256 "$routes")" || return 1
	if [[ -e "$platform_billing_readiness_receipt" || -L "$platform_billing_readiness_receipt" ]]; then
		platform_cutover_validate_billing_readiness_receipt || return 1
		platform_cutover_validate_phase_a_env_artifact || return 1
		if [[ -e "$platform_phase_a_intent" || -L "$platform_phase_a_intent" ]]; then
			platform_cutover_assert_phase_a_intent_matches \
				"$PLATFORM_ENV_EXPECTED_SHA256" "$routes_sha" || return 1
		fi
		platform_cutover_bind_database_url_parser_image || return 1
		[[ "$(platform_cutover_billing_readiness_value revision)" == "$EXPECTED_REVISION" &&
			"$(platform_cutover_billing_readiness_value phase_a_env_sha256)" == "$PLATFORM_ENV_EXPECTED_SHA256" &&
			"$(platform_cutover_billing_readiness_value phase_a_routes_sha256)" == "$routes_sha" ]] ||
			platform_cutover_fail 'Existing Billing readiness receipt belongs to another revision or phase-A env.' || return 1
		gateway_image="$(platform_cutover_billing_readiness_value gateway_image_id)" || return 1
		platform_cutover_validate_phase_a_gateway_manifest "$gateway_image" "$platform_phase_a_env_artifact" || return 1
		platform_cutover_assert_phase_a_runtime_from_receipt >/dev/null || return 1
		platform_cutover_verify_phase_a_gateway_routes || return 1
		platform_cutover_validate_frontend_attestation \
			"$(platform_cutover_billing_readiness_value generation)" || return 1
		platform_cutover_finalize_phase_a_intent || return 1
		printf 'platform_billing_readiness=ready\n'
		printf 'platform_billing_readiness_revision=%s\n' "$EXPECTED_REVISION"
		printf 'platform_billing_readiness_env_sha256=%s\n' "$PLATFORM_ENV_EXPECTED_SHA256"
		return
	fi
	if [[ -e "$platform_phase_a_intent" || -L "$platform_phase_a_intent" ]]; then
		platform_cutover_assert_phase_a_intent_matches \
			"$PLATFORM_ENV_EXPECTED_SHA256" "$routes_sha" || return 1
	else
		[[ ! -e "$platform_phase_a_env_artifact" && ! -L "$platform_phase_a_env_artifact" ]] ||
			platform_cutover_fail 'Orphan phase-A env artifact exists without a durable preparing intent.' || return 1
		platform_cutover_write_phase_a_intent \
			"$PLATFORM_ENV_EXPECTED_SHA256" "$routes_sha" || return 1
	fi
	platform_cutover_install_phase_a_env_artifact || return 1
	platform_cutover_validate_phase_a_env_against_intent || return 1
	env_non_route_sha="$(platform_cutover_canonical_env_without_routes_sha256 "$platform_phase_a_env_artifact")" || return 1
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		build --pull --provenance=false api billing-api api-gateway || return 1
	platform_cutover_assert_core_image || return 1
	platform_cutover_assert_billing_worker_image || return 1
	platform_cutover_assert_gateway_image || return 1
	platform_cutover_assert_core_migration_ledger before || return 1
	gateway_image="$(platform_database_docker image inspect --format '{{.Id}}' \
		"winwidget-api-gateway:git-$EXPECTED_REVISION")" || return 1
	platform_cutover_validate_phase_a_gateway_manifest "$gateway_image" "$platform_phase_a_env_artifact" || return 1
	platform_cutover_validate_frontend_attestation 1 || return 1
	if ! platform_cutover_phase_a_runtime_is_ready >/dev/null 2>&1; then
		platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --force-recreate api billing-api api-gateway || return 1
		for _ in {1..60}; do
			if platform_cutover_phase_a_runtime_is_ready >/dev/null 2>&1; then
				break
			fi
			sleep 2
		done
	fi
	platform_cutover_phase_a_runtime_is_ready || return 1
	core_container="$(platform_cutover_assert_core_api_candidate)" || return 1
	core_image="$(platform_database_docker image inspect --format '{{.Id}}' \
		"winwidget-api:git-$EXPECTED_REVISION")" || return 1
	core_env_sha="$(platform_cutover_container_env_sha256 "$core_container" -)" || return 1
	billing_container="$(platform_cutover_assert_billing_api_candidate)" || return 1
	billing_image="$(platform_database_docker image inspect --format '{{.Id}}' \
		"winwidget-billing:git-$EXPECTED_REVISION")" || return 1
	billing_env_sha="$(platform_cutover_container_env_sha256 "$billing_container" -)" || return 1
	gateway_container="$(platform_cutover_assert_gateway_runtime)" || return 1
	gateway_env_sha="$(platform_cutover_container_env_sha256 "$gateway_container" GATEWAY_ROUTES_JSON)" || return 1
	platform_cutover_validate_frontend_attestation 1 || return 1
	platform_cutover_write_billing_readiness_receipt \
		"$PLATFORM_ENV_EXPECTED_SHA256" "$env_non_route_sha" "$routes_sha" \
		"$core_container" "$core_image" "$core_env_sha" \
		"$billing_container" "$billing_image" "$billing_env_sha" \
		"$gateway_container" "$gateway_image" "$gateway_env_sha" || return 1
	platform_cutover_finalize_phase_a_intent || return 1
	printf 'platform_billing_readiness=ready\n'
	printf 'platform_billing_readiness_revision=%s\n' "$EXPECTED_REVISION"
	printf 'platform_billing_readiness_env_sha256=%s\n' "$PLATFORM_ENV_EXPECTED_SHA256"
}

platform_cutover_validate_final_env_and_attestation() {
	platform_cutover_require_expected_env_sha || return 1
	platform_cutover_validate_billing_readiness_receipt || return 1
	platform_cutover_validate_phase_a_env_artifact || return 1
	platform_cutover_require_frontend_attestation_inputs || return 1
	[[ "$(platform_cutover_billing_readiness_value revision)" == "$EXPECTED_REVISION" &&
		"$(platform_cutover_billing_readiness_value generation)" == 1 &&
		"$(platform_cutover_billing_readiness_value phase_a_env_sha256)" != "$PLATFORM_ENV_EXPECTED_SHA256" &&
		"$(platform_cutover_canonical_env_without_routes_sha256 "$ENV_FILE")" == \
			"$(platform_cutover_billing_readiness_value phase_a_env_non_route_sha256)" ]] ||
		platform_cutover_fail 'Final env is not distinct from the revision-bound phase-A readiness env.' || return 1
	platform_cutover_validate_gateway_manifest \
		"$(platform_cutover_billing_readiness_value gateway_image_id)" || return 1
	platform_cutover_validate_exact_route_delta \
		"$(platform_cutover_billing_readiness_value gateway_image_id)" || return 1
	platform_cutover_assert_core_api_candidate >/dev/null || return 1
	platform_cutover_assert_billing_api_candidate >/dev/null || return 1
	platform_cutover_validate_frontend_attestation \
		"$(platform_cutover_billing_readiness_value generation)"
}

platform_cutover_preflight_final_env_and_phase_a() {
	platform_cutover_validate_final_env_and_attestation || return 1
	platform_cutover_assert_phase_a_runtime_from_receipt >/dev/null || return 1
	platform_cutover_verify_phase_a_gateway_routes || return 1
	platform_cutover_finalize_phase_a_intent
}

platform_cutover_run_core_migration() {
	[[ $# -eq 1 && "$1" =~ ^(initial|structure)$ ]] || return 1
	local catalog_mode="$1" core_image_id ledger_state
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
	assert_core_database_production_boundary || return 1
	core_image_id="$(platform_cutover_expected_release_image_id core)" || return 1
	platform_cutover_assert_release_image_id core "$core_image_id" ||
		platform_cutover_fail 'Platform Core migration image identity verification failed.' || return 1
	platform_cutover_bind_database_url_parser_image || return 1
	ledger_state="$(platform_cutover_core_migration_ledger_state)" || return 1
	case "$ledger_state" in
	before)
		[[ "$catalog_mode" == initial ]] || return 1
		platform_cutover_compose_with_receipt_images \
			--profile migration run --rm --no-deps migrate || return 1
		;;
	after) ;;
	*) return 1 ;;
	esac
	platform_cutover_assert_core_migration_ledger after || return 1
	platform_cutover_assert_core_post_migration_catalog "$catalog_mode" || return 1
	printf 'platform_core_migration_revision=%s\n' "$EXPECTED_REVISION"
}

platform_cutover_prepare() {
	local phase database_phase catalog_mode image_id database_id system_id directory
	platform_cutover_require_root
	acquire_production_deploy_lock 'Platform ownership prepare'
	[[ "${PLATFORM_CONFIRMATION:-}" == 'PREPARE PLATFORM OWNERSHIP' ]] ||
		platform_cutover_fail 'Platform ownership prepare requires exact confirmation.' || return 1
	platform_cutover_bind_database_url_parser_image || return 1
	phase="$(platform_cutover_current_phase)" || return 1
	[[ "$phase" != aborted ]] ||
		platform_cutover_fail 'Aborted Platform attempts cannot be rebound without a separately authorized recovery contract.' || return 1
	platform_database_require_inputs || return 1
	database_phase="$(platform_database_current_phase)" || return 1
	case "$phase:$database_phase" in
	absent:absent | absent:prepared) catalog_mode=initial ;;
	prepared:prepared) catalog_mode=structure ;;
	*) platform_cutover_fail "Platform prepare pre-state is inconsistent: $phase:$database_phase."; return 1 ;;
	esac
	platform_cutover_preflight_final_env_and_phase_a || return 1
	platform_cutover_run_core_migration "$catalog_mode" || return 1
	if [[ "$phase" == prepared ]]; then
		platform_cutover_cli core preflight --revision "$EXPECTED_REVISION" >/dev/null || return 1
	fi
	platform_cutover_validate_frontend_attestation \
		"$(platform_cutover_billing_readiness_value generation)" || return 1
	platform_database_prepare
	platform_cutover_require_inputs
	phase="$(platform_cutover_current_phase)"
	case "$phase" in absent | prepared) ;; *)
		platform_cutover_fail "Platform prepare is unavailable from phase=$phase."; return 1 ;; esac
	image_id="$(platform_database_marker_value image_id)"
	database_id="$(platform_database_marker_value database_id)"
	system_id="$(platform_database_marker_value database_system_identifier)"
	directory="$(platform_cutover_prepare_evidence_dir)"
	if [[ "$phase" == absent && -n "$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
		platform_cutover_fail 'Platform evidence directory is not empty for a new lifecycle attempt.'
		return 1
	fi
	platform_cutover_assert_core_image || return 1
	platform_cutover_assert_billing_worker_image || return 1
	platform_cutover_assert_gateway_image || return 1
	platform_cutover_validate_gateway_manifest || return 1
	if [[ "$phase" == absent ]]; then
		platform_cutover_write_marker prepared "$EXPECTED_REVISION" \
			"$(platform_database_marker_value generation)" "$image_id" \
			"$database_id" "$system_id" pending pending pending pending \
			pending pending pending
	fi
	platform_cutover_validate_frontend_attestation \
		"$(platform_cutover_billing_readiness_value generation)" || return 1
	platform_cutover_cli target validate-shadow >/dev/null
	platform_cutover_cli core preflight --revision "$EXPECTED_REVISION" >/dev/null
	platform_cutover_cli core prepare --revision "$EXPECTED_REVISION" >/dev/null
	printf 'platform_cutover_phase=prepared\n'
	printf 'platform_cutover_evidence_directory=%s\n' "$directory"
}

platform_cutover_validate_restore_evidence() {
	[[ $# -eq 4 && "$2" =~ ^(imported|active)$ && "$4" =~ ^[0-9a-f]{64}$ ]] || return 1
	local evidence="$1" phase="$2" dump="$3" dump_sha="$4"
	local image_id migration_checksum dump_size
	platform_cutover_validate_private_file "$evidence" || return 1
	platform_cutover_validate_private_file "$dump" || return 1
	[[ "$(platform_cutover_sha256 "$dump")" == "$dump_sha" ]] || return 1
	image_id="$(platform_cutover_marker_value image_id)" || return 1
	migration_checksum="$(platform_cutover_sha256 \
		"$SERVER_ROOT/apps/platform/prisma/migrations/20260823000000_init_platform/migration.sql")" || return 1
	dump_size="$(wc -c <"$dump" | tr -d '[:space:]')"
	EVIDENCE_PHASE="$phase" EVIDENCE_REVISION="$EXPECTED_REVISION" \
		EVIDENCE_DUMP_SHA="$dump_sha" EVIDENCE_DUMP_SIZE="$dump_size" \
		EVIDENCE_DATABASE_ID="$(platform_cutover_marker_value database_id)" \
		EVIDENCE_SOURCE_SYSTEM="$(platform_cutover_marker_value database_system_identifier)" \
		EVIDENCE_MIGRATION_CHECKSUM="$migration_checksum" \
		platform_database_docker run --rm --pull never --network none --read-only \
			--cap-drop ALL --security-opt no-new-privileges --pids-limit 64 \
			--mount "type=bind,source=$evidence,target=/evidence.json,readonly" \
			--env EVIDENCE_PHASE --env EVIDENCE_REVISION --env EVIDENCE_DUMP_SHA \
			--env EVIDENCE_DUMP_SIZE --env EVIDENCE_DATABASE_ID \
			--env EVIDENCE_SOURCE_SYSTEM --env EVIDENCE_MIGRATION_CHECKSUM \
			--entrypoint node "$image_id" -e '
const fs = require("node:fs");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const positiveString = value => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const timestamp = value => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
let value;
try { value = JSON.parse(fs.readFileSync("/evidence.json", "utf8")); }
catch { process.exit(1); }
const checkKeys = [
  "immutableRevision", "dumpShaStable", "isolatedTarget", "noHostPorts",
  "distinctCluster", "ownershipAnchors", "positiveSourceHighWatermark",
  "currentSemanticFingerprint", "legitimateMutationRefreshAtomic",
  "unrefreshedMutationDetectedByRecompute", "outboxEmpty",
  "migrationChecksumExact", "catalogExact", "repeatDumpReadable",
  "resourcesRemovedBeforeEvidence", "canonicalArtifactPaths",
  "privateArtifactOwnership", "noSymlinkArtifacts", "fileAndParentFsync",
];
if (!exact(value, ["schemaVersion", "action", "target", "status", "phase", "revision",
    "postgresMajor", "dump", "identity", "catalog", "counts", "checks", "completedAt"]) ||
  value.schemaVersion !== 1 || value.action !== "platform-actual-backup-restore-rehearsal" ||
  value.target !== "platform" || value.status !== "passed" || value.postgresMajor !== 18 ||
  value.phase !== process.env.EVIDENCE_PHASE || value.revision !== process.env.EVIDENCE_REVISION ||
  !timestamp(value.completedAt) ||
  !exact(value.dump, ["sha256", "sizeBytes"]) ||
  value.dump.sha256 !== process.env.EVIDENCE_DUMP_SHA ||
  String(value.dump.sizeBytes) !== process.env.EVIDENCE_DUMP_SIZE || !positive(value.dump.sizeBytes) ||
  !exact(value.identity, ["databaseId", "sourceSystemIdentifier", "restoredSystemIdentifier"]) ||
  value.identity.databaseId !== process.env.EVIDENCE_DATABASE_ID ||
  value.identity.sourceSystemIdentifier !== process.env.EVIDENCE_SOURCE_SYSTEM ||
  !positiveString(value.identity.restoredSystemIdentifier) ||
  value.identity.restoredSystemIdentifier === process.env.EVIDENCE_SOURCE_SYSTEM ||
  !exact(value.catalog, ["migrationChecksum", "catalogSha256", "repeatArchiveListSha256"]) ||
  value.catalog.migrationChecksum !== process.env.EVIDENCE_MIGRATION_CHECKSUM ||
  !sha(value.catalog.catalogSha256) || !sha(value.catalog.repeatArchiveListSha256) ||
  !exact(value.counts, ["tables", "migrations", "siteSettings", "legalPages",
    "homePageContent", "outboxEvents"]) || value.counts.tables !== 8 ||
  value.counts.migrations !== 1 || value.counts.siteSettings !== 1 ||
  value.counts.legalPages !== 4 || value.counts.homePageContent !== 1 ||
  value.counts.outboxEvents !== 0 || !exact(value.checks, checkKeys) ||
  !checkKeys.every(key => value.checks[key] === true)) process.exit(1);
' >/dev/null
}

platform_cutover_run_restore() {
	[[ $# -eq 5 && "$5" =~ ^(pending|[0-9a-f]{64})$ ]] || return 1
	local phase="$1" dump="$2" sha="$3" evidence="$4" expected_evidence_sha="$5"
	local script="$SERVER_ROOT/scripts/platform-backup-restore-rehearsal.sh" evidence_sha
	if [[ -e "$evidence" || -L "$evidence" ]]; then
		platform_cutover_validate_restore_evidence "$evidence" "$phase" "$dump" "$sha" ||
			platform_cutover_fail 'Existing Platform restore evidence is invalid.' || return 1
		evidence_sha="$(platform_cutover_sha256 "$evidence")" || return 1
		[[ "$expected_evidence_sha" == pending || "$evidence_sha" == "$expected_evidence_sha" ]] ||
			platform_cutover_fail 'Existing Platform restore evidence has another SHA-256.' || return 1
		printf '%s\n' "$evidence_sha"
		return
	fi
	[[ "$expected_evidence_sha" == pending ]] ||
		platform_cutover_fail 'Bound Platform restore evidence is missing.' || return 1
	[[ -x "$script" && ! -L "$script" ]] || return 1
	bash "$script" --revision "$EXPECTED_REVISION" --phase "$phase" \
		--dump "$dump" --expected-sha256 "$sha" \
		--database-id "$(platform_cutover_marker_value database_id)" \
		--source-system-identifier "$(platform_cutover_marker_value database_system_identifier)" \
		--evidence-file "$evidence" \
		--node-image-id "$(platform_cutover_marker_value image_id)" >/dev/null
	platform_cutover_validate_restore_evidence "$evidence" "$phase" "$dump" "$sha" || return 1
	evidence_sha="$(platform_cutover_sha256 "$evidence")" || return 1
	[[ "$evidence_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s\n' "$evidence_sha"
}

platform_cutover_require_bound_file_sha() {
	[[ $# -eq 2 && "$2" =~ ^[0-9a-f]{64}$ ]] || return 1
	platform_cutover_validate_private_file "$1" || return 1
	[[ "$(platform_cutover_sha256 "$1")" == "$2" ]] ||
		platform_cutover_fail 'Platform lifecycle artifact SHA-256 changed after it was bound.'
}

platform_cutover_revalidate_snapshot_and_anchors() {
	local directory snapshot snapshot_sha
	directory="$(platform_cutover_evidence_dir)" || return 1
	snapshot="$directory/platform-snapshot.json"
	snapshot_sha="$(platform_cutover_marker_value snapshot_sha256)" || return 1
	platform_cutover_require_bound_file_sha "$snapshot" "$snapshot_sha" || return 1
	[[ "$(platform_cutover_snapshot_field sourceFingerprint)" == \
		"$(platform_cutover_marker_value source_fingerprint)" &&
		"$(platform_cutover_snapshot_field platformHighWater)" == \
		"$(platform_cutover_marker_value source_high_watermark)" ]] ||
		platform_cutover_fail 'Platform snapshot anchors changed after they were bound.' || return 1
	platform_cutover_cli target preflight --file /evidence/platform-snapshot.json \
		--sha256 "$snapshot_sha" >/dev/null
}

platform_cutover_revalidate_restore_binding() {
	[[ $# -eq 5 && "$1" =~ ^(imported|active)$ ]] || return 1
	local phase="$1" dump="$2" dump_sha="$3" evidence="$4" evidence_sha="$5"
	if [[ "$dump_sha" == pending ]]; then
		if [[ -e "$dump" || -L "$dump" ]]; then
			platform_cutover_validate_private_file "$dump" || return 1
			[[ "$(head -c 5 "$dump")" == PGDMP ]] || return 1
		elif [[ -e "$evidence" || -L "$evidence" ]]; then
			platform_cutover_fail 'Unbound Platform restore evidence exists without its dump.'
			return 1
		fi
		if [[ -e "$evidence" || -L "$evidence" ]]; then
			platform_cutover_validate_restore_evidence "$evidence" "$phase" "$dump" \
				"$(platform_cutover_sha256 "$dump")" || return 1
		fi
		return 0
	fi
	platform_cutover_require_bound_file_sha "$dump" "$dump_sha" || return 1
	if [[ -e "$evidence" || -L "$evidence" ]]; then
		platform_cutover_validate_restore_evidence "$evidence" "$phase" "$dump" "$dump_sha" || return 1
		if [[ "$evidence_sha" != pending ]]; then
			platform_cutover_require_bound_file_sha "$evidence" "$evidence_sha" || return 1
		fi
	else
		[[ "$evidence_sha" == pending ]] ||
			platform_cutover_fail 'Bound Platform restore evidence disappeared.' || return 1
	fi
}

platform_cutover_revalidate_phase() {
	[[ $# -eq 1 ]] || return 1
	local phase="$1" directory
	platform_cutover_status >/dev/null || return 1
	case "$phase" in
	prepared) return ;;
	source-fenced | imported | restore-verified | target-active | consumer-v2 | core-active | complete)
		platform_cutover_revalidate_snapshot_and_anchors || return 1
		;;
	*) return 1 ;;
	esac
	directory="$(platform_cutover_evidence_dir)" || return 1
	case "$phase" in
	imported | restore-verified | target-active | consumer-v2 | core-active | complete)
		platform_cutover_revalidate_restore_binding imported \
			"$directory/platform-imported.dump" \
			"$(platform_cutover_marker_value imported_backup_sha256)" \
			"$directory/platform-imported-restore.json" \
			"$(platform_cutover_marker_value imported_restore_evidence_sha256)" || return 1
		;;
	esac
	case "$phase" in
	core-active | complete)
		platform_cutover_revalidate_restore_binding active \
			"$directory/platform-active.dump" \
			"$(platform_cutover_marker_value active_backup_sha256)" \
			"$directory/platform-active-restore.json" \
			"$(platform_cutover_marker_value active_restore_evidence_sha256)" || return 1
		;;
	esac
}

platform_cutover_advance_target_active() {
	platform_cutover_revalidate_phase target-active || return 1
	platform_cutover_validate_frontend_attestation \
		"$(platform_cutover_marker_value generation)" || return 1
	platform_cutover_ensure_gateway_boundary || return 1
	platform_cutover_retire_settings_projection hold-billing || return 1
	platform_cutover_switch_billing_offer_consumer_v2 || return 1
	platform_cutover_rewrite_phase consumer-v2
}

platform_cutover_advance_consumer_v2() {
	local core_container core_state
	platform_cutover_revalidate_phase consumer-v2 || return 1
	platform_cutover_ensure_gateway_boundary || return 1
	platform_cutover_retire_settings_projection || return 1
	core_container="$(platform_cutover_ensure_core_api_candidate)" || return 1
	if platform_cutover_assert_core_routes fenced "$core_container" >/dev/null 2>&1; then
		core_state=fenced
	elif platform_cutover_assert_core_routes retired "$core_container" >/dev/null 2>&1; then
		core_state=retired
	else
		platform_cutover_fail 'Core candidate is neither exactly frozen nor exactly active.'
		return 1
	fi
	platform_cutover_verify_billing_offer_v2_boundary || return 1
	platform_cutover_validate_frontend_attestation \
		"$(platform_cutover_marker_value generation)" || return 1
	platform_cutover_cli core activate --revision "$EXPECTED_REVISION" \
		--file /evidence/platform-snapshot.json \
		--sha256 "$(platform_cutover_marker_value snapshot_sha256)" \
		--fingerprint "$(platform_cutover_marker_value source_fingerprint)" \
		--high-watermark "$(platform_cutover_marker_value source_high_watermark)" >/dev/null || return 1
	platform_cutover_assert_core_routes retired "$core_container" || return 1
	platform_cutover_gateway_boundary_is_ready || return 1
	[[ "$core_state" =~ ^(fenced|retired)$ ]] || return 1
	platform_cutover_rewrite_phase core-active
}

platform_cutover_continue() {
	platform_cutover_require_root
	acquire_production_deploy_lock 'Platform ownership cutover'
	platform_cutover_bind_database_url_parser_image || return 1
	platform_cutover_require_inputs
	local phase directory snapshot imported_dump active_dump
	local imported_sha imported_restore_sha active_sha active_restore_sha
	local snapshot_sha fingerprint highwater core_container
	phase="$(platform_cutover_current_phase)"
	case "$phase" in prepared | source-fenced | imported | restore-verified | target-active | consumer-v2 | core-active | complete) ;; *)
		platform_cutover_fail "Platform cutover cannot continue from phase=$phase."; return 1 ;; esac
	if [[ "$phase" == complete ]]; then
		platform_cutover_verify_complete_noop || return 1
		platform_cutover_finalize_phase_a_artifacts || return 1
		printf 'platform_cutover_phase=complete\n'
		printf 'platform_cutover_revision=%s\n' "$EXPECTED_REVISION"
		return
	fi
	case "$phase" in
	prepared | source-fenced | imported | restore-verified)
		platform_cutover_preflight_final_env_and_phase_a || return 1
		;;
	target-active | consumer-v2 | core-active)
		platform_cutover_validate_final_env_and_attestation || return 1
		;;
	esac
	platform_cutover_assert_gateway_image
	platform_cutover_validate_gateway_manifest
	directory="$(platform_cutover_prepare_evidence_dir)"
	snapshot="$directory/platform-snapshot.json"
	imported_dump="$directory/platform-imported.dump"
	active_dump="$directory/platform-active.dump"
	if [[ "$phase" == prepared ]]; then
		platform_cutover_revalidate_phase "$phase"
		core_container="$(platform_cutover_ensure_core_api_candidate)" || return 1
		platform_cutover_assert_core_routes removed "$core_container" || return 1
		platform_cutover_cli target validate-shadow >/dev/null
		platform_cutover_assert_core_database_urls_match
		platform_cutover_validate_frontend_attestation \
			"$(platform_cutover_marker_value generation)" || return 1
		platform_cutover_cli core fence --revision "$EXPECTED_REVISION" >/dev/null
		platform_cutover_assert_core_routes fenced "$core_container" || return 1
		platform_cutover_wait_billing_offer_boundary
		platform_cutover_cli core export --revision "$EXPECTED_REVISION" \
			--file /evidence/platform-snapshot.json >/dev/null
		platform_cutover_validate_private_file "$snapshot"
		sync -f "$snapshot"
		sync -f "$directory"
		snapshot_sha="$(platform_cutover_sha256 "$snapshot")"
		fingerprint="$(platform_cutover_snapshot_field sourceFingerprint)"
		highwater="$(platform_cutover_snapshot_field platformHighWater)"
		platform_cutover_write_marker source-fenced "$EXPECTED_REVISION" \
			"$(platform_cutover_marker_value generation)" \
			"$(platform_cutover_marker_value image_id)" \
			"$(platform_cutover_marker_value database_id)" \
			"$(platform_cutover_marker_value database_system_identifier)" \
			"$snapshot_sha" "$fingerprint" "$highwater" \
			pending pending pending pending
		phase='source-fenced'
	fi
	if [[ "$phase" == source-fenced ]]; then
		platform_cutover_revalidate_phase "$phase"
		platform_cutover_cli target preflight --file /evidence/platform-snapshot.json \
			--sha256 "$(platform_cutover_marker_value snapshot_sha256)" >/dev/null
		platform_cutover_validate_frontend_attestation \
			"$(platform_cutover_marker_value generation)" || return 1
		platform_cutover_cli target import --file /evidence/platform-snapshot.json \
			--sha256 "$(platform_cutover_marker_value snapshot_sha256)" >/dev/null
		platform_cutover_rewrite_phase imported
		phase=imported
	fi
	if [[ "$phase" == imported ]]; then
		platform_cutover_revalidate_phase "$phase"
		imported_sha="$(platform_cutover_dump PLATFORM_BACKUP_URL platform "$imported_dump" \
			"$(platform_cutover_marker_value imported_backup_sha256)")"
		platform_cutover_update_evidence imported \
			"$imported_sha" \
			"$(platform_cutover_marker_value imported_restore_evidence_sha256)" \
			pending pending
		imported_restore_sha="$(platform_cutover_run_restore imported \
			"$imported_dump" "$imported_sha" "$directory/platform-imported-restore.json" \
			"$(platform_cutover_marker_value imported_restore_evidence_sha256)")" || return 1
		platform_cutover_update_evidence imported \
			"$imported_sha" \
			"$imported_restore_sha" pending pending
		platform_cutover_rewrite_phase restore-verified
		phase='restore-verified'
	fi
	if [[ "$phase" == restore-verified ]]; then
		platform_cutover_revalidate_phase "$phase"
		platform_cutover_validate_frontend_attestation \
			"$(platform_cutover_marker_value generation)" || return 1
		platform_cutover_cli target activate --sha256 \
			"$(platform_cutover_marker_value snapshot_sha256)" >/dev/null
		platform_cutover_cli target verify >/dev/null
		platform_database_advance active
		platform_cutover_rewrite_phase target-active
		phase='target-active'
	fi
	if [[ "$phase" == target-active ]]; then
		platform_cutover_advance_target_active || return 1
		phase='consumer-v2'
	fi
	if [[ "$phase" == consumer-v2 ]]; then
		platform_cutover_advance_consumer_v2 || return 1
		phase='core-active'
	fi
	if [[ "$phase" == core-active ]]; then
		platform_cutover_revalidate_phase "$phase"
		if [[ "$(platform_database_current_phase)" == complete ]]; then
			platform_cutover_verify_runtime_and_routes
			platform_cutover_rewrite_phase complete
			phase=complete
		else
		active_sha="$(platform_cutover_dump PLATFORM_BACKUP_URL platform "$active_dump" \
			"$(platform_cutover_marker_value active_backup_sha256)")"
		platform_cutover_update_evidence core-active \
			"$(platform_cutover_marker_value imported_backup_sha256)" \
			"$(platform_cutover_marker_value imported_restore_evidence_sha256)" \
			"$active_sha" "$(platform_cutover_marker_value active_restore_evidence_sha256)"
		active_restore_sha="$(platform_cutover_run_restore active \
			"$active_dump" "$active_sha" "$directory/platform-active-restore.json" \
			"$(platform_cutover_marker_value active_restore_evidence_sha256)")" || return 1
		platform_cutover_update_evidence core-active \
			"$(platform_cutover_marker_value imported_backup_sha256)" \
			"$(platform_cutover_marker_value imported_restore_evidence_sha256)" \
			"$active_sha" "$active_restore_sha"
		platform_cutover_ensure_gateway_boundary || return 1
		platform_cutover_verify_runtime_and_routes || return 1
		platform_cutover_validate_frontend_attestation \
			"$(platform_cutover_marker_value generation)" || return 1
		platform_database_advance complete || return 1
		platform_cutover_rewrite_phase complete || return 1
		phase=complete
		fi
	fi
	[[ "$phase" == complete ]] || return 1
	platform_cutover_verify_complete_noop || return 1
	platform_cutover_finalize_phase_a_artifacts || return 1
	printf 'platform_cutover_phase=complete\n'
	printf 'platform_cutover_revision=%s\n' "$EXPECTED_REVISION"
}

platform_cutover_restore_phase_a_runtime() {
	platform_cutover_restore_phase_a_env || return 1
	platform_cutover_assert_phase_a_runtime_from_receipt >/dev/null || return 1
	platform_cutover_verify_phase_a_gateway_routes
}

platform_cutover_abort() {
	platform_cutover_require_root
	acquire_production_deploy_lock 'Platform ownership abort'
	platform_cutover_bind_database_url_parser_image || return 1
	platform_cutover_require_abort_env_sha || return 1
	platform_cutover_require_inputs abort
	[[ "${PLATFORM_CONFIRMATION:-}" == 'ABORT PLATFORM CUTOVER' ]] ||
		platform_cutover_fail 'Platform cutover abort requires exact confirmation.' || return 1
	local phase snapshot_sha database_phase
	phase="$(platform_cutover_current_phase)"
	database_phase="$(platform_database_current_phase)" || return 1
	case "$phase" in prepared | source-fenced | imported | restore-verified | aborted) ;; target-active | consumer-v2 | core-active | complete)
		platform_cutover_fail 'Platform ownership is forward-only; use forward recovery.'; return 1 ;; *) return 1 ;; esac
	if [[ "$phase" == aborted ]]; then
		if [[ "$database_phase" == prepared ]]; then
			PLATFORM_ABORT_CONFIRMATION='ABORT PLATFORM PREPARE' platform_database_abort_prepare
		fi
		[[ "$(platform_database_current_phase)" == aborted ]] || return 1
		platform_cutover_restore_phase_a_runtime || return 1
		printf 'platform_cutover_phase=aborted\n'
		return
	fi
	snapshot_sha="$(platform_cutover_marker_value snapshot_sha256)"
	if [[ "$snapshot_sha" =~ ^[0-9a-f]{64}$ ]]; then
		platform_cutover_cli target abort --sha256 "$snapshot_sha" >/dev/null
	else
		platform_cutover_cli target validate-shadow >/dev/null
	fi
	platform_cutover_cli core abort --revision "$EXPECTED_REVISION" >/dev/null
	if [[ "$database_phase" == prepared ]]; then
		PLATFORM_ABORT_CONFIRMATION='ABORT PLATFORM PREPARE' platform_database_abort_prepare
	fi
	[[ "$(platform_database_current_phase)" == aborted ]] || return 1
	platform_cutover_restore_phase_a_runtime || return 1
	platform_cutover_rewrite_phase aborted
	printf 'platform_cutover_phase=aborted\n'
}

platform_cutover_status() {
	local phase database_phase target_status core_status image_id mode
	phase="$(platform_cutover_current_phase)" || return 1
	printf 'platform_cutover_phase=%s\n' "$phase"
	if [[ "$phase" == absent ]]; then
		if [[ -e "$platform_billing_readiness_receipt" || -L "$platform_billing_readiness_receipt" ]]; then
			platform_cutover_validate_billing_readiness_receipt || return 1
			platform_cutover_validate_phase_a_env_artifact || return 1
			platform_cutover_bind_database_url_parser_image || return 1
			[[ "$(platform_cutover_billing_readiness_value revision)" == "$EXPECTED_REVISION" ]] ||
				platform_cutover_fail 'Phase-A readiness belongs to another checkout revision.' || return 1
			platform_cutover_assert_phase_a_runtime_from_receipt >/dev/null || return 1
			platform_cutover_verify_phase_a_gateway_routes || return 1
			printf 'platform_billing_readiness=ready\n'
			printf 'platform_billing_readiness_revision=%s\n' \
				"$(platform_cutover_billing_readiness_value revision)"
		elif [[ -e "$platform_phase_a_intent" || -L "$platform_phase_a_intent" ]]; then
			platform_cutover_validate_phase_a_intent || return 1
			[[ "$(platform_cutover_phase_a_intent_value revision)" == "$EXPECTED_REVISION" ]] ||
				platform_cutover_fail 'Phase-A preparing intent belongs to another checkout revision.' || return 1
			if [[ -e "$platform_phase_a_env_artifact" || -L "$platform_phase_a_env_artifact" ]]; then
				platform_cutover_validate_phase_a_env_against_intent || return 1
			fi
			printf 'platform_billing_readiness=preparing\n'
			printf 'platform_billing_readiness_revision=%s\n' \
				"$(platform_cutover_phase_a_intent_value revision)"
		elif [[ -e "$platform_phase_a_env_artifact" || -L "$platform_phase_a_env_artifact" ]]; then
			platform_cutover_fail 'Orphan phase-A env artifact has no durable intent or final receipt.'
			return 1
		fi
		return
	fi
	if [[ "$phase" != absent ]]; then
		platform_cutover_bind_database_url_parser_image || return 1
		mode=cutover
		[[ "$phase" == aborted ]] && mode=abort
		platform_cutover_require_inputs "$mode"
		database_phase="$(platform_database_current_phase)" || return 1
		case "$phase:$database_phase" in
		prepared:prepared | source-fenced:prepared | imported:prepared | restore-verified:prepared | \
			restore-verified:active | \
			target-active:active | consumer-v2:active | core-active:active | core-active:complete | complete:complete | aborted:aborted) ;; *)
			platform_cutover_fail 'Platform cutover and database phases are inconsistent.'; return 1 ;; esac
		target_status="$(platform_cutover_cli target status)" || return 1
		core_status="$(platform_cutover_cli core status)" || return 1
		image_id="$(platform_cutover_marker_value image_id)"
		PHASE="$phase" REVISION="$EXPECTED_REVISION" TARGET_STATUS="$target_status" \
			CORE_STATUS="$core_status" SNAPSHOT_SHA="$(platform_cutover_marker_value snapshot_sha256)" \
			SOURCE_FINGERPRINT="$(platform_cutover_marker_value source_fingerprint)" \
			SOURCE_HIGH_WATER="$(platform_cutover_marker_value source_high_watermark)" \
			platform_database_docker run --rm --network none --read-only --cap-drop ALL \
				--security-opt no-new-privileges --pids-limit 64 --env PHASE --env REVISION \
				--env TARGET_STATUS --env CORE_STATUS --env SNAPSHOT_SHA \
				--env SOURCE_FINGERPRINT --env SOURCE_HIGH_WATER \
				--entrypoint node "$image_id" -e '
const target = JSON.parse(process.env.TARGET_STATUS);
const core = JSON.parse(process.env.CORE_STATUS);
const phase = process.env.PHASE;
const frozen = ["source-fenced", "imported", "restore-verified", "target-active"];
const targetActive = ["target-active", "consumer-v2", "core-active", "complete"];
const exactFrozenCore = core.ownership === "CORE" && core.sourceWritesEnabled === false &&
    core.legacyRoutesEnabled === true && core.preparedRevision === process.env.REVISION &&
    core.sourceRevision === process.env.REVISION &&
    core.sourceSnapshotSha256 === process.env.SNAPSHOT_SHA &&
    core.sourceFingerprint === process.env.SOURCE_FINGERPRINT &&
    core.sourceHighWatermark === process.env.SOURCE_HIGH_WATER &&
    typeof core.exportedAt === "string";
const exactActiveCore = core.ownership === "PLATFORM" && core.sourceWritesEnabled === false &&
    core.legacyRoutesEnabled === false && core.preparedRevision === process.env.REVISION &&
    core.sourceRevision === process.env.REVISION && core.ownershipRevision === process.env.REVISION &&
    core.sourceSnapshotSha256 === process.env.SNAPSHOT_SHA &&
    core.sourceFingerprint === process.env.SOURCE_FINGERPRINT &&
    core.sourceHighWatermark === process.env.SOURCE_HIGH_WATER &&
    typeof core.exportedAt === "string" && typeof core.activatedAt === "string";
const exactOpenPreparedCore = core.ownership === "CORE" && core.sourceWritesEnabled === true &&
    core.legacyRoutesEnabled === true && core.preparedRevision === process.env.REVISION &&
    core.sourceRevision === null && core.sourceSnapshotSha256 === null &&
    core.sourceFingerprint === null && core.sourceHighWatermark === null;
const resumableFencedPreparedCore = core.ownership === "CORE" && core.sourceWritesEnabled === false &&
    core.legacyRoutesEnabled === true && core.preparedRevision === process.env.REVISION &&
    core.billingOfferProducer?.contractVersion === 2 &&
    ((core.sourceRevision === null && core.sourceSnapshotSha256 === null &&
      core.sourceFingerprint === null && core.sourceHighWatermark === null) ||
     (core.sourceRevision === process.env.REVISION &&
      /^[0-9a-f]{64}$/.test(core.sourceSnapshotSha256 || "") &&
      /^[0-9a-f]{64}$/.test(core.sourceFingerprint || "") &&
      /^[1-9][0-9]*$/.test(core.sourceHighWatermark || "") &&
      typeof core.exportedAt === "string"));
const exactFreshTarget = target.phase === "SHADOW" && target.imported === false &&
    target.billingOfferProducer?.phase === "BLOCKED" && target.outbox === 0;
const exactImportedTarget = target.phase === "SHADOW" && target.imported === true &&
    target.billingOfferProducer?.phase === "IMPORTED" && target.outbox === 0 &&
    target.sourceSnapshotSha256 === process.env.SNAPSHOT_SHA &&
    target.sourceFingerprint === process.env.SOURCE_FINGERPRINT &&
    target.sourceHighWatermark === process.env.SOURCE_HIGH_WATER;
const exactActiveTarget = target.phase === "ACTIVE" && target.imported === true &&
    target.billingOfferProducer?.phase === "ACTIVE" &&
    target.sourceSnapshotSha256 === process.env.SNAPSHOT_SHA &&
    target.sourceFingerprint === process.env.SOURCE_FINGERPRINT &&
    target.sourceHighWatermark === process.env.SOURCE_HIGH_WATER;
if (target.ok !== true || target.action !== "status" || core.ok !== true || core.action !== "status") process.exit(1);
if (phase === "prepared" && (!exactFreshTarget ||
    (!exactOpenPreparedCore && !resumableFencedPreparedCore))) process.exit(1);
if (frozen.includes(phase) && !exactFrozenCore) process.exit(1);
if (phase === "consumer-v2" && !exactFrozenCore && !exactActiveCore) process.exit(1);
if (phase === "imported" && !exactImportedTarget) process.exit(1);
if (phase === "restore-verified" && !exactImportedTarget && !exactActiveTarget) process.exit(1);
if (phase === "source-fenced" && !exactFreshTarget && !exactImportedTarget) process.exit(1);
if (targetActive.includes(phase) && !exactActiveTarget) process.exit(1);
if (["core-active", "complete"].includes(phase) && !exactActiveCore) process.exit(1);
if (phase === "aborted" && (target.phase !== "SHADOW" || target.imported !== false ||
    target.billingOfferProducer?.phase !== "BLOCKED" || target.outbox !== 0 ||
    core.ownership !== "CORE" || core.sourceWritesEnabled !== true || core.legacyRoutesEnabled !== true ||
    core.preparedRevision !== null)) process.exit(1);
' >/dev/null
		case "$phase" in
		prepared | source-fenced | imported | restore-verified | aborted)
			platform_cutover_assert_phase_a_runtime_from_receipt >/dev/null || return 1
			;;
		target-active)
			platform_cutover_assert_core_api_candidate >/dev/null || return 1
			platform_cutover_assert_billing_api_candidate >/dev/null || return 1
			platform_cutover_assert_gateway_receipt_identity >/dev/null || return 1
			;;
		consumer-v2 | core-active | complete)
			platform_cutover_assert_core_api_candidate >/dev/null || return 1
			platform_cutover_assert_billing_api_candidate >/dev/null || return 1
			platform_cutover_assert_gateway_runtime >/dev/null || return 1
			;;
		esac
		if [[ "$phase" == aborted ]]; then
			[[ "$(platform_cutover_sha256 "$ENV_FILE")" == \
				"$(platform_cutover_billing_readiness_value phase_a_env_sha256)" ]] || return 1
			platform_cutover_phase_a_runtime_is_ready || return 1
		fi
		printf 'platform_cutover_revision=%s\n' "$(platform_cutover_marker_value revision)"
		printf 'platform_cutover_snapshot_sha256=%s\n' "$(platform_cutover_marker_value snapshot_sha256)"
		printf '%s\n' "$target_status"
		printf '%s\n' "$core_status"
	fi
}

platform_cutover_guard_checkout_revision() {
	[[ "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
	local phase
	phase="$(platform_cutover_current_phase)" || return 1
	case "$phase" in
	absent)
		if [[ -e "$platform_billing_readiness_receipt" || -L "$platform_billing_readiness_receipt" ]]; then
			platform_cutover_validate_billing_readiness_receipt || return 1
			[[ "$1" == "$(platform_cutover_billing_readiness_value revision)" ]]
		elif [[ -e "$platform_phase_a_intent" || -L "$platform_phase_a_intent" ]]; then
			platform_cutover_validate_phase_a_intent || return 1
			if [[ -e "$platform_phase_a_env_artifact" || -L "$platform_phase_a_env_artifact" ]]; then
				platform_cutover_validate_phase_a_env_against_intent || return 1
			fi
			[[ "$1" == "$(platform_cutover_phase_a_intent_value revision)" ]]
		elif [[ -e "$platform_phase_a_env_artifact" || -L "$platform_phase_a_env_artifact" ]]; then
			platform_cutover_fail 'Orphan phase-A env artifact blocks checkout.'
			return 1
		else
			return 0
		fi
		;;
	complete)
		if platform_cutover_assert_phase_a_artifacts_retired >/dev/null 2>&1; then
			return 0
		fi
		[[ "$1" == "$(platform_cutover_marker_value revision)" ]]
		;;
	aborted) [[ "$1" == "$(platform_cutover_marker_value revision)" ]] ;;
	*) [[ "$1" == "$(platform_cutover_marker_value revision)" ]] ;;
	esac
}

platform_cutover_self_test_restore_resume() (
	local directory dump evidence dump_sha expected_evidence_hash result
	directory="$(realpath -- "$(mktemp -d)")" || return 1
	trap 'rm -rf -- "$directory"' EXIT
	dump="$directory/platform.dump"
	evidence="$directory/platform-restore.json"
	dump_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	expected_evidence_hash='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	printf 'PGDMP-test\n' >"$dump"
	printf '{"status":"passed"}\n' >"$evidence"
	platform_cutover_validate_restore_evidence() {
		[[ "$1|$2|$3|$4" == "$evidence|imported|$dump|$dump_sha" ]]
	}
	platform_cutover_sha256() {
		[[ "$1" == "$evidence" ]] || return 1
		printf '%s\n' "$expected_evidence_hash"
	}
	result="$(platform_cutover_run_restore imported "$dump" "$dump_sha" \
		"$evidence" pending)" || return 1
	[[ "$result" == "$expected_evidence_hash" ]] || return 1
	! platform_cutover_run_restore imported "$dump" "$dump_sha" "$evidence" \
		'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' \
		>/dev/null 2>&1 || return 1
	rm -f -- "$evidence"
	! platform_cutover_run_restore imported "$dump" "$dump_sha" "$evidence" \
		"$expected_evidence_hash" >/dev/null 2>&1
)

platform_cutover_self_test_bound_hash_tamper() (
	local directory artifact sha
	directory="$(realpath -- "$(mktemp -d)")" || return 1
	trap 'rm -rf -- "$directory"' EXIT
	artifact="$directory/artifact"
	printf 'bound\n' >"$artifact"
	sha="$(platform_cutover_sha256 "$artifact")" || return 1
	platform_cutover_require_bound_file_sha "$artifact" "$sha" || return 1
	printf 'tampered\n' >>"$artifact"
	! platform_cutover_require_bound_file_sha "$artifact" "$sha" >/dev/null 2>&1
)

platform_cutover_self_test_unbound_dump_resume() (
	local directory dump expected result
	directory="$(realpath -- "$(mktemp -d)")" || return 1
	trap 'rm -rf -- "$directory"' EXIT
	chmod 700 "$directory"
	dump="$directory/platform-imported.dump"
	printf 'PGDMP-resume\n' >"$dump"
	chmod 600 "$dump"
	expected="$(platform_cutover_sha256 "$dump")" || return 1
	result="$(platform_cutover_dump PLATFORM_BACKUP_URL platform "$dump" pending)" || return 1
	[[ "$result" == "$expected" ]] || return 1
	platform_cutover_revalidate_restore_binding imported "$dump" pending \
		"$directory/platform-imported-restore.json" pending
)

platform_cutover_self_test_complete_noop() (
	local trace=''
	platform_cutover_current_phase() { printf 'complete\n'; }
	platform_database_current_phase() { printf 'complete\n'; }
	platform_cutover_revalidate_phase() { [[ "$1" == complete ]] && trace+='e'; }
	platform_cutover_assert_gateway_image() { trace+='i'; }
	platform_cutover_validate_gateway_manifest() { trace+='m'; }
	platform_cutover_verify_runtime_and_routes() { trace+='r'; }
	platform_cutover_verify_complete_noop || return 1
	[[ "$trace" == eimr ]] || return 1
	local source
	source="$(declare -f platform_cutover_verify_complete_noop)"
	[[ "$source" != *'platform_cutover_write_marker'* &&
		"$source" != *'platform_cutover_rewrite_phase'* &&
		"$source" != *'platform_database_advance'* &&
		"$source" != *'platform_cutover_provision_publisher'* &&
		"$source" != *'platform_release_compose'* ]]
)

platform_cutover_self_test_billing_offer_topology() (
	local valid_v2 legacy_v1 valid_bindings queue_details invalid_details trace=''
	valid_v2="$(printf '%s true 0 0 1\n' "$PLATFORM_BILLING_OFFER_V2_QUEUE")"
	valid_v2+="$(printf '\n%s.retry.1 true 0 0 0\n%s.retry.2 true 0 0 0\n%s.retry.3 true 0 0 0\n%s.dead-letter true 0 0 0' \
		"$PLATFORM_BILLING_OFFER_V2_QUEUE" "$PLATFORM_BILLING_OFFER_V2_QUEUE" \
		"$PLATFORM_BILLING_OFFER_V2_QUEUE" "$PLATFORM_BILLING_OFFER_V2_QUEUE")"
	legacy_v1="$(printf '%s true 0 0 0\n%s.retry.1 true 0 0 0\n%s.retry.2 true 0 0 0\n%s.retry.3 true 0 0 0\n%s.dead-letter true 0 0 0' \
		"$PLATFORM_BILLING_OFFER_V1_QUEUE" "$PLATFORM_BILLING_OFFER_V1_QUEUE" \
		"$PLATFORM_BILLING_OFFER_V1_QUEUE" "$PLATFORM_BILLING_OFFER_V1_QUEUE" \
		"$PLATFORM_BILLING_OFFER_V1_QUEUE")"
	platform_cutover_billing_offer_v1_listing_is_retirable "$legacy_v1" || return 1
	! platform_cutover_billing_offer_v1_listing_is_retirable \
		"${legacy_v1/$PLATFORM_BILLING_OFFER_V1_QUEUE true 0 0 0/$PLATFORM_BILLING_OFFER_V1_QUEUE true 0 0 1}" || return 1
	platform_cutover_billing_offer_v2_listing_is_exact "$valid_v2" || return 1
	! platform_cutover_billing_offer_v2_listing_is_exact "$valid_v2
$PLATFORM_BILLING_OFFER_V1_QUEUE true 0 0 0" || return 1
	! platform_cutover_billing_offer_v2_listing_is_exact \
		"${valid_v2/$PLATFORM_BILLING_OFFER_V2_QUEUE true 0 0 1/$PLATFORM_BILLING_OFFER_V2_QUEUE true 0 0 0}" || return 1
	valid_bindings="$(printf '%s %s queue %s\n' winwidget.events \
		"$PLATFORM_BILLING_OFFER_V2_QUEUE" "$PLATFORM_BILLING_OFFER_V2_EVENT")"
	valid_bindings+="$(printf '\n%s %s queue %s\n%s %s.dead-letter queue offer.dead-letter' \
		winwidget.billing.retry "$PLATFORM_BILLING_OFFER_V2_QUEUE" "$PLATFORM_BILLING_OFFER_V2_EVENT" \
		winwidget.billing.dead-letter "$PLATFORM_BILLING_OFFER_V2_QUEUE")"
	for attempt in 1 2 3; do
		valid_bindings+="$(printf '\n%s %s.retry.%s queue offer.retry.%s' \
			winwidget.billing.retry "$PLATFORM_BILLING_OFFER_V2_QUEUE" "$attempt" "$attempt")"
	done
	platform_cutover_billing_offer_v2_bindings_are_exact "$valid_bindings" || return 1
	! platform_cutover_billing_offer_v2_bindings_are_exact "$valid_bindings
winwidget.events $PLATFORM_BILLING_OFFER_V1_QUEUE queue billing.offer.changed.v1" || return 1
	queue_details="$(PLATFORM_QUEUE_PREFIX="$PLATFORM_BILLING_OFFER_V2_QUEUE" \
		PLATFORM_QUEUE_EVENT="$PLATFORM_BILLING_OFFER_V2_EVENT" node -e '
const prefix = process.env.PLATFORM_QUEUE_PREFIX;
const event = process.env.PLATFORM_QUEUE_EVENT;
const retry = [60_000, 300_000, 1_800_000].map((ttl, index) => ({
  name: `${prefix}.retry.${index + 1}`,
  vhost: "winwidget",
  durable: true,
  auto_delete: false,
  exclusive: false,
  arguments: {
    "x-message-ttl": ttl,
    "x-dead-letter-exchange": "winwidget.billing.retry",
    "x-dead-letter-routing-key": event,
  },
}));
process.stdout.write(JSON.stringify([
  { name: prefix, vhost: "winwidget", durable: true, auto_delete: false, exclusive: false, arguments: {} },
  { name: `${prefix}.dead-letter`, vhost: "winwidget", durable: true, auto_delete: false, exclusive: false, arguments: {} },
  ...retry,
]));
')" || return 1
	platform_cutover_billing_offer_v2_queue_details_are_exact "$queue_details" || return 1
	invalid_details="$(PLATFORM_QUEUE_DETAILS_JSON="$queue_details" node -e '
const rows = JSON.parse(process.env.PLATFORM_QUEUE_DETAILS_JSON);
rows[2].arguments["x-message-ttl"] += 1;
process.stdout.write(JSON.stringify(rows));
')" || return 1
	! platform_cutover_billing_offer_v2_queue_details_are_exact "$invalid_details" || return 1
	invalid_details="$(PLATFORM_QUEUE_DETAILS_JSON="$queue_details" node -e '
const rows = JSON.parse(process.env.PLATFORM_QUEUE_DETAILS_JSON);
rows[0].arguments.unexpected = true;
process.stdout.write(JSON.stringify(rows));
')" || return 1
	! platform_cutover_billing_offer_v2_queue_details_are_exact "$invalid_details" || return 1
	invalid_details="$(PLATFORM_QUEUE_DETAILS_JSON="$queue_details" node -e '
const rows = JSON.parse(process.env.PLATFORM_QUEUE_DETAILS_JSON);
rows[0].auto_delete = true;
process.stdout.write(JSON.stringify(rows));
')" || return 1
	! platform_cutover_billing_offer_v2_queue_details_are_exact "$invalid_details" || return 1
	platform_cutover_assert_billing_worker_image() { trace+='i'; }
	platform_release_compose() {
		shift 3
		case "$*" in
		'stop --timeout 90 billing-worker') trace+='s' ;;
		'ps -q rabbitmq') trace+='q'; printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n' ;;
		'up -d --no-deps --force-recreate billing-worker') trace+='u' ;;
		*) return 1 ;;
		esac
	}
	platform_cutover_compose_with_receipt_images() {
		[[ "$*" == 'up -d --no-deps --force-recreate billing-worker' ]] || return 1
		trace+='u'
	}
	platform_read_env_value() { [[ "$2" == RABBITMQ_VHOST ]] && printf 'winwidget\n'; }
	platform_database_docker() {
		[[ "$*" == *'rabbitmqctl --silent list_queues -p winwidget name durable messages_ready messages_unacknowledged consumers'* ]] || return 1
		trace+='l'
		printf '%s\n' "$legacy_v1"
	}
	platform_cutover_provision_billing_offer_v2_permissions() { trace+='p'; }
	platform_cutover_assert_billing_worker_candidate() { trace+='c'; }
	platform_cutover_retire_billing_offer_v1() { trace+='d'; }
	platform_cutover_verify_billing_offer_v2_boundary() { trace+='v'; }
	platform_cutover_switch_billing_offer_consumer_v2 || return 1
	[[ "$trace" == ispuccdv ]]
)

platform_cutover_self_test_settings_projection_topology() (
	local source retire_source provision_source listing bindings queue_details invalid_details attempt legacy_listing
	source="$(declare -f platform_cutover_settings_projection_topology_is_absent \
		platform_cutover_retire_settings_projection \
		platform_cutover_legacy_settings_queue_listing_is_drained \
		platform_cutover_platform_admin_audit_queue_listing_is_exact \
		platform_cutover_platform_admin_audit_bindings_are_exact \
		platform_cutover_platform_admin_audit_queue_details_are_exact \
		platform_cutover_assert_integration_worker_candidate)"
	retire_source="$(declare -f platform_cutover_retire_settings_projection)"
	provision_source="$(declare -f platform_cutover_provision_platform_admin_audit_topology)"
	listing="$(printf '%s true false false\n%s.dead-letter true false false' \
		"$PLATFORM_ADMIN_AUDIT_QUEUE" "$PLATFORM_ADMIN_AUDIT_QUEUE")"
	bindings="$(printf '%s %s queue %s\n%s %s queue manual.%s\n%s %s queue %s' \
		winwidget.events "$PLATFORM_ADMIN_AUDIT_QUEUE" "$PLATFORM_ADMIN_AUDIT_EVENT" \
		winwidget.events "$PLATFORM_ADMIN_AUDIT_QUEUE" "$PLATFORM_ADMIN_AUDIT_KIND" \
		winwidget.manual-retry "$PLATFORM_ADMIN_AUDIT_QUEUE" "$PLATFORM_ADMIN_AUDIT_KIND")"
	bindings+="$(printf '\n%s %s.dead-letter queue %s.dead-letter\n%s %s.dead-letter queue %s.dead-letter' \
		winwidget.dead-letter "$PLATFORM_ADMIN_AUDIT_QUEUE" "$PLATFORM_ADMIN_AUDIT_KIND" \
		winwidget.events "$PLATFORM_ADMIN_AUDIT_QUEUE" "$PLATFORM_ADMIN_AUDIT_KIND")"
	for attempt in 1 2 3; do
		listing+="$(printf '\n%s.retry-v2.%s true false false' "$PLATFORM_ADMIN_AUDIT_QUEUE" "$attempt")"
		bindings+="$(printf '\n%s %s.retry-v2.%s queue %s.retry.%s' \
			winwidget.retry "$PLATFORM_ADMIN_AUDIT_QUEUE" "$attempt" \
			"$PLATFORM_ADMIN_AUDIT_KIND" "$attempt")"
	done
	platform_cutover_platform_admin_audit_queue_listing_is_exact "$listing" || return 1
	platform_cutover_platform_admin_audit_bindings_are_exact "$bindings" || return 1
	! platform_cutover_platform_admin_audit_queue_listing_is_exact \
		"$listing"$'\n'"$PLATFORM_ADMIN_AUDIT_QUEUE.retry.1 true false false" || return 1
	! platform_cutover_platform_admin_audit_bindings_are_exact \
		"$bindings"$'\n'"winwidget.events $PLATFORM_ADMIN_AUDIT_QUEUE queue unexpected" || return 1
	legacy_listing='winwidget.core.billing.settings.v1 true 0 0 0
winwidget.core.billing.settings.v1.dead-letter true 0 0 0
winwidget.billing.settings-source.v1 true 0 0 0'
	platform_cutover_legacy_settings_queue_listing_is_drained "$legacy_listing" || return 1
	! platform_cutover_legacy_settings_queue_listing_is_drained \
		"${legacy_listing/winwidget.billing.settings-source.v1 true 0 0 0/winwidget.billing.settings-source.v1 true 1 0 0}" || return 1
	! platform_cutover_legacy_settings_queue_listing_is_drained \
		"${legacy_listing/winwidget.core.billing.settings.v1 true 0 0 0/winwidget.core.billing.settings.v1 false 0 0 0}" || return 1
	queue_details="$(PLATFORM_QUEUE_PREFIX="$PLATFORM_ADMIN_AUDIT_QUEUE" \
		PLATFORM_QUEUE_KIND="$PLATFORM_ADMIN_AUDIT_KIND" node -e '
const prefix = process.env.PLATFORM_QUEUE_PREFIX;
const kind = process.env.PLATFORM_QUEUE_KIND;
const rows = [
  { name: prefix, arguments: {} },
  { name: `${prefix}.dead-letter`, arguments: {} },
  ...[30_000, 300_000, 1_800_000].map((ttl, index) => ({
    name: `${prefix}.retry-v2.${index + 1}`,
    arguments: {
      "x-message-ttl": ttl,
      "x-dead-letter-exchange": "winwidget.manual-retry",
      "x-dead-letter-routing-key": kind,
    },
  })),
].map(row => ({
  ...row,
  vhost: "winwidget",
  durable: true,
  auto_delete: false,
  exclusive: false,
}));
process.stdout.write(JSON.stringify(rows));
')" || return 1
	platform_cutover_platform_admin_audit_queue_details_are_exact "$queue_details" || return 1
	invalid_details="$(PLATFORM_QUEUE_DETAILS_JSON="$queue_details" node -e '
const rows = JSON.parse(process.env.PLATFORM_QUEUE_DETAILS_JSON);
rows[2].arguments["x-message-ttl"] += 1;
process.stdout.write(JSON.stringify(rows));
')" || return 1
	! platform_cutover_platform_admin_audit_queue_details_are_exact "$invalid_details" || return 1
	invalid_details="$(PLATFORM_QUEUE_DETAILS_JSON="$queue_details" node -e '
const rows = JSON.parse(process.env.PLATFORM_QUEUE_DETAILS_JSON);
rows[0].arguments.unexpected = true;
process.stdout.write(JSON.stringify(rows));
')" || return 1
	! platform_cutover_platform_admin_audit_queue_details_are_exact "$invalid_details" || return 1
	invalid_details="$(PLATFORM_QUEUE_DETAILS_JSON="$queue_details" node -e '
const rows = JSON.parse(process.env.PLATFORM_QUEUE_DETAILS_JSON);
rows.pop();
process.stdout.write(JSON.stringify(rows));
')" || return 1
	! platform_cutover_platform_admin_audit_queue_details_are_exact "$invalid_details" || return 1
	[[ "$PLATFORM_LEGACY_SETTINGS_QUEUE_PATTERN" == *'winwidget\.core\.billing\.settings\.v1'* &&
		"$PLATFORM_LEGACY_SETTINGS_QUEUE_PATTERN" == *'winwidget\.billing\.settings-source\.v1'* &&
		"$source" == *'stop --timeout 90 integration-worker billing-worker'* &&
		"$source" == *'platform_cutover_legacy_settings_queue_listing_is_drained'* &&
		"$source" == *"billing.settings.source.changed.v1"*'status::text'*'PUBLISHED'* &&
		"$source" == *'platform_cutover_verify_gateway_routes'* &&
		"$source" == *'delete_queue'*'--if-empty'*'--if-unused'* &&
		"$retire_source" == *'platform_cutover_provision_platform_admin_audit_topology'*'platform_cutover_provision_integration_worker_permissions'*'if [[ "$mode" == hold-billing ]]'*'up -d --no-deps --force-recreate integration-worker'* &&
		"$source" == *'stop --timeout 90 billing-worker'* &&
		"$source" == *'up -d --no-deps --force-recreate integration-worker'* &&
		"$source" == *'Billing worker must remain stopped until offer-v2 permissions are installed.'* &&
		"$source" == *'up -d --no-deps --force-recreate integration-worker billing-worker'* &&
		"$source" == *'platform_cutover_assert_billing_worker_candidate'* &&
		"$source" == *'platform_cutover_settings_projection_topology_is_absent'* &&
		"$source" == *'platform_cutover_assert_integration_worker_permissions'*'platform_cutover_assert_platform_admin_audit_topology'* &&
		"$source" == *'"x-message-ttl": 30_000'*'"x-message-ttl": 300_000'*'"x-message-ttl": 1_800_000'* &&
		"$provision_source" == *'require("amqplib")'*'assertQueue(queue, { durable: true })'*'.retry-v2.${index + 1}'*'deadLetterExchange: "winwidget.manual-retry"'*'platform_cutover_assert_platform_admin_audit_topology'* ]]
)

platform_cutover_self_test_core_route_matrix() (
	local trace container='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
	local matrix_log
	matrix_log="$(mktemp)" || return 1
	trap 'rm -f -- "$matrix_log"' EXIT
	platform_cutover_assert_core_api_candidate() { [[ "$1" == "$container" ]]; }
	platform_cutover_core_route_status() {
		printf '%s:%s|' "$1" "$2" >>"$matrix_log"
		printf '404\n'
	}
	platform_cutover_assert_core_routes removed "$container" || return 1
	platform_cutover_assert_core_routes fenced "$container" || return 1
	trace="$(<"$matrix_log")"
	[[ "$trace" == *'GET:/legal-pages/oferta|'* &&
		"$trace" == *'PATCH:/legal-pages/oferta|'* && "$trace" != *'PATCH:/legal-pages|'* ]] || return 1
	: >"$matrix_log"
	platform_cutover_assert_core_routes retired "$container" || return 1
	trace="$(<"$matrix_log")"
	[[ "$trace" == *'GET:/legal-pages/oferta|'* &&
		"$trace" == *'PATCH:/legal-pages/oferta|'* && "$trace" != *'PATCH:/legal-pages|'* ]]
)

platform_cutover_self_test_billing_settings_boundary() (
	local mode=valid
	platform_cutover_assert_gateway_provenance() { return 0; }
	curl() {
		local args=" $* " url="${*: -1}"
		case "$url" in
		http://127.0.0.1:4800/api/v1/billing-settings/public | \
		http://127.0.0.1:4100/api/v1/billing-settings/public) printf '{"settings":true}\n' ;;
		http://127.0.0.1:4800/api/v1/billing-settings/admin)
			[[ "$args" == *' --write-out '* ]] || return 1
			[[ "$mode" == direct-unprotected ]] && printf '200' || printf '401'
			;;
		http://127.0.0.1:4100/api/v1/billing-settings/admin)
			[[ "$args" == *' --write-out '* ]] || return 1
			[[ "$mode" == gateway-unprotected ]] && printf '200' || printf '401'
			;;
		http://127.0.0.1:4100/api/v1/site-settings | \
		http://127.0.0.1:4100/api/v1/legal-pages | \
		http://127.0.0.1:4100/api/v1/legal-pages/oferta | \
		http://127.0.0.1:4100/api/v1/home-page-content) return 0 ;;
		*) return 1 ;;
		esac
	}
	platform_cutover_verify_gateway_routes || return 1
	mode=direct-unprotected
	! platform_cutover_verify_gateway_routes >/dev/null 2>&1 || return 1
	mode=gateway-unprotected
	! platform_cutover_verify_gateway_routes >/dev/null 2>&1 || return 1
	local source
	source="$(declare -f platform_cutover_assert_billing_api_candidate \
		platform_cutover_ensure_billing_api_candidate platform_cutover_verify_gateway_routes)"
	[[ "$source" == *'platform_cutover_expected_release_image_id billing'* &&
		"$source" == *'APP_REVISION'*'BILLING_PROCESS_ROLE'*'billing-api|False|billing'* &&
		"$source" == *'platform_cutover_receipt_is_present'*'automatic recreation is forbidden'* &&
		"$source" == *'http://127.0.0.1:4800/health/ready'* &&
		"$source" == *'up -d --no-deps --force-recreate billing-api'* &&
		"$source" == *'http://127.0.0.1:4800/api/v1/billing-settings/admin'* &&
		"$source" == *'http://127.0.0.1:4100/api/v1/billing-settings/admin'* ]]
)

platform_cutover_self_test_billing_readiness() (
	local directory valid_receipt source prepare_source readiness_source preflight_source restore_source abort_source trace=''
	directory="$(realpath -- "$(mktemp -d)")" || return 1
	trap 'rm -rf -- "$directory"' EXIT
	EXPECTED_REVISION='0123456789abcdef0123456789abcdef01234567'
	PLATFORM_ENV_EXPECTED_SHA256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	PLATFORM_FRONTEND_REVISION='89abcdef0123456789abcdef0123456789abcdef'
	PLATFORM_FRONTEND_RUNTIME_CHALLENGE='1111111111111111111111111111111111111111111111111111111111111111'
	PLATFORM_FRONTEND_ORIGIN='https://winwidget.ru'
	PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256='2222222222222222222222222222222222222222222222222222222222222222'
	platform_billing_readiness_receipt="$directory/.platform-billing-readiness-v1"
	platform_cutover_write_billing_readiness_receipt \
		"$PLATFORM_ENV_EXPECTED_SHA256" \
		'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
		'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' \
		'6666666666666666666666666666666666666666666666666666666666666666' \
		'sha256:7777777777777777777777777777777777777777777777777777777777777777' \
		'8888888888888888888888888888888888888888888888888888888888888888' \
		'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' \
		'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' \
		'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' \
		'3333333333333333333333333333333333333333333333333333333333333333' \
		'sha256:4444444444444444444444444444444444444444444444444444444444444444' \
		'5555555555555555555555555555555555555555555555555555555555555555' || return 1
	platform_cutover_validate_billing_readiness_receipt || return 1
	[[ "$(platform_cutover_billing_readiness_value revision)" == "$EXPECTED_REVISION" &&
		"$(platform_cutover_billing_readiness_value generation)" == 1 &&
		"$(platform_cutover_billing_readiness_value phase_a_env_sha256)" == "$PLATFORM_ENV_EXPECTED_SHA256" &&
		"$(platform_cutover_billing_readiness_value core_api_container_id)" == '6666666666666666666666666666666666666666666666666666666666666666' &&
		"$(platform_cutover_billing_readiness_value frontend_revision)" == "$PLATFORM_FRONTEND_REVISION" ]] || return 1
	valid_receipt="$(<"$platform_billing_readiness_receipt")"
	printf '%s\nversion=1\n' "$valid_receipt" >"$platform_billing_readiness_receipt"
	! platform_cutover_validate_billing_readiness_receipt >/dev/null 2>&1 || return 1
	printf '%s\n' "$valid_receipt" >"$platform_billing_readiness_receipt"
	mv -- "$platform_billing_readiness_receipt" "$platform_billing_readiness_receipt.real"
	ln -s -- "$platform_billing_readiness_receipt.real" "$platform_billing_readiness_receipt"
	! platform_cutover_validate_billing_readiness_receipt >/dev/null 2>&1 || return 1
	source="$(declare -f platform_cutover_validate_phase_a_gateway_manifest \
		platform_cutover_verify_phase_a_gateway_routes \
		platform_cutover_validate_billing_readiness_receipt)"
	platform_billing_readiness_receipt="$directory/chown-failure-receipt"
	uname() { printf 'Linux\n'; }
	id() { [[ "$1" == -u ]] && printf '0\n'; }
	chown() { return 1; }
	! platform_cutover_write_billing_readiness_receipt \
		"$PLATFORM_ENV_EXPECTED_SHA256" \
		'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
		'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' \
		'6666666666666666666666666666666666666666666666666666666666666666' \
		'sha256:7777777777777777777777777777777777777777777777777777777777777777' \
		'8888888888888888888888888888888888888888888888888888888888888888' \
		'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' \
		'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' \
		'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' \
		'3333333333333333333333333333333333333333333333333333333333333333' \
		'sha256:4444444444444444444444444444444444444444444444444444444444444444' \
		'5555555555555555555555555555555555555555555555555555555555555555' \
		>/dev/null 2>&1 || return 1
	[[ ! -e "$platform_billing_readiness_receipt" && ! -L "$platform_billing_readiness_receipt" ]] || return 1

	platform_cutover_validate_final_env_and_attestation() { trace+='F'; }
	platform_cutover_assert_phase_a_runtime_from_receipt() { trace+='I'; }
	platform_cutover_verify_phase_a_gateway_routes() { trace+='V'; }
	platform_cutover_finalize_phase_a_intent() { trace+='D'; }
	platform_cutover_preflight_final_env_and_phase_a || return 1
	[[ "$trace" == FIVD ]] || return 1

	prepare_source="$(declare -f platform_cutover_prepare)"
	readiness_source="$(declare -f platform_cutover_prepare_billing_readiness)"
	preflight_source="$(declare -f platform_cutover_preflight_final_env_and_phase_a)"
	restore_source="$(declare -f platform_cutover_restore_phase_a_env platform_cutover_restore_phase_a_runtime)"
	abort_source="$(declare -f platform_cutover_abort)"
	[[ "$prepare_source" == *'platform_database_require_inputs'*'platform_cutover_preflight_final_env_and_phase_a'*'platform_cutover_run_core_migration'*'platform_database_prepare'* &&
		"$prepare_source" != *'build --pull --provenance=false'* ]] || return 1
	[[ "$readiness_source" == *'build --pull --provenance=false api billing-api api-gateway'* &&
		"$readiness_source" == *'up -d --no-deps --force-recreate api billing-api api-gateway'* &&
		"$readiness_source" == *'platform_cutover_write_billing_readiness_receipt'* &&
		"$readiness_source" != *'platform_database_prepare'* &&
		"$readiness_source" != *'platform_cutover_write_marker'* ]] || return 1
	[[ "$preflight_source" == *'platform_cutover_validate_final_env_and_attestation'* &&
		"$preflight_source" == *'platform_cutover_assert_phase_a_runtime_from_receipt'* &&
		"$preflight_source" == *'platform_cutover_verify_phase_a_gateway_routes'* &&
		"$preflight_source" == *'platform_cutover_finalize_phase_a_intent'* ]] || return 1
	[[ "$restore_source" == *'platform_phase_a_env_artifact'*'mv -f'*'sync -f'* &&
		"$restore_source" == *'platform_cutover_assert_phase_a_runtime_from_receipt'*'platform_cutover_verify_phase_a_gateway_routes'* &&
		"$restore_source" != *'--force-recreate'* ]] || return 1
	[[ "$abort_source" == *'platform_cutover_require_abort_env_sha'* &&
		"$abort_source" != *'platform_cutover_require_expected_env_sha'* ]] || return 1
	[[ "$source" == *'platform-site-settings'*'platform-legal-pages'*'platform-home-page-content'* &&
		"$source" == *'http://127.0.0.1:5000'* &&
		"$source" == *'http://127.0.0.1:4200'* &&
		"$source" == *'http://127.0.0.1:4800/api/v1/billing-settings/admin'* &&
		"$source" == *'x-winwidget-service'* ]]
)

platform_cutover_self_test_phase_a_intent() (
	local directory expected other env_sha routes_sha expected_image trace='' prepare_source readiness_source finalizer_source
	directory="$(realpath -- "$(mktemp -d)")" || return 1
	trap 'rm -rf -- "$directory"' EXIT
	expected='0123456789abcdef0123456789abcdef01234567'
	other='89abcdef0123456789abcdef0123456789abcdef'
	EXPECTED_REVISION="$expected"
	PLATFORM_FRONTEND_REVISION='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	PLATFORM_FRONTEND_RUNTIME_CHALLENGE='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	PLATFORM_FRONTEND_ORIGIN='https://winwidget.ru'
	PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
	platform_phase_a_intent="$directory/.platform-phase-a-intent-v1"
	platform_phase_a_env_artifact="$directory/.platform-phase-a-env-v1"
	platform_billing_readiness_receipt="$directory/.platform-billing-readiness-v1"
	routes_sha='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
	printf 'phase-a-env\n' >"$platform_phase_a_env_artifact" || return 1
	chmod 600 "$platform_phase_a_env_artifact" || return 1
	env_sha="$(platform_cutover_sha256 "$platform_phase_a_env_artifact")" || return 1
	rm -f -- "$platform_phase_a_env_artifact"

	# A durable preparing intent alone pins the reviewed revision before any runtime mutation.
	platform_cutover_write_phase_a_intent "$env_sha" "$routes_sha" || return 1
	platform_cutover_validate_phase_a_intent || return 1
	platform_cutover_current_phase() { printf 'absent\n'; }
	platform_cutover_guard_checkout_revision "$expected" || return 1
	! platform_cutover_guard_checkout_revision "$other" || return 1
	expected_image='sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
	platform_database_docker() {
		[[ "$*" == "image inspect --format {{.Id}} winwidget-api:git-$expected" ]] || return 1
		printf '%s\n' "$expected_image"
	}
	[[ "$(platform_cutover_expected_release_image_id core)" == "$expected_image" ]] || return 1

	# A crash after installing the recoverable env remains bound to the same intent.
	printf 'phase-a-env\n' >"$platform_phase_a_env_artifact" || return 1
	chmod 600 "$platform_phase_a_env_artifact" || return 1
	platform_cutover_validate_phase_a_env_against_intent || return 1
	platform_cutover_guard_checkout_revision "$expected" || return 1

	platform_cutover_write_billing_readiness_receipt \
		"$env_sha" \
		'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' \
		"$routes_sha" \
		'1111111111111111111111111111111111111111111111111111111111111111' \
		'sha256:2222222222222222222222222222222222222222222222222222222222222222' \
		'3333333333333333333333333333333333333333333333333333333333333333' \
		'4444444444444444444444444444444444444444444444444444444444444444' \
		'sha256:5555555555555555555555555555555555555555555555555555555555555555' \
		'6666666666666666666666666666666666666666666666666666666666666666' \
		'7777777777777777777777777777777777777777777777777777777777777777' \
		'sha256:8888888888888888888888888888888888888888888888888888888888888888' \
		'9999999999999999999999999999999999999999999999999999999999999999' || return 1

	# Receipt durability precedes intent retirement; direct prepare resumes by clearing it after runtime checks.
	platform_cutover_validate_final_env_and_attestation() { trace+='F'; }
	platform_cutover_assert_phase_a_runtime_from_receipt() { trace+='I'; }
	platform_cutover_verify_phase_a_gateway_routes() { trace+='V'; }
	platform_cutover_preflight_final_env_and_phase_a || return 1
	[[ "$trace" == FIV && ! -e "$platform_phase_a_intent" && ! -L "$platform_phase_a_intent" ]] || return 1

	# A mismatched stale intent is never silently retired.
	PLATFORM_FRONTEND_REVISION="$other"
	platform_cutover_write_phase_a_intent "$env_sha" "$routes_sha" || return 1
	PLATFORM_FRONTEND_REVISION='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	! platform_cutover_finalize_phase_a_intent >/dev/null 2>&1 || return 1
	[[ -f "$platform_phase_a_intent" && ! -L "$platform_phase_a_intent" ]] || return 1
	rm -f -- "$platform_phase_a_intent"
	platform_cutover_write_phase_a_intent "$env_sha" "$routes_sha" || return 1
	platform_cutover_finalize_phase_a_intent || return 1
	[[ ! -e "$platform_phase_a_intent" && ! -L "$platform_phase_a_intent" ]] || return 1

	prepare_source="$(declare -f platform_cutover_prepare)"
	readiness_source="$(declare -f platform_cutover_prepare_billing_readiness)"
	finalizer_source="$(declare -f platform_cutover_finalize_phase_a_intent platform_cutover_finalize_phase_a_artifacts)"
	[[ "$prepare_source" == *'platform_cutover_preflight_final_env_and_phase_a'*'platform_cutover_run_core_migration'*'platform_database_prepare'* &&
		"$readiness_source" == *'platform_cutover_write_phase_a_intent'*'platform_cutover_install_phase_a_env_artifact'*'platform_cutover_write_billing_readiness_receipt'*'platform_cutover_finalize_phase_a_intent'* &&
		"$finalizer_source" == *'platform_cutover_validate_billing_readiness_receipt_file'*'rm -f -- "$platform_phase_a_intent"'*'sync -f "$directory"'* &&
		"$finalizer_source" == *'platform_cutover_finalize_phase_a_intent "$archive"'*'rm -f -- "$platform_billing_readiness_receipt"'* ]] || return 1
)

platform_cutover_self_test_guard_checkout_revision() (
	local expected='0123456789abcdef0123456789abcdef01234567' directory
	local other='89abcdef0123456789abcdef0123456789abcdef' test_phase retired=false
	directory="$(realpath -- "$(mktemp -d)")" || return 1
	trap 'rm -rf -- "$directory"' EXIT
	platform_billing_readiness_receipt="$directory/.platform-billing-readiness-v1"
	platform_phase_a_intent="$directory/.platform-phase-a-intent-v1"
	platform_phase_a_env_artifact="$directory/.platform-phase-a-env-v1"
	platform_cutover_current_phase() { printf '%s\n' "$test_phase"; }
	platform_cutover_marker_value() { [[ "$1" == revision ]] && printf '%s\n' "$expected"; }
	platform_cutover_assert_phase_a_artifacts_retired() { [[ "$retired" == true ]]; }
	test_phase=absent
	platform_cutover_guard_checkout_revision "$other" || return 1
	printf 'receipt\n' >"$platform_billing_readiness_receipt"
	platform_cutover_validate_billing_readiness_receipt() { return 0; }
	platform_cutover_billing_readiness_value() { [[ "$1" == revision ]] && printf '%s\n' "$expected"; }
	platform_cutover_guard_checkout_revision "$expected" || return 1
	! platform_cutover_guard_checkout_revision "$other" || return 1
	rm -f -- "$platform_billing_readiness_receipt"
	printf 'intent\n' >"$platform_phase_a_intent"
	platform_cutover_validate_phase_a_intent() { return 0; }
	platform_cutover_phase_a_intent_value() { [[ "$1" == revision ]] && printf '%s\n' "$expected"; }
	platform_cutover_guard_checkout_revision "$expected" || return 1
	! platform_cutover_guard_checkout_revision "$other" || return 1
	printf 'artifact\n' >"$platform_phase_a_env_artifact"
	platform_cutover_validate_phase_a_env_against_intent() { return 0; }
	platform_cutover_guard_checkout_revision "$expected" || return 1
	rm -f -- "$platform_phase_a_intent" "$platform_phase_a_env_artifact"
	test_phase=complete
	platform_cutover_guard_checkout_revision "$expected" || return 1
	! platform_cutover_guard_checkout_revision "$other" || return 1
	retired=true
	platform_cutover_guard_checkout_revision "$other" || return 1
	test_phase=aborted
	platform_cutover_guard_checkout_revision "$expected" || return 1
	! platform_cutover_guard_checkout_revision "$other" || return 1
	test_phase=consumer-v2
	platform_cutover_guard_checkout_revision "$expected" || return 1
	! platform_cutover_guard_checkout_revision "$other"
)

platform_cutover_self_test_consumer_v2_crash_resume() (
	local trace='' mode=valid route_state=fenced status_source
	local container='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
	EXPECTED_REVISION='0123456789abcdef0123456789abcdef01234567'
	platform_cutover_revalidate_phase() {
		trace+='r'
		[[ "$1" == consumer-v2 && "$mode" != partial ]]
	}
	platform_cutover_verify_billing_offer_v2_boundary() {
		trace+='t'
		[[ "$mode" != tampered ]]
	}
	platform_cutover_ensure_gateway_boundary() { trace+='g'; }
	platform_cutover_retire_settings_projection() { trace+='q'; }
	platform_cutover_ensure_core_api_candidate() { printf '%s\n' "$container"; }
	platform_cutover_assert_core_routes() {
		[[ "$2" == "$container" ]] || return 1
		case "$1" in
		fenced) trace+='F'; [[ "$route_state" == fenced ]] ;;
		retired) trace+='R'; [[ "$route_state" == retired ]] ;;
		*) return 1 ;;
		esac
	}
	platform_cutover_gateway_boundary_is_ready() { trace+='b'; }
	platform_cutover_validate_frontend_attestation() { trace+='A'; [[ "$1" == 1 ]]; }
	platform_cutover_marker_value() {
		case "$1" in
		generation) printf '1\n' ;;
		snapshot_sha256) printf '%064d\n' 0 ;;
		source_fingerprint) printf '%064d\n' 1 ;;
		source_high_watermark) printf '7\n' ;;
		*) return 1 ;;
		esac
	}
	platform_cutover_cli() {
		trace+='a'
		[[ "$*" == "core activate --revision $EXPECTED_REVISION --file /evidence/platform-snapshot.json --sha256 $(printf '%064d' 0) --fingerprint $(printf '%064d' 1) --high-watermark 7" ]] || return 1
		route_state=retired
	}
	platform_cutover_rewrite_phase() { trace+='w'; [[ "$1" == core-active ]]; }
	platform_cutover_advance_consumer_v2 || return 1
	platform_cutover_advance_consumer_v2 || return 1
	[[ "$trace" == rgqFtAaRbwrgqFRtAaRbw ]] || return 1
	mode=partial
	trace=''
	! platform_cutover_advance_consumer_v2 >/dev/null 2>&1 || return 1
	[[ "$trace" == r ]] || return 1
	mode=tampered
	trace=''
	! platform_cutover_advance_consumer_v2 >/dev/null 2>&1 || return 1
	[[ "$trace" == rgqFRt ]] || return 1
	mode=route-partial
	route_state=partial
	trace=''
	! platform_cutover_advance_consumer_v2 >/dev/null 2>&1 || return 1
	[[ "$trace" == rgqFR ]] || return 1
	status_source="$(declare -f platform_cutover_status)"
	[[ "$status_source" == *'const exactFrozenCore ='* &&
		"$status_source" == *'const exactActiveCore ='* &&
		"$status_source" == *'phase === "consumer-v2" && !exactFrozenCore && !exactActiveCore'* ]]
)

platform_cutover_self_test_target_active_crash_resume() (
	local trace='' mode=valid
	platform_cutover_revalidate_phase() { trace+='r'; [[ "$1" == target-active ]]; }
	platform_cutover_marker_value() { [[ "$1" == generation ]] && printf '1\n'; }
	platform_cutover_validate_frontend_attestation() { trace+='A'; [[ "$1" == 1 ]]; }
	platform_cutover_ensure_gateway_boundary() { trace+='g'; }
	platform_cutover_retire_settings_projection() {
		trace+='q'
		[[ "$1" == hold-billing && "$mode" != topology-failed ]]
	}
	platform_cutover_switch_billing_offer_consumer_v2() {
		trace+='s'
		[[ "$mode" != switch-failed ]]
	}
	platform_cutover_rewrite_phase() { trace+='w'; [[ "$1" == consumer-v2 ]]; }
	platform_cutover_advance_target_active || return 1
	platform_cutover_advance_target_active || return 1
	[[ "$trace" == rAgqswrAgqsw ]] || return 1
	mode=topology-failed
	trace=''
	! platform_cutover_advance_target_active >/dev/null 2>&1 || return 1
	[[ "$trace" == rAgq ]] || return 1
	mode=switch-failed
	trace=''
	! platform_cutover_advance_target_active >/dev/null 2>&1 || return 1
	[[ "$trace" == rAgqs ]]
)

platform_cutover_self_test_core_migration_ledger() (
	local prior repository before after wrong extra incomplete source readiness_source migration_source
	prior='20260823000000_prior_platform_dependency'
	repository="$prior|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
$PLATFORM_CORE_PREPARE_MIGRATION|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	before="$prior|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|applied"
	after="$before
$PLATFORM_CORE_PREPARE_MIGRATION|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|applied"
	platform_cutover_core_migration_ledger_is_exact before "$repository" "$before" || return 1
	platform_cutover_core_migration_ledger_is_exact after "$repository" "$after" || return 1
	! platform_cutover_core_migration_ledger_is_exact before "$repository" "$after" || return 1
	! platform_cutover_core_migration_ledger_is_exact after "$repository" "$before" || return 1
	wrong="${before/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc}"
	! platform_cutover_core_migration_ledger_is_exact before "$repository" "$wrong" || return 1
	extra="$before
20260822000000_unknown|dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd|applied"
	! platform_cutover_core_migration_ledger_is_exact before "$repository" "$extra" || return 1
	incomplete="${before/applied/incomplete}"
	! platform_cutover_core_migration_ledger_is_exact before "$repository" "$incomplete" || return 1
	readiness_source="$(declare -f platform_cutover_prepare_billing_readiness)"
	migration_source="$(declare -f platform_cutover_run_core_migration)"
	source="$(declare -f platform_cutover_core_migration_ledger_state \
		platform_cutover_assert_core_migration_ledger \
		platform_cutover_assert_core_post_migration_catalog)"
	[[ "$readiness_source" == *'build --pull --provenance=false'*'platform_cutover_assert_core_migration_ledger before'* &&
		"$migration_source" == *'ledger_state="$(platform_cutover_core_migration_ledger_state)"'* &&
		"$migration_source" == *'before)'*'--profile migration run --rm --no-deps migrate'* &&
		"$migration_source" == *'after)'*'platform_cutover_assert_core_migration_ledger after'*'platform_cutover_assert_core_post_migration_catalog "$catalog_mode"'* &&
		"$source" == *'expected_constraints'*'actual_constraints'*'expected_triggers'*'actual_triggers'* &&
		"$source" == *'constraint_entry.convalidated'*'constraint_entry.conkey'*'pg_get_constraintdef'* &&
		"$source" == *'procedure_namespace.nspname'*'trigger_entry.tgattr'* &&
		"$source" == *"('updated_at', 20, 'pg_catalog', 'timestamp', 3"* &&
		"$source" == *'expected_functions'*'actual_functions'*'expected_table_acl'*'actual_table_acl'* ]] || return 1

	local simulated_ledger_state=before catalog_mode log
	log="$(mktemp)" || return 1
	trap 'rm -f -- "$log"' EXIT
	database_restore_guard_assert_before_mutation() { return 0; }
	assert_core_database_production_boundary() { return 0; }
	platform_cutover_expected_release_image_id() { printf 'sha256:%064d\n' 0; }
	platform_cutover_assert_release_image_id() { return 0; }
	platform_cutover_bind_database_url_parser_image() { return 0; }
	platform_cutover_core_migration_ledger_state() {
		printf s >>"$log"
		printf '%s\n' "$simulated_ledger_state"
	}
	platform_cutover_compose_with_receipt_images() {
		[[ "$*" == '--profile migration run --rm --no-deps migrate' ]] || return 1
		printf m >>"$log"
		simulated_ledger_state=after
	}
	platform_cutover_assert_core_migration_ledger() {
		[[ "$1" == after && "$simulated_ledger_state" == after ]] || return 1
		printf l >>"$log"
	}
	platform_cutover_assert_core_post_migration_catalog() {
		[[ "$1" == "$catalog_mode" ]] || return 1
		printf c >>"$log"
	}
	catalog_mode=initial
	platform_cutover_run_core_migration initial >/dev/null || return 1
	[[ "$(<"$log")" == smlc && "$simulated_ledger_state" == after ]] || return 1
	: >"$log"
	platform_cutover_run_core_migration initial >/dev/null || return 1
	[[ "$(<"$log")" == slc ]] || return 1
	: >"$log"
	catalog_mode=structure
	platform_cutover_run_core_migration structure >/dev/null || return 1
	[[ "$(<"$log")" == slc ]] || return 1
	: >"$log"
	simulated_ledger_state=before
	! platform_cutover_run_core_migration structure >/dev/null 2>&1 || return 1
	[[ "$(<"$log")" == s ]]
)

platform_cutover_self_test_phase_a_retirement() (
	local directory evidence old_revision new_revision old_image new_image artifact_sha archive
	directory="$(realpath -- "$(mktemp -d)")" || return 1
	trap 'rm -rf -- "$directory"' EXIT
	old_revision='0123456789abcdef0123456789abcdef01234567'
	new_revision='89abcdef0123456789abcdef0123456789abcdef'
	old_image='sha256:1111111111111111111111111111111111111111111111111111111111111111'
	new_image='sha256:2222222222222222222222222222222222222222222222222222222222222222'
	platform_billing_readiness_receipt="$directory/.platform-billing-readiness-v1"
	platform_phase_a_env_artifact="$directory/.platform-phase-a-env-v1"
	platform_evidence_parent="$directory/.production-evidence"
	evidence="$platform_evidence_parent/platform-$old_revision-generation-1"
	mkdir -- "$platform_evidence_parent" "$evidence" || return 1
	chmod 700 "$platform_evidence_parent" "$evidence" || return 1
	printf 'artifact\n' >"$platform_phase_a_env_artifact"
	chmod 600 "$platform_phase_a_env_artifact" || return 1
	artifact_sha="$(platform_cutover_sha256 "$platform_phase_a_env_artifact")" || return 1
	EXPECTED_REVISION="$old_revision"
	PLATFORM_FRONTEND_REVISION='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	PLATFORM_FRONTEND_RUNTIME_CHALLENGE='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	PLATFORM_FRONTEND_ORIGIN='https://winwidget.ru'
	PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
	platform_cutover_write_billing_readiness_receipt \
		"$artifact_sha" \
		'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' \
		'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' \
		'3333333333333333333333333333333333333333333333333333333333333333' \
		"$old_image" \
		'4444444444444444444444444444444444444444444444444444444444444444' \
		'5555555555555555555555555555555555555555555555555555555555555555' \
		'sha256:6666666666666666666666666666666666666666666666666666666666666666' \
		'7777777777777777777777777777777777777777777777777777777777777777' \
		'8888888888888888888888888888888888888888888888888888888888888888' \
		'sha256:9999999999999999999999999999999999999999999999999999999999999999' \
		'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' || return 1
	platform_cutover_current_phase() { printf 'complete\n'; }
	platform_database_current_phase() { printf 'complete\n'; }
	platform_cutover_marker_value() {
		case "$1" in
		revision) printf '%s\n' "$old_revision" ;;
		generation) printf '1\n' ;;
		image_id) printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\n' ;;
		database_id) printf '01234567-89ab-4cde-8fab-0123456789ab\n' ;;
		database_system_identifier) printf '123456789\n' ;;
		*) return 1 ;;
		esac
	}
	platform_database_marker_value() {
		case "$1" in
		revision) printf '%s\n' "$old_revision" ;;
		generation) printf '1\n' ;;
		image_id) printf 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\n' ;;
		database_id) printf '01234567-89ab-4cde-8fab-0123456789ab\n' ;;
		database_system_identifier) printf '123456789\n' ;;
		*) return 1 ;;
		esac
	}

	[[ "$(platform_cutover_expected_release_image_id core)" == "$old_image" ]] || return 1
	EXPECTED_REVISION="$new_revision"
	! platform_cutover_expected_release_image_id core >/dev/null 2>&1 || return 1
	platform_cutover_guard_checkout_revision "$old_revision" || return 1
	! platform_cutover_guard_checkout_revision "$new_revision" || return 1
	EXPECTED_REVISION="$old_revision"
	platform_cutover_finalize_phase_a_artifacts || return 1
	archive="$evidence/platform-phase-a-readiness-v1.receipt"
	platform_cutover_assert_phase_a_artifacts_retired || return 1
	[[ "$(platform_cutover_expected_release_image_id core)" == "$old_image" ]] || return 1
	platform_cutover_guard_checkout_revision "$new_revision" || return 1

	EXPECTED_REVISION="$new_revision"
	platform_database_docker() {
		[[ "$*" == "image inspect --format {{.Id}} winwidget-api:git-$new_revision" ]] || return 1
		printf '%s\n' "$new_image"
	}
	[[ "$(platform_cutover_expected_release_image_id core)" == "$new_image" ]] || return 1

	# Crash after sealing the hard-link archive but before unlinking active artifacts.
	ln -- "$archive" "$platform_billing_readiness_receipt" || return 1
	printf 'artifact\n' >"$platform_phase_a_env_artifact"
	chmod 600 "$platform_phase_a_env_artifact" || return 1
	platform_cutover_finalize_phase_a_artifacts || return 1
	platform_cutover_assert_phase_a_artifacts_retired || return 1

	# Crash after unlinking the active receipt but before deleting its secret env artifact.
	printf 'artifact\n' >"$platform_phase_a_env_artifact"
	chmod 600 "$platform_phase_a_env_artifact" || return 1
	platform_cutover_finalize_phase_a_artifacts || return 1
	platform_cutover_finalize_phase_a_artifacts || return 1

	# Receipt without its artifact, symlinks, and a different inode fail before deletion.
	ln -- "$archive" "$platform_billing_readiness_receipt" || return 1
	! platform_cutover_finalize_phase_a_artifacts >/dev/null 2>&1 || return 1
	[[ -f "$platform_billing_readiness_receipt" ]] || return 1
	rm -f -- "$platform_billing_readiness_receipt"
	ln -s -- "$archive" "$platform_billing_readiness_receipt"
	printf 'artifact\n' >"$platform_phase_a_env_artifact"
	chmod 600 "$platform_phase_a_env_artifact" || return 1
	! platform_cutover_finalize_phase_a_artifacts >/dev/null 2>&1 || return 1
	[[ -L "$platform_billing_readiness_receipt" && -f "$platform_phase_a_env_artifact" ]] || return 1
	rm -f -- "$platform_billing_readiness_receipt"
	cp -- "$archive" "$platform_billing_readiness_receipt"
	chmod 600 "$platform_billing_readiness_receipt" || return 1
	! platform_cutover_finalize_phase_a_artifacts >/dev/null 2>&1 || return 1
	[[ -f "$platform_billing_readiness_receipt" && -f "$platform_phase_a_env_artifact" ]] || return 1
	rm -f -- "$platform_billing_readiness_receipt" "$platform_phase_a_env_artifact"

	ln -- "$archive" "$platform_billing_readiness_receipt" || return 1
	printf 'artifact\n' >"$platform_phase_a_env_artifact"
	chmod 600 "$platform_phase_a_env_artifact" || return 1
	platform_cutover_current_phase() { printf 'core-active\n'; }
	! platform_cutover_finalize_phase_a_artifacts >/dev/null 2>&1 || return 1
	[[ -f "$platform_billing_readiness_receipt" && -f "$platform_phase_a_env_artifact" ]] || return 1
	platform_cutover_current_phase() { printf 'complete\n'; }
	platform_cutover_finalize_phase_a_artifacts
)

platform_cutover_self_test_container_env_hash() (
	local container payload expected actual
	container='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
	platform_database_docker() {
		[[ "$1" == inspect && "$2" == --format && "$4" == "$container" ]] || return 1
		printf '%s' "$payload"
	}

	payload=$'SECOND=two\nFIRST=one\nTOKEN=left=right\n\n'
	expected="$(printf '%s\n' 'FIRST=one' 'SECOND=two' 'TOKEN=left=right' |
		LC_ALL=C sort | platform_cutover_sha256 /dev/stdin)" || return 1
	actual="$(platform_cutover_container_env_sha256 "$container" -)" || return 1
	[[ "$actual" == "$expected" ]] || return 1

	payload=$'GATEWAY_ROUTES_JSON=[]\nFIRST=one\n\n'
	expected="$(printf '%s\n' 'FIRST=one' | platform_cutover_sha256 /dev/stdin)" || return 1
	actual="$(platform_cutover_container_env_sha256 "$container" GATEWAY_ROUTES_JSON)" || return 1
	[[ "$actual" == "$expected" ]] || return 1

	for payload in \
		$'FIRST=one\n' \
		$'FIRST=one\n\nSECOND=two\n' \
		$'FIRST=one\n\n\n' \
		$'FIRST=one\nFIRST=two\n\n' \
		$'invalid=one\n\n' \
		$'MISSING_EQUALS\n\n'; do
		! platform_cutover_container_env_sha256 "$container" - >/dev/null 2>&1 || return 1
	done
)

platform_cutover_self_test() {
	platform_cutover_transition_allowed absent prepared
	platform_cutover_transition_allowed prepared source-fenced
	platform_cutover_transition_allowed restore-verified target-active
	platform_cutover_transition_allowed target-active consumer-v2
	platform_cutover_transition_allowed consumer-v2 core-active
	! platform_cutover_transition_allowed target-active core-active
	platform_cutover_transition_allowed core-active complete
	! platform_cutover_transition_allowed target-active aborted
	platform_cutover_self_test_restore_resume
	platform_cutover_self_test_bound_hash_tamper
	platform_cutover_self_test_unbound_dump_resume
	platform_cutover_self_test_complete_noop
	platform_cutover_self_test_billing_offer_topology
	platform_cutover_self_test_settings_projection_topology
	platform_cutover_self_test_core_route_matrix
	platform_cutover_self_test_billing_settings_boundary
	platform_cutover_self_test_billing_readiness
	platform_cutover_self_test_phase_a_intent
	platform_cutover_self_test_guard_checkout_revision
	platform_cutover_self_test_target_active_crash_resume
	platform_cutover_self_test_consumer_v2_crash_resume
	platform_cutover_self_test_core_migration_ledger
	platform_cutover_self_test_phase_a_retirement
	platform_cutover_self_test_container_env_hash
	local source prepare_source continue_source status_source dump_source
	prepare_source="$(declare -f platform_cutover_prepare)"
	[[ "$prepare_source" == *'phase="$(platform_cutover_current_phase)"'*'[[ "$phase" != aborted ]]'*'platform_database_require_inputs'*'platform_cutover_preflight_final_env_and_phase_a'*'platform_cutover_run_core_migration'*'platform_database_prepare'* &&
		"$prepare_source" == *'platform_cutover_assert_core_image'*'platform_cutover_assert_billing_worker_image'* &&
		"$prepare_source" != *'build --pull --provenance=false'* ]] || return 1
	source="$(declare -f platform_cutover_prepare platform_cutover_continue \
		platform_cutover_abort platform_cutover_validate_gateway_manifest \
		platform_cutover_wait_billing_offer_boundary platform_cutover_cli \
		platform_cutover_write_marker platform_cutover_run_restore \
		platform_cutover_revalidate_phase platform_cutover_verify_complete_noop \
		platform_cutover_switch_billing_offer_consumer_v2 \
		platform_cutover_verify_billing_offer_v2_boundary \
		platform_cutover_retire_billing_offer_v1 \
		platform_cutover_retire_settings_projection \
		platform_cutover_ensure_billing_api_candidate \
		platform_cutover_assert_gateway_runtime \
		platform_cutover_assert_gateway_receipt_identity \
		platform_cutover_verify_runtime_and_routes \
		platform_cutover_archived_readiness_receipt \
		platform_cutover_finalize_phase_a_artifacts \
		platform_cutover_assert_phase_a_artifacts_retired)"
	continue_source="$(declare -f platform_cutover_continue)"
	status_source="$(declare -f platform_cutover_status)"
	dump_source="$(declare -f platform_cutover_dump platform_cutover_revalidate_restore_binding)"
	[[ "$continue_source" == *'if [[ "$phase" == prepared ]]'*'platform_cutover_ensure_core_api_candidate'*'platform_cutover_assert_core_routes removed'*'platform_cutover_cli core fence'*'platform_cutover_assert_core_routes fenced'* &&
		"$continue_source" == *'if [[ "$phase" == target-active ]]'*'platform_cutover_advance_target_active'*"phase='consumer-v2'"* &&
		"$continue_source" == *'if [[ "$phase" == consumer-v2 ]]'*'platform_cutover_advance_consumer_v2'* ]] || return 1
	[[ "$continue_source" != *'platform_cutover_dump DATABASE_BACKUP_URL'* ]] || return 1
	[[ "$status_source" == *'restore-verified:active'* &&
		"$status_source" == *'const exactOpenPreparedCore ='* &&
		"$status_source" == *'const resumableFencedPreparedCore ='* &&
		"$status_source" == *'!exactFreshTarget && !exactImportedTarget'* ]] || return 1
	[[ "$dump_source" == *'"$expected" == pending || "$existing" == "$expected"'* &&
		"$dump_source" == *'Unbound Platform restore evidence exists without its dump.'* ]] || return 1
	local advance_source
	advance_source="$(declare -f platform_cutover_advance_consumer_v2)"
	[[ "$advance_source" == *'platform_cutover_revalidate_phase consumer-v2'*'platform_cutover_ensure_gateway_boundary'*'platform_cutover_retire_settings_projection'*'platform_cutover_ensure_core_api_candidate'*'platform_cutover_assert_core_routes fenced'*'platform_cutover_assert_core_routes retired'*'platform_cutover_verify_billing_offer_v2_boundary'*'platform_cutover_cli core activate'*'--file /evidence/platform-snapshot.json'*'platform_cutover_assert_core_routes retired'*'platform_cutover_gateway_boundary_is_ready'*'platform_cutover_rewrite_phase core-active'* ]] || return 1
	[[ "$source" == *'platform-imported-restore.json'* &&
		"$source" == *'platform-active-restore.json'* &&
		"$source" == *'imported_restore_evidence_sha256'* &&
		"$source" == *'active_restore_evidence_sha256'* &&
		"$source" == *'platform_cutover_validate_restore_evidence'* &&
		"$source" == *'platform_cutover_revalidate_snapshot_and_anchors'* &&
		"$source" == *'platform_cutover_verify_complete_noop'* &&
		"$source" == *'generation'* &&
		"$source" == *'ABORT PLATFORM CUTOVER'* &&
		"$source" == *'forward-only'* &&
		"$source" == *'api-gateway'* &&
		"$source" == *'PLATFORM_MIGRATION_DATABASE_URL'* &&
		"$source" == *'validate-shadow'* &&
		"$source" == *'core preflight'* &&
		"$source" == *'platform_cutover_assert_core_database_urls_match'* &&
		"$source" == *'platform_cutover_wait_billing_offer_boundary'* &&
		"$source" == *'platform_cutover_verify_billing_offer_v2_boundary'* &&
		"$source" == *'platform_cutover_ensure_billing_api_candidate'* &&
		"$source" == *'/api/v1/billing-settings/public'*'/api/v1/billing-settings/admin'* &&
		"$source" == *'winwidget.billing.offer.v2'* &&
		"$source" == *'delete_queue'*'--if-empty'*'--if-unused'* &&
		"$source" == *'acquire_production_deploy_lock'* &&
		"$source" == *'platform_cutover_finalize_phase_a_artifacts'* &&
		"$source" == *'platform_cutover_assert_phase_a_artifacts_retired'* &&
		"$source" == *'platform-phase-a-readiness-v1.receipt'* &&
		"$source" == *'ln -- "$platform_billing_readiness_receipt" "$archive"'* &&
		"$source" == *'rm -f -- "$platform_billing_readiness_receipt"'* &&
		"$source" == *'rm -f -- "$platform_phase_a_env_artifact"'* &&
		"$source" == *'sync -f'* ]]
	printf 'platform_cutover_production_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--prepare-billing-readiness)
		[[ $# -eq 1 ]] || exit 1
		platform_cutover_prepare_billing_readiness
		;;
	--prepare)
		[[ $# -eq 1 ]] || exit 1
		platform_cutover_prepare
		;;
	--cutover)
		[[ $# -eq 1 ]] || exit 1
		[[ "${PLATFORM_CONFIRMATION:-}" == 'CUTOVER PLATFORM OWNERSHIP' ]] ||
			platform_cutover_fail 'Platform cutover requires exact confirmation.' || exit 1
		platform_cutover_continue
		;;
	--forward-recovery)
		[[ $# -eq 1 ]] || exit 1
		[[ "${PLATFORM_CONFIRMATION:-}" == 'CUTOVER PLATFORM OWNERSHIP' ]] || exit 1
		[[ "$(platform_cutover_current_phase)" =~ ^(restore-verified|target-active|consumer-v2|core-active)$ ]] ||
			platform_cutover_fail 'Platform forward recovery has no forward-only boundary to finish.' || exit 1
		platform_cutover_continue
		;;
	--abort)
		[[ $# -eq 1 ]] || exit 1
		platform_cutover_abort
		;;
	--status)
		[[ $# -eq 1 ]] || exit 1
		platform_cutover_status
		;;
	--self-test)
		[[ $# -eq 1 ]] || exit 1
		platform_cutover_self_test
		;;
	--guard-before-fetch-revision | --guard-before-checkout-revision)
		[[ $# -eq 2 ]] || exit 1
		platform_cutover_guard_checkout_revision "$2"
		;;
	*) platform_cutover_fail 'Usage: platform-cutover-production.sh --prepare-billing-readiness|--prepare|--cutover|--forward-recovery|--abort|--status|--self-test|--guard-before-fetch-revision <sha>|--guard-before-checkout-revision <sha>' ;;
	esac
fi
