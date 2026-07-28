#!/usr/bin/env bash

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:4200/api/v1/health/deployment}"
PUBLIC_HEALTHCHECK_URL="${PUBLIC_HEALTHCHECK_URL:-https://api.winwidget.ru/api/v1/health/deployment}"
READINESS_URL="${READINESS_URL:-http://127.0.0.1:4200/api/v1/health/ready}"
GATEWAY_READINESS_URL="${GATEWAY_READINESS_URL:-http://127.0.0.1:4100/health/ready}"
MAINTENANCE_READINESS_URL="${MAINTENANCE_READINESS_URL:-http://127.0.0.1:4300/health/ready}"
NOTIFICATION_DELIVERY_READINESS_URL="${NOTIFICATION_DELIVERY_READINESS_URL:-http://127.0.0.1:4401/health/ready}"
NOTIFICATION_DELIVERY_INITIAL_CUTOVER_MARKER="$APP_ROOT/deploy/backend/.notification-delivery-cutover-v1"
NOTIFICATION_DELIVERY_CUTOVER_MARKER="$APP_ROOT/deploy/backend/.notification-delivery-telegram-cutover-v1"
NOTIFICATION_DELIVERY_CUTOVER_PROJECT="winwidget-notification-telegram-cutover"
HEALTHCHECK_ATTEMPTS="${HEALTHCHECK_ATTEMPTS:-30}"
HEALTHCHECK_INTERVAL="${HEALTHCHECK_INTERVAL:-2}"

cd "$APP_ROOT"

server_root="$APP_ROOT/winwidget.ru_server"
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

export APP_REVISION="$deploy_revision"
export APP_VERSION="git-$deploy_revision"
export MAINTENANCE_REVISION="$deploy_revision"
export MAINTENANCE_IMAGE="winwidget-maintenance:git-$deploy_revision"
export NOTIFICATION_DELIVERY_REVISION="$deploy_revision"
export NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:git-$deploy_revision"

echo "Deploying backend revision: $APP_REVISION"
echo "Building backend image: winwidget-api:$APP_VERSION"
echo "Building gateway image: winwidget-api-gateway:$APP_VERSION"
echo "Building maintenance image: $MAINTENANCE_IMAGE"
echo "Building notification delivery image: $NOTIFICATION_DELIVERY_IMAGE"

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
		APP_REVISION | APP_VERSION | MAINTENANCE_IMAGE | MAINTENANCE_REVISION | NOTIFICATION_DELIVERY_IMAGE | NOTIFICATION_DELIVERY_REVISION)
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
	local api_user
	local migration_user
	local maintenance_user
	local backup_user
	local notification_delivery_user
	local notification_delivery_migration_user

	api_user="$(get_database_username DATABASE_URL_PRODUCTION)"
	migration_user="$(get_database_username DATABASE_MIGRATION_URL_PRODUCTION)"
	maintenance_user="$(
		get_database_username MAINTENANCE_DATABASE_URL_PRODUCTION
	)"
	backup_user="$(get_database_username DATABASE_BACKUP_URL)"
	notification_delivery_user="$(
		get_database_username NOTIFICATION_DELIVERY_DATABASE_URL
	)"
	notification_delivery_migration_user="$(
		get_database_username NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION
	)"

	if [[ "$api_user" == "$migration_user" ||
		"$api_user" == "$maintenance_user" ||
		"$api_user" == "$backup_user" ||
		"$api_user" == "$notification_delivery_user" ||
		"$api_user" == "$notification_delivery_migration_user" ||
		"$migration_user" == "$maintenance_user" ||
		"$migration_user" == "$backup_user" ||
		"$migration_user" == "$notification_delivery_user" ||
		"$migration_user" == "$notification_delivery_migration_user" ||
		"$maintenance_user" == "$backup_user" ||
		"$maintenance_user" == "$notification_delivery_user" ||
		"$maintenance_user" == "$notification_delivery_migration_user" ||
		"$backup_user" == "$notification_delivery_user" ||
		"$backup_user" == "$notification_delivery_migration_user" ||
		"$notification_delivery_user" == "$notification_delivery_migration_user" ]]; then
		echo "API, core migration, Maintenance runtime, backup, notification delivery runtime and notification delivery migration must use six distinct PostgreSQL roles" >&2
		exit 1
	fi
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
			"webhook,bitrix24,amo-crm,mailing-email,mailing-telegram,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,auto-renewal"
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

compose_target \
	--profile migration \
	--profile notification-delivery-migration \
	config --quiet
compose_target build \
	api \
	api-gateway \
	maintenance-worker \
	notification-delivery-worker
verify_notification_delivery_image_artifact

