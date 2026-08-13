#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
BILLING_HEALTHCHECK_ATTEMPTS="${BILLING_HEALTHCHECK_ATTEMPTS:-60}"
BILLING_HEALTHCHECK_INTERVAL="${BILLING_HEALTHCHECK_INTERVAL:-2}"
BILLING_DEPLOY_SKIP_BUILD="${BILLING_DEPLOY_SKIP_BUILD:-false}"

server_root="$APP_ROOT/winwidget.ru_server"
billing_deploy_image_id=''

# shellcheck source=scripts/billing-release-identity.sh
declare -F billing_compose >/dev/null ||
	source "$server_root/scripts/billing-release-identity.sh"
# shellcheck source=scripts/billing-database-lifecycle.sh
declare -F billing_database_current_phase >/dev/null ||
	source "$server_root/scripts/billing-database-lifecycle.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
declare -F database_restore_guard_assert_before_mutation >/dev/null ||
	source "$server_root/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/production-deploy-lock.sh
declare -F acquire_production_deploy_lock >/dev/null ||
	source "$server_root/scripts/production-deploy-lock.sh"

billing_deploy_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

billing_deploy_require_boundary() {
	local phase
	billing_database_require_root
	billing_database_require_exact_checkout
	billing_database_require_env_contract
	billing_database_validate_urls
	# database-restore-production-guard: before-mutation
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	phase="$(billing_database_current_phase)" || return 1
	case "$phase" in
	prepared | source-frozen | imported | pre-backups-created | \
		pre-restore-verified | projection-synced | forward-only | active | \
		post-backup-created | post-restore-verified | complete) ;;
	*) billing_deploy_fail \
		"Billing deploy requires a prepared lifecycle marker; phase=$phase." || return 1 ;;
	esac
	[[ "$(billing_database_marker_value ownership_revision)" == "$EXPECTED_REVISION" ]] ||
		billing_deploy_fail 'Billing marker is bound to a different ownership revision.'
	billing_database_require_pinned_candidate_images
}

billing_deploy_database_fingerprint() {
	local container_id system_identifier database_id admin_secret admin_password
	container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" --profile billing-database ps -q billing-postgres)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		billing_deploy_fail 'Billing PostgreSQL is not running.' || return 1
	system_identifier="$(billing_database_verify_acl "$container_id")" || return 1
	admin_secret="$(billing_read_env_value "$ENV_FILE" \
		BILLING_POSTGRES_ADMIN_PASSWORD_FILE)"
	admin_password="$(tr -d '\r\n' <"$admin_secret")"
	database_id="$(docker exec -e "PGPASSWORD=$admin_password" "$container_id" \
		psql --no-psqlrc --no-password --quiet --tuples-only --no-align \
		--username winwidget_billing_admin --dbname winwidget_billing \
		--command "SELECT database_id::text FROM billing.service_identity WHERE service_name = 'billing-service';")"
	[[ "$system_identifier" == \
		"$(billing_database_marker_value database_system_identifier)" &&
		"$database_id" == "$(billing_database_marker_value database_id)" ]] ||
		billing_deploy_fail 'Billing database identity differs from its durable marker.' ||
		return 1
	printf '%s|%s\n' "$system_identifier" "$database_id"
}

billing_deploy_build_image() {
	local image_ref
	image_ref="$(billing_release_identity_value BILLING_IMAGE "$EXPECTED_REVISION")"
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		build --pull billing-api
	billing_deploy_verify_image "$image_ref"
}

billing_deploy_verify_image() {
	[[ $# -eq 1 ]] || return 1
	local image_ref="$1" image_id image_revision image_user
	image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
	image_revision="$(docker image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_ref")"
	image_user="$(docker image inspect --format '{{.Config.User}}' "$image_ref")"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$image_revision" == "$EXPECTED_REVISION" &&
		"$image_user" == 'billing' ]] ||
		billing_deploy_fail \
			'Billing image must be immutable, revision-labelled and USER billing.' || return 1
	billing_deploy_image_id="$image_id"
}

