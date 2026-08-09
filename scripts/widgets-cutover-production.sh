#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
HEALTHCHECK_ATTEMPTS="${WIDGETS_HEALTHCHECK_ATTEMPTS:-60}"
HEALTHCHECK_INTERVAL="${WIDGETS_HEALTHCHECK_INTERVAL:-2}"
DRAIN_ATTEMPTS="${WIDGETS_CUTOVER_DRAIN_ATTEMPTS:-120}"
DRAIN_INTERVAL="${WIDGETS_CUTOVER_DRAIN_INTERVAL:-2}"

server_root="$APP_ROOT/winwidget.ru_server"
artifact_root="$APP_ROOT/deploy/backend/widgets-cutover-artifacts"
snapshot_file="$artifact_root/widgets-cutover-snapshot-v1.jsonl"
snapshot_partial="$snapshot_file.partial"
import_result_file="$artifact_root/import-result.json"
handoff_result_file="$artifact_root/handoff-result.json"
activation_result_file="$artifact_root/activation-result.json"
verify_result_file="$artifact_root/verify-result.json"
core_backup_file="$artifact_root/core-pre-widgets-cutover.dump"
core_backup_sha_file="$artifact_root/core-pre-widgets-cutover.sha256"
widgets_backup_file=''
widgets_backup_sha_file=''

# shellcheck source=scripts/widgets-database-lifecycle.sh
source "$server_root/scripts/widgets-database-lifecycle.sh"

readonly canonical_widgets_postgres_image='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly canonical_worker_kinds="$WIDGETS_CANONICAL_STEADY_INTEGRATION_WORKER_KINDS"
readonly widgets_cutover_confirmation='CUTOVER WIDGETS OWNERSHIP'
readonly widgets_rabbitmq_configure_pattern="$WIDGETS_CANONICAL_RABBITMQ_CONFIGURE_PATTERN"
readonly widgets_rabbitmq_write_pattern="$WIDGETS_CANONICAL_RABBITMQ_WRITE_PATTERN"
readonly widgets_rabbitmq_read_pattern="$WIDGETS_CANONICAL_RABBITMQ_READ_PATTERN"
readonly widgets_events_topic_write="$WIDGETS_CANONICAL_EVENTS_TOPIC_WRITE"
readonly widgets_events_topic_read="$WIDGETS_CANONICAL_EVENTS_TOPIC_READ"
readonly widgets_dead_letter_topic="$WIDGETS_CANONICAL_DEAD_LETTER_TOPIC"
readonly -a required_source_services=(
	api-gateway
	api
	outbox-publisher
	integration-worker
	reporting-service
)
readonly -a reporting_drain_queues=(
	winwidget.reporting.widget
	winwidget.reporting.widget.retry.1
	winwidget.reporting.widget.retry.2
	winwidget.reporting.widget.retry.3
	winwidget.reporting.widget.dead-letter
	winwidget.reporting.lead
	winwidget.reporting.lead.retry.1
	winwidget.reporting.lead.retry.2
	winwidget.reporting.lead.retry.3
	winwidget.reporting.lead.dead-letter
)
readonly -a provider_queues=(
	"${WIDGETS_CANONICAL_PROVIDER_QUEUES[@]}"
)
readonly -a legacy_provider_drain_queue_contract=(
	'winwidget.lead-integration.webhook|1'
	'winwidget.lead-integration.webhook.retry-v2.1|0'
	'winwidget.lead-integration.webhook.retry-v2.2|0'
	'winwidget.lead-integration.webhook.retry-v2.3|0'
	'winwidget.lead-integration.webhook.dead-letter|0'
	'winwidget.lead-integration.bitrix24|1'
	'winwidget.lead-integration.bitrix24.retry-v2.1|0'
	'winwidget.lead-integration.bitrix24.retry-v2.2|0'
	'winwidget.lead-integration.bitrix24.retry-v2.3|0'
	'winwidget.lead-integration.bitrix24.dead-letter|0'
	'winwidget.lead-integration.amo-crm|1'
	'winwidget.lead-integration.amo-crm.retry-v2.1|0'
	'winwidget.lead-integration.amo-crm.retry-v2.2|0'
	'winwidget.lead-integration.amo-crm.retry-v2.3|0'
	'winwidget.lead-integration.amo-crm.dead-letter|0'
)

source_frozen=false
forward_only=false
snapshot_locked=false
dark_service_started=false
legacy_integration_worker_stopped=false
legacy_core_topology_owner_stopped=false
widgets_projection_topology_ready=false
core_topology_owner_restarted=false
initial_ownership_state=''
rabbitmq_container_id=''
widgets_postgres_container_id=''
deploy_revision=''
expected_revision=''

fail() {
	echo "$1" >&2
	# An explicit exit bypasses Bash's ERR trap. Dispatch cleanup directly so a
	# pre-forward failure cannot leave the source fence or legacy worker behind.
	on_error "${BASH_LINENO[0]}" 1
}

compose_target() {
	docker compose --project-name winwidget --env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" "$@"
}

# shellcheck source=scripts/production-deploy-lock.sh
source "$server_root/scripts/production-deploy-lock.sh"
acquire_production_deploy_lock 'Widgets first cutover'
# shellcheck source=scripts/database-restore-production-guard.sh
source "$server_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/core-database-production-guard.sh
source "$server_root/scripts/core-database-production-guard.sh"
# shellcheck source=scripts/reporting-database-lifecycle.sh
source "$server_root/scripts/reporting-database-lifecycle.sh"

get_env_value() {
	widgets_lifecycle_get_env_value "$1"
}

require_env_key() {
	local key="$1"
	local value
	value="$(get_env_value "$key")" ||
		fail "Missing or duplicate production env key: $key"
	[[ -n "$value" && "$value" != change_me* && "$value" != XYZXYZXYZ* ]] ||
		fail "Production env key is empty or a placeholder: $key"
}

restore_pre_forward_source() {
	local recovery_status
	if widgets_should_restore_pre_forward_source \
		"$source_frozen" "$forward_only" "$snapshot_locked"; then
		:
	else
		recovery_status="$?"
		[[ "$recovery_status" == '1' ]] && return 0
		return 1
	fi
	echo 'Widgets cutover failed before the snapshot boundary; restoring legacy Widgets writes.' >&2
	if [[ "$legacy_integration_worker_stopped" == 'true' ]]; then
		compose_target start "${WIDGETS_CANONICAL_SOURCE_FREEZE_SERVICES[@]}" \
			>/dev/null 2>&1 || return 1
		wait_for_legacy_provider_consumers || return 1
		legacy_integration_worker_stopped=false
	fi
	if [[ -e "$snapshot_partial" || -L "$snapshot_partial" ]]; then
		[[ -f "$snapshot_partial" && ! -L "$snapshot_partial" &&
			"$(stat -c '%u:%g:%a' "$snapshot_partial")" == '0:0:600' ]] ||
			return 1
		rm -f -- "$snapshot_partial"
	fi
	run_core_sql "$(widgets_core_write_fence_remove_sql)" >/dev/null || return 1
	source_frozen=false
}

on_error() {
	local line="$1"
	local exit_code="$2"
	trap - ERR
	set +e
	if [[ "$dark_service_started" == 'true' ]]; then
		compose_target stop -t 90 widgets-service >/dev/null 2>&1 || true
		dark_service_started=false
	fi
	if [[ "$forward_only" == 'true' ]]; then
		echo "Widgets cutover stopped after the forward-only ownership boundary at line $line (exit $exit_code)." >&2
		echo 'Do not restore legacy ownership; rerun the manual widgets target for forward recovery.' >&2
	elif [[ "$snapshot_locked" == 'true' ]]; then
		echo "Widgets cutover stopped with a deterministic snapshot at line $line (exit $exit_code)." >&2
		echo 'The source remains frozen; rerun the manual widgets target and do not resume legacy writes.' >&2
	else
		restore_pre_forward_source ||
			echo 'The pre-cutover Widgets write fence could not be removed automatically.' >&2
	fi
	exit "$exit_code"
}
trap 'on_error "$LINENO" "$?"' ERR

assert_checkout_and_environment() {
	local key
	local staleness
	local admin_secret_file

	[[ "${WIDGETS_AUTOMATIC_PROD_PUSH:-false}" == 'false' ]] ||
		fail 'Widgets first cutover and forward recovery are manual-only.'
	[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
		"$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
		fail 'Backend production env must be a root-owned mode-600 regular file.'
	[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] ||
		fail 'Backend production Compose file was not found.'

	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	deploy_revision="$(git -C "$server_root" rev-parse HEAD)"
	expected_revision="${EXPECTED_REVISION:-$deploy_revision}"
	[[ "$deploy_revision" == "$expected_revision" &&
		"$(git -C "$server_root" branch --show-current)" == 'prod' &&
		-z "$(git -C "$server_root" status --porcelain --untracked-files=all)" ]] ||
		fail 'Widgets cutover requires a clean protected prod checkout at EXPECTED_REVISION.'

	reporting_cutover_validate_marker ||
		fail 'Reporting cutover marker is missing or invalid.'
	[[ "$(reporting_cutover_marker_value phase)" == 'complete' ]] ||
		fail 'Reporting phase=complete is a hard gate for Widgets ownership.'
	assert_core_database_production_boundary

	for key in \
		DATABASE_URL_PRODUCTION DATABASE_MIGRATION_URL_PRODUCTION DATABASE_BACKUP_URL \
		INTEGRATION_WORKER_KINDS GATEWAY_ROUTES_JSON \
		WIDGETS_DATABASE_URL WIDGETS_MIGRATION_DATABASE_URL WIDGETS_BACKUP_URL \
		WIDGETS_POSTGRES_IMAGE WIDGETS_POSTGRES_PORT WIDGETS_POSTGRES_DATA_VOLUME \
		WIDGETS_POSTGRES_ADMIN_USER WIDGETS_POSTGRES_ADMIN_PASSWORD_FILE \
		WIDGETS_PROCESS_ROLE WIDGETS_LISTEN_HOST WIDGETS_PORT \
		WIDGETS_CORE_INTERNAL_BASE_URL WIDGETS_INTERNAL_BASE_URL \
		WIDGETS_INTERNAL_TOKEN WIDGETS_INTERNAL_TIMEOUT_MS \
		WIDGETS_ENTITLEMENT_MAX_STALENESS_MS RABBITMQ_WIDGETS_URL \
		RABBITMQ_INTEGRATION_WORKER_URL RABBITMQ_VHOST; do
		require_env_key "$key"
	done

	[[ "$(get_env_value WIDGETS_POSTGRES_IMAGE)" == "$canonical_widgets_postgres_image" &&
		"$(get_env_value WIDGETS_POSTGRES_PORT)" == '55436' &&
		"$(get_env_value WIDGETS_POSTGRES_DATA_VOLUME)" == 'winwidget-widgets-postgres-data' &&
		"$(get_env_value WIDGETS_POSTGRES_ADMIN_USER)" == 'winwidget_widgets_admin' ]] ||
		fail 'Widgets PostgreSQL must use the reviewed canonical PG18 identity.'
	[[ "$(get_env_value WIDGETS_PROCESS_ROLE)" == 'all' &&
		"$(get_env_value WIDGETS_LISTEN_HOST)" == '127.0.0.1' &&
		"$(get_env_value WIDGETS_PORT)" == '4700' &&
		"$(get_env_value WIDGETS_CORE_INTERNAL_BASE_URL)" == 'http://127.0.0.1:4200' &&
		"$(get_env_value WIDGETS_INTERNAL_BASE_URL)" == 'http://127.0.0.1:4700' ]] ||
		fail 'Widgets runtime boundary must remain loopback-only role=all on port 4700.'
	[[ "$(get_env_value INTEGRATION_WORKER_KINDS)" == "$canonical_worker_kinds" ]] ||
		fail 'Core integration-worker kinds are not the exact Widgets steady-state set.'
	staleness="$(get_env_value WIDGETS_ENTITLEMENT_MAX_STALENESS_MS)"
	[[ "$staleness" =~ ^[0-9]+$ ]] &&
		((staleness >= 60000 && staleness <= 31968000000)) ||
		fail 'Widgets entitlement staleness must be a finite reviewed production value.'

	admin_secret_file="$(get_env_value WIDGETS_POSTGRES_ADMIN_PASSWORD_FILE)"
	[[ "$admin_secret_file" == "$APP_ROOT/deploy/backend/.widgets-postgres-admin-password" &&
		-f "$admin_secret_file" && ! -L "$admin_secret_file" &&
		"$(stat -c '%u:%g:%a' "$admin_secret_file")" == '0:0:600' ]] ||
		fail 'Widgets PostgreSQL admin secret must use the canonical root-owned mode-600 file.'

	initial_ownership_state="$(widgets_service_identity_state)" ||
		fail 'Widgets service identity is unreadable.'
	case "$initial_ownership_state" in
	active | handoff) ;;
	absent | inactive)
		[[ "${WIDGETS_FIRST_CUTOVER_APPROVED:-false}" == 'true' &&
			"${WIDGETS_FIRST_CUTOVER_CONFIRMATION:-}" == "$widgets_cutover_confirmation" ]] ||
			fail 'Widgets first cutover requires the explicit manual target and exact ownership confirmation phrase.'
		;;
	*) fail 'Widgets service identity state is invalid.' ;;
	esac
}

