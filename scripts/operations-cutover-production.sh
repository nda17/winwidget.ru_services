#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
ENV_FILE="${OPERATIONS_ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${OPERATIONS_COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
CONFIRMATION='CUT OVER OPERATIONS FORWARD ONLY'
CONTAINER_ARTIFACT_DIR='/var/lib/winwidget/operations-cutover'
readonly OPERATIONS_STEADY_INTEGRATION_READ_PATTERN='^winwidget\.core\.billing\.(payment-details|subscription-details|affiliate)\.v1(\.dead-letter)?$'
readonly OPERATIONS_STEADY_INTEGRATION_KINDS='billing-payment-projection,billing-subscription-projection,billing-affiliate-projection'

operations_cutover_script_directory="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P
)"
# shellcheck source=scripts/billing-release-identity.sh
source "$operations_cutover_script_directory/billing-release-identity.sh"

fail() {
  printf 'operations-cutover: %s\n' "$1" >&2
  exit 1
}

compose() {
  docker compose --project-name winwidget \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    "$@"
}

read_env_value() {
  local key="$1"
  OPERATIONS_ENV_PATH="$ENV_FILE" OPERATIONS_ENV_KEY="$key" \
    billing_release_node - <<'NODE'
const { readFileSync } = require('node:fs');
const key = process.env.OPERATIONS_ENV_KEY;
const matches = [];
for (const line of readFileSync(process.env.OPERATIONS_ENV_PATH, 'utf8').split(/\r?\n/)) {
  if (!line.trim() || /^\s*#/.test(line)) continue;
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match || match[1] !== key) continue;
  let value = match[2];
  if (value.startsWith('"') || value.endsWith('"')) {
    if (!(value.startsWith('"') && value.endsWith('"'))) process.exit(1);
    try {
      value = JSON.parse(value);
    } catch {
      process.exit(1);
    }
  }
  else if (value.startsWith("'") || value.endsWith("'")) {
    if (!(value.startsWith("'") && value.endsWith("'"))) process.exit(1);
    value = value.slice(1, -1);
  }
  matches.push(value);
}
if (matches.length !== 1 || !matches[0] || matches[0].includes('\0')) process.exit(1);
process.stdout.write(matches[0]);
NODE
}

assert_checkout() {
  local expected="$1" actual branch
  actual="$(git -C "$SERVER_ROOT" rev-parse HEAD)"
  branch="$(git -C "$SERVER_ROOT" branch --show-current)"
  [[ "$expected" =~ ^[0-9a-f]{40}$ && "$actual" == "$expected" ]] ||
    fail 'EXPECTED_REVISION must match the exact checkout SHA'
  [[ "$branch" == 'prod' ]] || fail 'production cutover requires the prod branch'
  [[ -z "$(git -C "$SERVER_ROOT" status --porcelain --untracked-files=all)" ]] ||
    fail 'production cutover requires a clean checkout'
}

export_coordinated_revision() {
  local revision="$1"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'coordinated Operations revision must be an exact commit SHA'

  export APP_REVISION="$revision"
  export APP_VERSION="git-$revision"
  export MAINTENANCE_REVISION="$revision"
  export MAINTENANCE_IMAGE="winwidget-maintenance:git-$revision"
  export DATABASE_RESTORE_REVISION="$revision"
  export DATABASE_RESTORE_IMAGE="winwidget-database-restore:git-$revision"
  export NOTIFICATION_DELIVERY_REVISION="$revision"
  export NOTIFICATION_DELIVERY_IMAGE="winwidget-notification-delivery:git-$revision"
  export CAMPAIGNS_REVISION="$revision"
  export CAMPAIGNS_IMAGE="winwidget-campaigns:git-$revision"
  export REPORTING_REVISION="$revision"
  export REPORTING_IMAGE="winwidget-reporting:git-$revision"
  export WIDGETS_REVISION="$revision"
  export WIDGETS_IMAGE="winwidget-widgets:git-$revision"
  export BILLING_REVISION="$revision"
  export BILLING_IMAGE="winwidget-billing:git-$revision"
  export IDENTITY_REVISION="$revision"
  export IDENTITY_IMAGE="winwidget-identity:git-$revision"
  export PLATFORM_REVISION="$revision"
  export PLATFORM_IMAGE="winwidget-platform:git-$revision"
  export SUPPORT_REVISION="$revision"
  export SUPPORT_IMAGE="winwidget-support:git-$revision"
  export OPERATIONS_REVISION="$revision"
  export OPERATIONS_IMAGE="winwidget-operations:git-$revision"
}

