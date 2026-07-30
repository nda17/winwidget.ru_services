#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
ACTION="${1:-prepare}"
HEALTHCHECK_ATTEMPTS="${CAMPAIGNS_CUTOVER_HEALTHCHECK_ATTEMPTS:-60}"
HEALTHCHECK_INTERVAL="${CAMPAIGNS_CUTOVER_HEALTHCHECK_INTERVAL:-2}"

server_root="$APP_ROOT/winwidget.ru_server"
# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
acquire_production_deploy_lock "Campaigns database $ACTION"
# shellcheck source=scripts/campaigns-database-lifecycle.sh
source "$server_root/scripts/campaigns-database-lifecycle.sh"
# shellcheck source=scripts/campaigns-contract-migration-guard.sh
source "$server_root/scripts/campaigns-contract-migration-guard.sh"

temporary_marker=""
writes_frozen=false
forward_only=false
artifact_directory=""
cutover_started_at=""
source_manifest_sha256="pending"
target_manifest_sha256="pending"
postgres_image_id="pending"
postgres_system_identifier="pending"
previous_image_id="none"
previous_revision="none"
previous_gateway_image_id="none"
previous_gateway_routes_base64="pending"
previous_maintenance_image_id="none"
previous_notification_image_id="none"
telegram_audit_decision="pending"
telegram_audit_reference_sha256="pending"
restore_drill_reference_sha256="pending"
contract_migration_sha256=""
marker_phase=""
switch_generation=0
switch_started=false
previous_gateway_routes_json=""
rollback_image_tag=""
rollback_maintenance_revision="none"
rollback_notification_revision="none"
target_api_image_id="pending"
target_gateway_image_id="pending"
target_maintenance_image_id="pending"
target_notification_image_id="pending"
target_campaigns_image_id="pending"

fail() {
	echo "$1" >&2
	exit 1
}

validate_rehearsal_context() {
	local phase="${CAMPAIGNS_CUTOVER_REHEARSAL_FAIL_AFTER_PHASE:-}"
	local rehearsal="${CAMPAIGNS_CUTOVER_REHEARSAL:-}"
	local run_id="${CAMPAIGNS_CUTOVER_REHEARSAL_RUN_ID:-}"
	local gateway_write_token="${CAMPAIGNS_CUTOVER_REHEARSAL_GATEWAY_WRITE_TOKEN:-}"
	local canonical_app_root expected_app_root
	[[ -n "$phase" || "$rehearsal" == "true" ||
		-n "$gateway_write_token" ]] || return 0
	if [[ -n "$phase" ]]; then
		[[ "$phase" =~ ^(preflight|target-created|roles-ready|migrated|source-frozen|importing|copied|verified|switching|switch-runtime-started|gateway-exposed|switch-recovered|switched|forward-only|source-dropped|complete)$ ]] ||
			fail "Unknown Campaigns rehearsal failure phase: $phase"
	fi
	[[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ &&
		"$run_id" != "." && "$run_id" != ".." ]] ||
		fail "Campaigns rehearsal run ID is missing or invalid."
	expected_app_root="/tmp/winwidget-campaigns-cutover-rehearsal-$run_id"
	canonical_app_root="$(realpath -e -- "$APP_ROOT" 2>/dev/null)" ||
		fail "Campaigns rehearsal app root does not exist."
	[[ "$rehearsal" == "true" &&
		"$APP_ROOT" == "$expected_app_root" &&
		"$canonical_app_root" == "$APP_ROOT" &&
		-d "$APP_ROOT" && ! -L "$APP_ROOT" &&
		"$ENV_FILE" == "$APP_ROOT/deploy/backend/.env.production" &&
		"$COMPOSE_FILE" == "$APP_ROOT/winwidget.ru_server/deploy/docker-compose.rehearsal.yml" ]] ||
		fail "Campaigns rehearsal controls are allowed only in the exact isolated /tmp rehearsal."
	if [[ "$phase" == "gateway-exposed" ]]; then
		[[ -n "$gateway_write_token" &&
			${#gateway_write_token} -le 16384 &&
			"$gateway_write_token" != *[[:space:]]* &&
			"$gateway_write_token" == *.*.* ]] ||
			fail "The isolated gateway-exposed rehearsal requires a bounded access token."
	elif [[ -n "$gateway_write_token" ]]; then
		fail "The rehearsal Gateway write token is allowed only at gateway-exposed."
	fi
}

rehearsal_checkpoint() {
	local phase="$1"
	[[ "${CAMPAIGNS_CUTOVER_REHEARSAL_FAIL_AFTER_PHASE:-}" == "$phase" ]] ||
		return 0
	echo "Campaigns rehearsal injected a failure at checkpoint=$phase with durable phase=$marker_phase." >&2
	return 86
}

rehearsal_gateway_write_before_failure() {
	local status
	[[ "${CAMPAIGNS_CUTOVER_REHEARSAL_FAIL_AFTER_PHASE:-}" == "gateway-exposed" ]] ||
		return 0
	status="$(
		curl -sS -o /dev/null -w '%{http_code}' \
			-X POST \
			-H "Authorization: Bearer ${CAMPAIGNS_CUTOVER_REHEARSAL_GATEWAY_WRITE_TOKEN}" \
			-H 'Content-Type: application/json' \
			-H 'Idempotency-Key: 22000000-0000-4000-8000-000000000001' \
			--data '{"subject":"Gateway exposed recovery","message":"This target-only campaign must be discarded during recovery.","audience":"ALL","channel":"EMAIL"}' \
			http://127.0.0.1:4100/api/v1/admin/campaigns
	)" || fail "The isolated gateway-exposed rehearsal write failed."
	[[ "$status" == "202" ]] ||
		fail "The isolated gateway-exposed rehearsal write returned HTTP $status."
}

get_env_value() {
	local key="$1"
	awk -F= -v key="$key" '
		/^[[:space:]]*(#|$)/ { next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)
			value = $0
			sub(/^[^=]*=/, "", value)
			sub(/\r$/, "", value)
			sub(/^[[:space:]]*/, "", value)
			sub(/[[:space:]]*$/, "", value)
			if (name == key) {
				print value
				found += 1
			}
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$ENV_FILE"
}

activate_target_runtime_environment() {
	export APP_REVISION="$EXPECTED_REVISION"
	export APP_VERSION="git-$EXPECTED_REVISION"
	export MAINTENANCE_REVISION="$EXPECTED_REVISION"
	export MAINTENANCE_IMAGE="winwidget-maintenance:git-$EXPECTED_REVISION"
	export NOTIFICATION_DELIVERY_REVISION="$EXPECTED_REVISION"
	export NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:git-$EXPECTED_REVISION"
	export CAMPAIGNS_REVISION="$EXPECTED_REVISION"
	export CAMPAIGNS_IMAGE="winwidget-campaigns:git-$EXPECTED_REVISION"
	export GATEWAY_ROUTES_JSON
	GATEWAY_ROUTES_JSON="$(get_env_value GATEWAY_ROUTES_JSON)"
}

require_env_key() {
	local key="$1"
	local value
	value="$(get_env_value "$key")" ||
		fail "Missing or duplicate production env key: $key"
	[[ -n "$value" && "$value" != change_me* && "$value" != XYZXYZXYZ* ]] ||
		fail "Production env key is empty or a placeholder: $key"
}

compose_target() {
	docker compose \
		--project-name winwidget \
		--env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" \
		"$@"
}

compose_rollback_target() {
	local rollback_compose_file="$artifact_directory/rollback-compose.json"
	[[ -f "$rollback_compose_file" && ! -L "$rollback_compose_file" &&
		"$(stat -c '%a' "$rollback_compose_file")" == "600" &&
		"$(stat -c '%u:%g' "$rollback_compose_file")" == "0:0" ]] ||
		fail "Campaigns rollback Compose override is missing or unsafe."
	docker compose \
		--project-name winwidget \
		--env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" \
		-f "$rollback_compose_file" \
		"$@"
}

wait_for_url_ready() {
	local url="$1"
	local expected_revision="${2:-}"
	local response
	local attempt
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		response="$(curl -fsS --connect-timeout 2 --max-time 5 "$url" 2>/dev/null || true)"
		if [[ -n "$response" &&
			(-z "$expected_revision" ||
				"$response" == *"\"revision\":\"$expected_revision\""* ||
				"$response" == *"\"revision\": \"$expected_revision\""*) ]]; then
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	return 1
}

wait_for_url() {
	local url="$1"
	local label="$2"
	local expected_revision="${3:-}"
	wait_for_url_ready "$url" "$expected_revision" ||
		fail "$label did not become ready at the expected revision."
}

resolve_reviewed_image_id() {
	local image_ref="$1"
	local expected_revision="$2"
	local label="$3"
	local image_id image_revision
	image_id="$(docker image inspect "$image_ref" --format '{{.Id}}')"
	image_revision="$(
		docker image inspect "$image_ref" \
			--format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
	)"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$image_revision" == "$expected_revision" ]] ||
		fail "$label image identity or revision label is invalid."
	printf '%s' "$image_id"
}

verify_campaigns_image_artifact() {
	docker run --rm --network none \
		--entrypoint node "$CAMPAIGNS_IMAGE" -e '
const fs = require("node:fs");
for (const required of [
  "dist/src/main.js",
  "prisma/schema.prisma",
  "prisma/migrations/20260730000000_init_campaigns/migration.sql",
]) fs.accessSync(required);
require("@prisma/campaigns-client");
const migration = fs.readFileSync(
  "prisma/migrations/20260730000000_init_campaigns/migration.sql",
  "utf8",
);
if (/CREATE\s+SCHEMA/i.test(migration)) {
  throw new Error("Campaigns initial migration must use the pre-provisioned schema");
}
for (const forbidden of [
  "dist/src/app.module.js",
  "dist/src/mailing/mailing.service.js",
  "dist/src/outbox-publisher-main.js",
  "public/widgets",
]) {
  if (fs.existsSync(forbidden)) {
    throw new Error(`Campaigns image contains monolith artifact: ${forbidden}`);
  }
}
process.stdout.write("Campaigns cutover image artifact verified\n");
'
}

validate_campaigns_gateway_manifest() {
	local manifest="$1"
	printf '%s' "$manifest" |
		docker run --rm -i --network none \
			--entrypoint node "winwidget-api-gateway:$APP_VERSION" -e '
const fs = require("node:fs");
let routes;
try {
  routes = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  throw new Error("GATEWAY_ROUTES_JSON is not valid JSON");
}
if (!Array.isArray(routes) || routes.length === 0) {
  throw new Error("Gateway route manifest must be a non-empty array");
}
const ids = new Set();
const prefixes = new Set();
for (const route of routes) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new Error("Gateway route entry is invalid");
  }
  if (ids.has(route.id) || prefixes.has(route.pathPrefix)) {
    throw new Error("Gateway route ids and path prefixes must be unique");
  }
  ids.add(route.id);
  prefixes.add(route.pathPrefix);
  if (
    typeof route.pathPrefix !== "string" ||
    route.pathPrefix === "/internal" ||
    route.pathPrefix.startsWith("/internal/")
  ) {
    throw new Error("Internal endpoints must not be published by Gateway");
  }
}
const campaignsIndex = routes.findIndex(route => route.id === "campaigns");
const monolithIndex = routes.findIndex(route => route.id === "monolith");
const campaigns = routes[campaignsIndex];
const monolith = routes[monolithIndex];
if (
  campaignsIndex < 0 ||
  monolithIndex < 0 ||
  campaignsIndex >= monolithIndex ||
  campaigns.pathPrefix !== "/api/v1/admin/campaigns" ||
  campaigns.upstreamUrl !== "http://127.0.0.1:4500" ||
  campaigns.authPolicy !== "required" ||
  campaigns.timeoutMs !== 60000 ||
  monolith.pathPrefix !== "/api/v1" ||
  monolith.upstreamUrl !== "http://127.0.0.1:4200" ||
  monolith.authPolicy !== "optional" ||
  monolith.timeoutMs !== 60000
) {
  throw new Error(
    "Gateway must route Campaigns before the explicit monolith catch-all",
  );
}
process.stdout.write("Campaigns Gateway manifest verified\n");
	'
}

verify_live_service_image() {
	local service="$1"
	local expected_image_id="$2"
	local expected_revision="$3"
	local container_id image_id image_revision restart_count
	container_id="$(
		compose_target ps --status running -q "$service" 2>/dev/null || true
	)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] ||
		fail "Exactly one running $service container is required."
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_revision="$(
		docker image inspect \
			--format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
			"$image_id"
	)"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	[[ "$image_id" == "$expected_image_id" &&
		"$image_revision" == "$expected_revision" &&
		"$restart_count" == "0" ]] ||
		fail "$service runtime identity is invalid: image=$image_id expected=$expected_image_id revision=$image_revision expectedRevision=$expected_revision restartCount=$restart_count."
}

verify_live_campaigns_gateway() {
	local container_id live_manifest image_id restart_count
	container_id="$(
		compose_target ps --status running -q api-gateway 2>/dev/null || true
	)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] ||
		fail "Exactly one running API Gateway container is required."
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	[[ "$image_id" == "$target_gateway_image_id" && "$restart_count" == "0" ]] ||
		fail "Live API Gateway does not use the reviewed cutover image."
	live_manifest="$(container_env_value "$container_id" GATEWAY_ROUTES_JSON)"
	[[ -n "$live_manifest" ]] || fail "Live API Gateway route manifest is missing."
	validate_campaigns_gateway_manifest "$live_manifest"
}

hash_text() {
	printf '%s' "$1" | sha256sum | awk '{ print $1 }'
}

