#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
HEALTHCHECK_ATTEMPTS="${CAMPAIGNS_HEALTHCHECK_ATTEMPTS:-60}"
HEALTHCHECK_INTERVAL="${CAMPAIGNS_HEALTHCHECK_INTERVAL:-2}"

server_root="$APP_ROOT/winwidget.ru_server"
# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
acquire_production_deploy_lock "Campaigns deployment"
# shellcheck source=scripts/campaigns-database-lifecycle.sh
source "$server_root/scripts/campaigns-database-lifecycle.sh"

recreate_started=false
rollout_verified=false
previous_image_ref=""
previous_image_id=""
previous_revision=""
previous_restart_count=""
health_port=""

compose_target() {
	docker compose \
		--project-name winwidget \
		--env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" \
		"$@"
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

require_env_key() {
	local key="$1"
	local value
	value="$(get_env_value "$key")" || {
		echo "Required production env key must occur exactly once: $key" >&2
		exit 1
	}
	[[ -n "$value" && "$value" != "XYZXYZXYZ" && "$value" != change_me* ]] || {
		echo "Production env key is missing or still a placeholder: $key" >&2
		exit 1
	}
}

verify_campaigns_service() {
	local expected_image_id="$1"
	local expected_revision="$2"
	local expected_restart_count="${3:-0}"
	local attempt container_id health response image_id image_revision restart_count
	local process_role

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(
			compose_target ps --status running -q campaigns-service 2>/dev/null ||
				true
		)"
		if [[ -n "$container_id" && "$container_id" != *$'\n'* ]]; then
			health="$(
				docker inspect \
					--format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
					"$container_id" 2>/dev/null || true
			)"
			if [[ "$health" == "healthy" ]]; then
				response="$(
					curl -fs --connect-timeout 2 --max-time 5 \
						"http://127.0.0.1:$health_port/health/ready" 2>/dev/null ||
						true
				)"
				image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
				image_revision="$(
					docker image inspect \
						--format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
						"$image_id" 2>/dev/null || true
				)"
				restart_count="$(
					docker inspect --format '{{.RestartCount}}' "$container_id"
				)"
				process_role="$(
					docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
						"$container_id" |
						sed -n 's/^CAMPAIGNS_PROCESS_ROLE=//p'
				)"
				if [[ "$image_id" == "$expected_image_id" &&
					"$image_revision" == "$expected_revision" &&
					"$restart_count" == "$expected_restart_count" &&
					"$process_role" == "all" ]] &&
					printf '%s' "$response" |
						grep -Eq "\"revision\"[[:space:]]*:[[:space:]]*\"$expected_revision\""; then
					return 0
				fi
			fi
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	return 1
}

rollback_campaigns() {
	local reason="$1"
	[[ "$recreate_started" == "true" && "$rollout_verified" != "true" ]] || return
	[[ -n "$previous_image_id" && -n "$previous_revision" ]] || {
		echo "Campaigns rollout failed and no verified previous image is available." >&2
		return
	}

	echo "Campaigns rollout failed ($reason); restoring previous compatible image." >&2
	export CAMPAIGNS_IMAGE="$previous_image_id"
	export CAMPAIGNS_REVISION="$previous_revision"
	compose_target up -d --no-deps --no-build --force-recreate campaigns-service
	verify_campaigns_service \
		"$previous_image_id" \
		"$previous_revision" \
		0 ||
		echo "Campaigns automatic rollback did not become healthy." >&2
	verify_campaigns_database_lifecycle_unchanged ||
		echo "Campaigns PostgreSQL lifecycle changed during failed rollout." >&2
}

on_error() {
	local exit_code=$?
	local line="$1"
	trap - ERR
	rollback_campaigns "line $line, exit $exit_code"
	exit "$exit_code"
}
trap 'on_error "$LINENO"' ERR

[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || {
	echo "Backend production env file must be a regular non-symlink file." >&2
	exit 1
}
[[ "$(stat -c '%a' "$ENV_FILE")" == "600" &&
	"$(stat -c '%u:%g' "$ENV_FILE")" == "0:0" ]] || {
	echo "Backend production env file must be root-owned with mode 600." >&2
	exit 1
}
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || {
	echo "Backend production Compose file was not found." >&2
	exit 1
}

deploy_revision="$(git -C "$server_root" rev-parse HEAD)"
expected_revision="${EXPECTED_REVISION:-$deploy_revision}"
checkout_branch="$(git -C "$server_root" branch --show-current)"
checkout_dirty="$(
	git -C "$server_root" status --porcelain --untracked-files=all
)"
[[ "$deploy_revision" == "$expected_revision" &&
	"$checkout_branch" == "prod" &&
	-z "$checkout_dirty" ]] || {
	echo "Campaigns deploy requires a clean protected prod checkout at EXPECTED_REVISION." >&2
	exit 1
}