export_image_identity() {
	widgets_export_compose_release_identity "$deploy_revision"
	widgets_backup_file="$artifact_root/widgets-post-cutover-$deploy_revision.dump"
	widgets_backup_sha_file="$artifact_root/widgets-post-cutover-$deploy_revision.sha256"
}

validate_gateway_routes() {
	local routes
	routes="$(get_env_value GATEWAY_ROUTES_JSON)"
	printf '%s' "$routes" |
		docker run --rm -i --network none --entrypoint node \
			"winwidget-api-gateway:$APP_VERSION" -e '
const { readFileSync } = require("node:fs");
const routes = JSON.parse(readFileSync(0, "utf8"));
const expected = [
  ["widgets-admin", "/api/v1/widgets/admin", "required"],
  ["widgets-management", "/api/v1/widgets", "required"],
  ["quizzes-management", "/api/v1/quizzes", "required"],
  ["callbacks-management", "/api/v1/callbacks", "required"],
  ["countdown-timers-management", "/api/v1/countdown-timers", "required"],
  ["stop-offers-management", "/api/v1/stop-offers", "required"],
  ["online-consultants-management", "/api/v1/online-consultants", "required"],
  ["calculators-management", "/api/v1/calculators", "required"],
  ["widget-settings", "/api/v1/widget-settings", "required"],
  ["widget-runtime", "/api/v1/widget-runtime", "required"],
  ["widget-public", "/api/v1/widget", "optional"],
  ["quiz-public", "/api/v1/quiz", "optional"],
  ["callback-public", "/api/v1/callback", "optional"],
  ["countdown-timer-public", "/api/v1/countdown-timer", "optional"],
  ["stop-offer-public", "/api/v1/stop-offer", "optional"],
  ["online-consultant-public", "/api/v1/online-consultant", "optional"],
  ["calculator-public", "/api/v1/calculator", "optional"],
  ["widget-events", "/api/v1/widget-events", "optional"],
];
const actual = routes.filter(route => route.upstreamUrl === "http://127.0.0.1:4700");
if (actual.length !== expected.length) throw new Error("Gateway must expose exactly 18 Widgets routes");
for (const [index, values] of expected.entries()) {
  const route = actual[index];
  if (route.id !== values[0] || route.pathPrefix !== values[1] ||
      route.authPolicy !== values[2] || route.timeoutMs !== 60000) {
    throw new Error(`Widgets Gateway route mismatch at index ${index}`);
  }
}
const monolith = routes.at(-1);
if (!monolith || monolith.id !== "monolith" || monolith.pathPrefix !== "/api/v1" ||
    monolith.upstreamUrl !== "http://127.0.0.1:4200" || monolith.authPolicy !== "optional") {
  throw new Error("Monolith fallback must remain last");
}
process.stdout.write("Gateway Widgets route manifest verified\n");
'
}

verify_widgets_image() {
	docker run --rm --network none --entrypoint node "$WIDGETS_IMAGE" -e '
const fs = require("node:fs");
for (const path of ["dist/src/main.js", "dist/src/cutover-main.js", "prisma/schema.prisma"]) fs.accessSync(path);
require("@prisma/widgets-client");
const forbidden = ["dist/src/app.module.js", "dist/src/widget/widget.service.js", "dist/src/outbox-publisher-main.js", "public/email"];
for (const path of forbidden) if (fs.existsSync(path)) throw new Error(`Widgets image contains Core artifact: ${path}`);
const expected = ["calculator-button.png","calculator.js","callback-button.png","callback.js","email-logo.png","gift-button.png","helpers/libphonenumber-min.js","helpers/winwidget-phone.js","online-consultant-button.png","online-consultant.js","quiz-button.png","quiz.js","stop-offer.js","timer-button.png","timer.js","wheel.js"];
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = `${directory}/${entry.name}`;
  return entry.isDirectory() ? walk(path) : [path.slice("public/widgets/".length)];
}).sort();
if (JSON.stringify(walk("public/widgets")) !== JSON.stringify(expected)) throw new Error("Widgets runtime asset manifest drifted");
process.stdout.write("Standalone Widgets image verified\n");
'
}

build_and_verify_images() {
	compose_target --profile migration --profile reporting-migration \
		--profile widgets-migration --profile widgets-database config --quiet
	compose_target build --provenance=false api api-gateway maintenance-worker \
		database-restore-worker reporting-service widgets-service
	verify_widgets_image
	docker run --rm --network none --entrypoint node "winwidget-api:$APP_VERSION" -e '
const fs = require("node:fs");
fs.accessSync("dist/src/main.js");
require("@prisma/client");
if (fs.existsSync("public/widgets")) throw new Error("Core image still contains Widgets assets");
process.stdout.write("Core image Widgets boundary verified\n");
'
	validate_gateway_routes
}

validate_widgets_database_urls() {
	printf '%s\n%s\n%s\n' \
		"$(get_env_value WIDGETS_DATABASE_URL)" \
		"$(get_env_value WIDGETS_MIGRATION_DATABASE_URL)" \
		"$(get_env_value WIDGETS_BACKUP_URL)" |
		docker run --rm -i --network none \
			-e "EXPECTED_PORT=$(get_env_value WIDGETS_POSTGRES_PORT)" \
			--entrypoint node "$WIDGETS_IMAGE" -e '
const { readFileSync } = require("node:fs");
const urls = readFileSync(0, "utf8").trim().split("\n").map(value => new URL(value));
const users = ["winwidget_widgets_runtime", "winwidget_widgets_migration", "winwidget_widgets_backup"];
for (const [index, url] of urls.entries()) {
  const password = decodeURIComponent(url.password);
  if (url.protocol !== "postgresql:" || decodeURIComponent(url.username) !== users[index] ||
      url.hostname !== "127.0.0.1" || url.port !== process.env.EXPECTED_PORT ||
      url.pathname !== "/winwidget_widgets" || url.searchParams.get("schema") !== "widgets" ||
      password.length < 16 || /[\0\r\n]/.test(password)) throw new Error(`Invalid Widgets database URL ${index}`);
}
process.stdout.write("Widgets database URL boundaries verified\n");
'
}

wait_for_widgets_postgres() {
	local attempt
	local health
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$widgets_postgres_container_id" 2>/dev/null || true)"
		[[ "$health" == 'healthy' ]] && return 0
		[[ "$health" != 'unhealthy' ]] || return 1
		sleep "$HEALTHCHECK_INTERVAL"
	done
	return 1
}

prepare_widgets_postgres() {
	local volume
	local volume_identity
	local container_identity
	local mount_identity
	volume="$(get_env_value WIDGETS_POSTGRES_DATA_VOLUME)"
	if ! docker volume inspect "$volume" >/dev/null 2>&1; then
		docker volume create \
			--label com.winwidget.owner=widgets \
			--label com.winwidget.purpose=postgres \
			"$volume" >/dev/null
	fi
	volume_identity="$(docker volume inspect --format '{{.Driver}}|{{index .Labels "com.winwidget.owner"}}|{{index .Labels "com.winwidget.purpose"}}' "$volume")"
	[[ "$volume_identity" == 'local|widgets|postgres' ]] ||
		fail 'Widgets PostgreSQL volume identity is unsafe.'

	compose_target --profile widgets-database up -d widgets-postgres
	widgets_postgres_container_id="$(compose_target --profile widgets-database ps -q widgets-postgres)"
	[[ "$widgets_postgres_container_id" =~ ^[0-9a-f]{64}$ ]] ||
		fail 'Widgets PostgreSQL container was not created.'
	wait_for_widgets_postgres || fail 'Widgets PostgreSQL did not become healthy.'
	container_identity="$(docker inspect --format '{{.Config.Image}}|{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}|{{.HostConfig.RestartPolicy.Name}}' "$widgets_postgres_container_id")"
	[[ "$container_identity" == "$canonical_widgets_postgres_image|widgets|postgres|unless-stopped" ]] ||
		fail 'Widgets PostgreSQL container identity is unsafe.'
	mount_identity="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}' "$widgets_postgres_container_id")"
	[[ "$mount_identity" == "volume|$volume|true" ]] ||
		fail 'Widgets PostgreSQL data mount is unsafe.'
}

provision_widgets_database_roles() {
	local credentials_sql
	WIDGETS_DATABASE_URL="$(get_env_value WIDGETS_DATABASE_URL)"
	WIDGETS_MIGRATION_DATABASE_URL="$(get_env_value WIDGETS_MIGRATION_DATABASE_URL)"
	WIDGETS_BACKUP_URL="$(get_env_value WIDGETS_BACKUP_URL)"
	export WIDGETS_DATABASE_URL WIDGETS_MIGRATION_DATABASE_URL WIDGETS_BACKUP_URL
	credentials_sql="$(docker run --rm --network none \
		-e WIDGETS_DATABASE_URL -e WIDGETS_MIGRATION_DATABASE_URL -e WIDGETS_BACKUP_URL \
		--entrypoint node "$WIDGETS_IMAGE" -e '
const specs = [
  ["runtime_password_base64", process.env.WIDGETS_DATABASE_URL, "winwidget_widgets_runtime"],
  ["migration_password_base64", process.env.WIDGETS_MIGRATION_DATABASE_URL, "winwidget_widgets_migration"],
  ["backup_password_base64", process.env.WIDGETS_BACKUP_URL, "winwidget_widgets_backup"],
];
for (const [name, raw, expectedUser] of specs) {
  const url = new URL(raw);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (user !== expectedUser || password.length < 16 || /[\0\r\n]/.test(password)) throw new Error("Unsafe Widgets database credential");
  process.stdout.write(`\\set ${name} ${Buffer.from(password).toString("base64")}\n`);
}
' )"
	[[ "$(wc -l <<<"$credentials_sql" | tr -d '[:space:]')" == '3' ]] ||
		fail 'Widgets database credential transport is incomplete.'
	{
		printf '%s\n' "$credentials_sql"
		cat <<'SQL'
BEGIN;
REVOKE ALL ON DATABASE winwidget_widgets FROM PUBLIC;
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_widgets_migration') THEN
    CREATE ROLE winwidget_widgets_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_widgets_runtime') THEN
    CREATE ROLE winwidget_widgets_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_widgets_backup') THEN
    CREATE ROLE winwidget_widgets_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$roles$;
SELECT format('ALTER ROLE winwidget_widgets_runtime PASSWORD %L', convert_from(decode(:'runtime_password_base64', 'base64'), 'UTF8')) \gexec
SELECT format('ALTER ROLE winwidget_widgets_migration PASSWORD %L', convert_from(decode(:'migration_password_base64', 'base64'), 'UTF8')) \gexec
SELECT format('ALTER ROLE winwidget_widgets_backup PASSWORD %L', convert_from(decode(:'backup_password_base64', 'base64'), 'UTF8')) \gexec
ALTER ROLE winwidget_widgets_migration NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE winwidget_widgets_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE winwidget_widgets_backup NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT winwidget_widgets_migration, winwidget_widgets_runtime, winwidget_widgets_backup TO winwidget_widgets_admin;
GRANT CONNECT ON DATABASE winwidget_widgets TO winwidget_widgets_migration, winwidget_widgets_runtime, winwidget_widgets_backup;
REVOKE CREATE, TEMPORARY ON DATABASE winwidget_widgets FROM winwidget_widgets_migration, winwidget_widgets_runtime, winwidget_widgets_backup;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS widgets AUTHORIZATION winwidget_widgets_migration;
ALTER SCHEMA widgets OWNER TO winwidget_widgets_migration;
REVOKE ALL ON SCHEMA widgets FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA widgets TO winwidget_widgets_migration;
GRANT USAGE ON SCHEMA widgets TO winwidget_widgets_runtime, winwidget_widgets_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_widgets_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_widgets_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets GRANT SELECT ON TABLES TO winwidget_widgets_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets GRANT SELECT ON SEQUENCES TO winwidget_widgets_backup;
COMMIT;
SQL
	} | docker exec -i "$widgets_postgres_container_id" \
			psql --quiet --set ON_ERROR_STOP=1 \
				--username winwidget_widgets_admin --dbname winwidget_widgets
	unset credentials_sql
}