validate_notification_database_urls() {
	local parser_image="$1"
	local runtime_url
	local migration_url

	runtime_url="$(get_env_value NOTIFICATION_DELIVERY_DATABASE_URL)"
	migration_url="$(
		get_env_value NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION
	)"

	if ! printf '%s\n%s\n' "$runtime_url" "$migration_url" |
		docker run --rm -i --network none \
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
if (lines.length !== 2 || lines.some(value => !value)) {
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
for (const key of ["protocol", "host", "port", "database", "ssl"]) {
	if (runtime[key] !== migration[key]) {
		fail(
			"Notification delivery runtime and migration URLs must target the same protocol, host, port, database and SSL settings",
		);
	}
}
if (runtime.username === migration.username) {
	fail("Notification delivery runtime and migration URLs must use distinct roles");
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
	if ! awk '
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
			if (replaced_constraints) {
				for (i = 1; i <= 4; i += 1) {
					name = constraint_names[i]
					if (replaced[name] != 1) failed = 1
				}
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
		"webhook,bitrix24,amo-crm,mailing-email,mailing-telegram,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome,auto-renewal"
)"
legacy_narrow_integration_kinds="$(
	normalize_csv \
		"webhook,bitrix24,amo-crm,mailing-email,mailing-telegram,daily-summary-telegram,telegram-destination-unavailable,notification-delivery-outcome"
)"
broad_integration_kinds="$(
	normalize_csv \
		"webhook,bitrix24,amo-crm,payment-telegram,mailing-email,mailing-telegram,limit-telegram,daily-summary-telegram"
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
		if [[ "$current_integration_kinds_normalized" != "$narrow_integration_kinds" &&
			"$current_integration_kinds_normalized" != "$legacy_narrow_integration_kinds" ]]; then
			echo "Cutover marker exists, but the live integration worker still owns an unexpected kind set." >&2
			echo "Do not attempt an automatic legacy rollback after the cutover marker." >&2
			exit 1
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
)

docker run --rm --network none \
	"${gateway_validation_env[@]}" \
	--entrypoint node \
	"winwidget-api-gateway:$APP_VERSION" \
	-e '
