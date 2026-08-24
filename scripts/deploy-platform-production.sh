#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PLATFORM_DEPLOY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"

# shellcheck source=scripts/platform-release-identity.sh
declare -F platform_release_compose >/dev/null ||
	source "$PLATFORM_DEPLOY_ROOT/scripts/platform-release-identity.sh"
# shellcheck source=scripts/platform-cutover-production.sh
declare -F platform_cutover_provision_publisher >/dev/null ||
	source "$PLATFORM_DEPLOY_ROOT/scripts/platform-cutover-production.sh"
# shellcheck source=scripts/production-deploy-lock.sh
declare -F acquire_production_deploy_lock >/dev/null ||
	source "$PLATFORM_DEPLOY_ROOT/scripts/production-deploy-lock.sh"

platform_deploy_fail() {
	printf '%s\n' "$1" >&2
	return 1
}

platform_deploy_require_active() {
	[[ "$(id -u)" == 0 ]] || platform_deploy_fail 'Platform deploy must run as root.' || return 1
	platform_database_require_inputs || return 1
	platform_release_validate_revision "$EXPECTED_REVISION" || return 1
	platform_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION" || return 1
	platform_release_validate_file "$ENV_FILE" || return 1
	platform_release_validate_file "$COMPOSE_FILE" || return 1
	platform_cutover_validate_paths || return 1
	platform_cutover_validate_marker || return 1
	[[ "$(platform_cutover_marker_value phase)" == complete ]] ||
		platform_deploy_fail 'Routine Platform deploy requires completed ownership.' || return 1
	platform_database_validate_marker || return 1
	[[ "$(platform_database_current_phase)" == complete ]] ||
		platform_deploy_fail 'Routine Platform deploy requires completed database lifecycle.' || return 1
	[[ "$(platform_cutover_marker_value revision)" == \
		"$(platform_database_marker_value revision)" &&
		"$(platform_cutover_marker_value generation)" == \
		"$(platform_database_marker_value generation)" &&
		"$(platform_cutover_marker_value image_id)" == \
		"$(platform_database_marker_value image_id)" &&
		"$(platform_cutover_marker_value database_id)" == \
		"$(platform_database_marker_value database_id)" &&
		"$(platform_cutover_marker_value database_system_identifier)" == \
		"$(platform_database_marker_value database_system_identifier)" ]] ||
		platform_deploy_fail 'Platform ownership and database markers are not the same completed lifecycle.' || return 1
	platform_cutover_assert_phase_a_artifacts_retired || return 1
	for key in snapshot_sha256 source_fingerprint \
		imported_backup_sha256 active_backup_sha256; do
		[[ "$(platform_cutover_marker_value "$key")" =~ ^[0-9a-f]{64}$ ]] ||
			platform_deploy_fail "Completed Platform marker has no sealed $key evidence." || return 1
	done
	[[ "$(platform_cutover_marker_value source_high_watermark)" =~ ^[1-9][0-9]*$ ]] ||
		platform_deploy_fail 'Completed Platform marker has no source high-water evidence.' || return 1
	git -C "$SERVER_ROOT" merge-base --is-ancestor \
		"$(platform_cutover_marker_value revision)" "$EXPECTED_REVISION" ||
		platform_deploy_fail 'Routine Platform deploy would precede the completed ownership revision.' || return 1
	platform_database_assert_marker_identity
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
}

