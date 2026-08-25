#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_ROOT="${APP_ROOT:-/opt/winwidget}"
SERVER_ROOT="${SERVER_ROOT:-$APP_ROOT/winwidget.ru_server}"
ENV_FILE="${OPERATIONS_ENV_FILE:-$APP_ROOT/deploy/backend/.env.production}"
COMPOSE_FILE="${OPERATIONS_COMPOSE_FILE:-$SERVER_ROOT/deploy/docker-compose.prod.yml}"
CONFIRMATION='CUT OVER OPERATIONS FORWARD ONLY'
PLATFORM_TERMINAL_CONFIRMATION='DROP PLATFORM CORE SOURCE DURING OPERATIONS CUTOVER'
CONTAINER_ARTIFACT_DIR='/var/lib/winwidget/operations-cutover'
readonly PLATFORM_TERMINAL_MIGRATION='20260825000000_remove_legacy_platform_core_source'
readonly OPERATIONS_PREP_MIGRATION='20260824030000_prepare_operations_service_ownership'
readonly PLATFORM_TERMINAL_MARKER_NAME='.platform-core-source-terminal-v1'
readonly PLATFORM_PREPARED_RECOVERY_CONFIRMATION='RECOVER EXACT PREPARED PLATFORM MARKER'
readonly -a PLATFORM_TERMINAL_MARKER_KEYS=(
  version phase ownership_revision cleanup_revision production_env_sha256
  compose_sha256 core_database_name core_database_system_identifier generation
  migration migration_sha256 snapshot_sha256 source_fingerprint
  source_high_watermark billing_offer_contract_version
  billing_offer_sequence_scope billing_offer_aggregate_version
  billing_offer_source_sequence billing_offer_fence_fingerprint
  before_inventory after_inventory prisma_migration_id created_at updated_at
)
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
  [[ "$(id -u)" == '0' && "$(uname -s)" == Linux ]] ||
    fail 'production cutover must run as root on Linux'
  [[ -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" &&
    "$(docker context show)" == default &&
    "$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock' &&
    "$(docker info --format '{{.OSType}}')" == linux ]] ||
    fail 'canonical local production Docker daemon is required'
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