run_psql_url() {
	local database_url="$1"
	local sql="$2"
	database_url="$(widgets_lifecycle_libpq_url "$database_url")"
	PGURL="$database_url" PSQL_QUERY="$sql" \
		docker run --rm --network host -e PGURL -e PSQL_QUERY \
			--entrypoint sh "$canonical_widgets_postgres_image" -euc '
			exec psql "$PGURL" --no-psqlrc --set ON_ERROR_STOP=1 \
				--tuples-only --no-align --command "$PSQL_QUERY"
		'
}

run_core_sql() {
	run_psql_url "$(get_env_value DATABASE_MIGRATION_URL_PRODUCTION)" "$1"
}

run_widgets_sql() {
	run_psql_url "$(get_env_value WIDGETS_DATABASE_URL)" "$1"
}

run_widgets_backup_sql() {
	run_psql_url "$(get_env_value WIDGETS_BACKUP_URL)" "$1"
}

verify_widgets_rabbitmq_credentials() {
	local container_id="$1"
	docker exec "$container_id" node -e '
const amqp = require("amqplib");
(async () => {
  if (!process.env.RABBITMQ_URL) throw new Error("RabbitMQ URL is missing");
  const connection = await amqp.connect(process.env.RABBITMQ_URL, {
    timeout: 5000,
    clientProperties: { connection_name: "winwidget-widgets-cutover-dark-probe" },
  });
  const channel = await connection.createConfirmChannel();
  await channel.checkQueue("winwidget.widgets.identity-user");
  await channel.close();
  await connection.close();
  process.stdout.write("Widgets RabbitMQ credentials verified\n");
})().catch(() => {
  process.stderr.write("Widgets RabbitMQ credential probe failed\n");
  process.exit(1);
});
'
}