platform_deploy_gateway_manifest_validator_source() {
	cat <<'NODE'
const { loadConfig } = require("./dist/src/config.js");
const { matchGatewayRoute } = require("./dist/src/server.js");

const fail = () => process.exit(1);
let config;
try {
  config = loadConfig({
    GATEWAY_ROUTES_JSON: process.env.ROUTES,
    CORS_ALLOWED_ORIGINS: "https://gateway-validator.invalid",
    JWT_JWKS_URL: "http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json",
    JWT_ISSUER: "gateway-validator",
    JWT_AUDIENCE: "gateway-validator",
  });
} catch {
  fail();
}

const exact = [
  ["platform-site-settings", "/api/v1/site-settings", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-legal-pages", "/api/v1/legal-pages", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-home-page-content", "/api/v1/home-page-content", "http://127.0.0.1:5000", "optional", 60000],
  ["billing-settings-public", "/api/v1/billing-settings/public", "http://127.0.0.1:4800", "optional", 30000],
  ["billing-settings-admin", "/api/v1/billing-settings/admin", "http://127.0.0.1:4800", "required", 30000],
];
const routes = config.routes;
const monolith = routes.filter(route => route.id === "monolith");
if (monolith.length !== 1 || monolith[0].pathPrefix !== "/api/v1" ||
    monolith[0].upstreamUrl.origin !== "http://127.0.0.1:4200" ||
    monolith[0].authPolicy !== "optional" || monolith[0].timeoutMs !== 60000) fail();

for (const [id, pathPrefix, upstreamOrigin, authPolicy, timeoutMs] of exact) {
  const matching = routes.filter(route => route.id === id);
  if (matching.length !== 1) fail();
  const route = matching[0];
  if (route.pathPrefix !== pathPrefix || route.upstreamUrl.origin !== upstreamOrigin ||
      route.authPolicy !== authPolicy || route.timeoutMs !== timeoutMs) fail();
  for (const pathname of [pathPrefix, `${pathPrefix}/nested/fixture`]) {
    if (matchGatewayRoute(pathname, routes) !== route) fail();
  }
  if (routes.some(candidate => candidate !== route &&
      candidate.pathPrefix.startsWith(`${pathPrefix}/`))) fail();
}

if (routes.filter(route => route.upstreamUrl.origin === "http://127.0.0.1:5000").length !== 3) fail();
if (routes.filter(route => route.pathPrefix === "/api/v1/billing-settings" ||
    route.pathPrefix.startsWith("/api/v1/billing-settings/")).length !== 2) fail();

for (const pathname of [
  "/api/v1/site-settings-legacy",
  "/api/v1/legal-pages-old",
  "/api/v1/home-page-content-preview",
  "/api/v1/billing-settings",
  "/api/v1/billing-settings/unknown",
  "/api/v1/billing-settings-public",
]) {
  if (matchGatewayRoute(pathname, routes) !== monolith[0]) fail();
}
if (matchGatewayRoute("/api/v2/site-settings", routes) !== undefined) fail();
NODE
}

platform_deploy_validate_gateway_manifest() {
	[[ $# -eq 0 ]] || return 1
	local routes gateway_container gateway_image_id gateway_metadata gateway_revision
	local gateway_image_metadata running_routes validator_source
	routes="$(platform_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON)" || return 1
	gateway_container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api-gateway)" || return 1
	[[ "$gateway_container" =~ ^[0-9a-f]{64}$ ]] ||
		platform_deploy_fail 'Exactly one running canonical Gateway is required.' || return 1
	gateway_metadata="$(platform_database_docker inspect --format \
		'{{.Config.Image}}|{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}' \
		"$gateway_container")" || return 1
	IFS='|' read -r _ gateway_image_id gateway_revision _ _ _ _ _ _ _ <<<"$gateway_metadata"
	[[ "$gateway_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$gateway_revision" =~ ^[0-9a-f]{40}$ &&
		"$gateway_metadata" == "winwidget-api-gateway:git-$gateway_revision|$gateway_image_id|$gateway_revision|node|winwidget|api-gateway|False|true|healthy|0" ]] ||
		platform_deploy_fail 'Running Gateway identity or health is unsafe.' || return 1
	gateway_image_metadata="$(platform_database_docker image inspect --format \
		'{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' \
		"$gateway_image_id")" || return 1
	[[ "$gateway_image_metadata" == "$gateway_image_id|$gateway_revision|node" ]] ||
		platform_deploy_fail 'Running Gateway image identity is unsafe.' || return 1
	git -C "$SERVER_ROOT" merge-base --is-ancestor "$gateway_revision" "$EXPECTED_REVISION" ||
		platform_deploy_fail 'Running Gateway revision is not an ancestor of the Platform candidate.' || return 1
	validator_source="$(platform_deploy_gateway_manifest_validator_source)" || return 1
	if ! ROUTES="$routes" platform_database_docker run --rm --network none --read-only \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --cap-drop ALL \
		--security-opt no-new-privileges --pids-limit 64 --env ROUTES \
		--entrypoint node "$gateway_image_id" -e "$validator_source"; then
		platform_deploy_fail 'Candidate Platform Gateway route manifest is invalid.'
		return 1
	fi
	running_routes="$(
		platform_database_docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
			"$gateway_container" | awk '
	        index($0, "GATEWAY_ROUTES_JSON=") == 1 {
	          print substr($0, length("GATEWAY_ROUTES_JSON=") + 1)
	          found += 1
	        }
	        END { exit(found == 1 ? 0 : 1) }
	      '
	)" || platform_deploy_fail 'Running Gateway route manifest is missing or duplicated.' || return 1
	[[ "$running_routes" == "$routes" ]] ||
		platform_deploy_fail 'Running Gateway route manifest differs from the reviewed production env.' || return 1
	[[ "$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api-gateway)" == "$gateway_container" ]] ||
		platform_deploy_fail 'Running Gateway changed while its exact route implementation was validated.'
}

