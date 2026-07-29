#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
HEALTHCHECK_ATTEMPTS="${MAINTENANCE_HEALTHCHECK_ATTEMPTS:-60}"
HEALTHCHECK_INTERVAL="${MAINTENANCE_HEALTHCHECK_INTERVAL:-2}"

server_root="$APP_ROOT/winwidget.ru_server"
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

verify_maintenance_worker() {
	local expected_image_id="$1"
	local expected_revision="$2"
	local expected_restart_count="${3:-0}"
	local attempt
	local container_id
	local health_status
	local response
	local image_id
	local image_revision
	local restart_count

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(
			compose_target ps --status running -q maintenance-worker \
				2>/dev/null || true
		)"
		if [[ -n "$container_id" && "$container_id" != *$'\n'* ]]; then
			health_status="$(
				docker inspect \
					--format '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}missing{{ end }}' \
					"$container_id" 2>/dev/null || true
			)"
			if [[ "$health_status" == "healthy" ]]; then
				response="$(
					curl -fs \
						--connect-timeout 2 \
						--max-time 5 \
						"http://127.0.0.1:$health_port/health/ready" \
						2>/dev/null || true
				)"
				if printf '%s' "$response" |
					grep -Eq "\"revision\"[[:space:]]*:[[:space:]]*\"$expected_revision\""; then
					image_id="$(
						docker inspect --format '{{ .Image }}' "$container_id"
					)"
					image_revision="$(
						docker image inspect \
							--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
							"$image_id"
					)"
					restart_count="$(
						docker inspect --format '{{ .RestartCount }}' "$container_id"
					)"

					[[ "$image_id" == "$expected_image_id" ]] || return 1
					[[ "$image_revision" == "$expected_revision" ]] || return 1
					[[ "$restart_count" == "$expected_restart_count" ]] || return 1
					return 0
				fi
			fi
		fi

		sleep "$HEALTHCHECK_INTERVAL"
	done

	return 1
}

rollback_previous_maintenance_worker() {
	export MAINTENANCE_IMAGE="$previous_image_ref"
	export MAINTENANCE_REVISION="$previous_revision"
	export APP_REVISION="$previous_revision"
	export APP_VERSION="git-$previous_revision"

	if ! docker image inspect "$previous_image_id" >/dev/null 2>&1; then
		echo "Previous maintenance image is no longer available; rollback failed." >&2
		return 1
	fi
	if ! compose_target up \
		-d \
		--no-deps \
		--force-recreate \
		maintenance-worker; then
		echo "Previous maintenance image could not be recreated." >&2
		return 1
	fi
	if ! verify_maintenance_worker "$previous_image_id" "$previous_revision"; then
		echo "Previous maintenance worker did not recover to healthy state." >&2
		return 1
	fi

	return 0
}

handle_exit() {
	local status=$?
	local rollback_status

	trap - EXIT INT TERM
	if ((status == 0)); then
		return
	fi
	if [[ "$recreate_started" != "true" || "$rollout_verified" == "true" ]]; then
		exit "$status"
	fi

	echo "Maintenance rollout failed after recreate; restoring previous image." >&2
	set +e
	rollback_previous_maintenance_worker
	rollback_status=$?
	if ((rollback_status == 0)); then
		echo "Previous maintenance image was restored and is healthy." >&2
	else
		echo "CRITICAL: automatic maintenance rollback failed." >&2
	fi
	exit "$status"
}

trap handle_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$APP_ROOT"

if [[ ! -d "$server_root/.git" ]]; then
	echo "Backend checkout was not found." >&2
	exit 1
fi

deploy_revision="$(git -C "$server_root" rev-parse HEAD)"
expected_revision="${EXPECTED_REVISION:-$deploy_revision}"
if [[ "$deploy_revision" != "$expected_revision" ]]; then
	echo "Maintenance deployment revision does not match EXPECTED_REVISION." >&2
	exit 1
fi

dirty_files="$(
	git -C "$server_root" status --porcelain --untracked-files=all
)"
if [[ -n "$dirty_files" ]]; then
	echo "Backend deployment checkout is not clean:" >&2
	echo "$dirty_files" >&2
	exit 1
fi
source "$server_root/scripts/notification-delivery-database-lifecycle.sh"

if [[ ! -f "$ENV_FILE" ]]; then
	echo "Backend production env file was not found." >&2
	exit 1
fi
env_mode="$(stat -c '%a' "$ENV_FILE")"
if [[ "$env_mode" != "600" ]]; then
	echo "Backend production env file mode must be exactly 600." >&2
	exit 1
fi
if [[ ! -f "$COMPOSE_FILE" ]]; then
	echo "Backend production Compose file was not found." >&2
	exit 1
fi

