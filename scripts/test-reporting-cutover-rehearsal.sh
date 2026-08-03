#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SOURCE_ROOT="${REPORTING_REHEARSAL_SOURCE_ROOT:-$(
	cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P
)}"
RUN_ID="${REPORTING_REHEARSAL_RUN_ID:-local}"
LEGACY_BASELINE_REF="${REPORTING_REHEARSAL_BASELINE_REF:-42c422ca4c2c3a8ce758a37773d6cb0e6b689db7}"
REVISION_MODE="${REPORTING_REHEARSAL_REVISION_MODE:-synthetic-worktree}"
EXACT_REVISION="${REPORTING_REHEARSAL_EXACT_REVISION:-}"
APP_ROOT="/tmp/winwidget-reporting-cutover-rehearsal-$RUN_ID"
SERVER_ROOT="$APP_ROOT/winwidget.ru_server"
DEPLOY_ROOT="$APP_ROOT/deploy/backend"
ENV_FILE="$DEPLOY_ROOT/.env.production"
COMPOSE_FILE="$SERVER_ROOT/deploy/docker-compose.reporting-rehearsal.yml"
RUN_METADATA_FILE="$DEPLOY_ROOT/.reporting-rehearsal-run-v1"
REVISION_METADATA_FILE="$DEPLOY_ROOT/.reporting-rehearsal-revisions-v1"
DATABASE_MARKER="$DEPLOY_ROOT/.reporting-database-lifecycle-v1"
STAGED_MARKER="$DEPLOY_ROOT/.reporting-first-rollout-staged-v1"
CUTOVER_MARKER="$DEPLOY_ROOT/.reporting-database-cutover-v1"
ADMIN_SECRET_FILE="$DEPLOY_ROOT/.reporting-postgres-admin-password"
EVIDENCE_ROOT="$DEPLOY_ROOT/reporting-cutover-rehearsal-evidence"

POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
RABBITMQ_IMAGE='rabbitmq:4.2-management-alpine@sha256:70f261eb51c4dc58eb79a3c9d9ff0f3b5dad5c76762483329a5758f3f1f053ab'
REPORTING_VOLUME='winwidget-reporting-postgres-data'
REPORTING_NETWORK='winwidget-reporting-postgres'
RABBITMQ_VOLUME="winwidget-reporting-rehearsal-rabbitmq-$RUN_ID"
DEFAULT_NETWORK='winwidget_default'
REPORTING_PORT=55435
RABBITMQ_PORT=5672
RABBITMQ_MANAGEMENT_PORT=15672

RUNTIME_PASSWORD='reporting_rehearsal_runtime_password_2026'
MIGRATION_PASSWORD='reporting_rehearsal_migration_password_2026'
BACKUP_PASSWORD='reporting_rehearsal_backup_password_2026'
RABBITMQ_PASSWORD='reporting_rehearsal_rabbitmq_password_2026'
RABBITMQ_ALTERNATE_PASSWORD='reporting_rehearsal_alternate_password_2026'
RABBITMQ_ADMIN_PASSWORD='reporting_rehearsal_admin_password_2026'
REPORTING_INTERNAL_TOKEN='reporting_rehearsal_internal_token_2026'

REHEARSAL_KIND='reporting-cutover'
DOCKER_DAEMON_IDENTITY=''
LEGACY_BASELINE_REVISION=''
REVISION_A=''
REVISION_B=''
POSTGRES_SYSTEM_IDENTIFIER_A=''
POSTGRES_CONTAINER_ID_A=''
EVIDENCE_DIGEST_A=''

fail() {
	echo "$1" >&2
	exit 1
}

source_git() {
	git -c "safe.directory=$SOURCE_ROOT" -C "$SOURCE_ROOT" "$@"
}

sha256_file() {
	sha256sum "$1" | awk '{ print $1 }'
}

validate_run_id_and_paths() {
	local expected_root parent_root canonical_root
	validate_run_id
	expected_root="/tmp/winwidget-reporting-cutover-rehearsal-$RUN_ID"
	[[ "$APP_ROOT" == "$expected_root" &&
		"$(basename -- "$APP_ROOT")" == "$(basename -- "$expected_root")" ]] ||
		fail "Unsafe Reporting rehearsal root: $APP_ROOT"
	parent_root="$(realpath -e -- "$(dirname -- "$APP_ROOT")")"
	[[ "$parent_root" == '/tmp' ]] ||
		fail 'Reporting rehearsal root parent must resolve to /tmp.'
	if [[ -e "$APP_ROOT" || -L "$APP_ROOT" ]]; then
		[[ -d "$APP_ROOT" && ! -L "$APP_ROOT" ]] ||
			fail 'Reporting rehearsal root must be a regular directory.'
		canonical_root="$(realpath -e -- "$APP_ROOT")"
		[[ "$canonical_root" == "$expected_root" ]] ||
			fail 'Reporting rehearsal root resolves outside its exact /tmp target.'
	fi
}

validate_run_id() {
	[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] ||
		fail 'REPORTING_REHEARSAL_RUN_ID must match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$.'
	[[ "$RUN_ID" != '.' && "$RUN_ID" != '..' ]] ||
		fail 'REPORTING_REHEARSAL_RUN_ID cannot be a path segment.'
}

validate_revision_mode() {
	case "$REVISION_MODE" in
	synthetic-worktree)
		[[ -z "$EXACT_REVISION" ]] ||
			fail 'REPORTING_REHEARSAL_EXACT_REVISION is forbidden in synthetic-worktree mode.'
		;;
	exact-sha)
		[[ "$EXACT_REVISION" =~ ^[0-9a-f]{40}$ ]] ||
			fail 'Exact-SHA phase-A rehearsal requires REPORTING_REHEARSAL_EXACT_REVISION as one lowercase 40-character SHA.'
		;;
	*)
		fail 'REPORTING_REHEARSAL_REVISION_MODE must be synthetic-worktree or exact-sha.'
		;;
	esac
}

validate_source_revision_request() {
	local source_head source_status
	validate_revision_mode
	[[ "$REVISION_MODE" == exact-sha ]] || return 0
	source_head="$(source_git rev-parse HEAD)" ||
		fail 'Exact-SHA phase-A rehearsal could not resolve source HEAD.'
	[[ "$source_head" == "$EXACT_REVISION" ]] ||
		fail 'Exact-SHA phase-A rehearsal source HEAD differs from REPORTING_REHEARSAL_EXACT_REVISION.'
	source_status="$(source_git status --porcelain --untracked-files=all)" ||
		fail 'Exact-SHA phase-A rehearsal could not inspect source status.'
	[[ -z "$source_status" ]] ||
		fail 'Exact-SHA phase-A rehearsal requires a clean committed source checkout.'
}