platform_deploy_gateway_manifest_validator_self_test() {
	local self_test_node validator_source
	self_test_node="$(type -P node 2>/dev/null || true)"
	[[ -n "$self_test_node" && -x "$self_test_node" ]] ||
		platform_deploy_fail 'Gateway route validator self-test requires host Node.' || return 1
	validator_source="$(platform_deploy_gateway_manifest_validator_source)" || return 1
	GATEWAY_VALIDATOR_SOURCE="$validator_source" "$self_test_node" - <<'NODE'
const assert = require("node:assert/strict");
const vm = require("node:vm");

const validatorSource = process.env.GATEWAY_VALIDATOR_SOURCE;
assert.ok(validatorSource);
const exact = [
  ["platform-site-settings", "/api/v1/site-settings", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-legal-pages", "/api/v1/legal-pages", "http://127.0.0.1:5000", "optional", 60000],
  ["platform-home-page-content", "/api/v1/home-page-content", "http://127.0.0.1:5000", "optional", 60000],
  ["billing-settings-public", "/api/v1/billing-settings/public", "http://127.0.0.1:4800", "optional", 30000],
  ["billing-settings-admin", "/api/v1/billing-settings/admin", "http://127.0.0.1:4800", "required", 30000],
];
const safeRoutes = [
  ...exact.map(([id, pathPrefix, upstreamUrl, authPolicy, timeoutMs]) => ({
    id, pathPrefix, upstreamUrl, authPolicy, timeoutMs,
  })),
  {
    id: "monolith",
    pathPrefix: "/api/v1",
    upstreamUrl: "http://127.0.0.1:4200",
    authPolicy: "optional",
    timeoutMs: 60000,
  },
];
const matchGatewayRoute = (pathname, routes) => {
  let match;
  for (const route of routes) {
    if ((pathname === route.pathPrefix || pathname.startsWith(`${route.pathPrefix}/`)) &&
        (!match || route.pathPrefix.length > match.pathPrefix.length)) match = route;
  }
  return match;
};
const validates = input => {
  const routes = input.map(route => ({ ...route, upstreamUrl: new URL(route.upstreamUrl) }))
    .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length);
  class ValidatorExit extends Error {}
  try {
    vm.runInNewContext(validatorSource, {
      process: {
        env: { ROUTES: "fixture" },
        exit(code) {
          assert.equal(code, 1);
          throw new ValidatorExit();
        },
      },
      require(name) {
        if (name === "./dist/src/config.js") {
          return {
            loadConfig(env) {
              assert.equal(env.GATEWAY_ROUTES_JSON, "fixture");
              return { routes };
            },
          };
        }
        if (name === "./dist/src/server.js") return { matchGatewayRoute };
        throw new Error(`unexpected module: ${name}`);
      },
    });
    return true;
  } catch (error) {
    if (error instanceof ValidatorExit) return false;
    throw error;
  }
};
const extra = (id, pathPrefix, upstreamUrl = "http://127.0.0.1:4200") => ({
  id,
  pathPrefix,
  upstreamUrl,
  authPolicy: "required",
  timeoutMs: 60000,
});

assert.equal(validates(safeRoutes), true);
assert.equal(validates([
  ...safeRoutes,
  extra("platform-nested-interceptor", "/api/v1/site-settings/private"),
]), false);
assert.equal(validates([
  ...safeRoutes,
  extra("platform-unknown-interceptor", "/api/v1/site-settings-legacy"),
]), false);
assert.equal(validates([
  ...safeRoutes,
  extra("billing-unknown-interceptor", "/api/v1/billing-settings/private"),
]), false);
NODE
}

