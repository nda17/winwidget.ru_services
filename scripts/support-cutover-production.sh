#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

support_cutover_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
support_cutover_core_image_id=''
support_cutover_support_image_id=''
support_cutover_gateway_image_id=''
support_cutover_marker="${SUPPORT_CUTOVER_MARKER:-$APP_ROOT/deploy/backend/.support-cutover-v1}"

# shellcheck source=scripts/support-release-identity.sh
source "$support_cutover_root/scripts/support-release-identity.sh"
# shellcheck source=scripts/support-database-lifecycle.sh
source "$support_cutover_root/scripts/support-database-lifecycle.sh"
# shellcheck source=scripts/production-deploy-lock.sh
source "$support_cutover_root/scripts/production-deploy-lock.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$support_cutover_root/scripts/database-restore-production-guard.sh"

support_cutover_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

support_cutover_require_common() {
	[[ "$(id -u)" == '0' && "$(uname -s)" == 'Linux' ]] ||
		support_cutover_fail 'Support production lifecycle requires root on Linux.' || return 1
	support_release_validate_revision "$EXPECTED_REVISION" || return 1
	support_release_validate_file "$ENV_FILE" || return 1
	support_release_validate_file "$COMPOSE_FILE" || return 1
	support_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION" || return 1
	[[ "$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
		support_cutover_fail 'Canonical backend production env must be root:root mode 0600.' || return 1
	support_release_require_local_docker
}

support_cutover_compose() {
	support_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" "$@"
}

support_cutover_core_image() {
	printf 'winwidget-api:git-%s\n' "$EXPECTED_REVISION"
}

support_cutover_support_image() {
	support_release_image "$EXPECTED_REVISION"
}

support_cutover_gateway_image() {
	printf 'winwidget-api-gateway:git-%s\n' "$EXPECTED_REVISION"
}

support_cutover_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z_]+$ && -f "$support_cutover_marker" &&
		! -L "$support_cutover_marker" ]] || return 1
	awk -F= -v key="$1" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$support_cutover_marker"
}