launch_inside_colima_from_darwin() {
	local action="$1" context endpoint daemon_name source_root
	validate_run_id
	[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" &&
		-z "${DOCKER_TLS_VERIFY:-}" && -z "${DOCKER_CERT_PATH:-}" ]] ||
		fail 'Unset ambient Docker connection overrides before launching the Reporting rehearsal.'
	command -v colima >/dev/null 2>&1 || fail 'Colima CLI is required for the Reporting rehearsal.'
	context="$(docker context show 2>/dev/null)" || fail 'Docker context is unavailable.'
	[[ "$context" == colima ]] || fail "Reporting rehearsal requires local Docker context colima, current context=$context."
	endpoint="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" ||
		fail 'Colima Docker endpoint identity is unavailable.'
	[[ "$endpoint" == unix:///* && "$endpoint" != *$'\n'* && "$endpoint" != *$'\r'* ]] ||
		fail 'Colima Docker context must use one exact Unix socket.'
	daemon_name="$(docker info --format '{{.Name}}' 2>/dev/null)" || fail 'Colima Docker daemon is unavailable.'
	[[ "$daemon_name" == colima ]] || fail 'Docker context does not resolve to the local Colima daemon.'
	[[ -d "$SOURCE_ROOT/.git" && ! -L "$SOURCE_ROOT" ]] ||
		fail 'Reporting rehearsal source root is not a regular Git checkout.'
	source_root="$(cd -- "$SOURCE_ROOT" && pwd -P)"
	[[ "$source_root" == /* ]] || fail 'Reporting rehearsal source root must resolve to an absolute path.'
	[[ "$action" != run ]] || validate_source_revision_request
	colima ssh -- sudo env \
		-u DOCKER_HOST \
		-u DOCKER_CONTEXT \
		-u DOCKER_TLS_VERIFY \
		-u DOCKER_CERT_PATH \
		"REPORTING_REHEARSAL_SOURCE_ROOT=$source_root" \
		"REPORTING_REHEARSAL_RUN_ID=$RUN_ID" \
		"REPORTING_REHEARSAL_BASELINE_REF=$LEGACY_BASELINE_REF" \
		"REPORTING_REHEARSAL_REVISION_MODE=$REVISION_MODE" \
		"REPORTING_REHEARSAL_EXACT_REVISION=$EXACT_REVISION" \
		bash "$source_root/scripts/test-reporting-cutover-rehearsal.sh" "$action"
}

require_colima_daemon() {
	local context endpoint identity
	[[ "$(id -u)" == '0' ]] ||
		fail 'Reporting database/RabbitMQ phase-A rehearsal must run as root inside Colima.'
	[[ "$(uname -s)" == 'Linux' ]] ||
		fail 'Reporting database/RabbitMQ phase-A rehearsal requires Linux inside Colima.'
	[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" &&
		-z "${DOCKER_TLS_VERIFY:-}" && -z "${DOCKER_CERT_PATH:-}" ]] ||
		fail 'Unset ambient Docker connection overrides before the Reporting rehearsal.'
	context="$(docker context show 2>/dev/null)" ||
		fail 'Docker context is unavailable.'
	endpoint="$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" ||
		fail 'Docker endpoint identity is unavailable.'
	[[ "$endpoint" == 'unix:///var/run/docker.sock' ]] ||
		fail "Reporting rehearsal requires the local Docker socket, current endpoint=$endpoint."
	identity="$(docker info --format '{{.ID}}|{{.Name}}|{{.ServerVersion}}' 2>/dev/null)" ||
		fail 'Local Docker daemon is unavailable.'
	[[ "$identity" =~ ^[^|[:space:]]+[|]colima[|][^|[:space:]]+$ ]] ||
		fail 'Reporting rehearsal is restricted to the local Colima daemon.'
	if [[ -n "$DOCKER_DAEMON_IDENTITY" && "$identity" != "$DOCKER_DAEMON_IDENTITY" ]]; then
		fail 'Docker daemon identity changed during the Reporting rehearsal.'
	fi
	DOCKER_DAEMON_IDENTITY="$identity"
}

metadata_value() {
	local file="$1" key="$2"
	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$file"
}

write_run_metadata() {
	local temporary="$RUN_METADATA_FILE.tmp.$$"
	install -o 0 -g 0 -m 700 -d "$APP_ROOT" "$DEPLOY_ROOT"
	{
		printf 'version=1\n'
		printf 'run_id=%s\n' "$RUN_ID"
		printf 'app_root=%s\n' "$APP_ROOT"
		printf 'source_root=%s\n' "$SOURCE_ROOT"
		printf 'daemon_identity=%s\n' "$DOCKER_DAEMON_IDENTITY"
	} >"$temporary"
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$RUN_METADATA_FILE"
}

validate_run_metadata() {
	[[ -f "$RUN_METADATA_FILE" && ! -L "$RUN_METADATA_FILE" &&
		"$(stat -c '%u:%g:%a' "$RUN_METADATA_FILE")" == '0:0:600' ]] ||
		fail 'Reporting rehearsal run metadata is missing or unsafe.'
	[[ "$(metadata_value "$RUN_METADATA_FILE" version)" == '1' &&
		"$(metadata_value "$RUN_METADATA_FILE" run_id)" == "$RUN_ID" &&
		"$(metadata_value "$RUN_METADATA_FILE" app_root)" == "$APP_ROOT" ]] ||
		fail 'Reporting rehearsal run metadata differs from the requested run.'
	DOCKER_DAEMON_IDENTITY="$(metadata_value "$RUN_METADATA_FILE" daemon_identity)"
	require_colima_daemon
}

write_revision_metadata() {
	local temporary="$REVISION_METADATA_FILE.tmp.$$"
	{
		printf 'version=1\n'
		printf 'revision_mode=%s\n' "$REVISION_MODE"
		printf 'legacy_baseline_revision=%s\n' "$LEGACY_BASELINE_REVISION"
		printf 'revision_a=%s\n' "$REVISION_A"
		printf 'revision_b=%s\n' "$REVISION_B"
	} >"$temporary"
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$REVISION_METADATA_FILE"
}

load_revision_metadata() {
	[[ -f "$REVISION_METADATA_FILE" && ! -L "$REVISION_METADATA_FILE" &&
		"$(stat -c '%u:%g:%a' "$REVISION_METADATA_FILE")" == '0:0:600' ]] ||
		fail 'Reporting rehearsal revision metadata is missing or unsafe.'
	REVISION_MODE="$(metadata_value "$REVISION_METADATA_FILE" revision_mode)"
	LEGACY_BASELINE_REVISION="$(metadata_value "$REVISION_METADATA_FILE" legacy_baseline_revision)"
	REVISION_A="$(metadata_value "$REVISION_METADATA_FILE" revision_a)"
	REVISION_B="$(metadata_value "$REVISION_METADATA_FILE" revision_b)"
	[[ ( "$REVISION_MODE" == synthetic-worktree || "$REVISION_MODE" == exact-sha ) &&
		"$LEGACY_BASELINE_REVISION" =~ ^[0-9a-f]{40}$ &&
		"$REVISION_A" =~ ^[0-9a-f]{40}$ &&
		"$REVISION_B" =~ ^[0-9a-f]{40}$ &&
		"$LEGACY_BASELINE_REVISION" != "$REVISION_A" &&
		"$REVISION_A" != "$REVISION_B" ]] ||
		fail 'Reporting rehearsal revisions are invalid or not distinct.'
}

assert_image_absent() {
	! docker image inspect "$1" >/dev/null 2>&1 ||
		fail "Reporting rehearsal image tag already exists: $1"
}

assert_port_free() {
	local port="$1"
	! ss -H -ltn | awk -v suffix=":$port" '
		index($4, suffix) == length($4) - length(suffix) + 1 { found = 1 }
		END { exit(found ? 0 : 1) }
	' || fail "Local rehearsal port is already in use: $port"
}

assert_no_existing_targets() {
	local target
	[[ ! -e "$APP_ROOT" && ! -L "$APP_ROOT" ]] ||
		fail "Reporting rehearsal root already exists: $APP_ROOT"
	[[ -z "$(docker ps -aq --filter label=com.docker.compose.project=winwidget)" ]] ||
		fail 'Docker Compose project winwidget is already present.'
	for target in "$REPORTING_VOLUME" "$RABBITMQ_VOLUME"; do
		! docker volume inspect "$target" >/dev/null 2>&1 ||
			fail "Reporting rehearsal volume target already exists: $target"
	done
	for target in "$REPORTING_NETWORK" "$DEFAULT_NETWORK"; do
		! docker network inspect "$target" >/dev/null 2>&1 ||
			fail "Reporting rehearsal network target already exists: $target"
	done
	[[ -z "$(docker ps -aq --filter label=com.winwidget.owner=reporting)" ]] ||
		fail 'A Reporting-owned container already exists on the local daemon.'
	assert_port_free "$REPORTING_PORT"
	assert_port_free "$RABBITMQ_PORT"
	assert_port_free "$RABBITMQ_MANAGEMENT_PORT"
}

copy_worktree_snapshot() {
	local tree revision_b_message source_head
	validate_source_revision_request
	LEGACY_BASELINE_REVISION="$(
		source_git rev-parse --verify --end-of-options "${LEGACY_BASELINE_REF}^{commit}"
	)" || fail "Reporting rehearsal baseline ref does not resolve: $LEGACY_BASELINE_REF"
	[[ "$LEGACY_BASELINE_REVISION" == '42c422ca4c2c3a8ce758a37773d6cb0e6b689db7' ]] ||
		fail 'Default Reporting legacy baseline must remain pinned to the reviewed exact SHA.'
	source_git merge-base --is-ancestor "$LEGACY_BASELINE_REVISION" HEAD ||
		fail 'Reporting legacy baseline must be an ancestor of source HEAD.'
	if source_git cat-file -e "$LEGACY_BASELINE_REVISION:apps/reporting" 2>/dev/null; then
		fail 'Pinned legacy baseline already contains the Reporting service.'
	fi

	source_head="$(source_git rev-parse HEAD)"
	git -c "safe.directory=$SOURCE_ROOT" clone --quiet --no-hardlinks "$SOURCE_ROOT" "$SERVER_ROOT"
	git -C "$SERVER_ROOT" config user.name 'WinWidget Reporting Rehearsal'
	git -C "$SERVER_ROOT" config user.email 'reporting-rehearsal@localhost'
	case "$REVISION_MODE" in
	synthetic-worktree)
		source_git diff --binary --no-ext-diff HEAD |
			git -C "$SERVER_ROOT" apply --binary
		source_git ls-files --others --exclude-standard -z |
			(
				cd "$SOURCE_ROOT"
				tar --null --files-from=- -cf -
			) |
			(
				cd "$SERVER_ROOT"
				tar -xf -
			)
		git -C "$SERVER_ROOT" add -A
		git -C "$SERVER_ROOT" commit --quiet --allow-empty \
			-m 'test: synthesize reporting phase-A rehearsal revision A'
		REVISION_A="$(git -C "$SERVER_ROOT" rev-parse HEAD)"
		;;
	exact-sha)
		REVISION_A="$source_head"
		[[ "$REVISION_A" == "$EXACT_REVISION" &&
			"$(git -C "$SERVER_ROOT" rev-parse HEAD)" == "$REVISION_A" &&
			-z "$(git -C "$SERVER_ROOT" status --porcelain --untracked-files=all)" ]] ||
			fail 'Exact-SHA phase-A checkout does not match the clean requested revision A.'
		;;
	esac
	git -C "$SERVER_ROOT" branch -M prod
	[[ -f "$SERVER_ROOT/scripts/reporting-database-lifecycle.sh" &&
		-f "$SERVER_ROOT/scripts/deploy-reporting-production.sh" &&
		-f "$SERVER_ROOT/apps/reporting/Dockerfile" ]] ||
		fail 'Revision A lacks the Reporting database/RabbitMQ phase-A implementation.'

	tree="$(git -C "$SERVER_ROOT" write-tree)"
	revision_b_message='test: synthesize reporting phase-A rehearsal revision B'
	REVISION_B="$(
		printf '%s\n' "$revision_b_message" |
			GIT_AUTHOR_NAME='WinWidget Reporting Rehearsal' \
			GIT_AUTHOR_EMAIL='reporting-rehearsal@localhost' \
			GIT_COMMITTER_NAME='WinWidget Reporting Rehearsal' \
			GIT_COMMITTER_EMAIL='reporting-rehearsal@localhost' \
			git -C "$SERVER_ROOT" commit-tree "$tree" -p "$REVISION_A"
	)"
	[[ "$REVISION_A" =~ ^[0-9a-f]{40}$ && "$REVISION_B" =~ ^[0-9a-f]{40}$ &&
		"$REVISION_A" != "$REVISION_B" ]] ||
		fail 'Reporting phase-A revisions A and B must be distinct exact SHAs.'
	git -C "$SERVER_ROOT" merge-base --is-ancestor "$REVISION_A" "$REVISION_B" ||
		fail 'Synthetic Reporting phase-A revision B must fast-forward revision A.'
	write_revision_metadata
}

write_rehearsal_compose() {
	local temporary="$COMPOSE_FILE.tmp.$$"
	local exclude_pattern='/deploy/docker-compose.reporting-rehearsal.yml'
	cat >"$temporary" <<'YAML'
services:
  reporting-postgres:
    image: ${REPORTING_POSTGRES_IMAGE:?REPORTING_POSTGRES_IMAGE is required}
    profiles: [reporting-database]
    labels:
      com.winwidget.owner: reporting
      com.winwidget.purpose: postgres
      com.winwidget.rehearsal: __REHEARSAL_KIND__
      com.winwidget.rehearsal.run-id: __RUN_ID__
      com.winwidget.rehearsal.app-root: __APP_ROOT__
      com.winwidget.rehearsal.config-file: __COMPOSE_FILE__
    environment:
      POSTGRES_DB: winwidget_reporting
      POSTGRES_USER: ${REPORTING_POSTGRES_ADMIN_USER:?REPORTING_POSTGRES_ADMIN_USER is required}
      POSTGRES_PASSWORD_FILE: /run/secrets/reporting-postgres-admin-password
      POSTGRES_INITDB_ARGS: --locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums
      PGDATA: /var/lib/postgresql/18/docker
    ports:
      - '127.0.0.1:${REPORTING_POSTGRES_PORT:?REPORTING_POSTGRES_PORT is required}:5432'
    volumes:
      - winwidget-reporting-postgres-data:/var/lib/postgresql
    networks: [reporting-postgres]
    secrets: [reporting-postgres-admin-password]
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready --username "$$POSTGRES_USER" --dbname "$$POSTGRES_DB"']
      interval: 2s
      timeout: 5s
      retries: 45
      start_period: 5s
    stop_grace_period: 60s
    shm_size: 256m
    mem_limit: 768m
    mem_reservation: 256m
    cpus: 1.0
    pids_limit: 200
    restart: unless-stopped

  rabbitmq:
    image: __RABBITMQ_IMAGE__
    labels:
      com.winwidget.rehearsal: __REHEARSAL_KIND__
      com.winwidget.rehearsal.run-id: __RUN_ID__
      com.winwidget.rehearsal.app-root: __APP_ROOT__
      com.winwidget.rehearsal.config-file: __COMPOSE_FILE__
    hostname: winwidget-rabbitmq
    environment:
      RABBITMQ_DEFAULT_USER: ${RABBITMQ_ADMIN_USER:?RABBITMQ_ADMIN_USER is required}
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_ADMIN_PASSWORD:?RABBITMQ_ADMIN_PASSWORD is required}
      RABBITMQ_DEFAULT_VHOST: winwidget
    ports:
      - '127.0.0.1:5672:5672'
      - '127.0.0.1:15672:15672'
    volumes:
      - winwidget-rabbitmq-data:/var/lib/rabbitmq
    healthcheck:
      test: ['CMD', 'rabbitmq-diagnostics', '-q', 'ping']
      interval: 2s
      timeout: 5s
      retries: 45
    restart: unless-stopped

  reporting-service:
    image: __RABBITMQ_IMAGE__
    labels:
      com.winwidget.rehearsal: __REHEARSAL_KIND__
      com.winwidget.rehearsal.run-id: __RUN_ID__
      com.winwidget.rehearsal.app-root: __APP_ROOT__
      com.winwidget.rehearsal.config-file: __COMPOSE_FILE__
    entrypoint: ['/bin/sh', '-c']
    command: ['trap "exit 0" TERM INT; while :; do sleep 3600; done']
    restart: 'no'

volumes:
  winwidget-reporting-postgres-data:
    external: true
    name: ${REPORTING_POSTGRES_DATA_VOLUME:?REPORTING_POSTGRES_DATA_VOLUME is required}
  winwidget-rabbitmq-data:
    external: true
    name: ${RABBITMQ_DATA_VOLUME:?RABBITMQ_DATA_VOLUME is required}

networks:
  reporting-postgres:
    name: winwidget-reporting-postgres
    driver: bridge
    internal: false
    labels:
      com.winwidget.owner: reporting
      com.winwidget.purpose: postgres-network
      com.winwidget.rehearsal: __REHEARSAL_KIND__
      com.winwidget.rehearsal.run-id: __RUN_ID__
      com.winwidget.rehearsal.app-root: __APP_ROOT__
      com.winwidget.rehearsal.config-file: __COMPOSE_FILE__
  default:
    name: winwidget_default
    labels:
      com.winwidget.rehearsal: __REHEARSAL_KIND__
      com.winwidget.rehearsal.run-id: __RUN_ID__
      com.winwidget.rehearsal.app-root: __APP_ROOT__
      com.winwidget.rehearsal.config-file: __COMPOSE_FILE__

secrets:
  reporting-postgres-admin-password:
    file: ${REPORTING_POSTGRES_ADMIN_PASSWORD_FILE:?REPORTING_POSTGRES_ADMIN_PASSWORD_FILE is required}
YAML
	sed \
		-e "s|__REHEARSAL_KIND__|$REHEARSAL_KIND|g" \
		-e "s|__RABBITMQ_IMAGE__|$RABBITMQ_IMAGE|g" \
		-e "s|__RUN_ID__|$RUN_ID|g" \
		-e "s|__APP_ROOT__|$APP_ROOT|g" \
		-e "s|__COMPOSE_FILE__|$COMPOSE_FILE|g" \
		"$temporary" >"$COMPOSE_FILE"
	rm -f -- "$temporary"
	chown 0:0 "$COMPOSE_FILE"
	chmod 600 "$COMPOSE_FILE"
	if ! grep -Fxq "$exclude_pattern" "$SERVER_ROOT/.git/info/exclude"; then
		printf '%s\n' "$exclude_pattern" >>"$SERVER_ROOT/.git/info/exclude"
	fi
	[[ -z "$(git -C "$SERVER_ROOT" status --porcelain --untracked-files=all)" ]] ||
		fail 'Rehearsal Compose fixture dirtied the protected synthetic checkout.'
}

write_rehearsal_env() {
	local revision="$1" temporary="$ENV_FILE.tmp.$$"
	{
		printf 'REPORTING_IMAGE=winwidget-reporting:git-%s\n' "$revision"
		printf 'REPORTING_REVISION=%s\n' "$revision"
		printf 'REPORTING_POSTGRES_IMAGE=%s\n' "$POSTGRES_IMAGE"
		printf 'REPORTING_POSTGRES_PORT=%s\n' "$REPORTING_PORT"
		printf 'REPORTING_POSTGRES_DATA_VOLUME=%s\n' "$REPORTING_VOLUME"
		printf 'REPORTING_POSTGRES_ADMIN_USER=winwidget_reporting_admin\n'
		printf 'REPORTING_POSTGRES_ADMIN_PASSWORD_FILE=%s\n' "$ADMIN_SECRET_FILE"
		printf 'REPORTING_DATABASE_URL=postgresql://winwidget_reporting_runtime:%s@127.0.0.1:55435/winwidget_reporting?schema=reporting&sslmode=disable\n' "$RUNTIME_PASSWORD"
		printf 'REPORTING_MIGRATION_DATABASE_URL=postgresql://winwidget_reporting_migration:%s@127.0.0.1:55435/winwidget_reporting?schema=reporting&sslmode=disable\n' "$MIGRATION_PASSWORD"
		printf 'REPORTING_BACKUP_URL=postgresql://winwidget_reporting_backup:%s@127.0.0.1:55435/winwidget_reporting?schema=reporting&sslmode=disable\n' "$BACKUP_PASSWORD"
		printf 'REPORTING_PROCESS_ROLE=all\n'
		printf 'REPORTING_LISTEN_HOST=127.0.0.1\n'
		printf 'REPORTING_PORT=4600\n'
		printf 'REPORTING_CORE_INTERNAL_BASE_URL=http://127.0.0.1:4200\n'
		printf 'REPORTING_INTERNAL_TOKEN=%s\n' "$REPORTING_INTERNAL_TOKEN"
		printf 'REPORTING_INTERNAL_TIMEOUT_MS=10000\n'
		printf 'REPORTING_SCHEDULER_ENABLED=false\n'
		printf 'REPORTING_PREFETCH=10\n'
		printf 'REPORTING_OUTBOX_BATCH_SIZE=50\n'
		printf 'REPORTING_OUTBOX_POLL_INTERVAL_MS=1000\n'
		printf 'REPORTING_OUTBOX_RETENTION_DAYS=7\n'
		printf 'DATABASE_RESTORE_PRODUCTION_ENABLED=false\n'
		printf 'DATABASE_RESTORE_PRODUCTION_PERMIT=\n'
		printf 'CORS_ALLOWED_ORIGINS=https://rehearsal.invalid\n'
		printf 'RABBITMQ_REPORTING_URL=amqp://winwidget-reporting:%s@127.0.0.1:5672/winwidget\n' "$RABBITMQ_PASSWORD"
		printf 'INTEGRATION_WORKER_KINDS=webhook,bitrix24,amo-crm,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,reporting-admin-audit,auto-renewal\n'
		printf 'RABBITMQ_ADMIN_USER=winwidget-admin\n'
		printf 'RABBITMQ_ADMIN_PASSWORD=%s\n' "$RABBITMQ_ADMIN_PASSWORD"
		printf 'RABBITMQ_DATA_VOLUME=%s\n' "$RABBITMQ_VOLUME"
	} >"$temporary"
	chmod 600 "$temporary" || {
		rm -f -- "$temporary"
		fail 'Could not preserve the rehearsal env mode.'
	}
	mv -f "$temporary" "$ENV_FILE" || {
		rm -f -- "$temporary"
		fail 'Could not replace the rehearsal env atomically.'
	}
}

set_env_value() {
	local key="$1" value="$2" temporary="$ENV_FILE.tmp.$$"
	awk -F= -v key="$key" -v value="$value" '
		$1 == key { print key "=" value; found += 1; next }
		{ print }
		END { if (found != 1) exit 1 }
	' "$ENV_FILE" >"$temporary" || {
		rm -f -- "$temporary"
		fail "Rehearsal env key must occur exactly once: $key"
	}
	chmod 600 "$temporary" || {
		rm -f -- "$temporary"
		fail 'Could not preserve the rehearsal env mode.'
	}
	mv -f "$temporary" "$ENV_FILE" || {
		rm -f -- "$temporary"
		fail 'Could not replace the rehearsal env atomically.'
	}
}

compose() {
	docker compose --project-name winwidget --env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" "$@"
}

build_reporting_image() {
	local revision="$1" image_ref
	image_ref="winwidget-reporting:git-$revision"
	assert_image_absent "$image_ref"
	docker build \
		--label "com.winwidget.rehearsal=$REHEARSAL_KIND" \
		--label "com.winwidget.rehearsal.run-id=$RUN_ID" \
		--label "com.winwidget.rehearsal.app-root=$APP_ROOT" \
		--label "com.winwidget.rehearsal.config-file=$COMPOSE_FILE" \
		--build-arg "APP_REVISION=$revision" \
		--tag "$image_ref" \
		--file "$SERVER_ROOT/apps/reporting/Dockerfile" \
		"$SERVER_ROOT/apps/reporting"
	[[ "$(docker image inspect "$image_ref" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.winwidget.rehearsal"}}|{{index .Config.Labels "com.winwidget.rehearsal.run-id"}}')" == \
		"$revision|$REHEARSAL_KIND|$RUN_ID" ]] ||
		fail "Reporting image metadata is invalid for revision $revision."
}

run_database_lifecycle() {
	local revision="$1" action="$2" checkpoint='none' argument
	local -a lifecycle_arguments=()
	shift 2
	for argument in "$@"; do
		case "$argument" in
		--checkpoint=*) checkpoint="${argument#--checkpoint=}" ;;
		*) lifecycle_arguments+=("$argument") ;;
		esac
	done
	[[ "$checkpoint" == none || "$checkpoint" == compose-up || "$checkpoint" == roles ]] ||
		fail "Unknown Reporting rehearsal checkpoint: $checkpoint"
	EXPECTED_REVISION="$revision" \
	REPORTING_REHEARSAL_COMPOSE_FILE="$COMPOSE_FILE" \
	REPORTING_REHEARSAL_KIND="$REHEARSAL_KIND" \
	REPORTING_REHEARSAL_RUN_ID="$RUN_ID" \
	REPORTING_REHEARSAL_APP_ROOT="$APP_ROOT" \
	REPORTING_REHEARSAL_CHECKPOINT="$checkpoint" \
		bash -Eeuo pipefail -c '
APP_ROOT="$REPORTING_REHEARSAL_APP_ROOT"
source "$APP_ROOT/winwidget.ru_server/scripts/reporting-database-lifecycle.sh"
REPORTING_COMPOSE_FILE="$REPORTING_REHEARSAL_COMPOSE_FILE"

docker() {
  if [[ "${1:-}" == volume && "${2:-}" == create ]]; then
    shift 2
    command docker volume create \
      --label "com.winwidget.rehearsal=$REPORTING_REHEARSAL_KIND" \
      --label "com.winwidget.rehearsal.run-id=$REPORTING_REHEARSAL_RUN_ID" \
      --label "com.winwidget.rehearsal.app-root=$REPORTING_REHEARSAL_APP_ROOT" \
      --label "com.winwidget.rehearsal.config-file=$REPORTING_REHEARSAL_COMPOSE_FILE" \
      "$@"
    return
  fi
  if [[ "${1:-}" == run ]]; then
    shift
    command docker run \
      --label "com.winwidget.rehearsal=$REPORTING_REHEARSAL_KIND" \
      --label "com.winwidget.rehearsal.run-id=$REPORTING_REHEARSAL_RUN_ID" \
      --label "com.winwidget.rehearsal.app-root=$REPORTING_REHEARSAL_APP_ROOT" \
      --label "com.winwidget.rehearsal.config-file=$REPORTING_REHEARSAL_COMPOSE_FILE" \
      "$@"
    return
  fi
  command docker "$@"
}

reporting_compose() {
  local argument saw_up=false
  for argument in "$@"; do
    [[ "$argument" == up ]] && saw_up=true
  done
  if [[ "$REPORTING_REHEARSAL_CHECKPOINT" == compose-up && "$saw_up" == true ]]; then
    echo "Injected Reporting rehearsal checkpoint before PostgreSQL Compose up." >&2
    return 86
  fi
  docker compose --project-name winwidget --env-file "$REPORTING_ENV_FILE" \
    -f "$REPORTING_COMPOSE_FILE" "$@"
}

eval "$(declare -f reporting_configure_roles_and_schema | sed "1s/reporting_configure_roles_and_schema/reporting_rehearsal_original_configure_roles_and_schema/")"
reporting_configure_roles_and_schema() {
  if [[ "$REPORTING_REHEARSAL_CHECKPOINT" == roles ]]; then
    echo "Injected Reporting rehearsal checkpoint before role reconciliation." >&2
    return 87
  fi
  reporting_rehearsal_original_configure_roles_and_schema
}

reporting_database_lifecycle_main "$@"
' reporting-database-rehearsal "$action" "${lifecycle_arguments[@]}"
}

marker_value() {
	metadata_value "$DATABASE_MARKER" "$1"
}

staged_marker_value() {
	metadata_value "$STAGED_MARKER" "$1"
}

assert_no_database_mutation() {
	[[ ! -e "$DATABASE_MARKER" && ! -L "$DATABASE_MARKER" &&
		! -e "$CUTOVER_MARKER" && ! -L "$CUTOVER_MARKER" &&
		! -e "$ADMIN_SECRET_FILE" && ! -L "$ADMIN_SECRET_FILE" ]] ||
		fail 'Reporting preflight unexpectedly created a marker or admin secret.'
	! docker volume inspect "$REPORTING_VOLUME" >/dev/null 2>&1 ||
		fail 'Reporting preflight unexpectedly created the PostgreSQL volume.'
	! docker network inspect "$REPORTING_NETWORK" >/dev/null 2>&1 ||
		fail 'Reporting preflight unexpectedly created the PostgreSQL network.'
	[[ -z "$(docker ps -aq --filter label=com.winwidget.owner=reporting --filter label=com.winwidget.purpose=postgres)" ]] ||
		fail 'Reporting preflight unexpectedly created the PostgreSQL container.'
}

assert_marker_rejects_byte_drift() {
	local drift_marker="$DEPLOY_ROOT/.reporting-staged-marker-byte-drift"
	cp -p "$STAGED_MARKER" "$drift_marker"
	printf '\n' >>"$drift_marker"
	if APP_ROOT="$APP_ROOT" REPORTING_REHEARSAL_DRIFT_MARKER="$drift_marker" \
		bash -Eeuo pipefail -c '
source "$APP_ROOT/winwidget.ru_server/scripts/reporting-database-lifecycle.sh"
REPORTING_FIRST_ROLLOUT_STAGED_MARKER="$REPORTING_REHEARSAL_DRIFT_MARKER"
reporting_validate_first_rollout_staged_marker
' reporting-marker-drift >/dev/null 2>&1; then
		rm -f -- "$drift_marker"
		fail 'Reporting staged marker validator accepted appended-byte drift.'
	fi
	rm -f -- "$drift_marker"
}

exercise_preflight_no_mutation() {
	local env_snapshot="$DEPLOY_ROOT/.reporting-env-before-invalid-preflight"
	local env_hash staged_hash image_id resources_before resources_after
	cp -p "$ENV_FILE" "$env_snapshot"
	env_hash="$(sha256_file "$ENV_FILE")"
	staged_hash="$(sha256_file "$STAGED_MARKER")"
	image_id="$(docker image inspect "winwidget-reporting:git-$REVISION_A" --format '{{.Id}}')"
	resources_before="$(docker ps -aq --filter "label=com.winwidget.rehearsal.run-id=$RUN_ID" | LC_ALL=C sort)"
	set_env_value REPORTING_INTERNAL_TOKEN short
	if run_database_lifecycle "$REVISION_A" preflight-env prepare >/dev/null 2>&1; then
		cp -p "$env_snapshot" "$ENV_FILE"
		rm -f -- "$env_snapshot"
		fail 'Invalid Reporting env preflight unexpectedly succeeded.'
	fi
	cp -p "$env_snapshot" "$ENV_FILE"
	cmp -s "$ENV_FILE" "$env_snapshot" || fail 'Reporting env bytes changed during failed preflight.'
	[[ "$(sha256_file "$ENV_FILE")" == "$env_hash" &&
		"$(sha256_file "$STAGED_MARKER")" == "$staged_hash" &&
		"$(staged_marker_value revision)" == "$REVISION_A" &&
		"$(docker image inspect "winwidget-reporting:git-$REVISION_A" --format '{{.Id}}')" == "$image_id" ]] ||
		fail 'Failed Reporting preflight changed immutable input identity.'
	resources_after="$(docker ps -aq --filter "label=com.winwidget.rehearsal.run-id=$RUN_ID" | LC_ALL=C sort)"
	[[ "$resources_after" == "$resources_before" ]] ||
		fail 'Failed Reporting preflight changed labelled container state.'
	assert_no_database_mutation
	rm -f -- "$env_snapshot"
	assert_marker_rejects_byte_drift
	run_database_lifecycle "$REVISION_A" preflight-env prepare >/dev/null
	assert_no_database_mutation
}

assert_owned_volume() {
	local volume="$1" purpose="$2" revision="${3:-}" identity
	identity="$(docker volume inspect "$volume" --format '{{index .Labels "com.winwidget.rehearsal"}}|{{index .Labels "com.winwidget.rehearsal.run-id"}}|{{index .Labels "com.winwidget.rehearsal.app-root"}}|{{index .Labels "com.winwidget.rehearsal.config-file"}}|{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}|{{index .Labels "com.winwidget.lifecycle.revision"}}')"
	if [[ "$purpose" == postgres-data ]]; then
		[[ "$identity" == "$REHEARSAL_KIND|$RUN_ID|$APP_ROOT|$COMPOSE_FILE|reporting|postgres-data|$revision" ]] ||
			fail "Reporting PostgreSQL volume is not owned by this exact rehearsal: $volume"
	else
		[[ "$identity" == "$REHEARSAL_KIND|$RUN_ID|$APP_ROOT|$COMPOSE_FILE||rabbitmq-data|" ]] ||
			fail "RabbitMQ volume is not owned by this exact rehearsal: $volume"
	fi
}

assert_owned_network() {
	local network="$1" expected_key="$2" identity
	identity="$(docker network inspect "$network" --format '{{index .Labels "com.winwidget.rehearsal"}}|{{index .Labels "com.winwidget.rehearsal.run-id"}}|{{index .Labels "com.winwidget.rehearsal.app-root"}}|{{index .Labels "com.winwidget.rehearsal.config-file"}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}')"
	[[ "$identity" == "$REHEARSAL_KIND|$RUN_ID|$APP_ROOT|$COMPOSE_FILE|winwidget|$expected_key" ]] ||
		fail "Docker network is not owned by this exact Reporting rehearsal: $network"
}

assert_owned_container() {
	local container="$1" expected_service="${2:-}" identity
	identity="$(docker inspect "$container" --format '{{index .Config.Labels "com.winwidget.rehearsal"}}|{{index .Config.Labels "com.winwidget.rehearsal.run-id"}}|{{index .Config.Labels "com.winwidget.rehearsal.app-root"}}|{{index .Config.Labels "com.winwidget.rehearsal.config-file"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}')"
	[[ "$identity" == "$REHEARSAL_KIND|$RUN_ID|$APP_ROOT|$COMPOSE_FILE|winwidget|$expected_service" ||
		( -z "$expected_service" && "$identity" == "$REHEARSAL_KIND|$RUN_ID|$APP_ROOT|$COMPOSE_FILE||" ) ]] ||
		fail "Docker container is not owned by this exact Reporting rehearsal: $container"
}

assert_owned_image() {
	local image="$1" revision="$2" identity
	identity="$(docker image inspect "$image" --format '{{index .Config.Labels "com.winwidget.rehearsal"}}|{{index .Config.Labels "com.winwidget.rehearsal.run-id"}}|{{index .Config.Labels "com.winwidget.rehearsal.app-root"}}|{{index .Config.Labels "com.winwidget.rehearsal.config-file"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}')"
	[[ "$identity" == "$REHEARSAL_KIND|$RUN_ID|$APP_ROOT|$COMPOSE_FILE|$revision" ]] ||
		fail "Docker image is not owned by this exact Reporting rehearsal: $image"
}

assert_database_prepared() {
	local revision="$1" expected_system_identifier="${2:-}" container_id system_identifier
	[[ -f "$DATABASE_MARKER" && ! -L "$DATABASE_MARKER" &&
		"$(stat -c '%u:%g:%a' "$DATABASE_MARKER")" == '0:0:600' &&
		"$(marker_value phase)" == prepared &&
		"$(marker_value revision)" == "$revision" &&
		"$(marker_value target_volume)" == "$REPORTING_VOLUME" ]] ||
		fail "Reporting database marker is not prepared at revision $revision."
	container_id="$(marker_value container_id)"
	system_identifier="$(marker_value postgres_system_identifier)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ && "$system_identifier" =~ ^[0-9]+$ ]] ||
		fail 'Prepared Reporting PostgreSQL identity is incomplete.'
	[[ "$(compose --profile reporting-database ps --status running -q reporting-postgres)" == "$container_id" ]] ||
		fail 'Prepared Reporting PostgreSQL container differs from the marker.'
	assert_owned_container "$container_id" reporting-postgres
	assert_owned_volume "$REPORTING_VOLUME" postgres-data "$revision"
	assert_owned_network "$REPORTING_NETWORK" reporting-postgres
	[[ -z "$expected_system_identifier" || "$system_identifier" == "$expected_system_identifier" ]] ||
		fail 'Prepared Reporting PostgreSQL system identifier changed unexpectedly.'
	printf '%s|%s\n' "$container_id" "$system_identifier"
}

wait_for_container_health() {
	local container="$1" attempt health
	for ((attempt = 1; attempt <= 90; attempt++)); do
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
		[[ "$health" == healthy ]] && return
		sleep 1
	done
	fail "Container did not become healthy: $container"
}

wait_for_rabbitmq_app() {
	local container="$1" attempt
	for ((attempt = 1; attempt <= 90; attempt++)); do
		if docker exec "$container" rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
			return
		fi
		sleep 1
	done
	fail "RabbitMQ application did not become ready: $container"
}

create_shared_rabbitmq_exchanges() {
	local container="$1"
	RABBITMQ_REHEARSAL_ADMIN_PASSWORD="$RABBITMQ_ADMIN_PASSWORD" \
		docker exec -e RABBITMQ_REHEARSAL_ADMIN_PASSWORD "$container" sh -euc '
for exchange in winwidget.events winwidget.dead-letter; do
  rabbitmqadmin --vhost winwidget --username winwidget-admin \
    --password "$RABBITMQ_REHEARSAL_ADMIN_PASSWORD" \
    declare exchange --name "$exchange" --type topic --durable true \
    --non-interactive >/dev/null
done
'
}

delete_shared_rabbitmq_exchange() {
	local container="$1" exchange="$2"
	[[ "$exchange" == winwidget.events || "$exchange" == winwidget.dead-letter ]] ||
		fail 'Refusing to delete an exchange outside the isolated Reporting rehearsal set.'
	RABBITMQ_REHEARSAL_ADMIN_PASSWORD="$RABBITMQ_ADMIN_PASSWORD" \
		docker exec -e RABBITMQ_REHEARSAL_ADMIN_PASSWORD "$container" sh -euc '
rabbitmqadmin --vhost winwidget --username winwidget-admin \
  --password "$RABBITMQ_REHEARSAL_ADMIN_PASSWORD" \
  delete exchange --name "$1" --non-interactive >/dev/null
' rabbitmq-delete-exchange "$exchange"
}

rabbitmq_user_exists() {
	local container="$1"
	docker exec "$container" rabbitmqctl --silent list_users |
		cut -f1 | grep -Fqx -- winwidget-reporting
}

rabbitmq_authenticates() {
	local container="$1" password="$2"
	docker exec "$container" rabbitmqctl authenticate_user winwidget-reporting "$password" >/dev/null 2>&1
}

rabbitmq_boundary_snapshot() {
	local container="$1"
	{
		docker exec "$container" rabbitmqctl --silent list_users |
			awk '$1 == "winwidget-reporting" { print }'
		docker exec "$container" rabbitmqctl --silent list_user_permissions winwidget-reporting |
			LC_ALL=C sort
		docker exec "$container" rabbitmqctl --silent list_user_topic_permissions winwidget-reporting |
			LC_ALL=C sort
	} | sha256sum | awk '{ print $1 }'
}

assert_rabbitmq_user_has_no_tags() {
	local container="$1" row
	row="$(docker exec "$container" rabbitmqctl --silent list_users |
		awk '$1 == "winwidget-reporting" { print; found += 1 } END { exit(found == 1 ? 0 : 1) }')" ||
		fail 'Reporting RabbitMQ user is missing or duplicated.'
	[[ "$row" == *'[]' ]] || fail 'Reporting RabbitMQ user unexpectedly retains privileged tags.'
}

exercise_rabbitmq_phase_a() {
	local rabbitmq_container reporting_container snapshot_before snapshot_after version
	docker volume create \
		--label "com.winwidget.rehearsal=$REHEARSAL_KIND" \
		--label "com.winwidget.rehearsal.run-id=$RUN_ID" \
		--label "com.winwidget.rehearsal.app-root=$APP_ROOT" \
		--label "com.winwidget.rehearsal.config-file=$COMPOSE_FILE" \
		--label com.winwidget.purpose=rabbitmq-data \
		"$RABBITMQ_VOLUME" >/dev/null
	assert_owned_volume "$RABBITMQ_VOLUME" rabbitmq-data
	compose up -d rabbitmq
	rabbitmq_container="$(compose ps --status running -q rabbitmq)"
	[[ "$rabbitmq_container" =~ ^[0-9a-f]{64}$ ]] || fail 'RabbitMQ rehearsal container is ambiguous.'
	assert_owned_container "$rabbitmq_container" rabbitmq
	assert_owned_network "$DEFAULT_NETWORK" default
	wait_for_container_health "$rabbitmq_container"
	[[ "$(docker inspect "$rabbitmq_container" --format '{{.Config.Image}}')" == "$RABBITMQ_IMAGE" ]] ||
		fail 'RabbitMQ rehearsal container does not use the reviewed production image tag.'
	version="$(docker exec "$rabbitmq_container" rabbitmqctl version | tr -d '[:space:]')"
	[[ "$version" == 4.2.* ]] || fail "Reporting rehearsal requires RabbitMQ 4.2, got $version."

	(
		source "$SERVER_ROOT/scripts/deploy-reporting-production.sh" --self-test >/dev/null
		REPORTING_COMPOSE_FILE="$COMPOSE_FILE"
		reporting_compose() {
			command docker compose --project-name winwidget --env-file "$ENV_FILE" \
				-f "$REPORTING_COMPOSE_FILE" "$@"
		}
		if reporting_provision_initial_rabbitmq_user winwidget-reporting "$RABBITMQ_PASSWORD" >/dev/null 2>&1; then
			fail 'RabbitMQ provisioning mutated an absent user before shared exchanges existed.'
		fi
		! rabbitmq_user_exists "$rabbitmq_container" ||
			fail 'Failed RabbitMQ shared-exchange preflight created the Reporting user.'
		create_shared_rabbitmq_exchanges "$rabbitmq_container"
		reporting_provision_initial_rabbitmq_user winwidget-reporting "$RABBITMQ_PASSWORD"
		reporting_require_rabbitmq_preflight winwidget-reporting "$RABBITMQ_PASSWORD"
		rabbitmq_authenticates "$rabbitmq_container" "$RABBITMQ_PASSWORD" ||
			fail 'Initial Reporting RabbitMQ user does not authenticate.'
		assert_rabbitmq_user_has_no_tags "$rabbitmq_container"

		docker exec "$rabbitmq_container" rabbitmqctl set_user_tags \
			winwidget-reporting administrator >/dev/null
		if reporting_require_rabbitmq_preflight \
			winwidget-reporting "$RABBITMQ_PASSWORD" >/dev/null 2>&1; then
			fail 'Reporting RabbitMQ preflight accepted an administrator-tagged user.'
		fi
		reporting_provision_initial_rabbitmq_user winwidget-reporting "$RABBITMQ_PASSWORD"
		reporting_require_rabbitmq_preflight winwidget-reporting "$RABBITMQ_PASSWORD"
		assert_rabbitmq_user_has_no_tags "$rabbitmq_container"

		delete_shared_rabbitmq_exchange "$rabbitmq_container" winwidget.dead-letter
		if reporting_provision_initial_rabbitmq_user winwidget-reporting "$RABBITMQ_ALTERNATE_PASSWORD" >/dev/null 2>&1; then
			fail 'RabbitMQ provisioning mutated credentials while a shared exchange was missing.'
		fi
		rabbitmq_authenticates "$rabbitmq_container" "$RABBITMQ_PASSWORD" ||
			fail 'Shared-exchange failure changed the active Reporting password.'
		! rabbitmq_authenticates "$rabbitmq_container" "$RABBITMQ_ALTERNATE_PASSWORD" ||
			fail 'Shared-exchange failure rotated the Reporting password.'
		create_shared_rabbitmq_exchanges "$rabbitmq_container"

		docker exec "$rabbitmq_container" rabbitmqctl add_vhost reporting-rehearsal-extra >/dev/null
		docker exec "$rabbitmq_container" rabbitmqctl set_permissions \
			-p reporting-rehearsal-extra winwidget-reporting '.*' '.*' '.*' >/dev/null
		docker exec "$rabbitmq_container" rabbitmqctl clear_topic_permissions \
			-p winwidget winwidget-reporting >/dev/null
		if reporting_require_rabbitmq_preflight winwidget-reporting "$RABBITMQ_PASSWORD" >/dev/null 2>&1; then
			fail 'Reporting RabbitMQ preflight accepted partial permissions.'
		fi
		reporting_provision_initial_rabbitmq_user winwidget-reporting "$RABBITMQ_PASSWORD"
		reporting_require_rabbitmq_preflight winwidget-reporting "$RABBITMQ_PASSWORD"
		assert_rabbitmq_user_has_no_tags "$rabbitmq_container"
		[[ -z "$(docker exec "$rabbitmq_container" rabbitmqctl --silent list_user_permissions winwidget-reporting | awk '$1 == "reporting-rehearsal-extra" { print }')" ]] ||
			fail 'Reporting RabbitMQ resume retained permissions in another vhost.'

		snapshot_before="$(rabbitmq_boundary_snapshot "$rabbitmq_container")"
		reporting_provision_initial_rabbitmq_user winwidget-reporting "$RABBITMQ_PASSWORD"
		snapshot_after="$(rabbitmq_boundary_snapshot "$rabbitmq_container")"
		[[ "$snapshot_after" == "$snapshot_before" ]] ||
			fail 'Idempotent Reporting RabbitMQ provisioning changed the exact boundary.'

		compose up -d reporting-service
		reporting_container="$(compose ps --status running -q reporting-service)"
		[[ "$reporting_container" =~ ^[0-9a-f]{64}$ ]] || fail 'Running Reporting sentinel is ambiguous.'
		assert_owned_container "$reporting_container" reporting-service
		if reporting_provision_initial_rabbitmq_user winwidget-reporting "$RABBITMQ_ALTERNATE_PASSWORD" >/dev/null 2>&1; then
			fail 'Running Reporting container did not block credential rotation.'
		fi
		rabbitmq_authenticates "$rabbitmq_container" "$RABBITMQ_PASSWORD" ||
			fail 'Running-container guard changed the active Reporting password.'
		! rabbitmq_authenticates "$rabbitmq_container" "$RABBITMQ_ALTERNATE_PASSWORD" ||
			fail 'Running-container guard rotated the Reporting password.'
		compose stop reporting-service >/dev/null
		if reporting_provision_initial_rabbitmq_user winwidget-reporting "$RABBITMQ_ALTERNATE_PASSWORD" >/dev/null 2>&1; then
			fail 'Stopped Reporting container did not block credential rotation.'
		fi
		rabbitmq_authenticates "$rabbitmq_container" "$RABBITMQ_PASSWORD" ||
			fail 'Stopped-container guard changed the active Reporting password.'
		! rabbitmq_authenticates "$rabbitmq_container" "$RABBITMQ_ALTERNATE_PASSWORD" ||
			fail 'Stopped-container guard rotated the Reporting password.'
		compose rm -f reporting-service >/dev/null
	)

	compose restart rabbitmq >/dev/null
	wait_for_container_health "$rabbitmq_container"
	wait_for_rabbitmq_app "$rabbitmq_container"
	(
		source "$SERVER_ROOT/scripts/deploy-reporting-production.sh" --self-test >/dev/null
		REPORTING_COMPOSE_FILE="$COMPOSE_FILE"
		reporting_compose() {
			command docker compose --project-name winwidget --env-file "$ENV_FILE" \
				-f "$REPORTING_COMPOSE_FILE" "$@"
		}
		reporting_require_rabbitmq_preflight winwidget-reporting "$RABBITMQ_PASSWORD"
	)
	printf 'rabbitmq_version=%s\n' "$version" >"$DEPLOY_ROOT/.reporting-rehearsal-rabbitmq-version"
	chmod 600 "$DEPLOY_ROOT/.reporting-rehearsal-rabbitmq-version"
}

evidence_tree_digest() {
	local directory="$1"
	find "$directory" -type f -print0 |
		LC_ALL=C sort -z |
		xargs -0 sha256sum |
		sha256sum | awk '{ print $1 }'
}

archive_revision_a_evidence() {
	local directory="$EVIDENCE_ROOT/revision-a" container_id system_identifier
	local rabbitmq_container rabbitmq_version temporary
	[[ ! -e "$CUTOVER_MARKER" && ! -L "$CUTOVER_MARKER" ]] ||
		fail 'Reporting cutover marker exists beyond the rehearsal safe boundary.'
	[[ -z "$(compose ps -a -q reporting-service 2>/dev/null || true)" ]] ||
		fail 'Reporting service must be absent at the database rollback boundary.'
	container_id="$(marker_value container_id)"
	system_identifier="$(marker_value postgres_system_identifier)"
	rabbitmq_container="$(compose ps --status running -q rabbitmq)"
	rabbitmq_version="$(sed -n 's/^rabbitmq_version=//p' "$DEPLOY_ROOT/.reporting-rehearsal-rabbitmq-version")"
	install -o 0 -g 0 -m 700 -d "$EVIDENCE_ROOT" "$directory"
	cp -p "$STAGED_MARKER" "$directory/staged-marker.exact"
	cp -p "$DATABASE_MARKER" "$directory/database-marker.exact"
	temporary="$directory/manifest.tmp.$$"
	{
		printf 'version=1\n'
		printf 'run_id=%s\n' "$RUN_ID"
		printf 'revision_mode=%s\n' "$REVISION_MODE"
		printf 'legacy_baseline_revision=%s\n' "$LEGACY_BASELINE_REVISION"
		printf 'revision_a=%s\n' "$REVISION_A"
		printf 'revision_b=%s\n' "$REVISION_B"
		printf 'database_container_id=%s\n' "$container_id"
		printf 'database_system_identifier=%s\n' "$system_identifier"
		printf 'database_volume=%s\n' "$REPORTING_VOLUME"
		printf 'rabbitmq_version=%s\n' "$rabbitmq_version"
		printf 'rabbitmq_boundary_sha256=%s\n' "$(rabbitmq_boundary_snapshot "$rabbitmq_container")"
		printf 'env_sha256=%s\n' "$(sha256_file "$ENV_FILE")"
		printf 'staged_marker_sha256=%s\n' "$(sha256_file "$directory/staged-marker.exact")"
		printf 'database_marker_sha256=%s\n' "$(sha256_file "$directory/database-marker.exact")"
	} >"$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$directory/manifest"
	EVIDENCE_DIGEST_A="$(evidence_tree_digest "$directory")"
	[[ "$EVIDENCE_DIGEST_A" =~ ^[0-9a-f]{64}$ ]] || fail 'Revision-A evidence digest is invalid.'
}

safe_remove_local_file() {
	local file="$1"
	[[ "$file" == "$DEPLOY_ROOT"/* ]] || fail "Refusing to remove file outside rehearsal deploy root: $file"
	if [[ -e "$file" || -L "$file" ]]; then
		[[ -f "$file" && ! -L "$file" && "$(stat -c '%u' "$file")" == '0' ]] ||
			fail "Refusing to remove unsafe rehearsal file: $file"
		rm -f -- "$file"
	fi
}

remove_database_resources_for_restart() {
	local container_id
	[[ "$(marker_value phase)" == prepared && "$(marker_value revision)" == "$REVISION_A" ]] ||
		fail 'Local Reporting rollback requires the prepared revision-A marker.'
	[[ ! -e "$CUTOVER_MARKER" && ! -L "$CUTOVER_MARKER" ]] ||
		fail 'Local Reporting rollback is forbidden after cutover initialization.'
	[[ -z "$(compose ps -a -q reporting-service 2>/dev/null || true)" ]] ||
		fail 'Local Reporting rollback is forbidden while a Reporting service container exists.'
	container_id="$(marker_value container_id)"
	assert_owned_container "$container_id" reporting-postgres
	assert_owned_volume "$REPORTING_VOLUME" postgres-data "$REVISION_A"
	assert_owned_network "$REPORTING_NETWORK" reporting-postgres
	docker rm -f "$container_id" >/dev/null
	docker network rm "$REPORTING_NETWORK" >/dev/null
	docker volume rm "$REPORTING_VOLUME" >/dev/null
	safe_remove_local_file "$ADMIN_SECRET_FILE"
	safe_remove_local_file "$DATABASE_MARKER"
	safe_remove_local_file "$STAGED_MARKER"
	! docker container inspect "$container_id" >/dev/null 2>&1 || fail 'Revision-A PostgreSQL container survived rollback.'
	! docker network inspect "$REPORTING_NETWORK" >/dev/null 2>&1 || fail 'Revision-A PostgreSQL network survived rollback.'
	! docker volume inspect "$REPORTING_VOLUME" >/dev/null 2>&1 || fail 'Revision-A PostgreSQL volume survived rollback.'
	[[ "$(evidence_tree_digest "$EVIDENCE_ROOT/revision-a")" == "$EVIDENCE_DIGEST_A" ]] ||
		fail 'Revision-A evidence changed during local rollback.'
}

advance_to_revision_b() {
	git -C "$SERVER_ROOT" merge --quiet --ff-only "$REVISION_B"
	[[ "$(git -C "$SERVER_ROOT" rev-parse HEAD)" == "$REVISION_B" &&
		"$(git -C "$SERVER_ROOT" branch --show-current)" == prod &&
		-z "$(git -C "$SERVER_ROOT" status --porcelain --untracked-files=all)" ]] ||
		fail 'Reporting rehearsal restart did not reach a clean exact revision B.'
	set_env_value REPORTING_IMAGE "winwidget-reporting:git-$REVISION_B"
	set_env_value REPORTING_REVISION "$REVISION_B"
	build_reporting_image "$REVISION_B"
	run_database_lifecycle "$REVISION_B" stage >/dev/null
	run_database_lifecycle "$REVISION_B" preflight-env prepare >/dev/null
	[[ "$(staged_marker_value revision)" == "$REVISION_B" ]] ||
		fail 'Reporting restart did not stage exact revision B.'
}

exercise_prepare_rollback_restart_prepare() {
	local prepared_identity marker_hash secret_hash container_id_b system_identifier_b
	echo 'rehearsal_phase=prepare-a'
	if run_database_lifecycle "$REVISION_A" prepare --checkpoint=compose-up >/dev/null 2>&1; then
		fail 'Injected pre-Compose Reporting prepare checkpoint unexpectedly completed.'
	fi
	[[ -f "$DATABASE_MARKER" && "$(marker_value phase)" == preparing &&
		"$(marker_value revision)" == "$REVISION_A" &&
		-f "$ADMIN_SECRET_FILE" ]] ||
		fail 'Reporting prepare did not preserve resumable marker/secret state.'
	assert_owned_volume "$REPORTING_VOLUME" postgres-data "$REVISION_A"
	! docker network inspect "$REPORTING_NETWORK" >/dev/null 2>&1 ||
		fail 'Pre-Compose checkpoint unexpectedly created the Reporting network.'
	run_database_lifecycle "$REVISION_A" prepare >/dev/null
	prepared_identity="$(assert_database_prepared "$REVISION_A")"
	POSTGRES_CONTAINER_ID_A="${prepared_identity%%|*}"
	POSTGRES_SYSTEM_IDENTIFIER_A="${prepared_identity#*|}"
	marker_hash="$(sha256_file "$DATABASE_MARKER")"
	secret_hash="$(sha256_file "$ADMIN_SECRET_FILE")"
	run_database_lifecycle "$REVISION_A" prepare >/dev/null
	[[ "$(sha256_file "$DATABASE_MARKER")" == "$marker_hash" &&
		"$(sha256_file "$ADMIN_SECRET_FILE")" == "$secret_hash" ]] ||
		fail 'Idempotent Reporting prepare changed its marker or admin secret.'
	assert_database_prepared "$REVISION_A" "$POSTGRES_SYSTEM_IDENTIFIER_A" >/dev/null

	exercise_rabbitmq_phase_a
	archive_revision_a_evidence
	echo 'rehearsal_phase=rollback-a'
	remove_database_resources_for_restart

	echo 'rehearsal_phase=restart-b'
	advance_to_revision_b
	if run_database_lifecycle "$REVISION_B" prepare --checkpoint=roles >/dev/null 2>&1; then
		fail 'Injected pre-role Reporting prepare checkpoint unexpectedly completed.'
	fi
	[[ "$(marker_value phase)" == preparing && "$(marker_value revision)" == "$REVISION_B" ]] ||
		fail 'Pre-role checkpoint did not preserve a resumable revision-B marker.'
	container_id_b="$(compose --profile reporting-database ps --status running -q reporting-postgres)"
	[[ "$container_id_b" =~ ^[0-9a-f]{64}$ && "$container_id_b" != "$POSTGRES_CONTAINER_ID_A" ]] ||
		fail 'Revision-B checkpoint did not create a distinct healthy PostgreSQL container.'
	wait_for_container_health "$container_id_b"
	assert_owned_container "$container_id_b" reporting-postgres
	assert_owned_volume "$REPORTING_VOLUME" postgres-data "$REVISION_B"

	echo 'rehearsal_phase=prepare-b'
	run_database_lifecycle "$REVISION_B" prepare >/dev/null
	prepared_identity="$(assert_database_prepared "$REVISION_B")"
	container_id_b="${prepared_identity%%|*}"
	system_identifier_b="${prepared_identity#*|}"
	[[ "$container_id_b" != "$POSTGRES_CONTAINER_ID_A" &&
		"$system_identifier_b" != "$POSTGRES_SYSTEM_IDENTIFIER_A" ]] ||
		fail 'Reporting restart reused revision-A PostgreSQL identity.'
	marker_hash="$(sha256_file "$DATABASE_MARKER")"
	secret_hash="$(sha256_file "$ADMIN_SECRET_FILE")"
	run_database_lifecycle "$REVISION_B" prepare >/dev/null
	[[ "$(sha256_file "$DATABASE_MARKER")" == "$marker_hash" &&
		"$(sha256_file "$ADMIN_SECRET_FILE")" == "$secret_hash" &&
		"$(evidence_tree_digest "$EVIDENCE_ROOT/revision-a")" == "$EVIDENCE_DIGEST_A" ]] ||
		fail 'Final idempotent prepare changed durable revision-A/B evidence.'
	[[ ! -e "$CUTOVER_MARKER" && ! -L "$CUTOVER_MARKER" ]] ||
		fail 'Reporting rehearsal crossed the approved database-only safe boundary.'
	(
		source "$SERVER_ROOT/scripts/deploy-reporting-production.sh" --self-test >/dev/null
		REPORTING_COMPOSE_FILE="$COMPOSE_FILE"
		reporting_compose() {
			command docker compose --project-name winwidget --env-file "$ENV_FILE" \
				-f "$REPORTING_COMPOSE_FILE" "$@"
		}
		reporting_require_rabbitmq_preflight winwidget-reporting "$RABBITMQ_PASSWORD"
		reporting_provision_initial_rabbitmq_user winwidget-reporting "$RABBITMQ_PASSWORD"
		reporting_require_rabbitmq_preflight winwidget-reporting "$RABBITMQ_PASSWORD"
	)
}

validate_cleanup_container() {
	local container="$1" service
	service="$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.service"}}')"
	case "$service" in
		reporting-postgres | rabbitmq | reporting-service) assert_owned_container "$container" "$service" ;;
		'') assert_owned_container "$container" '' ;;
		*) fail "Unexpected labelled Reporting rehearsal container service: $service" ;;
	esac
}

cleanup_rehearsal() {
	local container network volume image cleanup_failed=false
	validate_run_id_and_paths
	[[ -d "$APP_ROOT" && ! -L "$APP_ROOT" && "$(stat -c '%u:%a' "$APP_ROOT")" == '0:700' ]] ||
		fail "Exact root-owned Reporting rehearsal root is required for cleanup: $APP_ROOT"
	validate_run_metadata
	if [[ ! -e "$REVISION_METADATA_FILE" && ! -L "$REVISION_METADATA_FILE" ]]; then
		[[ -z "$(docker ps -aq --filter "label=com.winwidget.rehearsal=$REHEARSAL_KIND" --filter "label=com.winwidget.rehearsal.run-id=$RUN_ID")" ]] ||
			fail 'Revision metadata is absent while labelled rehearsal containers exist.'
		for network in "$REPORTING_NETWORK" "$DEFAULT_NETWORK"; do
			! docker network inspect "$network" >/dev/null 2>&1 ||
				fail 'Revision metadata is absent while a canonical rehearsal network exists.'
		done
		for volume in "$REPORTING_VOLUME" "$RABBITMQ_VOLUME"; do
			! docker volume inspect "$volume" >/dev/null 2>&1 ||
				fail 'Revision metadata is absent while a canonical rehearsal volume exists.'
		done
		rm -rf -- "$APP_ROOT"
		[[ ! -e "$APP_ROOT" && ! -L "$APP_ROOT" ]] ||
			fail 'Early Reporting rehearsal root remains after exact cleanup.'
		return
	fi
	load_revision_metadata

	while IFS= read -r container; do
		[[ -n "$container" ]] || continue
		validate_cleanup_container "$container"
		docker rm -f "$container" >/dev/null || cleanup_failed=true
	done < <(docker ps -aq --filter "label=com.winwidget.rehearsal=$REHEARSAL_KIND" --filter "label=com.winwidget.rehearsal.run-id=$RUN_ID")

	for network in "$REPORTING_NETWORK" "$DEFAULT_NETWORK"; do
		docker network inspect "$network" >/dev/null 2>&1 || continue
		case "$network" in
			"$REPORTING_NETWORK") assert_owned_network "$network" reporting-postgres ;;
			"$DEFAULT_NETWORK") assert_owned_network "$network" default ;;
		esac
		docker network rm "$network" >/dev/null || cleanup_failed=true
	done
	for volume in "$REPORTING_VOLUME" "$RABBITMQ_VOLUME"; do
		docker volume inspect "$volume" >/dev/null 2>&1 || continue
		case "$volume" in
			"$REPORTING_VOLUME")
				if [[ -f "$DATABASE_MARKER" && ! -L "$DATABASE_MARKER" ]]; then
					assert_owned_volume "$volume" postgres-data "$(marker_value revision)"
				else
					local volume_revision
					volume_revision="$(docker volume inspect "$volume" --format '{{index .Labels "com.winwidget.lifecycle.revision"}}')"
					[[ "$volume_revision" == "$REVISION_A" || "$volume_revision" == "$REVISION_B" ]] ||
						fail 'Reporting cleanup volume has an unknown lifecycle revision.'
					assert_owned_volume "$volume" postgres-data "$volume_revision"
				fi
				;;
			"$RABBITMQ_VOLUME") assert_owned_volume "$volume" rabbitmq-data ;;
		esac
		docker volume rm "$volume" >/dev/null || cleanup_failed=true
	done
	for image in "winwidget-reporting:git-$REVISION_A" "winwidget-reporting:git-$REVISION_B"; do
		docker image inspect "$image" >/dev/null 2>&1 || continue
		case "$image" in
			*"$REVISION_A") assert_owned_image "$image" "$REVISION_A" ;;
			*"$REVISION_B") assert_owned_image "$image" "$REVISION_B" ;;
		esac
		docker image rm "$image" >/dev/null || cleanup_failed=true
	done

	[[ -z "$(docker ps -aq --filter "label=com.winwidget.rehearsal=$REHEARSAL_KIND" --filter "label=com.winwidget.rehearsal.run-id=$RUN_ID")" ]] || cleanup_failed=true
	for network in "$REPORTING_NETWORK" "$DEFAULT_NETWORK"; do
		! docker network inspect "$network" >/dev/null 2>&1 || cleanup_failed=true
	done
	for volume in "$REPORTING_VOLUME" "$RABBITMQ_VOLUME"; do
		! docker volume inspect "$volume" >/dev/null 2>&1 || cleanup_failed=true
	done
	for image in "winwidget-reporting:git-$REVISION_A" "winwidget-reporting:git-$REVISION_B"; do
		! docker image inspect "$image" >/dev/null 2>&1 || cleanup_failed=true
	done
	[[ "$cleanup_failed" == false ]] ||
		fail "Reporting rehearsal cleanup was incomplete; retained $APP_ROOT for inspection."
	validate_run_id_and_paths
	rm -rf -- "$APP_ROOT"
	[[ ! -e "$APP_ROOT" && ! -L "$APP_ROOT" ]] ||
		fail 'Reporting rehearsal root remains after exact cleanup.'
}

reporting_rehearsal_self_test() {
	local source_text temporary_root test_env forbidden_database_key forbidden_production_root
	local forbidden_system_prune forbidden_volume_prune forbidden_container_prune
	local forbidden_rabbitmq_declare forbidden_rabbitmq_delete
	local test_revision='0123456789abcdef0123456789abcdef01234567'
	source_text="$(<"${BASH_SOURCE[0]}")"
	forbidden_database_key='DATABASE_URL_''PRODUCTION'
	forbidden_production_root='/opt/''winwidget'
	forbidden_system_prune='docker system ''prune'
	forbidden_volume_prune='docker volume ''prune'
	forbidden_container_prune='docker container ''prune'
	forbidden_rabbitmq_declare='declare exchange ''name='
	forbidden_rabbitmq_delete='delete exchange ''name='
	[[ "$source_text" == *"LEGACY_BASELINE_REF=\"\${REPORTING_REHEARSAL_BASELINE_REF:-42c422ca4c2c3a8ce758a37773d6cb0e6b689db7}\""* &&
		"$source_text" == *'REVISION_MODE="${REPORTING_REHEARSAL_REVISION_MODE:-synthetic-worktree}"'* &&
		"$source_text" == *"RABBITMQ_IMAGE='rabbitmq:4.2-management-alpine@sha256:70f261eb51c4dc58eb79a3c9d9ff0f3b5dad5c76762483329a5758f3f1f053ab'"* &&
		"$source_text" == *'Darwin) launch_inside_colima_from_darwin run'* &&
		"$source_text" == *'colima ssh -- sudo env'* &&
		"$source_text" == *'-u DOCKER_HOST'* &&
		"$source_text" == *'rehearsal_phase=prepare-a'* &&
		"$source_text" == *'rehearsal_phase=rollback-a'* &&
		"$source_text" == *'rehearsal_phase=restart-b'* &&
		"$source_text" == *'rehearsal_phase=prepare-b'* &&
		"$source_text" == *'REPORTING_REHEARSAL_CHECKPOINT="$checkpoint"'* &&
		"$source_text" == *"printf 'DATABASE_RESTORE_PRODUCTION_ENABLED=false\\n'"* &&
		"$source_text" == *"printf 'DATABASE_RESTORE_PRODUCTION_PERMIT=\\n'"* &&
		"$source_text" == *'compose-up'* && "$source_text" == *'roles'* &&
		"$source_text" == *'cmp -s "$ENV_FILE" "$env_snapshot"'* &&
		"$source_text" == *'source "$SERVER_ROOT/scripts/deploy-reporting-production.sh" --self-test'* &&
		"$source_text" == *'RabbitMQ 4.2'* &&
		"$source_text" == *'declare exchange --name "$exchange" --type topic --durable true'* &&
		"$source_text" == *'delete exchange --name "$1" --non-interactive'* &&
		"$source_text" != *"$forbidden_rabbitmq_declare"* &&
		"$source_text" != *"$forbidden_rabbitmq_delete"* &&
		"$source_text" == *'RabbitMQ provisioning mutated credentials while a shared exchange was missing.'* &&
		"$source_text" == *'Reporting RabbitMQ preflight accepted an administrator-tagged user.'* &&
		"$source_text" == *'Running Reporting container did not block credential rotation.'* &&
		"$source_text" == *'Stopped Reporting container did not block credential rotation.'* &&
		"$source_text" == *'wait_for_rabbitmq_app "$rabbitmq_container"'* &&
		"$source_text" == *'rabbitmq-diagnostics -q ping'* &&
		"$source_text" == *'source_git status --porcelain --untracked-files=all'* &&
		"$source_text" == *'REVISION_A="$source_head"'* &&
		"$source_text" == *'Reporting database/RabbitMQ phase-A rehearsal passed'* &&
		"$source_text" == *'This is not a full production cutover.'* &&
		"$source_text" == *'reporting_require_rabbitmq_preflight'* &&
		"$source_text" == *'assert_owned_container'* &&
		"$source_text" == *'assert_owned_volume'* &&
		"$source_text" == *'assert_owned_network'* &&
		"$source_text" == *'assert_owned_image'* &&
		"$source_text" != *"$forbidden_system_prune"* &&
		"$source_text" != *"$forbidden_volume_prune"* &&
		"$source_text" != *"$forbidden_container_prune"* &&
		"$source_text" != *"$forbidden_database_key"* &&
		"$source_text" != *"$forbidden_production_root"* ]] ||
		fail 'Reporting database/RabbitMQ phase-A rehearsal static contract is incomplete or references a forbidden production boundary.'

	(
		REVISION_MODE=exact-sha
		EXACT_REVISION="$test_revision"
		source_git() {
			case "$1" in
			rev-parse) printf '%s\n' "$test_revision" ;;
			status) return 0 ;;
			*) return 1 ;;
			esac
		}
		validate_source_revision_request
	) || fail 'Exact-SHA phase-A source validation rejected a clean matching HEAD.'
	if (
		REVISION_MODE=exact-sha
		EXACT_REVISION="$test_revision"
		source_git() {
			case "$1" in
			rev-parse) printf '%s\n' "$test_revision" ;;
			status) printf '%s\n' ' M tracked-file' ;;
			*) return 1 ;;
			esac
		}
		validate_source_revision_request
	) >/dev/null 2>&1; then
		fail 'Exact-SHA phase-A source validation accepted a dirty checkout.'
	fi
	if (
		REVISION_MODE=exact-sha
		EXACT_REVISION='ffffffffffffffffffffffffffffffffffffffff'
		source_git() {
			case "$1" in
			rev-parse) printf '%s\n' "$test_revision" ;;
			status) return 0 ;;
			*) return 1 ;;
			esac
		}
		validate_source_revision_request
	) >/dev/null 2>&1; then
		fail 'Exact-SHA phase-A source validation accepted a different HEAD.'
	fi

	temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/winwidget-reporting-rehearsal-self-test.XXXXXX")"
	test_env="$temporary_root/env"
	printf 'ONE=first\nTWO=second\n' >"$test_env"
	(
		ENV_FILE="$test_env"
		set_env_value TWO replacement
		[[ "$(sed -n '2p' "$test_env")" == 'TWO=replacement' &&
			"$(wc -l <"$test_env" | tr -d '[:space:]')" == '2' ]]
	) || {
		rm -rf -- "$temporary_root"
		fail 'Reporting rehearsal env updater is not exact.'
	}
	rm -rf -- "$temporary_root"
	echo 'Reporting database/RabbitMQ phase-A rehearsal static contracts passed; Docker was not invoked.'
}

run_rehearsal() {
	validate_run_id_and_paths
	require_colima_daemon
	SOURCE_ROOT="$(realpath -e -- "$SOURCE_ROOT")" || fail 'Reporting rehearsal source root does not exist.'
	[[ -d "$SOURCE_ROOT/.git" && ! -L "$SOURCE_ROOT" ]] ||
		fail 'Reporting rehearsal source root is not a Git checkout.'
	validate_source_revision_request
	assert_no_existing_targets
	write_run_metadata
	copy_worktree_snapshot
	write_rehearsal_compose
	write_rehearsal_env "$REVISION_A"
	compose --profile reporting-database config --quiet
	assert_image_absent "winwidget-reporting:git-$REVISION_A"
	assert_image_absent "winwidget-reporting:git-$REVISION_B"
	build_reporting_image "$REVISION_A"
	run_database_lifecycle "$REVISION_A" stage >/dev/null
	[[ "$(staged_marker_value revision)" == "$REVISION_A" ]] ||
		fail 'Reporting rehearsal did not stage exact revision A.'
	exercise_preflight_no_mutation
	exercise_prepare_rollback_restart_prepare
	if [[ "$REVISION_MODE" == exact-sha ]]; then
		echo "Reporting database/RabbitMQ phase-A rehearsal passed for actual committed revision A $REVISION_A and synthetic fast-forward revision B $REVISION_B."
	else
		echo "Reporting database/RabbitMQ phase-A rehearsal passed for synthetic working-tree revisions $REVISION_A -> $REVISION_B."
	fi
	echo 'This is not a full production cutover. No cutover marker, Core mutation, producer activation or production path was used.'
	echo "Run exact cleanup: REPORTING_REHEARSAL_RUN_ID=$RUN_ID bash scripts/test-reporting-cutover-rehearsal.sh cleanup"
}

usage() {
	echo "Usage: $0 run|cleanup|--self-test|--help"
	echo "Post-commit gate: REPORTING_REHEARSAL_REVISION_MODE=exact-sha REPORTING_REHEARSAL_EXACT_REVISION=<sha> $0 run"
}

case "${1:-run}" in
run)
	[[ $# == 0 || $# == 1 ]] || fail 'The Reporting rehearsal run action accepts no extra arguments.'
	case "$(uname -s)" in
	Darwin) launch_inside_colima_from_darwin run ;;
	Linux) run_rehearsal ;;
	*) fail 'Reporting database/RabbitMQ phase-A rehearsal supports only a Darwin host or Linux inside Colima.' ;;
	esac
	;;
cleanup)
	[[ $# == 1 ]] || fail 'The Reporting rehearsal cleanup action accepts no extra arguments.'
	case "$(uname -s)" in
	Darwin) launch_inside_colima_from_darwin cleanup ;;
	Linux) cleanup_rehearsal ;;
	*) fail 'Reporting database/RabbitMQ phase-A rehearsal cleanup supports only a Darwin host or Linux inside Colima.' ;;
	esac
	;;
--self-test)
	[[ $# == 1 ]] || fail 'The Reporting rehearsal self-test accepts no extra arguments.'
	reporting_rehearsal_self_test
	;;
--help)
	usage
	;;
*)
	usage >&2
	exit 1
	;;
esac
