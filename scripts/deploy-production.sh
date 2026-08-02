#!/usr/bin/env bash

set -euo pipefail

validate_routine_database_restore_create_gate() {
	local env_file="$1"
	local matching_lines

	matching_lines="$(
		LC_ALL=C grep -Ec '^DATABASE_RESTORE_PRODUCTION_ENABLED=' "$env_file" || true
	)"
	if [[ "$matching_lines" != '1' ]]; then
		echo 'Routine production deployment requires exactly one literal DATABASE_RESTORE_PRODUCTION_ENABLED=false line.' >&2
		return 1
	fi
	if LC_ALL=C grep -Fxq 'DATABASE_RESTORE_PRODUCTION_ENABLED=false' "$env_file"; then
		return 0
	fi
	if LC_ALL=C grep -Fxq 'DATABASE_RESTORE_PRODUCTION_ENABLED=true' "$env_file"; then
		echo 'Routine production deployment rejects DATABASE_RESTORE_PRODUCTION_ENABLED=true. Use a separate reviewed restore-control action; it is not implemented in this release.' >&2
		return 1
	fi

	echo 'Routine production deployment requires the literal DATABASE_RESTORE_PRODUCTION_ENABLED=false line.' >&2
	return 1
}

run_database_restore_create_gate_self_test() {
	local self_test_directory
	local false_env
	local true_env
	local invalid_env
	local rejection

	self_test_directory="$(
		mktemp -d "${TMPDIR:-/tmp}/winwidget-restore-create-gate.XXXXXX"
	)"
	false_env="$self_test_directory/false.env"
	true_env="$self_test_directory/true.env"
	invalid_env="$self_test_directory/invalid.env"
	trap 'rm -f "$false_env" "$true_env" "$invalid_env"; rmdir "$self_test_directory"' RETURN

	printf '%s\n' 'DATABASE_RESTORE_PRODUCTION_ENABLED=false' >"$false_env"
	printf '%s\n' 'DATABASE_RESTORE_PRODUCTION_ENABLED=true' >"$true_env"
	printf '%s\n' 'DATABASE_RESTORE_PRODUCTION_ENABLED= false' >"$invalid_env"

	validate_routine_database_restore_create_gate "$false_env"
	if rejection="$(
		validate_routine_database_restore_create_gate "$true_env" 2>&1
	)"; then
		echo 'Database restore create-gate self-test accepted true.' >&2
		return 1
	fi
	if [[ "$rejection" != *'separate reviewed restore-control action'* ]]; then
		echo 'Database restore create-gate self-test lost the reviewed-action guidance.' >&2
		return 1
	fi
	if validate_routine_database_restore_create_gate "$invalid_env" >/dev/null 2>&1; then
		echo 'Database restore create-gate self-test accepted a non-literal false value.' >&2
		return 1
	fi

	printf 'database_restore_routine_create_gate=passed\n'
}

if [[ "${1:-}" == '--self-test-database-restore-create-gate' ]]; then
	[[ "$#" -eq 1 ]] || {
		echo 'Database restore create-gate self-test does not accept extra arguments.' >&2
		exit 1
	}
	run_database_restore_create_gate_self_test
	exit 0
fi

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4200/api/v1/health/deployment}"
PUBLIC_HEALTHCHECK_URL="${PUBLIC_HEALTHCHECK_URL:-https://api.winwidget.ru/api/v1/health/deployment}"
READINESS_URL="${READINESS_URL:-http://127.0.0.1:4200/api/v1/health/ready}"
GATEWAY_READINESS_URL="${GATEWAY_READINESS_URL:-http://127.0.0.1:4100/health/ready}"
MAINTENANCE_READINESS_URL="${MAINTENANCE_READINESS_URL:-http://127.0.0.1:4300/health/ready}"
NOTIFICATION_DELIVERY_READINESS_URL="${NOTIFICATION_DELIVERY_READINESS_URL:-http://127.0.0.1:4401/health/ready}"
CAMPAIGNS_READINESS_URL="${CAMPAIGNS_READINESS_URL:-http://127.0.0.1:4500/health/ready}"
REPORTING_READINESS_URL="${REPORTING_READINESS_URL:-http://127.0.0.1:4600/health/ready}"
NOTIFICATION_DELIVERY_INITIAL_CUTOVER_MARKER="$APP_ROOT/deploy/backend/.notification-delivery-cutover-v1"
NOTIFICATION_DELIVERY_CUTOVER_MARKER="$APP_ROOT/deploy/backend/.notification-delivery-telegram-cutover-v1"
NOTIFICATION_DELIVERY_CUTOVER_PROJECT="winwidget-notification-telegram-cutover"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-30}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-2}"

cd "$APP_ROOT"

server_root="$APP_ROOT/winwidget.ru_server"
# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
acquire_production_deploy_lock "full backend deployment"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$server_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/core-database-production-guard.sh
source "$server_root/scripts/core-database-production-guard.sh"
# shellcheck source=scripts/reporting-database-lifecycle.sh
source "$server_root/scripts/reporting-database-lifecycle.sh"
# shellcheck source=scripts/reporting-cutover-lifecycle.sh
source "$server_root/scripts/reporting-cutover-lifecycle.sh"
# shellcheck source=scripts/campaigns-contract-migration-guard.sh
source "$server_root/scripts/campaigns-contract-migration-guard.sh"
deploy_revision="$(git -C "$server_root" rev-parse HEAD)"
expected_revision="${EXPECTED_REVISION:-$deploy_revision}"
if [[ "$deploy_revision" != "$expected_revision" ]]; then
	echo "Deployment revision mismatch: expected $expected_revision, got $deploy_revision" >&2
	exit 1
fi

dirty_files="$(
	git -C "$server_root" status --porcelain --untracked-files=all
)"
if [[ -n "$dirty_files" ]]; then
	echo "Backend deployment checkout is not clean:" >&2
	echo "$dirty_files" >&2
	exit 1
fi

# database-restore-production-guard: before-mutation
database_restore_guard_assert_before_mutation \
	identity-if-present "$ENV_FILE"

reporting_automatic_prod_push="${REPORTING_AUTOMATIC_PROD_PUSH:-false}"
reporting_deploy_action="$(
	reporting_first_rollout_deploy_action \
		"$reporting_automatic_prod_push" \
		"$deploy_revision"
)" || {
	echo "Reporting first-rollout marker state is invalid." >&2
	exit 1
}
case "$reporting_deploy_action" in
	stage)
		reporting_write_first_rollout_staged_marker "$deploy_revision"
		echo "Reporting first-rollout revision $deploy_revision is staged on the VPS."
		echo "Restore safety state was verified; no Compose configuration was evaluated, image built, runtime changed or database accessed."
		echo "Run the manual reporting-database prepare workflow next."
		exit 0
		;;
	prepare)
		echo "Manual full deployment is blocked until the staged Reporting database is prepared." >&2
		echo "Run the reporting-database prepare workflow for revision $deploy_revision." >&2
		exit 1
		;;
	block)
		echo "Reporting database preparation is incomplete at revision $deploy_revision." >&2
		echo "Resume the pinned reporting-database prepare workflow before any deployment." >&2
		exit 1
		;;
	deploy) ;;
	*)
		echo "Reporting first-rollout action is invalid." >&2
		exit 1
		;;
esac
reporting_scheduler_policy="$(reporting_cutover_runtime_scheduler_policy)" || {
	echo 'Reporting cutover scheduler policy is invalid.' >&2
	exit 1
}
reporting_gateway_policy="$(reporting_cutover_runtime_gateway_policy)" || {
	echo 'Reporting cutover Gateway policy is invalid.' >&2
	exit 1
}
# Defaults are owned by the sourced lifecycle; keep them explicit here so
# static analysis can follow their later use through the dynamic source path.
notification_database_cutover_active=false
notification_database_phase_before=""
# shellcheck source=scripts/notification-delivery-database-lifecycle.sh
source "$server_root/scripts/notification-delivery-database-lifecycle.sh"
# shellcheck source=scripts/campaigns-database-lifecycle.sh
source "$server_root/scripts/campaigns-database-lifecycle.sh"

campaigns_automatic_prod_push="${CAMPAIGNS_AUTOMATIC_PROD_PUSH:-false}"
campaigns_cutover_phase="missing"
if [[ -e "$CAMPAIGNS_DATABASE_CUTOVER_MARKER" ||
	-L "$CAMPAIGNS_DATABASE_CUTOVER_MARKER" ]]; then
	if ! validate_campaigns_database_cutover_marker; then
		echo "Campaigns database cutover marker is invalid; refusing full deployment." >&2
		exit 1
	fi
	campaigns_cutover_phase="$(campaigns_database_marker_value phase)"
fi
campaigns_deploy_action="$(
	campaigns_full_deploy_action \
		"$campaigns_automatic_prod_push" \
		"$campaigns_cutover_phase"
)" || {
	echo "Campaigns full deployment trigger or cutover phase is invalid." >&2
	exit 1
}
case "$campaigns_deploy_action" in
	stage)
		guard_campaigns_cutover_checkout_revision "$deploy_revision"
		write_campaigns_first_cutover_staged_marker "$deploy_revision"
		echo "Campaigns first-cutover revision $deploy_revision is staged on the VPS."
		echo "No image was built, container restarted or migration applied."
		echo "Run the manual campaigns-database-cutover prepare workflow next."
		exit 0
		;;
	block)
		if [[ "$campaigns_cutover_phase" == "missing" ]]; then
			echo "Manual full deployment is blocked before the Campaigns cutover is complete." >&2
			echo "Run the staged automatic prod workflow and manual campaigns-database-cutover prepare first." >&2
		else
			echo "Campaigns database cutover is in phase $campaigns_cutover_phase." >&2
		fi
		echo "Production pushes must remain frozen until phase=complete; changing revision requires reviewed cutover recovery." >&2
		exit 1
		;;
	deploy) ;;
	*)
		echo "Campaigns full deployment action is invalid." >&2
		exit 1
		;;
esac

export APP_REVISION="$deploy_revision"
export APP_VERSION="git-$deploy_revision"
export MAINTENANCE_REVISION="$deploy_revision"
export MAINTENANCE_IMAGE="winwidget-maintenance:git-$deploy_revision"
export DATABASE_RESTORE_REVISION="$deploy_revision"
export DATABASE_RESTORE_IMAGE="winwidget-database-restore:git-$deploy_revision"
export NOTIFICATION_DELIVERY_REVISION="$deploy_revision"
export NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:git-$deploy_revision"
export CAMPAIGNS_REVISION="$deploy_revision"
export CAMPAIGNS_IMAGE="winwidget-campaigns:git-$deploy_revision"
export REPORTING_REVISION="$deploy_revision"
export REPORTING_IMAGE="winwidget-reporting:git-$deploy_revision"

echo "Deploying backend revision: $APP_REVISION"
echo "Building backend image: winwidget-api:$APP_VERSION"
echo "Building gateway image: winwidget-api-gateway:$APP_VERSION"
echo "Building maintenance image: $MAINTENANCE_IMAGE"
echo "Building isolated database restore image: $DATABASE_RESTORE_IMAGE"
echo "Building notification delivery image: $NOTIFICATION_DELIVERY_IMAGE"
echo "Building Campaigns image: $CAMPAIGNS_IMAGE"
echo "Building Reporting image; its runtime remains independent except for the exact staged cleanup revision: $REPORTING_IMAGE"

if [[ ! -f "$ENV_FILE" ]]; then
	echo "Backend env file not found: $ENV_FILE" >&2
	exit 1
fi