const { loadConfig } = require("./dist/src/config.js");
const config = loadConfig();
const monolith = config.routes.find(route => route.id === "monolith");
if (
	!monolith ||
	monolith.pathPrefix !== "/api/v1" ||
	monolith.upstreamUrl.origin !== "http://127.0.0.1:4200" ||
	monolith.authPolicy !== "optional" ||
	monolith.timeoutMs !== 60000
) {
	throw new Error(
		"Current production phase requires the explicit monolith /api/v1 catch-all route",
	);
}
process.stdout.write(
	`API Gateway route manifest validated: ${config.routes.length} route(s)\n`,
);
'

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
post_cutover_integration_read_pattern='^winwidget\.(lead-integration\.(webhook|bitrix24|amo-crm)|mailing\..*|report\.daily-summary\.telegram|notification\.(telegram-destination-unavailable|delivery-outcome))(\..*)?$'
legacy_integration_read_pattern='^winwidget\.(lead-integration\.(webhook|bitrix24|amo-crm)|payment-notification\.telegram(\.dead-letter|\.retry-v2\.[123])?|mailing\..*|limit-notification\.telegram(\.dead-letter|\.retry-v2\.[123])?|report\.daily-summary\.telegram)(\..*)?$'
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

	docker run --rm --network host \
		--env-file "$ENV_FILE" \
		-e "CLOSE_LEGACY_NOTIFICATION_CONSUMERS=$close_legacy_orphans" \
		-e "EXPECTED_NOTIFICATION_QUEUE_OWNER=$notification_owner" \
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
	const legacyTelegramOwner =
		process.env.EXPECTED_NOTIFICATION_QUEUE_OWNER === "legacy";
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
			kinds: [
				"webhook",
				"bitrix24",
				"amo-crm",
				"mailing-email",
				"mailing-telegram",
				"daily-summary-telegram",
				...(legacyTelegramOwner
					? []
					: [
							"telegram-destination-unavailable",
							"notification-delivery-outcome",
						]),
			],
			user: integrationUser,
			connectionName: "winwidget-integration-worker",
			notification: false,
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
			for (const queue of [baseQueue, `${baseQueue}.dead-letter`]) {
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
3. Wait until PROCESSING/RETRY_SCHEDULED receipts for payment/limit Telegram,
   campaigns and daily summary disappear, subscription reminders have no
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
		winwidget.limit-notification.telegram \
		winwidget.mailing.email \
		winwidget.mailing.telegram \
		winwidget.report.daily-summary.telegram; do
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
			$1 ~ /^winwidget\.limit-notification\.telegram(\.|$)/ ||
			$1 ~ /^winwidget\.mailing\.(email|telegram)(\.|$)/ ||
			$1 ~ /^winwidget\.report\.daily-summary\.telegram(\.|$)/
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
const providerBoundaryKinds = [
	...ownershipKinds,
	"mailing-email",
	"mailing-telegram",
	"daily-summary-telegram",
];

Promise.all([
	prisma.integrationDeliveryFailure.count({
		where: {
			integration: { in: ownershipKinds },
			resolvedAt: null,
		},
	}),
	prisma.integrationDeliveryReceipt.count({
		where: {
			integration: { in: providerBoundaryKinds },
			status: { in: ["PROCESSING", "RETRY_SCHEDULED"] },
		},
	}),
	prisma.outboxEvent.count({
		where: {
			routingKey: {
				in: [
					"payment.succeeded.v1",
					"lead.limit.reached.telegram.v2",
					"mailing.delivery.email.v1",
					"mailing.delivery.telegram.v1",
					"report.daily-summary.requested.v1",
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
	local name
	local ready
	local unacknowledged
	local consumers

	state="$(notification_cutover_queue_state)"
	for queue in \
		winwidget.payment-notification.telegram \
		winwidget.payment-notification.telegram.dead-letter \
		winwidget.limit-notification.telegram \
		winwidget.limit-notification.telegram.dead-letter \
		winwidget.mailing.email \
		winwidget.mailing.email.dead-letter \
		winwidget.mailing.telegram \
		winwidget.mailing.telegram.dead-letter \
		winwidget.report.daily-summary.telegram \
		winwidget.report.daily-summary.telegram.dead-letter; do
		queue_line="$(
			awk -v queue="$queue" '$1 == queue { print; exit }' <<<"$state"
		)"
		if [[ -z "$queue_line" ]]; then
			echo "Missing RabbitMQ queue required for Telegram cutover: $queue" >&2
			return 1
		fi
		read -r name ready unacknowledged consumers <<<"$queue_line"
		if [[ ! "$consumers" =~ ^[1-9][0-9]*$ ]]; then
			echo "Legacy integration-worker is not consuming queue: $queue" >&2
			return 1
		fi
	done
}

notification_cutover_is_clear() {
	local expected_queue
	local queue_line
	local name
	local ready
	local unacknowledged
	local consumers
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
		read -r name ready unacknowledged consumers <<<"$queue_line"
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
	local name
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
		read -r name ready unacknowledged consumers <<<"$queue_line"
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
	for service in outbox-publisher api api-gateway maintenance-worker; do
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

verify_notification_delivery_migration_boundary
if [[ "$notification_forward_candidate_active" == "true" ]]; then
	compose_target \
		--profile notification-delivery-migration \
		run --rm notification-delivery-migrate \
		migrate status \
		--schema prisma/schema.prisma
else
	compose_target \
		--profile notification-delivery-migration \
		run --rm notification-delivery-migrate
fi
verify_notification_delivery_runtime_crud

if [[ "$notification_delivery_first_cutover" == "true" ]]; then
	if ! compose_target --profile migration run --rm \
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
	compose_target --profile migration run --rm migrate
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
	compose_target stop \
		api-gateway \
		api \
		outbox-publisher \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker
	compose_target --profile migration run --rm migrate
	compose_target up -d rabbitmq
	messaging_readiness_started_at="$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')"
	compose_target up -d --force-recreate outbox-publisher
	wait_for_rabbitmq_topology
	compose_target up -d --force-recreate \
		integration-worker \
		maintenance-worker \
		notification-delivery-worker
	compose_target up -d --force-recreate api
	compose_target up -d --force-recreate api-gateway
fi

show_api_diagnostics() {
	echo "API deployment diagnostics:"
	compose_target \
		ps api-gateway api outbox-publisher integration-worker maintenance-worker notification-delivery-worker rabbitmq || true
	compose_target \
		logs --tail=100 api-gateway api outbox-publisher integration-worker maintenance-worker notification-delivery-worker rabbitmq || true
	echo "Processes listening on ports 4100, 4200, 4300 and 4401:"
	ss -ltnp \
		'( sport = :4100 or sport = :4200 or sport = :4300 or sport = :4401 )' ||
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
		notification-delivery-worker; do
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
	notification-delivery-worker; do
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
	if [[ "$service" == "notification-delivery-worker" ]]; then
		expected_image_revision="$NOTIFICATION_DELIVERY_REVISION"
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

echo "Backend revision verified locally and publicly: $APP_REVISION"

compose_target ps \
	api-gateway api outbox-publisher integration-worker maintenance-worker notification-delivery-worker rabbitmq
