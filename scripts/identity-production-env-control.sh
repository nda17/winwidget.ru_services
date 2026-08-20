#!/usr/bin/env bash

# One-time, fail-closed production env bootstrap for the Identity ownership
# candidate. Secret values are generated and written atomically on the backend
# VPS; this script never prints them or copies plaintext env outside the host.

set -Eeuo pipefail
umask 077
export LC_ALL=C

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
EXPECTED_REVISION="${EXPECTED_REVISION:-}"
IDENTITY_ENV_EXPECTED_SHA256="${IDENTITY_ENV_EXPECTED_SHA256:-}"
identity_env_marker="${IDENTITY_PRODUCTION_ENV_MARKER:-$APP_ROOT/deploy/backend/.identity-production-env-v1}"
identity_env_marker_temporary="${identity_env_marker}.tmp"
identity_env_admin_password_file="$APP_ROOT/deploy/backend/.identity-postgres-admin-password"
identity_env_admin_password_temporary="$APP_ROOT/deploy/backend/.identity-postgres-admin-password.bootstrap-tmp"
identity_env_bootstrap_source="$APP_ROOT/deploy/backend/.identity-production-env-bootstrap-source-v1"
identity_env_bootstrap_journal="$APP_ROOT/deploy/backend/.identity-production-env-bootstrap-journal-v1"
identity_env_bootstrap_candidate="$APP_ROOT/deploy/backend/.identity-production-env-bootstrap-candidate-v1"
identity_env_bootstrap_candidate_temporary="${identity_env_bootstrap_candidate}.tmp"
identity_env_bootstrap_rollback_temporary="${ENV_FILE}.identity-bootstrap-rollback"
identity_env_bootstrap_source_temporary="${identity_env_bootstrap_source}.tmp"
identity_env_bootstrap_journal_temporary="${identity_env_bootstrap_journal}.tmp"
identity_database_marker="$APP_ROOT/deploy/backend/.identity-database-lifecycle-v1"
identity_cutover_marker="$APP_ROOT/deploy/backend/.identity-cutover-v1"
identity_cleanup_marker="$APP_ROOT/deploy/backend/.identity-core-cleanup-v1"

readonly identity_env_postgres_image='postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296'
readonly identity_env_integration_kinds='campaign-admin-audit,reporting-admin-audit,widgets-admin-audit,billing-admin-audit,identity-admin-audit,billing-payment-projection,billing-subscription-projection,billing-affiliate-projection,billing-settings-projection'

identity_env_fail() {
	printf 'identity_production_env_error=%s\n' "$1" >&2
	return 1
}

identity_env_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk 'NR == 1 { print $1 }'
	else
		shasum -a 256 "$1" | awk 'NR == 1 { print $1 }'
	fi
}

identity_env_require_root() {
	[[ "$(id -u)" == '0' ]] ||
		identity_env_fail 'Identity production env control must run as root'
}

identity_env_require_revision() {
	[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]] ||
		identity_env_fail 'Identity production env control requires an exact revision'
}

identity_env_require_file() {
	[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
		"$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
		identity_env_fail 'backend production env must be a root-owned mode-600 regular file' || return 1
	local duplicates
	duplicates="$(awk '
    /^[[:space:]]*(#|$)/ { next }
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (line !~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) next
      name = line
      sub(/[[:space:]]*=.*/, "", name)
      count[name] += 1
    }
    END { for (name in count) if (count[name] != 1) print name }
	' "$ENV_FILE" | LC_ALL=C sort)" || return 1
	[[ -z "$duplicates" ]] ||
		identity_env_fail 'backend production env contains duplicate keys' || return 1
}

identity_env_validate_marker_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$1")" == '0:0:600' ]] || return 1
	fi
	awk -F= '
    $1 !~ /^(version|phase|revision|source_sha256|result_sha256|updated_at)$/ { exit 1 }
    { count[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
    END {
      for (key in count) if (count[key] != 1) exit 1
      if (NR != 6 || value["version"] != "1" ||
          value["phase"] != "candidate" ||
          value["revision"] !~ /^[0-9a-f]{40}$/ ||
          value["source_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["result_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
    }
	' "$1"
}

identity_env_validate_marker() {
	identity_env_validate_marker_file "$identity_env_marker"
}

identity_env_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^(version|phase|revision|source_sha256|result_sha256|updated_at)$ ]] || return 1
	identity_env_validate_marker || return 1
	awk -F= -v key="$1" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$identity_env_marker"
}

identity_env_write_marker() {
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{64}$ && "$2" =~ ^[0-9a-f]{64}$ &&
		"$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
	local temporary="$identity_env_marker_temporary" updated_at
	[[ ! -e "$identity_env_marker" && ! -L "$identity_env_marker" ]] || return 1
	if [[ -e "$temporary" || -L "$temporary" ]]; then
		[[ -f "$temporary" && ! -L "$temporary" &&
			"$(stat -c '%u:%g:%a' "$temporary")" == '0:0:600' ]] || return 1
		rm -f -- "$temporary" || return 1
	fi
	updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 1
	[[ "$updated_at" =~ ^[0-9TZ:.-]+$ ]] || return 1
	(
		set -o noclobber
		{
			printf 'version=1\nphase=candidate\nrevision=%s\n' "$EXPECTED_REVISION"
			printf 'source_sha256=%s\nresult_sha256=%s\n' "$1" "$2"
			printf 'updated_at=%s\n' "$updated_at"
		} >"$temporary"
	) || return 1
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	identity_env_validate_marker_file "$temporary" || return 1
	mv -- "$temporary" "$identity_env_marker" || return 1
	identity_env_validate_marker || return 1
}

identity_env_bootstrap_lifecycle_absent() {
	local path
	for path in "$identity_database_marker" "$identity_cutover_marker" \
		"$identity_cleanup_marker"; do
		[[ ! -e "$path" && ! -L "$path" ]] ||
			identity_env_fail 'incomplete Identity env bootstrap cannot cross a lifecycle marker' || return 1
	done
}

