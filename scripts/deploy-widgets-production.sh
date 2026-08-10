#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
HEALTHCHECK_ATTEMPTS="${WIDGETS_HEALTHCHECK_ATTEMPTS:-60}"
HEALTHCHECK_INTERVAL="${WIDGETS_HEALTHCHECK_INTERVAL:-2}"
server_root="$APP_ROOT/winwidget.ru_server"

# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
acquire_production_deploy_lock 'Widgets deployment'
# shellcheck source=scripts/database-restore-production-guard.sh
source "$server_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/widgets-database-lifecycle.sh
source "$server_root/scripts/widgets-database-lifecycle.sh"

recreate_started=false
rollout_verified=false
schema_migration_started=false
previous_image_id=''
previous_revision=''
health_port=''
post_cleanup_service_recovery=false
core_source_contract=''

fail() {
	echo "$1" >&2
	if [[ "$recreate_started" == 'true' && "$rollout_verified" != 'true' ]] &&
		declare -F rollback_widgets >/dev/null; then
		trap - ERR
		rollback_widgets "$1" || true
	fi
	exit 1
}

compose_target() {
	docker compose --project-name winwidget --env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" "$@"
}

get_env_value() {
	widgets_lifecycle_get_env_value "$1"
}

require_env_key() {
	local key="$1" value
	value="$(get_env_value "$key")" || fail "Missing or duplicate production env key: $key"
	[[ -n "$value" && "$value" != change_me* && "$value" != XYZXYZXYZ* ]] ||
		fail "Production env key is empty or a placeholder: $key"
}

validate_widgets_database_urls() {
	printf '%s\n%s\n%s\n' \
		"$(get_env_value WIDGETS_DATABASE_URL)" \
		"$(get_env_value WIDGETS_MIGRATION_DATABASE_URL)" \
		"$(get_env_value WIDGETS_BACKUP_URL)" |
		docker run --rm -i --network none \
			-e EXPECTED_PORT=55436 \
			--entrypoint node "$WIDGETS_IMAGE" -e '
const { readFileSync } = require("node:fs");
const urls = readFileSync(0, "utf8").trim().split("\n").map(value => new URL(value));
const expectedUsers = [
  "winwidget_widgets_runtime",
  "winwidget_widgets_migration",
  "winwidget_widgets_backup",
];
for (const [index, url] of urls.entries()) {
  const password = decodeURIComponent(url.password);
  if (
    url.protocol !== "postgresql:" ||
    decodeURIComponent(url.username) !== expectedUsers[index] ||
    url.hostname !== "127.0.0.1" ||
    url.port !== process.env.EXPECTED_PORT ||
    url.pathname !== "/winwidget_widgets" ||
    url.searchParams.get("schema") !== "widgets" ||
    url.searchParams.get("sslmode") !== "disable" ||
    password.length < 16 ||
    /[\0\r\n]/.test(password)
  ) throw new Error(`Invalid Widgets database URL boundary at index ${index}`);
}
process.stdout.write("Widgets runtime, migration and backup URL boundaries verified\n");
'
}

verify_service() {
	local expected_image_id="$1" expected_revision="$2"
	local attempt container_id health response image_id image_revision restart_count role listen_host asset_headers
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(compose_target ps --status running -q widgets-service 2>/dev/null || true)"
		if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
			health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null || true)"
			if [[ "$health" == 'healthy' ]]; then
				response="$(curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:$health_port/health/ready" 2>/dev/null || true)"
					image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
					image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
					restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
					role="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^WIDGETS_PROCESS_ROLE=//p')"
					listen_host="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^WIDGETS_LISTEN_HOST=//p')"
					asset_headers="$(
						curl -fsSI --connect-timeout 2 --max-time 5 \
							"http://127.0.0.1:$health_port/widgets/wheel.js" 2>/dev/null |
							tr -d '\r' |
							tr '[:upper:]' '[:lower:]' || true
					)"
					if [[ "$image_id" == "$expected_image_id" &&
						"$image_revision" == "$expected_revision" &&
						"$restart_count" == '0' && "$role" == 'all' &&
						"$listen_host" == '127.0.0.1' &&
						"$asset_headers" == *'cache-control: public, max-age=300'* &&
						"$asset_headers" != *'immutable'* &&
						( "$response" == *"\"revision\":\"$expected_revision\""* ||
					"$response" == *"\"revision\": \"$expected_revision\""* ) ]]; then
					return 0
				fi
			fi
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	return 1
}

