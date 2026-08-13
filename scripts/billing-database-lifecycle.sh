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
readonly BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME='20260813000000_remove_legacy_billing_core_source'
readonly BILLING_CORE_SOURCE_CLEANUP_MARKER_NAME='.billing-core-source-cleanup-v1'
readonly billing_core_postgres_image='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
BILLING_CANONICAL_CORE_SOURCE_TABLES=(
	payments
	payment_receipts
	subscriptions
	subscription_history
	subscription_expiry_reminders
	auto_renewals
	auto_renewal_consent_events
	tariff_prices
	affiliate_referrals
)
BILLING_CANONICAL_CORE_SITE_SETTINGS_COLUMNS=(
	payment_enabled
	auto_renewal_signup_enabled
	auto_renewal_charges_enabled
	auto_renewal_charges_enabled_at
	affiliate_program_enabled
	affiliate_cashback_percent
)

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
	printf '%s\n' "$raw" | FIELD="$2" billing_release_node_stdin -e '
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
		docker inspect "$container_id" | EXPECTED_VOLUME="$billing_postgres_volume" \
			billing_release_node_stdin -e '
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

billing_core_source_cleanup_sha256_stream() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 | awk 'NR == 1 { print $1 }'
	fi
}

billing_core_source_cleanup_sha256_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
	fi
}

billing_core_source_cleanup_stat_mode() {
	if stat -c '%a' "$1" >/dev/null 2>&1; then
		stat -c '%a' "$1"
	else
		stat -f '%Lp' "$1"
	fi
}

billing_core_source_cleanup_stat_owner() {
	if stat -c '%u:%g' "$1" >/dev/null 2>&1; then
		stat -c '%u:%g' "$1"
	else
		stat -f '%u:%g' "$1"
	fi
}

billing_core_source_cleanup_marker_path() {
	printf '%s/deploy/backend/%s\n' \
		"${APP_ROOT:-/opt/winwidget}" "$BILLING_CORE_SOURCE_CLEANUP_MARKER_NAME"
}

billing_core_source_cleanup_evidence_directory() {
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{40}$ && "$2" =~ ^[1-9][0-9]*$ ]] ||
		return 1
	printf '%s/deploy/backend/billing-core-source-cleanup/%s-g%s\n' \
		"${APP_ROOT:-/opt/winwidget}" "$1" "$2"
}

billing_core_source_cleanup_validate_private_file() {
	[[ $# -eq 2 && "$2" =~ ^[0-9a-f]{64}$ && -f "$1" && ! -L "$1" &&
		"$(billing_core_source_cleanup_stat_owner "$1")" == '0:0' &&
		"$(billing_core_source_cleanup_stat_mode "$1")" == '600' && -s "$1" &&
		"$(billing_core_source_cleanup_sha256_file "$1")" == "$2" ]]
}

billing_core_source_cleanup_migration_file() {
	local source_root
	source_root="$(
		cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
		pwd -P
	)" || return 1
	printf '%s/prisma/migrations/%s/migration.sql\n' \
		"$source_root" "$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME"
}

billing_core_source_cleanup_migration_checksum() {
	local migration_file
	migration_file="$(billing_core_source_cleanup_migration_file)" || return 1
	billing_core_source_cleanup_sha256_file "$migration_file"
}