env_mode="$(stat -c '%a' "$ENV_FILE")"
env_group_digit="${env_mode: -2:1}"
env_other_digit="${env_mode: -1}"
if ((10#$env_group_digit != 0 || 10#$env_other_digit != 0)); then
	echo "Backend env file must not be accessible by group or others: $ENV_FILE (mode $env_mode)" >&2
	echo "Run: chmod 600 $ENV_FILE" >&2
	exit 1
fi

duplicate_env_keys="$(
	awk '
		/^[[:space:]]*(#|$)/ { next }
		{
			line = $0
			sub(/^[[:space:]]*/, "", line)
			if (line !~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) next

			name = line
			sub(/[[:space:]]*=.*/, "", name)
			count[name] += 1
		}
		END {
			for (name in count) {
				if (count[name] > 1) print name
			}
		}
	' "$ENV_FILE" | LC_ALL=C sort
)"
if [[ -n "$duplicate_env_keys" ]]; then
	echo "Duplicate environment keys are not allowed in $ENV_FILE:" >&2
	echo "$duplicate_env_keys" >&2
	exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
	echo "Backend Compose file not found: $COMPOSE_FILE" >&2
	exit 1
fi

ambient_compose_overrides=()
while IFS= read -r key; do
	[[ -n "$key" ]] || continue
	case "$key" in
		APP_REVISION | APP_VERSION | MAINTENANCE_IMAGE | MAINTENANCE_REVISION | DATABASE_RESTORE_IMAGE | DATABASE_RESTORE_REVISION | NOTIFICATION_DELIVERY_IMAGE | NOTIFICATION_DELIVERY_REVISION | CAMPAIGNS_IMAGE | CAMPAIGNS_REVISION | REPORTING_IMAGE | REPORTING_REVISION)
			continue
			;;
	esac
	if printenv "$key" >/dev/null 2>&1; then
		ambient_compose_overrides+=("$key")
	fi
done < <(
	LC_ALL=C grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$COMPOSE_FILE" |
		sed 's/^${//' |
		LC_ALL=C sort -u
)
if ((${#ambient_compose_overrides[@]} > 0)); then
	echo "Unset shell variables that would override $ENV_FILE in Docker Compose:" >&2
	printf '%s\n' "${ambient_compose_overrides[@]}" >&2
	exit 1
fi

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

			if (name == key && value != "" && value !~ /^change_me/) ok = 1
		}
		END { exit(ok ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "Missing required $key in $ENV_FILE" >&2
		exit 1
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
				found = 1
				exit
			}
		}
		END { exit(found ? 0 : 1) }
	' "$ENV_FILE"
}

get_database_username() {
	local key="$1"
	local value

	value="$(get_env_value "$key")"
	if [[ "$value" =~ ^postgres(ql)?://([A-Za-z0-9._-]+):[^@]+@ ]]; then
		printf '%s' "${BASH_REMATCH[2]}"
		return
	fi
	echo "$key must be a PostgreSQL URL with an explicit non-encoded username and password" >&2
	exit 1
}

assert_distinct_database_roles() {
	local -a role_keys=(
		DATABASE_URL_PRODUCTION
		DATABASE_MIGRATION_URL_PRODUCTION
		MAINTENANCE_DATABASE_URL_PRODUCTION
		DATABASE_BACKUP_URL
		NOTIFICATION_DELIVERY_DATABASE_URL
		NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION
		NOTIFICATION_DELIVERY_BACKUP_URL
		CAMPAIGNS_DATABASE_URL
		CAMPAIGNS_MIGRATION_DATABASE_URL
		CAMPAIGNS_BACKUP_URL
		REPORTING_DATABASE_URL
		REPORTING_MIGRATION_DATABASE_URL
		REPORTING_BACKUP_URL
	)
	local -a role_users=()
	local key
	local left
	local right

	for key in "${role_keys[@]}"; do
		role_users+=("$(get_database_username "$key")")
	done
	for ((left = 0; left < ${#role_users[@]}; left++)); do
		for ((right = left + 1; right < ${#role_users[@]}; right++)); do
			if [[ "${role_users[$left]}" == "${role_users[$right]}" ]]; then
				echo "Core, Notification Delivery, Campaigns and Reporting database URLs must use thirteen distinct PostgreSQL roles." >&2
				exit 1
			fi
		done
	done
}

require_env_exact_list() {
	local key="$1"
	local expected="$2"
	local value
	local normalized
	local normalized_expected

	value="$(get_env_value "$key" || true)"
	normalized="$(
		tr ',' '\n' <<<"$value" |
			sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
			sed '/^$/d' |
			sort -u |
			paste -sd, -
	)"
	normalized_expected="$(
		tr ',' '\n' <<<"$expected" |
			sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
			sed '/^$/d' |
			sort -u |
			paste -sd, -
	)"
	if [[ "$normalized" != "$normalized_expected" ]]; then
		echo "$key in $ENV_FILE must contain exactly: $expected" >&2
		exit 1
	fi
}

require_env_base64url_secret() {
	local key="$1"
	local minimum_length="$2"
	local maximum_length="$3"

	if ! awk -v key="$key" -v minimum="$minimum_length" \
		-v maximum="$maximum_length" '
		/^[[:space:]]*(#|$)/ { next }
		{
			prefix = key "="
			if (index($0, prefix) != 1) next
			value = substr($0, length(prefix) + 1)
			if (value ~ /^[A-Za-z0-9_-]+$/ &&
				length(value) >= minimum && length(value) <= maximum) ok = 1
		}
		END { exit(ok ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "$key must be an unquoted base64url secret between $minimum_length and $maximum_length characters with no surrounding whitespace" >&2
		exit 1
	fi
}

assert_database_restore_admin_secret_file() {
	local key="$1"
	local expected_path="$2"
	local secret_path
	local secret_identity
	local secret_size

	secret_path="$(get_env_value "$key")"
	if [[ "$secret_path" != "$expected_path" ||
		! -f "$secret_path" || -L "$secret_path" ]]; then
		echo "$key must reference its canonical regular production secret file." >&2
		exit 1
	fi
	secret_identity="$(stat -c '%a|%U:%G' "$secret_path")"
	secret_size="$(stat -c '%s' "$secret_path")"
	if [[ "$secret_identity" != '600|root:root' ||
		! "$secret_size" =~ ^[0-9]+$ ]] ||
		((secret_size < 16 || secret_size > 4096)); then
		echo "$key must be a root-owned mode-600 secret between 16 and 4096 bytes." >&2
		exit 1
	fi
}

prepare_database_restore_storage() {
	local storage_path
	local active_entry
	local directory

	storage_path="$(get_env_value DATABASE_RESTORE_STORAGE_DIR)"
	if [[ "$storage_path" != "$APP_ROOT/deploy/backend/database-restores" ]]; then
		echo 'DATABASE_RESTORE_STORAGE_DIR must use the canonical scoped production path.' >&2
		exit 1
	fi
	if [[ -e "$storage_path" || -L "$storage_path" ]]; then
		if [[ ! -d "$storage_path" || -L "$storage_path" ||
			"$(stat -c '%u:%g:%a' "$storage_path")" != '1001:1001:700' ]]; then
			echo 'Database restore storage must be a UID/GID 1001 private directory with mode 700.' >&2
			exit 1
		fi
	else
		install -d -m 700 -o 1001 -g 1001 "$storage_path"
	fi

	for directory in queued processing locks gates fences; do
		if [[ ! -e "$storage_path/$directory" &&
			! -L "$storage_path/$directory" ]]; then
			continue
		fi
		if [[ ! -d "$storage_path/$directory" ||
			-L "$storage_path/$directory" ||
			"$(stat -c '%u:%g:%a' "$storage_path/$directory")" != '1001:1001:700' ]]; then
			echo "Unsafe database restore queue directory: $directory" >&2
			exit 1
		fi
		active_entry="$(
			find "$storage_path/$directory" -mindepth 1 -maxdepth 1 \
				-print -quit 2>/dev/null || true
		)"
		if [[ -n "$active_entry" ]]; then
			echo "Deployment is blocked by active or fenced database restore state in $directory." >&2
			exit 1
		fi
	done
}

mode="$(get_env_value "MODE" || true)"
mode="${mode:-production}"
mode="${mode,,}"

for key in \
	JWT_ACCESS_PRIVATE_KEY_BASE64 \
	JWT_ACCESS_JWKS_BASE64 \
	JWT_ACCESS_ACTIVE_KID \
	JWT_ISSUER \
	JWT_AUDIENCE \
	JWT_ACCESS_TTL_SECONDS \
	JWT_CLOCK_TOLERANCE_SECONDS \
	GATEWAY_LISTEN_HOST \
	GATEWAY_PORT \
	GATEWAY_ROUTES_JSON \
	CORS_ALLOWED_ORIGINS \
	JWT_JWKS_URL \
	GATEWAY_SHUTDOWN_GRACE_MS; do
	require_env_key "$key"
done

for legacy_key in \
	JWT_SECRET \
	API_UPSTREAM_URL \
	GATEWAY_PROXY_TIMEOUT_MS \
	RABBITMQ_LEGACY_USER \
	RABBITMQ_USER \
	RABBITMQ_PASSWORD \
	RABBITMQ_URL; do
	if awk -F= -v key="$legacy_key" '
		/^[[:space:]]*(#|$)/ { next }
		{
			name = $1
			sub(/^[[:space:]]*/, "", name)
			sub(/[[:space:]]*$/, "", name)
			if (name == key) found = 1
		}
		END { exit(found ? 0 : 1) }
	' "$ENV_FILE"; then
		echo "$legacy_key must be removed from $ENV_FILE" >&2
		exit 1
	fi
done

case "$mode" in
	production)
		require_env_key "DATABASE_URL_PRODUCTION"
		require_env_key "DATABASE_MIGRATION_URL_PRODUCTION"
		require_env_key "MAINTENANCE_DATABASE_URL_PRODUCTION"
		require_env_key "DATABASE_BACKUP_URL"
		require_env_key "NOTIFICATION_DELIVERY_DATABASE_URL"
		require_env_key "NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION"
		require_env_key "NOTIFICATION_DELIVERY_BACKUP_URL"
		require_env_key "CAMPAIGNS_DATABASE_URL"
		require_env_key "CAMPAIGNS_MIGRATION_DATABASE_URL"
		require_env_key "CAMPAIGNS_BACKUP_URL"
		require_env_key "NOTIFICATION_DELIVERY_POSTGRES_IMAGE"
		require_env_key "NOTIFICATION_DELIVERY_POSTGRES_PORT"
		require_env_key "NOTIFICATION_DELIVERY_POSTGRES_DATA_VOLUME"
		require_env_key "NOTIFICATION_DELIVERY_POSTGRES_ADMIN_USER"
		require_env_key "NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "CAMPAIGNS_POSTGRES_IMAGE"
		require_env_key "CAMPAIGNS_POSTGRES_PORT"
		require_env_key "CAMPAIGNS_POSTGRES_DATA_VOLUME"
		require_env_key "CAMPAIGNS_POSTGRES_ADMIN_USER"
		require_env_key "CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "REPORTING_DATABASE_URL"
		require_env_key "REPORTING_MIGRATION_DATABASE_URL"
		require_env_key "REPORTING_BACKUP_URL"
		require_env_key "REPORTING_POSTGRES_IMAGE"
		require_env_key "REPORTING_POSTGRES_PORT"
		require_env_key "REPORTING_POSTGRES_DATA_VOLUME"
		require_env_key "REPORTING_POSTGRES_ADMIN_USER"
		require_env_key "REPORTING_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "CORE_POSTGRES_ADMIN_PASSWORD_FILE"
		require_env_key "DATABASE_RESTORE_STORAGE_DIR"
		require_env_key "DATABASE_RESTORE_QUEUE_SECRET"
		require_env_key "DATABASE_RESTORE_PRODUCTION_ENABLED"
		require_env_key "DATABASE_RESTORE_POLL_INTERVAL_MS"
		require_env_key "DATABASE_RESTORE_COMMAND_TIMEOUT_MS"
		require_env_key "PRODUCTION_HOST"
		require_env_key "AUTH_COOKIE_DOMAIN"
		require_env_key "COMPOSE_PROJECT_NAME"
		require_env_key "RABBITMQ_DATA_VOLUME"
		require_env_key "RABBITMQ_ADMIN_USER"
		require_env_key "RABBITMQ_ADMIN_PASSWORD"
		require_env_key "RABBITMQ_MONITOR_USER"
		require_env_key "RABBITMQ_MONITOR_PASSWORD"
		require_env_key "RABBITMQ_PUBLISHER_URL"
		require_env_key "RABBITMQ_INTEGRATION_WORKER_URL"
		require_env_key "RABBITMQ_MAINTENANCE_WORKER_URL"
		require_env_key "RABBITMQ_NOTIFICATION_DELIVERY_URL"
		require_env_key "RABBITMQ_CAMPAIGNS_URL"
		require_env_key "RABBITMQ_REPORTING_URL"
		require_env_key "SMTP_SERVER"
		require_env_key "SMTP_LOGIN"
		require_env_key "SMTP_PASSWORD"
		require_env_key "SMTP_CONNECTION_TIMEOUT_MS"
		require_env_key "SMTP_GREETING_TIMEOUT_MS"
		require_env_key "SMTP_SOCKET_TIMEOUT_MS"
		require_env_key "TELEGRAM_INFO_BOT_TOKEN"
		require_env_key "NOTIFICATION_DELIVERY_INTERNAL_URL"
		require_env_key "NOTIFICATION_DELIVERY_INTERNAL_TOKEN"
		require_env_key "NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS"
		require_env_key "CAMPAIGNS_INTERNAL_TOKEN"
		require_env_key "CAMPAIGNS_INTERNAL_TIMEOUT_MS"
		require_env_key "CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE"
		require_env_key "CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS"
		require_env_key "CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE"
		require_env_key "CAMPAIGNS_PROCESS_ROLE"
		require_env_key "CAMPAIGNS_LISTEN_HOST"
		require_env_key "CAMPAIGNS_HEALTH_PORT"
		require_env_key "CAMPAIGNS_CORE_INTERNAL_BASE_URL"
		require_env_key "CAMPAIGNS_PREFETCH"
		require_env_key "CAMPAIGNS_EMAIL_RATE_PER_SECOND"
		require_env_key "CAMPAIGNS_TELEGRAM_RATE_PER_SECOND"
		require_env_key "CAMPAIGNS_OUTBOX_BATCH_SIZE"
		require_env_key "CAMPAIGNS_OUTBOX_POLL_INTERVAL_MS"
		require_env_key "CAMPAIGNS_OUTBOX_RETENTION_DAYS"
		require_env_key "REPORTING_INTERNAL_TOKEN"
		require_env_key "REPORTING_INTERNAL_TIMEOUT_MS"
		require_env_key "REPORTING_PROCESS_ROLE"
		require_env_key "REPORTING_LISTEN_HOST"
		require_env_key "REPORTING_PORT"
		require_env_key "REPORTING_CORE_INTERNAL_BASE_URL"
		require_env_key "REPORTING_SCHEDULER_ENABLED"
		require_env_key "REPORTING_PREFETCH"
		require_env_key "REPORTING_OUTBOX_BATCH_SIZE"
		require_env_key "REPORTING_OUTBOX_POLL_INTERVAL_MS"
		require_env_key "REPORTING_OUTBOX_RETENTION_DAYS"
		require_env_key "NOTIFICATION_DELIVERY_LISTEN_HOST"
		require_env_key "MAINTENANCE_WORKER_PREFETCH"
		require_env_key "MAINTENANCE_HEALTH_PORT"
		require_env_key "NOTIFICATION_DELIVERY_HEALTH_PORT"
		require_env_key "NOTIFICATION_DELIVERY_PREFETCH"
		require_env_key "SCHEDULED_JOB_POLL_INTERVAL_MS"
		require_env_key "SCHEDULED_JOB_LEASE_MS"
		require_env_key "SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS"
		require_env_key "INTEGRATION_WORKER_KINDS"
		require_env_key "MAINTENANCE_WORKER_KINDS"
		require_env_key "NOTIFICATION_DELIVERY_KINDS"
		require_env_exact_list \
			"INTEGRATION_WORKER_KINDS" \
			"$(reporting_expected_integration_worker_kinds)"
		require_env_exact_list \
			"MAINTENANCE_WORKER_KINDS" \
			"database-backup"
		require_env_exact_list \
			"NOTIFICATION_DELIVERY_KINDS" \
			"email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram"
		require_env_key "YOOKASSA_PRODUCTION_SHOP_ID"
		require_env_key "YOOKASSA_PRODUCTION_SECRET_KEY"
		require_env_key "PAYMENT_METHOD_ENCRYPTION_KEY"
		payment_method_key_bytes="$(
			printf '%s' "$(get_env_value PAYMENT_METHOD_ENCRYPTION_KEY)" |
				base64 -d 2>/dev/null |
				wc -c |
				tr -d '[:space:]'
		)"
		if [[ "$payment_method_key_bytes" != "32" ]]; then
			echo "PAYMENT_METHOD_ENCRYPTION_KEY must be standard base64 for exactly 32 bytes" >&2
			exit 1
		fi
		require_env_key "PORT"
		require_env_key "API_LISTEN_HOST"
		require_env_key "TRUST_PROXY"
		require_env_exact_list \
			"CORS_ALLOWED_ORIGINS" \
			"https://winwidget.ru,https://www.winwidget.ru"
		if [[ "$(get_env_value PORT)" != "4200" ]]; then
			echo "Production PORT must be 4200" >&2
			exit 1
		fi
		if [[ "$(get_env_value API_LISTEN_HOST)" != "127.0.0.1" ]]; then
			echo "Production API_LISTEN_HOST must be 127.0.0.1" >&2
			exit 1
		fi
		if [[ "$(get_env_value TRUST_PROXY)" != "loopback" ]]; then
			echo "Production TRUST_PROXY must be loopback" >&2
			exit 1
		fi
		if [[ "$(get_env_value PRODUCTION_HOST)" != "https://api.winwidget.ru" ]]; then
			echo "Production PRODUCTION_HOST must be https://api.winwidget.ru" >&2
			exit 1
		fi
		if [[ "$(get_env_value AUTH_COOKIE_DOMAIN)" != ".winwidget.ru" ]]; then
			echo "Production AUTH_COOKIE_DOMAIN must be .winwidget.ru so Next.js middleware and API share the refresh cookie" >&2
			exit 1
		fi
		if [[ "$(get_env_value JWT_ISSUER)" != "https://api.winwidget.ru/auth" ]]; then
			echo "Production JWT_ISSUER must be https://api.winwidget.ru/auth" >&2
			exit 1
		fi
		if [[ "$(get_env_value JWT_AUDIENCE)" != "https://api.winwidget.ru" ]]; then
			echo "Production JWT_AUDIENCE must be https://api.winwidget.ru" >&2
			exit 1
		fi
		if [[ "$(get_env_value GATEWAY_LISTEN_HOST)" != "127.0.0.1" ]]; then
			echo "Production GATEWAY_LISTEN_HOST must be 127.0.0.1" >&2
			exit 1
		fi
		if [[ "$(get_env_value GATEWAY_PORT)" != "4100" ]]; then
			echo "Production GATEWAY_PORT must be 4100" >&2
			exit 1
		fi
		if [[ "$(get_env_value MAINTENANCE_HEALTH_PORT)" != "4300" ]]; then
			echo "Production MAINTENANCE_HEALTH_PORT must be 4300" >&2
			exit 1
		fi
		if [[ "$(get_env_value NOTIFICATION_DELIVERY_HEALTH_PORT)" != "4401" ]]; then
			echo "Production NOTIFICATION_DELIVERY_HEALTH_PORT must be 4401" >&2
			exit 1
		fi
		if [[ "$(get_env_value NOTIFICATION_DELIVERY_LISTEN_HOST)" != "127.0.0.1" ]]; then
			echo "Production NOTIFICATION_DELIVERY_LISTEN_HOST must be 127.0.0.1" >&2
			exit 1
		fi
		if [[ "$(get_env_value NOTIFICATION_DELIVERY_INTERNAL_URL)" != "http://127.0.0.1:4401/internal/notification-delivery" ]]; then
			echo "Production NOTIFICATION_DELIVERY_INTERNAL_URL must use the loopback notification delivery endpoint" >&2
			exit 1
		fi
		notification_delivery_internal_token="$(
			get_env_value NOTIFICATION_DELIVERY_INTERNAL_TOKEN
		)"
		if [[ "$notification_delivery_internal_token" == "XYZXYZXYZ" ||
			"$notification_delivery_internal_token" == change_me* ||
			${#notification_delivery_internal_token} -lt 32 ]]; then
			echo "NOTIFICATION_DELIVERY_INTERNAL_TOKEN must be a non-placeholder value of at least 32 characters" >&2
			exit 1
		fi
		notification_delivery_internal_timeout_ms="$(
			get_env_value NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS || true
		)"
		notification_delivery_internal_timeout_ms="${notification_delivery_internal_timeout_ms:-5000}"
		if [[ ! "$notification_delivery_internal_timeout_ms" =~ ^[0-9]+$ ]] ||
			((notification_delivery_internal_timeout_ms < 500 ||
				notification_delivery_internal_timeout_ms > 30000)); then
			echo "NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS must be between 500 and 30000" >&2
			exit 1
		fi
		notification_delivery_prefetch="$(
			get_env_value NOTIFICATION_DELIVERY_PREFETCH
		)"
		if [[ ! "$notification_delivery_prefetch" =~ ^[1-9][0-9]*$ ]] ||
			((notification_delivery_prefetch > 100)); then
			echo "NOTIFICATION_DELIVERY_PREFETCH must be between 1 and 100" >&2
			exit 1
			fi
		campaigns_internal_token="$(get_env_value CAMPAIGNS_INTERNAL_TOKEN)"
		if [[ "$campaigns_internal_token" == change_me* ||
			"$campaigns_internal_token" == "ci_campaigns_internal_token_at_least_32_chars" ||
			${#campaigns_internal_token} -lt 32 ]]; then
			echo "CAMPAIGNS_INTERNAL_TOKEN must be a production-only secret of at least 32 characters" >&2
			exit 1
		fi
		if [[ "$(get_env_value CAMPAIGNS_PROCESS_ROLE)" != "all" ||
			"$(get_env_value CAMPAIGNS_LISTEN_HOST)" != "127.0.0.1" ||
			"$(get_env_value CAMPAIGNS_HEALTH_PORT)" != "4500" ||
			"$(get_env_value CAMPAIGNS_CORE_INTERNAL_BASE_URL)" != "http://127.0.0.1:4200" ]]; then
			echo "Campaigns must run as the loopback-only single-VPS all role on ports 4200/4500" >&2
			exit 1
		fi
		campaigns_internal_timeout_ms="$(
			get_env_value CAMPAIGNS_INTERNAL_TIMEOUT_MS
		)"
		campaigns_export_chunk_size="$(
			get_env_value CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE
		)"
		campaigns_export_timeout_ms="$(
			get_env_value CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS
		)"
		campaigns_import_batch_size="$(
			get_env_value CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE
		)"
		campaigns_prefetch="$(get_env_value CAMPAIGNS_PREFETCH)"
		if [[ ! "$campaigns_internal_timeout_ms" =~ ^[0-9]+$ ]] ||
			((campaigns_internal_timeout_ms < 500 ||
				campaigns_internal_timeout_ms > 30000)); then
			echo "CAMPAIGNS_INTERNAL_TIMEOUT_MS must be between 500 and 30000" >&2
			exit 1
		fi
		if [[ ! "$campaigns_export_chunk_size" =~ ^[0-9]+$ ]] ||
			((campaigns_export_chunk_size < 1 ||
				campaigns_export_chunk_size > 5000)); then
			echo "CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE must be between 1 and 5000" >&2
			exit 1
		fi
		if [[ ! "$campaigns_export_timeout_ms" =~ ^[0-9]+$ ]] ||
			((campaigns_export_timeout_ms < 30000 ||
				campaigns_export_timeout_ms > 900000)); then
			echo "CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS must be between 30000 and 900000" >&2
			exit 1
		fi
		if [[ ! "$campaigns_import_batch_size" =~ ^[0-9]+$ ]] ||
			((campaigns_import_batch_size < 1 ||
				campaigns_import_batch_size > 5000)); then
			echo "CAMPAIGNS_AUDIENCE_IMPORT_BATCH_SIZE must be between 1 and 5000" >&2
			exit 1
		fi
		if [[ ! "$campaigns_prefetch" =~ ^[1-9][0-9]*$ ]] ||
			((campaigns_prefetch > 100)); then
			echo "CAMPAIGNS_PREFETCH must be between 1 and 100" >&2
			exit 1
		fi
		reporting_validate_preflight_secret_isolation || {
			echo 'Reporting credential isolation preflight failed.' >&2
			exit 1
		}
		if [[ "$(get_env_value REPORTING_PROCESS_ROLE)" != "all" ||
			"$(get_env_value REPORTING_LISTEN_HOST)" != "127.0.0.1" ||
			"$(get_env_value REPORTING_PORT)" != "4600" ||
			"$(get_env_value REPORTING_CORE_INTERNAL_BASE_URL)" != "http://127.0.0.1:4200" ]]; then
			echo "Reporting must run as the loopback-only single-VPS all role on ports 4200/4600" >&2
			exit 1
		fi
		reporting_scheduler_enabled="$(get_env_value REPORTING_SCHEDULER_ENABLED)"
		if [[ "$reporting_scheduler_policy" == 'transitional' ||
			"$reporting_scheduler_policy" == 'fenced' ]]; then
			echo 'A coordinated full deployment is blocked during the Daily Summary owner hand-off; use the Reporting-only target.' >&2
			exit 1
		fi
		if ! reporting_cutover_scheduler_value_allowed \
			"$reporting_scheduler_policy" "$reporting_scheduler_enabled"; then
			echo "REPORTING_SCHEDULER_ENABLED=$reporting_scheduler_enabled conflicts with cutover policy $reporting_scheduler_policy" >&2
			exit 1
		fi
		reporting_internal_token="$(get_env_value REPORTING_INTERNAL_TOKEN)"
		if [[ "$reporting_internal_token" == change_me* ||
			"$reporting_internal_token" == "ci_reporting_internal_token_at_least_32_chars" ||
			${#reporting_internal_token} -lt 32 ]]; then
			echo "REPORTING_INTERNAL_TOKEN must be a production-only secret of at least 32 characters" >&2
			exit 1
		fi
		unset reporting_internal_token
		reporting_internal_timeout_ms="$(get_env_value REPORTING_INTERNAL_TIMEOUT_MS)"
		reporting_prefetch="$(get_env_value REPORTING_PREFETCH)"
		reporting_outbox_batch_size="$(get_env_value REPORTING_OUTBOX_BATCH_SIZE)"
		reporting_outbox_poll_interval_ms="$(get_env_value REPORTING_OUTBOX_POLL_INTERVAL_MS)"
		reporting_outbox_retention_days="$(get_env_value REPORTING_OUTBOX_RETENTION_DAYS)"
		if [[ ! "$reporting_internal_timeout_ms" =~ ^[0-9]+$ ]] ||
			((reporting_internal_timeout_ms < 500 ||
				reporting_internal_timeout_ms > 60000)); then
			echo "REPORTING_INTERNAL_TIMEOUT_MS must be between 500 and 60000" >&2
			exit 1
		fi
		if [[ ! "$reporting_prefetch" =~ ^[1-9][0-9]*$ ]] ||
			((reporting_prefetch > 100)); then
			echo "REPORTING_PREFETCH must be between 1 and 100" >&2
			exit 1
		fi
		if [[ ! "$reporting_outbox_batch_size" =~ ^[1-9][0-9]*$ ]] ||
			((reporting_outbox_batch_size > 500)); then
			echo "REPORTING_OUTBOX_BATCH_SIZE must be between 1 and 500" >&2
			exit 1
		fi
		if [[ ! "$reporting_outbox_poll_interval_ms" =~ ^[0-9]+$ ]] ||
			((reporting_outbox_poll_interval_ms < 100 ||
				reporting_outbox_poll_interval_ms > 60000)); then
			echo "REPORTING_OUTBOX_POLL_INTERVAL_MS must be between 100 and 60000" >&2
			exit 1
		fi
		if [[ ! "$reporting_outbox_retention_days" =~ ^[1-9][0-9]*$ ]] ||
			((reporting_outbox_retention_days > 365)); then
			echo "REPORTING_OUTBOX_RETENTION_DAYS must be between 1 and 365" >&2
			exit 1
		fi
		require_env_base64url_secret DATABASE_RESTORE_QUEUE_SECRET 43 128
		database_restore_queue_secret="$(
			get_env_value DATABASE_RESTORE_QUEUE_SECRET
		)"
		if [[ "$database_restore_queue_secret" == 'ci_database_restore_queue_secret_at_least_32_chars' ||
			"$database_restore_queue_secret" == "$(get_env_value NOTIFICATION_DELIVERY_INTERNAL_TOKEN)" ||
			"$database_restore_queue_secret" == "$(get_env_value CAMPAIGNS_INTERNAL_TOKEN)" ||
			"$database_restore_queue_secret" == "$(get_env_value REPORTING_INTERNAL_TOKEN)" ||
			"$database_restore_queue_secret" == "$(get_env_value PAYMENT_METHOD_ENCRYPTION_KEY)" ]]; then
			echo 'DATABASE_RESTORE_QUEUE_SECRET must be a unique production-only secret.' >&2
			exit 1
		fi
		unset database_restore_queue_secret
		validate_routine_database_restore_create_gate "$ENV_FILE" || exit 1
		database_restore_poll_interval_ms="$(
			get_env_value DATABASE_RESTORE_POLL_INTERVAL_MS
		)"
		database_restore_command_timeout_ms="$(
			get_env_value DATABASE_RESTORE_COMMAND_TIMEOUT_MS
		)"
		if [[ ! "$database_restore_poll_interval_ms" =~ ^[0-9]+$ ]] ||
			((database_restore_poll_interval_ms < 250 ||
				database_restore_poll_interval_ms > 60000)); then
			echo 'DATABASE_RESTORE_POLL_INTERVAL_MS must be between 250 and 60000.' >&2
			exit 1
		fi
		if [[ ! "$database_restore_command_timeout_ms" =~ ^[0-9]+$ ]] ||
			((database_restore_command_timeout_ms < 60000 ||
				database_restore_command_timeout_ms > 7200000)); then
			echo 'DATABASE_RESTORE_COMMAND_TIMEOUT_MS must be between 60000 and 7200000.' >&2
			exit 1
		fi
		assert_database_restore_admin_secret_file \
			CORE_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.core-postgres-temporary-admin-password"
		assert_database_restore_admin_secret_file \
			NOTIFICATION_DELIVERY_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.notification-delivery-postgres-admin-password"
		assert_database_restore_admin_secret_file \
			CAMPAIGNS_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.campaigns-postgres-admin-password"
		assert_database_restore_admin_secret_file \
			REPORTING_POSTGRES_ADMIN_PASSWORD_FILE \
			"$APP_ROOT/deploy/backend/.reporting-postgres-admin-password"
		for smtp_timeout_key in \
			SMTP_CONNECTION_TIMEOUT_MS \
			SMTP_GREETING_TIMEOUT_MS \
			SMTP_SOCKET_TIMEOUT_MS; do
			smtp_timeout_value="$(get_env_value "$smtp_timeout_key")"
			if [[ ! "$smtp_timeout_value" =~ ^[0-9]+$ ]] ||
				((smtp_timeout_value < 1000 || smtp_timeout_value > 60000)); then
				echo "$smtp_timeout_key must be between 1000 and 60000" >&2
				exit 1
			fi
		done
		assert_distinct_database_roles
		if [[ "$(get_env_value JWT_JWKS_URL)" != "http://127.0.0.1:4200/api/v1/auth/.well-known/jwks.json" ]]; then
			echo "Production JWT_JWKS_URL must use the loopback Auth endpoint" >&2
			exit 1
		fi
		for oauth_provider in google github yandex vk; do
			oauth_key="$(
				printf '%s' "$oauth_provider" |
					tr '[:lower:]' '[:upper:]'
			)_CALLBACK_URL"
			expected_oauth_callback="https://api.winwidget.ru/api/v1/auth/$oauth_provider/redirect"
			require_env_key "$oauth_key"
			if [[ "$(get_env_value "$oauth_key")" != "$expected_oauth_callback" ]]; then
				echo "$oauth_key must be $expected_oauth_callback" >&2
				exit 1
			fi
		done
		;;
	development)
		require_env_key "DATABASE_URL_DEVELOPMENT"
		require_env_key "YOOKASSA_SHOP_ID"
		require_env_key "YOOKASSA_SECRET_KEY"
		;;
	*)
		echo "Unsupported MODE in $ENV_FILE: $mode. Expected development or production." >&2
		exit 1
		;;
esac

jwt_access_ttl_seconds="$(get_env_value JWT_ACCESS_TTL_SECONDS)"
jwt_clock_tolerance_seconds="$(get_env_value JWT_CLOCK_TOLERANCE_SECONDS)"
if [[ ! "$jwt_access_ttl_seconds" =~ ^[0-9]+$ ]] ||
	((jwt_access_ttl_seconds < 300 || jwt_access_ttl_seconds > 1800)); then
	echo "JWT_ACCESS_TTL_SECONDS must be between 300 and 1800" >&2
	exit 1
fi
if [[ ! "$jwt_clock_tolerance_seconds" =~ ^[0-9]+$ ]] ||
	((jwt_clock_tolerance_seconds < 0 || jwt_clock_tolerance_seconds > 60)); then
	echo "JWT_CLOCK_TOLERANCE_SECONDS must be between 0 and 60" >&2
	exit 1
fi

target_project="$(get_env_value "COMPOSE_PROJECT_NAME" || true)"
if [[ "$target_project" != "winwidget" ]]; then
	echo "COMPOSE_PROJECT_NAME must be winwidget, got: ${target_project:-empty}" >&2
	exit 1
fi
assert_core_database_production_boundary
assert_notification_database_postgres_identity
assert_campaigns_database_postgres_identity
if [[ "$mode" == 'production' ]]; then
	prepare_database_restore_storage
fi
rabbitmq_vhost="$(get_env_value "RABBITMQ_VHOST" || true)"
if [[ "$rabbitmq_vhost" != "winwidget" ]]; then
	echo "RABBITMQ_VHOST must be winwidget, got: ${rabbitmq_vhost:-empty}" >&2
	exit 1
fi
rabbitmq_management_url="$(
	get_env_value "RABBITMQ_MANAGEMENT_URL" || true
)"
rabbitmq_management_url="${rabbitmq_management_url:-http://127.0.0.1:15672}"
if [[ "$rabbitmq_management_url" != "http://127.0.0.1:15672" ]]; then
	echo "RABBITMQ_MANAGEMENT_URL must use the loopback production endpoint" >&2
	exit 1
fi
rabbitmq_data_volume="$(get_env_value "RABBITMQ_DATA_VOLUME" || true)"
if ! docker volume inspect "$rabbitmq_data_volume" >/dev/null 2>&1; then
	echo "Verified RabbitMQ volume does not exist: $rabbitmq_data_volume" >&2
	echo "Determine the current /var/lib/rabbitmq volume before deployment; do not create a replacement blindly." >&2
	exit 1
fi
export COMPOSE_PROJECT_NAME="$target_project"
export RABBITMQ_DATA_VOLUME="$rabbitmq_data_volume"

rabbitmq_container_ids="$(
	docker ps -a \
		--filter label=com.docker.compose.service=rabbitmq \
		--format '{{.ID}}'
)"
matched_rabbitmq_containers=0
matched_rabbitmq_container_id=""
matched_rabbitmq_project=""
while IFS= read -r container_id; do
	[[ -n "$container_id" ]] || continue
	mounted_volume="$(
		docker inspect --format \
			'{{ range .Mounts }}{{ if eq .Destination "/var/lib/rabbitmq" }}{{ .Name }}{{ end }}{{ end }}' \
			"$container_id"
	)"
	if [[ "$mounted_volume" != "$rabbitmq_data_volume" ]]; then
		continue
	fi
	matched_rabbitmq_containers=$((matched_rabbitmq_containers + 1))
	matched_rabbitmq_container_id="$container_id"
	matched_rabbitmq_project="$(
		docker inspect --format \
			'{{ index .Config.Labels "com.docker.compose.project" }}' \
			"$container_id"
	)"
done <<<"$rabbitmq_container_ids"
if ((matched_rabbitmq_containers > 1)); then
	echo "More than one RabbitMQ container uses volume $rabbitmq_data_volume" >&2
	exit 1
fi
if [[ -n "$matched_rabbitmq_container_id" &&
	"$matched_rabbitmq_project" != "$target_project" ]]; then
	echo "RabbitMQ volume is attached to non-canonical Compose project: ${matched_rabbitmq_project:-unknown}" >&2
	echo "Resolve the stale project manually before deployment; automatic legacy cutover is not supported." >&2
	exit 1
fi

compose_target() {
	docker compose --project-name "$target_project" \
		--env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_notification_cutover() {
	docker compose --project-name "$NOTIFICATION_DELIVERY_CUTOVER_PROJECT" \
		--env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

routine_stop_services=(
	api-gateway
	campaigns-service
	api
	outbox-publisher
	integration-worker
	maintenance-worker
	database-restore-worker
	notification-delivery-worker
)
declare -A routine_stop_container_ids=()
reporting_cleanup_stop_recovery_active=false
# Remove this exact-image bootstrap after the first successful rollout verifies
# that the replacement API exits without Docker SIGKILL.
LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION="42c422ca4c2c3a8ce758a37773d6cb0e6b689db7"
LEGACY_API_SHUTDOWN_BOOTSTRAP_IMAGE_ID="sha256:e64d78b3dc511dde592641e979eb0b506b815f0e83c4eb943ac45b1780c3f554"
legacy_api_shutdown_bootstrap_observed=false

capture_routine_stop_containers() {
	local service
	local container_id

	routine_stop_container_ids=()
	for service in "${routine_stop_services[@]}"; do
		container_id="$(
			compose_target ps --status running -q "$service" \
				2>/dev/null || true
		)"
		if [[ -z "$container_id" && "$service" == 'database-restore-worker' &&
			-z "$(compose_target ps -a -q "$service" 2>/dev/null || true)" ]]; then
			continue
		fi
		if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
			echo "Exactly one running $service is required before the core migration boundary." >&2
			return 1
		fi
		routine_stop_container_ids["$service"]="$container_id"
	done
}

restore_routine_containers_after_failed_stop() {
	local service
	local container_id
	local running
	local recovery_failed=false
	local attempt
	local all_running

	echo "Restoring the exact pre-migration runtime after an unsafe stop." >&2
	for service in \
		reporting-service \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		database-restore-worker \
		notification-delivery-worker \
		campaigns-service \
		api \
		api-gateway; do
		container_id="${routine_stop_container_ids[$service]:-}"
		if [[ -z "$container_id" ]]; then
			continue
		fi
		running="$(
			docker inspect --format '{{.State.Running}}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$running" == "true" ]]; then
			continue
		fi
		if [[ "$running" != "false" ]] ||
			! docker start "$container_id" >/dev/null; then
			echo "Could not restart exact pre-migration container: $service" >&2
			recovery_failed=true
		fi
	done

	if [[ "$recovery_failed" == "true" ]]; then
		echo "CRITICAL: the exact pre-migration runtime could not be restored completely." >&2
		return 1
	fi

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		all_running=true
		for service in "${routine_stop_services[@]}"; do
			container_id="${routine_stop_container_ids[$service]:-}"
			if [[ -z "$container_id" ]]; then
				continue
			fi
			running="$(
				docker inspect --format '{{.State.Running}}' \
					"$container_id" 2>/dev/null || true
			)"
			if [[ "$running" != "true" ]]; then
				all_running=false
				break
			fi
		done
		if [[ "$all_running" == "true" ]] &&
			{ [[ -z "${routine_stop_container_ids[api]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[api-gateway]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$GATEWAY_READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[maintenance-worker]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$MAINTENANCE_READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[notification-delivery-worker]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$NOTIFICATION_DELIVERY_READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[campaigns-service]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$CAMPAIGNS_READINESS_URL" >/dev/null; } &&
			{ [[ -z "${routine_stop_container_ids[reporting-service]:-}" ]] ||
				curl -fsS --connect-timeout 2 --max-time 5 \
					"$REPORTING_READINESS_URL" >/dev/null; }; then
			if [[ -n "${routine_stop_container_ids[reporting-service]:-}" ]]; then
				reporting_require_rabbitmq_topology || {
					echo 'Restored Reporting runtime did not recreate the exact transitional topology.' >&2
					return 1
				}
			fi
			echo "Exact containers which were running at entry were restored; no Core cleanup migration was executed." >&2
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo "CRITICAL: the exact pre-migration runtime restarted but did not become healthy." >&2
	return 1
}

stop_routine_service_cleanly() {
	local service="$1"
	local timeout="$2"
	local container_id
	local stopped_state
	local legacy_api_identity
	local expected_legacy_api_identity

	container_id="${routine_stop_container_ids[$service]:-}"
	if [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
		echo "Captured container ID is invalid for $service." >&2
		return 1
	fi
	if ! docker stop --time "$timeout" "$container_id" >/dev/null; then
		echo "Could not stop $service before the core migration boundary." >&2
		return 1
	fi
	stopped_state="$(
		docker inspect --format \
			'{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}' \
			"$container_id" 2>/dev/null || true
	)"
	case "$stopped_state" in
	"exited|0|false|" | "exited|143|false|")
		return 0
		;;
	esac
	if [[ "$service" == "api" && "$stopped_state" == "exited|137|false|" ]]; then
		legacy_api_identity="$(
			docker inspect --format \
				'{{.Config.Image}}|{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
				"$container_id" 2>/dev/null || true
		)"
		expected_legacy_api_identity="winwidget-api:git-$LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION|$LEGACY_API_SHUTDOWN_BOOTSTRAP_IMAGE_ID|$LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION|winwidget|api"
		if [[ "$legacy_api_identity" == "$expected_legacy_api_identity" ]]; then
			legacy_api_shutdown_bootstrap_observed=true
			echo "Known legacy API image required SIGKILL; continuing only to the zero-session core database boundary." >&2
			return 0
		fi
	fi

	echo "$service did not stop cleanly: ${stopped_state:-unavailable}" >&2
	return 1
}

verify_core_database_sessions_drained() {
	local session_count

	if ! session_count="$(
		docker run --rm --network host \
			--env-file "$ENV_FILE" \
			--entrypoint node \
			"winwidget-api:$APP_VERSION" \
			-e '
const { PrismaClient } = require("@prisma/client");
const url = process.env.DATABASE_MIGRATION_URL_PRODUCTION;
if (!url) throw new Error("Core migration URL is missing");
const prisma = new PrismaClient({ datasources: { db: { url } } });
prisma.$queryRawUnsafe(
  `SELECT COUNT(*)::int AS count
   FROM pg_stat_activity
   WHERE datname = current_database()
     AND backend_type = $type$client backend$type$
     AND pid <> pg_backend_pid()`,
).then(rows => {
  process.stdout.write(String(rows[0]?.count ?? "invalid"));
}).finally(() => prisma.$disconnect());
'
	)"; then
		echo "Could not verify drained core PostgreSQL sessions." >&2
		return 1
	fi
	if [[ "$session_count" != "0" ]]; then
		echo "Core PostgreSQL still has $session_count other session(s); migration is blocked." >&2
		return 1
	fi

	if [[ "$legacy_api_shutdown_bootstrap_observed" == "true" ]]; then
		echo "Legacy API bootstrap accepted only after all other core sessions drained." >&2
	fi
	echo "Core PostgreSQL sessions drained."
}

