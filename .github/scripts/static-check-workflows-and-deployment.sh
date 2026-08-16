#!/usr/bin/env bash
set -e
set -o pipefail

sh -n database-restore-entrypoint.sh
bash -n \
  .github/scripts/validate-production-compose.sh \
  .github/scripts/static-check-workflows-and-deployment.sh \
  .github/scripts/stage-or-deploy-backend.sh
# actionlint runs without its ShellCheck integration. Extracted workflow
# runners are syntax-checked above; production scripts are checked separately.
docker run --rm \
  --network none \
  --read-only \
  --security-opt no-new-privileges \
  --volume "$GITHUB_WORKSPACE:/repo:ro" \
  --workdir /repo \
  rhysd/actionlint@sha256:887a259a5a534f3c4f36cb02dca341673c6089431057242cdc931e9f133147e9 \
  -shellcheck=
docker run --rm \
  --network none \
  --read-only \
  --security-opt no-new-privileges \
  --entrypoint shellcheck \
  --volume "$GITHUB_WORKSPACE:/repo:ro" \
  --workdir /repo \
  koalaman/shellcheck-alpine@sha256:5921d946dac740cbeec2fb1c898747b6105e585130cc7f0602eec9a10f7ddb63 \
  --severity=warning \
  scripts/deploy-production.sh \
  scripts/deploy-maintenance-production.sh \
  scripts/deploy-notification-delivery-production.sh \
  scripts/cutover-notification-delivery-database-production.sh \
  scripts/notification-delivery-database-lifecycle.sh \
  scripts/deploy-campaigns-production.sh \
  scripts/cutover-campaigns-database-production.sh \
  scripts/restart-campaigns-database-cutover-production.sh \
  scripts/campaigns-database-lifecycle.sh \
  scripts/campaigns-contract-migration-guard.sh \
  scripts/core-database-production-guard.sh \
  scripts/production-deploy-lock.sh \
  scripts/test-campaigns-cutover-rehearsal.sh \
  scripts/audit-legacy-telegram-channels-production.sh \
  scripts/database-restore-production-guard.sh \
  scripts/billing-release-identity.sh \
  scripts/billing-database-lifecycle.sh \
  scripts/deploy-billing-production.sh \
  scripts/billing-cutover-production.sh \
  scripts/billing-backup-restore-rehearsal.sh \
  scripts/cleanup-billing-core-source-production.sh \
  scripts/test-billing-core-source-cleanup-rehearsal.sh \
  scripts/identity-release-identity.sh \
  scripts/identity-production-env-control.sh \
  scripts/identity-database-lifecycle.sh \
  scripts/deploy-identity-production.sh \
  scripts/identity-cutover-production.sh \
  scripts/identity-backup-restore-rehearsal.sh \
  scripts/cleanup-identity-core-source-production.sh \
  database-restore-entrypoint.sh
docker run --rm \
  --network none \
  --read-only \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=1m \
  --volume "$GITHUB_WORKSPACE:/repo:ro" \
  --workdir /repo \
  --entrypoint bash \
  postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296 \
  -euc '
    APP_ROOT=/tmp/campaigns-lifecycle \
      bash scripts/campaigns-database-lifecycle.sh --self-test
    bash scripts/restart-campaigns-database-cutover-production.sh \
      --self-test
    APP_ROOT=/tmp/notification-lifecycle \
      bash scripts/notification-delivery-database-lifecycle.sh --self-test
    bash scripts/audit-legacy-telegram-channels-production.sh --self-test
  '
