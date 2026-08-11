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
		function image(value) { return value ~ /^sha256:[0-9a-f]{64}$/ }
		function timestamp(value) {
			return length(value) == 20 && value ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/
		}
		{
			count[$1] += 1
			value[$1] = substr($0, index($0, "=") + 1)
			if ($1 !~ /^(version|phase|ownership_revision|cleanup_revision|database_id|database_system_identifier|database_volume|postgres_image_id|core_image_id|billing_image_id|switch_generation|snapshot_sha256|pre_backup_sha256|post_backup_sha256|restore_evidence_sha256|pre_restore_evidence_sha256|pre_offsite_receipt_sha256|post_restore_evidence_sha256|post_offsite_receipt_sha256|projection_evidence_sha256|route_evidence_sha256|updated_at)$/) invalid = 1
		}
		END {
			for (key in count) if (count[key] != 1) invalid = 1
			phase = value["phase"]
			if (NR != 22 || value["version"] != "2" ||
				phase !~ /^(preparing|prepared|aborted|source-frozen|imported|pre-backups-created|pre-restore-verified|projection-synced|forward-only|active|post-backup-created|post-restore-verified|complete)$/ ||
				!hex(value["ownership_revision"], 40) ||
				!(value["cleanup_revision"] == "pending" || hex(value["cleanup_revision"], 40)) ||
				!(value["database_id"] == "pending" || value["database_id"] ~ /^[0-9a-f-]{36}$/) ||
				!(value["database_system_identifier"] == "pending" || value["database_system_identifier"] ~ /^[0-9]+$/) ||
				value["database_volume"] != "winwidget-billing-postgres-data" ||
				!(value["postgres_image_id"] == "pending" || image(value["postgres_image_id"])) ||
				!(value["core_image_id"] == "pending" || image(value["core_image_id"])) ||
				!(value["billing_image_id"] == "pending" || image(value["billing_image_id"])) ||
				value["switch_generation"] !~ /^[0-9]+$/ ||
				!(value["snapshot_sha256"] == "pending" || hex(value["snapshot_sha256"], 64)) ||
				!(value["pre_backup_sha256"] == "pending" || hex(value["pre_backup_sha256"], 64)) ||
				!(value["post_backup_sha256"] == "pending" || hex(value["post_backup_sha256"], 64)) ||
				!(value["restore_evidence_sha256"] == "pending" || hex(value["restore_evidence_sha256"], 64)) ||
				!(value["pre_restore_evidence_sha256"] == "pending" || hex(value["pre_restore_evidence_sha256"], 64)) ||
				!(value["pre_offsite_receipt_sha256"] == "pending" || hex(value["pre_offsite_receipt_sha256"], 64)) ||
				!(value["post_restore_evidence_sha256"] == "pending" || hex(value["post_restore_evidence_sha256"], 64)) ||
				!(value["post_offsite_receipt_sha256"] == "pending" || hex(value["post_offsite_receipt_sha256"], 64)) ||
				!(value["projection_evidence_sha256"] == "pending" || hex(value["projection_evidence_sha256"], 64)) ||
				!(value["route_evidence_sha256"] == "pending" || hex(value["route_evidence_sha256"], 64)) ||
				!timestamp(value["updated_at"])) invalid = 1
			if (phase !~ /^(preparing|prepared|aborted)$/ &&
				(!image(value["core_image_id"]) || !image(value["billing_image_id"]) ||
				 !hex(value["restore_evidence_sha256"], 64))) invalid = 1
			if (phase ~ /^(source-frozen|imported|pre-backups-created|pre-restore-verified|projection-synced|forward-only|active|post-backup-created|post-restore-verified|complete)$/ &&
				!hex(value["snapshot_sha256"], 64)) invalid = 1
			if (phase ~ /^(pre-backups-created|pre-restore-verified|projection-synced|forward-only|active|post-backup-created|post-restore-verified|complete)$/ &&
				!hex(value["pre_backup_sha256"], 64)) invalid = 1
			if (phase ~ /^(pre-restore-verified|projection-synced|forward-only|active|post-backup-created|post-restore-verified|complete)$/ &&
				(!hex(value["pre_restore_evidence_sha256"], 64) ||
				 !hex(value["pre_offsite_receipt_sha256"], 64))) invalid = 1
			if (phase ~ /^(projection-synced|forward-only|active|post-backup-created|post-restore-verified|complete)$/ &&
				!hex(value["projection_evidence_sha256"], 64)) invalid = 1
			if (phase ~ /^(active|post-backup-created|post-restore-verified|complete)$/ &&
				!hex(value["route_evidence_sha256"], 64)) invalid = 1
			if (phase ~ /^(post-backup-created|post-restore-verified|complete)$/ &&
				!hex(value["post_backup_sha256"], 64)) invalid = 1
			if (phase ~ /^(post-restore-verified|complete)$/ &&
				(!hex(value["post_restore_evidence_sha256"], 64) ||
				 !hex(value["post_offsite_receipt_sha256"], 64))) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' "$billing_database_marker"
}

