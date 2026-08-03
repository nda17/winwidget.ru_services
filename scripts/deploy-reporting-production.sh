#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
REPORTING_HEALTHCHECK_ATTEMPTS="${REPORTING_HEALTHCHECK_ATTEMPTS:-60}"
REPORTING_HEALTHCHECK_INTERVAL="${REPORTING_HEALTHCHECK_INTERVAL:-2}"

server_root="$APP_ROOT/winwidget.ru_server"
recreate_started=false
rollout_verified=false
previous_container_present=false
previous_image_ref=''
previous_image_id=''
previous_revision=''
previous_runtime_env_snapshot=''
previous_runtime_resource_snapshot=''
health_port=''

# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$server_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/reporting-database-lifecycle.sh
source "$server_root/scripts/reporting-database-lifecycle.sh"
# shellcheck source=scripts/reporting-cutover-lifecycle.sh
source "$server_root/scripts/reporting-cutover-lifecycle.sh"

reporting_verify_service() {
	local expected_image_id="$1"
	local expected_revision="$2"
	local expected_restart_count="${3:-0}"
	local expected_scheduler_enabled="$4"
	local attempt container_id health response image_id image_revision restart_count
	local process_role scheduler_enabled listen_host
	[[ "$expected_scheduler_enabled" == 'false' ||
		"$expected_scheduler_enabled" == 'true' ]] || return 1

	for ((attempt = 1; attempt <= REPORTING_HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(reporting_compose ps --status running -q reporting-service 2>/dev/null || true)"
		if [[ -n "$container_id" && "$container_id" != *$'\n'* ]]; then
			health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null || true)"
			if [[ "$health" == 'healthy' ]]; then
				response="$(curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:$health_port/health/ready" 2>/dev/null || true)"
				image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
				image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
				restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
				process_role="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_PROCESS_ROLE=//p')"
				scheduler_enabled="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_SCHEDULER_ENABLED=//p')"
				listen_host="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" | sed -n 's/^REPORTING_LISTEN_HOST=//p')"
				if [[ "$image_id" == "$expected_image_id" &&
					"$image_revision" == "$expected_revision" &&
					"$restart_count" == "$expected_restart_count" &&
					"$process_role" == 'all' &&
					"$scheduler_enabled" == "$expected_scheduler_enabled" &&
					"$listen_host" == '127.0.0.1' ]] &&
					printf '%s' "$response" | grep -Eq "\"revision\"[[:space:]]*:[[:space:]]*\"$expected_revision\""; then
					return 0
				fi
			fi
		fi
		sleep "$REPORTING_HEALTHCHECK_INTERVAL"
	done
	return 1
}

reporting_previous_runtime_env_value() {
	local key="$1"
	printf '%s\n' "$previous_runtime_env_snapshot" | awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	'
}

reporting_capture_previous_runtime_config() {
	local container_id="$1"
	local key memory_limit memory_reservation nano_cpus

	previous_runtime_env_snapshot="$(
		docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
			LC_ALL=C sort
	)"
	previous_runtime_resource_snapshot="$(
		docker inspect --format '{{.HostConfig.Memory}}|{{.HostConfig.MemoryReservation}}|{{.HostConfig.NanoCpus}}' "$container_id"
	)"
	for key in APP_REVISION MODE CORS_ALLOWED_ORIGINS REPORTING_DATABASE_URL \
		REPORTING_PROCESS_ROLE REPORTING_LISTEN_HOST REPORTING_PORT \
		REPORTING_CORE_INTERNAL_BASE_URL REPORTING_INTERNAL_TOKEN \
		REPORTING_INTERNAL_TIMEOUT_MS REPORTING_SCHEDULER_ENABLED REPORTING_PREFETCH \
		REPORTING_OUTBOX_BATCH_SIZE REPORTING_OUTBOX_POLL_INTERVAL_MS \
		REPORTING_OUTBOX_RETENTION_DAYS RABBITMQ_URL RABBITMQ_MAX_MESSAGE_BYTES; do
		reporting_previous_runtime_env_value "$key" >/dev/null || {
			echo "Previous Reporting container is missing runtime config key: $key" >&2
			return 1
		}
	done
	IFS='|' read -r memory_limit memory_reservation nano_cpus \
		<<<"$previous_runtime_resource_snapshot"
	[[ "$memory_limit" =~ ^[1-9][0-9]*$ &&
		"$memory_reservation" =~ ^[1-9][0-9]*$ &&
		"$nano_cpus" =~ ^[1-9][0-9]*$ ]] || {
		echo 'Previous Reporting resource configuration is not bounded.' >&2
		return 1
	}
}

reporting_apply_previous_runtime_config() {
	local memory_limit memory_reservation nano_cpus cpus

	REPORTING_REVISION="$(reporting_previous_runtime_env_value APP_REVISION)"
	MODE="$(reporting_previous_runtime_env_value MODE)"
	CORS_ALLOWED_ORIGINS="$(reporting_previous_runtime_env_value CORS_ALLOWED_ORIGINS)"
	REPORTING_DATABASE_URL="$(reporting_previous_runtime_env_value REPORTING_DATABASE_URL)"
	REPORTING_PROCESS_ROLE="$(reporting_previous_runtime_env_value REPORTING_PROCESS_ROLE)"
	REPORTING_LISTEN_HOST="$(reporting_previous_runtime_env_value REPORTING_LISTEN_HOST)"
	REPORTING_PORT="$(reporting_previous_runtime_env_value REPORTING_PORT)"
	REPORTING_CORE_INTERNAL_BASE_URL="$(reporting_previous_runtime_env_value REPORTING_CORE_INTERNAL_BASE_URL)"
	REPORTING_INTERNAL_TOKEN="$(reporting_previous_runtime_env_value REPORTING_INTERNAL_TOKEN)"
	REPORTING_INTERNAL_TIMEOUT_MS="$(reporting_previous_runtime_env_value REPORTING_INTERNAL_TIMEOUT_MS)"
	REPORTING_SCHEDULER_ENABLED="$(reporting_previous_runtime_env_value REPORTING_SCHEDULER_ENABLED)"
	REPORTING_PREFETCH="$(reporting_previous_runtime_env_value REPORTING_PREFETCH)"
	REPORTING_OUTBOX_BATCH_SIZE="$(reporting_previous_runtime_env_value REPORTING_OUTBOX_BATCH_SIZE)"
	REPORTING_OUTBOX_POLL_INTERVAL_MS="$(reporting_previous_runtime_env_value REPORTING_OUTBOX_POLL_INTERVAL_MS)"
	REPORTING_OUTBOX_RETENTION_DAYS="$(reporting_previous_runtime_env_value REPORTING_OUTBOX_RETENTION_DAYS)"
	RABBITMQ_REPORTING_URL="$(reporting_previous_runtime_env_value RABBITMQ_URL)"
	RABBITMQ_MAX_MESSAGE_BYTES="$(reporting_previous_runtime_env_value RABBITMQ_MAX_MESSAGE_BYTES)"
	IFS='|' read -r memory_limit memory_reservation nano_cpus \
		<<<"$previous_runtime_resource_snapshot"
	cpus="$(awk -v value="$nano_cpus" 'BEGIN { printf "%.9f", value / 1000000000 }' | sed 's/0*$//; s/[.]$//')"
	REPORTING_MEMORY_LIMIT="$memory_limit"
	REPORTING_MEMORY_RESERVATION="$memory_reservation"
	REPORTING_CPUS="$cpus"
	export REPORTING_REVISION MODE CORS_ALLOWED_ORIGINS REPORTING_DATABASE_URL
	export REPORTING_PROCESS_ROLE REPORTING_LISTEN_HOST REPORTING_PORT
	export REPORTING_CORE_INTERNAL_BASE_URL REPORTING_INTERNAL_TOKEN
	export REPORTING_INTERNAL_TIMEOUT_MS REPORTING_SCHEDULER_ENABLED REPORTING_PREFETCH
	export REPORTING_OUTBOX_BATCH_SIZE REPORTING_OUTBOX_POLL_INTERVAL_MS
	export REPORTING_OUTBOX_RETENTION_DAYS RABBITMQ_REPORTING_URL
	export RABBITMQ_MAX_MESSAGE_BYTES REPORTING_MEMORY_LIMIT
	export REPORTING_MEMORY_RESERVATION REPORTING_CPUS
}