start_and_verify_dark_widgets_service() {
	local dark_port='14700'
	local container_id
	local role
	local listen_host
	local database_identity
	local listener
	local response

	if ss -H -ltn "sport = :$dark_port" | grep -q .; then
		fail "Widgets dark verification port is already in use: $dark_port"
	fi
	dark_service_started=true
	WIDGETS_PROCESS_ROLE=api \
	WIDGETS_PORT="$dark_port" \
	WIDGETS_INTERNAL_BASE_URL="http://127.0.0.1:$dark_port" \
		compose_target up -d --no-deps --no-build --force-recreate widgets-service
	wait_for_url_revision "http://127.0.0.1:$dark_port/health/ready" "$deploy_revision" ||
		fail 'The dark Widgets API candidate did not become ready.'
	container_id="$(compose_target ps --status running -q widgets-service)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		fail 'The dark Widgets API candidate has no running container.'
	role="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^WIDGETS_PROCESS_ROLE=//p')"
	listen_host="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^WIDGETS_LISTEN_HOST=//p')"
	response="$(curl -fsS --connect-timeout 2 --max-time 5 \
		"http://127.0.0.1:$dark_port/health/ready")"
	listener="$(ss -H -ltn4 "sport = :$dark_port" | awk '{ print $4 }')"
	[[ "$role" == 'api' && "$listen_host" == '127.0.0.1' &&
		"$listener" == "127.0.0.1:$dark_port" &&
		( "$response" == *'"role":"api"'* || "$response" == *'"role": "api"'* ) ]] ||
		fail 'The dark Widgets candidate crossed the reviewed API-only loopback boundary.'
	verify_running_service_revision widgets-service "$deploy_revision" ||
		fail 'The dark Widgets candidate image revision or restart count is invalid.'
	database_identity="$(docker exec "$container_id" node -e '
const { PrismaClient } = require("@prisma/widgets-client");
const prisma = new PrismaClient();
(async () => {
  const [row] = await prisma.$queryRawUnsafe(`
    SELECT
      current_database() AS database_name,
      current_user AS role_name,
      current_setting('\''server_version_num'\'')::integer / 10000 AS major_version,
	  (SELECT datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
	   FROM pg_database WHERE datname = current_database()) AS database_owner,
	  (SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
	   FROM pg_namespace WHERE nspname = '\''widgets'\'') AS schema_owner,
      has_database_privilege(current_user, current_database(), '\''CREATE'\'') AS database_create,
      has_schema_privilege(current_user, '\''widgets'\'', '\''CREATE'\'') AS schema_create,
      has_table_privilege(current_user, '\''widgets._prisma_migrations'\'', '\''SELECT'\'') AS migration_read,
      (SELECT count(*)::integer
       FROM widgets.service_identity
       WHERE id = '\''widgets-service'\''
         AND database_id::text ~ '\''^[0-9a-f-]{36}$'\'') AS identity_rows
  `);
  process.stdout.write([
    row.database_name,
    row.role_name,
    row.major_version,
	row.database_owner,
	row.schema_owner,
    row.database_create,
    row.schema_create,
    row.migration_read,
    row.identity_rows,
  ].join("|"));
})().catch(() => {
  process.stderr.write("Widgets dark database identity probe failed\n");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
')"
	[[ "$database_identity" == 'winwidget_widgets|winwidget_widgets_runtime|18|false|false|false|false|false|1' ]] ||
		fail 'The dark Widgets candidate database identity is invalid.'
	verify_widgets_rabbitmq_credentials "$container_id"
	stop_services_gracefully widgets-service
	dark_service_started=false
	echo 'Dark Widgets API health, dedicated database identity and RabbitMQ credentials verified before source freeze.'
}

migrate_widgets_database() {
	compose_target --profile widgets-migration run --rm --no-deps widgets-migrate
	compose_target --profile widgets-migration run --rm --no-deps widgets-migrate \
		migrate status --schema prisma/schema.prisma
}

finalize_widgets_acl() {
	docker exec -i "$widgets_postgres_container_id" \
		psql --quiet --set ON_ERROR_STOP=1 \
			--username winwidget_widgets_admin --dbname winwidget_widgets <<'SQL'
REVOKE ALL ON ALL TABLES IN SCHEMA widgets
  FROM PUBLIC, winwidget_widgets_runtime, winwidget_widgets_backup;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA widgets
  FROM PUBLIC, winwidget_widgets_runtime, winwidget_widgets_backup;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA widgets
  FROM PUBLIC, winwidget_widgets_runtime, winwidget_widgets_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA widgets
  TO winwidget_widgets_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA widgets
  TO winwidget_widgets_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA widgets TO winwidget_widgets_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA widgets TO winwidget_widgets_backup;
REVOKE ALL ON TABLE widgets._prisma_migrations
  FROM winwidget_widgets_runtime;
REVOKE CREATE ON DATABASE winwidget_widgets
  FROM winwidget_widgets_migration, winwidget_widgets_runtime, winwidget_widgets_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets
  REVOKE ALL ON TABLES FROM PUBLIC, winwidget_widgets_runtime, winwidget_widgets_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets
  REVOKE ALL ON SEQUENCES FROM PUBLIC, winwidget_widgets_runtime, winwidget_widgets_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_widgets_runtime, winwidget_widgets_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, winwidget_widgets_runtime, winwidget_widgets_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_widgets_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_widgets_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets
  GRANT SELECT ON TABLES TO winwidget_widgets_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_widgets_migration IN SCHEMA widgets
  GRANT SELECT ON SEQUENCES TO winwidget_widgets_backup;
DO $acl$
DECLARE
  table_name TEXT;
BEGIN
  FOR table_name IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'widgets' AND tablename <> '_prisma_migrations'
  LOOP
    IF NOT has_table_privilege(
      'winwidget_widgets_runtime', format('widgets.%I', table_name),
      'SELECT,INSERT,UPDATE,DELETE'
    ) THEN
      RAISE EXCEPTION 'Widgets runtime ACL missing for %', table_name;
    END IF;
    IF NOT has_table_privilege(
      'winwidget_widgets_backup', format('widgets.%I', table_name), 'SELECT'
    ) THEN
      RAISE EXCEPTION 'Widgets backup ACL missing for %', table_name;
    END IF;
  END LOOP;
  IF has_table_privilege(
    'winwidget_widgets_runtime', 'widgets._prisma_migrations', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'Widgets migration history leaked to the runtime role';
  END IF;
  IF NOT has_table_privilege(
    'winwidget_widgets_backup', 'widgets._prisma_migrations', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'Widgets backup role cannot dump migration history';
  END IF;
END
$acl$;
SQL
	run_widgets_sql 'SELECT count(*) FROM widgets.service_identity;' >/dev/null
	run_widgets_backup_sql 'SELECT count(*) FROM widgets.widgets;' >/dev/null
}

widgets_import_row_count() {
	run_widgets_sql '
SELECT
  (SELECT count(*) FROM widgets.widgets) +
  (SELECT count(*) FROM widgets.quizzes) +
  (SELECT count(*) FROM widgets.callbacks) +
  (SELECT count(*) FROM widgets.countdown_timers) +
  (SELECT count(*) FROM widgets.stop_offers) +
  (SELECT count(*) FROM widgets.online_consultants) +
  (SELECT count(*) FROM widgets.calculators) +
  (SELECT count(*) FROM widgets.leads) +
  (SELECT count(*) FROM widgets.quiz_leads) +
  (SELECT count(*) FROM widgets.callback_leads) +
  (SELECT count(*) FROM widgets.countdown_timer_leads) +
  (SELECT count(*) FROM widgets.stop_offer_leads) +
  (SELECT count(*) FROM widgets.online_consultant_leads) +
  (SELECT count(*) FROM widgets.calculator_leads) +
  (SELECT count(*) FROM widgets.widget_config_revisions) +
  (SELECT count(*) FROM widgets.widget_runtime_presence) +
  (SELECT count(*) FROM widgets.widget_runtime_daily_metrics) +
  (SELECT count(*) FROM widgets.widget_runtime_daily_step_metrics) +
  (SELECT count(*) FROM widgets.owner_projections) +
  (SELECT count(*) FROM widgets.entitlement_projections) +
  (SELECT count(*) FROM widgets.usage_counters) +
  (SELECT count(*) FROM widgets.usage_ledger) +
  (SELECT count(*) FROM widgets.aggregate_versions);'
}

ensure_rabbitmq_ready() {
	local health
	rabbitmq_container_id="$(compose_target ps -q rabbitmq)"
	[[ "$rabbitmq_container_id" =~ ^[0-9a-f]{64}$ ]] ||
		fail 'The canonical RabbitMQ container is missing.'
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$rabbitmq_container_id")"
	[[ "$(docker inspect --format '{{.State.Running}}' "$rabbitmq_container_id")" == 'true' &&
		"$health" == 'healthy' ]] || fail 'RabbitMQ must be healthy before Widgets cutover.'
}

parse_rabbitmq_service_url() {
	local variable_name="$1"
	local rabbitmq_vhost
	local url_value
	rabbitmq_vhost="$(get_env_value RABBITMQ_VHOST)"
	url_value="$(get_env_value "$variable_name")"
	printf '%s' "$url_value" |
		docker run --rm -i --network none \
			-e "EXPECTED_VHOST=$rabbitmq_vhost" \
			--entrypoint node "$WIDGETS_IMAGE" -e '
const { readFileSync } = require("node:fs");
const url = new URL(readFileSync(0, "utf8"));
const username = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const vhost = decodeURIComponent(url.pathname.slice(1));
if (url.protocol !== "amqp:" || url.hostname !== "127.0.0.1" ||
    (url.port && url.port !== "5672") || url.search || url.hash ||
    !/^[A-Za-z0-9._-]+$/.test(username) || password.length < 32 ||
    password.startsWith("change_me") || /[\0\r\n]/.test(password) ||
    vhost !== process.env.EXPECTED_VHOST) throw new Error("Unsafe RabbitMQ service URL");
for (const value of [username, password]) process.stdout.write(`${Buffer.from(value).toString("base64")}\n`);
'
}

provision_rabbitmq_user() {
	local username="$1"
	local password_base64="$2"
	local configure_pattern="$3"
	local write_pattern="$4"
	local read_pattern="$5"
	local rabbitmq_vhost
	rabbitmq_vhost="$(get_env_value RABBITMQ_VHOST)"
	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_PASSWORD_BASE64="$password_base64" \
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_PROVISION_CONFIGURE="$configure_pattern" \
	RABBITMQ_PROVISION_WRITE="$write_pattern" \
	RABBITMQ_PROVISION_READ="$read_pattern" \
		docker exec \
			-e RABBITMQ_PROVISION_USER -e RABBITMQ_PROVISION_PASSWORD_BASE64 \
			-e RABBITMQ_PROVISION_VHOST -e RABBITMQ_PROVISION_CONFIGURE \
			-e RABBITMQ_PROVISION_WRITE -e RABBITMQ_PROVISION_READ \
			"$rabbitmq_container_id" sh -euc '
password="$(printf "%s" "$RABBITMQ_PROVISION_PASSWORD_BASE64" | base64 -d)"
if rabbitmqctl --silent list_users | cut -f1 | grep -Fqx -- "$RABBITMQ_PROVISION_USER"; then
  rabbitmqctl change_password "$RABBITMQ_PROVISION_USER" "$password"
else
  rabbitmqctl add_user "$RABBITMQ_PROVISION_USER" "$password"
fi
while IFS= read -r other_vhost; do
  if [ "$other_vhost" != "$RABBITMQ_PROVISION_VHOST" ]; then
    rabbitmqctl clear_permissions -p "$other_vhost" "$RABBITMQ_PROVISION_USER"
    rabbitmqctl clear_topic_permissions -p "$other_vhost" "$RABBITMQ_PROVISION_USER"
  fi
done <<EOF
$(rabbitmqctl --silent list_vhosts name)
EOF
rabbitmqctl set_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_PROVISION_USER" "$RABBITMQ_PROVISION_CONFIGURE" \
  "$RABBITMQ_PROVISION_WRITE" "$RABBITMQ_PROVISION_READ"
rabbitmqctl set_user_tags "$RABBITMQ_PROVISION_USER"
rabbitmqctl authenticate_user "$RABBITMQ_PROVISION_USER" "$password"
unset password
'
}

provision_widgets_rabbitmq_identity() {
	local credentials
	local username
	local password_base64
	local rabbitmq_vhost
	credentials="$(parse_rabbitmq_service_url RABBITMQ_WIDGETS_URL)"
	username="$(printf '%s' "$(sed -n '1p' <<<"$credentials")" | base64 --decode)"
	password_base64="$(sed -n '2p' <<<"$credentials")"
	[[ "$username" == 'winwidget-widgets' && -n "$password_base64" ]] ||
		fail 'RABBITMQ_WIDGETS_URL must use the dedicated winwidget-widgets identity.'
	provision_rabbitmq_user "$username" "$password_base64" \
		"$widgets_rabbitmq_configure_pattern" \
		"$widgets_rabbitmq_write_pattern" \
		"$widgets_rabbitmq_read_pattern"
	rabbitmq_vhost="$(get_env_value RABBITMQ_VHOST)"
	RABBITMQ_PROVISION_USER="$username" \
	RABBITMQ_PROVISION_VHOST="$rabbitmq_vhost" \
	RABBITMQ_WIDGETS_EVENTS_WRITE="$widgets_events_topic_write" \
	RABBITMQ_WIDGETS_EVENTS_READ="$widgets_events_topic_read" \
	RABBITMQ_WIDGETS_DEAD_LETTER="$widgets_dead_letter_topic" \
		docker exec \
			-e RABBITMQ_PROVISION_USER -e RABBITMQ_PROVISION_VHOST \
			-e RABBITMQ_WIDGETS_EVENTS_WRITE -e RABBITMQ_WIDGETS_EVENTS_READ \
			-e RABBITMQ_WIDGETS_DEAD_LETTER \
			"$rabbitmq_container_id" sh -euc '
rabbitmqctl clear_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" "$RABBITMQ_PROVISION_USER"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_PROVISION_USER" winwidget.events \
  "$RABBITMQ_WIDGETS_EVENTS_WRITE" "$RABBITMQ_WIDGETS_EVENTS_READ"
rabbitmqctl set_topic_permissions -p "$RABBITMQ_PROVISION_VHOST" \
  "$RABBITMQ_PROVISION_USER" winwidget.dead-letter \
  "$RABBITMQ_WIDGETS_DEAD_LETTER" "$RABBITMQ_WIDGETS_DEAD_LETTER"
'
	local permissions topic_permissions expected_topic_permissions
	permissions="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
			list_user_permissions "$username" |
			awk -v vhost="$rabbitmq_vhost" \
				'$1 == vhost { print $2 "|" $3 "|" $4; found += 1 } END { exit(found == 1 ? 0 : 1) }'
	)" || fail 'Widgets RabbitMQ resource permissions are missing or duplicated.'
	[[ "$permissions" == "$widgets_rabbitmq_configure_pattern|$widgets_rabbitmq_write_pattern|$widgets_rabbitmq_read_pattern" ]] ||
		fail 'Widgets RabbitMQ resource permissions drifted from the service topology.'
	topic_permissions="$(
		docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
			list_user_topic_permissions "$username" |
			awk 'NF == 4 { print $1 "|" $2 "|" $3 "|" $4 }' |
			LC_ALL=C sort
	)"
	expected_topic_permissions="$(
		printf '%s\n' \
			"$rabbitmq_vhost|winwidget.dead-letter|$widgets_dead_letter_topic|$widgets_dead_letter_topic" \
			"$rabbitmq_vhost|winwidget.events|$widgets_events_topic_write|$widgets_events_topic_read" |
			LC_ALL=C sort
	)"
	[[ "$topic_permissions" == "$expected_topic_permissions" ]] ||
		fail 'Widgets RabbitMQ topic permissions drifted from the reviewed routing keys.'
}

assert_widgets_rabbitmq_topology() {
	local topology_scope="${1:-all}"
	[[ "$#" -le 1 && ( "$topology_scope" == 'all' || "$topology_scope" == 'projections' ) ]] ||
		fail 'Widgets RabbitMQ topology scope is invalid.'
	compose_target run --rm --no-deps \
		-e "WIDGETS_RABBITMQ_TOPOLOGY_SCOPE=$topology_scope" \
		--entrypoint node widgets-service -e '
const { WidgetsRabbitMqService } = require("./dist/src/messaging/widgets-rabbitmq.service.js");
const config = {
  get(key) {
    if (key === "RABBITMQ_ASSERT_TOPOLOGY") return true;
    if (key === "RABBITMQ_CONNECTION_NAME") return "winwidget-widgets-cutover-topology";
    return process.env[key];
  },
};
const runtime = {
  role: "topology",
  rabbitEnabled: true,
  workerEnabled: false,
  publisherEnabled: false,
};
(async () => {
  const service = new WidgetsRabbitMqService(config, runtime);
  try {
    await service.onModuleInit();
    if (!service.isConnected() || !service.isTopologyReady()) {
      throw new Error("Widgets topology did not become ready");
    }
  } finally {
    await service.onApplicationShutdown();
  }
})().then(() => {
  process.stdout.write(`Widgets RabbitMQ ${process.env.WIDGETS_RABBITMQ_TOPOLOGY_SCOPE} topology asserted without consumers\n`);
}).catch(() => {
  process.stderr.write("Widgets RabbitMQ topology assertion failed\n");
  process.exitCode = 1;
});
'
}

verify_widgets_projection_topology() {
	local queues bindings rabbitmq_vhost
	rabbitmq_vhost="$(get_env_value RABBITMQ_VHOST)"
	queues="$(rabbitmq_queue_listing)"
	bindings="$(docker exec "$rabbitmq_container_id" rabbitmqctl --silent \
		list_bindings -p "$rabbitmq_vhost" \
		source_name destination_name routing_key)"
	widgets_rabbitmq_projection_topology_is_ready "$queues" "$bindings" ||
		fail 'Widgets identity/entitlement projection queues or bindings are missing before the snapshot boundary.'
	widgets_projection_topology_ready=true
	echo 'Widgets projection queues and bindings exist before snapshot/handoff; no Widgets consumer was started.'
}

switch_core_integration_rabbitmq_permissions() {
	local credentials
	local username
	local password_base64
	credentials="$(parse_rabbitmq_service_url RABBITMQ_INTEGRATION_WORKER_URL)"
	username="$(printf '%s' "$(sed -n '1p' <<<"$credentials")" | base64 --decode)"
	password_base64="$(sed -n '2p' <<<"$credentials")"
	[[ "$username" == 'winwidget-integration' && -n "$password_base64" ]] ||
		fail 'RABBITMQ_INTEGRATION_WORKER_URL must use winwidget-integration.'
	provision_rabbitmq_user "$username" "$password_base64" \
		'^$' '^(winwidget\.retry|winwidget\.dead-letter)$' \
		'^winwidget\.(payment\.auto-renewal|admin\.audit\.(campaigns|reporting|widgets)\.v1|notification\.(telegram-destination-unavailable|delivery-outcome))(\..*)?$'
}

rabbitmq_queue_listing() {
	docker exec "$rabbitmq_container_id" rabbitmqctl --silent list_queues \
		-p "$(get_env_value RABBITMQ_VHOST)" \
		--no-table-headers name messages_ready messages_unacknowledged consumers
}

reporting_widget_queues_are_drained() {
	local listing="$1"
	local queue
	local state
	for queue in "${reporting_drain_queues[@]}"; do
		state="$(awk -F '\t' -v queue="$queue" '$1 == queue { print $2 "|" $3; found += 1 } END { exit(found == 1 ? 0 : 1) }' <<<"$listing")" || return 1
		[[ "$state" == '0|0' ]] || return 1
	done
}

legacy_provider_queues_are_drained() {
	local listing="$1"
	local main_consumers="$2"
	local contract
	local queue
	local expected_consumers
	local state
	[[ "$main_consumers" =~ ^[01]$ ]] || return 1
	for contract in "${legacy_provider_drain_queue_contract[@]}"; do
		queue="${contract%|*}"
		expected_consumers="${contract##*|}"
		[[ "$expected_consumers" != '1' ]] || expected_consumers="$main_consumers"
		state="$(awk -F '\t' -v queue="$queue" \
			'$1 == queue { print $2 "|" $3 "|" $4; found += 1 } END { exit(found == 1 ? 0 : 1) }' \
			<<<"$listing")" || return 1
		[[ "$state" == "0|0|$expected_consumers" ]] || return 1
	done
}

replace_legacy_provider_rabbitmq_topology() {
	local listing rabbitmq_vhost queue queue_count
	local -a transition_queues=()
	widgets_cutover_provider_replacement_is_safe \
		"$forward_only" "$legacy_integration_worker_stopped" \
		"$legacy_core_topology_owner_stopped" ||
		fail 'Provider topology replacement is forbidden before forward-only handoff and both legacy RabbitMQ processes stop.'
	listing="$(rabbitmq_queue_listing)"
	widgets_rabbitmq_provider_transition_is_drained "$listing" ||
		fail 'Provider topology replacement requires the exact empty and unused legacy/Widgets transition namespace.'
	mapfile -t transition_queues < <({
		widgets_canonical_provider_target_queue_names
		widgets_canonical_provider_legacy_queue_names
	} | LC_ALL=C sort -u)
	[[ "${#transition_queues[@]}" == '24' ]] ||
		fail 'Provider transition queue manifest is incomplete.'
	rabbitmq_vhost="$(get_env_value RABBITMQ_VHOST)"
	for queue in "${transition_queues[@]}"; do
		queue_count="$(awk -F '\t' -v queue="$queue" \
			'$1 == queue { count += 1 } END { print count + 0 }' <<<"$listing")"
		[[ "$queue_count" == '0' || "$queue_count" == '1' ]] ||
			fail "Provider transition queue identity is ambiguous: $queue"
		if [[ "$queue_count" == '1' ]]; then
			docker exec "$rabbitmq_container_id" rabbitmqctl --silent delete_queue \
				-p "$rabbitmq_vhost" "$queue" --if-empty --if-unused >/dev/null
		fi
	done
	assert_widgets_rabbitmq_topology
	listing="$(rabbitmq_queue_listing)"
	widgets_rabbitmq_provider_namespace_is_exact "$listing" ||
		fail 'Widgets provider namespace is not exact after replacing legacy RabbitMQ topology.'
	echo 'Legacy provider main/DLQ/retry/retry-v2 topology was replaced by the exact Widgets-owned namespace.'
}

wait_for_core_topology_owner_restart() {
	local attempt container_id
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(compose_target ps --status running -q outbox-publisher 2>/dev/null || true)"
		if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] &&
			verify_running_service_revision outbox-publisher "$deploy_revision" &&
			docker logs "$container_id" 2>&1 |
			awk 'index($0, "Outbox publisher started") { found = 1 } END { exit(found ? 0 : 1) }'; then
			core_topology_owner_restarted=true
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	return 1
}

wait_for_post_publisher_provider_namespace() {
	local attempt listing
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		listing="$(rabbitmq_queue_listing)"
		if widgets_cutover_post_publisher_namespace_is_safe \
			"$forward_only" "$core_topology_owner_restarted" "$listing"; then
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	return 1
}

pending_widgets_outbox_count() {
	run_core_sql "
SELECT count(*)
FROM outbox_events
WHERE event_type IN (
    'widgets.widget.changed.v1',
    'widgets.lead.changed.v1',
    'lead.integration.requested.v2',
    'lead.limit.reached.email.v2',
    'lead.limit.reached.telegram.v2'
  )
  AND status <> 'PUBLISHED'::\"OutboxEventStatus\";"
}

assert_source_services_running() {
	local service
	local container_id
	for service in "${required_source_services[@]}"; do
		container_id="$(compose_target ps --status running -q "$service")"
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
			fail "Required pre-cutover service is not running: $service"
	done
}

