#!/usr/bin/env bash

set -Eeuo pipefail
umask 077
export LC_ALL=C

IDENTITY_SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_ROOT="${APP_ROOT:-/opt/winwidget}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
IDENTITY_CORE_CUTOVER_CLI="${IDENTITY_CORE_CUTOVER_CLI:-dist/src/identity-core-cutover-main.js}"
IDENTITY_SERVICE_CUTOVER_CLI="${IDENTITY_SERVICE_CUTOVER_CLI:-dist/src/cutover/main.js}"
identity_cutover_root="${IDENTITY_CUTOVER_ARTIFACT_ROOT:-$APP_ROOT/deploy/backend/identity-cutover-artifacts}"
identity_cutover_marker="${IDENTITY_CUTOVER_MARKER:-$APP_ROOT/deploy/backend/.identity-cutover-v1}"
identity_core_backup="$identity_cutover_root/core-pre-identity-cutover.dump"
identity_pre_backup="$identity_cutover_root/identity-pre-ownership.dump"
identity_post_backup="$identity_cutover_root/identity-post-ownership.dump"
identity_pre_restore_evidence="$identity_cutover_root/identity-pre-restore.json"
identity_post_restore_evidence="$identity_cutover_root/identity-post-restore.json"
identity_snapshot="$identity_cutover_root/core-frozen-identity-snapshot-v1.json"
identity_core_preflight_evidence="$identity_cutover_root/core-preflight.json"
identity_core_frozen_preflight_evidence="$identity_cutover_root/core-frozen-preflight.json"
identity_core_frozen_projection_evidence="$identity_cutover_root/core-frozen-projection-drain.json"
identity_core_frozen_destination_evidence="$identity_cutover_root/core-frozen-destination-drain.json"
identity_core_frozen_destination_state_evidence="$identity_cutover_root/core-frozen-destination-state.json"
identity_core_fence_evidence="$identity_cutover_root/core-source-fence.json"
identity_core_unfence_evidence="$identity_cutover_root/core-source-unfence.json"
identity_core_post_boundary_fence_evidence="$identity_cutover_root/core-post-boundary-fence-status.json"
identity_core_post_boundary_projection_evidence="$identity_cutover_root/core-post-boundary-projection-drain.json"
identity_core_post_boundary_destination_evidence="$identity_cutover_root/core-post-boundary-destination-drain.json"
identity_service_shadow_status_evidence="$identity_cutover_root/identity-shadow-status.json"
identity_service_import_evidence="$identity_cutover_root/identity-import.json"
identity_service_dark_status_evidence="$identity_cutover_root/identity-dark-status.json"
identity_service_dark_readiness_evidence="$identity_cutover_root/identity-dark-readiness.json"
identity_service_activation_evidence="$identity_cutover_root/identity-activation.json"
identity_service_completion_evidence="$identity_cutover_root/identity-completion.json"
identity_frozen_core_api_id=''
identity_frozen_core_integration_id=''
identity_frozen_core_outbox_id=''
identity_frozen_gateway_id=''
identity_frozen_core_recovery='false'
identity_cutover_active_stage=''

readonly identity_cutover_confirmation='CUTOVER IDENTITY OWNERSHIP'
readonly identity_core_expand_migration='20260814020000_detach_identity_foreign_keys'
readonly identity_core_cleanup_migration='20260815000000_remove_legacy_identity_core_source'
readonly identity_core_outbox_drain_attempts=90

# shellcheck source=scripts/identity-release-identity.sh
source "$IDENTITY_SCRIPT_ROOT/scripts/identity-release-identity.sh"
# shellcheck source=scripts/identity-database-lifecycle.sh
source "$IDENTITY_SCRIPT_ROOT/scripts/identity-database-lifecycle.sh"
# shellcheck source=scripts/deploy-identity-production.sh
source "$IDENTITY_SCRIPT_ROOT/scripts/deploy-identity-production.sh"
# shellcheck source=scripts/database-restore-production-guard.sh
source "$IDENTITY_SCRIPT_ROOT/scripts/database-restore-production-guard.sh"
# shellcheck source=scripts/production-deploy-lock.sh
source "$IDENTITY_SCRIPT_ROOT/scripts/production-deploy-lock.sh"

identity_cutover_fail() {
	printf 'identity_cutover_error=%s\n' "$1" >&2
	return 1
}

identity_cutover_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
	fi
}

identity_cutover_text_sha256() {
	node -e 'process.stdin.setEncoding("utf8");let value="";process.stdin.on("data",chunk=>value+=chunk);process.stdin.on("end",()=>process.stdout.write(require("node:crypto").createHash("sha256").update(value).digest("hex")));'
}

identity_cutover_validate_private_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" && -s "$1" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$1")" == '0:0:600' ]]
	fi
}

identity_cutover_require_artifact_root() {
	if [[ ! -e "$identity_cutover_root" && ! -L "$identity_cutover_root" ]]; then
		mkdir -m 700 "$identity_cutover_root"
		chown 0:0 "$identity_cutover_root"
	fi
	[[ -d "$identity_cutover_root" && ! -L "$identity_cutover_root" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_cutover_root")" == '0:0:700' ]] ||
			identity_cutover_fail 'Identity artifact directory must be root-owned mode 700'
	fi
}

identity_cutover_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z_]+$ ]] || return 1
	identity_cutover_validate_marker || return 1
	awk -F= -v key="$1" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$identity_cutover_marker"
}