write_marker() {
	local phase="$1"
	local source_schema_state="$2"
	local run_checkpoint="${3:-true}"
	local marker_directory
	marker_directory="$(dirname "$CAMPAIGNS_DATABASE_CUTOVER_MARKER")"
	[[ -d "$marker_directory" && ! -L "$marker_directory" ]] ||
		fail "Campaigns marker directory must already be a regular directory."
	temporary_marker="$marker_directory/.campaigns-marker.$$"
	{
		printf 'phase=%s\n' "$phase"
		printf 'revision=%s\n' "$EXPECTED_REVISION"
		printf 'cutover_started_at=%s\n' "$cutover_started_at"
		printf 'source_schema_state=%s\n' "$source_schema_state"
		printf 'target_volume=%s\n' "$CAMPAIGNS_CANONICAL_POSTGRES_VOLUME"
		printf 'artifact_directory=%s\n' "$artifact_directory"
		printf 'postgres_image_id=%s\n' "$postgres_image_id"
		printf 'postgres_system_identifier=%s\n' "$postgres_system_identifier"
		printf 'source_manifest_sha256=%s\n' "$source_manifest_sha256"
		printf 'target_manifest_sha256=%s\n' "$target_manifest_sha256"
		printf 'contract_migration_sha256=%s\n' "$contract_migration_sha256"
		printf 'target_api_image_id=%s\n' "$target_api_image_id"
		printf 'target_gateway_image_id=%s\n' "$target_gateway_image_id"
		printf 'target_maintenance_image_id=%s\n' "$target_maintenance_image_id"
		printf 'target_notification_image_id=%s\n' "$target_notification_image_id"
		printf 'target_campaigns_image_id=%s\n' "$target_campaigns_image_id"
		printf 'switch_generation=%s\n' "$switch_generation"
		printf 'telegram_audit_decision=%s\n' "$telegram_audit_decision"
		printf 'telegram_audit_reference_sha256=%s\n' "$telegram_audit_reference_sha256"
		printf 'restore_drill_reference_sha256=%s\n' "$restore_drill_reference_sha256"
		printf 'previous_image_id=%s\n' "$previous_image_id"
		printf 'previous_revision=%s\n' "$previous_revision"
		printf 'previous_gateway_image_id=%s\n' "$previous_gateway_image_id"
		printf 'previous_gateway_routes_base64=%s\n' "$previous_gateway_routes_base64"
		printf 'previous_maintenance_image_id=%s\n' "$previous_maintenance_image_id"
		printf 'previous_notification_image_id=%s\n' "$previous_notification_image_id"
		printf 'rollback_maintenance_revision=%s\n' "$rollback_maintenance_revision"
		printf 'rollback_notification_revision=%s\n' "$rollback_notification_revision"
		printf 'updated_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	} >"$temporary_marker"
	chown 0:0 "$temporary_marker"
	chmod 600 "$temporary_marker"
	mv -f "$temporary_marker" "$CAMPAIGNS_DATABASE_CUTOVER_MARKER"
	temporary_marker=""
	validate_campaigns_database_cutover_marker ||
		fail "Campaigns cutover marker failed its own validation."
	marker_phase="$phase"
	if [[ "$run_checkpoint" == "true" ]]; then
		rehearsal_checkpoint "$phase"
	fi
}

load_marker() {
	validate_campaigns_database_cutover_marker ||
		fail "Campaigns cutover marker has invalid ownership, mode or content."
	marker_phase="$(campaigns_database_marker_value phase)"
	cutover_started_at="$(campaigns_database_marker_value cutover_started_at)"
	artifact_directory="$(campaigns_database_marker_value artifact_directory)"
	source_manifest_sha256="$(campaigns_database_marker_value source_manifest_sha256)"
	target_manifest_sha256="$(campaigns_database_marker_value target_manifest_sha256)"
	postgres_image_id="$(campaigns_database_marker_value postgres_image_id)"
	postgres_system_identifier="$(campaigns_database_marker_value postgres_system_identifier)"
	contract_migration_sha256="$(campaigns_database_marker_value contract_migration_sha256)"
	target_api_image_id="$(campaigns_database_marker_value target_api_image_id)"
	target_gateway_image_id="$(campaigns_database_marker_value target_gateway_image_id)"
	target_maintenance_image_id="$(campaigns_database_marker_value target_maintenance_image_id)"
	target_notification_image_id="$(campaigns_database_marker_value target_notification_image_id)"
	target_campaigns_image_id="$(campaigns_database_marker_value target_campaigns_image_id)"
	switch_generation="$(campaigns_database_marker_value switch_generation)"
	telegram_audit_decision="$(campaigns_database_marker_value telegram_audit_decision)"
	telegram_audit_reference_sha256="$(campaigns_database_marker_value telegram_audit_reference_sha256)"
	restore_drill_reference_sha256="$(campaigns_database_marker_value restore_drill_reference_sha256)"
	previous_image_id="$(campaigns_database_marker_value previous_image_id)"
	previous_revision="$(campaigns_database_marker_value previous_revision)"
	previous_gateway_image_id="$(campaigns_database_marker_value previous_gateway_image_id)"
	previous_gateway_routes_base64="$(campaigns_database_marker_value previous_gateway_routes_base64)"
	previous_maintenance_image_id="$(campaigns_database_marker_value previous_maintenance_image_id)"
	previous_notification_image_id="$(campaigns_database_marker_value previous_notification_image_id)"
	rollback_maintenance_revision="$(campaigns_database_marker_value rollback_maintenance_revision)"
	rollback_notification_revision="$(campaigns_database_marker_value rollback_notification_revision)"
	if [[ "$previous_gateway_routes_base64" != "pending" ]]; then
		previous_gateway_routes_json="$(
			printf '%s' "$previous_gateway_routes_base64" | base64 --decode
		)"
	fi
	[[ -d "$artifact_directory" && ! -L "$artifact_directory" ]] ||
		fail "Campaigns cutover artifact directory is missing."
	if [[ "$marker_phase" =~ ^(source-frozen|importing|copied|verified|switching|switched|forward-only|source-dropped|complete)$ ]]; then
		local rollback_compose_file="$artifact_directory/rollback-compose.json"
		[[ -f "$rollback_compose_file" && ! -L "$rollback_compose_file" &&
			"$(stat -c '%a' "$rollback_compose_file")" == "600" &&
			"$(stat -c '%u:%g' "$rollback_compose_file")" == "0:0" ]] ||
			fail "Campaigns rollback Compose override is missing or unsafe."
	fi
}

campaigns_phase_rank() {
	case "$1" in
	preflight) printf '0' ;;
	target-created) printf '1' ;;
	roles-ready) printf '2' ;;
	migrated) printf '3' ;;
	source-frozen) printf '4' ;;
	importing) printf '5' ;;
	copied) printf '6' ;;
	verified) printf '7' ;;
	switching) printf '8' ;;
	switched) printf '9' ;;
	forward-only) printf '10' ;;
	source-dropped) printf '11' ;;
	complete) printf '12' ;;
	*) return 1 ;;
	esac
}

phase_at_least() {
	local expected="$1"
	(( $(campaigns_phase_rank "$marker_phase") >= $(campaigns_phase_rank "$expected") ))
}

restart_frozen_services() {
	[[ "$writes_frozen" == "true" && "$forward_only" != "true" ]] || return 0
	compose_target start \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
		api \
		api-gateway >/dev/null
	if [[ "$marker_phase" == "switched" ]]; then
		compose_target start campaigns-service >/dev/null
	fi
	writes_frozen=false
}

container_env_value() {
	local container_id="$1"
	local key="$2"
	docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$container_id" |
		sed -n "s/^${key}=//p"
}

capture_pre_switch_runtime() {
	local service
	local container_id
	local image_id
	local image_revision
	local integration_worker_kinds
	local mailing_email_rate
	local mailing_telegram_rate
	local api_image_id=""
	local gateway_image_id=""
	local maintenance_image_id=""
	local notification_image_id=""
	for service in \
		api \
		api-gateway \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker; do
		container_id="$(
			compose_target ps --status running -q "$service" 2>/dev/null ||
				true
		)"
		[[ -n "$container_id" && "$container_id" != *$'\n'* ]] ||
			fail "Exactly one running $service is required before Campaigns switch."
		image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
		image_revision="$(
			docker image inspect \
				--format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
				"$image_id"
		)"
		case "$service" in
		api)
			[[ "$image_revision" == "$previous_revision" ]] ||
				fail "The pre-switch API revision differs from the cutover marker."
			api_image_id="$image_id"
			;;
		api-gateway)
			[[ "$image_revision" == "$previous_revision" ]] ||
				fail "The pre-switch Gateway revision differs from the API revision."
			gateway_image_id="$image_id"
			;;
		outbox-publisher | integration-worker)
			[[ "$image_id" == "$api_image_id" ]] ||
				fail "$service does not use the same pre-switch API image."
			;;
		maintenance-worker)
			maintenance_image_id="$image_id"
			rollback_maintenance_revision="$image_revision"
			;;
		notification-delivery-worker)
			notification_image_id="$image_id"
			rollback_notification_revision="$image_revision"
			;;
		esac
	done
	[[ "$rollback_maintenance_revision" =~ ^[0-9a-f]{40}$ &&
		"$rollback_notification_revision" =~ ^[0-9a-f]{40}$ ]] ||
		fail "Pre-switch standalone service revisions are invalid."
	previous_image_id="$api_image_id"
	previous_gateway_image_id="$gateway_image_id"
	previous_maintenance_image_id="$maintenance_image_id"
	previous_notification_image_id="$notification_image_id"
	container_id="$(compose_target ps --status running -q api-gateway)"
	previous_gateway_routes_json="$(
		container_env_value "$container_id" GATEWAY_ROUTES_JSON
	)"
	[[ -n "$previous_gateway_routes_json" ]] ||
		fail "The live pre-Campaigns Gateway route manifest is missing."
	previous_gateway_routes_base64="$(
		printf '%s' "$previous_gateway_routes_json" | base64 | tr -d '\n'
	)"
	container_id="$(compose_target ps --status running -q integration-worker)"
	integration_worker_kinds="$(
		container_env_value "$container_id" INTEGRATION_WORKER_KINDS
	)"
	mailing_email_rate="$(
		container_env_value "$container_id" MAILING_EMAIL_RATE_PER_SECOND
	)"
	mailing_telegram_rate="$(
		container_env_value "$container_id" MAILING_TELEGRAM_RATE_PER_SECOND
	)"
	[[ ",$integration_worker_kinds," == *",mailing-email,"* &&
		",$integration_worker_kinds," == *",mailing-telegram,"* &&
		"$integration_worker_kinds" =~ ^[a-z0-9,-]+$ &&
		"$mailing_email_rate" =~ ^[0-9]+$ &&
		"$mailing_telegram_rate" =~ ^[0-9]+$ ]] ||
		fail "The live pre-Campaigns integration worker cannot restore the legacy mailing flow."
	docker run --rm --network none --user 0:0 \
		-v "$artifact_directory:/work:rw" \
		-e "INTEGRATION_WORKER_KINDS=$integration_worker_kinds" \
		-e "MAILING_EMAIL_RATE_PER_SECOND=$mailing_email_rate" \
		-e "MAILING_TELEGRAM_RATE_PER_SECOND=$mailing_telegram_rate" \
		--entrypoint node "$CAMPAIGNS_IMAGE" -e '
const fs = require("node:fs");
const environment = {
  INTEGRATION_WORKER_KINDS: process.env.INTEGRATION_WORKER_KINDS,
  MAILING_EMAIL_RATE_PER_SECOND: process.env.MAILING_EMAIL_RATE_PER_SECOND,
  MAILING_TELEGRAM_RATE_PER_SECOND: process.env.MAILING_TELEGRAM_RATE_PER_SECOND,
};
fs.writeFileSync(
  "/work/rollback-compose.json",
  `${JSON.stringify({ services: { "integration-worker": { environment } } })}\n`,
  { mode: 0o600 },
);
'
	chown 0:0 "$artifact_directory/rollback-compose.json"
	chmod 600 "$artifact_directory/rollback-compose.json"
	docker tag "$previous_image_id" "winwidget-api:$rollback_image_tag"
	docker tag "$previous_gateway_image_id" "winwidget-api-gateway:$rollback_image_tag"
	docker tag \
		"$previous_maintenance_image_id" \
		"winwidget-maintenance:$rollback_image_tag"
	docker tag \
		"$previous_notification_image_id" \
		"winwidget-notification-delivery:$rollback_image_tag"
}

restore_pre_switch_runtime() {
	local container_id
	local integration_worker_kinds
	local mailing_email_rate
	local mailing_telegram_rate
	[[ "$forward_only" != "true" ]] || return 0
	[[ "$previous_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$previous_gateway_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$previous_maintenance_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$previous_notification_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$previous_revision" =~ ^[0-9a-f]{40}$ &&
		"$rollback_maintenance_revision" =~ ^[0-9a-f]{40}$ &&
		"$rollback_notification_revision" =~ ^[0-9a-f]{40}$ &&
		-n "$previous_gateway_routes_json" ]] || {
		echo "Recorded pre-switch runtime is incomplete; automatic rollback is unsafe." >&2
		return 1
	}
	echo "Campaigns switch failed before the forward-only boundary; restoring the recorded pre-switch runtime." >&2
	docker image inspect \
		"$previous_image_id" \
		"$previous_gateway_image_id" \
		"$previous_maintenance_image_id" \
		"$previous_notification_image_id" >/dev/null || return 1
	docker tag "$previous_image_id" "winwidget-api:$rollback_image_tag"
	docker tag \
		"$previous_gateway_image_id" \
		"winwidget-api-gateway:$rollback_image_tag"
	docker tag \
		"$previous_maintenance_image_id" \
		"winwidget-maintenance:$rollback_image_tag"
	docker tag \
		"$previous_notification_image_id" \
		"winwidget-notification-delivery:$rollback_image_tag"
	export APP_REVISION="$previous_revision"
	export APP_VERSION="$rollback_image_tag"
	export MAINTENANCE_REVISION="$rollback_maintenance_revision"
	export MAINTENANCE_IMAGE="winwidget-maintenance:$rollback_image_tag"
	export NOTIFICATION_DELIVERY_REVISION="$rollback_notification_revision"
	export NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:$rollback_image_tag"
	export GATEWAY_ROUTES_JSON="$previous_gateway_routes_json"
	compose_target stop campaigns-service >/dev/null 2>&1 || true
	compose_target up -d rabbitmq
	compose_rollback_target up -d --no-deps --no-build --force-recreate \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
		api
	compose_rollback_target up -d --no-deps --no-build --force-recreate api-gateway
	wait_for_url_ready \
		"http://127.0.0.1:4200/api/v1/health/ready" \
		"$previous_revision" || return 1
	wait_for_url_ready \
		"http://127.0.0.1:4100/health/ready" || return 1
	wait_for_url_ready \
		"http://127.0.0.1:4300/health/ready" \
		"$rollback_maintenance_revision" || return 1
	wait_for_url_ready \
		"http://127.0.0.1:4401/health/ready" \
		"$rollback_notification_revision" || return 1
	container_id="$(compose_target ps --status running -q api-gateway)"
	[[ "$(docker inspect --format '{{.Image}}' "$container_id")" == "$previous_gateway_image_id" &&
		"$(docker inspect --format '{{.RestartCount}}' "$container_id")" == "0" &&
		"$(docker image inspect \
			--format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
			"$previous_gateway_image_id")" == "$previous_revision" &&
		"$(container_env_value "$container_id" GATEWAY_ROUTES_JSON)" == "$previous_gateway_routes_json" ]] ||
		return 1
	container_id="$(compose_target ps --status running -q integration-worker)"
	[[ "$(docker inspect --format '{{.Image}}' "$container_id")" == "$previous_image_id" &&
		"$(docker inspect --format '{{.RestartCount}}' "$container_id")" == "0" ]] ||
		return 1
	integration_worker_kinds="$(
		container_env_value "$container_id" INTEGRATION_WORKER_KINDS
	)"
	mailing_email_rate="$(
		container_env_value "$container_id" MAILING_EMAIL_RATE_PER_SECOND
	)"
	mailing_telegram_rate="$(
		container_env_value "$container_id" MAILING_TELEGRAM_RATE_PER_SECOND
	)"
	[[ ",$integration_worker_kinds," == *",mailing-email,"* &&
		",$integration_worker_kinds," == *",mailing-telegram,"* &&
		"$mailing_email_rate" =~ ^[0-9]+$ &&
		"$mailing_telegram_rate" =~ ^[0-9]+$ ]] ||
		return 1
	writes_frozen=false
	switch_started=false
}

on_exit() {
	local status=$?
	local recovery_status=0
	trap - EXIT
	[[ -z "$temporary_marker" ]] || rm -f "$temporary_marker"
	if ((status != 0)); then
		if [[ "$switch_started" == "true" ]]; then
			restore_pre_switch_runtime || recovery_status=$?
		else
			restart_frozen_services || recovery_status=$?
		fi
		if ((recovery_status != 0)); then
			echo "CRITICAL: Campaigns automatic recovery failed; keep the cutover marker and follow the runbook before restarting traffic." >&2
		elif [[ "$marker_phase" == "switching" ]]; then
			echo "Campaigns legacy runtime was restored; rerun prepare or rollback to discard target state recorded during the interrupted switch." >&2
		fi
	fi
	exit "$status"
}
trap on_exit EXIT

to_libpq_url() {
	local value="$1"
	printf '%s' "$value" |
		docker run --rm -i --network none \
			--entrypoint node "$CAMPAIGNS_IMAGE" -e '
const { readFileSync } = require("node:fs");
const url = new URL(readFileSync(0, "utf8"));
for (const key of ["schema", "connection_limit", "pool_timeout", "pgbouncer"]) {
  url.searchParams.delete(key);
}
process.stdout.write(url.toString());
'
}

