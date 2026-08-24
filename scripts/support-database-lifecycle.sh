#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SUPPORT_SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
support_database_marker="${SUPPORT_DATABASE_MARKER:-$APP_ROOT/deploy/backend/.support-database-lifecycle-v1}"
readonly SUPPORT_DATABASE_POSTGRES_IMAGE='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly SUPPORT_DATABASE_POSTGRES_VOLUME='winwidget-support-postgres-data'
readonly SUPPORT_STEADY_INTEGRATION_WORKER_KINDS='campaign-admin-audit,reporting-admin-audit,widgets-admin-audit,billing-admin-audit,identity-admin-audit,platform-admin-audit,support-admin-audit,billing-payment-projection,billing-subscription-projection,billing-affiliate-projection'

# shellcheck source=scripts/support-release-identity.sh
declare -F support_release_compose >/dev/null ||
	source "$SUPPORT_SCRIPT_ROOT/scripts/support-release-identity.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
declare -F database_restore_guard_assert_before_mutation >/dev/null ||
	source "$SUPPORT_SCRIPT_ROOT/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/production-deploy-lock.sh
declare -F acquire_production_deploy_lock >/dev/null ||
	source "$SUPPORT_SCRIPT_ROOT/scripts/production-deploy-lock.sh"

support_database_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

support_database_require_root() {
	[[ "$(id -u)" == '0' && "$(uname -s)" == 'Linux' ]] ||
		support_database_fail 'Support database lifecycle must run as root on Linux.'
}

