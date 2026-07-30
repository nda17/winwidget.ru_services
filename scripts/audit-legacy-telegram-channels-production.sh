#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
POSTGRES_IMAGE="postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296"
STATEMENT_TIMEOUT="60s"
LOCK_TIMEOUT="5s"

server_root="$APP_ROOT/winwidget.ru_server"
output_parent="$APP_ROOT/deploy/backend"
work_directory=""
final_directory=""
query_stderr_file=""
self_test=false
declare -a disconnect_logs=()

fail() {
	echo "$1" >&2
	exit 1
}

usage() {
	echo "Usage: $0 [--self-test] [--disconnect-log /absolute/path/to/nginx-access.log]..."
}

cleanup() {
	local exit_code="$?"
	if [[ "$exit_code" -ne 0 && -n "$work_directory" &&
		"$work_directory" == "$output_parent"/.campaigns-telegram-audit.tmp.* &&
		-d "$work_directory" && ! -L "$work_directory" ]]; then
		rm -rf -- "$work_directory"
	fi
	exit "$exit_code"
}
trap cleanup EXIT

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

require_env_key() {
	local key="$1"
	local value
	value="$(get_env_value "$key")" ||
		fail "Missing or duplicate protected env key: $key"
	[[ -n "$value" && "$value" != change_me* &&
		"$value" != XYZXYZXYZ* ]] ||
		fail "Protected env key is empty or a placeholder: $key"
}

validate_percent_encoding() {
	local value="$1"
	local remainder="$value"

	while [[ "$remainder" == *'%'* ]]; do
		remainder="${remainder#*%}"
		[[ "$remainder" =~ ^[0-9A-Fa-f]{2} ]] || return 1
		remainder="${remainder:2}"
	done
}

validate_ipv4_address() {
	local value="$1"
	local octet
	local -a octets=()

	[[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
	IFS='.' read -r -a octets <<<"$value"
	[[ "${#octets[@]}" == "4" ]] || return 1
	for octet in "${octets[@]}"; do
		[[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
		((10#$octet <= 255)) || return 1
	done
}

validate_backup_url() {
	local key="$1"
	local expected_schema="$2"
	local endpoint_policy="$3"
	local value="$4"
	local username password host port database query
	local pair parameter_name parameter_value
	local seen_parameters="|"
	local sslmode=""
	local -a parameters=()
	local schema_count=0
	local sslmode_count=0
	local is_loopback=false

	[[ "$value" != *$'\n'* && "$value" != *$'\r'* &&
		"$value" != *$'\t'* && "$value" != *'#'* ]] ||
		fail "$key contains a forbidden control character or URL fragment."
	case "$value" in
		*%0[aA]* | *%0[dD]* | *%09*)
			fail "$key contains a percent-encoded control character."
			;;
	esac
	validate_percent_encoding "$value" ||
		fail "$key contains invalid percent-encoding."
	[[ "$value" =~ ^postgres(ql)?://([^:/@?\#[:space:]]+):([^/@?\#[:space:]]+)@([^/:?\#[:space:]]+):([0-9]{1,5})/([^/?\#[:space:]]+)\?([^?\#[:space:]]+)$ ]] ||
		fail "$key must use explicit credentials and a supported PostgreSQL URL."
	username="${BASH_REMATCH[2]}"
	password="${BASH_REMATCH[3]}"
	host="${BASH_REMATCH[4]}"
	port="${BASH_REMATCH[5]}"
	database="${BASH_REMATCH[6]}"
	query="${BASH_REMATCH[7]}"
	[[ -n "$username" && -n "$password" && -n "$database" ]] ||
		fail "$key must use non-empty explicit credentials and database."
	((10#$port >= 1 && 10#$port <= 65535)) ||
		fail "$key contains an invalid PostgreSQL port."

	case "$host" in
		127.0.0.1 | [Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt])
			is_loopback=true
			;;
		*)
			case "$host" in
				[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]. | *.[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt] | 127.* | 0.0.0.0)
					fail "$key contains an unsupported loopback or wildcard host."
					;;
			esac
			if [[ "$host" == *.* && "$host" != *[A-Za-z-]* ]]; then
				validate_ipv4_address "$host" ||
					fail "$key contains an invalid IPv4 address."
			else
				[[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ &&
					"$host" != *..* &&
					"$host" != *.-* &&
					"$host" != *-.*
				]] ||
					fail "$key contains an invalid PostgreSQL hostname."
			fi
			;;
	esac

	IFS='&' read -r -a parameters <<<"$query"
	for pair in "${parameters[@]}"; do
		[[ -n "$pair" && "$pair" == *=* ]] ||
			fail "$key contains an empty or malformed query parameter."
		parameter_name="${pair%%=*}"
		parameter_value="${pair#*=}"
		[[ "$parameter_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
			-n "$parameter_value" ]] ||
			fail "$key contains an invalid query parameter."
		[[ "$seen_parameters" != *"|$parameter_name|"* ]] ||
			fail "$key contains a duplicate query parameter."
		seen_parameters+="$parameter_name|"
		case "$parameter_name" in
			schema)
				((schema_count += 1))
				[[ "$parameter_value" == "$expected_schema" ]] ||
					fail "$key must contain schema=$expected_schema."
				;;
			sslmode)
				((sslmode_count += 1))
				sslmode="$parameter_value"
				;;
			connection_limit | pool_timeout | pgbouncer) ;;
			*)
				fail "$key contains an unsupported query parameter."
				;;
		esac
	done
	[[ "$schema_count" == "1" ]] ||
		fail "$key must contain exactly one schema=$expected_schema parameter."
	[[ "$sslmode_count" == "1" ]] ||
		fail "$key must contain exactly one sslmode parameter."

	case "$endpoint_policy" in
		core)
			if [[ "$is_loopback" == "true" ]]; then
				[[ "$sslmode" == "disable" ]] ||
					fail "$key loopback endpoint must use sslmode=disable."
			else
				[[ "$sslmode" == "require" ||
					"$sslmode" == "verify-full" ]] ||
					fail "$key remote endpoint must require TLS."
			fi
			;;
		notification-delivery)
			[[ "$is_loopback" == "true" &&
				"$sslmode" == "disable" ]] ||
				fail "$key must use loopback with sslmode=disable."
			;;
		*)
			fail "Internal backup URL endpoint policy is invalid."
			;;
	esac
}

