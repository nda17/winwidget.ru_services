#!/usr/bin/env bash

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4200/api/health/deployment}"
PUBLIC_HEALTHCHECK_URL="${PUBLIC_HEALTHCHECK_URL:-https://api.winwidget.ru/api/health/deployment}"
READINESS_URL="${READINESS_URL:-http://127.0.0.1:4200/api/site-settings}"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-30}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-2}"

cd "$APP_ROOT"

server_root="$APP_ROOT/winwidget.ru_server"
deploy_revision="$(git -C "$server_root" rev-parse HEAD)"
expected_revision="${EXPECTED_REVISION:-$deploy_revision}"
if [[ "$deploy_revision" != "$expected_revision" ]]; then
	echo "Deployment revision mismatch: expected $expected_revision, got $deploy_revision" >&2
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

export APP_REVISION="$deploy_revision"
export APP_VERSION="git-$deploy_revision"

echo "Deploying backend revision: $APP_REVISION"
echo "Building backend image: winwidget-api:$APP_VERSION"

if [[ ! -f "$ENV_FILE" ]]; then
	echo "Backend env file not found: $ENV_FILE" >&2
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

			if (name == key && value != "" && value != "change_me") ok = 1
		}
		END { exit(ok ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "Missing required $key in $ENV_FILE" >&2
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

mode="$(get_env_value "MODE" || true)"
mode="${mode:-production}"
mode="${mode,,}"

case "$mode" in
	production)
		require_env_key "DATABASE_URL_PRODUCTION"
		require_env_key "RABBITMQ_URL"
		require_env_key "RABBITMQ_USER"
		require_env_key "RABBITMQ_PASSWORD"
		require_env_key "YOOKASSA_PRODUCTION_SHOP_ID"
		require_env_key "YOOKASSA_PRODUCTION_SECRET_KEY"
		;;
	development)
		require_env_key "DATABASE_URL_DEVELOPMENT"
		require_env_key "YOOKASSA_SHOP_ID"
		require_env_key "YOOKASSA_SECRET_KEY"
		;;
	*)
		echo "Unsupported MODE in $ENV_FILE: $mode. Expected development or production." >&2
		exit 1
		;;
esac

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build api
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile migration run --rm migrate
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d rabbitmq
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --force-recreate \
	api outbox-publisher integration-worker

show_api_diagnostics() {
	echo "API deployment diagnostics:"
	docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
		ps api outbox-publisher integration-worker rabbitmq || true
	docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
		logs --tail=100 api || true
	echo "Processes listening on port 4200:"
	ss -ltnp 'sport = :4200' || true
}

ensure_required_services_running() {
	local service
	local container_id
	for service in rabbitmq api outbox-publisher integration-worker; do
		container_id="$(
			docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
				ps --status running -q "$service"
		)"
		if [[ -z "$container_id" ]]; then
			echo "Required service is not running: $service" >&2
			show_api_diagnostics
			exit 1
		fi
	done
}

check_deployment_revision() {
	local url="$1"
	local response
	response="$(
		curl -fsS --connect-timeout 3 --max-time 5 \
			-H 'Cache-Control: no-cache' "$url" || true
	)"

	if [[ "$response" == *"\"revision\":\"$APP_REVISION\""* ]]; then
		return 0
	fi

	if [[ -n "$response" ]]; then
		echo "Unexpected deployment health response from $url: $response"
	fi
	return 1
}

ensure_required_services_running

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$HEALTHCHECK_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Backend revision healthcheck failed: $HEALTHCHECK_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$PUBLIC_HEALTHCHECK_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Public backend revision healthcheck failed: $PUBLIC_HEALTHCHECK_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if curl -fsS --connect-timeout 3 --max-time 5 "$READINESS_URL" > /dev/null; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Backend readiness check failed: $READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

ensure_required_services_running

for service in api outbox-publisher integration-worker; do
	container_id="$(
		docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q "$service"
	)"
	image_revision="$(
		docker inspect \
			--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
			"$container_id"
	)"
	if [[ "$image_revision" != "$APP_REVISION" ]]; then
		echo "$service image revision mismatch: expected $APP_REVISION, got $image_revision"
		show_api_diagnostics
		exit 1
	fi

	restart_count="$(
		docker inspect --format '{{ .RestartCount }}' "$container_id"
	)"
	if [[ "$restart_count" != "0" ]]; then
		echo "$service restarted during deployment: restartCount=$restart_count"
		show_api_diagnostics
		exit 1
	fi
done

echo "Backend revision verified locally and publicly: $APP_REVISION"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps \
	api outbox-publisher integration-worker rabbitmq