assert_inputs() {
  [[ "$(id -u)" == '0' ]] ||
    fail 'production cutover must run as root'
  [[ "${OPERATIONS_CUTOVER_CONFIRMATION:-}" == "$CONFIRMATION" ]] ||
    fail "set exact confirmation: $CONFIRMATION"
  [[ "$ENV_FILE" == "$APP_ROOT/deploy/backend/.env.production" &&
    -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
    fail 'backend production env is missing or unsafe'
  [[ "$COMPOSE_FILE" == "$SERVER_ROOT/deploy/docker-compose.prod.yml" &&
    -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] ||
    fail 'production Compose file is missing or unsafe'
  [[ "$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
    fail 'backend production env must be root-owned mode 600'
}

assert_platform_cleanup_complete() {
  local revision="$1" cleanup_revision
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'Platform cleanup prerequisite requires the exact Operations revision'
  cleanup_revision="$(
    APP_ROOT="$APP_ROOT" \
    SERVER_ROOT="$SERVER_ROOT" \
    EXPECTED_REVISION="$revision" \
      bash -Eeuo pipefail -c '
        source "$SERVER_ROOT/scripts/cleanup-platform-core-source-production.sh"
        platform_cleanup_validate_marker
        [[ "$(platform_cleanup_marker_value phase)" == complete ]]
        cleanup_revision="$(platform_cleanup_marker_value cleanup_revision)"
        [[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ &&
          "$cleanup_revision" != "$EXPECTED_REVISION" ]]
        git -C "$SERVER_ROOT" merge-base --is-ancestor \
          "$cleanup_revision" "$EXPECTED_REVISION"
        printf "%s\n" "$cleanup_revision"
      '
  )" || fail 'Operations cutover requires completed Platform cleanup at an immutable ancestor revision'
  [[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ &&
    "$cleanup_revision" != "$revision" ]] ||
    fail 'Platform cleanup prerequisite returned an invalid revision'
}

root_cutover() {
  compose --profile migration run --rm --no-deps \
    --entrypoint node migrate \
    dist/src/operations-cutover-main.js "$@"
}

target_cutover() {
  compose --profile operations-migration run --rm --no-deps \
    --entrypoint node operations-migrate \
    dist/src/cutover/main.js "$@"
}

run_core_source_cleanup() {
  local revision="$1" sha256="$2" note_count="$3" event_count="$4"
  local service running_container_ids
  local -a source_services=()
  [[ "$revision" =~ ^[0-9a-f]{40}$ &&
    "$sha256" =~ ^[0-9a-f]{64}$ &&
    "$note_count" =~ ^[0-9]+$ &&
    "$event_count" =~ ^[0-9]+$ ]] ||
    fail 'Operations Core cleanup expectations are invalid'
  mapfile -t source_services < <(select_existing_services \
    api integration-worker outbox-publisher \
    campaigns-service reporting-service widgets-service \
    billing-api billing-scheduler billing-worker billing-outbox-publisher \
    identity-api identity-worker identity-outbox-publisher \
    platform-api platform-outbox-publisher \
    support-api support-worker support-outbox-publisher \
    operations-api operations-worker operations-outbox-publisher)
  ((${#source_services[@]} > 0)) ||
    fail 'Operations source-writer services cannot be resolved'
  for service in "${source_services[@]}"; do
    running_container_ids="$(compose ps --status running -q "$service")"
    [[ -z "$running_container_ids" ]] ||
      fail "Source writer $service must remain stopped during terminal Operations source cleanup"
  done

  local OPERATIONS_EXPECTED_REVISION="$revision"
  local OPERATIONS_EXPECTED_SNAPSHOT_SHA256="$sha256"
  local OPERATIONS_EXPECTED_NOTE_COUNT="$note_count"
  local OPERATIONS_EXPECTED_EVENT_COUNT="$event_count"
  export OPERATIONS_EXPECTED_REVISION OPERATIONS_EXPECTED_SNAPSHOT_SHA256 \
    OPERATIONS_EXPECTED_NOTE_COUNT OPERATIONS_EXPECTED_EVENT_COUNT
  compose --profile migration run --rm -T --no-deps \
    -e OPERATIONS_EXPECTED_REVISION \
    -e OPERATIONS_EXPECTED_SNAPSHOT_SHA256 \
    -e OPERATIONS_EXPECTED_NOTE_COUNT \
    -e OPERATIONS_EXPECTED_EVENT_COUNT \
    --entrypoint node migrate -e '
const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const cleanupPath = "/app/prisma/post-cutover/operations/20260825010000_remove_legacy_operations_core_source.sql";
const revision = process.env.OPERATIONS_EXPECTED_REVISION || "";
const sha256 = process.env.OPERATIONS_EXPECTED_SNAPSHOT_SHA256 || "";
const notes = process.env.OPERATIONS_EXPECTED_NOTE_COUNT || "";
const events = process.env.OPERATIONS_EXPECTED_EVENT_COUNT || "";
if (!/^[0-9a-f]{40}$/.test(revision) || !/^[0-9a-f]{64}$/.test(sha256) ||
    !/^(0|[1-9][0-9]*)$/.test(notes) || !/^(0|[1-9][0-9]*)$/.test(events) ||
    !existsSync(cleanupPath)) process.exit(64);
let url;
try { url = new URL(process.env.DATABASE_URL || ""); } catch { process.exit(65); }
const queryKeys = [...url.searchParams.keys()];
if (url.protocol !== "postgresql:" || decodeURIComponent(url.username) !== "gen_user" ||
    !url.password || url.hostname !== "127.0.0.1" || url.port !== "55434" ||
    url.pathname !== "/default_db" || url.hash ||
    url.searchParams.getAll("schema").length !== 1 ||
    url.searchParams.get("schema") !== "public" ||
    url.searchParams.getAll("sslmode").length !== 1 ||
    url.searchParams.get("sslmode") !== "disable" || queryKeys.length !== 2 ||
    queryKeys.some(key => !["schema", "sslmode"].includes(key))) process.exit(66);
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port,
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGSSLMODE: "disable",
  PGOPTIONS: [
    "-c lock_timeout=60000",
    "-c statement_timeout=300000",
    "-c winwidget.operations_source_cleanup=approved",
    "-c winwidget.operations_core_stopped=true",
    `-c winwidget.operations_expected_revision=${revision}`,
    `-c winwidget.operations_expected_snapshot_sha256=${sha256}`,
    `-c winwidget.operations_expected_note_count=${notes}`,
    `-c winwidget.operations_expected_event_count=${events}`,
  ].join(" "),
};
delete env.DATABASE_URL;
const result = spawnSync("psql", ["--no-psqlrc", "--no-password", "--set", "ON_ERROR_STOP=1",
  "--file", cleanupPath], { env, stdio: "inherit" });
if (result.error || result.signal || result.status !== 0) process.exit(67);
const verifySql = `DO $$ BEGIN
  IF to_regclass('"'"'public.notes'"'"') IS NOT NULL
     OR to_regclass('"'"'public.admin_event_logs'"'"') IS NOT NULL
     OR to_regclass('"'"'public.operations_core_state'"'"') IS NOT NULL
     OR to_regprocedure('"'"'public.operations_core_source_write_guard()'"'"') IS NOT NULL
     OR to_regprocedure('"'"'public.operations_core_state_transition_guard()'"'"') IS NOT NULL
     OR to_regtype('"'"'public."OperationsCoreOwnership"'"'"') IS NOT NULL
  THEN RAISE EXCEPTION '"'"'Legacy Operations Core source remains after cleanup'"'"';
  END IF;
END $$;`;
const verification = spawnSync("psql", ["--no-psqlrc", "--no-password", "--set",
  "ON_ERROR_STOP=1", "--command", verifySql], { env, stdio: "inherit" });
if (verification.error || verification.signal || verification.status !== 0) process.exit(68);
'
}

wait_ready() {
  local url="$1" label="$2"
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 3 "$url" > /dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  fail "$label readiness timed out"
}

wait_operations_ready() {
  local url="$1" role="$2" revision="$3" response
  for _ in $(seq 1 60); do
    response="$(curl --fail --silent --show-error --max-time 3 "$url" 2>/dev/null || true)"
    if OPERATIONS_HEALTH_JSON="$response" \
      OPERATIONS_EXPECTED_ROLE="$role" \
      OPERATIONS_EXPECTED_REVISION="$revision" \
      billing_release_node - <<'NODE'
const value = JSON.parse(process.env.OPERATIONS_HEALTH_JSON || 'null');
const expectedKeys = ['revision', 'role', 'service', 'status'];
const keys = value && typeof value === 'object' ? Object.keys(value).sort() : [];
if (
  keys.length !== expectedKeys.length ||
  !keys.every((key, index) => key === expectedKeys[index]) ||
  value.status !== 'ready' ||
  value.service !== 'operations' ||
  value.role !== process.env.OPERATIONS_EXPECTED_ROLE ||
  value.revision !== process.env.OPERATIONS_EXPECTED_REVISION
) process.exit(1);
NODE
    then
      return 0
    fi
    sleep 2
  done
  fail "Operations $role readiness/revision timed out"
}

assert_steady_integration_contract() {
  local configured
  configured="$(read_env_value INTEGRATION_WORKER_KINDS)" ||
    fail 'INTEGRATION_WORKER_KINDS is missing'
  [[ "$configured" == "$OPERATIONS_STEADY_INTEGRATION_KINDS" ]] ||
    fail 'INTEGRATION_WORKER_KINDS must contain only the three Billing projections before RabbitMQ handoff'
}

select_existing_services() {
  local available candidate
  available="$(compose config --services)" ||
    fail 'production Compose services cannot be resolved'
  for candidate in "$@"; do
    if grep -Fxq "$candidate" <<< "$available"; then
      printf '%s\n' "$candidate"
    fi
  done
}

stop_audit_source_services() {
  local -a services=()
  mapfile -t services < <(select_existing_services \
    api-gateway api outbox-publisher \
    campaigns-service reporting-service widgets-service \
    billing-api billing-scheduler billing-worker billing-outbox-publisher \
    identity-api identity-worker identity-outbox-publisher \
    platform-api platform-outbox-publisher \
    support-api support-worker support-outbox-publisher \
    operations-api operations-worker operations-outbox-publisher)
  ((${#services[@]} > 0)) || fail 'audit source services cannot be resolved'
  compose stop --timeout 30 "${services[@]}"
}

start_cutover_services() {
  local -a services=()
  mapfile -t services < <(select_existing_services \
    operations-api operations-worker operations-outbox-publisher \
    api integration-worker outbox-publisher \
    campaigns-service reporting-service widgets-service \
    billing-api billing-scheduler billing-worker billing-outbox-publisher \
    identity-api identity-worker identity-outbox-publisher \
    platform-api platform-outbox-publisher \
    support-api support-worker support-outbox-publisher \
    api-gateway)
  ((${#services[@]} > 0)) || fail 'cutover services cannot be resolved'
  compose up -d "${services[@]}"
}

rabbit_queue_snapshot() {
  local container_id
  container_id="$(compose ps -q rabbitmq)"
  [[ -n "$container_id" &&
    "$(docker inspect --format '{{.State.Running}}' "$container_id")" == true ]] ||
    fail 'RabbitMQ must already be running for the Operations handoff'
  docker exec "$container_id" rabbitmqctl list_queues \
    --vhost winwidget \
    name messages_ready messages_unacknowledged consumers \
    --formatter json --no-table-headers
}

queue_state_matches() {
  local mode="$1" snapshot
  snapshot="$(rabbit_queue_snapshot)" || return 1
  OPERATIONS_QUEUE_MODE="$mode" OPERATIONS_QUEUE_SNAPSHOT="$snapshot" \
    billing_release_node - <<'NODE'
const rows = JSON.parse(process.env.OPERATIONS_QUEUE_SNAPSHOT || '[]');
if (!Array.isArray(rows)) process.exit(1);
const byName = new Map(rows.map(row => [row.name, row]));
const stat = name => {
  const row = byName.get(name);
  if (!row) return { ready: 0, unacked: 0, consumers: 0, missing: true };
  const result = {
    ready: Number(row.messages_ready),
    unacked: Number(row.messages_unacknowledged),
    consumers: Number(row.consumers),
    missing: false,
  };
  if (Object.values(result).slice(0, 3).some(value => !Number.isSafeInteger(value) || value < 0)) {
    process.exit(1);
  }
  return result;
};
const legacyBases = [
  'winwidget.admin.audit.campaigns.v1',
  'winwidget.admin.audit.reporting.v1',
  'winwidget.admin.audit.widgets.v1',
  'winwidget.admin.audit.billing.v1',
  'winwidget.admin.audit.identity.v1',
  'winwidget.admin.audit.platform.v1',
  'winwidget.admin.audit.support.v1',
];
const legacy = legacyBases.flatMap(base => [
  base,
  `${base}.retry-v2.1`,
  `${base}.retry-v2.2`,
  `${base}.retry-v2.3`,
]);
const sources = ['campaigns', 'reporting', 'widgets', 'billing', 'identity', 'platform', 'support', 'core'];
const operationsMain = sources.map(source => `winwidget.operations.admin.audit.${source}.v1`);
const operationsAuxiliary = sources.flatMap(source => [
  `winwidget.operations.admin.audit.${source}.v1.retry-v1`,
  `winwidget.operations.admin.audit.${source}.v1.dead-letter`,
]);
const projections = [
  'winwidget.core.billing.payment-details.v1',
  'winwidget.core.billing.subscription-details.v1',
  'winwidget.core.billing.affiliate.v1',
];
const empty = names => names.every(name => {
  const value = stat(name);
  return value.ready === 0 && value.unacked === 0;
});
const noConsumers = names => names.every(name => stat(name).consumers === 0);
let valid = false;
switch (process.env.OPERATIONS_QUEUE_MODE) {
  case 'legacy-drained':
    valid = empty(legacy);
    break;
  case 'legacy-stopped':
    valid = empty(legacy) && noConsumers(legacy);
    break;
  case 'legacy-absent':
    valid = legacy.every(name => stat(name).missing);
    break;
  case 'operations-prebind':
    valid = empty([...operationsMain, ...operationsAuxiliary]) &&
      noConsumers([...operationsMain, ...operationsAuxiliary]);
    break;
  case 'steady':
    valid = empty(legacy) && noConsumers(legacy) &&
      operationsMain.every(name => !stat(name).missing && stat(name).consumers === 1) &&
      empty(operationsAuxiliary) && noConsumers(operationsAuxiliary) &&
      projections.every(name => !stat(name).missing && stat(name).consumers === 1);
    break;
  default:
    process.exit(1);
}

process.exit(valid ? 0 : 1);
NODE
}

retire_drained_legacy_audit_queues() {
  local container_id snapshot queue
  local -a queues=()
  container_id="$(compose ps -q rabbitmq)"
  [[ -n "$container_id" &&
    "$(docker inspect --format '{{.State.Running}}' "$container_id")" == true ]] ||
    fail 'RabbitMQ is unavailable for legacy audit queue retirement'
  queue_state_matches legacy-stopped ||
    fail 'legacy audit queues must be empty and unused before retirement'
  snapshot="$(rabbit_queue_snapshot)"
  mapfile -t queues < <(
    OPERATIONS_QUEUE_SNAPSHOT="$snapshot" billing_release_node - <<'NODE'
const rows = JSON.parse(process.env.OPERATIONS_QUEUE_SNAPSHOT || '[]');
const existing = new Set(rows.map(row => row.name));
const bases = [
  'winwidget.admin.audit.campaigns.v1',
  'winwidget.admin.audit.reporting.v1',
  'winwidget.admin.audit.widgets.v1',
  'winwidget.admin.audit.billing.v1',
  'winwidget.admin.audit.identity.v1',
  'winwidget.admin.audit.platform.v1',
  'winwidget.admin.audit.support.v1',
];
for (const base of bases) {
  for (const queue of [
    base,
    `${base}.retry-v2.1`,
    `${base}.retry-v2.2`,
    `${base}.retry-v2.3`,
  ]) {
    if (existing.has(queue)) process.stdout.write(`${queue}\n`);
  }
}
NODE
  )
  for queue in "${queues[@]}"; do
    docker exec "$container_id" rabbitmqctl --silent delete_queue \
      -p winwidget "$queue" --if-empty --if-unused > /dev/null
  done
  queue_state_matches legacy-absent ||
    fail 'legacy audit queues or bindings remain after retirement'
}

wait_queue_state() {
  local mode="$1" label="$2" attempts="${3:-120}"
  [[ "$attempts" =~ ^[1-9][0-9]*$ && "$attempts" -le 1200 ]] ||
    fail 'invalid queue wait attempt count'
  for _ in $(seq 1 "$attempts"); do
    if queue_state_matches "$mode"; then
      return 0
    fi
    sleep 2
  done
  fail "$label did not reach the required exact queue state"
}

identity_introspection_smoke() {
  local revision="$1" identity_revision
  identity_revision="$(read_env_value IDENTITY_REVISION)" ||
    fail 'IDENTITY_REVISION is missing'
  [[ "$revision" =~ ^[0-9a-f]{40}$ && "$identity_revision" == "$revision" ]] ||
    fail 'Identity revision must match the exact Operations cutover revision'
  compose exec -T \
    -e EXPECTED_IDENTITY_REVISION="$identity_revision" \
    operations-api node -e '
const fail = () => process.exit(1);
(async () => {
  const revision = await fetch("http://127.0.0.1:4900/health/revision", {
    signal: AbortSignal.timeout(5000),
  });
  if (!revision.ok) fail();
  const identity = await revision.json();
  if (
    identity?.service !== "identity" ||
    identity?.revision !== process.env.EXPECTED_IDENTITY_REVISION
  ) fail();
  const response = await fetch("http://127.0.0.1:4900/internal/v1/auth/introspect", {
    method: "POST",
    headers: {
      authorization: "Bearer operations-cutover-invalid-control",
      "x-winwidget-service": "operations",
      "x-winwidget-internal-token": process.env.IDENTITY_OPERATIONS_TOKEN || "",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 401) fail();
  process.stdout.write("Identity revision and scoped Operations introspection verified\n");
})().catch(fail);
' || fail 'Identity Operations introspection smoke failed'
}

assert_identity_release_prerequisite() {
  local revision="$1" identity_revision identity_image image_id container_id
  revision="${revision:?}"
  identity_revision="$(read_env_value IDENTITY_REVISION)" ||
    fail 'IDENTITY_REVISION is missing'
  identity_image="$(read_env_value IDENTITY_IMAGE)" ||
    fail 'IDENTITY_IMAGE is missing'
  [[ "$revision" =~ ^[0-9a-f]{40}$ &&
    "$identity_revision" == "$revision" &&
    "$identity_image" == "winwidget-identity:git-$revision" ]] ||
    fail 'Identity image and revision must match the exact Operations cutover revision'
  image_id="$(docker image inspect --format '{{.Id}}' "$identity_image")" ||
    fail 'Identity image is unavailable after the coordinated build'
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
    "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$identity_image")" == "$revision" ]] ||
    fail 'Identity image revision label is invalid'

  compose up -d --no-deps --no-build --force-recreate identity-api
  wait_ready 'http://127.0.0.1:4900/health/ready' 'Identity API prerequisite'
  container_id="$(compose ps --status running -q identity-api)" ||
    fail 'Identity API prerequisite container cannot be resolved'
  [[ -n "$container_id" &&
    "$(docker inspect --format '{{.Image}}' "$container_id")" == "$image_id" ]] ||
    fail 'Identity API prerequisite did not start the exact cutover image'
  compose exec -T -e EXPECTED_IDENTITY_REVISION="$revision" identity-api node -e '
const fail = () => process.exit(1);
(async () => {
  const revision = await fetch("http://127.0.0.1:4900/health/revision", {
    signal: AbortSignal.timeout(5000),
  });
  if (!revision.ok) fail();
  const identity = await revision.json();
  if (
    identity?.service !== "identity" ||
    identity?.revision !== process.env.EXPECTED_IDENTITY_REVISION
  ) fail();
  const response = await fetch("http://127.0.0.1:4900/internal/v1/auth/introspect", {
    method: "POST",
    headers: {
      authorization: "Bearer operations-cutover-invalid-control",
      "x-winwidget-service": "operations",
      "x-winwidget-internal-token": process.env.IDENTITY_OPERATIONS_TOKEN || "",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 401) fail();
  process.stdout.write("Exact Identity cutover image and Operations scope verified\n");
})().catch(fail);
' || fail 'Identity current-revision Operations scope prerequisite failed'
}

identity_operations_overview_smoke() {
  local revision="$1"
  compose exec -T -e OPERATIONS_CUTOVER_REVISION="$revision" identity-api node -e '
const fail = () => process.exit(1);
(async () => {
  const response = await fetch(
    `http://127.0.0.1:5200/internal/v1/identity/users/operations-cutover-smoke-${process.env.OPERATIONS_CUTOVER_REVISION}/admin-events/overview`,
    {
      headers: {
        "x-winwidget-service": "identity",
        "x-winwidget-internal-token": process.env.OPERATIONS_IDENTITY_TOKEN || "",
      },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) fail();
  const value = await response.json();
  if (!value || Object.keys(value).length !== 1 || !Array.isArray(value.latest)) fail();
  process.stdout.write("Identity to Operations overview contract verified\n");
})().catch(fail);
' || fail 'Identity to Operations overview smoke failed'
}

assert_integration_runtime() {
  local revision="$1" container_id image
  container_id="$(compose ps -q integration-worker)"
  [[ -n "$container_id" &&
    "$(docker inspect --format '{{.State.Running}}' "$container_id")" == true ]] ||
    fail 'integration-worker is not running'
  image="$(docker inspect --format '{{.Image}}' "$container_id")"
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$revision" ]] ||
    fail 'integration-worker image revision is stale'
  docker exec --interactive \
    --env "OPERATIONS_EXPECTED_REVISION=$revision" \
    --env "OPERATIONS_EXPECTED_KINDS=$OPERATIONS_STEADY_INTEGRATION_KINDS" \
    "$container_id" node - <<'NODE'
if (
  process.env.APP_REVISION !== process.env.OPERATIONS_EXPECTED_REVISION ||
  process.env.INTEGRATION_WORKER_KINDS !== process.env.OPERATIONS_EXPECTED_KINDS
) process.exit(1);
NODE
}

provision_rabbitmq() {
  local revision="$1" image image_revision
  local admin_user admin_password management_url vhost worker_url publisher_url
  local integration_url

  image="$(read_env_value OPERATIONS_IMAGE)" ||
    fail 'OPERATIONS_IMAGE is missing'
  image_revision="$(read_env_value OPERATIONS_REVISION)" ||
    fail 'OPERATIONS_REVISION is missing'
  [[ "$image_revision" == "$revision" &&
    "$image" == "winwidget-operations:git-$revision" ]] ||
    fail 'Operations image and revision must match the cutover revision'
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$revision" ]] ||
    fail 'Operations image revision label is invalid'

  admin_user="$(read_env_value RABBITMQ_ADMIN_USER)" ||
    fail 'RABBITMQ_ADMIN_USER is missing'
  admin_password="$(read_env_value RABBITMQ_ADMIN_PASSWORD)" ||
    fail 'RABBITMQ_ADMIN_PASSWORD is missing'
  management_url="$(read_env_value RABBITMQ_MANAGEMENT_URL)" ||
    fail 'RABBITMQ_MANAGEMENT_URL is missing'
  vhost="$(read_env_value RABBITMQ_VHOST)" ||
    fail 'RABBITMQ_VHOST is missing'
  worker_url="$(read_env_value RABBITMQ_OPERATIONS_WORKER_URL)" ||
    fail 'RABBITMQ_OPERATIONS_WORKER_URL is missing'
  publisher_url="$(read_env_value RABBITMQ_OPERATIONS_PUBLISHER_URL)" ||
    fail 'RABBITMQ_OPERATIONS_PUBLISHER_URL is missing'
  integration_url="$(read_env_value RABBITMQ_INTEGRATION_WORKER_URL)" ||
    fail 'RABBITMQ_INTEGRATION_WORKER_URL is missing'

  RABBITMQ_ADMIN_USER="$admin_user" \
  RABBITMQ_ADMIN_PASSWORD="$admin_password" \
  RABBITMQ_MANAGEMENT_URL="$management_url" \
  RABBITMQ_VHOST="$vhost" \
  RABBITMQ_OPERATIONS_WORKER_URL="$worker_url" \
  RABBITMQ_OPERATIONS_PUBLISHER_URL="$publisher_url" \
  RABBITMQ_INTEGRATION_WORKER_URL="$integration_url" \
  OPERATIONS_STEADY_INTEGRATION_READ_PATTERN="$OPERATIONS_STEADY_INTEGRATION_READ_PATTERN" \
    docker run --rm --network host --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 \
      --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 \
      --log-driver none \
      --env RABBITMQ_ADMIN_USER \
      --env RABBITMQ_ADMIN_PASSWORD \
      --env RABBITMQ_MANAGEMENT_URL \
      --env RABBITMQ_VHOST \
      --env RABBITMQ_OPERATIONS_WORKER_URL \
      --env RABBITMQ_OPERATIONS_PUBLISHER_URL \
      --env RABBITMQ_INTEGRATION_WORKER_URL \
      --env OPERATIONS_STEADY_INTEGRATION_READ_PATTERN \
      --entrypoint node "$image" -e '
const amqp = require("amqplib");

const value = name => process.env[name] || "";
const fail = () => {
  throw new Error("Operations RabbitMQ provisioning failed");
};
const adminUser = value("RABBITMQ_ADMIN_USER");
const adminPassword = value("RABBITMQ_ADMIN_PASSWORD");
const managementUrl = value("RABBITMQ_MANAGEMENT_URL").replace(/\/$/, "");
const vhost = value("RABBITMQ_VHOST");
if (
  !/^[A-Za-z0-9._-]+$/.test(adminUser) ||
  adminPassword.length < 32 || /[\0\r\n]/.test(adminPassword) ||
  managementUrl !== "http://127.0.0.1:15672" ||
  vhost !== "winwidget"
) fail();

const parseService = (name, expectedUser) => {
  let url;
  try { url = new URL(value(name)); } catch { fail(); }
  let username;
  let password;
  let decodedVhost;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    decodedVhost = decodeURIComponent(url.pathname.slice(1));
  } catch { fail(); }
  if (
    url.protocol !== "amqp:" || url.hostname !== "127.0.0.1" ||
    (url.port && url.port !== "5672") || url.search || url.hash ||
    username !== expectedUser || decodedVhost !== vhost ||
    password.length < 32 || /[\0\r\n]/.test(password) ||
    /^(?:change_me|change-me|ci_)/.test(password)
  ) fail();
  return { username, password };
};

const worker = parseService(
  "RABBITMQ_OPERATIONS_WORKER_URL",
  "winwidget-operations-worker",
);
const publisher = parseService(
  "RABBITMQ_OPERATIONS_PUBLISHER_URL",
  "winwidget-operations-publisher",
);
const integration = parseService(
  "RABBITMQ_INTEGRATION_WORKER_URL",
  "winwidget-integration",
);
if (new Set([
  adminUser,
  worker.username,
  publisher.username,
  integration.username,
]).size !== 4) fail();

const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
const request = async (path, options = {}, expected = [200, 201, 204]) => {
  const response = await fetch(`${managementUrl}${path}`, {
    ...options,
    headers: {
      authorization,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!expected.includes(response.status)) fail();
  if (response.status === 204) return null;
  return response.json();
};
const encoded = value => encodeURIComponent(value);
const connectionOptions = (username, password, name) => ({
    protocol: "amqp",
    hostname: "127.0.0.1",
    port: 5672,
    username,
    password,
    vhost,
    clientProperties: { connection_name: name },
});
const connect = async (username, password, name) => {
  const connection = await amqp.connect(
    connectionOptions(username, password, name),
    { timeout: 10_000 },
  );
  await connection.close();
};

const provisionTopology = async () => {
  const {
    getOperationsAuditDeadLetterQueue,
    getOperationsAuditDeadLetterRoutingKey,
    getOperationsAuditManualRetryRoutingKey,
    getOperationsAuditQueue,
    getOperationsAuditRetryQueue,
    getOperationsAuditRetryRoutingKey,
	OPERATIONS_AUDIT_DLQ_RETENTION_MS,
    OPERATIONS_AUDIT_SOURCES,
    OPERATIONS_DEAD_LETTER_EXCHANGE,
    OPERATIONS_EVENTS_EXCHANGE,
    OPERATIONS_MANUAL_RETRY_EXCHANGE,
    OPERATIONS_RETRY_EXCHANGE,
  } = require("./dist/src/messaging/operations-messaging.constants.js");
  const expectedBindings = new Map();
  const connection = await amqp.connect(
    connectionOptions(
      adminUser,
      adminPassword,
      "winwidget-operations-cutover-topology-owner",
    ),
    { timeout: 10_000 },
  );
  try {
    const channel = await connection.createChannel();
    try {
      await channel.assertExchange(OPERATIONS_EVENTS_EXCHANGE, "topic", {
        durable: true,
      });
      await channel.assertExchange(OPERATIONS_RETRY_EXCHANGE, "direct", {
        durable: true,
      });
      await channel.assertExchange(OPERATIONS_DEAD_LETTER_EXCHANGE, "topic", {
        durable: true,
      });
      await channel.assertExchange(OPERATIONS_MANUAL_RETRY_EXCHANGE, "direct", {
        durable: true,
      });
      for (const source of OPERATIONS_AUDIT_SOURCES) {
        const queue = getOperationsAuditQueue(source);
        const retryQueue = getOperationsAuditRetryQueue(source);
        const deadLetterQueue = getOperationsAuditDeadLetterQueue(source);
        const deadLetterRoutingKey =
          getOperationsAuditDeadLetterRoutingKey(source);
        await channel.assertQueue(queue, {
          durable: true,
          arguments: {
            "x-dead-letter-exchange": OPERATIONS_DEAD_LETTER_EXCHANGE,
            "x-dead-letter-routing-key": deadLetterRoutingKey,
          },
        });
        await channel.bindQueue(
          queue,
          OPERATIONS_EVENTS_EXCHANGE,
          source.routingKey,
        );
        await channel.bindQueue(
          queue,
          OPERATIONS_MANUAL_RETRY_EXCHANGE,
          getOperationsAuditManualRetryRoutingKey(source),
        );
        await channel.assertQueue(retryQueue, {
          durable: true,
          arguments: {
            "x-dead-letter-exchange": OPERATIONS_EVENTS_EXCHANGE,
            "x-dead-letter-routing-key": source.routingKey,
          },
        });
        await channel.bindQueue(
          retryQueue,
          OPERATIONS_RETRY_EXCHANGE,
          getOperationsAuditRetryRoutingKey(source),
        );
        await channel.assertQueue(deadLetterQueue, {
          durable: true,
          arguments: {
            "x-message-ttl": OPERATIONS_AUDIT_DLQ_RETENTION_MS,
          },
        });
        await channel.bindQueue(
          deadLetterQueue,
          OPERATIONS_DEAD_LETTER_EXCHANGE,
          deadLetterRoutingKey,
        );
        expectedBindings.set(queue, [
          [OPERATIONS_EVENTS_EXCHANGE, source.routingKey],
          [
            OPERATIONS_MANUAL_RETRY_EXCHANGE,
            getOperationsAuditManualRetryRoutingKey(source),
          ],
        ]);
        expectedBindings.set(retryQueue, [[
          OPERATIONS_RETRY_EXCHANGE,
          getOperationsAuditRetryRoutingKey(source),
        ]]);
        expectedBindings.set(deadLetterQueue, [[
          OPERATIONS_DEAD_LETTER_EXCHANGE,
          deadLetterRoutingKey,
        ]]);
      }
    } finally {
      await channel.close();
    }
  } finally {
    await connection.close();
  }
  for (const [queue, expected] of expectedBindings) {
    const bindings = await request(
      `/api/queues/${encoded(vhost)}/${encoded(queue)}/bindings`,
    );
    if (!Array.isArray(bindings)) fail();
    const actual = bindings
      .filter(binding => binding?.source)
      .map(binding => [
        binding.source,
        binding.routing_key,
        binding.destination_type,
        binding.destination,
        binding.arguments,
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const canonicalExpected = expected
      .map(([source, routingKey]) => [source, routingKey, "queue", queue, {}])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (JSON.stringify(actual) !== JSON.stringify(canonicalExpected)) fail();
  }
};

const queuePattern = "winwidget\\.operations\\.admin\\.audit\\.(campaigns|reporting|widgets|billing|identity|platform|support|core)\\.v1(?:\\.retry-v1|\\.dead-letter)?";
const users = [
  {
    ...worker,
    configure: `^(winwidget\\.(events|retry|dead-letter|manual-retry)|${queuePattern})$`,
    write: "^winwidget\\.(retry|dead-letter)$",
    read: `^${queuePattern}$`,
    topics: [
      {
        exchange: "winwidget.dead-letter",
        write: "^operations\\.admin\\.audit\\.(campaigns|reporting|widgets|billing|identity|platform|support|core)\\.dead-letter\\.v1$",
        read: "^$",
      },
    ],
  },
  {
    ...publisher,
    configure: "^$",
    write: "^winwidget\\.(events|manual-retry)$",
    read: "^$",
    topics: [{
      exchange: "winwidget.events",
      write: "^operations\\.[a-z0-9.-]+\\.v1$",
      read: "^$",
    }],
  },
  {
    ...integration,
    configure: "^$",
    write: "^(winwidget\\.retry|winwidget\\.dead-letter)$",
    read: value("OPERATIONS_STEADY_INTEGRATION_READ_PATTERN"),
    topics: [],
  },
];

(async () => {
  await connect(adminUser, adminPassword, "winwidget-operations-cutover-admin-check");
  await provisionTopology();
  for (const user of users) {
    await request(`/api/users/${encoded(user.username)}`, {
      method: "PUT",
      body: JSON.stringify({ password: user.password, tags: "" }),
    });
    const permissions = await request(`/api/users/${encoded(user.username)}/permissions`);
    if (!Array.isArray(permissions)) fail();
    for (const permission of permissions) {
      if (permission?.vhost === vhost) continue;
      await request(
        `/api/permissions/${encoded(permission.vhost)}/${encoded(user.username)}`,
        { method: "DELETE" },
      );
    }
    await request(`/api/permissions/${encoded(vhost)}/${encoded(user.username)}`, {
      method: "PUT",
      body: JSON.stringify({
        configure: user.configure,
        write: user.write,
        read: user.read,
      }),
    });
    const topics = await request(
      `/api/topic-permissions/${encoded(vhost)}/${encoded(user.username)}`,
    );
    if (!Array.isArray(topics)) fail();
    for (const topic of topics) {
      await request(
        `/api/topic-permissions/${encoded(vhost)}/${encoded(user.username)}/${encoded(topic.exchange)}`,
        { method: "DELETE" },
      );
    }
    for (const topic of user.topics) {
      await request(
        `/api/topic-permissions/${encoded(vhost)}/${encoded(user.username)}`,
        { method: "PUT", body: JSON.stringify(topic) },
      );
    }
    await connect(
      user.username,
      user.password,
      `winwidget-operations-cutover-${user.username}-check`,
    );
  }
  process.stdout.write("Operations RabbitMQ users and permissions verified\n");
})().catch(() => {
  process.stderr.write("Operations RabbitMQ provisioning failed\n");
  process.exitCode = 1;
});
' || fail 'Operations RabbitMQ provisioning failed'
}

status() {
  local core_status target_status
  core_status="$(root_cutover status)"
  target_status="$(target_cutover status)"
  OPERATIONS_CORE_STATUS="$core_status" \
    OPERATIONS_TARGET_STATUS="$target_status" billing_release_node - <<'NODE'
const core = JSON.parse(process.env.OPERATIONS_CORE_STATUS || 'null');
const target = JSON.parse(process.env.OPERATIONS_TARGET_STATUS || 'null');
if (core?.source === 'removed') {
  if (
    target?.phase !== 'ACTIVE' ||
    !/^[0-9a-f]{40}$/.test(target.sourceRevision || '') ||
    !/^[0-9a-f]{64}$/.test(target.snapshotSha256 || '') ||
    !Number.isSafeInteger(target.notes) || target.notes < 0 ||
    !Number.isSafeInteger(target.adminEventLogs) || target.adminEventLogs < 0
  ) process.exit(1);
}
NODE
  printf 'Core: %s\nOperations: %s\n' "$core_status" "$target_status"
}

cutover() {
  local revision="$1" artifact_dir snapshot_host snapshot_container
  local export_json sha256 note_count event_count
  local fence_started=false

  trap 'if [[ "$fence_started" == true ]]; then printf "%s\n" "Operations cutover stopped after the Core write fence; continue forward and do not re-enable Core writes." >&2; fi' ERR

  assert_inputs
  assert_checkout "$revision"
  export_coordinated_revision "$revision"
  assert_steady_integration_contract

  # shellcheck source=scripts/production-deploy-lock.sh
  source "$SERVER_ROOT/scripts/production-deploy-lock.sh"
  acquire_production_deploy_lock 'Operations hard cutover'

  # The pending Operations prepare migration must never share the destructive
  # Platform cleanup revision. Platform cleanup is completed and sealed on an
  # immutable ancestor before any Operations database or Core mutation starts.
  assert_platform_cleanup_complete "$revision"

  # This gate only proves that the independently controlled restore path is
  # disabled and quiescent. It does not require a Core backup or restore run.
  # shellcheck source=scripts/database-restore-production-guard.sh
  source "$SERVER_ROOT/scripts/database-restore-production-guard.sh"
  database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"

  artifact_dir="$(read_env_value OPERATIONS_CUTOVER_ARTIFACT_DIR)" ||
    fail 'OPERATIONS_CUTOVER_ARTIFACT_DIR is missing'
  [[ "$artifact_dir" == "$APP_ROOT"/deploy/backend/operations-cutover ]] ||
    fail 'Operations artifact directory must use the exact deploy/backend path'
  [[ ! -L "$artifact_dir" &&
    (! -e "$artifact_dir" || -d "$artifact_dir") ]] ||
    fail 'Operations artifact directory is not a safe directory'
  mkdir -p "$artifact_dir"
  [[ "$(cd -- "$artifact_dir" && pwd -P)" == "$artifact_dir" ]] ||
    fail 'Operations artifact directory has a non-canonical path'
  chown 0:1001 "$artifact_dir"
  chmod 770 "$artifact_dir"
  [[ "$(stat -c '%u:%g:%a:%h' "$artifact_dir")" == '0:1001:770:2' ]] ||
    fail 'Operations artifact directory is unsafe'
  snapshot_host="$artifact_dir/operations-$revision.json"
  snapshot_container="$CONTAINER_ARTIFACT_DIR/operations-$revision.json"
  [[ ! -e "$snapshot_host" && ! -L "$snapshot_host" ]] ||
    fail 'cutover snapshot already exists; inspect state before continuing'

  compose build --provenance=false \
    api api-gateway maintenance-worker database-restore-worker \
    notification-delivery-worker campaigns-service reporting-service \
    widgets-service billing-api identity-api platform-api support-api \
    operations-api
  assert_identity_release_prerequisite "$revision"
  OPERATIONS_ENV_FILE="$ENV_FILE" \
    bash "$SERVER_ROOT/scripts/operations-database-prepare.sh" --prepare
  compose --profile migration run --rm --no-deps migrate
  root_cutover prepare --revision "$revision"
  rabbit_queue_snapshot > /dev/null

  # Hard-downtime handoff: freeze every audit source while the legacy
  # integration-worker drains its already-bound audit queues. DLQs are never
  # purged and pending source Outbox rows remain durable until restart.
  stop_audit_source_services
  # The third legacy retry tier has a 30-minute TTL. Keep the publishers
  # frozen and allow every retained retry to return to its main queue.
  wait_queue_state legacy-drained 'legacy audit queues' 1050
  compose stop --timeout 30 integration-worker
  wait_queue_state legacy-stopped 'stopped legacy audit queues'
  wait_queue_state operations-prebind 'pre-existing Operations queues'
  retire_drained_legacy_audit_queues

  provision_rabbitmq "$revision"
  compose up -d --no-deps identity-api
  compose up -d --no-deps \
    operations-api operations-worker operations-outbox-publisher
  wait_ready 'http://127.0.0.1:4900/health/ready' 'Identity API'
  wait_operations_ready 'http://127.0.0.1:5200/health/ready' api "$revision"
  wait_operations_ready 'http://127.0.0.1:5201/health/ready' worker "$revision"
  wait_operations_ready 'http://127.0.0.1:5202/health/ready' outbox-publisher "$revision"
  identity_introspection_smoke "$revision"

  compose stop --timeout 30 \
    operations-api operations-worker operations-outbox-publisher
  root_cutover fence --revision "$revision"
  fence_started=true
  export_json="$(root_cutover export \
    --revision "$revision" \
    --file "$snapshot_container")"
  read -r sha256 note_count event_count < <(
    OPERATIONS_EXPORT_JSON="$export_json" billing_release_node - <<'NODE'
const value = JSON.parse(process.env.OPERATIONS_EXPORT_JSON);
if (
  value.exported !== true ||
  !/^[0-9a-f]{64}$/.test(value.sha256 || '') ||
  !Number.isSafeInteger(value.notes) || value.notes < 0 ||
  !Number.isSafeInteger(value.events) || value.events < 0
) process.exit(1);
process.stdout.write(`${value.sha256} ${value.notes} ${value.events}\n`);
NODE
  ) || fail 'Core export result is invalid'
  unset export_json
  [[ -f "$snapshot_host" && ! -L "$snapshot_host" ]] ||
    fail 'Core snapshot was not created on the host'
  [[ "$(stat -c '%u:%g:%a:%h' "$snapshot_host")" == '1001:1001:600:1' ]] ||
    fail 'Core snapshot identity or mode is unsafe'

  target_cutover import \
    --file "$snapshot_container" \
    --sha256 "$sha256"
  target_cutover activate --sha256 "$sha256"
  root_cutover activate \
    --revision "$revision" \
    --sha256 "$sha256" \
    --notes "$note_count" \
    --events "$event_count"
  run_core_source_cleanup "$revision" "$sha256" "$note_count" "$event_count"

  start_cutover_services
  wait_operations_ready 'http://127.0.0.1:5200/health/ready' api "$revision"
  wait_operations_ready 'http://127.0.0.1:5201/health/ready' worker "$revision"
  wait_operations_ready 'http://127.0.0.1:5202/health/ready' outbox-publisher "$revision"
  wait_ready 'http://127.0.0.1:4900/health/ready' 'Identity API'
  wait_ready 'http://127.0.0.1:4100/health/ready' 'Gateway'
  identity_operations_overview_smoke "$revision"
  assert_integration_runtime "$revision"
  wait_queue_state steady 'Operations and steady integration consumers'
  fence_started=false
  trap - ERR

  printf 'Operations ownership is active at revision %s and the legacy Core source is removed.\n' "$revision"
}

self_test() {
  local revision='a234567890123456789012345678901234567890'
  local source source_without_backslashes cutover_source cleanup_sql
  local node_runtime_source self_test_server_root index
  local -a source_contracts normalized_source_contracts cutover_contracts
  local -a forbidden_source_contracts
  source="$(declare -f \
    assert_steady_integration_contract \
    assert_platform_cleanup_complete \
    export_coordinated_revision \
    stop_audit_source_services \
    queue_state_matches \
    retire_drained_legacy_audit_queues \
    identity_introspection_smoke \
    assert_identity_release_prerequisite \
    identity_operations_overview_smoke \
    assert_integration_runtime \
    run_core_source_cleanup \
    provision_rabbitmq \
    status \
    cutover)"
  source_without_backslashes="${source//\\/}"
  cutover_source="$(declare -f cutover)"
  node_runtime_source="$(declare -f \
    read_env_value \
    wait_operations_ready \
    queue_state_matches \
    retire_drained_legacy_audit_queues \
    status \
    cutover)"
  [[ "$CONFIRMATION" == 'CUT OVER OPERATIONS FORWARD ONLY' ]]
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]]
  [[ "$CONTAINER_ARTIFACT_DIR" == '/var/lib/winwidget/operations-cutover' ]]
  if (export_coordinated_revision latest) >/dev/null 2>&1; then
    return 1
  fi
  (
    export_coordinated_revision "$revision"
    [[ "$APP_REVISION" == "$revision" &&
      "$APP_VERSION" == "git-$revision" &&
      "$MAINTENANCE_REVISION" == "$revision" &&
      "$MAINTENANCE_IMAGE" == "winwidget-maintenance:git-$revision" &&
      "$DATABASE_RESTORE_REVISION" == "$revision" &&
      "$DATABASE_RESTORE_IMAGE" == "winwidget-database-restore:git-$revision" &&
      "$NOTIFICATION_DELIVERY_REVISION" == "$revision" &&
      "$NOTIFICATION_DELIVERY_IMAGE" == "winwidget-notification-delivery:git-$revision" &&
      "$CAMPAIGNS_REVISION" == "$revision" &&
      "$CAMPAIGNS_IMAGE" == "winwidget-campaigns:git-$revision" &&
      "$REPORTING_REVISION" == "$revision" &&
      "$REPORTING_IMAGE" == "winwidget-reporting:git-$revision" &&
      "$WIDGETS_REVISION" == "$revision" &&
      "$WIDGETS_IMAGE" == "winwidget-widgets:git-$revision" &&
      "$BILLING_REVISION" == "$revision" &&
      "$BILLING_IMAGE" == "winwidget-billing:git-$revision" &&
      "$IDENTITY_REVISION" == "$revision" &&
      "$IDENTITY_IMAGE" == "winwidget-identity:git-$revision" &&
      "$PLATFORM_REVISION" == "$revision" &&
      "$PLATFORM_IMAGE" == "winwidget-platform:git-$revision" &&
      "$SUPPORT_REVISION" == "$revision" &&
      "$SUPPORT_IMAGE" == "winwidget-support:git-$revision" &&
      "$OPERATIONS_REVISION" == "$revision" &&
      "$OPERATIONS_IMAGE" == "winwidget-operations:git-$revision" ]]
  )
  source_contracts=(
    'winwidget-operations-worker'
    'winwidget-operations-publisher'
    'winwidget-operations:git-$revision'
    'winwidget-integration'
    'Operations cutover requires completed Platform cleanup at an immutable ancestor revision'
    'OPERATIONS_STEADY_INTEGRATION_READ_PATTERN'
    'OPERATIONS_STEADY_INTEGRATION_KINDS'
    'const provisionTopology = async () => {'
    'operations-messaging.constants.js'
    'await channel.bindQueue('
    '/bindings`'
    'JSON.stringify(actual) !== JSON.stringify(canonicalExpected)'
    'await provisionTopology();'
    'read: `^${queuePattern}$`'
    '--env RABBITMQ_ADMIN_PASSWORD'
    'chown 0:1001 "$artifact_dir"'
    "'1001:1001:600:1'"
    'legacy-drained'
    'legacy-absent'
    'operations-prebind'
    'delete_queue'
    '--if-empty'
    '--if-unused'
    '/app/prisma/post-cutover/operations/20260825010000_remove_legacy_operations_core_source.sql'
    'url.port !== "55434"'
    'delete env.DATABASE_URL'
    'winwidget.operations_source_cleanup=approved'
    'winwidget.operations_core_stopped=true'
    'lock_timeout=60000'
    'statement_timeout=300000'
    'database-restore-production-guard.sh'
    'database_restore_guard_assert_before_mutation service-owned-required'
    'Source writer $service must remain stopped'
    'OPERATIONS_AUDIT_DLQ_RETENTION_MS'
    "target?.phase !== 'ACTIVE'"
    'operations-cutover-invalid-control'
    '"winwidget-identity:git-$revision"'
    'org.opencontainers.image.revision'
    'up -d --no-deps --no-build --force-recreate identity-api'
    'Identity image and revision must match the exact Operations cutover revision'
    'Exact Identity cutover image and Operations scope verified'
    'Identity to Operations overview contract verified'
    'docker exec --interactive'
    'process.env.APP_REVISION !== process.env.OPERATIONS_EXPECTED_REVISION'
  )
  normalized_source_contracts=(
    'winwidget.operations.admin.audit.(campaigns|reporting|widgets|billing|identity|platform|support|core).v1(?:.retry-v1|.dead-letter)?'
    'write: "^winwidget.(retry|dead-letter)$"'
    'winwidget.(events|retry|dead-letter|manual-retry)'
    'winwidget.(events|manual-retry)'
  )
  cutover_contracts=(
    'assert_platform_cleanup_complete "$revision"'
    'database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"'
  )
  forbidden_source_contracts=(
    '--env "RABBITMQ_ADMIN_PASSWORD='
    '--env DATABASE_URL'
    '--env "DATABASE_URL='
  )
  for index in "${!source_contracts[@]}"; do
    [[ "$source" == *"${source_contracts[$index]}"* ]] || {
      printf 'operations-cutover self-test source contract %s is missing\n' "$index" >&2
      return 1
    }
  done
  for index in "${!normalized_source_contracts[@]}"; do
    [[ "$source_without_backslashes" == *"${normalized_source_contracts[$index]}"* ]] || {
      printf 'operations-cutover self-test normalized source contract %s is missing\n' "$index" >&2
      return 1
    }
  done
  for index in "${!cutover_contracts[@]}"; do
    [[ "$cutover_source" == *"${cutover_contracts[$index]}"* ]] || {
      printf 'operations-cutover self-test cutover contract %s is missing\n' "$index" >&2
      return 1
    }
  done
  for index in "${!forbidden_source_contracts[@]}"; do
    [[ "$source" != *"${forbidden_source_contracts[$index]}"* ]] || {
      printf 'operations-cutover self-test forbidden source contract %s is present\n' "$index" >&2
      return 1
    }
  done
  [[ "$(grep -c 'billing_release_node -' <<<"$node_runtime_source")" == '6' ]]
  if grep -Eq '(^|[;&|][[:space:]]+|[[:space:]])node[[:space:]]+(-[[:space:]]+)?<<' \
    <<<"$node_runtime_source"; then
    return 1
  fi
  OPERATIONS_CUTOVER_SOURCE="$cutover_source" billing_release_node - <<'NODE'
const source = process.env.OPERATIONS_CUTOVER_SOURCE || '';
const markers = [
  'assert_checkout "$revision"',
  'export_coordinated_revision "$revision"',
  'assert_steady_integration_contract',
  'database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"',
  'compose build --provenance=false',
  'assert_identity_release_prerequisite "$revision"',
  'stop_audit_source_services',
  'wait_queue_state legacy-drained',
  'compose stop --timeout 30 integration-worker',
  'wait_queue_state legacy-stopped',
  'wait_queue_state operations-prebind',
  'retire_drained_legacy_audit_queues',
  'provision_rabbitmq "$revision"',
  'identity_introspection_smoke "$revision"',
  'root_cutover fence',
  'root_cutover activate',
  'run_core_source_cleanup "$revision" "$sha256" "$note_count" "$event_count"',
  'start_cutover_services',
  'identity_operations_overview_smoke',
  'wait_queue_state steady',
];
let previous = -1;
for (const marker of markers) {
  const index = source.indexOf(marker, previous + 1);
  if (index < 0) process.exit(1);
  previous = index;
}
NODE
  self_test_server_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
  cleanup_sql="$(<"$self_test_server_root/prisma/post-cutover/operations/20260825010000_remove_legacy_operations_core_source.sql")"
  OPERATIONS_CLEANUP_SQL="$cleanup_sql" billing_release_node - <<'NODE'
const sql = process.env.OPERATIONS_CLEANUP_SQL || '';
const approval = sql.indexOf('Operations Core cleanup requires exact approval');
const lock = sql.indexOf('LOCK TABLE "public"."notes", "public"."admin_event_logs"');
const count = sql.indexOf('SELECT count(*) FROM "public"."notes"');
const drop = sql.indexOf('DROP TABLE "public"."notes"');
const absence = sql.indexOf('Legacy Operations Core source remains after cleanup');
const commit = sql.indexOf('COMMIT;');
if (
  approval < 0 || lock <= approval || count <= lock || drop <= count ||
  absence <= drop || commit <= absence ||
  !sql.includes('DROP TYPE "public"."OperationsCoreOwnership"')
) process.exit(1);
NODE
  printf 'operations-cutover self-test passed\n'
}

main() {
  case "${1:-}" in
    --self-test)
      self_test
      ;;
    --status)
      status
      ;;
    --cutover)
      [[ -n "${EXPECTED_REVISION:-}" ]] || fail 'EXPECTED_REVISION is required'
      cutover "$EXPECTED_REVISION"
      ;;
    *)
      fail 'usage: operations-cutover-production.sh --self-test|--status|--cutover'
      ;;
  esac
}

main "$@"
