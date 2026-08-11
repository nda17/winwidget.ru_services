#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"

server_root="$APP_ROOT/winwidget.ru_server"
billing_database_marker="$APP_ROOT/deploy/backend/.billing-database-lifecycle-v1"
billing_cutover_marker="$APP_ROOT/deploy/backend/.billing-cutover-v1"
readonly billing_postgres_image='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly billing_postgres_port='55437'
readonly billing_postgres_volume='winwidget-billing-postgres-data'
readonly billing_postgres_admin='winwidget_billing_admin'

# shellcheck source=scripts/billing-release-identity.sh
source "$server_root/scripts/billing-release-identity.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$server_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"

billing_database_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

billing_database_require_root() {
	[[ "$(id -u)" == '0' ]] ||
		billing_database_fail 'Billing database mutation requires root.'
}

billing_database_require_exact_checkout() {
	billing_release_validate_revision "$EXPECTED_REVISION" || return 1
	[[ -d "$server_root/.git" &&
		"$(git -C "$server_root" rev-parse HEAD)" == "$EXPECTED_REVISION" &&
		"$(git -C "$server_root" branch --show-current)" == 'prod' &&
		-z "$(git -C "$server_root" status --porcelain --untracked-files=all)" ]] ||
		billing_database_fail \
			'Billing lifecycle requires a clean protected prod checkout at EXPECTED_REVISION.'
}

billing_database_require_env_contract() {
	local key value
	BILLING_REQUIRE_ROOT_OWNED_ENV=true \
		billing_release_validate_paths "$ENV_FILE" "$COMPOSE_FILE" || return 1
	for key in BILLING_POSTGRES_IMAGE BILLING_POSTGRES_PORT \
		BILLING_POSTGRES_DATA_VOLUME BILLING_POSTGRES_ADMIN_USER \
		BILLING_POSTGRES_ADMIN_PASSWORD_FILE BILLING_DATABASE_URL \
		BILLING_MIGRATION_DATABASE_URL BILLING_BACKUP_URL \
		BILLING_IMAGE BILLING_REVISION RABBITMQ_BILLING_WORKER_URL \
		RABBITMQ_BILLING_PUBLISHER_URL; do
		value="$(billing_read_env_value "$ENV_FILE" "$key")" ||
			billing_database_fail "Missing or duplicate production env key: $key" ||
			return 1
		[[ -n "$value" && "$value" != change_me* && "$value" != XYZXYZXYZ* ]] ||
			billing_database_fail "Production env key is empty or a placeholder: $key" ||
			return 1
	done
	[[ "$(billing_read_env_value "$ENV_FILE" BILLING_POSTGRES_IMAGE)" == \
		"$billing_postgres_image" &&
		"$(billing_read_env_value "$ENV_FILE" BILLING_POSTGRES_PORT)" == \
		"$billing_postgres_port" &&
		"$(billing_read_env_value "$ENV_FILE" BILLING_POSTGRES_DATA_VOLUME)" == \
		"$billing_postgres_volume" &&
		"$(billing_read_env_value "$ENV_FILE" BILLING_POSTGRES_ADMIN_USER)" == \
		"$billing_postgres_admin" &&
		"$(billing_read_env_value "$ENV_FILE" BILLING_REVISION)" == \
		"$EXPECTED_REVISION" &&
		"$(billing_read_env_value "$ENV_FILE" BILLING_IMAGE)" == \
		"winwidget-billing:git-$EXPECTED_REVISION" ]] ||
		billing_database_fail 'Billing production identity differs from the canonical contract.'
	billing_compose_config_all_profiles \
		"$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE"
}