stop_routine_topology_for_core_migration() {
	local service

	capture_routine_stop_containers || return 1
	for service in "${routine_stop_services[@]}"; do
		if [[ -z "${routine_stop_container_ids[$service]:-}" &&
			"$service" == 'database-restore-worker' ]]; then
			continue
		fi
		if stop_routine_service_cleanly "$service" 30; then
			continue
		fi
		restore_routine_containers_after_failed_stop || true
		return 1
	done
	if [[ "$mode" == 'production' ]]; then
		if ! prepare_database_restore_storage; then
			restore_routine_containers_after_failed_stop || true
			return 1
		fi
	fi
	if ! verify_core_database_sessions_drained; then
		restore_routine_containers_after_failed_stop || true
		return 1
	fi
}

stop_reporting_cleanup_topology_for_core_migration() {
	local migration_state="$1" previous_revision service container_id
	local container_state image_id image_revision identity compose_project compose_service
	local -a cleanup_services=(reporting-service "${routine_stop_services[@]}")

	[[ "$migration_state" == 'pending' || "$migration_state" == 'applied' ]] || return 1
	previous_revision="$(reporting_cutover_marker_value revision)" || return 1
	routine_stop_container_ids=()
	for service in "${cleanup_services[@]}"; do
		container_id="$(compose_target ps -a -q "$service" 2>/dev/null || true)"
		if [[ -z "$container_id" ]]; then
			if [[ "$service" == 'database-restore-worker' ||
				( "$service" == 'reporting-service' && "$migration_state" == 'applied' ) ]]; then
				continue
			fi
			echo "Reporting cleanup recovery requires one exact existing container for $service." >&2
			return 1
		fi
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
			echo "Reporting cleanup container identity is ambiguous for $service." >&2
			return 1
		}
		identity="$(docker inspect --format \
			'{{.State.Status}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
			"$container_id" 2>/dev/null || true)"
		IFS='|' read -r container_state image_id compose_project compose_service <<<"$identity"
		[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
			"$compose_project" == "$target_project" && "$compose_service" == "$service" ]] || {
			echo "Reporting cleanup found an untrusted container identity for $service." >&2
			return 1
		}
		image_revision="$(docker image inspect --format \
			'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
			"$image_id" 2>/dev/null || true)"
		if [[ ! "$image_revision" =~ ^[0-9a-f]{40}$ ]] ||
			! git -C "$server_root" cat-file -e \
				"$image_revision^{commit}" 2>/dev/null ||
			! git -C "$server_root" merge-base --is-ancestor \
				"$image_revision" "$APP_REVISION"; then
			echo "Reporting cleanup found an unknown or divergent image for $service." >&2
			return 1
		fi
		if [[ "$migration_state" == 'pending' ]]; then
			[[ "$image_revision" != "$APP_REVISION" &&
				( "$service" != 'reporting-service' || "$image_revision" == "$previous_revision" ) ]] || {
				echo "Pending Reporting cleanup found a non-rollback image for $service." >&2
				return 1
			}
		elif [[ "$service" == 'reporting-service' ]]; then
			[[ "$image_revision" == "$previous_revision" ||
				"$image_revision" == "$APP_REVISION" ]] || {
				echo 'Applied cleanup found a Reporting image outside the pinned old/new boundary.' >&2
				return 1
			}
		fi
		case "$container_state" in
		running | restarting)
			routine_stop_container_ids["$service"]="$container_id"
			stop_routine_service_cleanly "$service" 30 || return 1
			;;
		exited)
			;;
		created)
			[[ "$migration_state" == 'applied' && "$image_revision" == "$APP_REVISION" ]] || {
				echo "Pending cleanup cannot trust a merely created container for $service." >&2
				return 1
			}
			;;
		*)
			echo "Reporting cleanup found an unsafe container state for $service: ${container_state:-unknown}." >&2
			return 1
			;;
		esac
	done
	if [[ "$mode" == 'production' ]]; then
		prepare_database_restore_storage || return 1
	fi
	verify_core_database_sessions_drained
}

recover_reporting_cleanup_stop_on_exit() {
	local status=$? current_state='unsafe'
	trap - EXIT INT TERM
	if [[ "$reporting_cleanup_stop_recovery_active" != 'true' ]]; then
		exit "$status"
	fi
	set +e
	current_state="$(reporting_cutover_core_cleanup_migration_state "$APP_REVISION" 2>/dev/null)"
	case "$current_state" in
	pending)
		echo 'Reporting cleanup stopped before the destructive migration committed; restoring only the exact containers which were running at entry.' >&2
		restore_routine_containers_after_failed_stop || true
		;;
	applied)
		echo 'Reporting cleanup migration is applied; old Core writers will not be restored. Retry the exact cleanup revision to continue forward.' >&2
		;;
	*)
		echo 'Reporting cleanup migration state is ambiguous; all Core writers remain stopped for reviewed recovery.' >&2
		;;
	esac
	exit "$status"
}

notification_cutover_container_id() {
	local service="$1"
	local container_id

	container_id="$(
		compose_notification_cutover ps -a -q "$service" 2>/dev/null || true
	)"
	if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
		echo "Saved forward cutover service does not have exactly one container: $service" >&2
		return 1
	fi
	printf '%s\n' "$container_id"
}

verify_saved_notification_cutover_containers() {
	local expected_revision="$1"
	local service
	local container_id
	local image_revision
	local restart_count

	for service in "${notification_cutover_candidate_services[@]}"; do
		container_id="$(
			notification_cutover_container_id "$service"
		)" || return 1
		image_revision="$(
			docker inspect \
				--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$image_revision" != "$expected_revision" ]]; then
			echo "Saved forward cutover service has an unexpected image revision: $service" >&2
			return 1
		fi
		restart_count="$(
			docker inspect --format '{{ .RestartCount }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$restart_count" != "0" ]]; then
			echo "Saved forward cutover service restarted before recovery: $service restartCount=${restart_count:-unknown}" >&2
			return 1
		fi
	done
}

start_notification_cutover_services() {
	local service
	local container_id
	local running

	for service in "$@"; do
		container_id="$(
			notification_cutover_container_id "$service"
		)" || return 1
		running="$(
			docker inspect --format '{{ .State.Running }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$running" == "true" ]]; then
			continue
		fi
		if [[ "$running" != "false" ]]; then
			echo "Saved forward cutover service has an unreadable state: $service" >&2
			return 1
		fi
		if ! docker start "$container_id" >/dev/null; then
			echo "Saved forward cutover service could not be started: $service" >&2
			return 1
		fi
	done
}

stop_notification_cutover_services() {
	local timeout="$1"
	local allow_missing="$2"
	shift 2
	local service
	local container_id
	local running

	for service in "$@"; do
		container_id="$(
			compose_notification_cutover ps -a -q "$service" \
				2>/dev/null || true
		)"
		if [[ -z "$container_id" && "$allow_missing" == "true" ]]; then
			continue
		fi
		if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
			echo "Saved forward cutover service does not have exactly one container: $service" >&2
			return 1
		fi
		running="$(
			docker inspect --format '{{ .State.Running }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$running" == "false" ]]; then
			continue
		fi
		if [[ "$running" != "true" ]]; then
			echo "Saved forward cutover service has an unreadable state: $service" >&2
			return 1
		fi
		if ! docker stop --timeout "$timeout" "$container_id" >/dev/null; then
			echo "Saved forward cutover service could not be stopped: $service" >&2
			return 1
		fi
	done
}

remove_notification_cutover_services() {
	local service
	local container_id
	local running
	local container_ids=()

	for service in "$@"; do
		container_id="$(
			compose_notification_cutover ps -a -q "$service" \
				2>/dev/null || true
		)"
		if [[ -z "$container_id" ]]; then
			continue
		fi
		if [[ "$container_id" == *$'\n'* ]]; then
			echo "Saved forward cutover service has multiple containers: $service" >&2
			return 1
		fi
		running="$(
			docker inspect --format '{{ .State.Running }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$running" != "false" ]]; then
			echo "Saved forward cutover service must be stopped before removal: $service" >&2
			return 1
		fi
		container_ids+=("$container_id")
	done

	if [[ ${#container_ids[@]} -gt 0 ]]; then
		docker rm "${container_ids[@]}" >/dev/null
	fi
}

verify_notification_delivery_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$NOTIFICATION_DELIVERY_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of [
	"dist/src/main.js",
	"prisma/schema.prisma",
]) {
	fs.accessSync(required);
}
require("@prisma/notification-delivery-client");
for (const forbidden of [
	"dist/src/app.module.js",
	"dist/src/messaging/notification-delivery-client.service.js",
	"dist/src/outbox-publisher-main.js",
	"public/widgets",
]) {
	if (fs.existsSync(forbidden)) {
		throw new Error(
			`Notification Delivery image contains monolith artifact: ${forbidden}`,
		);
	}
}
process.stdout.write("Standalone Notification Delivery image artifact verified\n");
	'
}

verify_campaigns_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$CAMPAIGNS_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of ["dist/src/main.js", "prisma/schema.prisma"]) {
	fs.accessSync(required);
}
require("@prisma/campaigns-client");
for (const forbidden of [
	"dist/src/app.module.js",
	"dist/src/mailing/mailing.service.js",
	"dist/src/outbox-publisher-main.js",
	"public/widgets",
]) {
	if (fs.existsSync(forbidden)) {
		throw new Error(`Campaigns image contains monolith artifact: ${forbidden}`);
	}
}
process.stdout.write("Standalone Campaigns image artifact verified\n");
	'
}

verify_reporting_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$REPORTING_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of ["dist/src/main.js", "prisma/schema.prisma"]) {
	fs.accessSync(required);
}
require("@prisma/reporting-client");
for (const forbidden of [
	"dist/src/app.module.js",
	"dist/src/statistics/statistics.service.js",
	"dist/src/outbox-publisher-main.js",
	"public/widgets",
]) {
	if (fs.existsSync(forbidden)) {
		throw new Error(`Reporting image contains monolith artifact: ${forbidden}`);
	}
}
process.stdout.write("Standalone Reporting image artifact verified\n");
		'
}

verify_database_restore_image_artifact() {
	docker run --rm --network none \
		--entrypoint node \
		"$DATABASE_RESTORE_IMAGE" \
		-e '
const fs = require("node:fs");
for (const required of [
	"dist/src/database-restore-worker-main.js",
	"prisma/migrations",
	"apps/notification-delivery/prisma/migrations",
	"apps/campaigns/prisma/migrations",
	"apps/reporting/prisma/migrations",
	"/usr/bin/pg_dump",
	"/usr/bin/pg_restore",
	"/usr/bin/psql",
	"/usr/bin/flock",
	"/usr/local/bin/database-restore-entrypoint.sh",
]) {
	fs.accessSync(required);
}
process.stdout.write("Isolated database restore worker image artifact verified\n");
		'
}

validate_campaigns_database_urls() {
	printf '%s\n%s\n%s\n' \
		"$(get_env_value CAMPAIGNS_DATABASE_URL)" \
		"$(get_env_value CAMPAIGNS_MIGRATION_DATABASE_URL)" \
		"$(get_env_value CAMPAIGNS_BACKUP_URL)" |
		docker run --rm -i --network none \
			-e "EXPECTED_PORT=$(get_env_value CAMPAIGNS_POSTGRES_PORT)" \
			--entrypoint node "$CAMPAIGNS_IMAGE" -e '
const { readFileSync } = require("node:fs");
const urls = readFileSync(0, "utf8").trim().split("\n").map(value => new URL(value));
const expectedUsers = [
	"winwidget_campaigns_runtime",
	"winwidget_campaigns_migration",
	"winwidget_campaigns_backup",
];
for (const [index, url] of urls.entries()) {
	const user = decodeURIComponent(url.username);
	const password = decodeURIComponent(url.password);
	if (
		url.protocol !== "postgresql:" ||
		user !== expectedUsers[index] ||
		url.hostname !== "127.0.0.1" ||
		url.port !== process.env.EXPECTED_PORT ||
		url.pathname !== "/winwidget_campaigns" ||
		url.searchParams.get("schema") !== "campaigns" ||
		password.length < 16 ||
		/[\0\r\n]/.test(password)
	) {
		throw new Error(`Invalid Campaigns database URL boundary at index ${index}`);
	}
}
process.stdout.write("Campaigns runtime, migration and backup URL boundaries verified\n");
'
}

initialize_notification_database_lifecycle_guard \
	true \
	"a routine full deployment" \
	identity-if-present

compose_target \
	--profile migration \
	--profile notification-delivery-migration \
	--profile campaigns-migration \
	--profile reporting-migration \
	config --quiet
compose_target build \
	api \
	api-gateway \
	maintenance-worker \
	database-restore-worker \
	notification-delivery-worker \
	campaigns-service \
	reporting-service
verify_notification_delivery_image_artifact
verify_campaigns_image_artifact
verify_reporting_image_artifact
verify_database_restore_image_artifact
validate_campaigns_database_urls
assert_campaigns_contract_migration_applied_for_routine_deploy
initialize_campaigns_database_lifecycle_guard \
	"a routine full deployment" identity-if-present
reporting_initialize_database_guard "a routine full deployment" \
	identity-if-present

validate_notification_database_urls() {
	local parser_image="$1"
	local runtime_url
	local migration_url
	local backup_url

	runtime_url="$(get_env_value NOTIFICATION_DELIVERY_DATABASE_URL)"
	migration_url="$(
		get_env_value NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION
	)"
	backup_url="$(get_env_value NOTIFICATION_DELIVERY_BACKUP_URL)"

	if ! printf '%s\n%s\n%s\n' "$runtime_url" "$migration_url" "$backup_url" |
		docker run --rm -i --network none \
			-e "NOTIFICATION_DATABASE_CUTOVER_ACTIVE=$notification_database_cutover_active" \
			-e "NOTIFICATION_DATABASE_TARGET_PORT=$(get_env_value NOTIFICATION_DELIVERY_POSTGRES_PORT)" \
			--entrypoint node \
			"$parser_image" \
			-e '
const { readFileSync } = require("node:fs");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};
const input = readFileSync(0, "utf8");
const lines = input.endsWith("\n")
	? input.slice(0, -1).split("\n")
	: input.split("\n");
if (lines.length !== 3 || lines.some(value => !value)) {
	fail("Notification delivery PostgreSQL URLs are missing or contain a newline");
}

const parse = (value, label) => {
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
	let database;
	try {
		username = decodeURIComponent(url.username);
		database = decodeURIComponent(url.pathname.slice(1));
	} catch {
		fail(`${label} contains invalid percent-encoding`);
	}
	if (
		!username ||
		!/^[A-Za-z0-9._-]+$/.test(username) ||
		!database ||
		database.includes("/")
	) {
		fail(`${label} contains an invalid role or database name`);
	}

	const schemas = url.searchParams.getAll("schema");
	if (
		schemas.length !== 1 ||
		schemas[0] !== "notification_delivery"
	) {
		fail(`${label} must contain exactly schema=notification_delivery`);
	}

	const ssl = [...url.searchParams.entries()]
		.filter(([key]) => {
			const normalized = key.toLowerCase();
			return (
				normalized.startsWith("ssl") ||
				normalized === "channel_binding"
			);
		})
		.map(([key, entryValue]) => [
			key.toLowerCase(),
			entryValue,
		])
		.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
			leftKey === rightKey
				? leftValue.localeCompare(rightValue)
				: leftKey.localeCompare(rightKey),
		);

	return {
		protocol: url.protocol,
		host: url.hostname.toLowerCase(),
		port: url.port || "5432",
		database,
		username,
		ssl: JSON.stringify(ssl),
	};
};

const runtime = parse(lines[0], "NOTIFICATION_DELIVERY_DATABASE_URL");
const migration = parse(
	lines[1],
	"NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION",
);
const backup = parse(lines[2], "NOTIFICATION_DELIVERY_BACKUP_URL");
const targetPort = process.env.NOTIFICATION_DATABASE_TARGET_PORT;
const cutoverActive =
	process.env.NOTIFICATION_DATABASE_CUTOVER_ACTIVE === "true";
const targetsCanonicalEndpoint =
	runtime.host === "127.0.0.1" && runtime.port === targetPort;
const targetsLocalEndpoint =
	["127.0.0.1", "localhost", "[::1]"].includes(runtime.host) &&
	runtime.port === targetPort;
const targetsLocalDatabase =
	targetsCanonicalEndpoint &&
	runtime.database === "winwidget_notification_delivery";
if (cutoverActive && !targetsLocalDatabase) {
	fail(
		"After database cutover, Notification delivery PostgreSQL URLs must target 127.0.0.1, the canonical port and database winwidget_notification_delivery",
	);
}
if (
	cutoverActive &&
	runtime.ssl !== JSON.stringify([["sslmode", "disable"]])
) {
	fail(
		"After database cutover, Notification delivery PostgreSQL URLs must contain exactly sslmode=disable",
	);
}
if (
	!cutoverActive &&
	(
		targetsLocalEndpoint ||
		runtime.database === "winwidget_notification_delivery"
	)
) {
	fail(
		"The local Notification Delivery database cannot be selected before the durable database cutover marker",
	);
}
for (const candidate of [migration, backup]) {
	for (const key of ["protocol", "host", "port", "database", "ssl"]) {
		if (runtime[key] === candidate[key]) continue;
		fail(
			"Notification delivery runtime, migration and backup URLs must target the same protocol, host, port, database and SSL settings",
		);
	}
}
if (new Set([runtime.username, migration.username, backup.username]).size !== 3) {
	fail(
		"Notification delivery runtime, migration and backup URLs must use distinct roles",
	);
}
process.stdout.write("Notification delivery PostgreSQL URL structure validated\n");
'; then
		exit 1
	fi
}

normalize_csv() {
	tr ',' '\n' <<<"$1" |
		sed 's/^[[:space:]]*//;s/[[:space:]]*$//' |
		sed '/^$/d' |
		LC_ALL=C sort -u |
		paste -sd, -
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
				found = 1
				exit
			}
			END { exit(found ? 0 : 1) }
		'
}

validate_notification_cutover_marker() {
	local marker_path="${1:-$NOTIFICATION_DELIVERY_CUTOVER_MARKER}"
	local marker_mode
	local marker_owner

	if [[ ! -f "$marker_path" ||
		-L "$marker_path" ]]; then
		return 1
	fi
	marker_mode="$(stat -c '%a' "$marker_path")"
	marker_owner="$(stat -c '%u' "$marker_path")"
	if [[ "$marker_mode" != "600" ||
		"$marker_owner" != "$(id -u)" ]]; then
		return 1
	fi
	awk '
		NR == 1 && $0 ~ /^revision=[0-9a-f]{40}$/ { revision = 1; next }
		NR == 2 &&
			$0 ~ /^created_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/ {
			created = 1
			next
		}
		{ invalid = 1 }
		END {
			exit(revision && created && NR == 2 && !invalid ? 0 : 1)
		}
	' "$marker_path"
}

validate_notification_database_urls "winwidget-api:$APP_VERSION"

if ! validate_notification_cutover_marker \
	"$NOTIFICATION_DELIVERY_INITIAL_CUTOVER_MARKER"; then
	echo "The verified initial Notification Delivery cutover marker is required before moving Telegram payment/limit delivery." >&2
	echo "Restore $NOTIFICATION_DELIVERY_INITIAL_CUTOVER_MARKER from the completed first cutover; do not infer ownership automatically." >&2
	exit 1
fi

notification_migration_files="$(
	git -C "$server_root" ls-files \
		'apps/notification-delivery/prisma/migrations/*/migration.sql'
)"
if [[ -z "$notification_migration_files" ]]; then
	echo "No versioned notification delivery migration was found." >&2
	exit 1
