#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
MARKER_FILE="${NOTIFICATION_DELIVERY_DATABASE_CUTOVER_MARKER:-$APP_ROOT/deploy/backend/.notification-delivery-database-cutover-v1}"
LOCK_FILE="${NOTIFICATION_DELIVERY_DATABASE_CUTOVER_LOCK:-$APP_ROOT/deploy/backend/.notification-delivery-database-cutover-v1.lock}"
TARGET_DATABASE="winwidget_notification_delivery"
TARGET_SCHEMA="notification_delivery"
TARGET_HOST="127.0.0.1"
POSTGRES_SERVICE="notification-delivery-postgres"
POSTGRES_NETWORK="winwidget-notification-delivery-postgres"
POSTGRES_NETWORK_IDENTITY="bridge|local|false|notification-delivery|postgres-network"
LEGACY_POSTGRES_NETWORK_IDENTITY="bridge|local|true|notification-delivery|postgres-network"
HEALTHCHECK_ATTEMPTS="${NOTIFICATION_DELIVERY_DATABASE_HEALTHCHECK_ATTEMPTS:-60}"
HEALTHCHECK_INTERVAL="${NOTIFICATION_DELIVERY_DATABASE_HEALTHCHECK_INTERVAL:-2}"
FINALIZE_CUTOVER="${NOTIFICATION_DELIVERY_DATABASE_FINALIZE:-false}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
EXPECTED_WORKER_REVISION="${EXPECTED_WORKER_REVISION:-$EXPECTED_REVISION}"

server_root="$APP_ROOT/winwidget.ru_server"
temporary_directory=""
worker_stop_started=false
target_accepted=false
forward_only=false
cutover_complete=false
preparing_marker_created=false
new_cutover=false
marker_phase=""
marker_worker_image_id=""
marker_worker_revision=""
live_worker_image=""
live_worker_revision=""
worker_image_id=""
node_tools_image=""
database_tools_image=""
health_port=""
rabbitmq_vhost=""
configured_runtime_url=""

runtime_user=""
runtime_source_url=""
runtime_target_url=""
runtime_source_libpq_url=""
runtime_target_libpq_url=""
runtime_password=""

migration_user=""
migration_source_url=""
migration_target_url=""
migration_source_libpq_url=""
migration_target_libpq_url=""
migration_password=""

backup_user=""
backup_source_url=""
backup_target_url=""
backup_source_libpq_url=""
backup_target_libpq_url=""
backup_password=""

admin_user=""
source_database=""
source_endpoint_sha256=""
source_system_identifier=""
source_database_oid=""
admin_source_libpq_url=""
admin_password=""
source_admin_audit_access_preexisting=false

target_port=""
target_volume=""
target_postgres_image=""
target_admin_user=""
target_admin_password_file=""
target_admin_password=""
target_admin_url=""
target_admin_libpq_url=""
target_admin_server_libpq_url=""
target_postgres_image_id=""
target_system_identifier=""

dump_sha256="pending"
source_schema_sha256="pending"
source_manifest_sha256="pending"
target_manifest_sha256="pending"
source_cleanup_access_granted=false

fail() {
	echo "$1" >&2
	exit 1
}

compose_target() {
	local -a clean_environment=(
		env -i
		"PATH=$PATH"
		"HOME=${HOME:-/root}"
		"APP_REVISION=${APP_REVISION:-unknown}"
		"APP_VERSION=${APP_VERSION:-latest}"
		"NOTIFICATION_DELIVERY_IMAGE=${NOTIFICATION_DELIVERY_IMAGE:-unset}"
		"NOTIFICATION_DELIVERY_REVISION=${NOTIFICATION_DELIVERY_REVISION:-unset}"
	)
	local docker_variable

	for docker_variable in DOCKER_CONFIG DOCKER_CONTEXT DOCKER_HOST; do
		if [[ -n "${!docker_variable:-}" ]]; then
			clean_environment+=(
				"$docker_variable=${!docker_variable}"
			)
		fi
	done

	"${clean_environment[@]}" docker compose \
		--project-name winwidget \
		--env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" \
		--profile notification-delivery-database \
		"$@"
}

resolve_project_container() {
	local service="$1"
	local include_stopped="$2"
	local allow_missing="${3:-false}"
	local -a docker_ps=(docker ps --no-trunc)
	local container_ids

	if [[ "$include_stopped" == "true" ]]; then
		docker_ps+=(--all)
	fi
	container_ids="$(
		"${docker_ps[@]}" \
			--filter 'label=com.docker.compose.project=winwidget' \
			--filter "label=com.docker.compose.service=$service" \
			--format '{{ .ID }}'
	)"
	if [[ -z "$container_ids" && "$allow_missing" == "true" ]]; then
		return
	fi
	[[ -n "$container_ids" && "$container_ids" != *$'\n'* ]] ||
		fail "Exactly one WinWidget $service container is required."
	printf '%s\n' "$container_ids"
}

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

			if (name == key &&
				value != "" &&
				value !~ /^(change_me|XYZXYZXYZ)/) ok += 1
		}
		END { exit(ok == 1 ? 0 : 1) }
	' "$ENV_FILE"; then
		fail "Missing, duplicate or placeholder production env key: $key"
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
				found += 1
			}
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$ENV_FILE"
}

cleanup_stale_cutover_directories() {
	local deployment_directory="$APP_ROOT/deploy/backend"
	local stale_directory
	local -a stale_directories

	[[ -d "$deployment_directory" && ! -L "$deployment_directory" &&
		"$(stat -c '%u' "$deployment_directory")" == "0" ]] ||
		fail "Backend deployment directory must be a root-owned regular directory."
	shopt -s nullglob
	stale_directories=(
		"$deployment_directory"/.notification-delivery-database-cutover.*
	)
	shopt -u nullglob
	for stale_directory in "${stale_directories[@]}"; do
		[[ "$stale_directory" == "$deployment_directory"/.notification-delivery-database-cutover.* &&
			-d "$stale_directory" &&
			! -L "$stale_directory" &&
			"$(stat -c '%u:%g' "$stale_directory")" == "0:0" &&
			"$(stat -c '%a' "$stale_directory")" == "700" ]] ||
			fail "Refusing to remove an unverified stale cutover directory."
		rm -rf -- "$stale_directory"
	done
}

prepare_target_postgres_settings() {
	local secret_directory
	local secret_tmp
	local secret_line_count
	local existing_volume_driver
	local existing_volume_scope
	local existing_volume_label_owner
	local existing_volume_label_purpose

	target_port="$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_PORT)"
	target_volume="$(
		get_env_value NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME
	)"
	target_postgres_image="$(
		get_env_value NOTIFICATION_DELIVERY_POSTGRES_IMAGE
	)"
	target_admin_user="$(
		get_env_value NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER
	)"
	target_admin_password_file="$(
		get_env_value NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE
	)"

	[[ "$target_port" == "55432" ]] ||
		fail "NOTIFICATION_DELIVERY_POSTGRES_PORT must be 55432."
	[[ "$target_volume" == "winwidget-notification-delivery-postgres-data" ]] ||
		fail "Notification Delivery PostgreSQL must use the canonical external volume."
	[[ "$target_postgres_image" == "postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296" ]] ||
		fail "Notification Delivery PostgreSQL must stay on the approved PostgreSQL 18 Bookworm digest."
	[[ "$target_admin_user" == "winwidget_notification_delivery_admin" ]] ||
		fail "Notification Delivery PostgreSQL admin role is not canonical."
	[[ "$target_admin_password_file" == "$APP_ROOT/deploy/backend/.notification-delivery-postgres-admin-password" ]] ||
		fail "Notification Delivery PostgreSQL admin password file path is not canonical."

	secret_directory="$(dirname "$target_admin_password_file")"
	[[ -d "$secret_directory" && ! -L "$secret_directory" &&
		"$(stat -c '%u' "$secret_directory")" == "0" ]] ||
		fail "Notification Delivery PostgreSQL secret directory must be a root-owned regular directory."
	if [[ ! -e "$target_admin_password_file" ]]; then
		[[ ! -e "$MARKER_FILE" && ! -L "$MARKER_FILE" ]] ||
			fail "PostgreSQL admin secret is missing after cutover state was created."
		secret_tmp="$(
			mktemp "$secret_directory/.notification-delivery-postgres-admin-password.XXXXXX"
		)"
		od -An -N32 -tx1 /dev/urandom |
			tr -d ' \n' >"$secret_tmp"
		printf '\n' >>"$secret_tmp"
		chown 0:0 "$secret_tmp"
		chmod 600 "$secret_tmp"
		sync -f "$secret_tmp"
		mv -fT "$secret_tmp" "$target_admin_password_file"
		sync -f "$secret_directory"
	fi
	[[ -f "$target_admin_password_file" &&
		! -L "$target_admin_password_file" ]] ||
		fail "Notification Delivery PostgreSQL admin password must be a regular file."
	[[ "$(stat -c '%a' "$target_admin_password_file")" == "600" &&
		"$(stat -c '%u:%g' "$target_admin_password_file")" == "0:0" ]] ||
		fail "Notification Delivery PostgreSQL admin password must be root-owned with mode 600."
	secret_line_count="$(awk 'END { print NR }' "$target_admin_password_file")"
	[[ "$secret_line_count" == "1" ]] ||
		fail "Notification Delivery PostgreSQL admin password must contain exactly one line."
	target_admin_password="$(
		tr -d '\r\n' <"$target_admin_password_file"
	)"
	[[ "$target_admin_password" =~ ^[0-9a-f]{64}$ ]] ||
		fail "Notification Delivery PostgreSQL admin password file is invalid."

	if ! docker volume inspect "$target_volume" >/dev/null 2>&1; then
		[[ ! -e "$MARKER_FILE" && ! -L "$MARKER_FILE" ]] ||
			fail "PostgreSQL volume is missing after cutover state was created."
		docker volume create \
			--label com.winwidget.owner=notification-delivery \
			--label com.winwidget.purpose=postgres-data \
			"$target_volume" >/dev/null
	fi
	existing_volume_driver="$(
		docker volume inspect --format '{{ .Driver }}' "$target_volume"
	)"
	existing_volume_scope="$(
		docker volume inspect --format '{{ .Scope }}' "$target_volume"
	)"
	existing_volume_label_owner="$(
		docker volume inspect \
			--format '{{ index .Labels "com.winwidget.owner" }}' \
			"$target_volume"
	)"
	existing_volume_label_purpose="$(
		docker volume inspect \
			--format '{{ index .Labels "com.winwidget.purpose" }}' \
			"$target_volume"
	)"
	[[ "$existing_volume_driver" == "local" &&
		"$existing_volume_scope" == "local" &&
		"$existing_volume_label_owner" == "notification-delivery" &&
		"$existing_volume_label_purpose" == "postgres-data" ]] ||
		fail "Notification Delivery PostgreSQL volume driver or labels are invalid."
}

container_env_value() {
	local container_id="$1"
	local key="$2"

	docker inspect --format '{{ range .Config.Env }}{{ println . }}{{ end }}' \
		"$container_id" |
		awk -F= -v key="$key" '
			$1 == key {
				sub(/^[^=]*=/, "")
				print
				found += 1
			}
			END { exit(found == 1 ? 0 : 1) }
		'
}