billing_database_url_field() {
	[[ $# -eq 2 ]] || return 1
	local raw
	raw="$(billing_read_env_value "$ENV_FILE" "$1")" || return 1
	printf '%s\n' "$raw" | FIELD="$2" node -e '
		const fs = require("node:fs");
		const raw = fs.readFileSync(0, "utf8");
		if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n")) process.exit(1);
		let url;
		try { url = new URL(raw.slice(0, -1)); } catch { process.exit(1); }
		const field = process.env.FIELD;
		const values = {
			protocol: url.protocol,
			username: decodeURIComponent(url.username),
			password: decodeURIComponent(url.password),
			hostname: url.hostname,
			port: url.port,
			database: url.pathname.replace(/^\//, ""),
			schema: url.searchParams.get("schema") || "",
		};
		if (!(field in values) || !values[field]) process.exit(1);
		process.stdout.write(values[field]);
	'
}

billing_database_validate_urls() {
	local key expected_user
	for key in BILLING_DATABASE_URL BILLING_MIGRATION_DATABASE_URL \
		BILLING_BACKUP_URL; do
		case "$key" in
		BILLING_DATABASE_URL) expected_user='winwidget_billing_runtime' ;;
		BILLING_MIGRATION_DATABASE_URL)
			expected_user='winwidget_billing_migration'
			;;
		BILLING_BACKUP_URL) expected_user='winwidget_billing_backup' ;;
		esac
		[[ "$(billing_database_url_field "$key" protocol)" == 'postgresql:' &&
			"$(billing_database_url_field "$key" username)" == "$expected_user" &&
			-n "$(billing_database_url_field "$key" password)" &&
			"$(billing_database_url_field "$key" hostname)" == '127.0.0.1' &&
			"$(billing_database_url_field "$key" port)" == "$billing_postgres_port" &&
			"$(billing_database_url_field "$key" database)" == 'winwidget_billing' &&
			"$(billing_database_url_field "$key" schema)" == 'billing' ]] ||
			billing_database_fail "$key violates the isolated Billing role/database contract." ||
			return 1
	done
}

billing_database_marker_value() {
	[[ $# -eq 1 && -f "$billing_database_marker" && ! -L "$billing_database_marker" ]] ||
		return 1
	awk -F= -v key="$1" '
		$1 == key { print substr($0, index($0, "=") + 1); found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$billing_database_marker"
}

billing_database_validate_marker() {
	[[ -f "$billing_database_marker" && ! -L "$billing_database_marker" &&
		"$(stat -c '%u:%g:%a' "$billing_database_marker")" == '0:0:600' ]] || return 1
	awk -F= '
		function hex(value, size) { return length(value) == size && value ~ /^[0-9a-f]+$/ }
		function timestamp(value) {
			return length(value) == 20 && value ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/
		}
		{
			count[$1] += 1
			value[$1] = substr($0, index($0, "=") + 1)
			if ($1 !~ /^(version|phase|ownership_revision|cleanup_revision|database_id|database_system_identifier|database_volume|postgres_image_id|switch_generation|snapshot_sha256|pre_backup_sha256|post_backup_sha256|restore_evidence_sha256|projection_evidence_sha256|updated_at)$/) invalid = 1
		}
		END {
			for (key in count) if (count[key] != 1) invalid = 1
			if (NR != 15 || value["version"] != "1" ||
				value["phase"] !~ /^(preparing|prepared|aborted|source-frozen|imported|projection-synced|forward-only|active|complete)$/ ||
				!hex(value["ownership_revision"], 40) ||
				!(value["cleanup_revision"] == "pending" || hex(value["cleanup_revision"], 40)) ||
				!(value["database_id"] == "pending" || value["database_id"] ~ /^[0-9a-f-]{36}$/) ||
				!(value["database_system_identifier"] == "pending" || value["database_system_identifier"] ~ /^[0-9]+$/) ||
				value["database_volume"] != "winwidget-billing-postgres-data" ||
				!(value["postgres_image_id"] == "pending" || value["postgres_image_id"] ~ /^sha256:[0-9a-f]{64}$/) ||
				value["switch_generation"] !~ /^[0-9]+$/ ||
				!(value["snapshot_sha256"] == "pending" || hex(value["snapshot_sha256"], 64)) ||
				!(value["pre_backup_sha256"] == "pending" || hex(value["pre_backup_sha256"], 64)) ||
				!(value["post_backup_sha256"] == "pending" || hex(value["post_backup_sha256"], 64)) ||
				!(value["restore_evidence_sha256"] == "pending" || hex(value["restore_evidence_sha256"], 64)) ||
				!(value["projection_evidence_sha256"] == "pending" || hex(value["projection_evidence_sha256"], 64)) ||
				!timestamp(value["updated_at"])) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' "$billing_database_marker"
}

billing_database_write_marker() {
	[[ $# -eq 14 ]] || return 1
	local directory temporary
	directory="$(dirname "$billing_database_marker")"
	[[ -d "$directory" && ! -L "$directory" &&
		"$(stat -c '%u:%g' "$directory")" == '0:0' ]] || return 1
	temporary="$directory/.billing-database-lifecycle-v1.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	(umask 077; {
		printf 'version=1\n'
		printf 'phase=%s\n' "$1"
		printf 'ownership_revision=%s\n' "$2"
		printf 'cleanup_revision=%s\n' "$3"
		printf 'database_id=%s\n' "$4"
		printf 'database_system_identifier=%s\n' "$5"
		printf 'database_volume=%s\n' "$6"
		printf 'postgres_image_id=%s\n' "$7"
		printf 'switch_generation=%s\n' "$8"
		printf 'snapshot_sha256=%s\n' "$9"
		printf 'pre_backup_sha256=%s\n' "${10}"
		printf 'post_backup_sha256=%s\n' "${11}"
		printf 'restore_evidence_sha256=%s\n' "${12}"
		printf 'projection_evidence_sha256=%s\n' "${13}"
		printf 'updated_at=%s\n' "${14}"
	} >"$temporary")
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv -f "$temporary" "$billing_database_marker"
	billing_database_validate_marker
}

billing_database_transition_allowed() {
	case "${1:-}:${2:-}" in
	absent:preparing | preparing:preparing | preparing:prepared | \
		preparing:aborted | prepared:preparing | prepared:prepared | \
		prepared:aborted | aborted:preparing | prepared:source-frozen | \
		source-frozen:prepared | source-frozen:aborted | source-frozen:imported | \
		imported:aborted | imported:projection-synced | projection-synced:aborted | \
		projection-synced:forward-only | forward-only:active | active:complete | \
		complete:complete)
		return 0
		;;
	*) return 1 ;;
	esac
}

billing_database_current_phase() {
	if [[ ! -e "$billing_database_marker" && ! -L "$billing_database_marker" ]]; then
		printf 'absent\n'
		return
	fi
	billing_database_validate_marker || return 1
	billing_database_marker_value phase
}

billing_database_wait_healthy() {
	local container_id health
	for _ in {1..60}; do
		container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
			"$COMPOSE_FILE" --profile billing-database ps -q billing-postgres 2>/dev/null || true)"
		if [[ -n "$container_id" && "$container_id" != *$'\n'* ]]; then
			health="$(docker inspect --format \
				'{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
				"$container_id" 2>/dev/null || true)"
			[[ "$health" != 'healthy' ]] || {
				printf '%s\n' "$container_id"
				return
			}
			[[ "$health" != 'unhealthy' ]] || break
		fi
		sleep 2
	done
	billing_database_fail 'Billing PostgreSQL did not become healthy.'
}

