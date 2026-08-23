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
IDENTITY_ENV_EXPECTED_SHA256="${IDENTITY_ENV_EXPECTED_SHA256:-}"
identity_rotation_marker="${IDENTITY_JWT_ROTATION_MARKER:-$APP_ROOT/deploy/backend/.identity-jwt-rotation-v1}"
identity_rotation_candidate="${identity_rotation_marker}.prepared-env"
identity_rotation_old_header="${identity_rotation_marker}.old-probe-header"
identity_rotation_new_header="${identity_rotation_marker}.new-probe-header"
identity_rotation_direct_jwks="${identity_rotation_marker}.direct-jwks"
identity_rotation_public_jwks="${identity_rotation_marker}.public-jwks"
identity_rotation_old_response="${identity_rotation_marker}.old-probe-response"
identity_rotation_new_response="${identity_rotation_marker}.new-probe-response"
identity_rotation_history_root="${IDENTITY_JWT_ROTATION_HISTORY_ROOT:-$APP_ROOT/deploy/backend/identity-jwt-rotation-history-v1}"

readonly identity_rotation_confirmation='ROTATE IDENTITY JWT SIGNING KEY'

# shellcheck source=scripts/cleanup-identity-core-source-production.sh
source "$IDENTITY_SCRIPT_ROOT/scripts/cleanup-identity-core-source-production.sh"

identity_rotation_fail() {
	printf 'identity_jwt_rotation_error=%s\n' "$1" >&2
	return 1
}

identity_rotation_sha256() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	sha256sum "$1" | awk 'NR == 1 { print $1 }'
}

identity_rotation_text_sha256() {
	sha256sum | awk 'NR == 1 { print $1 }'
}

identity_rotation_validate_private_file() {
	[[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$1")" == '0:0:600' ]] || return 1
	fi
}