billing_database_write_marker() {
	[[ $# -eq 21 ]] || return 1
	local directory temporary
	directory="$(dirname "$billing_database_marker")"
	[[ -d "$directory" && ! -L "$directory" &&
		"$(stat -c '%u:%g' "$directory")" == '0:0' ]] || return 1
	temporary="$directory/.billing-database-lifecycle-v2.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	(umask 077; {
		printf 'version=2\n'
		printf 'phase=%s\n' "$1"
		printf 'ownership_revision=%s\n' "$2"
		printf 'cleanup_revision=%s\n' "$3"
		printf 'database_id=%s\n' "$4"
		printf 'database_system_identifier=%s\n' "$5"
		printf 'database_volume=%s\n' "$6"
		printf 'postgres_image_id=%s\n' "$7"
		printf 'core_image_id=%s\n' "$8"
		printf 'billing_image_id=%s\n' "$9"
		printf 'switch_generation=%s\n' "${10}"
		printf 'snapshot_sha256=%s\n' "${11}"
		printf 'pre_backup_sha256=%s\n' "${12}"
		printf 'post_backup_sha256=%s\n' "${13}"
		printf 'restore_evidence_sha256=%s\n' "${14}"
		printf 'pre_restore_evidence_sha256=%s\n' "${15}"
		printf 'pre_offsite_receipt_sha256=%s\n' "${16}"
		printf 'post_restore_evidence_sha256=%s\n' "${17}"
		printf 'post_offsite_receipt_sha256=%s\n' "${18}"
		printf 'projection_evidence_sha256=%s\n' "${19}"
		printf 'route_evidence_sha256=%s\n' "${20}"
		printf 'updated_at=%s\n' "${21}"
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
		imported:aborted | imported:pre-backups-created | \
		pre-backups-created:aborted | pre-backups-created:pre-restore-verified | \
		pre-restore-verified:aborted | pre-restore-verified:projection-synced | \
		projection-synced:aborted | projection-synced:forward-only | \
		forward-only:active | active:post-backup-created | \
		post-backup-created:post-restore-verified | \
		post-restore-verified:complete | \
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

billing_database_require_pinned_candidate_images() {
	local revision core_image billing_image expected_core_id expected_billing_id
	local actual_core_id actual_billing_id core_revision billing_revision
	local core_user billing_user
	billing_database_validate_marker || return 1
	revision="$(billing_database_marker_value ownership_revision)" || return 1
	expected_core_id="$(billing_database_marker_value core_image_id)" || return 1
	expected_billing_id="$(billing_database_marker_value billing_image_id)" || return 1
	[[ "$revision" =~ ^[0-9a-f]{40}$ &&
		"$expected_core_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$expected_billing_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
		billing_database_fail 'Billing candidate image IDs are not fixed in the durable marker.' ||
		return 1
	core_image="winwidget-api:git-$revision"
	billing_image="$(billing_release_identity_value BILLING_IMAGE "$revision")"
	actual_core_id="$(docker image inspect --format '{{.Id}}' "$core_image")" || return 1
	actual_billing_id="$(docker image inspect --format '{{.Id}}' "$billing_image")" || return 1
	core_revision="$(docker image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		"$core_image")" || return 1
	billing_revision="$(docker image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		"$billing_image")" || return 1
	core_user="$(docker image inspect --format '{{.Config.User}}' "$core_image")" || return 1
	billing_user="$(docker image inspect --format '{{.Config.User}}' "$billing_image")" || return 1
	[[ "$actual_core_id" == "$expected_core_id" &&
		"$actual_billing_id" == "$expected_billing_id" &&
		"$core_revision" == "$revision" && "$billing_revision" == "$revision" &&
		-n "$core_user" && "$core_user" != '0' && "$core_user" != 'root' &&
		"$billing_user" == 'billing' ]] ||
		billing_database_fail \
			'Billing candidate image identity differs from the durable marker.'
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
	local candidate_core_image_id candidate_billing_image_id marker_core_image_id
	local marker_billing_image_id
	local previous_generation='0'
	billing_database_require_root
	billing_database_require_exact_checkout
	billing_database_require_env_contract
	billing_database_validate_urls
	# database-restore-production-guard: before-mutation
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	acquire_production_deploy_lock 'Billing database prepare'
	phase="$(billing_database_current_phase)" || return 1
	candidate_core_image_id="${BILLING_CANDIDATE_CORE_IMAGE_ID:-}"
	candidate_billing_image_id="${BILLING_CANDIDATE_BILLING_IMAGE_ID:-}"
	[[ "$candidate_core_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$candidate_billing_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
		billing_database_fail \
			'Billing database prepare requires exact candidate image IDs.' ||
		return 1
	if [[ "$phase" != 'absent' ]]; then
		previous_generation="$(billing_database_marker_value switch_generation)"
		[[ "$previous_generation" =~ ^[0-9]+$ ]] || return 1
		marker_core_image_id="$(billing_database_marker_value core_image_id)"
		marker_billing_image_id="$(billing_database_marker_value billing_image_id)"
		if [[ "$marker_core_image_id" != 'pending' ||
			"$marker_billing_image_id" != 'pending' ]]; then
			[[ "$marker_core_image_id" == "$candidate_core_image_id" &&
				"$marker_billing_image_id" == "$candidate_billing_image_id" ]] ||
				billing_database_fail \
					'Billing database candidate image IDs cannot be rebound.' ||
				return 1
		fi
	fi
	billing_database_transition_allowed "$phase" preparing ||
		billing_database_fail "Billing database prepare cannot continue from phase=$phase." || return 1
	if [[ "$phase" == 'aborted' ]]; then
		billing_database_reset_aborted_target || return 1
	fi
	if [[ "$phase" == 'absent' || "$phase" == 'aborted' ]]; then
		billing_database_write_marker preparing "$EXPECTED_REVISION" pending pending \
			pending "$billing_postgres_volume" pending \
			"$candidate_core_image_id" "$candidate_billing_image_id" \
			"$previous_generation" pending pending pending pending pending pending \
			pending pending pending pending "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
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
		--profile billing-migration run --rm --no-deps billing-migrate
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
		"$candidate_core_image_id" "$candidate_billing_image_id" \
		"$previous_generation" pending pending pending pending \
		pending pending pending pending pending pending \
		"$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	printf 'billing_database_phase=prepared\n'
}

billing_database_require_runtime_stopped() {
	local running
	running="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q billing-api billing-scheduler \
		billing-worker billing-outbox-publisher)" || return 1
	[[ -z "$running" ]] ||
		billing_database_fail \
			'Billing runtime roles are still running after abort stop.'
}

billing_database_reset_aborted_target() {
	local container_id stopped_state volume_identity cutover_phase
	[[ "$(billing_database_current_phase)" == 'aborted' &&
		"$(billing_database_marker_value ownership_revision)" == \
		"$EXPECTED_REVISION" &&
		"$(billing_database_marker_value database_volume)" == \
		"$billing_postgres_volume" ]] ||
		billing_database_fail \
			'Billing target reset requires the exact aborted database marker.' ||
		return 1
	[[ -f "$billing_cutover_marker" && ! -L "$billing_cutover_marker" &&
		"$(stat -c '%u:%g:%a' "$billing_cutover_marker")" == '0:0:600' ]] ||
		billing_database_fail \
			'Billing target reset requires a safe cutover marker.' || return 1
	cutover_phase="$(awk -F= -v expected_revision="$EXPECTED_REVISION" '
		$1 == "phase" { print $2; found += 1 }
		$1 == "revision" { revision = $2; revisions += 1 }
		END { exit(found == 1 && revisions == 1 && revision == expected_revision ? 0 : 1) }
	' "$billing_cutover_marker")" || return 1
	[[ "$cutover_phase" == 'aborted' ]] ||
		billing_database_fail \
			'Billing target reset is forbidden unless cutover is aborted.' || return 1
	billing_database_require_runtime_stopped || return 1
	container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" --profile billing-database ps -aq billing-postgres)" ||
		return 1
	[[ -z "$container_id" || "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		billing_database_fail 'Billing PostgreSQL container identity is ambiguous.' ||
		return 1
	if [[ -n "$container_id" ]]; then
		EXPECTED_VOLUME="$billing_postgres_volume" docker inspect "$container_id" | \
			node -e '
const fs = require("node:fs");
const documents = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(documents) || documents.length !== 1) process.exit(1);
const document = documents[0];
const labels = document.Config?.Labels || {};
const volumes = (document.Mounts || []).filter(mount => mount.Type === "volume");
if (labels["com.docker.compose.project"] !== "winwidget" ||
    labels["com.docker.compose.service"] !== "billing-postgres" ||
    volumes.length !== 1 || volumes[0].Name !== process.env.EXPECTED_VOLUME ||
    volumes[0].Destination !== "/var/lib/postgresql") process.exit(1);
' || billing_database_fail \
			'Billing PostgreSQL container is outside the aborted target boundary.' ||
			return 1
		docker stop --time 30 "$container_id" >/dev/null || return 1
		stopped_state="$(docker inspect --format \
			'{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}' \
			"$container_id")" || return 1
		[[ "$stopped_state" == 'exited|0|false|' ||
			"$stopped_state" == 'exited|143|false|' ]] ||
			billing_database_fail \
				'Billing PostgreSQL did not stop cleanly before aborted reset.' ||
			return 1
		docker rm "$container_id" >/dev/null || return 1
	fi
	[[ -z "$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" --profile billing-database ps -aq billing-postgres)" ]] ||
		billing_database_fail \
			'Billing PostgreSQL container remains after aborted reset.' || return 1
	if docker volume inspect "$billing_postgres_volume" >/dev/null 2>&1; then
		volume_identity="$(docker volume inspect --format \
			'{{.Driver}}|{{.Scope}}|{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}' \
			"$billing_postgres_volume")" || return 1
		[[ "$volume_identity" == 'local|local|billing|postgres-data' ]] ||
			billing_database_fail \
				'Billing PostgreSQL volume is outside the aborted target boundary.' ||
			return 1
		docker volume rm "$billing_postgres_volume" >/dev/null || return 1
	fi
	! docker volume inspect "$billing_postgres_volume" >/dev/null 2>&1 ||
		billing_database_fail \
			'Billing PostgreSQL volume remains after aborted reset.'
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
		prepared | source-frozen | imported | pre-backups-created | \
			pre-restore-verified | projection-synced | aborted) ;;
		*) billing_database_fail \
			'Billing database abort is forbidden at or after the forward boundary.' || return 1 ;;
		esac
	fi
	billing_database_transition_allowed "$phase" aborted ||
		billing_database_fail "Billing database abort is forbidden from phase=$phase." || return 1
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop billing-api billing-scheduler billing-worker billing-outbox-publisher \
		>/dev/null || return 1
	billing_database_require_runtime_stopped || return 1
	billing_database_write_marker aborted \
		"$(billing_database_marker_value ownership_revision)" \
		"$(billing_database_marker_value cleanup_revision)" \
		"$(billing_database_marker_value database_id)" \
		"$(billing_database_marker_value database_system_identifier)" \
		"$(billing_database_marker_value database_volume)" \
		"$(billing_database_marker_value postgres_image_id)" \
		"$(billing_database_marker_value core_image_id)" \
		"$(billing_database_marker_value billing_image_id)" \
		"$(billing_database_marker_value switch_generation)" \
		"$(billing_database_marker_value snapshot_sha256)" \
		"$(billing_database_marker_value pre_backup_sha256)" \
		"$(billing_database_marker_value post_backup_sha256)" \
		"$(billing_database_marker_value restore_evidence_sha256)" \
		"$(billing_database_marker_value pre_restore_evidence_sha256)" \
		"$(billing_database_marker_value pre_offsite_receipt_sha256)" \
		"$(billing_database_marker_value post_restore_evidence_sha256)" \
		"$(billing_database_marker_value post_offsite_receipt_sha256)" \
		"$(billing_database_marker_value projection_evidence_sha256)" \
		"$(billing_database_marker_value route_evidence_sha256)" \
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

billing_database_reset_self_test() (
	local directory phase container_exists volume_exists container_id
	directory="$(mktemp -d /tmp/billing-database-reset-self-test.XXXXXX)"
	billing_cutover_marker="$directory/cutover.marker"
	EXPECTED_REVISION="$(printf '6%.0s' {1..40})"
	printf 'phase=aborted\nrevision=%s\n' "$EXPECTED_REVISION" \
		>"$billing_cutover_marker"
	phase='aborted'
	container_exists='true'
	volume_exists='true'
	container_id="$(printf 'a%.0s' {1..64})"
	BILLING_RESET_TEST_CONTAINER_ID="$container_id"
	export BILLING_RESET_TEST_CONTAINER_ID
	stat() { printf '0:0:600\n'; }
	billing_database_current_phase() { printf '%s\n' "$phase"; }
	billing_database_marker_value() {
		case "$1" in
		ownership_revision) printf '%s\n' "$EXPECTED_REVISION" ;;
		database_volume) printf '%s\n' "$billing_postgres_volume" ;;
		*) return 1 ;;
		esac
	}
	billing_database_require_runtime_stopped() { return 0; }
	billing_database_fail() { return 1; }
	billing_compose() {
		[[ " $* " == *' ps -aq billing-postgres '* ]] || return 1
		if [[ "$container_exists" == 'true' ]]; then
			printf '%s\n' "$BILLING_RESET_TEST_CONTAINER_ID"
		fi
		return 0
	}
	docker() {
		case "$1:$2" in
		inspect:"$BILLING_RESET_TEST_CONTAINER_ID")
			printf '[{"Config":{"Labels":{"com.docker.compose.project":"winwidget","com.docker.compose.service":"billing-postgres"}},"Mounts":[{"Type":"volume","Name":"%s","Destination":"/var/lib/postgresql"}]}]\n' \
				"$billing_postgres_volume"
			;;
		inspect:--format)
			printf 'exited|0|false|\n'
			;;
		stop:--time)
			[[ "${4:-}" == "$BILLING_RESET_TEST_CONTAINER_ID" ]]
			;;
		rm:"$BILLING_RESET_TEST_CONTAINER_ID")
			container_exists='false'
			;;
		volume:inspect)
			if [[ "${3:-}" == '--format' ]]; then
				[[ "$volume_exists" == 'true' ]] || return 1
				printf 'local|local|billing|postgres-data\n'
			else
				[[ "$volume_exists" == 'true' ]]
			fi
			;;
		volume:rm)
			[[ "${3:-}" == "$billing_postgres_volume" ]]
			volume_exists='false'
			;;
		*) return 1 ;;
		esac
	}
	billing_database_reset_aborted_target
	[[ "$container_exists" == 'false' && "$volume_exists" == 'false' ]]
	phase='prepared'
	container_exists='true'
	volume_exists='true'
	if billing_database_reset_aborted_target; then return 1; fi
	[[ "$container_exists" == 'true' && "$volume_exists" == 'true' ]]
	unset BILLING_RESET_TEST_CONTAINER_ID
	rm -f -- "$billing_cutover_marker"
	rmdir -- "$directory"
)