billing_deploy_verify_container_environment() {
	[[ $# -eq 3 ]] || return 1
	local container_id="$1" expected_role="$2" expected_revision="$3"
	docker inspect "$container_id" | EXPECTED_ROLE="$expected_role" \
		EXPECTED_REVISION="$expected_revision" billing_release_node_stdin -e '
const fs = require("node:fs");
const documents = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(documents) || documents.length !== 1) process.exit(1);
const document = documents[0];
const environment = Object.fromEntries(
  document.Config.Env.map(entry => {
    const index = entry.indexOf("=");
    return [entry.slice(0, index), entry.slice(index + 1)];
  }),
);
const role = process.env.EXPECTED_ROLE;
if (
  environment.APP_REVISION !== process.env.EXPECTED_REVISION ||
  environment.BILLING_PROCESS_ROLE !== role ||
  environment.BILLING_LISTEN_HOST !== "127.0.0.1"
) process.exit(1);
const providerKeys = [
  "YOOKASSA_PRODUCTION_SHOP_ID",
  "YOOKASSA_PRODUCTION_SECRET_KEY",
  "PAYMENT_METHOD_ENCRYPTION_KEY",
];
const developmentProviderKeys = ["YOOKASSA_SHOP_ID", "YOOKASSA_SECRET_KEY"];
const workerCallKeys = [...providerKeys, "RECAPTCHA_CLIENT_URL"];
const coreKeys = [
  "BILLING_CORE_INTERNAL_BASE_URL",
  "BILLING_INTERNAL_TOKEN",
  "BILLING_INTERNAL_TIMEOUT_MS",
];
const widgetsKeys = [
  "WIDGETS_INTERNAL_BASE_URL",
  "WIDGETS_INTERNAL_TOKEN",
  "WIDGETS_INTERNAL_TIMEOUT_MS",
];
const hasAll = keys => keys.every(key => typeof environment[key] === "string" && environment[key].length > 0);
const hasNone = keys => keys.every(key => !(key in environment));
if (!hasNone(developmentProviderKeys)) process.exit(1);
if (role === "api") {
  if (!(hasAll(coreKeys) && hasAll(widgetsKeys) && hasNone(workerCallKeys) && !("RABBITMQ_URL" in environment) && environment.TRUST_PROXY)) process.exit(1);
} else if (role === "worker") {
  if (!(hasAll(coreKeys) && hasAll(workerCallKeys) && hasNone(widgetsKeys) && environment.RABBITMQ_URL)) process.exit(1);
} else if (role === "outbox-publisher") {
  if (!(hasNone([...workerCallKeys, ...coreKeys, ...widgetsKeys]) && environment.RABBITMQ_URL)) process.exit(1);
} else if (role === "scheduler") {
  if (!(hasNone([...workerCallKeys, ...coreKeys, ...widgetsKeys]) && !("RABBITMQ_URL" in environment))) process.exit(1);
} else process.exit(1);
'
}

billing_deploy_verify_service() {
	[[ $# -eq 4 ]] || return 1
	local service="$1" role="$2" port="$3" expected_image_id="$4"
	local attempt container_id health image_id image_revision restart_count response
	for ((attempt = 1; attempt <= BILLING_HEALTHCHECK_ATTEMPTS; attempt++)); do
		container_id="$(billing_compose "$EXPECTED_REVISION" "$ENV_FILE" \
			"$COMPOSE_FILE" ps --status running -q "$service" 2>/dev/null || true)"
		if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
			health="$(docker inspect --format \
				'{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
				"$container_id" 2>/dev/null || true)"
			if [[ "$health" == 'healthy' ]]; then
				image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
				image_revision="$(docker image inspect --format \
					'{{index .Config.Labels "org.opencontainers.image.revision"}}' \
					"$image_id")"
				restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
				response="$(curl -fsS --connect-timeout 2 --max-time 5 \
					"http://127.0.0.1:$port/health/ready" 2>/dev/null || true)"
				if [[ "$image_id" == "$expected_image_id" &&
					"$image_revision" == "$EXPECTED_REVISION" &&
					"$restart_count" == '0' && -n "$response" ]] &&
					billing_deploy_verify_container_environment "$container_id" \
						"$role" "$EXPECTED_REVISION"; then
					return 0
				fi
			fi
		fi
		sleep "$BILLING_HEALTHCHECK_INTERVAL"
	done
	billing_deploy_fail "Billing service failed verification: $service"
}

billing_deploy_run() {
	local phase image_ref image_id fingerprint_before fingerprint_after
	billing_deploy_require_boundary
	acquire_production_deploy_lock 'Billing deployment'
	fingerprint_before="$(billing_deploy_database_fingerprint)"
	case "$BILLING_DEPLOY_SKIP_BUILD" in
	false)
		billing_deploy_fail \
			'Billing lifecycle image is pinned; rebuilding it during deployment is forbidden.'
		return 1
		;;
	true)
		image_ref="$(billing_release_identity_value BILLING_IMAGE "$EXPECTED_REVISION")"
		billing_deploy_verify_image "$image_ref"
		;;
	*) billing_deploy_fail 'BILLING_DEPLOY_SKIP_BUILD must be true or false.' || return 1 ;;
	esac
	image_id="$billing_deploy_image_id"
	billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile billing-migration run --rm --no-deps billing-migrate
	phase="$(billing_database_current_phase)"
	if [[ "$phase" == 'prepared' || "$phase" == 'source-frozen' ||
		"$phase" == 'imported' || "$phase" == 'pre-backups-created' ||
		"$phase" == 'pre-restore-verified' || "$phase" == 'projection-synced' ]]; then
		billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			stop -t 90 billing-scheduler \
			>/dev/null 2>&1 || true
		billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build --force-recreate \
			billing-api billing-worker billing-outbox-publisher
		billing_deploy_verify_service billing-api api 4800 "$image_id"
		billing_deploy_verify_service billing-worker worker 4802 "$image_id"
		billing_deploy_verify_service \
			billing-outbox-publisher outbox-publisher 4803 "$image_id"
		printf 'billing_deploy_mode=dark\n'
	else
		billing_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			up -d --no-deps --no-build --force-recreate \
			billing-api billing-scheduler billing-worker billing-outbox-publisher
		billing_deploy_verify_service billing-api api 4800 "$image_id"
		billing_deploy_verify_service billing-scheduler scheduler 4801 "$image_id"
		billing_deploy_verify_service billing-worker worker 4802 "$image_id"
		billing_deploy_verify_service \
			billing-outbox-publisher outbox-publisher 4803 "$image_id"
		printf 'billing_deploy_mode=active\n'
	fi
	fingerprint_after="$(billing_deploy_database_fingerprint)"
	[[ "$fingerprint_before" == "$fingerprint_after" ]] ||
		billing_deploy_fail 'Billing PostgreSQL identity changed during deployment.'
	printf 'billing_deploy_revision=%s\n' "$EXPECTED_REVISION"
}