platform_deploy_assert_runtime() {
	[[ $# -eq 3 && "$2" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local service="$1" image_id="$2" purpose="$3" container metadata
	container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q "$service")" || return 1
	[[ "$container" =~ ^[0-9a-f]{64}$ ]] ||
		platform_deploy_fail "Exactly one running $service container is required." || return 1
	metadata="$(platform_database_docker inspect --format \
		'{{.Config.Image}}|{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{index .Config.Labels "com.winwidget.purpose"}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}' \
		"$container")" || return 1
	[[ "$metadata" == "winwidget-platform:git-$EXPECTED_REVISION|$image_id|$EXPECTED_REVISION|platform|winwidget|$service|False|$purpose|true|healthy|0" ]] ||
		platform_deploy_fail "Running $service image, revision, role, or health is unsafe."
}

platform_deploy_assert_internal_overview() {
	local api_container
	api_container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api)" || return 1
	[[ "$api_container" =~ ^[0-9a-f]{64}$ ]] ||
		platform_deploy_fail 'Exactly one running canonical Core API is required for the Platform internal smoke.' || return 1
	platform_database_docker exec "$api_container" node -e '
const expectedRevision = process.argv[1];
const token = process.env.PLATFORM_CORE_TOKEN || "";
const fail = () => process.exit(1);
if (!/^[0-9a-f]{40}$/.test(expectedRevision) || token.length < 32 ||
    /^(change_me|change-me|ci_)/.test(token)) fail();
fetch("http://127.0.0.1:5000/internal/v1/platform/messaging/overview", {
  headers: {
    accept: "application/json",
    "x-winwidget-service": "core",
    "x-winwidget-internal-token": token,
  },
  redirect: "error",
  signal: AbortSignal.timeout(5000),
}).then(async response => {
  if (response.status !== 200 ||
      !(response.headers.get("cache-control") || "").includes("no-store")) fail();
  const text = await response.text();
  if (Buffer.byteLength(text) > 65536) fail();
  let body;
  try { body = JSON.parse(text); } catch { fail(); }
  const generatedAt = Date.parse(body?.generatedAt || "");
  const outbox = body?.outbox;
  const operational = body?.operational;
  const heartbeats = body?.heartbeats;
  const expectedServices = new Set(["platform-api", "platform-outbox-publisher"]);
  if (body?.schemaVersion !== 1 || Number.isNaN(generatedAt) ||
      Math.abs(Date.now() - generatedAt) > 30000 ||
      !outbox || Object.keys(outbox).sort().join(",") !== "PENDING,PROCESSING,PUBLISHED" ||
      Object.values(outbox).some(value => !Number.isInteger(value) || value < 0) ||
      !operational || !Number.isInteger(operational.dueOutbox) || operational.dueOutbox < 0 ||
      !Number.isInteger(operational.staleOutbox) || operational.staleOutbox < 0 ||
      !Array.isArray(heartbeats) || heartbeats.length !== expectedServices.size) fail();
  for (const item of heartbeats) {
    const lastSeenAt = Date.parse(item?.lastSeenAt || "");
    if (!expectedServices.delete(item?.service) || item.status !== "ok" ||
        item.activeInstances !== 1 || item.revision !== expectedRevision ||
        Number.isNaN(lastSeenAt) || Math.abs(lastSeenAt - generatedAt) > 5000) fail();
  }
  if (expectedServices.size !== 0) fail();
}).catch(fail);
' "$EXPECTED_REVISION" ||
		platform_deploy_fail 'Authenticated Core to Platform internal overview smoke failed.'
}

platform_deploy_verify_steady_boundaries() {
	local api_container integration_container integration_metadata integration_revision kinds path
	platform_cutover_verify_gateway_routes || return 1
	platform_cutover_settings_projection_topology_is_absent || return 1
	api_container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api)" || return 1
	integration_container="$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q integration-worker)" || return 1
	[[ "$api_container" =~ ^[0-9a-f]{64}$ && "$integration_container" =~ ^[0-9a-f]{64}$ ]] ||
		platform_deploy_fail 'Canonical Core API and integration-worker must be running.' || return 1
	integration_metadata="$(platform_database_docker inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.State.Running}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.Config.User}}' \
		"$integration_container")" || return 1
	IFS='|' read -r integration_revision _ _ _ _ _ _ <<<"$integration_metadata"
	[[ "$integration_revision" =~ ^[0-9a-f]{40}$ &&
		"$integration_metadata" == "$integration_revision|true|0|winwidget|integration-worker|False|nestjs" ]] ||
		platform_deploy_fail 'Core integration-worker runtime identity is unsafe.' || return 1
	git -C "$SERVER_ROOT" merge-base --is-ancestor "$integration_revision" "$EXPECTED_REVISION" ||
		platform_deploy_fail 'Core integration-worker revision is not an ancestor of the Platform candidate.' || return 1
	kinds="$(platform_database_docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
		"$integration_container" | awk -F= '
		$1 == "INTEGRATION_WORKER_KINDS" { print substr($0, index($0, "=") + 1); seen += 1 }
		END { exit(seen == 1 ? 0 : 1) }
	')" || return 1
	[[ "$kinds" == "$PLATFORM_STEADY_INTEGRATION_KINDS" ]] ||
		platform_deploy_fail 'Core integration-worker still has a retired or unknown projection kind.' || return 1
	platform_cutover_assert_integration_worker_permissions || return 1
	platform_cutover_assert_platform_admin_audit_topology || return 1
	for path in /site-settings /legal-pages /home-page-content; do
		[[ "$(platform_cutover_core_route_status GET "$path")" == 404 ]] ||
			platform_deploy_fail "Retired Core GET route is reachable: $path" || return 1
	done
	for path in /site-settings /legal-pages/oferta /home-page-content; do
		[[ "$(platform_cutover_core_route_status PATCH "$path")" == 404 ]] ||
			platform_deploy_fail "Retired Core mutation route is reachable: $path" || return 1
	done
	[[ "$(platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api)" == "$api_container" ]] ||
		platform_deploy_fail 'Core API changed while steady ownership was verified.'
}