identity_cutover_validate_marker() {
	[[ -f "$identity_cutover_marker" && ! -L "$identity_cutover_marker" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_cutover_marker")" == '0:0:600' ]] || return 1
	fi
	awk -F= '
    $1 !~ /^(version|phase|revision|core_image_id|identity_image_id|gateway_image_id|campaigns_image_id|reporting_image_id|widgets_image_id|billing_image_id|route_sha256|core_backup_sha256|identity_pre_backup_sha256|pre_restore_evidence_sha256|snapshot_sha256|identity_post_backup_sha256|post_restore_evidence_sha256|updated_at)$/ { exit 1 }
    { count[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
    END {
      for (key in count) if (count[key] != 1) exit 1
		if (NR != 18 || value["version"] != "1" ||
          value["phase"] !~ /^(preflight-verified|restore-verified|forward-only|active|complete)$/ ||
          value["revision"] !~ /^[0-9a-f]{40}$/ ||
          value["core_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
		  value["identity_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
		  value["gateway_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
		  value["campaigns_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
		  value["reporting_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
		  value["widgets_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
		  value["billing_image_id"] !~ /^sha256:[0-9a-f]{64}$/ ||
          value["route_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
      for (key in value) if (key ~ /_sha256$/ && key != "route_sha256" &&
          value[key] !~ /^(pending|[0-9a-f]{64})$/) exit 1
      if (value["phase"] ~ /^(restore-verified|forward-only|active|complete)$/ &&
          (value["core_backup_sha256"] == "pending" ||
           value["identity_pre_backup_sha256"] == "pending" ||
           value["pre_restore_evidence_sha256"] == "pending")) exit 1
      if (value["phase"] ~ /^(forward-only|active|complete)$/ &&
          value["snapshot_sha256"] == "pending") exit 1
      if (value["phase"] == "complete" &&
          (value["identity_post_backup_sha256"] == "pending" ||
           value["post_restore_evidence_sha256"] == "pending")) exit 1
    }
  ' "$identity_cutover_marker"
}

identity_cutover_transition_allowed() {
	case "$1:$2" in
	absent:preflight-verified | preflight-verified:preflight-verified | \
		preflight-verified:restore-verified | restore-verified:restore-verified | \
		restore-verified:forward-only | forward-only:forward-only | \
		forward-only:active | active:active | active:complete | complete:complete) return 0 ;;
	*) return 1 ;;
	esac
}

identity_cutover_write_marker() {
	[[ $# -eq 17 ]] || return 1
	local current='absent' temporary="${identity_cutover_marker}.tmp.$$"
	if [[ -e "$identity_cutover_marker" || -L "$identity_cutover_marker" ]]; then
		identity_cutover_validate_marker || return 1
		current="$(identity_cutover_marker_value phase)"
	fi
	identity_cutover_transition_allowed "$current" "$1" ||
		identity_cutover_fail "unsafe Identity cutover transition: $current -> $1" || return 1
	{
		printf 'version=1\nphase=%s\nrevision=%s\n' "$1" "$2"
		printf 'core_image_id=%s\nidentity_image_id=%s\ngateway_image_id=%s\n' "$3" "$4" "$5"
		printf 'campaigns_image_id=%s\nreporting_image_id=%s\nwidgets_image_id=%s\nbilling_image_id=%s\n' "$6" "$7" "$8" "$9"
		printf 'route_sha256=%s\ncore_backup_sha256=%s\nidentity_pre_backup_sha256=%s\n' "${10}" "${11}" "${12}"
		printf 'pre_restore_evidence_sha256=%s\nsnapshot_sha256=%s\n' "${13}" "${14}"
		printf 'identity_post_backup_sha256=%s\npost_restore_evidence_sha256=%s\n' "${15}" "${16}"
		printf 'updated_at=%s\n' "${17}"
	} >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$identity_cutover_marker"
	identity_cutover_validate_marker
}

identity_cutover_route_sha() {
	identity_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON | identity_cutover_text_sha256
}

identity_cutover_require_route_contract() {
	local routes jwks
	routes="$(identity_read_env_value "$ENV_FILE" GATEWAY_ROUTES_JSON)" || return 1
	jwks="$(identity_read_env_value "$ENV_FILE" JWT_JWKS_URL)" || return 1
	GATEWAY_ROUTES_JSON="$routes" JWT_JWKS_URL="$jwks" node <<'NODE'
const routes = JSON.parse(process.env.GATEWAY_ROUTES_JSON);
const required = [
  ['identity-auth', '/api/v1/auth'],
  ['identity-users', '/api/v1/users'],
  ['identity-telegram-auth', '/api/v1/telegram-auth'],
  ['identity-info-webhook', '/api/v1/telegram-bot/webhook'],
];
const match = ([id, pathPrefix]) => routes.filter(route =>
  route?.id === id && route.pathPrefix === pathPrefix &&
  route.upstreamUrl === 'http://127.0.0.1:4900' &&
  route.authPolicy === 'optional' && route.timeoutMs === 60000).length === 1;
if (!Array.isArray(routes) || !required.every(match) ||
    routes.filter(route => route?.upstreamUrl === 'http://127.0.0.1:4900').length !== 4 ||
    routes.some(route => route?.pathPrefix === '/api/v1/telegram-bot/support-webhook' &&
      route.upstreamUrl === 'http://127.0.0.1:4900') ||
    !routes.some(route => route?.id === 'monolith' && route.pathPrefix === '/api/v1' &&
      route.upstreamUrl === 'http://127.0.0.1:4200') ||
    process.env.JWT_JWKS_URL !==
      'http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json') process.exit(1);
NODE
}

identity_cutover_require_tokens() {
	local key value values='|'
	for key in NOTIFICATION_DELIVERY_INTERNAL_TOKEN CAMPAIGNS_INTERNAL_TOKEN \
		REPORTING_INTERNAL_TOKEN WIDGETS_INTERNAL_TOKEN BILLING_INTERNAL_TOKEN; do
		value="$(identity_read_env_value "$ENV_FILE" "$key")" || return 1
		[[ ${#value} -ge 32 && "$value" != *$'\n'* && "$value" != *$'\r'* &&
			"$values" != *"|$value|"* ]] ||
			identity_cutover_fail "Internal credential contract failed for $key" || return 1
		values+="$value|"
	done
	for key in IDENTITY_CORE_TOKEN IDENTITY_CAMPAIGNS_TOKEN \
		IDENTITY_REPORTING_TOKEN IDENTITY_WIDGETS_TOKEN IDENTITY_BILLING_TOKEN \
		CORE_IDENTITY_TOKEN BILLING_CAMPAIGNS_TOKEN BILLING_IDENTITY_TOKEN \
		WIDGETS_IDENTITY_TOKEN; do
		value="$(identity_read_env_value "$ENV_FILE" "$key")" || return 1
		[[ ${#value} -ge 32 && "$value" != *$'\n'* && "$value" != *$'\r'* &&
			"$values" != *"|$value|"* ]] ||
			identity_cutover_fail "Identity credential contract failed for $key" || return 1
		values+="$value|"
	done
	unset value values
}

identity_cutover_require_rotated_signing_key() {
	docker run --rm --network none --env-file "$ENV_FILE" --entrypoint node \
		"winwidget-identity:git-$EXPECTED_REVISION" -e '
const { createPrivateKey, createPublicKey, randomBytes, sign, verify } = require("node:crypto");
const fail = () => process.exit(1);
const privateValue = process.env.IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64 || "";
const jwksValue = process.env.IDENTITY_JWT_ACCESS_JWKS_BASE64 || "";
const activeKid = process.env.IDENTITY_JWT_ACCESS_ACTIVE_KID || "";
if (!privateValue || !jwksValue || !activeKid ||
    privateValue === process.env.JWT_ACCESS_PRIVATE_KEY_BASE64 ||
    jwksValue === process.env.JWT_ACCESS_JWKS_BASE64 ||
    activeKid === process.env.JWT_ACCESS_ACTIVE_KID) fail();
let privateKey;
let jwks;
try {
  privateKey = createPrivateKey(Buffer.from(privateValue, "base64"));
  jwks = JSON.parse(Buffer.from(jwksValue, "base64").toString("utf8"));
} catch { fail(); }
if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "rsa" ||
    (privateKey.asymmetricKeyDetails?.modulusLength || 0) < 3072 ||
    !Array.isArray(jwks?.keys) || !jwks.keys.length) fail();
const active = jwks.keys.find(key => key?.kid === activeKid);
if (!active || active.kty !== "RSA" || active.alg !== "RS256" || active.use !== "sig" ||
    ["d", "p", "q", "dp", "dq", "qi", "oth"].some(name => name in active)) fail();
let publicKey;
try { publicKey = createPublicKey({ key: active, format: "jwk" }); } catch { fail(); }
const challenge = randomBytes(64);
if (!verify("sha256", challenge, publicKey, sign("sha256", challenge, privateKey))) fail();
'
}

identity_cutover_require_common() {
	identity_database_require_root
	identity_database_require_inputs
	identity_cutover_require_artifact_root
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	identity_cutover_require_route_contract ||
		identity_cutover_fail 'Identity route/JWKS candidate is incomplete or unsafe' || return 1
	identity_cutover_require_tokens
	identity_cutover_require_rotated_signing_key ||
		identity_cutover_fail 'Identity signing key must be valid and rotated away from Core' || return 1
	[[ "$(identity_read_env_value "$ENV_FILE" IDENTITY_INTERNAL_BASE_URL)" == 'http://127.0.0.1:4900' ]] ||
		identity_cutover_fail 'Identity internal clients must use the loopback Identity endpoint' || return 1
}

identity_cutover_image_id() {
	docker image inspect --format '{{.Id}}' "$1"
}

identity_cutover_verify_image() {
	[[ $# -eq 2 ]] || return 1
	local image="$1" revision="$2" id user
	id="$(identity_cutover_image_id "$image")" || return 1
	user="$(docker image inspect --format '{{.Config.User}}' "$image")" || return 1
	[[ "$id" =~ ^sha256:[0-9a-f]{64}$ &&
		"$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$revision" &&
		-n "$user" && "$user" != 'root' && "$user" != '0' ]] ||
		identity_cutover_fail "immutable non-root image verification failed: $image"
}

identity_cutover_run_evidence() {
	[[ $# -ge 4 ]] || return 1
	local service="$1" destination="$2" cli="$3"
	shift 3
	local partial="${destination}.partial.$$"
	[[ ! -e "$destination" && ! -L "$destination" && ! -e "$partial" ]] || return 1
	if ! identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		run --rm -T --no-deps "$service" node "$cli" "$@" >"$partial"; then
		rm -f -- "$partial"
		return 1
	fi
	chmod 600 "$partial"
	chown 0:0 "$partial"
	if ! node - "$partial" <<'NODE'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\n/);
if (lines.length !== 1) process.exit(1);
const value = JSON.parse(lines[0]);
if (value?.ok !== true) process.exit(1);
NODE
	then
		rm -f -- "$partial"
		return 1
	fi
	mv -f -- "$partial" "$destination"
	identity_cutover_validate_private_file "$destination"
}

identity_cutover_assert_shadow_status_evidence() {
	[[ $# -eq 1 ]] || return 1
	local evidence="$1"
	identity_cutover_validate_private_file "$evidence" || return 1
	node - "$evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const counts = value?.counts;
if (value?.ok !== true || value.action !== 'status' || value.phase !== 'SHADOW' ||
    value.ownershipGeneration !== '0' || value.sourceSnapshotSha256 !== null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.databaseId || '') ||
    !counts || Object.keys(counts).sort().join(',') !==
      'challenges,identities,outbox,sessions,telegramNotificationChannels,users' ||
    Object.values(counts).some(count => count !== 0)) process.exit(1);
NODE
}

identity_cutover_apply_expand_migration() {
	[[ -f "$SERVER_ROOT/prisma/migrations/$identity_core_expand_migration/migration.sql" &&
		! -e "$SERVER_ROOT/prisma/migrations/$identity_core_cleanup_migration" ]] ||
		identity_cutover_fail 'Identity cutover requires the exact expand migration and forbids Core cleanup in the ownership SHA' || return 1
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile migration run --rm -T --no-deps migrate
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		run --rm -T --no-deps --entrypoint node api -e '
const { PrismaClient } = require("@prisma/client");
const url = process.env.DATABASE_URL_PRODUCTION;
if (!url) process.exit(64);
const prisma = new PrismaClient({ datasources: { db: { url } } });
(async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT migration_name, finished_at, rolled_back_at, logs
     FROM _prisma_migrations WHERE migration_name = $1`,
    process.argv[1],
  );
  const constraints = await prisma.$queryRawUnsafe(
    `SELECT conname FROM pg_constraint WHERE conname IN
      ('admin_event_logs_admin_id_fkey', 'admin_event_logs_target_user_id_fkey',
       'integration_delivery_failures_resolved_by_id_fkey')`,
  );
  if (rows.length !== 1 || !rows[0].finished_at || rows[0].rolled_back_at || rows[0].logs ||
      constraints.length !== 0) process.exit(1);
})().then(() => prisma.$disconnect()).catch(async () => {
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
' "$identity_core_expand_migration"
}

identity_cutover_preflight() {
	identity_cutover_require_common
	acquire_production_deploy_lock 'Identity cutover preflight'
	[[ "$(identity_database_current_phase)" == 'prepared' &&
		"$(identity_database_marker_value ownership_revision)" == "$EXPECTED_REVISION" ]] ||
		identity_cutover_fail 'Identity preflight requires the exact prepared database candidate' || return 1
	if [[ -e "$identity_cutover_marker" || -L "$identity_cutover_marker" ]]; then
		identity_cutover_validate_marker || return 1
		[[ "$(identity_cutover_marker_value revision)" == "$EXPECTED_REVISION" ]] ||
			identity_cutover_fail 'Identity cutover marker belongs to another revision' || return 1
		printf 'identity_cutover_phase=%s\n' "$(identity_cutover_marker_value phase)"
		return
	fi
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		build --pull api api-gateway maintenance-worker database-restore-worker \
		campaigns-service reporting-service widgets-service billing-api
	local core_image="winwidget-api:git-$EXPECTED_REVISION"
	local gateway_image="winwidget-api-gateway:git-$EXPECTED_REVISION"
	local identity_image="winwidget-identity:git-$EXPECTED_REVISION"
	local campaigns_image="winwidget-campaigns:git-$EXPECTED_REVISION"
	local reporting_image="winwidget-reporting:git-$EXPECTED_REVISION"
	local widgets_image="winwidget-widgets:git-$EXPECTED_REVISION"
	local billing_image="winwidget-billing:git-$EXPECTED_REVISION"
	identity_cutover_verify_image "$core_image" "$EXPECTED_REVISION"
	identity_cutover_verify_image "$gateway_image" "$EXPECTED_REVISION"
	identity_cutover_verify_image "$identity_image" "$EXPECTED_REVISION"
	identity_cutover_verify_image "$campaigns_image" "$EXPECTED_REVISION"
	identity_cutover_verify_image "$reporting_image" "$EXPECTED_REVISION"
	identity_cutover_verify_image "$widgets_image" "$EXPECTED_REVISION"
	identity_cutover_verify_image "$billing_image" "$EXPECTED_REVISION"
	[[ "$(identity_cutover_image_id "$identity_image")" == "$(identity_database_marker_value image_id)" ]] ||
		identity_cutover_fail 'Identity candidate image differs from the prepared database marker' || return 1
	identity_cutover_apply_expand_migration
	identity_cutover_run_evidence api "$identity_core_preflight_evidence" \
		"$IDENTITY_CORE_CUTOVER_CLI" preflight
	identity_cutover_run_evidence identity-api "$identity_service_shadow_status_evidence" \
		"$IDENTITY_SERVICE_CUTOVER_CLI" status
	identity_cutover_assert_shadow_status_evidence "$identity_service_shadow_status_evidence" ||
		identity_cutover_fail 'Identity pre-import target must be an empty SHADOW database' || return 1
	identity_cutover_write_marker preflight-verified "$EXPECTED_REVISION" \
		"$(identity_cutover_image_id "$core_image")" \
		"$(identity_cutover_image_id "$identity_image")" \
		"$(identity_cutover_image_id "$gateway_image")" \
		"$(identity_cutover_image_id "$campaigns_image")" \
		"$(identity_cutover_image_id "$reporting_image")" \
		"$(identity_cutover_image_id "$widgets_image")" \
		"$(identity_cutover_image_id "$billing_image")" \
		"$(identity_cutover_route_sha)" pending pending pending pending pending pending \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'identity_cutover_phase=preflight-verified\n'
}

identity_cutover_assert_bound_images() {
	local core_image="winwidget-api:git-$EXPECTED_REVISION"
	local gateway_image="winwidget-api-gateway:git-$EXPECTED_REVISION"
	local identity_image="winwidget-identity:git-$EXPECTED_REVISION"
	local campaigns_image="winwidget-campaigns:git-$EXPECTED_REVISION"
	local reporting_image="winwidget-reporting:git-$EXPECTED_REVISION"
	local widgets_image="winwidget-widgets:git-$EXPECTED_REVISION"
	local billing_image="winwidget-billing:git-$EXPECTED_REVISION"
	identity_cutover_verify_image "$core_image" "$EXPECTED_REVISION" &&
		identity_cutover_verify_image "$gateway_image" "$EXPECTED_REVISION" &&
		identity_cutover_verify_image "$identity_image" "$EXPECTED_REVISION" &&
		identity_cutover_verify_image "$campaigns_image" "$EXPECTED_REVISION" &&
		identity_cutover_verify_image "$reporting_image" "$EXPECTED_REVISION" &&
		identity_cutover_verify_image "$widgets_image" "$EXPECTED_REVISION" &&
		identity_cutover_verify_image "$billing_image" "$EXPECTED_REVISION" &&
		[[ "$(identity_cutover_image_id "$core_image")" == "$(identity_cutover_marker_value core_image_id)" &&
			"$(identity_cutover_image_id "$gateway_image")" == "$(identity_cutover_marker_value gateway_image_id)" &&
			"$(identity_cutover_image_id "$identity_image")" == "$(identity_cutover_marker_value identity_image_id)" &&
			"$(identity_cutover_image_id "$campaigns_image")" == "$(identity_cutover_marker_value campaigns_image_id)" &&
			"$(identity_cutover_image_id "$reporting_image")" == "$(identity_cutover_marker_value reporting_image_id)" &&
			"$(identity_cutover_image_id "$widgets_image")" == "$(identity_cutover_marker_value widgets_image_id)" &&
			"$(identity_cutover_image_id "$billing_image")" == "$(identity_cutover_marker_value billing_image_id)" &&
			"$(identity_cutover_route_sha)" == "$(identity_cutover_marker_value route_sha256)" ]]
}

identity_cutover_create_backup() {
	[[ $# -eq 3 ]] || return 1
	local url_key="$1" schema="$2" destination="$3" partial="${destination}.partial" size
	if [[ -e "$destination" || -L "$destination" ]]; then
		identity_cutover_validate_private_file "$destination" &&
			[[ "$(head -c 5 "$destination")" == 'PGDMP' ]] || return 1
		return
	fi
	[[ ! -e "$partial" && ! -L "$partial" ]] || return 1
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		run --rm -T --no-deps --entrypoint node maintenance-worker -e '
const { spawnSync } = require("node:child_process");
const key = process.argv[1];
const schema = process.argv[2];
const raw = process.env[key];
if (!raw) process.exit(64);
const url = new URL(raw);
const queryKeys = [...url.searchParams.keys()];
const sslmode = url.searchParams.get("sslmode");
if (url.protocol !== "postgresql:" || !url.username || !url.password ||
    !url.hostname || !url.pathname.slice(1) ||
    url.searchParams.getAll("schema").length !== 1 ||
    url.searchParams.get("schema") !== schema ||
    url.searchParams.getAll("sslmode").length !== 1 ||
    !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode) ||
    queryKeys.length !== 2 || queryKeys.some(key => !["schema", "sslmode"].includes(key))) process.exit(65);
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: sslmode };
delete env[key];
const result = spawnSync("pg_dump", ["--format=custom", "--compress=6", "--no-owner",
  "--no-acl", "--no-password", "--schema", schema],
  { env, stdio: ["ignore", "inherit", "inherit"] });
if (result.error || result.signal || result.status !== 0) process.exit(result.status || 66);
' "$url_key" "$schema" >"$partial"
	[[ "$(head -c 5 "$partial")" == 'PGDMP' ]] || return 1
	size="$(wc -c <"$partial" | tr -d '[:space:]')"
	[[ "$size" =~ ^[1-9][0-9]*$ && "$size" -le $((49 * 1024 * 1024)) ]] || return 1
	chmod 600 "$partial"
	chown 0:0 "$partial"
	mv -f -- "$partial" "$destination"
}

identity_cutover_restore_evidence_matches() {
	[[ $# -eq 3 ]] || return 1
	local evidence="$1" phase="$2" dump_sha="$3"
	identity_cutover_validate_private_file "$evidence" || return 1
	REVISION="$EXPECTED_REVISION" PHASE="$phase" DUMP_SHA="$dump_sha" \
		node - "$evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value?.schemaVersion !== 1 || value.action !== 'identity-actual-backup-restore-rehearsal' ||
    value.target !== 'identity' || value.status !== 'passed' ||
    value.revision !== process.env.REVISION || value.phase !== process.env.PHASE ||
    value.dump?.sha256 !== process.env.DUMP_SHA ||
    Object.values(value.checks || {}).some(item => item !== true)) process.exit(1);
NODE
}

identity_cutover_run_restore_rehearsal() {
	[[ $# -eq 3 ]] || return 1
	local phase="$1" dump="$2" evidence="$3" dump_sha
	dump_sha="$(identity_cutover_sha256 "$dump")"
	if [[ -e "$evidence" || -L "$evidence" ]]; then
		identity_cutover_restore_evidence_matches "$evidence" "$phase" "$dump_sha"
		return
	fi
	bash "$IDENTITY_SCRIPT_ROOT/scripts/identity-backup-restore-rehearsal.sh" \
		--revision "$EXPECTED_REVISION" --phase "$phase" --dump "$dump" \
		--expected-sha256 "$dump_sha" \
		--database-id "$(identity_database_marker_value database_id)" \
		--source-system-identifier "$(identity_database_marker_value database_system_identifier)" \
		--evidence-file "$evidence"
}

identity_cutover_verify() {
	identity_cutover_require_common
	acquire_production_deploy_lock 'Identity cutover restore verification'
	identity_cutover_validate_marker || return 1
	[[ "$(identity_cutover_marker_value revision)" == "$EXPECTED_REVISION" &&
		"$(identity_cutover_marker_value phase)" =~ ^(preflight-verified|restore-verified)$ &&
		"$(identity_database_current_phase)" == 'prepared' ]] ||
		identity_cutover_fail 'Identity verify requires the prepared preflight candidate' || return 1
	identity_cutover_assert_bound_images ||
		identity_cutover_fail 'Identity candidate images or route manifest drifted after preflight' || return 1
	if [[ "$(identity_cutover_marker_value phase)" == 'restore-verified' ]]; then
		[[ "$(identity_cutover_sha256 "$identity_core_backup")" == "$(identity_cutover_marker_value core_backup_sha256)" &&
			"$(identity_cutover_sha256 "$identity_pre_backup")" == "$(identity_cutover_marker_value identity_pre_backup_sha256)" &&
			"$(identity_cutover_sha256 "$identity_pre_restore_evidence")" == "$(identity_cutover_marker_value pre_restore_evidence_sha256)" ]] ||
			identity_cutover_fail 'Identity pre-cutover artifacts drifted after verification' || return 1
		printf 'identity_cutover_phase=restore-verified\n'
		return
	fi
	identity_cutover_create_backup DATABASE_BACKUP_URL public "$identity_core_backup"
	identity_cutover_create_backup IDENTITY_BACKUP_URL identity "$identity_pre_backup"
	identity_cutover_run_restore_rehearsal pre-cutover "$identity_pre_backup" \
		"$identity_pre_restore_evidence"
	identity_cutover_write_marker restore-verified "$EXPECTED_REVISION" \
		"$(identity_cutover_marker_value core_image_id)" \
		"$(identity_cutover_marker_value identity_image_id)" \
		"$(identity_cutover_marker_value gateway_image_id)" \
		"$(identity_cutover_marker_value campaigns_image_id)" \
		"$(identity_cutover_marker_value reporting_image_id)" \
		"$(identity_cutover_marker_value widgets_image_id)" \
		"$(identity_cutover_marker_value billing_image_id)" \
		"$(identity_cutover_marker_value route_sha256)" \
		"$(identity_cutover_sha256 "$identity_core_backup")" \
		"$(identity_cutover_sha256 "$identity_pre_backup")" \
		"$(identity_cutover_sha256 "$identity_pre_restore_evidence")" \
		pending pending pending "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'identity_cutover_phase=restore-verified\n'
}

identity_cutover_image_uid_gid() {
	[[ $# -eq 1 ]] || return 1
	docker run --rm --network none --log-driver none --entrypoint sh "$1" \
		-c 'printf "%s:%s\n" "$(id -u)" "$(id -g)"'
}

identity_cutover_cleanup_active_stage() {
	local stage="$identity_cutover_active_stage"
	[[ -n "$stage" ]] || return 0
	case "$stage" in
	"$identity_cutover_root/.core-export-$EXPECTED_REVISION" | \
		"$identity_cutover_root/.identity-import-$EXPECTED_REVISION") ;;
	*) return 1 ;;
	esac
	[[ -d "$stage" && ! -L "$stage" ]] || {
		identity_cutover_active_stage=''
		return 0
	}
	rm -f -- "$stage/snapshot.json"
	rmdir "$stage"
	identity_cutover_active_stage=''
}

identity_cutover_prepare_fresh_evidence() {
	[[ $# -eq 1 ]] || return 1
	local destination="$1"
	case "$destination" in
	"$identity_core_frozen_preflight_evidence" | \
	"$identity_core_frozen_projection_evidence" | \
		"$identity_core_frozen_destination_evidence" | \
		"$identity_core_frozen_destination_state_evidence" | \
		"$identity_core_fence_evidence" | \
		"$identity_core_unfence_evidence" | \
		"$identity_core_post_boundary_fence_evidence" | \
		"$identity_core_post_boundary_projection_evidence" | \
		"$identity_core_post_boundary_destination_evidence") ;;
	*) return 1 ;;
	esac
	if [[ -e "$destination" || -L "$destination" ]]; then
		identity_cutover_validate_private_file "$destination" || return 1
		rm -f -- "$destination"
	fi
	[[ ! -e "${destination}.partial.$$" && ! -L "${destination}.partial.$$" ]]
}

identity_cutover_assert_core_preflight_evidence() {
	[[ $# -eq 1 ]] || return 1
	identity_cutover_validate_private_file "$1" || return 1
	node - "$1" <<'NODE'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\n/);
if (lines.length !== 1) process.exit(1);
const value = JSON.parse(lines[0]);
if (value?.ok !== true || value.action !== 'preflight' ||
	value.identityOwnershipFence !== 'OPEN' || value.fencedRevision !== null ||
	value.fencedAt !== null || !/^(0|[1-9][0-9]*)$/.test(value.fenceGeneration || '') ||
	value.emailCollisionGroups !== 0 || value.phoneCollisionGroups !== 0 ||
	value.reportingVersionCoverageFailures !== 0 ||
	value.billingVersionCoverageFailures !== 0 ||
	value.legacyDestinationFailuresUnresolved !== 0 ||
    !Number.isSafeInteger(value.legacyIdentityOutboxPending) ||
    value.legacyIdentityOutboxPending !== 0) process.exit(1);
NODE
}

identity_cutover_assert_core_fence_evidence() {
	[[ $# -eq 3 && "$2" =~ ^(status|fence|unfence)$ && "$3" =~ ^(OPEN|FENCED)$ ]] || return 1
	identity_cutover_validate_private_file "$1" || return 1
	REVISION="$EXPECTED_REVISION" EXPECTED_ACTION="$2" EXPECTED_FENCE="$3" \
		node - "$1" <<'NODE'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\n/);
if (lines.length !== 1) process.exit(1);
const value = JSON.parse(lines[0]);
const generationValid = /^(0|[1-9][0-9]*)$/.test(value?.fenceGeneration || '');
const fenced = process.env.EXPECTED_FENCE === 'FENCED';
if (value?.ok !== true || value.action !== process.env.EXPECTED_ACTION ||
    value.identityOwnershipFence !== process.env.EXPECTED_FENCE || !generationValid ||
    (fenced && (BigInt(value.fenceGeneration) < 1n ||
      value.fencedRevision !== process.env.REVISION ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.fencedAt || ''))) ||
    (!fenced && (value.fencedRevision !== null || value.fencedAt !== null))) process.exit(1);
NODE
}

identity_cutover_run_core_fence_action() {
	[[ $# -eq 3 && "$1" =~ ^(status|fence|unfence)$ && "$3" =~ ^(OPEN|FENCED)$ ]] || return 1
	local action="$1" destination="$2" expected_fence="$3"
	identity_cutover_prepare_fresh_evidence "$destination" || return 1
	identity_cutover_run_evidence api "$destination" "$IDENTITY_CORE_CUTOVER_CLI" "$action" || return 1
	identity_cutover_assert_core_fence_evidence "$destination" "$action" "$expected_fence"
}

identity_cutover_require_core_fenced_live() {
	identity_cutover_run_core_fence_action status \
		"$identity_core_post_boundary_fence_evidence" FENCED ||
		identity_cutover_fail 'Legacy Core identity source is not durably fenced by the candidate revision'
}

identity_cutover_wait_core_identity_outbox_drained() {
	[[ $# -eq 1 ]] || return 1
	local destination="$1" partial="${1}.partial.$$" attempt pending status
	identity_cutover_prepare_fresh_evidence "$destination" || return 1
	for ((attempt = 1; attempt <= identity_core_outbox_drain_attempts; attempt++)); do
		if ! identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			run --rm -T --no-deps api node "$IDENTITY_CORE_CUTOVER_CLI" \
			preflight >"$partial"; then
			rm -f -- "$partial"
			identity_cutover_fail 'Core frozen preflight failed while draining the legacy Identity Outbox' || return 1
		fi
		chmod 600 "$partial"
		chown 0:0 "$partial"
		if pending="$(node - "$partial" <<'NODE'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\n/);
if (lines.length !== 1) process.exit(1);
const value = JSON.parse(lines[0]);
if (value?.ok !== true || value.action !== 'preflight' ||
    !Number.isSafeInteger(value.legacyIdentityOutboxPending) ||
    value.legacyIdentityOutboxPending < 0) process.exit(1);
process.stdout.write(String(value.legacyIdentityOutboxPending));
NODE
		)"; then
			status=0
		else
			status=$?
		fi
		if [[ "$status" -ne 0 || ! "$pending" =~ ^(0|[1-9][0-9]*)$ ]]; then
			rm -f -- "$partial"
			identity_cutover_fail 'Core frozen preflight returned invalid Outbox drain evidence' || return 1
		fi
		if [[ "$pending" == '0' ]]; then
			mv -f -- "$partial" "$destination"
			identity_cutover_assert_core_preflight_evidence "$destination" || return 1
			printf 'identity_core_legacy_outbox_pending=0\n'
			return 0
		fi
		rm -f -- "$partial"
		printf 'identity_core_legacy_outbox_pending=%s attempt=%s\n' "$pending" "$attempt"
		sleep 2
	done
	identity_cutover_fail 'Core legacy Identity Outbox did not drain within the bounded wait'
}

identity_cutover_assert_projection_evidence() {
	[[ $# -eq 1 ]] || return 1
	identity_cutover_validate_private_file "$1" || return 1
	REVISION="$EXPECTED_REVISION" node - "$1" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = [
  'winwidget.billing.identity.v1',
  'winwidget.reporting.identity-user',
  'winwidget.widgets.identity-user',
];
if (value?.ok !== true || value.action !== 'identity-projection-drain' ||
    value.revision !== process.env.REVISION || !Array.isArray(value.queues) ||
    value.queues.map(queue => queue.name).sort().join(',') !== expected.join(',') ||
    value.queues.some(queue => queue.messages !== 0 || queue.messagesReady !== 0 ||
      queue.messagesUnacknowledged !== 0 || queue.consumers !== 1)) process.exit(1);
NODE
}

identity_cutover_wait_projection_queues_drained() {
	[[ $# -eq 1 ]] || return 1
	local destination="$1" partial="${1}.partial.$$"
	identity_cutover_prepare_fresh_evidence "$destination" || return 1
	REVISION="$EXPECTED_REVISION" docker run --rm --network host --env-file "$ENV_FILE" \
		-e REVISION --entrypoint node "winwidget-api:git-$EXPECTED_REVISION" -e '
class DrainError extends Error {}
const run = async () => {
  const baseUrl = (process.env.RABBITMQ_MANAGEMENT_URL || "http://127.0.0.1:15672").replace(/\/$/, "");
  const vhost = process.env.RABBITMQ_VHOST || "winwidget";
  const adminUser = process.env.RABBITMQ_ADMIN_USER;
  const adminPassword = process.env.RABBITMQ_ADMIN_PASSWORD;
  if (!adminUser || !adminPassword || !/^[0-9a-f]{40}$/.test(process.env.REVISION || "")) {
    throw new DrainError("RabbitMQ projection drain inputs are missing");
  }
  const queueContracts = [
    ["winwidget.reporting.identity-user", "RABBITMQ_REPORTING_URL", "winwidget-reporting-service"],
    ["winwidget.widgets.identity-user", "RABBITMQ_WIDGETS_URL", "winwidget-widgets-service"],
    ["winwidget.billing.identity.v1", "RABBITMQ_BILLING_WORKER_URL", "winwidget-billing-worker"],
  ].map(([name, urlKey, connectionName]) => {
    let expectedUser;
    try { expectedUser = decodeURIComponent(new URL(process.env[urlKey] || "").username); }
    catch { throw new DrainError(`RabbitMQ URL is invalid for ${name}`); }
    if (!expectedUser) throw new DrainError(`RabbitMQ user is missing for ${name}`);
    return { name, expectedUser, connectionName };
  });
  const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
  const request = async path => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DrainError(`RabbitMQ Management returned HTTP ${response.status}`);
    }
    return response.json();
  };
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const connections = await request("/api/connections");
    if (!Array.isArray(connections)) throw new DrainError("RabbitMQ connections response is invalid");
    const byName = new Map(connections.map(connection => [connection.name, connection]));
    const queues = await Promise.all(queueContracts.map(async contract => {
      const queue = await request(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(contract.name)}`);
      const details = Array.isArray(queue?.consumer_details) ? queue.consumer_details : [];
      const owner = details.length === 1
        ? byName.get(details[0]?.channel_details?.connection_name)
        : undefined;
      return {
        name: contract.name,
        messages: queue?.messages,
        messagesReady: queue?.messages_ready,
        messagesUnacknowledged: queue?.messages_unacknowledged,
        consumers: queue?.consumers,
        ownerMatches: owner?.user === contract.expectedUser &&
          owner?.client_properties?.connection_name === contract.connectionName,
      };
    }));
    const validNumbers = queues.every(queue => [queue.messages, queue.messagesReady,
      queue.messagesUnacknowledged, queue.consumers].every(Number.isSafeInteger));
    if (!validNumbers) throw new DrainError("RabbitMQ projection queue counters are invalid");
    if (queues.every(queue => queue.messages === 0 && queue.messagesReady === 0 &&
        queue.messagesUnacknowledged === 0 && queue.consumers === 1 && queue.ownerMatches)) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        action: "identity-projection-drain",
        revision: process.env.REVISION,
        observedAt: new Date().toISOString(),
        queues: queues.map(({ ownerMatches, ...queue }) => queue),
      })}\n`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new DrainError("Identity projection queues did not drain within the bounded wait");
};
run().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Identity projection drain failed"}\n`);
  process.exit(1);
});
' >"$partial"
	chmod 600 "$partial"
	chown 0:0 "$partial"
	mv -f -- "$partial" "$destination"
	identity_cutover_assert_projection_evidence "$destination"
}

identity_cutover_assert_destination_evidence() {
	[[ $# -eq 2 && "$2" =~ ^(core|none|identity)$ ]] || return 1
	identity_cutover_validate_private_file "$1" || return 1
	REVISION="$EXPECTED_REVISION" DESTINATION_OWNER="$2" node - "$1" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const main = 'winwidget.notification.telegram-destination-unavailable';
const expected = [main, `${main}.dead-letter`, `${main}.retry-v2.1`,
  `${main}.retry-v2.2`, `${main}.retry-v2.3`].sort();
const expectedMainConsumers = process.env.DESTINATION_OWNER === 'none' ? 0 : 1;
if (value?.ok !== true || value.action !== 'telegram-destination-drain' ||
    value.revision !== process.env.REVISION || value.owner !== process.env.DESTINATION_OWNER ||
    !Array.isArray(value.queues) ||
    value.queues.map(queue => queue.name).sort().join(',') !== expected.join(',') ||
    value.queues.some(queue => queue.messages !== 0 || queue.messagesReady !== 0 ||
      queue.messagesUnacknowledged !== 0 ||
      queue.consumers !== (queue.name === main ? expectedMainConsumers : 0))) process.exit(1);
NODE
}

identity_cutover_wait_destination_queues_drained() {
	[[ $# -eq 2 && "$2" =~ ^(core|none|identity)$ ]] || return 1
	local destination="$1" owner="$2" partial="${1}.partial.$$"
	identity_cutover_prepare_fresh_evidence "$destination" || return 1
	REVISION="$EXPECTED_REVISION" DESTINATION_OWNER="$owner" \
		docker run --rm --network host --env-file "$ENV_FILE" \
		-e REVISION -e DESTINATION_OWNER --entrypoint node \
		"winwidget-api:git-$EXPECTED_REVISION" -e '
class DrainError extends Error {}
const run = async () => {
  const baseUrl = (process.env.RABBITMQ_MANAGEMENT_URL || "http://127.0.0.1:15672").replace(/\/$/, "");
  const vhost = process.env.RABBITMQ_VHOST || "winwidget";
  const adminUser = process.env.RABBITMQ_ADMIN_USER;
  const adminPassword = process.env.RABBITMQ_ADMIN_PASSWORD;
  const owner = process.env.DESTINATION_OWNER;
  if (!adminUser || !adminPassword || !/^[0-9a-f]{40}$/.test(process.env.REVISION || "") ||
      !["core", "none", "identity"].includes(owner)) {
    throw new DrainError("RabbitMQ destination drain inputs are missing");
  }
  const main = "winwidget.notification.telegram-destination-unavailable";
  const names = [main, `${main}.dead-letter`, `${main}.retry-v2.1`,
    `${main}.retry-v2.2`, `${main}.retry-v2.3`];
  const expected = owner === "core"
    ? ["RABBITMQ_INTEGRATION_WORKER_URL", "winwidget-integration-worker"]
    : owner === "identity"
      ? ["RABBITMQ_IDENTITY_WORKER_URL", "winwidget-identity-worker"]
      : null;
  let expectedUser = null;
  if (expected) {
    try { expectedUser = decodeURIComponent(new URL(process.env[expected[0]] || "").username); }
    catch { throw new DrainError("Destination owner RabbitMQ URL is invalid"); }
    if (!expectedUser) throw new DrainError("Destination owner RabbitMQ user is missing");
  }
  const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
  const request = async path => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DrainError(`RabbitMQ Management returned HTTP ${response.status}`);
    }
    return response.json();
  };
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const connections = await request("/api/connections");
    if (!Array.isArray(connections)) throw new DrainError("RabbitMQ connections response is invalid");
    const byName = new Map(connections.map(connection => [connection.name, connection]));
    const queues = await Promise.all(names.map(async name => {
      const queue = await request(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(name)}`);
      const details = Array.isArray(queue?.consumer_details) ? queue.consumer_details : [];
      const connection = details.length === 1
        ? byName.get(details[0]?.channel_details?.connection_name)
        : undefined;
      return {
        name,
        messages: queue?.messages,
        messagesReady: queue?.messages_ready,
        messagesUnacknowledged: queue?.messages_unacknowledged,
        consumers: queue?.consumers,
        ownerMatches: name !== main || owner === "none"
          ? details.length === 0
          : details.length === 1 && connection?.user === expectedUser &&
            connection?.client_properties?.connection_name === expected[1],
      };
    }));
    const validNumbers = queues.every(queue => [queue.messages, queue.messagesReady,
      queue.messagesUnacknowledged, queue.consumers].every(Number.isSafeInteger));
    if (!validNumbers) throw new DrainError("RabbitMQ destination queue counters are invalid");
    const mainConsumers = owner === "none" ? 0 : 1;
    if (queues.every(queue => queue.messages === 0 && queue.messagesReady === 0 &&
        queue.messagesUnacknowledged === 0 &&
        queue.consumers === (queue.name === main ? mainConsumers : 0) && queue.ownerMatches)) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        action: "telegram-destination-drain",
        revision: process.env.REVISION,
        owner,
        observedAt: new Date().toISOString(),
        queues: queues.map(({ ownerMatches, ...queue }) => queue),
      })}\n`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new DrainError("Telegram destination queues did not drain within the bounded wait");
};
run().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Telegram destination drain failed"}\n`);
  process.exit(1);
});
' >"$partial"
	chmod 600 "$partial"
	chown 0:0 "$partial"
	mv -f -- "$partial" "$destination"
	identity_cutover_assert_destination_evidence "$destination" "$owner"
}

identity_cutover_assert_destination_state_evidence() {
	[[ $# -eq 1 ]] || return 1
	identity_cutover_validate_private_file "$1" || return 1
	REVISION="$EXPECTED_REVISION" node - "$1" <<'NODE'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\n/);
if (lines.length !== 1) process.exit(1);
const value = JSON.parse(lines[0]);
if (value?.ok !== true || value.action !== 'telegram-destination-core-state' ||
    value.revision !== process.env.REVISION || value.unresolvedFailures !== 0 ||
    value.inFlightReceipts !== 0) process.exit(1);
NODE
}

identity_cutover_wait_destination_state_drained() {
	[[ $# -eq 1 ]] || return 1
	local destination="$1" partial="${1}.partial.$$" attempt unresolved in_flight status
	identity_cutover_prepare_fresh_evidence "$destination" || return 1
	for ((attempt = 1; attempt <= identity_core_outbox_drain_attempts; attempt++)); do
		if ! identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			run --rm -T --no-deps -e "REVISION=$EXPECTED_REVISION" \
			--entrypoint node api -e '
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL_PRODUCTION } } });
Promise.all([
  prisma.integrationDeliveryFailure.count({
    where: { integration: "telegram-destination-unavailable", resolvedAt: null },
  }),
  prisma.integrationDeliveryReceipt.count({
    where: {
      integration: "telegram-destination-unavailable",
      status: { in: ["PROCESSING", "RETRY_SCHEDULED"] },
    },
  }),
]).then(([unresolvedFailures, inFlightReceipts]) => {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action: "telegram-destination-core-state",
    revision: process.env.REVISION,
    unresolvedFailures,
    inFlightReceipts,
    observedAt: new Date().toISOString(),
  })}\n`);
}).catch(() => process.exitCode = 1).finally(() => prisma.$disconnect());
' >"$partial"; then
			rm -f -- "$partial"
			identity_cutover_fail 'Core telegram destination state query failed' || return 1
		fi
		chmod 600 "$partial"
		chown 0:0 "$partial"
		if read -r unresolved in_flight < <(node - "$partial" <<'NODE'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\n/);
if (lines.length !== 1) process.exit(1);
const value = JSON.parse(lines[0]);
if (value?.ok !== true || value.action !== 'telegram-destination-core-state' ||
    !Number.isSafeInteger(value.unresolvedFailures) || value.unresolvedFailures < 0 ||
    !Number.isSafeInteger(value.inFlightReceipts) || value.inFlightReceipts < 0) process.exit(1);
process.stdout.write(`${value.unresolvedFailures} ${value.inFlightReceipts}\n`);
NODE
		); then
			status=0
		else
			status=$?
		fi
		if [[ "$status" -ne 0 || ! "$unresolved" =~ ^(0|[1-9][0-9]*)$ ||
			! "$in_flight" =~ ^(0|[1-9][0-9]*)$ ]]; then
			rm -f -- "$partial"
			identity_cutover_fail 'Core telegram destination state evidence is invalid' || return 1
		fi
		if [[ "$unresolved" == '0' && "$in_flight" == '0' ]]; then
			mv -f -- "$partial" "$destination"
			identity_cutover_assert_destination_state_evidence "$destination"
			return
		fi
		rm -f -- "$partial"
		printf 'identity_core_destination_unresolved=%s in_flight=%s attempt=%s\n' \
			"$unresolved" "$in_flight" "$attempt"
		sleep 2
	done
	identity_cutover_fail 'Core telegram destination failures/receipts did not drain within the bounded wait'
}

identity_cutover_require_frozen_boundary_evidence() {
	identity_cutover_assert_core_preflight_evidence "$identity_core_frozen_preflight_evidence" &&
		identity_cutover_assert_projection_evidence "$identity_core_frozen_projection_evidence" &&
		identity_cutover_assert_destination_evidence "$identity_core_frozen_destination_evidence" none &&
		identity_cutover_assert_destination_state_evidence "$identity_core_frozen_destination_state_evidence" &&
		identity_cutover_assert_core_fence_evidence "$identity_core_fence_evidence" fence FENCED
}

identity_cutover_export_snapshot() {
	identity_cutover_require_frozen_boundary_evidence ||
		identity_cutover_fail 'Core frozen Outbox/queue boundary evidence is absent or invalid' || return 1
	if [[ -e "$identity_snapshot" || -L "$identity_snapshot" ]]; then
		identity_cutover_validate_private_file "$identity_snapshot" || return 1
		[[ "$identity_frozen_core_recovery" == 'true' &&
			"$(identity_database_current_phase)" == 'prepared' ]] || return 1
		rm -f -- "$identity_snapshot"
	fi
	local image="winwidget-api:git-$EXPECTED_REVISION" uid_gid stage partial
	uid_gid="$(identity_cutover_image_uid_gid "$image")"
	[[ "$uid_gid" =~ ^[0-9]+:[0-9]+$ ]] || return 1
	stage="$identity_cutover_root/.core-export-$EXPECTED_REVISION"
	if [[ -e "$stage" || -L "$stage" ]]; then
		identity_cutover_active_stage="$stage"
		identity_cutover_cleanup_active_stage || return 1
	fi
	mkdir -m 700 "$stage"
	identity_cutover_active_stage="$stage"
	chown "$uid_gid" "$stage"
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		run --rm -T --no-deps --user "$uid_gid" \
		--volume "$stage:/cutover" api node "$IDENTITY_CORE_CUTOVER_CLI" \
		export --file /cutover/snapshot.json >/dev/null
	partial="$stage/snapshot.json"
	[[ -f "$partial" && ! -L "$partial" && -s "$partial" ]] || return 1
	chown 0:0 "$partial" "$stage"
	chmod 600 "$partial"
	mv -f -- "$partial" "$identity_snapshot"
	rmdir "$stage"
	identity_cutover_active_stage=''
	identity_cutover_validate_private_file "$identity_snapshot"
	node - "$identity_snapshot" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const counts = value?.counts;
if (value?.schemaVersion !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.snapshotId || '') ||
    !Array.isArray(value.users) || !value.authSettings || !value.versions ||
    !Number.isSafeInteger(counts?.users) || counts.users !== value.users.length ||
    !Number.isSafeInteger(counts?.identities) ||
    !Number.isSafeInteger(counts?.telegramNotificationChannels) ||
    counts.emailCollisionGroups !== 0 ||
    JSON.stringify(value).includes('refreshTokenHash') ||
    JSON.stringify(value).includes('verificationChallenge')) process.exit(1);
const identities = value.users.reduce((sum, user) => sum + (user.authIdentities?.length || 0), 0);
const channels = value.users.filter(user => user.telegramNotificationChannel).length;
if (identities !== counts.identities || channels !== counts.telegramNotificationChannels) process.exit(1);
NODE
}

identity_cutover_import_snapshot() {
	local image="winwidget-identity:git-$EXPECTED_REVISION" uid_gid stage
	uid_gid="$(identity_cutover_image_uid_gid "$image")"
	[[ "$uid_gid" =~ ^[0-9]+:[0-9]+$ ]] || return 1
	stage="$identity_cutover_root/.identity-import-$EXPECTED_REVISION"
	if [[ -e "$stage" || -L "$stage" ]]; then
		identity_cutover_active_stage="$stage"
		identity_cutover_cleanup_active_stage || return 1
	fi
	mkdir -m 700 "$stage"
	identity_cutover_active_stage="$stage"
	cp -- "$identity_snapshot" "$stage/snapshot.json"
	chown -R "$uid_gid" "$stage"
	chmod 400 "$stage/snapshot.json"
	identity_cutover_run_evidence_with_volume="$stage:/cutover:ro"
	local partial="${identity_service_import_evidence}.partial.$$"
	[[ ! -e "$partial" ]] || return 1
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		run --rm -T --no-deps --user "$uid_gid" \
		--volume "$identity_cutover_run_evidence_with_volume" identity-api \
		node "$IDENTITY_SERVICE_CUTOVER_CLI" import --file /cutover/snapshot.json >"$partial"
	chmod 600 "$partial"
	chown 0:0 "$partial"
	node - "$partial" <<'NODE'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\n/);
if (lines.length !== 1 || JSON.parse(lines[0])?.ok !== true) process.exit(1);
NODE
	mv -f -- "$partial" "$identity_service_import_evidence"
	chown -R 0:0 "$stage"
	chmod 600 "$stage/snapshot.json"
	rm -f -- "$stage/snapshot.json"
	rmdir "$stage"
	identity_cutover_active_stage=''
	unset identity_cutover_run_evidence_with_volume
}

identity_cutover_recover_pre_boundary() {
	local status=$? phase='unsafe' safe_to_restart='false'
	trap - EXIT INT TERM
	identity_cutover_cleanup_active_stage || true
	phase="$(identity_database_current_phase 2>/dev/null || printf unsafe)"
	if [[ "$status" -ne 0 && "$identity_frozen_core_recovery" == 'true' &&
		"$phase" == 'prepared' ]]; then
		if [[ -e "$identity_snapshot" || -L "$identity_snapshot" ]]; then
			identity_cutover_validate_private_file "$identity_snapshot" &&
				rm -f -- "$identity_snapshot" || true
		fi
		if identity_cutover_run_core_fence_action unfence \
			"$identity_core_unfence_evidence" OPEN; then
			safe_to_restart='true'
		fi
		if [[ "$safe_to_restart" == 'true' ]]; then
			[[ -z "$identity_frozen_core_outbox_id" ]] || docker start "$identity_frozen_core_outbox_id" >/dev/null || true
			[[ -z "$identity_frozen_core_api_id" ]] || docker start "$identity_frozen_core_api_id" >/dev/null || true
			[[ -z "$identity_frozen_core_integration_id" ]] || docker start "$identity_frozen_core_integration_id" >/dev/null || true
			[[ -z "$identity_frozen_gateway_id" ]] || docker start "$identity_frozen_gateway_id" >/dev/null || true
			printf 'identity_pre_boundary_core_unfenced=true\n' >&2
			printf 'identity_pre_boundary_core_restarted=true\n' >&2
		else
			printf 'identity_pre_boundary_core_restarted=false reason=unfence-not-proven\n' >&2
		fi
	fi
	exit "$status"
}

identity_cutover_freeze_core() {
	identity_frozen_core_api_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q api)"
	identity_frozen_core_integration_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q integration-worker)"
	identity_frozen_core_outbox_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q outbox-publisher)"
	identity_frozen_gateway_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps -q api-gateway)"
	[[ "$identity_frozen_core_api_id" =~ ^[0-9a-f]{64}$ &&
		"$identity_frozen_core_integration_id" =~ ^[0-9a-f]{64}$ &&
		"$identity_frozen_core_outbox_id" =~ ^[0-9a-f]{64}$ &&
		"$identity_frozen_gateway_id" =~ ^[0-9a-f]{64}$ ]] ||
		identity_cutover_fail 'Core API, integration worker, Outbox publisher, or Gateway is absent before freeze' || return 1
	[[ "$(docker inspect --format '{{.State.Running}}' "$identity_frozen_core_api_id")" == 'true' &&
		"$(docker inspect --format '{{.State.Running}}' "$identity_frozen_core_integration_id")" == 'true' &&
		"$(docker inspect --format '{{.State.Running}}' "$identity_frozen_core_outbox_id")" == 'true' &&
		"$(docker inspect --format '{{.State.Running}}' "$identity_frozen_gateway_id")" == 'true' ]] ||
		identity_cutover_fail 'Core API, integration worker, Outbox publisher, and Gateway must be running before freeze' || return 1
	identity_frozen_core_recovery='true'
	trap identity_cutover_recover_pre_boundary EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop --timeout 90 api api-gateway
	[[ "$(docker inspect --format '{{.State.Running}}' "$identity_frozen_core_api_id")" == 'false' &&
		"$(docker inspect --format '{{.State.Running}}' "$identity_frozen_gateway_id")" == 'false' ]] ||
		identity_cutover_fail 'Core API or public Gateway did not stop cleanly' || return 1
	identity_cutover_wait_destination_queues_drained "$identity_core_frozen_destination_evidence" core
	identity_cutover_wait_destination_state_drained "$identity_core_frozen_destination_state_evidence"
	identity_cutover_wait_core_identity_outbox_drained "$identity_core_frozen_preflight_evidence"
	identity_cutover_wait_projection_queues_drained "$identity_core_frozen_projection_evidence"
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop --timeout 90 integration-worker
	[[ "$(docker inspect --format '{{.State.Running}}' "$identity_frozen_core_integration_id")" == 'false' ]] ||
		identity_cutover_fail 'Core integration worker did not stop after its destination drain' || return 1
	identity_cutover_wait_destination_queues_drained "$identity_core_frozen_destination_evidence" none
	identity_cutover_wait_destination_state_drained "$identity_core_frozen_destination_state_evidence"
	identity_cutover_wait_core_identity_outbox_drained "$identity_core_frozen_preflight_evidence"
	identity_cutover_wait_projection_queues_drained "$identity_core_frozen_projection_evidence"
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		stop --timeout 90 outbox-publisher
	[[ "$(docker inspect --format '{{.State.Running}}' "$identity_frozen_core_outbox_id")" == 'false' ]] ||
		identity_cutover_fail 'Core Outbox publisher did not stop after the legacy Identity drain' || return 1
	identity_cutover_wait_core_identity_outbox_drained "$identity_core_frozen_preflight_evidence"
	identity_cutover_wait_projection_queues_drained "$identity_core_frozen_projection_evidence"
	identity_cutover_wait_destination_queues_drained "$identity_core_frozen_destination_evidence" none
	identity_cutover_wait_destination_state_drained "$identity_core_frozen_destination_state_evidence"
	identity_cutover_run_core_fence_action fence "$identity_core_fence_evidence" FENCED
	identity_cutover_require_frozen_boundary_evidence ||
		identity_cutover_fail 'Core source fence or frozen event boundary evidence is invalid' || return 1
	printf 'identity_core_frozen_event_boundary=verified\n'
	printf 'identity_core_source_fence=FENCED\n'
}

identity_cutover_wait_url() {
	[[ $# -eq 2 ]] || return 1
	local url="$1" label="$2" attempt
	for ((attempt = 1; attempt <= 60; attempt++)); do
		curl -fsS --connect-timeout 2 --max-time 5 "$url" >/dev/null 2>&1 && return 0
		sleep 2
	done
	identity_cutover_fail "$label failed readiness"
}

identity_cutover_switch_core_integration_permissions() {
	local credentials integration_user rabbitmq_vhost rabbitmq_container_id
	credentials="$(identity_deploy_parse_rabbitmq_url RABBITMQ_INTEGRATION_WORKER_URL)" ||
		identity_cutover_fail 'Core integration RabbitMQ URL is invalid' || return 1
	integration_user="$(printf '%s' "$(sed -n '1p' <<<"$credentials")" | base64 --decode)"
	rabbitmq_vhost="$(printf '%s' "$(sed -n '3p' <<<"$credentials")" | base64 --decode)"
	[[ "$integration_user" == 'winwidget-integration' ]] ||
		identity_cutover_fail 'Core integration RabbitMQ URL uses a non-canonical user' || return 1
	rabbitmq_container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" \
		"$COMPOSE_FILE" ps --status running -q rabbitmq)" || return 1
	[[ "$rabbitmq_container_id" =~ ^[0-9a-f]{64}$ ]] ||
		identity_cutover_fail 'Exactly one RabbitMQ container is required for the ownership switch' || return 1
	IDENTITY_INTEGRATION_USER="$integration_user" \
	IDENTITY_RABBITMQ_VHOST="$rabbitmq_vhost" \
		docker exec -e IDENTITY_INTEGRATION_USER -e IDENTITY_RABBITMQ_VHOST \
			"$rabbitmq_container_id" sh -euc '
rabbitmqctl set_permissions -p "$IDENTITY_RABBITMQ_VHOST" \
  "$IDENTITY_INTEGRATION_USER" "^$" \
  "^(winwidget\.retry|winwidget\.dead-letter)$" \
  "^winwidget\.(admin\.audit\.(campaigns|reporting|widgets|billing|identity)\.v1|core\.billing\.(payment-details|subscription-details|affiliate|settings)\.v1)(\..*)?$" >/dev/null
'
	unset credentials
}

identity_cutover_assert_destination_queue_owner() {
	docker run --rm --network host --env-file "$ENV_FILE" --entrypoint node \
		"winwidget-api:git-$EXPECTED_REVISION" -e '
class OwnershipError extends Error {}
const run = async () => {
  const baseUrl = (process.env.RABBITMQ_MANAGEMENT_URL || "http://127.0.0.1:15672").replace(/\/$/, "");
  const vhost = process.env.RABBITMQ_VHOST || "winwidget";
  const adminUser = process.env.RABBITMQ_ADMIN_USER;
  const adminPassword = process.env.RABBITMQ_ADMIN_PASSWORD;
  if (!adminUser || !adminPassword) throw new OwnershipError("RabbitMQ admin credentials are missing");
  let expectedUser;
  try { expectedUser = decodeURIComponent(new URL(process.env.RABBITMQ_IDENTITY_WORKER_URL || "").username); }
  catch { throw new OwnershipError("Identity worker RabbitMQ URL is invalid"); }
  if (expectedUser !== "winwidget-identity-worker") throw new OwnershipError("Identity worker user is not canonical");
  const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
  const request = async path => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: authorization }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new OwnershipError(`RabbitMQ Management returned HTTP ${response.status}`); }
    return response.json();
  };
  const connections = await request("/api/connections");
  if (!Array.isArray(connections)) throw new OwnershipError("RabbitMQ connections response is invalid");
  const bySocketName = new Map(connections.map(connection => [connection.name, connection]));
  const queueName = "winwidget.notification.telegram-destination-unavailable";
  const queue = await request(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queueName)}`);
  const consumers = Array.isArray(queue?.consumer_details) ? queue.consumer_details : [];
  if (consumers.length !== 1) throw new OwnershipError("Telegram destination-unavailable queue must have exactly one Identity consumer");
  const connection = bySocketName.get(consumers[0]?.channel_details?.connection_name);
  if (connection?.user !== expectedUser || connection?.client_properties?.connection_name !== "winwidget-identity-worker") {
    throw new OwnershipError("Telegram destination-unavailable queue has a non-Identity owner");
  }
  for (const suffix of [".dead-letter", ".retry-v2.1", ".retry-v2.2", ".retry-v2.3"]) {
    const parking = await request(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queueName + suffix)}`);
    const parkingConsumers = Array.isArray(parking?.consumer_details) ? parking.consumer_details : [];
    if (parkingConsumers.length !== 0) throw new OwnershipError(`Identity parking queue ${queueName + suffix} must have no consumers`);
  }
};
run().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Identity queue ownership check failed"}\n`); process.exit(1); });
'
}

identity_cutover_run_service_action() {
	[[ $# -eq 2 ]] || return 1
	local action="$1" destination="$2" container partial
	container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" ps --status running -q identity-api)"
	[[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
	partial="${destination}.partial.$$"
	docker exec "$container" node "$IDENTITY_SERVICE_CUTOVER_CLI" "$action" >"$partial"
	chmod 600 "$partial"
	chown 0:0 "$partial"
	node - "$partial" <<'NODE'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\n/);
if (lines.length !== 1 || JSON.parse(lines[0])?.ok !== true) process.exit(1);
NODE
	mv -f -- "$partial" "$destination"
	identity_cutover_validate_private_file "$destination"
}

identity_cutover_require_completion_parity() {
	if [[ ! -e "$identity_service_completion_evidence" &&
		! -L "$identity_service_completion_evidence" ]]; then
		identity_cutover_run_service_action complete "$identity_service_completion_evidence"
	fi
	identity_cutover_validate_private_file "$identity_service_completion_evidence" || return 1
	EXPECTED_SNAPSHOT_SHA="$(identity_cutover_marker_value snapshot_sha256)" \
		node - "$identity_service_completion_evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const counts = value?.counts;
if (value?.ok !== true || value.action !== 'complete' || value.phase !== 'ACTIVE' ||
    value.sha256 !== process.env.EXPECTED_SNAPSHOT_SHA ||
    !/^[1-9][0-9]*$/.test(value.ownershipGeneration || '') ||
    !counts || !Number.isSafeInteger(counts.users) || counts.users < 1 ||
    !Number.isSafeInteger(counts.identities) || counts.identities < 1 ||
    !Number.isSafeInteger(counts.telegramNotificationChannels) ||
    counts.telegramNotificationChannels < 0) process.exit(1);
NODE
}

identity_cutover_assert_imported_status_evidence() {
	[[ $# -eq 1 ]] || return 1
	local evidence="$1"
	identity_cutover_validate_private_file "$evidence" || return 1
	EXPECTED_SNAPSHOT_SHA="$(identity_cutover_marker_value snapshot_sha256)" \
		node - "$evidence" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const counts = value?.counts;
if (value?.ok !== true || value.action !== 'status' || value.phase !== 'IMPORTED' ||
    value.ownershipGeneration !== '0' ||
    value.sourceSnapshotSha256 !== process.env.EXPECTED_SNAPSHOT_SHA ||
    !counts || !Number.isSafeInteger(counts.users) || counts.users < 1 ||
    !Number.isSafeInteger(counts.identities) || counts.identities < 1 ||
    !Number.isSafeInteger(counts.telegramNotificationChannels) ||
    counts.telegramNotificationChannels < 0 || counts.sessions !== 0 ||
    counts.challenges !== 0 || counts.outbox !== 0) process.exit(1);
NODE
}

identity_cutover_capture_dark_readiness() {
	local partial="${identity_service_dark_readiness_evidence}.partial.$$"
	[[ ! -e "$partial" && ! -L "$partial" ]] || return 1
	curl -fsS --connect-timeout 3 --max-time 10 \
		http://127.0.0.1:4900/health/ready >"$partial"
	EXPECTED_REVISION="$EXPECTED_REVISION" node - "$partial" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value?.status !== 'ready' || value.service !== 'identity' || value.role !== 'api' ||
    value.revision !== process.env.EXPECTED_REVISION ||
    value.ownership?.serviceName !== 'identity-service' ||
    value.ownership?.phase !== 'IMPORTED' || !value.ownership?.importedAt ||
    value.ownership?.activatedAt !== null) process.exit(1);
NODE
	chmod 600 "$partial"
	chown 0:0 "$partial"
	mv -f -- "$partial" "$identity_service_dark_readiness_evidence"
	identity_cutover_validate_private_file "$identity_service_dark_readiness_evidence"
}

identity_cutover_verify_candidate_service() {
	[[ $# -eq 4 ]] || return 1
	local service="$1" port="$2" marker_key="$3" label="$4"
	local container_id image_id revision restart_count health
	identity_cutover_wait_url "http://127.0.0.1:$port/health/ready" "$label"
	container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q "$service")" || return 1
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
		identity_cutover_fail "$label must have exactly one running container" || return 1
	image_id="$(docker inspect --format '{{.Image}}' "$container_id")" || return 1
	revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" || return 1
	restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")" || return 1
	health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" || return 1
	[[ "$image_id" == "$(identity_cutover_marker_value "$marker_key")" &&
		"$revision" == "$EXPECTED_REVISION" && "$restart_count" == '0' &&
		"$health" == 'healthy' ]] ||
		identity_cutover_fail "$label revision, image, restart count, or health drifted" || return 1
}

identity_cutover_start_candidate_dependents() {
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile campaigns-migration run --rm -T --no-deps campaigns-migrate
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile reporting-migration run --rm -T --no-deps reporting-migrate
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile widgets-migration run --rm -T --no-deps widgets-migrate
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile billing-migration run --rm -T --no-deps billing-migrate
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate \
		campaigns-service reporting-service widgets-service \
		billing-api billing-scheduler billing-worker billing-outbox-publisher
	identity_cutover_verify_candidate_service campaigns-service 4500 \
		campaigns_image_id 'Campaigns candidate'
	identity_cutover_verify_candidate_service reporting-service 4600 \
		reporting_image_id 'Reporting candidate'
	identity_cutover_verify_candidate_service widgets-service 4700 \
		widgets_image_id 'Widgets candidate'
	identity_cutover_verify_candidate_service billing-api 4800 \
		billing_image_id 'Billing API candidate'
	identity_cutover_verify_candidate_service billing-scheduler 4801 \
		billing_image_id 'Billing scheduler candidate'
	identity_cutover_verify_candidate_service billing-worker 4802 \
		billing_image_id 'Billing worker candidate'
	identity_cutover_verify_candidate_service billing-outbox-publisher 4803 \
		billing_image_id 'Billing Outbox candidate'
}

identity_cutover_assert_introspection_client() {
	[[ $# -eq 3 ]] || return 1
	local service="$1" caller="$2" token_key="$3" container_id
	container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q "$service")" || return 1
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	docker exec "$container_id" node -e '
const caller = process.argv[1];
const tokenKey = process.argv[2];
const baseUrl = process.env.IDENTITY_INTERNAL_BASE_URL;
const token = process.env[tokenKey];
if (baseUrl !== "http://127.0.0.1:4900" || !token || token.length < 32) process.exit(64);
fetch(`${baseUrl}/internal/v1/auth/introspect`, {
  method: "POST",
  headers: {
    authorization: "Bearer identity-cutover-introspection-probe-not-a-token",
    accept: "application/json",
    "x-winwidget-service": caller,
    "x-winwidget-internal-token": token,
  },
  signal: AbortSignal.timeout(5000),
}).then(async response => {
  await response.body?.cancel();
  if (response.status !== 401) process.exit(1);
}).catch(() => process.exit(1));
' "$caller" "$token_key"
}

identity_cutover_assert_all_introspection_clients() {
	identity_cutover_assert_introspection_client api core IDENTITY_CORE_TOKEN
	identity_cutover_assert_introspection_client campaigns-service campaigns IDENTITY_CAMPAIGNS_TOKEN
	identity_cutover_assert_introspection_client reporting-service reporting IDENTITY_REPORTING_TOKEN
	identity_cutover_assert_introspection_client widgets-service widgets IDENTITY_WIDGETS_TOKEN
	identity_cutover_assert_introspection_client billing-api billing IDENTITY_BILLING_TOKEN
}

identity_cutover_assert_narrow_owner_routes() {
	local container_id
	container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q identity-api)" || return 1
	[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
	docker exec "$container_id" node -e '
const call = async (url, options) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  if (response.status !== 200) process.exit(1);
};
Promise.all([
  call("http://127.0.0.1:4200/internal/v1/identity/users/00000000-0000-4000-8000-000000000000/admin-events/overview", {
    headers: { "x-winwidget-service": "identity", "x-winwidget-internal-token": process.env.CORE_IDENTITY_TOKEN },
  }),
  call("http://127.0.0.1:4800/internal/v1/identity/billing/users/00000000-0000-4000-8000-000000000000/admin-overview", {
    headers: { "x-winwidget-service": "identity", "x-winwidget-internal-token": process.env.BILLING_IDENTITY_TOKEN },
  }),
  call("http://127.0.0.1:4800/internal/v1/identity/billing/directory/subscription-user-ids", {
    headers: { "x-winwidget-service": "identity", "x-winwidget-internal-token": process.env.BILLING_IDENTITY_TOKEN },
  }),
  call("http://127.0.0.1:4700/internal/v1/identity/widgets/admin-owner-overview", {
    method: "POST",
    headers: { "content-type": "application/json", "x-winwidget-service": "identity", "x-winwidget-internal-token": process.env.WIDGETS_IDENTITY_TOKEN },
    body: JSON.stringify({ userId: "00000000-0000-4000-8000-000000000000" }),
  }),
]).catch(() => process.exit(1));
'
}

identity_cutover_assert_public_auth_contract() {
	local direct_settings public_settings direct_login_status public_login_status
	direct_settings="$(curl -fsS --connect-timeout 3 --max-time 10 \
		http://127.0.0.1:4900/api/v1/auth/settings | identity_cutover_text_sha256)"
	public_settings="$(curl -fsS --connect-timeout 3 --max-time 10 \
		https://api.winwidget.ru/api/v1/auth/settings | identity_cutover_text_sha256)"
	[[ "$direct_settings" =~ ^[0-9a-f]{64}$ && "$direct_settings" == "$public_settings" ]] ||
		identity_cutover_fail 'public auth settings differ from the direct Identity contract' || return 1
	direct_login_status="$(curl -sS -o /dev/null -w '%{http_code}' \
		--connect-timeout 3 --max-time 10 -H 'content-type: application/json' \
		--data '{}' http://127.0.0.1:4900/api/v1/auth/login || true)"
	public_login_status="$(curl -sS -o /dev/null -w '%{http_code}' \
		--connect-timeout 3 --max-time 10 -H 'content-type: application/json' \
		--data '{}' https://api.winwidget.ru/api/v1/auth/login || true)"
	[[ "$direct_login_status" =~ ^4[0-9]{2}$ &&
		"$direct_login_status" != '404' && "$direct_login_status" == "$public_login_status" ]] ||
		identity_cutover_fail 'public login validation no longer matches the stable frontend HTTP contract'
}

identity_cutover_start_forward_runtime() {
	local database_phase
	database_phase="$(identity_database_current_phase)" || return 1
	identity_cutover_require_core_fenced_live || return 1
	if [[ "$database_phase" == 'forward-only' ]]; then
		identity_deploy_run
		identity_cutover_capture_dark_readiness
		identity_cutover_run_service_action status "$identity_service_dark_status_evidence"
		identity_cutover_assert_imported_status_evidence "$identity_service_dark_status_evidence"
		identity_cutover_run_service_action activate "$identity_service_activation_evidence"
		identity_database_advance active
		identity_cutover_write_marker active "$EXPECTED_REVISION" \
			"$(identity_cutover_marker_value core_image_id)" \
			"$(identity_cutover_marker_value identity_image_id)" \
			"$(identity_cutover_marker_value gateway_image_id)" \
			"$(identity_cutover_marker_value campaigns_image_id)" \
			"$(identity_cutover_marker_value reporting_image_id)" \
			"$(identity_cutover_marker_value widgets_image_id)" \
			"$(identity_cutover_marker_value billing_image_id)" \
			"$(identity_cutover_marker_value route_sha256)" \
			"$(identity_cutover_marker_value core_backup_sha256)" \
			"$(identity_cutover_marker_value identity_pre_backup_sha256)" \
			"$(identity_cutover_marker_value pre_restore_evidence_sha256)" \
			"$(identity_cutover_marker_value snapshot_sha256)" pending pending \
			"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		identity_cutover_require_completion_parity
	elif [[ "$database_phase:$(identity_cutover_marker_value phase)" == 'active:active' ]]; then
		identity_deploy_dark_api
		identity_cutover_require_completion_parity
	elif [[ "$database_phase:$(identity_cutover_marker_value phase)" != 'complete:complete' ]]; then
		identity_cutover_fail "Identity forward runtime requires forward-only, active, or complete ownership; phase=$database_phase" || return 1
	else
		identity_cutover_require_completion_parity
	fi
	identity_deploy_run
	identity_cutover_assert_destination_queue_owner
	identity_cutover_start_candidate_dependents
	identity_cutover_wait_destination_queues_drained "$identity_core_post_boundary_destination_evidence" identity
	identity_cutover_wait_projection_queues_drained "$identity_core_post_boundary_projection_evidence"
	identity_cutover_assert_narrow_owner_routes
	identity_cutover_switch_core_integration_permissions
	identity_cutover_require_core_fenced_live
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate \
		api integration-worker outbox-publisher maintenance-worker database-restore-worker
	identity_cutover_wait_url http://127.0.0.1:4200/api/v1/health/ready 'Core API'
	identity_cutover_wait_url http://127.0.0.1:4300/health/ready 'maintenance worker'
	identity_cutover_require_core_fenced_live
	identity_cutover_wait_projection_queues_drained "$identity_core_post_boundary_projection_evidence"
	identity_cutover_assert_all_introspection_clients
	identity_cutover_assert_destination_queue_owner
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate api-gateway
	identity_cutover_wait_url http://127.0.0.1:4100/health/ready 'API Gateway'
	identity_cutover_wait_url http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json 'direct Identity JWKS'
	identity_cutover_wait_url https://api.winwidget.ru/api/v1/auth/.well-known/jwks.json 'public Identity JWKS'
	local direct_sha public_sha internal_status
	direct_sha="$(curl -fsS --connect-timeout 3 --max-time 10 \
		http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json | identity_cutover_text_sha256)"
	public_sha="$(curl -fsS --connect-timeout 3 --max-time 10 \
		https://api.winwidget.ru/api/v1/auth/.well-known/jwks.json | identity_cutover_text_sha256)"
	[[ "$direct_sha" =~ ^[0-9a-f]{64}$ && "$direct_sha" == "$public_sha" ]] ||
		identity_cutover_fail 'public Gateway JWKS differs from direct Identity JWKS' || return 1
	identity_cutover_assert_public_auth_contract
	internal_status="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 \
		https://api.winwidget.ru/internal/v1/auth/introspect || true)"
	[[ "$internal_status" =~ ^(404|405)$ ]] ||
		identity_cutover_fail 'Identity introspection unexpectedly became public through Gateway'
	identity_cutover_require_core_fenced_live
	identity_cutover_wait_projection_queues_drained "$identity_core_post_boundary_projection_evidence"
	identity_cutover_wait_destination_queues_drained "$identity_core_post_boundary_destination_evidence" identity
	printf 'identity_frontend_handoff_required=true\n'
	printf 'identity_frontend_candidate_revision=%s\n' "$EXPECTED_REVISION"
}

identity_cutover_complete_forward() {
	identity_cutover_create_backup IDENTITY_BACKUP_URL identity "$identity_post_backup"
	identity_cutover_run_restore_rehearsal post-ownership "$identity_post_backup" \
		"$identity_post_restore_evidence"
	identity_cutover_require_completion_parity
	if [[ "$(identity_database_current_phase)" == 'active' ]]; then
		identity_database_advance complete
	fi
	identity_cutover_write_marker complete "$EXPECTED_REVISION" \
		"$(identity_cutover_marker_value core_image_id)" \
		"$(identity_cutover_marker_value identity_image_id)" \
		"$(identity_cutover_marker_value gateway_image_id)" \
		"$(identity_cutover_marker_value campaigns_image_id)" \
		"$(identity_cutover_marker_value reporting_image_id)" \
		"$(identity_cutover_marker_value widgets_image_id)" \
		"$(identity_cutover_marker_value billing_image_id)" \
		"$(identity_cutover_marker_value route_sha256)" \
		"$(identity_cutover_marker_value core_backup_sha256)" \
		"$(identity_cutover_marker_value identity_pre_backup_sha256)" \
		"$(identity_cutover_marker_value pre_restore_evidence_sha256)" \
		"$(identity_cutover_marker_value snapshot_sha256)" \
		"$(identity_cutover_sha256 "$identity_post_backup")" \
		"$(identity_cutover_sha256 "$identity_post_restore_evidence")" \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'identity_cutover_phase=complete\n'
}

identity_cutover_deploy() {
	identity_cutover_require_common
	[[ "${IDENTITY_CUTOVER_CONFIRMATION:-}" == "$identity_cutover_confirmation" ]] ||
		identity_cutover_fail 'Identity cutover requires exact ownership confirmation' || return 1
	acquire_production_deploy_lock 'Identity ownership cutover'
	identity_cutover_validate_marker || return 1
	[[ "$(identity_cutover_marker_value revision)" == "$EXPECTED_REVISION" &&
		"$(identity_cutover_marker_value phase)" == 'restore-verified' &&
		"$(identity_database_current_phase)" == 'prepared' ]] ||
		identity_cutover_fail 'Identity deploy requires preflight then verified restore evidence' || return 1
	identity_cutover_assert_bound_images || return 1
	identity_cutover_freeze_core
	identity_cutover_export_snapshot
	local snapshot_sha
	snapshot_sha="$(identity_cutover_sha256 "$identity_snapshot")"
	identity_database_advance forward-only
	identity_cutover_write_marker forward-only "$EXPECTED_REVISION" \
		"$(identity_cutover_marker_value core_image_id)" \
		"$(identity_cutover_marker_value identity_image_id)" \
		"$(identity_cutover_marker_value gateway_image_id)" \
		"$(identity_cutover_marker_value campaigns_image_id)" \
		"$(identity_cutover_marker_value reporting_image_id)" \
		"$(identity_cutover_marker_value widgets_image_id)" \
		"$(identity_cutover_marker_value billing_image_id)" \
		"$(identity_cutover_marker_value route_sha256)" \
		"$(identity_cutover_marker_value core_backup_sha256)" \
		"$(identity_cutover_marker_value identity_pre_backup_sha256)" \
		"$(identity_cutover_marker_value pre_restore_evidence_sha256)" \
		"$snapshot_sha" pending pending "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	identity_frozen_core_recovery='false'
	trap identity_cutover_recover_pre_boundary EXIT
	identity_cutover_import_snapshot
	identity_cutover_start_forward_runtime
	identity_cutover_complete_forward
}

identity_cutover_forward_recovery() {
	identity_cutover_require_common
	acquire_production_deploy_lock 'Identity forward recovery'
	identity_cutover_validate_marker || return 1
	[[ "$(identity_cutover_marker_value revision)" == "$EXPECTED_REVISION" ]] || return 1
	identity_cutover_assert_bound_images || return 1
	trap identity_cutover_recover_pre_boundary EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	local database_phase marker_phase snapshot_sha
	database_phase="$(identity_database_current_phase)"
	marker_phase="$(identity_cutover_marker_value phase)"
	case "$database_phase:$marker_phase" in
	forward-only:restore-verified | forward-only:forward-only)
		identity_cutover_require_core_fenced_live || return 1
		identity_cutover_validate_private_file "$identity_snapshot" || return 1
		snapshot_sha="$(identity_cutover_sha256 "$identity_snapshot")"
		if [[ "$marker_phase" == 'restore-verified' ]]; then
			identity_cutover_write_marker forward-only "$EXPECTED_REVISION" \
				"$(identity_cutover_marker_value core_image_id)" \
				"$(identity_cutover_marker_value identity_image_id)" \
				"$(identity_cutover_marker_value gateway_image_id)" \
				"$(identity_cutover_marker_value campaigns_image_id)" \
				"$(identity_cutover_marker_value reporting_image_id)" \
				"$(identity_cutover_marker_value widgets_image_id)" \
				"$(identity_cutover_marker_value billing_image_id)" \
				"$(identity_cutover_marker_value route_sha256)" \
				"$(identity_cutover_marker_value core_backup_sha256)" \
				"$(identity_cutover_marker_value identity_pre_backup_sha256)" \
				"$(identity_cutover_marker_value pre_restore_evidence_sha256)" \
				"$snapshot_sha" pending pending "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		else
			[[ "$snapshot_sha" == "$(identity_cutover_marker_value snapshot_sha256)" ]] || return 1
		fi
		identity_cutover_import_snapshot
		identity_cutover_start_forward_runtime
		identity_cutover_complete_forward
		;;
	active:active)
		identity_cutover_require_core_fenced_live || return 1
		identity_cutover_start_forward_runtime
		identity_cutover_complete_forward
		;;
	complete:complete)
		identity_cutover_require_core_fenced_live || return 1
		identity_cutover_start_forward_runtime
		printf 'identity_cutover_phase=complete\n'
		;;
	*) identity_cutover_fail "unsupported Identity forward recovery state: $database_phase:$marker_phase" ;;
	esac
}

identity_cutover_status() {
	identity_database_status
	if [[ ! -e "$identity_cutover_marker" && ! -L "$identity_cutover_marker" ]]; then
		printf 'identity_cutover_phase=absent\n'
		return
	fi
	identity_cutover_validate_marker || return 1
	printf 'identity_cutover_phase=%s\n' "$(identity_cutover_marker_value phase)"
	printf 'identity_cutover_revision=%s\n' "$(identity_cutover_marker_value revision)"
}

identity_cutover_self_test() {
	identity_cutover_transition_allowed absent preflight-verified
	identity_cutover_transition_allowed preflight-verified restore-verified
	identity_cutover_transition_allowed restore-verified forward-only
	identity_cutover_transition_allowed forward-only active
	identity_cutover_transition_allowed active complete
	! identity_cutover_transition_allowed forward-only preflight-verified
	! identity_cutover_transition_allowed complete active
	local source
	source="$(declare -f identity_cutover_require_common identity_cutover_preflight identity_cutover_verify \
		identity_cutover_deploy identity_cutover_forward_recovery \
		identity_cutover_freeze_core identity_cutover_recover_pre_boundary \
		identity_cutover_run_core_fence_action identity_cutover_require_core_fenced_live \
		identity_cutover_wait_core_identity_outbox_drained \
		identity_cutover_require_frozen_boundary_evidence identity_cutover_export_snapshot \
		identity_cutover_start_forward_runtime identity_cutover_run_restore_rehearsal \
		identity_cutover_require_completion_parity identity_cutover_capture_dark_readiness \
		identity_cutover_switch_core_integration_permissions \
		identity_cutover_assert_narrow_owner_routes \
		identity_cutover_assert_destination_queue_owner)"
	[[ "$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *'preflight then verified restore evidence'* &&
		"$source" == *'legacyIdentityOutboxPending'* &&
		"$source" == *'stop --timeout 90 outbox-publisher'* &&
		"$source" == *'identity_cutover_run_core_fence_action fence'* &&
		"$source" == *'identity_cutover_run_core_fence_action unfence'* &&
		"$source" == *'identity_cutover_require_core_fenced_live'* &&
		"$source" == *'identity_database_advance forward-only'* &&
		"$source" == *'identity_cutover_require_completion_parity'* &&
		"$source" == *'ownership?.phase !== '\''IMPORTED'\'''* &&
		"$source" == *'CORE_IDENTITY_TOKEN'* && "$source" == *'BILLING_IDENTITY_TOKEN'* &&
		"$source" == *'WIDGETS_IDENTITY_TOKEN'* &&
		"$source" == *'api integration-worker'* &&
		"$source" == *'internal/v1/auth/introspect'* &&
		"$source" == *'admin\.audit\.(campaigns|reporting|widgets|billing|identity)'* &&
		"$source" == *'exactly one Identity consumer'* &&
		"$source" == *'identity-backup-restore-rehearsal.sh'* ]] || return 1
	printf 'identity_cutover_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--preflight) identity_cutover_preflight ;;
	--verify) identity_cutover_verify ;;
	--deploy) identity_cutover_deploy ;;
	--forward-recovery) identity_cutover_forward_recovery ;;
	--status) identity_cutover_status ;;
	--self-test) identity_cutover_self_test ;;
	*) identity_cutover_fail 'Usage: identity-cutover-production.sh --preflight|--verify|--deploy|--forward-recovery|--status|--self-test' ;;
	esac
fi
