#!/usr/bin/env bash

set -Eeuo pipefail

IDENTITY_SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
IDENTITY_HEALTHCHECK_ATTEMPTS="${IDENTITY_HEALTHCHECK_ATTEMPTS:-60}"
IDENTITY_HEALTHCHECK_INTERVAL="${IDENTITY_HEALTHCHECK_INTERVAL:-2}"

# shellcheck source=scripts/identity-release-identity.sh
declare -F identity_release_compose >/dev/null ||
	source "$IDENTITY_SCRIPT_ROOT/scripts/identity-release-identity.sh"
# shellcheck source=scripts/identity-database-lifecycle.sh
declare -F identity_database_current_phase >/dev/null ||
	source "$IDENTITY_SCRIPT_ROOT/scripts/identity-database-lifecycle.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
declare -F database_restore_guard_assert_before_mutation >/dev/null ||
	source "$IDENTITY_SCRIPT_ROOT/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/production-deploy-lock.sh
declare -F acquire_production_deploy_lock >/dev/null ||
	source "$IDENTITY_SCRIPT_ROOT/scripts/production-deploy-lock.sh"

identity_deploy_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

identity_deploy_require_boundary() {
	identity_database_require_root
	identity_database_require_inputs
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	local phase
	phase="$(identity_database_current_phase)" || return 1
	case "$phase" in
	prepared | forward-only | active | complete) ;;
	*) identity_deploy_fail "Identity deploy requires prepared or forward ownership; phase=$phase." || return 1 ;;
	esac
	[[ "$(identity_database_marker_value ownership_revision)" == "$EXPECTED_REVISION" ]] ||
		identity_deploy_fail 'Identity lifecycle marker belongs to another revision.'
}

identity_deploy_verify_image() {
	local image image_id revision user
	image="$(identity_release_image "$EXPECTED_REVISION")" || return 1
	image_id="$(docker image inspect --format '{{.Id}}' "$image")" || return 1
	revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" || return 1
	user="$(docker image inspect --format '{{.Config.User}}' "$image")" || return 1
	[[ "$image_id" == "$(identity_database_marker_value image_id)" &&
		"$revision" == "$EXPECTED_REVISION" && -n "$user" &&
		"$user" != 'root' && "$user" != '0' ]] ||
		identity_deploy_fail 'Identity image identity, revision, or runtime user is unsafe.' || return 1
	docker run --rm --network none --entrypoint node "$image" \
		-e 'require("node:fs").accessSync("assets/email-logo.png")' ||
		identity_deploy_fail 'Identity image is missing its service-owned email logo.' || return 1
	printf '%s\n' "$image_id"
}

