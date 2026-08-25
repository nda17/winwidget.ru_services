#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
server_root="$(cd "$script_dir/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
sql_contract="$server_root/prisma/post-cutover/support/20260824030000_remove_legacy_support_core_source.sql"

# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$server_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/support-cutover-production.sh
source "$server_root/scripts/support-cutover-production.sh"

self_test() {
	local guard_call marker_key_guard

	bash -n "${BASH_SOURCE[0]}"
	test -f "$sql_contract"
	grep -Fq "DROP LEGACY SUPPORT CORE SOURCE" "$sql_contract"
	grep -Fq 'pg_advisory_xact_lock' "$sql_contract"
	grep -Fq 'marker."ownership" <> '\''SUPPORT'\''' "$sql_contract"
	grep -Fq 'marker."active_task_count" <> 0' "$sql_contract"
	for immutable_input in cleanup_revision target_database_id \
		source_database_system_id source_fingerprint source_snapshot_sha256 \
		source_mapping_count source_high_watermark; do
		grep -Fq "$immutable_input IS NULL" "$sql_contract"
	done
	grep -Fq 'marker."exported_at" IS NULL' "$sql_contract"
	grep -Fq 'marker."activated_at" IS NULL' "$sql_contract"
	grep -Fq 'DROP TABLE "telegram_support_messages"' "$sql_contract"
	grep -Fq 'DROP COLUMN "support_thread_id"' "$sql_contract"
	grep -Fq 'CREATE TABLE "support_core_cleanup_state"' "$sql_contract"
	if grep -RqsF '20260824030000_remove_legacy_support_core_source.sql' \
		"$server_root/prisma/migrations"; then
		echo 'Support cleanup SQL must never be part of initial Prisma migrations.' >&2
		return 1
	fi
	grep -Fq "source \"\$server_root/scripts/production-deploy-lock.sh\"" \
		"${BASH_SOURCE[0]}"
	grep -Fq "source \"\$server_root/scripts/database-restore-production-guard.sh\"" \
		"${BASH_SOURCE[0]}"
	grep -Fq "source \"\$server_root/scripts/support-cutover-production.sh\"" \
		"${BASH_SOURCE[0]}"
	grep -Fq "acquire_production_deploy_lock 'Support Core source cleanup'" \
		"${BASH_SOURCE[0]}"
	guard_call="database_restore_guard_assert_before_""mutation healthy-required \"\$backend_env\""
	[[ "$(grep -Fc "$guard_call" "${BASH_SOURCE[0]}")" == '2' ]] || {
		echo 'Support cleanup must guard restore state before validation and immediately before SQL.' >&2
		return 1
	}
	if grep -Eq 'SUPPORT_CORE_SOURCE_CLEANUP_CORE_[B]ACKUP_(FILE|SHA256)' \
		"${BASH_SOURCE[0]}"; then
		echo 'Support cleanup must not require a retired Core backup.' >&2
		return 1
	fi
	grep -Fq 'support_database_mark_cleanup "$revision"' "${BASH_SOURCE[0]}"
	grep -Fq 'support_cleanup_write_marker complete' "${BASH_SOURCE[0]}"
	marker_key_guard='^[[:space:]]*\[\[ \$# -eq [12] && "\$1" =~ \^\[a-z\]\[a-z0-9_\]\*\$'
	[[ "$(grep -Ec "$marker_key_guard" "${BASH_SOURCE[0]}")" == '2' ]] || {
		echo 'Support cleanup marker keys must permit sha256 fields without allowing unsafe characters.' >&2
		return 1
	}
	grep -Fq '"$current_phase" == '\''complete'\'' || "$current_phase" == "$phase"' \
		"${BASH_SOURCE[0]}"
	printf 'Support Core source cleanup static self-test passed\n'
}