stop_widgets_service_for_migration() {
	local running exit_code oom_killed
	compose_target stop -t 90 widgets-service
	read -r running exit_code oom_killed < <(
		docker inspect --format '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}' \
			"$current_container_id"
	)
	[[ "$running" == 'false' && "$oom_killed" == 'false' &&
		( "$exit_code" == '0' || "$exit_code" == '143' ) ]] ||
		fail 'Widgets service did not stop through the graceful migration window.'
}

rollback_widgets() {
	local reason="$1"
	[[ "$recreate_started" == 'true' && "$rollout_verified" != 'true' ]] || return
	if [[ "$schema_migration_started" == 'true' ]]; then
		echo "Widgets rollout failed ($reason); automatic old-image rollback is blocked after the schema migration step. Recover forward with a schema-compatible image." >&2
		return
	fi
	if [[ ! "$previous_image_id" =~ ^sha256:[0-9a-f]{64}$ ||
		! "$previous_revision" =~ ^[0-9a-f]{40}$ ]]; then
		echo "Widgets rollout failed ($reason) and no verified previous image is available." >&2
		return
	fi
	echo "Widgets rollout failed ($reason); restoring the previous service image." >&2
	export WIDGETS_IMAGE="$previous_image_id" WIDGETS_REVISION="$previous_revision"
	compose_target up -d --no-deps --no-build --force-recreate widgets-service
	verify_service "$previous_image_id" "$previous_revision" ||
		echo 'Widgets automatic rollback did not become healthy.' >&2
}

on_error() {
	local exit_code=$? line="$1"
	trap - ERR
	rollback_widgets "line $line, exit $exit_code"
	exit "$exit_code"
}
trap 'on_error "$LINENO"' ERR

[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
	"$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
	fail 'Backend production env must be a root-owned mode-600 regular file.'
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] ||
	fail 'Backend production Compose file was not found.'

database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
deploy_revision="$(git -C "$server_root" rev-parse HEAD)"
expected_revision="${EXPECTED_REVISION:-$deploy_revision}"
[[ "$deploy_revision" == "$expected_revision" &&
	"$(git -C "$server_root" branch --show-current)" == 'prod' &&
	-z "$(git -C "$server_root" status --porcelain --untracked-files=all)" ]] ||
	fail 'Widgets deploy requires a clean protected prod checkout at EXPECTED_REVISION.'
widgets_export_compose_release_identity "$deploy_revision"

for key in WIDGETS_DATABASE_URL WIDGETS_MIGRATION_DATABASE_URL WIDGETS_BACKUP_URL \
	WIDGETS_POSTGRES_IMAGE WIDGETS_POSTGRES_PORT WIDGETS_POSTGRES_DATA_VOLUME \
	WIDGETS_POSTGRES_ADMIN_USER WIDGETS_POSTGRES_ADMIN_PASSWORD_FILE \
	WIDGETS_INTERNAL_TOKEN WIDGETS_PROCESS_ROLE WIDGETS_LISTEN_HOST WIDGETS_PORT \
	WIDGETS_CORE_INTERNAL_BASE_URL WIDGETS_INTERNAL_BASE_URL \
	WIDGETS_ENTITLEMENT_MAX_STALENESS_MS RABBITMQ_WIDGETS_URL; do
	require_env_key "$key"
done
[[ "$(get_env_value WIDGETS_PROCESS_ROLE)" == 'all' &&
	"$(get_env_value WIDGETS_LISTEN_HOST)" == '127.0.0.1' &&
	"$(get_env_value WIDGETS_PORT)" == '4700' &&
	"$(get_env_value WIDGETS_POSTGRES_PORT)" == '55436' ]] ||
	fail 'Widgets runtime and PostgreSQL boundaries must remain on the reviewed loopback ports.'