billing_deploy_self_test() {
	local source self_test_node
	source="$(declare -f billing_deploy_require_boundary billing_deploy_run \
		billing_deploy_verify_container_environment billing_deploy_verify_service)"
	[[ "$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *'billing_database_require_env_contract'* &&
		"$source" == *'billing_database_require_pinned_candidate_images'* &&
		"$source" == *'rebuilding it during deployment is forbidden'* &&
		"$source" == *'--profile billing-migration run --rm --no-deps billing-migrate'* &&
		"$source" != *'run --rm --no-deps --no-build billing-migrate'* &&
		"$source" == *'up -d --no-deps --no-build --force-recreate'* &&
		"$source" == *'billing-scheduler billing-worker billing-outbox-publisher'* &&
		"$source" == *'PAYMENT_METHOD_ENCRYPTION_KEY'* &&
		"$source" == *'TRUST_PROXY'* &&
		"$source" == *'WIDGETS_INTERNAL_BASE_URL'* &&
		"$source" == *'Billing PostgreSQL identity changed during deployment.'* ]] ||
		return 1
	self_test_node="$(type -P node 2>/dev/null || true)"
	[[ -n "$self_test_node" && -x "$self_test_node" ]] ||
		billing_deploy_fail 'Billing deploy self-test requires host Node.' || return 1
	"$self_test_node" - "$COMPOSE_FILE" "$server_root/apps/billing/Dockerfile" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const composePath = path.resolve(process.argv[2]);
const expectedDockerfile = path.resolve(process.argv[3]);
const compose = fs.readFileSync(composePath, 'utf8');
const start = compose.indexOf('\n  billing-api:');
const end = compose.indexOf('\n  billing-scheduler:', start);
if (start < 0 || end <= start) process.exit(1);
const block = compose.slice(start, end);
const contextMatch = block.match(/\n      context: ([^\n]+)\n/);
const dockerfileMatch = block.match(/\n      dockerfile: ([^\n]+)\n/);
if (!contextMatch || !dockerfileMatch) process.exit(1);
const context = path.resolve(path.dirname(composePath), contextMatch[1].trim());
const dockerfile = path.resolve(context, dockerfileMatch[1].trim());
if (dockerfile !== expectedDockerfile || !fs.statSync(context).isDirectory()) {
  process.exit(1);
}
const dockerSource = fs.readFileSync(dockerfile, 'utf8');
const localCopies = dockerSource.split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => /^COPY\s+/i.test(line) && !/^COPY\s+--from=/i.test(line));
if (!localCopies.length) process.exit(1);
for (const instruction of localCopies) {
  const tokens = instruction.replace(/^COPY\s+/i, '').trim().split(/\s+/);
  if (tokens.length < 2) process.exit(1);
  for (const source of tokens.slice(0, -1)) {
    if (source.startsWith('/') || source === '..' || source.startsWith('../')) {
      process.exit(1);
    }
    const resolved = path.resolve(context, source);
    if (resolved !== context && !resolved.startsWith(`${context}${path.sep}`)) {
      process.exit(1);
    }
    if (!fs.existsSync(resolved)) process.exit(1);
  }
}
if (
  !dockerSource.includes('COPY package.json pnpm-lock.yaml ./') ||
  !dockerSource.includes('pnpm install --frozen-lockfile') ||
  !dockerSource.includes('COPY . .') ||
  !dockerSource.includes('--gid 1001') ||
  !dockerSource.includes('--uid 1001') ||
  !/^USER billing$/m.test(dockerSource)
) process.exit(1);
NODE
	printf 'billing_deploy_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--deploy) billing_deploy_run ;;
	--self-test) billing_deploy_self_test ;;
	*) billing_deploy_fail \
		'Usage: deploy-billing-production.sh --deploy|--self-test' ;;
	esac
fi