provider_queues_are_ready_for_source_freeze() {
	local listing="$1"
	if [[ "$forward_only" == 'true' ]]; then
		widgets_rabbitmq_provider_transition_is_drained "$listing"
	else
		legacy_provider_queues_are_drained "$listing" 1
	fi
}

wait_for_widgets_source_drain() {
	local attempt
	local pending
	local listing
	for ((attempt = 1; attempt <= DRAIN_ATTEMPTS; attempt++)); do
		pending="$(pending_widgets_outbox_count)"
		listing="$(rabbitmq_queue_listing)"
		if [[ "$pending" == '0' ]] &&
			reporting_widget_queues_are_drained "$listing" &&
			provider_queues_are_ready_for_source_freeze "$listing"; then
			return 0
		fi
		sleep "$DRAIN_INTERVAL"
	done
	return 1
}

wait_for_legacy_provider_consumers() {
	local attempt
	local listing
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		listing="$(rabbitmq_queue_listing)"
		legacy_provider_queues_are_drained "$listing" 1 && return 0
		sleep "$HEALTHCHECK_INTERVAL"
	done
	return 1
}

install_core_widgets_write_fence() {
	run_core_sql "$(widgets_core_write_fence_install_sql)" >/dev/null
	source_frozen=true
}

stop_services_gracefully() {
	local -a services=("$@")
	local -a container_ids=()
	local service container_id running exit_code oom_killed
	for service in "${services[@]}"; do
		container_id="$(compose_target ps --status running -q "$service" 2>/dev/null || true)"
		if [[ -n "$container_id" ]]; then
			[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
				fail "Running service has an invalid container identity: $service"
			container_ids+=("$container_id")
		fi
	done
	compose_target stop -t 90 "${services[@]}"
	for container_id in "${container_ids[@]}"; do
		read -r running exit_code oom_killed < <(
			docker inspect --format '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}' "$container_id"
		)
		[[ "$running" == 'false' && "$oom_killed" == 'false' &&
			( "$exit_code" == '0' || "$exit_code" == '143' ) ]] ||
			fail "A source service did not stop through the graceful SIGTERM window: $container_id"
	done
}

freeze_and_drain_source() {
	local listing
	if [[ ( "$initial_ownership_state" == 'absent' ||
		"$initial_ownership_state" == 'inactive' ) &&
		! -e "$snapshot_file" && ! -L "$snapshot_file" ]]; then
		assert_source_services_running
	fi
	install_core_widgets_write_fence
	wait_for_widgets_source_drain ||
		fail 'Core Widgets Outbox, Reporting or provider queues did not drain cleanly.'
	stop_services_gracefully "${WIDGETS_CANONICAL_SOURCE_FREEZE_SERVICES[@]}"
	legacy_integration_worker_stopped=true
	listing="$(rabbitmq_queue_listing)"
	if [[ "$forward_only" != 'true' ]]; then
		legacy_provider_queues_are_drained "$listing" 0 ||
			fail 'Legacy provider queues changed while their Core consumer stopped.'
	fi
	widgets_rabbitmq_provider_transition_is_drained "$listing" ||
		fail 'Historical provider queues are not empty, unused and safe for replacement.'
	[[ "$(pending_widgets_outbox_count)" == '0' ]] ||
		fail 'A Widgets-owned Core Outbox event appeared after the write fence.'
	listing="$(rabbitmq_queue_listing)"
	reporting_widget_queues_are_drained "$listing" ||
		fail 'Reporting widget/lead queues changed after the source drain.'
}

assert_core_widget_handoff_sources() {
	local sql
	sql="$(cat <<'SQL'
DO $guard$
DECLARE
  missing_count INTEGER;
BEGIN
  SELECT count(*) INTO missing_count
  FROM (VALUES
    ('widgets', 'reporting_widget_projection'),
    ('quizzes', 'reporting_quiz_projection'),
    ('callbacks', 'reporting_callback_projection'),
    ('countdown_timers', 'reporting_countdown_timer_projection'),
    ('stop_offers', 'reporting_stop_offer_projection'),
    ('online_consultants', 'reporting_online_consultant_projection'),
    ('calculators', 'reporting_calculator_projection'),
    ('leads', 'reporting_wheel_lead_projection'),
    ('quiz_leads', 'reporting_quiz_lead_projection'),
    ('callback_leads', 'reporting_callback_lead_projection'),
    ('countdown_timer_leads', 'reporting_countdown_timer_lead_projection'),
    ('stop_offer_leads', 'reporting_stop_offer_lead_projection'),
    ('online_consultant_leads', 'reporting_online_consultant_lead_projection'),
    ('calculator_leads', 'reporting_calculator_lead_projection')
  ) expected(table_name, trigger_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = expected.table_name
      AND trigger.tgname = expected.trigger_name
      AND NOT trigger.tgisinternal
  );
  IF missing_count <> 0 OR
     to_regprocedure('public.reporting_widget_projection_trigger()') IS NULL OR
     to_regprocedure('public.reporting_lead_projection_trigger()') IS NULL THEN
    RAISE EXCEPTION 'Core Widgets Reporting handoff sources are incomplete';
  END IF;
END
$guard$;
SQL
)"
	run_core_sql "$sql" >/dev/null
}

ensure_snapshot_artifact_directory() {
	if [[ -e "$artifact_root" || -L "$artifact_root" ]]; then
		[[ -d "$artifact_root" && ! -L "$artifact_root" &&
			"$(stat -c '%u:%g:%a' "$artifact_root")" == '0:0:700' ]] ||
			fail 'Widgets cutover artifact directory is unsafe.'
	else
		install -d -o root -g root -m 700 "$artifact_root"
	fi
}

backup_evidence_sha() {
	local dump_path="$1"
	local sha_path="$2"
	local expected_schema="$3"
	local expected_system_identifier="$4"
	local expected_revision="${5:-$deploy_revision}"
	local revision_line schema_line system_identifier_line sha_line expected_sha actual_sha
	[[ -f "$dump_path" && ! -L "$dump_path" && -s "$dump_path" &&
		-f "$sha_path" && ! -L "$sha_path" && -s "$sha_path" &&
		"$(stat -c '%u:%g:%a' "$dump_path")" == '0:0:600' &&
		"$(stat -c '%u:%g:%a' "$sha_path")" == '0:0:600' &&
		"$(wc -l <"$sha_path" | tr -d '[:space:]')" == '4' ]] ||
		return 1
	revision_line="$(sed -n '1p' "$sha_path")"
	schema_line="$(sed -n '2p' "$sha_path")"
	system_identifier_line="$(sed -n '3p' "$sha_path")"
	sha_line="$(sed -n '4p' "$sha_path")"
	if [[ "$expected_revision" == 'any' ]]; then
		[[ "$revision_line" =~ ^revision=[0-9a-f]{40}$ ]] || return 1
	else
		[[ "$revision_line" == "revision=$expected_revision" ]] || return 1
	fi
	[[ "$schema_line" == "schema=$expected_schema" &&
		"$system_identifier_line" == "system_identifier=$expected_system_identifier" &&
		"$sha_line" =~ ^sha256=([0-9a-f]{64})$ ]] || return 1
	expected_sha="${BASH_REMATCH[1]}"
	actual_sha="$(sha256sum "$dump_path" | awk '{ print $1 }')"
	[[ "$actual_sha" == "$expected_sha" ]] || return 1
	printf '%s' "$actual_sha"
}

validate_custom_dump() {
	local dump_path="$1"
	docker run --rm --user 0:0 --network none \
		--mount "type=bind,source=$dump_path,target=/work/database.dump,readonly" \
		--entrypoint pg_restore "$MAINTENANCE_IMAGE" \
		--list /work/database.dump >/dev/null
}

create_cutover_backup() {
	local env_key="$1"
	local dump_path="$2"
	local sha_path="$3"
	local schema="$4"
	local system_identifier="$5"
	local expected_revision="${6:-$deploy_revision}"
	local dump_name dump_partial sha_partial dump_sha
	dump_name="$(basename "$dump_path")"
	dump_partial="$dump_path.partial"
	sha_partial="$sha_path.partial"
	[[ "$dump_name" =~ ^[a-z0-9.-]+\.dump$ &&
		"$schema" =~ ^[a-z][a-z0-9_]*$ && "$system_identifier" =~ ^[0-9]+$ ]] ||
		fail 'Cutover backup target is invalid.'
	if [[ -e "$dump_path" || -L "$dump_path" || -e "$sha_path" || -L "$sha_path" ]]; then
		dump_sha="$(backup_evidence_sha "$dump_path" "$sha_path" \
			"$schema" "$system_identifier" "$expected_revision")" ||
			fail "Existing cutover backup evidence is incomplete: $dump_name"
		validate_custom_dump "$dump_path" ||
			fail "Existing cutover backup is unreadable: $dump_name"
		printf '%s' "$dump_sha"
		return
	fi
	[[ ! -e "$dump_partial" && ! -L "$dump_partial" &&
		! -e "$sha_partial" && ! -L "$sha_partial" ]] ||
		fail "Stale partial cutover backup exists: $dump_name"
	WIDGETS_CUTOVER_BACKUP_URL="$(get_env_value "$env_key")"
	export WIDGETS_CUTOVER_BACKUP_URL
	WIDGETS_CUTOVER_BACKUP_SCHEMA="$schema" \
	WIDGETS_CUTOVER_BACKUP_FILE="$dump_name.partial" \
		docker run --rm --user 0:0 --network host \
			-e WIDGETS_CUTOVER_BACKUP_URL \
			-e WIDGETS_CUTOVER_BACKUP_SCHEMA \
			-e WIDGETS_CUTOVER_BACKUP_FILE \
			--mount "type=bind,source=$artifact_root,target=/work" \
			--entrypoint node "$MAINTENANCE_IMAGE" -e '
const { spawnSync } = require("node:child_process");
const raw = process.env.WIDGETS_CUTOVER_BACKUP_URL;
const schema = process.env.WIDGETS_CUTOVER_BACKUP_SCHEMA;
const file = process.env.WIDGETS_CUTOVER_BACKUP_FILE;
if (!raw || !/^[a-z][a-z0-9_]*$/.test(schema || "") ||
    !/^[a-z0-9.-]+\.dump\.partial$/.test(file || "")) {
  throw new Error("Cutover backup input is invalid");
}
const url = new URL(raw);
if (!["postgres:", "postgresql:"].includes(url.protocol)) {
  throw new Error("Cutover backup URL is invalid");
}
const password = url.password ? decodeURIComponent(url.password) : url.searchParams.get("password") || "";
url.password = "";
for (const key of ["password", "schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size"]) {
  url.searchParams.delete(key);
}
const environment = { ...process.env, PGPASSWORD: password };
delete environment.WIDGETS_CUTOVER_BACKUP_URL;
const result = spawnSync("pg_dump", [
  "--format=custom", "--no-owner", "--no-privileges", "--no-password",
  "--schema", schema, "--file", `/work/${file}`, url.toString()
], { env: environment, stdio: ["ignore", "ignore", "inherit"] });
if (result.status !== 0) throw new Error("Cutover pg_dump failed");
'
	unset WIDGETS_CUTOVER_BACKUP_URL
	[[ -f "$dump_partial" && ! -L "$dump_partial" && -s "$dump_partial" ]] ||
		fail "Cutover backup was not created: $dump_name"
	chmod 600 "$dump_partial"
	chown 0:0 "$dump_partial"
	validate_custom_dump "$dump_partial" || fail "Cutover backup list validation failed: $dump_name"
	dump_sha="$(sha256sum "$dump_partial" | awk '{ print $1 }')"
	[[ "$dump_sha" =~ ^[0-9a-f]{64}$ ]] || fail 'Cutover backup SHA-256 is invalid.'
	printf 'revision=%s\nschema=%s\nsystem_identifier=%s\nsha256=%s\n' \
		"$deploy_revision" "$schema" "$system_identifier" "$dump_sha" >"$sha_partial"
	chmod 600 "$sha_partial"
	chown 0:0 "$sha_partial"
	mv -fT "$dump_partial" "$dump_path"
	mv -fT "$sha_partial" "$sha_path"
	backup_evidence_sha "$dump_path" "$sha_path" \
		"$schema" "$system_identifier" "$expected_revision" >/dev/null ||
		fail "Persisted cutover backup evidence failed validation: $dump_name"
	printf '%s' "$dump_sha"
}

create_core_pre_cutover_backup() {
	create_cutover_backup DATABASE_BACKUP_URL \
		"$core_backup_file" "$core_backup_sha_file" public \
		"$CORE_POSTGRES_SYSTEM_IDENTIFIER" any >/dev/null
	echo 'A SHA-verified Core pre-cutover backup is retained in the private cutover artifact directory.'
}