run_validator_self_test() {
	local valid_core_remote_hostname
	local valid_core_remote_ipv4
	local valid_core_loopback
	local valid_notification_loopback
	local invalid_url
	local docker_option script_source secret_assignment secret_name secret_prefix
	local valid_url
	local transformed_url

	script_source="$(<"${BASH_SOURCE[0]}")"
	for docker_option in -e --env; do
		for secret_name in PGURL AUDIT_SALT PGPASSWORD; do
			for secret_prefix in \
				"$docker_option $secret_name" \
				"$docker_option \"$secret_name" \
				"$docker_option '$secret_name"; do
				secret_assignment="${secret_prefix}="
				[[ "$script_source" != *"$secret_assignment"* ]] ||
					fail "Legacy Telegram audit passes $secret_name through Docker CLI argv."
			done
		done
	done

	valid_core_remote_hostname="postgresql://maintenance-backup:p%40ss@direct-prod-host:5432/winwidget?schema=public&sslmode=require"
	valid_core_remote_ipv4="postgresql://maintenance-backup:password@203.0.113.10:5432/winwidget?schema=public&sslmode=verify-full"
	valid_core_loopback="postgresql://core-backup:password@127.0.0.1:55431/winwidget?schema=public&sslmode=disable"
	valid_notification_loopback="postgresql://notification-backup:password@127.0.0.1:55432/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable"

	for valid_url in \
		"$valid_core_remote_hostname" \
		"$valid_core_remote_ipv4" \
		"$valid_core_loopback"; do
		if ! (
			validate_backup_url \
				DATABASE_BACKUP_URL public core "$valid_url"
		) >/dev/null 2>&1; then
			fail "Backup URL validator self-test rejected a valid Core fixture."
		fi
	done
	if ! (
		validate_backup_url \
			NOTIFICATION_DELIVERY_BACKUP_URL notification_delivery \
			notification-delivery "$valid_notification_loopback"
	) >/dev/null 2>&1; then
		fail "Backup URL validator self-test rejected the valid Notification Delivery fixture."
	fi
	transformed_url="$(to_libpq_url "$valid_core_remote_hostname")"
	[[ "$transformed_url" == "postgresql://maintenance-backup:p%40ss@direct-prod-host:5432/winwidget?sslmode=require" ]] ||
		fail "Backup URL validator self-test did not preserve Core TLS settings."
	transformed_url="$(to_libpq_url "$valid_notification_loopback")"
	[[ "$transformed_url" == "postgresql://notification-backup:password@127.0.0.1:55432/winwidget_notification_delivery?sslmode=disable" ]] ||
		fail "Backup URL validator self-test did not preserve Notification Delivery SSL settings."

	for invalid_url in \
		"postgresql://backup:password@db.example:5432/winwidget?schema=public&sslmode=disable" \
		"postgresql://backup:password@db.example:5432/winwidget?schema=public&sslmode=prefer" \
		"postgresql://backup:password@db.example:5432/winwidget?schema=public&sslmode=allow" \
		"postgresql://backup:password@127.0.0.1:5432/winwidget?schema=public&sslmode=require" \
		"postgresql://backup:password@db.example:5432/winwidget?schema=public" \
		"postgresql://backup:password@db.example:5432/winwidget?schema=public&sslmode=require&sslmode=require" \
		"postgresql://backup:password@db.example:5432/winwidget?schema=public&sslmode=require&host=127.0.0.1" \
		"postgresql://backup:p%4Zss@db.example:5432/winwidget?schema=public&sslmode=require" \
		"postgresql://backup:password@[2001:db8::1]:5432/winwidget?schema=public&sslmode=require"; do
		if (
			validate_backup_url \
				DATABASE_BACKUP_URL public core "$invalid_url"
		) >/dev/null 2>&1; then
			fail "Backup URL validator self-test accepted an unsafe Core fixture."
		fi
	done

	for invalid_url in \
		"postgresql://notification-backup:password@db.example:55432/winwidget_notification_delivery?schema=notification_delivery&sslmode=require" \
		"postgresql://notification-backup:password@127.0.0.1:55432/winwidget_notification_delivery?schema=notification_delivery&sslmode=require" \
		"postgresql://notification-backup:password@127.0.0.1:55432/winwidget_notification_delivery?schema=public&sslmode=disable" \
		"postgresql://notification-backup@127.0.0.1:55432/winwidget_notification_delivery?schema=notification_delivery&sslmode=disable"; do
		if (
			validate_backup_url \
				NOTIFICATION_DELIVERY_BACKUP_URL notification_delivery \
				notification-delivery "$invalid_url"
		) >/dev/null 2>&1; then
			fail "Backup URL validator self-test accepted an unsafe Notification Delivery fixture."
		fi
	done

	echo "Legacy Telegram backup URL validator self-test passed."
}

