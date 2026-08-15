#!/usr/bin/env bash
set -e
set -o pipefail

case "$WIDGETS_CUTOVER_CONFIRMATION" in
  ''|'CUTOVER WIDGETS OWNERSHIP') ;;
  *)
    echo 'Invalid Widgets cutover confirmation.' >&2
    exit 1
    ;;
esac
case "$BILLING_ACTION:$BILLING_CONFIRMATION" in
  status:|prepare:) ;;
  cutover:'CUTOVER BILLING OWNERSHIP'|forward-recovery:'CUTOVER BILLING OWNERSHIP') ;;
  abort:'ABORT BILLING CUTOVER') ;;
  *)
    echo 'Invalid Billing action or confirmation.' >&2
    exit 1
    ;;
esac
if [[ "$DEPLOY_TARGET" == 'billing-cleanup' ]]; then
  case "$BILLING_CLEANUP_ACTION:$BILLING_CLEANUP_CONFIRMATION" in
    status:) ;;
    retarget:'RETARGET BILLING CLEANUP REVISION') ;;
    stage:'DROP LEGACY BILLING CORE SOURCE'|seal-offsite:'DROP LEGACY BILLING CORE SOURCE'|run:'DROP LEGACY BILLING CORE SOURCE'|complete-offsite:'DROP LEGACY BILLING CORE SOURCE') ;;
    *)
      echo 'Invalid Billing Core cleanup action or confirmation.' >&2
      exit 1
      ;;
  esac
elif [[ "$BILLING_CLEANUP_ACTION" != 'status' ||
  -n "$BILLING_CLEANUP_CONFIRMATION" ]]; then
  echo 'Billing Core cleanup inputs require the billing-cleanup target.' >&2
  exit 1
fi
if [[ "$DEPLOY_TARGET" == 'identity' ]]; then
  case "$IDENTITY_ACTION:$IDENTITY_CONFIRMATION" in
    status:|export-env:|prepare:) ;;
    cutover:'CUTOVER IDENTITY OWNERSHIP'|forward-recovery:'CUTOVER IDENTITY OWNERSHIP') ;;
    abort-prepare:'ABORT IDENTITY PREPARE') ;;
    *)
      echo 'Invalid Identity action or confirmation.' >&2
      exit 1
      ;;
  esac
  case "$IDENTITY_ACTION" in
    prepare|cutover|forward-recovery)
      [[ "$IDENTITY_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
        echo 'Identity mutation requires the exact local canonical backend env SHA-256.' >&2
        exit 1
      }
      ;;
    *)
      [[ -z "$IDENTITY_ENV_EXPECTED_SHA256" ]] || exit 1
      ;;
  esac
elif [[ "$DEPLOY_TARGET" != 'identity-cleanup' &&
  ( "$IDENTITY_ACTION" != 'status' || -n "$IDENTITY_CONFIRMATION" ||
    -n "$IDENTITY_ENV_EXPECTED_SHA256" ) ]]; then
  echo 'Identity lifecycle inputs require the identity target.' >&2
  exit 1