fi
while IFS= read -r notification_migration_file; do
	[[ -n "$notification_migration_file" ]] || continue
	if [[ "$notification_migration_file" == \
		"apps/notification-delivery/prisma/migrations/20260727000000_init_notification_delivery/migration.sql" ]]; then
		if grep -Eiq \
			'(^|[[:space:]])CREATE[[:space:]]+(SCHEMA|EXTENSION)([[:space:]]|$)' \
			"$server_root/$notification_migration_file"; then
			echo "Initial Notification Delivery migration must use the pre-provisioned schema without database CREATE privileges." >&2
			exit 1
		fi
		continue
	fi
	# Review CHECK replacements per immutable migration so future changes fail closed.
	expected_notification_constraint_replacements=""
	case "$notification_migration_file" in
		apps/notification-delivery/prisma/migrations/20260728000000_expand_notification_delivery_telegram_kinds/migration.sql)
			expected_notification_constraint_replacements="DELIVERY_RECEIPTS_IDENTITY_CHECK,DELIVERY_FAILURES_CLASSIFICATION_CHECK,CONTROL_ACTIONS_IDENTITY_CHECK,NOTIFICATION_OUTBOX_EVENTS_IDENTITY_CHECK"
			;;
		apps/notification-delivery/prisma/migrations/20260730020000_allow_campaign_delivery_outcome_v2/migration.sql)
			expected_notification_constraint_replacements="NOTIFICATION_OUTBOX_EVENTS_IDENTITY_CHECK"
			;;
	esac
	if ! awk \
		-v expected_replacements="$expected_notification_constraint_replacements" '
		BEGIN {
			RS = ";"
			failed = 0
			constraint_names[1] = "DELIVERY_RECEIPTS_IDENTITY_CHECK"
			constraint_names[2] = "DELIVERY_FAILURES_CLASSIFICATION_CHECK"
			constraint_names[3] = "CONTROL_ACTIONS_IDENTITY_CHECK"
			constraint_names[4] = "NOTIFICATION_OUTBOX_EVENTS_IDENTITY_CHECK"
			table_names[1] = "DELIVERY_RECEIPTS"
			table_names[2] = "DELIVERY_FAILURES"
			table_names[3] = "CONTROL_ACTIONS"
			table_names[4] = "OUTBOX_EVENTS"
			expected_count = split(expected_replacements, expected_names, ",")
			for (i = 1; i <= expected_count; i += 1) {
				if (expected_names[i] != "") {
					expected[expected_names[i]] = 1
				}
			}
		}
		{
			statement = $0
			gsub(/--[^\n]*/, "", statement)
			gsub(/[[:space:]]+/, " ", statement)
			sub(/^[[:space:]]+/, "", statement)
			sub(/[[:space:]]+$/, "", statement)
			if (statement == "") next
			upper = toupper(statement)
			if (upper == "BEGIN") {
				transaction_begin += 1
				next
			}
			if (upper == "COMMIT") {
				transaction_commit += 1
				next
			}
			if (upper ~ /^CREATE (TYPE|TABLE|INDEX|UNIQUE INDEX) / || upper ~ /^ALTER TYPE .* ADD VALUE /) next
			additive_column = upper ~ /^ALTER TABLE .* ADD COLUMN /
			additive_column = additive_column && upper !~ / NOT NULL/
			additive_column = additive_column && upper !~ / DEFAULT /
			additive_column = additive_column && upper !~ / UNIQUE/
			additive_column = additive_column && upper !~ / PRIMARY KEY/
			additive_column = additive_column && upper !~ / REFERENCES /
			additive_column = additive_column && upper !~ / CHECK[[:space:]]*\(/
			additive_column = additive_column && upper !~ / GENERATED /
			additive_column = additive_column && upper !~ / IDENTITY/
			if (additive_column) next
			accepted_replacement = 0
			for (i = 1; i <= 4; i += 1) {
				name = constraint_names[i]
				table_name = table_names[i]
				pattern = "^ALTER TABLE \"NOTIFICATION_DELIVERY\"\\.\"" table_name "\" DROP CONSTRAINT \"" name "\", ADD CONSTRAINT \"" name "\" CHECK[[:space:]]*\\("
				candidate = upper
				constraint_replacement = candidate ~ pattern
				constraint_replacement = constraint_replacement && gsub(/DROP CONSTRAINT/, "", candidate) == 1
				constraint_replacement = constraint_replacement && gsub(/ADD CONSTRAINT/, "", candidate) == 1
				constraint_replacement = constraint_replacement && gsub(/ALTER TABLE/, "", candidate) == 1
				constraint_replacement = constraint_replacement && candidate !~ /( CASCADE| DROP COLUMN| TRUNCATE | DELETE FROM | UPDATE | INSERT INTO | CREATE )/
				if (constraint_replacement) {
					if (!expected[name]) failed = 1
					replaced[name] += 1
					replaced_constraints = 1
					accepted_replacement = 1
					break
				}
			}
			if (accepted_replacement) next
			failed = 1
		}
		END {
			for (i = 1; i <= 4; i += 1) {
				name = constraint_names[i]
				required_replacements = expected[name] ? 1 : 0
				if (replaced[name] != required_replacements) failed = 1
			}
			invalid_transaction = transaction_begin != transaction_commit
			invalid_transaction = invalid_transaction || transaction_begin > 1
			invalid_transaction = invalid_transaction || transaction_commit > 1
			invalid_transaction = invalid_transaction || (transaction_begin && !replaced_constraints)
			invalid_transaction = invalid_transaction || (replaced_constraints && (transaction_begin != 1 || transaction_commit != 1))
			if (invalid_transaction) failed = 1
			exit(failed ? 1 : 0)
		}
	' "$server_root/$notification_migration_file"; then
		echo "Notification delivery migration is not provably additive: $notification_migration_file" >&2
		echo "Production notification migrations must follow the expand/contract policy." >&2
		exit 1
	fi
done <<<"$notification_migration_files"

notification_delivery_first_cutover=false
notification_forward_candidate_active=false
notification_forward_candidate_needs_recovery=false
notification_cutover_marker_revision=""
notification_cutover_candidate_services=(
	outbox-publisher
	integration-worker
	maintenance-worker
	notification-delivery-worker
	api
	api-gateway
)
notification_cutover_pre_marker_services=(
	integration-worker
	maintenance-worker
	notification-delivery-worker
	api
)
notification_delivery_container_ids="$(
	compose_target ps -a -q notification-delivery-worker 2>/dev/null || true
)"
running_notification_delivery_container_id="$(
	compose_target ps --status running -q notification-delivery-worker \
		2>/dev/null || true
)"
current_integration_container_id="$(
	compose_target ps --status running -q integration-worker 2>/dev/null || true
)"
notification_cutover_candidate_ids="$(
	compose_notification_cutover ps -a -q \
		"${notification_cutover_candidate_services[@]}" 2>/dev/null || true
)"
narrow_integration_kinds="$(
	normalize_csv \
		"$(reporting_expected_integration_worker_kinds)"
)"
pre_reporting_narrow_integration_kinds="$(
	normalize_csv \
		"webhook,bitrix24,amo-crm,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,campaign-admin-audit,auto-renewal"
)"
broad_integration_kinds="$(
	normalize_csv \
		"webhook,bitrix24,amo-crm,payment-telegram,limit-telegram,daily-summary-telegram"
)"
legacy_notification_delivery_kinds="$(
	normalize_csv \
		"email,telegram,payment-email,limit-email"
)"
expanded_notification_delivery_kinds="$(
	normalize_csv \
		"email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram"
)"

if [[ -e "$NOTIFICATION_DELIVERY_CUTOVER_MARKER" ||
	-L "$NOTIFICATION_DELIVERY_CUTOVER_MARKER" ]]; then
	if ! validate_notification_cutover_marker; then
		echo "Notification delivery cutover marker has invalid type, ownership, mode or content." >&2
		exit 1
	fi
	notification_cutover_marker_revision="$(
		sed -n 's/^revision=//p' "$NOTIFICATION_DELIVERY_CUTOVER_MARKER"
	)"

	candidate_topology_complete=true
	for service in "${notification_cutover_candidate_services[@]}"; do
		candidate_service_id="$(
			compose_notification_cutover ps --status running -q "$service" \
				2>/dev/null || true
		)"
		if [[ -z "$candidate_service_id" ||
			"$candidate_service_id" == *$'\n'* ]]; then
			candidate_topology_complete=false
			break
		fi
	done
	if [[ "$candidate_topology_complete" == "true" ]]; then
		if ! verify_saved_notification_cutover_containers \
			"$notification_cutover_marker_revision"; then
			echo "Running forward cutover topology does not match its durable marker." >&2
			exit 1
		fi
		if [[ -n "$current_integration_container_id" ]]; then
			echo "Both canonical and forward-candidate integration workers are running after cutover." >&2
			exit 1
		fi
		candidate_integration_container_id="$(
			compose_notification_cutover ps --status running -q integration-worker
		)"
		candidate_integration_kinds="$(
			container_env_value \
				"$candidate_integration_container_id" \
				INTEGRATION_WORKER_KINDS || true
		)"
		if [[ "$(normalize_csv "$candidate_integration_kinds")" != "$narrow_integration_kinds" ]]; then
			echo "Forward cutover topology has an unexpected integration kind set." >&2
			exit 1
		fi
		candidate_notification_container_id="$(
			compose_notification_cutover ps --status running -q \
				notification-delivery-worker
		)"
		candidate_notification_kinds="$(
			container_env_value \
				"$candidate_notification_container_id" \
				NOTIFICATION_DELIVERY_KINDS || true
		)"
		if [[ "$(normalize_csv "$candidate_notification_kinds")" != "$expanded_notification_delivery_kinds" ]]; then
			echo "Forward cutover topology has an unexpected Notification Delivery kind set." >&2
			exit 1
		fi
		notification_forward_candidate_active=true
	elif [[ -n "$notification_cutover_candidate_ids" ]]; then
		if ! verify_saved_notification_cutover_containers \
			"$notification_cutover_marker_revision"; then
			echo "Cutover marker exists, but the saved forward-candidate topology is incomplete or has drifted." >&2
			echo "Do not remove its containers; repair the exact saved topology before retrying." >&2
			exit 1
		fi
		canonical_cutover_service_ids="$(
			compose_target ps --status running -q \
				"${notification_cutover_candidate_services[@]}" \
				2>/dev/null || true
		)"
		if [[ -n "$canonical_cutover_service_ids" ]]; then
			echo "Cutover marker exists with an incomplete saved topology and running canonical services." >&2
			echo "Refusing automatic recovery while service ownership is ambiguous." >&2
			exit 1
		fi
		candidate_integration_container_id="$(
			notification_cutover_container_id integration-worker
		)"
		candidate_integration_kinds="$(
			container_env_value \
				"$candidate_integration_container_id" \
				INTEGRATION_WORKER_KINDS || true
		)"
		if [[ "$(normalize_csv "$candidate_integration_kinds")" != "$narrow_integration_kinds" ]]; then
			echo "Saved forward cutover integration worker has an unexpected kind set." >&2
			exit 1
		fi
		candidate_notification_container_id="$(
			notification_cutover_container_id notification-delivery-worker
		)"
		candidate_notification_kinds="$(
			container_env_value \
				"$candidate_notification_container_id" \
				NOTIFICATION_DELIVERY_KINDS || true
		)"
		if [[ "$(normalize_csv "$candidate_notification_kinds")" != "$expanded_notification_delivery_kinds" ]]; then
			echo "Saved forward cutover Notification Delivery worker has an unexpected kind set." >&2
			exit 1
		fi
		notification_forward_candidate_active=true
		notification_forward_candidate_needs_recovery=true
		echo "Saved forward cutover topology is incomplete but exact and recoverable."
	else
		if [[ -z "$running_notification_delivery_container_id" ||
			"$running_notification_delivery_container_id" == *$'\n'* ||
			-z "$current_integration_container_id" ||
			"$current_integration_container_id" == *$'\n'* ]]; then
			echo "Cutover marker exists, but neither canonical nor saved forward topology is complete." >&2
			echo "Resolve the topology manually; forward-only cutover state cannot be inferred safely." >&2
			exit 1
		fi
		current_integration_kinds="$(
			container_env_value \
				"$current_integration_container_id" \
				INTEGRATION_WORKER_KINDS || true
		)"
		current_integration_kinds_normalized="$(
			normalize_csv "$current_integration_kinds"
		)"
		if ! reporting_cutover_worker_kinds_allowed \
			"$current_integration_kinds_normalized" \
			"$narrow_integration_kinds" \
			"$pre_reporting_narrow_integration_kinds"; then
			echo "Cutover marker exists, but the live integration worker still owns an unexpected kind set." >&2
			echo "Do not attempt an automatic legacy rollback after the cutover marker." >&2
			exit 1
		fi
		if [[ "$current_integration_kinds_normalized" != "$narrow_integration_kinds" ]]; then
			echo 'Allowing the pre-Reporting integration worker only for its one-way audit-consumer bootstrap.'
		fi
		current_notification_delivery_kinds="$(
			container_env_value \
				"$running_notification_delivery_container_id" \
				NOTIFICATION_DELIVERY_KINDS || true
		)"
		if [[ "$(normalize_csv "$current_notification_delivery_kinds")" != "$expanded_notification_delivery_kinds" ]]; then
			echo "Cutover marker exists, but the live Notification Delivery worker has an unexpected kind set." >&2
			exit 1
		fi
	fi
else
	if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
		reporting_cutover_validate_marker || {
			echo 'Reporting cutover marker is invalid while Notification Delivery marker is missing.' >&2
			exit 1
		}
		echo 'Notification Delivery marker is missing after the Reporting cutover started.' >&2
		echo 'Routine deploy must not replay the historical provider cutover or recreate legacy Reporting topology.' >&2
		exit 1
	fi
	if [[ -n "$notification_cutover_candidate_ids" ]]; then
		echo "Forward cutover containers exist without the durable marker." >&2
		echo "Restore the exact legacy containers or remove only the verified stale cutover project." >&2
		exit 1
	fi
	if [[ -z "$running_notification_delivery_container_id" ||
		"$running_notification_delivery_container_id" == *$'\n'* ||
		"$notification_delivery_container_ids" == *$'\n'* ]]; then
		echo "Exactly one running canonical Notification Delivery worker is required before the Telegram ownership cutover." >&2
		exit 1
	fi
	if [[ -z "$current_integration_container_id" ||
		"$current_integration_container_id" == *$'\n'* ]]; then
		echo "Exactly one running v1 integration worker is required before the Telegram cutover." >&2
		exit 1
	fi
	current_integration_kinds="$(
		container_env_value \
			"$current_integration_container_id" \
			INTEGRATION_WORKER_KINDS || true
	)"
	if [[ "$(normalize_csv "$current_integration_kinds")" != "$broad_integration_kinds" ]]; then
		echo "Telegram cutover marker is missing and the live integration worker is not the exact v1 owner." >&2
		echo "Refusing to guess whether a previous cutover partially completed." >&2
		exit 1
	fi
	current_notification_delivery_kinds="$(
		container_env_value \
			"$running_notification_delivery_container_id" \
			NOTIFICATION_DELIVERY_KINDS || true
	)"
	if [[ "$(normalize_csv "$current_notification_delivery_kinds")" != "$legacy_notification_delivery_kinds" ]]; then
		echo "Telegram cutover marker is missing and the live Notification Delivery worker is not the exact four-kind v1 owner." >&2
		exit 1
	fi
	current_integration_rabbit_url="$(
		container_env_value \
			"$current_integration_container_id" \
			RABBITMQ_URL || true
	)"
	current_outbox_container_id="$(
		compose_target ps --status running -q outbox-publisher 2>/dev/null || true
	)"
	if [[ -z "$current_outbox_container_id" ||
		"$current_outbox_container_id" == *$'\n'* ]]; then
		echo "Exactly one running v1 Outbox publisher is required before the Telegram cutover." >&2
		exit 1
	fi
	current_outbox_rabbit_url="$(
		container_env_value \
			"$current_outbox_container_id" \
			RABBITMQ_URL || true
	)"
	if [[ "$current_integration_rabbit_url" != "$(get_env_value RABBITMQ_INTEGRATION_WORKER_URL)" ||
		"$current_outbox_rabbit_url" != "$(get_env_value RABBITMQ_PUBLISHER_URL)" ]]; then
		echo "First cutover cannot rotate the live legacy integration or Outbox RabbitMQ credentials." >&2
		echo "Deploy the credential rotation separately, then retry the full notification cutover." >&2
		exit 1
	fi
	notification_delivery_first_cutover=true
fi

if [[ "$notification_forward_candidate_active" == "true" ]]; then
	if ! git -C "$server_root" cat-file -e \
		"${notification_cutover_marker_revision}^{commit}" 2>/dev/null; then
		echo "The saved forward cutover revision is not available in this checkout." >&2
		echo "Fetch the marker revision before attempting canonical handoff." >&2
		exit 1
	fi
	if ! git -C "$server_root" merge-base --is-ancestor \
		"$notification_cutover_marker_revision" "$deploy_revision"; then
		echo "The current revision is not a descendant of the saved forward cutover revision." >&2
		echo "Canonicalize the marker revision before deploying a divergent history." >&2
		exit 1
	fi
	forward_recovery_schema_changes="$(
		git -C "$server_root" diff --name-only \
			"$notification_cutover_marker_revision" "$deploy_revision" -- \
			prisma/migrations \
			apps/notification-delivery/prisma/migrations
	)"
	if [[ -n "$forward_recovery_schema_changes" ]]; then
		echo "A saved forward topology cannot protect a deployment that changes PostgreSQL migrations." >&2
		echo "Canonicalize the marker revision first, then deploy the newer migrations:" >&2
		printf '%s\n' "$forward_recovery_schema_changes" >&2
		exit 1
	fi
fi

gateway_validation_env=()
for key in \
	GATEWAY_LISTEN_HOST \
	GATEWAY_PORT \
	GATEWAY_ROUTES_JSON \
	CORS_ALLOWED_ORIGINS \
	JWT_JWKS_URL \
	JWT_ISSUER \
	JWT_AUDIENCE \
	JWT_CLOCK_TOLERANCE_SECONDS \
	JWT_MAX_TOKEN_BYTES \
	JWKS_FETCH_TIMEOUT_MS \
	JWKS_REFRESH_MIN_INTERVAL_MS \
	JWKS_CACHE_TTL_MS \
	JWKS_MAX_STALE_MS \
	JWKS_MAX_BYTES; do
	value="$(get_env_value "$key" || true)"
	if [[ -n "$value" ]]; then
		gateway_validation_env+=(--env "$key=$value")
	fi
done
gateway_validation_env+=(
	--env "JWT_MAX_TOKEN_LIFETIME_SECONDS=$(get_env_value JWT_ACCESS_TTL_SECONDS)"
	--env "SHUTDOWN_GRACE_MS=$(get_env_value GATEWAY_SHUTDOWN_GRACE_MS)"
	--env "REPORTING_GATEWAY_POLICY=$reporting_gateway_policy"
)

docker run --rm --network none \
	"${gateway_validation_env[@]}" \
	--entrypoint node \
	"winwidget-api-gateway:$APP_VERSION" \
	-e '
const { loadConfig } = require("./dist/src/config.js");
const config = loadConfig();
const databaseRestores = config.routes.find(route => route.id === "database-restores");
const campaigns = config.routes.find(route => route.id === "campaigns");
const reporting = config.routes.find(route => route.id === "reporting");
const monolith = config.routes.find(route => route.id === "monolith");
const policy = process.env.REPORTING_GATEWAY_POLICY;
const commonInvalid =
	!databaseRestores ||
	databaseRestores.pathPrefix !== "/api/v1/dev-tools/database-restores" ||
	databaseRestores.upstreamUrl.origin !== "http://127.0.0.1:4200" ||
	databaseRestores.authPolicy !== "required" ||
	databaseRestores.timeoutMs !== 120000 ||
	!campaigns ||
	campaigns.pathPrefix !== "/api/v1/admin/campaigns" ||
	campaigns.upstreamUrl.origin !== "http://127.0.0.1:4500" ||
	campaigns.authPolicy !== "required" ||
	campaigns.timeoutMs !== 60000 ||
	!monolith ||
	monolith.pathPrefix !== "/api/v1" ||
	monolith.upstreamUrl.origin !== "http://127.0.0.1:4200" ||
	monolith.authPolicy !== "optional" ||
	monolith.timeoutMs !== 60000;
const darkInvalid =
	policy === "dark" &&
	(config.routes.length !== 3 ||
		config.routes[0]?.id !== "database-restores" ||
		config.routes[1]?.id !== "campaigns" ||
		config.routes[2]?.id !== "monolith" ||
		reporting ||
		config.routes.some(
			route =>
				route.pathPrefix === "/api/v1/admin/reporting" ||
				route.upstreamUrl.origin === "http://127.0.0.1:4600",
		));
const reportingInvalid =
	policy === "reporting" &&
	(config.routes.length !== 4 ||
		config.routes[0]?.id !== "database-restores" ||
		config.routes[1]?.id !== "campaigns" ||
		config.routes[2]?.id !== "reporting" ||
		config.routes[3]?.id !== "monolith" ||
		!reporting ||
		reporting.pathPrefix !== "/api/v1/admin/reporting" ||
		reporting.upstreamUrl.origin !== "http://127.0.0.1:4600" ||
		reporting.authPolicy !== "required" ||
		reporting.timeoutMs !== 60000);
if (
	!["dark", "reporting"].includes(policy) ||
	commonInvalid ||
	darkInvalid ||
	reportingInvalid
) {
	throw new Error(
		`Gateway route manifest conflicts with Reporting cutover policy ${policy}`,
	);
}
process.stdout.write(
	`API Gateway route manifest validated for Reporting policy ${policy}\n`,
);
'

if [[ "$reporting_gateway_policy" == 'reporting' ]]; then
	reporting_cutover_require_forward_scheduler_ready || {
		echo 'Reporting runtime/owner preflight failed before the public Gateway route switch.' >&2
		exit 1
	}
fi

docker run --rm --network none \
	--env-file "$ENV_FILE" \
	--entrypoint node \
	"winwidget-api:$APP_VERSION" \
	-e '
const {
	createPrivateKey,
	createPublicKey,
	randomBytes,
	sign,
	verify,
} = require("node:crypto");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

let privateKey;
let jwks;
try {
	privateKey = createPrivateKey(
		Buffer.from(process.env.JWT_ACCESS_PRIVATE_KEY_BASE64 || "", "base64"),
	);
	jwks = JSON.parse(
		Buffer.from(process.env.JWT_ACCESS_JWKS_BASE64 || "", "base64").toString(
			"utf8",
		),
	);
} catch {
	fail("JWT key material is malformed");
}

if (
	privateKey.type !== "private" ||
	privateKey.asymmetricKeyType !== "rsa" ||
	(privateKey.asymmetricKeyDetails?.modulusLength || 0) < 3072
) {
	fail("JWT private key must be an RSA key of at least 3072 bits");
}
if (!Array.isArray(jwks?.keys) || !jwks.keys.length) {
	fail("JWT JWKS must contain at least one public key");
}

const keyIds = new Set();
for (const key of jwks.keys) {
	if (
		!key ||
		key.kty !== "RSA" ||
		key.use !== "sig" ||
		key.alg !== "RS256" ||
		typeof key.kid !== "string" ||
		!key.kid ||
		typeof key.n !== "string" ||
		typeof key.e !== "string" ||
		["d", "p", "q", "dp", "dq", "qi", "oth"].some(name => name in key)
	) {
		fail("JWT JWKS contains an invalid or private key");
	}
	if (keyIds.has(key.kid)) fail("JWT JWKS contains a duplicate kid");
	keyIds.add(key.kid);
}

const activeKid = process.env.JWT_ACCESS_ACTIVE_KID;
const activeJwk = jwks.keys.find(key => key.kid === activeKid);
if (!activeJwk) fail("JWT active kid is missing from JWKS");

let publicKey;
try {
	publicKey = createPublicKey({ key: activeJwk, format: "jwk" });
} catch {
	fail("JWT active public JWK is malformed");
}
if ((publicKey.asymmetricKeyDetails?.modulusLength || 0) < 3072) {
	fail("JWT active public key must be at least 3072 bits");
}

const challenge = randomBytes(64);
const signature = sign("sha256", challenge, privateKey);
if (!verify("sha256", challenge, publicKey, signature)) {
	fail("JWT private key does not match the active public JWK");
}

process.stdout.write(`JWT RS256 keyset validated for kid ${activeKid}\n`);
'

rabbitmq_admin_user="$(get_env_value "RABBITMQ_ADMIN_USER")"
rabbitmq_admin_password="$(get_env_value "RABBITMQ_ADMIN_PASSWORD")"
rabbitmq_monitor_user="$(get_env_value "RABBITMQ_MONITOR_USER")"
rabbitmq_monitor_password="$(get_env_value "RABBITMQ_MONITOR_PASSWORD")"

validate_rabbitmq_username() {
	local variable_name="$1"
	local username="$2"

	if [[ ! "$username" =~ ^[A-Za-z0-9._-]+$ ]]; then
		echo "$variable_name must contain only letters, digits, dot, underscore or hyphen" >&2
		exit 1
	fi
}

validate_rabbitmq_username "RABBITMQ_ADMIN_USER" "$rabbitmq_admin_user"
validate_rabbitmq_username "RABBITMQ_MONITOR_USER" "$rabbitmq_monitor_user"
if [[ ! "$rabbitmq_vhost" =~ ^[A-Za-z0-9._/-]+$ ]]; then
	echo "RABBITMQ_VHOST contains unsupported characters" >&2
	exit 1
fi
if [[ "$rabbitmq_admin_password" == change_me* ||
	"$rabbitmq_monitor_password" == change_me* ||
	${#rabbitmq_admin_password} -lt 32 ||
	${#rabbitmq_monitor_password} -lt 32 ]]; then
	echo "RabbitMQ admin and monitor passwords must be non-example values of at least 32 characters" >&2
	exit 1
fi

parse_rabbitmq_service_url() {
	local variable_name="$1"
	local url_value
	local parsed
	local encoded_user
	local encoded_password
	local encoded_vhost

	url_value="$(get_env_value "$variable_name")"
	if ! parsed="$(
		printf '%s' "$url_value" |
			docker run --rm -i --network none \
				--entrypoint node \
				-e "RABBITMQ_EXPECTED_VHOST=$rabbitmq_vhost" \
				"winwidget-api:$APP_VERSION" \
				-e '
const { readFileSync } = require("node:fs");

const fail = message => {
	process.stderr.write(`${message}\n`);
	process.exit(1);
};

let url;
try {
	url = new URL(readFileSync(0, "utf8"));
} catch {
	fail("RabbitMQ service URL is invalid");
}

if (url.protocol !== "amqp:") {
	fail("RabbitMQ service URL must use amqp for the local production broker");
}
if (!url.hostname || url.search || url.hash) {
	fail("RabbitMQ service URL must contain a host and no query or fragment");
}
if (url.hostname !== "127.0.0.1" || (url.port && url.port !== "5672")) {
	fail("RabbitMQ service URL must target 127.0.0.1:5672");
}

let username;
let password;
let vhost;
try {
	username = decodeURIComponent(url.username);
	password = decodeURIComponent(url.password);
	vhost = decodeURIComponent(url.pathname.slice(1));
} catch {
	fail("RabbitMQ service URL contains invalid percent-encoding");
}

if (!/^[A-Za-z0-9._-]+$/.test(username)) {
	fail("RabbitMQ service username contains unsupported characters");
}
if (
	password.length < 32 ||
	password.startsWith("change_me") ||
	/[\0\r\n]/.test(password)
) {
	fail("RabbitMQ service password is missing or unsafe");
}
if (vhost !== process.env.RABBITMQ_EXPECTED_VHOST) {
	fail("RabbitMQ service URL vhost does not match RABBITMQ_VHOST");
}

for (const value of [username, password, vhost]) {
	process.stdout.write(`${Buffer.from(value).toString("base64")}\n`);
}
'
	)"; then
		echo "$variable_name is invalid" >&2
		exit 1
	fi

	encoded_user="$(sed -n '1p' <<<"$parsed")"
	encoded_password="$(sed -n '2p' <<<"$parsed")"
	encoded_vhost="$(sed -n '3p' <<<"$parsed")"
	if [[ -z "$encoded_user" || -z "$encoded_password" || -z "$encoded_vhost" ]]; then
		echo "$variable_name could not be parsed safely" >&2
		exit 1
	fi

	printf '%s\n%s\n%s\n' \
		"$encoded_user" "$encoded_password" "$encoded_vhost"
}

publisher_credentials="$(parse_rabbitmq_service_url "RABBITMQ_PUBLISHER_URL")"
integration_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_INTEGRATION_WORKER_URL"
)"
maintenance_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_MAINTENANCE_WORKER_URL"
)"
notification_delivery_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_NOTIFICATION_DELIVERY_URL"
)"
campaigns_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_CAMPAIGNS_URL"
)"
reporting_credentials="$(
	parse_rabbitmq_service_url "RABBITMQ_REPORTING_URL"
)"

