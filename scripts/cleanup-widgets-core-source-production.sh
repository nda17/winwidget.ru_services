#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
if [[ "${1:-}" == '--self-test' ]]; then
	SERVER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
else
	SERVER_ROOT="$APP_ROOT/winwidget.ru_server"
fi
CONFIRMATION='DROP LEGACY WIDGETS CORE SOURCE'

# shellcheck source=scripts/production-deploy-lock.sh
source "$SERVER_ROOT/scripts/production-deploy-lock.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$SERVER_ROOT/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/widgets-database-lifecycle.sh
source "$SERVER_ROOT/scripts/widgets-database-lifecycle.sh"

fail() {
	echo "Widgets Core source cleanup: $1" >&2
	exit 1
}

compose_target() {
	docker compose --project-name winwidget --env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" "$@"
}

get_env_value() {
	widgets_lifecycle_get_env_value "$1"
}

require_confirmation() {
	[[ "${WIDGETS_CORE_SOURCE_CLEANUP_CONFIRMATION:-}" == "$CONFIRMATION" ]] ||
		fail "set the exact confirmation: $CONFIRMATION"
}

assert_checkout() {
	local revision expected
	revision="$(git -C "$SERVER_ROOT" rev-parse HEAD)"
	expected="${EXPECTED_REVISION:-$revision}"
	[[ "$revision" == "$expected" && "$revision" =~ ^[0-9a-f]{40}$ &&
		"$(git -C "$SERVER_ROOT" branch --show-current)" == 'prod' &&
		-z "$(git -C "$SERVER_ROOT" status --porcelain --untracked-files=all)" ]] ||
		fail 'a clean protected prod checkout at EXPECTED_REVISION is required'
	printf '%s' "$revision"
}