run_psql() {
	local url="$1"
	shift
	(
		export PGURL="$url"
		docker run --rm -i --user 0:0 --network host \
			-v "$artifact_directory:/work:rw" \
			-e PGURL \
			"$CAMPAIGNS_CANONICAL_POSTGRES_IMAGE" \
			sh -euc 'umask 077; psql --no-psqlrc --set ON_ERROR_STOP=1 "$PGURL" "$@"' sh "$@"
	)
}

dump_and_list() {
	local url="$1"
	local name="$2"
	local schema="${3:-}"
	local -a dump_args=(--format=custom --no-owner --no-acl)
	[[ -z "$schema" ]] || dump_args+=("--schema=$schema")
	(
		export PGURL="$url"
		docker run --rm --user 0:0 --network host \
			-v "$artifact_directory:/work:rw" \
			-e PGURL \
			"$CAMPAIGNS_CANONICAL_POSTGRES_IMAGE" \
			sh -euc '
pg_dump "$@" "$PGURL" --file "/work/'"$name"'.dump"
pg_restore --list "/work/'"$name"'.dump" >"/work/'"$name"'.restore-list"
test -s "/work/'"$name"'.dump"
test -s "/work/'"$name"'.restore-list"
' sh "${dump_args[@]}"
	)
	sha256sum "$artifact_directory/$name.dump" \
		>"$artifact_directory/$name.dump.sha256"
}

database_version_and_size() {
	local url="$1"
	run_psql "$url" --tuples-only --no-align --command "
SELECT
	(current_setting('server_version_num')::integer / 10000) || E'\\t' ||
	pg_database_size(current_database());
"
}

assert_database_versions_and_disk_space() {
	local core_state notification_state target_state legacy_size
	local core_major core_size notification_major notification_size
	local target_major target_size available_kib available_bytes required_bytes
	local campaigns_postgres_id

	core_state="$(database_version_and_size "$core_migration_url")"
	notification_state="$(database_version_and_size "$notification_backup_url")"
	campaigns_postgres_id="$(campaigns_postgres_container_id)"
	target_state="$(
		docker exec "$campaigns_postgres_id" \
			psql --tuples-only --no-align \
				--username "$CAMPAIGNS_CANONICAL_ADMIN_USER" \
				--dbname winwidget_campaigns \
				--command "
SELECT
	(current_setting('server_version_num')::integer / 10000) || E'\\t' ||
	pg_database_size(current_database());
"
	)"
	legacy_size="$(
		run_psql "$core_migration_url" --tuples-only --no-align --command "
SELECT
	COALESCE(pg_total_relation_size(to_regclass('public.mailing_campaigns')), 0) +
	COALESCE(pg_total_relation_size(to_regclass('public.mailing_deliveries')), 0);
"
	)"

	IFS=$'\t' read -r core_major core_size <<<"$core_state"
	IFS=$'\t' read -r notification_major notification_size <<<"$notification_state"
	IFS=$'\t' read -r target_major target_size <<<"$target_state"
	[[ "$core_major" =~ ^[0-9]+$ && "$core_size" =~ ^[0-9]+$ &&
		"$notification_major" =~ ^[0-9]+$ &&
		"$notification_size" =~ ^[0-9]+$ &&
		"$target_major" =~ ^[0-9]+$ && "$target_size" =~ ^[0-9]+$ &&
		"$legacy_size" =~ ^[0-9]+$ ]] ||
		fail "Campaigns cutover could not determine PostgreSQL versions and sizes."
	[[ "$core_major" == "$target_major" &&
		"$notification_major" == "$target_major" &&
		"$target_major" == "18" ]] ||
		fail "Core, Notification Delivery and Campaigns must all use PostgreSQL major 18 for this cutover."

	available_kib="$(
		df -Pk "$artifact_directory" |
			awk 'NR == 2 { print $4 }'
	)"
	[[ "$available_kib" =~ ^[0-9]+$ ]] ||
		fail "Campaigns cutover could not determine free artifact disk space."
	available_bytes=$((available_kib * 1024))
	# The durable workspace retains three Core dumps, one Notification Delivery
	# dump and three Campaigns dumps. The legacy relation estimate receives
	# additional headroom for transformed rows, indexes and restore manifests.
	required_bytes=$(((3 * core_size + notification_size + 6 * legacy_size) * 6 / 5 +
		1073741824))
	((available_bytes >= required_bytes)) ||
		fail "Insufficient disk space for durable Campaigns cutover artifacts: available=$available_bytes required=$required_bytes."
	echo "Campaigns PostgreSQL major versions and durable artifact disk budget are verified."
}

freeze_campaign_writes() {
	writes_frozen=true
	compose_target stop -t 30 \
		api-gateway \
		api \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
			campaigns-service
}

legacy_mailing_queue_names() {
	local base
	for base in winwidget.mailing.email winwidget.mailing.telegram; do
		printf '%s\n' \
			"$base" \
			"$base.dead-letter" \
			"$base.retry-v2.1" \
			"$base.retry-v2.2" \
			"$base.retry-v2.3"
	done
}

is_legacy_mailing_queue() {
	case "$1" in
	winwidget.mailing.email | \
		winwidget.mailing.email.dead-letter | \
		winwidget.mailing.email.retry-v2.1 | \
		winwidget.mailing.email.retry-v2.2 | \
		winwidget.mailing.email.retry-v2.3 | \
		winwidget.mailing.telegram | \
		winwidget.mailing.telegram.dead-letter | \
		winwidget.mailing.telegram.retry-v2.1 | \
		winwidget.mailing.telegram.retry-v2.2 | \
		winwidget.mailing.telegram.retry-v2.3)
		return 0
		;;
	esac
	return 1
}

assert_legacy_mailing_queues_quiescent() {
	local rabbitmq_container="$1"
	local queue ready unacknowledged consumers queue_state
	queue_state="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues \
			-p "$(get_env_value RABBITMQ_VHOST)" \
			name messages_ready messages_unacknowledged consumers
	)" || fail "Could not inspect legacy Campaigns RabbitMQ queues."
	while read -r queue ready unacknowledged consumers; do
		[[ -n "$queue" && "$queue" == winwidget.mailing.* ]] || continue
		is_legacy_mailing_queue "$queue" ||
			fail "Unexpected queue in the legacy Campaigns namespace: $queue"
		[[ "$ready" =~ ^[0-9]+$ &&
			"$unacknowledged" =~ ^[0-9]+$ &&
			"$consumers" =~ ^[0-9]+$ ]] ||
			fail "Legacy Campaigns RabbitMQ queue counters are invalid: $queue"
		[[ "$ready" == "0" &&
			"$unacknowledged" == "0" &&
			"$consumers" == "0" ]] ||
			fail "Legacy Campaigns RabbitMQ queue is not empty and unused: $queue ready=$ready unacknowledged=$unacknowledged consumers=$consumers"
	done <<<"$queue_state"
}

assert_source_quiescent() {
	local source_url="$1"
	local result
	result="$(
		run_psql "$source_url" --tuples-only --no-align --command '
SELECT
	(SELECT count(*) FROM "mailing_campaigns"
	 WHERE "status" IN ('"'"'QUEUED'"'"', '"'"'RUNNING'"'"')) || E'"'"'\t'"'"' ||
	(SELECT count(*) FROM "mailing_deliveries"
	 WHERE "status" IN ('"'"'PENDING'"'"', '"'"'PROCESSING'"'"')) || E'"'"'\t'"'"' ||
	(SELECT count(*) FROM "integration_delivery_receipts"
	 WHERE "integration" IN ('"'"'mailing-email'"'"', '"'"'mailing-telegram'"'"')
	   AND "status" IN ('"'"'PROCESSING'"'"', '"'"'RETRY_SCHEDULED'"'"')) || E'"'"'\t'"'"' ||
	(SELECT count(*) FROM "outbox_events"
	 WHERE ("event_type" LIKE '"'"'mailing.%'"'"' OR "routing_key" LIKE '"'"'mailing.%'"'"')
	   AND "status" IN ('"'"'PENDING'"'"', '"'"'PUBLISHING'"'"', '"'"'FAILED'"'"'));
'
	)"
	[[ "$result" == $'0\t0\t0\t0' ]] ||
		fail "Legacy Campaigns PostgreSQL work is not quiescent: $result"

	local rabbitmq_container
	rabbitmq_container="$(compose_target ps --status running -q rabbitmq)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] ||
		fail "Exactly one running RabbitMQ container is required."
	assert_legacy_mailing_queues_quiescent "$rabbitmq_container"
}

