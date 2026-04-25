#!/usr/bin/env bash

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/deploy/backend/docker-compose.prod.yml}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4200/api/site-settings}"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-30}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-2}"

cd "$APP_ROOT"

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
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --force-recreate api

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if curl -fsS "$HEALTHCHECK_URL" > /dev/null; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Backend healthcheck failed: $HEALTHCHECK_URL"
		docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=100 api
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps api