fi
if [[ "$DEPLOY_TARGET" == 'identity-cleanup' ]]; then
  case "$IDENTITY_CLEANUP_ACTION:$IDENTITY_CLEANUP_CONFIRMATION" in
    status:)
      [[ -z "$IDENTITY_ENV_EXPECTED_SHA256" ]] || exit 1
      ;;
    verify:)
      [[ "$IDENTITY_CLEANUP_MIGRATION_SHA256" =~ ^[0-9a-f]{64}$ &&
        "$IDENTITY_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 1
      ;;
    run:'CLEANUP IDENTITY CORE SOURCE'|forward-recovery:'CLEANUP IDENTITY CORE SOURCE')
      [[ "$IDENTITY_CLEANUP_MIGRATION_SHA256" =~ ^[0-9a-f]{64}$ &&
        "$IDENTITY_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 1
      ;;
    *)
      echo 'Invalid Identity Core cleanup action or confirmation.' >&2
      exit 1
      ;;
  esac
elif [[ "$IDENTITY_CLEANUP_ACTION" != 'status' ||
  -n "$IDENTITY_CLEANUP_CONFIRMATION" ||
  -n "$IDENTITY_CLEANUP_MIGRATION_SHA256" ]]; then
  echo 'Identity cleanup inputs require the identity-cleanup target.' >&2
  exit 1
fi
ssh -i ~/.ssh/deploy_key \
  -o IdentitiesOnly=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=4 \
  -o TCPKeepAlive=yes \
  -p "$SSH_PORT" \
  "$SSH_USER@$SSH_HOST" \
  "APP_ROOT='$APP_ROOT' AUTOMATIC_PROD_PUSH='$AUTOMATIC_PROD_PUSH' EXPECTED_REVISION='$DEPLOY_REVISION' DEPLOY_TARGET='$DEPLOY_TARGET' WIDGETS_CUTOVER_CONFIRMATION='$WIDGETS_CUTOVER_CONFIRMATION' BILLING_ACTION='$BILLING_ACTION' BILLING_CONFIRMATION='$BILLING_CONFIRMATION' BILLING_CLEANUP_ACTION='$BILLING_CLEANUP_ACTION' BILLING_CLEANUP_CONFIRMATION='$BILLING_CLEANUP_CONFIRMATION' IDENTITY_ACTION='$IDENTITY_ACTION' IDENTITY_CONFIRMATION='$IDENTITY_CONFIRMATION' IDENTITY_ENV_EXPECTED_SHA256='$IDENTITY_ENV_EXPECTED_SHA256' IDENTITY_ENV_EXPORT_ID='$IDENTITY_ENV_EXPORT_ID' IDENTITY_CLEANUP_ACTION='$IDENTITY_CLEANUP_ACTION' IDENTITY_CLEANUP_CONFIRMATION='$IDENTITY_CLEANUP_CONFIRMATION' IDENTITY_CORE_CLEANUP_MIGRATION_SHA256='$IDENTITY_CLEANUP_MIGRATION_SHA256' bash -s" <<'EOF'
set -euo pipefail
unset ENV_FILE COMPOSE_FILE REPORTING_DATABASE_MARKER \
  REPORTING_FIRST_ROLLOUT_STAGED_MARKER
cd "$APP_ROOT/winwidget.ru_server"
lock_script="scripts/production-deploy-lock.sh"
[[ "$(id -u)" == "0" && -f "$lock_script" && ! -L "$lock_script" &&
  "$(git branch --show-current)" == "prod" &&
  -z "$(git status --porcelain --untracked-files=all)" ]] || {
  echo "Backend checkout requires a trusted clean prod bootstrap." >&2
  exit 1
}
tracked_lock_blob="$(git rev-parse --verify "HEAD:$lock_script")"
[[ "$(git hash-object "$lock_script")" == "$tracked_lock_blob" ]] || {
  echo "Production lock script differs from the checked-out revision." >&2
  exit 1
}
# shellcheck source=/dev/null
source "$lock_script"
acquire_production_deploy_lock "backend checkout and deployment"
guard_campaigns_checkout_before_pull() {
  local expected_revision="$1"
  local lifecycle_script="scripts/campaigns-database-lifecycle.sh"
  local staged_marker="$APP_ROOT/deploy/backend/.campaigns-first-cutover-staged-v1"
  local cutover_marker="$APP_ROOT/deploy/backend/.campaigns-database-cutover-v1"
  local tracked_blob actual_blob

  [[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || {
    echo "Expected production revision is invalid." >&2
    return 1
  }
  tracked_blob="$(
    git rev-parse --verify "HEAD:$lifecycle_script" 2>/dev/null ||
      true
  )"
  if [[ -e "$lifecycle_script" || -L "$lifecycle_script" ]]; then
    [[ -f "$lifecycle_script" && ! -L "$lifecycle_script" ]] || {
      echo "Campaigns lifecycle guard script is unsafe." >&2
      return 1
    }
    actual_blob="$(git hash-object "$lifecycle_script")"
    [[ -n "$tracked_blob" && "$actual_blob" == "$tracked_blob" ]] || {
      echo "Campaigns lifecycle guard script differs from the checked-out revision." >&2
      return 1
    }
    APP_ROOT="$APP_ROOT" \
      bash "$lifecycle_script" \
        --guard-checkout-revision "$expected_revision"
    return
  fi
  if [[ -n "$tracked_blob" ]]; then
    echo "Tracked Campaigns lifecycle guard script is missing." >&2
    return 1
  fi
  if [[ -e "$staged_marker" || -L "$staged_marker" ||
    -e "$cutover_marker" || -L "$cutover_marker" ]]; then
    echo "Campaigns marker exists but its checkout guard is unavailable." >&2
    return 1
  fi
}
guard_reporting_checkout_before_pull() {
  local expected_revision="$1"
  local guard_action="${2:---guard-before-fetch-revision}"
  local lifecycle_script="scripts/reporting-database-lifecycle.sh"
  local staged_marker="$APP_ROOT/deploy/backend/.reporting-first-rollout-staged-v1"
  local database_marker="$APP_ROOT/deploy/backend/.reporting-database-lifecycle-v1"
  local cutover_marker="$APP_ROOT/deploy/backend/.reporting-database-cutover-v1"
  local tracked_blob actual_blob

  [[ "$expected_revision" =~ ^[0-9a-f]{40}$ &&
    "$guard_action" =~ ^--guard-before-(fetch|checkout)-revision$ ]] || {
    echo "Expected Reporting revision is invalid." >&2
    return 1
  }
  tracked_blob="$(
    git rev-parse --verify "HEAD:$lifecycle_script" 2>/dev/null ||
      true
  )"
  if [[ -e "$lifecycle_script" || -L "$lifecycle_script" ]]; then
    [[ -f "$lifecycle_script" && ! -L "$lifecycle_script" ]] || {
      echo "Reporting lifecycle guard script is unsafe." >&2
      return 1
    }
    actual_blob="$(git hash-object "$lifecycle_script")"
    [[ -n "$tracked_blob" && "$actual_blob" == "$tracked_blob" ]] || {
      echo "Reporting lifecycle guard script differs from the checked-out revision." >&2
      return 1
    }
    APP_ROOT="$APP_ROOT" \
      bash "$lifecycle_script" \
        "$guard_action" "$expected_revision"
    return
  fi
  if [[ -n "$tracked_blob" ]]; then
    echo "Tracked Reporting lifecycle guard script is missing." >&2
    return 1
  fi
  if [[ -e "$staged_marker" || -L "$staged_marker" ||
    -e "$database_marker" || -L "$database_marker" ||
    -e "$cutover_marker" || -L "$cutover_marker" ]]; then
    echo "Reporting marker exists but its checkout guard is unavailable." >&2
    return 1
  fi
}
guard_widgets_checkout_before_pull() {
  local expected_revision="$1"
  local guard_action="${2:---guard-before-fetch-revision}"
  local lifecycle_script="scripts/widgets-database-lifecycle.sh"
  local tracked_blob actual_blob

  [[ "$expected_revision" =~ ^[0-9a-f]{40}$ &&
    "$guard_action" =~ ^--guard-before-(fetch|checkout)-revision$ ]] || {
    echo "Expected Widgets revision is invalid." >&2
    return 1
  }
  tracked_blob="$(
    git rev-parse --verify "HEAD:$lifecycle_script" 2>/dev/null ||
      true
  )"
  if [[ -e "$lifecycle_script" || -L "$lifecycle_script" ]]; then
    [[ -f "$lifecycle_script" && ! -L "$lifecycle_script" ]] || {
      echo "Widgets lifecycle guard script is unsafe." >&2
      return 1
    }
    actual_blob="$(git hash-object "$lifecycle_script")"
    [[ -n "$tracked_blob" && "$actual_blob" == "$tracked_blob" ]] || {
      echo "Widgets lifecycle guard script differs from the checked-out revision." >&2
      return 1
    }
    APP_ROOT="$APP_ROOT" \
      bash "$lifecycle_script" "$guard_action" "$expected_revision"
    return
  fi
  [[ -z "$tracked_blob" ]] || {
    echo "Tracked Widgets lifecycle guard script is missing." >&2
    return 1
  }
}
guard_billing_checkout_before_pull() {
  local expected_revision="$1"
  local guard_action="${2:---guard-before-fetch-revision}"
  local lifecycle_script="scripts/billing-database-lifecycle.sh"
  local database_marker="$APP_ROOT/deploy/backend/.billing-database-lifecycle-v1"
  local cutover_marker="$APP_ROOT/deploy/backend/.billing-cutover-v1"
  local tracked_blob actual_blob

  [[ "$expected_revision" =~ ^[0-9a-f]{40}$ &&
    "$guard_action" =~ ^--guard-before-(fetch|checkout)-revision$ ]] || {
    echo "Expected Billing revision is invalid." >&2
    return 1
  }
  tracked_blob="$(
    git rev-parse --verify "HEAD:$lifecycle_script" 2>/dev/null ||
      true
  )"
  if [[ -e "$lifecycle_script" || -L "$lifecycle_script" ]]; then
    [[ -f "$lifecycle_script" && ! -L "$lifecycle_script" ]] || {
      echo "Billing lifecycle guard script is unsafe." >&2
      return 1
    }
    actual_blob="$(git hash-object "$lifecycle_script")"
    [[ -n "$tracked_blob" && "$actual_blob" == "$tracked_blob" ]] || {
      echo "Billing lifecycle guard script differs from the checked-out revision." >&2
      return 1
    }
    APP_ROOT="$APP_ROOT" \
      bash "$lifecycle_script" "$guard_action" "$expected_revision"
    return
  fi
  [[ -z "$tracked_blob" ]] || {
    echo "Tracked Billing lifecycle guard script is missing." >&2
    return 1
  }
  if [[ -e "$database_marker" || -L "$database_marker" ||
    -e "$cutover_marker" || -L "$cutover_marker" ]]; then
    echo "Billing marker exists but its checkout guard is unavailable." >&2
    return 1
  fi
}
guard_identity_checkout_before_pull() {
  local expected_revision="$1"
  local guard_action="${2:---guard-before-fetch-revision}"
  local lifecycle_script="scripts/identity-database-lifecycle.sh"
  local database_marker="$APP_ROOT/deploy/backend/.identity-database-lifecycle-v1"
  local cutover_marker="$APP_ROOT/deploy/backend/.identity-cutover-v1"
  local cleanup_marker="$APP_ROOT/deploy/backend/.identity-core-cleanup-v1"
  local tracked_blob actual_blob

  [[ "$expected_revision" =~ ^[0-9a-f]{40}$ &&
    "$guard_action" =~ ^--guard-before-(fetch|checkout)-revision$ ]] || {
    echo "Expected Identity revision is invalid." >&2
    return 1
  }
  tracked_blob="$(
    git rev-parse --verify "HEAD:$lifecycle_script" 2>/dev/null || true
  )"
  if [[ -e "$lifecycle_script" || -L "$lifecycle_script" ]]; then
    [[ -f "$lifecycle_script" && ! -L "$lifecycle_script" ]] || {
      echo "Identity lifecycle guard script is unsafe." >&2
      return 1
    }
    actual_blob="$(git hash-object "$lifecycle_script")"
    [[ -n "$tracked_blob" && "$actual_blob" == "$tracked_blob" ]] || {
      echo "Identity lifecycle guard script differs from the checked-out revision." >&2
      return 1
    }
    APP_ROOT="$APP_ROOT" \
      bash "$lifecycle_script" "$guard_action" "$expected_revision"
    return
  fi
  [[ -z "$tracked_blob" ]] || return 1
  if [[ -e "$database_marker" || -L "$database_marker" ||
    -e "$cutover_marker" || -L "$cutover_marker" ||
    -e "$cleanup_marker" || -L "$cleanup_marker" ]]; then
    echo "Identity marker exists but its checkout guard is unavailable." >&2
    return 1
  fi
}
stage_billing_cleanup_revision_with_container_node() (
  [[ $# -eq 2 ]] || return 1
  local current_revision="$1" cleanup_revision="$2"
  local docker_path container_output candidate oneoff container_id
  local project service running restart_count container_revision
  local app_revision image_id inspected_image_id image_revision image_user
  local shim_dir=''
  local status cleanup_status
  local -a canonical_containers=()

  billing_cleanup_node_bootstrap_cleanup() {
    [[ -n "$shim_dir" ]] || return 0
    [[ "$shim_dir" =~ ^/tmp/winwidget-billing-cleanup-node\.[A-Za-z0-9]{6}$ &&
      -d "$shim_dir" && ! -L "$shim_dir" &&
      "$(stat -c '%u:%g:%a' "$shim_dir")" == '0:0:700' ]] ||
      return 1
    rm -f -- "$shim_dir/node" || return 1
    rmdir -- "$shim_dir" || return 1
    shim_dir=''
  }

  billing_cleanup_node_bootstrap_on_exit() {
    status=$?
    set +e
    billing_cleanup_node_bootstrap_cleanup
    cleanup_status=$?
    trap - EXIT
    if [[ "$status" == '0' && "$cleanup_status" != '0' ]]; then
      status="$cleanup_status"
    fi
    exit "$status"
  }
  trap billing_cleanup_node_bootstrap_on_exit EXIT

  [[ "$current_revision" =~ ^[0-9a-f]{40}$ &&
    "$cleanup_revision" =~ ^[0-9a-f]{40}$ &&
    "$current_revision" != "$cleanup_revision" ]] || {
    echo 'Billing cleanup Node bootstrap revisions are invalid.' >&2
    return 1
  }
  [[ "$(id -u)" == '0' && "$(uname -s)" == 'Linux' &&
    -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" ]] || {
    echo 'Billing cleanup Node bootstrap requires the local root Docker context.' >&2
    return 1
  }
  docker_path="$(type -P docker)" || return 1
  docker_path="$(readlink -f "$docker_path")" || return 1
  [[ "$docker_path" =~ ^/[A-Za-z0-9._/+:-]+$ &&
    -f "$docker_path" && ! -L "$docker_path" &&
    -x "$docker_path" ]] || {
    echo 'Billing cleanup Node bootstrap requires a trusted Docker CLI.' >&2
    return 1
  }
  [[ "$("$docker_path" context show)" == 'default' &&
    "$("$docker_path" context inspect default --format \
      '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock' &&
    "$("$docker_path" info --format '{{.OSType}}')" == 'linux' ]] || {
    echo 'Billing cleanup Node bootstrap rejected a non-local Docker daemon.' >&2
    return 1
  }
  container_output="$(
    "$docker_path" ps --no-trunc --filter status=running \
      --filter 'label=com.docker.compose.project=winwidget' \
      --filter 'label=com.docker.compose.service=maintenance-worker' \
      --format '{{.ID}}'
  )" || return 1
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || {
      echo 'Maintenance worker container identity is invalid.' >&2
      return 1
    }
    oneoff="$(
      "$docker_path" inspect --format \
        '{{index .Config.Labels "com.docker.compose.oneoff"}}' \
        "$candidate"
    )" || return 1
    if [[ "$oneoff" =~ ^[Ff]alse$ ]]; then
      canonical_containers+=("$candidate")
    fi
  done <<<"$container_output"
  [[ "${#canonical_containers[@]}" == '1' ]] || {
    echo 'Exactly one running canonical maintenance worker is required.' >&2
    return 1
  }
  container_id="${canonical_containers[0]}"
  project="$(
    "$docker_path" inspect --format \
      '{{index .Config.Labels "com.docker.compose.project"}}' \
      "$container_id"
  )" || return 1
  service="$(
    "$docker_path" inspect --format \
      '{{index .Config.Labels "com.docker.compose.service"}}' \
      "$container_id"
  )" || return 1
  oneoff="$(
    "$docker_path" inspect --format \
      '{{index .Config.Labels "com.docker.compose.oneoff"}}' \
      "$container_id"
  )" || return 1
  running="$(
    "$docker_path" inspect --format '{{.State.Running}}' "$container_id"
  )" || return 1
  restart_count="$(
    "$docker_path" inspect --format '{{.RestartCount}}' "$container_id"
  )" || return 1
  container_revision="$(
    "$docker_path" inspect --format \
      '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "$container_id"
  )" || return 1
  app_revision="$(
    "$docker_path" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
      "$container_id" | awk -F= '
        $1 == "APP_REVISION" {
          print substr($0, index($0, "=") + 1)
          found += 1
        }
        END { exit(found == 1 ? 0 : 1) }
      '
  )" || return 1
  image_id="$(
    "$docker_path" inspect --format '{{.Image}}' "$container_id"
  )" || return 1
  [[ "$container_id" =~ ^[0-9a-f]{64}$ &&
    "$project" == 'winwidget' &&
    "$service" == 'maintenance-worker' &&
    "$oneoff" =~ ^[Ff]alse$ &&
    "$running" == 'true' && "$restart_count" == '0' &&
    "$container_revision" == "$current_revision" &&
    "$app_revision" == "$current_revision" &&
    "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo 'Canonical maintenance worker failed the Node bootstrap identity gate.' >&2
    return 1
  }
  inspected_image_id="$(
    "$docker_path" image inspect --format '{{.Id}}' "$image_id"
  )" || return 1
  image_revision="$(
    "$docker_path" image inspect --format \
      '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "$image_id"
  )" || return 1
  image_user="$(
    "$docker_path" image inspect --format '{{.Config.User}}' "$image_id"
  )" || return 1
  [[ "$inspected_image_id" == "$image_id" &&
    "$image_revision" == "$current_revision" &&
    "$image_user" == 'nestjs' ]] || {
    echo 'Maintenance worker image failed the immutable revision gate.' >&2
    return 1
  }

  umask 077
  shim_dir="$(mktemp -d /tmp/winwidget-billing-cleanup-node.XXXXXX)" ||
    return 1
  [[ "$shim_dir" =~ ^/tmp/winwidget-billing-cleanup-node\.[A-Za-z0-9]{6}$ &&
    -d "$shim_dir" && ! -L "$shim_dir" &&
    "$(stat -c '%u:%g:%a' "$shim_dir")" == '0:0:700' ]] ||
    return 1
  export BILLING_CLEANUP_BOOTSTRAP_DOCKER="$docker_path"
  export BILLING_CLEANUP_BOOTSTRAP_NODE_IMAGE="$image_id"
  cat >"$shim_dir/node" <<'BILLING_CLEANUP_NODE_SHIM'