export_source() {
	local source_url="$1"
	local prefix="$2"
	run_psql "$source_url" --tuples-only --no-align --file - <<SQL
\\o /work/${prefix}source-campaigns.b64
SELECT replace(encode(convert_to(jsonb_build_object(
		'id', "id",
		'adminId', "admin_id",
		'idempotencyKey', "idempotency_key",
		'subject', "subject",
		'message', "message",
		'audience', "audience",
		'requestedChannel', "requested_channel",
		'status', "status",
		'recipientCount', "recipient_count",
		'sentCount', "sent_count",
		'failedCount', "failed_count",
		'cancelledCount', "cancelled_count",
		'emailCount', "email_recipient_count",
		'telegramCount', "telegram_recipient_count",
		'startedAt', CASE WHEN "started_at" IS NULL THEN NULL ELSE to_char("started_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
		'completedAt', CASE WHEN "completed_at" IS NULL THEN NULL ELSE to_char("completed_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
		'cancelRequestedAt', CASE WHEN "cancel_requested_at" IS NULL THEN NULL ELSE to_char("cancel_requested_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
		'createdAt', to_char("created_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'updatedAt', to_char("updated_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
	)::text, 'UTF8'), 'base64'), E'\n', '')
	FROM "mailing_campaigns"
	ORDER BY "id";
\\o /work/${prefix}source-deliveries.b64
SELECT replace(encode(convert_to(jsonb_build_object(
		'id', "id",
		'campaignId', "campaign_id",
		'channel', "channel",
		'recipient', "recipient",
		'status', "status",
		'attempts', "attempts",
		'lastError', "last_error",
		'sentAt', CASE WHEN "sent_at" IS NULL THEN NULL ELSE to_char("sent_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
		'cancelledAt', CASE WHEN "cancelled_at" IS NULL THEN NULL ELSE to_char("cancelled_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
		'createdAt', to_char("created_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'updatedAt', to_char("updated_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
	)::text, 'UTF8'), 'base64'), E'\n', '')
	FROM "mailing_deliveries"
	ORDER BY "id";
\\o
SQL
}

transform_source() {
	local prefix="$1"
	docker run --rm -i --user 0:0 --network none \
		-v "$artifact_directory:/work:rw" \
		--entrypoint node "$CAMPAIGNS_IMAGE" - "$prefix" "$cutover_started_at" <<'NODE'
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const prefix = process.argv[2];
const cutover = new Date(process.argv[3]);
const read = name => fs.readFileSync(`/work/${prefix}${name}.b64`, "utf8")
  .trim().split(/\r?\n/).filter(Boolean)
  .map(line => JSON.parse(Buffer.from(line, "base64").toString("utf8")));
const sha = value => createHash("sha256").update(value).digest("hex");
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
  );
};
const canonical = value => JSON.stringify(canonicalize(value));
const uuid = value => {
  const hex = createHash("md5").update(value).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
const normalize = (channel, value) => channel === "EMAIL"
  ? String(value).trim().toLowerCase()
  : String(value).trim();
const campaigns = read("source-campaigns");
const legacyDeliveries = read("source-deliveries");
const deliveriesByCampaign = new Map();
for (const delivery of legacyDeliveries) {
  const list = deliveriesByCampaign.get(delivery.campaignId) || [];
  list.push(delivery);
  deliveriesByCampaign.set(delivery.campaignId, list);
}
const snapshots = [];
const deliveries = [];
const idempotency = [];
const audiences = new Map([
  ["ACTIVE", "ACTIVE_SUBSCRIPTION"],
  ["ACTIVE_SUBSCRIPTION", "ACTIVE_SUBSCRIPTION"],
  ["ALL", "ALL"],
]);
for (const campaign of campaigns) {
  const normalizedAudience = audiences.get(campaign.audience);
  if (!normalizedAudience) {
    throw new Error(`unsupported legacy audience ${campaign.audience} for ${campaign.id}`);
  }
  campaign.audience = normalizedAudience;
  if (["QUEUED", "RUNNING"].includes(campaign.status)) {
    throw new Error(`active legacy campaign ${campaign.id}`);
  }
  campaign.subject = String(campaign.subject).trim();
  campaign.message = String(campaign.message).trim();
  const channels = campaign.requestedChannel === "BOTH"
    ? ["EMAIL", "TELEGRAM"] : [campaign.requestedChannel];
  const campaignDeliveries = deliveriesByCampaign.get(campaign.id) || [];
  for (const channel of channels) {
    const priority = { SENT: 3, FAILED: 2, CANCELLED: 1 };
    const byDestination = new Map();
    for (const item of campaignDeliveries.filter(value => value.channel === channel)) {
      const key = normalize(channel, item.recipient);
      const current = byDestination.get(key);
      if (!current || (priority[item.status] || 0) > (priority[current.status] || 0) ||
          ((priority[item.status] || 0) === (priority[current.status] || 0) &&
           item.id.localeCompare(current.id) < 0)) byDestination.set(key, item);
    }
    const channelDeliveries = [...byDestination.values()];
    const destinations = [...byDestination.keys()].sort();
    const snapshotId = uuid(`legacy-snapshot:${campaign.id}:${channel}`);
    snapshots.push({
      id: snapshotId, sourceSnapshotId: null, campaignId: campaign.id,
      channel, audience: campaign.audience, status: "READY",
      asOf: campaign.createdAt, recipientCount: channelDeliveries.length,
      sha256: sha(destinations.join("\n")), lastError: null,
      completedAt: campaign.completedAt || campaign.updatedAt,
      createdAt: campaign.createdAt, updatedAt: campaign.updatedAt,
    });
    for (const delivery of channelDeliveries) {
      const destination = normalize(channel, delivery.recipient);
      deliveries.push({
        id: delivery.id, campaignId: campaign.id, snapshotId, channel, destination,
        destinationKey: sha(`${channel}\0${destination}`), status: delivery.status,
        dispatchGeneration: 1, attempts: delivery.attempts,
        requestEventId: null, lastOutcomeEventId: null,
        lastErrorCode: delivery.status === "FAILED" ? "LEGACY_DELIVERY_FAILED" : null,
        lastErrorReason: delivery.status === "FAILED"
          ? String(delivery.lastError || "Legacy delivery failed").trim().slice(0, 2000) : null,
        sentAt: delivery.sentAt, cancelledAt: delivery.cancelledAt,
        createdAt: delivery.createdAt, updatedAt: delivery.updatedAt,
      });
    }
  }
  const mapped = deliveries.filter(delivery => delivery.campaignId === campaign.id);
  campaign.recipientCount = mapped.length;
  campaign.sentCount = mapped.filter(delivery => delivery.status === "SENT").length;
  campaign.failedCount = mapped.filter(delivery => delivery.status === "FAILED").length;
  campaign.cancelledCount = mapped.filter(delivery => delivery.status === "CANCELLED").length;
  campaign.emailCount = mapped.filter(delivery => delivery.channel === "EMAIL").length;
  campaign.telegramCount = mapped.filter(delivery => delivery.channel === "TELEGRAM").length;
  const request = JSON.stringify({
    subject: campaign.subject, message: campaign.message,
    audience: campaign.audience, channel: campaign.requestedChannel,
  });
  const created = new Date(campaign.createdAt);
  const expires = new Date(Math.max(
    created.getTime() + 30 * 86400000,
    cutover.getTime() + 30 * 86400000,
  )).toISOString();
  idempotency.push({
    id: uuid(`legacy-idempotency:${campaign.id}`), scope: "CAMPAIGN_CREATE",
    actorId: campaign.adminId, key: campaign.idempotencyKey,
    requestHash: sha(request), resourceType: "campaign",
    resourceId: campaign.id, createdAt: campaign.createdAt, expiresAt: expires,
  });
}
const outputCampaigns = campaigns.map(campaign => ({
  id: campaign.id, actorId: campaign.adminId,
  idempotencyKey: campaign.idempotencyKey, subject: campaign.subject,
  message: campaign.message, audience: campaign.audience,
  requestedChannel: campaign.requestedChannel, status: campaign.status,
  recipientCount: campaign.recipientCount, sentCount: campaign.sentCount,
  failedCount: campaign.failedCount, cancelledCount: campaign.cancelledCount,
  emailCount: campaign.emailCount, telegramCount: campaign.telegramCount,
  startedAt: campaign.startedAt, completedAt: campaign.completedAt,
  cancelRequestedAt: campaign.cancelRequestedAt,
  createdAt: campaign.createdAt, updatedAt: campaign.updatedAt,
}));
const sets = { campaigns: outputCampaigns, snapshots, deliveries, idempotency };
const manifest = [];
for (const [name, values] of Object.entries(sets)) {
  values.sort((a, b) => a.id.localeCompare(b.id));
  const lines = values.map(value => Buffer.from(JSON.stringify(value)).toString("base64"));
  fs.writeFileSync(`/work/${prefix}${name}.b64`, `${lines.join("\n")}${lines.length ? "\n" : ""}`, { mode: 0o600 });
  manifest.push(`${name}\t${values.length}\t${sha(values.map(canonical).join("\n"))}`);
}
const text = `${manifest.join("\n")}\n`;
fs.writeFileSync(`/work/${prefix}source-manifest.txt`, text, { mode: 0o600 });
fs.writeFileSync(`/work/${prefix}source-manifest.sha256`, `${sha(text)}\n`, { mode: 0o600 });
NODE
}

load_target() {
	local target_url="$1"
	run_psql "$target_url" --file - <<'SQL'
DROP TABLE IF EXISTS
	"campaigns"."_cutover_import_campaigns",
	"campaigns"."_cutover_import_snapshots",
	"campaigns"."_cutover_import_deliveries",
	"campaigns"."_cutover_import_idempotency";
CREATE UNLOGGED TABLE "campaigns"."_cutover_import_campaigns" ("raw" TEXT NOT NULL);
CREATE UNLOGGED TABLE "campaigns"."_cutover_import_snapshots" ("raw" TEXT NOT NULL);
CREATE UNLOGGED TABLE "campaigns"."_cutover_import_deliveries" ("raw" TEXT NOT NULL);
CREATE UNLOGGED TABLE "campaigns"."_cutover_import_idempotency" ("raw" TEXT NOT NULL);
REVOKE ALL ON
	"campaigns"."_cutover_import_campaigns",
	"campaigns"."_cutover_import_snapshots",
	"campaigns"."_cutover_import_deliveries",
	"campaigns"."_cutover_import_idempotency"
FROM "winwidget_campaigns_runtime", "winwidget_campaigns_backup";
\copy "campaigns"."_cutover_import_campaigns" FROM '/work/campaigns.b64';
\copy "campaigns"."_cutover_import_snapshots" FROM '/work/snapshots.b64';
\copy "campaigns"."_cutover_import_deliveries" FROM '/work/deliveries.b64';
\copy "campaigns"."_cutover_import_idempotency" FROM '/work/idempotency.b64';
BEGIN;
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "campaigns"."campaigns")
		OR EXISTS (SELECT 1 FROM "campaigns"."audience_snapshots")
		OR EXISTS (SELECT 1 FROM "campaigns"."deliveries")
		OR EXISTS (SELECT 1 FROM "campaigns"."control_actions")
		OR EXISTS (SELECT 1 FROM "campaigns"."outbox_events")
		OR EXISTS (SELECT 1 FROM "campaigns"."consumer_receipts")
		OR EXISTS (SELECT 1 FROM "campaigns"."idempotency_records")
		OR EXISTS (SELECT 1 FROM "campaigns"."rate_limits")
		OR EXISTS (SELECT 1 FROM "campaigns"."heartbeats") THEN
		RAISE EXCEPTION 'Campaigns target is not empty';
	END IF;
END $$;
INSERT INTO "campaigns"."campaigns" (
	"id", "actor_id", "idempotency_key", "subject", "message", "audience",
	"requested_channel", "status", "recipient_count", "sent_count",
	"failed_count", "cancelled_count", "email_count", "telegram_count",
	"started_at", "completed_at", "cancel_requested_at", "created_at", "updated_at"
)
SELECT
	(p->>'id')::uuid, p->>'actorId', (p->>'idempotencyKey')::uuid,
	p->>'subject', p->>'message', (p->>'audience')::"campaigns"."CampaignAudience",
	(p->>'requestedChannel')::"campaigns"."CampaignRequestedChannel",
	(p->>'status')::"campaigns"."CampaignStatus",
	(p->>'recipientCount')::integer, (p->>'sentCount')::integer,
	(p->>'failedCount')::integer, (p->>'cancelledCount')::integer,
	(p->>'emailCount')::integer, (p->>'telegramCount')::integer,
	(p->>'startedAt')::timestamp, (p->>'completedAt')::timestamp,
	(p->>'cancelRequestedAt')::timestamp, (p->>'createdAt')::timestamp,
	(p->>'updatedAt')::timestamp
FROM (
	SELECT convert_from(decode("raw", 'base64'), 'UTF8')::jsonb AS p
	FROM "campaigns"."_cutover_import_campaigns"
) AS source;
INSERT INTO "campaigns"."audience_snapshots" (
	"id", "source_snapshot_id", "campaign_id", "channel", "audience", "status",
	"as_of", "recipient_count", "sha256", "last_error", "completed_at",
	"created_at", "updated_at"
)
SELECT
	(p->>'id')::uuid, NULL, (p->>'campaignId')::uuid,
	(p->>'channel')::"campaigns"."CampaignDeliveryChannel",
	(p->>'audience')::"campaigns"."CampaignAudience",
	(p->>'status')::"campaigns"."AudienceSnapshotStatus",
	(p->>'asOf')::timestamp, (p->>'recipientCount')::integer, p->>'sha256',
	NULL, (p->>'completedAt')::timestamp, (p->>'createdAt')::timestamp,
	(p->>'updatedAt')::timestamp
FROM (
	SELECT convert_from(decode("raw", 'base64'), 'UTF8')::jsonb AS p
	FROM "campaigns"."_cutover_import_snapshots"
) AS source;
INSERT INTO "campaigns"."deliveries" (
	"id", "campaign_id", "snapshot_id", "channel", "destination",
	"destination_key", "status", "dispatch_generation", "attempts",
	"request_event_id", "last_outcome_event_id", "last_error_code",
	"last_error_reason", "sent_at", "cancelled_at", "created_at", "updated_at"
)
SELECT
	(p->>'id')::uuid, (p->>'campaignId')::uuid, (p->>'snapshotId')::uuid,
	(p->>'channel')::"campaigns"."CampaignDeliveryChannel", p->>'destination',
	p->>'destinationKey', (p->>'status')::"campaigns"."CampaignDeliveryStatus",
	(p->>'dispatchGeneration')::integer, (p->>'attempts')::integer,
	NULL, NULL, p->>'lastErrorCode', p->>'lastErrorReason',
	(p->>'sentAt')::timestamp, (p->>'cancelledAt')::timestamp,
	(p->>'createdAt')::timestamp, (p->>'updatedAt')::timestamp
FROM (
	SELECT convert_from(decode("raw", 'base64'), 'UTF8')::jsonb AS p
	FROM "campaigns"."_cutover_import_deliveries"
) AS source;
INSERT INTO "campaigns"."idempotency_records" (
	"id", "scope", "actor_id", "key", "request_hash", "resource_type",
	"resource_id", "created_at", "expires_at"
)
SELECT
	(p->>'id')::uuid, p->>'scope', p->>'actorId', (p->>'key')::uuid,
	p->>'requestHash', p->>'resourceType', (p->>'resourceId')::uuid,
	(p->>'createdAt')::timestamp, (p->>'expiresAt')::timestamp
FROM (
	SELECT convert_from(decode("raw", 'base64'), 'UTF8')::jsonb AS p
	FROM "campaigns"."_cutover_import_idempotency"
) AS source;
COMMIT;
DROP TABLE
	"campaigns"."_cutover_import_campaigns",
	"campaigns"."_cutover_import_snapshots",
	"campaigns"."_cutover_import_deliveries",
	"campaigns"."_cutover_import_idempotency";
SQL
}

export_target() {
	local target_url="$1"
	run_psql "$target_url" --tuples-only --no-align --file - <<'SQL'
\o /work/actual-campaigns.b64
SELECT replace(encode(convert_to(jsonb_build_object(
		'id', "id", 'actorId', "actor_id", 'idempotencyKey', "idempotency_key",
		'subject', "subject", 'message', "message", 'audience', "audience",
		'requestedChannel', "requested_channel", 'status', "status",
		'recipientCount', "recipient_count", 'sentCount', "sent_count",
		'failedCount', "failed_count", 'cancelledCount', "cancelled_count",
		'emailCount', "email_count", 'telegramCount', "telegram_count",
		'startedAt', "started_at", 'completedAt', "completed_at",
		'cancelRequestedAt', "cancel_requested_at", 'createdAt', "created_at",
		'updatedAt', "updated_at"
	)::text, 'UTF8'), 'base64'), E'\n', '')
FROM "campaigns"."campaigns" ORDER BY "id"
;
\o /work/actual-snapshots.b64
SELECT replace(encode(convert_to(jsonb_build_object(
		'id', "id", 'sourceSnapshotId', "source_snapshot_id",
		'campaignId', "campaign_id", 'channel', "channel", 'audience', "audience",
		'status', "status", 'asOf', "as_of", 'recipientCount', "recipient_count",
		'sha256', "sha256", 'lastError', "last_error",
		'completedAt', "completed_at", 'createdAt', "created_at", 'updatedAt', "updated_at"
	)::text, 'UTF8'), 'base64'), E'\n', '')
FROM "campaigns"."audience_snapshots" ORDER BY "id"
;
\o /work/actual-deliveries.b64
SELECT replace(encode(convert_to(jsonb_build_object(
		'id', "id", 'campaignId', "campaign_id", 'snapshotId', "snapshot_id",
		'channel', "channel", 'destination', "destination",
		'destinationKey', "destination_key", 'status', "status",
		'dispatchGeneration', "dispatch_generation", 'attempts', "attempts",
		'requestEventId', "request_event_id", 'lastOutcomeEventId', "last_outcome_event_id",
		'lastErrorCode', "last_error_code", 'lastErrorReason', "last_error_reason",
		'sentAt', "sent_at", 'cancelledAt', "cancelled_at",
		'createdAt', "created_at", 'updatedAt', "updated_at"
	)::text, 'UTF8'), 'base64'), E'\n', '')
FROM "campaigns"."deliveries" ORDER BY "id"
;
\o /work/actual-idempotency.b64
SELECT replace(encode(convert_to(jsonb_build_object(
		'id', "id", 'scope', "scope", 'actorId', "actor_id", 'key', "key",
		'requestHash', "request_hash", 'resourceType', "resource_type",
		'resourceId', "resource_id", 'createdAt', "created_at", 'expiresAt', "expires_at"
	)::text, 'UTF8'), 'base64'), E'\n', '')
FROM "campaigns"."idempotency_records" ORDER BY "id"
;
\o
SQL
}

verify_target() {
	local verification_mode="${1:-subset}"
	docker run --rm -i --user 0:0 --network none \
		-v "$artifact_directory:/work:rw" \
		-e "VERIFY_MODE=$verification_mode" \
		--entrypoint node "$CAMPAIGNS_IMAGE" - <<'NODE'
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const names = ["campaigns", "snapshots", "deliveries", "idempotency"];
const dates = new Set([
  "startedAt", "completedAt", "cancelRequestedAt", "createdAt", "updatedAt",
  "asOf", "sentAt", "cancelledAt", "expiresAt",
]);
const read = path => fs.readFileSync(path, "utf8").trim().split(/\r?\n/)
  .filter(Boolean).map(line => JSON.parse(Buffer.from(line, "base64").toString("utf8")));
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    let item = value[key];
    if (dates.has(key) && item !== null) item = new Date(`${String(item).replace(" ", "T").replace(/\+00$/, "Z")}`).toISOString();
    output[key] = normalize(item);
  }
  return output;
};
const sha = value => createHash("sha256").update(value).digest("hex");
const manifest = [];
for (const name of names) {
  const expected = read(`/work/${name}.b64`).map(normalize);
  const actual = new Map(read(`/work/actual-${name}.b64`).map(value => {
    const normalized = normalize(value);
    return [normalized.id, normalized];
  }));
  if (process.env.VERIFY_MODE === "exact" && actual.size !== expected.length) {
    throw new Error(
      `Campaigns target has unexpected rows dataset=${name} expected=${expected.length} actual=${actual.size}`,
    );
  }
  for (const value of expected) {
    const found = actual.get(value.id);
    if (!found || JSON.stringify(found) !== JSON.stringify(value)) {
      throw new Error(`Campaigns target mismatch dataset=${name} id=${value.id}`);
    }
  }
  manifest.push(`${name}\t${expected.length}\t${sha(expected.map(value => JSON.stringify(value)).join("\n"))}`);
}
const text = `${manifest.join("\n")}\n`;
fs.writeFileSync("/work/target-manifest.txt", text, { mode: 0o600 });
fs.writeFileSync("/work/target-manifest.sha256", `${sha(text)}\n`, { mode: 0o600 });
NODE
	target_manifest_sha256="$(tr -d '[:space:]' <"$artifact_directory/target-manifest.sha256")"
	[[ "$target_manifest_sha256" == "$source_manifest_sha256" ]] ||
		fail "Campaigns source and target manifests differ."
}

target_import_row_count() {
	local target_url="$1"
	run_psql "$target_url" --tuples-only --no-align --command '
SELECT
	(SELECT count(*) FROM "campaigns"."campaigns") +
	(SELECT count(*) FROM "campaigns"."audience_snapshots") +
	(SELECT count(*) FROM "campaigns"."deliveries") +
	(SELECT count(*) FROM "campaigns"."control_actions") +
	(SELECT count(*) FROM "campaigns"."outbox_events") +
	(SELECT count(*) FROM "campaigns"."consumer_receipts") +
	(SELECT count(*) FROM "campaigns"."idempotency_records") +
	(SELECT count(*) FROM "campaigns"."rate_limits") +
	(SELECT count(*) FROM "campaigns"."heartbeats");
'
}

reset_target_import() {
	local target_url="$1"
	run_psql "$target_url" --command '
	TRUNCATE TABLE
		"campaigns"."campaigns",
		"campaigns"."audience_snapshots",
		"campaigns"."deliveries",
		"campaigns"."control_actions",
		"campaigns"."outbox_events",
		"campaigns"."consumer_receipts",
		"campaigns"."idempotency_records",
		"campaigns"."rate_limits",
		"campaigns"."heartbeats"
	RESTART IDENTITY CASCADE;
	'
}

apply_target_acl() {
	local admin_password="$1"
	local target_port="$2"
	local runtime_user="$3"
	local runtime_password="$4"
	local migration_user="$5"
	local migration_password="$6"
	local backup_user="$7"
	local backup_password="$8"
	(
		export PGPASSWORD="$admin_password"
		export RUNTIME_USER="$runtime_user"
		export RUNTIME_PASSWORD="$runtime_password"
		export MIGRATION_USER="$migration_user"
		export MIGRATION_PASSWORD="$migration_password"
		export BACKUP_USER="$backup_user"
		export BACKUP_PASSWORD="$backup_password"
		docker run --rm -i --user 0:0 --network host \
			-e PGPASSWORD \
			-e RUNTIME_USER -e RUNTIME_PASSWORD \
			-e MIGRATION_USER -e MIGRATION_PASSWORD \
			-e BACKUP_USER -e BACKUP_PASSWORD \
			"$CAMPAIGNS_CANONICAL_POSTGRES_IMAGE" sh -euc '
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --host 127.0.0.1 --port "$1" --username winwidget_campaigns_admin \
  --dbname winwidget_campaigns \
  --set runtime_user="$RUNTIME_USER" --set runtime_password="$RUNTIME_PASSWORD" \
  --set migration_user="$MIGRATION_USER" --set migration_password="$MIGRATION_PASSWORD" \
  --set backup_user="$BACKUP_USER" --set backup_password="$BACKUP_PASSWORD"
' sh "$target_port" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'runtime_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'runtime_user') \gexec
SELECT format('CREATE ROLE %I LOGIN', :'migration_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'migration_user') \gexec
SELECT format('CREATE ROLE %I LOGIN', :'backup_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'backup_user') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'runtime_user', :'runtime_password') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'migration_user', :'migration_password') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'backup_user', :'backup_password') \gexec
REVOKE ALL ON DATABASE "winwidget_campaigns" FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'migration_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'backup_user') \gexec
SELECT format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), :'runtime_user') \gexec
SELECT format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), :'backup_user') \gexec
SELECT format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), :'migration_user') \gexec
CREATE SCHEMA IF NOT EXISTS "campaigns";
SELECT format('ALTER SCHEMA campaigns OWNER TO %I', :'migration_user') \gexec
REVOKE ALL ON SCHEMA "campaigns" FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA campaigns TO %I, %I', :'runtime_user', :'backup_user') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA campaigns TO %I', :'runtime_user') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA campaigns TO %I', :'runtime_user') \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA campaigns TO %I', :'backup_user') \gexec
SELECT format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA campaigns TO %I', :'backup_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA campaigns GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'migration_user', :'runtime_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA campaigns GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'migration_user', :'runtime_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA campaigns GRANT SELECT ON TABLES TO %I', :'migration_user', :'backup_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA campaigns GRANT SELECT ON SEQUENCES TO %I', :'migration_user', :'backup_user') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON TABLE campaigns._prisma_migrations FROM %I', :'runtime_user')
WHERE to_regclass('campaigns._prisma_migrations') IS NOT NULL \gexec
SQL
	)
}