support_database_wait_for_postgres() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{64}$ ]] || return 1
	local container_id="$1"
	for _ in {1..60}; do
		[[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" == 'healthy' ]] && return 0
		sleep 2
	done
	support_database_fail 'Support PostgreSQL did not become healthy.'
}

support_database_validate_bound_identity() {
	support_database_validate_marker || return 1
	[[ "$(support_database_marker_value phase)" =~ ^(prepared|forward-only|active|complete)$ &&
		"$(support_database_marker_value ownership_revision)" == "$EXPECTED_REVISION" ]] ||
		support_database_fail 'Bound Support marker does not match the lifecycle revision.' || return 1
	local volume image image_id marker_image_id container_id admin_file admin_password
	local database_id system_identifier container_identity volume_identity
	volume="$(support_read_env_value "$ENV_FILE" SUPPORT_POSTGRES_DATA_VOLUME)" || return 1
	image="$(support_release_image "$EXPECTED_REVISION")" || return 1
	marker_image_id="$(support_database_marker_value image_id)" || return 1
	image_id="$(docker image inspect --format '{{.Id}}' "$image")" || return 1
	[[ "$volume" == "$(support_database_marker_value volume)" &&
		"$image_id" == "$marker_image_id" &&
		"$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' "$image_id")" == "$EXPECTED_REVISION|support" ]] ||
		support_database_fail 'Bound Support image or volume identity changed.' || return 1
	volume_identity="$(docker volume inspect --format '{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}' "$volume")" || return 1
	[[ "$volume_identity" == 'support|postgres-data' ]] ||
		support_database_fail 'Bound Support volume ownership changed.' || return 1
	support_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile support-database up -d support-postgres
	container_id="$(support_release_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" --profile support-database ps -q support-postgres)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		support_database_fail 'Bound Support PostgreSQL container is missing.' || return 1
	support_database_wait_for_postgres "$container_id" || return 1
	container_identity="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.winwidget.owner"}}|{{.State.Health.Status}}' "$container_id")" || return 1
	[[ "$container_identity" == 'support-postgres|support|healthy' ]] ||
		support_database_fail 'Bound Support PostgreSQL runtime identity changed.' || return 1
	admin_file="$(support_read_env_value "$ENV_FILE" SUPPORT_POSTGRES_ADMIN_PASSWORD_FILE)"
	[[ "$admin_file" == /* && -f "$admin_file" && ! -L "$admin_file" &&
		"$(stat -c '%u:%g:%a' "$admin_file")" == '0:0:600' ]] ||
		support_database_fail 'Support PostgreSQL admin password file is unsafe.' || return 1
	admin_password="$(tr -d '\r\n' <"$admin_file")"
	database_id="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" psql \
		--no-psqlrc --no-password --tuples-only --no-align \
		--username winwidget_support_admin --dbname winwidget_support \
		--command "SELECT database_id::text FROM support.service_identity WHERE service_name = 'support-service';")"
	system_identifier="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" psql \
		--no-psqlrc --no-password --tuples-only --no-align \
		--username winwidget_support_admin --dbname postgres \
		--command "SELECT (pg_control_system()).system_identifier;")"
	unset admin_password
	[[ "$database_id" == "$(support_database_marker_value database_id)" &&
		"$system_identifier" == "$(support_database_marker_value database_system_identifier)" ]] ||
		support_database_fail 'Bound Support database identity changed.'
}

support_database_validate_prepared_identity() {
	[[ "$(support_database_marker_value phase)" == 'prepared' ]] ||
		support_database_fail 'Prepared Support identity validation requires phase=prepared.' || return 1
	support_database_validate_bound_identity
}

support_database_normalize_csv() {
	[[ $# -eq 1 ]] || return 1
	tr ',' '\n' <<<"$1" |
		sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
		sed '/^$/d' |
		LC_ALL=C sort -u |
		paste -sd, -
}

support_database_require_inputs() {
	local identity_token core_token
	support_release_validate_revision "$EXPECTED_REVISION" || return 1
	support_release_validate_file "$ENV_FILE" || return 1
	support_release_validate_file "$COMPOSE_FILE" || return 1
	support_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION"
	for key in SUPPORT_POSTGRES_IMAGE SUPPORT_POSTGRES_PORT \
		SUPPORT_POSTGRES_DATA_VOLUME SUPPORT_POSTGRES_ADMIN_USER \
		SUPPORT_POSTGRES_ADMIN_PASSWORD_FILE SUPPORT_DATABASE_URL \
		SUPPORT_MIGRATION_DATABASE_URL SUPPORT_BACKUP_URL \
		SUPPORT_INTERNAL_BASE_URL SUPPORT_API_PORT SUPPORT_WORKER_PORT \
		SUPPORT_OUTBOX_PUBLISHER_PORT SUPPORT_RESTORE_DRILL_EVIDENCE_FILE \
		IDENTITY_INTERNAL_BASE_URL IDENTITY_INTERNAL_TIMEOUT_MS \
		IDENTITY_SUPPORT_TOKEN SUPPORT_CORE_TOKEN \
		RABBITMQ_SUPPORT_WORKER_URL RABBITMQ_SUPPORT_PUBLISHER_URL \
		RABBITMQ_INTEGRATION_WORKER_URL RABBITMQ_VHOST INTEGRATION_WORKER_KINDS; do
		[[ -n "$(support_read_env_value "$ENV_FILE" "$key")" ]] ||
			support_database_fail "Support database env key is missing: $key" || return 1
	done
	[[ "$(support_read_env_value "$ENV_FILE" SUPPORT_POSTGRES_IMAGE)" == "$SUPPORT_DATABASE_POSTGRES_IMAGE" &&
		"$(support_read_env_value "$ENV_FILE" SUPPORT_POSTGRES_DATA_VOLUME)" == "$SUPPORT_DATABASE_POSTGRES_VOLUME" &&
		"$(support_read_env_value "$ENV_FILE" SUPPORT_POSTGRES_PORT)" == '55440' &&
		"$(support_read_env_value "$ENV_FILE" SUPPORT_POSTGRES_ADMIN_USER)" == 'winwidget_support_admin' &&
		"$(support_read_env_value "$ENV_FILE" SUPPORT_INTERNAL_BASE_URL)" == 'http://127.0.0.1:5100' &&
		"$(support_read_env_value "$ENV_FILE" SUPPORT_API_PORT)" == '5100' &&
		"$(support_read_env_value "$ENV_FILE" SUPPORT_WORKER_PORT)" == '5101' &&
		"$(support_read_env_value "$ENV_FILE" SUPPORT_OUTBOX_PUBLISHER_PORT)" == '5102' &&
		"$(support_read_env_value "$ENV_FILE" IDENTITY_INTERNAL_BASE_URL)" == 'http://127.0.0.1:4900' &&
		"$(support_read_env_value "$ENV_FILE" IDENTITY_INTERNAL_TIMEOUT_MS)" == '5000' &&
		"$(support_read_env_value "$ENV_FILE" SUPPORT_RESTORE_DRILL_EVIDENCE_FILE)" == '/opt/winwidget/deploy/backend/.support-restore-drill-evidence-v1.json' ]] ||
		support_database_fail 'Support PostgreSQL or internal HTTP contract differs from the release contract.' || return 1
	[[ "$(support_database_normalize_csv "$(support_read_env_value "$ENV_FILE" INTEGRATION_WORKER_KINDS)")" == \
		"$(support_database_normalize_csv "$SUPPORT_STEADY_INTEGRATION_WORKER_KINDS")" ]] ||
		support_database_fail 'Core integration-worker ownership is not the exact post-Support contract.' || return 1
	identity_token="$(support_read_env_value "$ENV_FILE" IDENTITY_SUPPORT_TOKEN)" || return 1
	core_token="$(support_read_env_value "$ENV_FILE" SUPPORT_CORE_TOKEN)" || return 1
	[[ ${#identity_token} -ge 32 && ${#core_token} -ge 32 &&
		"$identity_token" != change_me* && "$identity_token" != change-me* &&
		"$identity_token" != ci_* && "$core_token" != change_me* &&
		"$core_token" != change-me* && "$core_token" != ci_* &&
		"$identity_token" != "$core_token" ]] ||
		support_database_fail 'Support internal credentials must be non-placeholder and audience-scoped.'
}

support_database_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z_]+$ && -f "$support_database_marker" &&
		! -L "$support_database_marker" ]] || return 1
	awk -F= -v key="$1" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$support_database_marker"
}

support_database_current_phase() {
	if [[ ! -e "$support_database_marker" && ! -L "$support_database_marker" ]]; then
		printf 'absent\n'
		return
	fi
	support_database_validate_marker || return 1
	support_database_marker_value phase
}

support_database_validate_marker() {
	[[ -f "$support_database_marker" && ! -L "$support_database_marker" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$support_database_marker")" == '0:0:600' ]] || return 1
	fi
	awk -F= '
		$1 !~ /^(version|phase|ownership_revision|cleanup_revision|volume|image_id|database_id|database_system_identifier|updated_at)$/ { exit 1 }
		{ seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
		END {
			if (seen["version"] != 1 || value["version"] != "1" ||
				seen["phase"] != 1 || value["phase"] !~ /^(preparing|prepared|aborted|forward-only|active|complete)$/ ||
				seen["ownership_revision"] != 1 || value["ownership_revision"] !~ /^[0-9a-f]{40}$/ ||
				seen["volume"] != 1 || value["volume"] !~ /^[A-Za-z0-9][A-Za-z0-9_.-]+$/ ||
				seen["image_id"] != 1 || value["image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				seen["database_id"] != 1 || value["database_id"] !~ /^(pending|[0-9a-f-]{36})$/ ||
				seen["database_system_identifier"] != 1 || value["database_system_identifier"] !~ /^(pending|[1-9][0-9]*)$/ ||
				seen["cleanup_revision"] != 1 || value["cleanup_revision"] !~ /^(pending|[0-9a-f]{40})$/ ||
				seen["updated_at"] != 1 || value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
		}
	' "$support_database_marker"
}

support_database_transition_allowed() {
	case "$1:$2" in
	absent:preparing | aborted:preparing | preparing:preparing | preparing:prepared | prepared:prepared | \
		prepared:aborted | preparing:aborted | prepared:forward-only | \
		forward-only:forward-only | forward-only:active | active:active | \
		active:complete | complete:complete) return 0 ;;
	*) return 1 ;;
	esac
}

support_database_write_marker() {
	[[ $# -eq 6 ]] || return 1
	local phase="$1" revision="$2" volume="$3" image_id="$4"
	local database_id="$5" system_identifier="$6" current temporary
	current="$(support_database_current_phase 2>/dev/null || printf absent)"
	support_database_transition_allowed "$current" "$phase" ||
		support_database_fail "Unsafe Support lifecycle transition: $current -> $phase" || return 1
	mkdir -p "$(dirname "$support_database_marker")"
	temporary="${support_database_marker}.tmp.$$"
	{
		printf 'version=1\n'
		printf 'phase=%s\n' "$phase"
		printf 'ownership_revision=%s\n' "$revision"
		printf 'cleanup_revision=pending\n'
		printf 'volume=%s\n' "$volume"
		printf 'image_id=%s\n' "$image_id"
		printf 'database_id=%s\n' "$database_id"
		printf 'database_system_identifier=%s\n' "$system_identifier"
		printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"
	chmod 600 "$temporary"
	mv -f -- "$temporary" "$support_database_marker"
	support_database_validate_marker
}

support_database_image_id() {
	local image
	image="$(support_release_image "$EXPECTED_REVISION")" || return 1
	docker image inspect --format '{{.Id}}' "$image"
}

support_database_url_field() {
	[[ $# -eq 2 && "$2" =~ ^(username|password|hostname|port|database|schema)$ ]] || return 1
	local value image
	value="$(support_read_env_value "$ENV_FILE" "$1")" || return 1
	image="$(support_release_image "$EXPECTED_REVISION")" || return 1
	docker run --rm --network none --log-driver none \
		--env "SUPPORT_PARSE_URL=$value" --entrypoint node "$image" -e '
const value = process.env.SUPPORT_PARSE_URL;
const field = process.argv[1];
const parsed = new URL(value);
const fields = {
  username: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  hostname: parsed.hostname,
  port: parsed.port,
  database: parsed.pathname.slice(1),
  schema: parsed.searchParams.get("schema") || "",
};
if (!fields[field] || /[\u0000-\u001f\u007f]/.test(fields[field])) process.exit(1);
process.stdout.write(fields[field]);
' "$2"
}

support_database_validate_urls() {
	local contract key role
	for contract in \
		'SUPPORT_DATABASE_URL:winwidget_support_runtime' \
		'SUPPORT_MIGRATION_DATABASE_URL:winwidget_support_migration' \
		'SUPPORT_BACKUP_URL:winwidget_support_backup'; do
		key="${contract%%:*}"
		role="${contract#*:}"
		[[ "$(support_database_url_field "$key" username)" == "$role" &&
			"$(support_database_url_field "$key" hostname)" == '127.0.0.1' &&
			"$(support_database_url_field "$key" port)" == '55440' &&
			"$(support_database_url_field "$key" database)" == 'winwidget_support' &&
			"$(support_database_url_field "$key" schema)" == 'support' ]] ||
			support_database_fail "Support URL role/host/database contract failed: $key" || return 1
	done
}

support_database_prepare() {
	support_database_require_root
	support_release_require_local_docker
	support_database_require_inputs
	acquire_production_deploy_lock 'Support database prepare'
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	local phase volume image image_id admin_file admin_password
	local migration_password runtime_password backup_password container_id
	local database_id system_identifier acl_state
	phase="$(support_database_current_phase)" || return 1
	case "$phase" in
	prepared)
		support_database_validate_prepared_identity
		printf 'support_database_phase=prepared\n'
		return
		;;
	absent | aborted | preparing) ;;
	*) support_database_fail "Support prepare is forbidden from phase=$phase." || return 1 ;;
	esac
	volume="$(support_read_env_value "$ENV_FILE" SUPPORT_POSTGRES_DATA_VOLUME)"
	image="$(support_release_image "$EXPECTED_REVISION")"
	support_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		build --pull support-api
	image_id="$(docker image inspect --format '{{.Id}}' "$image")"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$EXPECTED_REVISION" &&
		"$(docker image inspect --format '{{.Config.User}}' "$image")" != '' &&
		"$(docker image inspect --format '{{.Config.User}}' "$image")" != 'root' &&
		"$(docker image inspect --format '{{.Config.User}}' "$image")" != '0' ]] ||
		support_database_fail 'Support image is mutable, root, or revision-mismatched.' || return 1
	support_database_validate_urls
	if docker volume inspect "$volume" >/dev/null 2>&1; then
		[[ "$(docker volume inspect --format '{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}' "$volume")" == 'support|postgres-data' ]] ||
			support_database_fail 'Existing Support volume lacks exact ownership labels.' || return 1
	else
		docker volume create --label com.winwidget.owner=support \
			--label com.winwidget.purpose=postgres-data "$volume" >/dev/null
	fi
	support_database_write_marker preparing "$EXPECTED_REVISION" "$volume" \
		"$image_id" pending pending
	support_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile support-database up -d support-postgres
	container_id="$(support_release_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" --profile support-database ps -q support-postgres)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		support_database_fail 'Support PostgreSQL container is missing.' || return 1
	support_database_wait_for_postgres "$container_id" || return 1
	admin_file="$(support_read_env_value "$ENV_FILE" SUPPORT_POSTGRES_ADMIN_PASSWORD_FILE)"
	[[ "$admin_file" == /* && -f "$admin_file" && ! -L "$admin_file" &&
		"$(stat -c '%u:%g:%a' "$admin_file")" == '0:0:600' ]] ||
		support_database_fail 'Support PostgreSQL admin password file is unsafe.' || return 1
	admin_password="$(tr -d '\r\n' <"$admin_file")"
	migration_password="$(support_database_url_field SUPPORT_MIGRATION_DATABASE_URL password)"
	runtime_password="$(support_database_url_field SUPPORT_DATABASE_URL password)"
	backup_password="$(support_database_url_field SUPPORT_BACKUP_URL password)"
	docker exec -i -e "PGPASSWORD=$admin_password" \
		"$container_id" psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 \
		--set "MIGRATION_PASSWORD=$migration_password" \
		--set "RUNTIME_PASSWORD=$runtime_password" \
		--set "BACKUP_PASSWORD=$backup_password" \
		--username winwidget_support_admin --dbname postgres <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_support_migration', :'MIGRATION_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_support_migration') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_support_runtime', :'RUNTIME_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_support_runtime') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_support_backup', :'BACKUP_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_support_backup') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_support_migration', :'MIGRATION_PASSWORD') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_support_runtime', :'RUNTIME_PASSWORD') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_support_backup', :'BACKUP_PASSWORD') \gexec
GRANT pg_signal_backend TO winwidget_support_admin;
GRANT winwidget_support_migration, winwidget_support_runtime, winwidget_support_backup TO winwidget_support_admin;
REVOKE ALL ON DATABASE winwidget_support FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_support TO winwidget_support_migration, winwidget_support_runtime, winwidget_support_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_support FROM winwidget_support_migration, winwidget_support_runtime, winwidget_support_backup;
\connect winwidget_support
CREATE SCHEMA IF NOT EXISTS support AUTHORIZATION winwidget_support_migration;
ALTER SCHEMA support OWNER TO winwidget_support_migration;
REVOKE ALL ON SCHEMA support FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA support TO winwidget_support_migration;
GRANT USAGE ON SCHEMA support TO winwidget_support_runtime, winwidget_support_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_support_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_support_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support
  GRANT SELECT ON TABLES TO winwidget_support_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support
  GRANT SELECT ON SEQUENCES TO winwidget_support_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, winwidget_support_runtime, winwidget_support_backup;
SQL
	unset admin_password migration_password runtime_password backup_password
	support_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile support-migration run --rm --no-deps support-migrate
	admin_password="$(tr -d '\r\n' <"$admin_file")"
	docker exec -i -e "PGPASSWORD=$admin_password" "$container_id" psql --no-psqlrc \
		--no-password --set ON_ERROR_STOP=1 --username winwidget_support_admin \
		--dbname winwidget_support <<'SQL'
REVOKE ALL ON SCHEMA support FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA support TO winwidget_support_migration;
REVOKE CREATE ON SCHEMA support FROM winwidget_support_runtime, winwidget_support_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA support FROM PUBLIC, winwidget_support_runtime, winwidget_support_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA support FROM PUBLIC, winwidget_support_runtime, winwidget_support_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA support FROM PUBLIC, winwidget_support_runtime, winwidget_support_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA support TO winwidget_support_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA support TO winwidget_support_runtime;
REVOKE ALL ON TABLE support._prisma_migrations FROM winwidget_support_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA support TO winwidget_support_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA support TO winwidget_support_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support REVOKE ALL ON TABLES FROM PUBLIC, winwidget_support_runtime, winwidget_support_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support REVOKE ALL ON SEQUENCES FROM PUBLIC, winwidget_support_runtime, winwidget_support_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, winwidget_support_runtime, winwidget_support_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_support_runtime, winwidget_support_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_support_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_support_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support GRANT SELECT ON TABLES TO winwidget_support_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_support_migration IN SCHEMA support GRANT SELECT ON SEQUENCES TO winwidget_support_backup;
SQL
	acl_state="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" psql \
		--no-psqlrc --no-password --tuples-only --no-align \
		--username winwidget_support_admin --dbname winwidget_support \
		--command "
			SELECT current_database() = 'winwidget_support',
				current_setting('server_version_num')::integer / 10000 = 18,
				current_setting('data_checksums') = 'on',
				(SELECT count(*) = 4 FROM pg_roles WHERE rolname IN
					('winwidget_support_admin','winwidget_support_migration',
					 'winwidget_support_runtime','winwidget_support_backup')),
				NOT has_schema_privilege('winwidget_support_runtime', 'support', 'CREATE'),
				NOT has_table_privilege('winwidget_support_runtime', 'support._prisma_migrations', 'SELECT'),
				has_table_privilege('winwidget_support_backup', 'support._prisma_migrations', 'SELECT'),
				NOT has_table_privilege('winwidget_support_backup', 'support.outbox_events', 'INSERT');")"
	[[ "$acl_state" == 't|t|t|t|t|t|t|t' ]] ||
		support_database_fail 'Support PostgreSQL support and least-privilege ACL verification failed.' || return 1
	database_id="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" psql \
		--no-psqlrc --no-password --tuples-only --no-align \
		--username winwidget_support_admin --dbname winwidget_support \
		--command "SELECT database_id::text FROM support.service_identity WHERE service_name = 'support-service';")"
	system_identifier="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" psql \
		--no-psqlrc --no-password --tuples-only --no-align \
		--username winwidget_support_admin --dbname postgres \
		--command "SELECT (pg_control_system()).system_identifier;")"
	unset admin_password
	[[ "$database_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
		"$system_identifier" =~ ^[1-9][0-9]*$ ]] ||
		support_database_fail 'Support database identity is missing after migration.' || return 1
	support_database_write_marker prepared "$EXPECTED_REVISION" "$volume" \
		"$image_id" "$database_id" "$system_identifier"
	printf 'support_database_phase=prepared\n'
}

support_database_advance() {
	[[ $# -eq 1 && "$1" =~ ^(forward-only|active|complete)$ ]] || return 1
	support_database_validate_marker || return 1
	[[ "$(support_database_marker_value ownership_revision)" == "$EXPECTED_REVISION" ]] ||
		support_database_fail 'Support lifecycle marker belongs to another revision.' || return 1
	support_database_write_marker "$1" "$EXPECTED_REVISION" \
		"$(support_database_marker_value volume)" \
		"$(support_database_marker_value image_id)" \
		"$(support_database_marker_value database_id)" \
		"$(support_database_marker_value database_system_identifier)"
}

support_database_abort_prepare() {
	support_database_require_root
	support_release_require_local_docker
	support_database_require_inputs
	[[ "${SUPPORT_ABORT_CONFIRMATION:-}" == 'ABORT SUPPORT PREPARE' ]] ||
		support_database_fail 'Support prepare abort requires exact confirmation.' || return 1
	local phase
	phase="$(support_database_current_phase)"
	case "$phase" in
	preparing | prepared) ;;
	forward-only | active | complete)
		support_database_fail 'Support ownership is forward-only; Core ownership rollback is forbidden.'
		return 1
		;;
	*) support_database_fail "Support prepare abort is unavailable from phase=$phase."; return 1 ;;
	esac
	acquire_production_deploy_lock 'Support database abort'
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	support_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop -t 90 support-api support-worker support-outbox-publisher support-postgres || true
	support_database_write_marker aborted "$EXPECTED_REVISION" \
		"$(support_database_marker_value volume)" \
		"$(support_database_marker_value image_id)" \
		"$(support_database_marker_value database_id)" \
		"$(support_database_marker_value database_system_identifier)"
	printf 'support_database_phase=aborted\n'
}

support_database_status() {
	local phase
	phase="$(support_database_current_phase)" || return 1
	printf 'support_database_phase=%s\n' "$phase"
	if [[ "$phase" != 'absent' ]]; then
		printf 'support_database_revision=%s\n' "$(support_database_marker_value ownership_revision)"
		printf 'support_database_volume=%s\n' "$(support_database_marker_value volume)"
	fi
}

support_database_guard_marker_state() {
	[[ $# -eq 3 ]] || return 1
	local marker="$1" phase_pattern="$2" revision_key="$3"
	[[ -f "$marker" && ! -L "$marker" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$marker")" == '0:0:600' ]] || return 1
	fi
	awk -F= -v phases="$phase_pattern" -v revision_key="$revision_key" '
		$1 == "phase" { phase=substr($0, index($0, "=") + 1); phase_count += 1 }
		$1 == revision_key { revision=substr($0, index($0, "=") + 1); revision_count += 1 }
		END {
			if (phase_count != 1 || revision_count != 1 || phase !~ phases ||
				revision !~ /^[0-9a-f]{40}$/) exit 1
			printf "%s|%s", phase, revision
		}
	' "$marker"
}

support_database_guard_checkout_revision() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
	local candidate="$1" phase ownership cleanup cutover_state cleanup_state
	local cutover_marker="${SUPPORT_CUTOVER_MARKER:-$APP_ROOT/deploy/backend/.support-cutover-v1}"
	local cleanup_marker="${SUPPORT_CORE_CLEANUP_MARKER:-$APP_ROOT/deploy/backend/.support-core-cleanup-v1}"
	if [[ ! -e "$support_database_marker" && ! -L "$support_database_marker" ]]; then
		[[ ! -e "$cutover_marker" && ! -L "$cutover_marker" &&
			! -e "$cleanup_marker" && ! -L "$cleanup_marker" ]]
		return
	fi
	support_database_validate_marker || return 1
	phase="$(support_database_marker_value phase)"
	ownership="$(support_database_marker_value ownership_revision)"
	cleanup="$(support_database_marker_value cleanup_revision)"
	case "$phase" in
	preparing | prepared | aborted | forward-only | active)
		[[ "$candidate" == "$ownership" ]] || return 1
		;;
	complete)
		if [[ "$cleanup" == 'pending' ]]; then
			[[ "$candidate" == "$ownership" ]] || return 1
		fi
		;;
	*) return 1 ;;
	esac
	if [[ -e "$cutover_marker" || -L "$cutover_marker" ]]; then
		cutover_state="$(support_database_guard_marker_state "$cutover_marker" \
			'^(preflight-verified|restore-verified|forward-only|active|complete)$' revision)" || return 1
		case "${cutover_state%%|*}" in
		preflight-verified | restore-verified | forward-only | active)
			[[ "$candidate" == "${cutover_state#*|}" ]] || return 1
			;;
		complete) ;;
		esac
	fi
	if [[ -e "$cleanup_marker" || -L "$cleanup_marker" ]]; then
		cleanup_state="$(support_database_guard_marker_state "$cleanup_marker" \
			'^(verified|forward-only|complete)$' cleanup_revision)" || return 1
		case "${cleanup_state%%|*}" in
		verified | forward-only)
			[[ "$candidate" == "${cleanup_state#*|}" ]] || return 1
			;;
		complete) ;;
		esac
	elif [[ "$cleanup" != 'pending' ]]; then
		return 1
	fi
}

support_database_mark_cleanup() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
	support_database_validate_marker || return 1
	if [[ "$(support_database_marker_value phase)" == 'complete' &&
		"$(support_database_marker_value cleanup_revision)" == "$1" ]]; then
		return
	fi
	[[ "$(support_database_marker_value phase)" == 'complete' &&
		"$(support_database_marker_value cleanup_revision)" == 'pending' ]] ||
		support_database_fail 'Support cleanup revision can only be bound once after completed ownership' || return 1
	local temporary="${support_database_marker}.tmp.$$"
	awk -F= -v revision="$1" '
		$1 == "cleanup_revision" { print "cleanup_revision=" revision; next }
		$1 == "updated_at" { next }
		{ print }
	' "$support_database_marker" >"$temporary"
	printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$support_database_marker"
	support_database_validate_marker
}

support_database_self_test() {
	support_database_transition_allowed absent preparing
	support_database_transition_allowed preparing preparing
	support_database_transition_allowed preparing prepared
	support_database_transition_allowed prepared aborted
	support_database_transition_allowed prepared forward-only
	support_database_transition_allowed forward-only active
	support_database_transition_allowed active complete
	if support_database_transition_allowed active aborted; then
		return 1
	fi
	if support_database_transition_allowed complete prepared; then
		return 1
	fi
	local source
	source="$(declare -f support_database_require_inputs support_database_prepare \
		support_database_validate_bound_identity support_database_validate_prepared_identity \
		support_database_abort_prepare \
		support_database_mark_cleanup)"
	[[ "$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *"acquire_production_deploy_lock 'Support database prepare'"* &&
		"$source" == *"acquire_production_deploy_lock 'Support database abort'"* &&
		"$source" == *'support_release_require_local_docker'* &&
		"$source" == *'Bound Support database identity changed.'* &&
		"$source" == *'exact post-Support contract'* &&
		"$source" == *'support-migrate'* &&
		"$source" == *'REVOKE ALL ON ALL FUNCTIONS'* &&
		"$source" == *'Core ownership rollback is forbidden'* &&
		"$source" == *'cleanup revision can only be bound once'* ]] || return 1
	printf 'support_database_lifecycle_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--prepare) support_database_prepare ;;
	--abort-prepare) support_database_abort_prepare ;;
	--status) support_database_status ;;
	--self-test) support_database_self_test ;;
	--guard-before-fetch-revision | --guard-before-checkout-revision)
		[[ $# -eq 2 ]] || exit 1
		support_database_guard_checkout_revision "$2"
		;;
	*) support_database_fail 'Usage: support-database-lifecycle.sh --prepare|--abort-prepare|--status|--self-test|--guard-before-fetch-revision <sha>|--guard-before-checkout-revision <sha>' ;;
	esac
fi