support_cutover_validate_marker() {
	[[ -f "$support_cutover_marker" && ! -L "$support_cutover_marker" &&
		"$(stat -c '%u:%g:%a' "$support_cutover_marker")" == '0:0:600' ]] || return 1
	awk -F= '
		$1 !~ /^(version|phase|revision|core_image_id|support_image_id|gateway_image_id|updated_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			if (seen["version"] != 1 || value["version"] != "1" ||
				seen["phase"] != 1 || value["phase"] !~ /^(preflight-verified|forward-only|complete)$/ ||
				seen["revision"] != 1 || value["revision"] !~ /^[0-9a-f]{40}$/ ||
				seen["core_image_id"] != 1 || value["core_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				seen["support_image_id"] != 1 || value["support_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				seen["gateway_image_id"] != 1 || value["gateway_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				seen["updated_at"] != 1 || value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
		}
	' "$support_cutover_marker"
}

support_cutover_write_marker() {
	[[ $# -eq 1 && "$1" =~ ^(preflight-verified|forward-only|complete)$ ]] || return 1
	support_cutover_require_image_ids || return 1
	local phase="$1" current='absent' temporary="${support_cutover_marker}.tmp.$$"
	if [[ -e "$support_cutover_marker" || -L "$support_cutover_marker" ]]; then
		support_cutover_validate_marker || return 1
		current="$(support_cutover_marker_value phase)"
		[[ "$(support_cutover_marker_value revision)" == "$EXPECTED_REVISION" &&
			"$(support_cutover_marker_value core_image_id)" == "$support_cutover_core_image_id" &&
			"$(support_cutover_marker_value support_image_id)" == "$support_cutover_support_image_id" &&
			"$(support_cutover_marker_value gateway_image_id)" == "$support_cutover_gateway_image_id" ]] ||
			support_cutover_fail 'Support cutover marker release identity changed.' || return 1
	fi
	case "$current:$phase" in
	absent:preflight-verified | preflight-verified:preflight-verified | \
		preflight-verified:forward-only | forward-only:forward-only | \
		forward-only:complete | complete:complete) ;;
	*) support_cutover_fail "Unsafe Support cutover marker transition: $current -> $phase"; return 1 ;;
	esac
	{
		printf 'version=1\nphase=%s\nrevision=%s\n' "$phase" "$EXPECTED_REVISION"
		printf 'core_image_id=%s\nsupport_image_id=%s\ngateway_image_id=%s\n' \
			"$support_cutover_core_image_id" "$support_cutover_support_image_id" \
			"$support_cutover_gateway_image_id"
		printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$support_cutover_marker"
	support_cutover_validate_marker
}

support_cutover_validate_images() {
	local core_image support_image gateway_image image image_id expected_user marker_image_id
	core_image="$(support_cutover_core_image)"
	support_image="$(support_cutover_support_image)"
	gateway_image="$(support_cutover_gateway_image)"
	marker_image_id="$(support_database_marker_value image_id)" || return 1
	for image in "$core_image" "$support_image" "$gateway_image"; do
		if [[ "$image" == "$core_image" ]]; then
			expected_user='nestjs'
		elif [[ "$image" == "$gateway_image" ]]; then
			expected_user='node'
		else
			expected_user='support'
		fi
		image_id="$(docker image inspect --format '{{.Id}}' "$image")" || return 1
		[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' "$image_id")" == "$EXPECTED_REVISION|$expected_user" ]] ||
			support_cutover_fail "Support lifecycle image identity mismatch: $image" || return 1
		if [[ "$image" == "$core_image" ]]; then
			support_cutover_core_image_id="$image_id"
		elif [[ "$image" == "$support_image" ]]; then
			[[ "$image_id" == "$marker_image_id" ]] ||
				support_cutover_fail 'Support image differs from the prepared database marker.' || return 1
			support_cutover_support_image_id="$image_id"
		else
			support_cutover_gateway_image_id="$image_id"
		fi
	done
	if [[ -e "$support_cutover_marker" || -L "$support_cutover_marker" ]]; then
		support_cutover_validate_marker || return 1
		[[ "$(support_cutover_marker_value revision)" == "$EXPECTED_REVISION" &&
			"$(support_cutover_marker_value core_image_id)" == "$support_cutover_core_image_id" &&
			"$(support_cutover_marker_value support_image_id)" == "$support_cutover_support_image_id" &&
			"$(support_cutover_marker_value gateway_image_id)" == "$support_cutover_gateway_image_id" ]] ||
			support_cutover_fail 'Support cutover images differ from the protected marker.' || return 1
	fi
}

support_cutover_require_image_ids() {
	[[ "$support_cutover_core_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$support_cutover_support_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$support_cutover_gateway_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
		support_cutover_fail 'Support lifecycle image IDs were not validated.'
}

support_cutover_validate_gateway_routes() {
	support_cutover_require_image_ids || return 1
	local expected_routes
	expected_routes="$(support_read_env_value "$SERVER_ROOT/.env.example" GATEWAY_ROUTES_JSON)" ||
		support_cutover_fail 'Tracked Gateway route manifest is unavailable.' || return 1
	support_cutover_compose run --rm --no-deps \
		-e "SUPPORT_EXPECTED_GATEWAY_ROUTES_JSON=$expected_routes" \
		--entrypoint node api-gateway -e '
const { loadConfig } = require("./dist/src/config.js");
const actual = loadConfig().routes;
const expected = JSON.parse(process.env.SUPPORT_EXPECTED_GATEWAY_ROUTES_JSON || "null");
if (!Array.isArray(expected)) throw new Error("Tracked Gateway routes must be an array");
const normalize = routes => routes.map(route => ({
  id: route.id,
  pathPrefix: route.pathPrefix,
  upstreamUrl: route.upstreamUrl instanceof URL ? route.upstreamUrl.origin : new URL(route.upstreamUrl).origin,
  authPolicy: route.authPolicy,
  timeoutMs: route.timeoutMs,
})).sort((left, right) => left.id.localeCompare(right.id));
if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected)))
  throw new Error("Gateway route manifest differs from the tracked production contract");
const monolith = actual.findIndex(route => route.id === "monolith");
for (const id of ["support-webhook", "support-admin"]) {
  const index = actual.findIndex(route => route.id === id);
  if (index < 0 || index >= monolith) throw new Error(`Unsafe ${id} route order`);
}
process.stdout.write("support_gateway_manifest=verified\n");
' >/dev/null
}

support_cutover_run_core() {
	support_cutover_require_image_ids || return 1
	DATABASE_URL="$(support_read_env_value "$ENV_FILE" DATABASE_URL_PRODUCTION)" \
		docker run --rm --network host --env-file "$ENV_FILE" --env DATABASE_URL \
		--entrypoint node "$support_cutover_core_image_id" \
		dist/src/support-cutover-main.js "$@"
}

support_cutover_run_target() {
	support_cutover_require_image_ids || return 1
	docker run --rm --network host --env-file "$ENV_FILE" \
		--entrypoint node "$support_cutover_support_image_id" \
		dist/src/cutover/main.js "$@"
}

support_cutover_verify_steady() {
	local core_status target_status
	core_status="$(support_cutover_run_core status)" || return 1
	target_status="$(support_cutover_run_target status)" || return 1
	printf '%s\n%s\n' "$core_status" "$target_status" |
		docker run --rm -i --network none \
			-e "EXPECTED_REVISION=$EXPECTED_REVISION" \
			--entrypoint node "$support_cutover_support_image_id" -e '
const { readFileSync } = require("node:fs");
const lines = readFileSync(0, "utf8").trim().split("\n");
if (lines.length !== 2) throw new Error("Support ownership status shape drifted");
const [core, target] = lines.map(JSON.parse);
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
if (
  core.action !== "status" || core.ownership !== "SUPPORT" ||
  core.admissionEnabled !== false || core.reconcilerEnabled !== false ||
  core.activeTaskCount !== 0 || core.sourceRevision !== process.env.EXPECTED_REVISION ||
  core.ownershipRevision !== process.env.EXPECTED_REVISION ||
  target.action !== "status" || target.phase !== "ACTIVE" ||
  target.sourceRevision !== process.env.EXPECTED_REVISION ||
  target.ownershipRevision !== process.env.EXPECTED_REVISION ||
  core.sourceDatabaseSystemId !== target.sourceDatabaseSystemId ||
  core.sourceFingerprint !== target.sourceFingerprint ||
  core.sourceSnapshotSha256 !== target.sourceSnapshotSha256 ||
  core.sourceMappingCount !== String(target.counts?.mappings) ||
  core.sourceHighWatermark !== target.sourceHighWatermark ||
  !hash(core.sourceFingerprint) || !hash(core.sourceSnapshotSha256)
) throw new Error("Support ownership is not in exact steady state");
process.stdout.write("support_ownership=steady\n");
'
}

support_cutover_prepare() {
	[[ "${SUPPORT_CONFIRMATION:-}" == 'PREPARE SUPPORT OWNERSHIP' ]] ||
		support_cutover_fail 'Support prepare requires exact confirmation.' || return 1
	support_cutover_require_common
	acquire_production_deploy_lock 'Support ownership prepare'
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	local phase
	phase="$(support_database_current_phase)"
	case "$phase" in
	absent | aborted | preparing | prepared) support_database_prepare ;;
	*) support_cutover_fail "Support prepare is unavailable from phase=$phase."; return 1 ;;
	esac
	if [[ -e "$support_cutover_marker" || -L "$support_cutover_marker" ]]; then
		support_cutover_validate_marker || return 1
		[[ "$(support_cutover_marker_value phase)" == 'preflight-verified' &&
			"$(support_cutover_marker_value revision)" == "$EXPECTED_REVISION" ]] ||
			support_cutover_fail 'Support prepared retry requires its exact preflight marker.' || return 1
		support_cutover_validate_images
	else
		support_cutover_compose build --pull api api-gateway
		support_cutover_validate_images
	fi
	support_cutover_validate_gateway_routes
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	support_cutover_compose --profile migration run --rm --no-deps migrate
	support_cutover_validate_images
	support_cutover_run_core preflight --revision "$EXPECTED_REVISION" >/dev/null
	support_cutover_run_core prepare --revision "$EXPECTED_REVISION" >/dev/null
	support_cutover_run_target validate-shadow >/dev/null
	support_cutover_write_marker preflight-verified
	printf 'support_cutover_phase=prepared\n'
}

support_cutover_extract_export() {
	[[ $# -eq 1 ]] || return 1
	printf '%s' "$1" |
		docker run --rm -i --network none --entrypoint node \
			"$support_cutover_support_image_id" -e '
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync(0, "utf8"));
for (const key of ["sha256", "fingerprint", "systemId", "mappingCount", "highWatermark"]) {
  if (value[key] === undefined || value[key] === null) throw new Error(`Missing ${key}`);
}
process.stdout.write(`${[value.sha256, value.fingerprint, value.systemId, value.mappingCount, value.highWatermark].join("\t")}\n`);
'
}

support_cutover_switch_ownership() {
	local snapshot_dir snapshot_host snapshot_container export_result
	local sha256 fingerprint system_id mapping_count high_watermark
	snapshot_dir="$APP_ROOT/deploy/backend/.support-cutover-$EXPECTED_REVISION"
	if [[ ! -e "$snapshot_dir" && ! -L "$snapshot_dir" ]]; then
		mkdir --mode=700 -- "$snapshot_dir"
		chown 0:0 "$snapshot_dir"
	fi
	[[ -d "$snapshot_dir" && ! -L "$snapshot_dir" &&
		"$(stat -c '%u:%g:%a' "$snapshot_dir")" == '0:0:700' ]] ||
		support_cutover_fail 'Support snapshot directory is unsafe.' || return 1
	snapshot_host="$snapshot_dir/snapshot.json"
	snapshot_container='/support-cutover/snapshot.json'

	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	support_cutover_compose stop -t 90 api-gateway api
	support_cutover_run_core fence --revision "$EXPECTED_REVISION" >/dev/null
	export_result="$(
		DATABASE_URL="$(support_read_env_value "$ENV_FILE" DATABASE_URL_PRODUCTION)" \
			docker run --rm --user 0:0 --network host --env-file "$ENV_FILE" \
			--env DATABASE_URL \
			--volume "$snapshot_dir:/support-cutover" \
			--entrypoint node "$support_cutover_core_image_id" \
			dist/src/support-cutover-main.js export \
			--revision "$EXPECTED_REVISION" --file "$snapshot_container"
	)"
	[[ -f "$snapshot_host" && ! -L "$snapshot_host" &&
		"$(stat -c '%u:%g:%a' "$snapshot_host")" == '0:0:600' ]] ||
		support_cutover_fail 'Support snapshot file is unsafe.' || return 1
	IFS=$'\t' read -r sha256 fingerprint system_id mapping_count high_watermark < <(
		support_cutover_extract_export "$export_result"
	)
	[[ "$sha256" =~ ^[0-9a-f]{64}$ && "$fingerprint" =~ ^[0-9a-f]{64}$ &&
		"$system_id" =~ ^[1-9][0-9]{0,31}$ && "$mapping_count" =~ ^(0|[1-9][0-9]*)$ &&
		"$high_watermark" =~ ^[1-9][0-9]*$ ]] ||
		support_cutover_fail 'Support snapshot anchors are invalid.' || return 1

	docker run --rm --user 0:0 --network host --env-file "$ENV_FILE" \
		--volume "$snapshot_dir:/support-cutover:ro" \
			--entrypoint node "$support_cutover_support_image_id" \
		dist/src/cutover/main.js import \
		--file "$snapshot_container" --sha256 "$sha256" >/dev/null
	support_cutover_run_target activate --sha256 "$sha256" >/dev/null
	DATABASE_URL="$(support_read_env_value "$ENV_FILE" DATABASE_URL_PRODUCTION)" \
		docker run --rm --user 0:0 --network host --env-file "$ENV_FILE" \
		--env DATABASE_URL \
		--volume "$snapshot_dir:/support-cutover:ro" \
			--entrypoint node "$support_cutover_core_image_id" \
		dist/src/support-cutover-main.js activate \
		--revision "$EXPECTED_REVISION" --file "$snapshot_container" \
		--sha256 "$sha256" --fingerprint "$fingerprint" --system-id "$system_id" \
		--mapping-count "$mapping_count" --high-watermark "$high_watermark" >/dev/null
	support_cutover_run_target verify >/dev/null
	support_cutover_verify_steady >/dev/null
}

support_cutover_remove_completed_snapshot() {
	local snapshot_dir snapshot_host
	snapshot_dir="$APP_ROOT/deploy/backend/.support-cutover-$EXPECTED_REVISION"
	snapshot_host="$snapshot_dir/snapshot.json"
	if [[ ! -e "$snapshot_dir" && ! -L "$snapshot_dir" ]]; then
		return
	fi
	[[ -d "$snapshot_dir" && ! -L "$snapshot_dir" &&
		"$(stat -c '%u:%g:%a' "$snapshot_dir")" == '0:0:700' &&
		-f "$snapshot_host" && ! -L "$snapshot_host" &&
		"$(stat -c '%u:%g:%a' "$snapshot_host")" == '0:0:600' ]] ||
		support_cutover_fail 'Completed Support snapshot path is unsafe to remove.' || return 1
	rm -f -- "$snapshot_host"
	rmdir -- "$snapshot_dir"
}

support_cutover_deploy_steady() {
	local first_cutover=false
	if [[ "$(support_database_current_phase)" == 'forward-only' ]]; then
		first_cutover=true
	fi
	env -u SUPPORT_IMAGE -u SUPPORT_REVISION \
		CAMPAIGNS_AUTOMATIC_PROD_PUSH=false \
		REPORTING_AUTOMATIC_PROD_PUSH=false \
		WIDGETS_AUTOMATIC_PROD_PUSH=false \
		BILLING_AUTOMATIC_PROD_PUSH=false \
		IDENTITY_AUTOMATIC_PROD_PUSH=false \
		SUPPORT_FIRST_CUTOVER_DEPLOY="$first_cutover" \
		APP_ROOT="$APP_ROOT" bash "$SERVER_ROOT/scripts/deploy-production.sh"
}

support_cutover_run() {
	[[ "${SUPPORT_CONFIRMATION:-}" == 'CUTOVER SUPPORT OWNERSHIP' ]] ||
		support_cutover_fail 'Support cutover requires exact confirmation.' || return 1
	support_cutover_require_common
	acquire_production_deploy_lock 'Support ownership cutover'
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	support_cutover_validate_images
	support_cutover_validate_marker
	[[ "$(support_cutover_marker_value revision)" == "$EXPECTED_REVISION" ]] ||
		support_cutover_fail 'Support cutover marker belongs to another revision.' || return 1
	local phase
	phase="$(support_database_current_phase)"
	support_database_validate_bound_identity
	support_cutover_validate_gateway_routes
	case "$phase" in
	prepared)
		if ! support_cutover_verify_steady >/dev/null 2>&1; then
			support_cutover_switch_ownership
		fi
		support_database_advance forward-only
		support_cutover_write_marker forward-only
		phase='forward-only'
		;;
	forward-only | active)
		support_cutover_verify_steady >/dev/null
		support_cutover_write_marker forward-only
		;;
	complete)
		support_cutover_verify_steady
		support_cutover_write_marker complete
		support_cutover_remove_completed_snapshot
		printf 'support_cutover_phase=complete\n'
		return
		;;
	*) support_cutover_fail "Support cutover is unavailable from phase=$phase."; return 1 ;;
	esac
	support_cutover_deploy_steady
	support_cutover_validate_images
	support_database_validate_bound_identity
	if [[ "$phase" == 'forward-only' ]]; then
		support_database_advance active
	fi
	support_database_advance complete
	support_cutover_verify_steady
	support_cutover_write_marker complete
	support_cutover_remove_completed_snapshot
	printf 'support_cutover_phase=complete\n'
}