identity_deploy_parse_rabbitmq_url() {
	[[ $# -eq 1 ]] || return 1
	local key="$1" raw expected_vhost
	raw="$(identity_read_env_value "$ENV_FILE" "$key")" || return 1
	expected_vhost="$(identity_read_env_value "$ENV_FILE" RABBITMQ_VHOST)" || return 1
	printf '%s' "$raw" | IDENTITY_EXPECTED_RABBITMQ_VHOST="$expected_vhost" node -e '
const { readFileSync } = require("node:fs");
const fail = () => process.exit(1);
let value;
try { value = new URL(readFileSync(0, "utf8")); } catch { fail(); }
let username;
let password;
let vhost;
try {
  username = decodeURIComponent(value.username);
  password = decodeURIComponent(value.password);
  vhost = decodeURIComponent(value.pathname.slice(1));
} catch { fail(); }
if (value.protocol !== "amqp:" || value.hostname !== "127.0.0.1" ||
    (value.port && value.port !== "5672") || value.search || value.hash ||
    !/^[A-Za-z0-9._-]+$/.test(username) || password.length < 32 ||
    password.startsWith("change_me") || /[\0\r\n]/.test(password) ||
    vhost !== process.env.IDENTITY_EXPECTED_RABBITMQ_VHOST) fail();
for (const item of [username, password, vhost]) {
  process.stdout.write(`${Buffer.from(item).toString("base64")}\n`);
}
'
}

identity_deploy_provision_rabbitmq_users() {
	local worker_credentials publisher_credentials worker_user publisher_user
	local worker_password publisher_password rabbitmq_vhost rabbitmq_container_id
	worker_credentials="$(identity_deploy_parse_rabbitmq_url RABBITMQ_IDENTITY_WORKER_URL)" ||
		identity_deploy_fail 'Identity worker RabbitMQ URL is invalid.' || return 1
	publisher_credentials="$(identity_deploy_parse_rabbitmq_url RABBITMQ_IDENTITY_PUBLISHER_URL)" ||
		identity_deploy_fail 'Identity publisher RabbitMQ URL is invalid.' || return 1
	worker_user="$(printf '%s' "$(sed -n '1p' <<<"$worker_credentials")" | base64 --decode)"
	publisher_user="$(printf '%s' "$(sed -n '1p' <<<"$publisher_credentials")" | base64 --decode)"
	worker_password="$(sed -n '2p' <<<"$worker_credentials")"
	publisher_password="$(sed -n '2p' <<<"$publisher_credentials")"
	rabbitmq_vhost="$(printf '%s' "$(sed -n '3p' <<<"$worker_credentials")" | base64 --decode)"
	[[ "$worker_user" == 'winwidget-identity-worker' &&
		"$publisher_user" == 'winwidget-identity-publisher' &&
		"$(sed -n '3p' <<<"$worker_credentials")" == "$(sed -n '3p' <<<"$publisher_credentials")" ]] ||
		identity_deploy_fail 'Identity RabbitMQ URLs must use the two dedicated canonical users.' || return 1
	rabbitmq_container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q rabbitmq)" || return 1
	[[ "$rabbitmq_container_id" =~ ^[0-9a-f]{64}$ ]] ||
		identity_deploy_fail 'Exactly one running RabbitMQ container is required for Identity provisioning.' || return 1
	IDENTITY_RABBITMQ_VHOST="$rabbitmq_vhost" \
	IDENTITY_WORKER_USER="$worker_user" \
	IDENTITY_WORKER_PASSWORD_BASE64="$worker_password" \
	IDENTITY_PUBLISHER_USER="$publisher_user" \
	IDENTITY_PUBLISHER_PASSWORD_BASE64="$publisher_password" \
		docker exec \
			-e IDENTITY_RABBITMQ_VHOST \
			-e IDENTITY_WORKER_USER \
			-e IDENTITY_WORKER_PASSWORD_BASE64 \
			-e IDENTITY_PUBLISHER_USER \
			-e IDENTITY_PUBLISHER_PASSWORD_BASE64 \
			"$rabbitmq_container_id" sh -euc '
upsert_user() {
  user="$1"
  password="$(printf "%s" "$2" | base64 -d)"
  if rabbitmqctl --silent list_users name | grep -Fqx -- "$user"; then
    rabbitmqctl change_password "$user" "$password" >/dev/null
  else
    rabbitmqctl add_user "$user" "$password" >/dev/null
  fi
  rabbitmqctl set_user_tags "$user" >/dev/null
}
upsert_user "$IDENTITY_WORKER_USER" "$IDENTITY_WORKER_PASSWORD_BASE64"
upsert_user "$IDENTITY_PUBLISHER_USER" "$IDENTITY_PUBLISHER_PASSWORD_BASE64"
rabbitmqctl set_permissions -p "$IDENTITY_RABBITMQ_VHOST" \
  "$IDENTITY_WORKER_USER" \
  "^(winwidget\.(events|retry|dead-letter|manual-retry)|winwidget\.notification\.telegram-destination-unavailable(\.dead-letter|\.retry-v2\.[123])?)$" \
  "^(winwidget\.(retry|dead-letter|manual-retry)|winwidget\.notification\.telegram-destination-unavailable(\.dead-letter|\.retry-v2\.[123])?)$" \
  "^(winwidget\.(events|retry|dead-letter|manual-retry)|winwidget\.notification\.telegram-destination-unavailable(\.dead-letter|\.retry-v2\.[123])?)$" >/dev/null
rabbitmqctl set_permissions -p "$IDENTITY_RABBITMQ_VHOST" \
  "$IDENTITY_PUBLISHER_USER" "^$" \
  "^winwidget\.(events|retry|dead-letter|manual-retry)$" "^$" >/dev/null
rabbitmqctl clear_topic_permissions -p "$IDENTITY_RABBITMQ_VHOST" \
  "$IDENTITY_WORKER_USER" >/dev/null
rabbitmqctl clear_topic_permissions -p "$IDENTITY_RABBITMQ_VHOST" \
  "$IDENTITY_PUBLISHER_USER" >/dev/null
rabbitmqctl set_topic_permissions -p "$IDENTITY_RABBITMQ_VHOST" \
  "$IDENTITY_WORKER_USER" winwidget.events "^$" \
  "^(notification\.telegram\.destination-unavailable\.v1|manual\.telegram-destination-unavailable|telegram-destination-unavailable\.dead-letter)$" >/dev/null
rabbitmqctl set_topic_permissions -p "$IDENTITY_RABBITMQ_VHOST" \
  "$IDENTITY_WORKER_USER" winwidget.dead-letter "^$" \
  "^telegram-destination-unavailable\.dead-letter$" >/dev/null
rabbitmqctl set_topic_permissions -p "$IDENTITY_RABBITMQ_VHOST" \
  "$IDENTITY_PUBLISHER_USER" winwidget.events \
  "^(identity\.user\.changed\.v1|billing\.(identity\.changed|referral\.requested|lifecycle-repair\.requested)\.v1|admin\.audit\.identity\.v1)$" "^$" >/dev/null
rabbitmqctl set_topic_permissions -p "$IDENTITY_RABBITMQ_VHOST" \
  "$IDENTITY_PUBLISHER_USER" winwidget.dead-letter \
  "^telegram-destination-unavailable\.dead-letter$" "^$" >/dev/null
'
	unset worker_credentials publisher_credentials worker_password publisher_password
}

identity_deploy_verify_environment() {
	[[ $# -eq 3 ]] || return 1
	local container_id="$1" role="$2" expected_port="$3" environment keys identity_port
	environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id")" || return 1
	keys="$(awk -F= '{ print $1 }' <<<"$environment" | LC_ALL=C sort -u)" || return 1
	identity_port="$(awk -F= '$1 == "IDENTITY_PORT" { print substr($0, length($1) + 2) }' \
		<<<"$environment")" || return 1
	grep -Fxq IDENTITY_DATABASE_URL <<<"$keys" || return 1
	grep -Fxq IDENTITY_PROCESS_ROLE <<<"$keys" || return 1
	[[ "$identity_port" == "$expected_port" ]] || return 1
	for forbidden in IDENTITY_MIGRATION_DATABASE_URL IDENTITY_BACKUP_URL \
		IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE DATABASE_RESTORE_IDENTITY_ADMIN_PASSWORD_FILE; do
		! grep -Fxq "$forbidden" <<<"$keys" || return 1
	done
	case "$role" in
	api)
		! grep -Fxq RABBITMQ_URL <<<"$keys" || return 1
		for required in IDENTITY_CORE_TOKEN CORE_IDENTITY_TOKEN \
			IDENTITY_CAMPAIGNS_TOKEN \
			IDENTITY_REPORTING_TOKEN IDENTITY_WIDGETS_TOKEN IDENTITY_BILLING_TOKEN \
			BILLING_IDENTITY_TOKEN WIDGETS_IDENTITY_TOKEN \
			JWT_ACCESS_PRIVATE_KEY_BASE64 JWT_ACCESS_JWKS_BASE64; do
			grep -Fxq "$required" <<<"$keys" || return 1
		done
		! grep -Fxq BILLING_INTERNAL_TOKEN <<<"$keys" || return 1
		! grep -Fxq WIDGETS_INTERNAL_TOKEN <<<"$keys" || return 1
		;;
	worker | outbox-publisher)
		grep -Fxq RABBITMQ_URL <<<"$keys" || return 1
		! grep -Fxq JWT_ACCESS_PRIVATE_KEY_BASE64 <<<"$keys" || return 1
		! grep -Fxq IDENTITY_CORE_TOKEN <<<"$keys" || return 1
		;;
	*) return 1 ;;
	esac
}