verify_target_acl() {
	local target_url="$1"
	local state
	state="$(
		run_psql "$target_url" --tuples-only --no-align --command '
SELECT
	has_database_privilege('"'"'winwidget_campaigns_runtime'"'"', current_database(), '"'"'CREATE'"'"') || '"'"'|'"'"' ||
	has_database_privilege('"'"'winwidget_campaigns_migration'"'"', current_database(), '"'"'CREATE'"'"') || '"'"'|'"'"' ||
	has_database_privilege('"'"'winwidget_campaigns_backup'"'"', current_database(), '"'"'CREATE'"'"') || '"'"'|'"'"' ||
	(
		has_table_privilege('"'"'winwidget_campaigns_runtime'"'"', '"'"'campaigns._prisma_migrations'"'"', '"'"'SELECT'"'"') OR
		has_table_privilege('"'"'winwidget_campaigns_runtime'"'"', '"'"'campaigns._prisma_migrations'"'"', '"'"'INSERT'"'"') OR
		has_table_privilege('"'"'winwidget_campaigns_runtime'"'"', '"'"'campaigns._prisma_migrations'"'"', '"'"'UPDATE'"'"') OR
		has_table_privilege('"'"'winwidget_campaigns_runtime'"'"', '"'"'campaigns._prisma_migrations'"'"', '"'"'DELETE'"'"')
	) || '"'"'|'"'"' ||
	has_table_privilege('"'"'winwidget_campaigns_backup'"'"', '"'"'campaigns._prisma_migrations'"'"', '"'"'SELECT'"'"') || '"'"'|'"'"' ||
	(
		has_table_privilege('"'"'winwidget_campaigns_backup'"'"', '"'"'campaigns._prisma_migrations'"'"', '"'"'INSERT'"'"') OR
		has_table_privilege('"'"'winwidget_campaigns_backup'"'"', '"'"'campaigns._prisma_migrations'"'"', '"'"'UPDATE'"'"') OR
		has_table_privilege('"'"'winwidget_campaigns_backup'"'"', '"'"'campaigns._prisma_migrations'"'"', '"'"'DELETE'"'"')
	) || '"'"'|'"'"' ||
	(
		has_table_privilege('"'"'winwidget_campaigns_runtime'"'"', '"'"'campaigns.campaigns'"'"', '"'"'SELECT'"'"') AND
		has_table_privilege('"'"'winwidget_campaigns_runtime'"'"', '"'"'campaigns.campaigns'"'"', '"'"'INSERT'"'"') AND
		has_table_privilege('"'"'winwidget_campaigns_runtime'"'"', '"'"'campaigns.campaigns'"'"', '"'"'UPDATE'"'"') AND
		has_table_privilege('"'"'winwidget_campaigns_runtime'"'"', '"'"'campaigns.campaigns'"'"', '"'"'DELETE'"'"')
	) || '"'"'|'"'"' ||
	has_table_privilege('"'"'winwidget_campaigns_backup'"'"', '"'"'campaigns.campaigns'"'"', '"'"'SELECT'"'"') || '"'"'|'"'"' ||
	(
		has_table_privilege('"'"'winwidget_campaigns_backup'"'"', '"'"'campaigns.campaigns'"'"', '"'"'INSERT'"'"') OR
		has_table_privilege('"'"'winwidget_campaigns_backup'"'"', '"'"'campaigns.campaigns'"'"', '"'"'UPDATE'"'"') OR
		has_table_privilege('"'"'winwidget_campaigns_backup'"'"', '"'"'campaigns.campaigns'"'"', '"'"'DELETE'"'"')
	) || '"'"'|'"'"' ||
	has_schema_privilege('"'"'winwidget_campaigns_migration'"'"', '"'"'campaigns'"'"', '"'"'CREATE'"'"') || '"'"'|'"'"' ||
	has_schema_privilege('"'"'winwidget_campaigns_runtime'"'"', '"'"'campaigns'"'"', '"'"'CREATE'"'"') || '"'"'|'"'"' ||
	has_schema_privilege('"'"'winwidget_campaigns_backup'"'"', '"'"'campaigns'"'"', '"'"'CREATE'"'"');
'
	)"
	[[ "$state" == \
		"false|false|false|false|true|false|true|true|false|true|false|false" ]] ||
		fail "Campaigns PostgreSQL ACL boundary is invalid: $state"
}

parse_target_url() {
	local key="$1"
	local expected_user="$2"
	local value
	value="$(get_env_value "$key")"
	printf '%s' "$value" |
		docker run --rm -i --network none \
			-e "EXPECTED_USER=$expected_user" \
			-e "EXPECTED_PORT=$(get_env_value CAMPAIGNS_POSTGRES_PORT)" \
			--entrypoint node "$CAMPAIGNS_IMAGE" \
			-e '
const { readFileSync } = require("node:fs");
const url = new URL(readFileSync(0, "utf8"));
const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
if (user !== process.env.EXPECTED_USER || url.hostname !== "127.0.0.1" ||
    url.port !== process.env.EXPECTED_PORT || url.pathname !== "/winwidget_campaigns" ||
    url.searchParams.get("schema") !== "campaigns" || password.length < 16 ||
    /[\0\r\n]/.test(password)) throw new Error("invalid Campaigns database role URL");
process.stdout.write(`${user}\n${Buffer.from(password).toString("base64")}\n`);
'
}

parse_rabbitmq_service_url() {
	local key="$1"
	local value
	value="$(get_env_value "$key")"
	printf '%s' "$value" |
		docker run --rm -i --network none \
			-e "EXPECTED_VHOST=$(get_env_value RABBITMQ_VHOST)" \
			--entrypoint node "$CAMPAIGNS_IMAGE" \
			-e '
const { readFileSync } = require("node:fs");
const url = new URL(readFileSync(0, "utf8"));
const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const vhost = decodeURIComponent(url.pathname.slice(1));
if (url.protocol !== "amqp:" || url.hostname !== "127.0.0.1" ||
    (url.port && url.port !== "5672") || url.search || url.hash ||
    !/^[A-Za-z0-9._-]+$/.test(user) || password.length < 32 ||
    password.startsWith("change_me") || /[\0\r\n]/.test(password) ||
    vhost !== process.env.EXPECTED_VHOST) {
  throw new Error("invalid RabbitMQ service URL");
}
process.stdout.write(`${user}\n${Buffer.from(password).toString("base64")}\n`);
	'
}

validate_campaigns_rabbitmq_identity() {
	local campaigns_credentials campaigns_user key credentials other_user
	campaigns_credentials="$(parse_rabbitmq_service_url RABBITMQ_CAMPAIGNS_URL)"
	campaigns_user="$(sed -n '1p' <<<"$campaigns_credentials")"
	for key in \
		RABBITMQ_PUBLISHER_URL \
		RABBITMQ_INTEGRATION_WORKER_URL \
		RABBITMQ_MAINTENANCE_WORKER_URL \
		RABBITMQ_NOTIFICATION_DELIVERY_URL; do
		credentials="$(parse_rabbitmq_service_url "$key")"
		other_user="$(sed -n '1p' <<<"$credentials")"
		[[ "$campaigns_user" != "$other_user" ]] ||
			fail "Campaigns RabbitMQ user collides with $key."
	done
	for key in RABBITMQ_ADMIN_USER RABBITMQ_MONITOR_USER; do
		other_user="$(get_env_value "$key")"
		[[ "$campaigns_user" != "$other_user" ]] ||
			fail "Campaigns RabbitMQ user collides with $key."
	done
}

provision_cutover_rabbitmq_user() {
	local rabbitmq_container="$1"
	local username="$2"
	local password_base64="$3"
	local configure_pattern="$4"
	local write_pattern="$5"
	local read_pattern="$6"
	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_PASSWORD_BASE64="$password_base64" \
	RABBITMQ_PROVISION_VHOST="$(get_env_value RABBITMQ_VHOST)" \
	RABBITMQ_PROVISION_CONFIGURE="$configure_pattern" \
	RABBITMQ_PROVISION_WRITE="$write_pattern" \
	RABBITMQ_PROVISION_READ="$read_pattern" \
		docker exec \
			-e RABBITMQ_PROVISION_USER \
			-e RABBITMQ_PROVISION_PASSWORD_BASE64 \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_PROVISION_CONFIGURE \
			-e RABBITMQ_PROVISION_WRITE \
			-e RABBITMQ_PROVISION_READ \
			"$rabbitmq_container" sh -euc '
password="$(printf "%s" "$RABBITMQ_PROVISION_PASSWORD_BASE64" | base64 -d)"
if rabbitmqctl --silent list_users | cut -f1 |
	grep -Fqx -- "$RABBITMQ_PROVISION_USER"; then
	rabbitmqctl change_password "$RABBITMQ_PROVISION_USER" "$password"
else
	rabbitmqctl add_user "$RABBITMQ_PROVISION_USER" "$password"
fi
while IFS= read -r other_vhost; do
	if [ "$other_vhost" != "$RABBITMQ_PROVISION_VHOST" ]; then
		rabbitmqctl clear_permissions -p "$other_vhost" "$RABBITMQ_PROVISION_USER"
		rabbitmqctl clear_topic_permissions \
			-p "$other_vhost" "$RABBITMQ_PROVISION_USER"
	fi
done <<EOF
$(rabbitmqctl --silent list_vhosts name)
EOF
rabbitmqctl set_permissions -p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" "$RABBITMQ_PROVISION_CONFIGURE" \
	"$RABBITMQ_PROVISION_WRITE" "$RABBITMQ_PROVISION_READ"
rabbitmqctl set_user_tags "$RABBITMQ_PROVISION_USER"
rabbitmqctl authenticate_user "$RABBITMQ_PROVISION_USER" "$password"
unset password
'
}

assert_campaigns_cutover_shared_rabbitmq_topology() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"$CAMPAIGNS_IMAGE" \
		-e '
const amqp = require("amqplib");
const {
  DEAD_LETTER_EXCHANGE,
  EVENTS_EXCHANGE,
} = require("./dist/src/messaging/campaigns-messaging.constants.js");

(async () => {
  const connection = await amqp.connect(process.env.RABBITMQ_PUBLISHER_URL);
  try {
    const channel = await connection.createConfirmChannel();
    try {
      await channel.assertExchange(EVENTS_EXCHANGE, "topic", {
        durable: true,
      });
      await channel.assertExchange(DEAD_LETTER_EXCHANGE, "topic", {
        durable: true,
      });
    } finally {
      await channel.close();
    }
  } finally {
    await connection.close();
  }
})().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Shared RabbitMQ topology assertion failed"}\n`,
  );
  process.exitCode = 1;
});
'
}

provision_campaigns_cutover_rabbitmq_topic_permissions() {
	local rabbitmq_container="$1"
	local username="$2"
	local vhost
	local events_write_pattern
	local events_read_pattern
	local dead_letter_pattern
	vhost="$(get_env_value RABBITMQ_VHOST)"
	events_write_pattern='^(admin\.audit\.event\.v1|campaign\.snapshot\.requested\.v1|notification\.campaign\.(email|telegram)\.requested\.v2|notification\.delivery\.outcome\.v2)$'
	events_read_pattern='^(campaign\.snapshot\.requested\.v1|notification\.delivery\.outcome\.v2)$'
	dead_letter_pattern='^campaigns\.(snapshot|outcome)\.dead-letter$'
	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_VHOST="$vhost" \
	RABBITMQ_CAMPAIGNS_EVENTS_WRITE="$events_write_pattern" \
	RABBITMQ_CAMPAIGNS_EVENTS_READ="$events_read_pattern" \
	RABBITMQ_CAMPAIGNS_DEAD_LETTER="$dead_letter_pattern" \
		docker exec \
			-e RABBITMQ_PROVISION_USER \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_CAMPAIGNS_EVENTS_WRITE \
			-e RABBITMQ_CAMPAIGNS_EVENTS_READ \
			-e RABBITMQ_CAMPAIGNS_DEAD_LETTER \
			"$rabbitmq_container" sh -euc '
rabbitmqctl clear_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER"
rabbitmqctl set_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"winwidget.events" \
	"$RABBITMQ_CAMPAIGNS_EVENTS_WRITE" \
	"$RABBITMQ_CAMPAIGNS_EVENTS_READ"
rabbitmqctl set_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"winwidget.dead-letter" \
	"$RABBITMQ_CAMPAIGNS_DEAD_LETTER" \
	"$RABBITMQ_CAMPAIGNS_DEAD_LETTER"
'
}

