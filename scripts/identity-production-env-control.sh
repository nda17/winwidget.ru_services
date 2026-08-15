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
identity_env_admin_password_file="$APP_ROOT/deploy/backend/.identity-postgres-admin-password"

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
		identity_env_fail 'backend production env must be a root-owned mode-600 regular file'
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
  ' "$ENV_FILE" | LC_ALL=C sort)"
	[[ -z "$duplicates" ]] ||
		identity_env_fail 'backend production env contains duplicate keys'
}

identity_env_validate_marker() {
	[[ -f "$identity_env_marker" && ! -L "$identity_env_marker" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_env_marker")" == '0:0:600' ]] || return 1
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
  ' "$identity_env_marker"
}

identity_env_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z_]+$ ]] || return 1
	identity_env_validate_marker || return 1
	awk -F= -v key="$1" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$identity_env_marker"
}

identity_env_write_marker() {
	[[ $# -eq 2 ]] || return 1
	local temporary="${identity_env_marker}.tmp.$$"
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	{
		printf 'version=1\nphase=candidate\nrevision=%s\n' "$EXPECTED_REVISION"
		printf 'source_sha256=%s\nresult_sha256=%s\n' "$1" "$2"
		printf 'updated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$identity_env_marker"
	identity_env_validate_marker
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
		node - "$ENV_FILE" <<'NODE'
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
  ['IDENTITY_AVATAR_S3_KEY_PREFIX', 'identity/avatars'],
  ['IDENTITY_AVATAR_CLEANUP_RETENTION_DAYS', '7'],
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
const avatarStorageKeys = [
  'IDENTITY_AVATAR_S3_ENDPOINT', 'IDENTITY_AVATAR_S3_REGION',
  'IDENTITY_AVATAR_S3_BUCKET', 'IDENTITY_AVATAR_S3_PUBLIC_BASE_URL',
  'IDENTITY_AVATAR_S3_KEY_PREFIX', 'IDENTITY_AVATAR_S3_FORCE_PATH_STYLE',
  'IDENTITY_AVATAR_S3_API_ACCESS_KEY_ID',
  'IDENTITY_AVATAR_S3_API_SECRET_ACCESS_KEY',
  'IDENTITY_AVATAR_S3_WORKER_ACCESS_KEY_ID',
  'IDENTITY_AVATAR_S3_WORKER_SECRET_ACCESS_KEY',
];
if (avatarStorageKeys.some(key => !values.has(key))) fail();
for (const forbidden of [
  'IDENTITY_AVATAR_S3_LEGACY_KEY_PREFIX',
  'IDENTITY_AVATAR_MIGRATION_S3_ACCESS_KEY_ID',
  'IDENTITY_AVATAR_MIGRATION_S3_SECRET_ACCESS_KEY',
  'IDENTITY_AVATAR_MIGRATION_LEGACY_KEY_PREFIX',
  'IDENTITY_AVATAR_MIGRATION_LEGACY_PUBLIC_BASE_URL',
  'IDENTITY_AVATAR_MIGRATION_UPLOADS_PUBLIC_BASE_URL',
  'IDENTITY_AVATAR_MIGRATION_UPLOADS_ROOT',
  'IDENTITY_AVATAR_RETIREMENT_S3_ACCESS_KEY_ID',
  'IDENTITY_AVATAR_RETIREMENT_S3_SECRET_ACCESS_KEY',
  'IDENTITY_AVATAR_RETIREMENT_LEGACY_KEY_PREFIX',
]) {
  if (values.has(forbidden)) fail();
}
let avatarEndpoint;
let avatarPublicBase;
try {
  avatarEndpoint = new URL(values.get('IDENTITY_AVATAR_S3_ENDPOINT'));
  avatarPublicBase = new URL(values.get('IDENTITY_AVATAR_S3_PUBLIC_BASE_URL'));
} catch { fail(); }
if (avatarEndpoint.protocol !== 'https:' || avatarEndpoint.username ||
    avatarEndpoint.password || avatarEndpoint.search || avatarEndpoint.hash ||
    avatarPublicBase.protocol !== 'https:' || avatarPublicBase.username ||
    avatarPublicBase.password || avatarPublicBase.search || avatarPublicBase.hash ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(values.get('IDENTITY_AVATAR_S3_REGION') || '') ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values.get('IDENTITY_AVATAR_S3_BUCKET') || '') ||
    !/^(true|false)$/.test(values.get('IDENTITY_AVATAR_S3_FORCE_PATH_STYLE') || '')) fail();
let genericEndpoint;
let genericPublicBase;
try {
  genericEndpoint = new URL(values.get('S3_ENDPOINT'));
  genericPublicBase = new URL(values.get('S3_PUBLIC_BASE_URL'));
} catch { fail(); }
const normalizedUrl = url => url.toString().replace(/\/$/, '');
if (normalizedUrl(avatarEndpoint) !== normalizedUrl(genericEndpoint) ||
    normalizedUrl(avatarPublicBase) !== normalizedUrl(genericPublicBase) ||
    values.get('IDENTITY_AVATAR_S3_REGION') !== values.get('S3_REGION') ||
    values.get('IDENTITY_AVATAR_S3_BUCKET') !== values.get('S3_BUCKET') ||
    values.get('IDENTITY_AVATAR_S3_FORCE_PATH_STYLE') !== values.get('S3_FORCE_PATH_STYLE')) fail();
const avatarPrefix = values.get('IDENTITY_AVATAR_S3_KEY_PREFIX');
const safePrefix = value => typeof value === 'string' &&
  !value.startsWith('/') && !value.endsWith('/') &&
  !value.split('/').some(part => !part || part === '.' || part === '..' ||
    !/^[A-Za-z0-9._-]+$/.test(part));
if (!safePrefix(avatarPrefix)) fail();
const avatarCredentialKeys = [
  'IDENTITY_AVATAR_S3_API_ACCESS_KEY_ID',
  'IDENTITY_AVATAR_S3_API_SECRET_ACCESS_KEY',
  'IDENTITY_AVATAR_S3_WORKER_ACCESS_KEY_ID',
  'IDENTITY_AVATAR_S3_WORKER_SECRET_ACCESS_KEY',
];
const avatarCredentials = avatarCredentialKeys.map(key => values.get(key));
if (avatarCredentials.some((value, index) => !value || /[\0\r\n]/.test(value) ||
    /^(change_me|ci_)/.test(value) ||
    (index % 2 === 1 && value.length < 32)) ||
    new Set(avatarCredentials).size !== avatarCredentials.length ||
    avatarCredentials.some(value => value === values.get('S3_ACCESS_KEY_ID') ||
      value === values.get('S3_SECRET_ACCESS_KEY'))) fail();
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
	identity_env_require_root
	identity_env_require_revision
	identity_env_require_expected_sha
	identity_env_require_file
	local current_sha marker_source marker_result temporary
	current_sha="$(identity_env_sha256 "$ENV_FILE")"
	if [[ -e "$identity_env_marker" || -L "$identity_env_marker" ]]; then
		identity_env_validate_marker || return 1
		[[ "$(identity_env_marker_value revision)" == "$EXPECTED_REVISION" ]] ||
			identity_env_fail 'Identity production env marker belongs to another revision' || return 1
		marker_source="$(identity_env_marker_value source_sha256)"
		marker_result="$(identity_env_marker_value result_sha256)"
		[[ "$current_sha" == "$marker_result" &&
			( "$IDENTITY_ENV_EXPECTED_SHA256" == "$marker_source" ||
				"$IDENTITY_ENV_EXPECTED_SHA256" == "$marker_result" ) ]] ||
			identity_env_fail 'server env drifted from the idempotent Identity bootstrap marker' || return 1
		identity_env_assert_candidate
		printf 'identity_production_env_phase=candidate\n'
		printf 'identity_production_env_sha256=%s\n' "$current_sha"
		return
	fi
	[[ "$current_sha" == "$IDENTITY_ENV_EXPECTED_SHA256" ]] ||
		identity_env_fail 'server env SHA-256 differs from the local canonical source copy' || return 1
	if [[ -e "$identity_env_admin_password_file" || -L "$identity_env_admin_password_file" ]]; then
		identity_env_fail 'untracked Identity PostgreSQL admin password file already exists' || return 1
	fi
	temporary="${identity_env_admin_password_file}.tmp.$$"
	openssl rand -hex 32 >"$temporary"
	chmod 600 "$temporary"
	chown 0:0 "$temporary"
	mv -f -- "$temporary" "$identity_env_admin_password_file"
	IDENTITY_EXPECTED_REVISION="$EXPECTED_REVISION" \
	IDENTITY_EXPECTED_POSTGRES_IMAGE="$identity_env_postgres_image" \
	IDENTITY_EXPECTED_INTEGRATION_KINDS="$identity_env_integration_kinds" \
	IDENTITY_EXPECTED_ADMIN_FILE="$identity_env_admin_password_file" \
		node - "$ENV_FILE" <<'NODE'
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { chmodSync, chownSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const file = process.argv[2];
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
const temporary = `${file}.identity-${process.pid}-${Date.now()}`;
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
	identity_env_require_file
	identity_env_assert_candidate
	local result_sha
	result_sha="$(identity_env_sha256 "$ENV_FILE")"
	[[ "$result_sha" != "$current_sha" ]] ||
		identity_env_fail 'Identity production env bootstrap made no change' || return 1
	identity_env_write_marker "$current_sha" "$result_sha"
	printf 'identity_production_env_phase=candidate\n'
	printf 'identity_production_env_sha256=%s\n' "$result_sha"
}

identity_env_verify() {
	identity_env_require_root
	identity_env_require_revision
	identity_env_require_expected_sha
	identity_env_require_file
	identity_env_validate_marker || return 1
	[[ "$(identity_env_marker_value revision)" == "$EXPECTED_REVISION" &&
		"$(identity_env_marker_value result_sha256)" == "$IDENTITY_ENV_EXPECTED_SHA256" &&
		"$(identity_env_sha256 "$ENV_FILE")" == "$IDENTITY_ENV_EXPECTED_SHA256" ]] ||
		identity_env_fail 'server env is not byte-identical to the expected local canonical Identity candidate' || return 1
	identity_env_assert_candidate
	printf 'identity_production_env_phase=candidate\n'
	printf 'identity_production_env_sha256=%s\n' "$IDENTITY_ENV_EXPECTED_SHA256"
}

identity_env_export_encrypted() {
	identity_env_require_root
	identity_env_require_revision
	identity_env_require_file
	local certificate="${IDENTITY_ENV_EXPORT_CERTIFICATE_FILE:-}"
	local output="${IDENTITY_ENV_EXPORT_FILE:-}" partial
	[[ -f "$certificate" && ! -L "$certificate" &&
		"$(dirname -- "$certificate")" == "$APP_ROOT/deploy/backend" &&
		"$(basename -- "$certificate")" =~ ^\.identity-env-export-certificate-[0-9]+-[0-9]+\.pem$ ]] ||
		identity_env_fail 'safe Identity env export certificate is required' || return 1
	openssl x509 -in "$certificate" -noout -checkend 86400 >/dev/null 2>&1 ||
		identity_env_fail 'Identity env export certificate is invalid or expires too soon' || return 1
	[[ "$(dirname -- "$output")" == "$APP_ROOT/deploy/backend" &&
		"$(basename -- "$output")" =~ ^\.identity-production-env-[0-9]+-[0-9]+\.p7m$ &&
		! -e "$output" && ! -L "$output" ]] ||
		identity_env_fail 'safe fresh encrypted Identity env export path is required' || return 1
	partial="${output}.partial.$$"
	trap 'rm -f -- "$partial"' RETURN
	openssl cms -encrypt -binary -aes-256-cbc -outform DER \
		-in "$ENV_FILE" -out "$partial" "$certificate"
	[[ -s "$partial" && ! -L "$partial" ]] || return 1
	chmod 600 "$partial"
	chown 0:0 "$partial"
	mv -- "$partial" "$output"
	trap - RETURN
	printf '%s\n' "$(identity_env_sha256 "$ENV_FILE")" >"${output}.env-sha256"
	chmod 600 "${output}.env-sha256"
	chown 0:0 "${output}.env-sha256"
	printf 'identity_production_env_export=encrypted\n'
}

identity_env_self_test() {
	local source
	source="$(declare -f identity_env_bootstrap identity_env_verify \
		identity_env_export_encrypted identity_env_assert_candidate)"
	[[ "$source" == *'server env SHA-256 differs from the local canonical source copy'* &&
		"$source" == *'legacy production env already contains a bootstrap-managed Identity key'* &&
		"$source" == *'IDENTITY_CORE_TOKEN'* && "$source" == *'CORE_IDENTITY_TOKEN'* &&
		"$source" == *'BILLING_CAMPAIGNS_TOKEN'* && "$source" == *'BILLING_IDENTITY_TOKEN'* &&
		"$source" == *'WIDGETS_IDENTITY_TOKEN'* &&
		"$source" == *'IDENTITY_AVATAR_S3_API_ACCESS_KEY_ID'* &&
		"$source" == *'IDENTITY_AVATAR_S3_WORKER_ACCESS_KEY_ID'* &&
		"$source" == *'identity/avatars'* &&
		"$source" == *'/api/v1/telegram-bot/webhook'* &&
		"$source" == *'openssl cms -encrypt -binary -aes-256-cbc'* &&
		"$source" == *'identity-production-env-'* ]] || return 1
	printf 'identity_production_env_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--bootstrap) identity_env_bootstrap ;;
	--verify) identity_env_verify ;;
	--export-encrypted) identity_env_export_encrypted ;;
	--self-test) identity_env_self_test ;;
	*) identity_env_fail 'Usage: identity-production-env-control.sh --bootstrap|--verify|--export-encrypted|--self-test' ;;
	esac
fi
