#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

if [[ "${1:-}" == '--self-test' ]]; then
	SERVER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
	APP_ROOT="$(cd -- "$SERVER_ROOT/.." && pwd -P)"
else
	APP_ROOT="${APP_ROOT:-/opt/winwidget}"
	SERVER_ROOT="$APP_ROOT/winwidget.ru_server"
fi
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
readonly CONFIRMATION='DROP LEGACY BILLING CORE SOURCE'
readonly POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly PRE_RECEIPT_PREFIX='/root/winwidget-billing-core-source-cleanup-pre-offsite'
readonly POST_RECEIPT_PREFIX='/root/winwidget-billing-core-source-cleanup-post-offsite'
readonly -a BILLING_CORE_CLEANUP_WRITER_SERVICES=(
	api-gateway campaigns-service api outbox-publisher maintenance-worker
	database-restore-worker notification-delivery-worker integration-worker
	reporting-service widgets-service billing-api billing-scheduler billing-worker
	billing-outbox-publisher
)
readonly -a BILLING_CORE_CLEANUP_START_ORDER=(
	outbox-publisher integration-worker maintenance-worker database-restore-worker
	notification-delivery-worker campaigns-service reporting-service widgets-service
	billing-outbox-publisher billing-worker billing-scheduler api billing-api api-gateway
)
declare -a STAGE_CONTAINER_IDS=()
declare -a STAGE_IMAGE_IDS=()
declare -a STAGE_IMAGE_REVISIONS=()
declare -a STAGE_APP_REVISIONS=()
STAGE_RECOVERY_ACTIVE=false
STAGE_REVISION=''
STAGE_PRECOMMIT_FILE=''

# shellcheck source=scripts/production-deploy-lock.sh
source "$SERVER_ROOT/scripts/production-deploy-lock.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$SERVER_ROOT/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/billing-database-lifecycle.sh
source "$SERVER_ROOT/scripts/billing-database-lifecycle.sh"

fail() {
	printf 'Billing Core source cleanup: %s\n' "$1" >&2
	exit 1
}

stage_service_index() {
	local expected="$1" index
	for index in "${!BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}"; do
		if [[ "${BILLING_CORE_CLEANUP_WRITER_SERVICES[$index]}" == "$expected" ]]; then
			printf '%s\n' "$index"
			return
		fi
	done
	return 1
}