provision_campaigns_cutover_rabbitmq_permissions() {
	local mode="${1:-legacy}"
	local rabbitmq_container
	local campaigns_credentials
	local integration_credentials
	local campaigns_user
	local integration_user
	local integration_read_pattern
	local attempt
	case "$mode" in
	legacy)
		integration_read_pattern='^winwidget\.(lead-integration\.(webhook|bitrix24|amo-crm)|payment\.auto-renewal|payment-notification\.telegram(\.dead-letter|\.retry-v2\.[123])?|mailing\..*|limit-notification\.telegram(\.dead-letter|\.retry-v2\.[123])?|admin\.audit\.campaigns\.v1|report\.daily-summary\.telegram|notification\.(telegram-destination-unavailable|delivery-outcome))(\..*)?$'
		;;
	final)
		integration_read_pattern='^winwidget\.(lead-integration\.(webhook|bitrix24|amo-crm)|payment\.auto-renewal|admin\.audit\.campaigns\.v1|report\.daily-summary\.telegram|notification\.(telegram-destination-unavailable|delivery-outcome))(\..*)?$'
		;;
	*)
		fail "Unknown Campaigns RabbitMQ permission phase: $mode"
		;;
	esac
	rabbitmq_container="$(compose_target ps --status running -q rabbitmq)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] ||
		fail "Exactly one running RabbitMQ container is required for Campaigns provisioning."
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if docker exec "$rabbitmq_container" rabbitmq-diagnostics -q ping \
			>/dev/null 2>&1; then
			break
		fi
		((attempt < HEALTHCHECK_ATTEMPTS)) ||
			fail "RabbitMQ did not become ready for Campaigns provisioning."
		sleep "$HEALTHCHECK_INTERVAL"
	done
	campaigns_credentials="$(parse_rabbitmq_service_url RABBITMQ_CAMPAIGNS_URL)"
	integration_credentials="$(
		parse_rabbitmq_service_url RABBITMQ_INTEGRATION_WORKER_URL
	)"
	campaigns_user="$(sed -n '1p' <<<"$campaigns_credentials")"
	integration_user="$(sed -n '1p' <<<"$integration_credentials")"
	[[ "$campaigns_user" != "$integration_user" ]] ||
		fail "Campaigns and integration worker must use distinct RabbitMQ users."
	assert_campaigns_cutover_shared_rabbitmq_topology
	provision_cutover_rabbitmq_user \
		"$rabbitmq_container" \
		"$campaigns_user" \
		"$(sed -n '2p' <<<"$campaigns_credentials")" \
		'^winwidget\.campaigns(\..*)?$' \
		'^(winwidget\.(events|dead-letter)|winwidget\.campaigns(\..*)?)$' \
		'^(winwidget\.(events|dead-letter)|winwidget\.campaigns(\..*)?)$'
	provision_campaigns_cutover_rabbitmq_topic_permissions \
		"$rabbitmq_container" "$campaigns_user"
	provision_cutover_rabbitmq_user \
		"$rabbitmq_container" \
		"$integration_user" \
		"$(sed -n '2p' <<<"$integration_credentials")" \
		'^$' \
		'^(winwidget\.retry|winwidget\.dead-letter)$' \
		"$integration_read_pattern"
}

verify_campaigns_dark_mode_contracts() {
	local campaigns_container
	campaigns_container="$(
		compose_target ps --status running -q campaigns-service
	)"
	[[ -n "$campaigns_container" &&
		"$campaigns_container" != *$'\n'* ]] ||
		fail "Exactly one running Campaigns container is required for dark-mode probes."
	docker exec -i "$campaigns_container" node - <<'NODE'
const { createHash } = require("node:crypto");

const baseUrl = (process.env.CAMPAIGNS_CORE_INTERNAL_BASE_URL || "").replace(
  /\/$/,
  "",
);
const internalToken = process.env.CAMPAIGNS_INTERNAL_TOKEN || "";
const campaignsPort = process.env.CAMPAIGNS_HEALTH_PORT || "4500";
const timeoutMs = Number(
  process.env.CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS || "300000",
);
if (
  baseUrl !== "http://127.0.0.1:4200" ||
  internalToken.length < 32 ||
  !Number.isInteger(timeoutMs) ||
  timeoutMs < 30000
) {
  throw new Error("Campaigns dark-mode probe configuration is invalid");
}

const verifyAudience = async () => {
  const response = await fetch(
    `${baseUrl}/internal/v1/campaigns/audience-export`,
    {
      method: "POST",
      headers: {
        "x-winwidget-internal-token": internalToken,
        accept: "application/x-ndjson",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        channel: "EMAIL",
        audience: "ALL",
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(`Audience dark probe returned HTTP ${response.status}`);
  }
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/x-ndjson") ||
    !response.body
  ) {
    throw new Error("Audience dark probe returned an invalid stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const hash = createHash("sha256");
  let buffer = "";
  let snapshotId = "";
  let recipients = 0;
  let completed = false;
  const consume = line => {
    if (!line) return;
    if (completed) {
      throw new Error("Audience dark probe returned data after completion");
    }
    const value = JSON.parse(line);
    if (value.type === "snapshot") {
      if (
        snapshotId ||
        value.schemaVersion !== 1 ||
        typeof value.snapshotId !== "string" ||
        value.criteria?.channel !== "EMAIL" ||
        value.criteria?.audience !== "ALL"
      ) {
        throw new Error("Audience dark probe snapshot is invalid");
      }
      snapshotId = value.snapshotId;
      return;
    }
    if (value.type === "recipient") {
      if (!snapshotId || typeof value.destination !== "string") {
        throw new Error("Audience dark probe recipient is invalid");
      }
      hash.update(`EMAIL\0${value.destination}\n`, "utf8");
      recipients += 1;
      return;
    }
    if (
      value.type !== "complete" ||
      !snapshotId ||
      value.snapshotId !== snapshotId ||
      value.totalCount !== recipients ||
      typeof value.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.sha256) ||
      value.sha256 !== hash.digest("hex")
    ) {
      throw new Error("Audience dark probe completion is invalid");
    }
    completed = true;
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffer);
  if (!completed) {
    throw new Error("Audience dark probe did not complete");
  }
};

const verifyFailClosedAuth = async () => {
  const response = await fetch(
    `http://127.0.0.1:${campaignsPort}/api/v1/admin/campaigns`,
    {
      headers: {
        authorization: "Bearer campaigns-dark-probe-invalid",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (response.status !== 401) {
    throw new Error(
      `Campaigns fail-closed auth probe returned HTTP ${response.status}`,
    );
  }
};

Promise.all([verifyAudience(), verifyFailClosedAuth()]).catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Campaigns dark-mode probes failed"}\n`,
  );
  process.exitCode = 1;
});
NODE
	echo "Campaigns dark-mode Auth and audience count/hash contracts are verified."
}

verify_campaigns_rabbitmq_runtime() {
	local campaigns_credentials campaigns_user attempt
	campaigns_credentials="$(parse_rabbitmq_service_url RABBITMQ_CAMPAIGNS_URL)"
	campaigns_user="$(sed -n '1p' <<<"$campaigns_credentials")"
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if docker run --rm --network host \
			--env-file "$ENV_FILE" \
			-e "EXPECTED_CAMPAIGNS_USER=$campaigns_user" \
			--entrypoint node "winwidget-api:$APP_VERSION" -e '
const baseUrl = (process.env.RABBITMQ_MANAGEMENT_URL || "").replace(/\/$/, "");
const vhost = process.env.RABBITMQ_VHOST;
const adminUser = process.env.RABBITMQ_ADMIN_USER;
const adminPassword = process.env.RABBITMQ_ADMIN_PASSWORD;
const expectedUser = process.env.EXPECTED_CAMPAIGNS_USER;
if (!baseUrl || !vhost || !adminUser || !adminPassword || !expectedUser) {
  throw new Error("RabbitMQ ownership verification configuration is incomplete");
}
const authorization = `Basic ${Buffer.from(
  `${adminUser}:${adminPassword}`,
).toString("base64")}`;
const request = async path => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`RabbitMQ Management returned HTTP ${response.status}`);
  }
  return response.json();
};
const run = async () => {
  const permission = await request(
    `/api/permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(expectedUser)}`,
  );
  const expectedPermission = {
    configure: "^winwidget\\.campaigns(\\..*)?$",
    write:
      "^(winwidget\\.(events|dead-letter)|winwidget\\.campaigns(\\..*)?)$",
    read:
      "^(winwidget\\.(events|dead-letter)|winwidget\\.campaigns(\\..*)?)$",
  };
  for (const [key, expected] of Object.entries(expectedPermission)) {
    if (permission?.[key] !== expected) {
      throw new Error(`Campaigns RabbitMQ ${key} permission is invalid`);
    }
  }
  const topicPermissions = await request(
    `/api/topic-permissions/${encodeURIComponent(vhost)}/${encodeURIComponent(expectedUser)}`,
  );
  if (!Array.isArray(topicPermissions) || topicPermissions.length !== 2) {
    throw new Error("Campaigns RabbitMQ topic permissions are incomplete");
  }
  const topics = new Map(
    topicPermissions.map(value => [value.exchange, value]),
  );
  const expectedTopics = {
    "winwidget.events": {
      write:
        "^(admin\\.audit\\.event\\.v1|campaign\\.snapshot\\.requested\\.v1|notification\\.campaign\\.(email|telegram)\\.requested\\.v2|notification\\.delivery\\.outcome\\.v2)$",
      read:
        "^(campaign\\.snapshot\\.requested\\.v1|notification\\.delivery\\.outcome\\.v2)$",
    },
    "winwidget.dead-letter": {
      write: "^campaigns\\.(snapshot|outcome)\\.dead-letter$",
      read: "^campaigns\\.(snapshot|outcome)\\.dead-letter$",
    },
  };
  for (const [exchange, expected] of Object.entries(expectedTopics)) {
    const actual = topics.get(exchange);
    if (
      actual?.write !== expected.write ||
      actual?.read !== expected.read
    ) {
      throw new Error(
        `Campaigns RabbitMQ topic permission is invalid for ${exchange}`,
      );
    }
  }
  const connections = await request("/api/connections");
  if (!Array.isArray(connections)) {
    throw new Error("RabbitMQ connections response is invalid");
  }
  const bySocketName = new Map(
    connections.map(connection => [connection.name, connection]),
  );
  const bases = [
    "winwidget.campaigns.snapshot",
    "winwidget.campaigns.delivery-outcome.v2",
  ];
  for (const base of bases) {
    const state = await request(
      `/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(base)}`,
    );
    const consumers = Array.isArray(state?.consumer_details)
      ? state.consumer_details
      : [];
    if (consumers.length !== 1) {
      throw new Error(`${base} must have exactly one consumer`);
    }
    const socketName = consumers[0]?.channel_details?.connection_name;
    const connection = bySocketName.get(socketName);
    const clientName = connection?.client_properties?.connection_name;
    if (
      connection?.user !== expectedUser ||
      clientName !== "winwidget-campaigns-service"
    ) {
      throw new Error(`${base} has an unexpected consumer owner`);
    }
    for (const queue of [
      `${base}.dead-letter`,
      `${base}.retry.1`,
      `${base}.retry.2`,
      `${base}.retry.3`,
    ]) {
      const parkingState = await request(
        `/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`,
      );
      const parkingConsumers = Array.isArray(parkingState?.consumer_details)
        ? parkingState.consumer_details
        : [];
      if (parkingConsumers.length !== 0) {
        throw new Error(`${queue} must not have consumers`);
      }
    }
  }
};
run().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
' >/dev/null 2>&1; then
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	fail "Campaigns RabbitMQ topology or exact consumer ownership is invalid."
}

rollback_target_queue_names() {
	local base
	for base in \
		winwidget.campaigns.snapshot \
		winwidget.campaigns.delivery-outcome.v2; do
		printf '%s\n' \
			"$base" \
			"$base.dead-letter" \
			"$base.retry.1" \
			"$base.retry.2" \
			"$base.retry.3"
	done
	root_target_queue_names
}

root_target_queue_names() {
	local base
	for base in \
		winwidget.admin.audit.campaigns.v1 \
		winwidget.notification.campaign.email.v2 \
		winwidget.notification.campaign.telegram.v2; do
		printf '%s\n' \
			"$base" \
			"$base.dead-letter" \
			"$base.retry-v2.1" \
			"$base.retry-v2.2" \
			"$base.retry-v2.3"
	done
}

wait_for_root_target_rabbitmq_topology() {
	local rabbitmq_container vhost queue_names required_queue missing
	local attempt
	rabbitmq_container="$(compose_target ps --status running -q rabbitmq)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] ||
		fail "Exactly one running RabbitMQ container is required."
	vhost="$(get_env_value RABBITMQ_VHOST)"
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		queue_names="$(
			docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues \
				-p "$vhost" name
		)" || fail "Could not inspect target RabbitMQ topology."
		missing=""
		while IFS= read -r required_queue; do
			if ! grep -Fxq -- "$required_queue" <<<"$queue_names"; then
				missing+="$required_queue "
			fi
		done < <(root_target_queue_names)
		[[ -z "$missing" ]] && return 0
		((attempt < HEALTHCHECK_ATTEMPTS)) ||
			fail "Root topology owner did not create target queues: $missing"
		sleep "$HEALTHCHECK_INTERVAL"
	done
}

delete_rollback_target_queues() {
	local rabbitmq_container vhost queue_state target_queues
	local queue ready unacknowledged consumers queue_names busy
	local attempt
	rabbitmq_container="$(compose_target ps --status running -q rabbitmq)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] ||
		fail "Exactly one running RabbitMQ container is required."
	vhost="$(get_env_value RABBITMQ_VHOST)"
	target_queues="$(rollback_target_queue_names)"

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		queue_state="$(
			docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues \
				-p "$vhost" \
				name messages_ready messages_unacknowledged consumers
		)" || fail "Could not inspect rollback-owned Campaigns queues."
		busy=""
		while read -r queue ready unacknowledged consumers; do
			grep -Fxq -- "$queue" <<<"$target_queues" || continue
			[[ "$ready" =~ ^[0-9]+$ &&
				"$unacknowledged" =~ ^[0-9]+$ &&
				"$consumers" =~ ^[0-9]+$ ]] ||
				fail "Rollback-owned queue counters are invalid: $queue"
			if [[ "$unacknowledged" != "0" || "$consumers" != "0" ]]; then
				busy+="$queue "
			fi
		done <<<"$queue_state"
		[[ -z "$busy" ]] && break
		((attempt < HEALTHCHECK_ATTEMPTS)) ||
			fail "Rollback-owned queues are still used or have unacknowledged deliveries: $busy"
		sleep "$HEALTHCHECK_INTERVAL"
	done

	queue_names="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues \
			-p "$vhost" name
	)" || fail "Could not list rollback-owned Campaigns queues."
	while IFS= read -r queue; do
		if grep -Fxq -- "$queue" <<<"$queue_names"; then
			docker exec "$rabbitmq_container" rabbitmqctl delete_queue \
				--if-unused -p "$vhost" "$queue"
		fi
	done <<<"$target_queues"
	queue_names="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues \
			-p "$vhost" name
	)" || fail "Could not verify rollback-owned Campaigns queue deletion."
	while IFS= read -r queue; do
		! grep -Fxq -- "$queue" <<<"$queue_names" ||
			fail "Rollback-owned Campaigns queue remains: $queue"
	done <<<"$target_queues"
}

recover_pre_forward_switch() {
	[[ "$marker_phase" == "switching" || "$marker_phase" == "switched" ]] ||
		fail "Campaigns pre-forward recovery requires marker phase=switching|switched."
	[[ "$forward_only" != "true" ]] ||
		fail "Campaigns pre-forward recovery is forbidden after forward-only."

	telegram_audit_decision="pending"
	telegram_audit_reference_sha256="pending"
	restore_drill_reference_sha256="pending"
	if [[ "$marker_phase" == "switched" ]]; then
		write_marker switching retained false
	fi

	switch_started=true
	restore_pre_switch_runtime ||
		fail "Campaigns pre-forward recovery did not restore the recorded runtime."
	delete_rollback_target_queues
	reset_target_import "$campaigns_migration_url"
	load_target "$campaigns_migration_url"
	export_target "$campaigns_migration_url"
	verify_target exact
	activate_target_runtime_environment
	write_marker verified retained false
}