billing_database_provision_roles() {
	local container_id="$1" secret_file admin_password
	local migration_password runtime_password backup_password
	secret_file="$(billing_read_env_value "$ENV_FILE" BILLING_POSTGRES_ADMIN_PASSWORD_FILE)"
	[[ "$secret_file" == /* && -f "$secret_file" && ! -L "$secret_file" &&
		"$(stat -c '%u:%g:%a' "$secret_file")" == '0:0:600' ]] ||
		billing_database_fail 'Billing PostgreSQL admin secret is unsafe.' || return 1
	admin_password="$(tr -d '\r\n' <"$secret_file")"
	[[ -n "$admin_password" ]] || return 1
	migration_password="$(billing_database_url_field BILLING_MIGRATION_DATABASE_URL password)"
	runtime_password="$(billing_database_url_field BILLING_DATABASE_URL password)"
	backup_password="$(billing_database_url_field BILLING_BACKUP_URL password)"
	docker exec -i \
		-e "PGPASSWORD=$admin_password" \
		-e "BILLING_MIGRATION_PASSWORD=$migration_password" \
		-e "BILLING_RUNTIME_PASSWORD=$runtime_password" \
		-e "BILLING_BACKUP_PASSWORD=$backup_password" \
		"$container_id" sh -eu -c '
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 \
			--username winwidget_billing_admin --dbname winwidget_billing <<'"'"'SQL'"'"'
\getenv migration_password BILLING_MIGRATION_PASSWORD
\getenv runtime_password BILLING_RUNTIME_PASSWORD
\getenv backup_password BILLING_BACKUP_PASSWORD
SELECT format('"'"'CREATE ROLE %I LOGIN PASSWORD %L'"'"', '"'"'winwidget_billing_migration'"'"', :'"'"'migration_password'"'"')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '"'"'winwidget_billing_migration'"'"') \gexec
SELECT format('"'"'CREATE ROLE %I LOGIN PASSWORD %L'"'"', '"'"'winwidget_billing_runtime'"'"', :'"'"'runtime_password'"'"')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '"'"'winwidget_billing_runtime'"'"') \gexec
SELECT format('"'"'CREATE ROLE %I LOGIN PASSWORD %L'"'"', '"'"'winwidget_billing_backup'"'"', :'"'"'backup_password'"'"')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '"'"'winwidget_billing_backup'"'"') \gexec
ALTER ROLE winwidget_billing_migration PASSWORD :'"'"'migration_password'"'"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE winwidget_billing_runtime PASSWORD :'"'"'runtime_password'"'"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE winwidget_billing_backup PASSWORD :'"'"'backup_password'"'"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT winwidget_billing_migration, winwidget_billing_runtime, winwidget_billing_backup TO winwidget_billing_admin;
REVOKE ALL ON DATABASE winwidget_billing FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_billing TO winwidget_billing_migration, winwidget_billing_runtime, winwidget_billing_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_billing FROM winwidget_billing_migration, winwidget_billing_runtime, winwidget_billing_backup;
CREATE SCHEMA IF NOT EXISTS billing AUTHORIZATION winwidget_billing_migration;
ALTER SCHEMA billing OWNER TO winwidget_billing_migration;
REVOKE ALL ON SCHEMA billing FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA billing TO winwidget_billing_migration;
GRANT USAGE ON SCHEMA billing TO winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_billing_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_billing_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
    GRANT SELECT ON TABLES TO winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
    GRANT SELECT ON SEQUENCES TO winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
SQL
	'
}

billing_database_verify_acl() {
	local container_id="$1" secret_file admin_password result
	secret_file="$(billing_read_env_value "$ENV_FILE" BILLING_POSTGRES_ADMIN_PASSWORD_FILE)"
	admin_password="$(tr -d '\r\n' <"$secret_file")"
	result="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" \
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 --quiet \
		--tuples-only --no-align --username winwidget_billing_admin \
		--dbname winwidget_billing --command "
			SELECT current_database(), current_setting('server_version_num')::integer / 10000,
				current_setting('data_checksums'),
				(SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles
				 WHERE rolname IN ('winwidget_billing_admin','winwidget_billing_migration','winwidget_billing_runtime','winwidget_billing_backup')),
				(SELECT system_identifier FROM pg_control_system()),
				NOT has_schema_privilege('winwidget_billing_runtime', 'billing', 'CREATE'),
				NOT has_table_privilege('winwidget_billing_runtime', 'billing._prisma_migrations', 'SELECT'),
				has_table_privilege('winwidget_billing_backup', 'billing._prisma_migrations', 'SELECT'),
				NOT has_table_privilege('winwidget_billing_backup', 'billing.outbox_events', 'INSERT');
		")"
	[[ "$result" =~ ^winwidget_billing\|18\|on\|winwidget_billing_admin,winwidget_billing_backup,winwidget_billing_migration,winwidget_billing_runtime\|[0-9]+\|t\|t\|t\|t$ ]] ||
		billing_database_fail 'Billing PostgreSQL identity/role boundary verification failed.'
	printf '%s\n' "$(printf '%s\n' "$result" | cut -d'|' -f5)"
}

billing_database_finalize_acl() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{64}$ ]] || return 1
	local container_id="$1" secret_file admin_password
	secret_file="$(billing_read_env_value "$ENV_FILE" BILLING_POSTGRES_ADMIN_PASSWORD_FILE)"
	admin_password="$(tr -d '\r\n' <"$secret_file")"
	docker exec -i -e "PGPASSWORD=$admin_password" "$container_id" \
		psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 --quiet \
		--username winwidget_billing_admin --dbname winwidget_billing <<'SQL'
REVOKE ALL ON ALL TABLES IN SCHEMA billing
  FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA billing
  FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA billing
  FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA billing
  TO winwidget_billing_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA billing
  TO winwidget_billing_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA billing TO winwidget_billing_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA billing TO winwidget_billing_backup;
REVOKE ALL ON TABLE billing._prisma_migrations
  FROM winwidget_billing_runtime;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_billing
  FROM winwidget_billing_migration, winwidget_billing_runtime, winwidget_billing_backup;

ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
  REVOKE ALL ON TABLES FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
  REVOKE ALL ON SEQUENCES FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_billing_runtime, winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_billing_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_billing_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
  GRANT SELECT ON TABLES TO winwidget_billing_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_billing_migration IN SCHEMA billing
  GRANT SELECT ON SEQUENCES TO winwidget_billing_backup;
SQL
}

billing_database_prepare() {
	local phase container_id system_identifier image_id database_id
	local previous_generation='0'
	billing_database_require_root
	billing_database_require_exact_checkout
	billing_database_require_env_contract
	billing_database_validate_urls
	# database-restore-production-guard: before-mutation
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	acquire_production_deploy_lock 'Billing database prepare'
	phase="$(billing_database_current_phase)" || return 1
	if [[ "$phase" != 'absent' ]]; then
		previous_generation="$(billing_database_marker_value switch_generation)"
		[[ "$previous_generation" =~ ^[0-9]+$ ]] || return 1
	fi
	billing_database_transition_allowed "$phase" preparing ||
		billing_database_fail "Billing database prepare cannot continue from phase=$phase." || return 1
	if [[ "$phase" == 'absent' || "$phase" == 'aborted' ]]; then
		billing_database_write_marker preparing "$EXPECTED_REVISION" pending pending \
			pending "$billing_postgres_volume" pending "$previous_generation" pending pending pending pending \
			pending "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	fi
	if ! docker volume inspect "$billing_postgres_volume" >/dev/null 2>&1; then
		docker volume create \
			--label com.winwidget.owner=billing \
			--label com.winwidget.purpose=postgres-data \
			"$billing_postgres_volume" >/dev/null
	fi
	[[ "$(docker volume inspect --format '{{.Driver}}|{{.Scope}}|{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}' "$billing_postgres_volume")" == \
		'local|local|billing|postgres-data' ]] ||
		billing_database_fail 'Billing PostgreSQL volume identity is unsafe.' || return 1
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile billing-database up -d --no-build billing-postgres
	container_id="$(billing_database_wait_healthy)"
	billing_database_provision_roles "$container_id"
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile billing-migration run --rm --no-deps --no-build billing-migrate
	billing_database_finalize_acl "$container_id"
	system_identifier="$(billing_database_verify_acl "$container_id")"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local admin_password_file admin_password
	admin_password_file="$(billing_read_env_value "$ENV_FILE" \
		BILLING_POSTGRES_ADMIN_PASSWORD_FILE)"
	admin_password="$(tr -d '\r\n' <"$admin_password_file")"
	database_id="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" \
		psql --no-psqlrc --no-password --username \
		winwidget_billing_admin --dbname winwidget_billing --quiet --tuples-only \
		--no-align --command \
		"SELECT database_id::text FROM billing.service_identity WHERE service_name = 'billing-service';")"
	[[ "$database_id" =~ ^[0-9a-f-]{36}$ ]] ||
		billing_database_fail 'Billing service identity database_id is missing.' || return 1
	billing_database_write_marker prepared "$EXPECTED_REVISION" pending "$database_id" \
		"$system_identifier" "$billing_postgres_volume" "$image_id" \
		"$previous_generation" pending \
		pending pending pending pending "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	printf 'billing_database_phase=prepared\n'
}

billing_database_abort() {
	local phase cutover_phase
	billing_database_require_root
	billing_database_require_exact_checkout
	# database-restore-production-guard: before-mutation
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	acquire_production_deploy_lock 'Billing database abort'
	phase="$(billing_database_current_phase)" || return 1
	if [[ -e "$billing_cutover_marker" || -L "$billing_cutover_marker" ]]; then
		[[ -f "$billing_cutover_marker" && ! -L "$billing_cutover_marker" &&
			"$(stat -c '%u:%g:%a' "$billing_cutover_marker")" == '0:0:600' ]] ||
			billing_database_fail 'Billing cutover marker is unsafe.' || return 1
		cutover_phase="$(awk -F= '$1 == "phase" { print $2; found += 1 } END { exit(found == 1 ? 0 : 1) }' \
			"$billing_cutover_marker")" || return 1
		case "$cutover_phase" in
		prepared | source-frozen | imported | projection-synced | aborted) ;;
		*) billing_database_fail \
			'Billing database abort is forbidden at or after the forward boundary.' || return 1 ;;
		esac
	fi
	billing_database_transition_allowed "$phase" aborted ||
		billing_database_fail "Billing database abort is forbidden from phase=$phase." || return 1
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop billing-api billing-scheduler billing-worker billing-outbox-publisher \
		>/dev/null 2>&1 || true
	billing_database_write_marker aborted \
		"$(billing_database_marker_value ownership_revision)" \
		"$(billing_database_marker_value cleanup_revision)" \
		"$(billing_database_marker_value database_id)" \
		"$(billing_database_marker_value database_system_identifier)" \
		"$(billing_database_marker_value database_volume)" \
		"$(billing_database_marker_value postgres_image_id)" \
		"$(billing_database_marker_value switch_generation)" \
		"$(billing_database_marker_value snapshot_sha256)" \
		"$(billing_database_marker_value pre_backup_sha256)" \
		"$(billing_database_marker_value post_backup_sha256)" \
		"$(billing_database_marker_value restore_evidence_sha256)" \
		"$(billing_database_marker_value projection_evidence_sha256)" \
		"$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	printf 'billing_database_phase=aborted\n'
}

billing_database_status() {
	local phase
	phase="$(billing_database_current_phase)" || return 1
	printf 'billing_database_phase=%s\n' "$phase"
	if [[ "$phase" != 'absent' ]]; then
		printf 'billing_database_revision=%s\n' \
			"$(billing_database_marker_value ownership_revision)"
		printf 'billing_database_generation=%s\n' \
			"$(billing_database_marker_value switch_generation)"
	fi
}

billing_database_guard_revision() {
	[[ $# -eq 1 ]] || return 1
	local revision="$1" phase ownership_revision cleanup_revision
	billing_release_validate_revision "$revision" || return 1
	phase="$(billing_database_current_phase)" || return 1
	[[ "$phase" == 'absent' ]] && return 0
	ownership_revision="$(billing_database_marker_value ownership_revision)"
	cleanup_revision="$(billing_database_marker_value cleanup_revision)"
	[[ "$revision" == "$ownership_revision" || "$revision" == "$cleanup_revision" ]] ||
		billing_database_fail \
			'Billing lifecycle forbids fetching/checking out an unbound third revision.'
}

billing_database_lifecycle_self_test() {
	local source
	billing_database_transition_allowed absent preparing
	billing_database_transition_allowed prepared source-frozen
	billing_database_transition_allowed projection-synced forward-only
	billing_database_transition_allowed active complete
	if billing_database_transition_allowed forward-only prepared; then
		billing_database_fail 'Billing lifecycle self-test allowed rollback after forward boundary.'
		return 1
	fi
	if billing_database_transition_allowed forward-only aborted; then
		billing_database_fail 'Billing lifecycle self-test allowed abort after the forward boundary.'
		return 1
	fi
	source="$(declare -f billing_database_prepare billing_database_abort \
		billing_database_require_env_contract \
		billing_database_guard_revision billing_database_provision_roles \
		billing_database_finalize_acl billing_database_verify_acl)"
	[[ "$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *'billing_compose_config_all_profiles'* &&
		"$source" == *'--profile billing-database up'* &&
		"$source" == *'--no-deps --no-build billing-migrate'* &&
		"$source" == *'winwidget_billing_migration'* &&
		"$source" == *'winwidget_billing_runtime'* &&
		"$source" == *'winwidget_billing_backup'* &&
		"$source" == *'REVOKE ALL ON TABLE billing._prisma_migrations'* &&
		"$source" == *'billing_database_finalize_acl "$container_id"'* &&
		"$source" == *'Billing database abort is forbidden at or after the forward boundary.'* ]] ||
		return 1
	bash "$server_root/scripts/billing-release-identity.sh" --self-test >/dev/null
	printf 'billing_database_lifecycle_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--prepare) billing_database_prepare ;;
	--abort) billing_database_abort ;;
	--status) billing_database_status ;;
	--guard-before-fetch-revision | --guard-before-checkout-revision)
		[[ $# -eq 2 ]] || billing_database_fail 'Exact revision argument is required.'
		# database-restore-production-guard: before-checkout
		database_restore_guard_assert_before_checkout "$ENV_FILE"
		billing_database_guard_revision "$2"
		;;
	--self-test) billing_database_lifecycle_self_test ;;
	*)
		billing_database_fail \
			'Usage: billing-database-lifecycle.sh --prepare|--abort|--status|--guard-before-fetch-revision SHA|--guard-before-checkout-revision SHA|--self-test'
		;;
	esac
fi