write_marker() {
	local phase="$1"
	local marker_directory
	local marker_tmp
	local source_schema_state="retained"

	if [[ "$phase" == "complete" ]]; then
		source_schema_state="dropped"
	fi

	marker_directory="$(dirname "$MARKER_FILE")"
	marker_tmp="$(mktemp "$marker_directory/.notification-delivery-database-cutover-marker.XXXXXX")"
	{
		printf 'version=7\n'
		printf 'phase=%s\n' "$phase"
		printf 'source_schema_state=%s\n' "$source_schema_state"
		printf 'source_database=%s\n' "$source_database"
		printf 'source_endpoint_sha256=%s\n' "$source_endpoint_sha256"
		printf 'source_system_identifier=%s\n' "$source_system_identifier"
		printf 'source_database_oid=%s\n' "$source_database_oid"
		printf 'source_admin_audit_access_preexisting=%s\n' \
			"$source_admin_audit_access_preexisting"
		printf 'target_database=%s\n' "$TARGET_DATABASE"
		printf 'target_host=%s\n' "$TARGET_HOST"
		printf 'target_port=%s\n' "$target_port"
		printf 'target_volume=%s\n' "$target_volume"
		printf 'postgres_image=%s\n' "$target_postgres_image"
		printf 'postgres_image_id=%s\n' "$target_postgres_image_id"
		printf 'postgres_system_identifier=%s\n' "$target_system_identifier"
		printf 'worker_image_id=%s\n' "$worker_image_id"
		printf 'revision=%s\n' "$live_worker_revision"
		printf 'dump_sha256=%s\n' "$dump_sha256"
		printf 'source_schema_sha256=%s\n' "$source_schema_sha256"
		printf 'source_manifest_sha256=%s\n' "$source_manifest_sha256"
		printf 'target_manifest_sha256=%s\n' "$target_manifest_sha256"
		printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$marker_tmp"
	chown 0:0 "$marker_tmp"
	chmod 600 "$marker_tmp"
	sync -f "$marker_tmp"
	mv -fT "$marker_tmp" "$MARKER_FILE"
	sync -f "$marker_directory"
	marker_phase="$phase"
}

validate_marker() {
	local marker_mode
	local marker_owner

	[[ -f "$MARKER_FILE" && ! -L "$MARKER_FILE" ]] || return 1
	marker_mode="$(stat -c '%a' "$MARKER_FILE")"
	marker_owner="$(stat -c '%u:%g' "$MARKER_FILE")"
	[[ "$marker_mode" == "600" && "$marker_owner" == "0:0" ]] || return 1

	awk -F= \
		-v target="$TARGET_DATABASE" \
		-v source_endpoint_sha256="$source_endpoint_sha256" \
		-v source_system_identifier="$source_system_identifier" \
		-v source_database_oid="$source_database_oid" \
		-v target_host="$TARGET_HOST" \
		-v target_port="$target_port" \
		-v target_volume="$target_volume" \
		-v postgres_image="$target_postgres_image" \
		-v postgres_image_id="$target_postgres_image_id" \
		-v postgres_system_identifier="$target_system_identifier" '
		function valid_hash(value) {
			return value == "pending" || value ~ /^[0-9a-f]{64}$/
		}
		{
			count[$1] += 1
			value[$1] = substr($0, index($0, "=") + 1)
			if ($1 != "version" &&
				$1 != "phase" &&
				$1 != "source_schema_state" &&
				$1 != "source_database" &&
				$1 != "source_endpoint_sha256" &&
				$1 != "source_system_identifier" &&
				$1 != "source_database_oid" &&
				$1 != "source_admin_audit_access_preexisting" &&
				$1 != "target_database" &&
				$1 != "target_host" &&
				$1 != "target_port" &&
				$1 != "target_volume" &&
				$1 != "postgres_image" &&
				$1 != "postgres_image_id" &&
				$1 != "postgres_system_identifier" &&
				$1 != "worker_image_id" &&
				$1 != "revision" &&
				$1 != "dump_sha256" &&
				$1 != "source_schema_sha256" &&
				$1 != "source_manifest_sha256" &&
				$1 != "target_manifest_sha256" &&
				$1 != "updated_at") invalid = 1
		}
		END {
			for (key in count) {
				if (count[key] != 1) invalid = 1
			}
			if (NR != 22 ||
				value["version"] != "7" ||
				value["phase"] !~ /^(preparing|restoring|prepared|forward_only|complete)$/ ||
				value["source_schema_state"] !~ /^(retained|dropped)$/ ||
				value["source_database"] !~ /^[A-Za-z_][A-Za-z0-9_]*$/ ||
				value["source_database"] == target ||
				value["source_endpoint_sha256"] != source_endpoint_sha256 ||
				value["source_endpoint_sha256"] !~ /^[0-9a-f]{64}$/ ||
				value["source_system_identifier"] != source_system_identifier ||
				value["source_system_identifier"] !~ /^[0-9]+$/ ||
				value["source_database_oid"] != source_database_oid ||
				value["source_database_oid"] !~ /^[0-9]+$/ ||
				value["source_admin_audit_access_preexisting"] !~ /^(true|false)$/ ||
				value["target_database"] != target ||
				value["target_host"] != target_host ||
				value["target_port"] != target_port ||
				value["target_volume"] != target_volume ||
				value["postgres_image"] != postgres_image ||
				value["postgres_image_id"] != postgres_image_id ||
				value["postgres_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["postgres_system_identifier"] != postgres_system_identifier ||
				value["postgres_system_identifier"] !~ /^[0-9]+$/ ||
				value["worker_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
				value["revision"] !~ /^[0-9a-f]{40}$/ ||
				!valid_hash(value["dump_sha256"]) ||
				!valid_hash(value["source_schema_sha256"]) ||
				!valid_hash(value["source_manifest_sha256"]) ||
				!valid_hash(value["target_manifest_sha256"]) ||
				value["updated_at"] !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/) invalid = 1
			if (value["phase"] ~ /^(prepared|forward_only|complete)$/ &&
				(value["dump_sha256"] == "pending" ||
					value["source_schema_sha256"] == "pending" ||
					value["source_manifest_sha256"] == "pending" ||
					value["target_manifest_sha256"] == "pending" ||
					value["target_manifest_sha256"] != value["source_manifest_sha256"])) invalid = 1
			if ((value["phase"] == "complete" && value["source_schema_state"] != "dropped") ||
				(value["phase"] != "complete" && value["source_schema_state"] != "retained")) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' "$MARKER_FILE"
}

marker_value() {
	local key="$1"

	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$MARKER_FILE"
}

update_notification_database_urls() {
	local runtime_url="$1"
	local migration_url="$2"
	local backup_url="$3"
	local env_directory
	local env_tmp
	local replacements=0
	local line

	env_directory="$(dirname "$ENV_FILE")"
	env_tmp="$(mktemp "$env_directory/.notification-delivery-database-env.XXXXXX")"
	while IFS= read -r line || [[ -n "$line" ]]; do
		if [[ "$line" =~ ^[[:space:]]*NOTIFICATION_DELIVERY_DATABASE_URL[[:space:]]*= ]]; then
			printf 'NOTIFICATION_DELIVERY_DATABASE_URL=%s\n' "$runtime_url"
			((replacements += 1))
		elif [[ "$line" =~ ^[[:space:]]*NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION[[:space:]]*= ]]; then
			printf 'NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION=%s\n' "$migration_url"
			((replacements += 1))
		elif [[ "$line" =~ ^[[:space:]]*NOTIFICATION_DELIVERY_BACKUP_URL[[:space:]]*= ]]; then
			printf 'NOTIFICATION_DELIVERY_BACKUP_URL=%s\n' "$backup_url"
			((replacements += 1))
		else
			printf '%s\n' "$line"
		fi
	done <"$ENV_FILE" >"$env_tmp"

	if [[ "$replacements" != "3" ]]; then
		rm -f "$env_tmp"
		fail "Production env update did not resolve exactly the three Notification Delivery database URLs."
	fi

	chown --reference="$ENV_FILE" "$env_tmp"
	chmod 600 "$env_tmp"
	sync -f "$env_tmp"
	mv -fT "$env_tmp" "$ENV_FILE"
	sync -f "$env_directory"
}

run_psql() {
	local password="$1"
	local database_url="$2"
	local volume_args=()
	shift 2

	if [[ -n "$temporary_directory" && -d "$temporary_directory" ]]; then
		volume_args=(--volume "$temporary_directory:/cutover")
	fi
	PGPASSWORD="$password" docker run --rm \
		--network host \
		--env PGPASSWORD \
		"${volume_args[@]}" \
		--entrypoint psql \
		"$database_tools_image" \
		--no-password \
		--no-psqlrc \
		--set ON_ERROR_STOP=1 \
		--dbname "$database_url" \
		"$@"
}

run_pg_dump() {
	local password="$1"
	local database_url="$2"
	shift 2

	PGPASSWORD="$password" docker run --rm \
		--network host \
		--env PGPASSWORD \
		--user 0:0 \
		--volume "$temporary_directory:/cutover" \
		--entrypoint pg_dump \
		"$database_tools_image" \
		--no-password \
		--dbname "$database_url" \
		"$@"
}

run_pg_restore() {
	local password="$1"
	shift

	PGPASSWORD="$password" docker run --rm \
		--network host \
		--env PGPASSWORD \
		--user 0:0 \
		--volume "$temporary_directory:/cutover" \
		--entrypoint pg_restore \
		"$database_tools_image" \
		"$@"
}

parse_database_urls() {
	local parsed
	local -a lines
	local label
	local password_base64

	parsed="$(
		printf '%s\n%s\n%s\n%s\n%s\n' \
			"$(get_env_value NOTIFICATION_DELIVERY_DATABASE_URL)" \
			"$(get_env_value NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION)" \
			"$(get_env_value NOTIFICATION_DELIVERY_BACKUP_URL)" \
			"$(get_env_value DATABASE_MIGRATION_URL_PRODUCTION)" \
			"$(printf '%s' "$target_admin_password" | base64 | tr -d '\n')" |
			docker run --rm -i \
				--network none \
				--env "TARGET_DATABASE=$TARGET_DATABASE" \
				--env "TARGET_HOST=$TARGET_HOST" \
				--env "TARGET_PORT=$target_port" \
				--env "TARGET_ADMIN_USER=$target_admin_user" \
				--entrypoint node \
				"$node_tools_image" \
				-e '
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};
const raw = readFileSync(0, "utf8");
const lines = raw.endsWith("\n")
	? raw.slice(0, -1).split("\n")
	: raw.split("\n");
if (lines.length !== 5 || lines.some(value => !value)) {
	fail("Database URL input is incomplete or contains a newline");
}

const targetDatabase = process.env.TARGET_DATABASE;
const targetHost = process.env.TARGET_HOST;
const targetPort = process.env.TARGET_PORT;
const targetAdminUser = process.env.TARGET_ADMIN_USER;
const targetAdminPassword = Buffer.from(lines[4], "base64").toString("utf8");
if (
	targetDatabase !== "winwidget_notification_delivery" ||
	targetHost !== "127.0.0.1" ||
	targetPort !== "55432" ||
	targetAdminUser !== "winwidget_notification_delivery_admin" ||
	!/^[0-9a-f]{64}$/.test(targetAdminPassword)
) {
	fail("Local Notification Delivery PostgreSQL target settings are invalid");
}
const prismaOnlyParameters = new Set([
	"connection_limit",
	"pool_timeout",
	"pgbouncer",
	"schema",
	"statement_cache_size",
]);
const parse = (value, label, requireSchema) => {
	let url;
	try {
		url = new URL(value);
	} catch {
		fail(`${label} is not a valid URL`);
	}
	if (!["postgres:", "postgresql:"].includes(url.protocol)) {
		fail(`${label} must use postgres or postgresql`);
	}
	if (
		!url.hostname ||
		!url.username ||
		!url.password ||
		url.hash ||
		(url.port && !/^[0-9]+$/.test(url.port))
	) {
		fail(`${label} must contain explicit credentials, host and a valid port`);
	}
	let username;
	let password;
	let database;
	try {
		username = decodeURIComponent(url.username);
		password = decodeURIComponent(url.password);
		database = decodeURIComponent(url.pathname.slice(1));
	} catch {
		fail(`${label} contains invalid percent-encoding`);
	}
	if (
		!username.match(/^[A-Za-z_][A-Za-z0-9_]*$/) ||
		!database.match(/^[A-Za-z_][A-Za-z0-9_]*$/) ||
		!/^[^\u0000-\u001f\u007f]+$/.test(password)
	) {
		fail(`${label} contains an invalid role, database or password`);
	}
	if (requireSchema) {
		const schemas = url.searchParams.getAll("schema");
		if (
			schemas.length !== 1 ||
			schemas[0] !== "notification_delivery"
		) {
			fail(`${label} must contain exactly schema=notification_delivery`);
		}
	}
	return { label, url, username, password, database };
};

const serviceEntries = [
	parse(lines[0], "runtime", true),
	parse(lines[1], "migration", true),
	parse(lines[2], "backup", true),
];
const sourceAdmin = parse(lines[3], "source-admin", false);
if (sourceAdmin.username !== "gen_user") {
	fail("DATABASE_MIGRATION_URL_PRODUCTION must use gen_user");
}
if (sourceAdmin.database === targetDatabase) {
	fail("Core migration URL must not target the Notification Delivery database");
}
if (
	new Set(serviceEntries.map(entry => entry.username)).size !== 3 ||
	serviceEntries.some(
		entry =>
			entry.username === sourceAdmin.username ||
			entry.username === targetAdminUser,
	)
) {
	fail("Runtime, migration, backup and both admin roles must be distinct");
}
const tlsEntries = url =>
	[...url.searchParams.entries()]
		.filter(([key]) => {
			const normalized = key.toLowerCase();
			return normalized.startsWith("ssl") || normalized === "channel_binding";
		})
		.map(([key, value]) => [key.toLowerCase(), value])
		.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
			leftKey === rightKey
				? leftValue.localeCompare(rightValue)
				: leftKey.localeCompare(rightKey),
		);
const endpointKey = entry => {
	const tls = [...entry.url.searchParams.entries()]
		.filter(([key]) => {
			const normalized = key.toLowerCase();
			return normalized.startsWith("ssl") || normalized === "channel_binding";
		});
	return JSON.stringify([
		entry.url.protocol,
		entry.url.hostname.toLowerCase(),
		entry.url.port || "5432",
		tlsEntries(entry.url),
	]);
};
if (new Set(serviceEntries.map(endpointKey)).size !== 1) {
	fail("The three current Notification Delivery URLs must share one endpoint");
}
if (new Set(serviceEntries.map(entry => entry.database)).size !== 1) {
	fail("The three current Notification Delivery URLs must share one database");
}

const replaceTransport = (entry, baseUrl, database, target = false) => {
	const result = new URL(entry.url.toString());
	result.protocol = baseUrl.protocol;
	result.hostname = baseUrl.hostname;
	result.port = baseUrl.port;
	result.pathname = `/${encodeURIComponent(database)}`;
	for (const key of [...result.searchParams.keys()]) {
		const normalized = key.toLowerCase();
		if (normalized.startsWith("ssl") || normalized === "channel_binding") {
			result.searchParams.delete(key);
		}
	}
	if (target) {
		result.searchParams.set("sslmode", "disable");
	} else {
		for (const [key, value] of tlsEntries(baseUrl)) {
			result.searchParams.append(key, value);
		}
	}
	result.searchParams.set("schema", "notification_delivery");
	return result.toString();
};
const libpq = value => {
	const result = new URL(value);
	result.password = "";
	for (const key of [...result.searchParams.keys()]) {
		if (
			prismaOnlyParameters.has(key.toLowerCase()) ||
			key.toLowerCase() === "password"
		) {
			result.searchParams.delete(key);
		}
	}
	return result.toString();
};

const targetBase = new URL(
	`postgresql://placeholder:placeholder@${targetHost}:${targetPort}/${targetDatabase}`,
);
targetBase.searchParams.set("sslmode", "disable");
const sourceEndpoint = endpointKey(sourceAdmin);
const sourceEndpointSha256 = createHash("sha256")
	.update(sourceEndpoint)
	.digest("hex");
const targetEndpoint = endpointKey({
	url: targetBase,
});
if (sourceEndpoint === targetEndpoint) {
	fail("Source and target PostgreSQL endpoints must be different");
}
const currentEndpoint = endpointKey(serviceEntries[0]);
const currentDatabase = serviceEntries[0].database;
let currentLocation;
if (
	currentDatabase === sourceAdmin.database &&
	currentEndpoint === sourceEndpoint
) {
	currentLocation = "source";
} else if (
	currentDatabase === targetDatabase &&
	currentEndpoint === targetEndpoint
) {
	currentLocation = "target";
} else {
	fail(
		"Current Notification Delivery URLs target neither the source nor the local PostgreSQL container",
	);
}

for (const entry of serviceEntries) {
	const sourceUrl = replaceTransport(
		entry,
		sourceAdmin.url,
		sourceAdmin.database,
	);
	const targetUrl = replaceTransport(
		entry,
		targetBase,
		targetDatabase,
		true,
	);
	process.stdout.write(
		[
			entry.label,
			entry.username,
			entry.database,
			currentLocation,
			sourceUrl,
			targetUrl,
			libpq(sourceUrl),
			libpq(targetUrl),
			Buffer.from(entry.password, "utf8").toString("base64"),
		].join("\t") + "\n",
	);
}

process.stdout.write(
	[
		"source-admin",
		sourceAdmin.username,
		sourceAdmin.database,
		sourceEndpointSha256,
		libpq(sourceAdmin.url.toString()),
		Buffer.from(sourceAdmin.password, "utf8").toString("base64"),
	].join("\t") + "\n",
);

const targetAdminUrl = new URL(targetBase.toString());
targetAdminUrl.username = targetAdminUser;
targetAdminUrl.password = targetAdminPassword;
const targetAdminServerUrl = new URL(targetAdminUrl.toString());
targetAdminServerUrl.pathname = "/postgres";
process.stdout.write(
	[
		"target-admin",
		targetAdminUser,
		targetDatabase,
		targetAdminUrl.toString(),
		libpq(targetAdminUrl.toString()),
		libpq(targetAdminServerUrl.toString()),
		Buffer.from(targetAdminPassword, "utf8").toString("base64"),
	].join("\t") + "\n",
);
'
		)"
	mapfile -t lines <<<"$parsed"
	[[ "${#lines[@]}" == "5" ]] ||
		fail "Database URL parser returned an invalid result."

	for line in "${lines[@]}"; do
		label="${line%%$'\t'*}"
		case "$label" in
			runtime)
				IFS=$'\t' read -r \
					label parsed_user parsed_current_database parsed_current_location \
					parsed_source_url parsed_target_url parsed_source_libpq_url \
					parsed_target_libpq_url password_base64 <<<"$line"
				runtime_user="$parsed_user"
				runtime_source_url="$parsed_source_url"
				runtime_target_url="$parsed_target_url"
				runtime_source_libpq_url="$parsed_source_libpq_url"
				runtime_target_libpq_url="$parsed_target_libpq_url"
				runtime_password="$(
					printf '%s' "$password_base64" | base64 --decode
				)"
				runtime_current_database="$parsed_current_database"
				runtime_current_location="$parsed_current_location"
				;;
			migration)
				IFS=$'\t' read -r \
					label parsed_user parsed_current_database parsed_current_location \
					parsed_source_url parsed_target_url parsed_source_libpq_url \
					parsed_target_libpq_url password_base64 <<<"$line"
				migration_user="$parsed_user"
				migration_source_url="$parsed_source_url"
				migration_target_url="$parsed_target_url"
				migration_source_libpq_url="$parsed_source_libpq_url"
				migration_target_libpq_url="$parsed_target_libpq_url"
				migration_password="$(
					printf '%s' "$password_base64" | base64 --decode
				)"
				migration_current_database="$parsed_current_database"
				migration_current_location="$parsed_current_location"
				;;
			backup)
				IFS=$'\t' read -r \
					label parsed_user parsed_current_database parsed_current_location \
					parsed_source_url parsed_target_url parsed_source_libpq_url \
					parsed_target_libpq_url password_base64 <<<"$line"
				backup_user="$parsed_user"
				backup_source_url="$parsed_source_url"
				backup_target_url="$parsed_target_url"
				backup_source_libpq_url="$parsed_source_libpq_url"
				backup_target_libpq_url="$parsed_target_libpq_url"
				backup_password="$(
					printf '%s' "$password_base64" | base64 --decode
				)"
				backup_current_database="$parsed_current_database"
				backup_current_location="$parsed_current_location"
				;;
			source-admin)
				IFS=$'\t' read -r \
					label parsed_user parsed_current_database \
					source_endpoint_sha256 parsed_source_libpq_url \
					password_base64 <<<"$line"
				admin_user="$parsed_user"
				source_database="$parsed_current_database"
				admin_source_libpq_url="$parsed_source_libpq_url"
				admin_password="$(
					printf '%s' "$password_base64" | base64 --decode
				)"
				[[ "$source_endpoint_sha256" =~ ^[0-9a-f]{64}$ ]] ||
					fail "Source PostgreSQL endpoint fingerprint is invalid."
				;;
			target-admin)
				IFS=$'\t' read -r \
					label parsed_user parsed_current_database parsed_target_url \
					parsed_target_libpq_url parsed_target_server_libpq_url \
					password_base64 <<<"$line"
				target_admin_user="$parsed_user"
				target_admin_url="$parsed_target_url"
				target_admin_libpq_url="$parsed_target_libpq_url"
				target_admin_server_libpq_url="$parsed_target_server_libpq_url"
				target_admin_password="$(
					printf '%s' "$password_base64" | base64 --decode
				)"
				;;
			*)
				fail "Database URL parser returned an unexpected role label."
				;;
		esac
		[[ -n "$password_base64" ]] ||
			fail "Database URL parser returned an incomplete result."
	done
}