if [[ "${1:-}" == '--self-test' ]]; then
	[[ $# -eq 1 ]]
	self_test
	exit 0
fi
[[ $# -eq 0 ]] || {
	echo 'This script accepts only --self-test.' >&2
	exit 2
}

[[ "${SUPPORT_CORE_SOURCE_CLEANUP_APPROVED:-false}" == 'true' &&
	"${SUPPORT_CORE_SOURCE_CLEANUP_CONFIRMATION:-}" == \
	'DROP LEGACY SUPPORT CORE SOURCE' ]] || {
	echo 'Exact Support Core source cleanup approval is required.' >&2
	exit 1
}

revision="${SUPPORT_CORE_SOURCE_CLEANUP_REVISION:-}"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || {
	echo 'SUPPORT_CORE_SOURCE_CLEANUP_REVISION must be an immutable Git SHA.' >&2
	exit 1
}
EXPECTED_REVISION="$revision"

case "$APP_ROOT" in
/*) [[ "$APP_ROOT" != '/' ]] ;;
*) false ;;
esac || {
	echo 'APP_ROOT must be an absolute scoped production directory.' >&2
	exit 1
}
[[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]] || {
	echo 'Support Core source cleanup requires root on Linux.' >&2
	exit 1
}

backend_env="${BACKEND_ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
[[ -f "$backend_env" && ! -L "$backend_env" ]] || {
	echo 'Canonical backend production env is missing or is a symlink.' >&2
	exit 1
}
file_mode() {
	if [[ "$(uname -s)" == 'Darwin' ]]; then
		stat -f '%Lp' "$1"
	else
		stat -c '%a' "$1"
	fi
}

env_mode="$(file_mode "$backend_env")"
env_owner="$(stat -c '%u:%g' "$backend_env")"
[[ "$env_mode" == '600' && "$env_owner" == '0:0' ]] || {
	echo 'Canonical backend production env must be root-owned mode 0600.' >&2
	exit 1
}
[[ -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" ]] || {
	echo 'Ambient Docker endpoint overrides are forbidden.' >&2
	exit 1
}
[[ "$(docker context show)" == 'default' &&
	"$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" == \
	'unix:///var/run/docker.sock' &&
	"$(docker info --format '{{.OSType}}')" == 'linux' ]] || {
	echo 'The canonical local production Docker daemon is required.' >&2
	exit 1
}
support_release_require_checkout "$server_root" "$revision"

acquire_production_deploy_lock 'Support Core source cleanup'
database_restore_guard_assert_before_mutation healthy-required "$backend_env"
ENV_FILE="$backend_env"
COMPOSE_FILE="$server_root/deploy/docker-compose.prod.yml"
support_database_validate_bound_identity
[[ "$(support_database_marker_value phase)" == 'complete' &&
	( "$(support_database_marker_value cleanup_revision)" == 'pending' ||
		"$(support_database_marker_value cleanup_revision)" == "$revision" ) ]] || {
	echo 'Support cleanup requires its exact completed ownership lifecycle.' >&2
	exit 1
}
support_cutover_validate_images
[[ "$(support_cutover_marker_value phase)" == 'complete' &&
	"$(support_cutover_marker_value revision)" == "$revision" ]] || {
	echo 'Support cleanup requires the exact completed cutover marker.' >&2
	exit 1
}

support_cleanup_compose() {
	support_release_compose "$revision" "$backend_env" "$COMPOSE_FILE" "$@"
}

support_cleanup_marker="$APP_ROOT/deploy/backend/.support-core-cleanup-v1"
support_cleanup_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z][a-z0-9_]*$ && -f "$support_cleanup_marker" &&
		! -L "$support_cleanup_marker" ]] || return 1
	awk -F= -v key="$1" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$support_cleanup_marker"
}

support_cleanup_require_marker_value() {
	[[ $# -eq 2 && "$1" =~ ^[a-z][a-z0-9_]*$ ]] || return 1
	local key="$1" expected="$2" actual
	actual="$(support_cleanup_marker_value "$key")" || {
		printf 'Support cleanup marker read failed: %s\n' "$key" >&2
		return 1
	}
	[[ "$actual" == "$expected" ]] || {
		printf 'Support cleanup marker mismatch: %s\n' "$key" >&2
		return 1
	}
}

support_cleanup_validate_marker() {
	[[ -f "$support_cleanup_marker" && ! -L "$support_cleanup_marker" &&
		"$(stat -c '%u:%g:%a' "$support_cleanup_marker")" == '0:0:600' ]] || return 1
	awk -F= '
		$1 !~ /^(version|phase|cleanup_revision|ownership_revision|migration_sha256|support_backup_sha256|restore_evidence_sha256|target_database_id|source_database_system_id|source_fingerprint|source_snapshot_sha256|source_mapping_count|source_high_watermark|updated_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1]=substr($0, index($0, "=") + 1) }
		END {
			if (seen["version"] != 1 || value["version"] != "1" ||
				seen["phase"] != 1 || value["phase"] !~ /^(verified|complete)$/ ||
				seen["cleanup_revision"] != 1 || value["cleanup_revision"] !~ /^[0-9a-f]{40}$/ ||
				seen["ownership_revision"] != 1 || value["ownership_revision"] != value["cleanup_revision"] ||
				seen["migration_sha256"] != 1 || value["migration_sha256"] !~ /^[0-9a-f]{64}$/ ||
				seen["support_backup_sha256"] != 1 || value["support_backup_sha256"] !~ /^[0-9a-f]{64}$/ ||
				seen["restore_evidence_sha256"] != 1 || value["restore_evidence_sha256"] !~ /^[0-9a-f]{64}$/ ||
				seen["target_database_id"] != 1 || value["target_database_id"] !~ /^[0-9a-f-]{36}$/ ||
				seen["source_database_system_id"] != 1 || value["source_database_system_id"] !~ /^[1-9][0-9]{0,31}$/ ||
				seen["source_fingerprint"] != 1 || value["source_fingerprint"] !~ /^[0-9a-f]{64}$/ ||
				seen["source_snapshot_sha256"] != 1 || value["source_snapshot_sha256"] !~ /^[0-9a-f]{64}$/ ||
				seen["source_mapping_count"] != 1 || value["source_mapping_count"] !~ /^(0|[1-9][0-9]*)$/ ||
				seen["source_high_watermark"] != 1 || value["source_high_watermark"] !~ /^[1-9][0-9]*$/ ||
				seen["updated_at"] != 1 || value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
		}
	' "$support_cleanup_marker"
}

support_cleanup_write_marker() {
	[[ $# -eq 1 && "$1" =~ ^(verified|complete)$ ]] || return 1
	local phase="$1" current_phase temporary="${support_cleanup_marker}.tmp.$$"
	if [[ -e "$support_cleanup_marker" || -L "$support_cleanup_marker" ]]; then
		support_cleanup_validate_marker || {
			printf 'Support cleanup marker structure is invalid.\n' >&2
			return 1
		}
		printf 'Support cleanup marker stage: structure-ok\n' >&2
		support_cleanup_require_marker_value cleanup_revision "$revision" || return 1
		support_cleanup_require_marker_value ownership_revision "$revision" || return 1
		support_cleanup_require_marker_value migration_sha256 "$reviewed_sql_sha256" || return 1
		support_cleanup_require_marker_value support_backup_sha256 \
			"${SUPPORT_CORE_SOURCE_CLEANUP_SUPPORT_BACKUP_SHA256:-}" || return 1
		support_cleanup_require_marker_value restore_evidence_sha256 \
			"${SUPPORT_CORE_SOURCE_CLEANUP_RESTORE_EVIDENCE_SHA256:-}" || return 1
		support_cleanup_require_marker_value target_database_id "$target_database_id" || return 1
		support_cleanup_require_marker_value source_database_system_id "$source_system_id" || return 1
		support_cleanup_require_marker_value source_fingerprint "$source_fingerprint" || return 1
		support_cleanup_require_marker_value source_snapshot_sha256 "$snapshot_sha256" || return 1
		support_cleanup_require_marker_value source_mapping_count "$mapping_count" || return 1
		support_cleanup_require_marker_value source_high_watermark "$high_watermark" || return 1
		printf 'Support cleanup marker stage: immutable-fields-ok\n' >&2
		current_phase="$(support_cleanup_marker_value phase)" || {
			printf 'Support cleanup marker read failed: phase\n' >&2
			return 1
		}
		if [[ "$current_phase" == 'complete' || "$current_phase" == "$phase" ]]; then
			printf 'Support cleanup marker stage: idempotent-phase-ok\n' >&2
			return 0
		fi
	fi
	{
		printf 'version=1\nphase=%s\n' "$phase"
		printf 'cleanup_revision=%s\nownership_revision=%s\n' "$revision" "$revision"
		printf 'migration_sha256=%s\nsupport_backup_sha256=%s\nrestore_evidence_sha256=%s\n' \
			"$reviewed_sql_sha256" "${SUPPORT_CORE_SOURCE_CLEANUP_SUPPORT_BACKUP_SHA256:-}" \
			"${SUPPORT_CORE_SOURCE_CLEANUP_RESTORE_EVIDENCE_SHA256:-}"
		printf 'target_database_id=%s\nsource_database_system_id=%s\n' \
			"$target_database_id" "$source_system_id"
		printf 'source_fingerprint=%s\nsource_snapshot_sha256=%s\n' \
			"$source_fingerprint" "$snapshot_sha256"
		printf 'source_mapping_count=%s\nsource_high_watermark=%s\n' \
			"$mapping_count" "$high_watermark"
		printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$support_cleanup_marker"
	support_cleanup_validate_marker || {
		printf 'Support cleanup marker post-write validation failed.\n' >&2
		return 1
	}
	printf 'Support cleanup marker stage: post-write-ok\n' >&2
}

core_image="$support_cutover_core_image_id"
support_image="$support_cutover_support_image_id"
restore_image_ref="${SUPPORT_CORE_SOURCE_CLEANUP_RESTORE_IMAGE:-winwidget-database-restore:git-$revision}"
restore_image="$(docker image inspect --format '{{.Id}}' "$restore_image_ref")"
gateway_image="$support_cutover_gateway_image_id"
[[ "$restore_image" =~ ^sha256:[0-9a-f]{64}$ &&
	"$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' "$restore_image")" == "$revision|root" ]] || {
	echo 'Cleanup restore image identity mismatch.' >&2
	exit 1
}
for image in "$core_image" "$support_image" "$restore_image" "$gateway_image"; do
	image_revision="$(
		docker image inspect \
			--format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
			"$image"
	)"
	[[ "$image_revision" == "$revision" ]] || {
		echo "Cleanup image revision mismatch: $image" >&2
		exit 1
	}
done

docker run --rm --network none --entrypoint node "$core_image" -e '
const fs = require("node:fs");
for (const file of [
  "dist/src/telegram-bot/telegram-bot.service.js",
  "dist/src/telegram-bot/telegram-bot.controller.js",
]) {
  const source = fs.readFileSync(file, "utf8");
  for (const forbidden of [
    "support-webhook", "TELEGRAM_SUPPORT_BOT", "handleSupportWebhook",
    "telegramSupportMessage", "setImmediate",
  ]) if (source.includes(forbidden)) {
    throw new Error(`Cleanup Core image retains Support runtime fallback: ${forbidden}`);
  }
}
fs.accessSync("dist/src/support-cutover-main.js");
'

support_cleanup_compose stop -t 90 api-gateway api
if [[ -n "$(support_cleanup_compose ps --status running -q api)" ||
	-n "$(support_cleanup_compose ps --status running -q api-gateway)" ]]; then
	echo 'Core API must be stopped before the destructive Support source cleanup.' >&2
	exit 1
fi
for service in support-api support-worker support-outbox-publisher; do
	[[ -n "$(support_cleanup_compose ps --status running -q "$service")" ]] || {
		echo "Canonical Support role is not running: $service" >&2
		exit 1
	}
done

core_status="$(
	docker run --rm --network host --env-file "$backend_env" \
		--entrypoint node "$core_image" dist/src/support-cutover-main.js status
)"
support_status="$(
	docker run --rm --network host --env-file "$backend_env" \
		--entrypoint node "$support_image" dist/src/cutover/main.js status
)"
attestation="$(
	printf '%s\n%s\n' "$core_status" "$support_status" |
		docker run --rm -i --network none -e "EXPECTED_REVISION=$revision" \
			--entrypoint node "$support_image" -e '
const { readFileSync } = require("node:fs");
const [core, target] = readFileSync(0, "utf8").trim().split("\n").map(JSON.parse);
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
if (
  core.ownership !== "SUPPORT" || core.admissionEnabled !== false ||
  core.reconcilerEnabled !== false || core.activeTaskCount !== 0 ||
  core.sourceRevision !== process.env.EXPECTED_REVISION ||
  core.ownershipRevision !== process.env.EXPECTED_REVISION ||
  target.phase !== "ACTIVE" || target.sourceRevision !== process.env.EXPECTED_REVISION ||
  target.ownershipRevision !== process.env.EXPECTED_REVISION ||
  !uuid(target.databaseId) ||
  core.sourceDatabaseSystemId !== target.sourceDatabaseSystemId ||
  core.sourceFingerprint !== target.sourceFingerprint ||
  core.sourceSnapshotSha256 !== target.sourceSnapshotSha256 ||
  core.sourceMappingCount !== String(target.counts?.mappings) ||
  core.sourceHighWatermark !== target.sourceHighWatermark ||
  !hash(core.sourceFingerprint) || !hash(core.sourceSnapshotSha256)
) throw new Error("Support ownership attestation is not exact");
process.stdout.write([
  target.databaseId, core.sourceDatabaseSystemId, core.sourceFingerprint,
  core.sourceSnapshotSha256, core.sourceMappingCount, core.sourceHighWatermark,
].join("\t"));
'
)"
IFS=$'\t' read -r target_database_id source_system_id source_fingerprint \
	snapshot_sha256 mapping_count high_watermark <<<"$attestation"

verify_evidence() {
	local label="$1" file="$2" expected="$3" actual mode
	[[ "$expected" =~ ^[0-9a-f]{64}$ && -f "$file" && ! -L "$file" ]] || {
		echo "$label cleanup evidence is missing or invalid." >&2
		return 1
	}
	mode="$(file_mode "$file")"
	[[ "$mode" == '600' ]] || {
		echo "$label cleanup evidence must have mode 0600." >&2
		return 1
	}
	actual="$(sha256sum "$file" | awk '{print $1}')"
	[[ "$actual" == "$expected" ]] || {
		echo "$label cleanup evidence SHA-256 mismatch." >&2
		return 1
	}
}

verify_evidence 'Support backup' \
	"${SUPPORT_CORE_SOURCE_CLEANUP_SUPPORT_BACKUP_FILE:-$APP_ROOT/deploy/backend/support-core-cleanup-support-backup-v1.dump}" \
	"${SUPPORT_CORE_SOURCE_CLEANUP_SUPPORT_BACKUP_SHA256:-}"
verify_evidence 'clean restore rehearsal' \
	"${SUPPORT_CORE_SOURCE_CLEANUP_RESTORE_EVIDENCE_FILE:-$APP_ROOT/deploy/backend/.support-restore-drill-evidence-v1.json}" \
	"${SUPPORT_CORE_SOURCE_CLEANUP_RESTORE_EVIDENCE_SHA256:-}"

reviewed_sql_sha256="${SUPPORT_CORE_SOURCE_CLEANUP_MIGRATION_SHA256:-}"
actual_sql_sha256="$(sha256sum "$sql_contract" | awk '{print $1}')"
[[ "$reviewed_sql_sha256" =~ ^[0-9a-f]{64}$ &&
	"$actual_sql_sha256" == "$reviewed_sql_sha256" ]] || {
	echo 'Reviewed Support cleanup SQL SHA-256 is missing or changed.' >&2
	exit 1
}

support_cleanup_write_marker verified
support_database_mark_cleanup "$revision"
printf 'Support cleanup marker stage: database-cleanup-binding-ok\n' >&2

source_shape="$(
	docker run --rm --network host --env-file "$backend_env" \
		--entrypoint sh "$restore_image" -ceu '
exec psql "$DATABASE_MIGRATION_URL_PRODUCTION" -X --set=ON_ERROR_STOP=1 \
  --tuples-only --no-align --command="SELECT CASE
    WHEN to_regclass('\''public.telegram_support_messages'\'') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='\''public'\'' AND table_name='\''telegram_bot_settings'\''
          AND column_name='\''support_thread_id'\'')
      AND to_regclass('\''public.support_core_cleanup_state'\'') IS NULL THEN '\''present'\''
    WHEN to_regclass('\''public.telegram_support_messages'\'') IS NULL
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='\''public'\'' AND table_name='\''telegram_bot_settings'\''
          AND column_name='\''support_thread_id'\'')
	      AND to_regclass('\''public.support_core_cleanup_state'\'') IS NOT NULL
	      THEN '\''cleanup-candidate'\''
    ELSE '\''unsafe'\'' END;"
'
)"
source_state="$source_shape"
if [[ "$source_shape" == 'cleanup-candidate' ]]; then
	source_state="$(
		docker run --rm --network host --env-file "$backend_env" \
			-e "CLEANUP_REVISION=$revision" \
			-e "TARGET_DATABASE_ID=$target_database_id" \
			-e "SOURCE_DATABASE_SYSTEM_ID=$source_system_id" \
			-e "SOURCE_FINGERPRINT=$source_fingerprint" \
			-e "SOURCE_SNAPSHOT_SHA256=$snapshot_sha256" \
			-e "SOURCE_MAPPING_COUNT=$mapping_count" \
			-e "SOURCE_HIGH_WATERMARK=$high_watermark" \
			--entrypoint sh "$restore_image" -ceu '
exec psql "$DATABASE_MIGRATION_URL_PRODUCTION" -X --set=ON_ERROR_STOP=1 \
  --tuples-only --no-align --command="SELECT CASE WHEN EXISTS (
    SELECT 1 FROM support_core_cleanup_state
    WHERE id='\''singleton'\'' AND cleanup_revision='\''$CLEANUP_REVISION'\''
      AND target_database_id::text='\''$TARGET_DATABASE_ID'\''
      AND source_database_system_id='\''$SOURCE_DATABASE_SYSTEM_ID'\''
      AND source_fingerprint='\''$SOURCE_FINGERPRINT'\''
      AND source_snapshot_sha256='\''$SOURCE_SNAPSHOT_SHA256'\''
      AND source_mapping_count::text='\''$SOURCE_MAPPING_COUNT'\''
      AND source_high_watermark::text='\''$SOURCE_HIGH_WATERMARK'\'')
    THEN '\''complete'\'' ELSE '\''unsafe'\'' END;"
'
	)"
fi
[[ "$source_state" =~ ^(present|complete)$ ]] || {
	echo "Support Core source cleanup state is unsafe: $source_state" >&2
	exit 1
}

if [[ "$source_state" == 'present' ]]; then
	database_restore_guard_assert_before_mutation healthy-required "$backend_env"
	docker run --rm --network host --env-file "$backend_env" \
	-e "CLEANUP_REVISION=$revision" \
	-e "TARGET_DATABASE_ID=$target_database_id" \
	-e "SOURCE_DATABASE_SYSTEM_ID=$source_system_id" \
	-e "SOURCE_FINGERPRINT=$source_fingerprint" \
	-e "SOURCE_SNAPSHOT_SHA256=$snapshot_sha256" \
	-e "SOURCE_MAPPING_COUNT=$mapping_count" \
	-e "SOURCE_HIGH_WATERMARK=$high_watermark" \
	--volume "$sql_contract:/contract/support-cleanup.sql:ro" \
	--entrypoint sh "$restore_image" -ceu '
exec psql "$DATABASE_MIGRATION_URL_PRODUCTION" -X --set=ON_ERROR_STOP=1 \
  --set=cleanup_confirmation="DROP LEGACY SUPPORT CORE SOURCE" \
  --set=cleanup_revision="$CLEANUP_REVISION" \
  --set=target_database_id="$TARGET_DATABASE_ID" \
  --set=source_database_system_id="$SOURCE_DATABASE_SYSTEM_ID" \
  --set=source_fingerprint="$SOURCE_FINGERPRINT" \
  --set=source_snapshot_sha256="$SOURCE_SNAPSHOT_SHA256" \
  --set=source_mapping_count="$SOURCE_MAPPING_COUNT" \
  --set=source_high_watermark="$SOURCE_HIGH_WATERMARK" \
  --file=/contract/support-cleanup.sql
'
fi

cleanup_verified="$(
	docker run --rm --network host --env-file "$backend_env" \
		-e "CLEANUP_REVISION=$revision" \
		-e "TARGET_DATABASE_ID=$target_database_id" \
		-e "SOURCE_DATABASE_SYSTEM_ID=$source_system_id" \
		-e "SOURCE_FINGERPRINT=$source_fingerprint" \
		-e "SOURCE_SNAPSHOT_SHA256=$snapshot_sha256" \
		-e "SOURCE_MAPPING_COUNT=$mapping_count" \
		-e "SOURCE_HIGH_WATERMARK=$high_watermark" \
		--entrypoint sh "$restore_image" -ceu '
exec psql "$DATABASE_MIGRATION_URL_PRODUCTION" -X --set=ON_ERROR_STOP=1 \
  --tuples-only --no-align --command="SELECT
    to_regclass('\''public.telegram_support_messages'\'') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = '\''public'\''
        AND table_name = '\''telegram_bot_settings'\''
        AND column_name = '\''support_thread_id'\''
    )
    AND EXISTS (
      SELECT 1 FROM support_core_cleanup_state
      WHERE id='\''singleton'\'' AND cleanup_revision='\''$CLEANUP_REVISION'\''
        AND target_database_id::text='\''$TARGET_DATABASE_ID'\''
        AND source_database_system_id='\''$SOURCE_DATABASE_SYSTEM_ID'\''
        AND source_fingerprint='\''$SOURCE_FINGERPRINT'\''
        AND source_snapshot_sha256='\''$SOURCE_SNAPSHOT_SHA256'\''
        AND source_mapping_count::text='\''$SOURCE_MAPPING_COUNT'\''
        AND source_high_watermark::text='\''$SOURCE_HIGH_WATERMARK'\''
    );"
'
)"
[[ "$cleanup_verified" == 't' ]] || {
	echo 'Support Core source cleanup postcondition failed.' >&2
	exit 1
}

support_cleanup_write_marker complete
support_cutover_validate_images
support_cleanup_compose up -d --no-deps --force-recreate api
for _ in {1..60}; do
	if curl -fsS --connect-timeout 2 --max-time 5 \
		http://127.0.0.1:4200/api/v1/health/ready >/dev/null 2>&1; then
		break
	fi
	sleep 2
done
curl -fsS --connect-timeout 2 --max-time 5 \
	http://127.0.0.1:4200/api/v1/health/ready >/dev/null
support_cleanup_compose up -d --no-deps --force-recreate api-gateway
for _ in {1..60}; do
	if curl -fsS --connect-timeout 2 --max-time 5 \
		http://127.0.0.1:4100/health/ready >/dev/null 2>&1; then
		break
	fi
	sleep 2
done
curl -fsS --connect-timeout 2 --max-time 5 \
	http://127.0.0.1:4100/health/ready >/dev/null

printf 'Support Core source cleanup completed at revision %s\n' "$revision"
