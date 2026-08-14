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
IDENTITY_CORE_CLEANUP_MIGRATION="${IDENTITY_CORE_CLEANUP_MIGRATION:-20260815000000_remove_legacy_identity_core_source}"
IDENTITY_CORE_CLEANUP_MIGRATION_SHA256="${IDENTITY_CORE_CLEANUP_MIGRATION_SHA256:-}"
IDENTITY_CORE_CLEANUP_SOAK_SECONDS="${IDENTITY_CORE_CLEANUP_SOAK_SECONDS:-}"
IDENTITY_ENV_EXPECTED_SHA256="${IDENTITY_ENV_EXPECTED_SHA256:-}"
identity_cleanup_root="${IDENTITY_CORE_CLEANUP_ARTIFACT_ROOT:-$APP_ROOT/deploy/backend/identity-core-cleanup-artifacts}"
identity_cleanup_marker="${IDENTITY_CORE_CLEANUP_MARKER:-$APP_ROOT/deploy/backend/.identity-core-cleanup-v1}"
identity_cleanup_signing_marker="${IDENTITY_CORE_SIGNING_ENV_MARKER:-$APP_ROOT/deploy/backend/.identity-core-signing-env-removal-v1}"
identity_cleanup_core_backup="$identity_cleanup_root/core-frozen-pre-cleanup.dump"
identity_cleanup_identity_backup="$identity_cleanup_root/identity-pre-core-cleanup.dump"
identity_cleanup_identity_restore="$identity_cleanup_root/identity-pre-core-cleanup-restore.json"
identity_cleanup_post_core_backup="$identity_cleanup_root/core-post-cleanup.dump"

readonly identity_cleanup_confirmation='CLEANUP IDENTITY CORE SOURCE'

# shellcheck source=scripts/identity-cutover-production.sh
source "$IDENTITY_SCRIPT_ROOT/scripts/identity-cutover-production.sh"

identity_cleanup_fail() {
	printf 'identity_core_cleanup_error=%s\n' "$1" >&2
	return 1
}

identity_cleanup_validate_signing_marker() {
	[[ -f "$identity_cleanup_signing_marker" && ! -L "$identity_cleanup_signing_marker" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_cleanup_signing_marker")" == '0:0:600' ]] || return 1
	fi
	awk -F= '
    $1 !~ /^(version|cleanup_revision|source_sha256|result_sha256|updated_at)$/ { exit 1 }
    { count[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
    END {
      for (key in count) if (count[key] != 1) exit 1
      if (NR != 5 || value["version"] != "1" ||
          value["cleanup_revision"] !~ /^[0-9a-f]{40}$/ ||
          value["source_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["result_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["source_sha256"] == value["result_sha256"] ||
          value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
    }
  ' "$identity_cleanup_signing_marker"
}

identity_cleanup_signing_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z_]+$ ]] || return 1
	identity_cleanup_validate_signing_marker || return 1
	awk -F= -v key="$1" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$identity_cleanup_signing_marker"
}

identity_cleanup_env_sha256() {
	identity_cutover_sha256 "$ENV_FILE"
}

identity_cleanup_require_env_source_sha() {
	[[ "$IDENTITY_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
		identity_cleanup_fail 'exact local canonical backend env SHA-256 is required' || return 1
	local current_sha
	current_sha="$(identity_cleanup_env_sha256)" || return 1
	if [[ -e "$identity_cleanup_signing_marker" || -L "$identity_cleanup_signing_marker" ]]; then
		identity_cleanup_validate_signing_marker || return 1
		[[ "$(identity_cleanup_signing_marker_value cleanup_revision)" == "$EXPECTED_REVISION" &&
			"$current_sha" == "$(identity_cleanup_signing_marker_value result_sha256)" &&
			( "$IDENTITY_ENV_EXPECTED_SHA256" == "$(identity_cleanup_signing_marker_value source_sha256)" ||
				"$IDENTITY_ENV_EXPECTED_SHA256" == "$current_sha" ) ]] ||
			identity_cleanup_fail 'backend env drifted after Core signing-key removal' || return 1
	else
		[[ "$current_sha" == "$IDENTITY_ENV_EXPECTED_SHA256" ]] ||
			identity_cleanup_fail 'server backend env differs from the local canonical source copy' || return 1
	fi
}

identity_cleanup_assert_candidate_signing_boundary() {
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		config --format json | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const compose = JSON.parse(input);
  const services = compose?.services || {};
  const core = services.api?.environment || {};
  const identity = services["identity-api"]?.environment || {};
  const keys = ["JWT_ACCESS_PRIVATE_KEY_BASE64", "JWT_ACCESS_JWKS_BASE64", "JWT_ACCESS_ACTIVE_KID"];
  if (keys.some(key => Object.prototype.hasOwnProperty.call(core, key)) ||
      keys.some(key => !identity[key])) process.exit(1);
  for (const [name, service] of Object.entries(services)) {
    if (name === "identity-api") continue;
    if (keys.some(key => Object.prototype.hasOwnProperty.call(service?.environment || {}, key))) process.exit(1);
  }
});
' || identity_cleanup_fail 'cleanup candidate still exposes Identity signing material to Core'
}