read_source_database_identity() {
	run_psql "$admin_password" "$admin_source_libpq_url" \
		--quiet --tuples-only --no-align --field-separator '|' \
		--command "
			SELECT
				control.system_identifier,
				databases.oid
			FROM pg_control_system() AS control
			CROSS JOIN pg_database AS databases
			WHERE databases.datname = current_database()
				AND current_database() = '$source_database'
				AND current_user = '$admin_user';
		"
}

capture_source_database_identity() {
	local identity

	identity="$(read_source_database_identity)"
	IFS='|' read -r \
		source_system_identifier \
		source_database_oid <<<"$identity"
	[[ "$source_system_identifier" =~ ^[0-9]+$ &&
		"$source_database_oid" =~ ^[0-9]+$ ]] ||
		fail "Could not capture the source PostgreSQL cluster and database identity."
}

verify_source_database_identity() {
	local identity
	local observed_system_identifier
	local observed_database_oid

	identity="$(read_source_database_identity)"
	IFS='|' read -r \
		observed_system_identifier \
		observed_database_oid <<<"$identity"
	[[ "$observed_system_identifier" == "$source_system_identifier" &&
		"$observed_database_oid" == "$source_database_oid" ]] ||
		fail "Source PostgreSQL cluster or database identity changed during cutover."
}

assert_current_urls_are_consistent() {
	local expected_database="$1"
	local expected_location="source"

	if [[ "$expected_database" == "$TARGET_DATABASE" ]]; then
		expected_location="target"
	fi

	if [[ "$runtime_current_database" != "$expected_database" ||
		"$migration_current_database" != "$expected_database" ||
		"$backup_current_database" != "$expected_database" ||
		"$runtime_current_location" != "$expected_location" ||
		"$migration_current_location" != "$expected_location" ||
		"$backup_current_location" != "$expected_location" ]]; then
		fail "The three Notification Delivery URLs must all target the same expected PostgreSQL instance."
	fi
}

verify_source_role_membership_boundary() {
	local boundary

	boundary="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT (
					(
						SELECT count(*) = 3
							AND count(DISTINCT granted_roles.rolname) = 3
							AND bool_and(
								member_roles.rolname = '$admin_user'
								AND memberships.admin_option
								AND NOT memberships.inherit_option
								AND NOT memberships.set_option
							)
						FROM pg_auth_members AS memberships
						JOIN pg_roles AS granted_roles
							ON granted_roles.oid = memberships.roleid
						JOIN pg_roles AS member_roles
							ON member_roles.oid = memberships.member
						WHERE granted_roles.rolname IN (
							'$runtime_user',
							'$migration_user',
							'$backup_user'
						)
					)
					AND NOT EXISTS (
						SELECT 1
						FROM pg_auth_members AS memberships
						JOIN pg_roles AS member_roles
							ON member_roles.oid = memberships.member
						WHERE member_roles.rolname IN (
							'$runtime_user',
							'$migration_user',
							'$backup_user'
						)
					)
				);
			"
	)"
	[[ "$boundary" == "t" ]]
}

report_source_role_boundary() {
	echo "Source Notification Delivery role diagnostics:" >&2
	run_psql "$admin_password" "$admin_source_libpq_url" \
		--quiet --tuples-only --no-align --field-separator '|' \
		--command "
			SELECT
				'role',
				roles.rolname::text,
				roles.rolcanlogin::text,
				roles.rolsuper::text,
				roles.rolcreatedb::text,
				roles.rolcreaterole::text,
				roles.rolreplication::text,
				roles.rolbypassrls::text,
				has_database_privilege(
					roles.rolname,
					current_database(),
					'CONNECT'
				)::text
			FROM pg_roles AS roles
			WHERE roles.rolname IN (
				'$runtime_user',
				'$migration_user',
				'$backup_user'
			)
			UNION ALL
			SELECT
				'membership',
				granted_roles.rolname::text,
				member_roles.rolname::text,
				grantor_roles.rolname::text,
				memberships.admin_option::text,
				memberships.inherit_option::text,
				memberships.set_option::text,
				'',
				''
			FROM pg_auth_members AS memberships
			JOIN pg_roles AS granted_roles
				ON granted_roles.oid = memberships.roleid
			JOIN pg_roles AS member_roles
				ON member_roles.oid = memberships.member
			JOIN pg_roles AS grantor_roles
				ON grantor_roles.oid = memberships.grantor
			WHERE granted_roles.rolname IN (
					'$runtime_user',
					'$migration_user',
					'$backup_user'
				)
				OR member_roles.rolname IN (
					'$runtime_user',
					'$migration_user',
					'$backup_user'
				)
			ORDER BY 1, 2;
		" >&2 || true
}

verify_source_roles_and_schema() {
	local role_boundary
	local schema_boundary

	role_boundary="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT (
					current_user = 'gen_user'
					AND has_database_privilege(
						'$runtime_user',
						current_database(),
						'CONNECT'
					)
					AND has_database_privilege(
						'$migration_user',
						current_database(),
						'CONNECT'
					)
					AND has_database_privilege(
						'$backup_user',
						current_database(),
						'CONNECT'
					)
					AND (
						SELECT count(*) = 3
							AND bool_and(
								rolcanlogin
								AND NOT rolsuper
								AND NOT rolcreatedb
								AND NOT rolcreaterole
								AND NOT rolreplication
								AND NOT rolbypassrls
							)
						FROM pg_roles
						WHERE rolname IN (
							'$runtime_user',
							'$migration_user',
							'$backup_user'
						)
					)
				);
			"
	)"
	if [[ "$role_boundary" != "t" ]] ||
		! verify_source_role_membership_boundary; then
		report_source_role_boundary
		fail "Source Notification Delivery role boundary is incomplete."
	fi

	schema_boundary="$(
		run_psql "$migration_password" "$migration_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT (
					current_database() = '$source_database'
					AND current_user = '$migration_user'
					AND (
						SELECT pg_get_userbyid(nspowner) = current_user
						FROM pg_namespace
						WHERE nspname = '$TARGET_SCHEMA'
					)
					AND to_regclass('$TARGET_SCHEMA._prisma_migrations') IS NOT NULL
					AND (
						SELECT count(*) > 1
						FROM pg_tables
						WHERE schemaname = '$TARGET_SCHEMA'
					)
				);
			"
	)"
	[[ "$schema_boundary" == "t" ]] ||
		fail "Source Notification Delivery schema ownership or migration history is invalid."

	run_pg_dump \
		"$backup_password" \
		"$backup_source_libpq_url" \
		--format=custom \
		--no-owner \
		--no-privileges \
		--schema "$TARGET_SCHEMA" \
		--file /dev/null
}

load_expected_queues() {
	docker run --rm \
		--network none \
		--entrypoint node \
		"$live_worker_image" \
		-e '
const {
	MESSAGING_QUEUE_NAMES,
	NOTIFICATION_DELIVERY_KINDS,
} = require("./dist/src/messaging/messaging.constants.js");
for (const kind of NOTIFICATION_DELIVERY_KINDS) {
	const base = MESSAGING_QUEUE_NAMES[kind];
	if (!base) process.exit(1);
	process.stdout.write(`${base}\tmain\n`);
	process.stdout.write(`${base}.dead-letter\tdead-letter\n`);
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		process.stdout.write(`${base}.retry-v2.${attempt}\tretry\n`);
	}
}
'
}

verify_notification_queue_quiescence() {
	local rabbitmq_container_id
	local queue_state
	local expected_queues
	local queue
	local queue_kind
	local queue_line
	local name
	local ready
	local unacknowledged
	local consumers

	rabbitmq_container_id="$(
		compose_target ps --status running -q rabbitmq 2>/dev/null || true
	)"
	[[ -n "$rabbitmq_container_id" &&
		"$rabbitmq_container_id" != *$'\n'* ]] ||
		fail "Exactly one running RabbitMQ container is required."
	queue_state="$(
		docker exec "$rabbitmq_container_id" \
			rabbitmqctl --silent list_queues \
				-p "$rabbitmq_vhost" \
				name messages_ready messages_unacknowledged consumers
	)"
	expected_queues="$(load_expected_queues)"
	while IFS=$'\t' read -r queue queue_kind; do
		[[ -n "$queue" && -n "$queue_kind" ]] || continue
		queue_line="$(
			awk -v queue="$queue" '$1 == queue { print; found += 1 } END { exit(found == 1 ? 0 : 1) }' \
				<<<"$queue_state"
		)" ||
			fail "Expected Notification Delivery RabbitMQ queue is missing: $queue"
		read -r name ready unacknowledged consumers <<<"$queue_line"
		[[ "$name" == "$queue" &&
			"$ready" =~ ^[0-9]+$ &&
			"$unacknowledged" == "0" &&
			"$consumers" == "0" ]] ||
			fail "Notification Delivery queue is not quiescent after the worker stop: $queue"
	done <<<"$expected_queues"
}

verify_source_database_quiescence() {
	local state
	local active_service_sessions

	state="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align --field-separator '|' \
			--command "
				SELECT
					(
						SELECT count(*)
						FROM \"$TARGET_SCHEMA\".\"delivery_receipts\"
						WHERE \"status\" = 'PROCESSING'
					),
					(
						SELECT count(*)
						FROM \"$TARGET_SCHEMA\".\"outbox_events\"
						WHERE \"status\" = 'PUBLISHING'
					);
			"
	)"
	[[ "$state" == "0|0" ]] ||
		fail "Notification Delivery has PROCESSING receipts or PUBLISHING Outbox rows."

	active_service_sessions="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT count(*)
				FROM pg_stat_activity
				WHERE datname = '$source_database'
					AND usename IN (
						'$runtime_user',
						'$migration_user',
						'$backup_user'
					);
			"
	)"
	[[ "$active_service_sessions" == "0" ]] ||
		fail "A Notification Delivery role still has an active source database session."
}

verify_source_access_revocation_capability() {
	verify_source_database_identity
	run_psql "$admin_password" "$admin_source_libpq_url" \
		--quiet \
		--command "
			BEGIN;
			REVOKE CONNECT ON DATABASE \"$source_database\"
				FROM \"$runtime_user\", \"$migration_user\", \"$backup_user\";
			DO \$\$
			BEGIN
				EXECUTE format(
					'ALTER ROLE %I LOGIN PASSWORD %L CONNECTION LIMIT 1 VALID UNTIL %L',
					'$migration_user',
					'cutover-preflight-rollback-only',
					CURRENT_TIMESTAMP + INTERVAL '5 minutes'
				);
			END
			\$\$;
			ALTER ROLE \"$migration_user\" SET lock_timeout = '15s';
			ALTER ROLE \"$migration_user\" SET statement_timeout = '2min';
			ALTER ROLE \"$migration_user\"
				SET idle_in_transaction_session_timeout = '60s';
			ALTER ROLE \"$migration_user\" SET idle_session_timeout = '2min';
			GRANT CONNECT ON DATABASE \"$source_database\"
				TO \"$migration_user\";
			ALTER ROLE \"$runtime_user\" NOLOGIN;
			ALTER ROLE \"$migration_user\" NOLOGIN;
			ALTER ROLE \"$backup_user\" NOLOGIN;
			DO \$\$
			BEGIN
				IF (
					SELECT count(*) <> 3 OR NOT bool_and(NOT rolcanlogin)
					FROM pg_roles
					WHERE rolname IN (
						'$runtime_user',
						'$migration_user',
						'$backup_user'
					)
				) THEN
					RAISE EXCEPTION
						'Source Notification Delivery LOGIN fencing is incomplete';
				END IF;
			END
			\$\$;
			ROLLBACK;
		"
}

grant_source_audit_read_access() {
	run_psql "$migration_password" "$migration_source_libpq_url" \
		--quiet \
		--command "
			GRANT USAGE ON SCHEMA \"$TARGET_SCHEMA\" TO \"$admin_user\";
			GRANT SELECT ON ALL TABLES IN SCHEMA \"$TARGET_SCHEMA\"
				TO \"$admin_user\";
			GRANT SELECT ON ALL SEQUENCES IN SCHEMA \"$TARGET_SCHEMA\"
				TO \"$admin_user\";
		"
}

fence_source_service_access() {
	local boundary

	verify_source_database_identity
	run_psql "$admin_password" "$admin_source_libpq_url" \
		--quiet \
		--command "
			REVOKE CONNECT ON DATABASE \"$source_database\"
				FROM \"$runtime_user\", \"$migration_user\", \"$backup_user\";
			ALTER ROLE \"$runtime_user\" NOLOGIN;
			ALTER ROLE \"$migration_user\" NOLOGIN;
			ALTER ROLE \"$backup_user\" NOLOGIN;
		"
	boundary="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT (
					(
						SELECT count(*) = 3
							AND bool_and(NOT rolcanlogin)
						FROM pg_roles
						WHERE rolname IN (
							'$runtime_user',
							'$migration_user',
							'$backup_user'
						)
					)
					AND NOT EXISTS (
						SELECT 1
						FROM pg_stat_activity
							WHERE datname = current_database()
								AND usename IN (
									'$runtime_user',
									'$migration_user',
									'$backup_user'
								)
					)
				);
			"
	)"
	if [[ "$boundary" != "t" ]] ||
		! verify_source_role_membership_boundary; then
		report_source_role_boundary
		fail "Source Notification Delivery service roles were not fenced before copying."
	fi
}

restore_source_database_access() {
	local boundary

	verify_source_database_identity
	run_psql "$admin_password" "$admin_source_libpq_url" \
		--quiet \
		--command "
			GRANT CONNECT ON DATABASE \"$source_database\"
				TO \"$runtime_user\", \"$migration_user\", \"$backup_user\";
			ALTER ROLE \"$runtime_user\" LOGIN;
			ALTER ROLE \"$migration_user\" LOGIN;
			ALTER ROLE \"$backup_user\" LOGIN;
		"
	boundary="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT (
					(
						SELECT count(*) = 3
							AND bool_and(rolcanlogin)
						FROM pg_roles
						WHERE rolname IN (
							'$runtime_user',
							'$migration_user',
							'$backup_user'
						)
					)
					AND
					has_database_privilege(
						'$runtime_user',
						current_database(),
						'CONNECT'
					)
					AND has_database_privilege(
						'$migration_user',
						current_database(),
						'CONNECT'
					)
					AND has_database_privilege(
						'$backup_user',
						current_database(),
						'CONNECT'
					)
				);
			"
	)"
	if [[ "$boundary" != "t" ]] ||
		! verify_source_role_membership_boundary; then
		report_source_role_boundary
		return 1
	fi
}