load_platform_terminal_dependencies() {
  local migration_file operations_migration_file
  migration_file="$SERVER_ROOT/prisma/migrations/$PLATFORM_TERMINAL_MIGRATION/migration.sql"
  operations_migration_file="$SERVER_ROOT/prisma/migrations/$OPERATIONS_PREP_MIGRATION/migration.sql"
  [[ -f "$migration_file" && ! -L "$migration_file" ]] ||
    fail 'terminal Platform migration is missing or unsafe'
  [[ -f "$operations_migration_file" && ! -L "$operations_migration_file" ]] ||
    fail 'Operations Core prepare migration is missing or unsafe'
  export EXPECTED_REVISION="${EXPECTED_REVISION:-}"
  export PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION="$PLATFORM_TERMINAL_MIGRATION"
  export PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256
  export PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256
  export PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256
  export OPERATIONS_PREP_MIGRATION_SHA256
  if ! declare -F platform_cleanup_source_state >/dev/null; then
    # shellcheck source=scripts/cleanup-platform-core-source-production.sh
    source "$SERVER_ROOT/scripts/cleanup-platform-core-source-production.sh"
  fi
  platform_cleanup_load_dependencies
  PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256="$(
    platform_cleanup_sha256 "$migration_file"
  )" || fail 'terminal Platform migration SHA-256 cannot be computed'
  OPERATIONS_PREP_MIGRATION_SHA256="$(
    platform_cleanup_sha256 "$operations_migration_file"
  )" || fail 'Operations Core prepare migration SHA-256 cannot be computed'
  PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256="$(
    platform_cleanup_sha256 "$ENV_FILE"
  )" || fail 'backend production env SHA-256 cannot be computed'
  PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256="$(
    platform_cleanup_sha256 "$COMPOSE_FILE"
  )" || fail 'production Compose SHA-256 cannot be computed'
  [[ "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" =~ ^[0-9a-f]{64}$ &&
    "$OPERATIONS_PREP_MIGRATION_SHA256" =~ ^[0-9a-f]{64}$ &&
    "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ &&
    "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'terminal Platform identities are invalid'
}

platform_terminal_marker_path() {
  printf '%s/deploy/backend/%s\n' "$APP_ROOT" "$PLATFORM_TERMINAL_MARKER_NAME"
}

platform_terminal_assert_files_unchanged() {
  local migration_file="$SERVER_ROOT/prisma/migrations/$PLATFORM_TERMINAL_MIGRATION/migration.sql"
  assert_checkout "$EXPECTED_REVISION"
  [[ -f "$migration_file" && ! -L "$migration_file" &&
    "$(platform_cleanup_sha256 "$migration_file")" == "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" &&
    "$(platform_cleanup_sha256 "$ENV_FILE")" == "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" &&
    "$(platform_cleanup_sha256 "$COMPOSE_FILE")" == "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" ]]
}

platform_terminal_marker_value() {
  local marker key="$1"
  [[ $# -eq 1 && "$key" =~ ^[a-z][a-z0-9_]*$ ]] || return 1
  marker="$(platform_terminal_marker_path)" || return 1
  platform_terminal_validate_marker "$marker" || return 1
  awk -F= -v key="$key" '
    $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
    END { exit(found == 1 ? 0 : 1) }
  ' "$marker"
}

platform_terminal_validate_marker() {
  local marker="${1:-$(platform_terminal_marker_path)}" directory
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  directory="$(dirname -- "$marker")"
  [[ "$(cd -- "$directory" && pwd -P)" == "$APP_ROOT/deploy/backend" &&
    "$(stat -c '%u:%g:%a:%h' "$marker")" == '0:0:600:1' ]] || return 1
  awk -F= -v expected="${#PLATFORM_TERMINAL_MARKER_KEYS[@]}" \
    -v expected_order="${PLATFORM_TERMINAL_MARKER_KEYS[*]}" '
    function hex(value, length_) {
      return length(value) == length_ && value ~ /^[0-9a-f]+$/ && value !~ /^0+$/
    }
    BEGIN { split(expected_order, order, " ") }
    $1 != order[NR] { exit 1 }
    $1 !~ /^(version|phase|ownership_revision|cleanup_revision|production_env_sha256|compose_sha256|core_database_name|core_database_system_identifier|generation|migration|migration_sha256|snapshot_sha256|source_fingerprint|source_high_watermark|billing_offer_contract_version|billing_offer_sequence_scope|billing_offer_aggregate_version|billing_offer_source_sequence|billing_offer_fence_fingerprint|before_inventory|after_inventory|prisma_migration_id|created_at|updated_at)$/ { exit 1 }
    { seen[$1] += 1; value[$1] = substr($0, index($0, "=") + 1) }
    END {
      if (NR != expected || value["version"] != "1" ||
        value["phase"] !~ /^(prepared|complete)$/ ||
        !hex(value["ownership_revision"], 40) ||
        !hex(value["cleanup_revision"], 40) ||
        value["ownership_revision"] == value["cleanup_revision"] ||
        !hex(value["production_env_sha256"], 64) ||
        !hex(value["compose_sha256"], 64) ||
        value["core_database_name"] != "default_db" ||
        value["core_database_system_identifier"] !~ /^[1-9][0-9]*$/ ||
        value["generation"] !~ /^[1-9][0-9]{0,17}$/ ||
        value["migration"] != "20260825000000_remove_legacy_platform_core_source" ||
        !hex(value["migration_sha256"], 64) ||
        !hex(value["snapshot_sha256"], 64) ||
        !hex(value["source_fingerprint"], 64) ||
        value["source_high_watermark"] !~ /^[1-9][0-9]*$/ ||
        value["billing_offer_contract_version"] != "2" ||
        value["billing_offer_sequence_scope"] != "billing.offer:offer" ||
        value["billing_offer_aggregate_version"] !~ /^[1-9][0-9]*$/ ||
        value["billing_offer_source_sequence"] !~ /^[1-9][0-9]*$/ ||
        !hex(value["billing_offer_fence_fingerprint"], 64) ||
        value["before_inventory"] != "platform-source-v1-present" ||
        value["created_at"] !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/ ||
        value["updated_at"] !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/) exit 1
      for (key in seen) if (seen[key] != 1) exit 1
      if (value["phase"] == "prepared" &&
        (value["after_inventory"] != "pending" ||
         value["prisma_migration_id"] != "pending" ||
         value["created_at"] != value["updated_at"])) exit 1
      if (value["phase"] == "complete" &&
        (value["after_inventory"] != "platform-source-v1-absent" ||
         value["prisma_migration_id"] !~ /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)) exit 1
    }
  ' "$marker"
}

platform_terminal_write_marker() {
  local phase="$1" prisma_id="$2" marker directory temporary now created_at
  [[ "$phase" =~ ^(prepared|complete)$ ]] || return 1
  [[ "$prisma_id" == pending ||
    "$prisma_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1
  marker="$(platform_terminal_marker_path)"
  directory="$(dirname -- "$marker")"
  [[ -d "$directory" && ! -L "$directory" &&
    "$(cd -- "$directory" && pwd -P)" == "$APP_ROOT/deploy/backend" ]] || return 1
  if [[ -e "$marker" || -L "$marker" ]]; then
    platform_terminal_validate_marker "$marker" || return 1
    [[ "$(platform_terminal_marker_value phase)" == prepared && "$phase" == complete ]] || {
      [[ "$(platform_terminal_marker_value phase)" == "$phase" ]] && return 0
      return 1
    }
    created_at="$(platform_terminal_marker_value created_at)"
  else
    [[ "$phase" == prepared ]] || return 1
    created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  fi
  now="$created_at"
  [[ "$phase" == prepared ]] || now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  temporary="$(mktemp "$directory/$PLATFORM_TERMINAL_MARKER_NAME.tmp.XXXXXX")"
  {
    printf 'version=1\nphase=%s\n' "$phase"
    printf 'ownership_revision=%s\ncleanup_revision=%s\n' \
      "$PLATFORM_TERMINAL_OWNERSHIP_REVISION" "$EXPECTED_REVISION"
    printf 'production_env_sha256=%s\ncompose_sha256=%s\n' \
      "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" \
      "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256"
    printf 'core_database_name=%s\ncore_database_system_identifier=%s\n' \
      "$PLATFORM_TERMINAL_DATABASE_NAME" "$PLATFORM_TERMINAL_DATABASE_SYSTEM_IDENTIFIER"
    printf 'generation=%s\nmigration=%s\nmigration_sha256=%s\n' \
      "$PLATFORM_TERMINAL_GENERATION" "$PLATFORM_TERMINAL_MIGRATION" \
      "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256"
    printf 'snapshot_sha256=%s\nsource_fingerprint=%s\nsource_high_watermark=%s\n' \
      "$PLATFORM_TERMINAL_SNAPSHOT_SHA256" "$PLATFORM_TERMINAL_SOURCE_FINGERPRINT" \
      "$PLATFORM_TERMINAL_SOURCE_HIGH_WATERMARK"
    printf 'billing_offer_contract_version=2\n'
    printf 'billing_offer_sequence_scope=billing.offer:offer\n'
    printf 'billing_offer_aggregate_version=%s\n' "$PLATFORM_TERMINAL_BILLING_AGGREGATE_VERSION"
    printf 'billing_offer_source_sequence=%s\n' "$PLATFORM_TERMINAL_BILLING_SOURCE_SEQUENCE"
    printf 'billing_offer_fence_fingerprint=%s\n' "$PLATFORM_TERMINAL_BILLING_FENCE_FINGERPRINT"
    printf 'before_inventory=platform-source-v1-present\n'
    if [[ "$phase" == complete ]]; then
      printf 'after_inventory=platform-source-v1-absent\n'
    else
      printf 'after_inventory=pending\n'
    fi
    printf 'prisma_migration_id=%s\ncreated_at=%s\nupdated_at=%s\n' \
      "$prisma_id" "$created_at" "$now"
  } >"$temporary"
  chmod 600 "$temporary"
  chown 0:0 "$temporary"
  platform_terminal_validate_marker "$temporary" || { rm -f -- "$temporary"; return 1; }
  sync -f "$temporary"
  mv -fT -- "$temporary" "$marker"
  sync -f "$directory"
  platform_terminal_validate_marker "$marker"
}

platform_terminal_git_file_sha256() {
  [[ $# -eq 2 ]] || return 1
  [[ "$1" =~ ^[0-9a-f]{40}$ &&
    "$2" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
  git -C "$SERVER_ROOT" show "$1:$2" | sha256sum | awk 'NR == 1 { print $1 }'
}

platform_terminal_prepared_recovery_archive_path() {
  [[ $# -eq 1 ]] || return 1
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s/deploy/backend/.production-evidence/platform-terminal-prepared-recovery-%s/prepared-marker.evidence\n' \
    "$APP_ROOT" "$1"
}

platform_terminal_archive_prepared_marker() {
  [[ $# -eq 3 ]] || return 1
  [[ "$1" == "$(platform_terminal_marker_path)" &&
    "$2" =~ ^[0-9a-f]{40}$ && "$3" =~ ^[0-9a-f]{64}$ ]] || return 1
  local marker="$1" ancestor="$2" expected_sha="$3" archive directory parent grandparent temporary
  archive="$(platform_terminal_prepared_recovery_archive_path "$ancestor")" || return 1
  directory="$(dirname -- "$archive")"
  parent="$(dirname -- "$directory")"
  grandparent="$(dirname -- "$parent")"
  platform_cleanup_prepare_private_directory "$directory" || return 1
  if [[ -e "$archive" || -L "$archive" ]]; then
    platform_cleanup_validate_private_file "$archive" || return 1
    [[ "$(platform_cleanup_sha256 "$archive")" == "$expected_sha" ]] || return 1
    sync -f "$archive" || return 1
    sync -f "$directory" || return 1
    sync -f "$parent" || return 1
    sync -f "$grandparent" || return 1
    printf '%s\n' "$archive"
    return
  fi
  temporary="$(mktemp "$directory/.prepared-marker.partial.XXXXXX")" || return 1
  cp -- "$marker" "$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  chmod 600 "$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  chown 0:0 "$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  [[ "$(platform_cleanup_sha256 "$temporary")" == "$expected_sha" ]] || {
    rm -f -- "$temporary"
    return 1
  }
  sync -f "$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  mv -fT -- "$temporary" "$archive" || {
    rm -f -- "$temporary"
    return 1
  }
  sync -f "$archive" || return 1
  sync -f "$directory" || return 1
  sync -f "$parent" || return 1
  sync -f "$grandparent" || return 1
  platform_cleanup_validate_private_file "$archive" || return 1
  [[ "$(platform_cleanup_sha256 "$archive")" == "$expected_sha" ]] || return 1
  printf '%s\n' "$archive"
}

platform_terminal_rebind_prepared_marker() {
  [[ $# -eq 4 ]] || return 1
  [[ "$1" =~ ^[0-9a-f]{40}$ && "$1" == "$EXPECTED_REVISION" &&
    "$2" == "$(platform_terminal_prepared_recovery_archive_path "$4")" &&
    "$3" =~ ^[0-9a-f]{64}$ && "$4" =~ ^[0-9a-f]{40}$ ]] || return 1
  local marker directory temporary created_at archive="$2" expected_sha="$3" ancestor="$4"
  marker="$(platform_terminal_marker_path)"
  platform_terminal_validate_marker "$marker" || return 1
  platform_cleanup_validate_private_file "$archive" || return 1
  [[ "$(platform_terminal_marker_value phase)" == prepared &&
    "$(platform_terminal_marker_value cleanup_revision)" == "$ancestor" &&
    "$(platform_cleanup_sha256 "$marker")" == "$expected_sha" &&
    "$(platform_cleanup_sha256 "$archive")" == "$expected_sha" ]] || return 1
  created_at="$(platform_terminal_marker_value created_at)" || return 1
  directory="$(dirname -- "$marker")"
  temporary="$(mktemp "$directory/$PLATFORM_TERMINAL_MARKER_NAME.rebind.XXXXXX")" || return 1
  {
    printf 'version=1\nphase=prepared\n'
    printf 'ownership_revision=%s\ncleanup_revision=%s\n' \
      "$PLATFORM_TERMINAL_OWNERSHIP_REVISION" "$EXPECTED_REVISION"
    printf 'production_env_sha256=%s\ncompose_sha256=%s\n' \
      "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" \
      "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256"
    printf 'core_database_name=%s\ncore_database_system_identifier=%s\n' \
      "$PLATFORM_TERMINAL_DATABASE_NAME" "$PLATFORM_TERMINAL_DATABASE_SYSTEM_IDENTIFIER"
    printf 'generation=%s\nmigration=%s\nmigration_sha256=%s\n' \
      "$PLATFORM_TERMINAL_GENERATION" "$PLATFORM_TERMINAL_MIGRATION" \
      "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256"
    printf 'snapshot_sha256=%s\nsource_fingerprint=%s\nsource_high_watermark=%s\n' \
      "$PLATFORM_TERMINAL_SNAPSHOT_SHA256" "$PLATFORM_TERMINAL_SOURCE_FINGERPRINT" \
      "$PLATFORM_TERMINAL_SOURCE_HIGH_WATERMARK"
    printf 'billing_offer_contract_version=2\n'
    printf 'billing_offer_sequence_scope=billing.offer:offer\n'
    printf 'billing_offer_aggregate_version=%s\n' "$PLATFORM_TERMINAL_BILLING_AGGREGATE_VERSION"
    printf 'billing_offer_source_sequence=%s\n' "$PLATFORM_TERMINAL_BILLING_SOURCE_SEQUENCE"
    printf 'billing_offer_fence_fingerprint=%s\n' "$PLATFORM_TERMINAL_BILLING_FENCE_FINGERPRINT"
    printf 'before_inventory=platform-source-v1-present\nafter_inventory=pending\n'
    printf 'prisma_migration_id=pending\ncreated_at=%s\nupdated_at=%s\n' \
      "$created_at" "$created_at"
  } >"$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  chmod 600 "$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  chown 0:0 "$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  platform_terminal_validate_marker "$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  sync -f "$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  mv -fT -- "$temporary" "$marker" || {
    rm -f -- "$temporary"
    return 1
  }
  sync -f "$marker" || return 1
  sync -f "$directory" || return 1
  [[ "$(platform_terminal_assert_marker_identity creation)" == prepared ]]
}

platform_terminal_recover_pinned_prepared_marker() {
  [[ $# -eq 4 ]] || return 1
  [[ "$1" =~ ^[0-9a-f]{40}$ &&
    "$2" =~ ^(present|absent)$ &&
    "$3" =~ ^(pending|failed|rolled-back|applied)$ &&
    "$4" =~ ^(absent|pristine|forward|unsafe)$ ]] || return 1
  local revision="$1" source_state="$2" migration_state="$3" operations_schema="$4"
  local ancestor intermediate expected_marker_sha expected_env_sha expected_script_sha
  local marker cleanup_revision phase archive operations_state guards running
  local marker_directory archive_directory archive_parent archive_grandparent
  local migration_path compose_path script_path revision_sha marker_migration_sha marker_compose_sha
  local candidate changed_paths
  [[ "${OPERATIONS_PLATFORM_PREPARED_RECOVERY_CONFIRMATION:-}" == \
    "$PLATFORM_PREPARED_RECOVERY_CONFIRMATION" ]] || return 1
  ancestor="${OPERATIONS_PLATFORM_PREPARED_ANCESTOR_REVISION:-}"
  intermediate="${OPERATIONS_PLATFORM_PREPARED_INTERMEDIATE_REVISION:-}"
  expected_marker_sha="${OPERATIONS_PLATFORM_PREPARED_MARKER_SHA256:-}"
  expected_env_sha="${OPERATIONS_PLATFORM_PREPARED_ENV_SHA256:-}"
  expected_script_sha="${OPERATIONS_PLATFORM_PREPARED_FINAL_SCRIPT_SHA256:-}"
  [[ "$ancestor" =~ ^[0-9a-f]{40}$ && "$intermediate" =~ ^[0-9a-f]{40}$ &&
    "$expected_marker_sha" =~ ^[0-9a-f]{64}$ &&
    "$expected_env_sha" =~ ^[0-9a-f]{64}$ &&
    "$expected_script_sha" =~ ^[0-9a-f]{64}$ &&
    "$ancestor" != "$intermediate" && "$intermediate" != "$revision" &&
    "$(git -C "$SERVER_ROOT" rev-list --parents -n 1 "$intermediate")" == \
      "$intermediate $ancestor" &&
    "$(git -C "$SERVER_ROOT" rev-list --parents -n 1 "$revision")" == \
      "$revision $intermediate" ]] || return 1
  script_path='scripts/operations-cutover-production.sh'
  changed_paths="$(git -C "$SERVER_ROOT" diff --name-only "$ancestor" "$revision")" || return 1
  [[ "$changed_paths" == "$script_path" &&
    "$(platform_terminal_git_file_sha256 "$revision" "$script_path")" == "$expected_script_sha" &&
    "$(platform_cleanup_sha256 "$SERVER_ROOT/$script_path")" == "$expected_script_sha" ]] || return 1
  migration_path="prisma/migrations/$PLATFORM_TERMINAL_MIGRATION/migration.sql"
  compose_path='deploy/docker-compose.prod.yml'
  marker="$(platform_terminal_marker_path)"
  platform_terminal_validate_marker "$marker" || return 1
  marker_migration_sha="$(platform_terminal_marker_value migration_sha256)" || return 1
  marker_compose_sha="$(platform_terminal_marker_value compose_sha256)" || return 1
  for candidate in "$ancestor" "$intermediate" "$revision"; do
    revision_sha="$(platform_terminal_git_file_sha256 "$candidate" "$migration_path")" || return 1
    [[ "$revision_sha" == "$marker_migration_sha" &&
      "$revision_sha" == "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" ]] || return 1
    revision_sha="$(platform_terminal_git_file_sha256 "$candidate" "$compose_path")" || return 1
    [[ "$revision_sha" == "$marker_compose_sha" &&
      "$revision_sha" == "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" ]] || return 1
  done
  cleanup_revision="$(platform_terminal_marker_value cleanup_revision)" || return 1
  phase="$(platform_terminal_marker_value phase)" || return 1
  archive="$(platform_terminal_prepared_recovery_archive_path "$ancestor")" || return 1
  marker_directory="$(dirname -- "$marker")"
  archive_directory="$(dirname -- "$archive")"
  archive_parent="$(dirname -- "$archive_directory")"
  archive_grandparent="$(dirname -- "$archive_parent")"
  if [[ "$cleanup_revision" == "$revision" ]]; then
    platform_cleanup_validate_private_file "$archive" || return 1
    [[ "$(platform_cleanup_sha256 "$archive")" == "$expected_marker_sha" &&
      "$(platform_terminal_assert_marker_identity creation)" == "$phase" &&
      "$phase" =~ ^(prepared|complete)$ ]] || return 1
    sync -f "$marker" || return 1
    sync -f "$marker_directory" || return 1
    sync -f "$archive" || return 1
    sync -f "$archive_directory" || return 1
    sync -f "$archive_parent" || return 1
    sync -f "$archive_grandparent" || return 1
    return
  fi
  [[ "$cleanup_revision" == "$ancestor" && "$phase" == prepared &&
    "$(platform_cleanup_sha256 "$marker")" == "$expected_marker_sha" &&
    "$(platform_terminal_marker_value production_env_sha256)" == "$expected_env_sha" &&
    "$(platform_terminal_assert_marker_identity descendant)" == prepared &&
    "$source_state" == present && "$migration_state" == pending &&
    "$operations_schema" == absent ]] || return 1
  operations_state="$(platform_terminal_candidate_migration_state \
    "$OPERATIONS_PREP_MIGRATION" "$OPERATIONS_PREP_MIGRATION_SHA256")" || return 1
  [[ "$operations_state" == pending ]] || return 1
  platform_terminal_assert_exact_repo_ledger pending pending creation || return 1
  platform_cleanup_assert_retained_billing_seam || return 1
  platform_terminal_assert_files_unchanged || return 1
  running="$(compose ps --status running -q api outbox-publisher integration-worker)" || return 1
  [[ -z "$running" ]] || return 1
  guards="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT count(*) FILTER (
  WHERE role.rolname='gen_user' AND config LIKE 'winwidget.platform_%'
)::text || '|' || count(*) FILTER (
  WHERE role.rolname='gen_user' AND config LIKE 'winwidget.operations_platform_%'
)::text
FROM pg_catalog.pg_db_role_setting setting
JOIN pg_catalog.pg_roles role ON role.oid=setting.setrole
JOIN pg_catalog.pg_database database ON database.oid=setting.setdatabase
CROSS JOIN LATERAL unnest(setting.setconfig) config
WHERE database.datname='default_db';")" || return 1
  [[ "$guards" == '0|0' ]] || return 1
  archive="$(platform_terminal_archive_prepared_marker \
    "$marker" "$ancestor" "$expected_marker_sha")" || return 1
  platform_cleanup_validate_private_file "$archive" || return 1
  [[ "$(platform_cleanup_sha256 "$archive")" == "$expected_marker_sha" ]] || return 1
  platform_terminal_rebind_prepared_marker \
    "$revision" "$archive" "$expected_marker_sha" "$ancestor" || return 1
  [[ "$(platform_cleanup_sha256 "$archive")" == "$expected_marker_sha" &&
    "$(platform_terminal_assert_marker_identity creation)" == prepared ]]
}

platform_terminal_marker_retry_mode() {
  [[ $# -eq 5 ]] || return 1
  local cleanup_revision="$1" revision="$2" phase="$3" source_state="$4" migration_state="$5"
  [[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ &&
    "$revision" =~ ^[0-9a-f]{40}$ &&
    "$phase" =~ ^(prepared|complete)$ &&
    "$source_state" =~ ^(present|absent)$ &&
    "$migration_state" =~ ^(pending|failed|rolled-back|applied)$ ]] || return 1
  if [[ "$cleanup_revision" == "$revision" ]]; then
    printf 'creation\n'
    return
  fi
  case "$phase:$source_state:$migration_state" in
    prepared:*) printf 'prepared-recovery\n' ;;
    complete:absent:applied) printf 'descendant\n' ;;
    *) return 1 ;;
  esac
}

platform_terminal_load_ownership_context() {
  local identity anchor
  platform_database_validate_marker
  platform_cutover_validate_marker
  [[ "$(platform_database_current_phase)" == complete &&
    "$(platform_cutover_current_phase)" == complete ]] || return 1
  PLATFORM_TERMINAL_OWNERSHIP_REVISION="$(platform_cutover_marker_value revision)"
  [[ "$PLATFORM_TERMINAL_OWNERSHIP_REVISION" == "$(platform_database_marker_value revision)" &&
    "$PLATFORM_TERMINAL_OWNERSHIP_REVISION" != "$EXPECTED_REVISION" ]] || return 1
  git -C "$SERVER_ROOT" merge-base --is-ancestor \
    "$PLATFORM_TERMINAL_OWNERSHIP_REVISION" "$EXPECTED_REVISION" || return 1
  PLATFORM_TERMINAL_GENERATION="$(platform_cutover_marker_value generation)"
  [[ "$PLATFORM_TERMINAL_GENERATION" == "$(platform_database_marker_value generation)" ]] || return 1
  PLATFORM_TERMINAL_SNAPSHOT_SHA256="$(platform_cutover_marker_value snapshot_sha256)"
  PLATFORM_TERMINAL_SOURCE_FINGERPRINT="$(platform_cutover_marker_value source_fingerprint)"
  PLATFORM_TERMINAL_SOURCE_HIGH_WATERMARK="$(platform_cutover_marker_value source_high_watermark)"
  identity="$(platform_cleanup_core_database_identity)" || return 1
  IFS='|' read -r PLATFORM_TERMINAL_DATABASE_NAME \
    PLATFORM_TERMINAL_DATABASE_SYSTEM_IDENTIFIER <<<"$identity"
  [[ "$PLATFORM_TERMINAL_DATABASE_NAME" == default_db &&
    "$PLATFORM_TERMINAL_DATABASE_SYSTEM_IDENTIFIER" =~ ^[1-9][0-9]*$ ]] || return 1
  if [[ "$(platform_cleanup_source_state)" == present ]]; then
    anchor="$(platform_cleanup_core_ownership_anchor)" || return 1
    IFS='|' read -r PLATFORM_TERMINAL_ANCHOR_GENERATION \
      PLATFORM_TERMINAL_BILLING_CONTRACT_VERSION \
      PLATFORM_TERMINAL_BILLING_SEQUENCE_SCOPE \
      PLATFORM_TERMINAL_BILLING_AGGREGATE_VERSION \
      PLATFORM_TERMINAL_BILLING_SOURCE_SEQUENCE \
      PLATFORM_TERMINAL_BILLING_FENCE_FINGERPRINT <<<"$anchor"
    [[ "$PLATFORM_TERMINAL_ANCHOR_GENERATION" == "$PLATFORM_TERMINAL_GENERATION" &&
      "$PLATFORM_TERMINAL_BILLING_CONTRACT_VERSION" == 2 &&
      "$PLATFORM_TERMINAL_BILLING_SEQUENCE_SCOPE" == 'billing.offer:offer' ]] || return 1
  fi
}

platform_terminal_load_marker_billing_context() {
  PLATFORM_TERMINAL_BILLING_AGGREGATE_VERSION="$(
    platform_terminal_marker_value billing_offer_aggregate_version
  )" || return 1
  PLATFORM_TERMINAL_BILLING_SOURCE_SEQUENCE="$(
    platform_terminal_marker_value billing_offer_source_sequence
  )" || return 1
  PLATFORM_TERMINAL_BILLING_FENCE_FINGERPRINT="$(
    platform_terminal_marker_value billing_offer_fence_fingerprint
  )" || return 1
}

platform_terminal_assert_marker_identity() {
  local mode="${1:-creation}" marker phase cleanup_revision marker_aggregate
  local marker_sequence marker_fence historical_migration_sha historical_compose_sha
  [[ "$mode" =~ ^(creation|descendant)$ ]] || return 1
  marker="$(platform_terminal_marker_path)"
  platform_terminal_validate_marker "$marker" || return 1
  phase="$(platform_terminal_marker_value phase)" || return 1
  cleanup_revision="$(platform_terminal_marker_value cleanup_revision)" || return 1
  [[ "$(platform_terminal_marker_value ownership_revision)" == "$PLATFORM_TERMINAL_OWNERSHIP_REVISION" &&
    "$(platform_terminal_marker_value core_database_name)" == "$PLATFORM_TERMINAL_DATABASE_NAME" &&
    "$(platform_terminal_marker_value core_database_system_identifier)" == "$PLATFORM_TERMINAL_DATABASE_SYSTEM_IDENTIFIER" &&
    "$(platform_terminal_marker_value generation)" == "$PLATFORM_TERMINAL_GENERATION" &&
    "$(platform_terminal_marker_value migration_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" &&
    "$(platform_terminal_marker_value snapshot_sha256)" == "$PLATFORM_TERMINAL_SNAPSHOT_SHA256" &&
    "$(platform_terminal_marker_value source_fingerprint)" == "$PLATFORM_TERMINAL_SOURCE_FINGERPRINT" &&
    "$(platform_terminal_marker_value source_high_watermark)" == "$PLATFORM_TERMINAL_SOURCE_HIGH_WATERMARK" ]] || return 1
  if [[ "$mode" == creation ]]; then
    [[ "$cleanup_revision" == "$EXPECTED_REVISION" &&
      "$(platform_terminal_marker_value production_env_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256" &&
      "$(platform_terminal_marker_value compose_sha256)" == "$PLATFORM_CORE_SOURCE_CLEANUP_COMPOSE_EXPECTED_SHA256" ]] || return 1
  else
    [[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ && "$cleanup_revision" != "$EXPECTED_REVISION" ]] || return 1
    git -C "$SERVER_ROOT" merge-base --is-ancestor "$cleanup_revision" "$EXPECTED_REVISION" || return 1
    historical_migration_sha="$(
      git -C "$SERVER_ROOT" show \
        "$cleanup_revision:prisma/migrations/$PLATFORM_TERMINAL_MIGRATION/migration.sql" |
        sha256sum | awk 'NR == 1 { print $1 }'
    )" || return 1
    historical_compose_sha="$(
      git -C "$SERVER_ROOT" show "$cleanup_revision:deploy/docker-compose.prod.yml" |
        sha256sum | awk 'NR == 1 { print $1 }'
    )" || return 1
    [[ "$historical_migration_sha" == "$(platform_terminal_marker_value migration_sha256)" &&
      "$historical_compose_sha" == "$(platform_terminal_marker_value compose_sha256)" ]] || return 1
  fi
  marker_aggregate="$(platform_terminal_marker_value billing_offer_aggregate_version)"
  marker_sequence="$(platform_terminal_marker_value billing_offer_source_sequence)"
  marker_fence="$(platform_terminal_marker_value billing_offer_fence_fingerprint)"
  if [[ -n "${PLATFORM_TERMINAL_BILLING_AGGREGATE_VERSION:-}" ]]; then
    [[ "$marker_aggregate" == "$PLATFORM_TERMINAL_BILLING_AGGREGATE_VERSION" &&
      "$marker_sequence" == "$PLATFORM_TERMINAL_BILLING_SOURCE_SEQUENCE" &&
      "$marker_fence" == "$PLATFORM_TERMINAL_BILLING_FENCE_FINGERPRINT" ]] || return 1
  fi
  PLATFORM_TERMINAL_BILLING_AGGREGATE_VERSION="$marker_aggregate"
  PLATFORM_TERMINAL_BILLING_SOURCE_SEQUENCE="$marker_sequence"
  PLATFORM_TERMINAL_BILLING_FENCE_FINGERPRINT="$marker_fence"
  printf '%s\n' "$phase"
}

assert_platform_cleanup_prerequisite() {
  local revision="$1" legacy_marker terminal_marker cleanup_revision ownership_revision
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'Platform cleanup prerequisite requires the exact Operations revision'
  EXPECTED_REVISION="$revision"
  export EXPECTED_REVISION
  load_platform_terminal_dependencies
  legacy_marker="$APP_ROOT/deploy/backend/.platform-core-source-cleanup-v1"
  terminal_marker="$(platform_terminal_marker_path)"
  if [[ -e "$legacy_marker" || -L "$legacy_marker" ]]; then
    [[ ! -e "$terminal_marker" && ! -L "$terminal_marker" ]] ||
      fail 'legacy and terminal Platform cleanup markers are ambiguous'
    platform_cleanup_validate_marker "$legacy_marker" ||
      fail 'legacy Platform cleanup marker is invalid'
    [[ "$(platform_cleanup_marker_value phase)" == complete ]] ||
      fail 'legacy Platform cleanup marker is incomplete'
    cleanup_revision="$(platform_cleanup_marker_value cleanup_revision)"
    [[ "$cleanup_revision" =~ ^[0-9a-f]{40}$ &&
      "$cleanup_revision" != "$revision" ]] ||
      fail 'legacy Platform cleanup revision is invalid'
    git -C "$SERVER_ROOT" merge-base --is-ancestor "$cleanup_revision" "$revision" ||
      fail 'legacy Platform cleanup is not an ancestor of Operations'
    printf 'legacy|%s\n' "$cleanup_revision"
    return
  fi
  [[ ! -L "$legacy_marker" ]] || fail 'legacy Platform cleanup marker path is unsafe'
  [[ "${OPERATIONS_PLATFORM_TERMINAL_CONFIRMATION:-}" == "$PLATFORM_TERMINAL_CONFIRMATION" ]] ||
    fail "set exact terminal Platform confirmation: $PLATFORM_TERMINAL_CONFIRMATION"
  platform_database_validate_marker || fail 'Platform database marker is invalid'
  platform_cutover_validate_marker || fail 'Platform ownership marker is invalid'
  [[ "$(platform_database_current_phase)" == complete &&
    "$(platform_cutover_current_phase)" == complete ]] ||
    fail 'Platform database and ownership markers must be complete'
  ownership_revision="$(platform_cutover_marker_value revision)"
  [[ "$ownership_revision" =~ ^[0-9a-f]{40}$ &&
    "$ownership_revision" == "$(platform_database_marker_value revision)" &&
    "$ownership_revision" != "$revision" ]] ||
    fail 'Platform complete markers disagree with Operations revision'
  git -C "$SERVER_ROOT" merge-base --is-ancestor "$ownership_revision" "$revision" ||
    fail 'Operations revision must descend from completed Platform ownership'
  if [[ -e "$terminal_marker" || -L "$terminal_marker" ]]; then
    platform_terminal_validate_marker "$terminal_marker" ||
      fail 'terminal Platform marker is invalid'
  fi
  printf 'terminal|%s\n' "$ownership_revision"
}

platform_terminal_stop_core_writers() {
  local running sessions
  compose stop --timeout 90 api outbox-publisher integration-worker
  running="$(compose ps --status running -q api outbox-publisher integration-worker)" || return 1
  [[ -z "$running" ]] || fail 'Core writers are still running before terminal Platform migration'
  for _ in $(seq 1 60); do
    sessions="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT count(*) FROM pg_catalog.pg_stat_activity
WHERE pid <> pg_backend_pid() AND datname=current_database()
  AND usename IN ('gen_user','winwidget_api_runtime');")" || return 1
    [[ "$sessions" == 0 ]] && return 0
    sleep 1
  done
  fail 'Core writer and migration database sessions did not drain'
}

platform_terminal_assert_core_outbox_runtime() {
  local revision="$EXPECTED_REVISION" expected_image_id="$1" container metadata app_revision
  [[ "$revision" =~ ^[0-9a-f]{40}$ && "$expected_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  container="$(compose ps --status running -q outbox-publisher)" || return 1
  [[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
  metadata="$(docker inspect --format \
    '{{.Image}}|{{.State.Status}}|{{.State.Running}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
    "$container")" || return 1
  app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" |
    awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
  [[ "$metadata" == "$expected_image_id|running|true|0|winwidget|outbox-publisher" &&
    "$app_revision" == "$revision" ]]
}

platform_terminal_wait_core_outbox_drained() {
  local expected_image_id="$1" pending
  for _ in $(seq 1 120); do
    if ! platform_terminal_assert_core_outbox_runtime "$expected_image_id"; then
      sleep 2
      continue
    fi
    pending="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT count(*) FROM public.outbox_events
WHERE event_type IN ('admin.audit.platform.v1','billing.offer.changed.v2')
  AND status <> 'PUBLISHED'::public.\"OutboxEventStatus\";")" || return 1
    [[ "$pending" =~ ^[0-9]+$ ]] || return 1
    [[ "$pending" == 0 ]] && return 0
    sleep 2
  done
  fail 'Core Platform/Billing Outbox rows did not drain before terminal Platform DDL'
}

platform_terminal_wait_gateway_healthy() {
  local expected_image_id="$1" revision="$EXPECTED_REVISION"
  local container metadata app_revision
  [[ "$expected_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
    "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
  for _ in $(seq 1 60); do
    container="$(compose ps --status running -q api-gateway)" ||
      fail 'coordinated Gateway container cannot be resolved while waiting for Docker health'
    [[ "$container" =~ ^[0-9a-f]{64}$ ]] ||
      fail 'coordinated Gateway container identity is invalid while waiting for Docker health'
    metadata="$(docker inspect --format \
      '{{.Image}}|{{.State.Status}}|{{.State.Running}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
      "$container")" ||
      fail 'coordinated Gateway metadata cannot be inspected while waiting for Docker health'
    app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" |
      awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }')" ||
      fail 'coordinated Gateway revision cannot be inspected while waiting for Docker health'
    [[ "$app_revision" == "$revision" ]] ||
      fail 'coordinated Gateway revision changed while waiting for Docker health'
    if [[ "$metadata" == "$expected_image_id|running|true|0|winwidget|api-gateway|healthy" ]]; then
      printf '%s\n' "$container"
      return
    fi
    [[ "$metadata" == "$expected_image_id|running|true|0|winwidget|api-gateway|starting" ]] ||
      fail 'coordinated Gateway runtime identity changed while waiting for Docker health'
    sleep 2
  done
  fail 'coordinated Gateway Docker health timed out'
}

platform_terminal_prepare_live_owner_runtime() {
  local revision="$EXPECTED_REVISION" platform_image platform_image_id core_image_id metadata
  local service purpose port container app_revision gateway_image_id gateway_container path
  local direct_sha gateway_sha public_sha headers owner status
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
  compose up -d --no-deps --no-build --force-recreate \
    api outbox-publisher platform-api platform-outbox-publisher api-gateway
  wait_ready 'http://127.0.0.1:4200/api/v1/health/ready' 'Core API'
  wait_ready 'http://127.0.0.1:5000/health/ready' 'Platform API'
  wait_ready 'http://127.0.0.1:5001/health/ready' 'Platform outbox publisher'
  wait_ready 'http://127.0.0.1:4100/health/ready' 'Gateway'
  platform_cutover_cli target verify >/dev/null ||
    fail 'Platform target is not ACTIVE at the completed ownership anchor'
  core_image_id="$(docker image inspect --format '{{.Id}}' "winwidget-api:git-$revision")" || return 1
  metadata="$(docker image inspect --format \
    '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' \
    "$core_image_id")" || return 1
  [[ "$core_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
    "$metadata" == "$core_image_id|$revision|nestjs" ]] ||
    fail 'coordinated Core API image identity is invalid'
  container="$(compose ps --status running -q api)" || return 1
  [[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
  metadata="$(docker inspect --format \
    '{{.Image}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
    "$container")" || return 1
  app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" |
    awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
  [[ "$metadata" == "$core_image_id|running|true|healthy|0|winwidget|api" &&
    "$app_revision" == "$revision" ]] || fail 'coordinated Core API runtime identity is invalid'
  platform_terminal_wait_core_outbox_drained "$core_image_id"
  platform_image="winwidget-platform:git-$revision"
  platform_image_id="$(docker image inspect --format '{{.Id}}' "$platform_image")" || return 1
  metadata="$(docker image inspect --format \
    '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{.Config.User}}' \
    "$platform_image_id")" || return 1
  [[ "$platform_image_id" =~ ^sha256:[0-9a-f]{64}$ &&
    "$metadata" == "$platform_image_id|$revision|platform" ]] ||
    fail 'coordinated Platform image identity is invalid'
  for service in platform-api platform-outbox-publisher; do
    case "$service" in
      platform-api) purpose=api; port=5000 ;;
      platform-outbox-publisher) purpose=outbox-publisher; port=5001 ;;
    esac
    container="$(compose ps --status running -q "$service")" || return 1
    [[ "$container" =~ ^[0-9a-f]{64}$ ]] || return 1
    metadata="$(docker inspect --format \
      '{{.Image}}|{{.State.Status}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.winwidget.owner"}}|{{index .Config.Labels "com.winwidget.purpose"}}' \
      "$container")" || return 1
    app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" |
      awk -F= '$1 == "APP_REVISION" { print substr($0, index($0, "=") + 1); found += 1 } END { exit(found == 1 ? 0 : 1) }')" || return 1
    [[ "$metadata" == "$platform_image_id|running|true|healthy|0|winwidget|$service|platform|$purpose" &&
      "$app_revision" == "$revision" ]] ||
      fail "coordinated $service runtime identity is invalid"
    curl --fail --silent --show-error --max-time 10 \
      "http://127.0.0.1:$port/health/ready" >/dev/null
  done
  gateway_image_id="$(docker image inspect --format '{{.Id}}' \
    "winwidget-api-gateway:git-$revision")" || return 1
  platform_cutover_validate_gateway_manifest "$gateway_image_id" ||
    fail 'coordinated Gateway route manifest is invalid'
  gateway_container="$(platform_terminal_wait_gateway_healthy "$gateway_image_id")" ||
    fail 'coordinated Gateway did not reach exact Docker healthy state'
  [[ "$(platform_cutover_assert_gateway_runtime)" == "$gateway_container" ]] ||
    fail 'coordinated Gateway runtime identity or env is invalid'
  platform_cleanup_assert_gateway_contract || return 1
  for path in site-settings legal-pages legal-pages/oferta home-page-content; do
    direct_sha="$(platform_cleanup_response_sha \
      "http://127.0.0.1:5000/api/v1/$path")" || return 1
    gateway_sha="$(platform_cleanup_response_sha \
      "http://127.0.0.1:4100/api/v1/$path")" || return 1
    public_sha="$(platform_cleanup_response_sha \
      "https://api.winwidget.ru/api/v1/$path")" || return 1
    [[ "$direct_sha" == "$gateway_sha" && "$gateway_sha" == "$public_sha" ]] ||
      fail "Platform route parity failed before terminal DDL: $path"
    headers="$(curl -fsS -D - -o /dev/null --connect-timeout 3 --max-time 10 \
      "http://127.0.0.1:4100/api/v1/$path")" || return 1
    owner="$(awk -F: 'tolower($1)=="x-winwidget-service" { value=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); print tolower(value); count += 1 } END { exit(count == 1 ? 0 : 1) }' \
      <<<"$headers")" || return 1
    [[ "$owner" == platform ]] || return 1
  done
  for path in /api/v1/site-settings /api/v1/legal-pages \
    /api/v1/legal-pages/oferta /api/v1/home-page-content; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 \
      --max-time 10 "http://127.0.0.1:4200$path" || true)"
    [[ "$status" =~ ^(404|410)$ ]] ||
      fail "legacy Core Platform route remains reachable before terminal DDL: $path status=$status"
  done
}

platform_terminal_guc_entries() {
  local mode="$1" marker_value
  [[ "$mode" =~ ^(names|values)$ ]] || return 1
  local -a names=(
    winwidget.platform_pristine_replay
    winwidget.platform_core_source_cleanup
    winwidget.platform_ownership_revision
    winwidget.platform_cleanup_revision
    winwidget.platform_production_env_sha256
    winwidget.platform_compose_sha256
    winwidget.platform_core_database_name
    winwidget.platform_core_database_system_identifier
    winwidget.platform_generation
    winwidget.platform_first_complete_proof_sha256
    winwidget.platform_cleanup_migration_sha256
    winwidget.platform_prisma_manifest_sha256
    winwidget.platform_prisma_pre_ledger_sha256
    winwidget.platform_snapshot_sha256
    winwidget.platform_source_fingerprint
    winwidget.platform_source_high_watermark
    winwidget.platform_billing_offer_contract_version
    winwidget.platform_billing_offer_sequence_scope
    winwidget.platform_billing_offer_aggregate_version
    winwidget.platform_billing_offer_source_sequence
    winwidget.platform_billing_offer_fence_fingerprint
    winwidget.platform_core_pre_backup_sha256
    winwidget.platform_pre_backup_sha256
    winwidget.platform_pre_restore_evidence_sha256
    winwidget.platform_soak_evidence_sha256
    winwidget.platform_route_evidence_sha256
    winwidget.platform_queue_evidence_sha256
    winwidget.platform_outbox_evidence_sha256
    winwidget.platform_frontend_evidence_sha256
    winwidget.platform_frontend_phase_evidence_chain_sha256
    winwidget.platform_topology_scan_evidence_sha256
    winwidget.platform_pre_offsite_receipt_sha256
    winwidget.operations_platform_source_cleanup
    winwidget.operations_platform_source_writers_stopped
    winwidget.operations_platform_core_database_name
    winwidget.operations_platform_core_database_system_identifier
    winwidget.operations_platform_ownership_revision
    winwidget.operations_platform_cleanup_revision
    winwidget.operations_platform_generation
    winwidget.operations_platform_source_high_watermark
    winwidget.operations_platform_billing_offer_contract_version
    winwidget.operations_platform_billing_offer_sequence_scope
    winwidget.operations_platform_billing_offer_aggregate_version
    winwidget.operations_platform_billing_offer_source_sequence
    winwidget.operations_platform_migration_sha256
    winwidget.operations_platform_production_env_sha256
    winwidget.operations_platform_compose_sha256
    winwidget.operations_platform_snapshot_sha256
    winwidget.operations_platform_source_fingerprint
    winwidget.operations_platform_billing_offer_fence_fingerprint
  )
  if [[ "$mode" == names ]]; then
    printf '%s\n' "${names[@]}"
    return
  fi
  local -a values=(
    "winwidget.operations_platform_source_cleanup=production-destructive-approved"
    "winwidget.operations_platform_source_writers_stopped=true"
    "winwidget.operations_platform_core_database_name=$(platform_terminal_marker_value core_database_name)"
    "winwidget.operations_platform_core_database_system_identifier=$(platform_terminal_marker_value core_database_system_identifier)"
    "winwidget.operations_platform_ownership_revision=$(platform_terminal_marker_value ownership_revision)"
    "winwidget.operations_platform_cleanup_revision=$(platform_terminal_marker_value cleanup_revision)"
    "winwidget.operations_platform_generation=$(platform_terminal_marker_value generation)"
    "winwidget.operations_platform_source_high_watermark=$(platform_terminal_marker_value source_high_watermark)"
    "winwidget.operations_platform_billing_offer_contract_version=$(platform_terminal_marker_value billing_offer_contract_version)"
    "winwidget.operations_platform_billing_offer_sequence_scope=$(platform_terminal_marker_value billing_offer_sequence_scope)"
    "winwidget.operations_platform_billing_offer_aggregate_version=$(platform_terminal_marker_value billing_offer_aggregate_version)"
    "winwidget.operations_platform_billing_offer_source_sequence=$(platform_terminal_marker_value billing_offer_source_sequence)"
    "winwidget.operations_platform_migration_sha256=$(platform_terminal_marker_value migration_sha256)"
    "winwidget.operations_platform_production_env_sha256=$(platform_terminal_marker_value production_env_sha256)"
    "winwidget.operations_platform_compose_sha256=$(platform_terminal_marker_value compose_sha256)"
    "winwidget.operations_platform_snapshot_sha256=$(platform_terminal_marker_value snapshot_sha256)"
    "winwidget.operations_platform_source_fingerprint=$(platform_terminal_marker_value source_fingerprint)"
    "winwidget.operations_platform_billing_offer_fence_fingerprint=$(platform_terminal_marker_value billing_offer_fence_fingerprint)"
  )
  for marker_value in "${values[@]}"; do
    [[ "${marker_value%%=*}" =~ ^winwidget\.[a-z0-9_]+$ &&
      "${marker_value#*=}" =~ ^[A-Za-z0-9._:-]+$ ]] || return 1
  done
  printf '%s\n' "${values[@]}"
}

platform_terminal_guc_sql() {
  local mode="$1" entry name value sql='BEGIN;'
  [[ "$mode" =~ ^(set|reset)$ ]] || return 1
  if [[ "$mode" == reset ]]; then
    while IFS= read -r name; do
      [[ "$name" =~ ^winwidget\.[a-z0-9_]+$ ]] || return 1
      sql+="ALTER ROLE gen_user IN DATABASE default_db RESET \"$name\";"
    done < <(platform_terminal_guc_entries names)
  else
    while IFS= read -r entry; do
      name="${entry%%=*}"
      value="${entry#*=}"
      [[ "$name" =~ ^winwidget\.[a-z0-9_]+$ && "$value" =~ ^[A-Za-z0-9._:-]+$ ]] || return 1
      sql+="ALTER ROLE gen_user IN DATABASE default_db SET \"$name\" TO '$value';"
    done < <(platform_terminal_guc_entries values)
  fi
  printf '%sCOMMIT;\n' "$sql"
}

platform_terminal_core_admin_query() {
  [[ $# -eq 1 ]] || return 1
  local sql="$1" container_id admin_password PGPASSWORD status=0
  [[ -n "$sql" ]] || return 1
  assert_core_database_production_boundary >/dev/null || return 1
  container_id="$(docker inspect --format '{{.Id}}' "$CORE_POSTGRES_CONTAINER")" || return 1
  [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$(awk 'END { print NR }' "$CORE_POSTGRES_ADMIN_PASSWORD_FILE")" == 1 ]] || return 1
  admin_password="$(<"$CORE_POSTGRES_ADMIN_PASSWORD_FILE")"
  [[ ${#admin_password} -ge 32 && "$admin_password" != *$'\r'* &&
    "$admin_password" != *$'\n'* ]] || return 1
  PGPASSWORD="$admin_password"
  export PGPASSWORD
  docker exec --env PGPASSWORD "$container_id" psql --no-psqlrc --no-password \
    --set ON_ERROR_STOP=1 --tuples-only --no-align --host 127.0.0.1 \
    --username "$CORE_POSTGRES_ADMIN_USER" --dbname "$CORE_POSTGRES_DATABASE" \
    --command "$sql" || status=$?
  unset PGPASSWORD admin_password
  return "$status"
}

platform_terminal_configure_gucs() {
  local mode="$1" sql actual
  [[ "$mode" =~ ^(set|reset)$ ]] || return 1
  [[ "$(platform_cleanup_database_url_field DATABASE_MIGRATION_URL_PRODUCTION username)" == gen_user &&
    "$(platform_cleanup_database_url_field DATABASE_MIGRATION_URL_PRODUCTION database)" == default_db ]] || return 1
  sql="$(platform_terminal_guc_sql "$mode")" || return 1
  platform_terminal_core_admin_query "$sql" >/dev/null || return 1
  if [[ "$mode" == reset ]]; then
    actual="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT count(*) FROM pg_catalog.pg_db_role_setting setting
JOIN pg_catalog.pg_roles role ON role.oid=setting.setrole
JOIN pg_catalog.pg_database database ON database.oid=setting.setdatabase
CROSS JOIN LATERAL unnest(setting.setconfig) config
WHERE role.rolname='gen_user' AND database.datname='default_db'
  AND (config LIKE 'winwidget.platform_%' OR config LIKE 'winwidget.operations_platform_%');")" || return 1
    [[ "$actual" == 0 ]]
    return
  fi
  platform_terminal_guc_entries values >/dev/null || return 1
  actual="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT count(*) FILTER (WHERE config LIKE 'winwidget.operations_platform_%')::text || '|' ||
  count(*) FILTER (WHERE config IN (
    'winwidget.operations_platform_source_cleanup=production-destructive-approved',
    'winwidget.operations_platform_source_writers_stopped=true',
    'winwidget.operations_platform_core_database_name=$(platform_terminal_marker_value core_database_name)',
    'winwidget.operations_platform_core_database_system_identifier=$(platform_terminal_marker_value core_database_system_identifier)',
    'winwidget.operations_platform_ownership_revision=$(platform_terminal_marker_value ownership_revision)',
    'winwidget.operations_platform_cleanup_revision=$(platform_terminal_marker_value cleanup_revision)',
    'winwidget.operations_platform_generation=$(platform_terminal_marker_value generation)',
    'winwidget.operations_platform_source_high_watermark=$(platform_terminal_marker_value source_high_watermark)',
    'winwidget.operations_platform_billing_offer_contract_version=2',
    'winwidget.operations_platform_billing_offer_sequence_scope=billing.offer:offer',
    'winwidget.operations_platform_billing_offer_aggregate_version=$(platform_terminal_marker_value billing_offer_aggregate_version)',
    'winwidget.operations_platform_billing_offer_source_sequence=$(platform_terminal_marker_value billing_offer_source_sequence)',
    'winwidget.operations_platform_migration_sha256=$(platform_terminal_marker_value migration_sha256)',
    'winwidget.operations_platform_production_env_sha256=$(platform_terminal_marker_value production_env_sha256)',
    'winwidget.operations_platform_compose_sha256=$(platform_terminal_marker_value compose_sha256)',
    'winwidget.operations_platform_snapshot_sha256=$(platform_terminal_marker_value snapshot_sha256)',
    'winwidget.operations_platform_source_fingerprint=$(platform_terminal_marker_value source_fingerprint)',
    'winwidget.operations_platform_billing_offer_fence_fingerprint=$(platform_terminal_marker_value billing_offer_fence_fingerprint)'
  ))::text || '|' ||
  count(*) FILTER (WHERE config LIKE 'winwidget.platform_%')::text
FROM pg_catalog.pg_db_role_setting setting
JOIN pg_catalog.pg_roles role ON role.oid=setting.setrole
JOIN pg_catalog.pg_database database ON database.oid=setting.setdatabase
CROSS JOIN LATERAL unnest(setting.setconfig) config
WHERE role.rolname='gen_user' AND database.datname='default_db';")" || return 1
  [[ "$actual" == '18|18|0' ]]
}

platform_terminal_candidate_migration_state() {
  local migration="$1" checksum="$2" result total applied pending rolled_back wrong
  [[ "$migration" =~ ^[0-9]{14}_[a-z0-9_]+$ && "$checksum" =~ ^[0-9a-f]{64}$ ]] || return 1
  result="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT count(*)::text || '|' ||
  count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    AND checksum='$checksum' AND applied_steps_count IN (0,1))::text || '|' ||
  count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL
    AND checksum='$checksum' AND applied_steps_count IN (0,1))::text || '|' ||
  count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NOT NULL
    AND checksum='$checksum' AND applied_steps_count IN (0,1))::text || '|' ||
  count(*) FILTER (WHERE checksum <> '$checksum' OR applied_steps_count NOT IN (0,1)
    OR (finished_at IS NOT NULL AND rolled_back_at IS NOT NULL))::text
FROM public._prisma_migrations
WHERE migration_name='$migration';")" || return 1
  IFS='|' read -r total applied pending rolled_back wrong <<<"$result"
  [[ "$total" =~ ^[0-9]+$ && "$applied" =~ ^[0-9]+$ && "$pending" =~ ^[0-9]+$ &&
    "$rolled_back" =~ ^[0-9]+$ && "$wrong" == 0 ]] || { printf 'unsafe\n'; return; }
  if ((total == 0)); then
    printf 'pending\n'
  elif ((applied == 0 && pending == 1 && rolled_back + 1 == total)); then
    printf 'failed\n'
  elif ((total > 0 && applied == 0 && pending == 0 && rolled_back == total)); then
    printf 'rolled-back\n'
  elif ((applied == 1 && pending == 0 && rolled_back + 1 == total)); then
    printf 'applied\n'
  else
    printf 'unsafe\n'
  fi
}

platform_terminal_operations_prepare_state() {
  local inventory state_inventory semantic_inventory
  inventory="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT
  COALESCE((SELECT string_agg(c.relname, ',' ORDER BY c.relname COLLATE \"C\")
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname='operations_core_state'), '') || '~' ||
  COALESCE((SELECT string_agg(c.relname || ':' || t.tgname, ',' ORDER BY c.relname COLLATE \"C\", t.tgname COLLATE \"C\")
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND
      ((c.relname='operations_core_state' AND t.tgname='operations_core_state_transition_guard') OR
       (c.relname='notes' AND t.tgname IN ('notes_operations_source_write_guard','notes_operations_source_truncate_guard')) OR
       (c.relname='admin_event_logs' AND t.tgname IN ('admin_event_logs_operations_source_write_guard','admin_event_logs_operations_source_truncate_guard')))), '') || '~' ||
  COALESCE((SELECT string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text COLLATE \"C\")
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('operations_core_source_write_guard','operations_core_state_transition_guard')), '') || '~' ||
  (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='OperationsCoreOwnership')::text;")" || return 1
  case "$inventory" in
    '~~~0') printf 'absent\n'; return ;;
    'operations_core_state~admin_event_logs:admin_event_logs_operations_source_truncate_guard,admin_event_logs:admin_event_logs_operations_source_write_guard,notes:notes_operations_source_truncate_guard,notes:notes_operations_source_write_guard,operations_core_state:operations_core_state_transition_guard~operations_core_source_write_guard(),operations_core_state_transition_guard()~1') ;;
    *) printf 'unsafe\n'; return ;;
  esac
  semantic_inventory="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT (
  (SELECT count(*)=1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='operations_core_source_write_guard'
      AND pg_get_functiondef(p.oid) LIKE '%Operations Core source is write-fenced%')
  AND
  (SELECT count(*)=1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='operations_core_state_transition_guard'
      AND pg_get_functiondef(p.oid) LIKE '%Operations ownership is forward-only%'
      AND pg_get_functiondef(p.oid) LIKE '%Operations Core write fence is forward-only%'
      AND pg_get_functiondef(p.oid) LIKE '%Operations source must be fenced and exported before activation%')
  AND (SELECT count(*)=6 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.operations_core_state'::regclass
      AND c.conname IN ('operations_core_state_pkey','operations_core_state_singleton_check',
        'operations_core_state_generation_check','operations_core_state_revision_check',
        'operations_core_state_snapshot_check','operations_core_state_activation_check'))
  AND NOT has_table_privilege('public','public.operations_core_state','INSERT,UPDATE,DELETE,TRUNCATE')
)::text;")" || return 1
  [[ "$semantic_inventory" == t ]] || { printf 'unsafe\n'; return; }
  state_inventory="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT
  (SELECT count(*)::text || '|' || count(*) FILTER (WHERE id='singleton' AND
    ownership='CORE'::public.\"OperationsCoreOwnership\" AND source_writes_enabled AND
    legacy_routes_enabled AND generation=0 AND prepared_revision IS NULL AND
    ownership_revision IS NULL AND source_snapshot_sha256 IS NULL AND
    source_note_count IS NULL AND source_event_count IS NULL AND fenced_at IS NULL AND
    exported_at IS NULL AND activated_at IS NULL)::text || '|' ||
    count(*) FILTER (WHERE prepared_revision='$EXPECTED_REVISION' AND generation >= 1 AND
      ((ownership='CORE'::public.\"OperationsCoreOwnership\" AND ownership_revision IS NULL AND
        legacy_routes_enabled AND activated_at IS NULL AND
        ((source_writes_enabled AND fenced_at IS NULL AND exported_at IS NULL AND
          source_snapshot_sha256 IS NULL AND source_note_count IS NULL AND source_event_count IS NULL) OR
         (NOT source_writes_enabled AND fenced_at IS NOT NULL AND
          ((exported_at IS NULL AND source_snapshot_sha256 IS NULL AND source_note_count IS NULL AND source_event_count IS NULL) OR
           (exported_at IS NOT NULL AND exported_at >= fenced_at AND
            source_snapshot_sha256 ~ '^[0-9a-f]{64}$' AND source_note_count >= 0 AND source_event_count >= 0)))) OR
       (ownership='OPERATIONS'::public.\"OperationsCoreOwnership\" AND NOT source_writes_enabled AND
        NOT legacy_routes_enabled AND ownership_revision='$EXPECTED_REVISION' AND generation >= 3 AND
        source_snapshot_sha256 ~ '^[0-9a-f]{64}$' AND source_note_count >= 0 AND source_event_count >= 0 AND
        fenced_at IS NOT NULL AND exported_at IS NOT NULL AND exported_at >= fenced_at AND
        activated_at IS NOT NULL AND activated_at >= exported_at)))::text
    FROM public.operations_core_state) || '~' ||
  (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_catalog.pg_enum e WHERE e.enumtypid='public.\"OperationsCoreOwnership\"'::regtype) || '~' ||
  (SELECT string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull::text,
    ',' ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.operations_core_state'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped) || '~' ||
  (SELECT string_agg(c.conname, ',' ORDER BY c.conname COLLATE \"C\")
    FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.operations_core_state'::regclass);")" || return 1
  case "$state_inventory" in
'1|1|0~CORE,OPERATIONS~id:text:true,ownership:"OperationsCoreOwnership":true,source_writes_enabled:boolean:true,legacy_routes_enabled:boolean:true,generation:bigint:true,prepared_revision:text:false,ownership_revision:text:false,source_snapshot_sha256:text:false,source_note_count:bigint:false,source_event_count:bigint:false,fenced_at:timestamp(3) without time zone:false,exported_at:timestamp(3) without time zone:false,activated_at:timestamp(3) without time zone:false,updated_at:timestamp(3) without time zone:true~operations_core_state_activation_check,operations_core_state_generation_check,operations_core_state_pkey,operations_core_state_revision_check,operations_core_state_singleton_check,operations_core_state_snapshot_check') printf 'pristine\n' ;;
'1|0|1~CORE,OPERATIONS~id:text:true,ownership:"OperationsCoreOwnership":true,source_writes_enabled:boolean:true,legacy_routes_enabled:boolean:true,generation:bigint:true,prepared_revision:text:false,ownership_revision:text:false,source_snapshot_sha256:text:false,source_note_count:bigint:false,source_event_count:bigint:false,fenced_at:timestamp(3) without time zone:false,exported_at:timestamp(3) without time zone:false,activated_at:timestamp(3) without time zone:false,updated_at:timestamp(3) without time zone:true~operations_core_state_activation_check,operations_core_state_generation_check,operations_core_state_pkey,operations_core_state_revision_check,operations_core_state_singleton_check,operations_core_state_snapshot_check') printf 'forward\n' ;;
*)
    printf 'unsafe\n'
    return
    ;;
  esac
}

platform_terminal_assert_exact_repo_ledger() {
  local operations_state="$1" platform_state="$2" mode="${3:-creation}"
  local directory name migration_file sha manifest='' actual
  local terminal_seen=false
  [[ "$operations_state" =~ ^(pending|failed|rolled-back|applied)$ &&
    "$platform_state" =~ ^(pending|failed|rolled-back|applied)$ &&
    "$mode" =~ ^(creation|descendant)$ ]] || return 1
  for directory in "$SERVER_ROOT"/prisma/migrations/*; do
    [[ -d "$directory" && ! -L "$directory" ]] || continue
    name="$(basename -- "$directory")"
    [[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ ]] || return 1
    if [[ "$terminal_seen" == true ]]; then
      [[ "$mode" == descendant ]] || return 1
      continue
    fi
    migration_file="$directory/migration.sql"
    [[ -f "$migration_file" && ! -L "$migration_file" ]] || return 1
    sha="$(platform_cleanup_sha256 "$migration_file")" || return 1
    manifest+="$name|$sha"$'\n'
    [[ "$name" == "$PLATFORM_TERMINAL_MIGRATION" ]] && terminal_seen=true
  done
  [[ "$terminal_seen" == true &&
    "$manifest" == *"$PLATFORM_TERMINAL_MIGRATION|$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256"$'\n' ]] || return 1
  actual="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT migration_name || '|' || checksum || '|' ||
  CASE WHEN finished_at IS NULL THEN '0' ELSE '1' END || '|' ||
  CASE WHEN rolled_back_at IS NULL THEN '0' ELSE '1' END || '|' ||
  applied_steps_count::text
FROM public._prisma_migrations
WHERE migration_name <= '$PLATFORM_TERMINAL_MIGRATION'
ORDER BY migration_name COLLATE \"C\", started_at, id;")" || return 1
  OPERATIONS_PRISMA_MANIFEST="$manifest" \
    OPERATIONS_PRISMA_LEDGER="$actual" \
    OPERATIONS_PREP_LEDGER_STATE="$operations_state" \
    OPERATIONS_PLATFORM_LEDGER_STATE="$platform_state" \
    billing_release_node - "$OPERATIONS_PREP_MIGRATION" \
      "$PLATFORM_TERMINAL_MIGRATION" <<'NODE'
const manifestRows = (process.env.OPERATIONS_PRISMA_MANIFEST || '').trim().split('\n');
const expected = new Map();
for (const row of manifestRows) {
  const fields = row.split('|');
  if (fields.length !== 2 || !/^[0-9]{14}_[a-z0-9_]+$/.test(fields[0]) ||
      !/^[0-9a-f]{64}$/.test(fields[1]) || expected.has(fields[0])) process.exit(1);
  expected.set(fields[0], fields[1]);
}
const actualText = process.env.OPERATIONS_PRISMA_LEDGER || '';
const actualRows = actualText ? actualText.trim().split('\n').map(row => row.split('|')) : [];
const grouped = new Map([...expected.keys()].map(name => [name, []]));
for (const row of actualRows) {
  if (row.length !== 5 || !grouped.has(row[0]) || row[1] !== expected.get(row[0]) ||
      !['0', '1'].includes(row[2]) || !['0', '1'].includes(row[3]) ||
      (row[2] === '1' && row[3] === '1') ||
      !/^(0|[1-9][0-9]*)$/.test(row[4])) process.exit(1);
  grouped.get(row[0]).push({ finished: row[2] === '1', rolled: row[3] === '1', steps: Number(row[4]) });
}
const operations = process.argv[2] || '';
const platform = process.argv[3] || '';
const successful = row => row.finished && !row.rolled && [0, 1].includes(row.steps);
const validateCandidate = (rows, state) => {
  const applied = rows.filter(successful);
  const unresolved = rows.filter(row => !row.finished && !row.rolled);
  const rolled = rows.filter(row => row.rolled);
  if (applied.length + unresolved.length + rolled.length !== rows.length) process.exit(1);
  if (state === 'pending' && rows.length !== 0) process.exit(1);
  if (state === 'failed' &&
      !(applied.length === 0 && unresolved.length === 1 && rolled.length + 1 === rows.length)) process.exit(1);
  if (state === 'rolled-back' &&
      !(rows.length > 0 && applied.length === 0 && unresolved.length === 0 && rolled.length === rows.length)) process.exit(1);
  if (state === 'applied' &&
      !(applied.length === 1 && unresolved.length === 0 && rolled.length + 1 === rows.length)) process.exit(1);
};
for (const [name, rows] of grouped) {
  if (name === operations) {
    validateCandidate(rows, process.env.OPERATIONS_PREP_LEDGER_STATE);
    continue;
  }
  if (name !== platform) {
    const applied = rows.filter(successful);
    const unresolved = rows.filter(row => !row.finished && !row.rolled);
    const rolled = rows.filter(row => row.rolled);
    if (applied.length !== 1 || unresolved.length !== 0 ||
        applied.length + rolled.length !== rows.length) process.exit(1);
    continue;
  }
  validateCandidate(rows, process.env.OPERATIONS_PLATFORM_LEDGER_STATE);
}
NODE
}

platform_terminal_resolve_migration() {
  local migration="$1" checksum="$2" resolution="$3" expected_state
  [[ "$migration" =~ ^[0-9]{14}_[a-z0-9_]+$ && "$checksum" =~ ^[0-9a-f]{64}$ &&
    "$resolution" =~ ^(rolled-back|applied)$ ]] || return 1
  expected_state="$resolution"
  compose --profile migration run --rm -T --no-deps migrate \
    migrate resolve "--$resolution" "$migration" || return 1
  [[ "$(platform_terminal_candidate_migration_state "$migration" "$checksum")" == "$expected_state" ]]
}

platform_terminal_rollback_pristine_operations_prepare() {
  local note_count event_count
  [[ "$(platform_terminal_candidate_migration_state \
    "$OPERATIONS_PREP_MIGRATION" "$OPERATIONS_PREP_MIGRATION_SHA256")" == failed &&
    "$(platform_terminal_operations_prepare_state)" == pristine &&
    "$PLATFORM_TERMINAL_DATABASE_NAME" == default_db &&
    "$PLATFORM_TERMINAL_DATABASE_SYSTEM_IDENTIFIER" =~ ^[1-9][0-9]*$ ]] || return 1
  note_count="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION \
    'SELECT count(*) FROM public.notes;')" || return 1
  event_count="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION \
    'SELECT count(*) FROM public.admin_event_logs;')" || return 1
  [[ "$note_count" =~ ^[0-9]+$ && "$event_count" =~ ^[0-9]+$ ]] || return 1
  database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"
  platform_terminal_stop_core_writers
  platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
BEGIN;
SET LOCAL lock_timeout='60s';
SET LOCAL statement_timeout='5min';
LOCK TABLE public.notes, public.admin_event_logs, public.operations_core_state IN ACCESS EXCLUSIVE MODE;
DO \$operations_prepare_rollback\$
DECLARE
  state_count BIGINT;
BEGIN
  IF current_database() <> 'default_db'
    OR (pg_control_system()).system_identifier::text <> '$PLATFORM_TERMINAL_DATABASE_SYSTEM_IDENTIFIER'
    OR (SELECT count(*) FROM public.notes) <> $note_count
    OR (SELECT count(*) FROM public.admin_event_logs) <> $event_count
  THEN RAISE EXCEPTION 'Operations prepare rollback database boundary changed'; END IF;
  SELECT count(*) INTO state_count FROM public.operations_core_state
  WHERE id='singleton' AND ownership='CORE'::public.\"OperationsCoreOwnership\"
    AND source_writes_enabled AND legacy_routes_enabled AND generation=0
    AND prepared_revision IS NULL AND ownership_revision IS NULL
    AND source_snapshot_sha256 IS NULL AND source_note_count IS NULL AND source_event_count IS NULL
    AND fenced_at IS NULL AND exported_at IS NULL AND activated_at IS NULL;
  IF state_count <> 1 OR (SELECT count(*) FROM public.operations_core_state) <> 1
    OR (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
      AND t.tgname IN ('operations_core_state_transition_guard','notes_operations_source_write_guard',
        'notes_operations_source_truncate_guard','admin_event_logs_operations_source_write_guard',
        'admin_event_logs_operations_source_truncate_guard')) <> 5
  THEN RAISE EXCEPTION 'Operations prepare rollback source is not pristine'; END IF;
  DROP TRIGGER operations_core_state_transition_guard ON public.operations_core_state;
  DROP TRIGGER notes_operations_source_write_guard ON public.notes;
  DROP TRIGGER notes_operations_source_truncate_guard ON public.notes;
  DROP TRIGGER admin_event_logs_operations_source_write_guard ON public.admin_event_logs;
  DROP TRIGGER admin_event_logs_operations_source_truncate_guard ON public.admin_event_logs;
  DROP FUNCTION public.operations_core_source_write_guard();
  DROP TABLE public.operations_core_state;
  DROP FUNCTION public.operations_core_state_transition_guard();
  DROP TYPE public.\"OperationsCoreOwnership\";
  IF (SELECT count(*) FROM public.notes) <> $note_count
    OR (SELECT count(*) FROM public.admin_event_logs) <> $event_count
  THEN RAISE EXCEPTION 'Operations prepare rollback changed source rows'; END IF;
END
\$operations_prepare_rollback\$;
COMMIT;" >/dev/null || return 1
  [[ "$(platform_terminal_operations_prepare_state)" == absent ]] || return 1
  platform_terminal_resolve_migration "$OPERATIONS_PREP_MIGRATION" \
    "$OPERATIONS_PREP_MIGRATION_SHA256" rolled-back
}

platform_terminal_recover_operations_prepare() {
  local state schema_state
  state="$(platform_terminal_candidate_migration_state \
    "$OPERATIONS_PREP_MIGRATION" "$OPERATIONS_PREP_MIGRATION_SHA256")" || return 1
  schema_state="$(platform_terminal_operations_prepare_state)" || return 1
  case "$state:$schema_state" in
    pending:absent | rolled-back:absent | applied:pristine | applied:forward) ;;
    failed:absent)
      platform_terminal_resolve_migration "$OPERATIONS_PREP_MIGRATION" \
        "$OPERATIONS_PREP_MIGRATION_SHA256" rolled-back || return 1
      state=rolled-back
      ;;
    failed:pristine)
      platform_terminal_rollback_pristine_operations_prepare || return 1
      state=rolled-back
      ;;
    *) fail "unsafe Operations prepare retry state: schema=$schema_state migration=$state" ;;
  esac
  printf '%s\n' "$state"
}

platform_terminal_applied_ledger_id() {
  local result
  result="$(platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "
SELECT CASE WHEN
  count(*) FILTER (WHERE checksum <> '$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256')=0 AND
  count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NOT NULL)=0 AND
  count(*) FILTER (WHERE applied_steps_count NOT IN (0,1))=0 AND
  count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    AND applied_steps_count IN (0,1))=1 AND
  count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)=0 AND
  count(*)=count(*) FILTER (WHERE rolled_back_at IS NOT NULL) +
    count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      AND applied_steps_count IN (0,1))
THEN max(id::text) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)
ELSE 'unsafe' END
FROM public._prisma_migrations
WHERE migration_name='$PLATFORM_TERMINAL_MIGRATION';")" || return 1
  [[ "$result" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || return 1
  printf '%s\n' "$result"
}

platform_terminal_apply_migrations() (
  local reset_required=true status
  platform_terminal_configure_gucs reset || return 1
  trap 'status=$?; trap - EXIT INT TERM; if [[ "$reset_required" == true ]] && ! platform_terminal_configure_gucs reset >/dev/null 2>&1; then printf "%s\n" "operations-cutover: terminal Platform migration guard settings could not be reset" >&2; exit 1; fi; exit "$status"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  platform_terminal_configure_gucs set || return 1
  compose --profile migration run --rm -T --no-deps migrate || return 1
  platform_terminal_configure_gucs reset || return 1
  reset_required=false
)

run_or_verify_terminal_platform_cleanup() (
  local revision="$1" marker phase source_state migration_state operations_state operations_schema prisma_id
  local cleanup_revision identity_mode=creation marker_retry_mode
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
  EXPECTED_REVISION="$revision"
  export EXPECTED_REVISION
  load_platform_terminal_dependencies
  # A SIGKILL cannot run the previous trap. Clear both legacy and terminal
  # persistent guard families before reading any retry state.
  platform_terminal_configure_gucs reset ||
    fail 'terminal Platform migration guard settings are not reset'
  marker="$(platform_terminal_marker_path)"
  source_state="$(platform_cleanup_source_state)" || return 1
  migration_state="$(platform_terminal_candidate_migration_state \
    "$PLATFORM_TERMINAL_MIGRATION" "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256")" || return 1
  if [[ "$source_state" == present ]]; then
    platform_terminal_prepare_live_owner_runtime
  fi
  database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"
  platform_terminal_stop_core_writers
  platform_terminal_load_ownership_context || return 1
  platform_cutover_cli target verify >/dev/null || return 1
  operations_schema="$(platform_terminal_operations_prepare_state)" || return 1
  if [[ -e "$marker" || -L "$marker" ]]; then
    platform_terminal_validate_marker "$marker" || return 1
    cleanup_revision="$(platform_terminal_marker_value cleanup_revision)" || return 1
    phase="$(platform_terminal_marker_value phase)" || return 1
    marker_retry_mode="$(platform_terminal_marker_retry_mode \
      "$cleanup_revision" "$revision" "$phase" "$source_state" "$migration_state")" ||
      fail 'terminal Platform marker retry state is unsafe'
    case "$marker_retry_mode" in
      creation)
        if [[ -n "${OPERATIONS_PLATFORM_PREPARED_RECOVERY_CONFIRMATION:-}" ]]; then
          platform_terminal_recover_pinned_prepared_marker \
            "$revision" "$source_state" "$migration_state" "$operations_schema" ||
            fail 'pinned prepared Platform marker recovery failed'
        fi
        ;;
      prepared-recovery)
        platform_terminal_recover_pinned_prepared_marker \
          "$revision" "$source_state" "$migration_state" "$operations_schema" ||
          fail 'pinned prepared Platform marker recovery failed'
        ;;
      descendant) identity_mode=descendant ;;
      *) return 1 ;;
    esac
    phase="$(platform_terminal_assert_marker_identity "$identity_mode")" || return 1
  else
    [[ ! -L "$marker" ]] || return 1
    phase=absent
  fi
  if [[ "$phase:$source_state:$migration_state:$operations_schema" == complete:absent:applied:absent ]]; then
    operations_state="$(platform_terminal_candidate_migration_state \
      "$OPERATIONS_PREP_MIGRATION" "$OPERATIONS_PREP_MIGRATION_SHA256")" || return 1
    [[ "$operations_state" == applied ]] || return 1
  else
    operations_state="$(platform_terminal_recover_operations_prepare)" || return 1
  fi
  case "$phase:$source_state:$migration_state" in
    absent:present:pending)
      platform_cleanup_assert_cleanup_source_retired
      platform_cleanup_assert_retained_billing_seam
      platform_terminal_assert_exact_repo_ledger "$operations_state" pending "$identity_mode"
      platform_terminal_write_marker prepared pending
      phase=prepared
      ;;
    prepared:present:pending)
      platform_cleanup_assert_cleanup_source_retired
      platform_cleanup_assert_retained_billing_seam
      platform_terminal_assert_exact_repo_ledger "$operations_state" pending "$identity_mode"
      ;;
    prepared:present:failed)
      platform_cleanup_assert_cleanup_source_retired
      platform_cleanup_assert_retained_billing_seam
      platform_terminal_assert_exact_repo_ledger "$operations_state" failed "$identity_mode"
      platform_terminal_resolve_migration "$PLATFORM_TERMINAL_MIGRATION" \
        "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" rolled-back || return 1
      migration_state=rolled-back
      platform_terminal_assert_exact_repo_ledger \
        "$operations_state" "$migration_state" "$identity_mode"
      ;;
    prepared:present:rolled-back)
      platform_cleanup_assert_cleanup_source_retired
      platform_cleanup_assert_retained_billing_seam
      platform_terminal_assert_exact_repo_ledger \
        "$operations_state" rolled-back "$identity_mode"
      ;;
    prepared:absent:failed | prepared:absent:rolled-back)
      platform_cleanup_assert_retained_billing_seam
      platform_terminal_assert_exact_repo_ledger \
        "$operations_state" "$migration_state" "$identity_mode"
      platform_terminal_resolve_migration "$PLATFORM_TERMINAL_MIGRATION" \
        "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256" applied || return 1
      migration_state=applied
      platform_terminal_assert_exact_repo_ledger \
        "$operations_state" applied "$identity_mode"
      ;;
    prepared:absent:applied | complete:absent:applied)
      platform_terminal_assert_exact_repo_ledger \
        "$operations_state" applied "$identity_mode"
      ;;
    *) fail "unsafe terminal Platform cleanup state: marker=$phase source=$source_state migration=$migration_state" ;;
  esac
  if [[ "$source_state" == present ]]; then
    [[ "$(platform_terminal_assert_marker_identity "$identity_mode")" == prepared ]] || return 1
    # Close the build/prepare-to-DDL window and clear any sessions that appeared
    # while a failed Prisma row was reconciled.
    database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"
    platform_terminal_assert_files_unchanged ||
      fail 'production env or Compose changed before terminal Platform DDL'
    platform_terminal_stop_core_writers
    platform_terminal_apply_migrations ||
      fail 'terminal Platform migration failed; persistent guards were reset and exact forward retry is required'
    source_state="$(platform_cleanup_source_state)" || return 1
    migration_state="$(platform_terminal_candidate_migration_state \
      "$PLATFORM_TERMINAL_MIGRATION" "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256")" || return 1
    operations_state="$(platform_terminal_candidate_migration_state \
      "$OPERATIONS_PREP_MIGRATION" "$OPERATIONS_PREP_MIGRATION_SHA256")" || return 1
    [[ "$source_state" == absent && "$migration_state" == applied ]] || return 1
    platform_terminal_assert_files_unchanged || return 1
    [[ "$(platform_terminal_operations_prepare_state)" == pristine ]] || return 1
    platform_terminal_assert_exact_repo_ledger \
      "$operations_state" applied "$identity_mode"
  fi
  platform_cleanup_assert_retained_billing_seam
  operations_schema="$(platform_terminal_operations_prepare_state)" || return 1
  operations_state="$(platform_terminal_candidate_migration_state \
    "$OPERATIONS_PREP_MIGRATION" "$OPERATIONS_PREP_MIGRATION_SHA256")" || return 1
  [[ "$operations_state" == applied &&
    ("$operations_schema" =~ ^(pristine|forward)$ ||
      "$phase:$source_state:$migration_state:$operations_schema" == complete:absent:applied:absent) ]] || return 1
  platform_terminal_assert_exact_repo_ledger applied applied "$identity_mode"
  prisma_id="$(platform_terminal_applied_ledger_id)" || return 1
  if [[ "$phase" != complete ]]; then
    platform_terminal_write_marker complete "$prisma_id"
  fi
  [[ "$(platform_terminal_assert_marker_identity "$identity_mode")" == complete &&
    "$(platform_terminal_marker_value prisma_migration_id)" == "$prisma_id" &&
    "$(platform_cleanup_source_state)" == absent &&
    "$(platform_terminal_candidate_migration_state \
      "$PLATFORM_TERMINAL_MIGRATION" "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256")" == applied ]] || return 1
  platform_cleanup_assert_retained_billing_seam
  printf 'terminal Platform Core source cleanup is complete at %s\n' "$revision"
)

verify_terminal_platform_cleanup() (
  local revision="$1" marker phase prisma_id identity_mode cleanup_revision
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
  EXPECTED_REVISION="$revision"
  export EXPECTED_REVISION
  load_platform_terminal_dependencies
  marker="$(platform_terminal_marker_path)"
  [[ -e "$marker" && ! -L "$marker" ]] || return 1
  [[ "$(platform_cleanup_source_state)" == absent &&
    "$(platform_terminal_candidate_migration_state \
      "$PLATFORM_TERMINAL_MIGRATION" "$PLATFORM_CORE_SOURCE_CLEANUP_MIGRATION_SHA256")" == applied ]] || return 1
  platform_terminal_load_ownership_context || return 1
  platform_cutover_cli target verify >/dev/null || return 1
  cleanup_revision="$(platform_terminal_marker_value cleanup_revision)" || return 1
  if [[ "$cleanup_revision" == "$revision" ]]; then
    identity_mode=creation
  else
    identity_mode=descendant
  fi
  phase="$(platform_terminal_assert_marker_identity "$identity_mode")" || return 1
  [[ "$phase" == complete ]] || return 1
  [[ "$(platform_terminal_operations_prepare_state)" =~ ^(pristine|forward|absent)$ &&
    "$(platform_terminal_candidate_migration_state \
      "$OPERATIONS_PREP_MIGRATION" "$OPERATIONS_PREP_MIGRATION_SHA256")" == applied ]] || return 1
  platform_terminal_assert_exact_repo_ledger applied applied "$identity_mode"
  prisma_id="$(platform_terminal_applied_ledger_id)" || return 1
  [[ "$(platform_terminal_marker_value prisma_migration_id)" == "$prisma_id" ]] || return 1
  platform_cleanup_assert_retained_billing_seam
  printf 'terminal Platform Core source cleanup marker and live state are exact at %s\n' "$revision"
)

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
  local service running_container_ids database_identity database_name database_system_identifier
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

  platform_terminal_assert_files_unchanged ||
    fail 'checkout, production env or Compose changed before terminal Operations cleanup'
  database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"
  database_identity="$(platform_cleanup_core_database_identity)" ||
    fail 'Core database identity cannot be read before terminal Operations cleanup'
  IFS='|' read -r database_name database_system_identifier <<<"$database_identity"
  [[ "$database_name" == default_db && "$database_system_identifier" =~ ^[1-9][0-9]*$ ]] ||
    fail 'Core database identity is invalid before terminal Operations cleanup'
  if [[ -e "$(platform_terminal_marker_path)" || -L "$(platform_terminal_marker_path)" ]]; then
    platform_terminal_validate_marker "$(platform_terminal_marker_path)" ||
      fail 'terminal Platform marker is invalid before Operations cleanup'
    [[ "$database_name" == "$(platform_terminal_marker_value core_database_name)" &&
      "$database_system_identifier" == "$(platform_terminal_marker_value core_database_system_identifier)" ]] ||
      fail 'Core database identity changed after terminal Platform cleanup'
  else
    platform_cleanup_validate_marker ||
      fail 'legacy Platform cleanup marker is invalid before Operations cleanup'
    [[ "$database_name" == "$(platform_cleanup_marker_value core_database_name)" &&
      "$database_system_identifier" == "$(platform_cleanup_marker_value core_database_system_identifier)" ]] ||
      fail 'Core database identity changed after legacy Platform cleanup'
  fi

  local OPERATIONS_EXPECTED_REVISION="$revision"
  local OPERATIONS_EXPECTED_SNAPSHOT_SHA256="$sha256"
  local OPERATIONS_EXPECTED_NOTE_COUNT="$note_count"
  local OPERATIONS_EXPECTED_EVENT_COUNT="$event_count"
  local OPERATIONS_EXPECTED_CORE_SYSTEM_IDENTIFIER="$database_system_identifier"
  export OPERATIONS_EXPECTED_REVISION OPERATIONS_EXPECTED_SNAPSHOT_SHA256 \
    OPERATIONS_EXPECTED_NOTE_COUNT OPERATIONS_EXPECTED_EVENT_COUNT \
    OPERATIONS_EXPECTED_CORE_SYSTEM_IDENTIFIER
  compose --profile migration run --rm -T --no-deps \
    -e OPERATIONS_EXPECTED_REVISION \
    -e OPERATIONS_EXPECTED_SNAPSHOT_SHA256 \
    -e OPERATIONS_EXPECTED_NOTE_COUNT \
    -e OPERATIONS_EXPECTED_EVENT_COUNT \
    -e OPERATIONS_EXPECTED_CORE_SYSTEM_IDENTIFIER \
    --entrypoint node migrate -e '
const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const cleanupPath = "/app/prisma/post-cutover/operations/20260825010000_remove_legacy_operations_core_source.sql";
const revision = process.env.OPERATIONS_EXPECTED_REVISION || "";
const sha256 = process.env.OPERATIONS_EXPECTED_SNAPSHOT_SHA256 || "";
const notes = process.env.OPERATIONS_EXPECTED_NOTE_COUNT || "";
const events = process.env.OPERATIONS_EXPECTED_EVENT_COUNT || "";
const systemIdentifier = process.env.OPERATIONS_EXPECTED_CORE_SYSTEM_IDENTIFIER || "";
if (!/^[0-9a-f]{40}$/.test(revision) || !/^[0-9a-f]{64}$/.test(sha256) ||
    !/^(0|[1-9][0-9]*)$/.test(notes) || !/^(0|[1-9][0-9]*)$/.test(events) ||
    !/^[1-9][0-9]*$/.test(systemIdentifier) ||
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
    `-c winwidget.operations_expected_core_system_identifier=${systemIdentifier}`,
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
  platform_terminal_assert_files_unchanged ||
    fail 'checkout, production env or Compose changed during terminal Operations cleanup'
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

finish_operations_cutover() {
  local revision="$1"
  start_cutover_services
  wait_operations_ready 'http://127.0.0.1:5200/health/ready' api "$revision"
  wait_operations_ready 'http://127.0.0.1:5201/health/ready' worker "$revision"
  wait_operations_ready 'http://127.0.0.1:5202/health/ready' outbox-publisher "$revision"
  wait_ready 'http://127.0.0.1:4900/health/ready' 'Identity API'
  wait_ready 'http://127.0.0.1:4100/health/ready' 'Gateway'
  identity_operations_overview_smoke "$revision"
  assert_integration_runtime "$revision"
  wait_queue_state steady 'Operations and steady integration consumers'
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

operations_snapshot_metadata() {
  local snapshot="$1" revision="$2"
  [[ -f "$snapshot" && ! -L "$snapshot" &&
    "$(stat -c '%u:%g:%a:%h' "$snapshot")" == '1001:1001:600:1' ]] || return 1
  OPERATIONS_SNAPSHOT_PATH="$snapshot" \
    OPERATIONS_EXPECTED_REVISION="$revision" billing_release_node - <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const body = readFileSync(process.env.OPERATIONS_SNAPSHOT_PATH);
let value;
try { value = JSON.parse(body.toString('utf8')); } catch { process.exit(1); }
const keys = value && typeof value === 'object' && !Array.isArray(value)
  ? Object.keys(value).sort() : [];
const expected = ['adminEventLogs', 'counts', 'createdAt', 'notes', 'schemaVersion', 'sourceRevision'];
if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index]) ||
    value.schemaVersion !== 1 || value.sourceRevision !== process.env.OPERATIONS_EXPECTED_REVISION ||
    !value.counts || Object.keys(value.counts).sort().join(',') !== 'adminEventLogs,notes' ||
    !Number.isSafeInteger(value.counts.notes) || value.counts.notes < 0 ||
    !Number.isSafeInteger(value.counts.adminEventLogs) || value.counts.adminEventLogs < 0 ||
    !Array.isArray(value.notes) || value.notes.length !== value.counts.notes ||
    !Array.isArray(value.adminEventLogs) || value.adminEventLogs.length !== value.counts.adminEventLogs ||
    typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) ||
    body.length === 0 || body[body.length - 1] !== 0x0a) process.exit(1);
const sha256 = createHash('sha256').update(body).digest('hex');
process.stdout.write(`${sha256} ${value.counts.notes} ${value.counts.adminEventLogs}\n`);
NODE
}

operations_resume_state() {
  local snapshot="$1" revision="$2" metadata core_status target_status unanchored_state
  if [[ ! -e "$snapshot" && ! -L "$snapshot" ]]; then
    printf 'new - - -\n'
    return
  fi
  [[ -f "$snapshot" && ! -L "$snapshot" &&
    "$(stat -c '%u:%g:%a:%h' "$snapshot")" == '1001:1001:600:1' ]] ||
    fail 'existing Operations snapshot path is unsafe'
  core_status="$(root_cutover status)" || fail 'Core Operations retry state cannot be read'
  target_status="$(target_cutover status)" || fail 'Operations target retry state cannot be read'
  unanchored_state="$(OPERATIONS_CORE_STATUS="$core_status" \
    OPERATIONS_TARGET_STATUS="$target_status" \
    OPERATIONS_EXPECTED_REVISION="$revision" billing_release_node - <<'NODE'
let core;
let target;
try {
  core = JSON.parse(process.env.OPERATIONS_CORE_STATUS || 'null');
  target = JSON.parse(process.env.OPERATIONS_TARGET_STATUS || 'null');
} catch { process.exit(1); }
const revision = process.env.OPERATIONS_EXPECTED_REVISION || '';
const exactCore = core && core.ownership === 'CORE' &&
  core.preparedRevision === revision && core.ownershipRevision === null &&
  core.snapshotSha256 === null && core.sourceWritesEnabled === false &&
  core.legacyRoutesEnabled === true && Number.isSafeInteger(core.notes) && core.notes >= 0 &&
  Number.isSafeInteger(core.adminEventLogs) && core.adminEventLogs >= 0;
const exactTarget = target && target.phase === 'EMPTY' && target.sourceRevision === null &&
  target.snapshotSha256 === null && target.notes === 0 && target.adminEventLogs === 0;
process.stdout.write(exactCore && exactTarget ? 'exact-unanchored' : 'anchored-or-unsafe');
NODE
  )" || fail 'Operations snapshot crash-window state cannot be classified'
  if [[ "$unanchored_state" == exact-unanchored ]]; then
    # exportSnapshot uses O_EXCL and fsyncs before anchoring the digest in Core.
    # Only that exact crash window may discard the untrusted/unanchored file.
    rm -- "$snapshot"
    sync -f "$(dirname -- "$snapshot")"
    [[ ! -e "$snapshot" && ! -L "$snapshot" ]] ||
      fail 'unanchored Operations snapshot could not be retired'
    printf 'new - - -\n'
    return
  fi
  [[ "$unanchored_state" == anchored-or-unsafe ]] || return 1
  metadata="$(operations_snapshot_metadata "$snapshot" "$revision")" ||
    fail 'existing Operations snapshot is not the exact safe retry artifact'
  OPERATIONS_SNAPSHOT_METADATA="$metadata" \
    OPERATIONS_CORE_STATUS="$core_status" \
    OPERATIONS_TARGET_STATUS="$target_status" \
    OPERATIONS_EXPECTED_REVISION="$revision" billing_release_node - <<'NODE'
const [sha256, notesText, eventsText] = (process.env.OPERATIONS_SNAPSHOT_METADATA || '').split(' ');
const notes = Number(notesText);
const events = Number(eventsText);
let core;
let target;
try {
  core = JSON.parse(process.env.OPERATIONS_CORE_STATUS || 'null');
  target = JSON.parse(process.env.OPERATIONS_TARGET_STATUS || 'null');
} catch { process.exit(1); }
const revision = process.env.OPERATIONS_EXPECTED_REVISION || '';
const targetCounts = target && target.notes === notes && target.adminEventLogs === events;
const targetExact = target && target.sourceRevision === revision &&
  target.snapshotSha256 === sha256 && targetCounts;
if (core?.source === 'removed') {
  if (target?.phase !== 'ACTIVE' || !targetExact) process.exit(1);
  process.stdout.write(`complete ${sha256} ${notes} ${events}\n`);
  process.exit(0);
}
const coreExact = core && ['CORE', 'OPERATIONS'].includes(core.ownership) &&
  core.preparedRevision === revision && core.snapshotSha256 === sha256 &&
  core.notes === notes && core.adminEventLogs === events &&
  core.sourceWritesEnabled === false &&
  ((core.ownership === 'CORE' && core.ownershipRevision === null && core.legacyRoutesEnabled === true) ||
   (core.ownership === 'OPERATIONS' && core.ownershipRevision === revision && core.legacyRoutesEnabled === false));
const targetEmpty = target?.phase === 'EMPTY' && target.sourceRevision === null &&
  target.snapshotSha256 === null && target.notes === 0 && target.adminEventLogs === 0;
const targetPrepared = ['IMPORTED', 'ACTIVE'].includes(target?.phase) && targetExact;
if (!coreExact || (!targetEmpty && !targetPrepared)) process.exit(1);
process.stdout.write(`resume-${core.ownership.toLowerCase()} ${sha256} ${notes} ${events}\n`);
NODE
}

status() {
  local revision="$1" core_status target_status
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail 'status requires EXPECTED_REVISION'
  export_coordinated_revision "$revision"
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
  local export_json sha256 note_count event_count resume_state
  local platform_prerequisite platform_mode platform_revision
  local forward_phase_started=false

  trap 'if [[ "$forward_phase_started" == true ]]; then printf "%s\n" "Operations cutover failed during or after a forward-only downtime phase; services may remain stopped. Keep the state unchanged and rerun this exact controller." >&2; fi' ERR

  assert_inputs
  assert_checkout "$revision"
  export_coordinated_revision "$revision"
  assert_steady_integration_contract

  # shellcheck source=scripts/production-deploy-lock.sh
  source "$SERVER_ROOT/scripts/production-deploy-lock.sh"
  acquire_production_deploy_lock 'Operations hard cutover'

  # Prefer the previously evidenced Platform cleanup when it exists. If it was
  # never run, the same locked downtime window performs the real fenced source
  # drop with a separate truthful terminal marker; no backup evidence is forged.
  platform_prerequisite="$(assert_platform_cleanup_prerequisite "$revision")" ||
    fail 'Platform cleanup prerequisite is invalid'
  IFS='|' read -r platform_mode platform_revision <<<"$platform_prerequisite"
  [[ "$platform_mode" =~ ^(legacy|terminal)$ &&
    "$platform_revision" =~ ^[0-9a-f]{40}$ ]] ||
    fail 'Platform cleanup prerequisite returned an invalid state'

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
  [[ ! -L "$snapshot_host" &&
    (! -e "$snapshot_host" || -f "$snapshot_host") ]] ||
    fail 'Operations snapshot path is unsafe'

  compose build --provenance=false \
    api api-gateway maintenance-worker database-restore-worker \
    notification-delivery-worker campaigns-service reporting-service \
    widgets-service billing-api identity-api platform-api support-api \
    operations-api
  assert_identity_release_prerequisite "$revision"
  OPERATIONS_ENV_FILE="$ENV_FILE" \
    bash "$SERVER_ROOT/scripts/operations-database-prepare.sh" --prepare
  if [[ "$platform_mode" == terminal ]]; then
    forward_phase_started=true
    run_or_verify_terminal_platform_cleanup "$revision"
  fi
  # The terminal runner may already have applied every pending migration. This
  # idempotent deploy also covers the ordinary legacy-cleanup path and the
  # Operations prepare migration immediately following the Platform DDL.
  compose --profile migration run --rm -T --no-deps migrate
  if [[ "$platform_mode" == terminal ]]; then
    # The terminal DDL requires integration-worker to be stopped. Recreate the
    # exact coordinated revision before the later legacy audit queue drain.
    compose up -d --no-deps --no-build --force-recreate integration-worker
    assert_integration_runtime "$revision"
  fi
  read -r resume_state sha256 note_count event_count < <(
    operations_resume_state "$snapshot_host" "$revision"
  ) || fail 'Operations cutover retry state is unsafe'
  [[ "$resume_state" =~ ^(new|resume-core|resume-operations|complete)$ ]] ||
    fail 'Operations cutover retry classifier returned an invalid state'
  if [[ "$resume_state" == complete ]]; then
    rabbit_queue_snapshot > /dev/null
    provision_rabbitmq "$revision"
    finish_operations_cutover "$revision"
    forward_phase_started=false
    trap - ERR
    printf 'Operations ownership is already active at revision %s; exact terminal retry verification completed.\n' "$revision"
    return
  fi
  if [[ "$resume_state" != resume-operations ]]; then
    root_cutover prepare --revision "$revision"
  fi
  rabbit_queue_snapshot > /dev/null

  # Hard-downtime handoff: freeze every audit source while the legacy
  # integration-worker drains its already-bound audit queues. DLQs are never
  # purged and pending source Outbox rows remain durable until restart.
  forward_phase_started=true
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
    identity-api operations-api operations-worker operations-outbox-publisher
  if [[ "$resume_state" == new ]]; then
    root_cutover fence --revision "$revision"
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
    [[ "$(operations_snapshot_metadata "$snapshot_host" "$revision")" == \
      "$sha256 $note_count $event_count" ]] ||
      fail 'Core snapshot was not created as the exact safe artifact'
  elif [[ "$resume_state" == resume-core ]]; then
    root_cutover fence --revision "$revision"
    [[ "$(operations_snapshot_metadata "$snapshot_host" "$revision")" == \
      "$sha256 $note_count $event_count" ]] ||
      fail 'Core retry snapshot changed after classification'
  else
    [[ "$resume_state" == resume-operations &&
      "$(operations_snapshot_metadata "$snapshot_host" "$revision")" == \
        "$sha256 $note_count $event_count" ]] ||
      fail 'activated Core retry snapshot changed after classification'
  fi

  platform_terminal_assert_files_unchanged ||
    fail 'checkout, production env or Compose changed before Operations import'
  database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"
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

  finish_operations_cutover "$revision"
  forward_phase_started=false
  trap - ERR

  printf 'Operations ownership is active at revision %s and the legacy Core source is removed.\n' "$revision"
}

self_test() {
  local revision='a234567890123456789012345678901234567890'
  local source source_without_backslashes cutover_source cleanup_sql ledger_argument_contract key
  local gateway_assert_contract gateway_manifest_contract gateway_ready_contract gateway_wait_contract
  local gateway_wait_source live_owner_runtime_source node_runtime_source self_test_server_root index
  local guc_admin_source guc_configure_source
  local prepared_recovery_source archive_source rebind_source marker_retry_source terminal_runner_source
  local recovery_line apply_line
  local -a source_contracts normalized_source_contracts cutover_contracts
  local -a forbidden_source_contracts
  source="$(declare -f \
    assert_inputs \
    assert_steady_integration_contract \
    assert_platform_cleanup_prerequisite \
    platform_terminal_assert_files_unchanged \
    platform_terminal_prepare_live_owner_runtime \
    platform_terminal_assert_core_outbox_runtime \
    platform_terminal_wait_core_outbox_drained \
    platform_terminal_wait_gateway_healthy \
    platform_terminal_core_admin_query \
    platform_terminal_configure_gucs \
    platform_terminal_git_file_sha256 \
    platform_terminal_prepared_recovery_archive_path \
    platform_terminal_archive_prepared_marker \
    platform_terminal_rebind_prepared_marker \
    platform_terminal_recover_pinned_prepared_marker \
    platform_terminal_marker_retry_mode \
    platform_terminal_candidate_migration_state \
    platform_terminal_operations_prepare_state \
    platform_terminal_assert_exact_repo_ledger \
    platform_terminal_rollback_pristine_operations_prepare \
    platform_terminal_recover_operations_prepare \
    run_or_verify_terminal_platform_cleanup \
    verify_terminal_platform_cleanup \
    export_coordinated_revision \
    stop_audit_source_services \
    queue_state_matches \
    retire_drained_legacy_audit_queues \
    identity_introspection_smoke \
    assert_identity_release_prerequisite \
    identity_operations_overview_smoke \
    assert_integration_runtime \
    operations_resume_state \
    run_core_source_cleanup \
    provision_rabbitmq \
    status \
    cutover)"
  source_without_backslashes="${source//\\/}"
  cutover_source="$(declare -f cutover)"
  gateway_wait_source="$(declare -f platform_terminal_wait_gateway_healthy)"
  live_owner_runtime_source="$(declare -f platform_terminal_prepare_live_owner_runtime)"
  guc_admin_source="$(declare -f platform_terminal_core_admin_query)"
  guc_configure_source="$(declare -f platform_terminal_configure_gucs)"
  prepared_recovery_source="$(declare -f platform_terminal_recover_pinned_prepared_marker)"
  archive_source="$(declare -f platform_terminal_archive_prepared_marker)"
  rebind_source="$(declare -f platform_terminal_rebind_prepared_marker)"
  marker_retry_source="$(declare -f platform_terminal_marker_retry_mode)"
  terminal_runner_source="$(declare -f run_or_verify_terminal_platform_cleanup)"
  gateway_ready_contract="wait_ready 'http://127.0.0.1:4100/health/ready' 'Gateway'"
  gateway_manifest_contract='platform_cutover_validate_gateway_manifest "$gateway_image_id"'
  gateway_wait_contract='gateway_container="$(platform_terminal_wait_gateway_healthy "$gateway_image_id")"'
  gateway_assert_contract='[[ "$(platform_cutover_assert_gateway_runtime)" == "$gateway_container" ]]'
  node_runtime_source="$(declare -f \
    read_env_value \
    wait_operations_ready \
    queue_state_matches \
    retire_drained_legacy_audit_queues \
    status \
    cutover)"
  [[ "$CONFIRMATION" == 'CUT OVER OPERATIONS FORWARD ONLY' ]]
  [[ "$PLATFORM_TERMINAL_CONFIRMATION" == 'DROP PLATFORM CORE SOURCE DURING OPERATIONS CUTOVER' ]]
  [[ "$PLATFORM_PREPARED_RECOVERY_CONFIRMATION" == \
    'RECOVER EXACT PREPARED PLATFORM MARKER' ]]
  [[ "$PLATFORM_TERMINAL_MARKER_NAME" == '.platform-core-source-terminal-v1' &&
    "$OPERATIONS_PREP_MIGRATION" == '20260824030000_prepare_operations_service_ownership' &&
    "$PLATFORM_TERMINAL_MIGRATION" == '20260825000000_remove_legacy_platform_core_source' ]]
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]]
  [[ "$(platform_terminal_marker_retry_mode \
    "$revision" "$revision" prepared present pending)" == creation ]]
  [[ "$(platform_terminal_marker_retry_mode \
    b234567890123456789012345678901234567890 "$revision" prepared present pending)" == \
    prepared-recovery ]]
  [[ "$(platform_terminal_marker_retry_mode \
    b234567890123456789012345678901234567890 "$revision" complete absent applied)" == \
    descendant ]]
  if platform_terminal_marker_retry_mode \
    b234567890123456789012345678901234567890 "$revision" complete present applied \
    >/dev/null 2>&1; then
    return 1
  fi
  [[ "$CONTAINER_ARTIFACT_DIR" == '/var/lib/winwidget/operations-cutover' ]]
  ledger_argument_contract="$(billing_release_node - operations-migration platform-migration <<'NODE'
if (process.argv[2] !== 'operations-migration' || process.argv[3] !== 'platform-migration') {
  process.exit(1);
}
process.stdout.write('passed');
NODE
)"
  [[ "$ledger_argument_contract" == passed ]]
  for key in OPERATIONS_PLATFORM_LEDGER_STATE OPERATIONS_PREP_LEDGER_STATE \
    OPERATIONS_PRISMA_LEDGER OPERATIONS_PRISMA_MANIFEST; do
    [[ " ${BILLING_RELEASE_NODE_ENV_KEYS[*]} " == *" $key "* ]]
  done
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
    'OPERATIONS_PLATFORM_TERMINAL_CONFIRMATION'
    'platform_terminal_assert_exact_repo_ledger'
    'platform_terminal_rollback_pristine_operations_prepare'
    'failed:pristine'
    'failed:absent'
    'prepared:absent:failed | prepared:absent:rolled-back'
    'platform_terminal_assert_files_unchanged'
    'canonical local production Docker daemon is required'
    'winwidget-api:git-$revision'
    'coordinated Core API runtime identity is invalid'
    'platform_terminal_wait_core_outbox_drained'
    "'admin.audit.platform.v1','billing.offer.changed.v2'"
    'coordinated Gateway Docker health timed out'
    '$expected_image_id|running|true|0|winwidget|api-gateway|starting'
    'identity-api operations-api operations-worker operations-outbox-publisher'
    'failed during or after a forward-only downtime phase'
    'platform_database_validate_marker'
    'platform_cutover_validate_marker'
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
    'winwidget.operations_expected_core_system_identifier'
    'Core database identity changed after terminal Platform cleanup'
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
    'platform_terminal_core_admin_query "$sql"'
    'docker exec --env PGPASSWORD'
    'assert_core_database_production_boundary'
    'OPERATIONS_PLATFORM_PREPARED_RECOVERY_CONFIRMATION'
    'OPERATIONS_PLATFORM_PREPARED_ANCESTOR_REVISION'
    'OPERATIONS_PLATFORM_PREPARED_INTERMEDIATE_REVISION'
    'OPERATIONS_PLATFORM_PREPARED_MARKER_SHA256'
    'OPERATIONS_PLATFORM_PREPARED_ENV_SHA256'
    'OPERATIONS_PLATFORM_PREPARED_FINAL_SCRIPT_SHA256'
    'platform_terminal_archive_prepared_marker'
    'platform_terminal_rebind_prepared_marker'
    'pinned prepared Platform marker recovery failed'
  )
  normalized_source_contracts=(
    'winwidget.operations.admin.audit.(campaigns|reporting|widgets|billing|identity|platform|support|core).v1(?:.retry-v1|.dead-letter)?'
    'write: "^winwidget.(retry|dead-letter)$"'
    'winwidget.(events|retry|dead-letter|manual-retry)'
    'winwidget.(events|manual-retry)'
  )
  cutover_contracts=(
    'assert_platform_cleanup_prerequisite "$revision"'
    'run_or_verify_terminal_platform_cleanup "$revision"'
    'operations_resume_state "$snapshot_host" "$revision"'
    'database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"'
  )
  forbidden_source_contracts=(
    '--env "RABBITMQ_ADMIN_PASSWORD='
    '--env DATABASE_URL'
    '--env "DATABASE_URL='
    '--env "PGPASSWORD='
    '--env PGPASSWORD='
    'OPERATIONS_PLATFORM_CLEANUP_BYPASS_CONFIRMATION'
    'CUT OVER OPERATIONS WITH PLATFORM SOURCE RETAINED IN CORE'
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
  [[ "$(grep -Fc 'database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"' \
    <<<"$cutover_source")" -ge 2 ]]
  [[ "$(grep -Fc 'database_restore_guard_assert_before_mutation service-owned-required "$ENV_FILE"' \
    <<<"$source")" -ge 3 ]]
  [[ "$(grep -Fc 'platform_terminal_assert_files_unchanged' <<<"$cutover_source")" -ge 1 ]]
  [[ "$(grep -Fc 'platform_terminal_assert_files_unchanged' <<<"$source")" -ge 3 ]]
  [[ "$gateway_wait_source" == *'[[ "$app_revision" == "$revision" ]]'* &&
    "$gateway_wait_source" == *'$expected_image_id|running|true|0|winwidget|api-gateway|healthy'* ]]
  [[ "$live_owner_runtime_source" == \
    *"$gateway_ready_contract"*"$gateway_manifest_contract"*"$gateway_wait_contract"*"$gateway_assert_contract"* ]]
  [[ "$guc_admin_source" == *'assert_core_database_production_boundary >/dev/null'* &&
    "$guc_admin_source" == *'"$CORE_POSTGRES_CONTAINER"'* &&
    "$guc_admin_source" == *'"$CORE_POSTGRES_ADMIN_PASSWORD_FILE"'* &&
    "$guc_admin_source" == *'--env PGPASSWORD'* &&
    "$guc_admin_source" == *'--username "$CORE_POSTGRES_ADMIN_USER"'* &&
    "$guc_admin_source" == *'--dbname "$CORE_POSTGRES_DATABASE"'* ]]
  [[ "$guc_configure_source" == *'platform_terminal_core_admin_query "$sql"'* &&
    "$(grep -Fc 'platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION' \
      <<<"$guc_configure_source")" -ge 2 &&
    "$guc_configure_source" != \
      *'platform_cleanup_query DATABASE_MIGRATION_URL_PRODUCTION "$sql"'* ]]
  [[ "$prepared_recovery_source" == *'git -C "$SERVER_ROOT" rev-list --parents -n 1 "$intermediate"'* &&
    "$prepared_recovery_source" == *'"$intermediate $ancestor"'* &&
    "$prepared_recovery_source" == *'git -C "$SERVER_ROOT" rev-list --parents -n 1 "$revision"'* &&
    "$prepared_recovery_source" == *'"$revision $intermediate"'* &&
    "$prepared_recovery_source" == *"script_path='scripts/operations-cutover-production.sh'"* &&
    "$prepared_recovery_source" == *'changed_paths="$(git -C "$SERVER_ROOT" diff --name-only "$ancestor" "$revision")"'* &&
    "$prepared_recovery_source" == *'for candidate in "$ancestor" "$intermediate" "$revision"'* &&
    "$prepared_recovery_source" == *'"$source_state" == present && "$migration_state" == pending'* &&
    "$prepared_recovery_source" == *'"$operations_schema" == absent'* &&
    "$prepared_recovery_source" == *'platform_terminal_assert_exact_repo_ledger pending pending creation'* &&
    "$prepared_recovery_source" == *'platform_cleanup_assert_retained_billing_seam'* &&
    "$prepared_recovery_source" == *'compose ps --status running -q api outbox-publisher integration-worker'* &&
    "$prepared_recovery_source" == *'[[ "$guards" == '\''0|0'\'' ]]'* ]]
  [[ "$archive_source" == *'platform_cleanup_prepare_private_directory "$directory"'* &&
    "$archive_source" == *'platform_cleanup_validate_private_file "$archive"'* &&
    "$archive_source" == *'sync -f "$archive" || return 1'* &&
    "$archive_source" == *'sync -f "$directory" || return 1'* &&
    "$archive_source" == *'sync -f "$parent" || return 1'* &&
    "$archive_source" == *'sync -f "$grandparent" || return 1'* &&
    "$archive_source" == *'mv -fT -- "$temporary" "$archive"'* &&
    "$archive_source" == *'"$(platform_cleanup_sha256 "$archive")" == "$expected_sha"'* ]]
  [[ "$rebind_source" == *'phase=prepared'* &&
    "$rebind_source" == *'cleanup_revision=%s'* &&
    "$rebind_source" == *'"$PLATFORM_CORE_SOURCE_CLEANUP_ENV_EXPECTED_SHA256"'* &&
    "$rebind_source" == *'mv -fT -- "$temporary" "$marker"'* &&
    "$rebind_source" == *'sync -f "$marker" || return 1'* &&
    "$rebind_source" == *'sync -f "$directory" || return 1'* &&
    "$rebind_source" == *'platform_terminal_assert_marker_identity creation'* &&
    "$rebind_source" != *'rm -f -- "$marker"'* ]]
  [[ "$prepared_recovery_source" == *'if [[ "$cleanup_revision" == "$revision" ]]'* &&
    "$prepared_recovery_source" == *'sync -f "$marker" || return 1'* &&
    "$prepared_recovery_source" == *'sync -f "$marker_directory" || return 1'* &&
    "$prepared_recovery_source" == *'sync -f "$archive" || return 1'* &&
    "$prepared_recovery_source" == *'sync -f "$archive_directory" || return 1'* &&
    "$prepared_recovery_source" == *'sync -f "$archive_parent" || return 1'* &&
    "$prepared_recovery_source" == *'sync -f "$archive_grandparent" || return 1'* ]]
  [[ "$marker_retry_source" == *'prepared:*) printf '\''prepared-recovery\n'\'''* &&
    "$marker_retry_source" == *'complete:absent:applied) printf '\''descendant\n'\'''* &&
    "$marker_retry_source" != *'complete:*)'* ]]
  recovery_line="$(grep -nF 'platform_terminal_recover_pinned_prepared_marker' \
    <<<"$terminal_runner_source" | awk -F: 'NR == 1 { print $1 }')"
  apply_line="$(grep -nF 'platform_terminal_apply_migrations' \
    <<<"$terminal_runner_source" | awk -F: 'NR == 1 { print $1 }')"
  [[ "$recovery_line" =~ ^[1-9][0-9]*$ && "$apply_line" =~ ^[1-9][0-9]*$ &&
    "$recovery_line" -lt "$apply_line" &&
    "$(grep -Fc 'platform_terminal_assert_marker_identity "$identity_mode"' \
      <<<"$terminal_runner_source")" -ge 3 &&
    "$terminal_runner_source" == *'prepared-recovery)'* &&
    "$terminal_runner_source" == *'descendant) identity_mode=descendant'* &&
    "$terminal_runner_source" != *'rm -f -- "$marker"'* ]]
  for index in "${!forbidden_source_contracts[@]}"; do
    [[ "$source" != *"${forbidden_source_contracts[$index]}"* ]] || {
      printf 'operations-cutover self-test forbidden source contract %s is present\n' "$index" >&2
      return 1
    }
  done
  [[ "$(grep -c 'billing_release_node -' <<<"$node_runtime_source")" -ge 6 ]]
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
  'run_or_verify_terminal_platform_cleanup "$revision"',
  'compose --profile migration run --rm -T --no-deps migrate',
  'operations_resume_state "$snapshot_host" "$revision"',
  'stop_audit_source_services',
  'wait_queue_state legacy-drained',
  'compose stop --timeout 30 integration-worker',
  'wait_queue_state legacy-stopped',
  'wait_queue_state operations-prebind',
  'retire_drained_legacy_audit_queues',
  'provision_rabbitmq "$revision"',
  'identity_introspection_smoke "$revision"',
  'identity-api operations-api operations-worker operations-outbox-publisher',
  'root_cutover fence',
  'root_cutover activate',
  'run_core_source_cleanup "$revision" "$sha256" "$note_count" "$event_count"',
  'finish_operations_cutover "$revision"',
];
let previous = -1;
for (const marker of markers) {
  const index = source.indexOf(marker, previous + 1);
  if (index < 0) {
    process.stderr.write(`operations-cutover self-test ordered marker missing: ${marker}\n`);
    process.exit(1);
  }
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
  !sql.includes('DROP TYPE "public"."OperationsCoreOwnership"') ||
  !sql.includes("current_database() <> 'default_db'") ||
  !sql.includes('(pg_control_system()).system_identifier::TEXT IS DISTINCT FROM expected_system_identifier')
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
      [[ -n "${EXPECTED_REVISION:-}" ]] || fail 'EXPECTED_REVISION is required'
      status "$EXPECTED_REVISION"
      ;;
    --verify-platform-terminal-cleanup)
      [[ -n "${EXPECTED_REVISION:-}" ]] || fail 'EXPECTED_REVISION is required'
      assert_checkout "$EXPECTED_REVISION"
      export_coordinated_revision "$EXPECTED_REVISION"
      verify_terminal_platform_cleanup "$EXPECTED_REVISION"
      ;;
    --cutover)
      [[ -n "${EXPECTED_REVISION:-}" ]] || fail 'EXPECTED_REVISION is required'
      cutover "$EXPECTED_REVISION"
      ;;
    *)
      fail 'usage: operations-cutover-production.sh --self-test|--status|--verify-platform-terminal-cleanup|--cutover'
      ;;
  esac
}

main "$@"