identity_cleanup_export_env_if_requested() {
	[[ -n "${IDENTITY_ENV_EXPORT_CERTIFICATE_FILE:-}" ||
		-n "${IDENTITY_ENV_EXPORT_FILE:-}" ]] || return 0
	[[ -n "${IDENTITY_ENV_EXPORT_CERTIFICATE_FILE:-}" &&
		-n "${IDENTITY_ENV_EXPORT_FILE:-}" ]] || return 1
	APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" EXPECTED_REVISION="$EXPECTED_REVISION" \
		IDENTITY_ENV_EXPORT_CERTIFICATE_FILE="$IDENTITY_ENV_EXPORT_CERTIFICATE_FILE" \
		IDENTITY_ENV_EXPORT_FILE="$IDENTITY_ENV_EXPORT_FILE" \
		bash "$IDENTITY_SCRIPT_ROOT/scripts/identity-production-env-control.sh" \
			--export-encrypted
}

identity_cleanup_remove_core_signing_env() {
	identity_cleanup_require_env_source_sha
	if [[ -e "$identity_cleanup_signing_marker" || -L "$identity_cleanup_signing_marker" ]]; then
		identity_cleanup_validate_signing_marker
		identity_cleanup_export_env_if_requested
		return
	fi
	local source_sha result_sha temporary="${identity_cleanup_signing_marker}.tmp.$$"
	source_sha="$(identity_cleanup_env_sha256)"
	node - "$ENV_FILE" <<'NODE'
const { chmodSync, chownSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const file = process.argv[2];
const content = readFileSync(file, 'utf8');
const remove = new Set(['JWT_ACCESS_PRIVATE_KEY_BASE64', 'JWT_ACCESS_JWKS_BASE64', 'JWT_ACCESS_ACTIVE_KID']);
const identity = new Set(['IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64', 'IDENTITY_JWT_ACCESS_JWKS_BASE64', 'IDENTITY_JWT_ACCESS_ACTIVE_KID']);
const counts = new Map();
const values = new Map();
const retained = [];
for (const line of content.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!match) { retained.push(line); continue; }
  counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  values.set(match[1], match[2].replace(/\r$/, '').trim());
  if (!remove.has(match[1])) retained.push(line);
}
if ([...counts.values()].some(count => count !== 1) ||
    [...remove].some(key => counts.get(key) !== 1 || !values.get(key)) ||
    [...identity].some(key => counts.get(key) !== 1 || !values.get(key))) process.exit(1);
const output = `${retained.join('\n').replace(/\n+$/, '')}\n`;
const temporary = `${file}.identity-core-signing-${process.pid}-${Date.now()}`;
try {
  writeFileSync(temporary, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chownSync(temporary, 0, 0);
  renameSync(temporary, file);
  chmodSync(file, 0o600);
} catch (error) {
  try { unlinkSync(temporary); } catch {}
  throw error;
}
NODE
	result_sha="$(identity_cleanup_env_sha256)"
	[[ "$result_sha" =~ ^[0-9a-f]{64}$ && "$result_sha" != "$source_sha" ]] || return 1
	{
		printf 'version=1\ncleanup_revision=%s\n' "$EXPECTED_REVISION"
		printf 'source_sha256=%s\nresult_sha256=%s\n' "$source_sha" "$result_sha"
		printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$identity_cleanup_signing_marker"
	identity_cleanup_validate_signing_marker
	printf 'identity_core_signing_env_removed=true\n'
	printf 'identity_production_env_sha256=%s\n' "$result_sha"
	identity_cleanup_export_env_if_requested
}

identity_cleanup_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z_]+$ ]] || return 1
	identity_cleanup_validate_marker || return 1
	awk -F= -v key="$1" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$identity_cleanup_marker"
}