reporting_verify_previous_runtime_config() {
	local container_id actual_env_snapshot actual_resource_snapshot
	container_id="$(reporting_compose ps --status running -q reporting-service 2>/dev/null || true)"
	[[ -n "$container_id" && "$container_id" != *$'\n'* ]] || return 1
	actual_env_snapshot="$(
		docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
			LC_ALL=C sort
	)"
	actual_resource_snapshot="$(
		docker inspect --format '{{.HostConfig.Memory}}|{{.HostConfig.MemoryReservation}}|{{.HostConfig.NanoCpus}}' "$container_id"
	)"
	[[ "$actual_env_snapshot" == "$previous_runtime_env_snapshot" &&
		"$actual_resource_snapshot" == "$previous_runtime_resource_snapshot" ]]
}

reporting_parse_rabbitmq_credentials() {
	local url="$1"
	local image_reference="$2" expected_revision="$3" image_id
	image_id="$(reporting_resolve_image_id_for_revision \
		"$expected_revision" "$image_reference")" || return 1
	printf '%s' "$url" | reporting_run_isolated_node_validator "$image_id" '
const { readFileSync } = require("node:fs");
const fail = message => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
let url;
try {
  url = new URL(readFileSync(0, "utf8"));
} catch {
  fail("RABBITMQ_REPORTING_URL is invalid");
}
let username;
let password;
let vhost;
try {
  username = decodeURIComponent(url.username);
  password = decodeURIComponent(url.password);
  vhost = decodeURIComponent(url.pathname.slice(1));
} catch {
  fail("RABBITMQ_REPORTING_URL contains invalid percent-encoding");
}
if (
  url.protocol !== "amqp:" ||
  url.hostname !== "127.0.0.1" ||
  (url.port && url.port !== "5672") ||
  url.search ||
  url.hash ||
  username !== "winwidget-reporting" ||
  vhost !== "winwidget" ||
  password.length < 32 ||
  password.startsWith("change_me") ||
  /[\u0000-\u001f\u007f]/.test(password)
) {
  fail("RABBITMQ_REPORTING_URL violates the dedicated local credential boundary");
}
process.stdout.write(`${Buffer.from(username).toString("base64")}\n`);
process.stdout.write(`${Buffer.from(password).toString("base64")}\n`);
'
}