duplicate_env_keys="$(
	awk '
		/^[[:space:]]*(#|$)/ { next }
		{
			line = $0
			sub(/^[[:space:]]*/, "", line)
			if (line !~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) next

			name = line
			sub(/[[:space:]]*=.*/, "", name)
			count[name] += 1
		}
		END {
			for (name in count) {
				if (count[name] > 1) print name
			}
		}
	' "$ENV_FILE" | LC_ALL=C sort
)"
if [[ -n "$duplicate_env_keys" ]]; then
	echo "Duplicate environment keys are not allowed:" >&2
	echo "$duplicate_env_keys" >&2
	exit 1
fi

require_env_key() {
	local key="$1"

	if ! awk -F= -v key="$key" '
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

			if (name == key && value != "" && value !~ /^change_me/) ok = 1
		}
		END { exit(ok ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "Missing required production env key: $key" >&2
		exit 1
	fi
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
				found = 1
				exit
			}
		}
		END { exit(found ? 0 : 1) }
	' "$ENV_FILE"
}

get_database_username() {
	local key="$1"
	local value

	value="$(get_env_value "$key")"
	if [[ "$value" =~ ^postgres(ql)?://([A-Za-z0-9._-]+):[^@]+@ ]]; then
		printf '%s' "${BASH_REMATCH[2]}"
		return
	fi
	echo "$key must be a PostgreSQL URL with an explicit non-encoded username and password" >&2
	exit 1
}

assert_distinct_database_roles() {
	local api_user
	local migration_user
	local maintenance_user
	local backup_user
	local notification_delivery_backup_user

	api_user="$(get_database_username DATABASE_URL_PRODUCTION)"
	migration_user="$(get_database_username DATABASE_MIGRATION_URL_PRODUCTION)"
	maintenance_user="$(
		get_database_username MAINTENANCE_DATABASE_URL_PRODUCTION
	)"
	backup_user="$(get_database_username DATABASE_BACKUP_URL)"
	notification_delivery_backup_user="$(
		get_database_username NOTIFICATION_DELIVERY_BACKUP_URL
	)"

	if [[ "$api_user" == "$migration_user" ||
		"$api_user" == "$maintenance_user" ||
		"$api_user" == "$backup_user" ||
		"$api_user" == "$notification_delivery_backup_user" ||
		"$migration_user" == "$maintenance_user" ||
		"$migration_user" == "$backup_user" ||
		"$migration_user" == "$notification_delivery_backup_user" ||
		"$maintenance_user" == "$backup_user" ||
		"$maintenance_user" == "$notification_delivery_backup_user" ||
		"$backup_user" == "$notification_delivery_backup_user" ]]; then
		echo "API, migration, Maintenance runtime, core backup and notification delivery backup must use five distinct PostgreSQL roles" >&2
		exit 1
	fi
}

for key in \
	MODE \
	COMPOSE_PROJECT_NAME \
	DATABASE_URL_PRODUCTION \
	DATABASE_MIGRATION_URL_PRODUCTION \
	MAINTENANCE_DATABASE_URL_PRODUCTION \
	DATABASE_BACKUP_URL \
	NOTIFICATION_DELIVERY_BACKUP_URL \
	NOTIFICATION_DELIVERY_POSTGRES_IMAGE \
	NOTIFICATION_DELIVERY_POSTGRES_PORT \
	NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME \
	NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER \
	NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE \
	RABBITMQ_MAINTENANCE_WORKER_URL \
	MAINTENANCE_HEALTH_PORT; do
	require_env_key "$key"
done