health_port="$(get_env_value WIDGETS_PORT)"
widgets_entitlement_max_staleness_ms="$(get_env_value WIDGETS_ENTITLEMENT_MAX_STALENESS_MS)"
[[ "$widgets_entitlement_max_staleness_ms" =~ ^[0-9]+$ ]] &&
	((widgets_entitlement_max_staleness_ms >= 60000 &&
		widgets_entitlement_max_staleness_ms <= 31968000000)) ||
	fail 'Widgets entitlement staleness must be a finite value between 60000 and 31968000000 ms.'

ownership_state="$(widgets_service_identity_state)" || fail 'Widgets ownership state is unreadable.'
if [[ "$ownership_state" == 'handoff' ]]; then
	[[ "${WIDGETS_AUTOMATIC_PROD_PUSH:-false}" == 'false' ]] ||
		fail 'Widgets forward recovery is manual-only.'
	exec env APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" \
		EXPECTED_REVISION="$expected_revision" WIDGETS_AUTOMATIC_PROD_PUSH=false \
		bash "$server_root/scripts/widgets-cutover-production.sh"
elif [[ "$ownership_state" != 'active' ]]; then
	[[ "${WIDGETS_AUTOMATIC_PROD_PUSH:-false}" == 'false' &&
		"${WIDGETS_FIRST_CUTOVER_APPROVED:-false}" == 'true' &&
		"${WIDGETS_FIRST_CUTOVER_CONFIRMATION:-}" == 'CUTOVER WIDGETS OWNERSHIP' ]] || {
		echo 'Widgets first cutover is manual-only; automatic/routine deploy made no runtime change.' >&2
		exit 1
	}
	exec env APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" \
		EXPECTED_REVISION="$expected_revision" WIDGETS_FIRST_CUTOVER_APPROVED=true \
		WIDGETS_FIRST_CUTOVER_CONFIRMATION="${WIDGETS_FIRST_CUTOVER_CONFIRMATION:-}" \
		bash "$server_root/scripts/widgets-cutover-production.sh"
fi

core_source_state="$(widgets_core_source_state)" ||
	fail 'Core legacy Widgets source state is unreadable.'
core_cleanup_migration_state="$(widgets_core_source_cleanup_migration_state)" ||
	fail 'Core legacy Widgets cleanup migration state is unreadable.'
case "$core_source_state|$core_cleanup_migration_state" in
	present\|pending | present\|rolled-back)
		[[ "$(widgets_core_source_cleanup_marker_state)" == 'absent' ]] ||
			fail 'Legacy Core source cannot be used after cleanup evidence staging.'
		core_source_contract='legacy'
		;;
	absent\|applied)
		widgets_core_source_cleanup_validate_marker ||
			fail 'Removed Core source requires the durable cleanup marker.'
		[[ "$(widgets_core_source_cleanup_marker_value phase)" == 'complete' ]] ||
			fail 'Widgets service-only deployment is blocked until post-cleanup restore evidence is complete.'
		widgets_core_source_cleanup_require_completion_evidence ||
			fail 'Widgets Core source cleanup evidence is missing or changed.'
		widgets_core_source_cleanup_local_retention_is_finalized ||
			fail 'Widgets Core source cleanup raw VPS evidence is not finalized.'
		core_source_contract='clean'
		;;
	absent\|unfinished)
		fail 'Core Widgets source was removed before Prisma finalized its ledger; resume the exact full cleanup revision forward.'
		;;
	partial\|* | present\|applied | absent\|pending | absent\|rolled-back | *\|unsafe)
		fail "Core Widgets source/cleanup state is unsafe: source=$core_source_state migration=$core_cleanup_migration_state."
		;;
	*)
		fail "Unsupported Core Widgets source/cleanup state: source=$core_source_state migration=$core_cleanup_migration_state."
		;;
esac

current_container_id="$(compose_target ps --status running -q widgets-service 2>/dev/null || true)"
if [[ ! "$current_container_id" =~ ^[0-9a-f]{64}$ ]]; then
	[[ "${WIDGETS_AUTOMATIC_PROD_PUSH:-false}" == 'false' ]] ||
		fail 'Active Widgets ownership has no running service; resume through the manual widgets target.'
	if [[ "$core_source_contract" == 'legacy' ]]; then
		exec env APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" COMPOSE_FILE="$COMPOSE_FILE" \
			EXPECTED_REVISION="$expected_revision" WIDGETS_AUTOMATIC_PROD_PUSH=false \
			bash "$server_root/scripts/widgets-cutover-production.sh"
	fi
	post_cleanup_service_recovery=true
	echo 'Recovering the active Widgets service forward without touching the removed Core source.'