create_and_restore_widgets_post_cutover_backup() {
	local dump_sha source_identifier
	source_identifier="$(docker exec "$widgets_postgres_container_id" \
		psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
			--username winwidget_widgets_admin --dbname winwidget_widgets \
			--command 'SELECT system_identifier FROM pg_control_system();')"
	[[ "$source_identifier" =~ ^[0-9]+$ ]] ||
		fail 'Widgets source PostgreSQL system identifier is invalid.'
	dump_sha="$(create_cutover_backup WIDGETS_BACKUP_URL \
		"$widgets_backup_file" "$widgets_backup_sha_file" widgets \
		"$source_identifier")"
	WIDGETS_REHEARSAL_RUN_ID="prod-${deploy_revision:0:12}" \
	WIDGETS_REHEARSAL_DUMP_FILE="$widgets_backup_file" \
	WIDGETS_REHEARSAL_EXPECTED_SHA256="$dump_sha" \
	WIDGETS_REHEARSAL_SOURCE_SYSTEM_IDENTIFIER="$source_identifier" \
		bash "$server_root/scripts/test-widgets-cutover-rehearsal.sh" --verify-dump
}

current_source_database_fingerprint() {
	printf '%s' "$CORE_POSTGRES_SYSTEM_IDENTIFIER:$CORE_POSTGRES_DATABASE" |
		sha256sum | awk '{ print $1 }'
}

snapshot_identity() {
	SNAPSHOT_FILE="$snapshot_file" docker run --rm --user 0:0 --network none \
		-e SNAPSHOT_FILE \
		--mount "type=bind,source=$snapshot_file,target=/work/snapshot.jsonl,readonly" \
		--entrypoint node "$WIDGETS_IMAGE" -e '
const { openSync, readSync, closeSync } = require("node:fs");
const fd = openSync("/work/snapshot.jsonl", "r");
const chunks = [];
let bytes = 0;
try {
  const buffer = Buffer.alloc(4096);
  for (;;) {
    const read = readSync(fd, buffer, 0, buffer.length, null);
    if (!read) throw new Error("Snapshot manifest is missing");
    const newline = buffer.subarray(0, read).indexOf(10);
    if (newline >= 0) {
      chunks.push(buffer.subarray(0, newline));
      bytes += newline;
      break;
    }
    chunks.push(buffer.subarray(0, read));
    bytes += read;
    if (bytes > 262144) throw new Error("Snapshot manifest exceeds the line limit");
  }
} finally { closeSync(fd); }
const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (manifest.recordType !== "manifest" || manifest.schemaVersion !== 1 ||
    !/^[0-9a-f]{64}$/.test(manifest.sourceDatabaseFingerprint) ||
    new Date(manifest.sourceExportedAt).toISOString() !== manifest.sourceExportedAt) {
  throw new Error("Snapshot manifest identity is invalid");
}
process.stdout.write(`${manifest.sourceDatabaseFingerprint}\n${manifest.sourceExportedAt}\n`);
'
}

validate_snapshot_artifact() {
	local identity
	local fingerprint
	[[ -f "$snapshot_file" && ! -L "$snapshot_file" && -s "$snapshot_file" &&
		"$(stat -c '%u:%g:%a' "$snapshot_file")" == '0:0:600' ]] ||
		fail 'Widgets cutover snapshot artifact is missing or unsafe.'
	[[ "$(stat -c '%s' "$snapshot_file")" -le 2147483648 ]] ||
		fail 'Widgets cutover snapshot exceeds the 2 GiB transport limit.'
	identity="$(snapshot_identity)"
	fingerprint="$(sed -n '1p' <<<"$identity")"
	[[ "$fingerprint" == "$(current_source_database_fingerprint)" ]] ||
		fail 'Persisted Widgets snapshot belongs to a different Core database.'
}

export_or_reuse_snapshot() {
	local import_rows
	local source_exported_at
	local source_fingerprint
	widgets_cutover_projection_boundary_is_safe "$widgets_projection_topology_ready" ||
		fail 'Widgets snapshot is forbidden before projection RabbitMQ topology is verified.'
	ensure_snapshot_artifact_directory
	if [[ -e "$snapshot_file" || -L "$snapshot_file" ]]; then
		snapshot_locked=true
		validate_snapshot_artifact
		revalidate_snapshot_against_frozen_source
		echo 'Reusing the exact private Widgets cutover snapshot for deterministic import recovery.'
		return
	fi
	if [[ -e "$snapshot_partial" || -L "$snapshot_partial" ]]; then
		[[ -f "$snapshot_partial" && ! -L "$snapshot_partial" &&
			"$(stat -c '%u:%g:%a' "$snapshot_partial")" == '0:0:600' ]] ||
			fail 'A partial Widgets snapshot is unsafe.'
		rm -f -- "$snapshot_partial"
	fi
	import_rows="$(widgets_import_row_count)"
	[[ "$import_rows" == '0' ]] ||
		fail 'Widgets target contains imported rows but the exact source snapshot is missing.'
	source_exported_at="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
	source_fingerprint="$(current_source_database_fingerprint)"
	DATABASE_URL_PRODUCTION="$(get_env_value DATABASE_URL_PRODUCTION)"
	export DATABASE_URL_PRODUCTION
	export WIDGETS_SOURCE_DATABASE_FINGERPRINT="$source_fingerprint"
	export WIDGETS_SOURCE_EXPORTED_AT="$source_exported_at"
	umask 077
	docker run --rm --network host \
		-e DATABASE_URL_PRODUCTION \
		-e WIDGETS_SOURCE_DATABASE_FINGERPRINT \
		-e WIDGETS_SOURCE_EXPORTED_AT \
		--mount "type=bind,source=$server_root/scripts/export-widgets-cutover-snapshot.mjs,target=/app/scripts/export-widgets-cutover-snapshot.mjs,readonly" \
		--entrypoint node "winwidget-api:$APP_VERSION" \
		/app/scripts/export-widgets-cutover-snapshot.mjs >"$snapshot_partial"
	[[ -s "$snapshot_partial" ]] || fail 'Widgets snapshot exporter produced no records.'
	chown 0:0 "$snapshot_partial"
	chmod 600 "$snapshot_partial"
	mv -f "$snapshot_partial" "$snapshot_file"
	snapshot_locked=true
	validate_snapshot_artifact
	echo 'Exact Widgets cutover snapshot exported under the source write freeze.'
}

revalidate_snapshot_against_frozen_source() {
	local comparison_file="$artifact_root/widgets-cutover-snapshot-comparison.jsonl"
	local identity
	local expected_fingerprint
	local expected_exported_at
	identity="$(snapshot_identity)"
	expected_fingerprint="$(sed -n '1p' <<<"$identity")"
	expected_exported_at="$(sed -n '2p' <<<"$identity")"
	[[ ! -e "$comparison_file" && ! -L "$comparison_file" ]] ||
		rm -f "$comparison_file"
	DATABASE_URL_PRODUCTION="$(get_env_value DATABASE_URL_PRODUCTION)"
	export DATABASE_URL_PRODUCTION
	export WIDGETS_SOURCE_DATABASE_FINGERPRINT="$expected_fingerprint"
	export WIDGETS_SOURCE_EXPORTED_AT="$expected_exported_at"
	umask 077
	docker run --rm --network host \
		-e DATABASE_URL_PRODUCTION \
		-e WIDGETS_SOURCE_DATABASE_FINGERPRINT \
		-e WIDGETS_SOURCE_EXPORTED_AT \
		--mount "type=bind,source=$server_root/scripts/export-widgets-cutover-snapshot.mjs,target=/app/scripts/export-widgets-cutover-snapshot.mjs,readonly" \
		--entrypoint node "winwidget-api:$APP_VERSION" \
		/app/scripts/export-widgets-cutover-snapshot.mjs >"$comparison_file"
	chmod 600 "$comparison_file"
	chown 0:0 "$comparison_file"
	cmp -s "$snapshot_file" "$comparison_file" ||
		fail 'Core state changed after the persisted Widgets snapshot; deterministic resume is unsafe.'
	rm -f "$comparison_file"
}

validate_cli_result() {
	local result_file="$1"
	local expected_command="$2"
	[[ -f "$result_file" && ! -L "$result_file" && -s "$result_file" &&
		"$(stat -c '%u:%g:%a' "$result_file")" == '0:0:600' ]] ||
		fail "Widgets CLI result is missing or unsafe: $expected_command"
	RESULT_FILE="$result_file" EXPECTED_COMMAND="$expected_command" \
		docker run --rm --user 0:0 --network none \
			-e RESULT_FILE -e EXPECTED_COMMAND \
			--mount "type=bind,source=$result_file,target=/work/result.json,readonly" \
			--entrypoint node "$WIDGETS_IMAGE" -e '
const { readFileSync } = require("node:fs");
const raw = readFileSync("/work/result.json", "utf8");
const lines = raw.split(/\r?\n/).filter(Boolean);
if (lines.length !== 1) throw new Error("Widgets CLI must emit exactly one JSON line");
const result = JSON.parse(lines[0]);
const allowedStatuses = {
  "import-snapshot": ["imported", "already-imported"],
  "begin-handoff": ["started", "already-started", "already-activated"],
  "activate-ownership": ["activated", "already-activated"],
  "verify-steady": ["steady"],
};
const allowed = allowedStatuses[process.env.EXPECTED_COMMAND];
if (!allowed || result.command !== process.env.EXPECTED_COMMAND ||
    result.schemaVersion !== 1 || !allowed.includes(result.status)) {
  throw new Error("Widgets CLI terminal result is invalid");
}
const forbidden = /password|secret|token|databaseurl|rabbitmqurl/i;
const visit = value => {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.test(key)) throw new Error("Widgets CLI result contains a forbidden field");
    visit(child);
  }
};
visit(result);
process.stdout.write(`Widgets CLI ${process.env.EXPECTED_COMMAND} result verified\n`);
'
}

run_import_snapshot() {
	WIDGETS_DATABASE_URL="$(get_env_value WIDGETS_DATABASE_URL)"
	export WIDGETS_DATABASE_URL
	rm -f "$import_result_file"
	umask 077
	docker run --rm -i --network host -e WIDGETS_DATABASE_URL \
		--entrypoint node "$WIDGETS_IMAGE" \
		dist/src/cutover-main.js import-snapshot \
		<"$snapshot_file" >"$import_result_file"
	chown 0:0 "$import_result_file"
	chmod 600 "$import_result_file"
	validate_cli_result "$import_result_file" import-snapshot
	[[ "$(widgets_service_identity_state)" == 'inactive' ]] ||
		fail 'Snapshot import must not activate Widgets ownership.'
}

begin_widgets_handoff() {
	local command_exit
	local ownership_state
	WIDGETS_DATABASE_URL="$(get_env_value WIDGETS_DATABASE_URL)"
	export WIDGETS_DATABASE_URL
	rm -f "$handoff_result_file"
	umask 077
	set +e
	docker run --rm --network host -e WIDGETS_DATABASE_URL \
		--entrypoint node "$WIDGETS_IMAGE" \
		dist/src/cutover-main.js begin-handoff \
		</dev/null >"$handoff_result_file"
	command_exit=$?
	ownership_state="$(widgets_service_identity_state 2>/dev/null || true)"
	if [[ "$ownership_state" == 'handoff' || "$ownership_state" == 'active' ]]; then
		forward_only=true
	fi
	set -e
	((command_exit == 0)) || fail 'Widgets durable handoff command failed.'
	[[ "$forward_only" == 'true' ]] ||
		fail 'Widgets durable handoff marker did not cross the forward-only boundary.'
	chown 0:0 "$handoff_result_file"
	chmod 600 "$handoff_result_file"
	validate_cli_result "$handoff_result_file" begin-handoff
}

activate_widgets_ownership() {
	local command_exit
	local ownership_state
	WIDGETS_DATABASE_URL="$(get_env_value WIDGETS_DATABASE_URL)"
	export WIDGETS_DATABASE_URL
	rm -f "$activation_result_file"
	umask 077
	set +e
	docker run --rm --network host -e WIDGETS_DATABASE_URL \
		--entrypoint node "$WIDGETS_IMAGE" \
		dist/src/cutover-main.js activate-ownership \
		</dev/null >"$activation_result_file"
	command_exit=$?
	ownership_state="$(widgets_service_identity_state 2>/dev/null || true)"
	if [[ "$ownership_state" == 'active' ]]; then
		forward_only=true
	fi
	set -e
	((command_exit == 0)) || fail 'Widgets ownership activation command failed.'
	[[ "$forward_only" == 'true' ]] ||
		fail 'Widgets ownership marker did not cross the forward-only boundary.'
	chown 0:0 "$activation_result_file"
	chmod 600 "$activation_result_file"
	validate_cli_result "$activation_result_file" activate-ownership
}