to_libpq_url() {
	local value="$1"
	local base query pair parameter_name
	local -a parameters=()
	local -a retained_parameters=()

	if [[ "$value" != *'?'* ]]; then
		printf '%s' "$value"
		return
	fi
	base="${value%%\?*}"
	query="${value#*\?}"
	IFS='&' read -r -a parameters <<<"$query"
	for pair in "${parameters[@]}"; do
		parameter_name="${pair%%=*}"
		case "$parameter_name" in
			schema | connection_limit | pool_timeout | pgbouncer) ;;
			*) retained_parameters+=("$pair") ;;
		esac
	done
	printf '%s' "$base"
	if ((${#retained_parameters[@]} > 0)); then
		local joined
		joined="$(IFS='&'; printf '%s' "${retained_parameters[*]}")"
		printf '?%s' "$joined"
	fi
}

validate_disconnect_log() {
	local path="$1"
	local mode owner gzip_magic
	[[ "$path" == /* && -f "$path" && ! -L "$path" ]] ||
		fail "Each disconnect log must be an absolute regular non-symlink file."
	mode="$(stat -c '%a' "$path" 2>/dev/null || true)"
	owner="$(stat -c '%u' "$path" 2>/dev/null || true)"
	[[ "$mode" =~ ^[0-7]{3,4}$ && "$owner" == "0" ]] ||
		fail "Each disconnect log must be root-owned with a valid Unix mode."
	(( (8#$mode & 0022) == 0 )) ||
		fail "Disconnect logs writable by group or others are forbidden."
	gzip_magic="$(
		od -An -N2 -tx1 "$path" 2>/dev/null |
			tr -d '[:space:]'
	)"
	[[ "$gzip_magic" != "1f8b" ]] ||
		fail "Compressed logs are not accepted; provide a protected decompressed copy."
}

run_psql_query() {
	local label="$1"
	local url="$2"
	local salt="$3"
	local sql="$4"
	local output_file="$5"
	local query_status
	local AUDIT_SALT PGURL

	: >"$query_stderr_file"
	AUDIT_SALT="$salt"
	PGURL="$url"
	export AUDIT_SALT PGURL
	if printf '%s\n' "$sql" |
		docker run --rm -i --network host \
			-e PGURL \
			-e AUDIT_SALT \
			"$POSTGRES_IMAGE" \
			sh -euc '
				psql --no-psqlrc --quiet --tuples-only --no-align \
					--field-separator="|" --set ON_ERROR_STOP=1 \
					--set audit_salt="$AUDIT_SALT" "$PGURL" --file=-
			' >"$output_file" 2>"$query_stderr_file"; then
		query_status=0
	else
		query_status="$?"
	fi
	unset AUDIT_SALT PGURL
	if [[ "$query_status" != "0" ]]; then
		: >"$query_stderr_file"
		fail "$label read-only audit query failed; database diagnostics were suppressed."
	fi
	: >"$query_stderr_file"
}

write_context() {
	local target="$1"
	local created_at="$2"
	local revision="$3"
	local marker_phase="$4"
	local salt_commitment="$5"
	local log_count="$6"
	{
		printf 'audit_version=1\n'
		printf 'created_at_utc=%s\n' "$created_at"
		printf 'revision=%s\n' "$revision"
		printf 'campaigns_cutover_phase=%s\n' "$marker_phase"
		printf 'core_source=DATABASE_BACKUP_URL\n'
		printf 'notification_delivery_source=NOTIFICATION_DELIVERY_BACKUP_URL\n'
		printf 'transaction_mode=READ ONLY\n'
		printf 'statement_timeout=%s\n' "$STATEMENT_TIMEOUT"
		printf 'lock_timeout=%s\n' "$LOCK_TIMEOUT"
		printf 'fingerprint_algorithm=SHA-256(random-256-bit-salt || colon || telegram-chat-id)\n'
		printf 'fingerprint_salt_persisted=false\n'
		printf 'fingerprint_salt_commitment=%s\n' "$salt_commitment"
		printf 'disconnect_log_source_count=%s\n' "$log_count"
		printf 'disconnect_log_identity_correlation=false\n'
		printf 'database_mutation_performed=false\n'
		printf 'telegram_reactivation_performed=false\n'
	} >"$target"
}

while (($# > 0)); do
	case "$1" in
		--self-test)
			[[ "$self_test" == "false" ]] ||
				fail "--self-test may be specified only once."
			self_test=true
			shift
			;;
		--disconnect-log)
			(($# >= 2)) || fail "--disconnect-log requires an absolute path."
			disconnect_logs+=("$2")
			shift 2
			;;
		--help | -h)
			usage
			exit 0
			;;
		*)
			usage >&2
			fail "Unknown argument: $1"
			;;
	esac
done

if [[ "$self_test" == "true" ]]; then
	((${#disconnect_logs[@]} == 0)) ||
		fail "--self-test cannot be combined with --disconnect-log."
	run_validator_self_test
	exit 0
fi

[[ "$(id -u)" == "0" ]] ||
	fail "Legacy Telegram production audit must run as root."
[[ "$(uname -s)" == "Linux" ]] ||
	fail "Legacy Telegram production audit must run on the Linux production host."
[[ "$APP_ROOT" == "/opt/winwidget" &&
	"$ENV_FILE" == "/opt/winwidget/deploy/backend/.env.production" ]] ||
	fail "Legacy Telegram production audit only accepts the canonical production paths."
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
	"$(stat -c '%a' "$ENV_FILE")" == "600" &&
	"$(stat -c '%u:%g' "$ENV_FILE")" == "0:0" ]] ||
	fail "Production env must be a root-owned mode-600 regular file."
[[ -d "$output_parent" && ! -L "$output_parent" &&
	"$(stat -c '%u' "$output_parent")" == "0" ]] ||
	fail "Production artifact parent must be a root-owned non-symlink directory."
output_parent_mode="$(stat -c '%a' "$output_parent")"
[[ "$output_parent_mode" =~ ^[0-7]{3,4}$ ]] ||
	fail "Production artifact parent has an invalid Unix mode."
(( (8#$output_parent_mode & 0022) == 0 )) ||
	fail "Production artifact parent must not be writable by group or others."

[[ -d "$server_root/.git" &&
	-f "$server_root/scripts/production-deploy-lock.sh" &&
	-f "$server_root/scripts/campaigns-database-lifecycle.sh" ]] ||
	fail "Protected backend checkout is incomplete."
current_revision="$(git -C "$server_root" rev-parse HEAD)"
[[ -z "$EXPECTED_REVISION" ]] && EXPECTED_REVISION="$current_revision"
[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ &&
	"$current_revision" == "$EXPECTED_REVISION" &&
	"$(git -C "$server_root" branch --show-current)" == "prod" &&
	-z "$(git -C "$server_root" status --porcelain --untracked-files=all)" ]] ||
	fail "Audit requires a clean protected prod checkout at EXPECTED_REVISION."

PRODUCTION_DEPLOY_LOCK_FILE="$output_parent/.production-deploy.lock"
export PRODUCTION_DEPLOY_LOCK_FILE
# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
acquire_production_deploy_lock "legacy Telegram channel audit"

CAMPAIGNS_DATABASE_CUTOVER_MARKER="$output_parent/.campaigns-database-cutover-v1"
export CAMPAIGNS_DATABASE_CUTOVER_MARKER
# shellcheck source=scripts/campaigns-database-lifecycle.sh
source "$server_root/scripts/campaigns-database-lifecycle.sh"
validate_campaigns_database_cutover_marker ||
	fail "Campaigns cutover marker is missing or unsafe."
marker_phase="$(campaigns_database_marker_value phase)"
marker_revision="$(campaigns_database_marker_value revision)"
source_schema_state="$(campaigns_database_marker_value source_schema_state)"
switch_generation="$(campaigns_database_marker_value switch_generation)"
[[ "$marker_phase" == "switched" ]] ||
	fail "Telegram audit must run after prepare and before finalize starts."
[[ "$marker_revision" == "$EXPECTED_REVISION" &&
	"$source_schema_state" == "retained" &&
	"$switch_generation" =~ ^[1-9][0-9]*$ ]] ||
	fail "Campaigns marker revision or retained-source state does not match the audit."

for key in DATABASE_BACKUP_URL NOTIFICATION_DELIVERY_BACKUP_URL; do
	require_env_key "$key"
done
core_backup_url="$(get_env_value DATABASE_BACKUP_URL)"
notification_backup_url="$(get_env_value NOTIFICATION_DELIVERY_BACKUP_URL)"
validate_backup_url DATABASE_BACKUP_URL public core "$core_backup_url"
validate_backup_url NOTIFICATION_DELIVERY_BACKUP_URL \
	notification_delivery \
	notification-delivery "$notification_backup_url"
core_backup_url="$(to_libpq_url "$core_backup_url")"
notification_backup_url="$(to_libpq_url "$notification_backup_url")"

docker_endpoint="$(
	docker context inspect "$(docker context show)" \
		--format '{{.Endpoints.docker.Host}}' 2>/dev/null || true
)"
[[ "$docker_endpoint" == unix://* ]] ||
	fail "Audit refuses a remote Docker endpoint."
docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1 ||
	fail "Reviewed PostgreSQL 18 audit image is not available locally."

for disconnect_log in "${disconnect_logs[@]}"; do
	validate_disconnect_log "$disconnect_log"
done
for ((index = 0; index < ${#disconnect_logs[@]}; index++)); do
	for ((other_index = index + 1; other_index < ${#disconnect_logs[@]}; other_index++)); do
		[[ "${disconnect_logs[$index]}" != "${disconnect_logs[$other_index]}" ]] ||
			fail "Duplicate disconnect log paths are forbidden."
	done
done

created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
artifact_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
random_suffix="$(
	od -An -N6 -tx1 /dev/urandom |
		tr -d '[:space:]'
)"
[[ "$random_suffix" =~ ^[0-9a-f]{12}$ ]] ||
	fail "Could not create the audit artifact suffix."
artifact_name="campaigns-telegram-audit.${artifact_timestamp}.${EXPECTED_REVISION:0:12}.${random_suffix}"
[[ "$artifact_name" =~ ^campaigns-telegram-audit\.[0-9]{8}T[0-9]{6}Z\.[0-9a-f]{12}\.[0-9a-f]{12}$ ]] ||
	fail "Generated audit artifact name is invalid."
final_directory="$output_parent/$artifact_name"
[[ ! -e "$final_directory" && ! -L "$final_directory" ]] ||
	fail "Audit artifact directory already exists."
work_directory="$(mktemp -d "$output_parent/.campaigns-telegram-audit.tmp.XXXXXXXXXXXX")"
[[ "$work_directory" == "$output_parent"/.campaigns-telegram-audit.tmp.* &&
	-d "$work_directory" && ! -L "$work_directory" ]] ||
	fail "Could not create a safe temporary audit directory."
chmod 700 "$work_directory"
chown 0:0 "$work_directory"
query_stderr_file="$work_directory/.query-stderr"
: >"$query_stderr_file"

fingerprint_salt="$(
	od -An -N32 -tx1 /dev/urandom |
		tr -d '[:space:]'
)"
[[ "$fingerprint_salt" =~ ^[0-9a-f]{64}$ ]] ||
	fail "Could not create the audit fingerprint salt."
fingerprint_salt_commitment="$(
	printf '%s' "$fingerprint_salt" |
		sha256sum |
		awk '{ print $1 }'
)"

CORE_PREFLIGHT_SQL=""
IFS= read -r -d '' CORE_PREFLIGHT_SQL <<SQL || true
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '$STATEMENT_TIMEOUT';
SET LOCAL lock_timeout = '$LOCK_TIMEOUT';
SET LOCAL idle_in_transaction_session_timeout = '65s';
SELECT CASE
	WHEN current_setting('transaction_read_only') = 'on'
		AND NOT r.rolsuper
		AND NOT r.rolcreaterole
		AND NOT r.rolcreatedb
		AND NOT r.rolreplication
		AND NOT r.rolbypassrls
		AND NOT has_database_privilege(
			current_user,
			current_database(),
			'CREATE'
		)
		AND has_schema_privilege(current_user, 'public', 'USAGE')
		AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
		AND to_regclass('public.integration_delivery_failures') IS NOT NULL
		AND to_regclass('public.mailing_deliveries') IS NOT NULL
		AND to_regclass('public.telegram_notification_channels') IS NOT NULL
		AND has_table_privilege(current_user, 'public.integration_delivery_failures', 'SELECT')
		AND has_table_privilege(current_user, 'public.mailing_deliveries', 'SELECT')
		AND has_table_privilege(current_user, 'public.telegram_notification_channels', 'SELECT')
		AND NOT has_table_privilege(current_user, 'public.integration_delivery_failures', 'INSERT')
		AND NOT has_table_privilege(current_user, 'public.integration_delivery_failures', 'UPDATE')
		AND NOT has_table_privilege(current_user, 'public.integration_delivery_failures', 'DELETE')
		AND NOT has_table_privilege(current_user, 'public.mailing_deliveries', 'INSERT')
		AND NOT has_table_privilege(current_user, 'public.mailing_deliveries', 'UPDATE')
		AND NOT has_table_privilege(current_user, 'public.mailing_deliveries', 'DELETE')
		AND NOT has_table_privilege(current_user, 'public.telegram_notification_channels', 'INSERT')
		AND NOT has_table_privilege(current_user, 'public.telegram_notification_channels', 'UPDATE')
		AND NOT has_table_privilege(current_user, 'public.telegram_notification_channels', 'DELETE')
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS audited_table
			JOIN pg_catalog.pg_namespace AS audited_schema
				ON audited_schema.oid = audited_table.relnamespace
			WHERE audited_schema.nspname = 'public'
				AND audited_table.relkind IN ('r', 'p')
				AND (
					has_table_privilege(
						current_user,
						audited_table.oid,
						'INSERT'
					)
					OR has_table_privilege(
						current_user,
						audited_table.oid,
						'UPDATE'
					)
					OR has_table_privilege(
						current_user,
						audited_table.oid,
						'DELETE'
					)
					OR has_table_privilege(
						current_user,
						audited_table.oid,
						'TRUNCATE'
					)
					OR has_table_privilege(
						current_user,
						audited_table.oid,
						'REFERENCES'
					)
					OR has_table_privilege(
						current_user,
						audited_table.oid,
						'TRIGGER'
					)
				)
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS audited_sequence
			JOIN pg_catalog.pg_namespace AS audited_schema
				ON audited_schema.oid = audited_sequence.relnamespace
			WHERE audited_schema.nspname = 'public'
				AND audited_sequence.relkind = 'S'
				AND (
					has_sequence_privilege(
						current_user,
						audited_sequence.oid,
						'USAGE'
					)
					OR has_sequence_privilege(
						current_user,
						audited_sequence.oid,
						'UPDATE'
					)
				)
		)
	THEN 'ok'
	ELSE 'invalid'
END
FROM pg_catalog.pg_roles AS r
WHERE r.rolname = current_user;
ROLLBACK;
SQL

NOTIFICATION_PREFLIGHT_SQL=""
IFS= read -r -d '' NOTIFICATION_PREFLIGHT_SQL <<SQL || true
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '$STATEMENT_TIMEOUT';
SET LOCAL lock_timeout = '$LOCK_TIMEOUT';
SET LOCAL idle_in_transaction_session_timeout = '65s';
SELECT CASE
	WHEN current_setting('transaction_read_only') = 'on'
		AND NOT r.rolsuper
		AND NOT r.rolcreaterole
		AND NOT r.rolcreatedb
		AND NOT r.rolreplication
		AND NOT r.rolbypassrls
		AND NOT has_database_privilege(
			current_user,
			current_database(),
			'CREATE'
		)
		AND has_schema_privilege(
			current_user,
			'notification_delivery',
			'USAGE'
		)
		AND NOT has_schema_privilege(
			current_user,
			'notification_delivery',
			'CREATE'
		)
		AND to_regclass('notification_delivery.delivery_failures') IS NOT NULL
		AND has_table_privilege(
			current_user,
			'notification_delivery.delivery_failures',
			'SELECT'
		)
		AND NOT has_table_privilege(
			current_user,
			'notification_delivery.delivery_failures',
			'INSERT'
		)
		AND NOT has_table_privilege(
			current_user,
			'notification_delivery.delivery_failures',
			'UPDATE'
		)
		AND NOT has_table_privilege(
			current_user,
			'notification_delivery.delivery_failures',
			'DELETE'
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS audited_table
			JOIN pg_catalog.pg_namespace AS audited_schema
				ON audited_schema.oid = audited_table.relnamespace
			WHERE audited_schema.nspname = 'notification_delivery'
				AND audited_table.relkind IN ('r', 'p')
				AND (
					has_table_privilege(
						current_user,
						audited_table.oid,
						'INSERT'
					)
					OR has_table_privilege(
						current_user,
						audited_table.oid,
						'UPDATE'
					)
					OR has_table_privilege(
						current_user,
						audited_table.oid,
						'DELETE'
					)
					OR has_table_privilege(
						current_user,
						audited_table.oid,
						'TRUNCATE'
					)
					OR has_table_privilege(
						current_user,
						audited_table.oid,
						'REFERENCES'
					)
					OR has_table_privilege(
						current_user,
						audited_table.oid,
						'TRIGGER'
					)
				)
		)
		AND NOT EXISTS (
			SELECT 1
			FROM pg_catalog.pg_class AS audited_sequence
			JOIN pg_catalog.pg_namespace AS audited_schema
				ON audited_schema.oid = audited_sequence.relnamespace
			WHERE audited_schema.nspname = 'notification_delivery'
				AND audited_sequence.relkind = 'S'
				AND (
					has_sequence_privilege(
						current_user,
						audited_sequence.oid,
						'USAGE'
					)
					OR has_sequence_privilege(
						current_user,
						audited_sequence.oid,
						'UPDATE'
					)
				)
		)
	THEN 'ok'
	ELSE 'invalid'
END
FROM pg_catalog.pg_roles AS r
WHERE r.rolname = current_user;
ROLLBACK;
SQL

run_psql_query core "$core_backup_url" "$fingerprint_salt" \
	"$CORE_PREFLIGHT_SQL" "$work_directory/.core-preflight"
[[ "$(tr -d '[:space:]' <"$work_directory/.core-preflight")" == "ok" ]] ||
	fail "DATABASE_BACKUP_URL is not a non-privileged read-only audit role."
run_psql_query notification-delivery "$notification_backup_url" \
	"$fingerprint_salt" "$NOTIFICATION_PREFLIGHT_SQL" \
	"$work_directory/.notification-preflight"
[[ "$(tr -d '[:space:]' <"$work_directory/.notification-preflight")" == "ok" ]] ||
	fail "NOTIFICATION_DELIVERY_BACKUP_URL is not a non-privileged read-only audit role."

CORE_STATS_SQL=""
IFS= read -r -d '' CORE_STATS_SQL <<SQL || true
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '$STATEMENT_TIMEOUT';
SET LOCAL lock_timeout = '$LOCK_TIMEOUT';
SET LOCAL idle_in_transaction_session_timeout = '65s';
WITH legacy_failures AS MATERIALIZED (
	SELECT f.id, f.payload
	FROM public.integration_delivery_failures AS f
	WHERE f.integration = 'mailing-telegram'
		AND lower(f.last_error) LIKE '%unsupported parse_mode%'
),
matched AS (
	SELECT
		f.id AS failure_id,
		d.id AS delivery_id,
		c.id AS channel_id,
		c.is_active,
		c.disabled_at
	FROM legacy_failures AS f
	LEFT JOIN public.mailing_deliveries AS d
		ON d.id::text = f.payload ->> 'deliveryId'
		AND d.campaign_id::text = f.payload ->> 'campaignId'
		AND d.channel::text = 'TELEGRAM'
	LEFT JOIN public.telegram_notification_channels AS c
		ON c.chat_id = d.recipient
)
SELECT
	count(*) || '|' ||
	count(delivery_id) || '|' ||
	count(channel_id) || '|' ||
	count(*) FILTER (WHERE channel_id IS NOT NULL AND is_active) || '|' ||
	count(*) FILTER (
		WHERE channel_id IS NOT NULL
			AND NOT is_active
			AND disabled_at IS NOT NULL
	)
FROM matched;
ROLLBACK;
SQL

CORE_CANDIDATES_SQL=""
IFS= read -r -d '' CORE_CANDIDATES_SQL <<SQL || true
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '$STATEMENT_TIMEOUT';
SET LOCAL lock_timeout = '$LOCK_TIMEOUT';
SET LOCAL idle_in_transaction_session_timeout = '65s';
COPY (
	SELECT
		c.id AS channel_id,
		encode(
			sha256(
				convert_to(
					:'audit_salt' || ':' || c.chat_id,
					'UTF8'
				)
			),
			'hex'
		) AS destination_fingerprint,
		f.id AS failure_id,
		f.event_id,
		d.campaign_id,
		d.id AS delivery_id,
		to_char(
			c.disabled_at AT TIME ZONE 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
		) AS disabled_at_utc,
		to_char(
			coalesce(f.first_failed_at, f.failed_at) AT TIME ZONE 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
		) AS first_failed_at_utc,
		to_char(
			f.failed_at AT TIME ZONE 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
		) AS failed_at_utc,
		floor(extract(epoch FROM (f.failed_at - c.disabled_at)))::bigint
			AS disabled_to_failure_seconds,
		CASE
			WHEN c.disabled_at BETWEEN
				coalesce(f.first_failed_at, f.failed_at) - interval '5 minutes'
				AND f.failed_at + interval '1 minute'
			THEN 'timing_consistent'
			WHEN c.disabled_at < coalesce(f.first_failed_at, f.failed_at)
			THEN 'disabled_earlier'
			ELSE 'disabled_later'
		END AS timing_relation
	FROM public.integration_delivery_failures AS f
	JOIN public.mailing_deliveries AS d
		ON d.id::text = f.payload ->> 'deliveryId'
		AND d.campaign_id::text = f.payload ->> 'campaignId'
		AND d.channel::text = 'TELEGRAM'
	JOIN public.telegram_notification_channels AS c
		ON c.chat_id = d.recipient
	WHERE f.integration = 'mailing-telegram'
		AND lower(f.last_error) LIKE '%unsupported parse_mode%'
		AND NOT c.is_active
		AND c.disabled_at IS NOT NULL
	ORDER BY destination_fingerprint, f.failed_at, f.id
) TO STDOUT WITH (FORMAT csv, HEADER true);
ROLLBACK;
SQL

NOTIFICATION_PERMANENT_SQL=""
IFS= read -r -d '' NOTIFICATION_PERMANENT_SQL <<SQL || true
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '$STATEMENT_TIMEOUT';
SET LOCAL lock_timeout = '$LOCK_TIMEOUT';
SET LOCAL idle_in_transaction_session_timeout = '65s';
COPY (
	SELECT
		encode(
			sha256(
				convert_to(
					:'audit_salt' || ':' || destination.telegram_chat_id,
					'UTF8'
				)
			),
			'hex'
		) AS destination_fingerprint,
		f.event_id,
		CASE f.consumer
			WHEN 'telegram' THEN 'telegram'
			WHEN 'limit-telegram' THEN 'limit-telegram'
			WHEN 'payment-telegram' THEN 'payment-telegram'
			WHEN 'campaign-telegram' THEN 'campaign-telegram'
			WHEN 'daily-summary-delivery-telegram'
				THEN 'daily-summary-delivery-telegram'
			WHEN 'subscription-expiry-telegram'
				THEN 'subscription-expiry-telegram'
		END AS consumer,
		to_char(
			f.failed_at AT TIME ZONE 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
		) AS failed_at_utc,
		CASE
			WHEN f.normalized_code = 'TELEGRAM_CHAT_NOT_FOUND'
				THEN 'TELEGRAM_CHAT_NOT_FOUND'
			WHEN f.normalized_code = 'TELEGRAM_USER_DEACTIVATED'
				THEN 'TELEGRAM_USER_DEACTIVATED'
			WHEN f.normalized_code = 'TELEGRAM_BOT_BLOCKED'
				THEN 'TELEGRAM_BOT_BLOCKED'
			WHEN f.normalized_code = 'TELEGRAM_BOT_KICKED'
				THEN 'TELEGRAM_BOT_KICKED'
			ELSE 'HTTP_403_PERMANENT'
		END AS permanent_signal,
		CASE
			WHEN f.resolved_at IS NULL THEN 'unresolved'
			ELSE 'closed_no_retry'
		END AS resolution_state
	FROM notification_delivery.delivery_failures AS f
	CROSS JOIN LATERAL (
		SELECT nullif(
			btrim(f.payload #>> '{destination,telegramChatId}'),
			''
		) AS telegram_chat_id
	) AS destination
	WHERE destination.telegram_chat_id IS NOT NULL
		AND f.consumer IN (
			'telegram',
			'limit-telegram',
			'payment-telegram',
			'campaign-telegram',
			'daily-summary-delivery-telegram',
			'subscription-expiry-telegram'
		)
		AND f.category::text = 'PERMANENT'
		AND NOT f.retryable
		AND (
			f.normalized_code IN (
				'TELEGRAM_CHAT_NOT_FOUND',
				'TELEGRAM_USER_DEACTIVATED',
				'TELEGRAM_BOT_BLOCKED',
				'TELEGRAM_BOT_KICKED'
			)
			OR f.http_status = 403
		)
		AND (
			f.resolved_at IS NULL
			OR f.resolution::text = 'CLOSED_NO_RETRY'
		)
	ORDER BY destination_fingerprint, f.failed_at, f.event_id
) TO STDOUT WITH (FORMAT csv, HEADER true);
ROLLBACK;
SQL

run_psql_query core "$core_backup_url" "$fingerprint_salt" \
	"$CORE_STATS_SQL" "$work_directory/.core-stats"
run_psql_query core "$core_backup_url" "$fingerprint_salt" \
	"$CORE_CANDIDATES_SQL" "$work_directory/20-core-candidates.csv"
run_psql_query notification-delivery "$notification_backup_url" \
	"$fingerprint_salt" "$NOTIFICATION_PERMANENT_SQL" \
	"$work_directory/.notification-permanent-all.csv"

core_stats="$(tr -d '\r\n' <"$work_directory/.core-stats")"
IFS='|' read -r unsupported_failure_count matched_delivery_count \
	matched_channel_count active_channel_failure_count \
	inactive_candidate_failure_count <<<"$core_stats"
for count in \
	"$unsupported_failure_count" "$matched_delivery_count" \
	"$matched_channel_count" "$active_channel_failure_count" \
	"$inactive_candidate_failure_count"; do
	[[ "$count" =~ ^[0-9]+$ ]] ||
		fail "Core audit returned invalid aggregate evidence."
done
[[ "$matched_delivery_count" -le "$unsupported_failure_count" &&
	"$matched_channel_count" -le "$matched_delivery_count" &&
	"$active_channel_failure_count" -le "$matched_channel_count" &&
	"$inactive_candidate_failure_count" -le "$matched_channel_count" ]] ||
	fail "Core audit aggregate evidence is inconsistent."

expected_core_header="channel_id,destination_fingerprint,failure_id,event_id,campaign_id,delivery_id,disabled_at_utc,first_failed_at_utc,failed_at_utc,disabled_to_failure_seconds,timing_relation"
expected_notification_header="destination_fingerprint,event_id,consumer,failed_at_utc,permanent_signal,resolution_state"
[[ "$(sed -n '1p' "$work_directory/20-core-candidates.csv")" == "$expected_core_header" &&
	"$(sed -n '1p' "$work_directory/.notification-permanent-all.csv")" == "$expected_notification_header" ]] ||
	fail "Audit query output headers are invalid."

candidate_failure_count="$(
	awk 'NR > 1 { count += 1 } END { print count + 0 }' \
		"$work_directory/20-core-candidates.csv"
)"
[[ "$candidate_failure_count" == "$inactive_candidate_failure_count" ]] ||
	fail "Candidate evidence does not match the read-only aggregate."
candidate_channel_count="$(
	awk -F, '
		NR > 1 {
			if (length($2) != 64 || $2 !~ /^[0-9a-f]+$/) exit 2
			seen[$2] = 1
		}
		END {
			if (!failed) {
				for (value in seen) count += 1
				print count + 0
			}
		}
	' "$work_directory/20-core-candidates.csv"
)" || fail "Candidate fingerprints are invalid."

awk -F, '
	NR == FNR {
		if (FNR > 1) {
			if (length($2) != 64 || $2 !~ /^[0-9a-f]+$/) exit 2
			if (!($2 in earliest) || $7 < earliest[$2]) earliest[$2] = $7
		}
		next
	}
	FNR == 1 {
		print
		next
	}
	{
		if (length($1) != 64 || $1 !~ /^[0-9a-f]+$/) exit 3
		if (($1 in earliest) && $4 >= earliest[$1]) print
	}
' "$work_directory/20-core-candidates.csv" \
	"$work_directory/.notification-permanent-all.csv" \
	>"$work_directory/30-notification-permanent.csv" ||
	fail "Could not correlate sanitized notification-delivery evidence."

permanent_evidence_count="$(
	awk 'NR > 1 { count += 1 } END { print count + 0 }' \
		"$work_directory/30-notification-permanent.csv"
)"
permanent_evidence_channel_count="$(
	awk -F, '
		NR > 1 {
			if (length($1) != 64 || $1 !~ /^[0-9a-f]+$/) exit 2
			seen[$1] = 1
		}
		END {
			for (value in seen) count += 1
			print count + 0
		}
	' "$work_directory/30-notification-permanent.csv"
)" || fail "Permanent-evidence fingerprints are invalid."
[[ "$permanent_evidence_channel_count" -le "$candidate_channel_count" ]] ||
	fail "Notification-delivery correlation evidence is inconsistent."

printf '%s\n' \
	"source_index,source_sha256,delete_request_count,identity_correlation_available,conclusion" \
	>"$work_directory/40-disconnect-log-summary.csv"
disconnect_delete_request_count=0
if ((${#disconnect_logs[@]} == 0)); then
	printf '%s\n' \
		"0,not_supplied,0,false,no_identity_correlation_source" \
		>>"$work_directory/40-disconnect-log-summary.csv"
else
	for ((index = 0; index < ${#disconnect_logs[@]}; index++)); do
		disconnect_log="${disconnect_logs[$index]}"
		log_sha256="$(sha256sum "$disconnect_log" | awk '{ print $1 }')"
		delete_count="$(
			LC_ALL=C awk '
				$0 ~ /DELETE[[:space:]]+\/api\/v1\/users\/profile\/telegram-notifications([?[:space:]])/ {
					count += 1
				}
				END { print count + 0 }
			' "$disconnect_log"
		)"
		[[ "$log_sha256" =~ ^[0-9a-f]{64}$ &&
			"$delete_count" =~ ^[0-9]+$ ]] ||
			fail "Disconnect log aggregation failed."
		((disconnect_delete_request_count += delete_count))
		printf '%s,%s,%s,false,aggregate_only_no_user_correlation\n' \
			"$((index + 1))" "$log_sha256" "$delete_count" \
			>>"$work_directory/40-disconnect-log-summary.csv"
	done
fi

unaccounted_failure_count="$((unsupported_failure_count -
	active_channel_failure_count -
	inactive_candidate_failure_count))"
[[ "$unaccounted_failure_count" -ge 0 ]] ||
	fail "Legacy Telegram audit accounting is invalid."
candidate_without_permanent_evidence_count="$((candidate_channel_count -
	permanent_evidence_channel_count))"

if [[ "$candidate_failure_count" == "0" &&
	"$unaccounted_failure_count" == "0" ]]; then
	audit_status="completed_no_candidates"
elif [[ "$candidate_channel_count" -gt 0 &&
	"$candidate_without_permanent_evidence_count" == "0" &&
	"$unaccounted_failure_count" == "0" ]]; then
	audit_status="completed_candidates_left_disabled"
else
	audit_status="completed_inconclusive_left_disabled"
fi

write_context "$work_directory/00-context.txt" "$created_at" \
	"$EXPECTED_REVISION" "$marker_phase" "$fingerprint_salt_commitment" \
	"${#disconnect_logs[@]}"
{
	printf 'metric,value\n'
	printf 'status,%s\n' "$audit_status"
	printf 'unsupported_parse_mode_failure_count,%s\n' \
		"$unsupported_failure_count"
	printf 'matched_legacy_delivery_count,%s\n' "$matched_delivery_count"
	printf 'matched_current_channel_failure_count,%s\n' \
		"$matched_channel_count"
	printf 'already_active_channel_failure_count,%s\n' \
		"$active_channel_failure_count"
	printf 'candidate_failure_count,%s\n' "$candidate_failure_count"
	printf 'candidate_channel_count,%s\n' "$candidate_channel_count"
	printf 'unaccounted_failure_count,%s\n' "$unaccounted_failure_count"
	printf 'later_permanent_evidence_count,%s\n' "$permanent_evidence_count"
	printf 'candidate_channel_with_later_permanent_evidence_count,%s\n' \
		"$permanent_evidence_channel_count"
	printf 'candidate_channel_without_later_permanent_evidence_count,%s\n' \
		"$candidate_without_permanent_evidence_count"
	printf 'disconnect_log_source_count,%s\n' "${#disconnect_logs[@]}"
	printf 'disconnect_delete_request_count,%s\n' \
		"$disconnect_delete_request_count"
	printf 'disconnect_identity_correlation_available,false\n'
	printf 'database_mutation_performed,false\n'
	printf 'telegram_reactivation_performed,false\n'
	printf 'candidate_channels_left_disabled,%s\n' "$candidate_channel_count"
} >"$work_directory/10-summary.csv"

rm -f -- \
	"$work_directory/.query-stderr" \
	"$work_directory/.core-preflight" \
	"$work_directory/.notification-preflight" \
	"$work_directory/.core-stats" \
	"$work_directory/.notification-permanent-all.csv"
query_stderr_file=""
unset fingerprint_salt core_backup_url notification_backup_url

artifacts=(
	"00-context.txt"
	"10-summary.csv"
	"20-core-candidates.csv"
	"30-notification-permanent.csv"
	"40-disconnect-log-summary.csv"
)
for artifact in "${artifacts[@]}"; do
	artifact_path="$work_directory/$artifact"
	[[ -f "$artifact_path" && ! -L "$artifact_path" ]] ||
		fail "Required audit artifact is missing: $artifact"
	chown 0:0 "$artifact_path"
	chmod 600 "$artifact_path"
done
(
	cd "$work_directory"
	sha256sum "${artifacts[@]}" >SHA256SUMS
)
chown 0:0 "$work_directory/SHA256SUMS"
chmod 600 "$work_directory/SHA256SUMS"
for artifact in "${artifacts[@]}" SHA256SUMS; do
	[[ "$(stat -c '%a' "$work_directory/$artifact")" == "600" &&
		"$(stat -c '%u:%g' "$work_directory/$artifact")" == "0:0" ]] ||
		fail "Audit artifact ownership or mode is unsafe: $artifact"
done
[[ "$(find "$work_directory" -mindepth 1 -maxdepth 1 | wc -l | tr -d '[:space:]')" == "6" ]] ||
	fail "Unexpected files exist in the audit artifact directory."

mv -T "$work_directory" "$final_directory"
work_directory=""
[[ -d "$final_directory" && ! -L "$final_directory" &&
	"$(stat -c '%a' "$final_directory")" == "700" &&
	"$(stat -c '%u:%g' "$final_directory")" == "0:0" ]] ||
	fail "Final audit artifact directory is unsafe."
manifest_sha256="$(
	sha256sum "$final_directory/SHA256SUMS" |
		awk '{ print $1 }'
)"
[[ "$manifest_sha256" =~ ^[0-9a-f]{64}$ ]] ||
	fail "Could not fingerprint the audit manifest."
audit_reference="switch-generation:${switch_generation}:${final_directory}/SHA256SUMS@sha256:${manifest_sha256}"

echo "Legacy Telegram audit status: $audit_status"
echo "Artifacts: $final_directory"
echo "CAMPAIGNS_TELEGRAM_AUDIT_DECISION=completed"
echo "CAMPAIGNS_TELEGRAM_AUDIT_REFERENCE=$audit_reference"