delete_legacy_queues() {
	local rabbitmq_container vhost
	local queue queue_names
	rabbitmq_container="$(compose_target ps --status running -q rabbitmq)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] ||
		fail "Exactly one running RabbitMQ container is required."
	vhost="$(get_env_value RABBITMQ_VHOST)"
	assert_legacy_mailing_queues_quiescent "$rabbitmq_container"
	queue_names="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues \
			-p "$vhost" name
	)" || fail "Could not list legacy Campaigns RabbitMQ queues."
	while IFS= read -r queue; do
		if grep -Fxq -- "$queue" <<<"$queue_names"; then
			docker exec "$rabbitmq_container" rabbitmqctl delete_queue \
				--if-empty --if-unused -p "$vhost" "$queue"
		fi
	done < <(legacy_mailing_queue_names)
	queue_names="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_queues \
			-p "$vhost" name
	)" || fail "Could not verify legacy Campaigns RabbitMQ queue deletion."
	! grep -Eq '^winwidget\.mailing\.' <<<"$queue_names" ||
		fail "Legacy Campaigns RabbitMQ queues remain after exact deletion."
}

[[ "$ACTION" == "prepare" || "$ACTION" == "rollback" ||
	"$ACTION" == "finalize" ]] ||
	fail "Usage: $0 prepare|rollback|finalize"
validate_rehearsal_context
[[ "$(id -u)" == "0" ]] || fail "Campaigns production cutover must run as root."
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
	"$(stat -c '%a' "$ENV_FILE")" == "600" &&
	"$(stat -c '%u:%g' "$ENV_FILE")" == "0:0" ]] ||
	fail "Production env must be a root-owned mode-600 regular file."

EXPECTED_REVISION="${EXPECTED_REVISION:-$(git -C "$server_root" rev-parse HEAD)}"
rollback_image_tag="campaigns-pre-$EXPECTED_REVISION"
[[ "$(git -C "$server_root" rev-parse HEAD)" == "$EXPECTED_REVISION" &&
	"$(git -C "$server_root" branch --show-current)" == "prod" &&
	-z "$(git -C "$server_root" status --porcelain --untracked-files=all)" ]] ||
	fail "Campaigns cutover requires a clean protected prod checkout at EXPECTED_REVISION."
require_campaigns_first_cutover_staged_revision "$EXPECTED_REVISION" ||
	fail "Campaigns cutover requires the exact revision produced by the staged-only prod workflow."

for key in \
	DATABASE_MIGRATION_URL_PRODUCTION DATABASE_BACKUP_URL \
	NOTIFICATION_DELIVERY_BACKUP_URL \
	CAMPAIGNS_DATABASE_URL CAMPAIGNS_MIGRATION_DATABASE_URL CAMPAIGNS_BACKUP_URL \
	CAMPAIGNS_POSTGRES_IMAGE CAMPAIGNS_POSTGRES_PORT \
	CAMPAIGNS_POSTGRES_DATA_VOLUME CAMPAIGNS_POSTGRES_ADMIN_USER \
	CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE CAMPAIGNS_INTERNAL_TOKEN \
	CAMPAIGNS_PROCESS_ROLE CAMPAIGNS_LISTEN_HOST CAMPAIGNS_HEALTH_PORT \
	CAMPAIGNS_CORE_INTERNAL_BASE_URL \
	CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS \
	CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE RABBITMQ_CAMPAIGNS_URL \
	GATEWAY_ROUTES_JSON RABBITMQ_PUBLISHER_URL \
	RABBITMQ_INTEGRATION_WORKER_URL RABBITMQ_MAINTENANCE_WORKER_URL \
	RABBITMQ_NOTIFICATION_DELIVERY_URL RABBITMQ_MANAGEMENT_URL \
	RABBITMQ_ADMIN_USER RABBITMQ_ADMIN_PASSWORD \
	RABBITMQ_MONITOR_USER RABBITMQ_VHOST; do
	require_env_key "$key"
done
campaigns_internal_token="$(get_env_value CAMPAIGNS_INTERNAL_TOKEN)"
[[ ${#campaigns_internal_token} -ge 32 &&
	"$campaigns_internal_token" != "ci_campaigns_internal_token_at_least_32_chars" ]] ||
	fail "CAMPAIGNS_INTERNAL_TOKEN must be a production-only secret of at least 32 characters."
unset campaigns_internal_token
[[ "$(get_env_value CAMPAIGNS_PROCESS_ROLE)" == "all" &&
	"$(get_env_value CAMPAIGNS_LISTEN_HOST)" == "127.0.0.1" &&
	"$(get_env_value CAMPAIGNS_HEALTH_PORT)" == "4500" &&
	"$(get_env_value CAMPAIGNS_CORE_INTERNAL_BASE_URL)" == \
	"http://127.0.0.1:4200" ]] ||
	fail "Campaigns first cutover requires the loopback-only single-VPS all role on ports 4200/4500."
[[ "$(get_env_value CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE)" =~ ^[0-9]+$ &&
	"$(get_env_value CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE)" -ge 1 &&
	"$(get_env_value CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE)" -le 5000 ]] ||
	fail "CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE must be between 1 and 5000."
[[ "$(get_env_value CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS)" =~ ^[0-9]+$ &&
	"$(get_env_value CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS)" -ge 30000 &&
	"$(get_env_value CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS)" -le 900000 ]] ||
	fail "CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS must be between 30000 and 900000."
[[ "$(get_env_value CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE)" =~ ^[0-9]+$ &&
	"$(get_env_value CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE)" -ge 1 &&
	"$(get_env_value CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE)" -le 5000 ]] ||
	fail "CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE must be between 1 and 5000."

activate_target_runtime_environment

contract_migration_sha256="$(campaigns_contract_migration_checksum)"
assert_campaigns_database_postgres_identity

compose_target \
	--profile campaigns-database \
	--profile campaigns-migration \
	config --quiet
if [[ ! -e "$CAMPAIGNS_DATABASE_CUTOVER_MARKER" &&
	! -L "$CAMPAIGNS_DATABASE_CUTOVER_MARKER" ]]; then
	compose_target build \
		api api-gateway maintenance-worker notification-delivery-worker campaigns-service
else
	echo "Campaigns cutover marker exists; reusing the reviewed revision images without rebuilding mutable tags."
fi
target_api_image_id="$(
	resolve_reviewed_image_id "winwidget-api:$APP_VERSION" "$EXPECTED_REVISION" "Core API"
)"
target_gateway_image_id="$(
	resolve_reviewed_image_id \
		"winwidget-api-gateway:$APP_VERSION" "$EXPECTED_REVISION" "API Gateway"
)"
target_maintenance_image_id="$(
	resolve_reviewed_image_id \
		"$MAINTENANCE_IMAGE" "$EXPECTED_REVISION" "Maintenance"
)"
target_notification_image_id="$(
	resolve_reviewed_image_id \
		"$NOTIFICATION_DELIVERY_IMAGE" "$EXPECTED_REVISION" "Notification Delivery"
)"
target_campaigns_image_id="$(
	resolve_reviewed_image_id "$CAMPAIGNS_IMAGE" "$EXPECTED_REVISION" "Campaigns"
)"
verify_campaigns_image_artifact
validate_campaigns_gateway_manifest "$(get_env_value GATEWAY_ROUTES_JSON)"
validate_campaigns_rabbitmq_identity

if [[ -e "$CAMPAIGNS_DATABASE_CUTOVER_MARKER" ||
	-L "$CAMPAIGNS_DATABASE_CUTOVER_MARKER" ]]; then
	reviewed_target_api_image_id="$target_api_image_id"
	reviewed_target_gateway_image_id="$target_gateway_image_id"
	reviewed_target_maintenance_image_id="$target_maintenance_image_id"
	reviewed_target_notification_image_id="$target_notification_image_id"
	reviewed_target_campaigns_image_id="$target_campaigns_image_id"
	load_marker
	[[ "$(campaigns_database_marker_value revision)" == "$EXPECTED_REVISION" ]] ||
		fail "Campaigns cutover must resume with the exact revision recorded in the marker."
	[[ "$contract_migration_sha256" == "$(campaigns_database_marker_value contract_migration_sha256)" ]] ||
		fail "Campaigns contract migration changed after cutover started."
	[[ "$target_api_image_id" == "$reviewed_target_api_image_id" &&
		"$target_gateway_image_id" == "$reviewed_target_gateway_image_id" &&
		"$target_maintenance_image_id" == "$reviewed_target_maintenance_image_id" &&
		"$target_notification_image_id" == "$reviewed_target_notification_image_id" &&
		"$target_campaigns_image_id" == "$reviewed_target_campaigns_image_id" ]] ||
		fail "Campaigns reviewed target image identity changed after cutover started."
	if phase_at_least forward-only; then
		forward_only=true
	fi
	if phase_at_least target-created; then
		compose_target --profile campaigns-database up -d campaigns-postgres
		for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
			if verify_campaigns_postgres_container \
				"" "$postgres_image_id" "$postgres_system_identifier"; then
				break
			fi
			((attempt < HEALTHCHECK_ATTEMPTS)) ||
				fail "Campaigns PostgreSQL differs from the durable cutover marker."
			sleep "$HEALTHCHECK_INTERVAL"
		done
	fi
else
	[[ "$ACTION" == "prepare" ]] ||
		fail "Campaigns rollback/finalize requires an existing cutover marker."
	cutover_started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	artifact_directory="$APP_ROOT/deploy/backend/campaigns-database-cutover.$EXPECTED_REVISION.$(date -u +'%Y%m%dT%H%M%SZ')"
	mkdir -m 700 "$artifact_directory"
	chown 0:0 "$artifact_directory"
	current_api="$(compose_target ps --status running -q api 2>/dev/null || true)"
	if [[ -n "$current_api" && "$current_api" != *$'\n'* ]]; then
		previous_image_id="$(docker inspect --format '{{.Image}}' "$current_api")"
		previous_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$previous_image_id")"
	fi
	write_marker preflight retained
fi

core_migration_url="$(to_libpq_url "$(get_env_value DATABASE_MIGRATION_URL_PRODUCTION)")"
core_backup_url="$(to_libpq_url "$(get_env_value DATABASE_BACKUP_URL)")"
notification_backup_url="$(to_libpq_url "$(get_env_value NOTIFICATION_DELIVERY_BACKUP_URL)")"
campaigns_migration_url="$(to_libpq_url "$(get_env_value CAMPAIGNS_MIGRATION_DATABASE_URL)")"
campaigns_backup_url="$(to_libpq_url "$(get_env_value CAMPAIGNS_BACKUP_URL)")"

if [[ "$ACTION" == "rollback" ]]; then
	[[ ("$marker_phase" == "switching" || "$marker_phase" == "switched") &&
		"$forward_only" != "true" ]] ||
		fail "Campaigns rollback is allowed only from switching|switched before forward-only."
	recover_pre_forward_switch
	echo "Campaigns route and runtime rolled back before the forward-only boundary; the target volume was preserved, post-switch test state/queues were discarded, the verified import was restored and prior audit/restore evidence was invalidated."
	exit 0
fi

