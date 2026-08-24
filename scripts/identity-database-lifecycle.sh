#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

IDENTITY_SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
identity_database_marker="${IDENTITY_DATABASE_MARKER:-$APP_ROOT/deploy/backend/.identity-database-lifecycle-v1}"
readonly IDENTITY_STEADY_INTEGRATION_WORKER_KINDS='campaign-admin-audit,reporting-admin-audit,widgets-admin-audit,billing-admin-audit,identity-admin-audit,platform-admin-audit,billing-payment-projection,billing-subscription-projection,billing-affiliate-projection'

# shellcheck source=scripts/identity-release-identity.sh
declare -F identity_release_compose >/dev/null ||
	source "$IDENTITY_SCRIPT_ROOT/scripts/identity-release-identity.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
declare -F database_restore_guard_assert_before_mutation >/dev/null ||
	source "$IDENTITY_SCRIPT_ROOT/scripts/database-restore-production-guard.sh"

identity_database_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

identity_database_require_root() {
	[[ "$(id -u)" == '0' ]] ||
		identity_database_fail 'Identity database lifecycle must run as root.'
}

identity_database_normalize_csv() {
	[[ $# -eq 1 ]] || return 1
	tr ',' '\n' <<<"$1" |
		sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
		sed '/^$/d' |
		LC_ALL=C sort -u |
		paste -sd, -
}

identity_database_require_inputs() {
	identity_release_validate_revision "$EXPECTED_REVISION" || return 1
	identity_release_validate_file "$ENV_FILE" || return 1
	identity_release_validate_file "$COMPOSE_FILE" || return 1
	identity_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION"
	for key in IDENTITY_POSTGRES_IMAGE IDENTITY_POSTGRES_PORT \
		IDENTITY_POSTGRES_DATA_VOLUME IDENTITY_POSTGRES_ADMIN_USER \
		IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE IDENTITY_DATABASE_URL \
		IDENTITY_MIGRATION_DATABASE_URL IDENTITY_BACKUP_URL \
		IDENTITY_INTERNAL_BASE_URL IDENTITY_INTERNAL_TIMEOUT_MS \
		RABBITMQ_IDENTITY_WORKER_URL RABBITMQ_IDENTITY_PUBLISHER_URL \
		RABBITMQ_INTEGRATION_WORKER_URL RABBITMQ_VHOST INTEGRATION_WORKER_KINDS; do
		[[ -n "$(identity_read_env_value "$ENV_FILE" "$key")" ]] ||
			identity_database_fail "Identity database env key is missing: $key" || return 1
	done
	[[ "$(identity_read_env_value "$ENV_FILE" IDENTITY_POSTGRES_PORT)" == '55438' &&
		"$(identity_read_env_value "$ENV_FILE" IDENTITY_POSTGRES_ADMIN_USER)" == 'winwidget_identity_admin' &&
		"$(identity_read_env_value "$ENV_FILE" IDENTITY_INTERNAL_BASE_URL)" == 'http://127.0.0.1:4900' &&
		"$(identity_read_env_value "$ENV_FILE" IDENTITY_INTERNAL_TIMEOUT_MS)" == '5000' ]] ||
		identity_database_fail 'Identity PostgreSQL or internal HTTP contract differs from the release contract.' || return 1
	[[ "$(identity_database_normalize_csv "$(identity_read_env_value "$ENV_FILE" INTEGRATION_WORKER_KINDS)")" == \
		"$(identity_database_normalize_csv "$IDENTITY_STEADY_INTEGRATION_WORKER_KINDS")" ]] ||
		identity_database_fail 'Core integration-worker ownership is not the exact post-Identity contract.'
}

identity_database_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z_]+$ && -f "$identity_database_marker" &&
		! -L "$identity_database_marker" ]] || return 1
	awk -F= -v key="$1" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$identity_database_marker"
}

identity_database_current_phase() {
	if [[ ! -e "$identity_database_marker" && ! -L "$identity_database_marker" ]]; then
		printf 'absent\n'
		return
	fi
	identity_database_validate_marker || return 1
	identity_database_marker_value phase
}

identity_database_validate_marker() {
	[[ -f "$identity_database_marker" && ! -L "$identity_database_marker" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_database_marker")" == '0:0:600' ]] || return 1
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
	' "$identity_database_marker"
}