identity_deploy_verify_service() {
	[[ $# -eq 3 ]] || return 1
	local service="$1" role="$2" port="$3" attempt container_id health
	local image_id revision restart_count response
	for ((attempt = 1; attempt <= IDENTITY_HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" \
			"$COMPOSE_FILE" ps --status running -q "$service" 2>/dev/null || true)"
		if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
			health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")"
			image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
			revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
			restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
			response="$(curl -fsS --connect-timeout 2 --max-time 5 \
				"http://127.0.0.1:$port/health/ready" 2>/dev/null || true)"
			if [[ "$health" == 'healthy' &&
				"$image_id" == "$(identity_database_marker_value image_id)" &&
				"$revision" == "$EXPECTED_REVISION" && "$restart_count" == '0' &&
				-n "$response" ]] &&
				identity_deploy_verify_environment "$container_id" "$role" "$port"; then
				return 0
			fi
		fi
		sleep "$IDENTITY_HEALTHCHECK_INTERVAL"
	done
	identity_deploy_fail "Identity service failed verification: $service"
}

identity_deploy_assert_single_api() {
	local ids count
	ids="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q identity-api)" || return 1
	count="$(grep -Ec '^[0-9a-f]{64}$' <<<"$ids")"
	[[ "$count" == '1' ]] ||
		identity_deploy_fail "Identity requires exactly one API instance; found=$count."
}

identity_deploy_assert_async_runtime_stopped() {
	local service ids
	for service in identity-worker identity-outbox-publisher; do
		ids="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			ps --status running -q "$service" 2>/dev/null || true)"
		[[ -z "$ids" ]] ||
			identity_deploy_fail "Identity dark runtime requires $service to remain stopped." || return 1
	done
}

identity_deploy_prepare_common() {
	identity_deploy_require_boundary
	acquire_production_deploy_lock 'Identity deployment'
	identity_deploy_verify_image >/dev/null
	identity_deploy_provision_rabbitmq_users
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile identity-migration run --rm --no-deps identity-migrate
}

identity_deploy_dark_api() {
	identity_deploy_prepare_common
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop --timeout 90 identity-worker identity-outbox-publisher
	identity_deploy_assert_async_runtime_stopped
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate identity-api
	identity_deploy_verify_service identity-api api 4900
	identity_deploy_assert_single_api
	identity_deploy_assert_async_runtime_stopped
	printf 'identity_deploy_mode=dark-api-only\n'
	printf 'identity_deploy_revision=%s\n' "$EXPECTED_REVISION"
	printf 'identity_deploy_phase=%s\n' "$(identity_database_current_phase)"
}

identity_deploy_active_runtime() {
	local phase
	phase="$(identity_database_current_phase)" || return 1
	[[ "$phase" =~ ^(active|complete)$ ]] ||
		identity_deploy_fail "Identity async runtime requires active ownership; phase=$phase." || return 1
	identity_deploy_prepare_common
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate \
		identity-api identity-worker identity-outbox-publisher
	identity_deploy_verify_service identity-api api 4900
	identity_deploy_verify_service identity-worker worker 4901
	identity_deploy_verify_service identity-outbox-publisher outbox-publisher 4902
	identity_deploy_assert_single_api
	printf 'identity_deploy_mode=active-runtime\n'
	printf 'identity_deploy_revision=%s\n' "$EXPECTED_REVISION"
	printf 'identity_deploy_phase=%s\n' "$phase"
}

identity_deploy_run() {
	local phase
	phase="$(identity_database_current_phase)" || return 1
	case "$phase" in
	prepared | forward-only) identity_deploy_dark_api ;;
	active | complete) identity_deploy_active_runtime ;;
	*) identity_deploy_fail "Identity deploy phase is unsafe: $phase." ;;
	esac
}

identity_deploy_self_test() {
	local source
	source="$(declare -f identity_deploy_require_boundary identity_deploy_prepare_common \
		identity_deploy_dark_api identity_deploy_active_runtime identity_deploy_run \
		identity_deploy_verify_environment identity_deploy_assert_single_api \
		identity_deploy_assert_async_runtime_stopped identity_deploy_parse_rabbitmq_url \
		identity_deploy_provision_rabbitmq_users)"
	[[ "$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *'--profile identity-migration run --rm --no-deps identity-migrate'* &&
		"$source" == *'identity_deploy_mode=dark-api-only'* &&
		"$source" == *'Identity async runtime requires active ownership'* &&
		"$source" == *'stop --timeout 90 identity-worker identity-outbox-publisher'* &&
		"$source" == *'--no-build --force-recreate'* &&
		"$source" == *'winwidget-identity-worker'* &&
		"$source" == *'notification\.telegram\.destination-unavailable\.v1'* &&
		"$source" == *'exactly one API instance'* &&
		"$source" == *'IDENTITY_PORT'* &&
		"$source" == *'IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE'* ]] || return 1
	printf 'identity_deploy_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--deploy | --forward-recovery) identity_deploy_run ;;
	--self-test) identity_deploy_self_test ;;
	*) identity_deploy_fail 'Usage: deploy-identity-production.sh --deploy|--forward-recovery|--self-test' ;;
	esac
fi