billing_core_source_cleanup_marker_value_from_file() {
	[[ $# -eq 2 && -f "$1" && ! -L "$1" ]] || return 1
	awk -F= -v key="$2" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$1"
}

billing_core_source_cleanup_parent_marker_value() {
	[[ $# -eq 2 && -f "$1" && ! -L "$1" ]] || return 1
	billing_core_source_cleanup_marker_value_from_file "$1" "$2"
}

billing_core_source_cleanup_validate_marker_contents() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	awk -F= -v migration="$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME" '
		function hex(value, size) {
			return length(value) == size && value ~ /^[0-9a-f]+$/ && value !~ /^0+$/
		}
		function timestamp(value) {
			return length(value) == 20 &&
				value ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/
		}
		function pending_or_hash(value) { return value == "pending" || hex(value, 64) }
		function pending_or_system_id(value) { return value == "pending" || value ~ /^[1-9][0-9]*$/ }
		function pending_or_database_id(value) {
			return value == "pending" || value ~ /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		}
		{
			count[$1] += 1
			value[$1] = substr($0, index($0, "=") + 1)
			if ($1 !~ /^(version|phase|previous_revision|revision|migration_name|migration_sha256|ownership_generation|cleanup_core_image_id|cleanup_billing_image_id|source_snapshot_sha256|projection_evidence_sha256|route_evidence_sha256|core_backup_sha256|billing_backup_sha256|restore_evidence_sha256|queue_drain_evidence_sha256|stopped_writers_evidence_sha256|pre_offsite_receipt_sha256|retention_decision|retention_reference|core_system_identifier|billing_system_identifier|billing_database_id|post_cleanup_backup_sha256|post_restore_evidence_sha256|post_offsite_receipt_sha256|completion_evidence_sha256|created_at|updated_at)$/) invalid = 1
		}
		END {
			for (key in count) if (count[key] != 1) invalid = 1
			phase = value["phase"]
			if (NR != 29 || value["version"] != "1" ||
				phase !~ /^(staged|applied|complete)$/ ||
				!hex(value["previous_revision"], 40) ||
				!hex(value["revision"], 40) ||
				value["previous_revision"] == value["revision"] ||
				value["migration_name"] != migration ||
				!hex(value["migration_sha256"], 64) ||
				value["ownership_generation"] != "2" ||
				value["cleanup_core_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["cleanup_billing_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["cleanup_core_image_id"] ~ /^sha256:0+$/ ||
				value["cleanup_billing_image_id"] ~ /^sha256:0+$/ ||
				!hex(value["source_snapshot_sha256"], 64) ||
				!hex(value["projection_evidence_sha256"], 64) ||
				!hex(value["route_evidence_sha256"], 64) ||
				!pending_or_hash(value["core_backup_sha256"]) ||
				!pending_or_hash(value["billing_backup_sha256"]) ||
				!pending_or_hash(value["restore_evidence_sha256"]) ||
				!pending_or_hash(value["queue_drain_evidence_sha256"]) ||
				!pending_or_hash(value["stopped_writers_evidence_sha256"]) ||
				!pending_or_hash(value["pre_offsite_receipt_sha256"]) ||
				value["retention_decision"] != "approved" ||
				!(value["retention_reference"] == "pending" || hex(value["retention_reference"], 64)) ||
				!pending_or_system_id(value["core_system_identifier"]) ||
				!pending_or_system_id(value["billing_system_identifier"]) ||
				!pending_or_database_id(value["billing_database_id"]) ||
				!pending_or_hash(value["post_cleanup_backup_sha256"]) ||
				!pending_or_hash(value["post_restore_evidence_sha256"]) ||
				!pending_or_hash(value["post_offsite_receipt_sha256"]) ||
				!pending_or_hash(value["completion_evidence_sha256"]) ||
				!timestamp(value["created_at"]) || !timestamp(value["updated_at"])) invalid = 1
			if ((value["pre_offsite_receipt_sha256"] == "pending") != (value["retention_reference"] == "pending")) invalid = 1
			if (hex(value["pre_offsite_receipt_sha256"], 64) &&
				value["retention_reference"] != value["pre_offsite_receipt_sha256"]) invalid = 1
			if (phase ~ /^(applied|complete)$/ &&
				(!hex(value["core_backup_sha256"], 64) ||
				 !hex(value["billing_backup_sha256"], 64) ||
				 !hex(value["restore_evidence_sha256"], 64) ||
				 !hex(value["queue_drain_evidence_sha256"], 64) ||
				 !hex(value["stopped_writers_evidence_sha256"], 64) ||
				 !hex(value["pre_offsite_receipt_sha256"], 64) ||
				 !hex(value["retention_reference"], 64) ||
				 value["core_system_identifier"] !~ /^[1-9][0-9]*$/ ||
				 value["billing_system_identifier"] !~ /^[1-9][0-9]*$/ ||
				 value["billing_database_id"] !~ /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)) invalid = 1
			if (phase ~ /^(staged|applied)$/ &&
				(value["post_cleanup_backup_sha256"] != "pending" ||
				 value["post_restore_evidence_sha256"] != "pending" ||
				 value["post_offsite_receipt_sha256"] != "pending" ||
				 value["completion_evidence_sha256"] != "pending")) invalid = 1
			if (phase == "complete" &&
				(!hex(value["post_cleanup_backup_sha256"], 64) ||
				 !hex(value["post_restore_evidence_sha256"], 64) ||
				 !hex(value["post_offsite_receipt_sha256"], 64) ||
				 !hex(value["completion_evidence_sha256"], 64))) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' "$1"
}

billing_core_source_cleanup_validate_marker() {
	local marker_file marker_directory expected_checksum
	marker_file="$(billing_core_source_cleanup_marker_path)" || return 1
	marker_directory="$(dirname -- "$marker_file")"
	[[ -d "$marker_directory" && ! -L "$marker_directory" &&
		"$(billing_core_source_cleanup_stat_owner "$marker_directory")" == '0:0' &&
		"$(billing_core_source_cleanup_stat_mode "$marker_directory")" =~ ^(700|750|755)$ &&
		-f "$marker_file" && ! -L "$marker_file" &&
		"$(billing_core_source_cleanup_stat_owner "$marker_file")" == '0:0' &&
		"$(billing_core_source_cleanup_stat_mode "$marker_file")" == '600' ]] || return 1
	billing_core_source_cleanup_validate_marker_contents "$marker_file" || return 1
	expected_checksum="$(billing_core_source_cleanup_migration_checksum)" || return 1
	[[ "$(billing_core_source_cleanup_marker_value_from_file \
		"$marker_file" migration_sha256)" == "$expected_checksum" ]]
}

billing_core_source_cleanup_marker_value() {
	[[ $# -eq 1 ]] || return 1
	billing_core_source_cleanup_validate_marker || return 1
	billing_core_source_cleanup_marker_value_from_file \
		"$(billing_core_source_cleanup_marker_path)" "$1"
}

billing_core_source_cleanup_marker_state() {
	local marker_file
	marker_file="$(billing_core_source_cleanup_marker_path)" || return 1
	if [[ ! -e "$marker_file" && ! -L "$marker_file" ]]; then
		printf 'absent\n'
		return
	fi
	billing_core_source_cleanup_validate_marker || {
		printf 'invalid\n'
		return 1
	}
	billing_core_source_cleanup_marker_value phase
}

billing_core_source_cleanup_write_marker() {
	[[ $# -eq 25 ]] || return 1
	local phase="$1" previous_revision="$2" revision="$3" ownership_generation="$4"
	local cleanup_core_image_id="$5" cleanup_billing_image_id="$6"
	local source_snapshot_sha256="$7" projection_evidence_sha256="$8"
	local route_evidence_sha256="$9" core_backup_sha256="${10}"
	local billing_backup_sha256="${11}" restore_evidence_sha256="${12}"
	local queue_drain_evidence_sha256="${13}" stopped_writers_evidence_sha256="${14}"
	local pre_offsite_receipt_sha256="${15}" retention_decision="${16}"
	local retention_reference="${17}" core_system_identifier="${18}"
	local billing_system_identifier="${19}" billing_database_id="${20}"
	local post_cleanup_backup_sha256="${21}" post_restore_evidence_sha256="${22}"
	local post_offsite_receipt_sha256="${23}" completion_evidence_sha256="${24}"
	local created_at="${25}" marker_file marker_directory
	local migration_sha256 temporary updated_at current_phase current_value key
	migration_sha256="$(billing_core_source_cleanup_migration_checksum)" || return 1
	marker_file="$(billing_core_source_cleanup_marker_path)" || return 1
	marker_directory="$(dirname -- "$marker_file")"
	[[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ &&
		-d "$marker_directory" && ! -L "$marker_directory" &&
		"$(billing_core_source_cleanup_stat_owner "$marker_directory")" == '0:0' ]] || return 1
	updated_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	if [[ -e "$marker_file" || -L "$marker_file" ]]; then
		billing_core_source_cleanup_validate_marker || return 1
		current_phase="$(billing_core_source_cleanup_marker_value phase)" || return 1
		case "$current_phase|$phase" in
		staged\|staged | staged\|applied | applied\|applied | applied\|complete | complete\|complete) ;;
		*) return 1 ;;
		esac
		for key in previous_revision revision migration_name migration_sha256 \
			ownership_generation cleanup_core_image_id cleanup_billing_image_id \
			source_snapshot_sha256 projection_evidence_sha256 route_evidence_sha256 \
			retention_decision created_at; do
			current_value="$(billing_core_source_cleanup_marker_value "$key")" || return 1
			case "$key" in
			previous_revision) [[ "$current_value" == "$previous_revision" ]] || return 1 ;;
			revision) [[ "$current_value" == "$revision" ]] || return 1 ;;
			migration_name) [[ "$current_value" == "$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME" ]] || return 1 ;;
			migration_sha256) [[ "$current_value" == "$migration_sha256" ]] || return 1 ;;
			ownership_generation) [[ "$current_value" == "$ownership_generation" ]] || return 1 ;;
			cleanup_core_image_id) [[ "$current_value" == "$cleanup_core_image_id" ]] || return 1 ;;
			cleanup_billing_image_id) [[ "$current_value" == "$cleanup_billing_image_id" ]] || return 1 ;;
			source_snapshot_sha256) [[ "$current_value" == "$source_snapshot_sha256" ]] || return 1 ;;
			projection_evidence_sha256) [[ "$current_value" == "$projection_evidence_sha256" ]] || return 1 ;;
			route_evidence_sha256) [[ "$current_value" == "$route_evidence_sha256" ]] || return 1 ;;
			retention_decision) [[ "$current_value" == "$retention_decision" ]] || return 1 ;;
			created_at) [[ "$current_value" == "$created_at" ]] || return 1 ;;
			esac
		done
		for key in core_backup_sha256 billing_backup_sha256 restore_evidence_sha256 \
			queue_drain_evidence_sha256 stopped_writers_evidence_sha256 \
			pre_offsite_receipt_sha256 retention_reference core_system_identifier \
			billing_system_identifier billing_database_id; do
			current_value="$(billing_core_source_cleanup_marker_value "$key")" || return 1
			[[ "$current_value" == 'pending' ]] || {
				case "$key" in
				core_backup_sha256) [[ "$current_value" == "$core_backup_sha256" ]] ;;
				billing_backup_sha256) [[ "$current_value" == "$billing_backup_sha256" ]] ;;
				restore_evidence_sha256) [[ "$current_value" == "$restore_evidence_sha256" ]] ;;
				queue_drain_evidence_sha256) [[ "$current_value" == "$queue_drain_evidence_sha256" ]] ;;
				stopped_writers_evidence_sha256) [[ "$current_value" == "$stopped_writers_evidence_sha256" ]] ;;
				pre_offsite_receipt_sha256) [[ "$current_value" == "$pre_offsite_receipt_sha256" ]] ;;
				retention_reference) [[ "$current_value" == "$retention_reference" ]] ;;
				core_system_identifier) [[ "$current_value" == "$core_system_identifier" ]] ;;
				billing_system_identifier) [[ "$current_value" == "$billing_system_identifier" ]] ;;
				billing_database_id) [[ "$current_value" == "$billing_database_id" ]] ;;
				esac || return 1
			}
		done
		if [[ "$current_phase" == 'complete' ]]; then
			[[ "$(billing_core_source_cleanup_marker_value post_cleanup_backup_sha256)" == "$post_cleanup_backup_sha256" &&
				"$(billing_core_source_cleanup_marker_value post_restore_evidence_sha256)" == "$post_restore_evidence_sha256" &&
				"$(billing_core_source_cleanup_marker_value post_offsite_receipt_sha256)" == "$post_offsite_receipt_sha256" &&
				"$(billing_core_source_cleanup_marker_value completion_evidence_sha256)" == "$completion_evidence_sha256" ]] || return 1
		fi
	fi
	temporary="$marker_directory/.${BILLING_CORE_SOURCE_CLEANUP_MARKER_NAME#\.}.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	if ! {
		(umask 077; {
			printf 'version=1\nphase=%s\nprevious_revision=%s\nrevision=%s\n' "$phase" "$previous_revision" "$revision"
			printf 'migration_name=%s\nmigration_sha256=%s\n' "$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME" "$migration_sha256"
			printf 'ownership_generation=%s\ncleanup_core_image_id=%s\ncleanup_billing_image_id=%s\n' "$ownership_generation" "$cleanup_core_image_id" "$cleanup_billing_image_id"
			printf 'source_snapshot_sha256=%s\nprojection_evidence_sha256=%s\nroute_evidence_sha256=%s\n' "$source_snapshot_sha256" "$projection_evidence_sha256" "$route_evidence_sha256"
			printf 'core_backup_sha256=%s\nbilling_backup_sha256=%s\nrestore_evidence_sha256=%s\n' "$core_backup_sha256" "$billing_backup_sha256" "$restore_evidence_sha256"
			printf 'queue_drain_evidence_sha256=%s\nstopped_writers_evidence_sha256=%s\n' "$queue_drain_evidence_sha256" "$stopped_writers_evidence_sha256"
			printf 'pre_offsite_receipt_sha256=%s\nretention_decision=%s\nretention_reference=%s\n' "$pre_offsite_receipt_sha256" "$retention_decision" "$retention_reference"
			printf 'core_system_identifier=%s\nbilling_system_identifier=%s\nbilling_database_id=%s\n' "$core_system_identifier" "$billing_system_identifier" "$billing_database_id"
			printf 'post_cleanup_backup_sha256=%s\npost_restore_evidence_sha256=%s\npost_offsite_receipt_sha256=%s\ncompletion_evidence_sha256=%s\n' "$post_cleanup_backup_sha256" "$post_restore_evidence_sha256" "$post_offsite_receipt_sha256" "$completion_evidence_sha256"
			printf 'created_at=%s\nupdated_at=%s\n' "$created_at" "$updated_at"
		} >"$temporary") &&
			chown 0:0 "$temporary" && chmod 600 "$temporary" &&
			billing_core_source_cleanup_validate_marker_contents "$temporary" &&
			mv -f "$temporary" "$marker_file"
	}; then
		rm -f -- "$temporary"
		return 1
	fi
	billing_core_source_cleanup_validate_marker
}

