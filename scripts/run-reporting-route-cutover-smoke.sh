#!/usr/bin/env bash

set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
server_root="$APP_ROOT/winwidget.ru_server"
readonly REPORTING_ROUTE_SMOKE_EVIDENCE="${REPORTING_ROUTE_SMOKE_EVIDENCE:-$APP_ROOT/deploy/backend/reporting-route-evidence-v1.json}"
readonly REPORTING_ROUTE_SMOKE_TOKEN_FILE="${REPORTING_CUTOVER_ADMIN_ACCESS_TOKEN_FILE:-$APP_ROOT/deploy/backend/.reporting-cutover-admin-access-token}"
readonly REPORTING_ROUTE_SMOKE_DENIED_ORIGIN='https://reporting-cutover.invalid'
readonly REPORTING_ROUTE_SWITCH_JOURNAL="$APP_ROOT/deploy/backend/.reporting-route-switch-v1"
readonly REPORTING_ROUTE_SWITCH_TARGET_MANIFEST='[{"id":"database-restores","pathPrefix":"/api/v1/dev-tools/database-restores","upstreamUrl":"http://127.0.0.1:4200","authPolicy":"required","timeoutMs":120000},{"id":"campaigns","pathPrefix":"/api/v1/admin/campaigns","upstreamUrl":"http://127.0.0.1:4500","authPolicy":"required","timeoutMs":60000},{"id":"reporting","pathPrefix":"/api/v1/admin/reporting","upstreamUrl":"http://127.0.0.1:4600","authPolicy":"required","timeoutMs":60000},{"id":"monolith","pathPrefix":"/api/v1","upstreamUrl":"http://127.0.0.1:4200","authPolicy":"optional","timeoutMs":60000}]'