assert_files_and_restore_guard() {
	[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
		"$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
		fail 'backend production env must be root-owned mode 600'
	[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] ||
		fail 'production Compose file is unavailable'
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
}

current_service_image() {
	local service="$1" container image
	[[ "$service" =~ ^(api|maintenance-worker)$ ]] || return 1
	container="$(compose_target ps --status running -q "$service" 2>/dev/null || true)"
	[[ "$container" =~ ^[0-9a-f]{64}$ ]] || fail "exactly one running $service is required"
	image="$(docker inspect --format '{{.Image}}' "$container")"
	[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "$service image identity is invalid"
	printf '%s' "$image"
}

current_api_image() {
	current_service_image api
}

current_maintenance_image() {
	current_service_image maintenance-worker
}

prepare_cleanup_node_runtime() {
	local image="${1:-}"
	[[ "$#" -le 1 ]] || return 1
	if [[ -z "$image" ]]; then
		widgets_lifecycle_prepare_node_runtime
		return
	fi
	[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	docker image inspect "$image" >/dev/null 2>&1 || return 1
	export WIDGETS_LIFECYCLE_NODE_IMAGE="$image"
	widgets_lifecycle_prepare_node_runtime
}

image_revision() {
	local revision
	revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1")"
	[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	printf '%s' "$revision"
}

remove_recoverable_partial() {
	local partial="$1" directory
	directory="$(dirname -- "$partial")"
	[[ -d "$directory" && ! -L "$directory" &&
		"$(widgets_lifecycle_stat_owner "$directory")" == '0:0' &&
		"$(widgets_lifecycle_stat_mode "$directory")" == '700' ]] ||
		fail 'cleanup evidence directory is unsafe'
	if [[ ! -e "$partial" && ! -L "$partial" ]]; then
		return
	fi
	[[ -f "$partial" && ! -L "$partial" &&
		"$(widgets_lifecycle_stat_owner "$partial")" == '0:0' ]] ||
		fail 'cleanup partial file is unsafe'
	rm -f -- "$partial"
}

validate_existing_private_file() {
	local file="$1" sha256
	[[ -f "$file" && ! -L "$file" ]] || return 1
	sha256="$(widgets_lifecycle_sha256_file "$file")" || return 1
	widgets_core_source_cleanup_validate_private_file "$file" "$sha256"
}

create_dump() {
	local image="$1" env_key="$2" schema="$3" destination="$4"
	local database_url directory filename partial
	database_url="$(get_env_value "$env_key")" || fail "missing production URL: $env_key"
	[[ -n "$database_url" && "$schema" =~ ^(public|widgets)$ ]] || fail 'backup input is invalid'
	directory="$(dirname -- "$destination")"
	filename="$(basename -- "$destination")"
	partial="$destination.partial"
	[[ ! -e "$destination" && ! -L "$destination" ]] ||
		fail 'backup destination already exists'
	remove_recoverable_partial "$partial"
	CLEANUP_DATABASE_URL="$database_url" CLEANUP_SCHEMA="$schema" CLEANUP_FILE="$filename.partial" \
		docker run --rm --user 0:0 --network host \
			-e CLEANUP_DATABASE_URL -e CLEANUP_SCHEMA -e CLEANUP_FILE \
			--mount "type=bind,source=$directory,target=/evidence" \
			--entrypoint node "$image" -e '
const { spawnSync } = require("node:child_process");
const url = new URL(process.env.CLEANUP_DATABASE_URL);
if (url.protocol !== "postgresql:") throw new Error("invalid backup protocol");
const password = url.password ? decodeURIComponent(url.password) : url.searchParams.get("password") || "";
url.password = "";
for (const key of ["password", "schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size"]) url.searchParams.delete(key);
const env = { ...process.env, PGPASSWORD: password };
delete env.CLEANUP_DATABASE_URL;
const result = spawnSync("pg_dump", [
  "--format=custom", "--no-owner", "--no-privileges", "--no-password",
  "--serializable-deferrable", "--schema", process.env.CLEANUP_SCHEMA,
  "--file", `/evidence/${process.env.CLEANUP_FILE}`, url.toString(),
], { env, stdio: ["ignore", "ignore", "inherit"] });
if (result.status !== 0) throw new Error("pg_dump failed");
'
	unset database_url
	[[ -f "$partial" && ! -L "$partial" && -s "$partial" ]] || fail 'pg_dump did not create a dump'
	chown 0:0 "$partial"
	chmod 600 "$partial"
	mv -fT "$partial" "$destination"
}

ensure_dump() {
	local image="$1" env_key="$2" schema="$3" destination="$4"
	if [[ -e "$destination" || -L "$destination" ]]; then
		validate_existing_private_file "$destination" ||
			fail 'existing cleanup dump owner, mode or content is invalid'
		validate_dump_list "$destination"
		return
	fi
	create_dump "$image" "$env_key" "$schema" "$destination"
	validate_dump_list "$destination"
}

validate_dump_list() {
	local dump="$1" directory
	directory="$(dirname -- "$dump")"
	docker run --rm --network none \
		--mount "type=bind,source=$directory,target=/evidence,readonly" \
		"$WIDGETS_CANONICAL_POSTGRES_IMAGE" pg_restore --list \
		"/evidence/$(basename -- "$dump")" >/dev/null
}

cleanup_stale_production_rehearsals() {
	[[ "$#" -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
	local revision_prefix="prod-${1:0:8}-" resource purpose run_id
	local temp_basename temp_entry temp_entry_count
	while IFS= read -r resource; do
		[[ -n "$resource" ]] || continue
		purpose="$(docker inspect --format '{{index .Config.Labels "com.winwidget.purpose"}}' "$resource" 2>/dev/null || true)"
		run_id="$(docker inspect --format '{{or (index .Config.Labels "com.winwidget.rehearsal.run-id") (index .Config.Labels "com.winwidget.rehearsal")}}' "$resource" 2>/dev/null || true)"
		if [[ "$purpose" =~ ^(core-source-cleanup-restore|cutover-restore-rehearsal)$ &&
			"$run_id" == "$revision_prefix"* ]]; then
			docker rm -f "$resource" >/dev/null || return 1
		fi
	done < <(docker ps -aq --filter label=com.winwidget.owner=widgets)
	while IFS= read -r resource; do
		[[ -n "$resource" ]] || continue
		purpose="$(docker volume inspect --format '{{index .Labels "com.winwidget.purpose"}}' "$resource" 2>/dev/null || true)"
		run_id="$(docker volume inspect --format '{{or (index .Labels "com.winwidget.rehearsal.run-id") (index .Labels "com.winwidget.rehearsal")}}' "$resource" 2>/dev/null || true)"
		if [[ "$purpose" =~ ^(core-source-cleanup-restore|cutover-restore-rehearsal)$ &&
			"$run_id" == "$revision_prefix"* ]]; then
			docker volume rm "$resource" >/dev/null || return 1
		fi
	done < <(docker volume ls -q --filter label=com.winwidget.owner=widgets)
	while IFS= read -r resource; do
		[[ -n "$resource" ]] || continue
		purpose="$(docker network inspect --format '{{index .Labels "com.winwidget.purpose"}}' "$resource" 2>/dev/null || true)"
		run_id="$(docker network inspect --format '{{index .Labels "com.winwidget.rehearsal"}}' "$resource" 2>/dev/null || true)"
		if [[ "$purpose" == 'cutover-restore-rehearsal' && "$run_id" == "$revision_prefix"* ]]; then
			docker network rm "$resource" >/dev/null || return 1
		fi
	done < <(docker network ls -q --filter label=com.winwidget.owner=widgets)
	while IFS= read -r -d '' resource; do
		temp_basename="$(basename -- "$resource")"
		[[ "$resource" == "/tmp/$temp_basename" && ! -L "$resource" &&
			"$temp_basename" =~ ^widgets-core-cleanup-prod-${1:0:8}-(c|p|f)-[0-9]+-[0-9]+\.[A-Za-z0-9]{6}$ &&
			"$(stat -c '%u:%g:%a' "$resource")" == '0:0:700' ]] || return 1
		temp_entry_count=0
		while IFS= read -r -d '' temp_entry; do
			((temp_entry_count += 1))
			[[ "$temp_entry_count" -eq 1 && "$temp_entry" == "$resource/redump.dump" &&
				-f "$temp_entry" && ! -L "$temp_entry" &&
				"$(stat -c '%u:%g:%a' "$temp_entry")" == '0:0:600' ]] || return 1
		done < <(find "$resource" -mindepth 1 -maxdepth 1 -print0)
		if [[ "$temp_entry_count" -eq 1 ]]; then
			rm -f -- "$resource/redump.dump" || return 1
		fi
		rmdir -- "$resource" || return 1
	done < <(find /tmp -mindepth 1 -maxdepth 1 -type d \
		-name "widgets-core-cleanup-${revision_prefix}*" -print0)
}

widgets_postgres_system_identifier() {
	local container admin_user identifier
	container="$(compose_target --profile widgets-database ps --status running -q widgets-postgres 2>/dev/null || true)"
	admin_user="$(get_env_value WIDGETS_POSTGRES_ADMIN_USER)" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ && "$admin_user" =~ ^[a-z_][a-z0-9_]*$ ]] || return 1
	identifier="$(docker exec "$container" psql --no-psqlrc --tuples-only --no-align \
		--set ON_ERROR_STOP=1 --username "$admin_user" --dbname winwidget_widgets \
		--command 'SELECT system_identifier FROM pg_control_system();')" || return 1
	[[ "$identifier" =~ ^[1-9][0-9]*$ ]] || return 1
	printf '%s' "$identifier"
}

write_json_evidence() {
	local destination="$1" previous_revision="$2" revision="$3" generation="$4"
	local fingerprint="$5" snapshot="$6" core_sha="$7" widgets_sha="$8"
	local core_system="$9" widgets_system="${10}" database_id="${11}"
	local core_restore_system="${12}" verified_at="${13}" partial
	partial="$destination.partial"
	[[ ! -e "$destination" && ! -L "$destination" ]] || fail 'evidence already exists'
	remove_recoverable_partial "$partial"
	printf '%s\n' \
		"{\"version\":1,\"previousRevision\":\"$previous_revision\",\"cleanupRevision\":\"$revision\",\"ownershipGeneration\":\"$generation\",\"sourceDatabaseFingerprint\":\"$fingerprint\",\"sourceSnapshotSha256\":\"$snapshot\",\"coreBackupSha256\":\"$core_sha\",\"widgetsBackupSha256\":\"$widgets_sha\",\"coreSystemIdentifier\":\"$core_system\",\"widgetsSystemIdentifier\":\"$widgets_system\",\"widgetsDatabaseId\":\"$database_id\",\"coreRestoreSystemIdentifier\":\"$core_restore_system\",\"widgetsRestoreVerified\":true,\"sourceCountsAndIdsVerified\":true,\"verifiedAt\":\"$verified_at\"}" \
		>"$partial"
	chown 0:0 "$partial"
	chmod 600 "$partial"
	mv -fT "$partial" "$destination"
}

validate_preflight_evidence() {
	[[ "$#" -eq 12 ]] || return 1
	local file="$1" previous_revision="$2" revision="$3" generation="$4"
	local fingerprint="$5" snapshot="$6" core_sha="$7" widgets_sha="$8"
	local core_system="$9" widgets_system="${10}" database_id="${11}"
	local core_restore_system="${12}"
	PREFLIGHT_FILE="$file" \
		PREVIOUS_REVISION="$previous_revision" CLEANUP_REVISION="$revision" \
		OWNERSHIP_GENERATION="$generation" SOURCE_FINGERPRINT="$fingerprint" \
		SOURCE_SNAPSHOT="$snapshot" CORE_BACKUP_SHA="$core_sha" \
		WIDGETS_BACKUP_SHA="$widgets_sha" CORE_SYSTEM_ID="$core_system" \
		WIDGETS_SYSTEM_ID="$widgets_system" WIDGETS_DATABASE_ID_VALUE="$database_id" \
		CORE_RESTORE_SYSTEM_ID="$core_restore_system" widgets_lifecycle_node <<'NODE'
const fs = require('node:fs');
let value;
try {
  value = JSON.parse(fs.readFileSync(process.env.PREFLIGHT_FILE, 'utf8'));
} catch {
  process.exit(1);
}
const expectedKeys = [
  'coreBackupSha256', 'coreRestoreSystemIdentifier', 'coreSystemIdentifier',
  'cleanupRevision', 'ownershipGeneration', 'previousRevision',
  'sourceCountsAndIdsVerified', 'sourceDatabaseFingerprint', 'sourceSnapshotSha256',
  'verifiedAt', 'version', 'widgetsBackupSha256', 'widgetsDatabaseId',
  'widgetsRestoreVerified', 'widgetsSystemIdentifier',
].sort().join(',');
const keys = Object.keys(value ?? {}).sort().join(',');
if (
  !value || Array.isArray(value) || keys !== expectedKeys ||
  value.version !== 1 ||
  value.previousRevision !== process.env.PREVIOUS_REVISION ||
  value.cleanupRevision !== process.env.CLEANUP_REVISION ||
  String(value.ownershipGeneration) !== process.env.OWNERSHIP_GENERATION ||
  value.sourceDatabaseFingerprint !== process.env.SOURCE_FINGERPRINT ||
  value.sourceSnapshotSha256 !== process.env.SOURCE_SNAPSHOT ||
  value.coreBackupSha256 !== process.env.CORE_BACKUP_SHA ||
  value.widgetsBackupSha256 !== process.env.WIDGETS_BACKUP_SHA ||
  String(value.coreSystemIdentifier) !== process.env.CORE_SYSTEM_ID ||
  String(value.widgetsSystemIdentifier) !== process.env.WIDGETS_SYSTEM_ID ||
  value.widgetsDatabaseId !== process.env.WIDGETS_DATABASE_ID_VALUE ||
  String(value.coreRestoreSystemIdentifier) !== process.env.CORE_RESTORE_SYSTEM_ID ||
  value.widgetsRestoreVerified !== true ||
  value.sourceCountsAndIdsVerified !== true ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.verifiedAt)
) process.exit(1);
NODE
}

preflight_core_restore_system_identifier() {
	[[ "$#" -eq 1 ]] || return 1
	PREFLIGHT_FILE="$1" widgets_lifecycle_node -e '
const fs = require("node:fs");
let value;
try { value = JSON.parse(fs.readFileSync(process.env.PREFLIGHT_FILE, "utf8")); } catch { process.exit(1); }
if (!/^[1-9][0-9]*$/.test(String(value.coreRestoreSystemIdentifier ?? ""))) process.exit(1);
process.stdout.write(String(value.coreRestoreSystemIdentifier));
' 2>/dev/null
}

import_offsite_receipt() {
	[[ "$#" -eq 4 || "$#" -eq 5 ]] || return 1
	local source="$1" destination="$2" evidence_kind="$3" expected_source="$4"
	local expected_post_sha="${5:-}" source_sha destination_sha partial
	[[ "$source" == "$expected_source" && -f "$source" && ! -L "$source" &&
		"$(widgets_lifecycle_stat_owner "$source")" == '0:0' &&
		"$(widgets_lifecycle_stat_mode "$source")" == '600' && -s "$source" ]] || return 1
	if [[ -n "$expected_post_sha" ]]; then
		widgets_core_source_cleanup_verify_receipt_artifacts \
			"$source" "$evidence_kind" "$expected_post_sha" || return 1
	else
		widgets_core_source_cleanup_verify_receipt_artifacts \
			"$source" "$evidence_kind" || return 1
	fi
	source_sha="$(widgets_lifecycle_sha256_file "$source")" || return 1
	if [[ -e "$destination" || -L "$destination" ]]; then
		validate_existing_private_file "$destination" || return 1
		destination_sha="$(widgets_lifecycle_sha256_file "$destination")" || return 1
		[[ "$destination_sha" == "$source_sha" ]] || return 1
	else
		partial="$destination.partial"
		remove_recoverable_partial "$partial"
		cp -- "$source" "$partial" || return 1
		chown 0:0 "$partial" && chmod 600 "$partial" &&
			mv -fT "$partial" "$destination" || return 1
	fi
	if [[ -n "$expected_post_sha" ]]; then
		widgets_core_source_cleanup_verify_receipt_artifacts \
			"$destination" "$evidence_kind" "$expected_post_sha" || return 1
	else
		widgets_core_source_cleanup_verify_receipt_artifacts \
			"$destination" "$evidence_kind" || return 1
	fi
	printf '%s' "$source_sha"
}

validate_completion_evidence() {
	[[ "$#" -eq 4 ]] || return 1
	local file="$1" revision="$2" post_sha="$3" post_receipt_sha="$4"
	COMPLETION_FILE="$file" EXPECTED_REVISION_VALUE="$revision" \
		EXPECTED_POST_SHA256="$post_sha" EXPECTED_POST_RECEIPT_SHA="$post_receipt_sha" \
		EXPECTED_GENERATION="$(widgets_core_source_cleanup_marker_value ownership_generation)" \
		EXPECTED_RECEIPT_SHA="$(widgets_core_source_cleanup_marker_value offsite_receipt_sha256)" \
		widgets_lifecycle_node <<'NODE'
const fs = require('node:fs');
const expectedKeys = [
  'cleanPostgreSQL18Restore',
  'cleanupRevision',
  'legacyRelationsAbsent',
  'migrationApplied',
  'ownershipGeneration',
  'postCleanupBackupSha256',
  'postCleanupOffsiteReceiptSha256',
  'preCleanupOffsiteReceiptSha256',
  'publicAssets',
  'runtimeSmoke',
  'status',
  'verifiedAt',
  'version',
];
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(process.env.COMPLETION_FILE, 'utf8'));
} catch {
  process.exit(1);
}
if (
  !parsed ||
  Array.isArray(parsed) ||
  Object.keys(parsed).sort().join('\n') !== expectedKeys.join('\n') ||
  parsed.version !== 1 ||
  parsed.status !== 'verified' ||
  parsed.cleanupRevision !== process.env.EXPECTED_REVISION_VALUE ||
  String(parsed.ownershipGeneration) !== process.env.EXPECTED_GENERATION ||
  parsed.postCleanupBackupSha256 !== process.env.EXPECTED_POST_SHA256 ||
  parsed.preCleanupOffsiteReceiptSha256 !== process.env.EXPECTED_RECEIPT_SHA ||
  parsed.postCleanupOffsiteReceiptSha256 !== process.env.EXPECTED_POST_RECEIPT_SHA ||
  !/^[0-9a-f]{64}$/.test(parsed.postCleanupBackupSha256) ||
  !/^[0-9a-f]{64}$/.test(parsed.postCleanupOffsiteReceiptSha256) ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(parsed.verifiedAt) ||
  parsed.migrationApplied !== true ||
  parsed.legacyRelationsAbsent !== true ||
  parsed.runtimeSmoke !== true ||
  parsed.publicAssets !== true ||
  parsed.cleanPostgreSQL18Restore !== true
) {
  process.exit(1);
}
NODE
}

write_completion_evidence() {
	[[ "$#" -eq 7 ]] || return 1
	local destination="$1" revision="$2" generation="$3" post_sha="$4"
	local receipt_sha="$5" post_receipt_sha="$6" verified_at="$7" partial
	partial="$destination.partial"
	[[ ! -e "$destination" && ! -L "$destination" &&
		"$revision" =~ ^[0-9a-f]{40}$ && "$generation" =~ ^[1-9][0-9]*$ &&
		"$post_sha" =~ ^[0-9a-f]{64}$ && "$receipt_sha" =~ ^[0-9a-f]{64}$ &&
		"$post_receipt_sha" =~ ^[0-9a-f]{64}$ &&
		"$verified_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
		return 1
	remove_recoverable_partial "$partial"
	(umask 077; printf '%s\n' \
		"{\"version\":1,\"status\":\"verified\",\"cleanupRevision\":\"$revision\",\"ownershipGeneration\":$generation,\"postCleanupBackupSha256\":\"$post_sha\",\"preCleanupOffsiteReceiptSha256\":\"$receipt_sha\",\"postCleanupOffsiteReceiptSha256\":\"$post_receipt_sha\",\"migrationApplied\":true,\"legacyRelationsAbsent\":true,\"runtimeSmoke\":true,\"publicAssets\":true,\"cleanPostgreSQL18Restore\":true,\"verifiedAt\":\"$verified_at\"}" \
		>"$partial") || return 1
	chown 0:0 "$partial"
	chmod 600 "$partial"
	mv -fT "$partial" "$destination"
}

stage_cleanup() {
	local revision previous_revision api_image maintenance_image identity generation fingerprint snapshot database_id
	local core_system widgets_system expected_fingerprint directory parent_directory core_dump widgets_dump evidence
	local core_sha widgets_sha restore_sha restore_output core_restore_system created_at marker_state
	local evidence_core_restore_system
	require_confirmation
	assert_files_and_restore_guard
	revision="$(assert_checkout)"
	widgets_export_compose_release_identity "$revision"
	[[ "$(widgets_service_identity_state)" == 'active' ]] || fail 'Widgets ownership is not active'
	[[ "$(widgets_core_source_state)" == 'present' ]] || fail 'legacy Core source is not exactly present'
	[[ "$(widgets_core_source_cleanup_migration_state)" =~ ^(pending|rolled-back)$ ]] ||
		fail 'cleanup migration is not in a stageable state'
	marker_state="$(widgets_core_source_cleanup_marker_state 2>/dev/null || printf 'invalid')"
	[[ "$marker_state" =~ ^(absent|staged)$ ]] || fail 'cleanup marker is invalid or not stageable'
	api_image="$(current_api_image)"
	previous_revision="$(image_revision "$api_image")" || fail 'current Core revision is invalid'
	maintenance_image="$(current_maintenance_image)"
	prepare_cleanup_node_runtime "$maintenance_image" ||
		fail 'the pinned maintenance image cannot provide the cleanup Node runtime'
	[[ "$(image_revision "$maintenance_image")" == "$previous_revision" ]] ||
		fail 'Core API and maintenance worker revisions differ before cleanup staging'
	[[ "$previous_revision" != "$revision" ]] || fail 'cleanup revision must be newer than the running Core revision'
	git -C "$SERVER_ROOT" merge-base --is-ancestor "$previous_revision" "$revision" ||
		fail 'cleanup revision is not a forward descendant'
	identity="$(widgets_service_identity_cleanup_evidence)" || fail 'active Widgets identity evidence is unreadable'
	IFS=$'\t' read -r generation fingerprint snapshot database_id <<<"$identity"
	core_system="$(widgets_core_database_query 'SELECT system_identifier FROM pg_control_system();')" ||
		fail 'Core system identifier is unreadable'
	widgets_system="$(widgets_postgres_system_identifier)" || fail 'Widgets system identifier is unreadable'
	expected_fingerprint="$(printf '%s' "$core_system:default_db" | widgets_lifecycle_sha256_stream)"
	[[ "$expected_fingerprint" == "$fingerprint" ]] || fail 'Core physical identity differs from the cutover source'
	widgets_core_source_ids_and_counts_are_covered "$maintenance_image"
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" "$generation")"
	if [[ ! -e "$directory" && ! -L "$directory" ]]; then
		parent_directory="$(dirname -- "$directory")"
		if [[ ! -e "$parent_directory" && ! -L "$parent_directory" ]]; then
			mkdir "$parent_directory"
			chown 0:0 "$parent_directory"
			chmod 700 "$parent_directory"
		fi
		[[ -d "$parent_directory" && ! -L "$parent_directory" &&
			"$(stat -c '%u:%g:%a' "$parent_directory")" == '0:0:700' ]] ||
			fail 'cleanup evidence parent directory is unsafe'
		mkdir "$directory"
		chown 0:0 "$directory"
		chmod 700 "$directory"
	fi
	[[ -d "$directory" && ! -L "$directory" && "$(stat -c '%u:%g:%a' "$directory")" == '0:0:700' ]] ||
		fail 'cleanup evidence directory is unsafe'
	core_dump="$directory/core-pre-cleanup.dump"
	widgets_dump="$directory/widgets-pre-cleanup.dump"
	evidence="$directory/preflight-evidence.json"
	if [[ "$marker_state" == 'staged' ]]; then
		[[ "$(widgets_core_source_cleanup_marker_value revision)" == "$revision" &&
			"$(widgets_core_source_cleanup_marker_value ownership_generation)" == "$generation" &&
			"$(widgets_core_source_cleanup_marker_value source_database_fingerprint)" == "$fingerprint" &&
			"$(widgets_core_source_cleanup_marker_value source_snapshot_sha256)" == "$snapshot" ]] ||
			fail 'existing staged cleanup marker does not match the current ownership boundary'
		widgets_core_source_cleanup_require_preflight_evidence ||
			fail 'existing staged cleanup evidence changed or disappeared'
		if widgets_core_source_cleanup_require_staged_evidence; then
			echo "Widgets Core source cleanup evidence and off-VPS receipt are already sealed for revision $revision."
		else
			echo "Widgets Core source cleanup evidence is already staged for revision $revision."
			echo 'Copy and SHA-verify the private pre-cleanup evidence off the VPS, then use --seal-offsite.'
			echo "Import the external receipt at /root/winwidget-widgets-core-cleanup-pre-offsite-${revision}-g${generation}.json."
		fi
		return
	fi
	ensure_dump "$maintenance_image" DATABASE_BACKUP_URL public "$core_dump"
	ensure_dump "$maintenance_image" WIDGETS_BACKUP_URL widgets "$widgets_dump"
	core_sha="$(widgets_lifecycle_sha256_file "$core_dump")"
	widgets_sha="$(widgets_lifecycle_sha256_file "$widgets_dump")"
	restore_output="$({
		cleanup_stale_production_rehearsals "$revision"
		CORE_CLEANUP_REHEARSAL_RUN_ID="prod-${revision:0:8}-c-$$-$RANDOM" \
		CORE_CLEANUP_REHEARSAL_DUMP_FILE="$core_dump" \
		CORE_CLEANUP_REHEARSAL_EXPECTED_SHA256="$core_sha" \
		CORE_CLEANUP_REHEARSAL_SOURCE_SYSTEM_IDENTIFIER="$core_system" \
		CORE_CLEANUP_REHEARSAL_EXPECTED_SOURCE_STATE=present \
			bash "$SERVER_ROOT/scripts/test-widgets-core-source-cleanup-rehearsal.sh" --verify-dump
	})"
	core_restore_system="$(sed -n 's/^core_cleanup_dump_restore_system_identifier=//p' <<<"$restore_output")"
	[[ "$core_restore_system" =~ ^[1-9][0-9]*$ &&
		"$restore_output" == *'widgets_core_cleanup_dump_restore=passed'* ]] ||
		fail 'Core pre-cleanup dump restore evidence is invalid'
	cleanup_stale_production_rehearsals "$revision"
	WIDGETS_REHEARSAL_RUN_ID="prod-${revision:0:8}-w-$$-$RANDOM" \
	WIDGETS_REHEARSAL_DUMP_FILE="$widgets_dump" \
	WIDGETS_REHEARSAL_EXPECTED_SHA256="$widgets_sha" \
	WIDGETS_REHEARSAL_SOURCE_SYSTEM_IDENTIFIER="$widgets_system" \
		bash "$SERVER_ROOT/scripts/test-widgets-cutover-rehearsal.sh" --verify-dump
	created_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	if [[ -e "$evidence" || -L "$evidence" ]]; then
		validate_existing_private_file "$evidence" || fail 'existing preflight evidence is unsafe'
		evidence_core_restore_system="$(preflight_core_restore_system_identifier "$evidence")" ||
			fail 'existing preflight restore identity is invalid'
		[[ "$evidence_core_restore_system" != "$core_system" ]] ||
			fail 'existing preflight restore is not physically independent'
		validate_preflight_evidence "$evidence" "$previous_revision" "$revision" "$generation" \
			"$fingerprint" "$snapshot" "$core_sha" "$widgets_sha" "$core_system" \
			"$widgets_system" "$database_id" "$evidence_core_restore_system" ||
			fail 'existing preflight evidence does not match the current verified boundary'
	else
		write_json_evidence "$evidence" "$previous_revision" "$revision" "$generation" \
			"$fingerprint" "$snapshot" "$core_sha" "$widgets_sha" "$core_system" \
			"$widgets_system" "$database_id" "$core_restore_system" "$created_at"
		validate_preflight_evidence "$evidence" "$previous_revision" "$revision" "$generation" \
			"$fingerprint" "$snapshot" "$core_sha" "$widgets_sha" "$core_system" \
			"$widgets_system" "$database_id" "$core_restore_system" ||
			fail 'new preflight evidence is invalid'
	fi
	restore_sha="$(widgets_lifecycle_sha256_file "$evidence")"
	widgets_core_source_cleanup_write_marker staged "$previous_revision" "$revision" \
		"$generation" "$fingerprint" "$snapshot" "$core_sha" "$widgets_sha" \
		"$restore_sha" pending "$core_system" "$widgets_system" "$database_id" \
		pending pending "$created_at" || fail 'could not create the durable staged marker'
	echo "Widgets Core source cleanup evidence is staged for revision $revision."
	echo 'Copy and SHA-verify the private pre-cleanup evidence off the VPS, then use --seal-offsite.'
	echo "Import the external receipt at /root/winwidget-widgets-core-cleanup-pre-offsite-${revision}-g${generation}.json."
}

seal_offsite_evidence() {
	local revision phase generation directory receipt receipt_sha current_receipt_sha source_receipt
	require_confirmation
	assert_files_and_restore_guard
	revision="$(assert_checkout)"
	widgets_export_compose_release_identity "$revision"
	prepare_cleanup_node_runtime ||
		fail 'the pinned maintenance image cannot provide the cleanup Node runtime'
	widgets_core_source_cleanup_validate_marker || fail 'cleanup marker is missing or invalid'
	[[ "$(widgets_core_source_cleanup_marker_value revision)" == "$revision" ]] ||
		fail 'cleanup marker pins another revision'
	phase="$(widgets_core_source_cleanup_marker_value phase)"
	[[ "$phase" == 'staged' ]] || fail 'only staged cleanup evidence can be sealed'
	widgets_core_source_cleanup_require_preflight_evidence ||
		fail 'preflight evidence changed or disappeared'
	current_receipt_sha="$(widgets_core_source_cleanup_marker_value offsite_receipt_sha256)"
	if [[ "$current_receipt_sha" =~ ^[0-9a-f]{64}$ &&
		! -e "/root/winwidget-widgets-core-cleanup-pre-offsite-${revision}-g$(widgets_core_source_cleanup_marker_value ownership_generation).json" &&
		! -L "/root/winwidget-widgets-core-cleanup-pre-offsite-${revision}-g$(widgets_core_source_cleanup_marker_value ownership_generation).json" ]]; then
		widgets_core_source_cleanup_require_staged_evidence ||
			fail 'sealed off-VPS receipt changed or disappeared'
		echo 'Pre-cleanup off-VPS evidence receipt is already sealed.'
		return
	fi
	generation="$(widgets_core_source_cleanup_marker_value ownership_generation)"
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" "$generation")"
	receipt="$directory/offsite-receipt.json"
	source_receipt="/root/winwidget-widgets-core-cleanup-pre-offsite-${revision}-g${generation}.json"
	receipt_sha="$(import_offsite_receipt "$source_receipt" "$receipt" pre "$source_receipt")" ||
		fail 'external pre-cleanup receipt is missing, unsafe or does not verify the exact local artifacts'
	widgets_core_source_cleanup_set_offsite_receipt "$receipt_sha" ||
		fail 'could not bind the off-VPS receipt to the durable cleanup marker'
	widgets_core_source_cleanup_require_staged_evidence ||
		fail 'sealed pre-cleanup evidence did not pass final validation'
	rm -f -- "$source_receipt"
	echo 'Pre-cleanup off-VPS evidence receipt is sealed; destructive --run is now eligible.'
}

verify_public_widgets_assets() {
	local asset
	for asset in wheel quiz callback timer stop-offer online-consultant calculator; do
		curl -fsS --connect-timeout 3 --max-time 10 \
			"https://api.winwidget.ru/widgets/$asset.js" >/dev/null ||
			fail "public Widgets asset failed after Core cleanup: $asset.js"
	done
}

purge_completed_raw_evidence_from_vps() {
	local revision generation directory file
	local -a cleanup_targets
	widgets_core_source_cleanup_validate_marker || return 1
	[[ "$(widgets_core_source_cleanup_marker_value phase)" == 'complete' ]] || return 1
	widgets_core_source_cleanup_require_completion_evidence || return 1
	revision="$(widgets_core_source_cleanup_marker_value revision)" || return 1
	generation="$(widgets_core_source_cleanup_marker_value ownership_generation)" || return 1
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" "$generation")" || return 1
	cleanup_targets=(
		"$directory/core-pre-cleanup.dump"
		"$directory/widgets-pre-cleanup.dump"
		"$directory/core-post-cleanup.dump"
		"/root/winwidget-widgets-core-cleanup-pre-offsite-${revision}-g${generation}.json"
		"/root/winwidget-widgets-core-cleanup-post-offsite-${revision}-g${generation}.json"
	)
	for file in "${cleanup_targets[@]}"; do
		if [[ ! -e "$file" && ! -L "$file" ]]; then
			continue
		fi
		[[ -f "$file" && ! -L "$file" &&
			"$(widgets_lifecycle_stat_owner "$file")" == '0:0' &&
			"$(widgets_lifecycle_stat_mode "$file")" == '600' ]] || return 1
		rm -f -- "$file" || return 1
	done
	for file in "${cleanup_targets[@]}"; do
		[[ ! -e "$file" && ! -L "$file" ]] || return 1
	done
	widgets_core_source_cleanup_local_retention_is_finalized
}

run_cleanup() {
	local revision phase api_image maintenance_image directory post_dump post_sha
	require_confirmation
	assert_files_and_restore_guard
	revision="$(assert_checkout)"
	widgets_export_compose_release_identity "$revision"
	prepare_cleanup_node_runtime ||
		fail 'the pinned maintenance image cannot provide the cleanup Node runtime'
	widgets_core_source_cleanup_validate_marker || fail 'cleanup marker is missing or invalid'
	[[ "$(widgets_core_source_cleanup_marker_value revision)" == "$revision" ]] ||
		fail 'cleanup marker pins another revision'
	phase="$(widgets_core_source_cleanup_marker_value phase)"
	if [[ "$phase" == 'complete' ]]; then
		[[ "$(widgets_core_source_state)" == 'absent' &&
			"$(widgets_core_source_cleanup_migration_state)" == 'applied' ]] ||
			fail 'completed cleanup state drifted'
		widgets_core_source_cleanup_require_completion_evidence ||
			fail 'completed cleanup evidence changed or disappeared'
		purge_completed_raw_evidence_from_vps ||
			fail 'completed cleanup raw VPS evidence could not be purged safely'
		verify_public_widgets_assets
		echo 'Widgets Core source cleanup is already complete.'
		return
	fi
	[[ "$phase" =~ ^(staged|applied)$ ]] || fail 'cleanup marker phase is not runnable'
	widgets_core_source_cleanup_require_staged_evidence || fail 'staged evidence changed'
	EXPECTED_REVISION="$revision" WIDGETS_AUTOMATIC_PROD_PUSH=false \
		WIDGETS_CORE_SOURCE_CLEANUP_APPROVED=true \
		WIDGETS_CORE_SOURCE_CLEANUP_CONFIRMATION="$CONFIRMATION" \
			bash "$SERVER_ROOT/scripts/deploy-production.sh"
	[[ "$(widgets_core_source_cleanup_marker_value phase)" == 'applied' &&
		"$(widgets_core_source_state)" == 'absent' &&
		"$(widgets_core_source_cleanup_migration_state)" == 'applied' ]] ||
		fail 'runtime deploy did not reach applied|absent'
	api_image="$(current_api_image)"
	[[ "$(image_revision "$api_image")" == "$revision" ]] || fail 'Core API did not reach cleanup revision'
	maintenance_image="$(current_maintenance_image)"
	[[ "$(image_revision "$maintenance_image")" == "$revision" ]] ||
		fail 'maintenance worker did not reach cleanup revision'
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" \
		"$(widgets_core_source_cleanup_marker_value ownership_generation)")"
	post_dump="$directory/core-post-cleanup.dump"
	ensure_dump "$maintenance_image" DATABASE_BACKUP_URL public "$post_dump"
	post_sha="$(widgets_lifecycle_sha256_file "$post_dump")"
	widgets_core_source_cleanup_validate_private_file "$post_dump" "$post_sha" ||
		fail 'post-cleanup dump owner, mode or content is invalid'
	validate_dump_list "$post_dump"
	cleanup_stale_production_rehearsals "$revision"
	CORE_CLEANUP_REHEARSAL_RUN_ID="prod-${revision:0:8}-p-$$-$RANDOM" \
	CORE_CLEANUP_REHEARSAL_DUMP_FILE="$post_dump" \
	CORE_CLEANUP_REHEARSAL_EXPECTED_SHA256="$post_sha" \
	CORE_CLEANUP_REHEARSAL_SOURCE_SYSTEM_IDENTIFIER="$(widgets_core_source_cleanup_marker_value core_system_identifier)" \
	CORE_CLEANUP_REHEARSAL_EXPECTED_SOURCE_STATE=absent \
		bash "$SERVER_ROOT/scripts/test-widgets-core-source-cleanup-rehearsal.sh" --verify-dump
	verify_public_widgets_assets
	echo 'Widgets Core source cleanup is applied and the post-cleanup PostgreSQL 18 restore passed.'
	echo 'Copy and SHA-verify core-post-cleanup.dump off the VPS, then use --complete-offsite.'
	echo "Import the external receipt at /root/winwidget-widgets-core-cleanup-post-offsite-${revision}-g$(widgets_core_source_cleanup_marker_value ownership_generation).json."
}

complete_offsite_evidence() {
	local revision phase api_image maintenance_image generation directory post_dump post_sha
	local completion completion_sha verified_at receipt_sha post_receipt post_receipt_sha source_receipt
	require_confirmation
	assert_files_and_restore_guard
	revision="$(assert_checkout)"
	widgets_export_compose_release_identity "$revision"
	prepare_cleanup_node_runtime ||
		fail 'the pinned maintenance image cannot provide the cleanup Node runtime'
	widgets_core_source_cleanup_validate_marker || fail 'cleanup marker is missing or invalid'
	[[ "$(widgets_core_source_cleanup_marker_value revision)" == "$revision" ]] ||
		fail 'cleanup marker pins another revision'
	phase="$(widgets_core_source_cleanup_marker_value phase)"
	if [[ "$phase" == 'complete' ]]; then
		[[ "$(widgets_core_source_state)" == 'absent' &&
			"$(widgets_core_source_cleanup_migration_state)" == 'applied' ]] ||
			fail 'completed cleanup state drifted'
		widgets_core_source_cleanup_require_completion_evidence ||
			fail 'completed cleanup evidence changed or disappeared'
		purge_completed_raw_evidence_from_vps ||
			fail 'completed cleanup raw VPS evidence could not be purged safely'
		verify_public_widgets_assets
		echo 'Widgets Core source cleanup is already complete.'
		return
	fi
	[[ "$phase" == 'applied' ]] || fail 'post-cleanup evidence requires phase=applied'
	widgets_core_source_cleanup_require_staged_evidence || fail 'pre-cleanup evidence changed'
	[[ "$(widgets_core_source_state)" == 'absent' &&
		"$(widgets_core_source_cleanup_migration_state)" == 'applied' ]] ||
		fail 'Core cleanup database state is not applied|absent'
	api_image="$(current_api_image)"
	maintenance_image="$(current_maintenance_image)"
	[[ "$(image_revision "$api_image")" == "$revision" &&
		"$(image_revision "$maintenance_image")" == "$revision" ]] ||
		fail 'Core runtime is not on the cleanup revision'
	generation="$(widgets_core_source_cleanup_marker_value ownership_generation)"
	directory="$(widgets_core_source_cleanup_evidence_directory "$revision" "$generation")"
	post_dump="$directory/core-post-cleanup.dump"
	validate_existing_private_file "$post_dump" || fail 'post-cleanup dump is missing or unsafe'
	validate_dump_list "$post_dump"
	post_sha="$(widgets_lifecycle_sha256_file "$post_dump")"
	cleanup_stale_production_rehearsals "$revision"
	CORE_CLEANUP_REHEARSAL_RUN_ID="prod-${revision:0:8}-f-$$-$RANDOM" \
	CORE_CLEANUP_REHEARSAL_DUMP_FILE="$post_dump" \
	CORE_CLEANUP_REHEARSAL_EXPECTED_SHA256="$post_sha" \
	CORE_CLEANUP_REHEARSAL_SOURCE_SYSTEM_IDENTIFIER="$(widgets_core_source_cleanup_marker_value core_system_identifier)" \
	CORE_CLEANUP_REHEARSAL_EXPECTED_SOURCE_STATE=absent \
		bash "$SERVER_ROOT/scripts/test-widgets-core-source-cleanup-rehearsal.sh" --verify-dump
	verify_public_widgets_assets
	receipt_sha="$(widgets_core_source_cleanup_marker_value offsite_receipt_sha256)"
	post_receipt="$directory/post-cleanup-offsite-receipt.json"
	source_receipt="/root/winwidget-widgets-core-cleanup-post-offsite-${revision}-g${generation}.json"
	post_receipt_sha="$(import_offsite_receipt \
		"$source_receipt" "$post_receipt" post "$source_receipt" "$post_sha")" ||
		fail 'external post-cleanup receipt is missing, unsafe or does not verify the exact local artifact'
	completion="$directory/completion-evidence.json"
	if [[ -e "$completion" || -L "$completion" ]]; then
		validate_existing_private_file "$completion" || fail 'existing completion evidence is unsafe'
		validate_completion_evidence "$completion" "$revision" "$post_sha" "$post_receipt_sha" ||
			fail 'existing completion evidence does not match the verified external manifest'
	else
		verified_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
		write_completion_evidence "$completion" "$revision" "$generation" "$post_sha" \
			"$receipt_sha" "$post_receipt_sha" "$verified_at" ||
			fail 'could not write completion evidence'
		validate_completion_evidence "$completion" "$revision" "$post_sha" "$post_receipt_sha" ||
			fail 'new completion evidence is invalid'
	fi
	completion_sha="$(widgets_lifecycle_sha256_file "$completion")"
	widgets_core_source_cleanup_validate_private_file "$completion" "$completion_sha" ||
		fail 'completion evidence owner, mode or content is invalid'
	widgets_core_source_cleanup_advance_marker complete "$post_sha" "$completion_sha" ||
		fail 'could not complete the durable cleanup marker'
	widgets_core_source_cleanup_require_completion_evidence ||
		fail 'completed cleanup evidence did not pass final validation'
	purge_completed_raw_evidence_from_vps ||
		fail 'completed cleanup raw VPS evidence could not be purged safely'
	echo 'Widgets Core source cleanup completed with off-VPS pre/post evidence and PostgreSQL 18 restores.'
}

cleanup_self_test() {
	local temporary receipt sha revision generation fingerprint database_id timestamp deploy_script script_text
	local production_run_id
	temporary="$(mktemp "${TMPDIR:-/tmp}/widgets-core-cleanup-self-test.XXXXXX")"
	receipt="$temporary.receipt"
	trap 'rm -f -- "$temporary" "$receipt"' EXIT
	sha="$(printf 'a%.0s' {1..64})"
	revision='0123456789abcdef0123456789abcdef01234567'
	production_run_id="prod-${revision:0:8}-w-12345-12345"
	[[ "$production_run_id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$ ]]
	[[ "widgets-core-cleanup-prod-${revision:0:8}-c-12345-12345.A1b2C3" =~ \
		^widgets-core-cleanup-prod-${revision:0:8}-(c|p|f)-[0-9]+-[0-9]+\.[A-Za-z0-9]{6}$ ]]
	generation='3'
	fingerprint="$sha"
	database_id='123e4567-e89b-42d3-a456-426614174000'
	timestamp='2026-08-10T00:00:00Z'
	printf '%s\n' \
		"{\"version\":1,\"previousRevision\":\"$revision\",\"cleanupRevision\":\"$revision\",\"ownershipGeneration\":$generation,\"sourceDatabaseFingerprint\":\"$fingerprint\",\"sourceSnapshotSha256\":\"$sha\",\"coreBackupSha256\":\"$sha\",\"widgetsBackupSha256\":\"$sha\",\"coreSystemIdentifier\":123,\"widgetsSystemIdentifier\":456,\"widgetsDatabaseId\":\"$database_id\",\"coreRestoreSystemIdentifier\":789,\"widgetsRestoreVerified\":true,\"sourceCountsAndIdsVerified\":true,\"verifiedAt\":\"$timestamp\"}" \
		>"$temporary"
	validate_preflight_evidence "$temporary" "$revision" "$revision" "$generation" \
		"$fingerprint" "$sha" "$sha" "$sha" 123 456 "$database_id" 789
	[[ "$(preflight_core_restore_system_identifier "$temporary")" == '789' ]]
	! validate_preflight_evidence "$temporary" "$revision" "$revision" "$generation" \
		"$fingerprint" "$sha" "$sha" "$sha" 123 456 "$database_id" 790
	widgets_core_source_cleanup_reference_is_safe \
		operator-managed-macos 'macos-offsite:widgets-cleanup-verified-001'
	! widgets_core_source_cleanup_reference_is_safe \
		operator-managed-macos 'file:///root/not-offsite'
	! widgets_core_source_cleanup_reference_is_safe unknown-provider 'macos-offsite:verified-001'
	printf '%s\n' \
		"{\"version\":1,\"status\":\"verified\",\"provider\":\"operator-managed-macos\",\"providerReference\":\"macos-offsite:widgets-cleanup-verified-001\",\"cleanupRevision\":\"$revision\",\"ownershipGeneration\":$generation,\"sourceDatabaseFingerprint\":\"$fingerprint\",\"artifacts\":[{\"name\":\"core-pre-cleanup.dump\",\"sizeBytes\":1,\"sha256\":\"$sha\"},{\"name\":\"preflight-evidence.json\",\"sizeBytes\":2,\"sha256\":\"$sha\"},{\"name\":\"widgets-pre-cleanup.dump\",\"sizeBytes\":3,\"sha256\":\"$sha\"}],\"verifiedAt\":\"$timestamp\"}" \
		>"$receipt"
	(
		widgets_core_source_cleanup_marker_value() {
			case "$1" in
			revision) printf '%s' "$revision" ;;
			ownership_generation) printf '%s' "$generation" ;;
			source_database_fingerprint) printf '%s' "$fingerprint" ;;
			core_backup_sha256 | widgets_backup_sha256 | restore_evidence_sha256) printf '%s' "$sha" ;;
			post_cleanup_backup_sha256) printf '%s' "$sha" ;;
			*) return 1 ;;
			esac
		}
		widgets_core_source_cleanup_validate_offsite_receipt "$receipt" pre
		fingerprint="$(printf 'b%.0s' {1..64})"
		! widgets_core_source_cleanup_validate_offsite_receipt "$receipt" pre
	)
	deploy_script="$SERVER_ROOT/scripts/deploy-production.sh"
	script_text="$(<"$deploy_script")"
	[[ "$script_text" == *'stop_widgets_core_cleanup_precommit_topology'* &&
		"$script_text" == *'capture_widgets_core_cleanup_precommit_containers'* &&
		"$script_text" == *'Widgets Core source is already absent; old writers will not be restored.'* &&
		"$script_text" == *'Pre-commit Widgets cleanup requires one exact existing container'* ]]
	[[ "$(<"$SERVER_ROOT/scripts/cleanup-widgets-core-source-production.sh")" == \
		*'--stage|--seal-offsite|--run|--complete-offsite'* ]]
	rm -f -- "$temporary" "$receipt"
	trap - EXIT
	printf 'widgets_core_source_cleanup_self_test=passed\n'
}

case "${1:-}" in
--self-test)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	cleanup_self_test
	;;
--stage)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	acquire_production_deploy_lock 'Widgets Core source cleanup'
	stage_cleanup
	;;
--seal-offsite)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	acquire_production_deploy_lock 'Widgets Core source cleanup'
	seal_offsite_evidence
	;;
--run)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	acquire_production_deploy_lock 'Widgets Core source cleanup'
	run_cleanup
	;;
--complete-offsite)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	acquire_production_deploy_lock 'Widgets Core source cleanup'
	complete_offsite_evidence
	;;
*)
	echo 'Usage: cleanup-widgets-core-source-production.sh --self-test|--stage|--seal-offsite|--run|--complete-offsite' >&2
	exit 64
	;;
esac