#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# == 2 && "$1" == '-e' && ${#2} == 658 ]] || exit 1
parser_sha256="$(printf '%s' "$2" | sha256sum)"
parser_sha256="${parser_sha256%% *}"
[[ "$parser_sha256" == \
  'fff593a9f2fe2cf95ab5fb20ca537e4f0cc1d0ecfba186745b3491ecdb45936b' ]] ||
  exit 1
case "${FIELD:-}" in
  protocol|username|password|hostname|port|database|schema) ;;
  *) exit 1 ;;
esac
[[ "${BILLING_CLEANUP_BOOTSTRAP_DOCKER:-}" =~ \
  ^/[A-Za-z0-9._/+:-]+$ &&
  -x "$BILLING_CLEANUP_BOOTSTRAP_DOCKER" &&
  "${BILLING_CLEANUP_BOOTSTRAP_NODE_IMAGE:-}" =~ \
  ^sha256:[0-9a-f]{64}$ ]] || exit 1
billing_url=''
IFS= read -r billing_url || exit 1
[[ -n "$billing_url" && "$billing_url" != *$'\r'* ]] || exit 1
remainder=''
if IFS= read -r remainder || [[ -n "$remainder" ]]; then
  exit 1
fi
printf '%s\n' "$billing_url" | \
  "$BILLING_CLEANUP_BOOTSTRAP_DOCKER" run --rm --interactive \
    --network none --read-only --user 65534:65534 --cap-drop ALL \
    --pids-limit 64 --cpus 1 --memory 512m --memory-swap 512m \
    --log-driver none --security-opt no-new-privileges --entrypoint node \
    --env "FIELD=$FIELD" \
    "$BILLING_CLEANUP_BOOTSTRAP_NODE_IMAGE" -e "$2"