publisher_user="$(
	printf '%s' "$(sed -n '1p' <<<"$publisher_credentials")" | base64 --decode
)"
publisher_password_base64="$(sed -n '2p' <<<"$publisher_credentials")"
integration_user="$(
	printf '%s' "$(sed -n '1p' <<<"$integration_credentials")" | base64 --decode
)"
integration_password_base64="$(sed -n '2p' <<<"$integration_credentials")"
maintenance_user="$(
	printf '%s' "$(sed -n '1p' <<<"$maintenance_credentials")" | base64 --decode
)"
maintenance_password_base64="$(sed -n '2p' <<<"$maintenance_credentials")"
notification_delivery_user="$(
	printf '%s' \
		"$(sed -n '1p' <<<"$notification_delivery_credentials")" |
		base64 --decode
)"
notification_delivery_password_base64="$(
	sed -n '2p' <<<"$notification_delivery_credentials"
)"
campaigns_user="$(
	printf '%s' "$(sed -n '1p' <<<"$campaigns_credentials")" |
		base64 --decode
)"
campaigns_password_base64="$(sed -n '2p' <<<"$campaigns_credentials")"
reporting_user="$(
	printf '%s' "$(sed -n '1p' <<<"$reporting_credentials")" |
		base64 --decode
)"
reporting_password_base64="$(sed -n '2p' <<<"$reporting_credentials")"
if [[ "$reporting_user" != "winwidget-reporting" ]]; then
	echo "RABBITMQ_REPORTING_URL must use the dedicated winwidget-reporting user" >&2
	exit 1
fi
rabbitmq_admin_password_base64="$(
	printf '%s' "$rabbitmq_admin_password" | base64 | tr -d '\n'
)"
rabbitmq_monitor_password_base64="$(
	printf '%s' "$rabbitmq_monitor_password" | base64 | tr -d '\n'
)"

service_users=(
	"$rabbitmq_admin_user"
	"$rabbitmq_monitor_user"
	"$publisher_user"
	"$integration_user"
	"$maintenance_user"
	"$notification_delivery_user"
	"$campaigns_user"
	"$reporting_user"
)
for ((left = 0; left < ${#service_users[@]}; left++)); do
	for ((right = left + 1; right < ${#service_users[@]}; right++)); do
		if [[ "${service_users[$left]}" == "${service_users[$right]}" ]]; then
			echo "RabbitMQ admin, monitor and service URLs must use distinct users" >&2
			exit 1
		fi
	done
done

if [[ -n "$matched_rabbitmq_container_id" ]]; then
	rabbitmq_is_running="$(
		docker inspect --format '{{ .State.Running }}' \
			"$matched_rabbitmq_container_id"
	)"
	if [[ "$rabbitmq_is_running" != "true" ]]; then
		docker start "$matched_rabbitmq_container_id" >/dev/null
	fi
	provisioning_rabbitmq_container_id="$matched_rabbitmq_container_id"
else
	compose_target up -d rabbitmq
	provisioning_rabbitmq_container_id="$(compose_target ps -q rabbitmq)"
fi

if [[ -z "$provisioning_rabbitmq_container_id" ]]; then
	echo "RabbitMQ container for service-user provisioning was not found" >&2
	exit 1
fi

for ((attempt = 1; attempt <= 30; attempt++)); do
	if docker exec "$provisioning_rabbitmq_container_id" \
		rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
		break
	fi
	if ((attempt == 30)); then
		echo "RabbitMQ did not become ready for service-user provisioning" >&2
		exit 1
	fi
	sleep 2
done

RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	docker exec \
		-e RABBITMQ_PROVISION_VHOST \
		"$provisioning_rabbitmq_container_id" \
		sh -ec '
if ! rabbitmqctl --silent list_vhosts name |
	grep -Fqx -- "$RABBITMQ_PROVISION_VHOST"; then
	rabbitmqctl add_vhost "$RABBITMQ_PROVISION_VHOST"
fi
'

unexpected_broad_users="$(
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_PROVISION_ADMIN_USER="$rabbitmq_admin_user" \
		docker exec \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_PROVISION_ADMIN_USER \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '
permissions="$(
	rabbitmqctl --silent list_permissions \
		-p "$RABBITMQ_PROVISION_VHOST" --no-table-headers
)"
printf "%s\n" "$permissions" |
awk -v admin="$RABBITMQ_PROVISION_ADMIN_USER" \
	'\''$2 == ".*" && $3 == ".*" && $4 == ".*" &&
		$1 != admin { print $1 }'\''
'
)"
if [[ -n "$unexpected_broad_users" ]]; then
	echo "Unexpected broad RabbitMQ user(s) on vhost $rabbitmq_vhost:" >&2
	echo "$unexpected_broad_users" >&2
	exit 1
fi

provision_rabbitmq_user() {
	local username="$1"
	local password_base64="$2"
	local configure_pattern="$3"
	local write_pattern="$4"
	local read_pattern="$5"
	local tag="$6"

	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_PASSWORD_BASE64="$password_base64" \
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_PROVISION_CONFIGURE="$configure_pattern" \
	RABBITMQ_PROVISION_WRITE="$write_pattern" \
	RABBITMQ_PROVISION_READ="$read_pattern" \
	RABBITMQ_PROVISION_TAG="$tag" \
		docker exec \
			-e RABBITMQ_PROVISION_USER \
			-e RABBITMQ_PROVISION_PASSWORD_BASE64 \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_PROVISION_CONFIGURE \
			-e RABBITMQ_PROVISION_WRITE \
			-e RABBITMQ_PROVISION_READ \
			-e RABBITMQ_PROVISION_TAG \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '
password="$(printf "%s" "$RABBITMQ_PROVISION_PASSWORD_BASE64" | base64 -d)"
if rabbitmqctl --silent list_users |
	cut -f1 |
	grep -Fqx -- "$RABBITMQ_PROVISION_USER"; then
	rabbitmqctl change_password "$RABBITMQ_PROVISION_USER" "$password"
else
	rabbitmqctl add_user "$RABBITMQ_PROVISION_USER" "$password"
fi

while IFS= read -r other_vhost; do
	if [ "$other_vhost" != "$RABBITMQ_PROVISION_VHOST" ]; then
		rabbitmqctl clear_permissions \
			-p "$other_vhost" "$RABBITMQ_PROVISION_USER"
		rabbitmqctl clear_topic_permissions \
			-p "$other_vhost" "$RABBITMQ_PROVISION_USER"
	fi
done <<EOF
$(rabbitmqctl --silent list_vhosts name)
EOF

rabbitmqctl set_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"$RABBITMQ_PROVISION_CONFIGURE" \
	"$RABBITMQ_PROVISION_WRITE" \
	"$RABBITMQ_PROVISION_READ"
if [ -n "$RABBITMQ_PROVISION_TAG" ]; then
	rabbitmqctl set_user_tags \
		"$RABBITMQ_PROVISION_USER" "$RABBITMQ_PROVISION_TAG"
else
	rabbitmqctl set_user_tags "$RABBITMQ_PROVISION_USER"
fi
rabbitmqctl authenticate_user "$RABBITMQ_PROVISION_USER" "$password"
unset password
'
}

provision_campaigns_rabbitmq_topic_permissions() {
	local username="$1"
	local events_write_pattern
	local events_read_pattern
	local dead_letter_pattern
	events_write_pattern='^(admin\.audit\.event\.v1|campaign\.snapshot\.requested\.v1|notification\.campaign\.(email|telegram)\.requested\.v2|notification\.delivery\.outcome\.v2)$'
	events_read_pattern='^(campaign\.snapshot\.requested\.v1|notification\.delivery\.outcome\.v2)$'
	dead_letter_pattern='^campaigns\.(snapshot|outcome)\.dead-letter$'

	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_CAMPAIGNS_EVENTS_WRITE="$events_write_pattern" \
	RABBITMQ_CAMPAIGNS_EVENTS_READ="$events_read_pattern" \
	RABBITMQ_CAMPAIGNS_DEAD_LETTER="$dead_letter_pattern" \
		docker exec \
			-e RABBITMQ_PROVISION_USER \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_CAMPAIGNS_EVENTS_WRITE \
			-e RABBITMQ_CAMPAIGNS_EVENTS_READ \
			-e RABBITMQ_CAMPAIGNS_DEAD_LETTER \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '
rabbitmqctl clear_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER"
rabbitmqctl set_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"winwidget.events" \
	"$RABBITMQ_CAMPAIGNS_EVENTS_WRITE" \
	"$RABBITMQ_CAMPAIGNS_EVENTS_READ"
rabbitmqctl set_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"winwidget.dead-letter" \
	"$RABBITMQ_CAMPAIGNS_DEAD_LETTER" \
	"$RABBITMQ_CAMPAIGNS_DEAD_LETTER"
'
}

provision_reporting_rabbitmq_topic_permissions() {
	local username="$1"
	local events_write_pattern
	local events_read_pattern
	local dead_letter_pattern
	events_write_pattern='^(notification\.daily-summary\.telegram\.requested\.v1|admin\.audit\.reporting\.v1)$'
	events_read_pattern='^(identity\.user\.changed\.v1|billing\.(payment|subscription)\.changed\.v1|widgets\.(widget|lead)\.changed\.v1|reporting\.(settings|core-operational-routing)\.changed\.v1|notification\.delivery\.outcome\.v1)$'
	dead_letter_pattern='^reporting\.(identityUser|billingPayment|billingSubscription|widget|lead|reportingSettings|deliveryOutcome)\.dead-letter$'

	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_REPORTING_EVENTS_WRITE="$events_write_pattern" \
	RABBITMQ_REPORTING_EVENTS_READ="$events_read_pattern" \
	RABBITMQ_REPORTING_DEAD_LETTER="$dead_letter_pattern" \
		docker exec \
			-e RABBITMQ_PROVISION_USER \
			-e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_REPORTING_EVENTS_WRITE \
			-e RABBITMQ_REPORTING_EVENTS_READ \
			-e RABBITMQ_REPORTING_DEAD_LETTER \
			"$provisioning_rabbitmq_container_id" \
			sh -ec '
rabbitmqctl clear_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER"
rabbitmqctl set_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"winwidget.events" \
	"$RABBITMQ_REPORTING_EVENTS_WRITE" \
	"$RABBITMQ_REPORTING_EVENTS_READ"
rabbitmqctl set_topic_permissions \
	-p "$RABBITMQ_PROVISION_VHOST" \
	"$RABBITMQ_PROVISION_USER" \
	"winwidget.dead-letter" \
	"$RABBITMQ_REPORTING_DEAD_LETTER" \
	"$RABBITMQ_REPORTING_DEAD_LETTER"
'
}

assert_campaigns_shared_rabbitmq_topology() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"$CAMPAIGNS_IMAGE" \
		-e '
const amqp = require("amqplib");
const {
	DEAD_LETTER_EXCHANGE,
	EVENTS_EXCHANGE,
} = require("./dist/src/messaging/campaigns-messaging.constants.js");

(async () => {
	const connection = await amqp.connect(process.env.RABBITMQ_PUBLISHER_URL);
	try {
		const channel = await connection.createConfirmChannel();
		try {
			await channel.assertExchange(EVENTS_EXCHANGE, "topic", {
				durable: true,
			});
			await channel.assertExchange(DEAD_LETTER_EXCHANGE, "topic", {
				durable: true,
			});
		} finally {
			await channel.close();
		}
	} finally {
		await connection.close();
	}
	process.stdout.write("Shared Campaigns RabbitMQ exchanges verified\n");
})().catch(error => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Shared RabbitMQ topology assertion failed"}\n`,
	);
	process.exitCode = 1;
});
'
}

assert_reporting_shared_rabbitmq_topology() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"$REPORTING_IMAGE" \
		-e '
const amqp = require("amqplib");
const {
	REPORTING_DEAD_LETTER_EXCHANGE,
	REPORTING_EVENTS_EXCHANGE,
} = require("./dist/src/messaging/reporting-messaging.constants.js");

(async () => {
	const connection = await amqp.connect(process.env.RABBITMQ_PUBLISHER_URL);
	try {
		const channel = await connection.createConfirmChannel();
		try {
			await channel.assertExchange(REPORTING_EVENTS_EXCHANGE, "topic", {
				durable: true,
			});
			await channel.assertExchange(REPORTING_DEAD_LETTER_EXCHANGE, "topic", {
				durable: true,
			});
		} finally {
			await channel.close();
		}
	} finally {
		await connection.close();
	}
	process.stdout.write("Shared Reporting RabbitMQ exchanges verified\n");
})().catch(error => {
	process.stderr.write(
		`${error instanceof Error ? error.message : "Shared Reporting RabbitMQ topology assertion failed"}\n`,
	);
	process.exitCode = 1;
});
'
}

provision_rabbitmq_user \
	"$rabbitmq_admin_user" \
	"$rabbitmq_admin_password_base64" \
	'.*' \
	'.*' \
	'.*' \
	'administrator'
provision_rabbitmq_user \
	"$publisher_user" \
	"$publisher_password_base64" \
	'^winwidget\..*' \
	'^winwidget\..*' \
	'^winwidget\..*' \
	''
assert_campaigns_shared_rabbitmq_topology
assert_reporting_shared_rabbitmq_topology
post_cutover_integration_read_pattern='^winwidget\.(lead-integration\.(webhook|bitrix24|amo-crm)|payment\.auto-renewal|admin\.audit\.(campaigns|reporting)\.v1|report\.daily-summary\.telegram|notification\.(telegram-destination-unavailable|delivery-outcome))(\..*)?$'
legacy_integration_read_pattern='^winwidget\.(lead-integration\.(webhook|bitrix24|amo-crm)|payment\.auto-renewal|payment-notification\.telegram(\.dead-letter|\.retry-v2\.[123])?|mailing\..*|limit-notification\.telegram(\.dead-letter|\.retry-v2\.[123])?|admin\.audit\.campaigns\.v1|report\.daily-summary\.telegram)(\..*)?$'
integration_worker_read_pattern="$post_cutover_integration_read_pattern"
if [[ "$notification_delivery_first_cutover" == "true" ]]; then
	integration_worker_read_pattern="$legacy_integration_read_pattern"
fi
provision_rabbitmq_user \
	"$integration_user" \
	"$integration_password_base64" \
	'^$' \
	'^(winwidget\.retry|winwidget\.dead-letter)$' \
	"$integration_worker_read_pattern" \
	''
provision_rabbitmq_user \
	"$maintenance_user" \
	"$maintenance_password_base64" \
	'^$' \
	'^(winwidget\.retry|winwidget\.dead-letter)$' \
	'^winwidget\.maintenance\..*' \
	''
provision_rabbitmq_user \
	"$notification_delivery_user" \
	"$notification_delivery_password_base64" \
	'^$' \
	'^(winwidget\.events|winwidget\.dead-letter)$' \
	'^winwidget\.(lead-integration\.(email|telegram)|payment-notification\.(email|telegram\.v2)|limit-notification\.(email|telegram)|notification\.(campaign\.(email|telegram)|daily-summary\.telegram|subscription-expiry\.(email|telegram)))(\..*)?$' \
	''
provision_rabbitmq_user \
	"$campaigns_user" \
	"$campaigns_password_base64" \
	'^winwidget\.campaigns(\..*)?$' \
	'^(winwidget\.(events|dead-letter)|winwidget\.campaigns(\..*)?)$' \
	'^(winwidget\.(events|dead-letter)|winwidget\.campaigns(\..*)?)$' \
	''
provision_campaigns_rabbitmq_topic_permissions "$campaigns_user"
provision_rabbitmq_user \
	"$reporting_user" \
	"$reporting_password_base64" \
	'^winwidget\.reporting(\..*)?$' \
	'^(winwidget\.(events|dead-letter)|winwidget\.reporting(\..*)?)$' \
	'^(winwidget\.(events|dead-letter)|winwidget\.reporting(\..*)?)$' \
	''
provision_reporting_rabbitmq_topic_permissions "$reporting_user"
provision_rabbitmq_user \
	"$rabbitmq_monitor_user" \
	"$rabbitmq_monitor_password_base64" \
	'^$' \
	'^$' \
	'^$' \
	'monitoring'

echo "RabbitMQ admin/service users and least-privilege permissions are verified"

assert_cutover_rabbitmq_topology() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		-e RABBITMQ_ASSERT_TOPOLOGY=true \
		-e RABBITMQ_CONNECTION_NAME=winwidget-notification-telegram-cutover-topology \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const {
	RabbitMqService,
} = require("./dist/src/messaging/rabbitmq.service.js");

const configService = {
	get(key) {
		if (key === "RABBITMQ_URL") {
			return process.env.RABBITMQ_PUBLISHER_URL;
		}
		return process.env[key];
	},
};
const rabbitMq = new RabbitMqService(configService);

rabbitMq
	.onModuleInit()
	.then(async () => {
		process.stdout.write(
			"Telegram ownership cutover RabbitMQ topology asserted\n",
		);
		await rabbitMq.onApplicationShutdown();
	})
	.catch(async error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "RabbitMQ topology assertion failed"}\n`,
		);
		try {
			await rabbitMq.onApplicationShutdown();
		} catch {}
		process.exitCode = 1;
	});
'
}

wait_for_rabbitmq_topology() {
	local rabbitmq_container_id
	local required_queues
	local campaigns_required_queues
	local actual_queues
	local required_queue
	local all_ready
	local attempt

	rabbitmq_container_id="$(compose_target ps --status running -q rabbitmq)"
	if [[ -z "$rabbitmq_container_id" ]]; then
		echo "RabbitMQ is not running while waiting for topology" >&2
		return 1
	fi
	required_queues="$(
		docker run --rm --network none \
			--entrypoint node \
			"winwidget-api:$APP_VERSION" \
			-e '
const {
	MESSAGING_KINDS,
	MESSAGING_QUEUE_NAMES
} = require("./dist/src/messaging/messaging.constants.js");
for (const kind of MESSAGING_KINDS) {
	const queue = MESSAGING_QUEUE_NAMES[kind];
	process.stdout.write(`${queue}\n${queue}.dead-letter\n`);
}
'
	)"
	campaigns_required_queues="$(
		docker run --rm --network none \
			--entrypoint node \
			"$CAMPAIGNS_IMAGE" \
			-e '
const {
	CAMPAIGNS_CONSUMER_KINDS,
	CAMPAIGNS_QUEUE_NAMES,
	CAMPAIGNS_RETRY_DELAYS_MS,
} = require("./dist/src/messaging/campaigns-messaging.constants.js");
for (const kind of CAMPAIGNS_CONSUMER_KINDS) {
	const queue = CAMPAIGNS_QUEUE_NAMES[kind];
	process.stdout.write(`${queue}\n${queue}.dead-letter\n`);
	for (let index = 0; index < CAMPAIGNS_RETRY_DELAYS_MS.length; index += 1) {
		process.stdout.write(`${queue}.retry.${index + 1}\n`);
	}
}
'
	)"
	required_queues+=$'\n'"$campaigns_required_queues"

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		actual_queues="$(
			docker exec "$rabbitmq_container_id" \
				rabbitmqctl --silent list_queues -p "$rabbitmq_vhost" name \
				2>/dev/null || true
		)"
		all_ready=true
		while IFS= read -r required_queue; do
			[[ -n "$required_queue" ]] || continue
			if ! grep -Fqx -- "$required_queue" <<<"$actual_queues"; then
				all_ready=false
				break
			fi
		done <<<"$required_queues"
		if [[ "$all_ready" == "true" ]]; then
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo "RabbitMQ topology owner did not create all worker queues" >&2
	compose_target logs --tail=100 outbox-publisher rabbitmq || true
	return 1
}

verify_notification_delivery_runtime_crud() {
	compose_target run --rm --no-deps \
		--entrypoint node \
		notification-delivery-worker \
		-e '
const { randomUUID } = require("node:crypto");
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL,
		},
	},
});
const instanceId = `deployment-smoke-${randomUUID()}`;

prisma
	.$transaction(async transaction => {
		const grants = await transaction.$queryRawUnsafe(`
			SELECT
				tablename,
				has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$select$SELECT$select$
				)
				AND has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$insert$INSERT$insert$
				)
				AND has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$update$UPDATE$update$
				)
				AND has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$delete$DELETE$delete$
				) AS allowed
			FROM pg_tables
			WHERE schemaname = $schema$notification_delivery$schema$
				AND tablename <> $migrations$_prisma_migrations$migrations$
		`);
		if (
			!Array.isArray(grants) ||
			grants.length === 0 ||
			grants.some(grant => grant.allowed !== true)
		) {
			throw new Error("runtime CRUD grants are incomplete");
		}
		const migrationTablePrivileges = await transaction.$queryRawUnsafe(`
			SELECT (
				has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$select$SELECT$select$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$insert$INSERT$insert$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$update$UPDATE$update$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$delete$DELETE$delete$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$truncate$TRUNCATE$truncate$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$references$REFERENCES$references$
				)
				OR has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$trigger$TRIGGER$trigger$
				)
			) AS allowed
			FROM pg_tables
			WHERE schemaname = $schema$notification_delivery$schema$
				AND tablename = $migrations$_prisma_migrations$migrations$
		`);
		if (
			migrationTablePrivileges.length !== 1 ||
			migrationTablePrivileges[0]?.allowed !== false
		) {
			throw new Error(
				"runtime role must not access the Prisma migration history table",
			);
		}
		const privilegeRows = await transaction.$queryRawUnsafe(`
			SELECT
				roles.rolsuper AS role_super,
				roles.rolcreatedb AS role_create_database,
				roles.rolcreaterole AS role_create_role,
				pg_get_userbyid(databases.datdba) = current_user AS database_owner,
				pg_get_userbyid(namespaces.nspowner) = current_user AS schema_owner,
				has_database_privilege(
					current_user,
					current_database(),
					$privilege$CREATE$privilege$
				) AS database_create,
				has_schema_privilege(
					current_user,
					$schema$notification_delivery$schema$,
					$privilege$CREATE$privilege$
				) AS schema_create
			FROM pg_roles AS roles
			JOIN pg_database AS databases
				ON databases.datname = current_database()
			JOIN pg_namespace AS namespaces
				ON namespaces.nspname = $schema$notification_delivery$schema$
			WHERE roles.rolname = current_user
		`);
		const privilege = privilegeRows[0];
		if (
			privilegeRows.length !== 1 ||
			privilege?.role_super !== false ||
			privilege?.role_create_database !== false ||
			privilege?.role_create_role !== false ||
			privilege?.database_owner !== false ||
			privilege?.schema_owner !== false ||
			privilege?.database_create !== false ||
			privilege?.schema_create !== false
		) {
			throw new Error("runtime role has unsafe PostgreSQL privileges");
		}
		const foreignTablePrivileges = await transaction.$queryRawUnsafe(`
			SELECT schemaname, tablename
			FROM pg_tables
			WHERE schemaname <> $schema$notification_delivery$schema$
				AND schemaname NOT IN (
					$catalog$pg_catalog$catalog$,
					$information$information_schema$information$
				)
				AND (
					has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$select$SELECT$select$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$insert$INSERT$insert$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$update$UPDATE$update$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$delete$DELETE$delete$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$truncate$TRUNCATE$truncate$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$references$REFERENCES$references$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$trigger$TRIGGER$trigger$
					)
				)
		`);
		if (
			!Array.isArray(foreignTablePrivileges) ||
			foreignTablePrivileges.length > 0
		) {
			throw new Error(
				"runtime role has table privileges outside notification_delivery",
			);
		}
		const foreignSchemaCreatePrivileges =
			await transaction.$queryRawUnsafe(`
				SELECT namespaces.nspname
				FROM pg_namespace AS namespaces
				WHERE namespaces.nspname <> $schema$notification_delivery$schema$
					AND namespaces.nspname <> $information$information_schema$information$
					AND left(namespaces.nspname, 3) <> $system$pg_$system$
					AND has_schema_privilege(
						current_user,
						namespaces.oid,
						$privilege$CREATE$privilege$
					)
			`);
		if (
			!Array.isArray(foreignSchemaCreatePrivileges) ||
			foreignSchemaCreatePrivileges.length > 0
		) {
			throw new Error(
				"runtime role has CREATE on a schema outside notification_delivery",
			);
		}
		await transaction.notificationDeliveryHeartbeat.create({
			data: {
				service: "deployment-runtime-crud-smoke",
				instanceId,
				metadata: { phase: "created" },
			},
		});
		const created =
			await transaction.notificationDeliveryHeartbeat.findUnique({
				where: {
					service_instanceId: {
						service: "deployment-runtime-crud-smoke",
						instanceId,
					},
				},
			});
		if (!created) throw new Error("runtime SELECT did not return the smoke row");

		await transaction.notificationDeliveryHeartbeat.update({
			where: {
				service_instanceId: {
					service: "deployment-runtime-crud-smoke",
					instanceId,
				},
			},
			data: { metadata: { phase: "updated" } },
		});
		await transaction.notificationDeliveryHeartbeat.delete({
			where: {
				service_instanceId: {
					service: "deployment-runtime-crud-smoke",
					instanceId,
				},
			},
		});
	})
	.then(() => {
		process.stdout.write(
			"Notification delivery runtime CRUD permissions verified\n",
		);
	})
	.catch(() => {
		process.stderr.write(
			"Notification delivery runtime role failed the CRUD permissions smoke\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
	'
}

verify_notification_delivery_migration_boundary() {
	compose_target \
		--profile notification-delivery-migration \
		run --rm --no-deps \
		--entrypoint node \
		notification-delivery-migrate \
		-e '
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL,
		},
	},
});

prisma
	.$queryRawUnsafe(`
		SELECT
			roles.rolsuper AS role_super,
			roles.rolcreatedb AS role_create_database,
			roles.rolcreaterole AS role_create_role,
			pg_get_userbyid(databases.datdba) = current_user AS database_owner,
			pg_get_userbyid(namespaces.nspowner) = current_user AS schema_owner,
			has_database_privilege(
				current_user,
				current_database(),
				$privilege$CREATE$privilege$
			) AS database_create,
			has_schema_privilege(
				current_user,
				$schema$notification_delivery$schema$,
				$privilege$CREATE$privilege$
			) AS schema_create
		FROM pg_roles AS roles
		JOIN pg_database AS databases
			ON databases.datname = current_database()
		JOIN pg_namespace AS namespaces
			ON namespaces.nspname = $schema$notification_delivery$schema$
		WHERE roles.rolname = current_user
	`)
	.then(rows => {
		const privilege = rows[0];
		if (
			rows.length !== 1 ||
			privilege?.role_super !== false ||
			privilege?.role_create_database !== false ||
			privilege?.role_create_role !== false ||
			privilege?.database_owner !== false ||
			privilege?.schema_owner !== true ||
			privilege?.database_create !== false ||
			privilege?.schema_create !== true
		) {
			throw new Error("migration role has unsafe PostgreSQL privileges");
		}
		process.stdout.write(
			"Notification delivery migration role boundary verified\n",
		);
	})
	.catch(() => {
		process.stderr.write(
			"Notification delivery migration role failed its privilege boundary smoke\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

finalize_notification_delivery_backup_grants() {
	local backup_role

	backup_role="$(get_database_username NOTIFICATION_DELIVERY_BACKUP_URL)"
	compose_target \
		--profile notification-delivery-migration \
		run --rm --no-deps \
		-e "NOTIFICATION_DELIVERY_BACKUP_ROLE=$backup_role" \
		--entrypoint node \
		notification-delivery-migrate \
		-e '
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");

const backupRole = process.env.NOTIFICATION_DELIVERY_BACKUP_ROLE?.trim();
if (!backupRole || !/^[A-Za-z0-9._-]+$/.test(backupRole)) {
	throw new Error("Notification delivery backup role name is invalid");
}
const quotedRole = `"${backupRole.replaceAll("\"", "\"\"")}"`;
const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL,
		},
	},
});