fi

compose_target --profile widgets-migration config --quiet

if [[ "$post_cleanup_service_recovery" != 'true' ]]; then
	[[ "$current_container_id" =~ ^[0-9a-f]{64}$ ]] ||
		fail 'Routine Widgets deploy requires exactly one running service.'
	previous_image_id="$(docker inspect --format '{{.Image}}' "$current_container_id")"
	previous_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$previous_image_id")"
	[[ "$previous_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$previous_revision" =~ ^[0-9a-f]{40}$ ]] ||
		fail 'Previous Widgets image identity is invalid.'
	verify_service "$previous_image_id" "$previous_revision" ||
		fail 'Current Widgets service is not a healthy rollback target.'
	git -C "$server_root" merge-base --is-ancestor "$previous_revision" "$deploy_revision" ||
		fail 'Routine Widgets deploy does not accept divergent revision history.'
fi

compose_target build --provenance=false widgets-service
new_image_id="$(docker image inspect "$WIDGETS_IMAGE" --format '{{.Id}}')"
new_image_revision="$(docker image inspect "$WIDGETS_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$new_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
	"$new_image_revision" == "$deploy_revision" ]] ||
	fail 'Widgets image identity or revision label is invalid.'
docker run --rm --network none --entrypoint node "$WIDGETS_IMAGE" -e '
const fs = require("node:fs");
for (const path of ["dist/src/main.js", "dist/src/cutover-main.js", "prisma/schema.prisma"]) fs.accessSync(path);
require("@prisma/widgets-client");
for (const path of ["dist/src/app.module.js", "dist/src/outbox-publisher-main.js"]) if (fs.existsSync(path)) throw new Error(`Widgets image contains Core artifact: ${path}`);
const expectedAssets = [
  "calculator-button.png", "calculator.js", "callback-button.png", "callback.js",
  "email-logo.png", "gift-button.png", "helpers/libphonenumber-min.js",
  "helpers/winwidget-phone.js", "online-consultant-button.png",
  "online-consultant.js", "quiz-button.png", "quiz.js", "stop-offer.js",
  "timer-button.png", "timer.js", "wheel.js",
];
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const relative = `${directory}/${entry.name}`;
  return entry.isDirectory() ? walk(relative) : [relative.slice("public/widgets/".length)];
}).sort();
if (JSON.stringify(walk("public/widgets")) !== JSON.stringify(expectedAssets)) throw new Error("Widgets runtime asset manifest drifted");
'
validate_widgets_database_urls

recreate_started=true
if [[ "$post_cleanup_service_recovery" != 'true' ]]; then
	stop_widgets_service_for_migration
fi
schema_migration_started=true
compose_target --profile widgets-migration run --rm --no-deps widgets-migrate
compose_target --profile widgets-migration run --rm --no-deps widgets-migrate \
	migrate status --schema prisma/schema.prisma

compose_target up -d --no-deps --no-build --force-recreate widgets-service
verify_service "$new_image_id" "$deploy_revision" ||
	fail 'Widgets service failed revision/readiness/restart checks.'
WIDGETS_DATABASE_URL="$(get_env_value WIDGETS_DATABASE_URL)"
export WIDGETS_DATABASE_URL
docker run --rm --network host --env WIDGETS_DATABASE_URL --entrypoint node \
	"$WIDGETS_IMAGE" dist/src/cutover-main.js verify-steady >/dev/null
[[ "$(widgets_service_identity_state)" == 'active' ]] ||
	fail 'Widgets ownership marker changed during routine deployment.'
[[ "$(widgets_core_source_state)" == "$core_source_state" &&
	"$(widgets_core_source_cleanup_migration_state)" == "$core_cleanup_migration_state" ]] ||
	fail 'Core Widgets source cleanup state changed during the independent Widgets deployment.'

rollout_verified=true
trap - ERR
echo "Widgets deployed independently at revision $deploy_revision."