for legacy_key in \
	RABBITMQ_LEGACY_USER \
	RABBITMQ_USER \
	RABBITMQ_PASSWORD \
	RABBITMQ_URL; do
	if awk -F= -v key="$legacy_key" '
		/^[[:space:]]*(#|$)/ { next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)
			if (name == key) found = 1
		}
		END { exit(found ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "$legacy_key must be removed from the production env file." >&2
		exit 1
	fi
done

if [[ "$(get_env_value MODE)" != "production" ]]; then
	echo "Maintenance rollout requires MODE=production." >&2
	exit 1
fi
if [[ "$(get_env_value COMPOSE_PROJECT_NAME)" != "winwidget" ]]; then
	echo "Maintenance rollout requires COMPOSE_PROJECT_NAME=winwidget." >&2
	exit 1
fi
assert_notification_database_postgres_identity
assert_distinct_database_roles

health_port="$(get_env_value MAINTENANCE_HEALTH_PORT)"
if [[ ! "$health_port" =~ ^[1-9][0-9]{0,4}$ ]] ||
	((10#$health_port > 65535)); then
	echo "MAINTENANCE_HEALTH_PORT must be an integer between 1 and 65535." >&2
	exit 1
fi
if [[ ! "$HEALTHCHECK_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
	echo "MAINTENANCE_HEALTHCHECK_ATTEMPTS must be a positive integer." >&2
	exit 1
fi
if [[ ! "$HEALTHCHECK_INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
	echo "MAINTENANCE_HEALTHCHECK_INTERVAL must be a positive integer." >&2
	exit 1
fi

ambient_compose_overrides=()
while IFS= read -r key; do
	[[ -n "$key" ]] || continue
	case "$key" in
		APP_REVISION | APP_VERSION | COMPOSE_PROJECT_NAME | MAINTENANCE_IMAGE | MAINTENANCE_REVISION)
			continue
			;;
	esac
	if printenv "$key" >/dev/null 2>&1; then
		ambient_compose_overrides+=("$key")
	fi
done < <(
	LC_ALL=C grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$COMPOSE_FILE" |
		sed 's/^${//' |
		LC_ALL=C sort -u
)
if ((${#ambient_compose_overrides[@]} > 0)); then
	echo "Unset shell variables that would override the production env file:" >&2
	printf '%s\n' "${ambient_compose_overrides[@]}" >&2
	exit 1
fi

export COMPOSE_PROJECT_NAME=winwidget
export APP_REVISION="$deploy_revision"
export APP_VERSION="git-$deploy_revision"
export MAINTENANCE_REVISION="$deploy_revision"
export MAINTENANCE_IMAGE="winwidget-maintenance:git-$deploy_revision"

initialize_notification_database_lifecycle_guard \
	false \
	"a maintenance-only rollout"
assert_notification_database_backup_target_url

compose_target config --quiet

previous_container_id="$(
	compose_target ps --status running -q maintenance-worker
)"
if [[ -z "$previous_container_id" || "$previous_container_id" == *$'\n'* ]]; then
	echo "Exactly one running maintenance-worker is required before routine rollout." >&2
	exit 1
fi

previous_image_ref="$(
	docker inspect --format '{{ .Config.Image }}' "$previous_container_id"
)"
previous_image_id="$(
	docker inspect --format '{{ .Image }}' "$previous_container_id"
)"
previous_restart_count="$(
	docker inspect --format '{{ .RestartCount }}' "$previous_container_id"
)"
previous_revision="$(
	docker image inspect \
		--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
		"$previous_image_id"
)"
if [[ -z "$previous_image_ref" ||
	-z "$previous_image_id" ||
	! "$previous_restart_count" =~ ^[0-9]+$ ]]; then
	echo "Previous maintenance image could not be resolved." >&2
	exit 1
fi
if [[ ! "$previous_revision" =~ ^[0-9a-f]{40}$ ]]; then
	echo "Previous maintenance image has no exact Git revision label." >&2
	exit 1
fi
if [[ "$previous_image_ref" == "$MAINTENANCE_IMAGE" ]]; then
	previous_image_hash="${previous_image_id#sha256:}"
	previous_image_ref="winwidget-maintenance:rollback-${previous_revision:0:12}-${previous_image_hash:0:12}"
	docker image tag "$previous_image_id" "$previous_image_ref"
fi
if ! git -C "$server_root" merge-base --is-ancestor \
	"$previous_revision" "$deploy_revision"; then
	echo "Previous maintenance revision is not an ancestor of the candidate." >&2
	echo "Use the full baseline deployment instead of a service-only rollout." >&2
	exit 1
fi

unsafe_contract_changes="$(
	git -C "$server_root" diff --name-only \
		"$previous_revision" "$deploy_revision" -- \
		prisma/schema.prisma \
		prisma/migrations \
		deploy/docker-compose.prod.yml \
		src/messaging/database-backup-event.ts \
		src/messaging/messaging.constants.ts \
		src/messaging/messaging-event-contract.ts \
		src/messaging/rabbitmq.service.ts \
		scripts/notification-delivery-database-lifecycle.sh
)"
if [[ -n "$unsafe_contract_changes" ]]; then
	echo "Maintenance-only rollout cannot include schema, topology or shared event contract changes:" >&2
	echo "$unsafe_contract_changes" >&2
	echo "Use the full baseline deployment." >&2
	exit 1
fi
if ! verify_maintenance_worker \
	"$previous_image_id" \
	"$previous_revision" \
	"$previous_restart_count"; then
	echo "Current maintenance worker is not a healthy rollback target." >&2
	exit 1
fi

echo "Building maintenance image for revision $deploy_revision."
compose_target build maintenance-worker

candidate_image_id="$(
	docker image inspect --format '{{ .Id }}' "$MAINTENANCE_IMAGE"
)"
candidate_image_revision="$(
	docker image inspect \
		--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
		"$candidate_image_id"
)"
if [[ "$candidate_image_revision" != "$deploy_revision" ]]; then
	echo "Candidate maintenance image revision label is invalid." >&2
	exit 1
fi

recreate_started=true
compose_target up -d --no-deps --force-recreate maintenance-worker

if ! verify_maintenance_worker "$candidate_image_id" "$deploy_revision"; then
	echo "Candidate maintenance worker did not pass rollout verification." >&2
	exit 1
fi

verify_notification_database_lifecycle_unchanged \
	"the maintenance-only rollout" \
	"complete"
rollout_verified=true
echo "Maintenance worker rollout verified for revision $deploy_revision."
