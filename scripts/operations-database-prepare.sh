#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ROOT="$(cd "$ROOT_DIR/.." && pwd -P)"
COMPOSE_FILE="$ROOT_DIR/deploy/docker-compose.prod.yml"
ENV_FILE="${OPERATIONS_ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"

fail() {
  printf 'operations-database-prepare: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" > /dev/null 2>&1 || fail "$1 is required"
}

load_env() {
  [[ "$ENV_FILE" == "$APP_ROOT/deploy/backend/.env.production" &&
    -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
    fail "production env file is missing or unsafe"
  if [[ "$(uname -s)" == 'Linux' && "$(id -u)" == '0' ]]; then
    [[ "$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' ]] ||
      fail "production env file must be root-owned mode 600"
  fi
  local encoded_entries key encoded value
  unset OPERATIONS_POSTGRES_IMAGE OPERATIONS_POSTGRES_PORT \
    OPERATIONS_POSTGRES_DATA_VOLUME OPERATIONS_POSTGRES_ADMIN_USER \
    OPERATIONS_POSTGRES_ADMIN_PASSWORD_FILE OPERATIONS_DATABASE_URL \
    OPERATIONS_MIGRATION_DATABASE_URL OPERATIONS_BACKUP_URL \
    OPERATIONS_IMAGE OPERATIONS_REVISION
  encoded_entries="$(OPERATIONS_ENV_PATH="$ENV_FILE" node <<'NODE'
const { readFileSync } = require('node:fs');
const values = new Map();
for (const line of readFileSync(process.env.OPERATIONS_ENV_PATH, 'utf8').split(/\r?\n/)) {
  if (!line.trim() || /^\s*#/.test(line)) continue;
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match || values.has(match[1])) throw new Error('invalid or duplicate env entry');
  let value = match[2];
  if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
  else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  if (value.includes('\0')) throw new Error('invalid env value');
  values.set(match[1], value);
}
for (const [key, value] of values) {
  process.stdout.write(`${key}\t${Buffer.from(value).toString('base64')}\n`);
}
NODE
  )" || fail "production env cannot be parsed"
  while IFS=$'\t' read -r key encoded; do
    [[ -n "$key" ]] || continue
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "invalid env key"
    value="$(printf '%s' "$encoded" | base64 --decode 2>/dev/null || printf '%s' "$encoded" | base64 -D)" ||
      fail "invalid encoded env value"
    printf -v "$key" '%s' "$value"
    export "${key?}"
  done <<< "$encoded_entries"
  unset encoded_entries encoded value
}

require_variable() {
  [[ -n "${!1:-}" ]] || fail "$1 is required"
}

validate_contract() {
  local required=(
    OPERATIONS_POSTGRES_IMAGE
    OPERATIONS_POSTGRES_PORT
    OPERATIONS_POSTGRES_DATA_VOLUME
    OPERATIONS_POSTGRES_ADMIN_USER
    OPERATIONS_POSTGRES_ADMIN_PASSWORD_FILE
    OPERATIONS_DATABASE_URL
    OPERATIONS_MIGRATION_DATABASE_URL
    OPERATIONS_BACKUP_URL
    OPERATIONS_IMAGE
    OPERATIONS_REVISION
  )
  local name
  for name in "${required[@]}"; do
    require_variable "$name"
  done
  [[ "$OPERATIONS_POSTGRES_IMAGE" == postgres:18-*'@sha256:'* ]] ||
    fail "OPERATIONS_POSTGRES_IMAGE must pin PostgreSQL 18 by digest"
  [[ "$OPERATIONS_POSTGRES_PORT" == '55441' ]] ||
    fail "OPERATIONS_POSTGRES_PORT must be 55441"
  [[ "$OPERATIONS_POSTGRES_DATA_VOLUME" == 'winwidget-operations-postgres-data' ]] ||
    fail "unexpected Operations PostgreSQL volume"
  [[ "$OPERATIONS_POSTGRES_ADMIN_USER" == 'winwidget_operations_admin' ]] ||
    fail "unexpected Operations PostgreSQL admin role"
  [[ "$OPERATIONS_REVISION" =~ ^[0-9a-f]{40}$ ]] ||
    fail "OPERATIONS_REVISION must be a full lowercase Git SHA"
  [[ "$OPERATIONS_POSTGRES_ADMIN_PASSWORD_FILE" == "$APP_ROOT/deploy/backend/.operations-postgres-admin-password" &&
    -f "$OPERATIONS_POSTGRES_ADMIN_PASSWORD_FILE" &&
    ! -L "$OPERATIONS_POSTGRES_ADMIN_PASSWORD_FILE" ]] ||
    fail "Operations PostgreSQL admin password file is missing or unsafe"
  [[ "$(cd "$(dirname "$OPERATIONS_POSTGRES_ADMIN_PASSWORD_FILE")" && pwd -P)" == "$APP_ROOT/deploy/backend" ]] ||
    fail "Operations PostgreSQL admin password parent must be canonical"
  [[ "$(uname -s)" == 'Linux' ]] ||
    fail "Operations PostgreSQL production prepare requires Linux"
  [[ "$(stat -c '%u:%g:%a:%h' "$OPERATIONS_POSTGRES_ADMIN_PASSWORD_FILE")" == '0:0:600:1' ]] ||
    fail "Operations PostgreSQL admin password file must be root:root mode 600 with one link"

  node <<'NODE'
const contracts = [
  ['OPERATIONS_DATABASE_URL', 'winwidget_operations_runtime'],
  ['OPERATIONS_MIGRATION_DATABASE_URL', 'winwidget_operations_migration'],
  ['OPERATIONS_BACKUP_URL', 'winwidget_operations_backup']
];
const passwords = new Set();
for (const [name, expectedUser] of contracts) {
  const url = new URL(process.env[name] || '');
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55441' ||
    url.pathname !== '/winwidget_operations' ||
    url.searchParams.get('schema') !== 'operations' ||
    url.searchParams.get('sslmode') !== 'disable' ||
    decodeURIComponent(url.username) !== expectedUser
  ) {
    throw new Error(`${name} violates the Operations database contract`);
  }
  const password = decodeURIComponent(url.password);
  if (password.length < 32 || password.startsWith('change_me')) {
    throw new Error(`${name} must contain a non-placeholder password`);
  }
  passwords.add(password);
}
if (passwords.size !== contracts.length) {
  throw new Error('Operations database roles must use distinct passwords');
}
NODE
}

assert_release_checkout() {
  local revision branch
  revision="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  branch="$(git -C "$ROOT_DIR" branch --show-current)"
  [[ "$revision" == "$OPERATIONS_REVISION" ]] ||
    fail "OPERATIONS_REVISION must match the exact checkout SHA"
  [[ "$branch" == 'prod' ]] || fail "Operations database prepare requires the prod branch"
  [[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]] ||
    fail "Operations database prepare requires a clean checkout"
}

compose() {
  docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    --profile operations-database \
    --profile operations-migration \
    "$@"
}

wait_for_database() {
  local container_id status
  container_id="$(compose ps -q operations-postgres)"
  [[ -n "$container_id" ]] || fail "operations-postgres did not start"
  for _ in $(seq 1 60); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
    [[ "$status" == healthy ]] && return 0
    [[ "$status" == unhealthy ]] && fail "operations-postgres is unhealthy"
    sleep 2
  done
  fail "operations-postgres readiness timed out"
}

emit_role_sql() {
  node <<'NODE'
const quoteLiteral = value => `'${value.replaceAll("'", "''")}'`;
const password = name => {
  const value = decodeURIComponent(new URL(process.env[name]).password);
  if (value.length < 32 || value.startsWith('change_me')) throw new Error('invalid password');
  return quoteLiteral(value);
};
const roles = [
  ['winwidget_operations_runtime', password('OPERATIONS_DATABASE_URL')],
  ['winwidget_operations_migration', password('OPERATIONS_MIGRATION_DATABASE_URL')],
  ['winwidget_operations_backup', password('OPERATIONS_BACKUP_URL')]
];
for (const [role, secret] of roles) {
  process.stdout.write(`DO $$ BEGIN\n`);
  process.stdout.write(`  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN\n`);
  process.stdout.write(`    ALTER ROLE "${role}" WITH LOGIN PASSWORD ${secret} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;\n`);
  process.stdout.write(`  ELSE\n`);
  process.stdout.write(`    CREATE ROLE "${role}" WITH LOGIN PASSWORD ${secret} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;\n`);
  process.stdout.write(`  END IF;\nEND $$;\n`);
}
NODE
}

psql_admin() {
  local container_id
  container_id="$(compose ps -q operations-postgres)"
  docker exec -i "$container_id" \
    psql --no-psqlrc --set=ON_ERROR_STOP=1 \
      --username "$OPERATIONS_POSTGRES_ADMIN_USER" \
      --dbname winwidget_operations "$@"
}

prepare_roles_and_schema() {
  emit_role_sql | psql_admin
  psql_admin <<'SQL'
REVOKE ALL ON DATABASE winwidget_operations FROM PUBLIC;
GRANT CONNECT ON DATABASE winwidget_operations TO
  winwidget_operations_runtime,
  winwidget_operations_migration,
  winwidget_operations_backup;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS operations AUTHORIZATION winwidget_operations_migration;
ALTER SCHEMA operations OWNER TO winwidget_operations_migration;
GRANT USAGE ON SCHEMA operations TO
  winwidget_operations_runtime,
  winwidget_operations_backup;
SQL
}

apply_runtime_acl() {
  psql_admin <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA operations
  TO winwidget_operations_runtime;
REVOKE ALL ON TABLE operations."_prisma_migrations"
  FROM winwidget_operations_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE operations.operations_ownership_state
  FROM winwidget_operations_runtime;
GRANT SELECT ON TABLE operations.operations_ownership_state
  TO winwidget_operations_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA operations
  TO winwidget_operations_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA operations
  TO winwidget_operations_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_operations_migration IN SCHEMA operations
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_operations_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_operations_migration IN SCHEMA operations
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO winwidget_operations_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE winwidget_operations_migration IN SCHEMA operations
  GRANT SELECT ON TABLES TO winwidget_operations_backup;
REVOKE CREATE ON SCHEMA operations FROM winwidget_operations_runtime;
REVOKE CREATE ON SCHEMA operations FROM winwidget_operations_backup;
SQL
}

verify_database() {
  local verification
  verification="$(psql_admin --tuples-only --no-align <<'SQL'
SELECT
  current_setting('server_version_num')::integer / 10000,
  current_setting('data_checksums'),
  count(*) FILTER (WHERE rolname IN (
    'winwidget_operations_runtime',
    'winwidget_operations_migration',
    'winwidget_operations_backup'
  )),
  count(*) FILTER (
    WHERE rolname IN (
      'winwidget_operations_runtime',
      'winwidget_operations_migration',
      'winwidget_operations_backup'
    )
      AND rolcanlogin
      AND NOT rolsuper
      AND NOT rolcreatedb
      AND NOT rolcreaterole
      AND NOT rolinherit
      AND NOT rolreplication
      AND NOT rolbypassrls
  ),
  has_table_privilege(
    'winwidget_operations_runtime',
    'operations.operations_ownership_state',
    'SELECT'
  ),
  NOT (
    has_table_privilege(
      'winwidget_operations_runtime',
      'operations.operations_ownership_state',
      'INSERT'
    )
    OR has_table_privilege(
      'winwidget_operations_runtime',
      'operations.operations_ownership_state',
      'UPDATE'
    )
    OR has_table_privilege(
      'winwidget_operations_runtime',
      'operations.operations_ownership_state',
      'DELETE'
    )
    OR has_table_privilege(
      'winwidget_operations_runtime',
      'operations.operations_ownership_state',
      'TRUNCATE'
    )
  ),
  NOT (
    has_table_privilege(
      'winwidget_operations_runtime',
      'operations._prisma_migrations',
      'SELECT'
    )
    OR has_table_privilege(
      'winwidget_operations_runtime',
      'operations._prisma_migrations',
      'INSERT'
    )
    OR has_table_privilege(
      'winwidget_operations_runtime',
      'operations._prisma_migrations',
      'UPDATE'
    )
    OR has_table_privilege(
      'winwidget_operations_runtime',
      'operations._prisma_migrations',
      'DELETE'
    )
    OR has_table_privilege(
      'winwidget_operations_runtime',
      'operations._prisma_migrations',
      'TRUNCATE'
    )
    OR has_table_privilege(
      'winwidget_operations_runtime',
      'operations._prisma_migrations',
      'REFERENCES'
    )
    OR has_table_privilege(
      'winwidget_operations_runtime',
      'operations._prisma_migrations',
      'TRIGGER'
    )
  ),
  pg_get_userbyid(
    (SELECT nspowner FROM pg_namespace WHERE nspname = 'operations')
  ) = 'winwidget_operations_migration',
  (
    SELECT bool_and(
      has_table_privilege('winwidget_operations_runtime', table_name, 'SELECT')
      AND has_table_privilege('winwidget_operations_runtime', table_name, 'INSERT')
      AND has_table_privilege('winwidget_operations_runtime', table_name, 'UPDATE')
      AND has_table_privilege('winwidget_operations_runtime', table_name, 'DELETE')
      AND NOT has_table_privilege('winwidget_operations_runtime', table_name, 'TRUNCATE')
    )
    FROM unnest(ARRAY[
      'operations.notes',
      'operations.admin_event_logs',
      'operations.audit_event_receipts',
      'operations.outbox_events'
    ]) AS runtime_table(table_name)
  ),
  (
    SELECT bool_and(
      has_table_privilege('winwidget_operations_backup', table_name, 'SELECT')
      AND NOT has_table_privilege('winwidget_operations_backup', table_name, 'INSERT')
      AND NOT has_table_privilege('winwidget_operations_backup', table_name, 'UPDATE')
      AND NOT has_table_privilege('winwidget_operations_backup', table_name, 'DELETE')
      AND NOT has_table_privilege('winwidget_operations_backup', table_name, 'TRUNCATE')
    )
    FROM unnest(ARRAY[
      'operations.notes',
      'operations.admin_event_logs',
      'operations.audit_event_receipts',
      'operations.outbox_events',
      'operations.operations_ownership_state'
    ]) AS backup_table(table_name)
	)
FROM pg_roles;
SQL
  )" || return 1
  [[ "$verification" == '18|on|3|3|t|t|t|t|t|t' ]]
}

self_test() {
  local image='postgres:18-bookworm@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  local revision='a234567890123456789012345678901234567890'
  local acl_source
  acl_source="$(declare -f apply_runtime_acl)"
  [[ "$image" == postgres:18-*'@sha256:'* ]]
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]]
  [[ "$(declare -f validate_contract)" == *"stat -c '%u:%g:%a:%h'"* &&
    "$(declare -f validate_contract)" == *"'0:0:600:1'"* &&
    "$(declare -f validate_contract)" == *'password parent must be canonical'* ]]
  [[ "$acl_source" == *'REVOKE ALL ON TABLE operations."_prisma_migrations"'* &&
    "$acl_source" == *'REVOKE INSERT, UPDATE, DELETE, TRUNCATE'* &&
    "$acl_source" == *'operations.operations_ownership_state'* &&
    "$acl_source" == *'GRANT SELECT ON TABLE operations.operations_ownership_state'* ]]
  printf 'operations-database-prepare self-test passed\n'
}

main() {
  case "${1:-}" in
    --self-test)
      self_test
      ;;
    --prepare)
      require_command docker
      require_command node
      require_command grep
      load_env
      validate_contract
      assert_release_checkout
      # shellcheck source=scripts/production-deploy-lock.sh
      source "$ROOT_DIR/scripts/production-deploy-lock.sh"
      acquire_production_deploy_lock 'Operations database prepare'
      docker volume inspect "$OPERATIONS_POSTGRES_DATA_VOLUME" > /dev/null 2>&1 ||
        docker volume create \
          --label com.winwidget.owner=operations \
          --label com.winwidget.purpose=postgres-data \
          "$OPERATIONS_POSTGRES_DATA_VOLUME" > /dev/null
      compose up -d operations-postgres
      wait_for_database
      prepare_roles_and_schema
      compose run --rm --no-deps operations-migrate
      apply_runtime_acl
      verify_database || fail "Operations PostgreSQL verification failed"
      printf 'Operations PostgreSQL 18 roles, schema and migrations are ready\n'
      ;;
    *)
      fail 'usage: operations-database-prepare.sh --self-test|--prepare'
      ;;
  esac
}

main "$@"