stage_identity_set() {
	[[ $# -eq 5 ]] || return 1
	local index
	index="$(stage_service_index "$1")" || return 1
	STAGE_CONTAINER_IDS[$index]="$2"
	STAGE_IMAGE_IDS[$index]="$3"
	STAGE_IMAGE_REVISIONS[$index]="$4"
	STAGE_APP_REVISIONS[$index]="$5"
}

stage_container_id() {
	local index
	index="$(stage_service_index "$1")" || return 1
	printf '%s\n' "${STAGE_CONTAINER_IDS[$index]:-}"
}

stage_image_id() {
	local index
	index="$(stage_service_index "$1")" || return 1
	printf '%s\n' "${STAGE_IMAGE_IDS[$index]:-}"
}

stage_image_revision() {
	local index
	index="$(stage_service_index "$1")" || return 1
	printf '%s\n' "${STAGE_IMAGE_REVISIONS[$index]:-}"
}

stage_app_revision() {
	local index
	index="$(stage_service_index "$1")" || return 1
	printf '%s\n' "${STAGE_APP_REVISIONS[$index]:-}"
}

sha256_file() {
	billing_core_source_cleanup_sha256_file "$1"
}

get_env_value() {
	billing_read_env_value "$ENV_FILE" "$1"
}

compose_target() {
	local revision="$1"
	shift
	billing_compose "$revision" "$ENV_FILE" "$COMPOSE_FILE" "$@"
}

require_confirmation() {
	[[ "${BILLING_CORE_SOURCE_CLEANUP_CONFIRMATION:-}" == "$CONFIRMATION" ]] ||
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

assert_production_context() {
	local restore_worker_mode="${1:-healthy-required}"
	[[ "$restore_worker_mode" =~ ^(healthy-required|identity-if-present)$ ]] ||
		fail 'invalid database restore guard mode'
	[[ "$(id -u)" == '0' && "$(uname -s)" == 'Linux' ]] ||
		fail 'production cleanup requires root on Linux'
	[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
		"$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
		fail 'backend production env must be root-owned mode 600'
	[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] ||
		fail 'production Compose file is unavailable'
	[[ -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" ]] ||
		fail 'ambient Docker endpoint overrides are forbidden'
	[[ "$(docker context show)" == 'default' &&
		"$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock' &&
		"$(docker info --format '{{.OSType}}')" == 'linux' ]] ||
		fail 'the canonical local production Docker daemon is required'
	# database-restore-production-guard: before-mutation
	database_restore_guard_assert_before_mutation "$restore_worker_mode" "$ENV_FILE"
}

assert_readonly_production_context() {
	[[ "$(id -u)" == '0' && "$(uname -s)" == 'Linux' ]] ||
		fail 'production status requires root on Linux'
	[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
		"$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
		fail 'backend production env must be root-owned mode 600'
	[[ -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" ]] ||
		fail 'ambient Docker endpoint overrides are forbidden'
	[[ "$(docker context show)" == 'default' &&
		"$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock' &&
		"$(docker info --format '{{.OSType}}')" == 'linux' ]] ||
		fail 'the canonical local production Docker daemon is required'
}

ensure_private_directory() {
	local directory="$1" parent
	parent="$(dirname -- "$directory")"
	if [[ ! -e "$parent" && ! -L "$parent" ]]; then
		mkdir "$parent"
		chown 0:0 "$parent"
		chmod 700 "$parent"
	fi
	[[ -d "$parent" && ! -L "$parent" &&
		"$(stat -c '%u:%g:%a' "$parent")" == '0:0:700' ]] ||
		fail 'cleanup evidence parent directory is unsafe'
	if [[ ! -e "$directory" && ! -L "$directory" ]]; then
		mkdir "$directory"
		chown 0:0 "$directory"
		chmod 700 "$directory"
	fi
	[[ -d "$directory" && ! -L "$directory" &&
		"$(stat -c '%u:%g:%a' "$directory")" == '0:0:700' ]] ||
		fail 'cleanup evidence directory is unsafe'
}

remove_recoverable_partial() {
	local partial="$1" directory
	directory="$(dirname -- "$partial")"
	[[ -d "$directory" && ! -L "$directory" &&
		"$(stat -c '%u:%g:%a' "$directory")" == '0:0:700' ]] ||
		fail 'cleanup partial directory is unsafe'
	if [[ ! -e "$partial" && ! -L "$partial" ]]; then
		return
	fi
	[[ -f "$partial" && ! -L "$partial" &&
		"$(stat -c '%u:%g' "$partial")" == '0:0' ]] ||
		fail 'cleanup partial file is unsafe'
	rm -f -- "$partial"
}

validate_private_file() {
	local file="$1" sha
	[[ -f "$file" && ! -L "$file" ]] || return 1
	sha="$(sha256_file "$file")" || return 1
	billing_core_source_cleanup_validate_private_file "$file" "$sha"
}

promote_private_file() {
	local source="$1" destination="$2" partial="$2.partial"
	[[ -f "$source" && ! -L "$source" && -s "$source" &&
		"$(stat -c '%u:%g:%a' "$source")" == '0:0:600' ]] || return 1
	if [[ -e "$destination" || -L "$destination" ]]; then
		validate_private_file "$destination" || return 1
		[[ "$(sha256_file "$source")" == "$(sha256_file "$destination")" ]]
		return
	fi
	remove_recoverable_partial "$partial"
	cp -- "$source" "$partial"
	chown 0:0 "$partial"
	chmod 600 "$partial"
	mv -fT "$partial" "$destination"
}

image_identity() {
	local image="$1" expected_revision="$2" expected_user="$3"
	local image_id revision user
	image_id="$(docker image inspect --format '{{.Id}}' "$image")" || return 1
	revision="$(docker image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" || return 1
	user="$(docker image inspect --format '{{.Config.User}}' "$image")" || return 1
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$revision" == "$expected_revision" ]] || return 1
	case "$expected_user" in
	billing) [[ "$user" == 'billing' ]] || return 1 ;;
	non-root) [[ -n "$user" && "$user" != '0' && "$user" != 'root' ]] || return 1 ;;
	*) return 1 ;;
	esac
	printf '%s' "$image_id"
}

verify_candidate_images() {
	local revision="$1" expected_core_id="${2:-}" expected_billing_id="${3:-}"
	local core_id billing_id
	core_id="$(image_identity "winwidget-api:git-$revision" "$revision" non-root)" ||
		fail 'cleanup Core candidate image identity is invalid'
	billing_id="$(image_identity "winwidget-billing:git-$revision" "$revision" billing)" ||
		fail 'cleanup Billing candidate image identity is invalid'
	if [[ -n "$expected_core_id" || -n "$expected_billing_id" ]]; then
		[[ "$core_id" == "$expected_core_id" && "$billing_id" == "$expected_billing_id" ]] ||
			fail 'cleanup candidate images changed after they were pinned'
	fi
	printf '%s\t%s\n' "$core_id" "$billing_id"
}

verify_complete_ownership_boundary() {
	local previous_revision="$1" revision="$2" generation snapshot projection route database_id
	billing_database_validate_marker || fail 'Billing database lifecycle marker is invalid'
	[[ "$(billing_database_marker_value phase)" == 'complete' &&
		"$(billing_database_marker_value ownership_revision)" == "$previous_revision" &&
		"$(billing_database_marker_value cleanup_revision)" == "$revision" &&
		"$(billing_database_marker_value switch_generation)" == '2' ]] ||
		fail 'Billing lifecycle is not complete generation 2 with this cleanup revision'
	# Defined by the sourced billing database lifecycle contract.
	# shellcheck disable=SC2154
	[[ -f "$billing_cutover_marker" && ! -L "$billing_cutover_marker" &&
		"$(stat -c '%u:%g:%a' "$billing_cutover_marker")" == '0:0:600' ]] ||
		fail 'Billing cutover marker is unsafe'
	[[ "$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" phase)" == 'complete' &&
		"$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" revision)" == "$previous_revision" &&
		"$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" cleanup_revision)" == "$revision" &&
		"$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" generation)" == '2' ]] ||
		fail 'Billing cutover marker does not match the lifecycle boundary'
	generation="$(billing_database_marker_value switch_generation)"
	snapshot="$(billing_database_marker_value snapshot_sha256)"
	projection="$(billing_database_marker_value projection_evidence_sha256)"
	route="$(billing_database_marker_value route_evidence_sha256)"
	database_id="$(billing_database_marker_value database_id)"
	[[ "$snapshot" =~ ^[0-9a-f]{64}$ && "$projection" =~ ^[0-9a-f]{64}$ &&
		"$route" =~ ^[0-9a-f]{64}$ &&
		"$database_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
		fail 'Billing ownership evidence identity is invalid'
	printf '%s\t%s\t%s\t%s\t%s\n' \
		"$generation" "$snapshot" "$projection" "$route" "$database_id"
}

validate_gateway_container_routes() {
	[[ $# -eq 1 ]] || return 1
	GATEWAY_ROUTES="$1" billing_release_node -e '
const fs = require("node:fs");
const documents = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(documents) || documents.length !== 1) process.exit(1);
const values = documents[0].Config.Env.filter(value => value.startsWith("GATEWAY_ROUTES_JSON="));
if (values.length !== 1 || values[0].slice("GATEWAY_ROUTES_JSON=".length) !== process.env.GATEWAY_ROUTES) process.exit(1);
'
}

verify_route_contract() {
	local revision="$1" gateway gateway_routes
	gateway_routes="$(get_env_value GATEWAY_ROUTES_JSON)" || return 1
	GATEWAY_ROUTES="$gateway_routes" billing_release_node <<'NODE'
const expected = [
  ['/api/v1/payments', 'billing-payments'],
  ['/api/v1/subscriptions', 'billing-subscriptions'],
  ['/api/v1/tariff-prices', 'billing-tariff-prices'],
  ['/api/v1/affiliate', 'billing-affiliate'],
];
let routes;
try { routes = JSON.parse(process.env.GATEWAY_ROUTES); } catch { process.exit(1); }
if (!Array.isArray(routes)) process.exit(1);
for (const [pathPrefix, id] of expected) {
  const matches = routes.filter(route => route?.pathPrefix === pathPrefix);
  if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify({
    id, pathPrefix, upstreamUrl: 'http://127.0.0.1:4800',
    authPolicy: 'optional', timeoutMs: 30000,
  })) process.exit(1);
}
if (!routes.some(route => route?.pathPrefix === '/api/v1' &&
    route.upstreamUrl === 'http://127.0.0.1:4200')) process.exit(1);
NODE
	gateway="$(compose_target "$revision" ps --status running -q api-gateway 2>/dev/null || true)"
	[[ "$gateway" =~ ^[0-9a-f]{64}$ ]] || fail 'running Gateway is unavailable'
	docker inspect "$gateway" | validate_gateway_container_routes "$gateway_routes"
}

generic_database_query() {
	local image="$1" env_key="$2" sql="$3" database_url
	database_url="$(get_env_value "$env_key")" || return 1
	DATABASE_QUERY_URL="$database_url" DATABASE_QUERY_SQL="$sql" \
		docker run --rm --network host \
			-e DATABASE_QUERY_URL -e DATABASE_QUERY_SQL \
			--entrypoint node "$image" -e '
const { spawnSync } = require("node:child_process");
const url = new URL(process.env.DATABASE_QUERY_URL);
if (!["postgres:", "postgresql:"].includes(url.protocol)) process.exit(1);
const password = url.password ? decodeURIComponent(url.password) : url.searchParams.get("password") || "";
url.password = "";
for (const key of ["password", "schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size"]) url.searchParams.delete(key);
const env = { ...process.env, PGPASSWORD: password };
delete env.DATABASE_QUERY_URL;
const result = spawnSync("psql", ["--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", url.toString(), "--command", process.env.DATABASE_QUERY_SQL], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
if (result.status !== 0) process.exit(1);
process.stdout.write(result.stdout.trim());
'
}

verify_billing_database_identity() {
	local image="$1" previous_revision="$2" database_id="$3" result
	result="$(generic_database_query "$image" BILLING_BACKUP_URL "
SELECT
  identity.phase::text || E'\\t' || identity.ownership_generation::text || E'\\t' ||
  identity.database_id::text || E'\\t' || marker.phase::text || E'\\t' ||
  marker.generation::text || E'\\t' || marker.ownership_revision
FROM billing.service_identity identity
CROSS JOIN billing.billing_ownership_marker marker
WHERE identity.id = 'singleton' AND identity.service_name = 'billing-service'
  AND marker.id = 'singleton';
")" || fail 'Billing database identity cannot be read'
	[[ "$result" == "ACTIVE"$'\t'"2"$'\t'"$database_id"$'\t'"COMPLETE"$'\t'"2"$'\t'"$previous_revision" ]] ||
		fail 'Billing database is not the exact COMPLETE generation-2 owner'
}

create_dump() {
	local image="$1" env_key="$2" schema="$3" destination="$4"
	local database_url directory filename partial
	database_url="$(get_env_value "$env_key")" || fail "missing production URL: $env_key"
	[[ -n "$database_url" && "$schema" =~ ^(public|billing)$ ]] || fail 'backup input is invalid'
	directory="$(dirname -- "$destination")"
	filename="$(basename -- "$destination")"
	partial="$destination.partial"
	[[ ! -e "$destination" && ! -L "$destination" ]] || fail 'backup destination already exists'
	remove_recoverable_partial "$partial"
	CLEANUP_DATABASE_URL="$database_url" CLEANUP_SCHEMA="$schema" CLEANUP_FILE="$filename.partial" \
		docker run --rm --user 0:0 --network host \
			-e CLEANUP_DATABASE_URL -e CLEANUP_SCHEMA -e CLEANUP_FILE \
			--mount "type=bind,source=$directory,target=/evidence" \
			--entrypoint node "$image" -e '
const { spawnSync } = require("node:child_process");
const url = new URL(process.env.CLEANUP_DATABASE_URL);
if (!["postgres:", "postgresql:"].includes(url.protocol)) process.exit(1);
const password = url.password ? decodeURIComponent(url.password) : url.searchParams.get("password") || "";
url.password = "";
for (const key of ["password", "schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size"]) url.searchParams.delete(key);
const env = { ...process.env, PGPASSWORD: password };
delete env.CLEANUP_DATABASE_URL;
const result = spawnSync("pg_dump", [
  "--format=custom", "--compress=9", "--no-owner", "--no-privileges",
  "--no-password", "--serializable-deferrable", "--schema", process.env.CLEANUP_SCHEMA,
  "--file", `/evidence/${process.env.CLEANUP_FILE}`, url.toString(),
], { env, stdio: ["ignore", "ignore", "inherit"] });
if (result.status !== 0) process.exit(1);
'
	unset database_url
	[[ -f "$partial" && ! -L "$partial" && -s "$partial" ]] || fail 'pg_dump did not create a dump'
	chown 0:0 "$partial"
	chmod 600 "$partial"
	mv -fT "$partial" "$destination"
}

validate_dump_list() {
	local dump="$1"
	docker run --rm --network none \
		--mount "type=bind,source=$(dirname -- "$dump"),target=/evidence,readonly" \
		"$POSTGRES_IMAGE" pg_restore --list "/evidence/$(basename -- "$dump")" >/dev/null
}

ensure_dump() {
	local image="$1" env_key="$2" schema="$3" destination="$4"
	if [[ -e "$destination" || -L "$destination" ]]; then
		validate_private_file "$destination" || fail 'existing cleanup dump is unsafe'
	else
		create_dump "$image" "$env_key" "$schema" "$destination"
	fi
	validate_dump_list "$destination"
}

write_stage_precommit() {
	[[ $# -eq 7 ]] || return 1
	local revision="$1" previous_revision="$2" generation="$3" snapshot="$4"
	local projection="$5" route="$6" destination="$7"
	local service container_id identity image_id image_revision app_revision state
	local records='' captured_at partial
	[[ ! -e "$destination" && ! -L "$destination" ]] || return 1
	STAGE_CONTAINER_IDS=()
	STAGE_IMAGE_IDS=()
	STAGE_IMAGE_REVISIONS=()
	STAGE_APP_REVISIONS=()
	for service in "${BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}"; do
		container_id="$(compose_target "$revision" ps --status running -q "$service" 2>/dev/null || true)"
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
			fail "exactly one running SHA A writer is required before stop: $service"
		identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)"
		image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
		image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
		app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null |
			awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }')" ||
			fail "writer APP_REVISION is ambiguous: $service"
		state="$(docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.RestartCount}}' "$container_id" 2>/dev/null || true)"
		[[ "$identity" == "winwidget|$service" && "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$image_revision" == "$previous_revision" && "$app_revision" == "$previous_revision" &&
			"$state" == 'running|true|0' ]] || fail "untrusted or restarted SHA A writer: $service"
		stage_identity_set "$service" "$container_id" "$image_id" "$image_revision" "$app_revision"
		records+="$service"$'\t'"$container_id"$'\t'"$image_id"$'\t'"$image_revision"$'\t'"$app_revision"$'\n'
	done
	captured_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	partial="$destination.partial"
	remove_recoverable_partial "$partial"
	WRITER_RECORDS="$records" PREVIOUS_REVISION="$previous_revision" \
		CLEANUP_REVISION="$revision" OWNERSHIP_GENERATION="$generation" \
		SOURCE_SNAPSHOT="$snapshot" PROJECTION_EVIDENCE="$projection" \
		ROUTE_EVIDENCE="$route" CAPTURED_AT="$captured_at" billing_release_node <<'NODE' >"$partial"
const services = process.env.WRITER_RECORDS.trim().split('\n').map(line => {
  const [service, containerId, imageId, imageRevision, appRevision] = line.split('\t');
  return { service, containerId, imageId, imageRevision, appRevision, state: 'running' };
});
const value = {
  schemaVersion: 1,
  action: 'billing-core-source-cleanup-writer-precommit',
  previousRevision: process.env.PREVIOUS_REVISION,
  cleanupRevision: process.env.CLEANUP_REVISION,
  ownershipGeneration: Number(process.env.OWNERSHIP_GENERATION),
  sourceSnapshotSha256: process.env.SOURCE_SNAPSHOT,
  projectionEvidenceSha256: process.env.PROJECTION_EVIDENCE,
  routeEvidenceSha256: process.env.ROUTE_EVIDENCE,
  reportingOutcomeTopology: 'steady',
  services,
  capturedAt: process.env.CAPTURED_AT,
};
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE
	chown 0:0 "$partial"
	chmod 600 "$partial"
	mv -fT "$partial" "$destination"
}

load_stage_precommit() {
	[[ $# -eq 7 ]] || return 1
	local output service container_id image_id image_revision app_revision state
	output="$(WRITER_FILE="$1" PREVIOUS_REVISION="$2" CLEANUP_REVISION="$3" \
		OWNERSHIP_GENERATION="$4" SOURCE_SNAPSHOT="$5" PROJECTION_EVIDENCE="$6" \
		ROUTE_EVIDENCE="$7" billing_release_node <<'NODE'
const fs = require('node:fs');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const services = [
  'api-gateway','campaigns-service','api','outbox-publisher','maintenance-worker',
  'database-restore-worker','notification-delivery-worker','integration-worker',
  'reporting-service','widgets-service','billing-api','billing-scheduler','billing-worker',
  'billing-outbox-publisher',
];
let value;
try { value = JSON.parse(fs.readFileSync(process.env.WRITER_FILE, 'utf8')); } catch { process.exit(1); }
if (!exact(value, ['schemaVersion','action','previousRevision','cleanupRevision','ownershipGeneration',
    'sourceSnapshotSha256','projectionEvidenceSha256','routeEvidenceSha256',
    'reportingOutcomeTopology','services','capturedAt']) || value.schemaVersion !== 1 ||
    value.action !== 'billing-core-source-cleanup-writer-precommit' ||
    value.previousRevision !== process.env.PREVIOUS_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    String(value.ownershipGeneration) !== process.env.OWNERSHIP_GENERATION ||
    value.sourceSnapshotSha256 !== process.env.SOURCE_SNAPSHOT ||
    value.projectionEvidenceSha256 !== process.env.PROJECTION_EVIDENCE ||
    value.routeEvidenceSha256 !== process.env.ROUTE_EVIDENCE ||
    value.reportingOutcomeTopology !== 'steady' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.capturedAt) ||
    !Array.isArray(value.services) || value.services.length !== services.length) process.exit(1);
for (let index = 0; index < services.length; index += 1) {
  const item = value.services[index];
  if (!exact(item, ['service','containerId','imageId','imageRevision','appRevision','state']) ||
      item.service !== services[index] || !/^[0-9a-f]{64}$/.test(item.containerId) ||
      !/^sha256:[0-9a-f]{64}$/.test(item.imageId) ||
      item.imageRevision !== process.env.PREVIOUS_REVISION ||
      item.appRevision !== process.env.PREVIOUS_REVISION || item.state !== 'running') process.exit(1);
  process.stdout.write([item.service,item.containerId,item.imageId,item.imageRevision,item.appRevision].join('\t') + '\n');
}
NODE
	)" || return 1
	STAGE_CONTAINER_IDS=()
	STAGE_IMAGE_IDS=()
	STAGE_IMAGE_REVISIONS=()
	STAGE_APP_REVISIONS=()
	while IFS=$'\t' read -r service container_id image_id image_revision app_revision; do
		[[ -n "$service" ]] || continue
		stage_identity_set "$service" "$container_id" "$image_id" "$image_revision" "$app_revision"
	done <<<"$output"
	[[ "${#STAGE_CONTAINER_IDS[@]}" -eq "${#BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}" ]]
}

inspect_stage_writer_state() {
	[[ $# -eq 2 ]] || return 1
	local service="$1" allowed="$2" container_id identity image_id image_revision app_revision state
	container_id="$(stage_container_id "$service")" || return 1
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
	image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
	app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null |
		awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
	state="$(docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}|{{.RestartCount}}' "$container_id" 2>/dev/null || true)"
	[[ "$identity" == "winwidget|$service" && "$image_id" == "$(stage_image_id "$service")" &&
		"$image_revision" == "$(stage_image_revision "$service")" &&
		"$app_revision" == "$(stage_app_revision "$service")" ]] || return 1
	case "$allowed:$state" in
	running:running\|true\|0\|false\|\|0) printf 'running\n' ;;
	stopped:exited\|false\|0\|false\|\|0 | stopped:exited\|false\|143\|false\|\|0)
		printf 'stopped\n'
		;;
	either:running\|true\|0\|false\|\|0) printf 'running\n' ;;
	either:exited\|false\|0\|false\|\|0 | either:exited\|false\|143\|false\|\|0)
		printf 'stopped\n'
		;;
	*) return 1 ;;
	esac
}

stop_stage_writers() {
	local service state
	for service in "${BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}"; do
		state="$(inspect_stage_writer_state "$service" either)" ||
			fail "unsafe writer identity/state before stop: $service"
		if [[ "$state" == 'running' ]]; then
			docker stop --time 30 "$(stage_container_id "$service")" >/dev/null ||
				fail "could not stop SHA A writer cleanly: $service"
		fi
		[[ "$(inspect_stage_writer_state "$service" stopped)" == 'stopped' ]] ||
			fail "SHA A writer did not reach a clean exited state: $service"
	done
}

write_writer_evidence() {
	[[ $# -eq 7 ]] || return 1
	local revision="$1" previous_revision="$2" generation="$3" snapshot="$4"
	local projection="$5" route="$6" destination="$7"
	local service container_id state exit_code oom_killed error records='' captured_at partial
	[[ ! -e "$destination" && ! -L "$destination" ]] || return 1
	for service in "${BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}"; do
		[[ "$(inspect_stage_writer_state "$service" stopped)" == 'stopped' ]] ||
			fail "writer is not exact and stopped at evidence capture: $service"
		container_id="$(stage_container_id "$service")"
		IFS='|' read -r state exit_code oom_killed error <<<"$(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}' "$container_id")"
		[[ "$state" == 'exited' && "$exit_code" =~ ^(0|143)$ && "$oom_killed" == 'false' && -z "$error" ]] || return 1
		records+="$service"$'\t'"$container_id"$'\t'"$(stage_image_id "$service")"$'\t'"$(stage_image_revision "$service")"$'\t'"$(stage_app_revision "$service")"$'\t'"$exit_code"$'\n'
	done
	captured_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	partial="$destination.partial"
	remove_recoverable_partial "$partial"
	WRITER_RECORDS="$records" PREVIOUS_REVISION="$previous_revision" \
		CLEANUP_REVISION="$revision" OWNERSHIP_GENERATION="$generation" \
		SOURCE_SNAPSHOT="$snapshot" PROJECTION_EVIDENCE="$projection" \
		ROUTE_EVIDENCE="$route" CAPTURED_AT="$captured_at" billing_release_node <<'NODE' >"$partial"
const services = process.env.WRITER_RECORDS.trim().split('\n').map(line => {
  const [service, containerId, imageId, imageRevision, appRevision, exitCode] = line.split('\t');
  return { service, containerId, imageId, imageRevision, appRevision,
    state: 'exited', exitCode: Number(exitCode), oomKilled: false, error: '' };
});
const value = {
  schemaVersion: 1,
  action: 'billing-core-source-cleanup-stopped-writers',
  previousRevision: process.env.PREVIOUS_REVISION,
  cleanupRevision: process.env.CLEANUP_REVISION,
  ownershipGeneration: Number(process.env.OWNERSHIP_GENERATION),
  sourceSnapshotSha256: process.env.SOURCE_SNAPSHOT,
  projectionEvidenceSha256: process.env.PROJECTION_EVIDENCE,
  routeEvidenceSha256: process.env.ROUTE_EVIDENCE,
  services,
  capturedAt: process.env.CAPTURED_AT,
};
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE
	chown 0:0 "$partial"
	chmod 600 "$partial"
	mv -fT "$partial" "$destination"
}

validate_writer_evidence() {
	[[ $# -eq 7 ]] || return 1
	WRITER_FILE="$1" PREVIOUS_REVISION="$2" CLEANUP_REVISION="$3" \
		OWNERSHIP_GENERATION="$4" SOURCE_SNAPSHOT="$5" \
		PROJECTION_EVIDENCE="$6" ROUTE_EVIDENCE="$7" billing_release_node <<'NODE'
const fs = require('node:fs');
const expectedServices = [
  'api-gateway','campaigns-service','api','outbox-publisher','maintenance-worker',
  'database-restore-worker','notification-delivery-worker','integration-worker',
  'reporting-service','widgets-service','billing-api','billing-scheduler','billing-worker',
  'billing-outbox-publisher',
];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === [...keys].sort().join('|');
let value;
try { value = JSON.parse(fs.readFileSync(process.env.WRITER_FILE, 'utf8')); } catch { process.exit(1); }
if (!exact(value, ['schemaVersion','action','previousRevision','cleanupRevision','ownershipGeneration',
    'sourceSnapshotSha256','projectionEvidenceSha256','routeEvidenceSha256','services','capturedAt']) ||
    value.schemaVersion !== 1 || value.action !== 'billing-core-source-cleanup-stopped-writers' ||
    value.previousRevision !== process.env.PREVIOUS_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    String(value.ownershipGeneration) !== process.env.OWNERSHIP_GENERATION ||
    value.sourceSnapshotSha256 !== process.env.SOURCE_SNAPSHOT ||
    value.projectionEvidenceSha256 !== process.env.PROJECTION_EVIDENCE ||
    value.routeEvidenceSha256 !== process.env.ROUTE_EVIDENCE ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.capturedAt) ||
    !Array.isArray(value.services) || value.services.length !== expectedServices.length) process.exit(1);
for (let index = 0; index < expectedServices.length; index += 1) {
  const item = value.services[index];
  if (!exact(item, ['service','containerId','imageId','imageRevision','appRevision',
      'state','exitCode','oomKilled','error']) || item.service !== expectedServices[index] ||
      item.state !== 'exited' || ![0,143].includes(item.exitCode) || item.oomKilled !== false ||
      item.error !== '' || !/^[0-9a-f]{64}$/.test(item.containerId) ||
      !/^sha256:[0-9a-f]{64}$/.test(item.imageId) ||
      item.imageRevision !== process.env.PREVIOUS_REVISION ||
      item.appRevision !== process.env.PREVIOUS_REVISION) process.exit(1);
}
NODE
}

load_writer_evidence() {
	[[ $# -eq 7 ]] || return 1
	validate_writer_evidence "$@" || return 1
	local output service container_id image_id image_revision app_revision
	output="$(WRITER_FILE="$1" billing_release_node <<'NODE'
const value = JSON.parse(require('node:fs').readFileSync(process.env.WRITER_FILE, 'utf8'));
for (const item of value.services)
  process.stdout.write([item.service,item.containerId,item.imageId,item.imageRevision,item.appRevision].join('\t') + '\n');
NODE
	)" || return 1
	STAGE_CONTAINER_IDS=()
	STAGE_IMAGE_IDS=()
	STAGE_IMAGE_REVISIONS=()
	STAGE_APP_REVISIONS=()
	while IFS=$'\t' read -r service container_id image_id image_revision app_revision; do
		[[ -n "$service" ]] || continue
		stage_identity_set "$service" "$container_id" "$image_id" "$image_revision" "$app_revision"
	done <<<"$output"
	[[ "${#STAGE_CONTAINER_IDS[@]}" -eq "${#BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}" ]]
}

validate_stopped_writers_live() {
	load_writer_evidence "$@" || return 1
	local service
	for service in "${BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}"; do
		[[ "$(inspect_stage_writer_state "$service" stopped)" == 'stopped' ]] || return 1
	done
}

require_reporting_outcome_topology_steady() {
	local revision="$1" rabbitmq vhost bindings old_count steady_count
	rabbitmq="$(compose_target "$revision" ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ "$rabbitmq" =~ ^[0-9a-f]{64}$ ]] || return 1
	vhost="$(get_env_value RABBITMQ_VHOST)" || return 1
	[[ "$vhost" == 'winwidget' ]] || return 1
	bindings="$(docker exec "$rabbitmq" rabbitmqctl --silent list_bindings -p "$vhost" \
		source_name destination_name routing_key)" || return 1
	old_count="$(awk '$1 == "winwidget.events" && $2 == "winwidget.reporting.delivery-outcome" && $3 == "notification.delivery.outcome.v1" { count += 1 } END { print count + 0 }' <<<"$bindings")"
	steady_count="$(awk '$1 == "winwidget.events" && $2 == "winwidget.reporting.delivery-outcome" && $3 == "reporting.notification.delivery.outcome.v1" { count += 1 } END { print count + 0 }' <<<"$bindings")"
	[[ "$old_count" == '0' && "$steady_count" == '1' ]]
}

require_core_sessions_drained() {
	local revision="$1" sessions
	sessions="$(generic_database_query "winwidget-api:git-$revision" DATABASE_MIGRATION_URL_PRODUCTION "
SELECT count(*)
FROM pg_stat_activity
WHERE datname = current_database()
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid();
")" || return 1
	[[ "$sessions" == '0' ]]
}

read_core_drain_state() {
	local revision="$1"
	generic_database_query "winwidget-api:git-$revision" DATABASE_BACKUP_URL "
SELECT
  (SELECT count(*) FROM public.billing_settings_compositions
   WHERE status IN ('PENDING'::public.\"BillingSettingsCompositionStatus\", 'BILLING_APPLIED'::public.\"BillingSettingsCompositionStatus\")) || E'\\t' ||
  (SELECT count(*) FROM public.outbox_events
   WHERE event_type = ANY(ARRAY[
     'billing.settings.source.changed.v1','billing.payment.changed.v1','billing.subscription.changed.v1',
     'notification.subscription-expiry.email.requested.v1','notification.subscription-expiry.telegram.requested.v1',
     'payment.auto-renewal.charge.requested.v1','payment.notification.telegram.requested.v1','payment.succeeded.v1'
   ]) AND status <> 'PUBLISHED'::public.\"OutboxEventStatus\") || E'\\t' ||
  (SELECT count(*) FROM public.integration_delivery_receipts
   WHERE integration IN ('auto-renewal','notification-delivery-outcome')
     AND status IN ('PROCESSING'::public.\"IntegrationDeliveryReceiptStatus\", 'RETRY_SCHEDULED'::public.\"IntegrationDeliveryReceiptStatus\")) || E'\\t' ||
  (SELECT count(*) FROM public.integration_delivery_failures
   WHERE integration IN ('auto-renewal','notification-delivery-outcome') AND resolved_at IS NULL);
"
}

require_core_drain_state() {
	[[ "$(read_core_drain_state "$1")" == $'0\t0\t0\t0' ]]
}

require_billing_database_quiescent() {
	local revision="$1" previous_revision="$2" database_id="$3" state
	state="$(generic_database_query "winwidget-api:git-$revision" BILLING_BACKUP_URL "
SELECT
  identity.database_id::text || E'\\t' || identity.phase::text || E'\\t' ||
  identity.ownership_generation::text || E'\\t' || marker.phase::text || E'\\t' ||
  marker.generation::text || E'\\t' || marker.prepared_revision || E'\\t' ||
  marker.ownership_revision || E'\\t' || marker.cleanup_revision || E'\\t' ||
  (SELECT count(*) FROM billing.outbox_events WHERE status::text <> 'PUBLISHED') || E'\\t' ||
  (SELECT count(*) FROM billing.provider_operations WHERE status::text IN ('PROCESSING','UNKNOWN')) || E'\\t' ||
  (SELECT count(*) FROM pg_stat_activity
   WHERE datname = current_database() AND backend_type = 'client backend'
     AND pid <> pg_backend_pid())
FROM billing.service_identity AS identity
CROSS JOIN billing.billing_ownership_marker AS marker
WHERE identity.id = 'singleton' AND identity.service_name = 'billing-service'
  AND marker.id = 'singleton';
")" || return 1
	[[ "$state" == "$database_id"$'\t''ACTIVE'$'\t''2'$'\t''COMPLETE'$'\t''2'$'\t'"$previous_revision"$'\t'"$previous_revision"$'\t'"$previous_revision"$'\t''0'$'\t''0'$'\t''0' ]]
}

read_queue_listing() {
	local revision="$1" rabbitmq vhost
	rabbitmq="$(compose_target "$revision" ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ "$rabbitmq" =~ ^[0-9a-f]{64}$ ]] || return 1
	vhost="$(get_env_value RABBITMQ_VHOST)" || return 1
	[[ "$vhost" == 'winwidget' ]] || return 1
	docker exec "$rabbitmq" rabbitmqctl --silent list_queues -p "$vhost" \
		name messages_ready messages_unacknowledged consumers
}

require_stopped_queue_boundary() {
	local listing
	listing="$(read_queue_listing "$1")" || return 1
	QUEUE_LISTING="$listing" billing_release_node <<'NODE'
const rows = process.env.QUEUE_LISTING.trim().split('\n').filter(Boolean)
  .map(line => line.trim().split(/\s+/));
const actual = new Map();
for (const row of rows) {
  if (row.length !== 4 || actual.has(row[0])) process.exit(1);
  const values = row.slice(1).map(Number);
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) process.exit(1);
  actual.set(row[0], values);
}
const retained = [
  'winwidget.billing.identity.v1','winwidget.billing.offer.v1',
  'winwidget.billing.notification-routing.v1','winwidget.billing.settings-source.v1',
  'winwidget.billing.trial.v1','winwidget.billing.referral.v1',
  'winwidget.billing.lifecycle-repair.v1','winwidget.payment.auto-renewal',
  'winwidget.billing.notification-delivery-outcome',
];
const expected = retained.flatMap(name => [name, `${name}.retry.1`, `${name}.retry.2`,
  `${name}.retry.3`, `${name}.dead-letter`]);
const retired = 'winwidget.notification.delivery-outcome';
expected.push(retired, `${retired}.retry-v2.1`, `${retired}.retry-v2.2`,
  `${retired}.retry-v2.3`, `${retired}.dead-letter`);
if (expected.length !== 50) process.exit(1);
for (const name of expected) {
  const values = actual.get(name);
  if (!values || values.some(value => value !== 0)) process.exit(1);
}
NODE
}

validate_live_broker_from_queue_evidence() {
	local revision="$1" evidence="$2" expected rabbitmq actual vhost
	expected="$(QUEUE_FILE="$evidence" billing_release_node <<'NODE'
const value = JSON.parse(require('node:fs').readFileSync(process.env.QUEUE_FILE, 'utf8'));
const broker = value.rabbitmq;
process.stdout.write([broker.imageId,broker.vhost].join('\t'));
NODE
	)" || return 1
	rabbitmq="$(compose_target "$revision" ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ "$rabbitmq" =~ ^[0-9a-f]{64}$ ]] || return 1
	vhost="$(get_env_value RABBITMQ_VHOST)" || return 1
	actual="$(docker inspect --format '{{.Image}}' "$rabbitmq" 2>/dev/null || true)"$'\t'"$vhost"
	[[ "$actual" == "$expected" ]]
}

retired_outcome_topology_contract() {
	[[ $# -eq 1 ]] || return 1
	local revision="$1" rabbitmq identity image_id vhost queues bindings
	rabbitmq="$(compose_target "$revision" ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ "$rabbitmq" =~ ^[0-9a-f]{64}$ ]] || return 1
	identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
		"$rabbitmq" 2>/dev/null || true)"
	image_id="$(docker inspect --format '{{.Image}}' "$rabbitmq" 2>/dev/null || true)"
	vhost="$(get_env_value RABBITMQ_VHOST)" || return 1
	[[ "$identity" == 'winwidget|rabbitmq' && "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$vhost" == 'winwidget' ]] || return 1
	queues="$(docker exec "$rabbitmq" rabbitmqctl --silent list_queues -p "$vhost" name)" || return 1
	bindings="$(docker exec "$rabbitmq" rabbitmqctl --silent list_bindings -p "$vhost" destination_name)" || return 1
	RABBITMQ_IMAGE_ID="$image_id" RABBITMQ_VHOST_VALUE="$vhost" \
		RABBITMQ_QUEUE_NAMES="$queues" RABBITMQ_BINDING_DESTINATIONS="$bindings" billing_release_node <<'NODE'
const crypto = require('node:crypto');
const retiredQueues = [
  'winwidget.notification.delivery-outcome',
  'winwidget.notification.delivery-outcome.retry-v2.1',
  'winwidget.notification.delivery-outcome.retry-v2.2',
  'winwidget.notification.delivery-outcome.retry-v2.3',
  'winwidget.notification.delivery-outcome.dead-letter',
];
const names = value => new Set(String(value || '').split('\n').map(line => line.trim()).filter(Boolean));
const queues = names(process.env.RABBITMQ_QUEUE_NAMES);
const destinations = names(process.env.RABBITMQ_BINDING_DESTINATIONS);
if (retiredQueues.some(name => queues.has(name) || destinations.has(name))) process.exit(1);
const contract = {
  schemaVersion: 1,
  brokerImageId: process.env.RABBITMQ_IMAGE_ID,
  vhost: process.env.RABBITMQ_VHOST_VALUE,
  retiredQueues,
  queuesAbsent: true,
  bindingsAbsent: true,
};
if (!/^sha256:[0-9a-f]{64}$/.test(contract.brokerImageId || '') || contract.vhost !== 'winwidget')
  process.exit(1);
process.stdout.write(crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex'));
NODE
}

# Broker container ID, restartCount and startedAt in the signed JSON are the
# historical capture facts. A host reboot may legitimately replace those
# transient values while all 14 database writers remain stopped. Continuity is
# therefore proved by the same image/vhost plus a fresh exact 50-queue drain,
# never by rewriting the retained evidence.

stage_writer_boundary_state() {
	local service state running=0 stopped=0
	for service in "${BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}"; do
		state="$(inspect_stage_writer_state "$service" either)" || return 1
		case "$state" in
		running) running=$((running + 1)) ;;
		stopped) stopped=$((stopped + 1)) ;;
		esac
	done
	if ((running == ${#BILLING_CORE_CLEANUP_WRITER_SERVICES[@]})); then
		printf 'running\n'
	elif ((stopped == ${#BILLING_CORE_CLEANUP_WRITER_SERVICES[@]})); then
		printf 'stopped\n'
	elif ((running + stopped == ${#BILLING_CORE_CLEANUP_WRITER_SERVICES[@]})); then
		printf 'mixed\n'
	else
		return 1
	fi
}

archive_unbound_stage_artifacts() {
	local directory="$1" file archive='' timestamp
	local -a names=(
		core-pre-cleanup.dump billing-pre-cleanup.dump pre-restore-evidence.json
		queue-drain-evidence.json stopped-writers-evidence.json
	)
	for file in "${names[@]}"; do
		if [[ -e "$directory/$file" || -L "$directory/$file" ]]; then
			[[ -f "$directory/$file" && ! -L "$directory/$file" &&
				"$(stat -c '%u:%g' "$directory/$file")" == '0:0' ]] || return 1
			if [[ -z "$archive" ]]; then
				timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
				archive="$directory/failed-stage-$timestamp-$$"
				mkdir "$archive" || return 1
				chown 0:0 "$archive"
				chmod 700 "$archive"
			fi
			mv -- "$directory/$file" "$archive/$file" || return 1
		fi
	done
	if [[ -n "$archive" ]]; then
		printf 'Archived unbound evidence from a recovered stage attempt at %s.\n' "$archive" >&2
	fi
}

verify_restarted_writer_health() {
	local service container_id health url
	for service in "${BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}"; do
		[[ "$(inspect_stage_writer_state "$service" running)" == 'running' ]] || return 1
		container_id="$(stage_container_id "$service")" || return 1
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
			"$container_id" 2>/dev/null || true)"
		case "$service:$health" in
		outbox-publisher:none | integration-worker:none) ;;
		*:healthy) ;;
		*) return 1 ;;
		esac
	done
	for url in \
		http://127.0.0.1:4100/health/ready \
		http://127.0.0.1:4200/api/v1/health/ready \
		http://127.0.0.1:4300/health/ready \
		http://127.0.0.1:4401/health/ready \
		http://127.0.0.1:4500/health/ready \
		http://127.0.0.1:4600/health/ready \
		http://127.0.0.1:4700/health/ready \
		http://127.0.0.1:4800/health/ready \
		http://127.0.0.1:4801/health/ready \
		http://127.0.0.1:4802/health/ready \
		http://127.0.0.1:4803/health/ready; do
		curl -fsS --connect-timeout 2 --max-time 5 "$url" >/dev/null || return 1
	done
}

verify_restarted_core_heartbeats() {
	[[ $# -eq 1 && "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || return 1
	local started_at="$1" outbox_id integration_id maintenance_id result
	outbox_id="$(stage_container_id outbox-publisher)" || return 1
	integration_id="$(stage_container_id integration-worker)" || return 1
	maintenance_id="$(stage_container_id maintenance-worker)" || return 1
	result="$(generic_database_query "$(stage_image_id api)" DATABASE_BACKUP_URL "
WITH required(service, hostname) AS (
  VALUES
    ('outbox-publisher', '${outbox_id:0:12}'),
    ('integration-worker', '${integration_id:0:12}'),
    ('maintenance-worker', '${maintenance_id:0:12}')
)
SELECT count(*)
FROM required
WHERE (
  SELECT count(*)
  FROM public.messaging_heartbeats heartbeat
  WHERE heartbeat.service = required.service
    AND heartbeat.metadata->>'hostname' = required.hostname
    AND heartbeat.last_seen_at >= '$started_at'::timestamptz
) = 1;
")" || return 1
	[[ "$result" == '3' ]]
}

verify_restarted_rabbitmq_ownership() {
	local core_image notification_image campaigns_image expected_kinds
	local integration_queues notification_queues campaigns_queues
	core_image="$(stage_image_id api)" || return 1
	notification_image="$(stage_image_id notification-delivery-worker)" || return 1
	campaigns_image="$(stage_image_id campaigns-service)" || return 1
	expected_kinds="$(get_env_value INTEGRATION_WORKER_KINDS)" || return 1
	[[ -n "$expected_kinds" ]] || return 1
	integration_queues="$(docker run --rm --network none \
		-e "EXPECTED_INTEGRATION_KINDS=$expected_kinds" --entrypoint node "$core_image" -e '
const { INTEGRATION_KINDS, MESSAGING_QUEUE_NAMES } = require("./dist/src/messaging/messaging.constants.js");
const kinds = String(process.env.EXPECTED_INTEGRATION_KINDS || "").split(",").map(value => value.trim()).filter(Boolean);
if (!kinds.length || new Set(kinds).size !== kinds.length || kinds.some(kind => !INTEGRATION_KINDS.includes(kind)) ||
    kinds.some(kind => kind === "auto-renewal" || kind === "notification-delivery-outcome")) process.exit(1);
const queues = kinds.map(kind => MESSAGING_QUEUE_NAMES[kind]);
if (queues.some(queue => typeof queue !== "string" || !queue) || new Set(queues).size !== queues.length) process.exit(1);
process.stdout.write(JSON.stringify(queues));
')" || return 1
	notification_queues="$(docker run --rm --network none --entrypoint node \
		"$notification_image" -e '
const { MESSAGING_QUEUE_NAMES, NOTIFICATION_DELIVERY_KINDS } = require("./dist/src/messaging/messaging.constants.js");
const queues = NOTIFICATION_DELIVERY_KINDS.map(kind => MESSAGING_QUEUE_NAMES[kind]);
if (!queues.length || queues.some(queue => typeof queue !== "string" || !queue) ||
    new Set(queues).size !== queues.length) process.exit(1);
process.stdout.write(JSON.stringify(queues));
')" || return 1
	campaigns_queues="$(docker run --rm --network none --entrypoint node \
		"$campaigns_image" -e '
const { CAMPAIGNS_QUEUE_NAMES } = require("./dist/src/messaging/campaigns-messaging.constants.js");
const queues = Object.values(CAMPAIGNS_QUEUE_NAMES);
if (queues.length !== 2 || queues.some(queue => typeof queue !== "string" || !queue) ||
    new Set(queues).size !== queues.length) process.exit(1);
process.stdout.write(JSON.stringify(queues));
')" || return 1
	INTEGRATION_QUEUES_JSON="$integration_queues" \
		NOTIFICATION_QUEUES_JSON="$notification_queues" \
		CAMPAIGNS_QUEUES_JSON="$campaigns_queues" \
		docker run --rm --network host --env-file "$ENV_FILE" \
		-e INTEGRATION_QUEUES_JSON -e NOTIFICATION_QUEUES_JSON \
		-e CAMPAIGNS_QUEUES_JSON --entrypoint node "$core_image" -e '
class OwnershipError extends Error {}
const parseQueues = (name, expectedLength = null) => {
  let value;
  try { value = JSON.parse(process.env[name] || ""); } catch { throw new OwnershipError(`${name} is invalid`); }
  if (!Array.isArray(value) || !value.length || (expectedLength !== null && value.length !== expectedLength) ||
      value.some(queue => typeof queue !== "string" || !queue) || new Set(value).size !== value.length)
    throw new OwnershipError(`${name} is incomplete`);
  return value;
};
const decodeUser = name => {
  try {
    const user = decodeURIComponent(new URL(process.env[name] || "").username);
    if (!user) throw new Error();
    return user;
  } catch { throw new OwnershipError(`${name} user is invalid`); }
};
const run = async () => {
  const baseUrl = String(process.env.RABBITMQ_MANAGEMENT_URL || "http://127.0.0.1:15672").replace(/\/$/, "");
  const vhost = process.env.RABBITMQ_VHOST;
  const adminUser = process.env.RABBITMQ_ADMIN_USER;
  const adminPassword = process.env.RABBITMQ_ADMIN_PASSWORD;
  if (vhost !== "winwidget" || !adminUser || !adminPassword) throw new OwnershipError("RabbitMQ management contract is invalid");
  const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
  const request = async path => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) { await response.body?.cancel(); throw new OwnershipError(`RabbitMQ Management HTTP ${response.status}`); }
    return response.json();
  };
  const nodes = await request("/api/nodes");
  if (!Array.isArray(nodes) || !nodes.length || nodes.some(node => node.running === false || node.mem_alarm === true ||
      node.disk_free_alarm === true || (Array.isArray(node.partitions) && node.partitions.length)))
    throw new OwnershipError("RabbitMQ node is not healthy");
  const connections = await request("/api/connections");
  if (!Array.isArray(connections)) throw new OwnershipError("RabbitMQ connections response is invalid");
  const bySocketName = new Map(connections.map(connection => [connection.name, connection]));
  const queueState = async queue => request(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`);
  const requireConsumer = async (queue, user, connectionName) => {
    const state = await queueState(queue);
    const consumers = Array.isArray(state?.consumer_details) ? state.consumer_details : [];
    if (consumers.length !== 1) throw new OwnershipError(`RabbitMQ queue ${queue} consumer count drifted`);
    const connection = bySocketName.get(consumers[0]?.channel_details?.connection_name);
    if (connection?.user !== user || connection?.client_properties?.connection_name !== connectionName)
      throw new OwnershipError(`RabbitMQ queue ${queue} owner drifted`);
  };
  const requireNoConsumer = async queue => {
    const state = await queueState(queue);
    const consumers = Array.isArray(state?.consumer_details) ? state.consumer_details : [];
    if (consumers.length !== 0) throw new OwnershipError(`RabbitMQ parking queue ${queue} has consumers`);
  };
  const groups = [
    { queues: parseQueues("INTEGRATION_QUEUES_JSON"), user: decodeUser("RABBITMQ_INTEGRATION_WORKER_URL"),
      connection: "winwidget-integration-worker", consumeDeadLetter: true },
    { queues: parseQueues("NOTIFICATION_QUEUES_JSON"), user: decodeUser("RABBITMQ_NOTIFICATION_DELIVERY_URL"),
      connection: "winwidget-notification-delivery-worker", consumeDeadLetter: true },
    { queues: parseQueues("CAMPAIGNS_QUEUES_JSON", 2), user: decodeUser("RABBITMQ_CAMPAIGNS_URL"),
      connection: "winwidget-campaigns-service", parking: [".retry.1", ".retry.2", ".retry.3", ".dead-letter"] },
    { queues: ["winwidget.billing.identity.v1", "winwidget.billing.offer.v1",
        "winwidget.billing.notification-routing.v1", "winwidget.billing.settings-source.v1",
        "winwidget.billing.trial.v1", "winwidget.billing.referral.v1",
        "winwidget.billing.lifecycle-repair.v1", "winwidget.payment.auto-renewal",
        "winwidget.billing.notification-delivery-outcome"], user: decodeUser("RABBITMQ_BILLING_WORKER_URL"),
      connection: "winwidget-billing-worker", parking: [".retry.1", ".retry.2", ".retry.3", ".dead-letter"] },
  ];
  for (const group of groups) {
    for (const queue of group.queues) {
      await requireConsumer(queue, group.user, group.connection);
      if (group.consumeDeadLetter) await requireConsumer(`${queue}.dead-letter`, group.user, group.connection);
      for (const suffix of group.parking || []) await requireNoConsumer(`${queue}${suffix}`);
    }
  }
};
run().catch(error => {
  process.stderr.write(`${error instanceof OwnershipError ? error.message : "RabbitMQ ownership verification failed"}\n`);
  process.exitCode = 1;
});
'
}

restart_stage_writers() {
	local service container_id attempt started_at
	started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	for service in "${BILLING_CORE_CLEANUP_START_ORDER[@]}"; do
		container_id="$(stage_container_id "$service")" || return 1
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
		case "$(docker inspect --format '{{.State.Status}}|{{.State.Running}}' "$container_id" 2>/dev/null || true)" in
		exited\|false) docker start "$container_id" >/dev/null || return 1 ;;
		running\|true) ;;
		*) return 1 ;;
		esac
	done
	for ((attempt = 1; attempt <= 60; attempt++)); do
		if verify_restarted_writer_health &&
			verify_restarted_core_heartbeats "$started_at" &&
			verify_restarted_rabbitmq_ownership; then
			return 0
		fi
		sleep 2
	done
	return 1
}

restop_stage_writers_after_failed_recovery() {
	local service container_id running recovery_stopped=true
	for service in "${BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}"; do
		container_id="$(stage_container_id "$service" 2>/dev/null || true)"
		if [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
			recovery_stopped=false
			continue
		fi
		running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)"
		if [[ "$running" == 'true' ]]; then
			docker stop --time 30 "$container_id" >/dev/null 2>&1 || recovery_stopped=false
		elif [[ "$running" != 'false' ]]; then
			recovery_stopped=false
		fi
	done
	for service in "${BILLING_CORE_CLEANUP_WRITER_SERVICES[@]}"; do
		container_id="$(stage_container_id "$service" 2>/dev/null || true)"
		[[ "$container_id" =~ ^[0-9a-f]{64}$ &&
			"$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)" == 'false' ]] ||
			recovery_stopped=false
	done
	[[ "$recovery_stopped" == 'true' ]]
}

stage_recover_on_exit() {
	local status=$? marker_state source_state migration_state
	trap - EXIT INT TERM
	[[ "$STAGE_RECOVERY_ACTIVE" == 'true' ]] || exit "$status"
	set +e
	marker_state="$(billing_core_source_cleanup_marker_state 2>/dev/null || printf 'invalid')"
	if [[ "$marker_state" == 'staged' &&
		"$(billing_core_source_cleanup_marker_value revision 2>/dev/null)" == "$STAGE_REVISION" ]]; then
		echo 'Billing Core cleanup staging is durable; exact SHA A writers remain intentionally stopped.' >&2
		exit "$status"
	fi
	source_state="$(billing_core_source_state 2>/dev/null || printf 'unknown')"
	migration_state="$(billing_core_source_cleanup_migration_state 2>/dev/null || printf 'unsafe')"
	if [[ "$source_state" == 'present' && "$migration_state" =~ ^(pending|rolled-back|unfinished)$ ]]; then
		echo 'Billing Core cleanup stage did not become durable; restoring exact SHA A writers.' >&2
		if restart_stage_writers; then
			if archive_unbound_stage_artifacts "$(dirname -- "$STAGE_PRECOMMIT_FILE")"; then
				if [[ -n "$STAGE_PRECOMMIT_FILE" &&
					( -e "$STAGE_PRECOMMIT_FILE" || -L "$STAGE_PRECOMMIT_FILE" ) ]]; then
					remove_recoverable_partial "$STAGE_PRECOMMIT_FILE" ||
						echo 'WARNING: recovered writer precommit manifest could not be removed.' >&2
				fi
			else
				echo 'CRITICAL: exact SHA A writers restarted, but unbound stage artifacts could not be archived; the recovery manifest was retained.' >&2
			fi
		else
			echo 'CRITICAL: exact SHA A stage recovery failed; stopping every manifest writer again.' >&2
			if restop_stage_writers_after_failed_recovery; then
				if archive_unbound_stage_artifacts "$(dirname -- "$STAGE_PRECOMMIT_FILE")"; then
					echo 'All exact SHA A manifest writers are confirmed non-running; unbound artifacts were archived and the recovery manifest was retained.' >&2
				else
					echo 'CRITICAL: all exact SHA A writers are stopped, but stale unbound stage artifacts could not be archived; manual recovery is required before retry.' >&2
				fi
			else
				echo 'CRITICAL: one or more exact SHA A manifest writers could not be confirmed stopped; manual recovery is required immediately.' >&2
			fi
		fi
	else
		echo "Billing Core cleanup stage recovery is unsafe: source=$source_state migration=$migration_state; writers remain stopped." >&2
	fi
	exit "$status"
}

write_queue_evidence() {
	local revision="$1" previous_revision="$2" generation="$3" snapshot="$4"
	local projection="$5" route="$6" destination="$7" rabbitmq vhost listing
	local image_id restart_count started_at core_state captured_at partial
	rabbitmq="$(compose_target "$revision" ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ "$rabbitmq" =~ ^[0-9a-f]{64}$ ]] || fail 'exactly one running RabbitMQ is required'
	vhost="$(get_env_value RABBITMQ_VHOST)"
	[[ "$vhost" == 'winwidget' ]] || fail 'RabbitMQ vhost differs from the canonical contract'
	image_id="$(docker inspect --format '{{.Image}}' "$rabbitmq")"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$rabbitmq")"
	started_at="$(docker inspect --format '{{.State.StartedAt}}' "$rabbitmq")"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ && "$restart_count" =~ ^[0-9]+$ &&
		"$started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || fail 'RabbitMQ identity is invalid'
	listing="$(docker exec "$rabbitmq" rabbitmqctl --silent list_queues -p "$vhost" \
		name messages_ready messages_unacknowledged consumers)" || fail 'RabbitMQ queue state is unreadable'
	core_state="$(read_core_drain_state "$revision")" ||
		fail 'Core Billing delivery drain state is unreadable'
	captured_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	partial="$destination.partial"
	[[ ! -e "$destination" && ! -L "$destination" ]] || return 1
	remove_recoverable_partial "$partial"
	QUEUE_LISTING="$listing" CORE_STATE="$core_state" RABBITMQ_CONTAINER_ID="$rabbitmq" \
		RABBITMQ_IMAGE_ID="$image_id" RABBITMQ_RESTART_COUNT="$restart_count" \
		RABBITMQ_STARTED_AT="$started_at" RABBITMQ_VHOST_VALUE="$vhost" \
		PREVIOUS_REVISION="$previous_revision" CLEANUP_REVISION="$revision" \
		OWNERSHIP_GENERATION="$generation" SOURCE_SNAPSHOT="$snapshot" \
		PROJECTION_EVIDENCE="$projection" ROUTE_EVIDENCE="$route" \
		CAPTURED_AT="$captured_at" billing_release_node <<'NODE' >"$partial"
const rows = process.env.QUEUE_LISTING.trim().split('\n').filter(Boolean)
  .map(line => line.trim().split(/\s+/));
const actual = new Map(rows.map(([name, ready, unacked, consumers]) => [name, {
  name, ready: Number(ready), unacked: Number(unacked), consumers: Number(consumers),
}]));
const retained = [
  'winwidget.billing.identity.v1', 'winwidget.billing.offer.v1',
  'winwidget.billing.notification-routing.v1', 'winwidget.billing.settings-source.v1',
  'winwidget.billing.trial.v1', 'winwidget.billing.referral.v1',
  'winwidget.billing.lifecycle-repair.v1', 'winwidget.payment.auto-renewal',
  'winwidget.billing.notification-delivery-outcome',
];
const names = retained.flatMap(name => [name, `${name}.retry.1`, `${name}.retry.2`,
  `${name}.retry.3`, `${name}.dead-letter`]);
const retired = 'winwidget.notification.delivery-outcome';
names.push(retired, `${retired}.retry-v2.1`, `${retired}.retry-v2.2`,
  `${retired}.retry-v2.3`, `${retired}.dead-letter`);
const queues = names.map((name, index) => {
  const state = actual.get(name);
  if (!state || ![state.ready, state.unacked, state.consumers].every(Number.isSafeInteger) ||
      state.ready !== 0 || state.unacked !== 0) process.exit(1);
	  if (state.consumers !== 0) process.exit(1);
  return state;
});
const counts = process.env.CORE_STATE.split('\t').map(Number);
if (counts.length !== 4 || counts.some(value => value !== 0)) process.exit(1);
const value = {
  schemaVersion: 1,
  action: 'billing-core-source-cleanup-queue-drain',
  previousRevision: process.env.PREVIOUS_REVISION,
  cleanupRevision: process.env.CLEANUP_REVISION,
  ownershipGeneration: Number(process.env.OWNERSHIP_GENERATION),
  sourceSnapshotSha256: process.env.SOURCE_SNAPSHOT,
  projectionEvidenceSha256: process.env.PROJECTION_EVIDENCE,
  routeEvidenceSha256: process.env.ROUTE_EVIDENCE,
  rabbitmq: {
    containerId: process.env.RABBITMQ_CONTAINER_ID,
    imageId: process.env.RABBITMQ_IMAGE_ID,
    restartCount: Number(process.env.RABBITMQ_RESTART_COUNT),
    startedAt: process.env.RABBITMQ_STARTED_AT,
    vhost: process.env.RABBITMQ_VHOST_VALUE,
  },
  queues,
  coreState: {
    pendingBillingCompositions: counts[0],
    unfinishedLegacyOutboxEvents: counts[1],
    activeDeliveryReceipts: counts[2],
    unresolvedDeliveryFailures: counts[3],
  },
  capturedAt: process.env.CAPTURED_AT,
};
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE
	chown 0:0 "$partial"
	chmod 600 "$partial"
	mv -fT "$partial" "$destination"
}

validate_queue_evidence() {
	[[ $# -eq 7 ]] || return 1
	QUEUE_FILE="$1" PREVIOUS_REVISION="$2" CLEANUP_REVISION="$3" \
		OWNERSHIP_GENERATION="$4" SOURCE_SNAPSHOT="$5" \
		PROJECTION_EVIDENCE="$6" ROUTE_EVIDENCE="$7" billing_release_node <<'NODE'
const fs = require('node:fs');
let value;
try { value = JSON.parse(fs.readFileSync(process.env.QUEUE_FILE, 'utf8')); } catch { process.exit(1); }
const keys = ['action','capturedAt','cleanupRevision','coreState','ownershipGeneration',
  'previousRevision','projectionEvidenceSha256','queues','rabbitmq','routeEvidenceSha256',
  'schemaVersion','sourceSnapshotSha256'].sort().join('|');
if (!value || Array.isArray(value) || Object.keys(value).sort().join('|') !== keys ||
    value.schemaVersion !== 1 || value.action !== 'billing-core-source-cleanup-queue-drain' ||
    value.previousRevision !== process.env.PREVIOUS_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    String(value.ownershipGeneration) !== process.env.OWNERSHIP_GENERATION ||
    value.sourceSnapshotSha256 !== process.env.SOURCE_SNAPSHOT ||
    value.projectionEvidenceSha256 !== process.env.PROJECTION_EVIDENCE ||
    value.routeEvidenceSha256 !== process.env.ROUTE_EVIDENCE ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.capturedAt)) process.exit(1);
const retained = [
  'winwidget.billing.identity.v1', 'winwidget.billing.offer.v1',
  'winwidget.billing.notification-routing.v1', 'winwidget.billing.settings-source.v1',
  'winwidget.billing.trial.v1', 'winwidget.billing.referral.v1',
  'winwidget.billing.lifecycle-repair.v1', 'winwidget.payment.auto-renewal',
  'winwidget.billing.notification-delivery-outcome',
];
const expected = retained.flatMap(name => [name, `${name}.retry.1`, `${name}.retry.2`,
  `${name}.retry.3`, `${name}.dead-letter`]);
const retired = 'winwidget.notification.delivery-outcome';
expected.push(retired, `${retired}.retry-v2.1`, `${retired}.retry-v2.2`,
  `${retired}.retry-v2.3`, `${retired}.dead-letter`);
if (!Array.isArray(value.queues) || value.queues.length !== 50) process.exit(1);
for (let index = 0; index < expected.length; index += 1) {
  const row = value.queues[index];
  if (!row || Object.keys(row).sort().join('|') !== 'consumers|name|ready|unacked' ||
	      row.name !== expected[index] || row.ready !== 0 || row.unacked !== 0 ||
	      row.consumers !== 0) process.exit(1);
}
if (!value.rabbitmq || Object.keys(value.rabbitmq).sort().join('|') !==
    'containerId|imageId|restartCount|startedAt|vhost' ||
    !/^[0-9a-f]{64}$/.test(value.rabbitmq.containerId) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.rabbitmq.imageId) ||
    !Number.isSafeInteger(value.rabbitmq.restartCount) || value.rabbitmq.restartCount < 0 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.rabbitmq.startedAt) || value.rabbitmq.vhost !== 'winwidget') process.exit(1);
const stateKeys = ['activeDeliveryReceipts','pendingBillingCompositions',
  'unfinishedLegacyOutboxEvents','unresolvedDeliveryFailures'].sort().join('|');
if (!value.coreState || Object.keys(value.coreState).sort().join('|') !== stateKeys ||
    Object.values(value.coreState).some(count => count !== 0)) process.exit(1);
NODE
}

validate_restore_evidence() {
	[[ $# -eq 10 ]] || return 1
	RESTORE_FILE="$1" EXPECTED_KIND="$2" PREVIOUS_REVISION="$3" \
		CLEANUP_REVISION="$4" OWNERSHIP_GENERATION="$5" CORE_SHA="$6" \
		BILLING_SHA="$7" CORE_SYSTEM_ID="$8" BILLING_SYSTEM_ID="$9" \
		BILLING_DATABASE_ID_VALUE="${10}" billing_release_node <<'NODE'
const fs = require('node:fs');
let value;
try { value = JSON.parse(fs.readFileSync(process.env.RESTORE_FILE, 'utf8')); } catch { process.exit(1); }
const pre = process.env.EXPECTED_KIND === 'pre';
const expectedKeys = (pre
  ? ['action','billing','checks','cleanupRevision','core','ownershipGeneration','previousRevision','schemaVersion','status','verifiedAt']
  : ['action','checks','cleanupRevision','core','ownershipGeneration','previousRevision','schemaVersion','status','verifiedAt']).sort();
if (!value || Array.isArray(value) || Object.keys(value).sort().join('|') !== expectedKeys.join('|') ||
    value.schemaVersion !== 1 || value.action !== `billing-core-source-cleanup-${pre ? 'pre' : 'post'}-restore` ||
    value.status !== 'passed' || value.previousRevision !== process.env.PREVIOUS_REVISION ||
    value.cleanupRevision !== process.env.CLEANUP_REVISION ||
    String(value.ownershipGeneration) !== process.env.OWNERSHIP_GENERATION ||
    value.core?.dumpSha256 !== process.env.CORE_SHA ||
    String(value.core?.sourceSystemIdentifier) !== process.env.CORE_SYSTEM_ID ||
    !/^[1-9][0-9]*$/.test(String(value.core?.restoreSystemIdentifier || '')) ||
    String(value.core.restoreSystemIdentifier) === process.env.CORE_SYSTEM_ID ||
    value.core.legacySourceState !== (pre ? 'present' : 'absent') ||
    value.core.migrationState !== (pre ? 'pending' : 'applied') ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.verifiedAt) ||
    !value.checks || Object.values(value.checks).some(item => item !== true)) process.exit(1);
if (pre && (value.billing?.dumpSha256 !== process.env.BILLING_SHA ||
    String(value.billing?.sourceSystemIdentifier) !== process.env.BILLING_SYSTEM_ID ||
    !/^[1-9][0-9]*$/.test(String(value.billing?.restoreSystemIdentifier || '')) ||
    String(value.billing.restoreSystemIdentifier) === process.env.BILLING_SYSTEM_ID ||
    value.billing.databaseId !== process.env.BILLING_DATABASE_ID_VALUE ||
    value.billing.phase !== 'ACTIVE' || value.billing.ownershipGeneration !== 2)) process.exit(1);
NODE
}

ensure_restore_evidence() {
	local kind="$1" revision="$2" previous_revision="$3" generation="$4"
	local directory="$5" core_sha="$6" billing_sha="$7" core_system="$8"
	local billing_system="$9" database_id="${10}" evidence
	evidence="$directory/${kind}-restore-evidence.json"
	if [[ -e "$evidence" || -L "$evidence" ]]; then
		validate_private_file "$evidence" || fail "existing $kind restore evidence is unsafe"
	else
		if [[ "$kind" == 'pre' ]]; then
			CORE_CLEANUP_REHEARSAL_REVISION="$revision" \
			CORE_CLEANUP_REHEARSAL_PREVIOUS_REVISION="$previous_revision" \
			CORE_CLEANUP_REHEARSAL_GENERATION="$generation" \
			CORE_CLEANUP_REHEARSAL_CORE_DUMP_FILE="$directory/core-pre-cleanup.dump" \
			CORE_CLEANUP_REHEARSAL_CORE_SHA256="$core_sha" \
			CORE_CLEANUP_REHEARSAL_BILLING_DUMP_FILE="$directory/billing-pre-cleanup.dump" \
			CORE_CLEANUP_REHEARSAL_BILLING_SHA256="$billing_sha" \
			CORE_CLEANUP_REHEARSAL_CORE_SYSTEM_IDENTIFIER="$core_system" \
			CORE_CLEANUP_REHEARSAL_BILLING_SYSTEM_IDENTIFIER="$billing_system" \
			CORE_CLEANUP_REHEARSAL_BILLING_DATABASE_ID="$database_id" \
			CORE_CLEANUP_REHEARSAL_EVIDENCE_FILE="$evidence" \
			CORE_CLEANUP_REHEARSAL_RUN_ID="prod-${revision:0:8}-pre-$$-$RANDOM" \
				bash "$SERVER_ROOT/scripts/test-billing-core-source-cleanup-rehearsal.sh" --verify-dumps
		else
			CORE_CLEANUP_REHEARSAL_REVISION="$revision" \
			CORE_CLEANUP_REHEARSAL_PREVIOUS_REVISION="$previous_revision" \
			CORE_CLEANUP_REHEARSAL_GENERATION="$generation" \
			CORE_CLEANUP_REHEARSAL_CORE_DUMP_FILE="$directory/core-post-cleanup.dump" \
			CORE_CLEANUP_REHEARSAL_CORE_SHA256="$core_sha" \
			CORE_CLEANUP_REHEARSAL_CORE_SYSTEM_IDENTIFIER="$core_system" \
			CORE_CLEANUP_REHEARSAL_EVIDENCE_FILE="$evidence" \
			CORE_CLEANUP_REHEARSAL_RUN_ID="prod-${revision:0:8}-post-$$-$RANDOM" \
				bash "$SERVER_ROOT/scripts/test-billing-core-source-cleanup-rehearsal.sh" --verify-core-dump
		fi
	fi
	validate_restore_evidence "$evidence" "$kind" "$previous_revision" "$revision" \
		"$generation" "$core_sha" "$billing_sha" "$core_system" \
		"$billing_system" "$database_id" || fail "$kind restore evidence is invalid"
}

validate_pre_artifacts() {
	local directory="$1" previous_revision="$2" revision="$3" generation="$4"
	local snapshot="$5" projection="$6" route="$7" core_system="$8"
	local billing_system="$9" database_id="${10}" core_sha billing_sha
	local restore_sha queue_sha writers_sha
	for file in core-pre-cleanup.dump billing-pre-cleanup.dump pre-restore-evidence.json \
		queue-drain-evidence.json stopped-writers-evidence.json; do
		validate_private_file "$directory/$file" || return 1
	done
	validate_dump_list "$directory/core-pre-cleanup.dump" || return 1
	validate_dump_list "$directory/billing-pre-cleanup.dump" || return 1
	core_sha="$(sha256_file "$directory/core-pre-cleanup.dump")"
	billing_sha="$(sha256_file "$directory/billing-pre-cleanup.dump")"
	restore_sha="$(sha256_file "$directory/pre-restore-evidence.json")"
	queue_sha="$(sha256_file "$directory/queue-drain-evidence.json")"
	writers_sha="$(sha256_file "$directory/stopped-writers-evidence.json")"
	validate_restore_evidence "$directory/pre-restore-evidence.json" pre \
		"$previous_revision" "$revision" "$generation" "$core_sha" "$billing_sha" \
		"$core_system" "$billing_system" "$database_id" || return 1
	validate_queue_evidence "$directory/queue-drain-evidence.json" \
		"$previous_revision" "$revision" "$generation" "$snapshot" "$projection" "$route" || return 1
	validate_writer_evidence "$directory/stopped-writers-evidence.json" \
		"$previous_revision" "$revision" "$generation" "$snapshot" "$projection" "$route" || return 1
	[[ "$restore_sha" =~ ^[0-9a-f]{64}$ && "$queue_sha" =~ ^[0-9a-f]{64}$ &&
		"$writers_sha" =~ ^[0-9a-f]{64}$ ]]
}

reference_is_safe() {
	[[ $# -eq 2 ]] || return 1
	case "$1" in
	operator-managed-macos) [[ "$2" =~ ^macos-offsite:[A-Za-z0-9][A-Za-z0-9._:@+-]{7,239}$ ]] ;;
	s3-compatible) [[ "$2" =~ ^s3-offsite:[A-Za-z0-9][A-Za-z0-9._:/@+-]{7,239}$ ]] ;;
	telegram-document) [[ "$2" =~ ^telegram-document:[A-Za-z0-9][A-Za-z0-9._:@+-]{7,239}$ ]] ;;
	*) return 1 ;;
	esac
}

validate_offsite_receipt() {
	[[ $# -eq 4 ]] || return 1
	local receipt="$1" kind="$2" directory="$3" expected_post_sha="$4" metadata
	metadata="$(RECEIPT_FILE="$receipt" EXPECTED_KIND="$kind" billing_release_node <<'NODE'
const fs = require('node:fs');
let value;
try { value = JSON.parse(fs.readFileSync(process.env.RECEIPT_FILE, 'utf8')); } catch { process.exit(1); }
const keys = ['action','artifacts','cleanupRevision','ownershipGeneration','provider',
  'providerReference','sourceSnapshotSha256','status','verifiedAt','schemaVersion'].sort().join('|');
if (!value || Array.isArray(value) || Object.keys(value).sort().join('|') !== keys ||
    value.schemaVersion !== 1 || value.action !== `billing-core-source-cleanup-${process.env.EXPECTED_KIND}-offsite` ||
    value.status !== 'verified' || !Array.isArray(value.artifacts) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.verifiedAt)) process.exit(1);
const expected = process.env.EXPECTED_KIND === 'pre'
  ? ['billing-pre-cleanup.dump','core-pre-cleanup.dump','pre-restore-evidence.json','queue-drain-evidence.json','stopped-writers-evidence.json']
  : ['core-post-cleanup.dump','post-restore-evidence.json'];
if (value.artifacts.map(item => item?.name).sort().join('|') !== expected.join('|')) process.exit(1);
for (const item of value.artifacts) {
  if (!item || Object.keys(item).sort().join('|') !== 'name|sha256|sizeBytes' ||
      !/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0) process.exit(1);
}
process.stdout.write(`${value.provider}\t${value.providerReference}`);
NODE
)" || return 1
	local provider reference
	IFS=$'\t' read -r provider reference <<<"$metadata"
	reference_is_safe "$provider" "$reference" || return 1
	RECEIPT_FILE="$receipt" EXPECTED_KIND="$kind" DIRECTORY="$directory" \
		EXPECTED_REVISION="$(billing_core_source_cleanup_marker_value revision)" \
		EXPECTED_GENERATION="$(billing_core_source_cleanup_marker_value ownership_generation)" \
		EXPECTED_SNAPSHOT="$(billing_core_source_cleanup_marker_value source_snapshot_sha256)" \
		EXPECTED_POST_SHA="$expected_post_sha" billing_release_node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const value = JSON.parse(fs.readFileSync(process.env.RECEIPT_FILE, 'utf8'));
if (value.cleanupRevision !== process.env.EXPECTED_REVISION ||
    String(value.ownershipGeneration) !== process.env.EXPECTED_GENERATION ||
    value.sourceSnapshotSha256 !== process.env.EXPECTED_SNAPSHOT) process.exit(1);
for (const item of value.artifacts) {
  const file = path.join(process.env.DIRECTORY, item.name);
  const data = fs.readFileSync(file);
  if (data.length !== item.sizeBytes || crypto.createHash('sha256').update(data).digest('hex') !== item.sha256) process.exit(1);
}
if (process.env.EXPECTED_KIND === 'post') {
  const post = value.artifacts.find(item => item.name === 'core-post-cleanup.dump');
  if (post?.sha256 !== process.env.EXPECTED_POST_SHA) process.exit(1);
}
NODE
}

import_offsite_receipt() {
	local source="$1" destination="$2" kind="$3" directory="$4" expected_post_sha="$5"
	validate_offsite_receipt "$source" "$kind" "$directory" "$expected_post_sha" || return 1
	promote_private_file "$source" "$destination" || return 1
	validate_offsite_receipt "$destination" "$kind" "$directory" "$expected_post_sha" || return 1
	sha256_file "$destination"
}

require_bound_pre_evidence() {
	local revision generation directory key file expected
	billing_core_source_cleanup_validate_marker || return 1
	revision="$(billing_core_source_cleanup_marker_value revision)"
	generation="$(billing_core_source_cleanup_marker_value ownership_generation)"
	directory="$(billing_core_source_cleanup_evidence_directory "$revision" "$generation")"
	for key in core_backup_sha256 billing_backup_sha256 restore_evidence_sha256 \
		queue_drain_evidence_sha256 stopped_writers_evidence_sha256 pre_offsite_receipt_sha256; do
		expected="$(billing_core_source_cleanup_marker_value "$key")" || return 1
		[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
		file="$(billing_core_source_cleanup_evidence_file_for_key "$directory" "$key")" || return 1
		billing_core_source_cleanup_validate_private_file "$file" "$expected" || return 1
	done
	[[ "$(billing_core_source_cleanup_marker_value retention_decision)" == 'approved' &&
		"$(billing_core_source_cleanup_marker_value retention_reference)" == "$(billing_core_source_cleanup_marker_value pre_offsite_receipt_sha256)" &&
		"$(billing_core_source_cleanup_marker_value core_system_identifier)" =~ ^[1-9][0-9]*$ &&
		"$(billing_core_source_cleanup_marker_value billing_system_identifier)" =~ ^[1-9][0-9]*$ &&
		"$(billing_core_source_cleanup_marker_value billing_database_id)" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1
	billing_core_source_cleanup_require_evidence
}

stage_cleanup() {
	local revision previous_revision marker_state identities core_image_id billing_image_id
	local boundary generation snapshot projection route database_id directory core_image
	local core_system billing_system core_sha billing_sha precommit writer_file
	require_confirmation
	assert_production_context
	revision="$(assert_checkout)"
	previous_revision="$(billing_database_marker_value ownership_revision 2>/dev/null || true)"
	[[ "$previous_revision" =~ ^[0-9a-f]{40}$ && "$previous_revision" != "$revision" ]] ||
		fail 'cleanup revision must be a forward revision after Billing ownership'
	git -C "$SERVER_ROOT" merge-base --is-ancestor "$previous_revision" "$revision" ||
		fail 'cleanup revision is not a descendant of the ownership revision'
	boundary="$(verify_complete_ownership_boundary "$previous_revision" "$revision")"
	IFS=$'\t' read -r generation snapshot projection route database_id <<<"$boundary"
	[[ "$(billing_core_source_state)" == 'present' &&
		"$(billing_core_source_cleanup_migration_state)" =~ ^(pending|rolled-back)$ ]] ||
		fail 'legacy Core Billing source is not exactly stageable'
	billing_core_source_cleanup_require_exact_migration_manifest exclusive ||
		fail 'tracked Core migration manifest or ledger is not exclusive before stage'
	marker_state="$(billing_core_source_cleanup_marker_state 2>/dev/null || printf 'invalid')"
	[[ "$marker_state" =~ ^(absent|staged)$ ]] || fail 'cleanup marker is invalid or not stageable'
	if [[ "$marker_state" == 'absent' ]]; then
		verify_route_contract "$revision" || fail 'Billing Gateway route contract is invalid'
		require_reporting_outcome_topology_steady "$revision" ||
			fail 'Reporting outcome routing must be steady before stopping writers'
		compose_target "$revision" --profile migration --profile billing-migration config --quiet
		compose_target "$revision" build --pull --provenance=false api billing-api
		identities="$(verify_candidate_images "$revision")"
	else
		[[ "$(billing_core_source_cleanup_marker_value revision)" == "$revision" &&
			"$(billing_core_source_cleanup_marker_value previous_revision)" == "$previous_revision" ]] ||
			fail 'existing staged marker pins another ownership boundary'
		identities="$(verify_candidate_images "$revision" \
			"$(billing_core_source_cleanup_marker_value cleanup_core_image_id)" \
			"$(billing_core_source_cleanup_marker_value cleanup_billing_image_id)")"
	fi
	IFS=$'\t' read -r core_image_id billing_image_id <<<"$identities"
	core_image="winwidget-api:git-$revision"
	verify_billing_database_identity "$core_image" "$previous_revision" "$database_id"
	core_system="$(generic_database_query "$core_image" DATABASE_BACKUP_URL \
		'SELECT system_identifier FROM pg_control_system();')" || fail 'Core system identifier is unreadable'
	billing_system="$(generic_database_query "$core_image" BILLING_BACKUP_URL \
		'SELECT system_identifier FROM pg_control_system();')" || fail 'Billing system identifier is unreadable'
	[[ "$core_system" =~ ^[1-9][0-9]*$ && "$billing_system" =~ ^[1-9][0-9]*$ &&
		"$core_system" != "$billing_system" ]] || fail 'Core and Billing physical identities are invalid'
	directory="$(billing_core_source_cleanup_evidence_directory "$revision" "$generation")"
	ensure_private_directory "$directory"
	precommit="$directory/stopped-writers-precommit.json"
	writer_file="$directory/stopped-writers-evidence.json"
	if [[ "$marker_state" == 'staged' ]]; then
		validate_stopped_writers_live "$writer_file" "$previous_revision" "$revision" \
			"$generation" "$snapshot" "$projection" "$route" ||
			fail 'staged exact SHA A writers are no longer stopped and unchanged'
		validate_pre_artifacts "$directory" "$previous_revision" "$revision" "$generation" \
			"$snapshot" "$projection" "$route" "$core_system" "$billing_system" "$database_id" ||
			fail 'staged pre-cleanup evidence is incomplete or changed'
		validate_live_broker_from_queue_evidence "$revision" "$directory/queue-drain-evidence.json" ||
			fail 'RabbitMQ image or vhost changed after stage; restore or reviewed restage is required before cleanup'
		require_core_sessions_drained "$revision" || fail 'Core database sessions reappeared after stage'
		require_core_drain_state "$revision" || fail 'Core Billing drain changed after stage'
		require_billing_database_quiescent "$revision" "$previous_revision" "$database_id" ||
			fail 'Billing database work or sessions changed after stage'
		require_stopped_queue_boundary "$revision" || fail 'stopped queue boundary changed after stage'
		verify_candidate_images "$revision" "$core_image_id" "$billing_image_id" >/dev/null
		if require_bound_pre_evidence; then
			echo "Billing Core source cleanup evidence is already sealed for revision $revision."
		else
			echo "Billing Core source cleanup evidence is staged for revision $revision."
			echo 'Copy and SHA-verify all five private pre-cleanup artifacts off the VPS, then use --seal-offsite.'
			echo "Import the receipt at ${PRE_RECEIPT_PREFIX}-${revision}-g${generation}.json."
		fi
		return
	fi
	if [[ -e "$precommit" || -L "$precommit" ]]; then
		validate_private_file "$precommit" || fail 'writer precommit recovery manifest is unsafe'
		load_stage_precommit "$precommit" "$previous_revision" "$revision" "$generation" \
			"$snapshot" "$projection" "$route" || fail 'writer precommit recovery manifest is invalid'
		stage_writer_boundary_state >/dev/null || fail 'writer precommit recovery boundary is unsafe'
		archive_unbound_stage_artifacts "$directory" ||
			fail 'could not preserve unbound evidence before stage retry'
	else
		if [[ -e "$writer_file" || -L "$writer_file" ||
			-e "$directory/core-pre-cleanup.dump" || -L "$directory/core-pre-cleanup.dump" ||
			-e "$directory/billing-pre-cleanup.dump" || -L "$directory/billing-pre-cleanup.dump" ||
			-e "$directory/pre-restore-evidence.json" || -L "$directory/pre-restore-evidence.json" ||
			-e "$directory/queue-drain-evidence.json" || -L "$directory/queue-drain-evidence.json" ]]; then
			fail 'unbound stage artifacts exist without their recovery manifest'
		fi
		write_stage_precommit "$revision" "$previous_revision" "$generation" "$snapshot" \
			"$projection" "$route" "$precommit" || fail 'could not persist writer precommit identities'
	fi
	STAGE_RECOVERY_ACTIVE=true
	STAGE_REVISION="$revision"
	STAGE_PRECOMMIT_FILE="$precommit"
	trap stage_recover_on_exit EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	stop_stage_writers
	require_core_sessions_drained "$revision" || fail 'Core database sessions did not drain after stop'
	require_core_drain_state "$revision" || fail 'Core Billing durable work is not drained after stop'
	require_billing_database_quiescent "$revision" "$previous_revision" "$database_id" ||
		fail 'Billing database work or sessions did not drain after stop'
	require_stopped_queue_boundary "$revision" || fail 'Billing cleanup queues are not exact, empty and unused after stop'
	if [[ ! -e "$writer_file" && ! -L "$writer_file" ]]; then
		write_writer_evidence "$revision" "$previous_revision" "$generation" "$snapshot" \
			"$projection" "$route" "$writer_file" || fail 'could not write stopped writer evidence'
	fi
	validate_stopped_writers_live "$writer_file" "$previous_revision" "$revision" \
		"$generation" "$snapshot" "$projection" "$route" ||
		fail 'stopped writer evidence is invalid or no longer live'
	ensure_dump "$core_image" DATABASE_BACKUP_URL public "$directory/core-pre-cleanup.dump"
	ensure_dump "$core_image" BILLING_BACKUP_URL billing "$directory/billing-pre-cleanup.dump"
	core_sha="$(sha256_file "$directory/core-pre-cleanup.dump")"
	billing_sha="$(sha256_file "$directory/billing-pre-cleanup.dump")"
	ensure_restore_evidence pre "$revision" "$previous_revision" "$generation" "$directory" \
		"$core_sha" "$billing_sha" "$core_system" "$billing_system" "$database_id"
	if [[ ! -e "$directory/queue-drain-evidence.json" &&
		! -L "$directory/queue-drain-evidence.json" ]]; then
		write_queue_evidence "$revision" "$previous_revision" "$generation" "$snapshot" \
			"$projection" "$route" "$directory/queue-drain-evidence.json"
	fi
	validate_pre_artifacts "$directory" "$previous_revision" "$revision" "$generation" \
		"$snapshot" "$projection" "$route" "$core_system" "$billing_system" "$database_id" ||
		fail 'pre-cleanup evidence is incomplete or changed'
	billing_core_source_cleanup_stage_marker "$previous_revision" "$revision" \
		"$core_image_id" "$billing_image_id" || fail 'could not create staged cleanup marker'
	STAGE_RECOVERY_ACTIVE=false
	trap - EXIT INT TERM
	remove_recoverable_partial "$precommit"
	verify_candidate_images "$revision" "$core_image_id" "$billing_image_id" >/dev/null
	if require_bound_pre_evidence; then
		echo "Billing Core source cleanup evidence is already sealed for revision $revision."
	else
		echo "Billing Core source cleanup evidence is staged for revision $revision."
		echo 'Copy and SHA-verify all five private pre-cleanup artifacts off the VPS, then use --seal-offsite.'
		echo "Import the receipt at ${PRE_RECEIPT_PREFIX}-${revision}-g${generation}.json."
	fi
}

seal_offsite() {
	local revision previous_revision generation directory receipt_source receipt_destination
	local receipt_sha core_sha billing_sha restore_sha queue_sha writers_sha
	local snapshot projection route core_system billing_system database_id
	require_confirmation
	assert_production_context identity-if-present
	revision="$(assert_checkout)"
	billing_core_source_cleanup_validate_marker || fail 'cleanup marker is missing or invalid'
	[[ "$(billing_core_source_cleanup_marker_value phase)" == 'staged' &&
		"$(billing_core_source_cleanup_marker_value revision)" == "$revision" ]] ||
		fail 'only this revision staged marker can seal pre-cleanup evidence'
	[[ "$(billing_core_source_state)" == 'present' &&
		"$(billing_core_source_cleanup_migration_state)" =~ ^(pending|rolled-back)$ ]] ||
		fail 'pre-cleanup seal requires the intact legacy source boundary'
	billing_core_source_cleanup_require_exact_migration_manifest exclusive ||
		fail 'tracked Core migration manifest or ledger changed before seal'
	previous_revision="$(billing_core_source_cleanup_marker_value previous_revision)"
	generation="$(billing_core_source_cleanup_marker_value ownership_generation)"
	snapshot="$(billing_core_source_cleanup_marker_value source_snapshot_sha256)"
	projection="$(billing_core_source_cleanup_marker_value projection_evidence_sha256)"
	route="$(billing_core_source_cleanup_marker_value route_evidence_sha256)"
	core_system="$(generic_database_query "winwidget-api:git-$revision" DATABASE_BACKUP_URL 'SELECT system_identifier FROM pg_control_system();')" ||
		fail 'Core physical identity is unreadable before seal'
	billing_system="$(generic_database_query "winwidget-api:git-$revision" BILLING_BACKUP_URL 'SELECT system_identifier FROM pg_control_system();')" ||
		fail 'Billing physical identity is unreadable before seal'
	database_id="$(billing_database_marker_value database_id)"
	directory="$(billing_core_source_cleanup_evidence_directory "$revision" "$generation")"
	validate_pre_artifacts "$directory" "$previous_revision" "$revision" "$generation" \
		"$snapshot" "$projection" "$route" "$core_system" "$billing_system" "$database_id" ||
		fail 'pre-cleanup evidence changed before seal'
	validate_stopped_writers_live "$directory/stopped-writers-evidence.json" \
		"$previous_revision" "$revision" "$generation" "$snapshot" "$projection" "$route" ||
		fail 'exact SHA A writers are not continuously stopped before seal'
	validate_live_broker_from_queue_evidence "$revision" "$directory/queue-drain-evidence.json" ||
		fail 'RabbitMQ durable identity differs from staged queue evidence'
	require_reporting_outcome_topology_steady "$revision" ||
		fail 'Reporting outcome routing changed after stage'
	require_core_sessions_drained "$revision" || fail 'Core database sessions reappeared before seal'
	require_core_drain_state "$revision" || fail 'Core Billing drain changed before seal'
	require_billing_database_quiescent "$revision" "$previous_revision" "$database_id" ||
		fail 'Billing database work or sessions changed before seal'
	require_stopped_queue_boundary "$revision" || fail 'stopped queue boundary changed before seal'
	if require_bound_pre_evidence; then
		echo 'Pre-cleanup off-VPS evidence is already sealed.'
		return
	fi
	receipt_source="${PRE_RECEIPT_PREFIX}-${revision}-g${generation}.json"
	receipt_destination="$directory/pre-offsite-receipt.json"
	receipt_sha="$(import_offsite_receipt "$receipt_source" "$receipt_destination" pre "$directory" '')" ||
		fail 'pre-cleanup off-VPS receipt is missing or invalid'
	core_sha="$(sha256_file "$directory/core-pre-cleanup.dump")"
	billing_sha="$(sha256_file "$directory/billing-pre-cleanup.dump")"
	restore_sha="$(sha256_file "$directory/pre-restore-evidence.json")"
	queue_sha="$(sha256_file "$directory/queue-drain-evidence.json")"
	writers_sha="$(sha256_file "$directory/stopped-writers-evidence.json")"
	billing_core_source_cleanup_bind_staged_evidence \
		"$core_sha" "$billing_sha" "$restore_sha" "$queue_sha" "$writers_sha" \
		"$receipt_sha" \
		"$core_system" "$billing_system" "$database_id" || fail 'could not bind staged evidence'
	require_bound_pre_evidence || fail 'sealed evidence failed its final marker validation'
	echo 'Pre-cleanup off-VPS evidence is sealed; destructive --run is now eligible.'
}

verify_runtime_smoke() {
	local revision="$1" core_id billing_id service container image
	core_id="$(billing_core_source_cleanup_marker_value cleanup_core_image_id)"
	billing_id="$(billing_core_source_cleanup_marker_value cleanup_billing_image_id)"
	for service in api billing-api billing-scheduler billing-worker billing-outbox-publisher; do
		container="$(compose_target "$revision" ps --status running -q "$service" 2>/dev/null || true)"
		[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
		image="$(docker inspect --format '{{.Image}}' "$container")"
		case "$service" in api) [[ "$image" == "$core_id" ]] || return 1 ;; *) [[ "$image" == "$billing_id" ]] || return 1 ;; esac
	done
	for url in \
		http://127.0.0.1:4200/api/v1/health/ready \
		http://127.0.0.1:4100/health/ready \
		http://127.0.0.1:4800/health/ready \
		http://127.0.0.1:4801/health/ready \
		http://127.0.0.1:4802/health/ready \
		http://127.0.0.1:4803/health/ready \
		http://127.0.0.1:4800/api/v1/tariff-prices \
		http://127.0.0.1:4100/api/v1/tariff-prices \
		https://api.winwidget.ru/api/v1/tariff-prices; do
		curl -fsS --connect-timeout 3 --max-time 15 "$url" >/dev/null || return 1
	done
}

run_cleanup() {
	local revision phase generation directory post_dump post_sha core_system
	local previous_revision snapshot projection route source_state migration_state
	require_confirmation
	assert_production_context identity-if-present
	revision="$(assert_checkout)"
	billing_core_source_cleanup_validate_marker || fail 'cleanup marker is missing or invalid'
	[[ "$(billing_core_source_cleanup_marker_value revision)" == "$revision" ]] ||
		fail 'cleanup marker pins another revision'
	phase="$(billing_core_source_cleanup_marker_value phase)"
	if [[ "$phase" == 'complete' ]]; then
		[[ "$(billing_core_source_state)" == 'absent' &&
			"$(billing_core_source_cleanup_migration_state)" == 'applied' ]] ||
			fail 'completed cleanup database state drifted'
		billing_core_source_cleanup_require_exact_migration_manifest applied ||
			fail 'completed Core migration manifest or ledger drifted'
		billing_core_source_cleanup_require_evidence || fail 'completed cleanup evidence changed'
		verify_runtime_smoke "$revision" || fail 'completed cleanup runtime smoke failed'
		echo 'Billing Core source cleanup is already complete.'
		return
	fi
	[[ "$phase" =~ ^(staged|applied)$ ]] || fail 'cleanup marker is not runnable'
	require_bound_pre_evidence || fail 'all six pre-cleanup evidence hashes must be sealed before --run'
	previous_revision="$(billing_core_source_cleanup_marker_value previous_revision)"
	generation="$(billing_core_source_cleanup_marker_value ownership_generation)"
	directory="$(billing_core_source_cleanup_evidence_directory "$revision" "$generation")"
	snapshot="$(billing_core_source_cleanup_marker_value source_snapshot_sha256)"
	projection="$(billing_core_source_cleanup_marker_value projection_evidence_sha256)"
	route="$(billing_core_source_cleanup_marker_value route_evidence_sha256)"
	source_state="$(billing_core_source_state)" || fail 'Core source state is unreadable before run'
	migration_state="$(billing_core_source_cleanup_migration_state)" ||
		fail 'cleanup migration state is unreadable before run'
	if [[ "$migration_state" == 'applied' ]]; then
		billing_core_source_cleanup_require_exact_migration_manifest applied ||
			fail 'tracked Core migration manifest or applied ledger changed before run'
	else
		billing_core_source_cleanup_require_exact_migration_manifest exclusive ||
			fail 'tracked Core migration manifest or ledger is not exclusive before run'
	fi
	if [[ "$phase" == 'staged' && "$source_state" == 'present' ]]; then
		[[ "$migration_state" =~ ^(pending|rolled-back|unfinished)$ ]] ||
			fail 'staged present source has an unsafe migration ledger state'
		validate_stopped_writers_live "$directory/stopped-writers-evidence.json" \
			"$previous_revision" "$revision" "$generation" "$snapshot" "$projection" "$route" ||
			fail 'exact SHA A writers are not continuously stopped before run'
		validate_live_broker_from_queue_evidence "$revision" "$directory/queue-drain-evidence.json" ||
			fail 'RabbitMQ durable identity differs from staged queue evidence'
		require_reporting_outcome_topology_steady "$revision" ||
			fail 'Reporting outcome routing changed before run'
		require_core_sessions_drained "$revision" || fail 'Core database sessions reappeared before run'
		require_core_drain_state "$revision" || fail 'Core Billing drain changed before run'
		require_billing_database_quiescent "$revision" "$previous_revision" \
			"$(billing_core_source_cleanup_marker_value billing_database_id)" ||
			fail 'Billing database work or sessions changed before run'
		require_stopped_queue_boundary "$revision" || fail 'stopped queue boundary changed before run'
	elif [[ "$source_state" == 'absent' && "$migration_state" =~ ^(unfinished|applied)$ ]]; then
		:
	elif [[ "$phase" != 'applied' ]]; then
		fail "unsafe cleanup recovery state: source=$source_state migration=$migration_state"
	fi
	EXPECTED_REVISION="$revision" BILLING_AUTOMATIC_PROD_PUSH=false \
	BILLING_CORE_SOURCE_CLEANUP_APPROVED=true \
	BILLING_CORE_SOURCE_CLEANUP_CONFIRMATION="$CONFIRMATION" \
		bash "$SERVER_ROOT/scripts/deploy-production.sh"
	[[ "$(billing_core_source_cleanup_marker_value phase)" == 'applied' &&
		"$(billing_core_source_state)" == 'absent' &&
		"$(billing_core_source_cleanup_migration_state)" == 'applied' ]] ||
		fail 'deploy did not reach the durable applied|absent boundary'
	billing_core_source_cleanup_require_exact_migration_manifest applied ||
		fail 'deploy did not leave the exact tracked migration manifest applied'
	require_bound_pre_evidence || fail 'pre-cleanup evidence changed after deployment'
	verify_runtime_smoke "$revision" || fail 'post-cleanup direct/Gateway/public smoke failed'
	post_dump="$directory/core-post-cleanup.dump"
	ensure_dump "winwidget-api:git-$revision" DATABASE_BACKUP_URL public "$post_dump"
	post_sha="$(sha256_file "$post_dump")"
	core_system="$(billing_core_source_cleanup_marker_value core_system_identifier)"
	ensure_restore_evidence post "$revision" \
		"$(billing_core_source_cleanup_marker_value previous_revision)" "$generation" \
		"$directory" "$post_sha" '' "$core_system" '' \
		"$(billing_core_source_cleanup_marker_value billing_database_id)"
	echo 'Billing Core source cleanup is applied and its post-cleanup PostgreSQL 18 restore passed.'
	echo 'Copy and SHA-verify both post-cleanup artifacts off the VPS, then use --complete-offsite.'
	echo "Import the receipt at ${POST_RECEIPT_PREFIX}-${revision}-g${generation}.json."
}

write_completion_evidence() {
	[[ $# -eq 9 ]] || return 1
	local destination="$1" revision="$2" previous_revision="$3" generation="$4"
	local post_sha="$5" post_restore_sha="$6" pre_receipt_sha="$7" post_receipt_sha="$8"
	local retired_topology_sha="$9"
	local partial="$destination.partial" verified_at
	verified_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	[[ ! -e "$destination" && ! -L "$destination" ]] || return 1
	remove_recoverable_partial "$partial"
	COMPLETION_REVISION="$revision" PREVIOUS_REVISION="$previous_revision" \
		OWNERSHIP_GENERATION="$generation" POST_SHA="$post_sha" \
		POST_RESTORE_SHA="$post_restore_sha" PRE_RECEIPT_SHA="$pre_receipt_sha" \
		POST_RECEIPT_SHA="$post_receipt_sha" RETIRED_TOPOLOGY_SHA="$retired_topology_sha" \
		VERIFIED_AT="$verified_at" \
		billing_release_node <<'NODE' >"$partial"
const value = {
  schemaVersion: 1,
  action: 'billing-core-source-cleanup-complete',
  status: 'verified',
  previousRevision: process.env.PREVIOUS_REVISION,
  cleanupRevision: process.env.COMPLETION_REVISION,
  ownershipGeneration: Number(process.env.OWNERSHIP_GENERATION),
  postCleanupBackupSha256: process.env.POST_SHA,
  postRestoreEvidenceSha256: process.env.POST_RESTORE_SHA,
  preOffsiteReceiptSha256: process.env.PRE_RECEIPT_SHA,
  postOffsiteReceiptSha256: process.env.POST_RECEIPT_SHA,
  legacySourceAbsent: true,
  migrationApplied: true,
  runtimeSmoke: true,
  directGatewayPublicParity: true,
  cleanPostgreSQL18Restore: true,
  retiredOutcomeTopologyAbsent: true,
  retiredOutcomeTopologyContractSha256: process.env.RETIRED_TOPOLOGY_SHA,
  verifiedAt: process.env.VERIFIED_AT,
};
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE
	chown 0:0 "$partial"
	chmod 600 "$partial"
	mv -fT "$partial" "$destination"
}

validate_completion_evidence() {
	[[ $# -eq 9 ]] || return 1
	COMPLETION_FILE="$1" COMPLETION_REVISION="$2" PREVIOUS_REVISION="$3" \
		OWNERSHIP_GENERATION="$4" POST_SHA="$5" POST_RESTORE_SHA="$6" \
		PRE_RECEIPT_SHA="$7" POST_RECEIPT_SHA="$8" RETIRED_TOPOLOGY_SHA="$9" billing_release_node <<'NODE'
const fs = require('node:fs');
let value;
try { value = JSON.parse(fs.readFileSync(process.env.COMPLETION_FILE, 'utf8')); } catch { process.exit(1); }
const keys = ['action','cleanPostgreSQL18Restore','cleanupRevision','directGatewayPublicParity',
  'legacySourceAbsent','migrationApplied','ownershipGeneration','postCleanupBackupSha256',
  'postOffsiteReceiptSha256','postRestoreEvidenceSha256','preOffsiteReceiptSha256',
  'previousRevision','retiredOutcomeTopologyAbsent','retiredOutcomeTopologyContractSha256',
  'runtimeSmoke','schemaVersion','status','verifiedAt'].sort().join('|');
if (!value || Array.isArray(value) || Object.keys(value).sort().join('|') !== keys ||
    value.schemaVersion !== 1 || value.action !== 'billing-core-source-cleanup-complete' ||
    value.status !== 'verified' || value.previousRevision !== process.env.PREVIOUS_REVISION ||
    value.cleanupRevision !== process.env.COMPLETION_REVISION ||
    String(value.ownershipGeneration) !== process.env.OWNERSHIP_GENERATION ||
    value.postCleanupBackupSha256 !== process.env.POST_SHA ||
    value.postRestoreEvidenceSha256 !== process.env.POST_RESTORE_SHA ||
    value.preOffsiteReceiptSha256 !== process.env.PRE_RECEIPT_SHA ||
    value.postOffsiteReceiptSha256 !== process.env.POST_RECEIPT_SHA ||
    value.retiredOutcomeTopologyAbsent !== true ||
    value.retiredOutcomeTopologyContractSha256 !== process.env.RETIRED_TOPOLOGY_SHA ||
    !/^[0-9a-f]{64}$/.test(value.retiredOutcomeTopologyContractSha256 || '') ||
    value.legacySourceAbsent !== true || value.migrationApplied !== true ||
    value.runtimeSmoke !== true || value.directGatewayPublicParity !== true ||
    value.cleanPostgreSQL18Restore !== true ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.verifiedAt)) process.exit(1);
NODE
}

complete_offsite() {
	local revision generation directory post_dump post_sha post_restore post_restore_sha
	local receipt_source receipt_destination post_receipt_sha pre_receipt_sha completion completion_sha
	local retired_topology_sha current_retired_topology_sha
	require_confirmation
	assert_production_context identity-if-present
	revision="$(assert_checkout)"
	billing_core_source_cleanup_validate_marker || fail 'cleanup marker is missing or invalid'
	[[ "$(billing_core_source_cleanup_marker_value revision)" == "$revision" ]] ||
		fail 'cleanup marker pins another revision'
	if [[ "$(billing_core_source_cleanup_marker_value phase)" == 'complete' ]]; then
		billing_core_source_cleanup_require_exact_migration_manifest applied ||
			fail 'completed Core migration manifest or ledger drifted'
		billing_core_source_cleanup_require_evidence || fail 'completed cleanup evidence changed'
		retired_outcome_topology_contract "$revision" >/dev/null ||
			fail 'retired Core notification outcome topology reappeared after completion'
		verify_runtime_smoke "$revision" || fail 'completed cleanup runtime smoke failed'
		echo 'Billing Core source cleanup is already complete.'
		return
	fi
	[[ "$(billing_core_source_cleanup_marker_value phase)" == 'applied' &&
		"$(billing_core_source_state)" == 'absent' &&
		"$(billing_core_source_cleanup_migration_state)" == 'applied' ]] ||
		fail 'post-cleanup evidence requires applied|absent database state'
	billing_core_source_cleanup_require_exact_migration_manifest applied ||
		fail 'tracked Core migration manifest or applied ledger changed before completion'
	require_bound_pre_evidence || fail 'pre-cleanup evidence changed'
	verify_runtime_smoke "$revision" || fail 'post-cleanup runtime smoke failed'
	generation="$(billing_core_source_cleanup_marker_value ownership_generation)"
	directory="$(billing_core_source_cleanup_evidence_directory "$revision" "$generation")"
	post_dump="$directory/core-post-cleanup.dump"
	post_restore="$directory/post-restore-evidence.json"
	validate_private_file "$post_dump" && validate_dump_list "$post_dump" ||
		fail 'post-cleanup dump is missing or unsafe'
	validate_private_file "$post_restore" || fail 'post-cleanup restore evidence is missing or unsafe'
	post_sha="$(sha256_file "$post_dump")"
	post_restore_sha="$(sha256_file "$post_restore")"
	validate_restore_evidence "$post_restore" post \
		"$(billing_core_source_cleanup_marker_value previous_revision)" "$revision" "$generation" \
		"$post_sha" '' "$(billing_core_source_cleanup_marker_value core_system_identifier)" '' \
		"$(billing_core_source_cleanup_marker_value billing_database_id)" ||
		fail 'post-cleanup restore evidence is invalid'
	retired_topology_sha="$(retired_outcome_topology_contract "$revision")" ||
		fail 'retired Core notification outcome queues or bindings reappeared before completion'
	receipt_source="${POST_RECEIPT_PREFIX}-${revision}-g${generation}.json"
	receipt_destination="$directory/post-offsite-receipt.json"
	post_receipt_sha="$(import_offsite_receipt "$receipt_source" "$receipt_destination" \
		post "$directory" "$post_sha")" || fail 'post-cleanup off-VPS receipt is missing or invalid'
	pre_receipt_sha="$(billing_core_source_cleanup_marker_value pre_offsite_receipt_sha256)"
	completion="$directory/completion-evidence.json"
	if [[ ! -e "$completion" && ! -L "$completion" ]]; then
		write_completion_evidence "$completion" "$revision" \
			"$(billing_core_source_cleanup_marker_value previous_revision)" "$generation" \
			"$post_sha" "$post_restore_sha" "$pre_receipt_sha" "$post_receipt_sha" \
			"$retired_topology_sha"
	fi
	validate_private_file "$completion" || fail 'completion evidence is unsafe'
	validate_completion_evidence "$completion" "$revision" \
		"$(billing_core_source_cleanup_marker_value previous_revision)" "$generation" \
		"$post_sha" "$post_restore_sha" "$pre_receipt_sha" "$post_receipt_sha" \
		"$retired_topology_sha" ||
		fail 'completion evidence is invalid'
	completion_sha="$(sha256_file "$completion")"
	current_retired_topology_sha="$(retired_outcome_topology_contract "$revision")" ||
		fail 'retired Core notification outcome topology changed before marker completion'
	[[ "$current_retired_topology_sha" == "$retired_topology_sha" ]] ||
		fail 'canonical RabbitMQ completion contract changed before marker completion'
	billing_core_source_cleanup_require_exact_migration_manifest applied ||
		fail 'tracked Core migration manifest or applied ledger changed before marker completion'
	billing_core_source_cleanup_advance_complete "$post_sha" "$post_restore_sha" \
		"$post_receipt_sha" "$completion_sha" || fail 'could not complete durable cleanup marker'
	billing_core_source_cleanup_require_evidence || fail 'completed cleanup evidence failed final validation'
	echo 'Billing Core source cleanup completed with retained pre/post evidence and clean PostgreSQL 18 restores.'
}

show_status() {
	local revision marker_state phase source_state migration_state generation
	local pre_bound='false' post_bound='false'
	assert_readonly_production_context
	revision="$(git -C "$SERVER_ROOT" rev-parse HEAD 2>/dev/null || printf 'unavailable')"
	marker_state="$(billing_core_source_cleanup_marker_state 2>/dev/null || printf 'invalid')"
	source_state="$(billing_core_source_state 2>/dev/null || printf 'unknown')"
	migration_state="$(billing_core_source_cleanup_migration_state 2>/dev/null || printf 'unknown')"
	phase="$marker_state"
	generation='unavailable'
	if [[ "$marker_state" =~ ^(staged|applied|complete)$ ]]; then
		phase="$(billing_core_source_cleanup_marker_value phase)"
		revision="$(billing_core_source_cleanup_marker_value revision)"
		generation="$(billing_core_source_cleanup_marker_value ownership_generation)"
		if require_bound_pre_evidence; then pre_bound='true'; fi
		if [[ "$phase" == 'complete' ]] && billing_core_source_cleanup_require_evidence; then
			post_bound='true'
		fi
	fi
	printf 'phase=%s\nsource=%s\nmigration=%s\nrevision=%s\ngeneration=%s\npre_evidence_bound=%s\npost_evidence_bound=%s\n' \
		"$phase" "$source_state" "$migration_state" "$revision" "$generation" \
		"$pre_bound" "$post_bound"
}

self_test() {
	local source revision previous sha directory receipt forbidden_cleanup_name forbidden_cleanup_status
	revision='0123456789abcdef0123456789abcdef01234567'
	previous='89abcdef0123456789abcdef0123456789abcdef'
	sha="$(printf 'a%.0s' {1..64})"
	directory="$(mktemp -d "${TMPDIR:-/tmp}/billing-core-cleanup-self-test.XXXXXX")"
	receipt="$directory/receipt.json"
	trap 'rm -f -- "$receipt"; rmdir -- "$directory"' RETURN
	reference_is_safe operator-managed-macos macos-offsite:billing-cleanup-verified-001
	! reference_is_safe operator-managed-macos file:///root/not-offsite
	! reference_is_safe unknown-provider macos-offsite:billing-cleanup-verified-001
	printf '%s\n' \
		'{"schemaVersion":1,"action":"billing-core-source-cleanup-pre-offsite","status":"verified","provider":"operator-managed-macos","providerReference":"macos-offsite:billing-cleanup-verified-001","cleanupRevision":"0123456789abcdef0123456789abcdef01234567","ownershipGeneration":2,"sourceSnapshotSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","artifacts":[{"name":"billing-pre-cleanup.dump","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"name":"core-pre-cleanup.dump","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"name":"pre-restore-evidence.json","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"name":"queue-drain-evidence.json","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"name":"stopped-writers-evidence.json","sizeBytes":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"verifiedAt":"2026-08-13T00:00:00Z"}' \
		>"$receipt"
	RECEIPT_FILE="$receipt" EXPECTED_KIND=pre billing_release_node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.env.RECEIPT_FILE, "utf8"));
if (value.artifacts.length !== 5 || value.action !== "billing-core-source-cleanup-pre-offsite") process.exit(1);
'
	[[ "$revision" != "$previous" && "$sha" =~ ^[0-9a-f]{64}$ ]]
	[[ "$(billing_core_source_cleanup_recovery_action present unfinished)" == 'restore-exact' ]]
	[[ "$(billing_core_source_cleanup_recovery_action absent unfinished)" == 'forward-only' ]]
	printf '%s\n' \
		'[{"Config":{"Env":["GATEWAY_ROUTES_JSON=[{\"id\":\"test\"}]"]}}]' | \
		validate_gateway_container_routes '[{"id":"test"}]'
	if printf '%s\n' \
		'[{"Config":{"Env":["GATEWAY_ROUTES_JSON=[{\"id\":\"wrong\"}]"]}}]' | \
		validate_gateway_container_routes '[{"id":"test"}]'; then
		return 1
	fi
	source="$(<"${BASH_SOURCE[0]}")"
	forbidden_cleanup_name='purge_completed_raw_''evidence'
	forbidden_cleanup_status=0
	grep -Fq -- "$forbidden_cleanup_name" "${BASH_SOURCE[0]}" || forbidden_cleanup_status=$?
	[[ "$forbidden_cleanup_status" -eq 1 ]]
	[[ "$source" == *'--stage|--seal-offsite|--run|--complete-offsite'* &&
		"$source" == *'billing_core_source_cleanup_bind_staged_evidence'* &&
		"$source" == *'billing_core_source_cleanup_advance_complete'* &&
		"$source" == *'BILLING_CORE_SOURCE_CLEANUP_APPROVED=true'* &&
		"$source" == *'queue-drain-evidence.json'* &&
		"$source" == *'stopped-writers-evidence.json'* ]]
	RUNNER_SOURCE="$source" billing_release_node <<'NODE'
const source = process.env.RUNNER_SOURCE;
const restart = source.indexOf('if restart_stage_writers; then');
const restartArchive = source.indexOf('archive_unbound_stage_artifacts "$(dirname -- "$STAGE_PRECOMMIT_FILE")"', restart);
const precommitRemoval = source.indexOf('remove_recoverable_partial "$STAGE_PRECOMMIT_FILE"', restart);
const restop = source.indexOf('if restop_stage_writers_after_failed_recovery; then', restart);
const restopArchive = source.indexOf('archive_unbound_stage_artifacts "$(dirname -- "$STAGE_PRECOMMIT_FILE")"', restop);
if (restart < 0 || restartArchive < restart || precommitRemoval < restartArchive ||
    restop < precommitRemoval || restopArchive < restop) process.exit(1);
NODE
	printf 'billing_core_source_cleanup_self_test=passed\n'
}

case "${1:-}" in
--status)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	show_status
	;;
--self-test)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	self_test
	;;
--stage)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	acquire_production_deploy_lock 'Billing Core source cleanup stage'
	stage_cleanup
	;;
--seal-offsite)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	acquire_production_deploy_lock 'Billing Core source cleanup offsite seal'
	seal_offsite
	;;
--run)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	acquire_production_deploy_lock 'Billing Core source cleanup run'
	run_cleanup
	;;
--complete-offsite)
	[[ "$#" -eq 1 ]] || fail 'unexpected arguments'
	acquire_production_deploy_lock 'Billing Core source cleanup completion'
	complete_offsite
	;;
*)
	echo 'Usage: cleanup-billing-core-source-production.sh --status|--self-test|--stage|--seal-offsite|--run|--complete-offsite' >&2
	exit 64
	;;
esac