reporting_provision_initial_rabbitmq_user() {
	local user="$1" password="$2"
	local reporting_container_any rabbitmq_container health shared_exchanges password_base64
	[[ "$user" == 'winwidget-reporting' && ${#password} -ge 32 ]] || return 1
	reporting_container_any="$(reporting_compose ps -a -q reporting-service 2>/dev/null || true)"
	[[ -z "$reporting_container_any" ]] || {
		echo 'Initial Reporting RabbitMQ credentials cannot be provisioned while any Reporting container exists.' >&2
		return 1
	}
	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || {
		echo 'Exactly one running RabbitMQ container is required before initial Reporting credential provisioning.' >&2
		return 1
	}
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$rabbitmq_container")"
	[[ "$health" == 'healthy' ]] || {
		echo 'RabbitMQ must be healthy before initial Reporting credential provisioning.' >&2
		return 1
	}
	shared_exchanges="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_exchanges \
			--vhost winwidget name type durable |
			awk '$1 == "winwidget.events" || $1 == "winwidget.dead-letter" { print $1 "|" $2 "|" $3 }' |
			LC_ALL=C sort
	)"
	[[ "$shared_exchanges" == $'winwidget.dead-letter|topic|true\nwinwidget.events|topic|true' ]] || {
		echo 'Shared Reporting RabbitMQ exchanges must exist before initial credential provisioning.' >&2
		return 1
	}
	password_base64="$(printf '%s' "$password" | base64 | tr -d '\n')"
	RABBITMQ_PROVISION_USER="$user" \
	RABBITMQ_PROVISION_PASSWORD_BASE64="$password_base64" \
		docker exec \
			-e RABBITMQ_PROVISION_USER \
			-e RABBITMQ_PROVISION_PASSWORD_BASE64 \
			"$rabbitmq_container" \
			sh -euc '
password="$(printf "%s" "$RABBITMQ_PROVISION_PASSWORD_BASE64" | base64 -d)"
if rabbitmqctl --silent list_users |
	cut -f1 |
	grep -Fqx -- "$RABBITMQ_PROVISION_USER"; then
	rabbitmqctl change_password "$RABBITMQ_PROVISION_USER" "$password"
else
	rabbitmqctl add_user "$RABBITMQ_PROVISION_USER" "$password"
fi
while IFS= read -r other_vhost; do
	if [ "$other_vhost" != "winwidget" ]; then
		rabbitmqctl clear_permissions -p "$other_vhost" "$RABBITMQ_PROVISION_USER"
		rabbitmqctl clear_topic_permissions -p "$other_vhost" "$RABBITMQ_PROVISION_USER"
	fi
done <<EOF
$(rabbitmqctl --silent list_vhosts name)
EOF
rabbitmqctl set_permissions \
	-p winwidget \
	"$RABBITMQ_PROVISION_USER" \
	"^winwidget\.reporting(\..*)?$" \
	"^(winwidget\.(events|dead-letter)|winwidget\.reporting(\..*)?)$" \
	"^(winwidget\.(events|dead-letter)|winwidget\.reporting(\..*)?)$"
rabbitmqctl set_user_tags "$RABBITMQ_PROVISION_USER"
rabbitmqctl clear_topic_permissions -p winwidget "$RABBITMQ_PROVISION_USER"
rabbitmqctl set_topic_permissions \
	-p winwidget \
	"$RABBITMQ_PROVISION_USER" \
	winwidget.events \
	"^(notification\.daily-summary\.telegram\.requested\.v1|admin\.audit\.reporting\.v1)$" \
	"^(identity\.user\.changed\.v1|billing\.(payment|subscription)\.changed\.v1|widgets\.(widget|lead)\.changed\.v1|reporting\.(settings|core-operational-routing)\.changed\.v1|notification\.delivery\.outcome\.v1)$"
rabbitmqctl set_topic_permissions \
	-p winwidget \
	"$RABBITMQ_PROVISION_USER" \
	winwidget.dead-letter \
	"^reporting\.(identityUser|billingPayment|billingSubscription|widget|lead|reportingSettings|deliveryOutcome)\.dead-letter$" \
	"^reporting\.(identityUser|billingPayment|billingSubscription|widget|lead|reportingSettings|deliveryOutcome)\.dead-letter$"
rabbitmqctl authenticate_user "$RABBITMQ_PROVISION_USER" "$password"
unset password
'
	unset password_base64
}

reporting_extract_unique_rabbitmq_user_row() {
	local expected_user="$1"
	awk -v expected_user="$expected_user" '
		$1 == expected_user {
			matched += 1
			if (matched == 1) {
				tags = $0
				sub(/^[^[:space:]]+[[:space:]]+/, "", tags)
				print $1 "|" tags
			}
		}
		END { exit(matched == 1 ? 0 : 1) }
	'
}

reporting_rabbitmq_user_row_is_unprivileged() {
	local row="$1" expected_user="$2"
	[[ "$row" == "$expected_user|[]" ]]
}

reporting_require_rabbitmq_preflight() {
	local user="$1"
	local password="$2"
	local rabbitmq_container health user_row regular_permissions topic_permissions
	local expected_topic_permissions shared_exchanges

	rabbitmq_container="$(reporting_compose ps --status running -q rabbitmq 2>/dev/null || true)"
	[[ -n "$rabbitmq_container" && "$rabbitmq_container" != *$'\n'* ]] || {
		echo 'Exactly one running RabbitMQ container is required before Reporting migration.' >&2
		return 1
	}
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$rabbitmq_container")"
	[[ "$health" == 'healthy' ]] || {
		echo 'RabbitMQ must be healthy before Reporting migration.' >&2
		return 1
	}
	if ! user_row="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_users |
			reporting_extract_unique_rabbitmq_user_row "$user"
	)"; then
		echo 'Dedicated Reporting RabbitMQ user must exist exactly once.' >&2
		return 1
	fi
	reporting_rabbitmq_user_row_is_unprivileged "$user_row" "$user" || {
		echo 'Dedicated Reporting RabbitMQ user must have an empty tag set.' >&2
		return 1
	}
	docker exec "$rabbitmq_container" rabbitmqctl authenticate_user "$user" "$password" >/dev/null || {
		echo 'Dedicated Reporting RabbitMQ credentials are not authenticated.' >&2
		return 1
	}
	regular_permissions="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_user_permissions "$user" |
			awk 'NF == 4 { print $1 "|" $2 "|" $3 "|" $4 }'
	)"
	[[ "$regular_permissions" == 'winwidget|^winwidget\.reporting(\..*)?$|^(winwidget\.(events|dead-letter)|winwidget\.reporting(\..*)?)$|^(winwidget\.(events|dead-letter)|winwidget\.reporting(\..*)?)$' ]] || {
		echo 'Dedicated Reporting RabbitMQ regular permissions differ from the reviewed boundary.' >&2
		return 1
	}
	topic_permissions="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_user_topic_permissions "$user" |
			awk 'NF == 4 { print $1 "|" $2 "|" $3 "|" $4 }' |
			LC_ALL=C sort
	)"
	expected_topic_permissions="$(
		printf '%s\n' \
			'winwidget|winwidget.dead-letter|^reporting\.(identityUser|billingPayment|billingSubscription|widget|lead|reportingSettings|deliveryOutcome)\.dead-letter$|^reporting\.(identityUser|billingPayment|billingSubscription|widget|lead|reportingSettings|deliveryOutcome)\.dead-letter$' \
			'winwidget|winwidget.events|^(notification\.daily-summary\.telegram\.requested\.v1|admin\.audit\.reporting\.v1)$|^(identity\.user\.changed\.v1|billing\.(payment|subscription)\.changed\.v1|widgets\.(widget|lead)\.changed\.v1|reporting\.(settings|core-operational-routing)\.changed\.v1|notification\.delivery\.outcome\.v1)$' |
			LC_ALL=C sort
	)"
	[[ "$topic_permissions" == "$expected_topic_permissions" ]] || {
		echo 'Dedicated Reporting RabbitMQ topic permissions differ from the reviewed boundary.' >&2
		return 1
	}
	shared_exchanges="$(
		docker exec "$rabbitmq_container" rabbitmqctl --silent list_exchanges \
			--vhost winwidget name type durable |
			awk '$1 == "winwidget.events" || $1 == "winwidget.dead-letter" { print $1 "|" $2 "|" $3 }' |
			LC_ALL=C sort
	)"
	[[ "$shared_exchanges" == $'winwidget.dead-letter|topic|true\nwinwidget.events|topic|true' ]] || {
		echo 'Shared Reporting RabbitMQ exchanges are missing or incompatible.' >&2
		return 1
	}
}