prisma
	.$transaction([
		prisma.$executeRawUnsafe(
			`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA notification_delivery FROM ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA notification_delivery FROM ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`GRANT USAGE ON SCHEMA notification_delivery TO ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`GRANT SELECT ON ALL TABLES IN SCHEMA notification_delivery TO ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`GRANT SELECT ON ALL SEQUENCES IN SCHEMA notification_delivery TO ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`ALTER DEFAULT PRIVILEGES IN SCHEMA notification_delivery GRANT SELECT ON TABLES TO ${quotedRole}`,
		),
		prisma.$executeRawUnsafe(
			`ALTER DEFAULT PRIVILEGES IN SCHEMA notification_delivery GRANT SELECT ON SEQUENCES TO ${quotedRole}`,
		),
	])
	.then(() => {
		process.stdout.write(
			"Notification delivery backup grants finalized\n",
		);
	})
	.catch(error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Notification delivery backup grant finalization failed"}\n`,
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

verify_notification_delivery_backup_boundary() {
	compose_target run --rm --no-deps \
		--entrypoint node \
		maintenance-worker \
		-e '
const { PrismaClient } = require("@prisma/client");

const backupUrl = new URL(process.env.NOTIFICATION_DELIVERY_BACKUP_URL);
const expectedDatabase = decodeURIComponent(backupUrl.pathname.slice(1));
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expectedDatabase)) {
	throw new Error("notification delivery backup database name is invalid");
}

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_BACKUP_URL,
		},
	},
});

prisma
	.$transaction(async transaction => {
		const tables = await transaction.$queryRawUnsafe(`
			SELECT
				tablename,
				has_table_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, tablename),
					$select$SELECT$select$
				) AS can_select,
				(
					has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$insert$INSERT$insert$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$update$UPDATE$update$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$delete$DELETE$delete$
					)
					OR has_table_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, tablename),
						$truncate$TRUNCATE$truncate$
					)
				) AS can_write
			FROM pg_tables
			WHERE schemaname = $schema$notification_delivery$schema$
		`);
		if (
			!Array.isArray(tables) ||
			tables.length === 0 ||
			tables.some(
				table => table.can_select !== true || table.can_write !== false,
			)
		) {
			throw new Error(
				"notification delivery backup role must have read-only access to every service table",
			);
		}

		const sequences = await transaction.$queryRawUnsafe(`
			SELECT
				sequencename,
				has_sequence_privilege(
					current_user,
					format($fmt$%I.%I$fmt$, schemaname, sequencename),
					$select$SELECT$select$
				) AS can_select,
				(
					has_sequence_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, sequencename),
						$usage$USAGE$usage$
					)
					OR has_sequence_privilege(
						current_user,
						format($fmt$%I.%I$fmt$, schemaname, sequencename),
						$update$UPDATE$update$
					)
				) AS can_advance
			FROM pg_sequences
			WHERE schemaname = $schema$notification_delivery$schema$
		`);
		if (
			!Array.isArray(sequences) ||
			sequences.some(
				sequence =>
					sequence.can_select !== true ||
					sequence.can_advance !== false,
			)
		) {
			throw new Error(
				"notification delivery backup role has unsafe sequence privileges",
			);
		}

		const privilegeRows = await transaction.$queryRawUnsafe(`
			SELECT
				current_database() AS database_name,
				roles.rolsuper AS role_super,
				roles.rolcreatedb AS role_create_database,
				roles.rolcreaterole AS role_create_role,
				pg_get_userbyid(databases.datdba) = current_user AS database_owner,
				pg_get_userbyid(namespaces.nspowner) = current_user AS schema_owner,
				has_database_privilege(
					current_user,
					current_database(),
					$privilege$CREATE$privilege$
				) AS database_create,
				has_schema_privilege(
					current_user,
					$schema$notification_delivery$schema$,
					$privilege$CREATE$privilege$
				) AS schema_create
			FROM pg_roles AS roles
			JOIN pg_database AS databases
				ON databases.datname = current_database()
			JOIN pg_namespace AS namespaces
				ON namespaces.nspname = $schema$notification_delivery$schema$
			WHERE roles.rolname = current_user
		`);
		const privilege = privilegeRows[0];
		if (
			privilegeRows.length !== 1 ||
			privilege?.database_name !== expectedDatabase ||
			privilege?.role_super !== false ||
			privilege?.role_create_database !== false ||
			privilege?.role_create_role !== false ||
			privilege?.database_owner !== false ||
			privilege?.schema_owner !== false ||
			privilege?.database_create !== false ||
			privilege?.schema_create !== false
		) {
			throw new Error(
				"notification delivery backup role has unsafe PostgreSQL privileges",
			);
		}
	})
	.then(() => {
		process.stdout.write(
			"Notification delivery backup role boundary verified\n",
		);
	})
	.catch(error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Notification delivery backup role verification failed"}\n`,
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

verify_notification_delivery_control_smoke() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const { randomUUID } = require("node:crypto");
const {
	NotificationDeliveryClientService,
	NotificationDeliveryInternalApiError,
} = require("./dist/src/messaging/notification-delivery-client.service.js");

const expectValidationFailure = async (operation, label) => {
	try {
		await operation();
	} catch (error) {
		if (
			error instanceof NotificationDeliveryInternalApiError &&
			error.statusCode === 400
		) {
			return;
		}
		throw error;
	}
	throw new Error(`${label} did not preserve its validation contract`);
};
const run = async () => {
	const configService = {
		get: key => process.env[key],
	};
	const client = new NotificationDeliveryClientService(configService);
	await client.getOverview();
	await client.getFailures(1, 1, {});
	const validationId = randomUUID();
	await expectValidationFailure(
		() => client.retryFailure(validationId, ""),
		"retry endpoint",
	);
	await expectValidationFailure(
		() =>
			client.closeFailure(
				validationId,
				"deployment-control-smoke",
				"x",
			),
		"close endpoint",
	);
};

run()
	.then(() => {
		process.stdout.write(
			"Notification delivery internal control endpoint verified\n",
		);
	})
	.catch(error => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Notification delivery internal control endpoint smoke failed"}\n`,
		);
		process.exitCode = 1;
	});
'
}

verify_exact_worker_consumer_ownership() {
	local close_legacy_orphans="${1:-false}"
	local notification_owner="${2:-notification}"
	local campaigns_queue_names_json
	campaigns_queue_names_json="$(
		docker run --rm --network none \
			--entrypoint node "$CAMPAIGNS_IMAGE" \
			-e '
const {
	CAMPAIGNS_QUEUE_NAMES,
} = require("./dist/src/messaging/campaigns-messaging.constants.js");
process.stdout.write(JSON.stringify(Object.values(CAMPAIGNS_QUEUE_NAMES)));
'
	)"

	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		-e "CLOSE_LEGACY_NOTIFICATION_CONSUMERS=$close_legacy_orphans" \
		-e "EXPECTED_NOTIFICATION_QUEUE_OWNER=$notification_owner" \
		-e "EXPECTED_INTEGRATION_KINDS=$(reporting_expected_integration_worker_kinds)" \
		-e "CAMPAIGNS_QUEUE_NAMES_JSON=$campaigns_queue_names_json" \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const {
	MESSAGING_QUEUE_NAMES,
} = require("./dist/src/messaging/messaging.constants.js");

class OwnershipError extends Error {}

const decodeUser = (value, label) => {
	try {
		const url = new URL(value || "");
		const username = decodeURIComponent(url.username);
		if (!username) throw new Error();
		return username;
	} catch {
		throw new OwnershipError(`${label} has no valid user`);
	}
};

const run = async () => {
	const baseUrl = (
		process.env.RABBITMQ_MANAGEMENT_URL ||
		"http://127.0.0.1:15672"
	).replace(/\/$/, "");
	const vhost = process.env.RABBITMQ_VHOST || "winwidget";
	const adminUser = process.env.RABBITMQ_ADMIN_USER;
	const adminPassword = process.env.RABBITMQ_ADMIN_PASSWORD;
	if (!adminUser || !adminPassword) {
		throw new OwnershipError("RabbitMQ admin credentials are missing");
	}
	const authorization = `Basic ${Buffer.from(
		`${adminUser}:${adminPassword}`,
	).toString("base64")}`;
	const request = async (path, options = {}) => {
		const response = await fetch(`${baseUrl}${path}`, {
			...options,
			headers: {
				Authorization: authorization,
				...(options.headers || {}),
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new OwnershipError(
				`RabbitMQ Management returned HTTP ${response.status}`,
			);
		}
		if (response.status === 204) return null;
		return response.json();
	};

	const connections = await request("/api/connections");
	if (!Array.isArray(connections)) {
		throw new OwnershipError("RabbitMQ connections response is invalid");
	}
	const bySocketName = new Map(
		connections.map(connection => [connection.name, connection]),
	);
	const integrationUser = decodeUser(
		process.env.RABBITMQ_INTEGRATION_WORKER_URL,
		"RABBITMQ_INTEGRATION_WORKER_URL",
	);
	const notificationUser = decodeUser(
		process.env.RABBITMQ_NOTIFICATION_DELIVERY_URL,
		"RABBITMQ_NOTIFICATION_DELIVERY_URL",
	);
	const campaignsUser = decodeUser(
		process.env.RABBITMQ_CAMPAIGNS_URL,
		"RABBITMQ_CAMPAIGNS_URL",
	);
	let campaignsQueues;
	try {
		campaignsQueues = JSON.parse(process.env.CAMPAIGNS_QUEUE_NAMES_JSON || "");
	} catch {
		throw new OwnershipError("Campaigns queue contract is invalid");
	}
	if (
		!Array.isArray(campaignsQueues) ||
		campaignsQueues.length !== 2 ||
		campaignsQueues.some(queue => typeof queue !== "string" || !queue)
	) {
		throw new OwnershipError("Campaigns queue contract is incomplete");
	}
	const legacyTelegramOwner =
		process.env.EXPECTED_NOTIFICATION_QUEUE_OWNER === "legacy";
	const expectedIntegrationKinds = (
		process.env.EXPECTED_INTEGRATION_KINDS || ""
	)
		.split(",")
		.map(value => value.trim())
		.filter(Boolean);
	if (!expectedIntegrationKinds.length) {
		throw new OwnershipError("Expected integration kind contract is missing");
	}
	const groups = [
		{
			kinds: [
				"email",
				"telegram",
				"payment-email",
				"limit-email",
				...(legacyTelegramOwner
					? []
					: [
							"campaign-email",
							"campaign-telegram",
							"daily-summary-delivery-telegram",
							"subscription-expiry-email",
							"subscription-expiry-telegram",
						]),
			],
			user: notificationUser,
			connectionName: "winwidget-notification-delivery-worker",
			notification: true,
		},
		{
			queues: legacyTelegramOwner
				? [
						"winwidget.payment-notification.telegram",
						"winwidget.limit-notification.telegram",
					]
				: [
						MESSAGING_QUEUE_NAMES["payment-telegram"],
						MESSAGING_QUEUE_NAMES["limit-telegram"],
					],
			user: legacyTelegramOwner ? integrationUser : notificationUser,
			connectionName: legacyTelegramOwner
				? "winwidget-integration-worker"
				: "winwidget-notification-delivery-worker",
			notification: true,
		},
		{
			kinds: expectedIntegrationKinds,
			user: integrationUser,
			connectionName: "winwidget-integration-worker",
			notification: false,
		},
		{
			queues: campaignsQueues,
			user: campaignsUser,
			connectionName: "winwidget-campaigns-service",
			notification: false,
			includeDeadLetter: false,
		},
	];

	let closedLegacyOrphan = false;
	for (const group of groups) {
		const baseQueues =
			group.queues ??
			group.kinds.map(kind => MESSAGING_QUEUE_NAMES[kind]);
		for (const baseQueue of baseQueues) {
			if (!baseQueue) {
				throw new OwnershipError(
					"RabbitMQ ownership group contains an unknown queue",
				);
			}
			const consumedQueues =
				group.includeDeadLetter === false
					? [baseQueue]
					: [baseQueue, `${baseQueue}.dead-letter`];
			for (const queue of consumedQueues) {
				const state = await request(
					`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(
						queue,
					)}`,
				);
				const consumers = Array.isArray(state?.consumer_details)
					? state.consumer_details
					: [];

				for (const consumer of consumers) {
					const socketName =
						consumer?.channel_details?.connection_name;
					const connection = bySocketName.get(socketName);
					const clientName =
						connection?.client_properties?.connection_name;
					if (
						group.notification &&
						process.env.CLOSE_LEGACY_NOTIFICATION_CONSUMERS ===
							"true" &&
						connection?.user === integrationUser &&
						clientName === "winwidget-integration-worker"
					) {
						await request(
							`/api/connections/${encodeURIComponent(
								connection.name,
							)}`,
							{
								method: "DELETE",
								headers: {
									"X-Reason":
										"WinWidget notification cutover ownership repair",
								},
							},
						);
						closedLegacyOrphan = true;
					}
				}

				if (closedLegacyOrphan) continue;
				if (consumers.length !== 1) {
					throw new OwnershipError(
						`RabbitMQ queue ${queue} must have exactly one consumer`,
					);
				}
				const socketName =
					consumers[0]?.channel_details?.connection_name;
				const connection = bySocketName.get(socketName);
				const clientName =
					connection?.client_properties?.connection_name;
				if (
					connection?.user !== group.user ||
					clientName !== group.connectionName
				) {
					throw new OwnershipError(
						`RabbitMQ queue ${queue} has an unexpected owner`,
					);
				}
			}
		}
	}

	for (const baseQueue of campaignsQueues) {
		for (const queue of [
			`${baseQueue}.dead-letter`,
			`${baseQueue}.retry.1`,
			`${baseQueue}.retry.2`,
			`${baseQueue}.retry.3`,
		]) {
			const state = await request(
				`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(
					queue,
				)}`,
			);
			const consumers = Array.isArray(state?.consumer_details)
				? state.consumer_details
				: [];
			if (consumers.length !== 0) {
				throw new OwnershipError(
					`RabbitMQ Campaigns parking queue ${queue} must have no consumers`,
				);
			}
		}
	}

	if (closedLegacyOrphan) {
		throw new OwnershipError(
			"Closed an orphan legacy notification consumer; ownership must be rechecked",
		);
	}
};

run()
	.then(() => {
		process.stdout.write("RabbitMQ consumer ownership verified\n");
	})
	.catch(error => {
		const message =
			error instanceof OwnershipError
				? error.message
				: "RabbitMQ consumer ownership could not be verified";
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
'
}

first_cutover_producer_ids=()
first_cutover_legacy_worker_id=""
first_cutover_legacy_notification_worker_id=""
first_cutover_candidate_started=false
first_cutover_marker_tmp=""
first_cutover_recovery_active=false
forward_cutover_recovery_active=false
notification_cutover_last_queue_state=""
notification_cutover_last_database_state=""
notification_cutover_last_service_state=""

print_notification_cutover_runbook() {
	cat >&2 <<'RUNBOOK'
Notification Delivery provider-ownership cutover did not pass.
Do not start the expanded Notification Delivery worker while legacy provider
calls can still be in flight.

Manual recovery/runbook:
1. Keep the current v1 Notification Delivery worker and integration worker running.
2. Through the existing Messaging admin flow, resolve or retry every unresolved
   payment-telegram and limit-telegram failure.
3. Wait until PROCESSING/RETRY_SCHEDULED receipts for payment/limit Telegram
   and campaigns disappear, subscription reminders have no
   PROCESSING rows, and every matching main, retry-v2.* and dead-letter queue
   reports zero ready and zero unacknowledged messages.
4. Re-run the full `all` deployment. The script will stop producers, recheck the
   quiescent boundary, stop both old workers, then start the disjoint workers.
5. Do not use the notification-delivery service-only target until
   `.notification-delivery-telegram-cutover-v1` exists.
RUNBOOK
}

notification_cutover_expected_queues() {
	local base_queue
	local retry_index

	for base_queue in \
		winwidget.payment-notification.telegram \
		winwidget.limit-notification.telegram; do
		printf '%s\n%s.dead-letter\n' "$base_queue" "$base_queue"
		for retry_index in 1 2 3; do
			printf '%s.retry-v2.%s\n' "$base_queue" "$retry_index"
		done
	done
	if [[ "$first_cutover_candidate_started" == "true" ]]; then
		base_queue="winwidget.payment-notification.telegram.v2"
		printf '%s\n%s.dead-letter\n' "$base_queue" "$base_queue"
		for retry_index in 1 2 3; do
			printf '%s.retry-v2.%s\n' "$base_queue" "$retry_index"
		done
	fi
}

notification_cutover_queue_state() {
	local rabbitmq_container_id

	rabbitmq_container_id="$(
		compose_target ps --status running -q rabbitmq
	)"
	if [[ -z "$rabbitmq_container_id" ||
		"$rabbitmq_container_id" == *$'\n'* ]]; then
		echo "Exactly one running RabbitMQ container is required for notification cutover." >&2
		return 1
	fi

	docker exec "$rabbitmq_container_id" \
		rabbitmqctl --silent list_queues \
			-p "$rabbitmq_vhost" \
			name messages_ready messages_unacknowledged consumers |
		awk '
			$1 ~ /^winwidget\.payment-notification\.telegram(\.v2)?(\.|$)/ ||
			$1 ~ /^winwidget\.limit-notification\.telegram(\.|$)/
		'
}

notification_cutover_database_state() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.DATABASE_URL_PRODUCTION,
		},
	},
});
const ownershipKinds = ["payment-telegram", "limit-telegram"];

Promise.all([
	prisma.integrationDeliveryFailure.count({
		where: {
			integration: { in: ownershipKinds },
			resolvedAt: null,
		},
	}),
	prisma.integrationDeliveryReceipt.count({
		where: {
			integration: { in: ownershipKinds },
			status: { in: ["PROCESSING", "RETRY_SCHEDULED"] },
		},
	}),
	prisma.outboxEvent.count({
		where: {
				routingKey: {
					in: [
						"payment.succeeded.v1",
						"lead.limit.reached.telegram.v2",
					],
			},
			status: { in: ["PENDING", "PUBLISHING", "FAILED"] },
		},
	}),
	prisma.subscriptionExpiryReminder.count({
		where: {
			status: "PROCESSING",
		},
	}),
])
	.then(
		([
			unresolvedFailures,
			activeReceipts,
			pendingOutbox,
			processingReminders,
		]) => {
		process.stdout.write(
				`${unresolvedFailures}\t${activeReceipts}\t${pendingOutbox}\t${processingReminders}\n`,
		);
		},
	)
	.catch(() => {
		process.stderr.write(
			"Notification cutover could not query public delivery state\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

notification_delivery_service_state() {
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		--entrypoint node \
		"$NOTIFICATION_DELIVERY_IMAGE" \
		-e '
const {
	PrismaClient,
} = require("@prisma/notification-delivery-client");
const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.NOTIFICATION_DELIVERY_DATABASE_URL,
		},
	},
});

const kinds = ["payment-telegram", "limit-telegram"];
Promise.all([
	prisma.notificationDeliveryReceipt.count({
		where: { consumer: { in: kinds } },
	}),
	prisma.notificationDeliveryFailure.count({
		where: { consumer: { in: kinds } },
	}),
	prisma.notificationDeliveryOutboxEvent.count({
		where: {
			OR: [
				{ routingKey: { in: ["manual.payment-telegram", "manual.limit-telegram"] } },
				{ routingKey: { in: ["payment-telegram.dead-letter", "limit-telegram.dead-letter"] } },
				{ routingKey: "notification.telegram.destination-unavailable.v1" },
			],
		},
	}),
])
	.then(([receipts, failures, outbox]) => {
		process.stdout.write(`${receipts}\t${failures}\t${outbox}\n`);
	})
	.catch(() => {
		process.stderr.write(
			"Notification cutover could not query service-owned state\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
'
}

notification_delivery_service_state_is_empty() {
	local receipts
	local failures
	local outbox

	notification_cutover_last_service_state="$(
		notification_delivery_service_state
	)" || return 1
	IFS=$'\t' read -r receipts failures outbox \
		<<<"$notification_cutover_last_service_state"
	if [[ ! "$receipts" =~ ^[0-9]+$ ||
		! "$failures" =~ ^[0-9]+$ ||
		! "$outbox" =~ ^[0-9]+$ ]]; then
		return 1
	fi
	[[ "$receipts" == "0" && "$failures" == "0" && "$outbox" == "0" ]]
}

notification_cutover_consumers_ready() {
	local state
	local queue
	local queue_line
	local _name
	local ready
	local unacknowledged
	local consumers

	state="$(notification_cutover_queue_state)"
	for queue in \
		winwidget.payment-notification.telegram \
		winwidget.payment-notification.telegram.dead-letter \
		winwidget.limit-notification.telegram \
		winwidget.limit-notification.telegram.dead-letter; do
		queue_line="$(
			awk -v queue="$queue" '$1 == queue { print; exit }' <<<"$state"
		)"
		if [[ -z "$queue_line" ]]; then
			echo "Missing RabbitMQ queue required for Telegram cutover: $queue" >&2
			return 1
		fi
		read -r _name ready unacknowledged consumers <<<"$queue_line"
		if [[ ! "$consumers" =~ ^[1-9][0-9]*$ ]]; then
			echo "Legacy integration-worker is not consuming queue: $queue" >&2
			return 1
		fi
	done
}

notification_cutover_is_clear() {
	local expected_queue
	local queue_line
	local _name
	local ready
	local unacknowledged
	local _consumers
	local unresolved_failures
	local active_receipts
	local pending_outbox
	local processing_reminders

	notification_cutover_last_queue_state="$(
		notification_cutover_queue_state
	)"
	while IFS= read -r expected_queue; do
		[[ -n "$expected_queue" ]] || continue
		queue_line="$(
			awk -v queue="$expected_queue" \
				'$1 == queue { print; exit }' \
				<<<"$notification_cutover_last_queue_state"
		)"
		if [[ -z "$queue_line" ]]; then
			return 1
		fi
		read -r _name ready unacknowledged _consumers <<<"$queue_line"
		if [[ ! "$ready" =~ ^[0-9]+$ ||
			! "$unacknowledged" =~ ^[0-9]+$ ||
			"$ready" != "0" ||
			"$unacknowledged" != "0" ]]; then
			return 1
		fi
	done < <(notification_cutover_expected_queues)

	notification_cutover_last_database_state="$(
		notification_cutover_database_state
	)"
	IFS=$'\t' read -r unresolved_failures active_receipts pending_outbox processing_reminders \
		<<<"$notification_cutover_last_database_state"
	if [[ ! "$unresolved_failures" =~ ^[0-9]+$ ||
		! "$active_receipts" =~ ^[0-9]+$ ||
		! "$pending_outbox" =~ ^[0-9]+$ ||
		! "$processing_reminders" =~ ^[0-9]+$ ]]; then
		return 1
	fi
	[[ "$unresolved_failures" == "0" &&
		"$active_receipts" == "0" &&
		"$pending_outbox" == "0" &&
		"$processing_reminders" == "0" ]]
}

delete_legacy_payment_telegram_queues() {
	local rabbitmq_container_id
	local queue
	local queue_line
	local _name
	local ready
	local unacknowledged
	local consumers
	local state

	if ! validate_notification_cutover_marker; then
		echo "Refusing to delete legacy payment Telegram queues before the durable Telegram cutover marker." >&2
		return 1
	fi
	rabbitmq_container_id="$(
		compose_target ps --status running -q rabbitmq
	)"
	if [[ -z "$rabbitmq_container_id" ||
		"$rabbitmq_container_id" == *$'\n'* ]]; then
		echo "Exactly one running RabbitMQ container is required to retire legacy queues." >&2
		return 1
	fi
	state="$(
		docker exec "$rabbitmq_container_id" \
			rabbitmqctl --silent list_queues \
				-p "$rabbitmq_vhost" \
				name messages_ready messages_unacknowledged consumers
	)"
	for queue in \
		winwidget.payment-notification.telegram \
		winwidget.payment-notification.telegram.dead-letter \
		winwidget.payment-notification.telegram.retry-v2.1 \
		winwidget.payment-notification.telegram.retry-v2.2 \
		winwidget.payment-notification.telegram.retry-v2.3; do
		queue_line="$(
			awk -v queue="$queue" '$1 == queue { print; exit }' <<<"$state"
		)"
		if [[ -z "$queue_line" ]]; then
			continue
		fi
		read -r _name ready unacknowledged consumers <<<"$queue_line"
		if [[ "$ready" != "0" ||
			"$unacknowledged" != "0" ||
			"$consumers" != "0" ]]; then
			echo "Legacy queue is not strictly empty/unowned and cannot be deleted: $queue" >&2
			return 1
		fi
	done
	for queue in \
		winwidget.payment-notification.telegram \
		winwidget.payment-notification.telegram.dead-letter \
		winwidget.payment-notification.telegram.retry-v2.1 \
		winwidget.payment-notification.telegram.retry-v2.2 \
		winwidget.payment-notification.telegram.retry-v2.3; do
		if awk -v queue="$queue" '$1 == queue { found = 1 } END { exit(found ? 0 : 1) }' \
			<<<"$state"; then
			docker exec "$rabbitmq_container_id" \
				rabbitmqctl delete_queue -p "$rabbitmq_vhost" \
					"$queue" --if-empty --if-unused \
				>/dev/null
		fi
	done
	echo "Strictly empty legacy payment Telegram queues were retired."
}