support_cutover_status() {
	support_cutover_require_common
	support_database_status
	if docker image inspect "$(support_cutover_core_image)" \
		"$(support_cutover_support_image)" >/dev/null 2>&1 &&
		support_cutover_validate_images; then
		support_cutover_verify_steady || true
	fi
}

support_cutover_self_test() {
	local source
	source="$(declare -f support_cutover_prepare support_cutover_switch_ownership \
		support_cutover_remove_completed_snapshot support_cutover_run \
		support_cutover_validate_gateway_routes support_cutover_write_marker \
		support_cutover_deploy_steady support_cutover_run_core \
		support_cutover_extract_export)"
	[[ "$source" == *"acquire_production_deploy_lock 'Support ownership prepare'"* &&
		"$source" == *'database_restore_guard_assert_before_mutation healthy-required'* &&
		"$source" == *'--profile migration run --rm --no-deps migrate'* &&
		"$source" == *'support_cutover_validate_gateway_routes'* &&
		"$source" == *'SUPPORT_EXPECTED_GATEWAY_ROUTES_JSON'* &&
		"$source" == *'support_cutover_write_marker preflight-verified'* &&
		"$source" == *'support_cutover_write_marker forward-only'* &&
		"$source" == *'support_cutover_write_marker complete'* &&
		"$source" == *'support_database_validate_bound_identity'* &&
		"$source" == *'support-cutover-main.js export'* &&
		"$source" == *'.support-cutover-$EXPECTED_REVISION'* &&
		"$source" == *'dist/src/cutover/main.js import'* &&
		"$source" == *'support_cutover_compose stop -t 90 api-gateway api'* &&
		"$source" == *'support_database_advance forward-only'* &&
		"$source" == *'DATABASE_URL_PRODUCTION'*'--env DATABASE_URL'* &&
		"$source" == *'join("\t")}\n`'* &&
		"$source" == *'env -u SUPPORT_IMAGE -u SUPPORT_REVISION'* &&
		"$source" != *'SUPPORT_DEPLOY_SCRIPT'* &&
		"$source" == *'SUPPORT_FIRST_CUTOVER_DEPLOY="$first_cutover"'* &&
		"$source" == *'APP_ROOT="$APP_ROOT" bash "$SERVER_ROOT/scripts/deploy-production.sh"'* ]] || return 1
	printf 'support_cutover_production_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--status) support_cutover_status ;;
	--prepare) support_cutover_prepare ;;
	--cutover) support_cutover_run ;;
	--self-test) support_cutover_self_test ;;
	*) support_cutover_fail 'Usage: support-cutover-production.sh --status|--prepare|--cutover|--self-test' ;;
	esac
fi