if [[ "$ACTION" == "prepare" ]]; then
	[[ "$marker_phase" != "forward-only" &&
		"$marker_phase" != "source-dropped" &&
		"$marker_phase" != "complete" ]] ||
		fail "Campaigns prepare cannot run after the forward-only boundary."
	if [[ "$marker_phase" == "switching" ]]; then
		echo "Campaigns interrupted switch detected; restoring the exact verified import before retry."
		recover_pre_forward_switch
		rehearsal_checkpoint switch-recovered
	fi
	if [[ "$marker_phase" == "switched" ]]; then
		wait_for_url "http://127.0.0.1:4500/health/ready" "Campaigns" "$EXPECTED_REVISION"
		wait_for_url "http://127.0.0.1:4100/health/ready" "API Gateway"
		verify_live_service_image campaigns-service "$target_campaigns_image_id" "$EXPECTED_REVISION"
		verify_campaigns_dark_mode_contracts
		verify_campaigns_rabbitmq_runtime
		verify_live_campaigns_gateway
		echo "Campaigns cutover is already switched; production-destructive finalize remains separate."
		exit 0
	fi

	if [[ "$marker_phase" == "preflight" ]]; then
		if ! docker volume inspect "$CAMPAIGNS_CANONICAL_POSTGRES_VOLUME" >/dev/null 2>&1; then
			volume_labels=(
				--label com.winwidget.owner=campaigns
				--label com.winwidget.purpose=postgres-data
				--label "com.winwidget.cutover.revision=$EXPECTED_REVISION"
				--label "com.winwidget.cutover.started-at=$cutover_started_at"
			)
			if [[ "${CAMPAIGNS_CUTOVER_REHEARSAL:-}" == "true" ]]; then
				volume_labels+=(
					--label "com.winwidget.rehearsal=$CAMPAIGNS_CUTOVER_REHEARSAL_RUN_ID"
					--label "com.winwidget.rehearsal.app-root=$APP_ROOT"
					--label "com.winwidget.rehearsal.config-file=$COMPOSE_FILE"
					--label "com.winwidget.rehearsal.working-dir=$(dirname -- "$COMPOSE_FILE")"
				)
			fi
			docker volume create \
				"${volume_labels[@]}" \
				"$CAMPAIGNS_CANONICAL_POSTGRES_VOLUME" >/dev/null
		else
			volume_cutover_identity="$(
				docker volume inspect "$CAMPAIGNS_CANONICAL_POSTGRES_VOLUME" \
					--format '{{printf "%s|%s|%s|%s" (index .Labels "com.winwidget.owner") (index .Labels "com.winwidget.purpose") (index .Labels "com.winwidget.cutover.revision") (index .Labels "com.winwidget.cutover.started-at")}}'
			)"
			[[ "$volume_cutover_identity" == "campaigns|postgres-data|$EXPECTED_REVISION|$cutover_started_at" ]] ||
				fail "Existing Campaigns PostgreSQL volume does not belong to this exact cutover attempt."
		fi
		compose_target --profile campaigns-database up -d campaigns-postgres
		for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
			if verify_campaigns_postgres_container; then break; fi
			((attempt < HEALTHCHECK_ATTEMPTS)) ||
				fail "Campaigns PostgreSQL did not pass identity/readiness checks."
			sleep "$HEALTHCHECK_INTERVAL"
		done
		campaigns_postgres_id="$(campaigns_postgres_container_id)"
		postgres_image_id="$(docker inspect --format '{{.Image}}' "$campaigns_postgres_id")"
		postgres_system_identifier="$(campaigns_postgres_system_identifier "$campaigns_postgres_id")"
		write_marker target-created retained
	fi

	if [[ "$marker_phase" != "preflight" ]]; then
		assert_database_versions_and_disk_space
	fi

	if [[ "$marker_phase" == "target-created" ]]; then
		runtime_credentials="$(parse_target_url CAMPAIGNS_DATABASE_URL winwidget_campaigns_runtime)"
		migration_credentials="$(parse_target_url CAMPAIGNS_MIGRATION_DATABASE_URL winwidget_campaigns_migration)"
		backup_credentials="$(parse_target_url CAMPAIGNS_BACKUP_URL winwidget_campaigns_backup)"
		runtime_user="$(sed -n '1p' <<<"$runtime_credentials")"
		runtime_password="$(sed -n '2p' <<<"$runtime_credentials" | base64 --decode)"
		migration_user="$(sed -n '1p' <<<"$migration_credentials")"
		migration_password="$(sed -n '2p' <<<"$migration_credentials" | base64 --decode)"
		backup_user="$(sed -n '1p' <<<"$backup_credentials")"
		backup_password="$(sed -n '2p' <<<"$backup_credentials" | base64 --decode)"
		admin_password="$(<"$(get_env_value CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE)")"
		apply_target_acl \
			"$admin_password" "$(get_env_value CAMPAIGNS_POSTGRES_PORT)" \
			"$runtime_user" "$runtime_password" \
			"$migration_user" "$migration_password" \
			"$backup_user" "$backup_password"
		unset admin_password runtime_password migration_password backup_password
		write_marker roles-ready retained
	fi

	if [[ "$marker_phase" == "roles-ready" ]]; then
		runtime_credentials="$(parse_target_url CAMPAIGNS_DATABASE_URL winwidget_campaigns_runtime)"
		migration_credentials="$(parse_target_url CAMPAIGNS_MIGRATION_DATABASE_URL winwidget_campaigns_migration)"
		backup_credentials="$(parse_target_url CAMPAIGNS_BACKUP_URL winwidget_campaigns_backup)"
		runtime_user="$(sed -n '1p' <<<"$runtime_credentials")"
		migration_user="$(sed -n '1p' <<<"$migration_credentials")"
		backup_user="$(sed -n '1p' <<<"$backup_credentials")"
		compose_target --profile campaigns-migration run --rm --no-deps campaigns-migrate
		apply_target_acl \
			"$(<"$(get_env_value CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE)")" \
			"$(get_env_value CAMPAIGNS_POSTGRES_PORT)" \
			"$runtime_user" "$(sed -n '2p' <<<"$runtime_credentials" | base64 --decode)" \
			"$migration_user" "$(sed -n '2p' <<<"$migration_credentials" | base64 --decode)" \
			"$backup_user" "$(sed -n '2p' <<<"$backup_credentials" | base64 --decode)"
		verify_target_acl "$campaigns_migration_url"
		verify_campaigns_database_access_boundaries
		write_marker migrated retained
	fi

	if [[ "$marker_phase" == "migrated" ]]; then
		capture_pre_switch_runtime
		write_marker migrated retained
		freeze_campaign_writes
		assert_source_quiescent "$core_migration_url"
		write_marker source-frozen retained
	fi

	if [[ "$marker_phase" == "source-frozen" ||
		"$marker_phase" == "importing" ||
		"$marker_phase" == "copied" ||
		"$marker_phase" == "verified" ]]; then
		[[ "$writes_frozen" == "true" ]] || freeze_campaign_writes
		assert_source_quiescent "$core_migration_url"
		dump_and_list "$core_backup_url" core-pre-cutover
		dump_and_list "$notification_backup_url" notification-delivery-pre-cutover

		resume_phase="$marker_phase"
		if [[ "$resume_phase" == "copied" || "$resume_phase" == "verified" ]]; then
			export_target "$campaigns_migration_url"
			verify_target exact
			export_source "$core_migration_url" "recheck-"
			transform_source "recheck-"
			rechecked_manifest="$(
				tr -d '[:space:]' \
					<"$artifact_directory/recheck-source-manifest.sha256"
			)"
			if [[ "$rechecked_manifest" != "$source_manifest_sha256" ]]; then
				for artifact in \
					campaigns.b64 snapshots.b64 deliveries.b64 idempotency.b64 \
					source-manifest.txt source-manifest.sha256; do
					cp -- \
						"$artifact_directory/recheck-$artifact" \
						"$artifact_directory/$artifact"
				done
				source_manifest_sha256="$rechecked_manifest"
				target_manifest_sha256="pending"
				write_marker importing retained
				reset_target_import "$campaigns_migration_url"
				load_target "$campaigns_migration_url"
			fi
		else
			export_source "$core_migration_url" ""
			transform_source ""
			source_manifest_sha256="$(
				tr -d '[:space:]' <"$artifact_directory/source-manifest.sha256"
			)"
			target_import_rows="$(target_import_row_count "$campaigns_migration_url")"
			[[ "$target_import_rows" =~ ^[0-9]+$ ]] ||
				fail "Campaigns target row count is invalid: $target_import_rows"
			if [[ "$resume_phase" == "source-frozen" ]]; then
				((target_import_rows == 0)) ||
					fail "Campaigns target was non-empty before the durable importing phase."
				target_manifest_sha256="pending"
				write_marker importing retained
			else
				target_manifest_sha256="pending"
				write_marker importing retained
				if ((target_import_rows > 0)); then
					reset_target_import "$campaigns_migration_url"
				fi
			fi
			load_target "$campaigns_migration_url"
		fi

		export_target "$campaigns_migration_url"
		verify_target exact
		dump_and_list "$campaigns_backup_url" campaigns-verified campaigns
		write_marker copied retained
		write_marker verified retained
	fi

	[[ "$marker_phase" == "verified" ]] ||
		fail "Campaigns prepare could not reach the verified phase."

	((switch_generation += 1))
	telegram_audit_decision="pending"
	telegram_audit_reference_sha256="pending"
	restore_drill_reference_sha256="pending"
	write_marker switching retained false
	rehearsal_checkpoint switching
	switch_started=true
	compose_target up -d rabbitmq
	provision_campaigns_cutover_rabbitmq_permissions
	compose_target up -d --no-deps --no-build --force-recreate outbox-publisher
	wait_for_root_target_rabbitmq_topology
	verify_live_service_image \
		outbox-publisher "$target_api_image_id" "$EXPECTED_REVISION"
	compose_target up -d --no-deps --no-build --force-recreate \
		integration-worker maintenance-worker \
		notification-delivery-worker api campaigns-service
	writes_frozen=false
	rehearsal_checkpoint switch-runtime-started
	wait_for_url "http://127.0.0.1:4200/api/v1/health/ready" "Core API" "$EXPECTED_REVISION"
	wait_for_url "http://127.0.0.1:4401/health/ready" "Notification Delivery" "$EXPECTED_REVISION"
	wait_for_url "http://127.0.0.1:4500/health/ready" "Campaigns" "$EXPECTED_REVISION"
	verify_live_service_image api "$target_api_image_id" "$EXPECTED_REVISION"
	verify_live_service_image outbox-publisher "$target_api_image_id" "$EXPECTED_REVISION"
	verify_live_service_image integration-worker "$target_api_image_id" "$EXPECTED_REVISION"
	verify_live_service_image maintenance-worker "$target_maintenance_image_id" "$EXPECTED_REVISION"
	verify_live_service_image \
		notification-delivery-worker "$target_notification_image_id" "$EXPECTED_REVISION"
	verify_live_service_image \
		campaigns-service "$target_campaigns_image_id" "$EXPECTED_REVISION"
	verify_campaigns_dark_mode_contracts
	verify_campaigns_rabbitmq_runtime

	compose_target up -d --no-deps --no-build --force-recreate api-gateway
	wait_for_url "http://127.0.0.1:4100/health/ready" "API Gateway"
	verify_live_campaigns_gateway
	rehearsal_gateway_write_before_failure
	rehearsal_checkpoint gateway-exposed
	write_marker switched retained false
	switch_started=false
	rehearsal_checkpoint switched
	echo "Campaigns database copied and coordinated route switched."
	echo "Complete production smoke, Telegram backup restore drill and audit decision before finalize."
	exit 0
fi

if [[ "$marker_phase" == "complete" ]]; then
	wait_for_url "http://127.0.0.1:4500/health/ready" "Campaigns" "$EXPECTED_REVISION"
	wait_for_url "http://127.0.0.1:4100/health/ready" "API Gateway"
	verify_live_campaigns_gateway
	echo "Campaigns production-destructive finalize is already complete."
	exit 0
fi
[[ "$marker_phase" == "switched" ||
	"$marker_phase" == "forward-only" ||
	"$marker_phase" == "source-dropped" ]] ||
	fail "Campaigns finalize requires marker phase=switched|forward-only|source-dropped."
require_env_key CAMPAIGNS_TELEGRAM_AUDIT_DECISION
require_env_key CAMPAIGNS_TELEGRAM_AUDIT_REFERENCE
require_env_key CAMPAIGNS_RESTORE_DRILL_REFERENCE
telegram_audit_decision="$(get_env_value CAMPAIGNS_TELEGRAM_AUDIT_DECISION)"
[[ "$telegram_audit_decision" == "completed" ]] ||
	fail "Telegram-channel audit must be completed; waiver and automated reactivation are forbidden."
telegram_audit_reference="$(get_env_value CAMPAIGNS_TELEGRAM_AUDIT_REFERENCE)"
restore_drill_reference="$(get_env_value CAMPAIGNS_RESTORE_DRILL_REFERENCE)"
evidence_prefix="switch-generation:${switch_generation}:"
telegram_audit_reference_body="${telegram_audit_reference#"$evidence_prefix"}"
restore_drill_reference_body="${restore_drill_reference#"$evidence_prefix"}"
telegram_audit_manifest_sha256="${telegram_audit_reference_body##*@sha256:}"
restore_drill_sha256="${restore_drill_reference_body##*@sha256:}"
telegram_audit_manifest_path="${telegram_audit_reference_body%@sha256:*}"
telegram_audit_artifact_directory="$(dirname "$telegram_audit_manifest_path")"
[[ "$telegram_audit_reference" == "$evidence_prefix"* &&
	"$telegram_audit_reference_body" == \
	"$APP_ROOT"/deploy/backend/campaigns-telegram-audit.*/SHA256SUMS@sha256:* &&
	"$telegram_audit_manifest_sha256" =~ ^[0-9a-f]{64}$ &&
	-f "$telegram_audit_manifest_path" &&
	! -L "$telegram_audit_manifest_path" &&
	"$(stat -c '%u:%a' "$telegram_audit_manifest_path")" == "0:600" &&
	-d "$telegram_audit_artifact_directory" &&
	! -L "$telegram_audit_artifact_directory" &&
	"$(stat -c '%u:%a' "$telegram_audit_artifact_directory")" == "0:700" &&
	"$restore_drill_reference" == "$evidence_prefix"* &&
	"$restore_drill_reference_body" == ?*@sha256:* &&
	"$restore_drill_sha256" =~ ^[0-9a-f]{64}$ ]] ||
	fail "Telegram audit and restore drill evidence must belong to the current Campaigns switch generation."
[[ "$(sha256sum "$telegram_audit_manifest_path" | awk '{ print $1 }')" == \
	"$telegram_audit_manifest_sha256" ]] ||
	fail "Telegram audit manifest fingerprint does not match its reference."
(
	cd "$telegram_audit_artifact_directory"
	sha256sum --check SHA256SUMS >/dev/null
) || fail "Telegram audit artifact checksums are invalid."
telegram_audit_reference_sha256="$(hash_text "$telegram_audit_reference")"
restore_drill_reference_sha256="$(hash_text "$restore_drill_reference")"

if phase_at_least forward-only; then
	recorded_audit_decision="$(
		campaigns_database_marker_value telegram_audit_decision
	)"
	recorded_audit_reference_sha256="$(
		campaigns_database_marker_value telegram_audit_reference_sha256
	)"
	recorded_restore_drill_reference_sha256="$(
		campaigns_database_marker_value restore_drill_reference_sha256
	)"
	[[ "$telegram_audit_decision" == "$recorded_audit_decision" &&
		"$telegram_audit_reference_sha256" == "$recorded_audit_reference_sha256" &&
		"$restore_drill_reference_sha256" == "$recorded_restore_drill_reference_sha256" ]] ||
		fail "Campaigns finalize evidence differs from the durable forward-only marker."
fi

freeze_campaign_writes

if [[ "$marker_phase" == "switched" ]]; then
	assert_source_quiescent "$core_migration_url"
	export_source "$core_migration_url" "recheck-"
	transform_source "recheck-"
	[[ "$(tr -d '[:space:]' <"$artifact_directory/recheck-source-manifest.sha256")" == "$source_manifest_sha256" ]] ||
		fail "Legacy Campaigns source changed after the verified copy."
	export_target "$campaigns_migration_url"
	verify_target subset
	dump_and_list "$core_backup_url" core-forward-boundary
	dump_and_list "$campaigns_backup_url" campaigns-forward-boundary campaigns
	assert_campaigns_contract_migration_clean_pending

	forward_only=true
	write_marker forward-only retained
fi

if [[ "$marker_phase" == "forward-only" ]]; then
	expected_contract_checksum="$(campaigns_contract_migration_checksum)"
	contract_state="$(campaigns_contract_migration_state)"
	case "$contract_state" in
	pending)
		guarded_migration_url="$(
			printf '%s' "$(get_env_value DATABASE_MIGRATION_URL_PRODUCTION)" |
				docker run --rm -i --network none \
					-e "SOURCE_MANIFEST=$source_manifest_sha256" \
					-e "AUDIT_DECISION=$telegram_audit_decision" \
					-e "AUDIT_REFERENCE=$telegram_audit_reference_sha256" \
					--entrypoint node "winwidget-api:$APP_VERSION" -e '
const { readFileSync } = require("node:fs");
const url = new URL(readFileSync(0, "utf8"));
url.searchParams.set("options", [
  "-c winwidget.campaigns_contract_cutover=production-destructive-approved",
  "-c winwidget.campaigns_forward_boundary=forward-only",
  `-c winwidget.campaigns_source_manifest_sha256=${process.env.SOURCE_MANIFEST}`,
  `-c winwidget.campaigns_telegram_audit_decision=${process.env.AUDIT_DECISION}`,
  `-c winwidget.campaigns_telegram_audit_reference=${process.env.AUDIT_REFERENCE}`,
].join(" "));
process.stdout.write(url.toString());
'
		)"
		(
			export DATABASE_URL="$guarded_migration_url"
			docker run --rm --network host \
				-e DATABASE_URL \
				--entrypoint ./node_modules/.bin/prisma \
				"$target_api_image_id" migrate deploy
		)
		unset guarded_migration_url
		;;
	"applied:$expected_contract_checksum")
		echo "Campaigns contract migration is already applied; resuming forward recovery."
		;;
	*)
		fail "Campaigns forward recovery requires manual migration review; state=$contract_state"
		;;
	esac
	contract_state="$(campaigns_contract_migration_state)"
	[[ "$contract_state" == "applied:$expected_contract_checksum" ]] ||
		fail "Campaigns contract migration did not finish with the reviewed checksum."

	delete_legacy_queues
	provision_campaigns_cutover_rabbitmq_permissions final
	write_marker source-dropped dropped
fi

[[ "$marker_phase" == "source-dropped" ]] ||
	fail "Campaigns forward recovery did not reach source-dropped."
delete_legacy_queues
provision_campaigns_cutover_rabbitmq_permissions final
dump_and_list "$core_backup_url" core-post-cutover
dump_and_list "$campaigns_backup_url" campaigns-post-cutover campaigns
compose_target up -d rabbitmq
compose_target up -d --no-deps --no-build --force-recreate \
	outbox-publisher integration-worker maintenance-worker \
	notification-delivery-worker campaigns-service api
compose_target up -d --no-deps --no-build --force-recreate api-gateway
writes_frozen=false
wait_for_url "http://127.0.0.1:4200/api/v1/health/ready" "Core API" "$EXPECTED_REVISION"
wait_for_url "http://127.0.0.1:4300/health/ready" "Maintenance" "$EXPECTED_REVISION"
wait_for_url "http://127.0.0.1:4401/health/ready" "Notification Delivery" "$EXPECTED_REVISION"
wait_for_url "http://127.0.0.1:4500/health/ready" "Campaigns" "$EXPECTED_REVISION"
verify_live_service_image api "$target_api_image_id" "$EXPECTED_REVISION"
verify_live_service_image outbox-publisher "$target_api_image_id" "$EXPECTED_REVISION"
verify_live_service_image integration-worker "$target_api_image_id" "$EXPECTED_REVISION"
verify_live_service_image maintenance-worker "$target_maintenance_image_id" "$EXPECTED_REVISION"
verify_live_service_image \
	notification-delivery-worker "$target_notification_image_id" "$EXPECTED_REVISION"
verify_live_service_image campaigns-service "$target_campaigns_image_id" "$EXPECTED_REVISION"
verify_campaigns_rabbitmq_runtime
wait_for_url "http://127.0.0.1:4100/health/ready" "API Gateway"
verify_live_campaigns_gateway
write_marker complete dropped
echo "Campaigns production-destructive finalize completed at revision $EXPECTED_REVISION."