billing_core_source_cleanup_rewrite_marker() {
	[[ $# -eq 11 ]] || return 1
	local next_phase="$1" core_backup_sha256="$2" billing_backup_sha256="$3"
	local restore_evidence_sha256="$4" queue_drain_evidence_sha256="$5"
	local stopped_writers_evidence_sha256="$6" pre_offsite_receipt_sha256="$7"
	local core_system_identifier="$8" billing_system_identifier="$9"
	local billing_database_id="${10}" post_values="${11}" created_at
	local post_backup='pending' post_restore='pending' post_receipt='pending' completion='pending'
	billing_core_source_cleanup_validate_marker || return 1
	created_at="$(billing_core_source_cleanup_marker_value created_at)" || return 1
	if [[ "$post_values" != 'pending' ]]; then
		IFS='|' read -r post_backup post_restore post_receipt completion <<<"$post_values"
		[[ "$post_values" == *'|'* && "$completion" != "$post_values" ]] || return 1
	fi
	billing_core_source_cleanup_write_marker \
		"$next_phase" \
		"$(billing_core_source_cleanup_marker_value previous_revision)" \
		"$(billing_core_source_cleanup_marker_value revision)" \
		"$(billing_core_source_cleanup_marker_value ownership_generation)" \
		"$(billing_core_source_cleanup_marker_value cleanup_core_image_id)" \
		"$(billing_core_source_cleanup_marker_value cleanup_billing_image_id)" \
		"$(billing_core_source_cleanup_marker_value source_snapshot_sha256)" \
		"$(billing_core_source_cleanup_marker_value projection_evidence_sha256)" \
		"$(billing_core_source_cleanup_marker_value route_evidence_sha256)" \
		"$core_backup_sha256" "$billing_backup_sha256" "$restore_evidence_sha256" \
		"$queue_drain_evidence_sha256" "$stopped_writers_evidence_sha256" \
		"$pre_offsite_receipt_sha256" approved "$pre_offsite_receipt_sha256" \
		"$core_system_identifier" "$billing_system_identifier" "$billing_database_id" \
		"$post_backup" "$post_restore" "$post_receipt" "$completion" "$created_at"
}

billing_core_source_cleanup_bind_staged_evidence() {
	[[ $# -eq 9 ]] || return 1
	[[ "$(billing_core_source_cleanup_marker_value phase)" == 'staged' ]] || return 1
	billing_core_source_cleanup_rewrite_marker staged "$@" pending
}

billing_core_source_cleanup_advance_applied() {
	[[ $# -eq 0 && "$(billing_core_source_cleanup_marker_value phase)" =~ ^(staged|applied)$ ]] ||
		return 1
	billing_core_source_cleanup_rewrite_marker applied \
		"$(billing_core_source_cleanup_marker_value core_backup_sha256)" \
		"$(billing_core_source_cleanup_marker_value billing_backup_sha256)" \
		"$(billing_core_source_cleanup_marker_value restore_evidence_sha256)" \
		"$(billing_core_source_cleanup_marker_value queue_drain_evidence_sha256)" \
		"$(billing_core_source_cleanup_marker_value stopped_writers_evidence_sha256)" \
		"$(billing_core_source_cleanup_marker_value pre_offsite_receipt_sha256)" \
		"$(billing_core_source_cleanup_marker_value core_system_identifier)" \
		"$(billing_core_source_cleanup_marker_value billing_system_identifier)" \
		"$(billing_core_source_cleanup_marker_value billing_database_id)" pending
}

billing_core_source_cleanup_advance_complete() {
	[[ $# -eq 4 && "$(billing_core_source_cleanup_marker_value phase)" =~ ^(applied|complete)$ ]] ||
		return 1
	local post_values="$1|$2|$3|$4"
	billing_core_source_cleanup_rewrite_marker complete \
		"$(billing_core_source_cleanup_marker_value core_backup_sha256)" \
		"$(billing_core_source_cleanup_marker_value billing_backup_sha256)" \
		"$(billing_core_source_cleanup_marker_value restore_evidence_sha256)" \
		"$(billing_core_source_cleanup_marker_value queue_drain_evidence_sha256)" \
		"$(billing_core_source_cleanup_marker_value stopped_writers_evidence_sha256)" \
		"$(billing_core_source_cleanup_marker_value pre_offsite_receipt_sha256)" \
		"$(billing_core_source_cleanup_marker_value core_system_identifier)" \
		"$(billing_core_source_cleanup_marker_value billing_system_identifier)" \
		"$(billing_core_source_cleanup_marker_value billing_database_id)" "$post_values"
}

billing_core_source_cleanup_stage_marker() {
	[[ $# -eq 4 ]] || return 1
	local previous_revision="$1" revision="$2" cleanup_core_image_id="$3"
	local cleanup_billing_image_id="$4" generation snapshot projection route created_at
	billing_release_validate_revision "$previous_revision" || return 1
	billing_release_validate_revision "$revision" || return 1
	[[ "$previous_revision" != "$revision" &&
		"$cleanup_core_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$cleanup_billing_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	billing_database_validate_marker || return 1
	[[ "$(billing_database_marker_value phase)" == 'complete' &&
		"$(billing_database_marker_value ownership_revision)" == "$previous_revision" &&
		"$(billing_database_marker_value cleanup_revision)" == "$revision" ]] || return 1
	[[ -f "$billing_cutover_marker" && ! -L "$billing_cutover_marker" &&
		"$(billing_core_source_cleanup_stat_owner "$billing_cutover_marker")" == '0:0' &&
		"$(billing_core_source_cleanup_stat_mode "$billing_cutover_marker")" == '600' &&
		"$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" phase)" == 'complete' &&
		"$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" revision)" == "$previous_revision" &&
		"$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" cleanup_revision)" == "$revision" ]] || return 1
	generation="$(billing_database_marker_value switch_generation)" || return 1
	snapshot="$(billing_database_marker_value snapshot_sha256)" || return 1
	projection="$(billing_database_marker_value projection_evidence_sha256)" || return 1
	route="$(billing_database_marker_value route_evidence_sha256)" || return 1
	[[ "$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" generation)" == "$generation" &&
		"$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" snapshot_sha256)" == "$snapshot" &&
		"$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" projection_sha256)" == "$projection" &&
		"$(billing_core_source_cleanup_parent_marker_value "$billing_cutover_marker" route_sha256)" == "$route" ]] || return 1
	created_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	billing_core_source_cleanup_write_marker staged "$previous_revision" "$revision" \
		"$generation" "$cleanup_core_image_id" "$cleanup_billing_image_id" \
		"$snapshot" "$projection" "$route" \
		pending pending pending pending pending pending approved pending \
		pending pending pending pending pending pending pending "$created_at"
}

billing_core_source_cleanup_migration_url() {
	[[ $# -eq 12 ]] || return 1
	local base_url="$1" generation="$2" previous_revision="$3" cleanup_revision="$4"
	local snapshot="$5" core_backup="$6" billing_backup="$7" restore_evidence="$8"
	local offsite_receipt="$9" queue_drain="${10}" stopped_writers="${11}"
	local retention_reference="${12}"
	local zero_sha
	zero_sha="$(printf '0%.0s' {1..64})"
	[[ -n "$base_url" && "$generation" == '2' &&
		"$previous_revision" =~ ^[0-9a-f]{40}$ && "$previous_revision" != "$(printf '0%.0s' {1..40})" &&
		"$cleanup_revision" =~ ^[0-9a-f]{40}$ && "$cleanup_revision" != "$(printf '0%.0s' {1..40})" &&
		"$previous_revision" != "$cleanup_revision" ]] || return 1
	local hash
	for hash in "$snapshot" "$core_backup" "$billing_backup" "$restore_evidence" "$offsite_receipt" \
		"$queue_drain" "$stopped_writers" "$retention_reference"; do
		[[ "$hash" =~ ^[0-9a-f]{64}$ && "$hash" != "$zero_sha" ]] || return 1
	done
	BASE_DATABASE_URL="$base_url" BILLING_CLEANUP_GENERATION="$generation" \
		BILLING_CLEANUP_PREVIOUS_REVISION="$previous_revision" \
		BILLING_CLEANUP_REVISION="$cleanup_revision" BILLING_CLEANUP_SNAPSHOT="$snapshot" \
		BILLING_CLEANUP_CORE_BACKUP="$core_backup" \
		BILLING_CLEANUP_BILLING_BACKUP="$billing_backup" \
		BILLING_CLEANUP_RESTORE_EVIDENCE="$restore_evidence" \
		BILLING_CLEANUP_OFFSITE_RECEIPT="$offsite_receipt" \
		BILLING_CLEANUP_QUEUE_DRAIN="$queue_drain" \
		BILLING_CLEANUP_STOPPED_WRITERS="$stopped_writers" \
		BILLING_CLEANUP_RETENTION_REFERENCE="$retention_reference" billing_release_node - <<'NODE'
let databaseUrl;
try {
  databaseUrl = new URL(process.env.BASE_DATABASE_URL);
} catch {
  process.exit(1);
}
if (
  !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
  databaseUrl.pathname !== '/default_db'
) process.exit(1);
const existingOptions = databaseUrl.searchParams.getAll('options');
if (existingOptions.length > 1) process.exit(1);
const cleanupOptions = [
  '-c winwidget.billing_core_source_cleanup=production-destructive-approved',
  '-c winwidget.billing_ownership_phase=complete',
  `-c winwidget.billing_ownership_generation=${process.env.BILLING_CLEANUP_GENERATION}`,
  `-c winwidget.billing_ownership_revision=${process.env.BILLING_CLEANUP_PREVIOUS_REVISION}`,
  `-c winwidget.billing_cleanup_revision=${process.env.BILLING_CLEANUP_REVISION}`,
  `-c winwidget.billing_source_snapshot_sha256=${process.env.BILLING_CLEANUP_SNAPSHOT}`,
  `-c winwidget.billing_core_backup_sha256=${process.env.BILLING_CLEANUP_CORE_BACKUP}`,
  `-c winwidget.billing_backup_sha256=${process.env.BILLING_CLEANUP_BILLING_BACKUP}`,
  `-c winwidget.billing_restore_evidence_sha256=${process.env.BILLING_CLEANUP_RESTORE_EVIDENCE}`,
  `-c winwidget.billing_offsite_receipt_sha256=${process.env.BILLING_CLEANUP_OFFSITE_RECEIPT}`,
  `-c winwidget.billing_queue_drain_evidence_sha256=${process.env.BILLING_CLEANUP_QUEUE_DRAIN}`,
  `-c winwidget.billing_stopped_writers_evidence_sha256=${process.env.BILLING_CLEANUP_STOPPED_WRITERS}`,
  '-c winwidget.billing_retention_decision=approved',
  `-c winwidget.billing_retention_reference=${process.env.BILLING_CLEANUP_RETENTION_REFERENCE}`,
].join(' ');
const existing = existingOptions[0]?.trim();
databaseUrl.searchParams.set('options', existing ? `${existing} ${cleanupOptions}` : cleanupOptions);
const serialized = databaseUrl.toString().replace(
  /([?&]options=)([^&#]*)/,
  (_, prefix, value) => `${prefix}${value.replace(/\+/g, '%20')}`,
);
process.stdout.write(serialized);
NODE
}

billing_core_source_cleanup_migration_url_from_env() {
	[[ $# -eq 11 ]] || return 1
	local database_migration_url
	database_migration_url="$(billing_read_env_value "$ENV_FILE" DATABASE_MIGRATION_URL_PRODUCTION)" ||
		return 1
	[[ -n "$database_migration_url" ]] || return 1
	billing_core_source_cleanup_migration_url "$database_migration_url" "$@"
}

billing_core_source_cleanup_migration_url_from_marker() {
	[[ $# -eq 0 ]] || return 1
	billing_core_source_cleanup_migration_url_from_env \
		"$(billing_core_source_cleanup_marker_value ownership_generation)" \
		"$(billing_core_source_cleanup_marker_value previous_revision)" \
		"$(billing_core_source_cleanup_marker_value revision)" \
		"$(billing_core_source_cleanup_marker_value source_snapshot_sha256)" \
		"$(billing_core_source_cleanup_marker_value core_backup_sha256)" \
		"$(billing_core_source_cleanup_marker_value billing_backup_sha256)" \
		"$(billing_core_source_cleanup_marker_value restore_evidence_sha256)" \
		"$(billing_core_source_cleanup_marker_value pre_offsite_receipt_sha256)" \
		"$(billing_core_source_cleanup_marker_value queue_drain_evidence_sha256)" \
		"$(billing_core_source_cleanup_marker_value stopped_writers_evidence_sha256)" \
		"$(billing_core_source_cleanup_marker_value retention_reference)"
}

billing_core_source_cleanup_evidence_file_for_key() {
	[[ $# -eq 2 ]] || return 1
	case "$2" in
	core_backup_sha256) printf '%s/core-pre-cleanup.dump\n' "$1" ;;
	billing_backup_sha256) printf '%s/billing-pre-cleanup.dump\n' "$1" ;;
	restore_evidence_sha256) printf '%s/pre-restore-evidence.json\n' "$1" ;;
	queue_drain_evidence_sha256) printf '%s/queue-drain-evidence.json\n' "$1" ;;
	stopped_writers_evidence_sha256) printf '%s/stopped-writers-evidence.json\n' "$1" ;;
	pre_offsite_receipt_sha256) printf '%s/pre-offsite-receipt.json\n' "$1" ;;
	post_cleanup_backup_sha256) printf '%s/core-post-cleanup.dump\n' "$1" ;;
	post_restore_evidence_sha256) printf '%s/post-restore-evidence.json\n' "$1" ;;
	post_offsite_receipt_sha256) printf '%s/post-offsite-receipt.json\n' "$1" ;;
	completion_evidence_sha256) printf '%s/completion-evidence.json\n' "$1" ;;
	*) return 1 ;;
	esac
}

billing_core_source_cleanup_require_evidence() {
	local revision generation directory key expected file phase
	billing_core_source_cleanup_validate_marker || return 1
	revision="$(billing_core_source_cleanup_marker_value revision)" || return 1
	generation="$(billing_core_source_cleanup_marker_value ownership_generation)" || return 1
	directory="$(billing_core_source_cleanup_evidence_directory "$revision" "$generation")" || return 1
	[[ -d "$directory" && ! -L "$directory" &&
		"$(billing_core_source_cleanup_stat_owner "$directory")" == '0:0' &&
		"$(billing_core_source_cleanup_stat_mode "$directory")" =~ ^(700|750)$ ]] || return 1
	phase="$(billing_core_source_cleanup_marker_value phase)" || return 1
	for key in core_backup_sha256 billing_backup_sha256 restore_evidence_sha256 \
		queue_drain_evidence_sha256 stopped_writers_evidence_sha256 \
		pre_offsite_receipt_sha256 post_cleanup_backup_sha256 \
		post_restore_evidence_sha256 post_offsite_receipt_sha256 \
		completion_evidence_sha256; do
		expected="$(billing_core_source_cleanup_marker_value "$key")" || return 1
		if [[ "$expected" == 'pending' ]]; then
			if [[ "$phase" =~ ^(applied|complete)$ &&
				"$key" =~ ^(core_backup_sha256|billing_backup_sha256|restore_evidence_sha256|queue_drain_evidence_sha256|stopped_writers_evidence_sha256|pre_offsite_receipt_sha256)$ ]]; then
				return 1
			fi
			if [[ "$phase" == 'complete' ]]; then return 1; fi
			continue
		fi
		file="$(billing_core_source_cleanup_evidence_file_for_key "$directory" "$key")" ||
			return 1
		billing_core_source_cleanup_validate_private_file "$file" "$expected" || return 1
	done
}

billing_core_database_query() {
	[[ $# -eq 1 ]] || return 1
	local database_url postgres_image
	database_url="$(billing_read_env_value "$ENV_FILE" DATABASE_MIGRATION_URL_PRODUCTION)" ||
		return 1
	database_url="$(billing_normalize_libpq_url_value "$database_url")" || return 1
	postgres_image="$(billing_read_env_value "$ENV_FILE" CORE_POSTGRES_IMAGE 2>/dev/null || true)"
	postgres_image="${postgres_image:-$billing_core_postgres_image}"
	PGURL="$database_url" BILLING_CORE_SQL="$1" \
		docker run --rm --network host -e PGURL -e BILLING_CORE_SQL \
			--entrypoint sh "$postgres_image" -euc '
				exec psql "$PGURL" --no-psqlrc --tuples-only --no-align \
					--set ON_ERROR_STOP=1 --command "$BILLING_CORE_SQL"
			' 2>/dev/null
}

billing_core_source_state_from_counts() {
	[[ $# -eq 2 && "$1" =~ ^[0-9]+$ && "$2" =~ ^[0-9]+$ ]] || return 1
	case "$1:$2" in
	0:0) printf 'absent\n' ;;
	9:6) printf 'present\n' ;;
	*) printf 'partial\n' ;;
	esac
}

billing_core_source_state() {
	local result relation_count column_count
	result="$(billing_core_database_query "
SELECT
  (SELECT count(*)
   FROM unnest(ARRAY[
     'payments','payment_receipts','subscriptions','subscription_history',
     'subscription_expiry_reminders','auto_renewals',
     'auto_renewal_consent_events','tariff_prices','affiliate_referrals'
   ]) AS expected(relation_name)
   WHERE to_regclass(format('public.%I', relation_name)) IS NOT NULL)
  || E'\\t' ||
  (SELECT count(*)
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'site_settings'
     AND column_name = ANY(ARRAY[
       'payment_enabled','auto_renewal_signup_enabled',
       'auto_renewal_charges_enabled','auto_renewal_charges_enabled_at',
       'affiliate_program_enabled','affiliate_cashback_percent'
     ]));
")" || {
		echo 'Core Billing source state cannot be read; failing closed.' >&2
		return 1
	}
	IFS=$'\t' read -r relation_count column_count <<<"$result"
	billing_core_source_state_from_counts "$relation_count" "$column_count"
}

billing_core_source_cleanup_migration_state_from_counts() {
	[[ $# -eq 5 ]] || return 1
	local total="$1" mismatched="$2" applied="$3" unfinished="$4" rolled_back="$5"
	[[ "$total" =~ ^[0-9]+$ && "$mismatched" =~ ^[0-9]+$ &&
		"$applied" =~ ^[0-9]+$ && "$unfinished" =~ ^[0-9]+$ &&
		"$rolled_back" =~ ^[0-9]+$ ]] || return 1
	if ((total == 0)); then
		printf 'pending\n'
	elif ((mismatched != 0 || applied > 1 || unfinished > 1 ||
		applied + unfinished + rolled_back != total)); then
		printf 'unsafe\n'
	elif ((applied == 1 && unfinished == 0)); then
		printf 'applied\n'
	elif ((applied == 0 && unfinished == 1)); then
		printf 'unfinished\n'
	elif ((applied == 0 && unfinished == 0 && rolled_back >= 1)); then
		printf 'rolled-back\n'
	else
		printf 'unsafe\n'
	fi
}

billing_core_source_cleanup_migration_state() {
	local expected_checksum result total mismatched applied unfinished rolled_back
	expected_checksum="$(billing_core_source_cleanup_migration_checksum)" || return 1
	result="$(billing_core_database_query "
SELECT count(*) || E'\\t' ||
       count(*) FILTER (WHERE checksum <> '$expected_checksum') || E'\\t' ||
       count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || E'\\t' ||
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) || E'\\t' ||
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL)
FROM public.\"_prisma_migrations\"
WHERE migration_name = '$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME';
")" || return 1
	IFS=$'\t' read -r total mismatched applied unfinished rolled_back <<<"$result"
	billing_core_source_cleanup_migration_state_from_counts \
		"$total" "$mismatched" "$applied" "$unfinished" "$rolled_back" ||
		printf 'unsafe\n'
}

billing_core_source_cleanup_migration_manifest_json() {
	MIGRATIONS_ROOT="$server_root/prisma/migrations" \
		CLEANUP_MIGRATION="$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME" billing_release_node - <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.MIGRATIONS_ROOT;
const target = process.env.CLEANUP_MIGRATION;
const rootStat = fs.lstatSync(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) process.exit(1);
const manifest = {};
for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) =>
  a.name.localeCompare(b.name, 'en'))) {
  if (entry.name === 'migration_lock.toml') {
    const lockStat = fs.lstatSync(path.join(root, entry.name));
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) process.exit(1);
    continue;
  }
  if (!/^\d{14}_[a-z0-9_]+$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
    process.exit(1);
  const directory = path.join(root, entry.name);
  const files = fs.readdirSync(directory).sort();
  if (files.length !== 1 || files[0] !== 'migration.sql') process.exit(1);
  const migration = path.join(directory, 'migration.sql');
  const migrationStat = fs.lstatSync(migration);
  if (!migrationStat.isFile() || migrationStat.isSymbolicLink()) process.exit(1);
  manifest[entry.name] = crypto.createHash('sha256').update(fs.readFileSync(migration)).digest('hex');
}
if (!Object.hasOwn(manifest, target)) process.exit(1);
process.stdout.write(JSON.stringify(manifest));
NODE
}

billing_core_source_cleanup_validate_migration_manifest_state() {
	[[ $# -eq 3 && "$3" =~ ^(exclusive|applied)$ ]] || return 1
	MIGRATION_MANIFEST_JSON="$1" MIGRATION_LEDGER_ROWS="$2" \
		CLEANUP_MIGRATION="$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME" \
		EXPECTED_CLEANUP_STATE="$3" billing_release_node - <<'NODE'
let manifest;
try { manifest = JSON.parse(process.env.MIGRATION_MANIFEST_JSON || ''); } catch { process.exit(1); }
if (!manifest || Array.isArray(manifest)) process.exit(1);
const names = Object.keys(manifest);
const target = process.env.CLEANUP_MIGRATION;
if (!names.length || !names.includes(target) ||
    names.some(name => !/^\d{14}_[a-z0-9_]+$/.test(name) || !/^[0-9a-f]{64}$/.test(manifest[name])))
  process.exit(1);
if (process.env.EXPECTED_CLEANUP_STATE === 'exclusive' && names.at(-1) !== target)
  process.exit(1);
const ledger = new Map(names.map(name => [name, []]));
for (const line of (process.env.MIGRATION_LEDGER_ROWS || '').split('\n').filter(Boolean)) {
  const fields = line.split('\t');
  if (fields.length !== 3 || !ledger.has(fields[0]) || !/^[0-9a-f]{64}$/.test(fields[1]) ||
      !['applied', 'unfinished', 'rolled-back'].includes(fields[2])) process.exit(1);
  ledger.get(fields[0]).push({ checksum: fields[1], state: fields[2] });
}
for (const name of names) {
  const rows = ledger.get(name);
  if (rows.some(row => row.checksum !== manifest[name])) process.exit(1);
  const applied = rows.filter(row => row.state === 'applied').length;
  const unfinished = rows.filter(row => row.state === 'unfinished').length;
  if (name !== target) {
    if (applied !== 1 || unfinished !== 0) process.exit(1);
    continue;
  }
  if (process.env.EXPECTED_CLEANUP_STATE === 'applied') {
    if (applied !== 1 || unfinished !== 0) process.exit(1);
  } else if (applied !== 0 || unfinished > 1) {
    process.exit(1);
  }
}
NODE
}

billing_core_source_cleanup_require_exact_migration_manifest() {
	[[ $# -eq 1 && "$1" =~ ^(exclusive|applied)$ ]] || return 1
	local manifest ledger
	manifest="$(billing_core_source_cleanup_migration_manifest_json)" || return 1
	ledger="$(billing_core_database_query '
SELECT migration_name || CHR(9) || checksum || CHR(9) ||
       CASE
         WHEN rolled_back_at IS NOT NULL THEN $ledger$rolled-back$ledger$
         WHEN finished_at IS NOT NULL THEN $ledger$applied$ledger$
         WHEN finished_at IS NULL THEN $ledger$unfinished$ledger$
       END
FROM public."_prisma_migrations"
ORDER BY migration_name, started_at, id;
')" || return 1
	billing_core_source_cleanup_validate_migration_manifest_state \
		"$manifest" "$ledger" "$1"
}

billing_core_source_cleanup_recovery_action() {
	[[ $# -eq 2 ]] || return 1
	case "$1|$2" in
	present\|pending | present\|rolled-back | present\|unfinished) printf 'restore-exact\n' ;;
	absent\|unfinished | absent\|applied) printf 'forward-only\n' ;;
	*) printf 'halt\n' ;;
	esac
}

billing_require_core_source_absent() {
	[[ "$(billing_core_source_cleanup_migration_state)" == 'applied' &&
		"$(billing_core_source_state)" == 'absent' ]]
}

billing_database_guard_revision() {
	[[ $# -eq 1 || $# -eq 2 ]] || return 1
	local revision="$1" guard_action="${2:---guard-before-checkout-revision}"
	local phase ownership_revision cleanup_revision cleanup_marker cleanup_phase
	local marker_revision marker_checksum target_checksum
	billing_release_validate_revision "$revision" || return 1
	[[ "$guard_action" =~ ^--guard-before-(fetch|checkout)-revision$ ]] || return 1
	phase="$(billing_database_current_phase)" || return 1
	[[ "$phase" == 'absent' ]] && return 0
	ownership_revision="$(billing_database_marker_value ownership_revision)"
	cleanup_revision="$(billing_database_marker_value cleanup_revision)"
	cleanup_marker="$(billing_core_source_cleanup_marker_path)" || return 1
	if [[ -e "$cleanup_marker" || -L "$cleanup_marker" ]]; then
		billing_core_source_cleanup_validate_marker ||
			billing_database_fail 'Billing Core source cleanup marker is present but invalid.' ||
			return 1
		cleanup_phase="$(billing_core_source_cleanup_marker_value phase)" || return 1
		marker_revision="$(billing_core_source_cleanup_marker_value revision)" || return 1
		marker_checksum="$(billing_core_source_cleanup_marker_value migration_sha256)" || return 1
		[[ "$phase" == 'complete' &&
			"$ownership_revision" == "$(billing_core_source_cleanup_marker_value previous_revision)" &&
			"$cleanup_revision" == "$marker_revision" ]] ||
			billing_database_fail 'Billing cleanup marker is not bound to the complete ownership markers.' ||
			return 1
		if [[ "$cleanup_phase" =~ ^(staged|applied)$ && "$revision" != "$marker_revision" ]]; then
			billing_database_fail \
				"Billing Core source cleanup pins deployment to revision $marker_revision until post-cleanup evidence is complete."
			return 1
		fi
		if [[ "$cleanup_phase" =~ ^(applied|complete)$ ]]; then
			billing_core_source_cleanup_require_evidence ||
				billing_database_fail 'Billing Core source cleanup evidence is missing or invalid.' ||
				return 1
		fi
		if [[ "$guard_action" == '--guard-before-checkout-revision' ]]; then
			git -C "$server_root" cat-file -e \
				"$revision:scripts/billing-database-lifecycle.sh" 2>/dev/null || {
				billing_database_fail \
					'Target revision would remove the Billing Core source cleanup guard.'
				return 1
			}
			target_checksum="$({
				git -C "$server_root" show \
					"$revision:prisma/migrations/$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME/migration.sql" 2>/dev/null
			} | billing_core_source_cleanup_sha256_stream)" || return 1
			[[ "$target_checksum" == "$marker_checksum" ]] || {
				billing_database_fail \
					'Target revision changed or removed the Billing Core source cleanup migration.'
				return 1
			}
			if [[ "$cleanup_phase" == 'complete' ]]; then
				git -C "$server_root" merge-base --is-ancestor \
					"$marker_revision" "$revision" || {
					billing_database_fail \
						'Target revision would downgrade past the completed Billing Core source cleanup.'
					return 1
				}
			fi
		fi
		return 0
	fi
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
	local source cleanup_sha cleanup_url cleanup_options revision previous_revision
	local table_name column_name other_sha migration_manifest migration_rows
	cleanup_sha="$(printf 'a%.0s' {1..64})"
	other_sha="$(printf 'b%.0s' {1..64})"
	revision="$(printf 'b%.0s' {1..40})"
	previous_revision="$(printf 'a%.0s' {1..40})"
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
	! billing_core_source_cleanup_advance_applied unexpected-argument
	[[ "$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME" =~ ^[0-9]{14}_[a-z0-9_]+$ &&
		"$(billing_core_source_cleanup_migration_checksum)" =~ ^[0-9a-f]{64}$ &&
		"${#BILLING_CANONICAL_CORE_SOURCE_TABLES[@]}" == '9' &&
		"${#BILLING_CANONICAL_CORE_SITE_SETTINGS_COLUMNS[@]}" == '6' ]]
	[[ "$(printf '%s\n' "${BILLING_CANONICAL_CORE_SOURCE_TABLES[@]}" |
		LC_ALL=C sort -u | wc -l | tr -d '[:space:]')" == '9' ]]
	[[ "$(printf '%s\n' "${BILLING_CANONICAL_CORE_SITE_SETTINGS_COLUMNS[@]}" |
		LC_ALL=C sort -u | wc -l | tr -d '[:space:]')" == '6' ]]
	for table_name in "${BILLING_CANONICAL_CORE_SOURCE_TABLES[@]}"; do
		[[ "$table_name" =~ ^[a-z][a-z0-9_]*$ ]]
	done
	for column_name in "${BILLING_CANONICAL_CORE_SITE_SETTINGS_COLUMNS[@]}"; do
		[[ "$column_name" =~ ^[a-z][a-z0-9_]*$ ]]
	done
	[[ "$(billing_core_source_state_from_counts 0 0)" == 'absent' &&
		"$(billing_core_source_state_from_counts 9 6)" == 'present' &&
		"$(billing_core_source_state_from_counts 8 6)" == 'partial' &&
		"$(billing_core_source_state_from_counts 9 5)" == 'partial' ]]
	! billing_core_source_state_from_counts invalid 0 >/dev/null 2>&1
	[[ "$(billing_core_source_cleanup_migration_state_from_counts 0 0 0 0 0)" == 'pending' &&
		"$(billing_core_source_cleanup_migration_state_from_counts 1 0 0 1 0)" == 'unfinished' &&
		"$(billing_core_source_cleanup_migration_state_from_counts 1 0 0 0 1)" == 'rolled-back' &&
		"$(billing_core_source_cleanup_migration_state_from_counts 2 0 1 0 1)" == 'applied' &&
		"$(billing_core_source_cleanup_migration_state_from_counts 2 1 1 0 0)" == 'unsafe' ]]
	! billing_core_source_cleanup_migration_state_from_counts invalid 0 0 0 0 >/dev/null 2>&1
	migration_manifest="$(printf '{"20260101000000_old":"%s","%s":"%s"}' \
		"$other_sha" "$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME" "$cleanup_sha")"
	migration_rows="$(printf '20260101000000_old\t%s\tapplied\n' "$other_sha")"
	billing_core_source_cleanup_validate_migration_manifest_state \
		"$migration_manifest" "$migration_rows" exclusive
	billing_core_source_cleanup_validate_migration_manifest_state \
		"$migration_manifest" \
		"$migration_rows"$'\n'"$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME"$'\t'"$cleanup_sha"$'\tunfinished' \
		exclusive
	billing_core_source_cleanup_validate_migration_manifest_state \
		"$migration_manifest" \
		"$migration_rows"$'\n'"$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME"$'\t'"$cleanup_sha"$'\tapplied' \
		applied
	! billing_core_source_cleanup_validate_migration_manifest_state \
		"$migration_manifest" \
		"$migration_rows"$'\n'"$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME"$'\t'"$cleanup_sha"$'\tapplied' \
		exclusive
	! billing_core_source_cleanup_validate_migration_manifest_state \
		"$migration_manifest" \
		"20260101000000_old"$'\t'"$other_sha"$'\tunfinished' exclusive
	! billing_core_source_cleanup_validate_migration_manifest_state \
		"$migration_manifest" \
		"$migration_rows"$'\n'"20990101000000_unknown"$'\t'"$cleanup_sha"$'\tapplied' exclusive
	migration_manifest="$(printf '{"20260101000000_old":"%s","%s":"%s","20260901000000_later":"%s"}' \
		"$other_sha" "$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME" "$cleanup_sha" "$other_sha")"
	migration_rows="$(printf '20260101000000_old\t%s\tapplied\n%s\t%s\tapplied\n20260901000000_later\t%s\tapplied\n' \
		"$other_sha" "$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME" "$cleanup_sha" "$other_sha")"
	billing_core_source_cleanup_validate_migration_manifest_state \
		"$migration_manifest" "$migration_rows" applied
	! billing_core_source_cleanup_validate_migration_manifest_state \
		"$migration_manifest" "$migration_rows" exclusive
	[[ "$(billing_core_source_cleanup_recovery_action present pending)" == 'restore-exact' &&
		"$(billing_core_source_cleanup_recovery_action present rolled-back)" == 'restore-exact' &&
		"$(billing_core_source_cleanup_recovery_action present unfinished)" == 'restore-exact' &&
		"$(billing_core_source_cleanup_recovery_action absent unfinished)" == 'forward-only' &&
		"$(billing_core_source_cleanup_recovery_action absent applied)" == 'forward-only' &&
		"$(billing_core_source_cleanup_recovery_action partial unfinished)" == 'halt' &&
		"$(billing_core_source_cleanup_recovery_action present applied)" == 'halt' ]]
	cleanup_url="$(billing_core_source_cleanup_migration_url \
		'postgresql://migration:masked@127.0.0.1:55432/default_db?schema=public&options=-c%20existing.setting%3Dretained' \
		2 "$previous_revision" "$revision" "$cleanup_sha" "$cleanup_sha" \
		"$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" \
		"$cleanup_sha")"
	cleanup_options="$(CLEANUP_URL="$cleanup_url" billing_release_node -e \
		'process.stdout.write(new URL(process.env.CLEANUP_URL).searchParams.get("options") ?? "")')"
	[[ "$cleanup_url" == postgresql://migration:masked@127.0.0.1:55432/default_db* &&
		"$cleanup_url" == *'%20'* && "$cleanup_url" != *'+'* &&
		"$cleanup_options" == '-c existing.setting=retained -c winwidget.billing_core_source_cleanup=production-destructive-approved -c winwidget.billing_ownership_phase=complete -c winwidget.billing_ownership_generation=2 -c winwidget.billing_ownership_revision='"$previous_revision"' -c winwidget.billing_cleanup_revision='"$revision"' -c winwidget.billing_source_snapshot_sha256='"$cleanup_sha"' -c winwidget.billing_core_backup_sha256='"$cleanup_sha"' -c winwidget.billing_backup_sha256='"$cleanup_sha"' -c winwidget.billing_restore_evidence_sha256='"$cleanup_sha"' -c winwidget.billing_offsite_receipt_sha256='"$cleanup_sha"' -c winwidget.billing_queue_drain_evidence_sha256='"$cleanup_sha"' -c winwidget.billing_stopped_writers_evidence_sha256='"$cleanup_sha"' -c winwidget.billing_retention_decision=approved -c winwidget.billing_retention_reference='"$cleanup_sha" ]]
	! billing_core_source_cleanup_migration_url \
		'https://example.test/not-postgres' 2 "$previous_revision" "$revision" \
		"$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" \
		"$cleanup_sha" "$cleanup_sha" "$cleanup_sha" >/dev/null 2>&1
	! billing_core_source_cleanup_migration_url \
		'postgresql://migration:masked@127.0.0.1/default_db' 2 "$revision" "$revision" \
		"$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" \
		"$cleanup_sha" "$cleanup_sha" "$cleanup_sha" >/dev/null 2>&1
	(
		local marker_directory marker_file marker_timestamp image_id
		marker_directory="$(mktemp -d "${TMPDIR:-/tmp}/billing-cleanup-marker.XXXXXX")"
		marker_file="$marker_directory/marker"
		marker_timestamp='2026-08-13T00:00:00Z'
		image_id="sha256:$cleanup_sha"
		trap 'rm -f -- "$marker_file"; rmdir -- "$marker_directory"' EXIT
		{
			printf 'version=1\nphase=staged\nprevious_revision=%s\nrevision=%s\n' "$previous_revision" "$revision"
			printf 'migration_name=%s\nmigration_sha256=%s\n' "$BILLING_CORE_SOURCE_CLEANUP_MIGRATION_NAME" "$cleanup_sha"
			printf 'ownership_generation=2\ncleanup_core_image_id=%s\ncleanup_billing_image_id=%s\n' "$image_id" "$image_id"
			printf 'source_snapshot_sha256=%s\nprojection_evidence_sha256=%s\nroute_evidence_sha256=%s\n' "$cleanup_sha" "$cleanup_sha" "$cleanup_sha"
			printf 'core_backup_sha256=pending\nbilling_backup_sha256=pending\nrestore_evidence_sha256=pending\n'
			printf 'queue_drain_evidence_sha256=pending\nstopped_writers_evidence_sha256=pending\n'
			printf 'pre_offsite_receipt_sha256=pending\nretention_decision=approved\nretention_reference=pending\n'
			printf 'core_system_identifier=pending\nbilling_system_identifier=pending\nbilling_database_id=pending\n'
			printf 'post_cleanup_backup_sha256=pending\npost_restore_evidence_sha256=pending\npost_offsite_receipt_sha256=pending\ncompletion_evidence_sha256=pending\n'
			printf 'created_at=%s\nupdated_at=%s\n' "$marker_timestamp" "$marker_timestamp"
		} >"$marker_file"
		billing_core_source_cleanup_validate_marker_contents "$marker_file"
		sed 's/retention_reference=pending/retention_reference=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
			"$marker_file" >"$marker_file.changed"
		mv "$marker_file.changed" "$marker_file"
		! billing_core_source_cleanup_validate_marker_contents "$marker_file"
	)
	(
		local temporary_root backend_directory marker_file marker_timestamp image_id other_sha
		temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/billing-cleanup-write.XXXXXX")"
		backend_directory="$temporary_root/deploy/backend"
		mkdir -p "$backend_directory"
		chmod 700 "$backend_directory"
		APP_ROOT="$temporary_root"
		marker_file="$(billing_core_source_cleanup_marker_path)"
		marker_timestamp='2026-08-13T00:00:00Z'
		image_id="sha256:$cleanup_sha"
		other_sha="$(printf 'b%.0s' {1..64})"
		billing_core_source_cleanup_stat_owner() { printf '0:0\n'; }
		chown() { return 0; }
		trap 'rm -f -- "$marker_file"; rmdir -- "$backend_directory" "$(dirname -- "$backend_directory")" "$temporary_root"' EXIT
		billing_core_source_cleanup_write_marker staged "$previous_revision" "$revision" \
			2 "$image_id" "$image_id" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" \
			pending pending pending pending pending pending approved pending \
			pending pending pending pending pending pending pending "$marker_timestamp"
		[[ "$(billing_core_source_cleanup_marker_value phase)" == 'staged' ]]
		billing_core_source_cleanup_bind_staged_evidence \
			"$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" \
			"$cleanup_sha" "$cleanup_sha" 123 456 \
			'123e4567-e89b-42d3-a456-426614174000'
		[[ "$(billing_core_source_cleanup_marker_value retention_reference)" == "$cleanup_sha" ]]
		billing_core_source_cleanup_advance_applied
		[[ "$(billing_core_source_cleanup_marker_value phase)" == 'applied' ]]
		billing_core_source_cleanup_advance_complete \
			"$cleanup_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha"
		[[ "$(billing_core_source_cleanup_marker_value phase)" == 'complete' ]]
		! billing_core_source_cleanup_advance_complete \
			"$other_sha" "$cleanup_sha" "$cleanup_sha" "$cleanup_sha" >/dev/null 2>&1
	)
	source="$(declare -f billing_database_prepare billing_database_abort \
		billing_database_require_runtime_stopped \
		billing_database_reset_aborted_target \
		billing_database_require_env_contract \
		billing_database_validate_marker billing_database_write_marker \
		billing_database_guard_revision \
		billing_core_source_cleanup_validate_marker_contents \
		billing_core_source_cleanup_write_marker \
		billing_core_source_cleanup_migration_url \
		billing_core_source_cleanup_require_exact_migration_manifest \
		billing_core_source_state billing_core_source_cleanup_migration_state \
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
		billing_database_guard_revision "$2" "$1"
		;;
	--core-source-state)
		[[ $# -eq 1 ]] || exit 64
		billing_core_source_state
		;;
	--core-source-migration-state)
		[[ $# -eq 1 ]] || exit 64
		billing_core_source_cleanup_migration_state
		;;
	--core-source-cleanup-marker-state)
		[[ $# -eq 1 ]] || exit 64
		billing_core_source_cleanup_marker_state
		;;
	--self-test) billing_database_lifecycle_self_test ;;
	*)
		billing_database_fail \
			'Usage: billing-database-lifecycle.sh --prepare|--abort|--status|--core-source-state|--core-source-migration-state|--core-source-cleanup-marker-state|--guard-before-fetch-revision SHA|--guard-before-checkout-revision SHA|--self-test'
		;;
	esac
fi