retarget_marker_rewrite_fixture() {
  [[ $# -eq 1 ]] || return 1
  awk -F= -v next_revision="$1" '
    $1 == "cleanup_revision" { print "cleanup_revision=" next_revision; found += 1; next }
    { print }
    END { exit(found == 1 ? 0 : 1) }
  '
}
retarget_fixture_revision='cccccccccccccccccccccccccccccccccccccccc'
retarget_fixture_output="$(retarget_marker_rewrite_fixture \
  "$retarget_fixture_revision" <<'EOF'
version=1
cleanup_revision=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
generation=2
EOF
)"
[[ "$retarget_fixture_output" == $'version=1\ncleanup_revision=cccccccccccccccccccccccccccccccccccccccc\ngeneration=2' ]]
if retarget_marker_rewrite_fixture "$retarget_fixture_revision" >/dev/null <<'EOF'; then
cleanup_revision=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
cleanup_revision=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
EOF
  echo 'Retarget marker rewrite accepted duplicate cleanup_revision fields.' >&2
  exit 1
fi
if retarget_marker_rewrite_fixture "$retarget_fixture_revision" >/dev/null <<'EOF'; then
version=1
generation=2
EOF
  echo 'Retarget marker rewrite accepted a missing cleanup_revision field.' >&2
  exit 1
fi

node <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const workflow = readFileSync(
  ".github/workflows/deploy-production.yml",
  "utf8",
);
const validateProductionComposeScript = readFileSync(
  ".github/scripts/validate-production-compose.sh",
  "utf8",
);
const staticWorkflowCheckScript = readFileSync(
  ".github/scripts/static-check-workflows-and-deployment.sh",
  "utf8",
);
const stageOrDeployScript = readFileSync(
  ".github/scripts/stage-or-deploy-backend.sh",
  "utf8",
);
if (Buffer.byteLength(workflow, "utf8") >= 450_000) {
  throw new Error(
    "deploy-production.yml must stay below 450000 bytes of scheduler headroom",
  );
}
const workflowDispatchInputsStart = workflow.indexOf(
  "  workflow_dispatch:\n    inputs:\n",
);
const workflowPushStart = workflow.indexOf(
  "  push:\n",
  workflowDispatchInputsStart,
);
if (
  workflowDispatchInputsStart < 0 ||
  workflowPushStart <= workflowDispatchInputsStart
) {
  throw new Error("workflow_dispatch input block is missing or misplaced");
}
const workflowDispatchInputNames = [
  ...workflow
    .slice(workflowDispatchInputsStart, workflowPushStart)
    .matchAll(/^      ([a-z][a-z0-9_]*):$/gm),
].map(match => match[1]);
const expectedWorkflowDispatchInputNames = [
  "deploy_target",
  "widgets_cutover_confirmation",
  "billing_action",
  "billing_confirmation",
  "billing_cleanup_action",
  "identity_action",
  "identity_confirmation",
  "identity_backend_env_expected_sha256",
  "identity_cleanup_action",
  "identity_cleanup_migration_sha256",
];
if (
  JSON.stringify(workflowDispatchInputNames) !==
  JSON.stringify(expectedWorkflowDispatchInputNames)
) {
  throw new Error(
    `Unexpected workflow_dispatch inputs: ${workflowDispatchInputNames.join(",")}`,
  );
}
const workflowContract = [
  workflow,
  validateProductionComposeScript,
  staticWorkflowCheckScript,
  stageOrDeployScript,
].join("\n");
const lines = workflowContract.split("\n").map(line => line.trim());
const count = needle => lines.filter(line => line === needle).length;
const substringCount = (value, needle) =>
  value.split(needle).length - 1;
const compactWhitespace = value => value.replace(/\s+/g, " ").trim();
const requireCount = (needle, expected) => {
  const actual = count(needle);
  if (actual !== expected) {
    throw new Error(
      `Expected ${expected} occurrences of ${JSON.stringify(needle)}, got ${actual}`,
    );
  }
};

requireCount(
  "BILLING_CONFIRMATION: ${{ github.event_name == 'workflow_dispatch' && inputs.deploy_target != 'billing-cleanup' && inputs.billing_confirmation || '' }}",
  1,
);
requireCount(
  "BILLING_CLEANUP_CONFIRMATION: ${{ github.event_name == 'workflow_dispatch' && inputs.deploy_target == 'billing-cleanup' && inputs.billing_confirmation || '' }}",
  2,
);
requireCount(
  "IDENTITY_CONFIRMATION: ${{ github.event_name == 'workflow_dispatch' && inputs.deploy_target != 'identity-cleanup' && inputs.identity_confirmation || '' }}",
  2,
);
requireCount(
  "IDENTITY_CLEANUP_CONFIRMATION: ${{ github.event_name == 'workflow_dispatch' && inputs.deploy_target == 'identity-cleanup' && inputs.identity_confirmation || '' }}",
  2,
);
if (
  workflow.includes("inputs.billing_cleanup_confirmation") ||
  workflow.includes("inputs.identity_cleanup_confirmation")
) {
  throw new Error("Removed cleanup confirmation inputs must not be referenced");
}

requireCount("guard_campaigns_checkout_before_pull() {", 2);
requireCount("checkout_verified_prod_revision() {", 1);
requireCount(
  'git rev-parse --verify "HEAD:$lifecycle_script" 2>/dev/null ||',
  8,
);
requireCount(
  'git rev-parse "HEAD:$lifecycle_script" 2>/dev/null || true',
  0,
);
requireCount(
  'guard_campaigns_checkout_before_pull "$expected_revision"',
  2,
);
requireCount("git fetch origin prod", 3);
requireCount("git checkout prod", 2);
requireCount('git merge --ff-only "$fetched_revision"', 1);
requireCount(
  'checkout_verified_prod_revision "$EXPECTED_REVISION"',
  9,
);
requireCount(
  '"$EXPECTED_REVISION" "$prefetched_cleanup_revision"',
  2,
);
requireCount(
  'checkout_verified_prod_revision "$EXPECTED_PROD_REVISION"',
  0,
);
requireCount(
  "git ls-remote --exit-code origin refs/heads/prod |",
  0,
);
requireCount(
  '--require-staged-revision "$expected_revision"',
  0,
);
requireCount("git pull --ff-only origin prod", 0);
requireCount(
  'echo "Campaigns marker exists but its checkout guard is unavailable." >&2',
  1,
);
requireCount(
  'echo "Tracked Campaigns lifecycle guard script is missing." >&2',
  1,
);
requireCount("guard_reporting_checkout_before_pull() {", 2);
requireCount("guard_widgets_checkout_before_pull() {", 2);
requireCount("guard_billing_checkout_before_pull() {", 2);
requireCount("guard_identity_checkout_before_pull() {", 2);
requireCount(
  'local lifecycle_script="scripts/widgets-database-lifecycle.sh"',
  2,
);
requireCount(
  'local guard_action="${2:---guard-before-fetch-revision}"',
  8,
);
requireCount('"$guard_action" "$expected_revision"', 2);
requireCount(
  '"$expected_revision" --guard-before-checkout-revision',
  8,
);
requireCount(
  '"$EXPECTED_NEXT_REVISION" --guard-before-checkout-revision',
  0,
);
requireCount(
  'guard_reporting_checkout_before_pull "$expected_revision"',
  2,
);
requireCount(
  'guard_widgets_checkout_before_pull "$expected_revision"',
  2,
);
requireCount(
  'guard_billing_checkout_before_pull "$expected_revision"',
  1,
);
requireCount(
  'guard_identity_checkout_before_pull "$expected_revision"',
  2,
);
requireCount(
  'echo "Reporting marker exists but its checkout guard is unavailable." >&2',
  1,
);
requireCount(
  'echo "Tracked Reporting lifecycle guard script is missing." >&2',
  1,
);
requireCount(
  'echo "Tracked Widgets lifecycle guard script is missing." >&2',
  1,
);
requireCount(
  'echo "Tracked Billing lifecycle guard script is missing." >&2',
  1,
);
requireCount(
  'echo "Billing marker exists but its checkout guard is unavailable." >&2',
  1,
);
requireCount(
  'echo "Identity marker exists but its checkout guard is unavailable." >&2',
  1,
);
requireCount(
  "stage_billing_cleanup_revision_with_container_node() (",
  1,
);
requireCount(
  'stage_billing_cleanup_revision_with_container_node \\',
  1,
);
const indentedStageOrDeployBody = stageOrDeployScript
  .split("\n")
  .slice(4)
  .map(line => `          ${line}`)
  .join("\n");
const deployJobHeader = workflow.slice(workflow.indexOf("\n  deploy:"));
const deploymentControllerCheckoutIndex = deployJobHeader.indexOf(
  "- name: Checkout deployment controller",
);
const deploymentControllerRunIndex = deployJobHeader.indexOf(
  "run: bash .github/scripts/stage-or-deploy-backend.sh",
);
if (
  deploymentControllerCheckoutIndex < 0 ||
  deploymentControllerRunIndex <= deploymentControllerCheckoutIndex
) {
  throw new Error(
    "The deploy job must check out the versioned controller before executing it",
  );
}
const deployJob = [
  deployJobHeader,
  indentedStageOrDeployBody,
].join("\n");
const billingNodeBootstrapStart = deployJob.indexOf(
  "stage_billing_cleanup_revision_with_container_node() (",
);
const billingNodeBootstrapEnd = deployJob.indexOf(
  "\n          retarget_billing_cleanup_revision() (",
  billingNodeBootstrapStart,
);
const billingNodeBootstrap = deployJob.slice(
  billingNodeBootstrapStart,
  billingNodeBootstrapEnd,
);
if (
  billingNodeBootstrapStart < 0 ||
  billingNodeBootstrapEnd <= billingNodeBootstrapStart
) {
  throw new Error(
    "Billing cleanup legacy Node bootstrap is missing or misplaced",
  );
}
for (const requiredBootstrapToken of [
  "--filter 'label=com.docker.compose.project=winwidget'",
  "--filter 'label=com.docker.compose.service=maintenance-worker'",
  '[[ "${#canonical_containers[@]}" == \'1\' ]]',
  '"$running" == \'true\' && "$restart_count" == \'0\'',
  '"$container_revision" == "$current_revision"',
  '"$app_revision" == "$current_revision"',
  '"$image_revision" == "$current_revision"',
  '"$image_user" == \'nestjs\'',
  "unix:///var/run/docker.sock",
  "^sha256:[0-9a-f]{64}$",
  "/tmp/winwidget-billing-cleanup-node.XXXXXX",
  "fff593a9f2fe2cf95ab5fb20ca537e4f0cc1d0ecfba186745b3491ecdb45936b",
  "protocol|username|password|hostname|port|database|schema",
  "--network none --read-only --user 65534:65534 --cap-drop ALL",
  "--log-driver none",
  "--security-opt no-new-privileges --entrypoint node",
  'trap billing_cleanup_node_bootstrap_on_exit EXIT',
  '--stage-cleanup-revision "$cleanup_revision"',
]) {
  if (!billingNodeBootstrap.includes(requiredBootstrapToken)) {
    throw new Error(
      `Billing cleanup Node bootstrap lost ${requiredBootstrapToken}`,
    );
  }
}
for (const forbiddenBootstrapToken of [
  "apt ",
  "apt-get ",
  "apk ",
  "docker exec",
  "--volume",
  "git checkout",
  "git merge",
]) {
  if (billingNodeBootstrap.includes(forbiddenBootstrapToken)) {
    throw new Error(
      `Billing cleanup Node bootstrap contains forbidden operation ${forbiddenBootstrapToken}`,
    );
  }
}
const billingLifecycle = readFileSync(
  "scripts/billing-database-lifecycle.sh",
  "utf8",
);
const billingUrlFieldStart = billingLifecycle.indexOf(
  "billing_database_url_field() {",
);
const billingUrlFieldEnd = billingLifecycle.indexOf(
  "\n}\n\nbilling_database_validate_urls() {",
  billingUrlFieldStart,
);
const billingUrlFieldFunction = billingLifecycle.slice(
  billingUrlFieldStart,
  billingUrlFieldEnd,
);
const billingUrlParserMatch = billingUrlFieldFunction.match(
  / -e '([\s\S]*)'$/,
);
if (
  billingUrlFieldStart < 0 ||
  billingUrlFieldEnd <= billingUrlFieldStart ||
  !billingUrlParserMatch ||
  Buffer.byteLength(billingUrlParserMatch[1]) !== 658 ||
  createHash("sha256").update(billingUrlParserMatch[1]).digest("hex") !==
    "fff593a9f2fe2cf95ab5fb20ca537e4f0cc1d0ecfba186745b3491ecdb45936b"
) {
  throw new Error(
    "Billing cleanup Node shim must stay pinned to the exact legacy URL parser",
  );
}
const cleanupDispatchStart = deployJob.indexOf(
  "\n            billing-cleanup)",
);
const cleanupDispatch = deployJob.slice(
  cleanupDispatchStart,
  deployJob.indexOf("\n            *)", cleanupDispatchStart),
);
const cleanupStageStart = cleanupDispatch.indexOf(
  'if [[ "$BILLING_CLEANUP_ACTION" == \'stage\'',
);
const cleanupStageDispatch = cleanupDispatch.slice(cleanupStageStart);
const cleanupFetchIndex = cleanupStageDispatch.indexOf(
  "git fetch origin prod",
);
const cleanupFetchHeadIndex = cleanupStageDispatch.indexOf(
  'prefetched_cleanup_revision="$(git rev-parse FETCH_HEAD)"',
);
const cleanupStageMarkerIndex = cleanupStageDispatch.indexOf(
  "stage_billing_cleanup_revision_with_container_node",
);
const cleanupCheckoutIndex = cleanupStageDispatch.indexOf(
  '"$EXPECTED_REVISION" "$prefetched_cleanup_revision"',
);
if (
  cleanupStageStart < 0 ||
  cleanupFetchIndex < 0 ||
  cleanupFetchHeadIndex < 0 ||
  cleanupStageMarkerIndex < 0 ||
  cleanupCheckoutIndex < 0 ||
  cleanupFetchIndex >= cleanupFetchHeadIndex ||
  cleanupFetchHeadIndex >= cleanupStageMarkerIndex ||
  cleanupStageMarkerIndex >= cleanupCheckoutIndex
) {
  throw new Error(
    "Billing cleanup must fetch and freeze origin/prod before binding and checking out SHA B",
  );
}
if (
  cleanupStageDispatch
    .slice(cleanupStageMarkerIndex, cleanupCheckoutIndex)
    .includes("git fetch origin prod")
) {
  throw new Error(
    "Billing cleanup must not refetch origin/prod after binding SHA B",
  );
}
const retargetFunctionStart = deployJob.indexOf(
  "retarget_billing_cleanup_revision() (",
);
const retargetFunctionEnd = deployJob.indexOf(
  "\n          checkout_verified_prod_revision() {",
  retargetFunctionStart,
);
const retargetFunction = deployJob.slice(
  retargetFunctionStart,
  retargetFunctionEnd,
);
if (
  retargetFunctionStart < 0 ||
  retargetFunctionEnd <= retargetFunctionStart
) {
  throw new Error("Billing cleanup retarget function is missing");
}
for (const requiredRetargetToken of [
  "RETARGET BILLING CLEANUP REVISION",
  "git merge-base --is-ancestor",
  '"$previous_cleanup_revision:prisma/migrations"',
  '"$next_cleanup_revision:prisma/migrations"',
  "winwidget-billing-retarget-helper.XXXXXX",
  '"$(git hash-object "$helper_path")" == "$helper_blob"',
  "billing_core_source_cleanup_require_exact_migration_manifest exclusive",
  'database_restore_guard_assert_before_mutation healthy-required "$ENV_FILE"',
  'local ENV_FILE="$APP_ROOT/deploy/backend/.env.production"',
  'local COMPOSE_FILE="$APP_ROOT/winwidget.ru_server/deploy/docker-compose.prod.yml"',
  "unix:///var/run/docker.sock",
  '"$identity" =~ ^winwidget\\|$service\\|[Ff]alse\\|1$',
  '"$state" == \'running|true|0\'',
  "billing-core-source-cleanup-pre-offsite",
  "state=prepared",
  "state=%s",
  "mv -fT",
  "retarget_marker_contract_sha256",
  "write_prepared_retarget_receipt",
  "Billing cleanup retarget may rebind only an intact prepared receipt before either parent marker changes.",
  '"$receipt_next_revision" "$next_cleanup_revision"',
  '"$receipt_next_revision:prisma/migrations"',
  "Billing cleanup retarget cannot replace a candidate with imported offsite receipts.",
  '"$receipt_state" =~ ^(prepared|ready)$',
]) {
  if (!retargetFunction.includes(requiredRetargetToken)) {
    throw new Error(
      `Billing cleanup retarget lost ${requiredRetargetToken}`,
    );
  }
}
if (
  retargetFunction.split(
    '-v next_revision="$next_cleanup_revision"',
  ).length -
    1 !==
    2 ||
  retargetFunction.includes('-v next="$next_cleanup_revision"')
) {
  throw new Error(
    "Billing cleanup retarget must not use the gawk next builtin as a variable name",
  );
}
requireCount(
  "retarget:'RETARGET BILLING CLEANUP REVISION') ;;",
  2,
);
const retargetStateCaseStart = retargetFunction.indexOf(
  'case "$cutover_state|$database_state|$receipt_state" in',
);
const retargetStateCaseEnd = retargetFunction.indexOf(
  "\n            esac",
  retargetStateCaseStart,
);
const retargetStateCase = retargetFunction.slice(
  retargetStateCaseStart,
  retargetStateCaseEnd,
);
for (const requiredState of [
  '"$previous_cleanup_revision|$previous_cleanup_revision|prepared")',
  '"$next_cleanup_revision|$previous_cleanup_revision|prepared"',
  '"$next_cleanup_revision|$previous_cleanup_revision|ready"',
  '"$next_cleanup_revision|$next_cleanup_revision|ready")',
]) {
  if (!retargetStateCase.includes(requiredState)) {
    throw new Error(
      `Billing cleanup retarget lost crash state ${requiredState}`,
    );
  }
}
if (
  retargetStateCaseStart < 0 ||
  retargetStateCaseEnd <= retargetStateCaseStart ||
  retargetStateCase.includes("|complete") ||
  retargetStateCase.includes(
    '"$previous_cleanup_revision|$next_cleanup_revision',
  )
) {
  throw new Error(
    "Billing cleanup retarget crash-state matrix is unsafe",
  );
}
if (
  retargetFunction.includes("git checkout") ||
  retargetFunction.includes("docker stop") ||
  retargetFunction.includes("docker rm") ||
  retargetFunction.includes("prisma migrate")
) {
  throw new Error(
    "Billing cleanup retarget must not checkout, stop services, remove containers, or migrate",
  );
}
const cutoverMarkerWrite = retargetFunction.indexOf(
  'mv -fT "$cutover_temporary" "$cutover_marker"',
);
const receiptReadyWrite = retargetFunction.indexOf(
  "rewrite_retarget_receipt ready",
  cutoverMarkerWrite,
);
const databaseMarkerWrite = retargetFunction.indexOf(
  'mv -fT "$database_temporary" "$database_marker"',
);
const preparedReceiptRebind = retargetFunction.indexOf(
  'write_prepared_retarget_receipt "$receipt_created_at"',
);
if (
  cutoverMarkerWrite < 0 ||
  receiptReadyWrite <= cutoverMarkerWrite ||
  databaseMarkerWrite <= receiptReadyWrite ||
  preparedReceiptRebind < 0 ||
  preparedReceiptRebind >= cutoverMarkerWrite
) {
  throw new Error(
    "Billing cleanup retarget must rebind only prepared evidence before committing cutover marker, ready receipt, then database marker",
  );
}
const retargetCheckoutStart = deployJob.indexOf(
  "checkout_retargeted_billing_cleanup_revision() {",
);
const retargetCheckoutEnd = deployJob.indexOf(
  '\n          current_revision="$(git rev-parse HEAD)"',
  retargetCheckoutStart,
);
const retargetCheckout = deployJob.slice(
  retargetCheckoutStart,
  retargetCheckoutEnd,
);
const retargetMerge = retargetCheckout.indexOf(
  'git merge --ff-only "$prefetched_revision"',
);
const retargetBillingGuard = retargetCheckout.indexOf(
  "guard_billing_checkout_before_pull",
);
if (
  retargetCheckoutStart < 0 ||
  retargetCheckoutEnd <= retargetCheckoutStart ||
  retargetMerge < 0 ||
  retargetBillingGuard <= retargetMerge ||
  retargetCheckout.slice(0, retargetMerge).includes(
    "guard_billing_checkout_before_pull",
  )
) {
  throw new Error(
    "Billing cleanup retarget checkout must defer only the Billing guard until candidate checkout",
  );
}
const retargetDispatchStart = cleanupDispatch.indexOf(
  'if [[ "$BILLING_CLEANUP_ACTION" == \'retarget\'',
);
const retargetDispatchEnd = cleanupDispatch.indexOf(
  "\n              prefetched_cleanup_revision=''",
  retargetDispatchStart,
);
const retargetDispatch = cleanupDispatch.slice(
  retargetDispatchStart,
  retargetDispatchEnd,
);
const retargetFetch = retargetDispatch.indexOf("git fetch origin prod");
const retargetMutation = retargetDispatch.lastIndexOf(
  "retarget_billing_cleanup_revision",
);
const retargetCheckoutCall = retargetDispatch.indexOf(
  "checkout_retargeted_billing_cleanup_revision",
);
const retargetStatus = retargetDispatch.indexOf(
  "scripts/billing-database-lifecycle.sh --status",
);
const retargetExit = retargetDispatch.lastIndexOf("exit 0");
if (
  retargetDispatchStart < 0 ||
  retargetDispatchEnd <= retargetDispatchStart ||
  retargetFetch < 0 ||
  retargetMutation <= retargetFetch ||
  retargetCheckoutCall <= retargetMutation ||
  retargetStatus <= retargetCheckoutCall ||
  retargetExit <= retargetStatus ||
  retargetDispatch.includes("--stage") ||
  retargetDispatch.includes("--run")
) {
  throw new Error(
    "Billing cleanup retarget dispatch must fetch, retarget, checkout, status, and exit without cleanup mutation",
  );
}
const automaticDeferStart = deployJob.indexOf(
  'current_revision="$(git rev-parse HEAD)"\n          if [[ "$AUTOMATIC_PROD_PUSH" == "true"',
);
const automaticDeferEnd = deployJob.indexOf(
  '\n          case "$DEPLOY_TARGET" in',
  automaticDeferStart,
);
const automaticDefer = deployJob.slice(
  automaticDeferStart,
  automaticDeferEnd,
);
const billingCandidateGuard = automaticDefer.indexOf(
  'if ! guard_billing_checkout_before_pull \\\n              "$EXPECTED_REVISION"',
);
const billingDeferredExit = automaticDefer.indexOf(
  "exit 0",
  billingCandidateGuard,
);
if (
  automaticDeferStart < 0 ||
  automaticDeferEnd <= automaticDeferStart ||
  billingCandidateGuard < 0 ||
  billingDeferredExit <= billingCandidateGuard ||
  automaticDefer.includes("git fetch origin prod") ||
  automaticDefer.includes("git checkout prod") ||
  automaticDefer.includes("retarget_billing_cleanup_revision")
) {
  throw new Error(
    "Automatic SHA C push must defer before fetch, checkout, or Billing cleanup retarget",
  );
}
if (
  !deployJob.includes("needs: verify") ||
  !deployJob.includes("github.event_name == 'push'") ||
  deployJob.includes("needs.verify.result")
) {
  throw new Error(
    "Ordinary pushes must keep the simple mandatory preflight to verify to deploy chain",
  );
}
const assertCheckoutOrder = (job, lockNeedle, label) => {
  const lockIndex = job.indexOf(lockNeedle);
  const checkoutFunctionStart = job.indexOf(
    "checkout_verified_prod_revision() {",
  );
  const checkoutFunctionEnd = job.indexOf(
    "\n          checkout_retargeted_billing_cleanup_revision() {",
    checkoutFunctionStart,
  );
  const checkoutFunction = job.slice(
    checkoutFunctionStart,
    checkoutFunctionEnd,
  );
  const reportingPreFetchGuardIndex = checkoutFunction.lastIndexOf(
    'guard_reporting_checkout_before_pull "$expected_revision"',
  );
  const campaignsGuardIndex = checkoutFunction.lastIndexOf(
    'guard_campaigns_checkout_before_pull "$expected_revision"',
  );
  const widgetsPreFetchGuardIndex = checkoutFunction.lastIndexOf(
    'guard_widgets_checkout_before_pull "$expected_revision"',
  );
  const billingPreFetchGuardIndex = checkoutFunction.lastIndexOf(
    'guard_billing_checkout_before_pull "$expected_revision"',
  );
  const identityPreFetchGuardIndex = checkoutFunction.lastIndexOf(
    'guard_identity_checkout_before_pull "$expected_revision"',
  );
  const fetchIndex = checkoutFunction.indexOf("git fetch origin prod");
  const reportingPostFetchGuardIndex = checkoutFunction.indexOf(
    "guard_reporting_checkout_before_pull",
    fetchIndex,
  );
  const widgetsPostFetchGuardIndex = checkoutFunction.indexOf(
    "guard_widgets_checkout_before_pull",
    fetchIndex,
  );
  const billingPostFetchGuardIndex = checkoutFunction.indexOf(
    "guard_billing_checkout_before_pull",
    fetchIndex,
  );
  const identityPostFetchGuardIndex = checkoutFunction.indexOf(
    "guard_identity_checkout_before_pull",
    fetchIndex,
  );
  const checkoutIndex = checkoutFunction.lastIndexOf("git checkout prod");
  if (
    lockIndex < 0 ||
    checkoutFunctionStart < 0 ||
    checkoutFunctionEnd <= checkoutFunctionStart ||
    reportingPreFetchGuardIndex < 0 ||
    campaignsGuardIndex < 0 ||
    widgetsPreFetchGuardIndex < 0 ||
    billingPreFetchGuardIndex < 0 ||
    identityPreFetchGuardIndex < 0 ||
    fetchIndex < 0 ||
    reportingPostFetchGuardIndex < 0 ||
    widgetsPostFetchGuardIndex < 0 ||
    billingPostFetchGuardIndex < 0 ||
    identityPostFetchGuardIndex < 0 ||
    checkoutIndex < 0 ||
    lockIndex >= checkoutFunctionStart ||
    reportingPreFetchGuardIndex >= fetchIndex ||
    campaignsGuardIndex >= fetchIndex ||
    widgetsPreFetchGuardIndex >= fetchIndex ||
    billingPreFetchGuardIndex >= fetchIndex ||
    identityPreFetchGuardIndex >= fetchIndex ||
    fetchIndex >= reportingPostFetchGuardIndex ||
    reportingPostFetchGuardIndex >= widgetsPostFetchGuardIndex ||
    widgetsPostFetchGuardIndex >= billingPostFetchGuardIndex ||
    billingPostFetchGuardIndex >= identityPostFetchGuardIndex ||
    identityPostFetchGuardIndex >= checkoutIndex
  ) {
    throw new Error(
      `${label} must hold the production lock and pass every lifecycle guard around the exact fetch`,
    );
  }
};
assertCheckoutOrder(
  deployJob,
  'acquire_production_deploy_lock "backend checkout and deployment"',
  "Backend deploy checkout",
);
const lifecyclePreflightStart = workflow.indexOf(
  "\n  lifecycle_checkout_preflight:",
);
const verifyStart = workflow.indexOf("\n  verify:");
const verifyServicesStart = workflow.indexOf(
  "\n    services:",
  verifyStart,
);
if (
  lifecyclePreflightStart < 0 ||
  verifyStart <= lifecyclePreflightStart ||
  verifyServicesStart <= verifyStart ||
  substringCount(workflow, "\n  lifecycle_checkout_preflight:") !== 1 ||
  substringCount(workflow, "\n  verify:") !== 1
) {
  throw new Error(
    "The mandatory production preflight and verify chain is missing or out of order",
  );
}
const lifecyclePreflightHeader = compactWhitespace(
  workflow.slice(lifecyclePreflightStart, verifyStart),
);
const verifyHeader = compactWhitespace(
  workflow.slice(verifyStart, verifyServicesStart),
);
if (
  !lifecyclePreflightHeader.includes(
    "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
  ) ||
  !verifyHeader.includes("needs: lifecycle_checkout_preflight") ||
  !verifyHeader.includes(
    "needs.lifecycle_checkout_preflight.result == 'success'",
  )
) {
  throw new Error(
    "Every ordinary and manual deployment must pass mandatory preflight and verify",
  );
}
for (const retiredToken of [
  "\n          - notification-delivery-" + "database",
  "\n          - campaigns-" + "database",
  "\n      campaigns_" + "database_action:",
  "\n  notification-delivery-" + "database:",
  "\n  campaigns-" + "database:",
  "inputs.campaigns_" + "database_action",
  "\n          - reporting-" + "database",
  "\n          - reporting-" + "cutover",
  "\n      reporting_" + "database_action:",
  "\n      reporting_" + "cutover_action:",
  "\n      reporting_" + "core_backup_job_id:",
  "\n      reporting_" + "cleanup_confirmation:",
  "\n      reporting_" + "cleanup_resolve_confirmation:",
  "\n  reporting-" + "database-status:",
  "\n  reporting-" + "cutover-status:",
  "\n  reporting-" + "cutover-verify-core-cleanup-backup:",
  "\n  reporting-" + "cutover-resolve-core-cleanup:",
  "\n  reporting-" + "cutover-stage-cleanup:",
  "\n  reporting-" + "database:",
  "inputs.reporting_" + "database_action",
  "inputs.reporting_" + "cutover_action",
  "inputs.reporting_" + "core_backup_job_id",
  "inputs.reporting_" + "cleanup_confirmation",
  "inputs.reporting_" + "cleanup_resolve_confirmation",
  "Validate Reporting production " + "env before full verify",
]) {
  if (workflowContract.includes(retiredToken)) {
    throw new Error(
      `Completed Reporting lifecycle workflow surface remains: ${retiredToken}`,
    );
  }
}
const deployScript = readFileSync(
  "scripts/deploy-production.sh",
  "utf8",
);
const maintenanceScript = readFileSync(
  "scripts/deploy-maintenance-production.sh",
  "utf8",
);
const restoreStorageFunction = deployScript.slice(
  deployScript.indexOf("prepare_database_restore_storage() {"),
  deployScript.indexOf('\nmode="$(get_env_value "MODE" || true)"'),
);
if (
  !restoreStorageFunction.includes(
    "for directory in queued processing locks gates fences; do",
  )
) {
  throw new Error(
    "Full deployment must block on every active restore transition gate",
  );
}
if (
  !deployScript.includes(
    "validate_routine_database_restore_create_gate() {",
  ) ||
  !deployScript.includes(
    'validate_routine_database_restore_create_gate "$ENV_FILE" || exit 1',
  ) ||
  !deployScript.includes(
    "Routine production deployment rejects DATABASE_RESTORE_PRODUCTION_ENABLED=true. Use the separate reviewed restore-control action.",
  ) ||
  deployScript.includes(
    "^DATABASE_RESTORE_PRODUCTION_ENABLED=(true|false)$",
  )
) {
  throw new Error(
    "Routine production deployment must reject an enabled database restore create-gate",
  );
}
const reportingStageIndex = deployScript.indexOf(
  "reporting_write_first_rollout_staged_marker",
);
const envReadIndex = deployScript.indexOf(
  'if [[ ! -f "$ENV_FILE" ]]',
);
const reportingBuildInFullIndex = deployScript.indexOf(
  "reporting-service",
  envReadIndex,
);
const reportingRuntimeStarts =
  deployScript.match(
    /compose_target up -d --no-deps --force-recreate reporting-service/g,
  ) || [];
const cleanupStopBoundary = deployScript.slice(
  deployScript.lastIndexOf(
    "if ! stop_routine_topology_for_core_migration; then",
  ),
  deployScript.lastIndexOf(
    "if ! compose_target --profile migration run --rm --no-deps migrate; then",
  ),
);
const coreCleanupBackupIndex = cleanupStopBoundary.indexOf(
  "reporting_cutover_require_core_cleanup_backup_from_review",
);
const legacyCleanupDrainIndex = cleanupStopBoundary.indexOf(
  "reporting_cutover_require_cleanup_legacy_drain_after_stop",
);
const settingsCleanupTopologyIndex = cleanupStopBoundary.indexOf(
  "reporting_cutover_prepare_settings_topology_cleanup_after_stop",
);
const cleanupRuntimeStartIndex = deployScript.indexOf(
  "compose_target up -d --no-deps --force-recreate reporting-service",
);
const cleanupActiveTopologyIndex = deployScript.indexOf(
  "reporting_require_rabbitmq_topology",
  cleanupRuntimeStartIndex,
);
if (
  reportingStageIndex < 0 ||
  envReadIndex < 0 ||
  reportingStageIndex >= envReadIndex ||
  reportingBuildInFullIndex < envReadIndex ||
  !deployScript.includes(
    'reporting_initialize_database_guard "a routine full deployment"',
  ) ||
  !deployScript.includes(
    "reporting_verify_database_lifecycle_unchanged",
  ) ||
  reportingRuntimeStarts.length !== 1 ||
  !deployScript.includes(
    "reporting_cleanup_runtime_deploy=true",
  ) ||
  !deployScript.includes(
    '"$(reporting_cutover_marker_value phase)" == \'cleanup-staged\'',
  ) ||
  !deployScript.includes(
    '"$(reporting_cutover_marker_value cleanup_revision)" == "$APP_REVISION"',
  ) ||
  !deployScript.includes(
    "reporting_cutover_prepare_settings_topology_cleanup_after_stop",
  ) ||
  !deployScript.includes(
    "reporting_cutover_core_cleanup_migration_state",
  ) ||
  !deployScript.includes(
    "stop_reporting_cleanup_topology_for_core_migration",
  ) ||
  !deployScript.includes("recover_reporting_cleanup_stop_on_exit") ||
  !deployScript.includes(
    "unfinished-transition | unfinished-steady",
  ) ||
  !deployScript.includes(
    "reporting_cutover_require_core_cleanup_backup_archive_from_review",
  ) ||
  !deployScript.includes(
    '"$reporting_cleanup_migration_state" == \'pending\'',
  ) ||
  coreCleanupBackupIndex < 0 ||
  legacyCleanupDrainIndex < 0 ||
  settingsCleanupTopologyIndex < 0 ||
  coreCleanupBackupIndex >= legacyCleanupDrainIndex ||
  legacyCleanupDrainIndex >= settingsCleanupTopologyIndex ||
  cleanupStopBoundary.includes("reporting_require_rabbitmq_topology") ||
  cleanupRuntimeStartIndex < 0 ||
  cleanupActiveTopologyIndex <= cleanupRuntimeStartIndex ||
  !deployScript.includes(
    "Exact Core cleanup migration is already applied; Prisma deploy is skipped during forward-only recovery.",
  ) ||
  !deployScript.includes(
    "continuing forward without restoring old writers",
  ) ||
  !deployScript.includes(
    "Cleanup Reporting cannot start until the exact migration state is applied",
  ) ||
  !deployScript.includes(
    'reporting_cutover_require_cleanup_runtime_revision "$APP_REVISION"',
  )
) {
  throw new Error(
    "Full deployment must guard Reporting state and start one canonical runtime after the stopped migration boundary",
  );
}
for (const [label, script] of [
  ["full deployment", deployScript],
  ["maintenance deployment", maintenanceScript],
]) {
  if (
    !script.includes(
      'source "$server_root/scripts/core-database-production-guard.sh"',
    ) ||
    !script.includes("assert_core_database_production_boundary")
  ) {
    throw new Error(
      `${label} must fail closed on the standalone core database boundary`,
    );
  }
}
for (const requiredBoundary of [
  "stop_routine_topology_for_core_migration",
  ".State.ExitCode",
  ".State.OOMKilled",
  "verify_core_database_sessions_drained",
  "LEGACY_API_SHUTDOWN_BOOTSTRAP_REVISION",
  "exited|137|false|",
]) {
  if (!deployScript.includes(requiredBoundary)) {
    throw new Error(
      `Full deployment is missing clean-stop boundary: ${requiredBoundary}`,
    );
  }
}
const apiMain = readFileSync("src/main.ts", "utf8");
if (!apiMain.includes("forceCloseConnections: true")) {
  throw new Error(
    "Monolith API must force-close residual HTTP connections during shutdown",
  );
}
const compose = readFileSync(
  "deploy/docker-compose.prod.yml",
  "utf8",
);
if (compose.includes("winwidget-core-postgres-temporary")) {
  throw new Error(
    "Routine production Compose must not own the temporary core PostgreSQL lifecycle",
  );
}
process.stdout.write(
  "Backend checkout and standalone core database guards verified\n",
);
NODE