restore_first_cutover_producers_on_exit() {
	local status=$?
	local recovery_failed=false
	local container_id
	local running
	local attempt

	trap - EXIT INT TERM
	if [[ "$first_cutover_recovery_active" != "true" ]]; then
		exit "$status"
	fi

	set +e
	echo "First notification delivery cutover failed before its durable marker; restoring the exact legacy runtime." >&2
	if [[ -n "$first_cutover_marker_tmp" ]]; then
		rm -f "$first_cutover_marker_tmp"
	fi

	if [[ "$first_cutover_candidate_started" == "true" ]]; then
		if ! notification_delivery_service_state_is_empty ||
			! notification_cutover_is_clear ||
			! notification_delivery_service_state_is_empty; then
			echo "CRITICAL: pre-marker state is non-empty or unreadable; refusing automatic legacy rollback." >&2
			echo "Service state (receipts failures outbox): ${notification_cutover_last_service_state:-unavailable}" >&2
			echo "Moved queue state:" >&2
			echo "${notification_cutover_last_queue_state:-unavailable}" >&2
			echo "Candidate workers stay running while producers and public Gateway remain stopped. Resolve the forward state manually." >&2
			exit "$status"
		fi
		if ! stop_notification_cutover_services 30 true \
			"${notification_cutover_pre_marker_services[@]}" \
			>/dev/null 2>&1; then
			recovery_failed=true
		fi
		if ! remove_notification_cutover_services \
			"${notification_cutover_candidate_services[@]}" \
			>/dev/null 2>&1; then
			recovery_failed=true
		fi
	fi

	if ! provision_rabbitmq_user \
		"$integration_user" \
		"$integration_password_base64" \
		'^$' \
		'^(winwidget\.retry|winwidget\.dead-letter)$' \
		"$legacy_integration_read_pattern" \
		''; then
		echo "CRITICAL: broad legacy RabbitMQ permissions could not be restored." >&2
		recovery_failed=true
	fi

	if [[ -n "$first_cutover_legacy_worker_id" ]]; then
		if ! docker image inspect "$(
			docker inspect --format '{{ .Image }}' \
				"$first_cutover_legacy_worker_id" 2>/dev/null
		)" >/dev/null 2>&1 ||
			! docker start "$first_cutover_legacy_worker_id" >/dev/null; then
			echo "CRITICAL: the unchanged legacy integration worker could not be restarted." >&2
			recovery_failed=true
		fi
	fi
	if [[ -n "$first_cutover_legacy_notification_worker_id" ]]; then
		if ! docker image inspect "$(
			docker inspect --format '{{ .Image }}' \
				"$first_cutover_legacy_notification_worker_id" 2>/dev/null
		)" >/dev/null 2>&1 ||
			! docker start \
				"$first_cutover_legacy_notification_worker_id" >/dev/null; then
			echo "CRITICAL: the unchanged v1 Notification Delivery worker could not be restarted." >&2
			recovery_failed=true
		fi
	fi

	if [[ ${#first_cutover_producer_ids[@]} -gt 0 ]] &&
		! docker start "${first_cutover_producer_ids[@]}" >/dev/null; then
		echo "CRITICAL: one or more unchanged producer containers could not be restarted." >&2
		recovery_failed=true
	fi

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		running=true
		for container_id in \
			"$first_cutover_legacy_worker_id" \
			"$first_cutover_legacy_notification_worker_id" \
			"${first_cutover_producer_ids[@]}"; do
			[[ -n "$container_id" ]] || continue
			if [[ "$(docker inspect --format '{{ .State.Running }}' \
				"$container_id" 2>/dev/null)" != "true" ]]; then
				running=false
				break
			fi
		done
		if [[ "$running" == "true" ]] &&
			curl -fsS --connect-timeout 3 --max-time 5 \
				"$HEALTHCHECK_URL" >/dev/null 2>&1 &&
			curl -fsS --connect-timeout 3 --max-time 5 \
				"$GATEWAY_READINESS_URL" >/dev/null 2>&1 &&
			notification_cutover_consumers_ready >/dev/null 2>&1 &&
			verify_exact_worker_consumer_ownership \
				false legacy >/dev/null 2>&1; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "CRITICAL: restored legacy containers did not pass readiness verification." >&2
			recovery_failed=true
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	if [[ "$recovery_failed" == "true" ]]; then
		echo "CRITICAL: automatic first-cutover recovery was incomplete; keep the marker absent and follow the manual runbook." >&2
	else
		echo "The unchanged legacy worker and producers were restored and verified." >&2
	fi
	exit "$status"
}

wait_for_cutover_revision() {
	local url="$1"
	local expected_revision="$2"
	local label="$3"
	local attempt
	local response

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		response="$(
			curl -fsS --connect-timeout 3 --max-time 5 \
				-H 'Cache-Control: no-cache' "$url" 2>/dev/null || true
		)"
		if [[ "$response" == *"\"revision\":\"$expected_revision\""* ]]; then
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo "$label did not report revision $expected_revision." >&2
	return 1
}

wait_for_cutover_readiness() {
	local url="$1"
	local label="$2"
	local attempt

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if curl -fsS --connect-timeout 3 --max-time 5 \
			"$url" >/dev/null 2>&1; then
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo "$label did not become ready." >&2
	return 1
}

wait_for_database_restore_worker() {
	local attempt
	local container_id
	local health
	local image_revision

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(
			compose_target ps -q database-restore-worker 2>/dev/null || true
		)"
		if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
			health="$(
				docker inspect --format \
					'{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
					"$container_id" 2>/dev/null || true
			)"
			image_revision="$(
				docker inspect --format \
					'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
					"$container_id" 2>/dev/null || true
			)"
			if [[ "$health" == 'healthy' &&
				"$image_revision" == "$DATABASE_RESTORE_REVISION" ]]; then
				return 0
			fi
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo 'Database restore worker did not publish revision-bound readiness.' >&2
	return 1
}

verify_active_reporting_runtime() {
	local expected_container_id="${1:-}" expected_image_id="${2:-}"
	local container_id health image_id image_revision app_revision restart_count
	local process_role scheduler_enabled expected_scheduler listen_host response
	local phase phase_index migrated_index scheduler_index
	container_id="$(compose_target ps -a -q reporting-service 2>/dev/null || true)"
	if [[ -z "$container_id" ]]; then
		[[ -z "$expected_container_id" || "$expected_container_id" == 'absent' ]] || {
			echo 'Reporting runtime disappeared during the coordinated deployment.' >&2
			return 1
		}
		if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
			echo 'Reporting cutover is active but reporting-service is absent.' >&2
			return 1
		fi
		return 0
	fi
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
		echo 'Reporting runtime identity is ambiguous.' >&2
		return 1
	}
	[[ "$expected_container_id" != 'absent' ]] || {
		echo 'Reporting runtime appeared during a full deployment which must not manage it.' >&2
		return 1
	}
	[[ -z "$expected_container_id" || "$container_id" == "$expected_container_id" ]] || {
		echo 'Reporting container identity changed during a full deployment.' >&2
		return 1
	}
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
	app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^APP_REVISION=//p')"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	process_role="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_PROCESS_ROLE=//p')"
	scheduler_enabled="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_SCHEDULER_ENABLED=//p')"
	listen_host="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_LISTEN_HOST=//p')"
	expected_scheduler="$(get_env_value REPORTING_SCHEDULER_ENABLED)"
	response="$(curl -fsS --connect-timeout 2 --max-time 5 "$REPORTING_READINESS_URL" 2>/dev/null || true)"
	[[ -z "$expected_image_id" || "$image_id" == "$expected_image_id" ]] || {
		echo 'Reporting image identity changed during a full deployment.' >&2
		return 1
	}
	[[ "$image_revision" =~ ^[0-9a-f]{40}$ ]] &&
		git -C "$server_root" cat-file -e "$image_revision^{commit}" 2>/dev/null &&
		git -C "$server_root" merge-base --is-ancestor \
			"$image_revision" "$REPORTING_REVISION" || {
		echo 'Active Reporting revision is unknown, divergent or newer than the full deployment.' >&2
		return 1
	}
	[[ "$health" == 'healthy' && "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$app_revision" == "$image_revision" && "$restart_count" == '0' &&
		"$process_role" == 'all' && "$listen_host" == '127.0.0.1' &&
		"$scheduler_enabled" == "$expected_scheduler" ]] && {
		printf '%s' "$response" |
			grep -Eq "\"revision\"[[:space:]]*:[[:space:]]*\"$image_revision\""
	} || {
		echo 'Active Reporting runtime failed exact image, config, health or restart verification.' >&2
		return 1
	}
	if [[ ! -e "$REPORTING_CUTOVER_MARKER" && ! -L "$REPORTING_CUTOVER_MARKER" ]]; then
		[[ "$scheduler_enabled" == 'false' ]] || return 1
		return 0
	fi
	reporting_cutover_validate_marker || return 1
	phase="$(reporting_cutover_marker_value phase)"
	phase_index="$(reporting_cutover_phase_index "$phase")"
	migrated_index="$(reporting_cutover_phase_index migrated)"
	scheduler_index="$(reporting_cutover_phase_index scheduler-switched)"
	if ((phase_index >= scheduler_index)); then
		reporting_cutover_require_switch_generation REPORTING
		reporting_cutover_schedule_authority_generation REPORTING REPORTING >/dev/null
		reporting_cutover_require_telegram_topic_split REPORTING
	elif ((phase_index >= migrated_index)); then
		reporting_cutover_schedule_authority_generation CORE CORE_SHADOW >/dev/null
		reporting_cutover_require_telegram_topic_split CORE_SHADOW
	fi
}

verify_cutover_candidate_heartbeats() {
	local started_at="$1"
	local required_services="${2:-outbox-publisher,integration-worker,maintenance-worker}"

	if [[ -z "$started_at" ]]; then
		echo "Forward candidate heartbeat verification requires a start boundary." >&2
		return 1
	fi
	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		-e "CUTOVER_CANDIDATE_STARTED_AT=$started_at" \
		-e "CUTOVER_REQUIRED_HEARTBEATS=$required_services" \
		--entrypoint node \
		"winwidget-api:$APP_VERSION" \
		-e '
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.DATABASE_URL_PRODUCTION,
		},
	},
});
const required = String(process.env.CUTOVER_REQUIRED_HEARTBEATS || "")
	.split(",")
	.map(value => value.trim())
	.filter(Boolean);
if (!required.length) {
	throw new Error("candidate heartbeat list is empty");
}
const startedAtMs = Date.parse(
	process.env.CUTOVER_CANDIDATE_STARTED_AT || "",
);
if (!Number.isFinite(startedAtMs)) {
	throw new Error("invalid forward candidate heartbeat boundary");
}
const freshAfter = new Date(
	Math.max(startedAtMs, Date.now() - 30_000),
);

prisma.messagingHeartbeat
	.findMany({
		where: {
			service: { in: required },
			lastSeenAt: { gte: freshAfter },
		},
		select: { service: true },
	})
	.then(rows => {
		const active = new Set(rows.map(row => row.service));
		const missing = required.filter(service => !active.has(service));
		if (missing.length) {
			throw new Error(`missing candidate heartbeat: ${missing.join(",")}`);
		}
		process.stdout.write("Forward candidate heartbeats verified\n");
	})
	.catch(() => {
		process.stderr.write(
			"Forward candidate messaging heartbeats are incomplete\n",
		);
		process.exitCode = 1;
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
	'
}

verify_notification_cutover_containers() {
	local expected_revision="$1"
	shift
	local service
	local container_id
	local image_revision
	local restart_count

	for service in "$@"; do
		container_id="$(
			compose_notification_cutover ps --status running -q "$service" \
				2>/dev/null || true
		)"
		if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
			echo "Forward cutover service is not running exactly once: $service" >&2
			return 1
		fi
		image_revision="$(
			docker inspect \
				--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$image_revision" != "$expected_revision" ]]; then
			echo "Forward cutover service has an unexpected image revision: $service" >&2
			return 1
		fi
		restart_count="$(
			docker inspect --format '{{ .RestartCount }}' \
				"$container_id" 2>/dev/null || true
		)"
		if [[ "$restart_count" != "0" ]]; then
			echo "Forward cutover service restarted before verification: $service restartCount=${restart_count:-unknown}" >&2
			return 1
		fi
	done
}

verify_notification_cutover_candidate_containers() {
	verify_notification_cutover_containers \
		"$1" \
		"${notification_cutover_candidate_services[@]}"
}

verify_notification_cutover_pre_marker_containers() {
	verify_notification_cutover_containers \
		"$1" \
		"${notification_cutover_pre_marker_services[@]}"
}

verify_notification_cutover_pre_marker_topology() {
	local expected_revision="$1"
	local started_at="$2"
	local attempt

	if ! verify_notification_cutover_pre_marker_containers \
		"$expected_revision"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$HEALTHCHECK_URL" "$expected_revision" \
		"Pre-marker candidate API"; then
		return 1
	fi
	if ! wait_for_cutover_readiness \
		"$READINESS_URL" "Pre-marker candidate API"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$MAINTENANCE_READINESS_URL" "$expected_revision" \
		"Pre-marker candidate Maintenance worker"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$NOTIFICATION_DELIVERY_READINESS_URL" "$expected_revision" \
		"Pre-marker candidate Notification Delivery"; then
		return 1
	fi
	if ! verify_notification_delivery_control_smoke; then
		return 1
	fi
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_cutover_candidate_heartbeats \
			"$started_at" \
			"integration-worker,maintenance-worker"; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			return 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_exact_worker_consumer_ownership true; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "Pre-marker candidate RabbitMQ ownership was not established." >&2
			return 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	if ! notification_cutover_is_clear; then
		echo "Moved queues or legacy delivery state changed during pre-marker verification." >&2
		return 1
	fi
	if ! notification_delivery_service_state_is_empty; then
		echo "Notification Delivery created service-owned state before the durable marker." >&2
		echo "Service state (receipts failures outbox): ${notification_cutover_last_service_state:-unavailable}" >&2
		return 1
	fi
	verify_notification_cutover_pre_marker_containers "$expected_revision"
}

verify_notification_cutover_candidate_topology() {
	local expected_revision="$1"
	local started_at="$2"
	local attempt

	if ! verify_notification_cutover_candidate_containers \
		"$expected_revision"; then
		return 1
	fi

	if ! wait_for_cutover_revision \
		"$HEALTHCHECK_URL" "$expected_revision" \
		"Forward candidate API"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$PUBLIC_HEALTHCHECK_URL" "$expected_revision" \
		"Forward candidate public API"; then
		return 1
	fi
	if ! wait_for_cutover_readiness \
		"$READINESS_URL" "Forward candidate API"; then
		return 1
	fi
	if ! wait_for_cutover_readiness \
		"$GATEWAY_READINESS_URL" "Forward candidate API Gateway"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$MAINTENANCE_READINESS_URL" "$expected_revision" \
		"Forward candidate Maintenance worker"; then
		return 1
	fi
	if ! wait_for_cutover_revision \
		"$NOTIFICATION_DELIVERY_READINESS_URL" "$expected_revision" \
		"Forward candidate Notification Delivery"; then
		return 1
	fi
	if ! verify_notification_delivery_control_smoke; then
		return 1
	fi
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_cutover_candidate_heartbeats "$started_at"; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			return 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_exact_worker_consumer_ownership true; then
			if ! verify_notification_cutover_candidate_containers \
				"$expected_revision"; then
				return 1
			fi
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	echo "Forward candidate RabbitMQ ownership was not established." >&2
	return 1
}

restore_forward_cutover_on_exit() {
	local status=$?
	local recovery_failed=false
	local recovery_started_at

	trap - EXIT INT TERM
	if [[ "$forward_cutover_recovery_active" != "true" ]]; then
		exit "$status"
	fi

	set +e
	echo "Canonical handoff failed after the durable marker; restoring the saved forward topology." >&2
	if ! compose_target stop --timeout 30 \
		api-gateway \
		api \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		database-restore-worker \
		notification-delivery-worker >/dev/null 2>&1; then
		recovery_failed=true
	fi
	recovery_started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	if ! start_notification_cutover_services outbox-publisher >/dev/null; then
		recovery_failed=true
	fi
	if ! wait_for_rabbitmq_topology >/dev/null 2>&1; then
		recovery_failed=true
	fi
	if ! start_notification_cutover_services \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
		api >/dev/null; then
		recovery_failed=true
	fi
	if ! wait_for_cutover_revision \
		"$HEALTHCHECK_URL" \
		"$notification_cutover_marker_revision" \
		"Restored forward candidate API" >/dev/null 2>&1; then
		recovery_failed=true
	fi
	if ! start_notification_cutover_services api-gateway >/dev/null; then
		recovery_failed=true
	fi
	if ! verify_notification_cutover_candidate_topology \
		"$notification_cutover_marker_revision" \
		"$recovery_started_at"; then
		recovery_failed=true
	fi

	if [[ "$recovery_failed" == "true" ]]; then
		echo "CRITICAL: saved forward topology could not be restored completely; keep the durable marker and repair forward." >&2
	else
		echo "Saved forward topology is running; retry the full deployment to canonicalize it." >&2
	fi
	exit "$status"
}

perform_notification_first_cutover_preflight() {
	local legacy_integration_container_id
	local service
	local container_id
	local initial_database_state
	local unresolved_failures
	local active_receipts
	local pending_outbox
	local processing_reminders
	local attempt

	if [[ "$notification_delivery_first_cutover" != "true" ]]; then
		return
	fi

	legacy_integration_container_id="$(
		compose_target ps --status running -q integration-worker
	)"
	if [[ -z "$legacy_integration_container_id" ||
		"$legacy_integration_container_id" == *$'\n'* ]]; then
		echo "Exactly one running legacy integration-worker is required for the first notification delivery cutover." >&2
		print_notification_cutover_runbook
		return 1
	fi
	first_cutover_legacy_worker_id="$legacy_integration_container_id"
	first_cutover_legacy_notification_worker_id="$(
		compose_target ps --status running -q notification-delivery-worker
	)"
	if [[ -z "$first_cutover_legacy_notification_worker_id" ||
		"$first_cutover_legacy_notification_worker_id" == *$'\n'* ]]; then
		echo "Exactly one running v1 Notification Delivery worker is required for the Telegram cutover." >&2
		print_notification_cutover_runbook
		return 1
	fi

	assert_cutover_rabbitmq_topology
	wait_for_rabbitmq_topology
	if ! notification_cutover_consumers_ready; then
		print_notification_cutover_runbook
		return 1
	fi
	if ! verify_exact_worker_consumer_ownership false legacy; then
		echo "The moved queues are not owned exclusively by the exact legacy integration connection." >&2
		print_notification_cutover_runbook
		return 1
	fi

	initial_database_state="$(notification_cutover_database_state)"
	IFS=$'\t' read -r unresolved_failures active_receipts pending_outbox processing_reminders \
		<<<"$initial_database_state"
	if [[ ! "$unresolved_failures" =~ ^[0-9]+$ ||
		! "$active_receipts" =~ ^[0-9]+$ ||
		! "$pending_outbox" =~ ^[0-9]+$ ||
		! "$processing_reminders" =~ ^[0-9]+$ ]]; then
		echo "Public delivery state returned an invalid provider-cutover result." >&2
		print_notification_cutover_runbook
		return 1
	fi
	if [[ "$unresolved_failures" != "0" ]]; then
		echo "First cutover is blocked by $unresolved_failures unresolved public delivery failure(s)." >&2
		print_notification_cutover_runbook
		return 1
	fi
	for service in \
		outbox-publisher \
		api \
		api-gateway \
		maintenance-worker \
		campaigns-service; do
		container_id="$(
			compose_target ps --status running -q "$service"
		)"
		if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
			echo "Exactly one running $service is required before the Telegram cutover." >&2
			print_notification_cutover_runbook
			return 1
		fi
		first_cutover_producer_ids+=("$container_id")
	done

	echo "Notification Delivery provider cutover: stopping producers and draining legacy provider work."
	first_cutover_recovery_active=true
	trap restore_first_cutover_producers_on_exit EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	compose_target stop api-gateway
	compose_target stop api
	compose_target stop maintenance-worker
	compose_target stop campaigns-service

	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if notification_cutover_is_clear; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "Legacy notification queues did not reach a safe empty boundary." >&2
			echo "Queue state (name ready unacknowledged consumers):" >&2
			echo "$notification_cutover_last_queue_state" >&2
			echo "Database state (unresolved_failures active_receipts): ${notification_cutover_last_database_state:-unavailable}" >&2
			print_notification_cutover_runbook
			return 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	compose_target stop outbox-publisher
	if ! notification_cutover_is_clear; then
		echo "Moved Telegram state changed while stopping the legacy Outbox publisher." >&2
		echo "$notification_cutover_last_queue_state" >&2
		print_notification_cutover_runbook
		return 1
	fi

	compose_target stop integration-worker
	if ! notification_cutover_is_clear; then
		echo "Moved notification state changed while stopping the legacy integration-worker." >&2
		echo "$notification_cutover_last_queue_state" >&2
		print_notification_cutover_runbook
		return 1
	fi
	compose_target stop notification-delivery-worker

	echo "Notification Delivery Telegram cutover boundary is quiescent and verified."
}

reporting_runtime_container_before="$(
	compose_target ps -a -q reporting-service 2>/dev/null || true
)"
if [[ "$reporting_runtime_container_before" =~ ^[0-9a-f]{64}$ ]]; then
	reporting_runtime_image_before="$(
		docker inspect --format '{{.Image}}' "$reporting_runtime_container_before"
	)"
elif [[ -z "$reporting_runtime_container_before" ]]; then
	reporting_runtime_container_before='absent'
	reporting_runtime_image_before=''
else
	reporting_runtime_image_before=''
fi
reporting_cleanup_runtime_deploy=false
reporting_cleanup_migration_state='not-applicable'
if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
	reporting_cutover_validate_marker || exit 1
	if [[ "$(reporting_cutover_marker_value phase)" == 'cleanup-staged' &&
		"$(reporting_cutover_marker_value cleanup_revision)" == "$APP_REVISION" ]]; then
		reporting_cleanup_migration_state="$(
			reporting_cutover_core_cleanup_migration_state "$APP_REVISION"
		)" || exit 1
		case "$reporting_cleanup_migration_state" in
		pending | applied) ;;
		unfinished-transition | unfinished-steady)
			echo 'Reporting cleanup has an exact unfinished Prisma attempt; keep writers stopped and use the separately reviewed resolve procedure.' >&2
			exit 1
			;;
		*)
			echo 'Reporting cleanup migration ledger/schema/checksum state is unsafe.' >&2
			exit 1
			;;
		esac
		reporting_cleanup_runtime_deploy=true
		if [[ "$reporting_cleanup_migration_state" == 'pending' ]]; then
			echo 'Exact staged cleanup will stop or adopt the pinned rollback containers before the Core migration.'
		else
			echo 'Exact cleanup migration is already applied; all old writers are fenced and recovery is forward-only.'
		fi
	fi
fi
if [[ "$reporting_cleanup_runtime_deploy" != 'true' ]]; then
	verify_active_reporting_runtime \
		"$reporting_runtime_container_before" \
		"$reporting_runtime_image_before" || {
		echo 'Reporting runtime preflight failed before any database migration or runtime handoff.' >&2
		exit 1
	}
fi

if [[ "$reporting_cleanup_runtime_deploy" == 'true' ]]; then
	[[ "$notification_delivery_first_cutover" != 'true' &&
		"$notification_forward_candidate_active" != 'true' &&
		"$notification_forward_candidate_needs_recovery" != 'true' ]] || {
		echo 'Reporting cleanup cannot overlap a Notification Delivery cutover or recovery.' >&2
		exit 1
	}
	echo 'Pinned Reporting cleanup revision skips already-completed service migrations; its reviewed Git contract permits only the exact Core cleanup migration.'
else
verify_notification_delivery_migration_boundary
if [[ "$notification_forward_candidate_active" == "true" ]]; then
	compose_target \
		--profile notification-delivery-migration \
		run --rm --no-deps notification-delivery-migrate \
		migrate status \
		--schema prisma/schema.prisma
else
	compose_target \
		--profile notification-delivery-migration \
		run --rm --no-deps notification-delivery-migrate
fi
finalize_notification_delivery_backup_grants
verify_notification_delivery_runtime_crud
verify_notification_delivery_backup_boundary
current_campaigns_container_id="$(
	compose_target ps --status running -q campaigns-service 2>/dev/null || true
)"
[[ -n "$current_campaigns_container_id" &&
	"$current_campaigns_container_id" != *$'\n'* ]] || {
	echo "Routine full deploy requires one running Campaigns service." >&2
	exit 1
}
current_campaigns_revision="$(
	docker image inspect \
		--format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
		"$(docker inspect --format '{{.Image}}' "$current_campaigns_container_id")"
)"
[[ "$current_campaigns_revision" =~ ^[0-9a-f]{40}$ ]] ||
	{
		echo "Current Campaigns image revision is invalid." >&2
		exit 1
	}
