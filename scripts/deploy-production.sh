#!/usr/bin/env bash

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/deploy/backend/docker-compose.prod.yml}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4200/api/site-settings}"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-30}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-2}"

cd "$APP_ROOT"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build api
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile migration run --rm migrate
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d api

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