identity_database_transition_allowed() {
	case "$1:$2" in
	absent:preparing | aborted:preparing | preparing:prepared | prepared:prepared | \
		prepared:aborted | preparing:aborted | prepared:forward-only | \
		forward-only:forward-only | forward-only:active | active:active | \
		active:complete | complete:complete) return 0 ;;
	*) return 1 ;;
	esac
}

identity_database_write_marker() {
	[[ $# -eq 6 ]] || return 1
	local phase="$1" revision="$2" volume="$3" image_id="$4"
	local database_id="$5" system_identifier="$6" current temporary
	current="$(identity_database_current_phase 2>/dev/null || printf absent)"
	identity_database_transition_allowed "$current" "$phase" ||
		identity_database_fail "Unsafe Identity lifecycle transition: $current -> $phase" || return 1
	mkdir -p "$(dirname "$identity_database_marker")"
	temporary="${identity_database_marker}.tmp.$$"
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
	mv -f -- "$temporary" "$identity_database_marker"
	identity_database_validate_marker
}

identity_database_image_id() {
	local image
	image="$(identity_release_image "$EXPECTED_REVISION")" || return 1
	docker image inspect --format '{{.Id}}' "$image"
}

identity_database_url_field() {
	[[ $# -eq 2 && "$2" =~ ^(username|password|hostname|port|database|schema)$ ]] || return 1
	local value image
	value="$(identity_read_env_value "$ENV_FILE" "$1")" || return 1
	image="$(identity_release_image "$EXPECTED_REVISION")" || return 1
	docker run --rm --network none --log-driver none \
		--env "IDENTITY_PARSE_URL=$value" --entrypoint node "$image" -e '
const value = process.env.IDENTITY_PARSE_URL;
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

identity_database_validate_urls() {
	local contract key role
	for contract in \
		'IDENTITY_DATABASE_URL:winwidget_identity_runtime' \
		'IDENTITY_MIGRATION_DATABASE_URL:winwidget_identity_migration' \
		'IDENTITY_BACKUP_URL:winwidget_identity_backup'; do
		key="${contract%%:*}"
		role="${contract#*:}"
		[[ "$(identity_database_url_field "$key" username)" == "$role" &&
			"$(identity_database_url_field "$key" hostname)" == '127.0.0.1' &&
			"$(identity_database_url_field "$key" port)" == '55438' &&
			"$(identity_database_url_field "$key" database)" == 'winwidget_identity' &&
			"$(identity_database_url_field "$key" schema)" == 'identity' ]] ||
			identity_database_fail "Identity URL role/host/database contract failed: $key" || return 1
	done
}

identity_database_prepare() {
	identity_database_require_root
	identity_database_require_inputs
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	local phase volume image image_id admin_file admin_password
	local migration_password runtime_password backup_password container_id
	local database_id system_identifier acl_state
	phase="$(identity_database_current_phase)" || return 1
	case "$phase" in
	absent | aborted | preparing | prepared) ;;
	*) identity_database_fail "Identity prepare is forbidden from phase=$phase." || return 1 ;;
	esac
	volume="$(identity_read_env_value "$ENV_FILE" IDENTITY_POSTGRES_DATA_VOLUME)"
	image="$(identity_release_image "$EXPECTED_REVISION")"
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		build --pull identity-api
	image_id="$(docker image inspect --format '{{.Id}}' "$image")"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$EXPECTED_REVISION" &&
		"$(docker image inspect --format '{{.Config.User}}' "$image")" != '' &&
		"$(docker image inspect --format '{{.Config.User}}' "$image")" != 'root' &&
		"$(docker image inspect --format '{{.Config.User}}' "$image")" != '0' ]] ||
		identity_database_fail 'Identity image is mutable, root, or revision-mismatched.' || return 1
	identity_database_validate_urls
	if docker volume inspect "$volume" >/dev/null 2>&1; then
		[[ "$(docker volume inspect --format '{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}' "$volume")" == 'identity|postgres-data' ]] ||
			identity_database_fail 'Existing Identity volume lacks exact ownership labels.' || return 1
	else
		docker volume create --label com.winwidget.owner=identity \
			--label com.winwidget.purpose=postgres-data "$volume" >/dev/null
	fi
	identity_database_write_marker preparing "$EXPECTED_REVISION" "$volume" \
		"$image_id" pending pending
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile identity-database up -d identity-postgres
	container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" --profile identity-database ps -q identity-postgres)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		identity_database_fail 'Identity PostgreSQL container is missing.' || return 1
	for _ in {1..60}; do
		[[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" == 'healthy' ]] && break
		sleep 2
	done
	[[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" == 'healthy' ]] ||
		identity_database_fail 'Identity PostgreSQL did not become healthy.' || return 1
	admin_file="$(identity_read_env_value "$ENV_FILE" IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE)"
	[[ "$admin_file" == /* && -f "$admin_file" && ! -L "$admin_file" &&
		"$(stat -c '%u:%g:%a' "$admin_file")" == '0:0:600' ]] ||
		identity_database_fail 'Identity PostgreSQL admin password file is unsafe.' || return 1
	admin_password="$(tr -d '\r\n' <"$admin_file")"
	migration_password="$(identity_database_url_field IDENTITY_MIGRATION_DATABASE_URL password)"
	runtime_password="$(identity_database_url_field IDENTITY_DATABASE_URL password)"
	backup_password="$(identity_database_url_field IDENTITY_BACKUP_URL password)"
	docker exec -i -e "PGPASSWORD=$admin_password" \
		"$container_id" psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 \
		--set "MIGRATION_PASSWORD=$migration_password" \
		--set "RUNTIME_PASSWORD=$runtime_password" \
		--set "BACKUP_PASSWORD=$backup_password" \
		--username winwidget_identity_admin --dbname postgres <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_identity_migration', :'MIGRATION_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_identity_migration') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_identity_runtime', :'RUNTIME_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_identity_runtime') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_identity_backup', :'BACKUP_PASSWORD')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_identity_backup') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_identity_migration', :'MIGRATION_PASSWORD') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_identity_runtime', :'RUNTIME_PASSWORD') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', 'winwidget_identity_backup', :'BACKUP_PASSWORD') \gexec
GRANT pg_signal_backend TO winwidget_identity_admin;
GRANT winwidget_identity_migration, winwidget_identity_runtime, winwidget_identity_backup TO winwidget_identity_admin;
REVOKE ALL ON DATABASE winwidget_identity FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_identity TO winwidget_identity_migration, winwidget_identity_runtime, winwidget_identity_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_identity FROM winwidget_identity_migration, winwidget_identity_runtime, winwidget_identity_backup;
\connect winwidget_identity
CREATE SCHEMA IF NOT EXISTS identity AUTHORIZATION winwidget_identity_migration;
ALTER SCHEMA identity OWNER TO winwidget_identity_migration;
REVOKE ALL ON SCHEMA identity FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA identity TO winwidget_identity_migration;
GRANT USAGE ON SCHEMA identity TO winwidget_identity_runtime, winwidget_identity_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_identity_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_identity_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity
  GRANT SELECT ON TABLES TO winwidget_identity_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity
  GRANT SELECT ON SEQUENCES TO winwidget_identity_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, winwidget_identity_runtime, winwidget_identity_backup;
SQL
	unset admin_password migration_password runtime_password backup_password
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile identity-migration run --rm --no-deps identity-migrate
	admin_password="$(tr -d '\r\n' <"$admin_file")"
	docker exec -i -e "PGPASSWORD=$admin_password" "$container_id" psql --no-psqlrc \
		--no-password --set ON_ERROR_STOP=1 --username winwidget_identity_admin \
		--dbname winwidget_identity <<'SQL'
REVOKE ALL ON SCHEMA identity FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA identity TO winwidget_identity_migration;
REVOKE CREATE ON SCHEMA identity FROM winwidget_identity_runtime, winwidget_identity_backup;
REVOKE ALL ON ALL TABLES IN SCHEMA identity FROM PUBLIC, winwidget_identity_runtime, winwidget_identity_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA identity FROM PUBLIC, winwidget_identity_runtime, winwidget_identity_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA identity FROM PUBLIC, winwidget_identity_runtime, winwidget_identity_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO winwidget_identity_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA identity TO winwidget_identity_runtime;
REVOKE ALL ON TABLE identity._prisma_migrations FROM winwidget_identity_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA identity TO winwidget_identity_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA identity TO winwidget_identity_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity REVOKE ALL ON TABLES FROM PUBLIC, winwidget_identity_runtime, winwidget_identity_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity REVOKE ALL ON SEQUENCES FROM PUBLIC, winwidget_identity_runtime, winwidget_identity_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, winwidget_identity_runtime, winwidget_identity_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_identity_runtime, winwidget_identity_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_identity_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_identity_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity GRANT SELECT ON TABLES TO winwidget_identity_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_identity_migration IN SCHEMA identity GRANT SELECT ON SEQUENCES TO winwidget_identity_backup;
SQL
	acl_state="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" psql \
		--no-psqlrc --no-password --tuples-only --no-align \
		--username winwidget_identity_admin --dbname winwidget_identity \
		--command "
			SELECT current_database() = 'winwidget_identity',
				current_setting('server_version_num')::integer / 10000 = 18,
				current_setting('data_checksums') = 'on',
				(SELECT count(*) = 4 FROM pg_roles WHERE rolname IN
					('winwidget_identity_admin','winwidget_identity_migration',
					 'winwidget_identity_runtime','winwidget_identity_backup')),
				NOT has_schema_privilege('winwidget_identity_runtime', 'identity', 'CREATE'),
				NOT has_table_privilege('winwidget_identity_runtime', 'identity._prisma_migrations', 'SELECT'),
				has_table_privilege('winwidget_identity_backup', 'identity._prisma_migrations', 'SELECT'),
				NOT has_table_privilege('winwidget_identity_backup', 'identity.outbox_events', 'INSERT');")"
	[[ "$acl_state" == 't|t|t|t|t|t|t|t' ]] ||
		identity_database_fail 'Identity PostgreSQL identity and least-privilege ACL verification failed.' || return 1
	database_id="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" psql \
		--no-psqlrc --no-password --tuples-only --no-align \
		--username winwidget_identity_admin --dbname winwidget_identity \
		--command "SELECT database_id::text FROM identity.service_identity WHERE service_name = 'identity-service';")"
	system_identifier="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" psql \
		--no-psqlrc --no-password --tuples-only --no-align \
		--username winwidget_identity_admin --dbname postgres \
		--command "SELECT (pg_control_system()).system_identifier;")"
	unset admin_password
	[[ "$database_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ &&
		"$system_identifier" =~ ^[1-9][0-9]*$ ]] ||
		identity_database_fail 'Identity database identity is missing after migration.' || return 1
	identity_database_write_marker prepared "$EXPECTED_REVISION" "$volume" \
		"$image_id" "$database_id" "$system_identifier"
	printf 'identity_database_phase=prepared\n'
}

identity_database_advance() {
	[[ $# -eq 1 && "$1" =~ ^(forward-only|active|complete)$ ]] || return 1
	identity_database_validate_marker || return 1
	[[ "$(identity_database_marker_value ownership_revision)" == "$EXPECTED_REVISION" ]] ||
		identity_database_fail 'Identity lifecycle marker belongs to another revision.' || return 1
	identity_database_write_marker "$1" "$EXPECTED_REVISION" \
		"$(identity_database_marker_value volume)" \
		"$(identity_database_marker_value image_id)" \
		"$(identity_database_marker_value database_id)" \
		"$(identity_database_marker_value database_system_identifier)"
}

identity_database_abort_prepare() {
	identity_database_require_root
	identity_database_require_inputs
	[[ "${IDENTITY_ABORT_CONFIRMATION:-}" == 'ABORT IDENTITY PREPARE' ]] ||
		identity_database_fail 'Identity prepare abort requires exact confirmation.' || return 1
	local phase
	phase="$(identity_database_current_phase)"
	case "$phase" in
	preparing | prepared) ;;
	forward-only | active | complete)
		identity_database_fail 'Identity ownership is forward-only; Core ownership rollback is forbidden.'
		return 1
		;;
	*) identity_database_fail "Identity prepare abort is unavailable from phase=$phase."; return 1 ;;
	esac
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop -t 90 identity-api identity-worker identity-outbox-publisher identity-postgres || true
	identity_database_write_marker aborted "$EXPECTED_REVISION" \
		"$(identity_database_marker_value volume)" \
		"$(identity_database_marker_value image_id)" \
		"$(identity_database_marker_value database_id)" \
		"$(identity_database_marker_value database_system_identifier)"
	printf 'identity_database_phase=aborted\n'
}

identity_database_status() {
	local phase
	phase="$(identity_database_current_phase)" || return 1
	printf 'identity_database_phase=%s\n' "$phase"
	if [[ "$phase" != 'absent' ]]; then
		printf 'identity_database_revision=%s\n' "$(identity_database_marker_value ownership_revision)"
		printf 'identity_database_volume=%s\n' "$(identity_database_marker_value volume)"
	fi
}

identity_database_guard_marker_state() {
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

identity_database_guard_checkout_revision() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
	local candidate="$1" phase ownership cleanup cutover_state cleanup_state
	local cutover_marker="${IDENTITY_CUTOVER_MARKER:-$APP_ROOT/deploy/backend/.identity-cutover-v1}"
	local cleanup_marker="${IDENTITY_CORE_CLEANUP_MARKER:-$APP_ROOT/deploy/backend/.identity-core-cleanup-v1}"
	if [[ ! -e "$identity_database_marker" && ! -L "$identity_database_marker" ]]; then
		[[ ! -e "$cutover_marker" && ! -L "$cutover_marker" &&
			! -e "$cleanup_marker" && ! -L "$cleanup_marker" ]]
		return
	fi
	identity_database_validate_marker || return 1
	phase="$(identity_database_marker_value phase)"
	ownership="$(identity_database_marker_value ownership_revision)"
	cleanup="$(identity_database_marker_value cleanup_revision)"
	case "$phase" in
	preparing | prepared | aborted | forward-only | active)
		[[ "$candidate" == "$ownership" ]] || return 1
		;;
	complete) ;;
	*) return 1 ;;
	esac
	if [[ -e "$cutover_marker" || -L "$cutover_marker" ]]; then
		cutover_state="$(identity_database_guard_marker_state "$cutover_marker" \
			'^(preflight-verified|restore-verified|forward-only|active|complete)$' revision)" || return 1
		case "${cutover_state%%|*}" in
		preflight-verified | restore-verified | forward-only | active)
			[[ "$candidate" == "${cutover_state#*|}" ]] || return 1
			;;
		complete) ;;
		esac
	fi
	if [[ -e "$cleanup_marker" || -L "$cleanup_marker" ]]; then
		cleanup_state="$(identity_database_guard_marker_state "$cleanup_marker" \
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

identity_database_mark_cleanup() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
	identity_database_validate_marker || return 1
	if [[ "$(identity_database_marker_value phase)" == 'complete' &&
		"$(identity_database_marker_value cleanup_revision)" == "$1" ]]; then
		return
	fi
	[[ "$(identity_database_marker_value phase)" == 'complete' &&
		"$(identity_database_marker_value cleanup_revision)" == 'pending' ]] ||
		identity_database_fail 'Identity cleanup revision can only be bound once after completed ownership' || return 1
	local temporary="${identity_database_marker}.tmp.$$"
	awk -F= -v revision="$1" '
		$1 == "cleanup_revision" { print "cleanup_revision=" revision; next }
		$1 == "updated_at" { next }
		{ print }
	' "$identity_database_marker" >"$temporary"
	printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$identity_database_marker"
	identity_database_validate_marker
}

identity_database_self_test() {
	identity_database_transition_allowed absent preparing
	identity_database_transition_allowed preparing prepared
	identity_database_transition_allowed prepared aborted
	identity_database_transition_allowed prepared forward-only
	identity_database_transition_allowed forward-only active
	identity_database_transition_allowed active complete
	! identity_database_transition_allowed active aborted
	! identity_database_transition_allowed complete prepared
	local source
	source="$(declare -f identity_database_require_inputs identity_database_prepare \
		identity_database_abort_prepare identity_database_mark_cleanup)"
	[[ "$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *'exact post-Identity contract'* &&
		"$source" == *'identity-migrate'* &&
		"$source" == *'REVOKE ALL ON ALL FUNCTIONS'* &&
		"$source" == *'Core ownership rollback is forbidden'* &&
		"$source" == *'cleanup revision can only be bound once'* ]] || return 1
	printf 'identity_database_lifecycle_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--prepare) identity_database_prepare ;;
	--abort-prepare) identity_database_abort_prepare ;;
	--status) identity_database_status ;;
	--self-test) identity_database_self_test ;;
	--guard-before-fetch-revision | --guard-before-checkout-revision)
		[[ $# -eq 2 ]] || exit 1
		identity_database_guard_checkout_revision "$2"
		;;
	*) identity_database_fail 'Usage: identity-database-lifecycle.sh --prepare|--abort-prepare|--status|--self-test|--guard-before-fetch-revision <sha>|--guard-before-checkout-revision <sha>' ;;
	esac
fi