reporting_create_pre_migration_backup() {
	local revision="$1"
	local backup_directory backup_name PGURL BACKUP_NAME command_status
	backup_directory="$APP_ROOT/deploy/backend/reporting-migration-backups"
	[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
	reporting_validate_root_owned_directory "$(dirname "$backup_directory")" || {
		echo 'Reporting deploy directory is unsafe for migration backups.' >&2
		return 1
	}
	if [[ -e "$backup_directory" || -L "$backup_directory" ]]; then
		[[ -d "$backup_directory" && ! -L "$backup_directory" ]] || {
			echo 'Reporting migration backup directory is unsafe.' >&2
			return 1
		}
	else
		mkdir -m 700 "$backup_directory"
	fi
	chown 0:0 "$backup_directory"
	chmod 700 "$backup_directory"
	backup_name="reporting-pre-migration-${revision}-$(date -u +'%Y%m%dT%H%M%SZ')"
	PGURL="$(reporting_libpq_url REPORTING_BACKUP_URL)"
	BACKUP_NAME="$backup_name"
	export PGURL BACKUP_NAME
	if docker run --rm --network host --user 0:0 \
		-v "$backup_directory:/backup:rw" \
		-e PGURL -e BACKUP_NAME \
		"$REPORTING_CANONICAL_POSTGRES_IMAGE" sh -euc '
pg_dump --format=custom --no-owner --no-acl --schema=reporting \
  "$PGURL" --file="/backup/$BACKUP_NAME.dump"
pg_restore --list "/backup/$BACKUP_NAME.dump" \
  >"/backup/$BACKUP_NAME.restore-list"
test -s "/backup/$BACKUP_NAME.dump"
test -s "/backup/$BACKUP_NAME.restore-list"
chmod 600 "/backup/$BACKUP_NAME.dump" "/backup/$BACKUP_NAME.restore-list"
'; then
		command_status=0
	else
		command_status=$?
	fi
	unset PGURL BACKUP_NAME
	[[ "$command_status" == '0' ]] || return "$command_status"
	reporting_sha256_file "$backup_directory/$backup_name.dump" >"$backup_directory/$backup_name.dump.sha256"
	chown 0:0 "$backup_directory/$backup_name.dump" \
		"$backup_directory/$backup_name.restore-list" \
		"$backup_directory/$backup_name.dump.sha256"
	chmod 600 "$backup_directory/$backup_name.dump" \
		"$backup_directory/$backup_name.restore-list" \
		"$backup_directory/$backup_name.dump.sha256"
	echo "Reporting pre-migration backup verified: $backup_directory/$backup_name.dump"
}

reporting_rollback_service() {
	local reason="$1"
	local rollback_failed=false
	[[ "$recreate_started" == 'true' && "$rollout_verified" != 'true' ]] || return
	echo "Reporting rollout failed ($reason); rolling back only reporting-service." >&2
	if [[ "$previous_container_present" == 'true' ]]; then
		[[ "$previous_image_id" =~ ^sha256:[0-9a-f]{64}$ && "$previous_revision" =~ ^[0-9a-f]{40}$ ]] || {
			echo 'No verified previous Reporting image is available.' >&2
			return 1
		}
		if ! reporting_apply_previous_runtime_config; then
			echo 'Reporting automatic rollback could not load the captured runtime configuration.' >&2
			rollback_failed=true
		else
			export REPORTING_IMAGE="$previous_image_id"
			export REPORTING_REVISION="$previous_revision"
			health_port="$(reporting_previous_runtime_env_value REPORTING_PORT)"
			if ! reporting_compose up -d --no-deps --no-build --force-recreate reporting-service; then
				echo 'Reporting automatic image rollback could not recreate the previous container.' >&2
				rollback_failed=true
			elif ! reporting_verify_service "$previous_image_id" "$previous_revision" 0 \
				"$(reporting_previous_runtime_env_value REPORTING_SCHEDULER_ENABLED)"; then
				echo 'Reporting automatic image rollback did not become healthy.' >&2
				rollback_failed=true
			elif ! reporting_verify_previous_runtime_config; then
				echo 'Reporting automatic rollback did not restore the captured runtime configuration.' >&2
				rollback_failed=true
			fi
		fi
	else
		reporting_compose stop reporting-service >/dev/null 2>&1 || true
		reporting_compose rm -f reporting-service >/dev/null 2>&1 || true
		if [[ -n "$(reporting_compose ps -a -q reporting-service 2>/dev/null || true)" ]]; then
			echo 'Initial failed Reporting service container could not be removed.' >&2
			rollback_failed=true
		else
			echo 'Initial failed Reporting service container was removed; its database was preserved.' >&2
		fi
	fi
	if ! reporting_verify_database_lifecycle_unchanged; then
		echo 'Reporting PostgreSQL lifecycle changed during failed rollout.' >&2
		rollback_failed=true
	fi
	[[ "$rollback_failed" == 'false' ]]
}

reporting_deploy_on_exit() {
	local exit_code=$?
	local rollback_status=0
	trap - EXIT
	trap '' HUP INT TERM
	if [[ "$recreate_started" == 'true' && "$rollout_verified" != 'true' ]]; then
		set +e
		reporting_rollback_service "process exit $exit_code"
		rollback_status=$?
		if [[ "$rollback_status" != '0' ]]; then
			echo 'CRITICAL: Reporting automatic rollback did not restore the captured service state.' >&2
		fi
	fi
	exit "$exit_code"
}

reporting_deploy_self_test() {
	local source_text main_text before_env_validation topology_index migration_index
	local ambient_index numeric_index build_index provision_index trap_index recreate_index
	local temporary_root rollback_marker exit_status rabbitmq_user_row
	local signal expected_signal_status
	source_text="$(declare -f reporting_deploy_main reporting_rollback_service reporting_create_pre_migration_backup reporting_deploy_on_exit reporting_capture_previous_runtime_config reporting_apply_previous_runtime_config reporting_verify_previous_runtime_config reporting_provision_initial_rabbitmq_user reporting_extract_unique_rabbitmq_user_row reporting_rabbitmq_user_row_is_unprivileged reporting_require_rabbitmq_preflight reporting_validate_runtime_numeric_env reporting_parse_rabbitmq_credentials)"
	main_text="$(declare -f reporting_deploy_main)"
	[[ "$source_text" != *'DATABASE_URL_PRODUCTION migrate'* &&
		"$source_text" != *'--profile reporting-database up'* &&
		"$source_text" != *'docker volume rm'* &&
		"$source_text" != *'docker compose down'* ]] || {
		echo 'Reporting deploy self-test found a forbidden database lifecycle operation.' >&2
		return 1
	}
	[[ "$source_text" == *'REPORTING_MIGRATION_DATABASE_URL'* &&
		"$source_text" == *'REPORTING_SCHEDULER_ENABLED'* &&
		"$source_text" == *'{{.HostConfig.Memory}}|{{.HostConfig.MemoryReservation}}|{{.HostConfig.NanoCpus}}'* &&
		"$source_text" != *'printf "%d|%d|%d" .HostConfig.Memory'* &&
		"$source_text" == *'AUTOMATIC_PROD_PUSH'* &&
		"$source_text" == *'reporting_first_rollout_deploy_action'* &&
		"$source_text" == *'reporting_validate_preflight_secret_isolation'* &&
		"$source_text" == *'reporting_verify_database_lifecycle_unchanged'* &&
		"$source_text" == *'REPORTING_OUTBOX_POLL_INTERVAL_MS must be between 100 and 60000.'* &&
		"$source_text" == *'reporting_assert_no_ambient_compose_overrides REPORTING_IMAGE REPORTING_REVISION'* &&
		"$source_text" == *'trap reporting_deploy_on_exit EXIT'* &&
		"$source_text" == *"trap 'exit 129' HUP"* &&
		"$source_text" == *"trap 'exit 130' INT"* &&
		"$source_text" == *"trap 'exit 143' TERM"* &&
		"$source_text" == *'rabbitmqctl authenticate_user'* &&
		"$source_text" == *'rabbitmqctl change_password'* &&
		"$source_text" == *'rabbitmqctl clear_topic_permissions'* &&
		"$source_text" == *'docker exec "$rabbitmq_container" rabbitmqctl --silent list_users'* &&
		"$source_text" == *'Dedicated Reporting RabbitMQ user must exist exactly once.'* &&
		"$source_text" == *'Dedicated Reporting RabbitMQ user must have an empty tag set.'* &&
		"$source_text" == *'Shared Reporting RabbitMQ exchanges must exist before initial credential provisioning.'* &&
		"$source_text" == *'list_user_permissions'* &&
		"$source_text" == *'list_user_topic_permissions'* &&
		"$source_text" == *'list_exchanges'* &&
		"$source_text" == *'"$rabbit_url" "$new_image_id" "$deploy_revision"'* &&
		"$source_text" == *'REPORTING_IMAGE="$new_image_id"'* &&
		"$source_text" == *'--no-deps reporting-migrate'* &&
		"$source_text" != *'run --rm --no-deps --no-build reporting-migrate'* &&
		"$source_text" == *'"$new_image_id" sh -euc'* &&
		"$source_text" == *'--security-opt no-new-privileges'* &&
		"$source_text" != *'--entrypoint node "$REPORTING_IMAGE"'* ]] || {
		echo 'Reporting deploy self-test found a missing phase-A guard.' >&2
		return 1
	}
	rabbitmq_user_row="$(
		printf '%s\n' $'winwidget-reporting\t[]' |
			reporting_extract_unique_rabbitmq_user_row winwidget-reporting
	)" || return 1
	reporting_rabbitmq_user_row_is_unprivileged \
		"$rabbitmq_user_row" winwidget-reporting || return 1
	if printf '%s\n' \
		$'winwidget-reporting\t[]' \
		$'winwidget-reporting\t[]' |
		reporting_extract_unique_rabbitmq_user_row winwidget-reporting >/dev/null 2>&1; then
		echo 'Reporting deploy self-test accepted duplicate RabbitMQ user rows.' >&2
		return 1
	fi
	for rabbitmq_user_row in \
		'winwidget-reporting|[administrator]' \
		'winwidget-reporting|[management]' \
		'winwidget-reporting|[administrator, management]'; do
		if reporting_rabbitmq_user_row_is_unprivileged \
			"$rabbitmq_user_row" winwidget-reporting; then
			echo "Reporting deploy self-test accepted privileged RabbitMQ row: $rabbitmq_user_row" >&2
			return 1
		fi
	done
	ambient_index="$(printf '%s\n' "$main_text" | grep -n 'reporting_assert_no_ambient_compose_overrides' | cut -d: -f1)"
	numeric_index="$(printf '%s\n' "$main_text" | grep -n 'reporting_validate_runtime_numeric_env' | cut -d: -f1)"
	build_index="$(printf '%s\n' "$main_text" | grep -n 'reporting_compose build reporting-service' | cut -d: -f1)"
	provision_index="$(printf '%s\n' "$main_text" | grep -n 'reporting_provision_initial_rabbitmq_user' | cut -d: -f1)"
	topology_index="$(printf '%s\n' "$main_text" | grep -n 'reporting_require_rabbitmq_preflight' | cut -d: -f1)"
	migration_index="$(printf '%s\n' "$main_text" | grep -n 'reporting-migrate' | head -n 1 | cut -d: -f1)"
	trap_index="$(printf '%s\n' "$main_text" | grep -n 'trap reporting_deploy_on_exit EXIT' | cut -d: -f1)"
	recreate_index="$(printf '%s\n' "$main_text" | grep -n 'reporting_compose up -d --no-deps --no-build --force-recreate reporting-service' | cut -d: -f1)"
	[[ "$ambient_index" =~ ^[0-9]+$ && "$numeric_index" =~ ^[0-9]+$ &&
		"$build_index" =~ ^[0-9]+$ &&
		"$ambient_index" -lt "$build_index" &&
		"$numeric_index" -lt "$build_index" &&
		"$provision_index" =~ ^[0-9]+$ && "$build_index" -lt "$provision_index" &&
		"$topology_index" =~ ^[0-9]+$ && "$provision_index" -lt "$topology_index" &&
		"$migration_index" =~ ^[0-9]+$ &&
		"$topology_index" -lt "$migration_index" &&
		"$trap_index" =~ ^[0-9]+$ && "$recreate_index" =~ ^[0-9]+$ &&
		"$trap_index" -lt "$recreate_index" ]] || {
		echo 'Reporting deploy self-test found an unsafe ambient/build/topology/migration/trap/recreate order.' >&2
		return 1
	}
	(
		previous_runtime_env_snapshot="$(printf '%s\n' \
			'APP_REVISION=0123456789abcdef0123456789abcdef01234567' \
			'MODE=production' \
			'CORS_ALLOWED_ORIGINS=https://winwidget.test' \
			'REPORTING_DATABASE_URL=postgresql://runtime:secret@127.0.0.1:55435/winwidget_reporting?schema=reporting&sslmode=disable' \
			'REPORTING_PROCESS_ROLE=all' \
			'REPORTING_LISTEN_HOST=127.0.0.1' \
			'REPORTING_PORT=4600' \
			'REPORTING_CORE_INTERNAL_BASE_URL=http://127.0.0.1:4200' \
			'REPORTING_INTERNAL_TOKEN=self_test_internal_token_at_least_32_chars' \
			'REPORTING_INTERNAL_TIMEOUT_MS=10000' \
			'REPORTING_SCHEDULER_ENABLED=false' \
			'REPORTING_PREFETCH=10' \
			'REPORTING_OUTBOX_BATCH_SIZE=50' \
			'REPORTING_OUTBOX_POLL_INTERVAL_MS=1000' \
			'REPORTING_OUTBOX_RETENTION_DAYS=7' \
			'RABBITMQ_URL=amqp://winwidget-reporting:self_test_password_at_least_32_chars@127.0.0.1:5672/winwidget' \
			'RABBITMQ_MAX_MESSAGE_BYTES=262144' | LC_ALL=C sort)"
		previous_runtime_resource_snapshot='536870912|134217728|750000000'
		reporting_apply_previous_runtime_config
		[[ "$REPORTING_REVISION" == '0123456789abcdef0123456789abcdef01234567' &&
			"$REPORTING_SCHEDULER_ENABLED" == 'false' &&
			"$REPORTING_MEMORY_LIMIT" == '536870912' &&
			"$REPORTING_MEMORY_RESERVATION" == '134217728' &&
			"$REPORTING_CPUS" == '0.75' ]]
	) || {
		echo 'Reporting deploy self-test could not restore the captured runtime overrides.' >&2
		return 1
	}
	(
		test_prefetch=10
		test_batch=50
		test_poll_interval=1000
		test_retention=7
		reporting_get_env_value() {
			case "$1" in
			REPORTING_PREFETCH) printf '%s\n' "$test_prefetch" ;;
			REPORTING_OUTBOX_BATCH_SIZE) printf '%s\n' "$test_batch" ;;
			REPORTING_OUTBOX_POLL_INTERVAL_MS) printf '%s\n' "$test_poll_interval" ;;
			REPORTING_OUTBOX_RETENTION_DAYS) printf '%s\n' "$test_retention" ;;
			*) return 1 ;;
			esac
		}
		reporting_validate_runtime_numeric_env || return 1
		for scenario in prefetch-low prefetch-high batch-low batch-high \
			poll-low poll-high retention-low retention-high; do
			test_prefetch=10
			test_batch=50
			test_poll_interval=1000
			test_retention=7
			case "$scenario" in
			prefetch-low) test_prefetch=0 ;;
			prefetch-high) test_prefetch=101 ;;
			batch-low) test_batch=0 ;;
			batch-high) test_batch=501 ;;
			poll-low) test_poll_interval=99 ;;
			poll-high) test_poll_interval=60001 ;;
			retention-low) test_retention=0 ;;
			retention-high) test_retention=366 ;;
			esac
			if reporting_validate_runtime_numeric_env >/dev/null 2>&1; then
				echo "Reporting numeric env self-test accepted $scenario." >&2
				return 1
			fi
		done
	) || {
		echo 'Reporting deploy self-test found invalid numeric env boundaries.' >&2
		return 1
	}
	temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/winwidget-reporting-deploy.XXXXXX")"
	rollback_marker="$temporary_root/rollback"
	if (
		reporting_rollback_service() {
			printf 'called\n' >"$rollback_marker"
		}
		recreate_started=true
		rollout_verified=false
		trap reporting_deploy_on_exit EXIT
		exit 73
	); then
		exit_status=0
	else
		exit_status=$?
	fi
	if [[ "$exit_status" != '73' || "$(sed -n '1p' "$rollback_marker" 2>/dev/null || true)" != 'called' ]]; then
		rm -rf -- "$temporary_root"
		echo 'Reporting deploy self-test did not run EXIT rollback with the original status.' >&2
		return 1
	fi
	for signal in HUP INT TERM; do
		case "$signal" in
		HUP) expected_signal_status=129 ;;
		INT) expected_signal_status=130 ;;
		TERM) expected_signal_status=143 ;;
		esac
		rollback_marker="$temporary_root/rollback-$signal"
		if (
			reporting_rollback_service() {
				printf 'called\n' >"$rollback_marker"
			}
			recreate_started=true
			rollout_verified=false
			trap reporting_deploy_on_exit EXIT
			trap 'exit 129' HUP
			trap 'exit 130' INT
			trap 'exit 143' TERM
			sh -c 'kill -s "$1" "$PPID"' reporting-signal-self-test "$signal"
			exit 99
		); then
			exit_status=0
		else
			exit_status=$?
		fi
		if [[ "$exit_status" != "$expected_signal_status" ||
			"$(sed -n '1p' "$rollback_marker" 2>/dev/null || true)" != 'called' ]]; then
			rm -rf -- "$temporary_root"
			echo "Reporting deploy self-test did not preserve $signal rollback status." >&2
			return 1
		fi
	done
	rm -rf -- "$temporary_root"
	before_env_validation="${source_text%%reporting_validate_production_files*}"
	[[ "$before_env_validation" == *'reporting_first_rollout_deploy_action'* &&
		"$before_env_validation" == *'reporting_write_first_rollout_staged_marker'* ]] || {
		echo 'Reporting deploy self-test found env validation before the first-rollout stage-and-exit gate.' >&2
		return 1
	}
	echo 'Reporting deploy stage-and-exit and phase-A safety helpers verified.'
}