platform_deploy_run() {
	acquire_production_deploy_lock 'routine Platform deployment'
	platform_deploy_require_active
	local image image_id
	image="$(platform_release_image "$EXPECTED_REVISION")"
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		build --pull --provenance=false platform-api
	image_id="$(platform_database_docker image inspect --format '{{.Id}}' "$image")"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$(platform_database_docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$EXPECTED_REVISION" &&
		"$(platform_database_docker image inspect --format '{{.Config.User}}' "$image")" == platform ]] ||
		platform_deploy_fail 'Platform image identity verification failed.' || return 1
	platform_deploy_validate_gateway_manifest
	platform_database_assert_marker_identity
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile platform-migration run --rm --no-deps platform-migrate
	platform_database_assert_marker_identity
	platform_cutover_provision_publisher
	platform_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --force-recreate platform-api platform-outbox-publisher
	for _ in {1..60}; do
		if curl --fail --silent --show-error http://127.0.0.1:5000/health/ready >/dev/null 2>&1 &&
			curl --fail --silent --show-error http://127.0.0.1:5001/health/ready >/dev/null 2>&1; then
			break
		fi
		sleep 2
	done
	curl --fail --silent --show-error http://127.0.0.1:5000/health/ready >/dev/null
	curl --fail --silent --show-error http://127.0.0.1:5001/health/ready >/dev/null
	curl --fail --silent --show-error http://127.0.0.1:4100/api/v1/site-settings >/dev/null
	platform_deploy_assert_runtime platform-api "$image_id" api
	platform_deploy_assert_runtime platform-outbox-publisher "$image_id" outbox-publisher
	platform_deploy_assert_internal_overview
	platform_deploy_validate_gateway_manifest
	platform_deploy_verify_steady_boundaries
	platform_database_assert_marker_identity
	local target_url
	target_url="$(platform_read_env_value "$ENV_FILE" PLATFORM_DATABASE_URL)" || return 1
	if ! PLATFORM_DATABASE_URL="$target_url" platform_database_docker run --rm --network host --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 \
		--cap-drop ALL --security-opt no-new-privileges --pids-limit 128 \
		--env PLATFORM_DATABASE_URL --entrypoint node "$image_id" \
		dist/src/cutover/main.js verify >/dev/null; then
		return 1
	fi
	printf 'platform_deploy_revision=%s\n' "$EXPECTED_REVISION"
	printf 'platform_deploy_status=complete\n'
}