apply_core_widgets_handoff() {
	local sql
	sql="$(cat <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('winwidget.widgets.owner.handoff.v1'));
SELECT pg_advisory_xact_lock(hashtext('winwidget.widgets.write-fence.v1'));
SQL
)"
	sql+=$'\n'
	sql+="$(widgets_core_write_fence_drop_statements)"
	sql+=$'\n'
	sql+="$(cat <<'SQL'

DROP TRIGGER IF EXISTS reporting_widget_projection ON public.widgets;
DROP TRIGGER IF EXISTS reporting_quiz_projection ON public.quizzes;
DROP TRIGGER IF EXISTS reporting_callback_projection ON public.callbacks;
DROP TRIGGER IF EXISTS reporting_countdown_timer_projection ON public.countdown_timers;
DROP TRIGGER IF EXISTS reporting_stop_offer_projection ON public.stop_offers;
DROP TRIGGER IF EXISTS reporting_online_consultant_projection ON public.online_consultants;
DROP TRIGGER IF EXISTS reporting_calculator_projection ON public.calculators;
DROP TRIGGER IF EXISTS reporting_wheel_lead_projection ON public.leads;
DROP TRIGGER IF EXISTS reporting_quiz_lead_projection ON public.quiz_leads;
DROP TRIGGER IF EXISTS reporting_callback_lead_projection ON public.callback_leads;
DROP TRIGGER IF EXISTS reporting_countdown_timer_lead_projection ON public.countdown_timer_leads;
DROP TRIGGER IF EXISTS reporting_stop_offer_lead_projection ON public.stop_offer_leads;
DROP TRIGGER IF EXISTS reporting_online_consultant_lead_projection ON public.online_consultant_leads;
DROP TRIGGER IF EXISTS reporting_calculator_lead_projection ON public.calculator_leads;
DROP FUNCTION IF EXISTS public.reporting_widget_projection_trigger();
DROP FUNCTION IF EXISTS public.reporting_lead_projection_trigger();

REVOKE ALL PRIVILEGES ON TABLE
  public.widgets,
  public.quizzes,
  public.callbacks,
  public.countdown_timers,
  public.stop_offers,
  public.online_consultants,
  public.calculators,
  public.leads,
  public.quiz_leads,
  public.callback_leads,
  public.countdown_timer_leads,
  public.stop_offer_leads,
  public.online_consultant_leads,
  public.calculator_leads,
  public.widget_config_revisions,
  public.widget_runtime_presence,
  public.widget_runtime_daily_metrics,
  public.widget_runtime_daily_step_metrics
FROM PUBLIC, winwidget_api_runtime, winwidget_maintenance;

DO $verify$
DECLARE
  relation_name TEXT;
  role_name TEXT;
BEGIN
  IF to_regprocedure('public.reporting_widget_projection_trigger()') IS NOT NULL OR
     to_regprocedure('public.reporting_lead_projection_trigger()') IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy Widgets Reporting functions remain';
  END IF;
  FOR relation_name IN SELECT unnest(ARRAY[
    'widgets','quizzes','callbacks','countdown_timers','stop_offers',
    'online_consultants','calculators','leads','quiz_leads','callback_leads',
    'countdown_timer_leads','stop_offer_leads','online_consultant_leads',
    'calculator_leads','widget_config_revisions','widget_runtime_presence',
    'widget_runtime_daily_metrics','widget_runtime_daily_step_metrics'
  ]) LOOP
    FOR role_name IN SELECT unnest(ARRAY['winwidget_api_runtime','winwidget_maintenance']) LOOP
      IF has_table_privilege(role_name, format('public.%I', relation_name), 'SELECT') OR
         has_table_privilege(role_name, format('public.%I', relation_name), 'INSERT') OR
         has_table_privilege(role_name, format('public.%I', relation_name), 'UPDATE') OR
         has_table_privilege(role_name, format('public.%I', relation_name), 'DELETE') OR
         has_table_privilege(role_name, format('public.%I', relation_name), 'TRUNCATE') OR
         has_table_privilege(role_name, format('public.%I', relation_name), 'REFERENCES') OR
         has_table_privilege(role_name, format('public.%I', relation_name), 'TRIGGER') THEN
        RAISE EXCEPTION 'Core role % retains a Widgets table privilege on %', role_name, relation_name;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_trigger trigger
    WHERE trigger.tgname IN (
      'reporting_widget_projection','reporting_quiz_projection',
      'reporting_callback_projection','reporting_countdown_timer_projection',
      'reporting_stop_offer_projection','reporting_online_consultant_projection',
      'reporting_calculator_projection','reporting_wheel_lead_projection',
      'reporting_quiz_lead_projection','reporting_callback_lead_projection',
      'reporting_countdown_timer_lead_projection','reporting_stop_offer_lead_projection',
      'reporting_online_consultant_lead_projection','reporting_calculator_lead_projection'
    ) AND NOT trigger.tgisinternal
  ) THEN
    RAISE EXCEPTION 'A legacy Widgets Reporting trigger remains';
  END IF;
END
$verify$;
COMMIT;
SQL
)"
	run_core_sql "$sql" >/dev/null
}

wait_for_url_revision() {
	local url="$1"
	local revision="$2"
	local attempt
	local response
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		response="$(curl -fsS --connect-timeout 2 --max-time 5 "$url" 2>/dev/null || true)"
		if [[ "$response" == *"\"revision\":\"$revision\""* ||
			"$response" == *"\"revision\": \"$revision\""* ]]; then
			return 0
		fi
		sleep "$HEALTHCHECK_INTERVAL"
	done
	return 1
}

verify_running_service_revision() {
	local service="$1"
	local revision="$2"
	local container_id
	local image_id
	local image_revision
	local restart_count
	container_id="$(compose_target ps --status running -q "$service")"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	[[ "$image_revision" == "$revision" && "$restart_count" == '0' ]]
}

run_verify_steady() {
	WIDGETS_DATABASE_URL="$(get_env_value WIDGETS_DATABASE_URL)"
	export WIDGETS_DATABASE_URL
	rm -f "$verify_result_file"
	umask 077
	docker run --rm --network host -e WIDGETS_DATABASE_URL \
		--entrypoint node "$WIDGETS_IMAGE" \
		dist/src/cutover-main.js verify-steady \
		</dev/null >"$verify_result_file"
	chown 0:0 "$verify_result_file"
	chmod 600 "$verify_result_file"
	validate_cli_result "$verify_result_file" verify-steady
	[[ "$(widgets_service_identity_state)" == 'active' ]] ||
		fail 'Widgets steady verification lost the ownership marker.'
}

verify_core_worker_ownership() {
	local container_id
	local worker_kinds
	container_id="$(compose_target ps --status running -q integration-worker)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		fail 'Core integration-worker is not running.'
	worker_kinds="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^INTEGRATION_WORKER_KINDS=//p')"
	[[ "$worker_kinds" == "$canonical_worker_kinds" ]] ||
		fail 'Core integration-worker restarted with non-steady consumer kinds.'
}

verify_rabbitmq_consumer_ownership() {
	local attempt
	local listing
	local queue
	local state
	local ready=false
	for ((attempt = 1; attempt <= HEALTHCHECK_ATTEMPTS; attempt++)); do
		listing="$(rabbitmq_queue_listing)"
		ready=true
		for queue in \
			winwidget.widgets.identity-user \
			winwidget.widgets.billing-subscription \
			"${provider_queues[@]}"; do
			state="$(awk -F '\t' -v queue="$queue" '$1 == queue { print $4; found += 1 } END { exit(found == 1 ? 0 : 1) }' <<<"$listing")" || {
				ready=false
				break
			}
			if [[ "$state" != '1' ]]; then
				ready=false
				break
			fi
		done
		[[ "$ready" == 'true' ]] && break
		sleep "$HEALTHCHECK_INTERVAL"
	done
	[[ "$ready" == 'true' ]] ||
		fail 'Widgets did not become the sole consumer of its projection/provider queues.'
}

install_and_reload_backend_nginx() {
	local source_config="$server_root/deploy/nginx.conf"
	local target_config='/etc/nginx/sites-available/api.winwidget.ru'
	local enabled_config='/etc/nginx/sites-enabled/api.winwidget.ru'
	local staged_config='/etc/nginx/sites-available/.api.winwidget.ru.widgets-cutover'
	local backup_config='/etc/nginx/sites-available/.api.winwidget.ru.pre-widgets-cutover'
	local enabled_target
	[[ -f "$source_config" && ! -L "$source_config" &&
		-f "$target_config" && ! -L "$target_config" &&
		-L "$enabled_config" ]] ||
		fail 'Backend Nginx source/live configuration boundary is unsafe.'
	enabled_target="$(readlink -f "$enabled_config")"
	[[ "$enabled_target" == "$target_config" ]] ||
		fail 'Backend Nginx enabled site does not resolve to the canonical target.'
	[[ ! -e "$staged_config" && ! -L "$staged_config" &&
		! -e "$backup_config" && ! -L "$backup_config" ]] ||
		fail 'A stale Widgets Nginx staging artifact exists.'
	install -o root -g root -m 600 "$target_config" "$backup_config"
	install -o root -g root -m 644 "$source_config" "$staged_config"
	mv -fT "$staged_config" "$target_config"
	if ! nginx -t; then
		install -o root -g root -m 644 "$backup_config" "$staged_config"
		mv -fT "$staged_config" "$target_config"
		nginx -t || fail 'Backend Nginx rollback validation failed.'
		rm -f -- "$backup_config"
		fail 'Widgets backend Nginx candidate validation failed; live file was restored without reload.'
	fi
	[[ "$(sha256sum "$source_config" | awk '{ print $1 }')" == \
		"$(sha256sum "$target_config" | awk '{ print $1 }')" ]] ||
		fail 'Installed backend Nginx configuration differs from the release file.'
	if ! systemctl reload nginx; then
		install -o root -g root -m 644 "$backup_config" "$staged_config"
		mv -fT "$staged_config" "$target_config"
		nginx -t || fail 'Backend Nginx file restoration validation failed after reload failure.'
		rm -f -- "$backup_config"
		fail 'Backend Nginx reload failed; the previous live file was restored.'
	fi
	systemctl is-active --quiet nginx || fail 'Backend Nginx is not active after reload.'
	rm -f -- "$backup_config"
}