revoke_source_database_access() {
	local boundary

	verify_source_database_identity
	run_psql "$admin_password" "$admin_source_libpq_url" \
		--quiet \
		--command "
			REVOKE CONNECT ON DATABASE \"$source_database\"
				FROM \"$runtime_user\", \"$migration_user\", \"$backup_user\";
			ALTER ROLE \"$runtime_user\" NOLOGIN;
			ALTER ROLE \"$migration_user\" NOLOGIN;
			ALTER ROLE \"$backup_user\" NOLOGIN;
		"

	boundary="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT (
					(
						SELECT count(*) = 3
							AND bool_and(NOT rolcanlogin)
						FROM pg_roles
						WHERE rolname IN (
							'$runtime_user',
							'$migration_user',
							'$backup_user'
						)
					)
					AND NOT EXISTS (
						SELECT 1
						FROM pg_stat_activity
						WHERE datname = current_database()
							AND usename IN (
								'$runtime_user',
								'$migration_user',
								'$backup_user'
							)
					)
				);
			"
	)"
	if [[ "$boundary" != "t" ]] ||
		! verify_source_role_membership_boundary; then
		report_source_role_boundary
		fail "Source database still permits a Notification Delivery role to connect."
	fi
}

verify_source_cleanup_complete() {
	local boundary

	verify_source_database_identity
	boundary="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT (
					to_regnamespace('$TARGET_SCHEMA') IS NULL
					AND (
						SELECT count(*) = 3
							AND bool_and(NOT rolcanlogin)
						FROM pg_roles
						WHERE rolname IN (
							'$runtime_user',
							'$migration_user',
							'$backup_user'
						)
					)
					AND NOT EXISTS (
						SELECT 1
						FROM pg_stat_activity
						WHERE datname = current_database()
							AND usename IN (
								'$runtime_user',
								'$migration_user',
								'$backup_user'
							)
					)
				);
			"
	)"
	[[ "$boundary" == "t" ]] &&
		verify_source_role_membership_boundary
}

revoke_source_cleanup_access() {
	if [[ "$source_cleanup_access_granted" != "true" ]]; then
		return
	fi
	if run_psql "$admin_password" "$admin_source_libpq_url" \
		--quiet \
		--command "
			REVOKE CONNECT ON DATABASE \"$source_database\"
				FROM \"$migration_user\";
			ALTER ROLE \"$migration_user\" NOLOGIN;
		"; then
		source_cleanup_access_granted=false
		return
	fi
	echo "CRITICAL: temporary source cleanup access could not be revoked; its unknown one-time password expires within five minutes." >&2
	return 1
}

drop_source_schema_and_disable_roles() {
	local cleanup_status=0
	local cleanup_credential_file
	local cleanup_password
	local credential_fence
	local schema_boundary
	local schema_exists

	if verify_source_cleanup_complete; then
		return
	fi

	revoke_source_database_access
	run_psql "$admin_password" "$admin_source_libpq_url" \
		--quiet \
		--command "
			BEGIN;
			ALTER ROLE \"$runtime_user\" NOLOGIN;
			ALTER ROLE \"$migration_user\" NOLOGIN;
			ALTER ROLE \"$backup_user\" NOLOGIN;
			ROLLBACK;
		"
	schema_exists="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT to_regnamespace('$TARGET_SCHEMA') IS NOT NULL;
			"
	)"
	[[ "$schema_exists" == "t" || "$schema_exists" == "f" ]] ||
		fail "Could not determine the source Notification Delivery schema state."

	if [[ "$schema_exists" == "t" ]]; then
		verify_frozen_source_snapshot
		schema_boundary="$(
			run_psql "$admin_password" "$admin_source_libpq_url" \
				--quiet --tuples-only --no-align \
				--command "
					SELECT (
						(
							SELECT pg_get_userbyid(nspowner)
							FROM pg_namespace
							WHERE nspname = '$TARGET_SCHEMA'
						) = '$migration_user'
						AND (
							SELECT count(*) = 3
								AND bool_and(
									NOT rolcanlogin
									AND NOT rolsuper
									AND NOT rolcreatedb
									AND NOT rolcreaterole
									AND NOT rolreplication
									AND NOT rolbypassrls
								)
							FROM pg_roles
							WHERE rolname IN (
								'$runtime_user',
								'$migration_user',
								'$backup_user'
							)
						)
					);
				"
		)"
		[[ "$schema_boundary" == "t" ]] ||
			fail "Source schema ownership or dedicated role boundary changed before cleanup."

		cleanup_password="$(
			od -An -N32 -tx1 /dev/urandom |
				tr -d ' \n'
		)"
		[[ "$cleanup_password" =~ ^[0-9a-f]{64}$ ]] ||
			fail "Could not generate the one-time source cleanup credential."
		cleanup_credential_file="$temporary_directory/source-cleanup-credential.sql"
		{
			printf 'BEGIN;\n'
			printf 'DO $$\n'
			printf 'BEGIN\n'
			printf '  EXECUTE format(\n'
			printf "    'ALTER ROLE %%I LOGIN PASSWORD %%L CONNECTION LIMIT 1 VALID UNTIL %%L',\n"
			printf "    '%s',\n" "$migration_user"
			printf "    '%s',\n" "$cleanup_password"
			printf "    CURRENT_TIMESTAMP + INTERVAL '5 minutes'\n"
			printf '  );\n'
			printf 'END\n'
			printf '$$;\n'
			printf 'ALTER ROLE "%s" SET lock_timeout = '"'"'15s'"'"';\n' \
				"$migration_user"
			printf 'ALTER ROLE "%s" SET statement_timeout = '"'"'2min'"'"';\n' \
				"$migration_user"
			printf 'ALTER ROLE "%s" SET idle_in_transaction_session_timeout = '"'"'60s'"'"';\n' \
				"$migration_user"
			printf 'ALTER ROLE "%s" SET idle_session_timeout = '"'"'2min'"'"';\n' \
				"$migration_user"
			printf 'GRANT CONNECT ON DATABASE "%s" TO "%s";\n' \
				"$source_database" \
				"$migration_user"
			printf 'COMMIT;\n'
		} >"$cleanup_credential_file"
		chmod 600 "$cleanup_credential_file"
		source_cleanup_access_granted=true
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet \
			--file /cutover/source-cleanup-credential.sql
		rm -f -- "$cleanup_credential_file"
		credential_fence="$(
			run_psql "$admin_password" "$admin_source_libpq_url" \
				--quiet --tuples-only --no-align \
				--command "
					SELECT (
						(
							SELECT rolcanlogin
								AND rolconnlimit = 1
								AND rolvaliduntil > CURRENT_TIMESTAMP
								AND rolvaliduntil <= CURRENT_TIMESTAMP
									+ INTERVAL '6 minutes'
							FROM pg_roles
							WHERE rolname = '$migration_user'
						)
						AND (
							SELECT count(*) = 2
								AND bool_and(NOT rolcanlogin)
							FROM pg_roles
							WHERE rolname IN (
								'$runtime_user',
								'$backup_user'
							)
						)
						AND NOT EXISTS (
							SELECT 1
							FROM pg_stat_activity
							WHERE datname = current_database()
								AND usename IN (
									'$runtime_user',
									'$migration_user',
									'$backup_user'
								)
						)
					)
					;
				"
		)"
		if [[ "$credential_fence" != "t" ]]; then
			revoke_source_cleanup_access || true
			fail "Source migration role did not receive the bounded cleanup credential fence."
		fi

		set +e
		run_psql "$cleanup_password" "$migration_source_libpq_url" \
			--quiet \
			--command "
				BEGIN;
				SET LOCAL lock_timeout = '15s';
				SET LOCAL statement_timeout = '2min';
				SET LOCAL idle_in_transaction_session_timeout = '60s';
				DO \$\$
				BEGIN
					IF current_user <> '$migration_user' THEN
						RAISE EXCEPTION 'Unexpected source schema owner';
					END IF;
					IF EXISTS (
						SELECT 1
						FROM \"$TARGET_SCHEMA\".\"delivery_receipts\"
						WHERE \"status\" = 'PROCESSING'
					) OR EXISTS (
						SELECT 1
						FROM \"$TARGET_SCHEMA\".\"outbox_events\"
						WHERE \"status\" = 'PUBLISHING'
					) THEN
						RAISE EXCEPTION 'Source Notification Delivery state is not quiescent';
					END IF;
				END
				\$\$;
				DROP TABLE
					\"$TARGET_SCHEMA\".\"_prisma_migrations\",
					\"$TARGET_SCHEMA\".\"control_actions\",
					\"$TARGET_SCHEMA\".\"delivery_failures\",
					\"$TARGET_SCHEMA\".\"delivery_receipts\",
					\"$TARGET_SCHEMA\".\"heartbeats\",
					\"$TARGET_SCHEMA\".\"outbox_events\"
				RESTRICT;
				DROP TYPE
					\"$TARGET_SCHEMA\".\"NotificationDeliveryControlActionKind\",
					\"$TARGET_SCHEMA\".\"NotificationDeliveryErrorCategory\",
					\"$TARGET_SCHEMA\".\"NotificationDeliveryExchange\",
					\"$TARGET_SCHEMA\".\"NotificationDeliveryFailureResolution\",
					\"$TARGET_SCHEMA\".\"NotificationDeliveryOutboxStatus\",
					\"$TARGET_SCHEMA\".\"NotificationDeliveryReceiptStatus\"
				RESTRICT;
				DROP SCHEMA \"$TARGET_SCHEMA\" RESTRICT;
				COMMIT;
			"
		cleanup_status=$?
		set -e

		revoke_source_cleanup_access ||
			fail "Temporary source cleanup access could not be revoked."
		((cleanup_status == 0)) ||
			fail "Source Notification Delivery schema cleanup failed."
	fi

	run_psql "$admin_password" "$admin_source_libpq_url" \
		--quiet \
		--command "
			REVOKE CONNECT ON DATABASE \"$source_database\"
				FROM \"$runtime_user\", \"$migration_user\", \"$backup_user\";
			ALTER ROLE \"$runtime_user\" NOLOGIN;
			ALTER ROLE \"$migration_user\" NOLOGIN;
			ALTER ROLE \"$backup_user\" NOLOGIN;
		"

	verify_source_cleanup_complete ||
		fail "Source Notification Delivery schema or roles remain active after cleanup."
}

verify_target_postgres_container() {
	local container_id
	local health_status
	local image_ref
	local owner_label
	local purpose_label
	local network_attachment
	local network_identity
	local network_container_ids
	local volume_mount
	local port_binding
	local attached_container_ids
	local identity
	local identity_database
	local identity_user
	local identity_major
	local identity_checksums
	local identity_data_directory
	local observed_image_id
	local observed_system_identifier
	local pgdata_env

	container_id="$(
		compose_target ps --status running -q "$POSTGRES_SERVICE" \
			2>/dev/null || true
	)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] || return 1
	health_status="$(
		docker inspect \
			--format '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}missing{{ end }}' \
			"$container_id" 2>/dev/null || true
	)"
	[[ "$health_status" == "healthy" ]] || return 1
	image_ref="$(
		docker inspect --format '{{ .Config.Image }}' "$container_id"
	)"
	[[ "$image_ref" == "$target_postgres_image" ]] || return 1
	observed_image_id="$(
		docker inspect --format '{{ .Image }}' "$container_id"
	)"
	[[ "$observed_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	database_tools_image="$observed_image_id"
	owner_label="$(
		docker inspect \
			--format '{{ index .Config.Labels "com.winwidget.owner" }}' \
			"$container_id"
	)"
	purpose_label="$(
		docker inspect \
			--format '{{ index .Config.Labels "com.winwidget.purpose" }}' \
			"$container_id"
	)"
	[[ "$owner_label" == "notification-delivery" &&
		"$purpose_label" == "postgres" ]] || return 1
	pgdata_env="$(
		container_env_value "$container_id" PGDATA
	)"
	[[ "$pgdata_env" == "/var/lib/postgresql/18/docker" ]] || return 1
	network_attachment="$(
		docker inspect --format \
			'{{ range $name, $_ := .NetworkSettings.Networks }}{{ println $name }}{{ end }}' \
			"$container_id"
	)"
	[[ "$network_attachment" == "$POSTGRES_NETWORK" ]] ||
		return 1
	network_identity="$(
		docker network inspect \
			--format '{{ .Driver }}|{{ .Scope }}|{{ .Internal }}|{{ index .Labels "com.winwidget.owner" }}|{{ index .Labels "com.winwidget.purpose" }}' \
			"$network_attachment"
	)"
	[[ "$network_identity" == "$POSTGRES_NETWORK_IDENTITY" ]] ||
		return 1
	network_container_ids="$(
		docker network inspect \
			--format '{{ range $id, $_ := .Containers }}{{ println $id }}{{ end }}' \
			"$network_attachment"
	)"
	[[ "$network_container_ids" == "$container_id" ]] || return 1
	volume_mount="$(
		docker inspect --format \
			'{{ range .Mounts }}{{ printf "%s|%s|%s|%t\n" .Destination .Type .Name .RW }}{{ end }}' \
			"$container_id" |
			awk -F'|' '$1 == "/var/lib/postgresql" || index($1, "/var/lib/postgresql/") == 1'
	)"
	[[ "$volume_mount" == "/var/lib/postgresql|volume|$target_volume|true" ]] ||
		return 1
	port_binding="$(
		docker inspect --format \
			'{{ with (index .NetworkSettings.Ports "5432/tcp") }}{{ (index . 0).HostIp }}|{{ (index . 0).HostPort }}|{{ len . }}{{ end }}' \
			"$container_id"
	)"
	[[ "$port_binding" == "$TARGET_HOST|$target_port|1" ]] || return 1
	attached_container_ids="$(
		docker ps -a --no-trunc \
			--filter "volume=$target_volume" \
			--format '{{ .ID }}'
	)"
	[[ "$attached_container_ids" == "$container_id" ]] || return 1

	identity="$(
		run_psql "$target_admin_password" "$target_admin_server_libpq_url" \
			--quiet --tuples-only --no-align --field-separator '|' \
			--command "
				SELECT
					current_database(),
					current_user,
					current_setting('server_version_num')::integer / 10000,
					current_setting('data_checksums'),
					current_setting('data_directory'),
					system_identifier
				FROM pg_control_system();
			"
	)" || return 1
	IFS='|' read -r \
		identity_database \
		identity_user \
		identity_major \
		identity_checksums \
		identity_data_directory \
		observed_system_identifier <<<"$identity"
	[[ "$identity_database" == "postgres" &&
		"$identity_user" == "$target_admin_user" &&
		"$identity_major" == "18" &&
		"$identity_checksums" == "on" &&
		"$identity_data_directory" == "/var/lib/postgresql/18/docker" &&
		"$observed_system_identifier" =~ ^[0-9]+$ ]] || return 1

	if [[ -n "$target_postgres_image_id" &&
		"$target_postgres_image_id" != "$observed_image_id" ]]; then
		return 1
	fi
	if [[ -n "$target_system_identifier" &&
		"$target_system_identifier" != "$observed_system_identifier" ]]; then
		return 1
	fi
	target_postgres_image_id="$observed_image_id"
	target_system_identifier="$observed_system_identifier"
}