identity_cleanup_validate_marker() {
	[[ -f "$identity_cleanup_marker" && ! -L "$identity_cleanup_marker" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_cleanup_marker")" == '0:0:600' ]] || return 1
	fi
	awk -F= '
    $1 !~ /^(version|phase|ownership_revision|cleanup_revision|migration|migration_sha256|core_backup_sha256|identity_backup_sha256|identity_restore_evidence_sha256|post_core_backup_sha256|updated_at)$/ { exit 1 }
    { count[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
    END {
      for (key in count) if (count[key] != 1) exit 1
      if (NR != 11 || value["version"] != "1" ||
          value["phase"] !~ /^(verified|forward-only|complete)$/ ||
          value["ownership_revision"] !~ /^[0-9a-f]{40}$/ ||
          value["cleanup_revision"] !~ /^[0-9a-f]{40}$/ ||
          value["ownership_revision"] == value["cleanup_revision"] ||
          value["migration"] != "20260815000000_remove_legacy_identity_core_source" ||
          value["migration_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
      for (key in value) if (key ~ /_backup_sha256$|_evidence_sha256$/ &&
          value[key] !~ /^(pending|[0-9a-f]{64})$/) exit 1
      if (value["phase"] == "complete" && value["post_core_backup_sha256"] == "pending") exit 1
    }
  ' "$identity_cleanup_marker"
}

identity_cleanup_transition_allowed() {
	case "$1:$2" in
	absent:verified | verified:verified | verified:forward-only | \
		forward-only:forward-only | forward-only:complete | complete:complete) return 0 ;;
	*) return 1 ;;
	esac
}

identity_cleanup_write_marker() {
	[[ $# -eq 10 ]] || return 1
	local current='absent' temporary="${identity_cleanup_marker}.tmp.$$"
	if [[ -e "$identity_cleanup_marker" || -L "$identity_cleanup_marker" ]]; then
		identity_cleanup_validate_marker || return 1
		current="$(identity_cleanup_marker_value phase)"
	fi
	identity_cleanup_transition_allowed "$current" "$1" || return 1
	{
		printf 'version=1\nphase=%s\nownership_revision=%s\ncleanup_revision=%s\n' "$1" "$2" "$3"
		printf 'migration=%s\nmigration_sha256=%s\n' "$4" "$5"
		printf 'core_backup_sha256=%s\nidentity_backup_sha256=%s\n' "$6" "$7"
		printf 'identity_restore_evidence_sha256=%s\npost_core_backup_sha256=%s\n' "$8" "$9"
		printf 'updated_at=%s\n' "${10}"
	} >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$identity_cleanup_marker"
	identity_cleanup_validate_marker
}

identity_cleanup_require_migration() {
	local migration_file="$SERVER_ROOT/prisma/migrations/$IDENTITY_CORE_CLEANUP_MIGRATION/migration.sql"
	[[ "$IDENTITY_CORE_CLEANUP_MIGRATION" == '20260815000000_remove_legacy_identity_core_source' &&
		"$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" =~ ^[0-9a-f]{64}$ &&
		-f "$migration_file" && ! -L "$migration_file" &&
		"$(identity_cutover_sha256 "$migration_file")" == "$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" ]] ||
		identity_cleanup_fail 'exact reviewed Identity Core cleanup migration/SHA-256 is required' || return 1
	local ownership_revision changed_migrations
	ownership_revision="$(identity_cutover_marker_value revision)"
	git -C "$SERVER_ROOT" merge-base --is-ancestor "$ownership_revision" "$EXPECTED_REVISION" ||
		identity_cleanup_fail 'cleanup revision must descend from the ownership revision' || return 1
	changed_migrations="$(git -C "$SERVER_ROOT" diff --name-only \
		"$ownership_revision" "$EXPECTED_REVISION" -- prisma/migrations)"
	[[ "$changed_migrations" == "prisma/migrations/$IDENTITY_CORE_CLEANUP_MIGRATION/migration.sql" ]] ||
		identity_cleanup_fail 'cleanup revision must add exactly the reviewed Identity Core cleanup migration' || return 1
}

identity_cleanup_require_soak() {
	local soak_seconds="$IDENTITY_CORE_CLEANUP_SOAK_SECONDS" updated_at
	if [[ -z "$soak_seconds" ]]; then
		soak_seconds="$(identity_read_env_value "$ENV_FILE" IDENTITY_CORE_CLEANUP_SOAK_SECONDS 2>/dev/null || printf '900')"
	fi
	[[ "$soak_seconds" =~ ^[0-9]+$ && "$soak_seconds" -ge 900 &&
		"$soak_seconds" -le 86400 ]] ||
		identity_cleanup_fail 'Identity cleanup soak must be between 900 and 86400 seconds' || return 1
	updated_at="$(identity_cutover_marker_value updated_at)" || return 1
	CUTOVER_UPDATED_AT="$updated_at" SOAK_SECONDS="$soak_seconds" node -e '
const updated = Date.parse(process.env.CUTOVER_UPDATED_AT || "");
const soakMs = Number(process.env.SOAK_SECONDS) * 1000;
const now = Date.now();
if (!Number.isFinite(updated) || !Number.isSafeInteger(soakMs) || updated > now || now - updated < soakMs) process.exit(1);
' || identity_cleanup_fail "Identity cleanup requires the completed cutover soak window ($soak_seconds seconds)"
}

identity_cleanup_assert_identity_runtime_stable() {
	local ownership_revision spec service port container_id image_id revision restart_count health
	ownership_revision="$(identity_cutover_marker_value revision)" || return 1
	for spec in 'identity-api:4900' 'identity-worker:4901' 'identity-outbox-publisher:4902'; do
		service="${spec%%:*}"
		port="${spec##*:}"
		container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			ps --status running -q "$service")" || return 1
		[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
			identity_cleanup_fail "$service must have exactly one running instance" || return 1
		image_id="$(docker inspect --format '{{.Image}}' "$container_id")" || return 1
		revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" || return 1
		restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")" || return 1
		health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" || return 1
		[[ "$image_id" == "$(identity_cutover_marker_value identity_image_id)" &&
			"$revision" == "$ownership_revision" && "$restart_count" == '0' &&
			"$health" == 'healthy' ]] ||
			identity_cleanup_fail "$service is not a stable zero-restart ownership runtime" || return 1
		identity_cutover_wait_url "http://127.0.0.1:$port/health/ready" "$service"
	done
	identity_cutover_wait_url http://127.0.0.1:4100/health/ready 'API Gateway before Identity cleanup'
	identity_cutover_wait_url http://127.0.0.1:4900/api/v1/auth/settings 'direct Identity auth health'
	identity_cutover_wait_url https://api.winwidget.ru/api/v1/auth/settings 'public Identity auth health'
	identity_cutover_wait_url http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json 'direct Identity JWKS before cleanup'
	identity_cutover_wait_url https://api.winwidget.ru/api/v1/auth/.well-known/jwks.json 'public Identity JWKS before cleanup'
	local direct_sha public_sha
	direct_sha="$(curl -fsS --connect-timeout 3 --max-time 10 \
		http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json | identity_cutover_text_sha256)"
	public_sha="$(curl -fsS --connect-timeout 3 --max-time 10 \
		https://api.winwidget.ru/api/v1/auth/.well-known/jwks.json | identity_cutover_text_sha256)"
	[[ "$direct_sha" =~ ^[0-9a-f]{64}$ && "$direct_sha" == "$public_sha" ]] ||
		identity_cleanup_fail 'public and direct Identity JWKS differ before cleanup'
}

identity_cleanup_assert_identity_queues_drained() {
	identity_cutover_assert_destination_queue_owner
	identity_cutover_wait_projection_queues_drained \
		"$identity_core_post_boundary_projection_evidence"
	docker run --rm --network host --env-file "$ENV_FILE" --entrypoint node \
		"winwidget-api:git-$EXPECTED_REVISION" -e '
class QueueError extends Error {}
const run = async () => {
  const baseUrl = (process.env.RABBITMQ_MANAGEMENT_URL || "http://127.0.0.1:15672").replace(/\/$/, "");
  const vhost = process.env.RABBITMQ_VHOST || "winwidget";
  const user = process.env.RABBITMQ_MONITOR_USER;
  const password = process.env.RABBITMQ_MONITOR_PASSWORD;
  if (!user || !password) throw new QueueError("RabbitMQ monitor credentials are missing");
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const queueName = "winwidget.notification.telegram-destination-unavailable";
  for (const suffix of ["", ".dead-letter", ".retry-v2.1", ".retry-v2.2", ".retry-v2.3"]) {
    const response = await fetch(`${baseUrl}/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queueName + suffix)}`, {
      headers: { Authorization: authorization }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new QueueError(`RabbitMQ Management returned HTTP ${response.status}`); }
    const queue = await response.json();
    if (queue?.messages_ready !== 0 || queue?.messages_unacknowledged !== 0 || queue?.messages !== 0) {
      throw new QueueError(`Identity queue is not drained: ${queueName + suffix}`);
    }
  }
};
run().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Identity queue drain check failed"}\n`); process.exit(1); });
'
}

identity_cleanup_require_common() {
	identity_database_require_root
	identity_release_validate_revision "$EXPECTED_REVISION"
	identity_release_validate_file "$ENV_FILE"
	identity_release_validate_file "$COMPOSE_FILE"
	identity_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION"
	identity_cleanup_require_env_source_sha
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	identity_cutover_require_route_contract || return 1
	identity_cutover_require_tokens || return 1
	identity_database_validate_marker || return 1
	identity_cutover_validate_marker || return 1
	[[ "$(identity_database_current_phase)" == 'complete' &&
		"$(identity_cutover_marker_value phase)" == 'complete' &&
		"$(identity_database_marker_value ownership_revision)" == "$(identity_cutover_marker_value revision)" ]] ||
		identity_cleanup_fail 'Identity ownership and recovery gates must be complete before Core cleanup' || return 1
	identity_cleanup_require_soak
	identity_cleanup_require_migration
	if [[ ! -e "$identity_cleanup_root" && ! -L "$identity_cleanup_root" ]]; then
		mkdir -m 700 "$identity_cleanup_root"
		chown 0:0 "$identity_cleanup_root"
	fi
	[[ -d "$identity_cleanup_root" && ! -L "$identity_cleanup_root" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_cleanup_root")" == '0:0:700' ]] || return 1
	fi
}

identity_cleanup_verify() {
	identity_cleanup_require_common
	acquire_production_deploy_lock 'Identity Core cleanup verification'
	if [[ -e "$identity_cleanup_marker" || -L "$identity_cleanup_marker" ]]; then
		identity_cleanup_validate_marker || return 1
		[[ "$(identity_cleanup_marker_value cleanup_revision)" == "$EXPECTED_REVISION" ]] || return 1
		printf 'identity_core_cleanup_phase=%s\n' "$(identity_cleanup_marker_value phase)"
		return
	fi
	identity_cleanup_assert_candidate_signing_boundary
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		build --pull api maintenance-worker database-restore-worker
	identity_cutover_verify_image "winwidget-api:git-$EXPECTED_REVISION" "$EXPECTED_REVISION"
	identity_cleanup_assert_identity_runtime_stable
	identity_cleanup_assert_identity_queues_drained
	identity_cutover_create_backup DATABASE_BACKUP_URL public "$identity_cleanup_core_backup"
	identity_cutover_create_backup IDENTITY_BACKUP_URL identity "$identity_cleanup_identity_backup"
	identity_cutover_run_restore_rehearsal pre-cutover "$identity_cleanup_identity_backup" \
		"$identity_cleanup_identity_restore"
	identity_cleanup_write_marker verified "$(identity_cutover_marker_value revision)" \
		"$EXPECTED_REVISION" "$IDENTITY_CORE_CLEANUP_MIGRATION" \
		"$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" \
		"$(identity_cutover_sha256 "$identity_cleanup_core_backup")" \
		"$(identity_cutover_sha256 "$identity_cleanup_identity_backup")" \
		"$(identity_cutover_sha256 "$identity_cleanup_identity_restore")" pending \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'identity_core_cleanup_phase=verified\n'
}

identity_cleanup_source_state() {
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		run --rm -T --no-deps --entrypoint node api -e '
const { PrismaClient } = require("@prisma/client");
const url = process.env.DATABASE_URL_PRODUCTION;
if (!url) process.exit(64);
const prisma = new PrismaClient({ datasources: { db: { url } } });
(async () => {
  const tables = await prisma.$queryRawUnsafe(`SELECT ARRAY[
    to_regclass('\''public."User"'\''), to_regclass('\''public.user_sessions'\''),
    to_regclass('\''public.auth_identities'\''),
    to_regclass('\''public.telegram_notification_channels'\''),
    to_regclass('\''public.verification_challenges'\'')] AS value`);
  const columns = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count
    FROM information_schema.columns WHERE table_schema = '\''public'\'' AND
    table_name = '\''site_settings'\'' AND column_name IN
    ('\''recaptcha_enabled'\'', '\''google_auth_enabled'\'', '\''yandex_auth_enabled'\'',
     '\''github_auth_enabled'\'', '\''vk_auth_enabled'\'', '\''telegram_auth_enabled'\'')`);
  const migration = await prisma.$queryRawUnsafe(
    `SELECT finished_at, rolled_back_at, logs FROM _prisma_migrations WHERE migration_name = $1`,
    process.argv[1],
  );
  const absent = tables.length === 1 && tables[0].value.every(value => value === null) &&
    columns.length === 1 && columns[0].count === 0;
  const applied = migration.length === 1 && migration[0].finished_at &&
    !migration[0].rolled_back_at && !migration[0].logs;
  process.stdout.write(absent && applied ? "absent|applied" : "unsafe");
})().then(() => prisma.$disconnect()).catch(async () => {
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
' "$IDENTITY_CORE_CLEANUP_MIGRATION"
}

identity_cleanup_start_core() {
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate \
		api integration-worker outbox-publisher maintenance-worker database-restore-worker
	identity_cutover_wait_url http://127.0.0.1:4200/api/v1/health/ready 'clean Core API'
	local status
	for path in /api/v1/auth/settings /api/v1/users/me /api/v1/telegram-auth/admin/status; do
		status="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 \
			"http://127.0.0.1:4200$path" || true)"
		[[ "$status" =~ ^(404|410)$ ]] ||
			identity_cleanup_fail "legacy Core Identity route remains active: $path status=$status" || return 1
	done
	identity_cutover_wait_url https://api.winwidget.ru/api/v1/auth/.well-known/jwks.json \
		'public Identity JWKS after Core cleanup'
	local core_container identity_container core_keys identity_keys
	core_container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q api)" || return 1
	identity_container="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		ps --status running -q identity-api)" || return 1
	[[ "$core_container" =~ ^[0-9a-f]{64}$ && "$identity_container" =~ ^[0-9a-f]{64}$ ]] || return 1
	core_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$core_container" |
		awk -F= '{ print $1 }' | LC_ALL=C sort -u)" || return 1
	identity_keys="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$identity_container" |
		awk -F= '{ print $1 }' | LC_ALL=C sort -u)" || return 1
	for key in JWT_ACCESS_PRIVATE_KEY_BASE64 JWT_ACCESS_JWKS_BASE64 JWT_ACCESS_ACTIVE_KID; do
		! grep -Fxq "$key" <<<"$core_keys" ||
			identity_cleanup_fail "clean Core container still receives $key" || return 1
		grep -Fxq "$key" <<<"$identity_keys" ||
			identity_cleanup_fail "Identity API lost required signing key $key" || return 1
	done
	for key in JWT_ACCESS_PRIVATE_KEY_BASE64 JWT_ACCESS_JWKS_BASE64 JWT_ACCESS_ACTIVE_KID; do
		! awk -F= -v key="$key" '$1 == key { found += 1 } END { exit(found == 0 ? 0 : 1) }' "$ENV_FILE" ||
			identity_cleanup_fail "legacy Core signing key remains in backend production env: $key" || return 1
	done
}

identity_cleanup_deploy() {
	identity_cleanup_require_common
	[[ "${IDENTITY_CORE_CLEANUP_CONFIRMATION:-}" == "$identity_cleanup_confirmation" ]] ||
		identity_cleanup_fail 'Core source cleanup requires exact confirmation' || return 1
	acquire_production_deploy_lock 'Identity Core source cleanup'
	identity_cleanup_validate_marker || return 1
	[[ "$(identity_cleanup_marker_value phase)" =~ ^(verified|forward-only)$ &&
		"$(identity_cleanup_marker_value cleanup_revision)" == "$EXPECTED_REVISION" ]] || return 1
	identity_cleanup_assert_identity_runtime_stable
	identity_cleanup_assert_identity_queues_drained
	identity_cleanup_assert_candidate_signing_boundary
	if [[ "$(identity_cleanup_marker_value phase)" == 'verified' ]]; then
		[[ "$(identity_cutover_sha256 "$identity_cleanup_core_backup")" == "$(identity_cleanup_marker_value core_backup_sha256)" &&
			"$(identity_cutover_sha256 "$identity_cleanup_identity_backup")" == "$(identity_cleanup_marker_value identity_backup_sha256)" &&
			"$(identity_cutover_sha256 "$identity_cleanup_identity_restore")" == "$(identity_cleanup_marker_value identity_restore_evidence_sha256)" ]] || return 1
		identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			stop --timeout 90 api integration-worker outbox-publisher maintenance-worker
		identity_cleanup_write_marker forward-only "$(identity_cleanup_marker_value ownership_revision)" \
			"$EXPECTED_REVISION" "$IDENTITY_CORE_CLEANUP_MIGRATION" \
			"$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" \
			"$(identity_cleanup_marker_value core_backup_sha256)" \
			"$(identity_cleanup_marker_value identity_backup_sha256)" \
			"$(identity_cleanup_marker_value identity_restore_evidence_sha256)" pending \
			"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	fi
	identity_cleanup_remove_core_signing_env
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		--profile migration run --rm -T --no-deps migrate
	[[ "$(identity_cleanup_source_state)" == 'absent|applied' ]] ||
		identity_cleanup_fail 'Identity Core source cleanup did not reach absent|applied' || return 1
	identity_cleanup_start_core
	identity_cutover_create_backup DATABASE_BACKUP_URL public "$identity_cleanup_post_core_backup"
	identity_database_mark_cleanup "$EXPECTED_REVISION"
	identity_cleanup_write_marker complete "$(identity_cleanup_marker_value ownership_revision)" \
		"$EXPECTED_REVISION" "$IDENTITY_CORE_CLEANUP_MIGRATION" \
		"$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" \
		"$(identity_cleanup_marker_value core_backup_sha256)" \
		"$(identity_cleanup_marker_value identity_backup_sha256)" \
		"$(identity_cleanup_marker_value identity_restore_evidence_sha256)" \
		"$(identity_cutover_sha256 "$identity_cleanup_post_core_backup")" \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'identity_core_cleanup_phase=complete\n'
}

identity_cleanup_status() {
	if [[ ! -e "$identity_cleanup_marker" && ! -L "$identity_cleanup_marker" ]]; then
		printf 'identity_core_cleanup_phase=absent\n'
		return
	fi
	identity_cleanup_validate_marker || return 1
	printf 'identity_core_cleanup_phase=%s\n' "$(identity_cleanup_marker_value phase)"
	printf 'identity_core_cleanup_revision=%s\n' "$(identity_cleanup_marker_value cleanup_revision)"
}

identity_cleanup_self_test() {
	identity_cleanup_transition_allowed absent verified
	identity_cleanup_transition_allowed verified forward-only
	identity_cleanup_transition_allowed forward-only complete
	! identity_cleanup_transition_allowed complete verified
	local source
	source="$(declare -f identity_cleanup_require_migration identity_cleanup_require_common \
		identity_cleanup_require_soak identity_cleanup_assert_identity_runtime_stable \
		identity_cleanup_assert_identity_queues_drained identity_cleanup_assert_candidate_signing_boundary \
		identity_cleanup_remove_core_signing_env identity_cleanup_deploy identity_cleanup_source_state)"
	[[ "$source" == *'merge-base --is-ancestor'* &&
		"$source" == *'must add exactly the reviewed Identity Core cleanup migration'* &&
		"$source" == *'database_restore_guard_assert_before_mutation'* &&
		"$source" == *'soak must be between 900 and 86400 seconds'* &&
		"$source" == *'RestartCount'* && "$source" == *'health/ready'* &&
		"$source" == *'messages_unacknowledged !== 0'* &&
		"$source" == *'identity_cutover_wait_projection_queues_drained'* &&
		"$source" == *'identity-api'* && "$source" == *'JWT_ACCESS_PRIVATE_KEY_BASE64'* &&
		"$source" == *'forward-only'* && "$source" == *'absent|applied'* &&
		"$source" == *'identity_database_mark_cleanup'* ]] || return 1
	printf 'identity_core_cleanup_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--verify) identity_cleanup_verify ;;
	--deploy | --forward-recovery) identity_cleanup_deploy ;;
	--status) identity_cleanup_status ;;
	--self-test) identity_cleanup_self_test ;;
	*) identity_cleanup_fail 'Usage: cleanup-identity-core-source-production.sh --verify|--deploy|--forward-recovery|--status|--self-test' ;;
	esac
fi
