#!/usr/bin/env bash

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/deploy/backend/docker-compose.prod.yml}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4200/api/site-settings}"

cd "$APP_ROOT"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build api
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile migration run --rm migrate
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d api
curl -fsS "$HEALTHCHECK_URL" > /dev/null
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps api