recover_legacy_pre_cutover_postgres_network() {
	local network_identity
	local network_container_ids
	local container_id
	local container_networks
	local project_label
	local service_label
	local owner_label
	local purpose_label
	local image_ref
	local pgdata_env
	local database_env
	local admin_user_env
	local password_file_env
	local volume_mount
	local secret_mount
	local attached_container_ids
	local worker_database_url
	local running

	if ! docker network inspect "$POSTGRES_NETWORK" >/dev/null 2>&1; then
		return
	fi
	network_identity="$(
		docker network inspect \
			--format '{{ .Driver }}|{{ .Scope }}|{{ .Internal }}|{{ index .Labels "com.winwidget.owner" }}|{{ index .Labels "com.winwidget.purpose" }}' \
			"$POSTGRES_NETWORK"
	)"
	if [[ "$network_identity" == "$POSTGRES_NETWORK_IDENTITY" ]]; then
		return
	fi
	[[ ! -e "$MARKER_FILE" && ! -L "$MARKER_FILE" ]] ||
		fail "Refusing to repair the legacy PostgreSQL network after cutover state was created."
	[[ "$network_identity" == "$LEGACY_POSTGRES_NETWORK_IDENTITY" ]] ||
		fail "Notification Delivery PostgreSQL network identity is invalid."

	network_container_ids="$(
		docker network inspect \
			--format '{{ range $id, $_ := .Containers }}{{ println $id }}{{ end }}' \
			"$POSTGRES_NETWORK"
	)"
	container_id="$(
		resolve_project_container "$POSTGRES_SERVICE" true true
	)"
	attached_container_ids="$(
		docker ps -a --no-trunc \
			--filter "volume=$target_volume" \
			--format '{{ .ID }}'
	)"
	if [[ -z "$container_id" ]]; then
		[[ -z "$network_container_ids" && -z "$attached_container_ids" ]] ||
			fail "Legacy Notification Delivery PostgreSQL network or volume is used by an unexpected container."
	else
		container_networks="$(
			docker inspect --format \
				'{{ range $name, $_ := .NetworkSettings.Networks }}{{ println $name }}{{ end }}' \
				"$container_id"
		)"
		project_label="$(
			docker inspect \
				--format '{{ index .Config.Labels "com.docker.compose.project" }}' \
				"$container_id"
		)"
		service_label="$(
			docker inspect \
				--format '{{ index .Config.Labels "com.docker.compose.service" }}' \
				"$container_id"
		)"
		owner_label="$(
			docker inspect \
				--format '{{ index .Config.Labels "com.winwidget.owner" }}' \
				"$container_id"
		)"
		purpose_label="$(
			docker inspect \
				--format '{{ index .Config.Labels "com.winwidget.purpose" }}' \
				"$container_id"
		)"
		image_ref="$(
			docker inspect --format '{{ .Config.Image }}' "$container_id"
		)"
		pgdata_env="$(container_env_value "$container_id" PGDATA)"
		database_env="$(container_env_value "$container_id" POSTGRES_DB)"
		admin_user_env="$(container_env_value "$container_id" POSTGRES_USER)"
		password_file_env="$(
			container_env_value "$container_id" POSTGRES_PASSWORD_FILE
		)"
		volume_mount="$(
			docker inspect --format \
				'{{ range .Mounts }}{{ printf "%s|%s|%s|%t\n" .Destination .Type .Name .RW }}{{ end }}' \
				"$container_id" |
				awk -F'|' '$1 == "/var/lib/postgresql" || index($1, "/var/lib/postgresql/") == 1'
		)"
		secret_mount="$(
			docker inspect --format \
				'{{ range .Mounts }}{{ printf "%s|%s|%s|%t\n" .Destination .Type .Source .RW }}{{ end }}' \
				"$container_id" |
				awk -F'|' '$1 == "/run/secrets/notification-delivery-postgres-admin-password"'
		)"
		worker_database_url="$(
			container_env_value \
				"$worker_container_id" \
				NOTIFICATION_DELIVERY_DATABASE_URL 2>/dev/null || true
		)"
		[[ "$runtime_current_location" == "source" &&
			"$project_label" == "winwidget" &&
			"$service_label" == "$POSTGRES_SERVICE" &&
			"$owner_label" == "notification-delivery" &&
			"$purpose_label" == "postgres" &&
			"$image_ref" == "$target_postgres_image" &&
			"$pgdata_env" == "/var/lib/postgresql/18/docker" &&
			"$database_env" == "$TARGET_DATABASE" &&
			"$admin_user_env" == "$target_admin_user" &&
			"$password_file_env" == "/run/secrets/notification-delivery-postgres-admin-password" &&
			"$container_networks" == "$POSTGRES_NETWORK" &&
			"$network_container_ids" == "$container_id" &&
			"$volume_mount" == "/var/lib/postgresql|volume|$target_volume|true" &&
			"$secret_mount" == "/run/secrets/notification-delivery-postgres-admin-password|bind|$target_admin_password_file|false" &&
			"$attached_container_ids" == "$container_id" &&
			"$worker_database_url" == "$(get_env_value NOTIFICATION_DELIVERY_DATABASE_URL)" ]] ||
			fail "Legacy Notification Delivery PostgreSQL resources do not match the safe pre-cutover recovery identity."
		running="$(
			docker inspect --format '{{ .State.Running }}' "$container_id"
		)"
		if [[ "$running" == "true" ]]; then
			docker stop --timeout 60 "$container_id" >/dev/null
		fi
		docker rm "$container_id" >/dev/null
	fi
	docker network rm "$POSTGRES_NETWORK" >/dev/null
	docker volume inspect "$target_volume" >/dev/null
	[[ -f "$target_admin_password_file" && ! -L "$target_admin_password_file" ]] ||
		fail "Notification Delivery PostgreSQL admin secret disappeared during network recovery."
	echo "Recovered the failed pre-cutover PostgreSQL layout without removing its external volume."
}

report_target_postgres_diagnostics() {
	local container_id

	container_id="$(
		compose_target ps -a -q "$POSTGRES_SERVICE" 2>/dev/null || true
	)"
	if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
		echo "Notification Delivery PostgreSQL diagnostics: canonical container is missing or ambiguous." >&2
		return
	fi
	docker inspect --format \
		'status={{ .State.Status }} running={{ .State.Running }} health={{ if .State.Health }}{{ .State.Health.Status }}{{ else }}missing{{ end }} image={{ .Config.Image }}' \
		"$container_id" >&2 || true
	docker inspect --format \
		'{{ range .Mounts }}mount={{ .Destination }}|{{ .Type }}|{{ .Name }}|rw={{ .RW }}{{ println }}{{ end }}{{ range $name, $_ := .NetworkSettings.Networks }}network={{ $name }}{{ println }}{{ end }}ports={{ json .NetworkSettings.Ports }}' \
		"$container_id" >&2 || true
	docker logs --tail 100 "$container_id" >&2 || true
}

start_target_postgres() {
	local attempt
	local existing_container_id
	local running

	recover_legacy_pre_cutover_postgres_network
	existing_container_id="$(
		compose_target ps -a -q "$POSTGRES_SERVICE" 2>/dev/null || true
	)"
	if [[ -n "$existing_container_id" ]]; then
		[[ "$existing_container_id" != *$'\n'* ]] ||
			fail "Multiple Notification Delivery PostgreSQL containers were found."
		running="$(
			docker inspect --format '{{ .State.Running }}' "$existing_container_id"
		)"
		if [[ "$running" != "true" ]]; then
			docker start "$existing_container_id" >/dev/null
		fi
	else
		compose_target up -d --no-deps "$POSTGRES_SERVICE"
	fi
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_target_postgres_container; then
			return
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	report_target_postgres_diagnostics
	fail "Notification Delivery PostgreSQL container failed its canonical health, network, volume, port or identity checks."
}

verify_postgres_compatibility_and_capacity() {
	local source_major
	local target_major
	local source_locale_identity
	local target_locale_identity
	local expected_locale_identity="UTF8|c|C.UTF-8|C.UTF-8|"
	local source_schema_bytes
	local required_free_bytes
	local required_host_free_bytes
	local container_id
	local free_kilobytes
	local free_bytes
	local host_free_kilobytes
	local host_free_bytes

	source_major="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT current_setting('server_version_num')::integer / 10000;
			"
	)"
	target_major="$(
		run_psql "$target_admin_password" "$target_admin_server_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT current_setting('server_version_num')::integer / 10000;
			"
	)"
	[[ "$source_major" == "18" && "$target_major" == "18" ]] ||
		fail "Source and target PostgreSQL must both use major version 18."

	source_locale_identity="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align --field-separator '|' \
			--command "
					SELECT
						pg_encoding_to_char(encoding),
						datlocprovider,
						datcollate,
						datctype,
						COALESCE(datcollversion, '')
				FROM pg_database
				WHERE datname = current_database();
			"
	)"
	target_locale_identity="$(
		run_psql "$target_admin_password" "$target_admin_server_libpq_url" \
			--quiet --tuples-only --no-align --field-separator '|' \
			--command "
					SELECT
						pg_encoding_to_char(encoding),
						datlocprovider,
						datcollate,
						datctype,
						COALESCE(datcollversion, '')
				FROM pg_database
				WHERE datname = CASE
					WHEN EXISTS (
						SELECT 1
						FROM pg_database
						WHERE datname = '$TARGET_DATABASE'
					)
					THEN '$TARGET_DATABASE'
					ELSE 'template0'
				END;
			"
	)"
	if [[ "$source_locale_identity" != "$expected_locale_identity" ||
		"$target_locale_identity" != "$expected_locale_identity" ]]; then
		echo "Source locale identity: $source_locale_identity" >&2
		echo "Target locale identity: $target_locale_identity" >&2
		fail "Source and target PostgreSQL locale/collation must exactly match the approved UTF8 libc C.UTF-8 identity."
	fi

	source_schema_bytes="$(
		run_psql "$migration_password" "$migration_source_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT COALESCE(
					sum(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))),
					0
				)::bigint
				FROM pg_tables
				WHERE schemaname = '$TARGET_SCHEMA';
			"
	)"
	[[ "$source_schema_bytes" =~ ^[0-9]+$ ]] ||
		fail "Could not determine Notification Delivery source schema size."
	required_free_bytes=$((source_schema_bytes * 3 + 1073741824))
	required_host_free_bytes=$((source_schema_bytes * 5 + 1610612736))
	host_free_kilobytes="$(
		df -Pk "$temporary_directory" |
			awk 'NR == 2 { print $4 }'
	)"
	[[ "$host_free_kilobytes" =~ ^[0-9]+$ ]] ||
		fail "Could not determine cutover workspace free disk space."
	host_free_bytes=$((host_free_kilobytes * 1024))
	((host_free_bytes >= required_host_free_bytes)) ||
		fail "The VPS filesystem has insufficient free disk space for the dump, restore and rollback workspace."
	container_id="$(
		compose_target ps --status running -q "$POSTGRES_SERVICE"
	)"
	free_kilobytes="$(
		docker exec "$container_id" \
			df -Pk /var/lib/postgresql |
			awk 'NR == 2 { print $4 }'
	)"
	[[ "$free_kilobytes" =~ ^[0-9]+$ ]] ||
		fail "Could not determine Notification Delivery PostgreSQL free disk space."
	free_bytes=$((free_kilobytes * 1024))
	((free_bytes >= required_free_bytes)) ||
		fail "Notification Delivery PostgreSQL volume has insufficient free disk space."
}

bootstrap_target_roles() {
	local bootstrap_file="$temporary_directory/bootstrap-target-roles.sql"

	printf '%s\t%s\n%s\t%s\n%s\t%s\n' \
		"$runtime_user" \
		"$(printf '%s' "$runtime_password" | base64 | tr -d '\n')" \
		"$migration_user" \
		"$(printf '%s' "$migration_password" | base64 | tr -d '\n')" \
		"$backup_user" \
		"$(printf '%s' "$backup_password" | base64 | tr -d '\n')" |
		docker run --rm -i \
			--network none \
			--entrypoint node \
			"$node_tools_image" \
			-e '
const { readFileSync } = require("node:fs");
const lines = readFileSync(0, "utf8").trim().split("\n");
if (lines.length !== 3) throw new Error("Expected three service roles");
const quoteIdentifier = value => `"${value.replaceAll("\"", "\"\"")}"`;
const apostrophe = String.fromCharCode(39);
const quoteLiteral = value =>
	`${apostrophe}${value
		.split(apostrophe)
		.join(apostrophe + apostrophe)}${apostrophe}`;
let sql = `SET password_encryption = ${quoteLiteral("scram-sha-256")};\n`;
for (const line of lines) {
	const [role, encodedPassword] = line.split("\t");
	const password = Buffer.from(encodedPassword, "base64").toString("utf8");
	if (
		!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role) ||
		!password ||
		/[\u0000-\u001f\u007f]/.test(password)
	) {
		throw new Error("Invalid target role bootstrap input");
	}
	const identifier = quoteIdentifier(role);
	sql += `
DO $role$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
		CREATE ROLE ${identifier};
	END IF;
END
$role$;
ALTER ROLE ${identifier}
	WITH LOGIN PASSWORD ${quoteLiteral(password)}
	NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
`;
}
process.stdout.write(sql);
' >"$bootstrap_file"
	chmod 600 "$bootstrap_file"

	run_psql \
		"$target_admin_password" \
		"$target_admin_server_libpq_url" \
		--quiet \
		--file /cutover/bootstrap-target-roles.sql
	rm -f "$bootstrap_file"
}

target_database_state() {
	run_psql "$target_admin_password" "$target_admin_server_libpq_url" \
		--quiet --tuples-only --no-align --field-separator '|' \
		--command "
			SELECT datname, pg_get_userbyid(datdba)
			FROM pg_database
			WHERE datname = '$TARGET_DATABASE';
		"
}

verify_existing_target_is_empty() {
	local state

	state="$(
		run_psql "$target_admin_password" "$target_admin_libpq_url" \
			--quiet --tuples-only --no-align --field-separator '|' \
			--command "
				SELECT
					(
						SELECT count(*)
						FROM pg_namespace
						WHERE nspname NOT IN (
							'pg_catalog',
							'information_schema',
							'public'
						)
							AND nspname NOT LIKE 'pg_toast%'
							AND nspname NOT LIKE 'pg_temp_%'
					),
					(
						SELECT count(*)
						FROM pg_class AS classes
						JOIN pg_namespace AS namespaces
							ON namespaces.oid = classes.relnamespace
						WHERE namespaces.nspname = 'public'
							AND classes.relkind IN (
								'r',
								'p',
								'v',
								'm',
								'S',
								'f'
							)
					),
					(
						SELECT count(*)
						FROM pg_extension
						WHERE extname <> 'plpgsql'
					),
					(
						SELECT count(*)
						FROM pg_proc AS procedures
						JOIN pg_namespace AS namespaces
							ON namespaces.oid = procedures.pronamespace
						WHERE namespaces.nspname = 'public'
					),
					(
						SELECT count(*)
						FROM pg_type AS types
						JOIN pg_namespace AS namespaces
							ON namespaces.oid = types.typnamespace
						WHERE namespaces.nspname = 'public'
							AND types.typisdefined
					),
					(
						SELECT count(*)
						FROM pg_collation AS collations
						JOIN pg_namespace AS namespaces
							ON namespaces.oid = collations.collnamespace
						WHERE namespaces.nspname = 'public'
					),
					(
						SELECT count(*)
						FROM pg_conversion AS conversions
						JOIN pg_namespace AS namespaces
							ON namespaces.oid = conversions.connamespace
						WHERE namespaces.nspname = 'public'
					),
					(
						SELECT
							(
								SELECT count(*)
								FROM pg_operator AS operators
								JOIN pg_namespace AS namespaces
									ON namespaces.oid = operators.oprnamespace
								WHERE namespaces.nspname = 'public'
							) +
							(
								SELECT count(*)
								FROM pg_opclass AS classes
								JOIN pg_namespace AS namespaces
									ON namespaces.oid = classes.opcnamespace
								WHERE namespaces.nspname = 'public'
							) +
							(
								SELECT count(*)
								FROM pg_opfamily AS families
								JOIN pg_namespace AS namespaces
									ON namespaces.oid = families.opfnamespace
								WHERE namespaces.nspname = 'public'
							) +
							(
								SELECT count(*)
								FROM pg_ts_config AS configurations
								JOIN pg_namespace AS namespaces
									ON namespaces.oid = configurations.cfgnamespace
								WHERE namespaces.nspname = 'public'
							) +
							(
								SELECT count(*)
								FROM pg_ts_dict AS dictionaries
								JOIN pg_namespace AS namespaces
									ON namespaces.oid = dictionaries.dictnamespace
								WHERE namespaces.nspname = 'public'
							)
					),
					(
						SELECT count(*)
						FROM pg_largeobject_metadata
					),
					(
						SELECT
							(SELECT count(*) FROM pg_event_trigger) +
							(SELECT count(*) FROM pg_publication) +
							(SELECT count(*) FROM pg_subscription)
					);
			"
		)"
	[[ "$state" == "0|0|0|0|0|0|0|0|0|0" ]] ||
		fail "Existing target database is not empty; refusing to overwrite it."
}