git -C "$server_root" merge-base --is-ancestor \
	"$current_campaigns_revision" "$CAMPAIGNS_REVISION" || {
	echo "Routine full deploy does not accept divergent Campaigns history." >&2
	exit 1
}
changed_campaigns_migrations="$(
	git -C "$server_root" diff --name-only \
		"$current_campaigns_revision" "$CAMPAIGNS_REVISION" -- \
		'apps/campaigns/prisma/migrations/*/migration.sql'
)"
while IFS= read -r migration; do
	[[ -z "$migration" ]] && continue
	if git -C "$server_root" diff --unified=0 \
		"$current_campaigns_revision" "$CAMPAIGNS_REVISION" -- "$migration" |
		sed -n 's/^+//p' |
		grep -Eiq \
			'(^|[[:space:]])(DROP|TRUNCATE)[[:space:]]|RENAME[[:space:]]|ALTER[[:space:]]+COLUMN|SET[[:space:]]+NOT[[:space:]]+NULL|DROP[[:space:]]+NOT[[:space:]]+NULL'; then
		echo "Routine full deploy found a breaking Campaigns migration: $migration" >&2
		echo "Use a separately reviewed coordinated Campaigns migration plan." >&2
		exit 1
	fi
done <<<"$changed_campaigns_migrations"
if [[ -n "$changed_campaigns_migrations" ]]; then
	create_campaigns_pre_migration_backup
fi
compose_target \
	--profile campaigns-migration \
	run --rm --no-deps campaigns-migrate
verify_campaigns_database_access_boundaries

if [[ "$notification_delivery_first_cutover" == "true" ]]; then
	if ! compose_target --profile migration run --rm --no-deps \
		migrate migrate status; then
		echo "The first notification cutover cannot carry a pending core schema migration." >&2
		echo "Deploy the core expand migration separately, then rerun the full cutover." >&2
		exit 1
	fi
fi

perform_notification_first_cutover_preflight

if [[ "$notification_delivery_first_cutover" == "true" ]]; then
	assert_cutover_rabbitmq_topology
	wait_for_rabbitmq_topology
fi

if [[ "$notification_delivery_first_cutover" != "true" ]] &&
	validate_notification_cutover_marker; then
	delete_legacy_payment_telegram_queues
fi

if [[ "$notification_forward_candidate_needs_recovery" == "true" ]]; then
	echo "Restoring the exact saved forward topology before canonical handoff."
	forward_cutover_recovery_active=true
	trap restore_forward_cutover_on_exit EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	start_notification_cutover_services outbox-publisher
	wait_for_rabbitmq_topology
	start_notification_cutover_services \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
		api
	wait_for_cutover_revision \
		"$HEALTHCHECK_URL" \
		"$notification_cutover_marker_revision" \
		"Recovered forward candidate API"
	start_notification_cutover_services api-gateway
	echo "Exact saved forward topology was restarted."
fi

if [[ "$notification_delivery_first_cutover" == "true" ]]; then
	provision_rabbitmq_user \
		"$integration_user" \
		"$integration_password_base64" \
		'^$' \
		'^(winwidget\.retry|winwidget\.dead-letter)$' \
		"$post_cutover_integration_read_pattern" \
		''
	echo "Integration RabbitMQ read permissions were narrowed after the verified Telegram cutover boundary."

	notification_cutover_candidate_started_at="$(
		date -u +'%Y-%m-%dT%H:%M:%S.%3NZ'
	)"
	first_cutover_candidate_started=true
	# Production Compose does not support --no-deps on `create`.
	# `up --no-start` pre-creates the two post-marker services in isolation.
	compose_notification_cutover up \
		--no-start \
		--no-deps \
		--force-recreate \
		outbox-publisher \
		api-gateway
	compose_notification_cutover up \
		-d \
		--no-deps \
		--force-recreate \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker \
		api

	verify_notification_cutover_pre_marker_topology \
		"$APP_REVISION" \
		"$notification_cutover_candidate_started_at"

	umask 077
	first_cutover_marker_tmp="$(
		mktemp "${NOTIFICATION_DELIVERY_CUTOVER_MARKER}.tmp.XXXXXX"
	)"
	{
		printf 'revision=%s\n' "$APP_REVISION"
		printf 'created_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
	} >"$first_cutover_marker_tmp"
	chmod 600 "$first_cutover_marker_tmp"
	# From this point a marker means the isolated worker/API topology was
	# verified and rollback must continue forward. Ignore termination only
	# across the atomic marker/trap state transition.
	trap '' INT TERM
	mv "$first_cutover_marker_tmp" "$NOTIFICATION_DELIVERY_CUTOVER_MARKER"
	first_cutover_marker_tmp=""
	notification_cutover_marker_revision="$APP_REVISION"
	notification_forward_candidate_active=true
	first_cutover_recovery_active=false
	echo "Durable notification delivery cutover marker created before enabling producers or public traffic."
	# Keep every producer stopped until the legacy payment queue and its
	# payment.succeeded.v1 binding are gone. If retirement fails, exit
	# fail-closed with the marker present; the next full deploy resumes forward
	# before any publisher or public Gateway is started.
	delete_legacy_payment_telegram_queues
	forward_cutover_recovery_active=true
	trap restore_forward_cutover_on_exit EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	start_notification_cutover_services outbox-publisher
	wait_for_rabbitmq_topology
	start_notification_cutover_services api-gateway
	echo "The saved cutover project stays available until canonical Compose handoff is fully verified."
fi
fi

if [[ "$notification_forward_candidate_active" == "true" ]]; then
	notification_cutover_candidate_verification_started_at="$(
		date -u +'%Y-%m-%dT%H:%M:%S.%3NZ'
	)"
	verify_notification_cutover_candidate_topology \
		"$notification_cutover_marker_revision" \
		"$notification_cutover_candidate_verification_started_at"
	forward_cutover_recovery_active=true
	trap restore_forward_cutover_on_exit EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM

	echo "Canonicalizing the verified forward cutover topology service by service."
	echo "Candidate containers are retained as the post-marker recovery target until final smoke passes."
	compose_target --profile migration run --rm --no-deps migrate
	compose_target up -d rabbitmq
	messaging_readiness_started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"

	# Outbox publishers are CAS-safe, so start the canonical instance before
	# pausing its saved forward counterpart.
	compose_target up -d --no-deps --force-recreate outbox-publisher
	if [[ -z "$(compose_target ps --status running -q outbox-publisher)" ]]; then
		echo "Canonical Outbox publisher did not start." >&2
		exit 1
	fi
	stop_notification_cutover_services 30 false outbox-publisher
	wait_for_rabbitmq_topology

	# The two narrow integration workers are idempotent; overlap is limited to
	# startup and ends before exact ownership is checked.
	compose_target up -d --no-deps --force-recreate integration-worker
	if [[ -z "$(compose_target ps --status running -q integration-worker)" ]]; then
		echo "Canonical integration worker did not start." >&2
		exit 1
	fi
	stop_notification_cutover_services 30 false integration-worker
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_exact_worker_consumer_ownership true; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "Canonical integration ownership was not established." >&2
			exit 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	stop_notification_cutover_services 30 false maintenance-worker
	compose_target up -d --no-deps --force-recreate maintenance-worker
	wait_for_cutover_revision \
		"$MAINTENANCE_READINESS_URL" \
		"$MAINTENANCE_REVISION" \
		"Canonical Maintenance worker"

	compose_target up -d --no-deps --force-recreate database-restore-worker
	wait_for_database_restore_worker

	stop_notification_cutover_services 30 false notification-delivery-worker
	compose_target up -d --no-deps --force-recreate notification-delivery-worker
	wait_for_cutover_revision \
		"$NOTIFICATION_DELIVERY_READINESS_URL" \
		"$NOTIFICATION_DELIVERY_REVISION" \
		"Canonical Notification Delivery"
	verify_notification_delivery_control_smoke
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		if verify_exact_worker_consumer_ownership true; then
			break
		fi
		if ((attempt == HEALTHCHECK_ATTEMPTS)); then
			echo "Canonical notification ownership was not established." >&2
			exit 1
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done

	compose_target up -d --no-deps --force-recreate campaigns-service
	wait_for_cutover_revision \
		"$CAMPAIGNS_READINESS_URL" \
		"$CAMPAIGNS_REVISION" \
		"Canonical Campaigns"

	stop_notification_cutover_services 30 false api
	compose_target up -d --no-deps --force-recreate api
	wait_for_cutover_revision \
		"$HEALTHCHECK_URL" "$APP_REVISION" "Canonical API"
	wait_for_cutover_readiness "$READINESS_URL" "Canonical API"

	stop_notification_cutover_services 30 false api-gateway
	compose_target up -d --no-deps --force-recreate api-gateway
	wait_for_cutover_readiness \
		"$GATEWAY_READINESS_URL" "Canonical API Gateway"
	wait_for_cutover_revision \
		"$PUBLIC_HEALTHCHECK_URL" "$APP_REVISION" "Canonical public API"
else
	if [[ "$reporting_cleanup_runtime_deploy" == 'true' ]]; then
		reporting_cleanup_stop_recovery_active=true
		trap recover_reporting_cleanup_stop_on_exit EXIT
		trap 'exit 130' INT
		trap 'exit 143' TERM
		if ! stop_reporting_cleanup_topology_for_core_migration \
			"$reporting_cleanup_migration_state"; then
			echo 'Reporting cleanup topology did not reach an exact quiescent recovery boundary.' >&2
			exit 1
		fi
	elif ! stop_routine_topology_for_core_migration; then
		echo "Routine production topology did not reach a safe core migration boundary." >&2
		exit 1
	fi
	if [[ -e "$REPORTING_CUTOVER_MARKER" || -L "$REPORTING_CUTOVER_MARKER" ]]; then
		reporting_cutover_validate_marker || {
			if [[ "$reporting_cleanup_runtime_deploy" != 'true' ]]; then
				restore_routine_containers_after_failed_stop || true
			fi
			exit 1
		}
		if [[ "$(reporting_cutover_marker_value phase)" == 'cleanup-staged' &&
			"$(reporting_cutover_marker_value cleanup_revision)" == "$APP_REVISION" ]]; then
			if [[ "$reporting_cleanup_migration_state" == 'pending' ]]; then
				core_cleanup_backup_gate='reporting_cutover_require_core_cleanup_backup_from_review'
			else
				core_cleanup_backup_gate='reporting_cutover_require_core_cleanup_backup_archive_from_review'
			fi
			if ! "$core_cleanup_backup_gate"; then
				echo 'Verified Core cleanup backup evidence changed, expired or no longer matches the pre-migration boundary.' >&2
				exit 1
			fi
			if ! reporting_cutover_require_cleanup_legacy_drain_after_stop; then
				echo 'Legacy Reporting drain changed at the destructive migration boundary; no migration was executed.' >&2
				exit 1
			fi
			if ! reporting_cutover_prepare_settings_topology_cleanup_after_stop; then
				echo 'Reporting settings topology could not converge at the stopped cleanup boundary.' >&2
				exit 1
			fi
		fi
	fi
	if [[ "$reporting_cleanup_runtime_deploy" == 'true' &&
		"$reporting_cleanup_migration_state" == 'applied' ]]; then
		echo 'Exact Core cleanup migration is already applied; Prisma deploy is skipped during forward-only recovery.'
	elif ! compose_target --profile migration run --rm --no-deps migrate; then
		if [[ "$reporting_cleanup_runtime_deploy" != 'true' ]]; then
			exit 1
		fi
		reporting_cleanup_migration_state="$(
			reporting_cutover_core_cleanup_migration_state "$APP_REVISION" 2>/dev/null ||
				printf 'unsafe\n'
		)"
		if [[ "$reporting_cleanup_migration_state" != 'applied' ]]; then
			echo "Core cleanup migrate failed with post-command state=$reporting_cleanup_migration_state; recovery remains fail-closed." >&2
			exit 1
		fi
		echo 'Prisma command failed after the exact cleanup migration became applied; continuing forward without restoring old writers.' >&2
	fi
	if [[ "$reporting_cleanup_runtime_deploy" == 'true' ]]; then
		reporting_cleanup_migration_state="$(
			reporting_cutover_core_cleanup_migration_state "$APP_REVISION"
		)" || exit 1
		[[ "$reporting_cleanup_migration_state" == 'applied' ]] || {
			echo "Cleanup Reporting cannot start until the exact migration state is applied; got $reporting_cleanup_migration_state." >&2
			exit 1
		}
	fi
	compose_target up -d rabbitmq
	messaging_readiness_started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	if [[ "$reporting_cleanup_runtime_deploy" == 'true' ]]; then
		compose_target up -d --no-deps --force-recreate reporting-service
		wait_for_cutover_revision \
			"$REPORTING_READINESS_URL" "$REPORTING_REVISION" \
			"Cleanup Reporting"
		reporting_require_rabbitmq_topology
		reporting_runtime_container_before="$(
			compose_target ps --status running -q reporting-service
		)"
		reporting_runtime_image_before="$(
			docker inspect --format '{{.Image}}' "$reporting_runtime_container_before"
		)"
	fi
	compose_target up -d --no-deps --force-recreate outbox-publisher
	wait_for_rabbitmq_topology
	compose_target up -d --no-deps --force-recreate \
		integration-worker \
		maintenance-worker \
		database-restore-worker \
		notification-delivery-worker \
		campaigns-service
	compose_target up -d --no-deps --force-recreate api
	compose_target up -d --no-deps --force-recreate api-gateway
fi

show_api_diagnostics() {
	echo "API deployment diagnostics:"
	compose_target \
		ps api-gateway api outbox-publisher integration-worker maintenance-worker database-restore-worker notification-delivery-worker campaigns-service reporting-service rabbitmq || true
	compose_target \
		logs --tail=100 api-gateway api outbox-publisher integration-worker maintenance-worker database-restore-worker notification-delivery-worker campaigns-service reporting-service rabbitmq || true
	echo "Processes listening on ports 4100, 4200, 4300, 4401, 4500 and 4600:"
	ss -ltnp \
		'( sport = :4100 or sport = :4200 or sport = :4300 or sport = :4401 or sport = :4500 or sport = :4600 )' ||
		true
}

ensure_required_services_running() {
	local service
	local container_id
	for service in \
		rabbitmq \
		api \
		api-gateway \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		database-restore-worker \
		notification-delivery-worker \
		campaigns-service; do
		container_id="$(
			compose_target ps --status running -q "$service"
		)"
		if [[ -z "$container_id" ]]; then
			echo "Required service is not running: $service" >&2
			show_api_diagnostics
			exit 1
		fi
	done
}

check_deployment_revision() {
	local url="$1"
	local response
	response="$(
		curl -fsS --connect-timeout 3 --max-time 5 \
			-H 'Cache-Control: no-cache' "$url" || true
	)"

	if [[ "$response" == *"\"revision\":\"$APP_REVISION\""* ]]; then
		return 0
	fi

	if [[ -n "$response" ]]; then
		echo "Unexpected deployment health response from $url: $response"
	fi
	return 1
}

check_messaging_readiness() {
	compose_target exec -T \
		-e "MESSAGING_READINESS_STARTED_AT=$messaging_readiness_started_at" \
		-e "INTEGRATION_WORKER_KINDS=$(get_env_value INTEGRATION_WORKER_KINDS)" \
		-e "MAINTENANCE_WORKER_KINDS=$(get_env_value MAINTENANCE_WORKER_KINDS)" \
		-e "NOTIFICATION_DELIVERY_KINDS=$(get_env_value NOTIFICATION_DELIVERY_KINDS)" \
		api node - <<'NODE'
const { PrismaClient } = require('@prisma/client');
const {
	INTEGRATION_KINDS,
	MAINTENANCE_KINDS,
	NOTIFICATION_DELIVERY_KINDS,
	MESSAGING_QUEUE_NAMES
} = require('./dist/src/messaging/messaging.constants.js');

class ReadinessError extends Error {}

const requiredServices = [
	'outbox-publisher',
	'integration-worker',
	'maintenance-worker'
];

const parseEnabledKinds = (name, supportedKinds) => {
	const value = process.env[name] || '';
	const kinds = value
		.split(',')
		.map(item => item.trim())
		.filter(Boolean);
	const invalid = kinds.filter(kind => !supportedKinds.includes(kind));
	if (!kinds.length || invalid.length) {
		throw new ReadinessError(
			invalid.length
				? `${name} has unsupported values: ${invalid.join(', ')}`
				: `${name} is empty`
		);
	}
	return [...new Set(kinds)];
};

const run = async () => {
	const mode = (process.env.MODE || 'production').trim().toLowerCase();
	const databaseUrl =
		mode === 'production'
			? process.env.DATABASE_URL_PRODUCTION
			: process.env.DATABASE_URL_DEVELOPMENT;
	if (!databaseUrl) {
		throw new ReadinessError('Messaging readiness database URL is missing');
	}

	const startedAt = Date.parse(
		process.env.MESSAGING_READINESS_STARTED_AT || ''
	);
	if (!Number.isFinite(startedAt)) {
		throw new ReadinessError('Messaging readiness timestamp is invalid');
	}
	const requiredKinds = [
		...parseEnabledKinds('INTEGRATION_WORKER_KINDS', INTEGRATION_KINDS),
		...parseEnabledKinds('MAINTENANCE_WORKER_KINDS', MAINTENANCE_KINDS),
		...parseEnabledKinds(
			'NOTIFICATION_DELIVERY_KINDS',
			NOTIFICATION_DELIVERY_KINDS
		)
	];
	const requiredQueues = requiredKinds.flatMap(kind => {
		const queue = MESSAGING_QUEUE_NAMES[kind];
		if (!queue) {
			throw new ReadinessError(`RabbitMQ queue is unknown for ${kind}`);
		}
		return [queue, `${queue}.dead-letter`];
	});
	const freshAfter = new Date(Math.max(startedAt, Date.now() - 30_000));
	const prisma = new PrismaClient({
		datasources: { db: { url: databaseUrl } }
	});

	try {
		const heartbeats = await prisma.messagingHeartbeat.findMany({
			where: {
				service: { in: requiredServices },
				lastSeenAt: { gte: freshAfter }
			},
			select: { service: true }
		});
		const activeServices = new Set(heartbeats.map(item => item.service));
		const missingServices = requiredServices.filter(
			service => !activeServices.has(service)
		);
		if (missingServices.length) {
			throw new ReadinessError(
				`Missing fresh heartbeat: ${missingServices.join(', ')}`
			);
		}

		const baseUrl = (
			process.env.RABBITMQ_MANAGEMENT_URL || 'http://127.0.0.1:15672'
		).replace(/\/$/, '');
		const user = process.env.RABBITMQ_MONITOR_USER;
		const password = process.env.RABBITMQ_MONITOR_PASSWORD;
		const vhost = process.env.RABBITMQ_VHOST || 'winwidget';
		if (!user || !password) {
			throw new ReadinessError(
				'RabbitMQ management credentials are missing'
			);
		}
			const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString(
				'base64'
			)}`;
			const nodesResponse = await fetch(`${baseUrl}/api/nodes`, {
				headers: { Authorization: authorization },
				signal: AbortSignal.timeout(4000)
			});
			if (!nodesResponse.ok) {
				await nodesResponse.body?.cancel();
				throw new ReadinessError(
					`RabbitMQ nodes returned HTTP ${nodesResponse.status}`
				);
			}
			const nodes = await nodesResponse.json();
			if (
				!Array.isArray(nodes) ||
				!nodes.length ||
				nodes.some(
					node =>
						node.running === false ||
						node.mem_alarm === true ||
						node.disk_free_alarm === true ||
						(Array.isArray(node.partitions) &&
							node.partitions.length > 0)
				)
			) {
				throw new ReadinessError(
					'RabbitMQ node is stopped or reports an alarm/partition'
				);
			}

			for (const queue of requiredQueues) {
			let response;
			try {
				response = await fetch(
					`${baseUrl}/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`,
					{
						headers: { Authorization: authorization },
						signal: AbortSignal.timeout(4000)
					}
				);
			} catch {
				throw new ReadinessError(
					`RabbitMQ queue check failed: ${queue}`
				);
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new ReadinessError(
					`RabbitMQ queue ${queue} returned HTTP ${response.status}`
				);
			}
			const state = await response.json();
			if (!Number.isInteger(state.consumers) || state.consumers < 1) {
				throw new ReadinessError(
					`RabbitMQ queue has no consumers: ${queue}`
				);
			}
		}
	} finally {
		await prisma.$disconnect();
	}
};

run()
	.then(() => {
		process.stdout.write(
			'Messaging heartbeats and RabbitMQ consumers are ready\n'
		);
	})
	.catch(error => {
		const message =
			error instanceof ReadinessError
				? error.message
				: 'Messaging readiness could not query PostgreSQL or RabbitMQ';
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
NODE
}

ensure_required_services_running

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$HEALTHCHECK_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Backend revision healthcheck failed: $HEALTHCHECK_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

if ! verify_active_reporting_runtime \
	"$reporting_runtime_container_before" \
	"$reporting_runtime_image_before"; then
	echo "Reporting runtime verification failed: $REPORTING_READINESS_URL"
	show_api_diagnostics
	exit 1
fi

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$PUBLIC_HEALTHCHECK_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Public backend revision healthcheck failed: $PUBLIC_HEALTHCHECK_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if curl -fsS --connect-timeout 3 --max-time 5 "$READINESS_URL" > /dev/null; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Backend readiness check failed: $READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if curl -fsS --connect-timeout 3 --max-time 5 "$GATEWAY_READINESS_URL" > /dev/null; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "API Gateway readiness check failed: $GATEWAY_READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$MAINTENANCE_READINESS_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Maintenance readiness check failed: $MAINTENANCE_READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

if ! wait_for_database_restore_worker; then
	show_api_diagnostics
	exit 1
fi

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$NOTIFICATION_DELIVERY_READINESS_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Notification delivery readiness check failed: $NOTIFICATION_DELIVERY_READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_deployment_revision "$CAMPAIGNS_READINESS_URL"; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Campaigns readiness check failed: $CAMPAIGNS_READINESS_URL"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if check_messaging_readiness; then
		break
	fi

	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Messaging readiness check failed"
		show_api_diagnostics
		exit 1
	fi

	sleep "$HEALTHCHECK_INTERVAL"
done

for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
	if verify_exact_worker_consumer_ownership true; then
		break
	fi
	if ((attempt == HEALTHCHECK_ATTEMPTS)); then
		echo "Exact RabbitMQ consumer ownership verification failed"
		show_api_diagnostics
		exit 1
	fi
	sleep "$HEALTHCHECK_INTERVAL"
done

ensure_required_services_running

for service in \
	api-gateway \
	api \
	outbox-publisher \
	integration-worker \
	maintenance-worker \
	database-restore-worker \
	notification-delivery-worker \
	campaigns-service; do
	container_id="$(
		compose_target ps -q "$service"
	)"
	image_revision="$(
		docker inspect \
			--format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
			"$container_id"
	)"
	expected_image_revision="$APP_REVISION"
	if [[ "$service" == "maintenance-worker" ]]; then
		expected_image_revision="$MAINTENANCE_REVISION"
	fi
	if [[ "$service" == "database-restore-worker" ]]; then
		expected_image_revision="$DATABASE_RESTORE_REVISION"
	fi
	if [[ "$service" == "notification-delivery-worker" ]]; then
		expected_image_revision="$NOTIFICATION_DELIVERY_REVISION"
	fi
	if [[ "$service" == "campaigns-service" ]]; then
		expected_image_revision="$CAMPAIGNS_REVISION"
	fi
	if [[ "$image_revision" != "$expected_image_revision" ]]; then
		echo "$service image revision mismatch: expected $expected_image_revision, got $image_revision"
		show_api_diagnostics
		exit 1
	fi

	restart_count="$(
		docker inspect --format '{{ .RestartCount }}' "$container_id"
	)"
	if [[ "$restart_count" != "0" ]]; then
		echo "$service restarted during deployment: restartCount=$restart_count"
		show_api_diagnostics
		exit 1
	fi
done

if [[ "$notification_forward_candidate_active" == "true" ]]; then
	# Canonical services passed the complete deployment smoke, so the saved
	# forward topology is no longer the recovery authority.
	forward_cutover_recovery_active=false
	trap - EXIT INT TERM
	notification_cutover_cleanup_complete=false
	for ((attempt = 1; attempt <= 5; attempt++)); do
		if remove_notification_cutover_services \
			"${notification_cutover_candidate_services[@]}"; then
			remaining_cutover_candidate_ids="$(
				compose_notification_cutover ps -a -q \
					"${notification_cutover_candidate_services[@]}" \
					2>/dev/null || true
			)"
			if [[ -z "$remaining_cutover_candidate_ids" ]]; then
				notification_cutover_cleanup_complete=true
				break
			fi
		fi
		if ((attempt < 5)); then
			sleep "$HEALTHCHECK_INTERVAL"
		fi
	done
	if [[ "$notification_cutover_cleanup_complete" != "true" ]]; then
		echo "Canonical topology is healthy, but saved forward containers could not be removed after five attempts." >&2
		echo "Remove only the stopped $NOTIFICATION_DELIVERY_CUTOVER_PROJECT containers before the next deployment." >&2
		exit 1
	fi
	notification_forward_candidate_active=false
	echo "Canonical topology verified; saved forward cutover containers removed."
fi

if [[ "$reporting_cleanup_runtime_deploy" == 'true' ]]; then
	reporting_require_rabbitmq_topology
	reporting_cutover_require_cleanup_runtime_revision "$APP_REVISION"
	echo 'Reporting cleanup runtime and steady-state RabbitMQ topology verified.'
fi

verify_notification_database_lifecycle_unchanged \
	"the routine full deployment" \
	"$notification_database_phase_before"
verify_campaigns_database_lifecycle_unchanged
reporting_verify_database_lifecycle_unchanged

if [[ "$reporting_cleanup_stop_recovery_active" == 'true' ]]; then
	reporting_cleanup_stop_recovery_active=false
	trap - EXIT INT TERM
fi

echo "Backend revision verified locally and publicly: $APP_REVISION"

compose_target ps \
	api-gateway api outbox-publisher integration-worker maintenance-worker database-restore-worker notification-delivery-worker campaigns-service reporting-service rabbitmq