identity_rotation_validate_marker_file() {
	[[ $# -eq 1 ]] || return 1
	identity_rotation_validate_private_file "$1" || return 1
	awk -F= '
    $1 !~ /^(version|phase|sequence|revision|source_sha256|result_sha256|previous_kid_sha256|active_kid|jwks_sha256|started_at|updated_at)$/ { exit 1 }
    { count[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
    END {
      for (key in count) if (count[key] != 1) exit 1
      if (NR != 11 || value["version"] != "1" ||
          value["phase"] !~ /^(prepared|forward-only|complete)$/ ||
          value["sequence"] !~ /^[1-9][0-9]*$/ ||
          value["revision"] !~ /^[0-9a-f]{40}$/ ||
          value["source_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["result_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["source_sha256"] == value["result_sha256"] ||
          value["previous_kid_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["active_kid"] !~ /^[A-Za-z0-9._:-]{1,128}$/ ||
          value["jwks_sha256"] !~ /^[0-9a-f]{64}$/ ||
          value["started_at"] !~ /^[0-9TZ:.-]+$/ ||
          value["updated_at"] !~ /^[0-9TZ:.-]+$/) exit 1
    }
  ' "$1"
}

identity_rotation_validate_marker() {
	identity_rotation_validate_marker_file "$identity_rotation_marker"
}

identity_rotation_marker_value() {
	[[ $# -eq 1 && "$1" =~ ^[a-z0-9_]+$ ]] || return 1
	identity_rotation_validate_marker || return 1
	awk -F= -v key="$1" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$identity_rotation_marker"
}

identity_rotation_transition_allowed() {
	case "$1:$2" in
	absent:prepared | complete:prepared | prepared:prepared | \
		prepared:forward-only | forward-only:forward-only | \
		forward-only:complete | complete:complete) return 0 ;;
	*) return 1 ;;
	esac
}

identity_rotation_write_marker() {
	[[ $# -eq 10 && "$1" =~ ^(prepared|forward-only|complete)$ &&
		"$2" =~ ^[1-9][0-9]*$ && "$3" =~ ^[0-9a-f]{40}$ &&
		"$4" =~ ^[0-9a-f]{64}$ && "$5" =~ ^[0-9a-f]{64}$ && "$4" != "$5" &&
		"$6" =~ ^[0-9a-f]{64}$ && "$7" =~ ^[A-Za-z0-9._:-]{1,128}$ &&
		"$8" =~ ^[0-9a-f]{64}$ && "$9" =~ ^[0-9TZ:.-]+$ &&
		"${10}" =~ ^[0-9TZ:.-]+$ ]] || return 1
	local phase="$1" sequence="$2" revision="$3" source_sha="$4"
	local result_sha="$5" previous_kid_sha="$6" active_kid="$7"
	local jwks_sha="$8" started_at="$9" updated_at="${10}"
	local current='absent' temporary="${identity_rotation_marker}.tmp.$$"
	if [[ -e "$identity_rotation_marker" || -L "$identity_rotation_marker" ]]; then
		identity_rotation_validate_marker || return 1
		current="$(identity_rotation_marker_value phase)" || return 1
		if [[ "$current" == 'complete' && "$phase" == 'prepared' ]]; then
			[[ "$sequence" -eq "$(( $(identity_rotation_marker_value sequence) + 1 ))" &&
				"$source_sha" == "$(identity_rotation_marker_value result_sha256)" ]] || return 1
		else
			[[ "$sequence" == "$(identity_rotation_marker_value sequence)" &&
				"$revision" == "$(identity_rotation_marker_value revision)" &&
				"$source_sha" == "$(identity_rotation_marker_value source_sha256)" &&
				"$result_sha" == "$(identity_rotation_marker_value result_sha256)" &&
				"$previous_kid_sha" == "$(identity_rotation_marker_value previous_kid_sha256)" &&
				"$active_kid" == "$(identity_rotation_marker_value active_kid)" &&
				"$jwks_sha" == "$(identity_rotation_marker_value jwks_sha256)" &&
				"$started_at" == "$(identity_rotation_marker_value started_at)" ]] || return 1
		fi
	fi
	identity_rotation_transition_allowed "$current" "$phase" || return 1
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	{
		printf 'version=1\nphase=%s\nsequence=%s\nrevision=%s\n' \
			"$phase" "$sequence" "$revision"
		printf 'source_sha256=%s\nresult_sha256=%s\n' "$source_sha" "$result_sha"
		printf 'previous_kid_sha256=%s\nactive_kid=%s\njwks_sha256=%s\n' \
			"$previous_kid_sha" "$active_kid" "$jwks_sha"
		printf 'started_at=%s\nupdated_at=%s\n' "$started_at" "$updated_at"
	} >"$temporary"
	chmod 600 "$temporary"
	if [[ "$(id -u)" == '0' ]]; then chown 0:0 "$temporary"; fi
	identity_rotation_validate_marker_file "$temporary" || return 1
	mv -f -- "$temporary" "$identity_rotation_marker"
	identity_rotation_validate_marker
}

identity_rotation_history_file() {
	[[ $# -eq 2 && "$1" =~ ^[1-9][0-9]*$ && "$2" =~ ^[0-9a-f]{64}$ ]] || return 1
	printf '%s/%08d-%s.receipt\n' "$identity_rotation_history_root" "$1" "$2"
}

identity_rotation_archive_complete_marker() {
	identity_rotation_validate_marker || return 1
	[[ "$(identity_rotation_marker_value phase)" == 'complete' ]] || return 1
	if [[ ! -e "$identity_rotation_history_root" && ! -L "$identity_rotation_history_root" ]]; then
		mkdir -m 700 "$identity_rotation_history_root"
		if [[ "$(id -u)" == '0' ]]; then chown 0:0 "$identity_rotation_history_root"; fi
	fi
	[[ -d "$identity_rotation_history_root" && ! -L "$identity_rotation_history_root" ]] || return 1
	if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
		[[ "$(stat -c '%u:%g:%a' "$identity_rotation_history_root")" == '0:0:700' ]] || return 1
	fi
	local history_file temporary
	history_file="$(identity_rotation_history_file \
		"$(identity_rotation_marker_value sequence)" \
		"$(identity_rotation_marker_value result_sha256)")" || return 1
	temporary="${history_file}.tmp.$$"
	if [[ -e "$history_file" || -L "$history_file" ]]; then
		identity_rotation_validate_marker_file "$history_file" || return 1
		cmp -s -- "$history_file" "$identity_rotation_marker"
		return
	fi
	[[ ! -e "$temporary" && ! -L "$temporary" ]] || return 1
	install -m 600 "$identity_rotation_marker" "$temporary"
	if [[ "$(id -u)" == '0' ]]; then chown 0:0 "$temporary"; fi
	identity_rotation_validate_marker_file "$temporary" || return 1
	mv -f -- "$temporary" "$history_file"
	identity_rotation_validate_marker_file "$history_file"
}

identity_rotation_prepare_output_file() {
	[[ $# -eq 1 && ! -e "$1" && ! -L "$1" ]] || return 1
	(
		set -o noclobber
		: >"$1"
	)
	chmod 600 "$1"
	if [[ "$(id -u)" == '0' ]]; then chown 0:0 "$1"; fi
	identity_rotation_validate_private_file "$1"
}

identity_rotation_remove_probe_files() {
	local path
	for path in "$identity_rotation_candidate" "$identity_rotation_old_header" \
		"$identity_rotation_new_header" "$identity_rotation_direct_jwks" \
		"$identity_rotation_public_jwks" "$identity_rotation_old_response" \
		"$identity_rotation_new_response"; do
		if [[ -e "$path" || -L "$path" ]]; then
			identity_rotation_validate_private_file "$path" || return 1
			rm -f -- "$path"
		fi
	done
}

identity_rotation_verify_runtime_image() {
	[[ $# -ge 2 && $# -le 3 && "$1" =~ ^[A-Za-z0-9._:/-]+$ &&
		"$2" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
	local image="$1" expected_user="$2" expected_title="${3:-}"
	local metadata image_id revision image_user image_title
	metadata="$(docker image inspect --format \
		'{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.title"}}' \
		"$image")" || return 1
	IFS='|' read -r image_id revision image_user image_title <<<"$metadata"
	[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ && "$revision" == "$EXPECTED_REVISION" &&
		"$image_user" == "$expected_user" &&
		( -z "$expected_title" || "$image_title" == "$expected_title" ) ]] || return 1
	printf '%s\n' "$image_id"
}

identity_rotation_image_id() {
	identity_rotation_verify_runtime_image \
		"winwidget-identity:git-$EXPECTED_REVISION" identity winwidget-identity
}

identity_rotation_generate_candidate() {
	[[ $# -eq 1 && "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local image_id="$1"
	identity_rotation_remove_probe_files || return 1
	identity_rotation_prepare_output_file "$identity_rotation_candidate" || return 1
	identity_rotation_prepare_output_file "$identity_rotation_old_header" || return 1
	identity_rotation_prepare_output_file "$identity_rotation_new_header" || return 1
	docker run --rm --interactive --pull never --network none --read-only \
		--cap-drop ALL --pids-limit 64 --cpus 1 --memory 512m --memory-swap 512m \
		--log-driver none --user 0:0 --security-opt no-new-privileges \
		--entrypoint node \
		--mount "type=bind,source=$ENV_FILE,target=/run/identity-env-source,readonly" \
		--mount "type=bind,source=$identity_rotation_candidate,target=/run/identity-env-candidate" \
		--mount "type=bind,source=$identity_rotation_old_header,target=/run/identity-old-header" \
		--mount "type=bind,source=$identity_rotation_new_header,target=/run/identity-new-header" \
		"$image_id" - \
		/run/identity-env-source /run/identity-env-candidate \
		/run/identity-old-header /run/identity-new-header <<'NODE'
const {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} = require('node:crypto');
const { closeSync, constants, fsyncSync, openSync, readFileSync, writeFileSync } = require('node:fs');
const [source, candidate, oldHeaderFile, newHeaderFile] = process.argv.slice(2);
const content = readFileSync(source, 'utf8');
if (content.includes('\r')) throw new Error('production env must use LF line endings');
const managed = new Set([
  'IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64',
  'IDENTITY_JWT_ACCESS_JWKS_BASE64',
  'IDENTITY_JWT_ACCESS_ACTIVE_KID',
]);
const values = new Map();
const counts = new Map();
for (const [index, line] of content.split('\n').entries()) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!match) continue;
  counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  if (counts.get(match[1]) !== 1) throw new Error(`duplicate env key at line ${index + 1}`);
  values.set(match[1], match[2].trim());
}
for (const key of managed) {
  if (counts.get(key) !== 1 || !values.get(key)) throw new Error(`missing ${key}`);
}
const safeKid = value => /^[A-Za-z0-9._:-]{1,128}$/.test(value || '');
const privateKey = value => {
  const key = createPrivateKey(Buffer.from(value, 'base64'));
  if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength || 0) < 3072) throw new Error('invalid RSA private key');
  return key;
};
const publicKeyset = (encoded, kid) => {
  const jwks = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!Array.isArray(jwks?.keys) || jwks.keys.length !== 1) throw new Error('JWKS must contain exactly one key');
  const key = jwks.keys[0];
  if (!safeKid(kid) || key?.kid !== kid || key.kty !== 'RSA' || key.alg !== 'RS256' ||
      key.use !== 'sig' || key.key_ops?.join(',') !== 'verify' ||
      ['d','p','q','dp','dq','qi','oth'].some(name => name in key)) throw new Error('invalid public JWK');
  const imported = createPublicKey({ key, format: 'jwk' });
  if ((imported.asymmetricKeyDetails?.modulusLength || 0) < 3072) throw new Error('weak public JWK');
  return { jwks, key, imported };
};
const oldKid = values.get('IDENTITY_JWT_ACCESS_ACTIVE_KID');
const oldPrivateKey = privateKey(values.get('IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64'));
const oldPublic = publicKeyset(values.get('IDENTITY_JWT_ACCESS_JWKS_BASE64'), oldKid);
const challenge = randomBytes(64);
if (!verify('sha256', challenge, oldPublic.imported, sign('sha256', challenge, oldPrivateKey))) {
  throw new Error('old private key does not match old JWKS');
}
const pair = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
const newKid = `identity-rotation-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(8).toString('hex')}`;
const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicJwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: newKid,
  use: 'sig',
  alg: 'RS256',
  key_ops: ['verify'],
};
const updates = new Map([
  ['IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64', Buffer.from(privatePem).toString('base64')],
  ['IDENTITY_JWT_ACCESS_JWKS_BASE64', Buffer.from(JSON.stringify({ keys: [publicJwk] })).toString('base64')],
  ['IDENTITY_JWT_ACCESS_ACTIVE_KID', newKid],
]);
const candidateContent = content.split('\n').map(line => {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match && managed.has(match[1]) ? `${match[1]}=${updates.get(match[1])}` : line;
}).join('\n');
const candidateValues = new Map(values);
for (const [key, value] of updates) candidateValues.set(key, value);
const newPrivateKey = privateKey(candidateValues.get('IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64'));
const newPublic = publicKeyset(candidateValues.get('IDENTITY_JWT_ACCESS_JWKS_BASE64'), newKid);
if (!verify('sha256', challenge, newPublic.imported, sign('sha256', challenge, newPrivateKey)) ||
    newKid === oldKid || newPublic.key.n === oldPublic.key.n) throw new Error('new keyset is not distinct');
const writeExisting = (path, value) => {
  const fd = openSync(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try { writeFileSync(fd, value, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
};
writeExisting(candidate, candidateContent);
const issuer = values.get('JWT_ISSUER');
const audience = values.get('JWT_AUDIENCE');
const configuredTtl = Number(values.get('JWT_ACCESS_TTL_SECONDS'));
if (!issuer || !audience || !Number.isSafeInteger(configuredTtl) || configuredTtl < 300) {
  throw new Error('JWT context is invalid');
}
const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: issuer,
  aud: audience,
  sub: 'identity-jwt-rotation-probe',
  sid: randomUUID(),
  roles: ['USER'],
  token_use: 'access',
  jti: randomUUID(),
  iat: now,
  nbf: now,
  exp: now + Math.min(configuredTtl, 900),
};
const token = (kid, key) => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
};
writeExisting(oldHeaderFile, `Authorization: Bearer ${token(oldKid, oldPrivateKey)}\n`);
writeExisting(newHeaderFile, `Authorization: Bearer ${token(newKid, newPrivateKey)}\n`);
NODE
	identity_rotation_validate_private_file "$identity_rotation_candidate"
	identity_rotation_validate_private_file "$identity_rotation_old_header"
	identity_rotation_validate_private_file "$identity_rotation_new_header"
}

identity_rotation_require_probe_files() {
	identity_rotation_validate_private_file "$identity_rotation_old_header" || return 1
	identity_rotation_validate_private_file "$identity_rotation_new_header" || return 1
	awk 'NR == 1 && /^Authorization: Bearer [A-Za-z0-9_.-]+$/ { found += 1 } END { exit(NR == 1 && found == 1 ? 0 : 1) }' \
		"$identity_rotation_old_header" || return 1
	awk 'NR == 1 && /^Authorization: Bearer [A-Za-z0-9_.-]+$/ { found += 1 } END { exit(NR == 1 && found == 1 ? 0 : 1) }' \
		"$identity_rotation_new_header"
}

identity_rotation_refresh_new_header() {
	[[ $# -eq 1 && "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local image_id="$1"
	if [[ -e "$identity_rotation_new_header" || -L "$identity_rotation_new_header" ]]; then
		identity_rotation_validate_private_file "$identity_rotation_new_header" || return 1
		rm -f -- "$identity_rotation_new_header"
	fi
	identity_rotation_prepare_output_file "$identity_rotation_new_header" || return 1
	docker run --rm --interactive --pull never --network none --read-only \
		--cap-drop ALL --pids-limit 64 --cpus 1 --memory 256m --memory-swap 256m \
		--log-driver none --user 0:0 --security-opt no-new-privileges \
		--entrypoint node \
		--mount "type=bind,source=$ENV_FILE,target=/run/identity-env-source,readonly" \
		--mount "type=bind,source=$identity_rotation_new_header,target=/run/identity-new-header" \
		"$image_id" - /run/identity-env-source /run/identity-new-header <<'NODE'
const { createPrivateKey, createPublicKey, randomUUID, sign } = require('node:crypto');
const { closeSync, constants, fsyncSync, openSync, readFileSync, writeFileSync } = require('node:fs');
const [envFile, headerFile] = process.argv.slice(2);
const values = new Map();
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!match) continue;
  if (values.has(match[1])) process.exit(1);
  values.set(match[1], match[2].trim());
}
let privateKey;
let jwks;
try {
  privateKey = createPrivateKey(Buffer.from(values.get('IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64') || '', 'base64'));
  jwks = JSON.parse(Buffer.from(values.get('IDENTITY_JWT_ACCESS_JWKS_BASE64') || '', 'base64').toString('utf8'));
} catch { process.exit(1); }
const kid = values.get('IDENTITY_JWT_ACCESS_ACTIVE_KID');
if (!/^[A-Za-z0-9._:-]{1,128}$/.test(kid || '') || privateKey.asymmetricKeyType !== 'rsa' ||
    (privateKey.asymmetricKeyDetails?.modulusLength || 0) < 3072 ||
    !Array.isArray(jwks?.keys) || jwks.keys.length !== 1 || jwks.keys[0]?.kid !== kid ||
    (createPublicKey({ key: jwks.keys[0], format: 'jwk' }).asymmetricKeyDetails?.modulusLength || 0) < 3072) process.exit(1);
const derived = createPublicKey(privateKey).export({ format: 'jwk' });
if (derived.n !== jwks.keys[0].n || derived.e !== jwks.keys[0].e) process.exit(1);
const configuredTtl = Number(values.get('JWT_ACCESS_TTL_SECONDS'));
if (!values.get('JWT_ISSUER') || !values.get('JWT_AUDIENCE') ||
    !Number.isSafeInteger(configuredTtl) || configuredTtl < 300) process.exit(1);
const now = Math.floor(Date.now() / 1000);
const protectedHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt', kid })).toString('base64url');
const payload = Buffer.from(JSON.stringify({
  iss: values.get('JWT_ISSUER'), aud: values.get('JWT_AUDIENCE'),
  sub: 'identity-jwt-rotation-probe', sid: randomUUID(), roles: ['USER'],
  token_use: 'access', jti: randomUUID(), iat: now, nbf: now,
  exp: now + Math.min(configuredTtl, 900),
})).toString('base64url');
const input = `${protectedHeader}.${payload}`;
const token = `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
const fd = openSync(headerFile, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
try { writeFileSync(fd, `Authorization: Bearer ${token}\n`, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
NODE
	identity_rotation_validate_private_file "$identity_rotation_new_header"
}

identity_rotation_write_current_marker_phase() {
	[[ $# -eq 1 && "$1" =~ ^(prepared|forward-only|complete)$ ]] || return 1
	identity_rotation_write_marker "$1" \
		"$(identity_rotation_marker_value sequence)" \
		"$(identity_rotation_marker_value revision)" \
		"$(identity_rotation_marker_value source_sha256)" \
		"$(identity_rotation_marker_value result_sha256)" \
		"$(identity_rotation_marker_value previous_kid_sha256)" \
		"$(identity_rotation_marker_value active_kid)" \
		"$(identity_rotation_marker_value jwks_sha256)" \
		"$(identity_rotation_marker_value started_at)" \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

identity_rotation_commit_env() {
	identity_rotation_validate_marker || return 1
	local source_sha result_sha current_sha
	source_sha="$(identity_rotation_marker_value source_sha256)"
	result_sha="$(identity_rotation_marker_value result_sha256)"
	current_sha="$(identity_rotation_sha256 "$ENV_FILE")"
	if [[ "$current_sha" == "$source_sha" ]]; then
		identity_rotation_validate_private_file "$identity_rotation_candidate" || return 1
		[[ "$(identity_rotation_sha256 "$identity_rotation_candidate")" == "$result_sha" ]] || return 1
		mv -f -- "$identity_rotation_candidate" "$ENV_FILE"
		chmod 600 "$ENV_FILE"
		chown 0:0 "$ENV_FILE"
		sync -f "$ENV_FILE"
		sync -f "$(dirname -- "$ENV_FILE")"
		current_sha="$(identity_rotation_sha256 "$ENV_FILE")"
	fi
	[[ "$current_sha" == "$result_sha" ]] ||
		identity_rotation_fail 'backend env is outside the prepared forward-only rotation pair' || return 1
	if [[ -e "$identity_rotation_candidate" || -L "$identity_rotation_candidate" ]]; then
		identity_rotation_validate_private_file "$identity_rotation_candidate" || return 1
		[[ "$(identity_rotation_sha256 "$identity_rotation_candidate")" == "$result_sha" ]] || return 1
		rm -f -- "$identity_rotation_candidate"
	fi
	identity_rotation_write_current_marker_phase forward-only
}

identity_rotation_wait_container() {
	[[ $# -eq 5 && "$1" =~ ^[a-z0-9-]+$ && "$2" =~ ^sha256:[0-9a-f]{64}$ &&
		"$3" =~ ^[0-9]+$ && "$4" =~ ^[A-Za-z0-9._:-]{1,128}$ &&
		"$5" =~ ^[A-Za-z0-9._:/-]+$ ]] || return 1
	local service="$1" expected_image_id="$2" port="$3" expected_kid="$4"
	local expected_configured_image="$5"
	local attempt container_id metadata project actual_service oneoff status running health
	local restart_count container_revision image_id configured_image owner purpose singleton
	local app_revision runtime_kid identity_labels_valid
	for attempt in {1..30}; do
		((attempt > 0)) || return 1
		container_id="$(identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
			ps --status running -q "$service" 2>/dev/null || true)"
		if [[ "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
			metadata="$(docker inspect --format \
				'{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Image}}|{{.Config.Image}}|{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}|{{index .Config.Labels "com.winwidget.singleton"}}' \
				"$container_id" 2>/dev/null || true)"
			IFS='|' read -r project actual_service oneoff status running health restart_count \
				container_revision image_id configured_image owner purpose singleton <<<"$metadata"
			app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
				"$container_id" | awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }' 2>/dev/null || true)"
			runtime_kid="$expected_kid"
			if [[ "$service" == 'identity-api' ]]; then
				runtime_kid="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
					"$container_id" | awk -F= '$1 == "JWT_ACCESS_ACTIVE_KID" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }' 2>/dev/null || true)"
			fi
			identity_labels_valid='true'
			if [[ "$service" == 'identity-api' &&
				( "$owner" != 'identity' || "$purpose" != 'api' || "$singleton" != 'true' ) ]]; then
				identity_labels_valid='false'
			fi
			if [[ "$project" == 'winwidget' && "$actual_service" == "$service" &&
				"$oneoff" =~ ^[Ff]alse$ && "$status" == 'running' && "$running" == 'true' &&
				"$health" == 'healthy' && "$restart_count" == '0' &&
				"$container_revision" == "$EXPECTED_REVISION" && "$image_id" == "$expected_image_id" &&
				"$configured_image" == "$expected_configured_image" && "$identity_labels_valid" == 'true' &&
				"$app_revision" == "$EXPECTED_REVISION" && "$runtime_kid" == "$expected_kid" ]] &&
				curl -fsS --connect-timeout 2 --max-time 5 \
					"http://127.0.0.1:$port/health/ready" >/dev/null 2>&1; then
				return
			fi
		fi
		sleep 4
	done
	identity_rotation_fail "$service did not become healthy on the rotated keyset"
}

identity_rotation_prepare_response_file() {
	[[ $# -eq 1 ]] || return 1
	if [[ -e "$1" || -L "$1" ]]; then
		identity_rotation_validate_private_file "$1" || return 1
		rm -f -- "$1"
	fi
	identity_rotation_prepare_output_file "$1"
}

identity_rotation_verify_jwks_files() {
	[[ $# -eq 3 && "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
	local image_id="$1" direct_file="$2" public_file="$3"
	identity_rotation_validate_private_file "$direct_file" || return 1
	identity_rotation_validate_private_file "$public_file" || return 1
	cmp -s -- "$direct_file" "$public_file" ||
		identity_rotation_fail 'public Gateway JWKS differs from direct Identity JWKS' || return 1
	docker run --rm --interactive --pull never --network none --read-only \
		--cap-drop ALL --pids-limit 64 --cpus 1 --memory 256m --memory-swap 256m \
		--log-driver none --user 0:0 --security-opt no-new-privileges \
		--entrypoint node \
		--mount "type=bind,source=$ENV_FILE,target=/run/identity-env-source,readonly" \
		--mount "type=bind,source=$direct_file,target=/run/identity-direct-jwks,readonly" \
		"$image_id" - /run/identity-env-source /run/identity-direct-jwks <<'NODE'
const { createPublicKey } = require('node:crypto');
const { readFileSync } = require('node:fs');
const [envFile, responseFile] = process.argv.slice(2);
const values = new Map();
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (match) {
    if (values.has(match[1])) process.exit(1);
    values.set(match[1], match[2].trim());
  }
}
let expected;
let actual;
try {
  expected = JSON.parse(Buffer.from(values.get('IDENTITY_JWT_ACCESS_JWKS_BASE64') || '', 'base64').toString('utf8'));
  actual = JSON.parse(readFileSync(responseFile, 'utf8'));
} catch { process.exit(1); }
if (!Array.isArray(expected?.keys) || expected.keys.length !== 1 ||
    !Array.isArray(actual?.keys) || actual.keys.length !== 1 ||
    Object.keys(expected).join(',') !== 'keys' || Object.keys(actual).join(',') !== 'keys') process.exit(1);
const fields = value => Object.keys(value).sort().map(key => [key, value[key]]);
if (JSON.stringify(fields(expected.keys[0])) !== JSON.stringify(fields(actual.keys[0])) ||
    actual.keys[0].kid !== values.get('IDENTITY_JWT_ACCESS_ACTIVE_KID') ||
    (createPublicKey({ key: actual.keys[0], format: 'jwk' }).asymmetricKeyDetails?.modulusLength || 0) < 3072) process.exit(1);
NODE
}

identity_rotation_verify_runtime() {
	identity_rotation_validate_marker || return 1
	local identity_image_id gateway_image_id active_kid new_status old_status
	identity_image_id="$(identity_rotation_image_id)" || return 1
	identity_rotation_validate_private_file "$identity_rotation_old_header" || return 1
	identity_rotation_refresh_new_header "$identity_image_id"
	identity_rotation_require_probe_files || return 1
	gateway_image_id="$(identity_rotation_verify_runtime_image \
		"winwidget-api-gateway:git-$EXPECTED_REVISION" node)" || return 1
	active_kid="$(identity_rotation_marker_value active_kid)"
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate identity-api
	identity_rotation_wait_container identity-api "$identity_image_id" 4900 "$active_kid" \
		"winwidget-identity:git-$EXPECTED_REVISION"
	identity_rotation_prepare_response_file "$identity_rotation_direct_jwks"
	curl -fsS --connect-timeout 3 --max-time 10 --max-filesize 65536 \
		-o "$identity_rotation_direct_jwks" \
		http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" \
		up -d --no-deps --no-build --force-recreate api-gateway
	identity_rotation_wait_container api-gateway "$gateway_image_id" 4100 "$active_kid" \
		"winwidget-api-gateway:git-$EXPECTED_REVISION"
	identity_rotation_prepare_response_file "$identity_rotation_public_jwks"
	curl -fsS --connect-timeout 3 --max-time 10 --max-filesize 65536 \
		-o "$identity_rotation_public_jwks" \
		https://api.winwidget.ru/api/v1/auth/.well-known/jwks.json
	identity_rotation_verify_jwks_files "$identity_image_id" \
		"$identity_rotation_direct_jwks" "$identity_rotation_public_jwks"
	identity_rotation_prepare_response_file "$identity_rotation_new_response"
	if ! new_status="$(curl -sS --connect-timeout 3 --max-time 10 --max-filesize 65536 \
		-o "$identity_rotation_new_response" -w '%{http_code}' \
		-H "@$identity_rotation_new_header" \
		https://api.winwidget.ru/api/v1/auth/settings)"; then
		identity_rotation_fail 'new Identity JWT rotation probe request failed'
		return 1
	fi
	[[ "$new_status" == '200' ]] ||
		identity_rotation_fail 'Gateway rejected the new Identity JWT rotation probe' || return 1
	identity_rotation_prepare_response_file "$identity_rotation_old_response"
	if ! old_status="$(curl -sS --connect-timeout 3 --max-time 10 --max-filesize 65536 \
		-o "$identity_rotation_old_response" -w '%{http_code}' \
		-H "@$identity_rotation_old_header" \
		https://api.winwidget.ru/api/v1/auth/settings)"; then
		identity_rotation_fail 'retired Identity JWT rotation probe request failed'
		return 1
	fi
	[[ "$old_status" == '401' ]] ||
		identity_rotation_fail 'Gateway did not reject the retired Identity JWT key' || return 1
	docker run --rm --interactive --pull never --network none --read-only \
		--cap-drop ALL --pids-limit 32 --cpus 1 --memory 128m --memory-swap 128m \
		--log-driver none --user 0:0 --security-opt no-new-privileges \
		--entrypoint node \
		--mount "type=bind,source=$identity_rotation_old_response,target=/run/identity-old-response,readonly" \
		"$identity_image_id" - /run/identity-old-response <<'NODE'
const { readFileSync } = require('node:fs');
let body;
try { body = JSON.parse(readFileSync(process.argv[2], 'utf8')); } catch { process.exit(1); }
if (body?.statusCode !== 401 || body?.code !== 'invalid_token') process.exit(1);
NODE
}

identity_rotation_require_common() {
	identity_database_require_root
	identity_release_validate_revision "$EXPECTED_REVISION"
	identity_release_validate_file "$ENV_FILE"
	identity_release_validate_file "$COMPOSE_FILE"
	identity_release_require_checkout "$SERVER_ROOT" "$EXPECTED_REVISION"
	[[ "$IDENTITY_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
		identity_rotation_fail 'exact local canonical backend env SHA-256 is required' || return 1
	[[ "$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
		identity_rotation_fail 'backend production env must be root-owned mode 600' || return 1
	identity_database_validate_marker
	identity_cutover_validate_marker
	identity_cleanup_validate_marker
	identity_cleanup_validate_signing_marker
	[[ "$(identity_database_current_phase)" == 'complete' &&
		"$(identity_cutover_marker_value phase)" == 'complete' &&
		"$(identity_cleanup_marker_value phase)" == 'complete' &&
		"$(identity_cleanup_signing_marker_value phase)" == 'complete' ]] ||
		identity_rotation_fail 'Identity ownership and Core cleanup must be complete before JWT rotation' || return 1
	git -C "$SERVER_ROOT" merge-base --is-ancestor \
		"$(identity_cleanup_marker_value cleanup_revision)" "$EXPECTED_REVISION" ||
		identity_rotation_fail 'rotation revision must descend from completed Identity Core cleanup' || return 1
	database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"
	identity_release_compose "$EXPECTED_REVISION" "$ENV_FILE" "$COMPOSE_FILE" config --quiet
}

identity_rotation_export_env_if_requested() {
	if [[ -z "${IDENTITY_ENV_EXPORT_CERTIFICATE_FILE:-}" &&
		-z "${IDENTITY_ENV_EXPORT_FILE:-}" ]]; then
		return
	fi
	[[ -n "${IDENTITY_ENV_EXPORT_CERTIFICATE_FILE:-}" &&
		-n "${IDENTITY_ENV_EXPORT_FILE:-}" ]] || return 1
	APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" EXPECTED_REVISION="$EXPECTED_REVISION" \
		IDENTITY_ENV_EXPORT_CERTIFICATE_FILE="$IDENTITY_ENV_EXPORT_CERTIFICATE_FILE" \
		IDENTITY_ENV_EXPORT_FILE="$IDENTITY_ENV_EXPORT_FILE" \
		bash "$IDENTITY_SCRIPT_ROOT/scripts/identity-production-env-control.sh" --export-encrypted
}

identity_rotation_prepare_new() {
	local current_sha source_sha result_sha sequence previous_kid previous_kid_sha
	local active_kid jwks_value jwks_sha started_at image_id
	current_sha="$(identity_rotation_sha256 "$ENV_FILE")" || return 1
	[[ "$current_sha" == "$IDENTITY_ENV_EXPECTED_SHA256" ]] ||
		identity_rotation_fail 'server backend env differs from the local canonical source copy' || return 1
	sequence=1
	if [[ -e "$identity_rotation_marker" || -L "$identity_rotation_marker" ]]; then
		identity_rotation_validate_marker || return 1
		[[ "$(identity_rotation_marker_value phase)" == 'complete' ]] ||
			identity_rotation_fail 'an incomplete JWT rotation requires forward recovery' || return 1
		[[ "$(identity_rotation_marker_value result_sha256)" == "$current_sha" ]] ||
			identity_rotation_fail 'backend env drifted from the completed JWT rotation marker' || return 1
		identity_rotation_archive_complete_marker
		sequence="$(( $(identity_rotation_marker_value sequence) + 1 ))"
	else
		[[ "$(identity_cleanup_signing_marker_value result_sha256)" == "$current_sha" ]] ||
			identity_rotation_fail 'first JWT rotation must descend from completed Core signing-env cleanup' || return 1
	fi
	image_id="$(identity_rotation_image_id)" || return 1
	identity_rotation_generate_candidate "$image_id"
	source_sha="$current_sha"
	result_sha="$(identity_rotation_sha256 "$identity_rotation_candidate")" || return 1
	[[ "$result_sha" =~ ^[0-9a-f]{64}$ && "$result_sha" != "$source_sha" ]] || return 1
	previous_kid="$(identity_read_env_value "$ENV_FILE" IDENTITY_JWT_ACCESS_ACTIVE_KID)" || return 1
	previous_kid_sha="$(printf '%s' "$previous_kid" | identity_rotation_text_sha256)" || return 1
	active_kid="$(identity_read_env_value "$identity_rotation_candidate" IDENTITY_JWT_ACCESS_ACTIVE_KID)" || return 1
	jwks_value="$(identity_read_env_value "$identity_rotation_candidate" IDENTITY_JWT_ACCESS_JWKS_BASE64)" || return 1
	jwks_sha="$(printf '%s' "$jwks_value" | identity_rotation_text_sha256)" || return 1
	unset previous_kid jwks_value
	started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	identity_rotation_write_marker prepared "$sequence" "$EXPECTED_REVISION" \
		"$source_sha" "$result_sha" "$previous_kid_sha" "$active_kid" \
		"$jwks_sha" "$started_at" "$started_at"
}

identity_rotation_resume() {
	identity_rotation_validate_marker || return 1
	local phase source_sha result_sha current_sha
	phase="$(identity_rotation_marker_value phase)"
	[[ "$phase" =~ ^(prepared|forward-only)$ ]] ||
		identity_rotation_fail 'no incomplete JWT rotation is available for forward recovery' || return 1
	[[ "$(identity_rotation_marker_value revision)" == "$EXPECTED_REVISION" ]] ||
		identity_rotation_fail 'forward recovery requires the exact rotation revision' || return 1
	source_sha="$(identity_rotation_marker_value source_sha256)"
	result_sha="$(identity_rotation_marker_value result_sha256)"
	[[ "$IDENTITY_ENV_EXPECTED_SHA256" == "$source_sha" ||
		"$IDENTITY_ENV_EXPECTED_SHA256" == "$result_sha" ]] ||
		identity_rotation_fail 'local canonical env SHA is outside the active rotation pair' || return 1
	current_sha="$(identity_rotation_sha256 "$ENV_FILE")"
	[[ "$current_sha" == "$source_sha" || "$current_sha" == "$result_sha" ]] ||
		identity_rotation_fail 'backend env drifted outside the active rotation pair'
}

identity_rotation_finish() {
	identity_rotation_commit_env
	identity_rotation_verify_runtime
	identity_rotation_write_current_marker_phase complete
	identity_rotation_archive_complete_marker
	identity_rotation_remove_probe_files
	identity_rotation_export_env_if_requested
	printf 'identity_jwt_rotation_phase=complete\n'
	printf 'identity_jwt_rotation_sequence=%s\n' "$(identity_rotation_marker_value sequence)"
	printf 'identity_jwt_rotation_revision=%s\n' "$(identity_rotation_marker_value revision)"
	printf 'identity_jwt_rotation_env_sha256=%s\n' "$(identity_rotation_marker_value result_sha256)"
	printf 'identity_jwt_rotation_jwks_keys=1\n'
	printf 'identity_jwt_rotation_old_token_rejected=true\n'
}

identity_rotation_run() {
	[[ "${IDENTITY_JWT_ROTATION_CONFIRMATION:-}" == "$identity_rotation_confirmation" ]] ||
		identity_rotation_fail 'exact Identity JWT rotation confirmation is required' || return 1
	identity_rotation_require_common
	acquire_production_deploy_lock 'Identity JWT signing-key rotation'
	identity_rotation_prepare_new
	identity_rotation_finish
}

identity_rotation_forward_recovery() {
	[[ "${IDENTITY_JWT_ROTATION_CONFIRMATION:-}" == "$identity_rotation_confirmation" ]] ||
		identity_rotation_fail 'exact Identity JWT rotation confirmation is required' || return 1
	identity_rotation_require_common
	acquire_production_deploy_lock 'Identity JWT signing-key forward recovery'
	if [[ -e "$identity_rotation_marker" || -L "$identity_rotation_marker" ]]; then
		identity_rotation_validate_marker || return 1
		if [[ "$(identity_rotation_marker_value phase)" == 'complete' ]]; then
			[[ "$(identity_rotation_marker_value revision)" == "$EXPECTED_REVISION" &&
				"$(identity_rotation_marker_value result_sha256)" == "$(identity_rotation_sha256 "$ENV_FILE")" &&
				( "$IDENTITY_ENV_EXPECTED_SHA256" == "$(identity_rotation_marker_value source_sha256)" ||
					"$IDENTITY_ENV_EXPECTED_SHA256" == "$(identity_rotation_marker_value result_sha256)" ) ]] || return 1
			identity_rotation_archive_complete_marker
			identity_rotation_remove_probe_files
			identity_rotation_export_env_if_requested
			printf 'identity_jwt_rotation_phase=complete\n'
			return
		fi
	fi
	identity_rotation_resume
	identity_rotation_finish
}

identity_rotation_status() {
	if [[ ! -e "$identity_rotation_marker" && ! -L "$identity_rotation_marker" ]]; then
		printf 'identity_jwt_rotation_phase=absent\n'
		return
	fi
	identity_rotation_validate_marker
	printf 'identity_jwt_rotation_phase=%s\n' "$(identity_rotation_marker_value phase)"
	printf 'identity_jwt_rotation_sequence=%s\n' "$(identity_rotation_marker_value sequence)"
	printf 'identity_jwt_rotation_revision=%s\n' "$(identity_rotation_marker_value revision)"
	printf 'identity_jwt_rotation_env_sha256=%s\n' "$(identity_rotation_marker_value result_sha256)"
}

identity_rotation_self_test() {
	identity_rotation_transition_allowed absent prepared
	identity_rotation_transition_allowed complete prepared
	identity_rotation_transition_allowed prepared forward-only
	identity_rotation_transition_allowed forward-only complete
	! identity_rotation_transition_allowed prepared complete
	! identity_rotation_transition_allowed complete forward-only
	local source
	source="$(declare -f identity_rotation_generate_candidate identity_rotation_commit_env \
		identity_rotation_verify_runtime_image identity_rotation_wait_container \
		identity_rotation_verify_runtime identity_rotation_finish identity_rotation_run \
		identity_rotation_forward_recovery identity_rotation_archive_complete_marker)"
	[[ "$source" == *"generateKeyPairSync('rsa', { modulusLength: 3072"* &&
		"$source" == *"JSON.stringify({ keys: [publicJwk] })"* &&
		"$source" == *'constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW'* &&
		"$source" == *'mv -f -- "$identity_rotation_candidate" "$ENV_FILE"'* &&
		"$source" == *'identity_rotation_write_current_marker_phase forward-only'* &&
		"$source" == *'--force-recreate identity-api'* &&
		"$source" == *'--force-recreate api-gateway'* &&
		"$source" == *'--max-filesize 65536'* &&
		"$source" == *'{{.Config.Image}}'* &&
		"$source" == *'winwidget-api-gateway:git-$EXPECTED_REVISION" node'* &&
		"$source" == *'-H "@$identity_rotation_new_header"'* &&
		"$source" == *'-H "@$identity_rotation_old_header"'* &&
		"$source" == *"old_status\" == '401'"* &&
		"$source" == *'identity_rotation_write_current_marker_phase complete'* &&
		"$source" == *'identity_rotation_archive_complete_marker'* &&
		"$source" == *'acquire_production_deploy_lock'* ]] || return 1
	ROTATION_SOURCE="${BASH_SOURCE[0]}" node -e '
const { readFileSync } = require("node:fs");
const { Script } = require("node:vm");
const source = readFileSync(process.env.ROTATION_SOURCE, "utf8");
const blocks = [...source.matchAll(/<<\x27NODE\x27\n([\s\S]*?)\nNODE/g)].map(match => match[1]);
if (blocks.length !== 4) process.exit(1);
blocks.forEach((block, index) => new Script(block, { filename: `identity-rotation-${index + 1}.js` }));
'
	printf 'identity_jwt_rotation_self_test=passed\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	case "${1:-}" in
	--rotate) identity_rotation_run ;;
	--forward-recovery) identity_rotation_forward_recovery ;;
	--status) identity_rotation_status ;;
	--self-test) identity_rotation_self_test ;;
	*) identity_rotation_fail 'Usage: rotate-identity-jwt-production.sh --rotate|--forward-recovery|--status|--self-test' ;;
	esac
fi