create_target_database() {
	run_psql "$target_admin_password" "$target_admin_server_libpq_url" \
		--quiet \
		--command "
			CREATE DATABASE \"$TARGET_DATABASE\"
				WITH OWNER \"$target_admin_user\"
				TEMPLATE template0;
		"
}

reset_target_database() {
	local connections

	connections="$(
		run_psql "$target_admin_password" "$target_admin_server_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT count(*)
				FROM pg_stat_activity
				WHERE datname = '$TARGET_DATABASE';
			"
	)"
	[[ "$connections" == "0" ]] ||
		fail "Target database has active connections and cannot be reset safely."
	run_psql "$target_admin_password" "$target_admin_server_libpq_url" \
		--quiet \
		--command "DROP DATABASE \"$TARGET_DATABASE\";"
	create_target_database
}

prepare_target_database() {
	local existing_target

	existing_target="$(target_database_state)"
	if [[ "$marker_phase" == "restoring" ]]; then
		if [[ -n "$existing_target" ]]; then
			[[ "$existing_target" == "$TARGET_DATABASE|$target_admin_user" ]] ||
				fail "Target database has an unexpected owner."
			reset_target_database
		else
			create_target_database
		fi
		target_accepted=true
		return
	fi

	if [[ -n "$existing_target" ]]; then
		[[ "$existing_target" == "$TARGET_DATABASE|$target_admin_user" ]] ||
			fail "Target database has an unexpected owner."
		verify_existing_target_is_empty
	fi

	write_marker "restoring"
	target_accepted=true
	if [[ -z "$existing_target" ]]; then
		create_target_database
	fi
}

grant_temporary_restore_boundary() {
	run_psql "$target_admin_password" "$target_admin_libpq_url" \
		--quiet \
		--command "
			REVOKE ALL ON DATABASE \"$TARGET_DATABASE\" FROM PUBLIC;
			GRANT CONNECT ON DATABASE \"$TARGET_DATABASE\"
				TO \"$runtime_user\", \"$migration_user\", \"$backup_user\";
			GRANT CREATE ON DATABASE \"$TARGET_DATABASE\" TO \"$migration_user\";
			REVOKE CREATE, TEMPORARY ON DATABASE \"$TARGET_DATABASE\"
				FROM \"$runtime_user\", \"$backup_user\";
			REVOKE ALL ON SCHEMA public FROM PUBLIC;
			REVOKE ALL ON SCHEMA public
				FROM \"$runtime_user\", \"$migration_user\", \"$backup_user\";
		"
}

apply_strict_target_acls() {
	run_psql "$migration_password" "$migration_target_libpq_url" \
		--quiet \
		--command "
			REVOKE ALL ON SCHEMA \"$TARGET_SCHEMA\" FROM PUBLIC;
			REVOKE ALL ON SCHEMA \"$TARGET_SCHEMA\"
				FROM \"$runtime_user\", \"$backup_user\";
			GRANT USAGE ON SCHEMA \"$TARGET_SCHEMA\"
				TO \"$runtime_user\", \"$backup_user\";

			REVOKE ALL ON ALL TABLES IN SCHEMA \"$TARGET_SCHEMA\" FROM PUBLIC;
			REVOKE ALL ON ALL TABLES IN SCHEMA \"$TARGET_SCHEMA\"
				FROM \"$runtime_user\", \"$backup_user\";
			GRANT SELECT, INSERT, UPDATE, DELETE
				ON ALL TABLES IN SCHEMA \"$TARGET_SCHEMA\"
				TO \"$runtime_user\";
			REVOKE ALL
				ON TABLE \"$TARGET_SCHEMA\".\"_prisma_migrations\"
				FROM \"$runtime_user\";
			GRANT SELECT
				ON ALL TABLES IN SCHEMA \"$TARGET_SCHEMA\"
				TO \"$backup_user\";

			REVOKE ALL ON ALL SEQUENCES IN SCHEMA \"$TARGET_SCHEMA\" FROM PUBLIC;
			REVOKE ALL ON ALL SEQUENCES IN SCHEMA \"$TARGET_SCHEMA\"
				FROM \"$runtime_user\", \"$backup_user\";
			GRANT USAGE, SELECT, UPDATE
				ON ALL SEQUENCES IN SCHEMA \"$TARGET_SCHEMA\"
				TO \"$runtime_user\";
			GRANT SELECT
				ON ALL SEQUENCES IN SCHEMA \"$TARGET_SCHEMA\"
				TO \"$backup_user\";

			REVOKE ALL ON ALL FUNCTIONS IN SCHEMA \"$TARGET_SCHEMA\" FROM PUBLIC;

			ALTER DEFAULT PRIVILEGES FOR ROLE \"$migration_user\"
				IN SCHEMA \"$TARGET_SCHEMA\"
				REVOKE ALL ON TABLES FROM PUBLIC;
			ALTER DEFAULT PRIVILEGES FOR ROLE \"$migration_user\"
				IN SCHEMA \"$TARGET_SCHEMA\"
				GRANT SELECT, INSERT, UPDATE, DELETE
				ON TABLES TO \"$runtime_user\";
			ALTER DEFAULT PRIVILEGES FOR ROLE \"$migration_user\"
				IN SCHEMA \"$TARGET_SCHEMA\"
				GRANT SELECT ON TABLES TO \"$backup_user\";

			ALTER DEFAULT PRIVILEGES FOR ROLE \"$migration_user\"
				IN SCHEMA \"$TARGET_SCHEMA\"
				REVOKE ALL ON SEQUENCES FROM PUBLIC;
			ALTER DEFAULT PRIVILEGES FOR ROLE \"$migration_user\"
				IN SCHEMA \"$TARGET_SCHEMA\"
				GRANT USAGE, SELECT, UPDATE
				ON SEQUENCES TO \"$runtime_user\";
			ALTER DEFAULT PRIVILEGES FOR ROLE \"$migration_user\"
				IN SCHEMA \"$TARGET_SCHEMA\"
				GRANT SELECT ON SEQUENCES TO \"$backup_user\";

			ALTER DEFAULT PRIVILEGES FOR ROLE \"$migration_user\"
				IN SCHEMA \"$TARGET_SCHEMA\"
				REVOKE ALL ON FUNCTIONS FROM PUBLIC;
		"

	run_psql "$target_admin_password" "$target_admin_libpq_url" \
		--quiet \
		--command "
			REVOKE CREATE, TEMPORARY ON DATABASE \"$TARGET_DATABASE\"
				FROM \"$migration_user\";
		"
}

verify_target_acl_boundary() {
	local boundary

	boundary="$(
		run_psql "$target_admin_password" "$target_admin_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				WITH application_tables AS (
					SELECT format('%I.%I', schemaname, tablename) AS object_name
					FROM pg_tables
					WHERE schemaname = '$TARGET_SCHEMA'
						AND tablename <> '_prisma_migrations'
				),
				all_service_tables AS (
					SELECT
						tablename,
						format('%I.%I', schemaname, tablename) AS object_name
					FROM pg_tables
					WHERE schemaname = '$TARGET_SCHEMA'
				)
				SELECT (
					current_database() = '$TARGET_DATABASE'
					AND pg_get_userbyid((
						SELECT datdba
						FROM pg_database
						WHERE datname = current_database()
					)) = '$target_admin_user'
					AND (
						SELECT pg_get_userbyid(nspowner) = '$migration_user'
						FROM pg_namespace
						WHERE nspname = '$TARGET_SCHEMA'
					)
					AND NOT EXISTS (
						SELECT 1
						FROM pg_database AS databases
						CROSS JOIN LATERAL aclexplode(
							COALESCE(
								databases.datacl,
								acldefault('d', databases.datdba)
							)
						) AS privileges
						WHERE databases.datname = current_database()
							AND privileges.grantee = 0
							AND privileges.privilege_type IN (
								'CONNECT',
								'TEMPORARY'
							)
					)
					AND has_database_privilege('$runtime_user', current_database(), 'CONNECT')
					AND NOT has_database_privilege('$runtime_user', current_database(), 'CREATE')
					AND NOT has_database_privilege('$runtime_user', current_database(), 'TEMPORARY')
					AND has_database_privilege('$migration_user', current_database(), 'CONNECT')
					AND NOT has_database_privilege('$migration_user', current_database(), 'CREATE')
					AND NOT has_database_privilege('$migration_user', current_database(), 'TEMPORARY')
					AND has_database_privilege('$backup_user', current_database(), 'CONNECT')
					AND NOT has_database_privilege('$backup_user', current_database(), 'CREATE')
					AND NOT has_database_privilege('$backup_user', current_database(), 'TEMPORARY')
					AND has_schema_privilege('$runtime_user', '$TARGET_SCHEMA', 'USAGE')
					AND NOT has_schema_privilege('$runtime_user', '$TARGET_SCHEMA', 'CREATE')
					AND has_schema_privilege('$backup_user', '$TARGET_SCHEMA', 'USAGE')
					AND NOT has_schema_privilege('$backup_user', '$TARGET_SCHEMA', 'CREATE')
					AND NOT EXISTS (
						SELECT 1
						FROM pg_namespace AS namespaces
						CROSS JOIN LATERAL aclexplode(
							COALESCE(
								namespaces.nspacl,
								acldefault('n', namespaces.nspowner)
							)
						) AS privileges
						WHERE namespaces.nspname = '$TARGET_SCHEMA'
							AND privileges.grantee = 0
					)
					AND NOT EXISTS (
						SELECT 1
						FROM pg_class AS classes
						JOIN pg_namespace AS namespaces
							ON namespaces.oid = classes.relnamespace
						CROSS JOIN LATERAL aclexplode(
							COALESCE(
								classes.relacl,
								acldefault(
									CASE
										WHEN classes.relkind = 'S' THEN 'S'
										ELSE 'r'
									END,
									classes.relowner
								)
							)
						) AS privileges
						WHERE namespaces.nspname = '$TARGET_SCHEMA'
							AND classes.relkind IN ('r', 'p', 'S', 'v', 'm')
							AND privileges.grantee = 0
					)
					AND (
						SELECT count(*) > 0
							AND bool_and(
								has_table_privilege('$runtime_user', object_name, 'SELECT')
								AND has_table_privilege('$runtime_user', object_name, 'INSERT')
								AND has_table_privilege('$runtime_user', object_name, 'UPDATE')
								AND has_table_privilege('$runtime_user', object_name, 'DELETE')
							)
						FROM application_tables
					)
					AND NOT (
						has_table_privilege(
							'$runtime_user',
							'$TARGET_SCHEMA._prisma_migrations',
							'SELECT'
						)
						OR has_table_privilege(
							'$runtime_user',
							'$TARGET_SCHEMA._prisma_migrations',
							'INSERT'
						)
						OR has_table_privilege(
							'$runtime_user',
							'$TARGET_SCHEMA._prisma_migrations',
							'UPDATE'
						)
						OR has_table_privilege(
							'$runtime_user',
							'$TARGET_SCHEMA._prisma_migrations',
							'DELETE'
						)
					)
					AND (
						SELECT count(*) > 1
							AND bool_and(
								has_table_privilege('$backup_user', object_name, 'SELECT')
								AND NOT has_table_privilege('$backup_user', object_name, 'INSERT')
								AND NOT has_table_privilege('$backup_user', object_name, 'UPDATE')
								AND NOT has_table_privilege('$backup_user', object_name, 'DELETE')
								AND NOT has_table_privilege('$backup_user', object_name, 'TRUNCATE')
							)
						FROM all_service_tables
					)
					AND NOT EXISTS (
						SELECT 1
						FROM pg_sequences
						WHERE schemaname = '$TARGET_SCHEMA'
							AND (
								NOT has_sequence_privilege(
									'$runtime_user',
									format('%I.%I', schemaname, sequencename),
									'SELECT'
								)
								OR NOT has_sequence_privilege(
									'$runtime_user',
									format('%I.%I', schemaname, sequencename),
									'USAGE'
								)
								OR NOT has_sequence_privilege(
									'$runtime_user',
									format('%I.%I', schemaname, sequencename),
									'UPDATE'
								)
								OR NOT has_sequence_privilege(
									'$backup_user',
									format('%I.%I', schemaname, sequencename),
									'SELECT'
								)
								OR has_sequence_privilege(
									'$backup_user',
									format('%I.%I', schemaname, sequencename),
									'USAGE'
								)
								OR has_sequence_privilege(
									'$backup_user',
									format('%I.%I', schemaname, sequencename),
									'UPDATE'
								)
							)
					)
					AND (
						SELECT bool_and(
							pg_get_userbyid(classes.relowner) = '$migration_user'
						)
						FROM pg_class AS classes
						JOIN pg_namespace AS namespaces
							ON namespaces.oid = classes.relnamespace
						WHERE namespaces.nspname = '$TARGET_SCHEMA'
							AND classes.relkind IN ('r', 'p', 'S', 'v', 'm')
					)
				);
			"
	)"
	[[ "$boundary" == "t" ]] ||
		fail "Target Notification Delivery database ACL boundary is invalid."

	run_pg_dump \
		"$backup_password" \
		"$backup_target_libpq_url" \
		--format=custom \
		--no-owner \
		--no-privileges \
		--schema "$TARGET_SCHEMA" \
		--file /dev/null
}