verify_widgets_public_surface() {
	local surface_manifest
	local public_api
	local asset
	local smoke_key="${deploy_revision:0:12}"
	local direct_body
	local gateway_body
	local public_body
	local direct_response
	local gateway_response
	local public_response
	local direct_hash
	local gateway_hash
	local public_hash
	local direct_status
	local gateway_status
	local public_status
	local core_asset_status
	local direct_headers
	local public_headers
	local headers
	surface_manifest="$(
		docker run --rm --network none --entrypoint node "$WIDGETS_IMAGE" -e '
const { WIDGET_DEFINITIONS } = require("./dist/src/domain/widgets-domain.types.js");
if (WIDGET_DEFINITIONS.length !== 7) throw new Error("Widgets public surface must contain seven definitions");
const seenApis = new Set();
const seenAssets = new Set();
for (const definition of WIDGET_DEFINITIONS) {
  if (!/^[a-z][a-z-]*$/.test(definition.publicApi) ||
      !/^[a-z][a-z-]*\.js$/.test(definition.asset) ||
      seenApis.has(definition.publicApi) || seenAssets.has(definition.asset)) {
    throw new Error("Widgets public surface definition is invalid");
  }
  seenApis.add(definition.publicApi);
  seenAssets.add(definition.asset);
  process.stdout.write(`${definition.publicApi}\t${definition.asset}\n`);
}
'
	)"
	[[ "$(wc -l <<<"$surface_manifest" | tr -d '[:space:]')" == '7' &&
		"$(sort -u <<<"$surface_manifest" | wc -l | tr -d '[:space:]')" == '7' ]] ||
		fail 'Widgets public API/asset manifest is incomplete or duplicated.'
	[[ "$(run_widgets_sql "
SELECT
  (SELECT count(*) FROM widgets.widgets WHERE public_key = '$smoke_key') +
  (SELECT count(*) FROM widgets.quizzes WHERE public_key = '$smoke_key') +
  (SELECT count(*) FROM widgets.callbacks WHERE public_key = '$smoke_key') +
  (SELECT count(*) FROM widgets.countdown_timers WHERE public_key = '$smoke_key') +
  (SELECT count(*) FROM widgets.stop_offers WHERE public_key = '$smoke_key') +
  (SELECT count(*) FROM widgets.online_consultants WHERE public_key = '$smoke_key') +
  (SELECT count(*) FROM widgets.calculators WHERE public_key = '$smoke_key');")" == '0' ]] ||
		fail 'The deterministic public API smoke key collides with production data.'

	while IFS=$'\t' read -r public_api asset; do
		[[ -n "$public_api" && -n "$asset" ]] || continue
		direct_hash="$(curl -fsS --connect-timeout 3 --max-time 20 \
			"http://127.0.0.1:4700/widgets/$asset" | sha256sum | awk '{ print $1 }')"
		public_hash="$(curl -fsS --connect-timeout 5 --max-time 30 \
			"https://api.winwidget.ru/widgets/$asset" | sha256sum | awk '{ print $1 }')"
		[[ "$direct_hash" =~ ^[0-9a-f]{64}$ && "$direct_hash" == "$public_hash" ]] ||
			fail "Public Widgets asset differs from the direct service: $asset"
		direct_headers="$(curl -fsSI --connect-timeout 3 --max-time 20 \
			"http://127.0.0.1:4700/widgets/$asset" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
		public_headers="$(curl -fsSI --connect-timeout 5 --max-time 30 \
			"https://api.winwidget.ru/widgets/$asset" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
		for headers in "$direct_headers" "$public_headers"; do
			[[ "$headers" == *'cache-control: public, max-age=300'* &&
				"$headers" != *'immutable'* &&
				"$(grep -c '^cache-control:' <<<"$headers")" == '1' ]] ||
				fail "Widgets asset cache policy is invalid: $asset"
		done
		core_asset_status="$(curl -sS --connect-timeout 2 --max-time 5 \
			-o /dev/null --write-out '%{http_code}' \
			"http://127.0.0.1:4200/widgets/$asset" || true)"
		[[ "$core_asset_status" == '404' ]] ||
			fail "Core API still serves a Widgets runtime asset: $asset"
		direct_response="$(curl -sS --connect-timeout 2 --max-time 5 \
			--write-out $'\n%{http_code}' \
			"http://127.0.0.1:4700/api/v1/$public_api/$smoke_key/config" || true)"
		gateway_response="$(curl -sS --connect-timeout 2 --max-time 5 \
			--write-out $'\n%{http_code}' \
			"http://127.0.0.1:4100/api/v1/$public_api/$smoke_key/config" || true)"
		public_response="$(curl -sS --connect-timeout 5 --max-time 20 \
			--write-out $'\n%{http_code}' \
			"https://api.winwidget.ru/api/v1/$public_api/$smoke_key/config" || true)"
		direct_status="${direct_response##*$'\n'}"
		gateway_status="${gateway_response##*$'\n'}"
		public_status="${public_response##*$'\n'}"
		direct_body="${direct_response%$'\n'*}"
		gateway_body="${gateway_response%$'\n'*}"
		public_body="${public_response%$'\n'*}"
		direct_hash="$(printf '%s' "$direct_body" | sha256sum | awk '{ print $1 }')"
		gateway_hash="$(printf '%s' "$gateway_body" | sha256sum | awk '{ print $1 }')"
		public_hash="$(printf '%s' "$public_body" | sha256sum | awk '{ print $1 }')"
		[[ "$direct_status" == '404' && "$gateway_status" == '404' &&
			"$public_status" == '404' && -n "$direct_body" &&
			"$direct_hash" == "$gateway_hash" && "$direct_hash" == "$public_hash" ]] ||
			fail "Widgets public API smoke failed: $public_api"
	done <<<"$surface_manifest"
	echo 'All seven Widgets public APIs and all seven runtime assets passed direct and public smoke checks.'
}

verify_widgets_queues_and_delivery_state() {
	local queue_manifest
	local listing
	local database_pending
	local queue
	local kind
	local state
	local expected_state
	local expected_queues
	local actual_owned_queues
	local queues_ready
	local clean_samples=0
	local attempt
	queue_manifest="$(
		docker run --rm --network none --entrypoint node "$WIDGETS_IMAGE" -e '
const {
  WIDGETS_CONSUMER_KINDS,
  WIDGETS_QUEUE_NAMES,
  WIDGETS_RETRY_DELAYS_MS,
} = require("./dist/src/messaging/widgets-messaging.constants.js");
for (const kind of WIDGETS_CONSUMER_KINDS) {
  const queue = WIDGETS_QUEUE_NAMES[kind];
  process.stdout.write(`${queue}\tmain\n${queue}.dead-letter\tdead-letter\n`);
  for (let index = 0; index < WIDGETS_RETRY_DELAYS_MS.length; index += 1) {
    process.stdout.write(`${queue}.retry.${index + 1}\tretry\n`);
  }
}
'
	)"
	[[ "$(wc -l <<<"$queue_manifest" | tr -d '[:space:]')" == '25' ]] ||
		fail 'Widgets queue manifest is incomplete.'
	expected_queues="$(cut -f1 <<<"$queue_manifest" | LC_ALL=C sort -u)"
	[[ "$(wc -l <<<"$expected_queues" | tr -d '[:space:]')" == '25' ]] ||
		fail 'Widgets queue manifest contains duplicate queue ownership.'
	for ((attempt = 1; attempt <= DRAIN_ATTEMPTS; attempt++)); do
		listing="$(rabbitmq_queue_listing)"
		queues_ready=true
		if ! widgets_cutover_post_publisher_namespace_is_safe \
			"$forward_only" "$core_topology_owner_restarted" "$listing"; then
			queues_ready=false
		fi
		actual_owned_queues="$(awk -F '\t' '
      $1 ~ /^winwidget\.widgets\./ ||
      $1 ~ /^winwidget\.lead-integration\.(webhook|bitrix24|amo-crm)(\.|$)/ { print $1 }
    ' <<<"$listing" | LC_ALL=C sort -u)"
		if [[ "$actual_owned_queues" != "$expected_queues" ]]; then
			queues_ready=false
		fi
		while IFS=$'\t' read -r queue kind; do
			[[ -n "$queue" && -n "$kind" ]] || continue
			state="$(awk -F '\t' -v queue="$queue" \
				'$1 == queue { print $2 "|" $3 "|" $4; found += 1 } END { exit(found == 1 ? 0 : 1) }' \
				<<<"$listing")" || {
				queues_ready=false
				break
			}
			expected_state='0|0|0'
			[[ "$kind" != 'main' ]] || expected_state='0|0|1'
			if [[ "$state" != "$expected_state" ]]; then
				queues_ready=false
				break
			fi
		done <<<"$queue_manifest"
		database_pending="$(run_widgets_sql "
SELECT
	(SELECT count(*) FROM widgets.outbox_events
	 WHERE status::text <> 'PUBLISHED' OR published_at IS NULL OR
	       locked_at IS NOT NULL OR locked_by IS NOT NULL OR
	       lock_token IS NOT NULL OR lease_expires_at IS NOT NULL) +
  (SELECT count(*) FROM widgets.consumer_failures WHERE status::text IN ('OPEN', 'RETRY_REQUESTED')) +
  (SELECT count(*) FROM widgets.integration_delivery_failures WHERE resolved_at IS NULL) +
	(SELECT count(*) FROM widgets.consumer_receipts WHERE status::text IN ('PROCESSING', 'RETRY_SCHEDULED', 'DEAD_LETTERED')) +
	(SELECT count(*) FROM widgets.integration_delivery_receipts WHERE status::text IN ('PROCESSING', 'RETRY_SCHEDULED', 'DEAD_LETTERED'));")"
		if [[ "$queues_ready" == 'true' && "$database_pending" == '0' ]]; then
			clean_samples=$((clean_samples + 1))
			if ((clean_samples >= 2)); then
				echo 'Widgets main/retry/DLQ queues and durable delivery state are empty and steady.'
				return 0
			fi
		else
			clean_samples=0
		fi
		sleep "$DRAIN_INTERVAL"
	done
	fail 'Widgets queues or durable delivery state did not reach the empty steady state.'
}

deploy_forward_runtime() {
	local ownership_state
	widgets_cutover_projection_boundary_is_safe "$widgets_projection_topology_ready" ||
		fail 'Widgets handoff is forbidden before projection RabbitMQ topology is verified.'
	compose_target --profile migration run --rm --no-deps migrate
	compose_target --profile migration run --rm --no-deps migrate \
		migrate status --schema prisma/schema.prisma
	ownership_state="$(widgets_service_identity_state)" ||
		fail 'Widgets ownership state is unreadable before the durable handoff.'
	case "$ownership_state" in
	inactive) begin_widgets_handoff ;;
	handoff | active) forward_only=true ;;
	*) fail 'Widgets target is not imported at the durable handoff boundary.' ;;
	esac
	apply_core_widgets_handoff
	finalize_widgets_acl
	switch_core_integration_rabbitmq_permissions
	stop_services_gracefully outbox-publisher
	legacy_core_topology_owner_stopped=true
	replace_legacy_provider_rabbitmq_topology
	compose_target up -d --no-deps --no-build --force-recreate outbox-publisher
	wait_for_core_topology_owner_restart ||
		fail 'Core outbox publisher did not restart at the cutover revision after topology replacement.'
	wait_for_post_publisher_provider_namespace ||
		fail 'Core outbox publisher recreated or changed the Widgets provider namespace.'
	if [[ "$(widgets_service_identity_state)" != 'active' ]]; then
		activate_widgets_ownership
	fi

	compose_target up -d --no-deps --no-build --force-recreate widgets-service
	wait_for_url_revision 'http://127.0.0.1:4700/health/ready' "$deploy_revision" ||
		fail 'Widgets service did not become ready at the cutover revision.'
	run_verify_steady

	compose_target up -d --no-deps --no-build --force-recreate \
		reporting-service api integration-worker \
		maintenance-worker database-restore-worker
	wait_for_url_revision 'http://127.0.0.1:4600/health/ready' "$deploy_revision" ||
		fail 'Reporting service did not become ready at the cutover revision.'
	wait_for_url_revision 'http://127.0.0.1:4200/api/v1/health/ready' "$deploy_revision" ||
		fail 'Core API did not become ready at the cutover revision.'
	for service in reporting-service api outbox-publisher integration-worker \
		maintenance-worker database-restore-worker widgets-service; do
		verify_running_service_revision "$service" "$deploy_revision" ||
			fail "Service revision/restart verification failed: $service"
	done

	compose_target up -d --no-deps --no-build --force-recreate api-gateway
	wait_for_url_revision 'http://127.0.0.1:4100/health/ready' "$deploy_revision" ||
		fail 'API Gateway did not become ready at the cutover revision.'
	verify_running_service_revision api-gateway "$deploy_revision" ||
		fail 'API Gateway revision/restart verification failed.'
	verify_core_worker_ownership
	verify_rabbitmq_consumer_ownership
	install_and_reload_backend_nginx
	verify_widgets_public_surface
	verify_widgets_queues_and_delivery_state
	run_verify_steady
}

cleanup_private_cutover_artifacts() {
	rm -f "$snapshot_file" "$snapshot_partial" \
		"$artifact_root/widgets-cutover-snapshot-comparison.jsonl" \
		"$import_result_file" "$handoff_result_file" \
		"$activation_result_file" "$verify_result_file"
	rmdir "$artifact_root" 2>/dev/null || true
}

main() {
	local prepared_state
	assert_checkout_and_environment
	export_image_identity
	case "$initial_ownership_state" in
	active | handoff) forward_only=true ;;
	absent | inactive) ;;
	*) fail 'Widgets service identity state is invalid.' ;;
	esac

	build_and_verify_images
	validate_widgets_database_urls
	ensure_rabbitmq_ready
	provision_widgets_rabbitmq_identity
	assert_widgets_rabbitmq_topology projections
	verify_widgets_projection_topology
	prepare_widgets_postgres
	provision_widgets_database_roles
	migrate_widgets_database
	finalize_widgets_acl
	ensure_snapshot_artifact_directory
	prepared_state="$(widgets_service_identity_state)" ||
		fail 'Prepared Widgets service identity is unreadable.'
	if [[ "$initial_ownership_state" == 'active' ]]; then
		[[ "$prepared_state" == 'active' ]] ||
			fail 'An active Widgets ownership marker regressed during recovery.'
		stop_services_gracefully widgets-service
	elif [[ "$initial_ownership_state" == 'handoff' ]]; then
		[[ "$prepared_state" == 'handoff' ]] ||
			fail 'The durable Widgets handoff marker regressed during forward recovery.'
		stop_services_gracefully widgets-service
	else
		[[ "$prepared_state" == 'inactive' ]] ||
			fail 'First-cutover target must have an inactive service identity.'
	fi
	start_and_verify_dark_widgets_service
	if [[ -e "$snapshot_file" || -L "$snapshot_file" ]]; then
		snapshot_locked=true
	fi
	create_core_pre_cutover_backup

	freeze_and_drain_source
	if [[ "$forward_only" != 'true' ]]; then
		assert_core_widget_handoff_sources
		export_or_reuse_snapshot
		run_import_snapshot
	fi
	deploy_forward_runtime
	create_and_restore_widgets_post_cutover_backup
	cleanup_private_cutover_artifacts
	trap - ERR
	echo "Widgets ownership cutover completed at revision $deploy_revision; Core runtime roles have no Widgets table privileges, verified backup evidence is retained, and no legacy rollback is permitted."
}

main "$@"