reporting_deploy_main() {
	local deploy_revision expected_revision checkout_branch checkout_dirty
	local automatic_prod_push first_rollout_action
	local reporting_internal_token internal_timeout core_base_url rabbit_url rabbit_credentials
	local rabbit_user rabbit_password
	local scheduler_enabled scheduler_policy previous_scheduler_enabled
	local current_container_id current_container_any initial_container_id initial_container_any
	local changed_paths changed_migrations migration
	local new_image_id new_image_revision changed_path key
	local reporting_schema_relation_count reporting_migration_table_present

	if [[ "${1:-}" == '--self-test' ]]; then
		[[ $# == 1 ]] || return 1
		reporting_deploy_self_test
		return
	fi
	[[ $# == 0 ]] || {
		echo "Usage: EXPECTED_REVISION=<sha> $0 | $0 --self-test" >&2
		return 1
	}
	[[ "$(id -u)" == '0' ]] || {
		echo 'Reporting production deploy must run as root.' >&2
		return 1
	}
	acquire_production_deploy_lock 'Reporting deployment'

	deploy_revision="$(git -C "$server_root" rev-parse HEAD)"
	expected_revision="${EXPECTED_REVISION:-$deploy_revision}"
	checkout_branch="$(git -C "$server_root" branch --show-current)"
	checkout_dirty="$(git -C "$server_root" status --porcelain --untracked-files=all)"
	[[ "$deploy_revision" == "$expected_revision" &&
		"$deploy_revision" =~ ^[0-9a-f]{40}$ &&
		"$checkout_branch" == 'prod' && -z "$checkout_dirty" ]] || {
		echo 'Reporting deploy requires a clean protected prod checkout at EXPECTED_REVISION.' >&2
		return 1
	}
	automatic_prod_push="${AUTOMATIC_PROD_PUSH:-false}"
	[[ "$automatic_prod_push" == 'true' || "$automatic_prod_push" == 'false' ]] || {
		echo 'AUTOMATIC_PROD_PUSH must be true or false.' >&2
		return 1
	}
	first_rollout_action="$(reporting_first_rollout_deploy_action "$automatic_prod_push" "$deploy_revision")" || {
		echo 'Reporting first-rollout marker state is invalid.' >&2
		return 1
	}
	case "$first_rollout_action" in
	stage)
		# database-restore-production-guard: before-mutation
		database_restore_guard_assert_before_mutation \
			identity-if-present "$ENV_FILE"
		reporting_write_first_rollout_staged_marker "$deploy_revision"
		echo "Reporting first rollout staged at revision $deploy_revision. Restore safety state was verified; automatic deployment exits before Compose, build or database access."
		return
		;;
	prepare)
		echo "Reporting first rollout is staged at $deploy_revision but its database is absent. Run the manual reporting-database prepare target; deploy made no runtime change." >&2
		return 1
		;;
	block)
		echo 'Reporting database preparation is incomplete; resume the pinned manual prepare before deployment.' >&2
		return 1
		;;
	deploy)
		# database-restore-production-guard: before-mutation
		database_restore_guard_assert_before_mutation \
			healthy-required "$ENV_FILE"
		;;
	*)
		echo 'Reporting first-rollout action classifier returned an invalid result.' >&2
		return 1
		;;
	esac
	reporting_validate_production_files
	reporting_assert_no_ambient_compose_overrides REPORTING_IMAGE REPORTING_REVISION

	for key in REPORTING_DATABASE_URL REPORTING_MIGRATION_DATABASE_URL \
		REPORTING_BACKUP_URL REPORTING_POSTGRES_IMAGE REPORTING_POSTGRES_PORT \
		REPORTING_POSTGRES_DATA_VOLUME REPORTING_POSTGRES_ADMIN_USER \
		REPORTING_POSTGRES_ADMIN_PASSWORD_FILE REPORTING_INTERNAL_TOKEN \
		REPORTING_PROCESS_ROLE REPORTING_LISTEN_HOST REPORTING_PORT \
		REPORTING_CORE_INTERNAL_BASE_URL REPORTING_INTERNAL_TIMEOUT_MS \
		REPORTING_SCHEDULER_ENABLED REPORTING_PREFETCH REPORTING_OUTBOX_BATCH_SIZE \
		REPORTING_OUTBOX_POLL_INTERVAL_MS REPORTING_OUTBOX_RETENTION_DAYS \
		CORS_ALLOWED_ORIGINS RABBITMQ_REPORTING_URL; do
		reporting_require_env_key "$key"
	done
	reporting_validate_preflight_secret_isolation
	[[ "$(reporting_get_env_value REPORTING_PROCESS_ROLE)" == 'all' ]] || {
		echo 'Current single-VPS Reporting deployment requires REPORTING_PROCESS_ROLE=all.' >&2
		return 1
	}
	[[ "$(reporting_get_env_value REPORTING_LISTEN_HOST)" == '127.0.0.1' ]] || {
		echo 'REPORTING_LISTEN_HOST must remain loopback-only.' >&2
		return 1
	}
	health_port="$(reporting_get_env_value REPORTING_PORT)"
	[[ "$health_port" == '4600' ]] || {
		echo 'REPORTING_PORT must use the reviewed loopback port 4600.' >&2
		return 1
	}
	scheduler_enabled="$(reporting_get_env_value REPORTING_SCHEDULER_ENABLED)"
	scheduler_policy="$(reporting_cutover_runtime_scheduler_policy)" || return 1
	reporting_cutover_scheduler_value_allowed "$scheduler_policy" "$scheduler_enabled" || {
		echo "REPORTING_SCHEDULER_ENABLED=$scheduler_enabled is unsafe for cutover policy $scheduler_policy." >&2
		return 1
	}
	reporting_internal_token="$(reporting_get_env_value REPORTING_INTERNAL_TOKEN)"
	[[ ${#reporting_internal_token} -ge 32 &&
		"$reporting_internal_token" != 'ci_reporting_internal_token_at_least_32_chars' ]] || {
		echo 'REPORTING_INTERNAL_TOKEN must be a production-only secret of at least 32 characters.' >&2
		return 1
	}
	unset reporting_internal_token
	internal_timeout="$(reporting_get_env_value REPORTING_INTERNAL_TIMEOUT_MS)"
	[[ "$internal_timeout" =~ ^[0-9]+$ && "$internal_timeout" -ge 500 && "$internal_timeout" -le 60000 ]] || {
		echo 'REPORTING_INTERNAL_TIMEOUT_MS must be between 500 and 60000.' >&2
		return 1
	}
	reporting_validate_runtime_numeric_env
	core_base_url="$(reporting_get_env_value REPORTING_CORE_INTERNAL_BASE_URL)"
	[[ "$core_base_url" == 'http://127.0.0.1:4200' ]] || {
		echo 'REPORTING_CORE_INTERNAL_BASE_URL must use the reviewed loopback core endpoint.' >&2
		return 1
	}
	reporting_export_pinned_runtime_identity "$deploy_revision"
	# URL validation for the guard uses the currently staged image. Build the
	# exact new image first, but do not touch the database or runtime yet.
	reporting_compose build reporting-service
	new_image_id="$(docker image inspect "$REPORTING_IMAGE" --format '{{.Id}}')"
	new_image_revision="$(docker image inspect "$REPORTING_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
	[[ "$new_image_id" =~ ^sha256:[0-9a-f]{64}$ && "$new_image_revision" == "$deploy_revision" ]] || {
		echo 'Reporting image identity or revision label is invalid.' >&2
		return 1
	}
	# From this point all migration and runtime Compose operations consume the
	# verified content-addressed image, never the mutable build tag.
	REPORTING_IMAGE="$new_image_id"
	export REPORTING_IMAGE
	rabbit_url="$(reporting_get_env_value RABBITMQ_REPORTING_URL)"
	rabbit_credentials="$(reporting_parse_rabbitmq_credentials \
		"$rabbit_url" "$new_image_id" "$deploy_revision")" || return 1
	rabbit_user="$(printf '%s' "$(sed -n '1p' <<<"$rabbit_credentials")" | base64 --decode)"
	rabbit_password="$(printf '%s' "$(sed -n '2p' <<<"$rabbit_credentials")" | base64 --decode)"
	unset rabbit_credentials rabbit_url
	initial_container_any="$(reporting_compose ps -a -q reporting-service 2>/dev/null || true)"
	initial_container_id="$(reporting_compose ps --status running -q reporting-service 2>/dev/null || true)"
	[[ -z "$initial_container_any" ||
		( "$initial_container_any" == "$initial_container_id" &&
			"$initial_container_any" != *$'\n'* ) ]] || {
		unset rabbit_user rabbit_password
		echo 'A stopped or ambiguous Reporting container blocks RabbitMQ credential provisioning.' >&2
		return 1
	}
	if [[ -z "$initial_container_any" ]]; then
		reporting_provision_initial_rabbitmq_user "$rabbit_user" "$rabbit_password" || {
			unset rabbit_user rabbit_password
			return 1
		}
	fi
	if ! reporting_require_rabbitmq_preflight "$rabbit_user" "$rabbit_password"; then
		unset rabbit_user rabbit_password
		return 1
	fi
	unset rabbit_user rabbit_password
	reporting_initialize_database_guard 'routine Reporting deployment'

	current_container_any="$(reporting_compose ps -a -q reporting-service 2>/dev/null || true)"
	current_container_id="$(reporting_compose ps --status running -q reporting-service 2>/dev/null || true)"
	if [[ -n "$current_container_any" && "$current_container_any" != *$'\n'* ]]; then
		[[ "$current_container_any" == "$current_container_id" ]] || {
			echo 'A stopped or unhealthy Reporting container requires manual inspection before deployment.' >&2
			return 1
		}
		previous_container_present=true
		previous_image_id="$(docker inspect --format '{{.Image}}' "$current_container_id")"
		previous_image_ref="$(docker inspect --format '{{.Config.Image}}' "$current_container_id")"
		previous_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$previous_image_id")"
		[[ "$previous_image_id" =~ ^sha256:[0-9a-f]{64}$ && "$previous_revision" =~ ^[0-9a-f]{40}$ ]] || {
			echo 'Previous Reporting image identity is invalid.' >&2
			return 1
		}
		reporting_capture_previous_runtime_config "$current_container_id"
		previous_scheduler_enabled="$(reporting_previous_runtime_env_value REPORTING_SCHEDULER_ENABLED)"
		reporting_cutover_scheduler_value_allowed "$scheduler_policy" "$previous_scheduler_enabled" || {
			echo 'Current Reporting scheduler state conflicts with the durable cutover marker.' >&2
			return 1
		}
		reporting_verify_service "$previous_image_id" "$previous_revision" 0 \
			"$previous_scheduler_enabled" || {
			echo 'Current Reporting service is not a healthy rollback target.' >&2
			return 1
		}
		[[ "$(reporting_previous_runtime_env_value APP_REVISION)" == "$previous_revision" ]] || {
			echo 'Previous Reporting runtime config revision differs from its image.' >&2
			return 1
		}
		git -C "$server_root" merge-base --is-ancestor "$previous_revision" "$deploy_revision" || {
			echo 'Reporting deploy does not accept divergent revision history.' >&2
			return 1
		}
		changed_paths="$(git -C "$server_root" diff --name-only "$previous_revision" "$deploy_revision")"
		while IFS= read -r changed_path; do
			[[ -z "$changed_path" || "$changed_path" == apps/reporting/* ||
				"$changed_path" == scripts/deploy-reporting-production.sh ||
				"$changed_path" == scripts/reporting-database-lifecycle.sh ||
				"$changed_path" == scripts/reporting-cutover-lifecycle.sh ||
				"$changed_path" == scripts/test-reporting-production-scripts.sh ]] || {
				echo "Reporting-only deploy cannot release shared path: $changed_path" >&2
				echo 'Use the coordinated/full phase-A production target.' >&2
				return 1
			}
		done <<<"$changed_paths"
		changed_migrations="$(git -C "$server_root" diff --name-only "$previous_revision" "$deploy_revision" -- 'apps/reporting/prisma/migrations/*/migration.sql')"
	else
		[[ -z "$current_container_any" ]] || {
			echo 'Multiple Reporting containers were resolved unexpectedly.' >&2
			return 1
		}
		changed_migrations="$(git -C "$server_root" ls-files 'apps/reporting/prisma/migrations/*/migration.sql')"
	fi
	reporting_schema_relation_count="$(reporting_database_psql REPORTING_MIGRATION_DATABASE_URL --tuples-only --no-align --command "SELECT count(*) FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = '$REPORTING_CANONICAL_SCHEMA' AND relation.relkind IN ('r', 'p', 'S', 'v', 'm');")"
	reporting_migration_table_present="$(reporting_database_psql REPORTING_MIGRATION_DATABASE_URL --tuples-only --no-align --command "SELECT CASE WHEN to_regclass('$REPORTING_CANONICAL_SCHEMA._prisma_migrations') IS NULL THEN 'false' ELSE 'true' END;")"
	[[ "$reporting_schema_relation_count" =~ ^[0-9]+$ &&
		( "$reporting_migration_table_present" == 'true' || "$reporting_migration_table_present" == 'false' ) ]] || {
		echo 'Reporting schema baseline could not be classified safely.' >&2
		return 1
	}
	if [[ "$previous_container_present" != 'true' &&
		"$reporting_schema_relation_count" != '0' &&
		"$reporting_migration_table_present" != 'true' ]]; then
		echo 'Initial Reporting deploy found untracked schema objects without Prisma migration history.' >&2
		return 1
	fi

	while IFS= read -r migration; do
		[[ -z "$migration" ]] && continue
		if git -C "$server_root" show "$deploy_revision:$migration" 2>/dev/null |
			grep -Eiq '(^|[[:space:]])(DROP|TRUNCATE)[[:space:]]|RENAME[[:space:]]|ALTER[[:space:]]+COLUMN|SET[[:space:]]+NOT[[:space:]]+NULL'; then
			echo "Reporting migration is not safe for service image rollback: $migration" >&2
			return 1
		fi
	done <<<"$changed_migrations"

	docker run --rm --network none --read-only --cap-drop ALL \
		--security-opt no-new-privileges --pids-limit 64 --memory 128m --cpus 0.5 \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		"$new_image_id" sh -euc '
test -f dist/src/main.js
test -f prisma/schema.prisma
node -e '\''require("@prisma/reporting-client")'\''
test ! -e dist/src/app.module.js
test ! -e public/widgets
'
	if [[ -n "$changed_migrations" &&
		( "$previous_container_present" == 'true' || "$reporting_migration_table_present" == 'true' ) ]]; then
		reporting_create_pre_migration_backup "$deploy_revision"
	fi
	reporting_compose --profile reporting-migration run --rm --no-deps reporting-migrate
	reporting_compose --profile reporting-migration run --rm --no-deps reporting-migrate \
		migrate status --schema prisma/schema.prisma
	reporting_reconcile_database_acl
	reporting_verify_database_access_boundaries
	reporting_verify_database_lifecycle_unchanged

	trap reporting_deploy_on_exit EXIT
	trap 'exit 129' HUP
	trap 'exit 130' INT
	trap 'exit 143' TERM
	recreate_started=true
	reporting_compose up -d --no-deps --no-build --force-recreate reporting-service
	reporting_verify_service "$new_image_id" "$deploy_revision" 0 \
		"$scheduler_enabled" || {
		echo 'Reporting service failed revision/readiness/scheduler/restart checks.' >&2
		return 1
	}
	reporting_verify_database_lifecycle_unchanged
	rollout_verified=true
	trap - EXIT HUP INT TERM
	echo "Reporting deployed at revision $deploy_revision with scheduler=$scheduler_enabled (cutover policy=$scheduler_policy)."
	if [[ "$previous_container_present" == 'true' ]]; then
		echo "Previous compatible image retained for rollback: $previous_image_ref ($previous_image_id)."
	else
		echo 'Initial phase-A service has no previous image; failure cleanup preserves the Reporting database.'
	fi
}

reporting_deploy_main "$@"