platform_deploy_self_test() {
	local source routine_provision_source gateway_validator_source
	if platform_deploy_validate_gateway_manifest unexpected-argument >/dev/null 2>&1; then
		return 1
	fi
	gateway_validator_source="$(platform_deploy_gateway_manifest_validator_source)" || return 1
	source="$(declare -f platform_deploy_require_active platform_deploy_gateway_manifest_validator_source \
		platform_deploy_validate_gateway_manifest \
		platform_deploy_assert_runtime platform_deploy_assert_internal_overview \
		platform_deploy_verify_steady_boundaries platform_deploy_run)"
	routine_provision_source="$(awk '
		/^provision_rabbitmq_user\(\) \{/ { capture = 1 }
		/^provision_campaigns_rabbitmq_topic_permissions\(\) \{/ { capture = 0 }
		capture { print }
	' "$PLATFORM_DEPLOY_ROOT/scripts/deploy-production.sh")"
	[[ "$source" == *'completed ownership'* && "$source" == *'platform-migrate'* &&
		"$source" == *'platform-outbox-publisher'* && "$source" == *'cutover/main.js verify'* ]] || return 1
	[[ "$source" == *"acquire_production_deploy_lock 'routine Platform deployment'"* &&
		"$source" == *'platform_cutover_assert_phase_a_artifacts_retired'* &&
		"$source" == *'platform_database_assert_marker_identity'* &&
		"$source" == *'platform_cutover_marker_value generation'* &&
		"$source" == *'Running Gateway route manifest differs'* &&
		"$source" == *'snapshot_sha256 source_fingerprint'* &&
		"$source" == *'/api/v1/billing-settings/public'*'/api/v1/billing-settings/admin'* &&
		"$source" == *'PLATFORM_STEADY_INTEGRATION_KINDS'* &&
		"$source" == *'platform_cutover_settings_projection_topology_is_absent'*'platform_cutover_assert_platform_admin_audit_topology'* &&
		"$source" == *'platform_database_require_inputs'* &&
		"$source" == *'gateway_image_metadata'*'--entrypoint node "$gateway_image_id"'* &&
		"$source" == *'/internal/v1/platform/messaging/overview'* &&
		"$source" == *'x-winwidget-internal-token'* &&
		"$source" == *'/legal-pages/oferta'*'PATCH "$path"'* &&
		"$source" == *'ROUTES="$routes" platform_database_docker run'*'--env ROUTES'* &&
		"$source" == *'PLATFORM_DATABASE_URL="$target_url" platform_database_docker run'*'--env PLATFORM_DATABASE_URL'* &&
		"$(grep -Ec '^[[:space:]]*platform_deploy_validate_gateway_manifest;?$' <<<"$source")" == 2 &&
		"$source" != *'platform_deploy_validate_gateway_manifest "$image_id"'* &&
		"$source" != *'--env "ROUTES='* &&
		"$source" != *'--env "PLATFORM_DATABASE_URL='* ]] || return 1
	[[ "$gateway_validator_source" == *'require("./dist/src/config.js")'* &&
		"$gateway_validator_source" == *'require("./dist/src/server.js")'* &&
		"$gateway_validator_source" == *'loadConfig({'*'matchGatewayRoute(pathname, routes)'* &&
		"$gateway_validator_source" == *'`${pathPrefix}/nested/fixture`'* &&
		"$gateway_validator_source" == *'/api/v1/billing-settings/unknown'* &&
		"$gateway_validator_source" == *'candidate.pathPrefix.startsWith(`${pathPrefix}/`)'* &&
		"$gateway_validator_source" != *'JSON.parse('* ]] || return 1
	[[ "$routine_provision_source" == *'const adminConnection = await connectRabbitMq('*'const response = await fetch('*'/api/users/'*'const targetConnection = await connectRabbitMq('* &&
		"$routine_provision_source" == *'JSON.stringify({'*'password: targetPassword'*'tags: value("RABBITMQ_PROVISION_TAG")'* &&
		"$routine_provision_source" == *'--env RABBITMQ_ADMIN_PASSWORD'* &&
		"$routine_provision_source" == *'--env RABBITMQ_PROVISION_PASSWORD_BASE64'* &&
		"$routine_provision_source" != *'rabbitmqctl add_user'* &&
		"$routine_provision_source" != *'rabbitmqctl change_password'* &&
		"$routine_provision_source" != *'rabbitmqctl authenticate_user'* &&
		"$routine_provision_source" != *'--env "RABBITMQ_ADMIN_PASSWORD='* &&
		"$routine_provision_source" != *'--env "RABBITMQ_PROVISION_PASSWORD_BASE64='* ]] || return 1
	if grep -Eq -- '--env(=|[[:space:]]+)"?[A-Za-z_][A-Za-z0-9_]*=' <<<"$source"; then
		platform_deploy_fail 'Platform deploy contains inline Docker environment values.'
		return 1
	fi
	bash "$PLATFORM_DEPLOY_ROOT/scripts/deploy-production.sh" \
		--self-test-rabbitmq-provisioning-contract >/dev/null
	platform_deploy_gateway_manifest_validator_self_test
	printf 'platform_deploy_production_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--deploy) platform_deploy_run ;;
	--self-test) platform_deploy_self_test ;;
	*) platform_deploy_fail 'Usage: deploy-platform-production.sh --deploy|--self-test' ;;
	esac
fi
