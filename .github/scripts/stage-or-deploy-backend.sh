#!/usr/bin/env bash
set -e
set -o pipefail

deploy_ssh_key_path="${DEPLOY_SSH_KEY_PATH:-$HOME/.ssh/deploy_key}"
deploy_ssh_known_hosts_path="${DEPLOY_SSH_KNOWN_HOSTS_PATH:-$HOME/.ssh/known_hosts}"
[[ "$deploy_ssh_key_path" == /* && -f "$deploy_ssh_key_path" &&
  ! -L "$deploy_ssh_key_path" &&
  "$deploy_ssh_known_hosts_path" == /* &&
  -f "$deploy_ssh_known_hosts_path" &&
  ! -L "$deploy_ssh_known_hosts_path" ]] || {
  echo 'Deployment SSH credential paths are not trusted regular files.' >&2
  exit 1
}
if [[ -n "$IDENTITY_ENV_EXPORT_ID" &&
  ! "$IDENTITY_ENV_EXPORT_ID" =~ ^[0-9]{1,20}-[0-9]{1,10}$ ]]; then
  echo 'Identity env export id is unsafe.' >&2
  exit 1
fi
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
    status:|recover-candidate-env:|prepare:) ;;
    rollback-env-bootstrap:'ROLLBACK INCOMPLETE IDENTITY ENV BOOTSTRAP') ;;
    cutover:'CUTOVER IDENTITY OWNERSHIP'|forward-recovery:'CUTOVER IDENTITY OWNERSHIP') ;;
    abort-prepare:'ABORT IDENTITY PREPARE') ;;
    rotate-jwt:'ROTATE IDENTITY JWT SIGNING KEY'|rotate-jwt-forward-recovery:'ROTATE IDENTITY JWT SIGNING KEY') ;;
    *)
      echo 'Invalid Identity action or confirmation.' >&2
      exit 1
      ;;
  esac
  case "$IDENTITY_ACTION" in
    prepare|rollback-env-bootstrap|cutover|forward-recovery|rotate-jwt|rotate-jwt-forward-recovery)
      [[ "$IDENTITY_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
        echo 'Identity mutation requires the exact local canonical backend env SHA-256.' >&2
        exit 1
      }
      ;;
    *)
      [[ -z "$IDENTITY_ENV_EXPECTED_SHA256" ]] || exit 1
      ;;
  esac
  if [[ "$IDENTITY_ACTION" =~ ^(recover-candidate-env|prepare|rotate-jwt|rotate-jwt-forward-recovery)$ ]]; then
    [[ "$IDENTITY_ENV_EXPORT_ID" =~ ^[0-9]{1,20}-[0-9]{1,10}$ ]] || {
      echo 'Identity env export requires a safe export id.' >&2
      exit 1
    }
  fi
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
        "$IDENTITY_ENV_EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ &&
        "$IDENTITY_ENV_EXPORT_ID" =~ ^[0-9]{1,20}-[0-9]{1,10}$ ]] || exit 1
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
require_completion_receipt() {
  awk -v expected_revision="$DEPLOY_REVISION" \
    -v automatic_prod_push="$AUTOMATIC_PROD_PUSH" \
    -v deploy_target="$DEPLOY_TARGET" '
      {
        print
        fflush()
      }
      $0 == "Backend revision verified locally and publicly: " expected_revision {
        receipts += 1
      }
      END {
        if (automatic_prod_push == "true" && deploy_target == "all" && receipts != 1) {
          print "Automatic backend deploy did not produce its exact completion receipt." > "/dev/stderr"
          exit 74
        }
      }
    '
}
remote_controller_source=".github/scripts/stage-or-deploy-backend-remote.sh"
[[ -f "$remote_controller_source" && ! -L "$remote_controller_source" &&
  "$DEPLOY_REVISION" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'Tracked backend remote deployment controller is unavailable.' >&2
  exit 1
}
remote_controller_blob="$(
  git rev-parse --verify "$DEPLOY_REVISION:$remote_controller_source"
)"
[[ "$(git hash-object "$remote_controller_source")" == "$remote_controller_blob" ]] || {
  echo 'Backend remote deployment controller differs from the candidate revision.' >&2
  exit 1
}
remote_controller_sha256="$(
  sha256sum "$remote_controller_source" | awk 'NR == 1 { print $1 }'
)"
[[ "$remote_controller_sha256" =~ ^[0-9a-f]{64}$ ]] || exit 1
remote_controller_id="${IDENTITY_ENV_EXPORT_ID:-${DEPLOY_REVISION:0:20}-$$}"
[[ "$remote_controller_id" =~ ^[0-9a-f]{1,40}-[0-9]{1,10}$ ]] || {
  echo 'Backend remote deployment controller id is unsafe.' >&2
  exit 1
}
remote_controller_path="$APP_ROOT/deploy/backend/.stage-or-deploy-backend-$remote_controller_id.sh"

ssh_options=(
  -i "$deploy_ssh_key_path"
  -F /dev/null
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o GlobalKnownHostsFile=/dev/null
  -o "UserKnownHostsFile=$deploy_ssh_known_hosts_path"
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
  -o TCPKeepAlive=yes
  -p "$SSH_PORT"
)
scp_options=(
  -q
  -i "$deploy_ssh_key_path"
  -F /dev/null
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o GlobalKnownHostsFile=/dev/null
  -o "UserKnownHostsFile=$deploy_ssh_known_hosts_path"
  -o ConnectTimeout=15
  -P "$SSH_PORT"
)
cleanup_remote_controller() {
  # The validated path intentionally expands on the trusted GitHub runner.
  # shellcheck disable=SC2029
  ssh "${ssh_options[@]}" \
    "$SSH_USER@$SSH_HOST" \
    "rm -f -- '$remote_controller_path'" > /dev/null 2>&1 || true
}
trap cleanup_remote_controller EXIT
cleanup_remote_controller
scp "${scp_options[@]}" \
  "$remote_controller_source" \
  "$SSH_USER@$SSH_HOST:$remote_controller_path"
# The staged path and SHA intentionally expand on the trusted GitHub runner.
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" \
  "$SSH_USER@$SSH_HOST" \
  "set -euo pipefail
controller='$remote_controller_path'
cleanup_controller() {
  rm -f -- \"\$controller\"
}
trap cleanup_controller EXIT HUP INT TERM
[[ \"\$(id -u)\" == '0' &&
  -f \"\$controller\" && ! -L \"\$controller\" &&
  \"\$(stat -c '%u:%g:%a:%h' \"\$controller\")\" =~ ^0:0:(600|644):1$ &&
  \"\$(sha256sum \"\$controller\" | awk 'NR == 1 { print \$1 }')\" == '$remote_controller_sha256' ]] || {
  echo 'Staged backend remote deployment controller failed verification.' >&2
  exit 1
}
chmod 600 \"\$controller\"
APP_ROOT='$APP_ROOT' AUTOMATIC_PROD_PUSH='$AUTOMATIC_PROD_PUSH' EXPECTED_REVISION='$DEPLOY_REVISION' DEPLOY_TARGET='$DEPLOY_TARGET' WIDGETS_CUTOVER_CONFIRMATION='$WIDGETS_CUTOVER_CONFIRMATION' BILLING_ACTION='$BILLING_ACTION' BILLING_CONFIRMATION='$BILLING_CONFIRMATION' BILLING_CLEANUP_ACTION='$BILLING_CLEANUP_ACTION' BILLING_CLEANUP_CONFIRMATION='$BILLING_CLEANUP_CONFIRMATION' IDENTITY_ACTION='$IDENTITY_ACTION' IDENTITY_CONFIRMATION='$IDENTITY_CONFIRMATION' IDENTITY_ENV_EXPECTED_SHA256='$IDENTITY_ENV_EXPECTED_SHA256' IDENTITY_ENV_EXPORT_ID='$IDENTITY_ENV_EXPORT_ID' IDENTITY_CLEANUP_ACTION='$IDENTITY_CLEANUP_ACTION' IDENTITY_CLEANUP_CONFIRMATION='$IDENTITY_CLEANUP_CONFIRMATION' IDENTITY_CORE_CLEANUP_MIGRATION_SHA256='$IDENTITY_CLEANUP_MIGRATION_SHA256' bash \"\$controller\"" |
  require_completion_receipt
trap - EXIT
cleanup_remote_controller