identity_env_validate_bootstrap_journal_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" &&
		"$(stat -c '%u:%g:%a' "$1")" == '0:0:600' ]] || return 1
	awk -F= '
    $1 !~ /^(version|phase|revision|source_sha256|updated_at)$/ { exit 1 }
    { count[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
    END {
      for (key in count) if (count[key] != 1) exit 1
      if (NR != 5 || value["version"] != "1" ||
          value["phase"] != "source-protected" ||
          value["revision"] !~ /^[0-9a-f]{40}$/ ||
          value["source_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
    }
	' "$1"
}

identity_env_validate_bootstrap_journal() {
	identity_env_validate_bootstrap_journal_file "$identity_env_bootstrap_journal"
}

identity_env_bootstrap_journal_value() {
	[[ $# -eq 1 && "$1" =~ ^(version|phase|revision|source_sha256|updated_at)$ ]] || return 1
	identity_env_validate_bootstrap_journal || return 1
	awk -F= -v key="$1" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$identity_env_bootstrap_journal"
}

identity_env_write_bootstrap_journal() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{64}$ &&
		"$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
	local temporary="$identity_env_bootstrap_journal_temporary" updated_at
	[[ ! -e "$identity_env_bootstrap_journal" &&
		! -L "$identity_env_bootstrap_journal" ]] || return 1
	if [[ -e "$temporary" || -L "$temporary" ]]; then
		[[ -f "$temporary" && ! -L "$temporary" &&
			"$(stat -c '%u:%g:%a' "$temporary")" == '0:0:600' ]] || return 1
		rm -f -- "$temporary" || return 1
	fi
	updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 1
	[[ "$updated_at" =~ ^[0-9TZ:.-]+$ ]] || return 1
	(
		set -o noclobber
		{
			printf 'version=1\nphase=source-protected\nrevision=%s\n' "$EXPECTED_REVISION"
			printf 'source_sha256=%s\nupdated_at=%s\n' "$1" "$updated_at"
		} >"$temporary"
	) || return 1
	chmod 600 "$temporary" || return 1
	chown 0:0 "$temporary" || return 1
	identity_env_validate_bootstrap_journal_file "$temporary" || return 1
	mv -- "$temporary" "$identity_env_bootstrap_journal" || return 1
	identity_env_validate_bootstrap_journal || return 1
}

identity_env_require_bootstrap_source() {
	[[ -f "$identity_env_bootstrap_source" &&
		! -L "$identity_env_bootstrap_source" &&
		"$(stat -c '%u:%g:%a' "$identity_env_bootstrap_source")" == '0:0:600' ]] ||
		identity_env_fail 'protected Identity bootstrap source is unsafe' || return 1
}

identity_env_protect_bootstrap_source() {
	[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{64}$ ]] || return 1
	local source_sha="$1" temporary="$identity_env_bootstrap_source_temporary"
	if [[ -e "$identity_env_bootstrap_journal" || -L "$identity_env_bootstrap_journal" ]]; then
		identity_env_validate_bootstrap_journal || return 1
		identity_env_require_bootstrap_source || return 1
		[[ "$(identity_env_bootstrap_journal_value revision)" == "$EXPECTED_REVISION" &&
			"$(identity_env_bootstrap_journal_value source_sha256)" == "$source_sha" &&
			"$(identity_env_sha256 "$identity_env_bootstrap_source")" == "$source_sha" ]] || return 1
		return
	fi
	if [[ -e "$identity_env_bootstrap_source" || -L "$identity_env_bootstrap_source" ]]; then
		identity_env_require_bootstrap_source || return 1
		[[ ! -e "$identity_env_admin_password_file" &&
			! -L "$identity_env_admin_password_file" &&
			"$(identity_env_sha256 "$identity_env_bootstrap_source")" == "$source_sha" &&
			"$(identity_env_sha256 "$ENV_FILE")" == "$source_sha" ]] || return 1
		identity_env_write_bootstrap_journal "$source_sha" || return 1
		return
	fi
	if [[ -e "$temporary" || -L "$temporary" ]]; then
		[[ -f "$temporary" && ! -L "$temporary" &&
			"$(stat -c '%u:%g:%a' "$temporary")" == '0:0:600' &&
			"$(identity_env_sha256 "$temporary")" == "$source_sha" ]] || return 1
	else
		install -o 0 -g 0 -m 600 "$ENV_FILE" "$temporary" || return 1
	fi
	[[ "$(identity_env_sha256 "$temporary")" == "$source_sha" ]] || return 1
	mv -- "$temporary" "$identity_env_bootstrap_source" || return 1
	identity_env_require_bootstrap_source || return 1
	identity_env_write_bootstrap_journal "$source_sha" || return 1
}

identity_env_finalize_bootstrap_journal() {
	[[ $# -eq 2 && "$1" =~ ^[0-9a-f]{64}$ && "$2" =~ ^[0-9a-f]{64}$ ]] || return 1
	local source_sha="$1" result_sha="$2"
	if [[ ! -e "$identity_env_bootstrap_journal" &&
		! -L "$identity_env_bootstrap_journal" &&
		! -e "$identity_env_bootstrap_source" &&
		! -L "$identity_env_bootstrap_source" &&
		! -e "$identity_env_bootstrap_candidate" &&
		! -L "$identity_env_bootstrap_candidate" &&
		! -e "$identity_env_bootstrap_candidate_temporary" &&
		! -L "$identity_env_bootstrap_candidate_temporary" &&
		! -e "$identity_env_bootstrap_rollback_temporary" &&
		! -L "$identity_env_bootstrap_rollback_temporary" ]]; then
		return
	fi
	identity_env_validate_bootstrap_journal || return 1
	[[ "$(identity_env_bootstrap_journal_value revision)" == "$EXPECTED_REVISION" &&
		"$(identity_env_bootstrap_journal_value source_sha256)" == "$source_sha" &&
		"$(identity_env_sha256 "$ENV_FILE")" == "$result_sha" ]] || return 1
	[[ ! -e "$identity_env_bootstrap_candidate" &&
		! -L "$identity_env_bootstrap_candidate" &&
		! -e "$identity_env_bootstrap_candidate_temporary" &&
		! -L "$identity_env_bootstrap_candidate_temporary" &&
		! -e "$identity_env_bootstrap_rollback_temporary" &&
		! -L "$identity_env_bootstrap_rollback_temporary" ]] || return 1
	if [[ -e "$identity_env_bootstrap_source" || -L "$identity_env_bootstrap_source" ]]; then
		identity_env_require_bootstrap_source || return 1
		[[ "$(identity_env_sha256 "$identity_env_bootstrap_source")" == "$source_sha" ]] || return 1
		rm -f -- "$identity_env_bootstrap_source" || return 1
	fi
	[[ ! -e "$identity_env_bootstrap_source" && ! -L "$identity_env_bootstrap_source" ]] || return 1
	rm -f -- "$identity_env_bootstrap_journal" || return 1
	[[ ! -e "$identity_env_bootstrap_journal" && ! -L "$identity_env_bootstrap_journal" ]] || return 1
}

identity_env_require_expected_sha() {
	[[ "$IDENTITY_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
		identity_env_fail 'expected local canonical backend env SHA-256 is required'
}

identity_env_assert_candidate() {
	IDENTITY_EXPECTED_REVISION="$EXPECTED_REVISION" \
	IDENTITY_EXPECTED_POSTGRES_IMAGE="$identity_env_postgres_image" \
	IDENTITY_EXPECTED_INTEGRATION_KINDS="$identity_env_integration_kinds" \
	IDENTITY_EXPECTED_ADMIN_FILE="$identity_env_admin_password_file" \
		node - "$ENV_FILE" <<'NODE' || return 1
const { createPrivateKey, createPublicKey, randomBytes, sign, verify } = require('node:crypto');
const fs = require('node:fs');
const fail = () => process.exit(1);
const content = fs.readFileSync(process.argv[2], 'utf8');
const values = new Map();
for (const line of content.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!match) continue;
  if (values.has(match[1])) fail();
  values.set(match[1], match[2].replace(/\r$/, '').trim());
}
const requiredExact = new Map([
  ['IDENTITY_REVISION', process.env.IDENTITY_EXPECTED_REVISION],
  ['IDENTITY_IMAGE', `winwidget-identity:git-${process.env.IDENTITY_EXPECTED_REVISION}`],
  ['IDENTITY_POSTGRES_IMAGE', process.env.IDENTITY_EXPECTED_POSTGRES_IMAGE],
  ['IDENTITY_POSTGRES_PORT', '55438'],
  ['IDENTITY_POSTGRES_DATA_VOLUME', 'winwidget-identity-postgres-data'],
  ['IDENTITY_POSTGRES_ADMIN_USER', 'winwidget_identity_admin'],
  ['IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE', process.env.IDENTITY_EXPECTED_ADMIN_FILE],
  ['IDENTITY_RESTORE_DRILL_EVIDENCE_FILE', '/opt/winwidget/deploy/backend/.identity-restore-drill-evidence-v1.json'],
  ['IDENTITY_PROCESS_ROLE', 'api'],
  ['IDENTITY_LISTEN_HOST', '127.0.0.1'],
  ['IDENTITY_API_PORT', '4900'],
  ['IDENTITY_WORKER_PORT', '4901'],
  ['IDENTITY_OUTBOX_PUBLISHER_PORT', '4902'],
  ['IDENTITY_INTERNAL_BASE_URL', 'http://127.0.0.1:4900'],
  ['IDENTITY_INTERNAL_TIMEOUT_MS', '5000'],
  ['IDENTITY_PREFETCH', '10'],
  ['IDENTITY_OUTBOX_BATCH_SIZE', '50'],
  ['IDENTITY_OUTBOX_POLL_INTERVAL_MS', '1000'],
  ['IDENTITY_OUTBOX_RETENTION_DAYS', '7'],
  ['IDENTITY_RECEIPT_RETENTION_DAYS', '90'],
  ['IDENTITY_FAILURE_DETAIL_RETENTION_DAYS', '30'],
  ['IDENTITY_CORE_CLEANUP_SOAK_SECONDS', '900'],
  ['INTEGRATION_WORKER_KINDS', process.env.IDENTITY_EXPECTED_INTEGRATION_KINDS],
  ['JWT_JWKS_URL', 'http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json'],
]);
for (const [key, expected] of requiredExact) if (values.get(key) !== expected) fail();
const urls = [
  ['IDENTITY_DATABASE_URL', 'winwidget_identity_runtime'],
  ['IDENTITY_MIGRATION_DATABASE_URL', 'winwidget_identity_migration'],
  ['IDENTITY_BACKUP_URL', 'winwidget_identity_backup'],
];
for (const [key, role] of urls) {
  let url;
  try { url = new URL(values.get(key)); } catch { fail(); }
  if (url.protocol !== 'postgresql:' || decodeURIComponent(url.username) !== role ||
      decodeURIComponent(url.password).length < 32 || url.hostname !== '127.0.0.1' ||
      url.port !== '55438' || url.pathname !== '/winwidget_identity' ||
      url.searchParams.get('schema') !== 'identity' ||
      url.searchParams.get('sslmode') !== 'disable' || [...url.searchParams.keys()].length !== 2) fail();
}
for (const [key, user] of [
  ['RABBITMQ_IDENTITY_WORKER_URL', 'winwidget-identity-worker'],
  ['RABBITMQ_IDENTITY_PUBLISHER_URL', 'winwidget-identity-publisher'],
]) {
  let url;
  try { url = new URL(values.get(key)); } catch { fail(); }
  if (url.protocol !== 'amqp:' || decodeURIComponent(url.username) !== user ||
      decodeURIComponent(url.password).length < 32 || url.hostname !== '127.0.0.1' ||
      (url.port && url.port !== '5672') || decodeURIComponent(url.pathname) !== '/winwidget') fail();
}
const scopedKeys = [
  'IDENTITY_CORE_TOKEN', 'CORE_IDENTITY_TOKEN', 'IDENTITY_CAMPAIGNS_TOKEN',
  'IDENTITY_REPORTING_TOKEN', 'IDENTITY_WIDGETS_TOKEN', 'IDENTITY_BILLING_TOKEN',
  'BILLING_CAMPAIGNS_TOKEN', 'BILLING_IDENTITY_TOKEN', 'WIDGETS_IDENTITY_TOKEN',
];
const scoped = scopedKeys.map(key => values.get(key));
if (scoped.some(value => !value || value.length < 32 || /^(change_me|ci_)/.test(value)) ||
    new Set(scoped).size !== scoped.length) fail();
for (const broadKey of ['NOTIFICATION_DELIVERY_INTERNAL_TOKEN', 'CAMPAIGNS_INTERNAL_TOKEN',
  'REPORTING_INTERNAL_TOKEN', 'WIDGETS_INTERNAL_TOKEN', 'BILLING_INTERNAL_TOKEN']) {
  if (scoped.includes(values.get(broadKey))) fail();
}
const privateValue = values.get('IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64');
const jwksValue = values.get('IDENTITY_JWT_ACCESS_JWKS_BASE64');
const kid = values.get('IDENTITY_JWT_ACCESS_ACTIVE_KID');
if (!privateValue || !jwksValue || !kid ||
    privateValue === values.get('JWT_ACCESS_PRIVATE_KEY_BASE64') ||
    jwksValue === values.get('JWT_ACCESS_JWKS_BASE64') ||
    kid === values.get('JWT_ACCESS_ACTIVE_KID')) fail();
let privateKey;
let jwks;
try {
  privateKey = createPrivateKey(Buffer.from(privateValue, 'base64'));
  jwks = JSON.parse(Buffer.from(jwksValue, 'base64').toString('utf8'));
} catch { fail(); }
if (privateKey.asymmetricKeyType !== 'rsa' ||
    (privateKey.asymmetricKeyDetails?.modulusLength || 0) < 3072 ||
    !Array.isArray(jwks?.keys) || jwks.keys.length !== 1) fail();
const active = jwks.keys[0];
if (active?.kid !== kid || active.kty !== 'RSA' || active.alg !== 'RS256' ||
    active.use !== 'sig' || active.key_ops?.join(',') !== 'verify' ||
    ['d','p','q','dp','dq','qi','oth'].some(key => key in active)) fail();
let publicKey;
try { publicKey = createPublicKey({ key: active, format: 'jwk' }); } catch { fail(); }
const challenge = randomBytes(32);
if (!verify('sha256', challenge, publicKey, sign('sha256', challenge, privateKey))) fail();
let routes;
try { routes = JSON.parse(values.get('GATEWAY_ROUTES_JSON')); } catch { fail(); }
const requiredRoutes = [
  ['identity-auth', '/api/v1/auth'],
  ['identity-users', '/api/v1/users'],
  ['identity-telegram-auth', '/api/v1/telegram-auth'],
  ['identity-info-webhook', '/api/v1/telegram-bot/webhook'],
];
if (!Array.isArray(routes) || !requiredRoutes.every(([id, pathPrefix]) =>
    routes.filter(route => route?.id === id && route.pathPrefix === pathPrefix &&
      route.upstreamUrl === 'http://127.0.0.1:4900' && route.authPolicy === 'optional' &&
      route.timeoutMs === 60000).length === 1) ||
    routes.filter(route => route?.upstreamUrl === 'http://127.0.0.1:4900').length !== 4 ||
    routes.some(route => route?.pathPrefix === '/api/v1/telegram-bot/support-webhook' &&
      route.upstreamUrl === 'http://127.0.0.1:4900') ||
    !routes.some(route => route?.id === 'monolith' && route.pathPrefix === '/api/v1' &&
      route.upstreamUrl === 'http://127.0.0.1:4200')) fail();
NODE
	[[ -f "$identity_env_admin_password_file" && ! -L "$identity_env_admin_password_file" &&
		"$(stat -c '%u:%g:%a' "$identity_env_admin_password_file")" == '0:0:600' &&
		"$(tr -d '\r\n' <"$identity_env_admin_password_file" | wc -c | tr -d '[:space:]')" -ge 32 ]] ||
		identity_env_fail 'Identity PostgreSQL admin password file is unsafe'
}

identity_env_bootstrap() {
	identity_env_require_root || return 1
	identity_env_require_revision || return 1
	identity_env_require_expected_sha || return 1
	identity_env_require_file || return 1
	local current_sha marker_source marker_result result_sha
	current_sha="$(identity_env_sha256 "$ENV_FILE")" || return 1
	if [[ -e "$identity_env_marker" || -L "$identity_env_marker" ]]; then
		identity_env_validate_marker || return 1
		[[ "$(identity_env_marker_value revision)" == "$EXPECTED_REVISION" ]] ||
			identity_env_fail 'Identity production env marker belongs to another revision' || return 1
		marker_source="$(identity_env_marker_value source_sha256)" || return 1
		marker_result="$(identity_env_marker_value result_sha256)" || return 1
		[[ "$current_sha" == "$marker_result" &&
			( "$IDENTITY_ENV_EXPECTED_SHA256" == "$marker_source" ||
				"$IDENTITY_ENV_EXPECTED_SHA256" == "$marker_result" ) ]] ||
			identity_env_fail 'server env drifted from the idempotent Identity bootstrap marker' || return 1
		identity_env_assert_candidate || return 1
		identity_env_finalize_bootstrap_journal "$marker_source" "$marker_result" || return 1
		printf 'identity_production_env_phase=candidate\n'
		printf 'identity_production_env_sha256=%s\n' "$current_sha"
		return
	fi
	identity_env_bootstrap_lifecycle_absent || return 1
	[[ ! -e "$identity_env_bootstrap_rollback_temporary" &&
		! -L "$identity_env_bootstrap_rollback_temporary" ]] ||
		identity_env_fail 'incomplete Identity env rollback must be resumed before bootstrap' || return 1
	[[ "$current_sha" == "$IDENTITY_ENV_EXPECTED_SHA256" ]] ||
		identity_env_fail 'server env SHA-256 differs from the local canonical source copy' || return 1
	identity_env_protect_bootstrap_source "$current_sha" || return 1
	if [[ -e "$identity_env_admin_password_temporary" ||
		-L "$identity_env_admin_password_temporary" ]]; then
		[[ -f "$identity_env_admin_password_temporary" &&
			! -L "$identity_env_admin_password_temporary" &&
			"$(stat -c '%u:%g:%a' "$identity_env_admin_password_temporary")" == '0:0:600' ]] || return 1
		rm -f -- "$identity_env_admin_password_temporary" || return 1
	fi
	if [[ ! -e "$identity_env_admin_password_file" &&
		! -L "$identity_env_admin_password_file" ]]; then
		(
			set -o noclobber
			openssl rand -hex 32 >"$identity_env_admin_password_temporary"
		) || return 1
		chmod 600 "$identity_env_admin_password_temporary" || return 1
		chown 0:0 "$identity_env_admin_password_temporary" || return 1
		mv -- "$identity_env_admin_password_temporary" "$identity_env_admin_password_file" || return 1
	fi
	[[ -f "$identity_env_admin_password_file" &&
		! -L "$identity_env_admin_password_file" &&
		"$(stat -c '%u:%g:%a' "$identity_env_admin_password_file")" == '0:0:600' &&
		"$(tr -d '\r\n' <"$identity_env_admin_password_file" | wc -c | tr -d '[:space:]')" -ge 32 ]] ||
		identity_env_fail 'Identity PostgreSQL admin password file is unsafe' || return 1
	if [[ -e "$identity_env_bootstrap_candidate" ||
		-L "$identity_env_bootstrap_candidate" ]]; then
		[[ ! -e "$identity_env_bootstrap_candidate_temporary" &&
			! -L "$identity_env_bootstrap_candidate_temporary" ]] || return 1
		(
			ENV_FILE="$identity_env_bootstrap_candidate"
			identity_env_require_file || exit 1
			identity_env_assert_candidate || exit 1
		) || identity_env_fail 'protected Identity bootstrap candidate is invalid' || return 1
	else
		if [[ -e "$identity_env_bootstrap_candidate_temporary" ||
			-L "$identity_env_bootstrap_candidate_temporary" ]]; then
			[[ -f "$identity_env_bootstrap_candidate_temporary" &&
				! -L "$identity_env_bootstrap_candidate_temporary" &&
				"$(stat -c '%u:%g:%a' "$identity_env_bootstrap_candidate_temporary")" == '0:0:600' ]] || return 1
			rm -f -- "$identity_env_bootstrap_candidate_temporary" || return 1
		fi
	IDENTITY_EXPECTED_REVISION="$EXPECTED_REVISION" \
	IDENTITY_EXPECTED_POSTGRES_IMAGE="$identity_env_postgres_image" \
	IDENTITY_EXPECTED_INTEGRATION_KINDS="$identity_env_integration_kinds" \
	IDENTITY_EXPECTED_ADMIN_FILE="$identity_env_admin_password_file" \
		node - "$ENV_FILE" "$identity_env_bootstrap_candidate_temporary" <<'NODE' || return 1
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { chmodSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const file = process.argv[2];
const candidate = process.argv[3];
const content = readFileSync(file, 'utf8');
const values = new Map();
for (const [index, line] of content.split(/\r?\n/).entries()) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!match) continue;
  if (values.has(match[1])) throw new Error(`duplicate env key at line ${index + 1}`);
  values.set(match[1], match[2].replace(/\r$/, '').trim());
}
const additions = [
  'IDENTITY_IMAGE', 'IDENTITY_REVISION', 'IDENTITY_POSTGRES_IMAGE',
  'IDENTITY_POSTGRES_PORT', 'IDENTITY_POSTGRES_DATA_VOLUME',
  'IDENTITY_POSTGRES_ADMIN_USER', 'IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE',
  'IDENTITY_DATABASE_URL', 'IDENTITY_MIGRATION_DATABASE_URL', 'IDENTITY_BACKUP_URL',
  'IDENTITY_RESTORE_DRILL_EVIDENCE_FILE', 'IDENTITY_PROCESS_ROLE',
  'IDENTITY_LISTEN_HOST', 'IDENTITY_API_PORT', 'IDENTITY_WORKER_PORT',
  'IDENTITY_OUTBOX_PUBLISHER_PORT', 'IDENTITY_INTERNAL_BASE_URL',
  'IDENTITY_INTERNAL_TIMEOUT_MS', 'IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64',
  'IDENTITY_JWT_ACCESS_JWKS_BASE64', 'IDENTITY_JWT_ACCESS_ACTIVE_KID',
  'IDENTITY_CORE_TOKEN', 'CORE_IDENTITY_TOKEN', 'IDENTITY_CAMPAIGNS_TOKEN',
  'IDENTITY_REPORTING_TOKEN', 'IDENTITY_WIDGETS_TOKEN', 'IDENTITY_BILLING_TOKEN',
  'BILLING_CAMPAIGNS_TOKEN', 'BILLING_IDENTITY_TOKEN', 'WIDGETS_IDENTITY_TOKEN',
  'IDENTITY_PREFETCH', 'IDENTITY_OUTBOX_BATCH_SIZE',
  'IDENTITY_OUTBOX_POLL_INTERVAL_MS', 'IDENTITY_OUTBOX_RETENTION_DAYS',
  'IDENTITY_RECEIPT_RETENTION_DAYS', 'IDENTITY_FAILURE_DETAIL_RETENTION_DAYS',
  'IDENTITY_CORE_CLEANUP_SOAK_SECONDS', 'RABBITMQ_IDENTITY_WORKER_URL',
  'RABBITMQ_IDENTITY_PUBLISHER_URL',
];
if (additions.some(key => values.has(key))) {
  throw new Error('legacy production env already contains a bootstrap-managed Identity key');
}
if (values.get('JWT_JWKS_URL') !== 'http://127.0.0.1:4200/api/v1/auth/.well-known/jwks.json') {
  throw new Error('legacy JWKS URL is not Core');
}
let routes;
try { routes = JSON.parse(values.get('GATEWAY_ROUTES_JSON')); } catch { throw new Error('legacy Gateway routes are invalid'); }
const identityPaths = new Set(['/api/v1/auth', '/api/v1/users', '/api/v1/telegram-auth', '/api/v1/telegram-bot/webhook']);
if (!Array.isArray(routes) || routes.some(route => identityPaths.has(route?.pathPrefix) ||
    route?.upstreamUrl === 'http://127.0.0.1:4900') ||
    !routes.some(route => route?.id === 'monolith' && route.pathPrefix === '/api/v1' &&
      route.upstreamUrl === 'http://127.0.0.1:4200')) {
  throw new Error('Gateway is not in the exact legacy Identity state');
}
const requiredRoutes = [
  { id: 'identity-auth', pathPrefix: '/api/v1/auth', upstreamUrl: 'http://127.0.0.1:4900', authPolicy: 'optional', timeoutMs: 60000 },
  { id: 'identity-users', pathPrefix: '/api/v1/users', upstreamUrl: 'http://127.0.0.1:4900', authPolicy: 'optional', timeoutMs: 60000 },
  { id: 'identity-telegram-auth', pathPrefix: '/api/v1/telegram-auth', upstreamUrl: 'http://127.0.0.1:4900', authPolicy: 'optional', timeoutMs: 60000 },
  { id: 'identity-info-webhook', pathPrefix: '/api/v1/telegram-bot/webhook', upstreamUrl: 'http://127.0.0.1:4900', authPolicy: 'optional', timeoutMs: 60000 },
];
const secret = () => randomBytes(32).toString('hex');
const runtimePassword = secret();
const migrationPassword = secret();
const backupPassword = secret();
const workerPassword = secret();
const publisherPassword = secret();
const revision = process.env.IDENTITY_EXPECTED_REVISION;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
const kid = `identity-${revision.slice(0, 12)}-${randomBytes(8).toString('hex')}`;
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256', key_ops: ['verify'] };
const updates = new Map([
  ['IDENTITY_IMAGE', `winwidget-identity:git-${revision}`],
  ['IDENTITY_REVISION', revision],
  ['IDENTITY_POSTGRES_IMAGE', process.env.IDENTITY_EXPECTED_POSTGRES_IMAGE],
  ['IDENTITY_POSTGRES_PORT', '55438'],
  ['IDENTITY_POSTGRES_DATA_VOLUME', 'winwidget-identity-postgres-data'],
  ['IDENTITY_POSTGRES_ADMIN_USER', 'winwidget_identity_admin'],
  ['IDENTITY_POSTGRES_ADMIN_PASSWORD_FILE', process.env.IDENTITY_EXPECTED_ADMIN_FILE],
  ['IDENTITY_DATABASE_URL', `postgresql://winwidget_identity_runtime:${runtimePassword}@127.0.0.1:55438/winwidget_identity?schema=identity&sslmode=disable`],
  ['IDENTITY_MIGRATION_DATABASE_URL', `postgresql://winwidget_identity_migration:${migrationPassword}@127.0.0.1:55438/winwidget_identity?schema=identity&sslmode=disable`],
  ['IDENTITY_BACKUP_URL', `postgresql://winwidget_identity_backup:${backupPassword}@127.0.0.1:55438/winwidget_identity?schema=identity&sslmode=disable`],
  ['IDENTITY_RESTORE_DRILL_EVIDENCE_FILE', '/opt/winwidget/deploy/backend/.identity-restore-drill-evidence-v1.json'],
  ['IDENTITY_PROCESS_ROLE', 'api'], ['IDENTITY_LISTEN_HOST', '127.0.0.1'],
  ['IDENTITY_API_PORT', '4900'], ['IDENTITY_WORKER_PORT', '4901'],
  ['IDENTITY_OUTBOX_PUBLISHER_PORT', '4902'],
  ['IDENTITY_INTERNAL_BASE_URL', 'http://127.0.0.1:4900'],
  ['IDENTITY_INTERNAL_TIMEOUT_MS', '5000'],
  ['IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64', Buffer.from(privatePem).toString('base64')],
  ['IDENTITY_JWT_ACCESS_JWKS_BASE64', Buffer.from(JSON.stringify({ keys: [publicJwk] })).toString('base64')],
  ['IDENTITY_JWT_ACCESS_ACTIVE_KID', kid],
  ['IDENTITY_CORE_TOKEN', secret()], ['CORE_IDENTITY_TOKEN', secret()],
  ['IDENTITY_CAMPAIGNS_TOKEN', secret()], ['IDENTITY_REPORTING_TOKEN', secret()],
  ['IDENTITY_WIDGETS_TOKEN', secret()], ['IDENTITY_BILLING_TOKEN', secret()],
  ['BILLING_CAMPAIGNS_TOKEN', secret()], ['BILLING_IDENTITY_TOKEN', secret()],
  ['WIDGETS_IDENTITY_TOKEN', secret()], ['IDENTITY_PREFETCH', '10'],
  ['IDENTITY_OUTBOX_BATCH_SIZE', '50'], ['IDENTITY_OUTBOX_POLL_INTERVAL_MS', '1000'],
  ['IDENTITY_OUTBOX_RETENTION_DAYS', '7'], ['IDENTITY_RECEIPT_RETENTION_DAYS', '90'],
  ['IDENTITY_FAILURE_DETAIL_RETENTION_DAYS', '30'], ['IDENTITY_CORE_CLEANUP_SOAK_SECONDS', '900'],
  ['RABBITMQ_IDENTITY_WORKER_URL', `amqp://winwidget-identity-worker:${workerPassword}@127.0.0.1:5672/winwidget`],
  ['RABBITMQ_IDENTITY_PUBLISHER_URL', `amqp://winwidget-identity-publisher:${publisherPassword}@127.0.0.1:5672/winwidget`],
  ['INTEGRATION_WORKER_KINDS', process.env.IDENTITY_EXPECTED_INTEGRATION_KINDS],
  ['GATEWAY_ROUTES_JSON', JSON.stringify([...requiredRoutes, ...routes])],
  ['JWT_JWKS_URL', 'http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json'],
]);
const managed = new Set(updates.keys());
const lines = content.split(/\r?\n/);
let insertion = lines.findIndex(line => {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match && managed.has(match[1]);
});
if (insertion < 0) insertion = lines.length;
const retained = [];
let retainedBefore = 0;
for (let index = 0; index < lines.length; index += 1) {
  const match = lines[index].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (match && managed.has(match[1])) continue;
  if (index < insertion) retainedBefore += 1;
  retained.push(lines[index]);
}
retained.splice(retainedBefore, 0,
  '# Identity clean-cutover candidate (generated once on the production VPS)',
  ...[...updates].map(([key, value]) => `${key}=${value}`));
const output = `${retained.join('\n').replace(/\n+$/, '')}\n`;
try {
  writeFileSync(candidate, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(candidate, 0o600);
} catch (error) {
  try { unlinkSync(candidate); } catch {}
  throw error;
}
NODE
		chmod 600 "$identity_env_bootstrap_candidate_temporary" || return 1
		chown 0:0 "$identity_env_bootstrap_candidate_temporary" || return 1
		(
			ENV_FILE="$identity_env_bootstrap_candidate_temporary"
			identity_env_require_file || exit 1
			identity_env_assert_candidate || exit 1
		) || return 1
		mv -- "$identity_env_bootstrap_candidate_temporary" \
			"$identity_env_bootstrap_candidate" || return 1
	fi
	(
		ENV_FILE="$identity_env_bootstrap_candidate"
		identity_env_require_file || exit 1
		identity_env_assert_candidate || exit 1
	) || return 1
	result_sha="$(identity_env_sha256 "$identity_env_bootstrap_candidate")" || return 1
	[[ "$result_sha" != "$current_sha" ]] ||
		identity_env_fail 'Identity production env bootstrap made no change' || return 1
	mv -- "$identity_env_bootstrap_candidate" "$ENV_FILE" || return 1
	identity_env_require_file || return 1
	identity_env_assert_candidate || return 1
	[[ "$(identity_env_sha256 "$ENV_FILE")" == "$result_sha" ]] || return 1
	identity_env_write_marker "$current_sha" "$result_sha" || return 1
	identity_env_finalize_bootstrap_journal "$current_sha" "$result_sha" || return 1
	printf 'identity_production_env_phase=candidate\n'
	printf 'identity_production_env_sha256=%s\n' "$result_sha"
}

identity_env_verify() {
	identity_env_require_root || return 1
	identity_env_require_revision || return 1
	identity_env_require_expected_sha || return 1
	identity_env_require_file || return 1
	identity_env_validate_marker || return 1
	[[ "$(identity_env_marker_value revision)" == "$EXPECTED_REVISION" &&
		"$(identity_env_marker_value result_sha256)" == "$IDENTITY_ENV_EXPECTED_SHA256" &&
		"$(identity_env_sha256 "$ENV_FILE")" == "$IDENTITY_ENV_EXPECTED_SHA256" ]] ||
		identity_env_fail 'server env is not byte-identical to the expected local canonical Identity candidate' || return 1
	identity_env_assert_candidate || return 1
	printf 'identity_production_env_phase=candidate\n'
	printf 'identity_production_env_sha256=%s\n' "$IDENTITY_ENV_EXPECTED_SHA256"
}

identity_env_rollback_incomplete_bootstrap() {
	identity_env_require_root || return 1
	identity_env_require_revision || return 1
	identity_env_require_expected_sha || return 1
	identity_env_require_file || return 1
	identity_env_bootstrap_lifecycle_absent || return 1
	[[ "${IDENTITY_ENV_ROLLBACK_CONFIRMATION:-}" == 'ROLLBACK INCOMPLETE IDENTITY ENV BOOTSTRAP' ]] ||
		identity_env_fail 'exact incomplete Identity env rollback confirmation is required' || return 1
	[[ ! -e "$identity_env_marker" && ! -L "$identity_env_marker" ]] ||
		identity_env_fail 'committed Identity candidate env cannot be rolled back' || return 1
	if [[ -e "$identity_env_marker_temporary" || -L "$identity_env_marker_temporary" ]]; then
		[[ -f "$identity_env_marker_temporary" && ! -L "$identity_env_marker_temporary" &&
			"$(stat -c '%u:%g:%a' "$identity_env_marker_temporary")" == '0:0:600' ]] || return 1
	fi
	identity_env_validate_bootstrap_journal || return 1
	local source_sha current_sha rollback_temporary
	source_sha="$(identity_env_bootstrap_journal_value source_sha256)" || return 1
	current_sha="$(identity_env_sha256 "$ENV_FILE")" || return 1
	[[ "$(identity_env_bootstrap_journal_value revision)" == "$EXPECTED_REVISION" &&
		"$source_sha" == "$IDENTITY_ENV_EXPECTED_SHA256" ]] ||
		identity_env_fail 'incomplete Identity env rollback journal binding differs' || return 1
	if [[ ! -e "$identity_env_bootstrap_source" &&
		! -L "$identity_env_bootstrap_source" ]]; then
		[[ "$current_sha" == "$source_sha" &&
			! -e "$identity_env_admin_password_file" &&
			! -L "$identity_env_admin_password_file" &&
			! -e "$identity_env_admin_password_temporary" &&
			! -L "$identity_env_admin_password_temporary" &&
			! -e "$identity_env_bootstrap_candidate" &&
			! -L "$identity_env_bootstrap_candidate" &&
			! -e "$identity_env_bootstrap_candidate_temporary" &&
			! -L "$identity_env_bootstrap_candidate_temporary" &&
			! -e "$identity_env_bootstrap_rollback_temporary" &&
			! -L "$identity_env_bootstrap_rollback_temporary" &&
			! -e "$identity_env_marker_temporary" &&
			! -L "$identity_env_marker_temporary" ]] || return 1
		rm -f -- "$identity_env_bootstrap_journal" || return 1
		printf 'identity_production_env_phase=rolled-back\n'
		return
	fi
	identity_env_require_bootstrap_source || return 1
	[[ "$(identity_env_sha256 "$identity_env_bootstrap_source")" == "$source_sha" ]] || return 1
	if [[ "$current_sha" != "$source_sha" ]]; then
		identity_env_assert_candidate ||
			identity_env_fail 'incomplete Identity env rollback rejected unknown env drift' || return 1
	fi
	if [[ -e "$identity_env_admin_password_file" ||
		-L "$identity_env_admin_password_file" ]]; then
		[[ -f "$identity_env_admin_password_file" &&
			! -L "$identity_env_admin_password_file" &&
			"$(stat -c '%u:%g:%a' "$identity_env_admin_password_file")" == '0:0:600' &&
			"$(tr -d '\r\n' <"$identity_env_admin_password_file" | wc -c | tr -d '[:space:]')" -ge 32 ]] || return 1
	fi
	if [[ -e "$identity_env_admin_password_temporary" ||
		-L "$identity_env_admin_password_temporary" ]]; then
		[[ -f "$identity_env_admin_password_temporary" &&
			! -L "$identity_env_admin_password_temporary" &&
			"$(stat -c '%u:%g:%a' "$identity_env_admin_password_temporary")" == '0:0:600' ]] || return 1
	fi
	if [[ -e "$identity_env_bootstrap_candidate" ||
		-L "$identity_env_bootstrap_candidate" ]]; then
		(
			ENV_FILE="$identity_env_bootstrap_candidate"
			identity_env_require_file || exit 1
			identity_env_assert_candidate || exit 1
		) || return 1
	fi
	if [[ -e "$identity_env_bootstrap_candidate_temporary" ||
		-L "$identity_env_bootstrap_candidate_temporary" ]]; then
		[[ -f "$identity_env_bootstrap_candidate_temporary" &&
			! -L "$identity_env_bootstrap_candidate_temporary" &&
			"$(stat -c '%u:%g:%a' "$identity_env_bootstrap_candidate_temporary")" == '0:0:600' ]] || return 1
	fi
	rollback_temporary="$identity_env_bootstrap_rollback_temporary"
	if [[ -e "$rollback_temporary" || -L "$rollback_temporary" ]]; then
		[[ -f "$rollback_temporary" && ! -L "$rollback_temporary" &&
			"$(stat -c '%u:%g:%a' "$rollback_temporary")" == '0:0:600' ]] || return 1
	else
		install -o 0 -g 0 -m 600 "$identity_env_bootstrap_source" "$rollback_temporary" || return 1
	fi
	[[ "$(identity_env_sha256 "$rollback_temporary")" == "$source_sha" ]] || return 1
	mv -- "$rollback_temporary" "$ENV_FILE" || return 1
	identity_env_require_file || return 1
	[[ "$(identity_env_sha256 "$ENV_FILE")" == "$source_sha" ]] || return 1
	rm -f -- "$identity_env_bootstrap_candidate" \
		"$identity_env_bootstrap_candidate_temporary" \
		"$identity_env_admin_password_temporary" "$identity_env_admin_password_file" \
		"$identity_env_marker_temporary" || return 1
	[[ ! -e "$identity_env_bootstrap_candidate" &&
		! -L "$identity_env_bootstrap_candidate" &&
		! -e "$identity_env_bootstrap_candidate_temporary" &&
		! -L "$identity_env_bootstrap_candidate_temporary" &&
		! -e "$identity_env_admin_password_temporary" &&
		! -L "$identity_env_admin_password_temporary" &&
		! -e "$identity_env_admin_password_file" &&
		! -L "$identity_env_admin_password_file" &&
		! -e "$identity_env_marker_temporary" &&
		! -L "$identity_env_marker_temporary" ]] || return 1
	rm -f -- "$identity_env_bootstrap_source" || return 1
	[[ ! -e "$identity_env_bootstrap_source" && ! -L "$identity_env_bootstrap_source" ]] || return 1
	rm -f -- "$identity_env_bootstrap_journal" || return 1
	[[ ! -e "$identity_env_bootstrap_journal" && ! -L "$identity_env_bootstrap_journal" ]] || return 1
	printf 'identity_production_env_phase=rolled-back\n'
}

identity_env_export_encrypted() {
	identity_env_require_root || return 1
	identity_env_require_revision || return 1
	identity_env_require_file || return 1
	local certificate="${IDENTITY_ENV_EXPORT_CERTIFICATE_FILE:-}"
	local output="${IDENTITY_ENV_EXPORT_FILE:-}" partial checksum checksum_partial digest
	local certificate_name export_id
	certificate_name="$(basename -- "$certificate")" || return 1
	[[ -f "$certificate" && ! -L "$certificate" &&
		"$(stat -c '%u:%g:%a' "$certificate")" == '0:0:600' &&
		"$(dirname -- "$certificate")" == "$APP_ROOT/deploy/backend" &&
		"$certificate_name" =~ ^\.identity-env-export-certificate-([0-9]{1,20}-[0-9]{1,10})\.pem$ ]] ||
		identity_env_fail 'safe Identity env export certificate is required' || return 1
	export_id="${BASH_REMATCH[1]}"
	openssl x509 -in "$certificate" -noout -checkend 86400 >/dev/null 2>&1 ||
		identity_env_fail 'Identity env export certificate is invalid or expires too soon' || return 1
	checksum="${output}.env-sha256"
	[[ "$(dirname -- "$output")" == "$APP_ROOT/deploy/backend" &&
		"$(basename -- "$output")" == ".identity-production-env-${export_id}.p7m" &&
		! -e "$output" && ! -L "$output" &&
		! -e "$checksum" && ! -L "$checksum" ]] ||
		identity_env_fail 'safe fresh encrypted Identity env export path is required' || return 1
	partial="${output}.partial"
	checksum_partial="${checksum}.partial"
	[[ ! -e "$partial" && ! -L "$partial" &&
		! -e "$checksum_partial" && ! -L "$checksum_partial" ]] || return 1
	trap 'rm -f -- "${partial:-}" "${checksum_partial:-}"; trap - RETURN' RETURN
	openssl cms -encrypt -binary -aes-256-cbc -outform DER \
		-in "$ENV_FILE" -out "$partial" "$certificate" || return 1
	[[ -s "$partial" && ! -L "$partial" ]] || return 1
	chmod 600 "$partial" || return 1
	chown 0:0 "$partial" || return 1
	digest="$(identity_env_sha256 "$ENV_FILE")" || return 1
	(
		set -o noclobber
		printf '%s\n' "$digest" >"$checksum_partial"
	) || return 1
	chmod 600 "$checksum_partial" || return 1
	chown 0:0 "$checksum_partial" || return 1
	mv -- "$partial" "$output" || return 1
	if ! mv -- "$checksum_partial" "$checksum"; then
		rm -f -- "$output"
		return 1
	fi
	trap - RETURN
	[[ -f "$output" && ! -L "$output" &&
		"$(stat -c '%u:%g:%a' "$output")" == '0:0:600' &&
		-f "$checksum" && ! -L "$checksum" &&
		"$(stat -c '%u:%g:%a' "$checksum")" == '0:0:600' &&
		"$(tr -d '\r\n' <"$checksum")" == "$digest" ]] || return 1
	printf 'identity_production_env_export=encrypted\n'
}

identity_env_export_candidate_encrypted() {
	identity_env_require_root || return 1
	identity_env_require_revision || return 1
	identity_env_require_file || return 1
	identity_env_validate_marker || return 1
	[[ "$(identity_env_marker_value revision)" == "$EXPECTED_REVISION" &&
		"$(identity_env_sha256 "$ENV_FILE")" == "$(identity_env_marker_value result_sha256)" ]] ||
		identity_env_fail 'Identity candidate env export is not bound to its marker' || return 1
	[[ ! -e "$identity_env_bootstrap_rollback_temporary" &&
		! -L "$identity_env_bootstrap_rollback_temporary" ]] || return 1
	identity_env_assert_candidate || return 1
	identity_env_export_encrypted || return 1
}

identity_env_self_test() {
	local source
	source="$(declare -f identity_env_bootstrap identity_env_verify \
		identity_env_validate_bootstrap_journal identity_env_write_bootstrap_journal \
		identity_env_protect_bootstrap_source identity_env_finalize_bootstrap_journal \
		identity_env_rollback_incomplete_bootstrap \
		identity_env_export_encrypted identity_env_export_candidate_encrypted \
		identity_env_assert_candidate)"
	[[ "$source" == *'server env SHA-256 differs from the local canonical source copy'* &&
		"$source" == *'legacy production env already contains a bootstrap-managed Identity key'* &&
		"$source" == *'IDENTITY_CORE_TOKEN'* && "$source" == *'CORE_IDENTITY_TOKEN'* &&
		"$source" == *'BILLING_CAMPAIGNS_TOKEN'* && "$source" == *'BILLING_IDENTITY_TOKEN'* &&
		"$source" == *'WIDGETS_IDENTITY_TOKEN'* &&
		"$source" == *'/api/v1/telegram-bot/webhook'* &&
		"$source" == *'openssl cms -encrypt -binary -aes-256-cbc'* &&
		"$source" == *'source-protected'* &&
		"$source" == *'ROLLBACK INCOMPLETE IDENTITY ENV BOOTSTRAP'* &&
		"$source" == *'committed Identity candidate env cannot be rolled back'* &&
		"$source" == *'Identity candidate env export is not bound to its marker'* &&
		"$source" == *'set -o noclobber'* &&
		"$source" == *'identity-production-env-'* ]] || return 1
	printf 'identity_production_env_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--bootstrap) identity_env_bootstrap ;;
	--verify) identity_env_verify ;;
	--rollback-incomplete-bootstrap) identity_env_rollback_incomplete_bootstrap ;;
	--export-encrypted) identity_env_export_encrypted ;;
	--export-candidate-encrypted) identity_env_export_candidate_encrypted ;;
	--self-test) identity_env_self_test ;;
	*) identity_env_fail 'Usage: identity-production-env-control.sh --bootstrap|--verify|--rollback-incomplete-bootstrap|--export-encrypted|--export-candidate-encrypted|--self-test' ;;
	esac
fi