build_data_manifest() {
	local database_url="$1"
	local password="$2"
	local output_file="$3"
	local tables
	local table
	local sequences
	local sequence
	local row_count
	local row_checksum

	tables="$(
		run_psql "$password" "$database_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT tablename
				FROM pg_tables
				WHERE schemaname = '$TARGET_SCHEMA'
				ORDER BY tablename;
			"
	)"
	[[ -n "$tables" ]] ||
		fail "Notification Delivery schema has no tables for checksum verification."
	: >"$output_file"
	while IFS= read -r table; do
		[[ "$table" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
			fail "Notification Delivery contains an unsupported table identifier."
		row_count="$(
			run_psql "$password" "$database_url" \
				--quiet --tuples-only --no-align \
				--command "
					SELECT count(*)
					FROM \"$TARGET_SCHEMA\".\"$table\";
				"
		)"
		[[ "$row_count" =~ ^[0-9]+$ ]] ||
			fail "Could not count a Notification Delivery table."
		row_checksum="$(
			run_psql "$password" "$database_url" \
				--quiet --tuples-only --no-align \
				--command "
					COPY (
						SELECT to_jsonb(source_row)::text
						FROM \"$TARGET_SCHEMA\".\"$table\" AS source_row
						ORDER BY to_jsonb(source_row)::text COLLATE "C"
					) TO STDOUT;
				" |
				sha256sum |
				awk '{ print $1 }'
		)"
		[[ "$row_checksum" =~ ^[0-9a-f]{64}$ ]] ||
			fail "Could not checksum a Notification Delivery table."
		printf '%s\t%s\t%s\n' \
			"$table" \
			"$row_count" \
			"$row_checksum" >>"$output_file"
	done <<<"$tables"
	run_psql "$password" "$database_url" \
		--quiet --tuples-only --no-align --field-separator $'\t' \
		--command "
			SELECT
				'@sequence',
				sequencename,
				COALESCE(last_value::text, 'NULL'),
				start_value,
				increment_by,
				min_value,
				max_value,
				cache_size,
				cycle
			FROM pg_sequences
			WHERE schemaname = '$TARGET_SCHEMA'
			ORDER BY sequencename;
		" >>"$output_file"
	sequences="$(
		run_psql "$password" "$database_url" \
			--quiet --tuples-only --no-align \
			--command "
				SELECT sequencename
				FROM pg_sequences
				WHERE schemaname = '$TARGET_SCHEMA'
				ORDER BY sequencename;
			"
	)"
	while IFS= read -r sequence; do
		[[ -n "$sequence" ]] || continue
		[[ "$sequence" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
			fail "Notification Delivery contains an unsupported sequence identifier."
		run_psql "$password" "$database_url" \
			--quiet --tuples-only --no-align --field-separator $'\t' \
			--command "
				SELECT
					'@sequence-state',
					'$sequence',
					last_value,
					is_called
				FROM \"$TARGET_SCHEMA\".\"$sequence\";
			" >>"$output_file"
	done <<<"$sequences"
	chmod 600 "$output_file"
}

verify_frozen_source_snapshot() {
	local source_schema_dump="$temporary_directory/source.final.schema.sql"
	local source_schema_manifest="$temporary_directory/source.final.schema.manifest.sql"
	local source_manifest="$temporary_directory/source.final.manifest"
	local observed_schema_sha256
	local observed_manifest_sha256
	local frozen_boundary

	verify_source_database_identity
	frozen_boundary="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align --field-separator '|' \
			--command "
				SELECT
					(
						(
							SELECT count(*) = 3
								AND bool_and(NOT rolcanlogin)
							FROM pg_roles
							WHERE rolname IN (
								'$runtime_user',
								'$migration_user',
								'$backup_user'
							)
						)
						AND NOT EXISTS (
							SELECT 1
							FROM pg_stat_activity
							WHERE datname = current_database()
								AND usename IN (
									'$runtime_user',
									'$migration_user',
									'$backup_user'
								)
						)
					),
					(
						SELECT count(*)
						FROM \"$TARGET_SCHEMA\".\"delivery_receipts\"
						WHERE \"status\" = 'PROCESSING'
					),
					(
						SELECT count(*)
						FROM \"$TARGET_SCHEMA\".\"outbox_events\"
						WHERE \"status\" = 'PUBLISHING'
					);
			"
	)"
	[[ "$frozen_boundary" == "t|0|0" ]] ||
		fail "Source Notification Delivery snapshot is not frozen."

	run_pg_dump \
		"$admin_password" \
		"$admin_source_libpq_url" \
		--format=plain \
		--schema-only \
		--no-owner \
		--no-privileges \
		--schema "$TARGET_SCHEMA" \
		--file /cutover/source.final.schema.sql
	sed -E \
		-e '/^-- Dumped from database version /d' \
		-e '/^-- Dumped by pg_dump version /d' \
		-e '/^\\(un)?restrict /d' \
		"$source_schema_dump" >"$source_schema_manifest"
	observed_schema_sha256="$(
		sha256sum "$source_schema_manifest" | awk '{ print $1 }'
	)"
	[[ "$observed_schema_sha256" == "$source_schema_sha256" ]] ||
		fail "Source Notification Delivery schema changed after migration."

	build_data_manifest \
		"$admin_source_libpq_url" \
		"$admin_password" \
		"$source_manifest"
	observed_manifest_sha256="$(
		sha256sum "$source_manifest" | awk '{ print $1 }'
	)"
	[[ "$observed_manifest_sha256" == "$source_manifest_sha256" ]] ||
		fail "Source Notification Delivery data changed after migration."
}

dump_and_restore_target() {
	local dump_file="$temporary_directory/notification-delivery.dump"
	local dump_list_file="$temporary_directory/notification-delivery.dump.list"
	local source_schema_dump="$temporary_directory/source.schema.sql"
	local target_schema_dump="$temporary_directory/target.schema.sql"
	local source_schema_manifest="$temporary_directory/source.schema.manifest.sql"
	local target_schema_manifest="$temporary_directory/target.schema.manifest.sql"
	local source_manifest="$temporary_directory/source.manifest"
	local target_manifest="$temporary_directory/target.manifest"
	local target_schema_sha256

	verify_source_database_quiescence
	build_data_manifest \
		"$admin_source_libpq_url" \
		"$admin_password" \
		"$source_manifest"
	run_pg_dump \
		"$admin_password" \
		"$admin_source_libpq_url" \
		--format=plain \
		--schema-only \
		--no-owner \
		--no-privileges \
		--schema "$TARGET_SCHEMA" \
		--file /cutover/source.schema.sql

	run_pg_dump \
		"$admin_password" \
		"$admin_source_libpq_url" \
		--format=custom \
		--no-owner \
		--no-privileges \
		--schema "$TARGET_SCHEMA" \
		--file /cutover/notification-delivery.dump
	[[ -s "$dump_file" ]] ||
		fail "Notification Delivery custom dump is empty."
	run_pg_restore \
		"$migration_password" \
		--list \
		/cutover/notification-delivery.dump >"$dump_list_file"
	grep -Eq \
		'TABLE DATA[[:space:]]+notification_delivery[[:space:]]+_prisma_migrations([[:space:]]|$)' \
		"$dump_list_file" ||
		fail "Notification Delivery dump does not include Prisma migration history."
	dump_sha256="$(sha256sum "$dump_file" | awk '{ print $1 }')"
	[[ "$dump_sha256" =~ ^[0-9a-f]{64}$ ]] ||
		fail "Notification Delivery dump checksum is invalid."

	grant_temporary_restore_boundary
	run_pg_restore \
		"$migration_password" \
		--no-owner \
		--no-privileges \
		--exit-on-error \
		--single-transaction \
		--dbname "$migration_target_libpq_url" \
		/cutover/notification-delivery.dump
	apply_strict_target_acls
	verify_target_acl_boundary
	run_pg_dump \
		"$migration_password" \
		"$migration_target_libpq_url" \
		--format=plain \
		--schema-only \
		--no-owner \
		--no-privileges \
		--schema "$TARGET_SCHEMA" \
		--file /cutover/target.schema.sql
	sed -E \
		-e '/^-- Dumped from database version /d' \
		-e '/^-- Dumped by pg_dump version /d' \
		-e '/^\\(un)?restrict /d' \
		"$source_schema_dump" >"$source_schema_manifest"
	sed -E \
		-e '/^-- Dumped from database version /d' \
		-e '/^-- Dumped by pg_dump version /d' \
		-e '/^\\(un)?restrict /d' \
		"$target_schema_dump" >"$target_schema_manifest"
	if ! cmp -s "$source_schema_manifest" "$target_schema_manifest"; then
		diff -u "$source_schema_manifest" "$target_schema_manifest" >&2 || true
		fail "Notification Delivery source and target schema definitions differ."
	fi
	source_schema_sha256="$(
		sha256sum "$source_schema_manifest" | awk '{ print $1 }'
	)"
	target_schema_sha256="$(
		sha256sum "$target_schema_manifest" | awk '{ print $1 }'
	)"
	[[ "$source_schema_sha256" =~ ^[0-9a-f]{64}$ &&
		"$target_schema_sha256" == "$source_schema_sha256" ]] ||
		fail "Notification Delivery schema checksum comparison failed."

	build_data_manifest \
		"$migration_target_libpq_url" \
		"$migration_password" \
		"$target_manifest"
	if ! cmp -s "$source_manifest" "$target_manifest"; then
		echo "Notification Delivery source and target manifests differ:" >&2
		diff -u "$source_manifest" "$target_manifest" >&2 || true
		fail "Notification Delivery row counts or deterministic checksums differ."
	fi
	source_manifest_sha256="$(
		sha256sum "$source_manifest" | awk '{ print $1 }'
	)"
	target_manifest_sha256="$(
		sha256sum "$target_manifest" | awk '{ print $1 }'
	)"
	[[ "$source_manifest_sha256" =~ ^[0-9a-f]{64}$ &&
		"$target_manifest_sha256" == "$source_manifest_sha256" ]] ||
		fail "Notification Delivery manifest checksum comparison failed."
	verify_source_database_quiescence
	verify_notification_queue_quiescence
	write_marker "prepared"
}

verify_worker() {
	local expected_database_url="$1"
	local expected_database="$2"
	local require_zero_restart="${3:-false}"
	local expected_libpq_url
	local attempt
	local container_id
	local health_status
	local response
	local restart_count
	local live_url
	local database_probe

	if [[ "$expected_database" == "$TARGET_DATABASE" ]]; then
		expected_libpq_url="$runtime_target_libpq_url"
	else
		expected_libpq_url="$runtime_source_libpq_url"
	fi

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(
			compose_target ps --status running -q notification-delivery-worker \
				2>/dev/null || true
		)"
		if [[ -n "$container_id" && "$container_id" != *$'\n'* ]]; then
			health_status="$(
				docker inspect \
					--format '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}missing{{ end }}' \
					"$container_id" 2>/dev/null || true
			)"
			live_url="$(
				container_env_value \
					"$container_id" \
					NOTIFICATION_DELIVERY_DATABASE_URL 2>/dev/null || true
			)"
			if [[ "$health_status" == "healthy" &&
				"$live_url" == "$expected_database_url" ]]; then
				response="$(
					curl -fs \
						--connect-timeout 2 \
						--max-time 5 \
						"http://127.0.0.1:$health_port/health/ready" \
						2>/dev/null || true
				)"
				restart_count="$(
					docker inspect --format '{{ .RestartCount }}' "$container_id"
				)"
				if [[ "$require_zero_restart" != "true" ||
					"$restart_count" == "0" ]] &&
					printf '%s' "$response" |
						grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' &&
					printf '%s' "$response" |
						grep -Eq "\"revision\"[[:space:]]*:[[:space:]]*\"$live_worker_revision\""; then
					database_probe="$(
						run_psql \
							"$runtime_password" \
							"$expected_libpq_url" \
							--quiet --tuples-only --no-align \
							--command "
								SELECT (
									current_database() = '$expected_database'
									AND current_user = '$runtime_user'
									AND has_schema_privilege(
										current_user,
										'$TARGET_SCHEMA',
										'USAGE'
									)
								);
							"
					)"
					[[ "$database_probe" == "t" ]] && return 0
				fi
			fi
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	return 1
}

verify_worker_queue_ownership() {
	local rabbitmq_container_id
	local queue_state
	local expected_queues
	local queue
	local queue_kind
	local queue_line
	local name
	local ready
	local unacknowledged
	local consumers

	rabbitmq_container_id="$(
		compose_target ps --status running -q rabbitmq 2>/dev/null || true
	)"
	[[ -n "$rabbitmq_container_id" &&
		"$rabbitmq_container_id" != *$'\n'* ]] || return 1
	queue_state="$(
		docker exec "$rabbitmq_container_id" \
			rabbitmqctl --silent list_queues \
				-p "$rabbitmq_vhost" \
				name messages_ready messages_unacknowledged consumers
	)" || return 1
	expected_queues="$(load_expected_queues)" || return 1
	while IFS=$'\t' read -r queue queue_kind; do
		[[ -n "$queue" && -n "$queue_kind" ]] || continue
		queue_line="$(
			awk -v queue="$queue" '$1 == queue { print; found += 1 } END { exit(found == 1 ? 0 : 1) }' \
				<<<"$queue_state"
		)" || return 1
		read -r name ready unacknowledged consumers <<<"$queue_line"
		[[ "$name" == "$queue" &&
			"$ready" =~ ^[0-9]+$ &&
			"$unacknowledged" =~ ^[0-9]+$ ]] || return 1
		if [[ "$queue_kind" == "retry" ]]; then
			[[ "$consumers" == "0" ]] || return 1
		else
			[[ "$consumers" == "1" ]] || return 1
		fi
	done <<<"$expected_queues"
}

force_recreate_worker_and_verify() {
	local expected_database_url="$1"
	local expected_database="$2"
	local failure_context="$3"
	local attempt

	compose_target up \
		-d \
		--no-deps \
		--no-build \
		--force-recreate \
		notification-delivery-worker

	if ! verify_worker "$expected_database_url" "$expected_database" true; then
		fail "$failure_context worker did not become healthy on the expected database."
	fi
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_worker_queue_ownership; then
			return
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			fail "$failure_context worker did not acquire exact RabbitMQ queue ownership."
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
}

verify_maintenance_backup_target() {
	local require_new_backup_evidence="${1:-true}"
	local container_id
	local health_status
	local live_backup_url
	local marker_updated_at
	local backup_evidence

	container_id="$(
		compose_target ps --status running -q maintenance-worker \
			2>/dev/null || true
	)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] ||
		fail "Exactly one running maintenance-worker is required to finalize cutover."
	health_status="$(
		docker inspect \
			--format '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}missing{{ end }}' \
			"$container_id" 2>/dev/null || true
	)"
	[[ "$health_status" == "healthy" ]] ||
		fail "Maintenance worker must be healthy before database cutover finalization."
	live_backup_url="$(
		container_env_value \
			"$container_id" \
			NOTIFICATION_DELIVERY_BACKUP_URL 2>/dev/null || true
	)"
	[[ "$live_backup_url" == "$backup_target_url" ]] ||
		fail "Maintenance worker does not use the target Notification Delivery backup URL."
	[[ "$require_new_backup_evidence" == "true" ]] || return

	marker_updated_at="$(marker_value updated_at)"
	backup_evidence="$(
		run_psql "$admin_password" "$admin_source_libpq_url" \
			--quiet --tuples-only --no-align --field-separator '|' \
			--command "
				SELECT
					EXISTS (
						SELECT 1
						FROM public.scheduled_job_runs
						WHERE job_type = 'DATABASE_BACKUP'
							AND status = 'SUCCEEDED'
							AND finished_at >= '$marker_updated_at'::timestamptz
							AND COALESCE(result->>'telegramSent', 'false') = 'true'
							AND result->>'target' = 'core'
							AND result->>'databaseName' = '$source_database'
							AND result->>'schema' = 'public'
							AND COALESCE((result->>'fileSize')::bigint, 0) > 0
							AND result->>'fileName' LIKE 'winwidget-db-%.dump'
					),
					EXISTS (
						SELECT 1
						FROM public.scheduled_job_runs
						WHERE job_type = 'NOTIFICATION_DELIVERY_DATABASE_BACKUP'
							AND status = 'SUCCEEDED'
							AND finished_at >= '$marker_updated_at'::timestamptz
							AND COALESCE(result->>'telegramSent', 'false') = 'true'
							AND result->>'target' = 'notification-delivery'
							AND result->>'databaseName' = '$TARGET_DATABASE'
							AND result->>'schema' = '$TARGET_SCHEMA'
							AND COALESCE((result->>'fileSize')::bigint, 0) > 0
							AND result->>'fileName'
								LIKE 'winwidget-notification-delivery-db-%.dump'
					);
			"
	)"
	[[ "$backup_evidence" == "t|t" ]] ||
		fail "Successful off-VPS core and Notification Delivery backups created after cutover are required before finalization."
}

requeue_known_outcome_route_quarantine_on_target() {
	local recovered_count

	recovered_count="$(
		run_psql "$migration_password" "$migration_target_libpq_url" \
			--quiet --tuples-only --no-align \
			--command "
				WITH recovered AS (
					UPDATE \"$TARGET_SCHEMA\".\"outbox_events\"
					SET
						\"status\" = 'PENDING',
						\"available_at\" = CURRENT_TIMESTAMP,
						\"locked_at\" = NULL,
						\"locked_by\" = NULL,
						\"lock_token\" = NULL,
						\"lease_expires_at\" = NULL,
						\"last_error\" = NULL,
						\"updated_at\" = CURRENT_TIMESTAMP
					WHERE \"status\" = 'FAILED'
						AND \"exchange\" = 'EVENTS'
						AND \"event_type\" = 'notification.delivery.outcome.v1'
						AND \"routing_key\" = 'notification.delivery.outcome.v1'
						AND \"last_error\" = 'INVALID_NOTIFICATION_DELIVERY_ROUTE'
						AND \"published_at\" IS NULL
					RETURNING 1
				)
				SELECT count(*) FROM recovered;
			"
	)"
	[[ "$recovered_count" =~ ^[0-9]+$ ]] ||
		fail "Could not safely recover the known Notification Delivery outcome route quarantine."
	if ((recovered_count > 0)); then
		echo "Recovered $recovered_count known notification.delivery.outcome.v1 Outbox quarantine row(s) on the target database."
	fi
}