billing_database_lifecycle_self_test() {
	local source
	billing_database_transition_allowed absent preparing
	billing_database_transition_allowed prepared source-frozen
	billing_database_transition_allowed imported pre-backups-created
	billing_database_transition_allowed pre-backups-created pre-restore-verified
	billing_database_transition_allowed pre-restore-verified projection-synced
	billing_database_transition_allowed projection-synced forward-only
	billing_database_transition_allowed active post-backup-created
	billing_database_transition_allowed post-backup-created post-restore-verified
	billing_database_transition_allowed post-restore-verified complete
	if billing_database_transition_allowed forward-only prepared; then
		billing_database_fail 'Billing lifecycle self-test allowed rollback after forward boundary.'
		return 1
	fi
	if billing_database_transition_allowed forward-only aborted; then
		billing_database_fail 'Billing lifecycle self-test allowed abort after the forward boundary.'
		return 1
	fi
	source="$(declare -f billing_database_prepare billing_database_abort \
		billing_database_require_runtime_stopped \
		billing_database_reset_aborted_target \
		billing_database_require_env_contract \
		billing_database_validate_marker billing_database_write_marker \
		billing_database_guard_revision \
		billing_database_require_pinned_candidate_images \
		billing_database_provision_roles \
		billing_database_finalize_acl billing_database_verify_acl)"
	[[ "$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *'billing_compose_config_all_profiles'* &&
		"$source" == *'--profile billing-database up'* &&
		"$source" == *'--profile billing-migration run --rm --no-deps billing-migrate'* &&
		"$source" != *'run --rm --no-deps --no-build billing-migrate'* &&
		"$source" == *'winwidget_billing_migration'* &&
		"$source" == *'winwidget_billing_runtime'* &&
		"$source" == *'winwidget_billing_backup'* &&
		"$source" == *'REVOKE ALL ON TABLE billing._prisma_migrations'* &&
		"$source" == *'billing_database_finalize_acl "$container_id"'* &&
		"$source" == *'Billing candidate image identity differs from the durable marker.'* &&
		"$source" == *'billing_database_require_runtime_stopped'* &&
		"$source" == *'Billing runtime roles are still running after abort stop.'* &&
		"$source" == *'docker volume rm "$billing_postgres_volume"'* &&
		"$source" == *'Billing target reset requires the exact aborted database marker.'* &&
		"$source" == *'route_evidence_sha256'* &&
		"$source" == *'active|post-backup-created|post-restore-verified|complete'* &&
		"$source" == *'Billing database abort is forbidden at or after the forward boundary.'* ]] ||
		return 1
	billing_database_reset_self_test || return 1
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