for key in \
	CAMPAIGNS_DATABASE_URL \
	CAMPAIGNS_MIGRATION_DATABASE_URL \
	CAMPAIGNS_BACKUP_URL \
	CAMPAIGNS_POSTGRES_IMAGE \
	CAMPAIGNS_POSTGRES_PORT \
	CAMPAIGNS_POSTGRES_DATA_VOLUME \
	CAMPAIGNS_POSTGRES_ADMIN_USER \
	CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE \
	CAMPAIGNS_INTERNAL_TOKEN \
	CORS_ALLOWED_ORIGINS \
	CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE \
	CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS \
	CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE \
	RABBITMQ_CAMPAIGNS_URL; do
	require_env_key "$key"
done

campaigns_internal_token="$(get_env_value CAMPAIGNS_INTERNAL_TOKEN)"
[[ ${#campaigns_internal_token} -ge 32 &&
	"$campaigns_internal_token" != "ci_campaigns_internal_token_at_least_32_chars" ]] || {
	echo "CAMPAIGNS_INTERNAL_TOKEN must be a production-only secret of at least 32 characters." >&2
	exit 1
}
unset campaigns_internal_token

campaigns_export_chunk_size="$(get_env_value CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE)"
campaigns_export_timeout_ms="$(get_env_value CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS)"
campaigns_import_batch_size="$(get_env_value CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE)"
[[ "$campaigns_export_chunk_size" =~ ^[0-9]+$ &&
	"$campaigns_export_chunk_size" -ge 1 &&
	"$campaigns_export_chunk_size" -le 5000 ]] || {
	echo "CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE must be between 1 and 5000." >&2
	exit 1
}
[[ "$campaigns_export_timeout_ms" =~ ^[0-9]+$ &&
	"$campaigns_export_timeout_ms" -ge 30000 &&
	"$campaigns_export_timeout_ms" -le 900000 ]] || {
	echo "CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS must be between 30000 and 900000." >&2
	exit 1
}
[[ "$campaigns_import_batch_size" =~ ^[0-9]+$ &&
	"$campaigns_import_batch_size" -ge 1 &&
	"$campaigns_import_batch_size" -le 5000 ]] || {
	echo "CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE must be between 1 and 5000." >&2
	exit 1
}
[[ "$(get_env_value CAMPAIGNS_PROCESS_ROLE)" == "all" ]] || {
	echo "Current single-VPS Campaigns deployment requires CAMPAIGNS_PROCESS_ROLE=all." >&2
	exit 1
}
[[ "$(get_env_value CAMPAIGNS_LISTEN_HOST)" == "127.0.0.1" ]] || {
	echo "CAMPAIGNS_LISTEN_HOST must remain loopback-only." >&2
	exit 1
}
health_port="$(get_env_value CAMPAIGNS_HEALTH_PORT)"
[[ "$health_port" == "4500" ]] || {
	echo "CAMPAIGNS_HEALTH_PORT must use the reviewed loopback port 4500." >&2
	exit 1
}

export CAMPAIGNS_REVISION="$deploy_revision"
export CAMPAIGNS_IMAGE="winwidget-campaigns:git-$deploy_revision"

initialize_campaigns_database_lifecycle_guard "routine Campaigns deployment"

current_container_id="$(
	compose_target ps --status running -q campaigns-service 2>/dev/null || true
)"
[[ -n "$current_container_id" && "$current_container_id" != *$'\n'* ]] || {
	echo "Routine Campaigns deploy requires exactly one existing running service." >&2
	exit 1
}
previous_image_id="$(docker inspect --format '{{.Image}}' "$current_container_id")"
previous_image_ref="$(docker inspect --format '{{.Config.Image}}' "$current_container_id")"
previous_revision="$(
	docker image inspect \
		--format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		"$previous_image_id"
)"
previous_restart_count="$(
	docker inspect --format '{{.RestartCount}}' "$current_container_id"
)"
[[ "$previous_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
	"$previous_revision" =~ ^[0-9a-f]{40}$ &&
	"$previous_restart_count" =~ ^[0-9]+$ ]] || {
	echo "Previous Campaigns image identity is invalid." >&2
	exit 1
}
verify_campaigns_service "$previous_image_id" "$previous_revision" 0 || {
	echo "Current Campaigns service is not a healthy rollback target." >&2
	exit 1
}
git -C "$server_root" merge-base --is-ancestor \
	"$previous_revision" "$deploy_revision" || {
	echo "Routine Campaigns deploy does not accept divergent revision history." >&2
	exit 1
}