reporting_route_smoke_stat_mode_before_source() {
	stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

reporting_route_smoke_stat_owner_before_source() {
	stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1"
}

reporting_route_smoke_resolve_lifecycle_script() {
	local override="${REPORTING_CUTOVER_LIFECYCLE_SCRIPT:-}"
	if [[ -z "$override" ]]; then
		printf '%s\n' "$server_root/scripts/reporting-cutover-lifecycle.sh"
		return
	fi
	[[ "$override" == /* && "$override" != *$'\n'* &&
		-f "$override" && ! -L "$override" &&
		"$(reporting_route_smoke_stat_owner_before_source "$override")" == '0:0' &&
		"$(reporting_route_smoke_stat_mode_before_source "$override")" == '600' ]] || {
		echo 'REPORTING_CUTOVER_LIFECYCLE_SCRIPT must be an absolute root-owned mode-600 regular non-symlink file.' >&2
		return 1
	}
	printf '%s\n' "$override"
}

reporting_cutover_lifecycle_script="$(reporting_route_smoke_resolve_lifecycle_script)"
# shellcheck disable=SC1090
source "$reporting_cutover_lifecycle_script"

reporting_route_smoke_require_safe_file() {
	local path="$1" minimum_size="$2" maximum_size="$3" size
	[[ "$path" == /* && -f "$path" && ! -L "$path" &&
		"$(reporting_stat_owner "$path")" == '0:0' &&
		"$(reporting_stat_mode "$path")" == '600' ]] || return 1
	size="$(wc -c <"$path" | tr -d '[:space:]')" || return 1
	[[ "$size" =~ ^[0-9]+$ && "$size" -ge "$minimum_size" &&
		"$size" -le "$maximum_size" ]]
}

reporting_route_smoke_runtime_image() {
	local service="$1" revision="$2" container_id app_revision status
	local restarting restart_count health image_id image_revision
	container_id="$(reporting_compose ps --status running -q "$service" 2>/dev/null || true)"
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
		echo "Reporting route smoke requires exactly one running $service container." >&2
		return 1
	}
	app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
		sed -n 's/^APP_REVISION=//p')"
	status="$(docker inspect --format '{{.State.Status}}' "$container_id")"
	restarting="$(docker inspect --format '{{.State.Restarting}}' "$container_id")"
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$container_id")"
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
	image_revision="$(docker image inspect --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
	[[ "$app_revision" == "$revision" && "$status" == 'running' &&
		"$restarting" == 'false' && "$restart_count" == '0' &&
		( "$health" == 'healthy' || "$health" == 'not-configured' ) &&
		"$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$image_revision" == "$revision" ]] || {
		echo "$service runtime/image identity is not safe for the Reporting route smoke." >&2
		return 1
	}
	printf '%s\n' "$image_id"
}

reporting_route_smoke_attestation_identity_source() {
	cat <<'NODE'
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync("/attestation.json", "utf8"));
if (value.version !== 1 ||
    !/^[0-9a-f]{40}$/.test(value.backendRevision) ||
    !/^[0-9a-f]{40}$/.test(value.frontendRevision) ||
    !/^[1-9][0-9]*$/.test(value.switchGeneration) ||
    typeof value.origin !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.challenge)) process.exit(1);
const origin = new URL(value.origin);
if (origin.origin !== value.origin || origin.protocol !== "https:" ||
    origin.username || origin.password) process.exit(1);
process.stdout.write([
  value.backendRevision,
  value.frontendRevision,
  value.switchGeneration,
  value.origin,
  value.challenge,
].join("|"));
NODE
}

reporting_route_smoke_core_auth_source() {
	cat <<'NODE'
const assert = require("node:assert/strict");
const { generateKeyPairSync, randomUUID } = require("node:crypto");
const { JwtService } = require("@nestjs/jwt");
const { hash } = require("bcryptjs");
const { AccessJwtService } = require("/app/dist/src/auth/access-jwt.service.js");
const { AuthService } = require("/app/dist/src/auth/auth.service.js");
const {
  createOpaqueRefreshToken,
  getOpaqueRefreshTokenHashInput,
} = require("/app/dist/src/auth/opaque-refresh-token.js");
const {
  ReportingAuthIntrospectionService,
} = require("/app/dist/src/reporting-internal/reporting-auth-introspection.service.js");

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
const publicJwk = pair.publicKey.export({ format: "jwk" });
Object.assign(publicJwk, {
  kid: "reporting-route-smoke",
  use: "sig",
  alg: "RS256",
  key_ops: ["verify"],
});
const values = {
  JWT_ACCESS_PRIVATE_KEY_BASE64: Buffer.from(privatePem).toString("base64"),
  JWT_ACCESS_JWKS_BASE64: Buffer.from(JSON.stringify({ keys: [publicJwk] })).toString("base64"),
  JWT_ACCESS_ACTIVE_KID: publicJwk.kid,
  JWT_ISSUER: "https://reporting-route-smoke.invalid",
  JWT_AUDIENCE: "winwidget-api",
  JWT_ACCESS_TTL_SECONDS: "900",
  JWT_CLOCK_TOLERANCE_SECONDS: "0",
};
const config = { get: name => values[name] };
const accessJwt = new AccessJwtService(new JwtService(), config);
const userId = "reporting-route-smoke-user";
const sessionId = randomUUID();
const state = {
  id: sessionId,
  userId,
  refreshTokenHash: "",
  expiresAt: new Date(Date.now() + 600_000),
  revokedAt: null,
  status: "ACTIVE",
  deletedAt: null,
  rights: ["USER", "ADMIN"],
};
const prisma = {
  userSession: {
    findFirst: async ({ where }) => {
      assert.equal(where.id, sessionId);
      assert.equal(where.userId, userId);
      assert.equal(where.revokedAt, null);
      assert(where.expiresAt.gt instanceof Date);
      assert.equal(where.user.status, "ACTIVE");
      assert.equal(where.user.deletedAt, null);
      if (state.revokedAt || state.expiresAt <= new Date() ||
          state.status !== "ACTIVE" || state.deletedAt) return null;
      return { id: state.id, user: { id: userId, rights: [...state.rights] } };
    },
    findUnique: async ({ where }) => where.id === sessionId ? { ...state } : null,
    updateMany: async ({ where, data }) => {
      if (where.id !== sessionId || state.revokedAt ||
          where.refreshTokenHash !== state.refreshTokenHash) return { count: 0 };
      state.revokedAt = data.revokedAt;
      return { count: 1 };
    },
  },
};
const introspection = new ReportingAuthIntrospectionService(accessJwt, prisma);
const accessToken = accessJwt.issueAccessToken(userId, ["USER", "ADMIN"], sessionId);
const authorization = `Bearer ${accessToken}`;
const reject401 = async promise => {
  await assert.rejects(promise, error =>
    typeof error?.getStatus === "function" && error.getStatus() === 401);
};

(async () => {
  const active = await introspection.introspect(authorization);
  assert.deepEqual(active.roles, ["USER", "ADMIN"]);

  const refreshToken = createOpaqueRefreshToken(sessionId);
  state.refreshTokenHash = await hash(getOpaqueRefreshTokenHashInput(refreshToken), 10);
  const auth = new AuthService(accessJwt, {}, {}, prisma, {}, {});
  await auth.logout(refreshToken);
  assert(state.revokedAt instanceof Date);
  await reject401(introspection.introspect(authorization));

  state.revokedAt = new Date();
  await reject401(introspection.introspect(authorization));

  state.revokedAt = null;
  state.status = "DEACTIVATED";
  await reject401(introspection.introspect(authorization));

  state.status = "ACTIVE";
  state.rights = ["USER"];
  const roleChanged = await introspection.introspect(authorization);
  assert.deepEqual(roleChanged.roles, ["USER"]);
})().catch(error => {
  console.error(error instanceof Error ? error.message : "core auth contract failed");
  process.exitCode = 1;
});
NODE
}

reporting_route_smoke_reporting_auth_source() {
	cat <<'NODE'
const assert = require("node:assert/strict");
const {
  CoreInternalClient,
} = require("/app/dist/src/internal/core-internal.client.js");
const {
  ReportingAdminGuard,
} = require("/app/dist/src/auth/reporting-auth.guard.js");

const config = {
  get: name => ({
    REPORTING_CORE_INTERNAL_BASE_URL: "http://127.0.0.1:1",
    REPORTING_INTERNAL_TOKEN: "reporting-route-smoke-token-32-characters",
    REPORTING_INTERNAL_TIMEOUT_MS: "500",
  })[name],
};
const runtime = { apiEnabled: true, backfillEnabled: false };
const statusIs = expected => error =>
  typeof error?.getStatus === "function" && error.getStatus() === expected;

(async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const client = new CoreInternalClient(config, runtime);
    await assert.rejects(client.introspect("Bearer route-smoke"), statusIs(503));
  } finally {
    globalThis.fetch = savedFetch;
  }

  const reflector = { getAllAndOverride: () => "ADMIN" };
  const request = { headers: { authorization: "Bearer route-smoke" } };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  };
  const rejected = new ReportingAdminGuard(reflector, {
    introspect: async () => ({
      active: true,
      subject: "route-smoke-user",
      sessionId: "route-smoke-session",
      roles: ["USER"],
    }),
  });
  await assert.rejects(rejected.canActivate(context), statusIs(403));

  const accepted = new ReportingAdminGuard(reflector, {
    introspect: async () => ({
      active: true,
      subject: "route-smoke-admin",
      sessionId: "route-smoke-session",
      roles: ["ADMIN"],
    }),
  });
  assert.equal(await accepted.canActivate(context), true);
})().catch(error => {
  console.error(error instanceof Error ? error.message : "reporting auth contract failed");
  process.exitCode = 1;
});
NODE
}

reporting_route_smoke_gateway_rotation_source() {
	cat <<'NODE'
const assert = require("node:assert/strict");
const { generateKeyPairSync, randomUUID, sign } = require("node:crypto");
const { JwksStore } = require("/app/dist/src/jwks.js");
const { verifyAccessToken } = require("/app/dist/src/jwt.js");

const makeKey = kid => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: "jwk" });
  Object.assign(jwk, { kid, use: "sig", alg: "RS256", key_ops: ["verify"] });
  return { privateKey: pair.privateKey, jwk };
};
const oldKey = makeKey("reporting-route-smoke-old");
const newKey = makeKey("reporting-route-smoke-new");
let keys = [oldKey.jwk];
let now = Date.now();
const store = new JwksStore({
  url: new URL("https://reporting-route-smoke.invalid/jwks"),
  fetchTimeoutMs: 1000,
  refreshMinIntervalMs: 0,
  cacheTtlMs: 60_000,
  maxStaleMs: 120_000,
  maxBytes: 65_536,
  logger: { log() {} },
  now: () => now,
  fetch: async () => {
    const body = JSON.stringify({ keys });
    return {
      ok: true,
      status: 200,
      headers: { get: name => name.toLowerCase() === "content-length" ? String(Buffer.byteLength(body)) : null },
      text: async () => body,
    };
  },
});
const config = {
  issuer: "https://reporting-route-smoke.invalid",
  audience: "winwidget-api",
  clockToleranceSeconds: 0,
  maxTokenLifetimeSeconds: 900,
  maxTokenBytes: 16_384,
};
const token = key => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "at+jwt", kid: key.jwk.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: config.issuer,
    aud: config.audience,
    sub: "reporting-route-smoke-user",
    sid: randomUUID(),
    roles: ["ADMIN"],
    token_use: "access",
    jti: randomUUID(),
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + 600,
  })).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url");
  return `${input}.${signature}`;
};

(async () => {
  assert.equal(await store.initialize(), true);
  assert.equal((await verifyAccessToken(token(oldKey), store, config)).roles[0], "ADMIN");
  keys = [oldKey.jwk, newKey.jwk];
  now += 1;
  assert.equal((await verifyAccessToken(token(newKey), store, config)).roles[0], "ADMIN");
})().catch(error => {
  console.error(error instanceof Error ? error.message : "gateway rotation contract failed");
  process.exitCode = 1;
});
NODE
}

reporting_route_smoke_live_http_source() {
	cat <<'NODE'
const { readFileSync } = require("node:fs");
const token = readFileSync("/run/secrets/reporting-route-smoke-token", "utf8").trim();
if (!/^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/.test(token) ||
    token.length > 16 * 1024) process.exit(1);
const authorization = `Bearer ${token}`;
const publicApi = process.env.PUBLIC_API_ORIGIN;
const frontend = process.env.FRONTEND_ORIGIN;
const deniedOrigin = process.env.DENIED_ORIGIN;
const localGateway = "http://127.0.0.1:4100";
const localReporting = "http://127.0.0.1:4600";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const call = async (origin, path, expectedStatus, init = {}) => {
  const response = await fetch(`${origin}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    ...init,
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${init.method || "GET"} ${origin}${path}: expected ${expectedStatus}, received ${response.status}`);
  }
  return { response, text };
};
const json = result => {
  try { return JSON.parse(result.text); }
  catch { throw new Error("Expected a JSON response"); }
};
const authenticated = { headers: { authorization } };

(async () => {
  const overviewPath = "/api/v1/admin/reporting/overview";
  const dashboard = json(await call(publicApi, "/api/v1/admin/reporting/dashboard", 200, authenticated));
  if (!dashboard || typeof dashboard !== "object" || typeof dashboard.generatedAt !== "string") {
    throw new Error("Reporting dashboard contract is invalid");
  }
  const overview = json(await call(publicApi, overviewPath, 200, authenticated));
  if (!overview || typeof overview !== "object" || Array.isArray(overview)) {
    throw new Error("Reporting overview contract is invalid");
  }
  const registrations = json(await call(publicApi, "/api/v1/admin/reporting/registrations-by-month", 200, authenticated));
  if (!Array.isArray(registrations)) throw new Error("Reporting registrations contract is invalid");
  const settings = json(await call(publicApi, "/api/v1/admin/reporting/daily-summary/settings", 200, authenticated));
  if (!settings || settings.owner !== "REPORTING") throw new Error("Reporting settings owner is not REPORTING");

  await call(localGateway, overviewPath, 200, authenticated);
  const directRequestId = "11111111-1111-4111-8111-111111111111";
  const directCorrelationId = "22222222-2222-4222-8222-222222222222";
  const direct = await call(localReporting, overviewPath, 200, {
    headers: {
      authorization,
      "x-request-id": directRequestId,
      "x-correlation-id": directCorrelationId,
    },
  });
  if (direct.response.headers.get("x-request-id") !== directRequestId ||
      direct.response.headers.get("x-correlation-id") !== directCorrelationId) {
    throw new Error("Reporting did not preserve direct request correlation");
  }

  for (const origin of [localGateway, publicApi]) {
    const legacyDashboard = json(await call(origin, "/api/v1/statistics/dashboard", 200, authenticated));
    if (!legacyDashboard || typeof legacyDashboard !== "object" ||
        typeof legacyDashboard.generatedAt !== "string") {
      throw new Error("Legacy dashboard was removed before cleanup");
    }
    const legacyOverview = json(await call(origin, "/api/v1/statistics/overview", 200, authenticated));
    if (!legacyOverview || typeof legacyOverview !== "object" || Array.isArray(legacyOverview)) {
      throw new Error("Legacy overview was removed before cleanup");
    }
    const legacyRegistrations = json(await call(
      origin,
      "/api/v1/statistics/registrations-by-month",
      200,
      authenticated,
    ));
    if (!Array.isArray(legacyRegistrations)) {
      throw new Error("Legacy registrations were removed before cleanup");
    }
  }

  for (const origin of [localGateway, publicApi]) {
    const restore = json(await call(origin, "/api/v1/dev-tools/database-restores/settings", 200, authenticated));
    if (!restore || typeof restore !== "object" || Array.isArray(restore)) {
      throw new Error("Database restore settings contract is invalid");
    }
    const unauthenticated = json(await call(origin, "/api/v1/dev-tools/database-restores/settings", 401));
    if (unauthenticated.code !== "authentication_required") {
      throw new Error("Database restore route did not reject an unauthenticated request at Gateway");
    }
  }

  const preflightHeaders = {
    origin: frontend,
    "access-control-request-method": "GET",
    "access-control-request-headers": "authorization,content-type",
  };
  const allowed = await call(publicApi, overviewPath, 204, { method: "OPTIONS", headers: preflightHeaders });
  if (allowed.response.headers.get("access-control-allow-origin") !== frontend ||
      allowed.response.headers.get("access-control-allow-credentials") !== "true") {
    throw new Error("Reporting CORS rejected the reviewed frontend origin");
  }
  const denied = await call(publicApi, overviewPath, 204, {
    method: "OPTIONS",
    headers: { ...preflightHeaders, origin: deniedOrigin },
  });
  if (denied.response.headers.has("access-control-allow-origin") ||
      denied.response.headers.has("access-control-allow-credentials")) {
    throw new Error("Reporting CORS accepted an unreviewed origin");
  }

  const forged = json(await call(publicApi, overviewPath, 401, {
    headers: {
      "x-user-id": "attacker",
      "x-user-roles": "ADMIN,DEV",
      "x-auth-user": "attacker",
      "x-forwarded-user": "attacker",
      "x-winwidget-internal-token": "attacker",
    },
  }));
  if (forged.code !== "authentication_required") {
    throw new Error("Forged forwarded identity headers bypassed required auth");
  }

  const attackerRequestId = "attacker-request-id";
  const attackerCorrelationId = "attacker-correlation-id";
  const correlated = await call(publicApi, overviewPath, 200, {
    headers: {
      authorization,
      "x-request-id": attackerRequestId,
      "x-correlation-id": attackerCorrelationId,
    },
  });
  const requestId = correlated.response.headers.get("x-request-id") || "";
  const correlationId = correlated.response.headers.get("x-correlation-id") || "";
  if (!uuid.test(requestId) || !uuid.test(correlationId) ||
      requestId === attackerRequestId || correlationId === attackerCorrelationId) {
    throw new Error("Gateway did not replace untrusted correlation headers");
  }
})().catch(error => {
  console.error(error instanceof Error ? error.message : "live Reporting route smoke failed");
  process.exitCode = 1;
});
NODE
}

reporting_route_smoke_write_evidence() {
	local revision="$1" frontend_revision="$2" switch_generation="$3"
	local frontend_origin="$4" attestation_sha="$5" signature_sha="$6"
	local public_key_sha="$7" challenge="$8" image_id temporary
	image_id="$(reporting_resolve_image_id_for_revision "$revision")" || return 1
	if [[ -e "$REPORTING_ROUTE_SMOKE_EVIDENCE" || -L "$REPORTING_ROUTE_SMOKE_EVIDENCE" ]]; then
		reporting_route_smoke_require_safe_file \
			"$REPORTING_ROUTE_SMOKE_EVIDENCE" 64 16384 || {
			echo 'Existing Reporting route evidence file is unsafe.' >&2
			return 1
		}
	fi
	temporary="${REPORTING_ROUTE_SMOKE_EVIDENCE}.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	if ! reporting_run_isolated_node_validator "$image_id" '
const value = {
  version: 1,
  backendRevision: process.env.BACKEND_REVISION,
  frontendRevision: process.env.FRONTEND_REVISION,
  switchGeneration: process.env.SWITCH_GENERATION,
  origin: process.env.FRONTEND_ORIGIN,
  frontendRuntimeAttestationSha256: process.env.ATTESTATION_SHA,
  frontendRuntimeSignatureSha256: process.env.SIGNATURE_SHA,
  frontendRuntimePublicKeySha256: process.env.PUBLIC_KEY_SHA,
  frontendRuntimeChallenge: process.env.CHALLENGE,
  verifiedAt: new Date().toISOString(),
  checks: {
    gatewayRoute: true,
    frontendReportingApi: true,
    adminDashboard: true,
    adminOverview: true,
    adminRegistrations: true,
    dailySummarySettings: true,
    legacyStatisticsRetained: true,
    allowedCors: true,
    deniedCors: true,
    databaseRestoreSettings: true,
    databaseRestoreUnauthenticatedRejected: true,
    logoutRejected: true,
    blockedUserRejected: true,
    revokedSessionRejected: true,
    roleChangeRejected: true,
    jwtKeyRotationAccepted: true,
    introspectionFailClosed: true,
    forgedForwardedHeadersRejected: true,
    correlationIdPreserved: true,
  },
};
process.stdout.write(`${JSON.stringify(value)}\n`);
' \
		-e "BACKEND_REVISION=$revision" \
		-e "FRONTEND_REVISION=$frontend_revision" \
		-e "SWITCH_GENERATION=$switch_generation" \
		-e "FRONTEND_ORIGIN=$frontend_origin" \
		-e "ATTESTATION_SHA=$attestation_sha" \
		-e "SIGNATURE_SHA=$signature_sha" \
		-e "PUBLIC_KEY_SHA=$public_key_sha" \
		-e "CHALLENGE=$challenge" >"$temporary"; then
		rm -f -- "$temporary"
		return 1
	fi
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	mv "$temporary" "$REPORTING_ROUTE_SMOKE_EVIDENCE"
}

reporting_route_smoke_main() {
	local revision switch_generation phase reporting_image gateway_image core_image
	local identity attestation_revision frontend_revision attestation_generation
	local frontend_origin challenge attestation_sha signature_sha public_key_sha
	local public_api_origin evidence_sha
	[[ "$(id -u)" == '0' ]] || {
		echo 'Reporting route cutover smoke must run as root.' >&2
		return 1
	}
	revision="${EXPECTED_REVISION:-}"
	reporting_validate_production_files
	reporting_validate_exact_revision "$revision"
	reporting_cutover_export_pinned_runtime_identity "$revision"
	reporting_assert_no_ambient_compose_overrides \
		REPORTING_IMAGE REPORTING_REVISION \
		NOTIFICATION_DELIVERY_IMAGE NOTIFICATION_DELIVERY_REVISION \
		CAMPAIGNS_IMAGE CAMPAIGNS_REVISION \
		DATABASE_RESTORE_IMAGE DATABASE_RESTORE_REVISION
	acquire_production_deploy_lock 'Reporting route cutover smoke'
	database_restore_guard_assert_before_mutation healthy-required "$REPORTING_ENV_FILE"
	assert_core_database_url_boundaries
	assert_core_database_postgres_identity
	reporting_initialize_database_guard 'Reporting route cutover smoke'
	reporting_cutover_validate_marker
	phase="$(reporting_cutover_marker_value phase)"
	[[ "$phase" == 'scheduler-switched' &&
		"$(reporting_cutover_marker_value revision)" == "$revision" &&
		"$(reporting_cutover_marker_value scheduler_step)" == 'target-owned' &&
		"$(reporting_cutover_marker_value route_evidence_sha256)" == 'pending' ]] || {
		echo 'Reporting route smoke requires scheduler-switched with pending route evidence.' >&2
		return 1
	}
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	reporting_cutover_require_forward_scheduler_ready
	reporting_cutover_require_projection_barrier

	reporting_image="$(reporting_resolve_image_id_for_revision "$revision")"
	gateway_image="$(reporting_route_smoke_runtime_image api-gateway "$revision")"
	core_image="$(reporting_route_smoke_runtime_image api "$revision")"
	reporting_route_smoke_require_safe_file "$REPORTING_ROUTE_SMOKE_TOKEN_FILE" 64 16385 || {
		echo 'Reporting route smoke requires an absolute root-owned mode-600 ADMIN+DEV access-token file.' >&2
		return 1
	}
	for artifact in \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION" \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION_SIGNATURE" \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION_PUBLIC_KEY"; do
		reporting_route_smoke_require_safe_file "$artifact" 32 16384 || {
			echo 'Reporting frontend runtime attestation artifacts are missing or unsafe.' >&2
			return 1
		}
	done
	identity="$(reporting_run_isolated_node_validator "$reporting_image" \
		"$(reporting_route_smoke_attestation_identity_source)" \
		-v "$REPORTING_FRONTEND_RUNTIME_ATTESTATION:/attestation.json:ro")"
	IFS='|' read -r attestation_revision frontend_revision attestation_generation \
		frontend_origin challenge <<<"$identity"
	[[ "$attestation_revision" == "$revision" &&
		"$attestation_generation" == "$switch_generation" ]] || {
		echo 'Frontend runtime attestation does not match the active Reporting cutover.' >&2
		return 1
	}
	attestation_sha="$(reporting_sha256_file "$REPORTING_FRONTEND_RUNTIME_ATTESTATION")"
	signature_sha="$(reporting_sha256_file "$REPORTING_FRONTEND_RUNTIME_ATTESTATION_SIGNATURE")"
	public_key_sha="$(reporting_sha256_file "$REPORTING_FRONTEND_RUNTIME_ATTESTATION_PUBLIC_KEY")"
	reporting_cutover_validate_frontend_runtime_attestation \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION" \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION_SIGNATURE" \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION_PUBLIC_KEY" \
		"$revision" "$frontend_revision" "$frontend_origin" \
		"$switch_generation" "$challenge" "$attestation_sha" \
		"$signature_sha" "$public_key_sha"

	reporting_run_isolated_node_validator "$core_image" \
		"$(reporting_route_smoke_core_auth_source)" >/dev/null
	reporting_run_isolated_node_validator "$reporting_image" \
		"$(reporting_route_smoke_reporting_auth_source)" >/dev/null
	reporting_run_isolated_node_validator "$gateway_image" \
		"$(reporting_route_smoke_gateway_rotation_source)" >/dev/null

	public_api_origin="$(reporting_get_env_value PRODUCTION_HOST)"
	[[ "$public_api_origin" =~ ^https://[^/:]+$ &&
		"$frontend_origin" != "$REPORTING_ROUTE_SMOKE_DENIED_ORIGIN" ]] || {
		echo 'Reporting route smoke requires canonical HTTPS production origins.' >&2
		return 1
	}
	docker run --rm -i --network host --read-only --user 0:0 \
		--cap-drop ALL --security-opt no-new-privileges \
		--pids-limit 64 --memory 128m --cpus 0.5 \
		--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		-e "PUBLIC_API_ORIGIN=$public_api_origin" \
		-e "FRONTEND_ORIGIN=$frontend_origin" \
		-e "DENIED_ORIGIN=$REPORTING_ROUTE_SMOKE_DENIED_ORIGIN" \
		-v "$REPORTING_ROUTE_SMOKE_TOKEN_FILE:/run/secrets/reporting-route-smoke-token:ro" \
		--entrypoint node "$reporting_image" \
		-e "$(reporting_route_smoke_live_http_source)" >/dev/null

	reporting_route_smoke_write_evidence "$revision" "$frontend_revision" \
		"$switch_generation" "$frontend_origin" "$attestation_sha" \
		"$signature_sha" "$public_key_sha" "$challenge"
	reporting_cutover_validate_route_evidence \
		"$REPORTING_ROUTE_SMOKE_EVIDENCE" "$revision" "$switch_generation"
	evidence_sha="$(reporting_sha256_file "$REPORTING_ROUTE_SMOKE_EVIDENCE")"
	REPORTING_CUTOVER_ADMIN_ACCESS_TOKEN_FILE="$REPORTING_ROUTE_SMOKE_TOKEN_FILE"
	REPORTING_ROUTE_EVIDENCE_FILE="$REPORTING_ROUTE_SMOKE_EVIDENCE"
	CONFIRM_REPORTING_ROUTES_VERIFIED="routes:$revision:$switch_generation:$evidence_sha"
	export REPORTING_CUTOVER_ADMIN_ACCESS_TOKEN_FILE REPORTING_ROUTE_EVIDENCE_FILE
	export CONFIRM_REPORTING_ROUTES_VERIFIED
	reporting_verify_database_lifecycle_unchanged
	reporting_cutover_verify_routes
	reporting_verify_database_lifecycle_unchanged
	echo "Reporting route cutover smoke completed evidence_sha256=$evidence_sha."
}

reporting_route_switch_journal_value() {
	local key="$1"
	awk -F= -v key="$key" '
		$1 == key {
			print substr($0, index($0, "=") + 1)
			found += 1
		}
		END { exit(found == 1 ? 0 : 1) }
	' "$REPORTING_ROUTE_SWITCH_JOURNAL"
}

reporting_route_switch_validate_journal() {
	local revision switch_generation original_env_sha original_database_guard_sha
	local gateway_image_id
	local original_manifest target_manifest
	[[ -f "$REPORTING_ROUTE_SWITCH_JOURNAL" &&
		! -L "$REPORTING_ROUTE_SWITCH_JOURNAL" &&
		"$(reporting_stat_owner "$REPORTING_ROUTE_SWITCH_JOURNAL")" == '0:0' &&
		"$(reporting_stat_mode "$REPORTING_ROUTE_SWITCH_JOURNAL")" == '600' ]] || {
		echo 'Reporting route switch journal must be a root-owned mode-600 regular file.' >&2
		return 1
	}
	awk -F= '
		BEGIN {
			allowed["version"] = 1
			allowed["revision"] = 1
			allowed["switch_generation"] = 1
			allowed["original_env_sha256"] = 1
			allowed["original_database_guard_sha256"] = 1
			allowed["original_gateway_image_id"] = 1
			allowed["original_gateway_routes_json"] = 1
			allowed["target_gateway_routes_json"] = 1
		}
		{
			if (!($1 in allowed) || seen[$1]++) invalid = 1
		}
		END {
			for (key in allowed) if (seen[key] != 1) invalid = 1
			exit(invalid ? 1 : 0)
		}
	' "$REPORTING_ROUTE_SWITCH_JOURNAL" || {
		echo 'Reporting route switch journal has an invalid key contract.' >&2
		return 1
	}
	[[ "$(reporting_route_switch_journal_value version)" == '1' ]] || return 1
	revision="$(reporting_route_switch_journal_value revision)" || return 1
	switch_generation="$(reporting_route_switch_journal_value switch_generation)" || return 1
	original_env_sha="$(reporting_route_switch_journal_value original_env_sha256)" || return 1
	original_database_guard_sha="$(reporting_route_switch_journal_value original_database_guard_sha256)" || return 1
	gateway_image_id="$(reporting_route_switch_journal_value original_gateway_image_id)" || return 1
	original_manifest="$(reporting_route_switch_journal_value original_gateway_routes_json)" || return 1
	target_manifest="$(reporting_route_switch_journal_value target_gateway_routes_json)" || return 1
	[[ "$revision" =~ ^[0-9a-f]{40}$ &&
		"$switch_generation" =~ ^[1-9][0-9]*$ &&
		"$original_env_sha" =~ ^[0-9a-f]{64}$ &&
		"$original_database_guard_sha" =~ ^[0-9a-f]{64}$ &&
		"$gateway_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$target_manifest" == "$REPORTING_ROUTE_SWITCH_TARGET_MANIFEST" &&
		"$original_manifest" != "$target_manifest" ]] || return 1
	reporting_cutover_validate_gateway_manifest_value "$original_manifest" dark
	reporting_cutover_validate_gateway_manifest_value "$target_manifest" reporting
}

reporting_route_switch_write_journal() {
	local revision="$1" switch_generation="$2" original_env_sha="$3"
	local original_database_guard_sha="$4" gateway_image_id="$5"
	local original_manifest="$6" temporary
	[[ ! -e "$REPORTING_ROUTE_SWITCH_JOURNAL" &&
		! -L "$REPORTING_ROUTE_SWITCH_JOURNAL" ]] || {
		echo 'Reporting route switch journal already exists; recover it before a new switch.' >&2
		return 1
	}
	[[ "$(dirname -- "$REPORTING_ROUTE_SWITCH_JOURNAL")" == \
		"$(dirname -- "$REPORTING_ENV_FILE")" ]] || return 1
	reporting_validate_root_owned_directory \
		"$(dirname -- "$REPORTING_ROUTE_SWITCH_JOURNAL")" || {
		echo 'Reporting route switch journal directory is unsafe.' >&2
		return 1
	}
	temporary="${REPORTING_ROUTE_SWITCH_JOURNAL}.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	umask 077
	{
		printf 'version=1\n'
		printf 'revision=%s\n' "$revision"
		printf 'switch_generation=%s\n' "$switch_generation"
		printf 'original_env_sha256=%s\n' "$original_env_sha"
		printf 'original_database_guard_sha256=%s\n' \
			"$original_database_guard_sha"
		printf 'original_gateway_image_id=%s\n' "$gateway_image_id"
		printf 'original_gateway_routes_json=%s\n' "$original_manifest"
		printf 'target_gateway_routes_json=%s\n' \
			"$REPORTING_ROUTE_SWITCH_TARGET_MANIFEST"
	} >"$temporary"
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	sync -f "$temporary"
	mv -- "$temporary" "$REPORTING_ROUTE_SWITCH_JOURNAL"
	sync -f "$(dirname -- "$REPORTING_ROUTE_SWITCH_JOURNAL")"
	reporting_route_switch_validate_journal
}

reporting_route_switch_clear_journal() {
	reporting_route_switch_validate_journal || return 1
	rm -f -- "$REPORTING_ROUTE_SWITCH_JOURNAL"
	sync -f "$(dirname -- "$REPORTING_ROUTE_SWITCH_JOURNAL")"
}

reporting_route_switch_database_guard_sha256() {
	local value
	[[ "${REPORTING_GUARD_CONTAINER_ID:-}" =~ ^[0-9a-f]{64}$ &&
		"${REPORTING_GUARD_IMAGE_ID:-}" =~ ^sha256:[0-9a-f]{64}$ &&
		"${REPORTING_GUARD_SYSTEM_IDENTIFIER:-}" =~ ^[0-9]+$ ]] || return 1
	for value in \
		"${REPORTING_GUARD_CONTAINER_SNAPSHOT:-}" \
		"${REPORTING_GUARD_VOLUME_SNAPSHOT:-}" \
		"${REPORTING_GUARD_SECRET_SNAPSHOT:-}"; do
		[[ -n "$value" && "$value" != *$'\n'* && ${#value} -le 16384 ]] || return 1
	done
	if command -v sha256sum >/dev/null 2>&1; then
		printf '%s\0' \
			"$REPORTING_GUARD_CONTAINER_ID" \
			"$REPORTING_GUARD_IMAGE_ID" \
			"$REPORTING_GUARD_SYSTEM_IDENTIFIER" \
			"$REPORTING_GUARD_CONTAINER_SNAPSHOT" \
			"$REPORTING_GUARD_VOLUME_SNAPSHOT" \
			"$REPORTING_GUARD_SECRET_SNAPSHOT" |
			sha256sum | awk '{ print $1 }'
	else
		printf '%s\0' \
			"$REPORTING_GUARD_CONTAINER_ID" \
			"$REPORTING_GUARD_IMAGE_ID" \
			"$REPORTING_GUARD_SYSTEM_IDENTIFIER" \
			"$REPORTING_GUARD_CONTAINER_SNAPSHOT" \
			"$REPORTING_GUARD_VOLUME_SNAPSHOT" \
			"$REPORTING_GUARD_SECRET_SNAPSHOT" |
			shasum -a 256 | awk '{ print $1 }'
	fi
}

reporting_route_switch_exact_env_manifest() {
	local manifest line
	manifest="$(reporting_get_env_value GATEWAY_ROUTES_JSON)" || {
		echo 'Reporting route switch requires exactly one GATEWAY_ROUTES_JSON key.' >&2
		return 1
	}
	line="$(awk '
		/^GATEWAY_ROUTES_JSON=/ { print; found += 1 }
		END { exit(found == 1 ? 0 : 1) }
	' "$REPORTING_ENV_FILE")" || {
		echo 'Reporting route switch requires one canonical GATEWAY_ROUTES_JSON line.' >&2
		return 1
	}
	[[ "$line" == "GATEWAY_ROUTES_JSON=$manifest" ]] || {
		echo 'GATEWAY_ROUTES_JSON must use the exact canonical single-line form.' >&2
		return 1
	}
	printf '%s\n' "$manifest"
}

reporting_route_switch_replace_env_manifest() {
	local expected="$1" replacement="$2" expected_before_sha="${3:-}"
	local temporary current_manifest current_sha
	current_manifest="$(reporting_route_switch_exact_env_manifest)" || return 1
	[[ "$current_manifest" == "$expected" ]] || {
		echo 'Production Gateway manifest changed outside the protected route switch.' >&2
		return 1
	}
	current_sha="$(reporting_sha256_file "$REPORTING_ENV_FILE")" || return 1
	[[ -z "$expected_before_sha" || "$current_sha" == "$expected_before_sha" ]] || {
		echo 'Production env changed after the Reporting route switch journal was written.' >&2
		return 1
	}
	temporary="${REPORTING_ENV_FILE}.reporting-routes.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	if ! awk -v expected="GATEWAY_ROUTES_JSON=$expected" \
		-v replacement="GATEWAY_ROUTES_JSON=$replacement" '
		$0 == expected { print replacement; replaced += 1; next }
		{ print }
		END { exit(replaced == 1 ? 0 : 1) }
	' "$REPORTING_ENV_FILE" >"$temporary"; then
		rm -f -- "$temporary"
		echo 'Could not stage the exact Reporting Gateway env-line replacement.' >&2
		return 1
	fi
	chown 0:0 "$temporary"
	chmod 600 "$temporary"
	[[ -f "$temporary" && ! -L "$temporary" &&
		"$(reporting_stat_owner "$temporary")" == '0:0' &&
		"$(reporting_stat_mode "$temporary")" == '600' &&
		"$(awk -F= '$1 == "GATEWAY_ROUTES_JSON" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }' "$temporary")" == "$replacement" ]] || {
		rm -f -- "$temporary"
		echo 'Staged Reporting Gateway env file failed exact validation.' >&2
		return 1
	}
	sync -f "$temporary"
	if ! mv -- "$temporary" "$REPORTING_ENV_FILE"; then
		rm -f -- "$temporary"
		echo 'Could not atomically replace the production Gateway env line.' >&2
		return 1
	fi
	sync -f "$(dirname -- "$REPORTING_ENV_FILE")"
	[[ "$(reporting_route_switch_exact_env_manifest)" == "$replacement" ]] || {
		echo 'Production Gateway env-line replacement did not persist.' >&2
		return 1
	}
}

reporting_route_switch_gateway_image_id() {
	local revision="$1" expected_image_id="${2:-}" image_id image_revision
	image_id="$(docker image inspect "winwidget-api-gateway:git-$revision" \
		--format '{{.Id}}' 2>/dev/null || true)"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
		echo 'Exact API Gateway image is not present locally.' >&2
		return 1
	}
	image_revision="$(docker image inspect "$image_id" --format \
		'{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
	[[ "$image_revision" == "$revision" &&
		( -z "$expected_image_id" || "$image_id" == "$expected_image_id" ) ]] || {
		echo 'API Gateway tag, image ID or revision label changed during route switch.' >&2
		return 1
	}
	printf '%s\n' "$image_id"
}

reporting_route_switch_recreate_gateway() {
	local revision="$1" expected_manifest="$2" expected_image_id="$3"
	local attempt image_id container_id live_manifest
	reporting_route_switch_gateway_image_id "$revision" "$expected_image_id" >/dev/null
	(
		export APP_REVISION="$revision"
		export APP_VERSION="git-$revision"
		reporting_compose config --quiet
		reporting_compose up -d --no-deps --force-recreate api-gateway
	)
	for ((attempt = 1; attempt <= 60; attempt++)); do
		image_id="$(reporting_route_smoke_runtime_image api-gateway "$revision" \
			2>/dev/null || true)"
		if [[ "$image_id" == "$expected_image_id" ]] &&
			curl -fsS --connect-timeout 2 --max-time 5 \
				http://127.0.0.1:4100/health/ready >/dev/null 2>&1; then
			container_id="$(reporting_compose ps --status running -q api-gateway)"
			live_manifest="$(docker inspect --format \
				'{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
				sed -n 's/^GATEWAY_ROUTES_JSON=//p')"
			[[ "$live_manifest" == "$expected_manifest" ]] && return 0
		fi
		sleep 2
	done
	echo 'API Gateway did not converge to the exact Reporting route-switch runtime.' >&2
	reporting_compose ps api-gateway >&2 || true
	reporting_compose logs --tail=100 api-gateway >&2 || true
	return 1
}

reporting_route_switch_recover() {
	local phase revision switch_generation original_env_sha original_database_guard_sha
	local current_database_guard_sha original_image_id
	local original_manifest target_manifest current_manifest restored_env_sha
	local gateway_container_id live_manifest recovery_failed='false'
	local database_guard_changed='false'
	reporting_route_switch_validate_journal || return 1
	revision="$(reporting_route_switch_journal_value revision)"
	switch_generation="$(reporting_route_switch_journal_value switch_generation)"
	original_env_sha="$(reporting_route_switch_journal_value original_env_sha256)"
	original_database_guard_sha="$(reporting_route_switch_journal_value original_database_guard_sha256)"
	current_database_guard_sha="$(reporting_route_switch_database_guard_sha256)" || return 1
	[[ "$current_database_guard_sha" == "$original_database_guard_sha" ]] ||
		database_guard_changed='true'
	original_image_id="$(reporting_route_switch_journal_value original_gateway_image_id)"
	original_manifest="$(reporting_route_switch_journal_value original_gateway_routes_json)"
	target_manifest="$(reporting_route_switch_journal_value target_gateway_routes_json)"
	reporting_cutover_validate_marker || return 1
	phase="$(reporting_cutover_marker_value phase)" || return 1
	[[ "$(reporting_cutover_marker_value revision)" == "$revision" &&
		"$(reporting_cutover_marker_value switch_generation)" == "$switch_generation" ]] || {
		echo 'Reporting marker identity differs from the route switch journal.' >&2
		return 1
	}
	case "$phase" in
	routes-switched)
		[[ "$database_guard_changed" == 'false' ]] || {
			echo 'Reporting database lifecycle differs from the durable pre-route guard.' >&2
			return 1
		}
		current_manifest="$(reporting_route_switch_exact_env_manifest)" || return 1
		[[ "$current_manifest" == "$target_manifest" ]] || {
			echo 'Marker already advanced; refusing to auto-revert an inconsistent public route.' >&2
			return 1
		}
		[[ "$(reporting_route_smoke_runtime_image api-gateway "$revision")" == \
			"$original_image_id" ]] || return 1
		gateway_container_id="$(reporting_compose ps --status running -q api-gateway)"
		live_manifest="$(docker inspect --format \
			'{{range .Config.Env}}{{println .}}{{end}}' "$gateway_container_id" |
			sed -n 's/^GATEWAY_ROUTES_JSON=//p')"
		[[ "$live_manifest" == "$target_manifest" ]] || {
			echo 'Marker already advanced, but the live Gateway is not the exact forward route.' >&2
			return 1
		}
		reporting_cutover_require_switch_generation \
			REPORTING "$switch_generation" || return 1
		reporting_cutover_require_forward_scheduler_ready || return 1
		reporting_cutover_require_projection_barrier || return 1
		reporting_cutover_require_archived_route_runtime \
			"$revision" "$revision" || return 1
		reporting_verify_database_lifecycle_unchanged || return 1
		reporting_route_switch_clear_journal || return 1
		echo 'Reporting route marker already advanced; the fully revalidated forward route was preserved.'
		return 0
		;;
	scheduler-switched)
		[[ "$(reporting_cutover_marker_value scheduler_step)" == 'target-owned' &&
			"$(reporting_cutover_marker_value route_evidence_sha256)" == 'pending' ]] || {
			echo 'Reporting pre-route marker no longer matches the rollback journal.' >&2
			return 1
		}
		;;
	*)
		echo "Reporting route journal cannot recover from phase=$phase." >&2
		return 1
		;;
	esac
	if [[ "$database_guard_changed" == 'true' ]]; then
		echo 'Reporting database lifecycle differs from the durable pre-route guard.' >&2
		recovery_failed='true'
	fi
	current_manifest="$(reporting_route_switch_exact_env_manifest)" || return 1
	case "$current_manifest" in
	"$target_manifest")
		reporting_route_switch_replace_env_manifest \
			"$target_manifest" "$original_manifest" || recovery_failed='true'
		;;
	"$original_manifest") ;;
	*)
		echo 'Route switch recovery found neither the exact target nor original manifest.' >&2
		return 1
		;;
	esac
	if [[ "$(reporting_route_switch_exact_env_manifest 2>/dev/null || true)" == \
		"$original_manifest" ]]; then
		restored_env_sha="$(reporting_sha256_file "$REPORTING_ENV_FILE" 2>/dev/null || true)"
		[[ "$restored_env_sha" == "$original_env_sha" ]] || {
			echo 'The route line was restored, but another production env line changed during the switch.' >&2
			recovery_failed='true'
		}
	else
		recovery_failed='true'
	fi
	if ! reporting_cutover_require_dark_gateway_runtime >/dev/null 2>&1 ||
		[[ "$(reporting_route_smoke_runtime_image api-gateway "$revision" \
			2>/dev/null || true)" != "$original_image_id" ]]; then
		reporting_route_switch_recreate_gateway \
			"$revision" "$original_manifest" "$original_image_id" || recovery_failed='true'
	fi
	reporting_cutover_require_dark_gateway_runtime || recovery_failed='true'
	reporting_cutover_require_forward_scheduler_ready || recovery_failed='true'
	reporting_verify_database_lifecycle_unchanged || recovery_failed='true'
	[[ "$recovery_failed" == 'false' ]] || {
		echo 'Reporting route recovery is incomplete; the durable journal was retained.' >&2
		return 1
	}
	reporting_route_switch_clear_journal || return 1
	echo 'Reporting Gateway was restored to the exact dark pre-route runtime.'
}

reporting_route_switch_on_exit() {
	local status=$? recovery_status=0
	trap - EXIT HUP INT TERM
	set +e
	if [[ -e "$REPORTING_ROUTE_SWITCH_JOURNAL" ||
		-L "$REPORTING_ROUTE_SWITCH_JOURNAL" ]]; then
		reporting_route_switch_recover
		recovery_status=$?
		if ((status == 0)); then
			status=1
		fi
	fi
	((recovery_status == 0)) || status=1
	exit "$status"
}

reporting_route_switch_main() {
	local revision phase switch_generation original_manifest original_env_sha
	local original_database_guard_sha gateway_image_id artifact
	[[ "$(id -u)" == '0' ]] || {
		echo 'Reporting route switch must run as root.' >&2
		return 1
	}
	revision="${EXPECTED_REVISION:-}"
	reporting_validate_production_files
	reporting_validate_exact_revision "$revision"
	reporting_cutover_export_pinned_runtime_identity "$revision"
	reporting_assert_no_ambient_compose_overrides \
		REPORTING_IMAGE REPORTING_REVISION \
		NOTIFICATION_DELIVERY_IMAGE NOTIFICATION_DELIVERY_REVISION \
		CAMPAIGNS_IMAGE CAMPAIGNS_REVISION \
		DATABASE_RESTORE_IMAGE DATABASE_RESTORE_REVISION
	acquire_production_deploy_lock 'Atomic Reporting route switch'
	database_restore_guard_assert_before_mutation healthy-required "$REPORTING_ENV_FILE"
	assert_core_database_url_boundaries
	assert_core_database_postgres_identity
	reporting_initialize_database_guard 'Atomic Reporting route switch'
	if [[ -e "$REPORTING_ROUTE_SWITCH_JOURNAL" ||
		-L "$REPORTING_ROUTE_SWITCH_JOURNAL" ]]; then
		reporting_route_switch_recover
		if [[ "$(reporting_cutover_marker_value phase)" == 'routes-switched' ]]; then
			return 0
		fi
		echo 'Recovered an earlier Reporting route switch journal; run --switch again for a new attempt.'
		return 0
	fi
	reporting_cutover_validate_marker
	phase="$(reporting_cutover_marker_value phase)"
	[[ "$phase" == 'scheduler-switched' &&
		"$(reporting_cutover_marker_value revision)" == "$revision" &&
		"$(reporting_cutover_marker_value scheduler_step)" == 'target-owned' &&
		"$(reporting_cutover_marker_value route_evidence_sha256)" == 'pending' ]] || {
		echo 'Atomic route switch requires scheduler-switched with pending route evidence.' >&2
		return 1
	}
	switch_generation="$(reporting_cutover_marker_value switch_generation)"
	reporting_cutover_require_forward_scheduler_ready
	reporting_cutover_require_projection_barrier
	original_manifest="$(reporting_route_switch_exact_env_manifest)"
	reporting_cutover_validate_gateway_manifest_value "$original_manifest" dark || {
		echo 'Atomic route switch requires the exact dark production Gateway manifest.' >&2
		return 1
	}
	reporting_cutover_validate_gateway_manifest_value \
		"$REPORTING_ROUTE_SWITCH_TARGET_MANIFEST" reporting
	reporting_cutover_require_dark_gateway_runtime
	gateway_image_id="$(reporting_route_smoke_runtime_image api-gateway "$revision")"
	[[ "$(reporting_route_switch_gateway_image_id "$revision")" == \
		"$gateway_image_id" ]] || return 1
	reporting_route_smoke_require_safe_file \
		"$REPORTING_ROUTE_SMOKE_TOKEN_FILE" 64 16385 || {
		echo 'Reporting route switch token prerequisite is missing or unsafe.' >&2
		return 1
	}
	for artifact in \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION" \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION_SIGNATURE" \
		"$REPORTING_FRONTEND_RUNTIME_ATTESTATION_PUBLIC_KEY"; do
		reporting_route_smoke_require_safe_file "$artifact" 32 16384 || {
			echo "Reporting route switch prerequisite is missing or unsafe: $artifact" >&2
			return 1
		}
	done
	original_env_sha="$(reporting_sha256_file "$REPORTING_ENV_FILE")"
	original_database_guard_sha="$(reporting_route_switch_database_guard_sha256)"
	reporting_route_switch_write_journal "$revision" "$switch_generation" \
		"$original_env_sha" "$original_database_guard_sha" \
		"$gateway_image_id" "$original_manifest"
	trap reporting_route_switch_on_exit EXIT
	trap 'exit 129' HUP
	trap 'exit 130' INT
	trap 'exit 143' TERM
	reporting_route_switch_replace_env_manifest "$original_manifest" \
		"$REPORTING_ROUTE_SWITCH_TARGET_MANIFEST" "$original_env_sha"
	reporting_route_switch_recreate_gateway "$revision" \
		"$REPORTING_ROUTE_SWITCH_TARGET_MANIFEST" "$gateway_image_id"
	reporting_route_smoke_main
	[[ "$(reporting_cutover_marker_value phase)" == 'routes-switched' &&
		"$(reporting_route_switch_exact_env_manifest)" == \
			"$REPORTING_ROUTE_SWITCH_TARGET_MANIFEST" &&
		"$(reporting_route_smoke_runtime_image api-gateway "$revision")" == \
			"$gateway_image_id" ]] || {
		echo 'Reporting route switch finished without an exact forward boundary.' >&2
		return 1
	}
	reporting_route_switch_clear_journal
	trap - EXIT HUP INT TERM
	echo 'Reporting public routes switched atomically and marker advanced to routes-switched.'
}

reporting_route_smoke_self_test() {
	local source_text switch_text lifecycle_override_text source
	local source_database_guard_count
	for source in \
		reporting_route_smoke_attestation_identity_source \
		reporting_route_smoke_core_auth_source \
		reporting_route_smoke_reporting_auth_source \
		reporting_route_smoke_gateway_rotation_source \
		reporting_route_smoke_live_http_source; do
		"$source" | node --check >/dev/null
	done
	source_text="$(declare -f \
		reporting_route_smoke_core_auth_source \
		reporting_route_smoke_reporting_auth_source \
		reporting_route_smoke_gateway_rotation_source \
		reporting_route_smoke_live_http_source \
		reporting_route_smoke_write_evidence \
		reporting_route_smoke_main)"
	switch_text="$(declare -f \
		reporting_route_switch_journal_value \
		reporting_route_switch_validate_journal \
		reporting_route_switch_write_journal \
		reporting_route_switch_clear_journal \
		reporting_route_switch_database_guard_sha256 \
		reporting_route_switch_exact_env_manifest \
		reporting_route_switch_replace_env_manifest \
		reporting_route_switch_gateway_image_id \
		reporting_route_switch_recreate_gateway \
		reporting_route_switch_recover \
		reporting_route_switch_on_exit \
		reporting_route_switch_main)"
	lifecycle_override_text="$(declare -f reporting_route_smoke_resolve_lifecycle_script)"
	source_database_guard_count="$(printf '%s\n' "$source_text" | awk \
		'/reporting_verify_database_lifecycle_unchanged/ { count += 1 } END { print count + 0 }')"
	(
		REPORTING_GUARD_CONTAINER_ID="$(printf 'a%.0s' {1..64})"
		REPORTING_GUARD_IMAGE_ID="sha256:$(printf 'b%.0s' {1..64})"
		REPORTING_GUARD_SYSTEM_IDENTIFIER='12345'
		REPORTING_GUARD_CONTAINER_SNAPSHOT='container-snapshot'
		REPORTING_GUARD_VOLUME_SNAPSHOT='volume-snapshot'
		REPORTING_GUARD_SECRET_SNAPSHOT='secret-snapshot'
		first="$(reporting_route_switch_database_guard_sha256)"
		REPORTING_GUARD_VOLUME_SNAPSHOT='changed-volume-snapshot'
		second="$(reporting_route_switch_database_guard_sha256)"
		[[ "$first" =~ ^[0-9a-f]{64}$ && "$second" =~ ^[0-9a-f]{64}$ &&
			"$first" != "$second" ]]
	) || {
		echo 'Reporting route cutover self-test rejected the durable database guard digest.' >&2
		return 1
	}
	[[ "$source_text" == *'await auth.logout(refreshToken)'* &&
		"$source_text" == *'state.status = "DEACTIVATED"'* &&
		"$source_text" == *'state.rights = ["USER"]'* &&
		"$source_text" == *'await assert.rejects(client.introspect("Bearer route-smoke"), statusIs(503))'* &&
		"$source_text" == *'keys = [oldKey.jwk, newKey.jwk]'* &&
		"$source_text" == *'/api/v1/admin/reporting/dashboard'* &&
		"$source_text" == *'/api/v1/admin/reporting/overview'* &&
		"$source_text" == *'/api/v1/admin/reporting/registrations-by-month'* &&
		"$source_text" == *'/api/v1/admin/reporting/daily-summary/settings'* &&
		"$source_text" == *'/api/v1/dev-tools/database-restores/settings'* &&
		"$source_text" == *'Legacy dashboard was removed before cleanup'* &&
		"$source_text" == *'legacyStatisticsRetained: true'* &&
		"$source_text" == *'forged.code !== "authentication_required"'* &&
		"$source_text" == *'reporting_cutover_validate_frontend_runtime_attestation'* &&
		"$source_text" == *'reporting_cutover_validate_route_evidence'* &&
		"$source_text" == *'reporting_cutover_verify_routes'* &&
		"$source_database_guard_count" -eq 2 &&
		"$source_text" != *'reporting_core_migration_psql'* &&
		"$source_text" != *'rabbitmqadmin publish'* &&
		"$source_text" != *'docker compose up'* &&
		"$switch_text" == *'original_gateway_routes_json'* &&
		"$switch_text" == *'target_gateway_routes_json'* &&
		"$switch_text" == *'original_env_sha256'* &&
		"$switch_text" == *'original_database_guard_sha256'* &&
		"$switch_text" == *'Reporting database lifecycle differs from the durable pre-route guard.'* &&
		"$switch_text" == *'reporting_route_switch_replace_env_manifest'* &&
		"$switch_text" == *'reporting_compose up -d --no-deps --force-recreate api-gateway'* &&
		"$switch_text" != *'--no-build'* &&
		"$switch_text" != *'reporting_compose build'* &&
		"$switch_text" == *"== 'scheduler-switched'"* &&
		"$switch_text" == *'routes-switched)'* &&
		"$switch_text" == *'reporting_cutover_require_switch_generation'* &&
		"$switch_text" == *'REPORTING "$switch_generation" || return 1'* &&
		"$switch_text" == *'reporting_cutover_require_dark_gateway_runtime'* &&
		"$switch_text" == *'reporting_cutover_require_forward_scheduler_ready || return 1'* &&
		"$switch_text" == *'reporting_cutover_require_projection_barrier || return 1'* &&
		"$switch_text" == *'"$revision" "$revision" || return 1'* &&
		"$switch_text" == *'reporting_verify_database_lifecycle_unchanged || return 1'* &&
		"$switch_text" == *'reporting_route_smoke_main'* &&
		"$switch_text" != *'reporting_cutover_rollback_routes'* &&
		"$switch_text" == *"trap 'exit 129' HUP"* &&
		"$switch_text" == *'sync -f "$temporary"'* &&
		"$switch_text" == *'mv -- "$temporary" "$REPORTING_ENV_FILE"'* &&
		"$switch_text" == *'reporting_route_switch_clear_journal || return 1'* &&
		"$lifecycle_override_text" == *'REPORTING_CUTOVER_LIFECYCLE_SCRIPT'* &&
		"$lifecycle_override_text" == *'"$override" == /*'* &&
		"$lifecycle_override_text" == *'reporting_route_smoke_stat_owner_before_source'* &&
		"$lifecycle_override_text" == *"== '0:0'"* &&
		"$lifecycle_override_text" == *'reporting_route_smoke_stat_mode_before_source'* &&
		"$lifecycle_override_text" == *"== '600'"* &&
		"$lifecycle_override_text" == *'! -L "$override"'* ]] || {
		echo 'Reporting route cutover smoke self-test found an incomplete or mutating contract.' >&2
		return 1
	}
	echo 'Reporting route cutover smoke contracts passed.'
}

case "${1:-}" in
--self-test)
	[[ $# == 1 ]] || exit 1
	reporting_route_smoke_self_test
	;;
--switch)
	[[ $# == 1 ]] || exit 1
	reporting_route_switch_main
	;;
'')
	[[ $# == 0 ]] || exit 1
	reporting_route_smoke_main
	;;
*)
	echo "Usage: $0 [--self-test|--switch]" >&2
	exit 1
	;;
esac