BILLING_CLEANUP_NODE_SHIM
  chown 0:0 "$shim_dir/node"
  chmod 700 "$shim_dir/node"
  [[ -f "$shim_dir/node" && ! -L "$shim_dir/node" &&
    "$(stat -c '%u:%g:%a' "$shim_dir/node")" == '0:0:700' ]] ||
    return 1

  PATH="$shim_dir:$PATH" \
    APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$current_revision" \
    BILLING_CLEANUP_STAGE_CONFIRMATION='STAGE BILLING CLEANUP REVISION' \
    bash scripts/billing-cutover-production.sh \
      --stage-cleanup-revision "$cleanup_revision"
)
retarget_billing_cleanup_revision() (
  [[ $# -eq 2 ]] || return 1
  local previous_cleanup_revision="$1" next_cleanup_revision="$2"
  local migration_path migration_blob helper_path helper_blob lifecycle_blob
  local cleanup_marker evidence_root receipt receipt_temporary
  local receipt_state database_state cutover_state source_state migration_state
  local ownership_revision key actual expected service container_id identity image_id
  local image_revision container_revision app_revision state health all_container_ids
  local database_temporary cutover_temporary checkout_revision docker_path
  local database_contract_sha256 cutover_contract_sha256 root_receipt
  local receipt_next_revision receipt_created_at
  local ENV_FILE="$APP_ROOT/deploy/backend/.env.production"
  local COMPOSE_FILE="$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml"
  local database_marker="$APP_ROOT/deploy/backend/.billing-database-lifecycle-v1"
  local cutover_marker="$APP_ROOT/deploy/backend/.billing-cutover-v1"
  local -a writer_services=(
    api-gateway campaigns-service api outbox-publisher maintenance-worker
    database-restore-worker notification-delivery-worker integration-worker
    reporting-service widgets-service billing-api billing-scheduler billing-worker
    billing-outbox-publisher identity-api identity-worker identity-outbox-publisher
  )
  local -a persisted_identity_keys=(
    DATABASE_RESTORE_REVISION DATABASE_RESTORE_IMAGE
    BILLING_REVISION BILLING_IMAGE
  )

  retarget_cleanup_temporary_files() {
    rm -f -- "${helper_path:-}" "${receipt_temporary:-}" \
      "${database_temporary:-}" "${cutover_temporary:-}"
  }

  [[ "$AUTOMATIC_PROD_PUSH" == 'false' &&
    "$DEPLOY_TARGET" == 'billing-cleanup' &&
    "$BILLING_CLEANUP_ACTION" == 'retarget' &&
    "$BILLING_CLEANUP_CONFIRMATION" == 'RETARGET BILLING CLEANUP REVISION' &&
    "$previous_cleanup_revision" =~ ^[0-9a-f]{40}$ &&
    "$next_cleanup_revision" =~ ^[0-9a-f]{40}$ &&
    "$previous_cleanup_revision" != "$next_cleanup_revision" &&
    "$(id -u)" == '0' && "$(uname -s)" == 'Linux' &&
    -z "${DOCKER_HOST+x}" && -z "${DOCKER_CONTEXT+x}" &&
    "$(git branch --show-current)" == 'prod' &&
    -z "$(git status --porcelain --untracked-files=all)" ]] || {
    echo 'Billing cleanup retarget requires its exact manual production boundary.' >&2
    return 1
  }
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" &&
    "$(stat -c '%u:%g:%a' "$ENV_FILE")" == '0:0:600' &&
    -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || {
    echo 'Billing cleanup retarget rejected the production configuration boundary.' >&2
    return 1
  }
  docker_path="$(type -P docker 2>/dev/null || true)"
  docker_path="$(readlink -f "$docker_path" 2>/dev/null || true)"
  [[ "$docker_path" =~ ^/[A-Za-z0-9._/+:-]+$ &&
    -f "$docker_path" && ! -L "$docker_path" && -x "$docker_path" &&
    "$("$docker_path" context show)" == 'default' &&
    "$("$docker_path" context inspect default --format \
      '{{.Endpoints.docker.Host}}')" == 'unix:///var/run/docker.sock' &&
    "$("$docker_path" info --format '{{.OSType}}')" == 'linux' ]] || {
    echo 'Billing cleanup retarget requires the canonical local Docker daemon.' >&2
    return 1
  }
  checkout_revision="$(git rev-parse HEAD)"
  [[ "$checkout_revision" == "$previous_cleanup_revision" ||
    "$checkout_revision" == "$next_cleanup_revision" ]] || return 1
  git cat-file -e "$next_cleanup_revision^{commit}" 2>/dev/null || {
    echo 'Billing cleanup retarget candidate is unavailable locally.' >&2
    return 1
  }
  git merge-base --is-ancestor \
    "$previous_cleanup_revision" "$next_cleanup_revision" || {
    echo 'Billing cleanup retarget candidate must descend from the staged revision.' >&2
    return 1
  }
  migration_path='prisma/migrations/20260813000000_remove_legacy_billing_core_source/migration.sql'
  migration_blob="$(git rev-parse "$previous_cleanup_revision:$migration_path")" || return 1
  [[ "$migration_blob" == "$(git rev-parse "$next_cleanup_revision:$migration_path")" &&
    "$(git rev-parse "$previous_cleanup_revision:prisma/migrations")" == \
    "$(git rev-parse "$next_cleanup_revision:prisma/migrations")" ]] || {
    echo 'Billing cleanup retarget candidate changed the reviewed migration tree.' >&2
    return 1
  }
  [[ "$(git rev-parse "$checkout_revision:scripts/billing-database-lifecycle.sh")" == \
    "$(git hash-object scripts/billing-database-lifecycle.sh)" &&
    "$(git rev-parse "$checkout_revision:scripts/billing-cutover-production.sh")" == \
    "$(git hash-object scripts/billing-cutover-production.sh)" ]] || {
    echo 'Billing cleanup guards differ from the checked-out staged revision.' >&2
    return 1
  }
  [[ -f "$database_marker" && ! -L "$database_marker" &&
    "$(stat -c '%u:%g:%a' "$database_marker")" == '0:0:600' &&
    -f "$cutover_marker" && ! -L "$cutover_marker" &&
    "$(stat -c '%u:%g:%a' "$cutover_marker")" == '0:0:600' ]] || {
    echo 'Billing cleanup retarget parent markers are unsafe.' >&2
    return 1
  }
  # shellcheck source=/dev/null
  source scripts/billing-cutover-production.sh
  helper_blob="$(git rev-parse \
    "$next_cleanup_revision:scripts/billing-release-identity.sh")" || return 1
  lifecycle_blob="$(git rev-parse \
    "$next_cleanup_revision:scripts/billing-database-lifecycle.sh")" || return 1
  helper_path="$(mktemp /tmp/winwidget-billing-retarget-helper.XXXXXX)" || return 1
  trap retarget_cleanup_temporary_files EXIT
  git show \
    "$next_cleanup_revision:scripts/billing-release-identity.sh" >"$helper_path"
  chown 0:0 "$helper_path"
  chmod 600 "$helper_path"
  [[ "$helper_path" =~ ^/tmp/winwidget-billing-retarget-helper\.[A-Za-z0-9]{6}$ &&
    -f "$helper_path" && ! -L "$helper_path" &&
    "$(stat -c '%u:%g:%a' "$helper_path")" == '0:0:600' &&
    "$(git hash-object "$helper_path")" == "$helper_blob" ]] || {
    echo 'Billing cleanup retarget candidate Node helper is not the reviewed Git blob.' >&2
    return 1
  }
  # Source only the reviewed candidate helper. SHA B lifecycle functions
  # remain active, while this compatibility wrapper maps their legacy
  # zero-argument heredocs to the candidate helper's explicit `node -`.
  # shellcheck source=/dev/null
  source "$helper_path"
  eval "$(declare -f billing_release_node | \
    sed '1s/^billing_release_node /billing_retarget_candidate_node /')"
  declare -F billing_retarget_candidate_node >/dev/null || return 1
  billing_release_node() {
    if [[ $# -eq 0 ]]; then
      billing_retarget_candidate_node -
    elif [[ "$1" == '-e' ]]; then
      billing_release_node_stdin "$@"
    else
      billing_retarget_candidate_node "$@"
    fi
  }
  rm -f -- "$helper_path"
  helper_path=''
  billing_database_validate_urls || return 1
  # database-restore-production-guard: before-mutation
  database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE" || return 1
  billing_database_validate_marker || return 1
  billing_cutover_validate_marker || return 1
  ownership_revision="$(billing_database_marker_value ownership_revision)" || return 1
  database_state="$(billing_database_marker_value cleanup_revision)" || return 1
  cutover_state="$(billing_core_source_cleanup_parent_marker_value \
    "$cutover_marker" cleanup_revision)" || return 1
  [[ "$(billing_database_marker_value phase)" == 'complete' &&
    "$(billing_database_marker_value switch_generation)" == '2' &&
    ( "$database_state" == "$previous_cleanup_revision" ||
      "$database_state" == "$next_cleanup_revision" ) &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" phase)" == 'complete' &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" generation)" == '2' &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" revision)" == "$ownership_revision" &&
    ( "$cutover_state" == "$previous_cleanup_revision" ||
      "$cutover_state" == "$next_cleanup_revision" ) ]] || {
    echo 'Billing cleanup retarget requires complete generation-2 parent markers bound to SHA B.' >&2
    return 1
  }
  for key in "${persisted_identity_keys[@]}"; do
    actual="$(billing_read_env_value "$ENV_FILE" "$key")" || return 1
    expected="$(billing_release_identity_value "$key" "$ownership_revision")" || return 1
    [[ "$actual" == "$expected" ]] || {
      echo "Billing cleanup retarget rejected the SHA A production identity key: $key" >&2
      return 1
    }
  done
  [[ "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" database_id)" == \
    "$(billing_database_marker_value database_id)" &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" core_image_id)" == \
    "$(billing_database_marker_value core_image_id)" &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" billing_image_id)" == \
    "$(billing_database_marker_value billing_image_id)" &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" snapshot_sha256)" == \
    "$(billing_database_marker_value snapshot_sha256)" &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" projection_sha256)" == \
    "$(billing_database_marker_value projection_evidence_sha256)" &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" route_sha256)" == \
    "$(billing_database_marker_value route_evidence_sha256)" &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" pre_restore_evidence_sha256)" == \
    "$(billing_database_marker_value pre_restore_evidence_sha256)" &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" pre_offsite_receipt_sha256)" == \
    "$(billing_database_marker_value pre_offsite_receipt_sha256)" &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" post_restore_evidence_sha256)" == \
    "$(billing_database_marker_value post_restore_evidence_sha256)" &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" post_offsite_receipt_sha256)" == \
    "$(billing_database_marker_value post_offsite_receipt_sha256)" ]] || {
    echo 'Billing cleanup retarget parent marker identities/evidence differ.' >&2
    return 1
  }
  cleanup_marker="$(billing_core_source_cleanup_marker_path)" || return 1
  evidence_root="$APP_ROOT/deploy/backend/billing-core-source-cleanup"
  [[ ! -e "$cleanup_marker" && ! -L "$cleanup_marker" ]] || {
    echo 'Billing cleanup retarget is forbidden after the dedicated cleanup marker exists.' >&2
    return 1
  }
  if [[ -e "$evidence_root" || -L "$evidence_root" ]]; then
    [[ -d "$evidence_root" && ! -L "$evidence_root" &&
      "$(stat -c '%u:%g:%a' "$evidence_root")" == '0:0:700' &&
      -z "$(find "$evidence_root" -mindepth 1 -print -quit)" ]] || {
      echo 'Billing cleanup retarget is forbidden after cleanup evidence exists.' >&2
      return 1
    }
  fi
  source_state="$(billing_core_source_state)" || return 1
  migration_state="$(billing_core_source_cleanup_migration_state)" || return 1
  [[ "$source_state" == 'present' && "$migration_state" == 'pending' ]] || {
    echo 'Billing cleanup retarget requires intact Core source and a pending cleanup migration.' >&2
    return 1
  }
  billing_core_source_cleanup_require_exact_migration_manifest exclusive || {
    echo 'Billing cleanup retarget rejected the tracked migration manifest or ledger.' >&2
    return 1
  }
  all_container_ids="$(billing_compose "$previous_cleanup_revision" "$ENV_FILE" \
    "$COMPOSE_FILE" ps -a -q "${writer_services[@]}" 2>/dev/null || true)"
  [[ "$(printf '%s\n' "$all_container_ids" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')" == \
    "${#writer_services[@]}" ]] || {
    echo 'Billing cleanup retarget requires exactly 14 canonical writer containers.' >&2
    return 1
  }
  for service in "${writer_services[@]}"; do
    container_id="$(billing_compose "$previous_cleanup_revision" "$ENV_FILE" \
      "$COMPOSE_FILE" ps --status running -q "$service" 2>/dev/null || true)"
    [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
      echo "Billing cleanup retarget requires exactly one running SHA A service: $service" >&2
      return 1
    }
    identity="$(docker inspect --format \
      '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{index .Config.Labels "com.docker.compose.container-number"}}' \
      "$container_id" 2>/dev/null || true)"
    image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
    container_revision="$(docker inspect --format \
      '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "$container_id" 2>/dev/null || true)"
    image_revision="$(docker image inspect --format \
      '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "$image_id" 2>/dev/null || true)"
    app_revision="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
      "$container_id" 2>/dev/null | awk -F= '
        $1 == "APP_REVISION" {
          print substr($0, index($0, "=") + 1)
          found += 1
        }
        END { exit(found == 1 ? 0 : 1) }
      ')" || return 1
    state="$(docker inspect --format \
      '{{.State.Status}}|{{.State.Running}}|{{.RestartCount}}' \
      "$container_id" 2>/dev/null || true)"
    health="$(docker inspect --format \
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$container_id" 2>/dev/null || true)"
    case "$service:$health" in
      outbox-publisher:none | integration-worker:none | *:healthy) ;;
      *)
        echo "Billing cleanup retarget rejected SHA A service health: $service" >&2
        return 1
        ;;
    esac
    [[ "$identity" =~ ^winwidget\|$service\|[Ff]alse\|1$ &&
      "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
      "$container_revision" == "$ownership_revision" &&
      "$image_revision" == "$ownership_revision" &&
      "$app_revision" == "$ownership_revision" &&
      "$state" == 'running|true|0' ]] || {
      echo "Billing cleanup retarget rejected SHA A service identity/state: $service" >&2
      return 1
    }
  done
  for root_receipt in \
    "/root/winwidget-billing-core-source-cleanup-pre-offsite-${previous_cleanup_revision}-g2.json" \
    "/root/winwidget-billing-core-source-cleanup-post-offsite-${previous_cleanup_revision}-g2.json" \
    "/root/winwidget-billing-core-source-cleanup-pre-offsite-${next_cleanup_revision}-g2.json" \
    "/root/winwidget-billing-core-source-cleanup-post-offsite-${next_cleanup_revision}-g2.json"; do
    [[ ! -e "$root_receipt" && ! -L "$root_receipt" ]] || {
      echo 'Billing cleanup retarget rejected an existing cleanup receipt import.' >&2
      return 1
    }
  done

  receipt="$APP_ROOT/deploy/backend/.billing-cleanup-retarget-v1"
  receipt_temporary="$APP_ROOT/deploy/backend/.billing-cleanup-retarget-v1.$$"
  retarget_receipt_value() {
    [[ $# -eq 1 ]] || return 1
    awk -F= -v key="$1" '
      $1 == key { print substr($0, index($0, "=") + 1); found += 1 }
      END { exit(found == 1 ? 0 : 1) }
    ' "$receipt"
  }
  retarget_receipt_has_exact_schema() {
    [[ -f "$receipt" && ! -L "$receipt" &&
      "$(stat -c '%u:%g:%a' "$receipt")" == '0:0:600' ]] || return 1
    awk -F= '
      {
        count[$1] += 1
        if ($1 !~ /^(version|state|ownership_revision|ownership_generation|previous_cleanup_revision|next_cleanup_revision|migration_blob|candidate_helper_blob|candidate_lifecycle_blob|database_contract_sha256|cutover_contract_sha256|created_at|updated_at)$/) invalid = 1
      }
      END {
        for (key in count) if (count[key] != 1) invalid = 1
        if (NR != 13) invalid = 1
        exit(invalid ? 1 : 0)
      }
    ' "$receipt"
  }
  write_prepared_retarget_receipt() {
    [[ $# -eq 1 && "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ &&
      ! -e "$receipt_temporary" && ! -L "$receipt_temporary" ]] || return 1
    (umask 077; {
      printf 'version=1\nstate=prepared\nownership_revision=%s\nownership_generation=2\n' \
        "$ownership_revision"
      printf 'previous_cleanup_revision=%s\nnext_cleanup_revision=%s\n' \
        "$previous_cleanup_revision" "$next_cleanup_revision"
      printf 'migration_blob=%s\ncandidate_helper_blob=%s\ncandidate_lifecycle_blob=%s\n' \
        "$migration_blob" "$helper_blob" "$lifecycle_blob"
      printf 'database_contract_sha256=%s\ncutover_contract_sha256=%s\n' \
        "$database_contract_sha256" "$cutover_contract_sha256"
      printf 'created_at=%s\nupdated_at=%s\n' \
        "$1" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    } >"$receipt_temporary")
    chown 0:0 "$receipt_temporary"
    chmod 600 "$receipt_temporary"
    mv -fT "$receipt_temporary" "$receipt"
  }
  retarget_marker_contract_sha256() {
    [[ $# -eq 1 && -f "$1" && ! -L "$1" ]] || return 1
    awk -F= '
      $1 == "cleanup_revision" { print "cleanup_revision=RETARGETED"; next }
      { print }
    ' "$1" | sha256sum | awk '{print $1}'
  }
  database_contract_sha256="$(retarget_marker_contract_sha256 "$database_marker")" || return 1
  cutover_contract_sha256="$(retarget_marker_contract_sha256 "$cutover_marker")" || return 1
  [[ ! -L "$receipt" && ! -e "$receipt_temporary" && ! -L "$receipt_temporary" ]] || return 1
  if [[ -e "$receipt" ]]; then
    retarget_receipt_has_exact_schema || return 1
  else
    [[ "$database_state" == "$previous_cleanup_revision" &&
      "$cutover_state" == "$previous_cleanup_revision" ]] || {
      echo 'Billing cleanup retarget receipt is missing after a parent marker changed.' >&2
      return 1
    }
    write_prepared_retarget_receipt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  fi
  receipt_next_revision="$(retarget_receipt_value next_cleanup_revision)" || return 1
  if [[ "$receipt_next_revision" != "$next_cleanup_revision" ]]; then
    receipt_created_at="$(retarget_receipt_value created_at)" || return 1
    [[ "$database_state" == "$previous_cleanup_revision" &&
      "$cutover_state" == "$previous_cleanup_revision" &&
      "$(retarget_receipt_value version)" == '1' &&
      "$(retarget_receipt_value state)" == 'prepared' &&
      "$(retarget_receipt_value ownership_revision)" == "$ownership_revision" &&
      "$(retarget_receipt_value ownership_generation)" == '2' &&
      "$(retarget_receipt_value previous_cleanup_revision)" == "$previous_cleanup_revision" &&
      "$receipt_next_revision" =~ ^[0-9a-f]{40}$ &&
      "$receipt_next_revision" != "$previous_cleanup_revision" &&
      "$(retarget_receipt_value migration_blob)" == "$migration_blob" &&
      "$(retarget_receipt_value candidate_helper_blob)" == "$helper_blob" &&
      "$(retarget_receipt_value candidate_lifecycle_blob)" == "$lifecycle_blob" &&
      "$(retarget_receipt_value database_contract_sha256)" == "$database_contract_sha256" &&
      "$(retarget_receipt_value cutover_contract_sha256)" == "$cutover_contract_sha256" &&
      "$receipt_created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ &&
      "$(retarget_receipt_value updated_at)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
      echo 'Billing cleanup retarget may rebind only an intact prepared receipt before either parent marker changes.' >&2
      return 1
    }
    git cat-file -e "$receipt_next_revision^{commit}" 2>/dev/null || {
      echo 'Billing cleanup retarget prepared candidate is unavailable locally.' >&2
      return 1
    }
    [[ "$(git rev-parse "$receipt_next_revision:$migration_path")" == "$migration_blob" &&
      "$(git rev-parse "$receipt_next_revision:scripts/billing-release-identity.sh")" == "$helper_blob" &&
      "$(git rev-parse "$receipt_next_revision:scripts/billing-database-lifecycle.sh")" == "$lifecycle_blob" &&
      "$(git rev-parse "$receipt_next_revision:prisma/migrations")" == \
      "$(git rev-parse "$next_cleanup_revision:prisma/migrations")" ]] || {
      echo 'Billing cleanup retarget prepared candidate blobs no longer match the replacement.' >&2
      return 1
    }
    git merge-base --is-ancestor \
      "$receipt_next_revision" "$next_cleanup_revision" || {
      echo 'Billing cleanup retarget replacement must descend from the prepared candidate.' >&2
      return 1
    }
    for root_receipt in \
      "/root/winwidget-billing-core-source-cleanup-pre-offsite-${receipt_next_revision}-g2.json" \
      "/root/winwidget-billing-core-source-cleanup-post-offsite-${receipt_next_revision}-g2.json"; do
      [[ ! -e "$root_receipt" && ! -L "$root_receipt" ]] || {
        echo 'Billing cleanup retarget cannot replace a candidate with imported offsite receipts.' >&2
        return 1
      }
    done
    write_prepared_retarget_receipt "$receipt_created_at"
    receipt_next_revision="$next_cleanup_revision"
  fi
  retarget_receipt_has_exact_schema || return 1
  [[
    "$(retarget_receipt_value version)" == '1' &&
    "$(retarget_receipt_value ownership_revision)" == "$ownership_revision" &&
    "$(retarget_receipt_value ownership_generation)" == '2' &&
    "$(retarget_receipt_value previous_cleanup_revision)" == "$previous_cleanup_revision" &&
    "$(retarget_receipt_value next_cleanup_revision)" == "$next_cleanup_revision" &&
    "$(retarget_receipt_value migration_blob)" == "$migration_blob" &&
    "$(retarget_receipt_value candidate_helper_blob)" == "$helper_blob" &&
    "$(retarget_receipt_value candidate_lifecycle_blob)" == "$lifecycle_blob" &&
    "$(retarget_receipt_value database_contract_sha256)" == "$database_contract_sha256" &&
    "$(retarget_receipt_value cutover_contract_sha256)" == "$cutover_contract_sha256" &&
    "$(retarget_receipt_value created_at)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ &&
    "$(retarget_receipt_value updated_at)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  receipt_state="$(retarget_receipt_value state)" || return 1
  [[ "$receipt_state" =~ ^(prepared|ready)$ ]] || return 1

  rewrite_retarget_receipt() {
    [[ $# -eq 1 && "$1" == 'ready' ]] || return 1
    [[ ! -e "$receipt_temporary" && ! -L "$receipt_temporary" ]] || return 1
    (umask 077; {
      printf 'version=1\nstate=%s\nownership_revision=%s\nownership_generation=2\n' \
        "$1" "$ownership_revision"
      printf 'previous_cleanup_revision=%s\nnext_cleanup_revision=%s\n' \
        "$previous_cleanup_revision" "$next_cleanup_revision"
      printf 'migration_blob=%s\ncandidate_helper_blob=%s\ncandidate_lifecycle_blob=%s\n' \
        "$migration_blob" "$helper_blob" "$lifecycle_blob"
      printf 'database_contract_sha256=%s\ncutover_contract_sha256=%s\n' \
        "$(retarget_receipt_value database_contract_sha256)" \
        "$(retarget_receipt_value cutover_contract_sha256)"
      printf 'created_at=%s\nupdated_at=%s\n' \
        "$(retarget_receipt_value created_at)" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    } >"$receipt_temporary")
    chown 0:0 "$receipt_temporary"
    chmod 600 "$receipt_temporary"
    mv -fT "$receipt_temporary" "$receipt"
  }
  case "$cutover_state|$database_state|$receipt_state" in
    "$previous_cleanup_revision|$previous_cleanup_revision|prepared")
      ;;
    "$next_cleanup_revision|$previous_cleanup_revision|prepared" | \
    "$next_cleanup_revision|$previous_cleanup_revision|ready" | \
      "$next_cleanup_revision|$next_cleanup_revision|ready")
      ;;
    *)
      echo 'Billing cleanup retarget receipt and parent markers are inconsistent.' >&2
      return 1
      ;;
  esac
  if [[ "$cutover_state" == "$previous_cleanup_revision" ]]; then
    cutover_temporary="$APP_ROOT/deploy/backend/.billing-cutover-retarget.$$"
    [[ ! -e "$cutover_temporary" && ! -L "$cutover_temporary" ]] || return 1
    (umask 077; awk -F= -v next_revision="$next_cleanup_revision" '
        $1 == "cleanup_revision" { print "cleanup_revision=" next_revision; found += 1; next }
        { print }
        END { exit(found == 1 ? 0 : 1) }
      ' "$cutover_marker" >"$cutover_temporary")
    chown 0:0 "$cutover_temporary"
    chmod 600 "$cutover_temporary"
    mv -fT "$cutover_temporary" "$cutover_marker"
    billing_cutover_validate_marker || return 1
    cutover_state="$next_cleanup_revision"
    rewrite_retarget_receipt ready
    receipt_state='ready'
  fi
  if [[ "$cutover_state" == "$next_cleanup_revision" &&
    "$database_state" == "$previous_cleanup_revision" &&
    "$receipt_state" == 'prepared' ]]; then
    rewrite_retarget_receipt ready
    receipt_state='ready'
  fi
  if [[ "$database_state" == "$previous_cleanup_revision" ]]; then
    database_temporary="$APP_ROOT/deploy/backend/.billing-database-retarget.$$"
    [[ ! -e "$database_temporary" && ! -L "$database_temporary" ]] || return 1
    (umask 077; awk -F= -v next_revision="$next_cleanup_revision" '
        $1 == "cleanup_revision" { print "cleanup_revision=" next_revision; found += 1; next }
        { print }
        END { exit(found == 1 ? 0 : 1) }
      ' "$database_marker" >"$database_temporary")
    chown 0:0 "$database_temporary"
    chmod 600 "$database_temporary"
    mv -fT "$database_temporary" "$database_marker"
    database_state="$next_cleanup_revision"
  fi
  billing_database_validate_marker || return 1
  billing_cutover_validate_marker || return 1
  [[ "$(billing_database_marker_value cleanup_revision)" == "$next_cleanup_revision" &&
    "$(billing_core_source_cleanup_parent_marker_value "$cutover_marker" cleanup_revision)" == "$next_cleanup_revision" &&
    "$(retarget_receipt_value state)" == 'ready' &&
    "$(retarget_marker_contract_sha256 "$database_marker")" == \
    "$(retarget_receipt_value database_contract_sha256)" &&
    "$(retarget_marker_contract_sha256 "$cutover_marker")" == \
    "$(retarget_receipt_value cutover_contract_sha256)" ]] || return 1
  trap - EXIT
  retarget_cleanup_temporary_files
  printf 'billing_cleanup_revision_retargeted=%s\n' "$next_cleanup_revision"
)
checkout_verified_prod_revision() {
  local expected_revision="$1"
  local prefetched_revision="${2:-}"
  local current_revision fetched_revision

  [[ -z "$prefetched_revision" ||
    "$prefetched_revision" =~ ^[0-9a-f]{40}$ ]] || {
    echo "Prefetched prod revision is invalid." >&2
    return 1
  }

  current_revision="$(git rev-parse HEAD)"
  guard_campaigns_checkout_before_pull "$current_revision"
  guard_reporting_checkout_before_pull "$current_revision"
  guard_widgets_checkout_before_pull "$current_revision"
  guard_billing_checkout_before_pull "$current_revision"
  guard_identity_checkout_before_pull "$current_revision"
  guard_campaigns_checkout_before_pull "$expected_revision"
  guard_reporting_checkout_before_pull "$expected_revision"
  guard_widgets_checkout_before_pull "$expected_revision"
  guard_billing_checkout_before_pull "$expected_revision"
  guard_identity_checkout_before_pull "$expected_revision"
  if [[ -n "$prefetched_revision" ]]; then
    [[ "$prefetched_revision" == "$expected_revision" ]] || {
      echo "Prefetched prod revision differs from the reviewed revision." >&2
      return 1
    }
    git cat-file -e "$prefetched_revision^{commit}" 2>/dev/null || {
      echo "Prefetched prod commit is unavailable locally." >&2
      return 1
    }
    fetched_revision="$prefetched_revision"
  else
    git fetch origin prod
    fetched_revision="$(git rev-parse FETCH_HEAD)"
    [[ "$fetched_revision" == "$expected_revision" ]] || {
      echo "Origin prod changed after workflow start; checkout was not modified." >&2
      return 1
    }
  fi
  guard_reporting_checkout_before_pull \
    "$expected_revision" --guard-before-checkout-revision
  guard_widgets_checkout_before_pull \
    "$expected_revision" --guard-before-checkout-revision
  guard_billing_checkout_before_pull \
    "$expected_revision" --guard-before-checkout-revision
  guard_identity_checkout_before_pull \
    "$expected_revision" --guard-before-checkout-revision
  git checkout prod
  git merge --ff-only "$fetched_revision"
  [[ "$(git rev-parse HEAD)" == "$expected_revision" ]] || {
    echo "Verified prod checkout revision mismatch." >&2
    return 1
  }
}
checkout_retargeted_billing_cleanup_revision() {
  [[ $# -eq 2 ]] || return 1
  local expected_revision="$1" prefetched_revision="$2"
  local current_revision
  [[ "$expected_revision" =~ ^[0-9a-f]{40}$ &&
    "$prefetched_revision" == "$expected_revision" ]] || return 1
  current_revision="$(git rev-parse HEAD)"
  guard_campaigns_checkout_before_pull "$current_revision"
  guard_reporting_checkout_before_pull "$current_revision"
  guard_widgets_checkout_before_pull "$current_revision"
  guard_identity_checkout_before_pull "$current_revision"
  guard_campaigns_checkout_before_pull "$expected_revision"
  guard_reporting_checkout_before_pull "$expected_revision"
  guard_widgets_checkout_before_pull "$expected_revision"
  guard_identity_checkout_before_pull "$expected_revision"
  git cat-file -e "$prefetched_revision^{commit}" 2>/dev/null || return 1
  guard_reporting_checkout_before_pull \
    "$expected_revision" --guard-before-checkout-revision
  guard_widgets_checkout_before_pull \
    "$expected_revision" --guard-before-checkout-revision
  guard_identity_checkout_before_pull \
    "$expected_revision" --guard-before-checkout-revision
  git checkout prod
  git merge --ff-only "$prefetched_revision"
  [[ "$(git rev-parse HEAD)" == "$expected_revision" ]] || return 1
  guard_billing_checkout_before_pull \
    "$expected_revision" --guard-before-checkout-revision
}
current_revision="$(git rev-parse HEAD)"
if [[ "$AUTOMATIC_PROD_PUSH" == "true" &&
  "$current_revision" != "$EXPECTED_REVISION" ]]; then
  guard_campaigns_checkout_before_pull "$current_revision"
  guard_reporting_checkout_before_pull "$current_revision"
  guard_widgets_checkout_before_pull "$current_revision"
  guard_billing_checkout_before_pull "$current_revision"
  guard_identity_checkout_before_pull "$current_revision"
  if ! guard_campaigns_checkout_before_pull \
    "$EXPECTED_REVISION" > /dev/null 2>&1; then
    echo "Automatic backend deploy is verified but deferred: the incomplete Campaigns database lifecycle is pinned to $current_revision."
    echo "Resolve the pinned Campaigns lifecycle guard from the production runbook before deploying $EXPECTED_REVISION."
    exit 0
  fi
  if ! guard_reporting_checkout_before_pull \
    "$EXPECTED_REVISION" > /dev/null 2>&1; then
    echo "Automatic backend deploy is verified but deferred: Reporting first-rollout preparation is pinned to $current_revision."
    echo "Resolve the pinned Reporting lifecycle guard before deploying another revision."
    exit 0
  fi
  if ! guard_widgets_checkout_before_pull \
    "$EXPECTED_REVISION" > /dev/null 2>&1; then
    echo "Automatic backend deploy is verified but deferred: the active Widgets ownership guard rejects $EXPECTED_REVISION."
    exit 0
  fi
  if ! guard_billing_checkout_before_pull \
    "$EXPECTED_REVISION" > /dev/null 2>&1; then
    echo "Automatic backend deploy is verified but deferred: the active Billing ownership guard rejects $EXPECTED_REVISION."
    exit 0
  fi
  if ! guard_identity_checkout_before_pull \
    "$EXPECTED_REVISION" > /dev/null 2>&1; then
    echo "Automatic backend deploy is verified but deferred: the active Identity ownership guard rejects $EXPECTED_REVISION."
    exit 0
  fi
fi
case "$DEPLOY_TARGET" in
  all)
    checkout_verified_prod_revision "$EXPECTED_REVISION"
    APP_ROOT="$APP_ROOT" \
      CAMPAIGNS_AUTOMATIC_PROD_PUSH="$AUTOMATIC_PROD_PUSH" \
      REPORTING_AUTOMATIC_PROD_PUSH="$AUTOMATIC_PROD_PUSH" \
      WIDGETS_AUTOMATIC_PROD_PUSH="$AUTOMATIC_PROD_PUSH" \
      BILLING_AUTOMATIC_PROD_PUSH="$AUTOMATIC_PROD_PUSH" \
      IDENTITY_AUTOMATIC_PROD_PUSH="$AUTOMATIC_PROD_PUSH" \
      bash scripts/deploy-production.sh
    exit 0
    ;;
  maintenance)
    checkout_verified_prod_revision "$EXPECTED_REVISION"
    APP_ROOT="$APP_ROOT" bash scripts/deploy-maintenance-production.sh
    ;;
  notification-delivery)
    checkout_verified_prod_revision "$EXPECTED_REVISION"
    APP_ROOT="$APP_ROOT" bash scripts/deploy-notification-delivery-production.sh
    ;;
  campaigns)
    checkout_verified_prod_revision "$EXPECTED_REVISION"
    APP_ROOT="$APP_ROOT" bash scripts/deploy-campaigns-production.sh
    ;;
  reporting)
    checkout_verified_prod_revision "$EXPECTED_REVISION"
    APP_ROOT="$APP_ROOT" bash scripts/deploy-reporting-production.sh
    ;;
  widgets)
    [[ "$AUTOMATIC_PROD_PUSH" == "false" ]] || {
      echo "Widgets first cutover is manual-only." >&2
      exit 1
    }
    widgets_cutover_approved=false
    if [[ "$WIDGETS_CUTOVER_CONFIRMATION" == 'CUTOVER WIDGETS OWNERSHIP' ]]; then
      widgets_cutover_approved=true
    fi
    checkout_verified_prod_revision "$EXPECTED_REVISION"
    APP_ROOT="$APP_ROOT" \
      WIDGETS_AUTOMATIC_PROD_PUSH=false \
      WIDGETS_FIRST_CUTOVER_APPROVED="$widgets_cutover_approved" \
      WIDGETS_FIRST_CUTOVER_CONFIRMATION="$WIDGETS_CUTOVER_CONFIRMATION" \
      bash scripts/deploy-widgets-production.sh
    ;;
  billing)
    [[ "$AUTOMATIC_PROD_PUSH" == "false" ]] || {
      echo "Billing lifecycle actions are manual-only." >&2
      exit 1
    }
    checkout_verified_prod_revision "$EXPECTED_REVISION"
    case "$BILLING_ACTION" in
      status)
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          bash scripts/billing-cutover-production.sh --status
        ;;
      prepare)
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          BILLING_AUTOMATIC_PROD_PUSH=false \
          bash scripts/billing-cutover-production.sh --prepare
        APP_ROOT="$APP_ROOT" BILLING_AUTOMATIC_PROD_PUSH=false \
          CAMPAIGNS_AUTOMATIC_PROD_PUSH=false \
          REPORTING_AUTOMATIC_PROD_PUSH=false \
          WIDGETS_AUTOMATIC_PROD_PUSH=false \
          bash scripts/deploy-production.sh
        ;;
      cutover|forward-recovery)
        billing_command="--$BILLING_ACTION"
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          BILLING_AUTOMATIC_PROD_PUSH=false \
          BILLING_FIRST_CUTOVER_APPROVED=true \
          BILLING_FIRST_CUTOVER_CONFIRMATION="$BILLING_CONFIRMATION" \
          bash scripts/billing-cutover-production.sh "$billing_command"
        ;;
      abort)
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          BILLING_AUTOMATIC_PROD_PUSH=false \
          BILLING_ABORT_CONFIRMATION="$BILLING_CONFIRMATION" \
          bash scripts/billing-cutover-production.sh --abort
        ;;
    esac
    ;;
  billing-cleanup)
    [[ "$AUTOMATIC_PROD_PUSH" == "false" ]] || {
      echo "Billing Core source cleanup actions are manual-only." >&2
      exit 1
    }
    if [[ "$BILLING_CLEANUP_ACTION" == 'status' &&
      "$(git rev-parse HEAD)" != "$EXPECTED_REVISION" ]]; then
      cleanup_marker="$APP_ROOT/deploy/backend/.billing-core-source-cleanup-v1"
      [[ ! -e "$cleanup_marker" && ! -L "$cleanup_marker" ]] || {
        echo 'Billing cleanup marker exists but its bound revision is not checked out.' >&2
        exit 1
      }
      APP_ROOT="$APP_ROOT" bash scripts/billing-database-lifecycle.sh --status
      printf 'billing_core_cleanup_phase=not-staged\n'
      printf 'billing_core_cleanup_candidate_revision=%s\n' "$EXPECTED_REVISION"
      printf 'billing_core_cleanup_checkout_revision=%s\n' "$(git rev-parse HEAD)"
      exit 0
    fi
    if [[ "$BILLING_CLEANUP_ACTION" == 'retarget' ]]; then
      current_revision="$(git rev-parse HEAD)"
      if [[ "$current_revision" == "$EXPECTED_REVISION" ]]; then
        retarget_receipt="$APP_ROOT/deploy/backend/.billing-cleanup-retarget-v1"
        [[ -f "$retarget_receipt" && ! -L "$retarget_receipt" &&
          "$(stat -c '%u:%g:%a' "$retarget_receipt")" == '0:0:600' ]] || {
          echo 'Completed Billing cleanup retarget receipt is unavailable.' >&2
          exit 1
        }
        previous_cleanup_revision="$(awk -F= '
          $1 == "previous_cleanup_revision" {
            print substr($0, index($0, "=") + 1)
            found += 1
          }
          END { exit(found == 1 ? 0 : 1) }
        ' "$retarget_receipt")" || exit 1
        retarget_billing_cleanup_revision \
          "$previous_cleanup_revision" "$EXPECTED_REVISION"
      else
        guard_campaigns_checkout_before_pull "$current_revision"
        guard_reporting_checkout_before_pull "$current_revision"
        guard_widgets_checkout_before_pull "$current_revision"
        guard_campaigns_checkout_before_pull "$EXPECTED_REVISION"
        guard_reporting_checkout_before_pull "$EXPECTED_REVISION"
        guard_widgets_checkout_before_pull "$EXPECTED_REVISION"
        git fetch origin prod
        prefetched_cleanup_revision="$(git rev-parse FETCH_HEAD)"
        [[ "$prefetched_cleanup_revision" == "$EXPECTED_REVISION" ]] || {
          echo 'Origin prod no longer matches the reviewed retarget revision.' >&2
          exit 1
        }
        guard_reporting_checkout_before_pull \
          "$EXPECTED_REVISION" --guard-before-checkout-revision
        guard_widgets_checkout_before_pull \
          "$EXPECTED_REVISION" --guard-before-checkout-revision
        retarget_billing_cleanup_revision \
          "$current_revision" "$EXPECTED_REVISION"
        checkout_retargeted_billing_cleanup_revision \
          "$EXPECTED_REVISION" "$prefetched_cleanup_revision"
      fi
      APP_ROOT="$APP_ROOT" bash scripts/billing-database-lifecycle.sh --status
      APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
        bash scripts/cleanup-billing-core-source-production.sh --status
      curl -fsS --connect-timeout 3 --max-time 5 \
        http://127.0.0.1:4100/health/ready >/dev/null
      curl -fsS --connect-timeout 3 --max-time 5 \
        http://127.0.0.1:4200/api/v1/health/ready >/dev/null
      curl -fsS --connect-timeout 3 --max-time 5 \
        https://api.winwidget.ru/api/v1/health/ready >/dev/null
      printf 'billing_core_cleanup_retarget_checkout_revision=%s\n' \
        "$(git rev-parse HEAD)"
      exit 0
    fi
    prefetched_cleanup_revision=''
    if [[ "$BILLING_CLEANUP_ACTION" == 'stage' &&
      "$(git rev-parse HEAD)" != "$EXPECTED_REVISION" ]]; then
      current_revision="$(git rev-parse HEAD)"
      git fetch origin prod
      prefetched_cleanup_revision="$(git rev-parse FETCH_HEAD)"
      [[ "$prefetched_cleanup_revision" == "$EXPECTED_REVISION" ]] || {
        echo 'Origin prod no longer matches the reviewed cleanup revision; marker was not changed.' >&2
        exit 1
      }
      stage_billing_cleanup_revision_with_container_node \
        "$current_revision" "$EXPECTED_REVISION"
    fi
    checkout_verified_prod_revision \
      "$EXPECTED_REVISION" "$prefetched_cleanup_revision"
    cleanup_command="--$BILLING_CLEANUP_ACTION"
    APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
      BILLING_CORE_SOURCE_CLEANUP_CONFIRMATION="$BILLING_CLEANUP_CONFIRMATION" \
      bash scripts/cleanup-billing-core-source-production.sh \
        "$cleanup_command"
    ;;
  identity)
    [[ "$AUTOMATIC_PROD_PUSH" == 'false' ]] || {
      echo 'Identity lifecycle actions are manual-only.' >&2
      exit 1
    }
    if [[ "$IDENTITY_ACTION" =~ ^(prepare|cutover|forward-recovery)$ ]]; then
      production_env="$APP_ROOT/deploy/backend/.env.production"
      [[ -f "$production_env" && ! -L "$production_env" &&
        "$(stat -c '%u:%g:%a' "$production_env")" == '0:0:600' &&
        "$(sha256sum "$production_env" | awk 'NR == 1 { print $1 }')" == "$IDENTITY_ENV_EXPECTED_SHA256" ]] || {
        echo 'Server backend env is not byte-identical to the supplied local canonical SHA-256.' >&2
        exit 1
      }
    fi
    checkout_verified_prod_revision "$EXPECTED_REVISION"
    case "$IDENTITY_ACTION" in
      status)
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          bash scripts/identity-cutover-production.sh --status
        ;;
      prepare)
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          IDENTITY_ENV_EXPECTED_SHA256="$IDENTITY_ENV_EXPECTED_SHA256" \
          bash scripts/identity-production-env-control.sh --bootstrap
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          IDENTITY_ENV_EXPORT_CERTIFICATE_FILE="$APP_ROOT/deploy/backend/.identity-env-export-certificate-$IDENTITY_ENV_EXPORT_ID.pem" \
          IDENTITY_ENV_EXPORT_FILE="$APP_ROOT/deploy/backend/.identity-production-env-$IDENTITY_ENV_EXPORT_ID.p7m" \
          bash scripts/identity-production-env-control.sh --export-encrypted
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          bash scripts/identity-database-lifecycle.sh --prepare
        ;;
      cutover)
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          IDENTITY_ENV_EXPECTED_SHA256="$IDENTITY_ENV_EXPECTED_SHA256" \
          bash scripts/identity-production-env-control.sh --verify
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          bash scripts/identity-cutover-production.sh --preflight
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          bash scripts/identity-cutover-production.sh --verify
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          IDENTITY_CUTOVER_CONFIRMATION="$IDENTITY_CONFIRMATION" \
          bash scripts/identity-cutover-production.sh --deploy
        ;;
      forward-recovery)
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          IDENTITY_ENV_EXPECTED_SHA256="$IDENTITY_ENV_EXPECTED_SHA256" \
          bash scripts/identity-production-env-control.sh --verify
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          IDENTITY_CUTOVER_CONFIRMATION="$IDENTITY_CONFIRMATION" \
          bash scripts/identity-cutover-production.sh --forward-recovery
        ;;
      abort-prepare)
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          IDENTITY_ABORT_CONFIRMATION="$IDENTITY_CONFIRMATION" \
          bash scripts/identity-database-lifecycle.sh --abort-prepare
        ;;
    esac
    ;;
  identity-cleanup)
    [[ "$AUTOMATIC_PROD_PUSH" == 'false' ]] || {
      echo 'Identity Core source cleanup actions are manual-only.' >&2
      exit 1
    }
    if [[ "$IDENTITY_CLEANUP_ACTION" =~ ^(verify|run|forward-recovery)$ ]]; then
      production_env="$APP_ROOT/deploy/backend/.env.production"
      [[ -f "$production_env" && ! -L "$production_env" &&
        "$(stat -c '%u:%g:%a' "$production_env")" == '0:0:600' &&
        "$(sha256sum "$production_env" | awk 'NR == 1 { print $1 }')" == "$IDENTITY_ENV_EXPECTED_SHA256" ]] || {
        echo 'Server backend env is not byte-identical to the supplied local canonical SHA-256.' >&2
        exit 1
      }
    fi
    checkout_verified_prod_revision "$EXPECTED_REVISION"
    case "$IDENTITY_CLEANUP_ACTION" in
      status)
        APP_ROOT="$APP_ROOT" \
          bash scripts/cleanup-identity-core-source-production.sh --status
        ;;
      verify)
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          IDENTITY_CORE_CLEANUP_MIGRATION_SHA256="$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" \
          IDENTITY_ENV_EXPECTED_SHA256="$IDENTITY_ENV_EXPECTED_SHA256" \
          bash scripts/cleanup-identity-core-source-production.sh --verify
        ;;
      run|forward-recovery)
        identity_cleanup_command='--deploy'
        [[ "$IDENTITY_CLEANUP_ACTION" == 'run' ]] || \
          identity_cleanup_command='--forward-recovery'
        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \
          IDENTITY_CORE_CLEANUP_MIGRATION_SHA256="$IDENTITY_CORE_CLEANUP_MIGRATION_SHA256" \
          IDENTITY_CORE_CLEANUP_CONFIRMATION="$IDENTITY_CLEANUP_CONFIRMATION" \
          IDENTITY_ENV_EXPECTED_SHA256="$IDENTITY_ENV_EXPECTED_SHA256" \
          IDENTITY_ENV_EXPORT_CERTIFICATE_FILE="$APP_ROOT/deploy/backend/.identity-env-export-certificate-$IDENTITY_ENV_EXPORT_ID.pem" \
          IDENTITY_ENV_EXPORT_FILE="$APP_ROOT/deploy/backend/.identity-production-env-$IDENTITY_ENV_EXPORT_ID.p7m" \
          bash scripts/cleanup-identity-core-source-production.sh \
            "$identity_cleanup_command"
        ;;
    esac
    ;;
  *)
    echo "Unsupported deploy target: $DEPLOY_TARGET" >&2
    exit 1
    ;;
esac
EOF