changed_paths="$(
	git -C "$server_root" diff --name-only "$previous_revision" "$deploy_revision"
)"
while IFS= read -r changed_path; do
	[[ -z "$changed_path" ||
		"$changed_path" == apps/campaigns/* ||
		"$changed_path" == scripts/deploy-campaigns-production.sh ]] ||
		{
			echo "Campaigns-only deploy cannot release shared path: $changed_path" >&2
			echo "Use the coordinated/full production target." >&2
			exit 1
		}
done <<<"$changed_paths"

changed_migrations="$(
	git -C "$server_root" diff --name-only "$previous_revision" "$deploy_revision" -- \
		'apps/campaigns/prisma/migrations/*/migration.sql'
)"
while IFS= read -r migration; do
	[[ -z "$migration" ]] && continue
	if git -C "$server_root" diff --unified=0 \
		"$previous_revision" "$deploy_revision" -- "$migration" |
		sed -n 's/^+//p' |
		grep -Eiq \
			'(^|[[:space:]])(DROP|TRUNCATE)[[:space:]]|RENAME[[:space:]]|ALTER[[:space:]]+COLUMN|SET[[:space:]]+NOT[[:space:]]+NULL|DROP[[:space:]]+NOT[[:space:]]+NULL'; then
		echo "Campaigns migration is not provably backward-compatible: $migration" >&2
		exit 1
	fi
done <<<"$changed_migrations"

compose_target build campaigns-service
new_image_id="$(
	docker image inspect "$CAMPAIGNS_IMAGE" --format '{{.Id}}'
)"
new_image_revision="$(
	docker image inspect "$CAMPAIGNS_IMAGE" \
		--format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
)"
[[ "$new_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
	"$new_image_revision" == "$deploy_revision" ]] || {
	echo "Campaigns image identity or revision label is invalid." >&2
	exit 1
}

printf '%s\n%s\n%s\n' \
	"$(get_env_value CAMPAIGNS_DATABASE_URL)" \
	"$(get_env_value CAMPAIGNS_MIGRATION_DATABASE_URL)" \
	"$(get_env_value CAMPAIGNS_BACKUP_URL)" |
	docker run --rm -i --network none --entrypoint node "$CAMPAIGNS_IMAGE" -e '
const fs = require("node:fs");
const urls = fs.readFileSync(0, "utf8").trim().split("\n").map(value => new URL(value));
const expectedUsers = [
  "winwidget_campaigns_runtime",
  "winwidget_campaigns_migration",
  "winwidget_campaigns_backup",
];
if (urls.length !== 3) throw new Error("Expected three Campaigns database URLs");
for (let index = 0; index < urls.length; index += 1) {
  const url = urls[index];
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    decodeURIComponent(url.username) !== expectedUsers[index] ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55433" ||
    url.pathname !== "/winwidget_campaigns" ||
    url.searchParams.get("schema") !== "campaigns" ||
    url.searchParams.get("sslmode") !== "disable"
  ) throw new Error(`Invalid Campaigns database URL boundary at index ${index}`);
}
if (new Set(expectedUsers).size !== expectedUsers.length) {
  throw new Error("Campaigns database roles must be distinct");
}
for (const required of ["dist/src/main.js", "prisma/schema.prisma"]) fs.accessSync(required);
require("@prisma/campaigns-client");
for (const forbidden of ["dist/src/app.module.js", "public/widgets"]) {
  if (fs.existsSync(forbidden)) throw new Error(`Campaigns image contains monolith artifact: ${forbidden}`);
}
'

if [[ -n "$changed_migrations" ]]; then
	create_campaigns_pre_migration_backup
fi
compose_target --profile campaigns-migration run --rm --no-deps campaigns-migrate
compose_target --profile campaigns-migration run --rm --no-deps \
	campaigns-migrate migrate status --schema prisma/schema.prisma
verify_campaigns_database_access_boundaries

recreate_started=true
compose_target up -d --no-deps --no-build --force-recreate campaigns-service
verify_campaigns_service "$new_image_id" "$deploy_revision" 0 || {
	echo "Campaigns service failed revision/readiness/restart checks." >&2
	exit 1
}
verify_campaigns_database_lifecycle_unchanged

rollout_verified=true
trap - ERR
echo "Campaigns deployed independently at revision $deploy_revision."
echo "Previous compatible image retained for rollback: $previous_image_ref ($previous_image_id)."