start_target_worker() {
	requeue_known_outcome_route_quarantine_on_target
	revoke_source_database_access
	verify_frozen_source_snapshot
	write_marker "forward_only"
	forward_only=true
	update_notification_database_urls \
		"$runtime_target_url" \
		"$migration_target_url" \
		"$backup_target_url"
	force_recreate_worker_and_verify \
		"$runtime_target_url" \
		"$TARGET_DATABASE" \
		"Target Notification Delivery"

	echo "Notification Delivery database switched to $TARGET_DATABASE."
	echo "Run the full production deploy, create both verified backups, then rerun the database cutover target to remove the source schema and finalize."
	echo "The source $TARGET_SCHEMA schema is retained only until the verified finalization run."
}

recover_source_before_forward_boundary() {
	local recovery_status=0
	local attempt
	local ownership_recovered=false

	set +e
	restore_source_database_access
	recovery_status=$?
	if ((recovery_status == 0)); then
		update_notification_database_urls \
			"$runtime_source_url" \
			"$migration_source_url" \
			"$backup_source_url"
		recovery_status=$?
	fi
	if ((recovery_status == 0)); then
		compose_target up \
			-d \
			--no-deps \
			--no-build \
			--force-recreate \
			notification-delivery-worker
		recovery_status=$?
	fi
	if ((recovery_status == 0)); then
		verify_worker "$runtime_source_url" "$source_database"
		recovery_status=$?
	fi
	if ((recovery_status == 0)); then
		for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
			if verify_worker_queue_ownership; then
				ownership_recovered=true
				break
			fi
			sleep "$HEALTHCHECK_INTERVAL"
		done
		if [[ "$ownership_recovered" != "true" ]]; then
			recovery_status=1
		fi
	fi
	set -e

	if ((recovery_status == 0)); then
		echo "Source Notification Delivery worker was restored before the forward-only boundary." >&2
	else
		echo "CRITICAL: source Notification Delivery worker recovery failed." >&2
	fi
	return "$recovery_status"
}

handle_exit() {
	local status=$?

	trap - EXIT INT TERM
	if [[ "$source_cleanup_access_granted" == "true" ]]; then
		revoke_source_cleanup_access || true
	fi
	if [[ -n "$temporary_directory" && -d "$temporary_directory" ]]; then
		rm -rf -- "$temporary_directory"
	fi
	if ((status == 0)); then
		return
	fi
	if [[ "$worker_stop_started" != "true" ]]; then
		if [[ "$preparing_marker_created" == "true" ]]; then
			if validate_marker &&
				[[ "$(marker_value phase)" == "preparing" ]]; then
				rm -f -- "$MARKER_FILE"
			else
				echo "CRITICAL: newly created preparing marker changed unexpectedly and was retained." >&2
			fi
		fi
		exit "$status"
	fi
	if [[ "$forward_only" == "true" ||
		"$marker_phase" == "forward_only" ||
		"$marker_phase" == "complete" ]]; then
		echo "CRITICAL: cutover crossed the forward-only boundary; automatic source rollback is forbidden." >&2
		echo "Keep the target database URLs and rerun this script for forward recovery." >&2
		exit "$status"
	fi

	if [[ "$target_accepted" == "true" ]]; then
		dump_sha256="pending"
		source_schema_sha256="pending"
		source_manifest_sha256="pending"
		target_manifest_sha256="pending"
		write_marker "restoring" || true
	else
		rm -f -- "$MARKER_FILE"
	fi
	recover_source_before_forward_boundary || true
	exit "$status"
}

trap handle_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$EUID" != "0" ]]; then
	fail "Notification Delivery database cutover must run as root."
fi
if [[ "$FINALIZE_CUTOVER" != "true" && "$FINALIZE_CUTOVER" != "false" ]]; then
	fail "NOTIFICATION_DELIVERY_DATABASE_FINALIZE must be true or false."
fi
if [[ ! "$HEALTHCHECK_ATTEMPTS" =~ ^[1-9][0-9]*$ ||
	! "$HEALTHCHECK_INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
	fail "Healthcheck attempts and interval must be positive integers."
fi
[[ -d "$server_root/.git" ]] ||
	fail "Backend production checkout was not found."
[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]] ||
	fail "EXPECTED_REVISION with the approved production commit is required."
checkout_revision="$(git -C "$server_root" rev-parse HEAD)"
checkout_branch="$(git -C "$server_root" branch --show-current)"
checkout_dirty="$(
	git -C "$server_root" status --porcelain --untracked-files=all
)"
[[ "$checkout_revision" == "$EXPECTED_REVISION" &&
	"$checkout_branch" == "prod" &&
	-z "$checkout_dirty" ]] ||
	fail "Database cutover requires a clean protected prod checkout at EXPECTED_REVISION."
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
	fail "Backend production env file must be a regular non-symlink file."
[[ "$(stat -c '%a' "$ENV_FILE")" == "600" &&
	"$(stat -c '%u' "$ENV_FILE")" == "0" ]] ||
	fail "Backend production env file must be root-owned with mode 600."
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] ||
	fail "Backend production Compose file was not found."

exec 9>"$LOCK_FILE"
chown 0:0 "$LOCK_FILE"
chmod 600 "$LOCK_FILE"
flock -n 9 ||
	fail "Another Notification Delivery database cutover process is running."
cleanup_stale_cutover_directories

for key in \
	MODE \
	COMPOSE_PROJECT_NAME \
	DATABASE_MIGRATION_URL_PRODUCTION \
	NOTIFICATION_DELIVERY_DATABASE_URL \
	NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION \
	NOTIFICATION_DELIVERY_BACKUP_URL \
	NOTIFICATION_DELIVERY_POSTGRES_IMAGE \
	NOTIFICATION_DELIVERY_POSTGRES_PORT \
	NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME \
	NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER \
	NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE \
	NOTIFICATION_DELIVERY_HEALTH_PORT \
	RABBITMQ_VHOST; do
	require_env_key "$key"
done
[[ "$(get_env_value MODE)" == "production" ]] ||
	fail "Notification Delivery database cutover requires MODE=production."
[[ "$(get_env_value COMPOSE_PROJECT_NAME)" == "winwidget" ]] ||
	fail "Notification Delivery database cutover requires COMPOSE_PROJECT_NAME=winwidget."
health_port="$(get_env_value NOTIFICATION_DELIVERY_HEALTH_PORT)"
[[ "$health_port" == "4401" ]] ||
	fail "NOTIFICATION_DELIVERY_HEALTH_PORT must be 4401."
rabbitmq_vhost="$(get_env_value RABBITMQ_VHOST)"
[[ "$rabbitmq_vhost" == "winwidget" ]] ||
	fail "RABBITMQ_VHOST must be winwidget."
prepare_target_postgres_settings

api_container_id="$(resolve_project_container api false)"
node_tools_image="$(
	docker inspect --format '{{ .Image }}' "$api_container_id"
)"
[[ "$node_tools_image" =~ ^sha256:[0-9a-f]{64}$ ]] ||
	fail "The live API image for isolated Node parsing could not be resolved."
worker_container_id="$(
	resolve_project_container notification-delivery-worker true true
)"
if [[ -e "$MARKER_FILE" || -L "$MARKER_FILE" ]]; then
	[[ -f "$MARKER_FILE" && ! -L "$MARKER_FILE" ]] ||
		fail "Notification Delivery database cutover marker must be a regular non-symlink file."
	[[ "$(stat -c '%a' "$MARKER_FILE")" == "600" &&
		"$(stat -c '%u:%g' "$MARKER_FILE")" == "0:0" ]] ||
		fail "Notification Delivery database cutover marker permissions are invalid."
	marker_phase="$(marker_value phase)"
	marker_worker_image_id="$(marker_value worker_image_id)"
	marker_worker_revision="$(marker_value revision)"
	[[ "$marker_phase" =~ ^(preparing|restoring|prepared|forward_only|complete)$ &&
		"$marker_worker_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$marker_worker_revision" =~ ^[0-9a-f]{40}$ ]] ||
		fail "Notification Delivery database cutover marker worker identity is invalid."
fi
if [[ "$marker_phase" =~ ^(preparing|restoring|prepared)$ ]]; then
	[[ "$(
		docker image inspect \
			--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
			"$marker_worker_image_id" 2>/dev/null || true
	)" == "$marker_worker_revision" ]] ||
		fail "The immutable pre-forward worker image recorded by the cutover marker is unavailable."
	worker_image_id="$marker_worker_image_id"
	live_worker_revision="$marker_worker_revision"
elif [[ -n "$worker_container_id" ]]; then
	worker_image_id="$(
		docker inspect --format '{{ .Image }}' "$worker_container_id"
	)"
	live_worker_revision="$(
		docker image inspect \
			--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
			"$worker_image_id"
	)"
else
	[[ -n "$marker_worker_image_id" && -n "$marker_worker_revision" ]] ||
		fail "The Notification Delivery worker is missing and no approved recovery image is recorded."
	[[ "$(
		docker image inspect \
			--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
			"$marker_worker_image_id" 2>/dev/null || true
	)" == "$marker_worker_revision" ]] ||
		fail "The recorded Notification Delivery recovery image is unavailable."
	worker_image_id="$marker_worker_image_id"
	live_worker_revision="$marker_worker_revision"
fi
[[ "$worker_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
	"$live_worker_revision" =~ ^[0-9a-f]{40}$ ]] ||
	fail "The live or recorded Notification Delivery image identity is invalid."
[[ "$EXPECTED_WORKER_REVISION" =~ ^[0-9a-f]{40}$ &&
	"$live_worker_revision" == "$EXPECTED_WORKER_REVISION" ]] ||
	fail "The Notification Delivery worker revision differs from the approved cutover worker revision."
live_worker_image="$worker_image_id"

export COMPOSE_PROJECT_NAME=winwidget
export NOTIFICATION_DELIVERY_IMAGE="$live_worker_image"
export NOTIFICATION_DELIVERY_REVISION="$live_worker_revision"
export APP_REVISION="$live_worker_revision"
export APP_VERSION="git-$live_worker_revision"

parse_database_urls
[[ "$source_database" != "$TARGET_DATABASE" ]] ||
	fail "The source and target Notification Delivery databases must differ."
start_target_postgres
capture_source_database_identity

temporary_directory="$(
	mktemp -d "$APP_ROOT/deploy/backend/.notification-delivery-database-cutover.XXXXXX"
)"
chown 0:0 "$temporary_directory"
chmod 700 "$temporary_directory"

if [[ -f "$MARKER_FILE" || -L "$MARKER_FILE" ]]; then
	validate_marker ||
		fail "Notification Delivery database cutover marker is invalid."
	marker_phase="$(marker_value phase)"
	[[ "$(marker_value source_database)" == "$source_database" &&
		"$(marker_value target_database)" == "$TARGET_DATABASE" ]] ||
		fail "Notification Delivery database cutover marker targets an unexpected database."
	dump_sha256="$(marker_value dump_sha256)"
	source_schema_sha256="$(marker_value source_schema_sha256)"
	source_manifest_sha256="$(marker_value source_manifest_sha256)"
	target_manifest_sha256="$(marker_value target_manifest_sha256)"
	case "$marker_phase" in
		complete)
			if [[ "$runtime_current_location" == "source" ]]; then
				update_notification_database_urls \
					"$runtime_target_url" \
					"$migration_target_url" \
					"$backup_target_url"
				parse_database_urls
			fi
			assert_current_urls_are_consistent "$TARGET_DATABASE"
			forward_only=true
			worker_stop_started=true
			if ! verify_target_acl_boundary; then
				fail "Completed target database ACL verification failed."
			fi
			if ! verify_worker "$runtime_target_url" "$TARGET_DATABASE" true ||
				! verify_worker_queue_ownership; then
				force_recreate_worker_and_verify \
					"$runtime_target_url" \
					"$TARGET_DATABASE" \
					"Completed cutover recovery"
			fi
			verify_source_cleanup_complete ||
				fail "Completed cutover source schema or role isolation drifted."
			cutover_complete=true
			echo "Notification Delivery database cutover is already complete."
			exit 0
			;;
		forward_only)
			if [[ "$runtime_current_location" == "source" ]]; then
				update_notification_database_urls \
					"$runtime_target_url" \
					"$migration_target_url" \
					"$backup_target_url"
				parse_database_urls
			fi
			assert_current_urls_are_consistent "$TARGET_DATABASE"
			forward_only=true
			worker_stop_started=true
			if ! verify_target_acl_boundary; then
				fail "Forward-only target database ACL verification failed."
			fi
			if ! verify_worker "$runtime_target_url" "$TARGET_DATABASE" true ||
				! verify_worker_queue_ownership; then
				force_recreate_worker_and_verify \
					"$runtime_target_url" \
					"$TARGET_DATABASE" \
					"Forward-only recovery"
			fi
			revoke_source_database_access
			if [[ "$FINALIZE_CUTOVER" != "true" ]]; then
				echo "Notification Delivery database is active on $TARGET_DATABASE."
				echo "Run the full production deploy, create both verified backups, then rerun the database cutover target to remove the source schema and finalize."
				exit 0
			fi
			verify_maintenance_backup_target true
			drop_source_schema_and_disable_roles
			write_marker "complete"
			cutover_complete=true
			echo "Notification Delivery database cutover finalized; the source schema was removed and its dedicated source roles were disabled."
			exit 0
			;;
		preparing | restoring | prepared)
			if [[ "$marker_phase" == "preparing" ]]; then
				target_accepted=false
			else
				target_accepted=true
			fi
			assert_current_urls_are_consistent "$source_database"
			;;
	esac
else
	assert_current_urls_are_consistent "$source_database"
	new_cutover=true
fi

if [[ "$marker_phase" =~ ^(preparing|restoring|prepared)$ ]]; then
	restore_source_database_access ||
		fail "Source Notification Delivery database access could not be restored for pre-forward recovery."
fi

bootstrap_target_roles
verify_source_roles_and_schema
verify_source_access_revocation_capability
verify_postgres_compatibility_and_capacity

current_worker_url="$(
	container_env_value \
		"$worker_container_id" \
		NOTIFICATION_DELIVERY_DATABASE_URL 2>/dev/null || true
)"
configured_runtime_url="$(
	get_env_value NOTIFICATION_DELIVERY_DATABASE_URL
)"
if [[ "$current_worker_url" != "$configured_runtime_url" ]] ||
	! verify_worker "$configured_runtime_url" "$source_database" ||
	! verify_worker_queue_ownership; then
	echo "Recovering the source Notification Delivery worker before resuming the pre-forward cutover."
	force_recreate_worker_and_verify \
		"$configured_runtime_url" \
		"$source_database" \
		"Source pre-forward recovery"
	worker_container_id="$(
		resolve_project_container notification-delivery-worker false
	)"
	current_worker_url="$(
		container_env_value \
			"$worker_container_id" \
			NOTIFICATION_DELIVERY_DATABASE_URL 2>/dev/null || true
	)"
	[[ "$current_worker_url" == "$configured_runtime_url" ]] ||
		fail "Recovered Notification Delivery worker is not connected to the source database."
fi

if [[ "$new_cutover" == "true" ]]; then
	write_marker "preparing"
	preparing_marker_created=true
fi
worker_stop_started=true
compose_target stop \
	--timeout 30 \
	notification-delivery-worker
verify_notification_queue_quiescence
grant_source_audit_read_access
verify_source_database_quiescence
fence_source_service_access
verify_source_database_quiescence

if [[ "$marker_phase" == "prepared" ]]; then
	write_marker "restoring"
	target_accepted=true
fi
prepare_target_database
dump_and_restore_target
start_target_worker
