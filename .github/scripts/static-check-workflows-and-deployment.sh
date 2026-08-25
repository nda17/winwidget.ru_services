#!/usr/bin/env bash
set -e
set -o pipefail

sh -n database-restore-entrypoint.sh
bash -n \
  .github/scripts/validate-production-compose.sh \
  .github/scripts/static-check-workflows-and-deployment.sh \
  .github/scripts/stage-or-deploy-backend.sh \
  .github/scripts/stage-or-deploy-backend-remote.sh
node --check .github/scripts/validate-production-compose.cjs
# actionlint runs without its ShellCheck integration. Extracted workflow
# runners are syntax-checked above; production scripts are checked separately.
docker run --rm \
  --network none \
  --read-only \
  --security-opt no-new-privileges \
  --volume "$GITHUB_WORKSPACE:/repo:ro" \
  --workdir /repo \
  rhysd/actionlint@sha256:ef8299f97635c4c30e2298f48f30763ab782a4ad2c95b744649439a039421e36 \
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
  scripts/test-identity-production-env-recovery.sh \
  scripts/identity-database-lifecycle.sh \
  scripts/deploy-identity-production.sh \
  scripts/identity-cutover-production.sh \
  scripts/identity-backup-restore-rehearsal.sh \
  scripts/cleanup-identity-core-source-production.sh \
  scripts/rotate-identity-jwt-production.sh \
  scripts/platform-release-identity.sh \
  scripts/platform-database-lifecycle.sh \
  scripts/platform-cutover-production.sh \
  scripts/platform-frontend-runtime-attestation.sh \
  scripts/platform-backup-restore-rehearsal.sh \
  scripts/deploy-platform-production.sh \
  .github/scripts/stage-or-deploy-backend.sh \
  .github/scripts/stage-or-deploy-backend-remote.sh \
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
const { existsSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const workflow = readFileSync(
  ".github/workflows/deploy-production.yml",
  "utf8",
);
const platformLifecycleLines = workflow.split("\n");
const platformLifecycleStarts = platformLifecycleLines
  .map((line, index) =>
    line.includes("<<'PLATFORM_LIFECYCLE'") ? index : -1,
  )
  .filter(index => index >= 0);
if (platformLifecycleStarts.length !== 1) {
  throw new Error("Expected exactly one Platform lifecycle heredoc");
}
const platformLifecycleStart = platformLifecycleStarts[0];
const platformLifecycleEnd = platformLifecycleLines.indexOf(
  "          PLATFORM_LIFECYCLE",
  platformLifecycleStart + 1,
);
if (platformLifecycleEnd < 0) {
  throw new Error("Platform lifecycle heredoc terminator is missing");
}
const platformLifecycle = platformLifecycleLines
  .slice(platformLifecycleStart + 1, platformLifecycleEnd)
  .map(line => {
    if (line !== "" && !line.startsWith("          ")) {
      throw new Error("Platform lifecycle heredoc indentation is invalid");
    }
    return line.slice(10);
  })
  .join("\n");
const platformLifecycleSyntax = spawnSync("bash", ["-n"], {
  input: platformLifecycle,
  encoding: "utf8",
});
if (platformLifecycleSyntax.status !== 0) {
  throw new Error(
    `Platform lifecycle heredoc is not valid Bash: ${platformLifecycleSyntax.stderr.trim()}`,
  );
}
const validateProductionComposeWrapper = readFileSync(
  ".github/scripts/validate-production-compose.sh",
  "utf8",
);
const validateProductionComposeValidator = readFileSync(
  ".github/scripts/validate-production-compose.cjs",
  "utf8",
);
const validateProductionComposeScript = [
  validateProductionComposeWrapper,
  validateProductionComposeValidator,
].join("\n");
if (
  !validateProductionComposeWrapper.includes(
    "node .github/scripts/validate-production-compose.cjs",
  ) ||
  validateProductionComposeWrapper.includes("node -e")
) {
  throw new Error(
    "Production Compose validation must execute its versioned file instead of oversized inline JavaScript",
  );
}
const productionCompose = readFileSync(
  "deploy/docker-compose.prod.yml",
  "utf8",
);
const staticWorkflowCheckScript = readFileSync(
  ".github/scripts/static-check-workflows-and-deployment.sh",
  "utf8",
);
const stageOrDeployLocalScript = readFileSync(
  ".github/scripts/stage-or-deploy-backend.sh",
  "utf8",
);
const stageOrDeployRemoteScript = readFileSync(
  ".github/scripts/stage-or-deploy-backend-remote.sh",
  "utf8",
);
const stageOrDeployScript = [
  stageOrDeployLocalScript,
  stageOrDeployRemoteScript,
].join("\n");
const identityEnvRecoveryTest = readFileSync(
  "scripts/test-identity-production-env-recovery.sh",
  "utf8",
);
const identityEnvControlScript = readFileSync(
  "scripts/identity-production-env-control.sh",
  "utf8",
);
const identityCutoverScript = readFileSync(
  "scripts/identity-cutover-production.sh",
  "utf8",
);
const identityJwtRotationScript = readFileSync(
  "scripts/rotate-identity-jwt-production.sh",
  "utf8",
);
const deployProductionScript = readFileSync(
  "scripts/deploy-production.sh",
  "utf8",
);
const deployPlatformProductionScript = readFileSync(
  "scripts/deploy-platform-production.sh",
  "utf8",
);
const coreAppModule = readFileSync("src/app.module.ts", "utf8");
const retiredCorePlatformRuntimeFiles = [
  "src/site-settings/site-settings.module.ts",
  "src/legal-pages/legal-pages.module.ts",
  "src/home-page-content/home-page-content.module.ts",
  "src/platform-boundary/platform-core-state.service.ts",
  "src/platform-boundary/platform-legacy-route.guard.ts",
];
if (
  retiredCorePlatformRuntimeFiles.some((file) => existsSync(file)) ||
  ["SiteSettingsModule", "LegalPagesModule", "HomePageContentModule", "PlatformBoundaryModule"].some(
    (token) => coreAppModule.includes(token),
  )
) {
  throw new Error("Retired Platform runtime or ownership guard remains registered in Core");
}
const platformEnvExample = readFileSync(
  "apps/platform/.env.example",
  "utf8",
);
const platformMigration = readFileSync(
  "apps/platform/prisma/migrations/20260823000000_init_platform/migration.sql",
  "utf8",
);
const platformMonotonicTimestampMigration = readFileSync(
  "apps/platform/prisma/migrations/20260823010000_fix_service_identity_timestamp_monotonicity/migration.sql",
  "utf8",
);
const platformSchema = readFileSync(
  "apps/platform/prisma/schema.prisma",
  "utf8",
);
const platformSequence = readFileSync(
  "apps/platform/src/domain/platform-sequence.ts",
  "utf8",
);
const platformCutoverTarget = readFileSync(
  "apps/platform/src/cutover/main.ts",
  "utf8",
);
const platformCutoverCore = readFileSync(
  "apps/platform/src/cutover/core-main.ts",
  "utf8",
);
const platformCoreOwnershipMigration = readFileSync(
  "prisma/migrations/20260824000000_prepare_platform_service_ownership/migration.sql",
  "utf8",
);
const platformOfferContinuity = readFileSync(
  "apps/platform/src/domain/billing-offer-continuity.ts",
  "utf8",
);
const billingMessagingConstants = readFileSync(
  "apps/billing/src/messaging/billing-messaging.constants.ts",
  "utf8",
);
const billingRabbitMqService = readFileSync(
  "apps/billing/src/messaging/billing-rabbitmq.service.ts",
  "utf8",
);
const billingProjection = readFileSync(
  "apps/billing/src/projections/billing-projection.service.ts",
  "utf8",
);
const platformMutationServices = [
  "apps/platform/src/site-settings/site-settings.service.ts",
  "apps/platform/src/legal-pages/legal-pages.service.ts",
  "apps/platform/src/home-page-content/home-page-content.service.ts",
].map((file) => readFileSync(file, "utf8"));
const platformOwnershipService = readFileSync(
  "apps/platform/src/ownership/platform-ownership.service.ts",
  "utf8",
);
const platformBackupRestoreRehearsal = readFileSync(
  "scripts/platform-backup-restore-rehearsal.sh",
  "utf8",
);
const platformDatabaseLifecycle = readFileSync(
  "scripts/platform-database-lifecycle.sh",
  "utf8",
);
const platformCutoverScript = readFileSync(
  "scripts/platform-cutover-production.sh",
  "utf8",
);
const platformFrontendAttestationScript = readFileSync(
  "scripts/platform-frontend-runtime-attestation.sh",
  "utf8",
);
const telegramBridgeNginx = readFileSync(
  "deploy/telegram-bridge/nginx.conf",
  "utf8",
);
const telegramBridgeStream = readFileSync(
  "deploy/telegram-bridge/telegram-api-stream.conf",
  "utf8",
);
for (const requiredTelegramStreamContract of [
  "listen 8443;",
  "listen [::]:8443;",
  "map $remote_addr $telegram_api_upstream {",
  "default api.telegram.org:443;",
  "resolver 1.1.1.1 8.8.8.8 ipv6=off valid=5m;",
  "proxy_pass $telegram_api_upstream;",
  "limit_conn telegram_api_per_ip 32;",
]) {
  if (!telegramBridgeStream.includes(requiredTelegramStreamContract)) {
    throw new Error(
      `Telegram public stream contract is missing: ${requiredTelegramStreamContract}`,
    );
  }
}
if (telegramBridgeStream.includes("server api.telegram.org:443")) {
  throw new Error(
    "Telegram public stream must not resolve a potentially unreachable IPv6 upstream at Nginx reload time",
  );
}
const telegramBotApiLocation =
  "location ~ ^/telegram-api/(bot[0-9]+:[A-Za-z0-9_-]+)/(getMe|getWebhookInfo|deleteWebhook|setWebhook|sendMessage|sendDocument|copyMessage|answerCallbackQuery)$ {";
for (const requiredTelegramBridgeContract of [
  telegramBotApiLocation,
  "location = /telegram-api-health {",
  'add_header X-WinWidget-Telegram-Proxy "active" always;',
  "limit_except GET POST {",
  "proxy_pass_request_body off;",
  "client_max_body_size 52m;",
  "limit_conn_zone $binary_remote_addr zone=telegram_api_https_per_ip:10m;",
  "limit_conn telegram_api_https_per_ip 32;",
  "proxy_request_buffering off;",
  "proxy_buffering off;",
  "proxy_ssl_server_name on;",
  "proxy_ssl_name api.telegram.org;",
  "proxy_ssl_verify on;",
  "proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;",
  "proxy_read_timeout 11m;",
]) {
  if (!telegramBridgeNginx.includes(requiredTelegramBridgeContract)) {
    throw new Error(
      `Telegram bridge contract is missing: ${requiredTelegramBridgeContract}`,
    );
  }
}
if (
  (telegramBridgeNginx.match(/access_log off;/g) ?? []).length < 4 ||
  (telegramBridgeNginx.match(/error_log \/dev\/null;/g) ?? []).length < 3 ||
  (telegramBridgeNginx.match(/proxy_ssl_verify on;/g) ?? []).length < 2 ||
  !/server \{[\s\S]*?listen 80;[\s\S]*?location \/telegram-api\/ \{[\s\S]*?access_log off;[\s\S]*?error_log \/dev\/null;[\s\S]*?return 404;[\s\S]*?\}[\s\S]*?location \/ \{[\s\S]*?return 301 https:\/\/\$host\$request_uri;[\s\S]*?\}/.test(
    telegramBridgeNginx,
  ) ||
  !/location = \/telegram-api-health \{[\s\S]*?limit_except GET \{[\s\S]*?proxy_pass_request_body off;[\s\S]*?proxy_set_header Content-Length "";/.test(
    telegramBridgeNginx,
  ) ||
  !new RegExp(
    `${telegramBotApiLocation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?access_log off;[\\s\\S]*?error_log \/dev\/null;`,
  ).test(telegramBridgeNginx)
) {
  throw new Error(
    "Telegram bridge must keep tokens out of logs and preserve the method/TLS/upload contract",
  );
}
for (const telegramDeployScript of [
  deployProductionScript,
  readFileSync("scripts/deploy-maintenance-production.sh", "utf8"),
  readFileSync("scripts/deploy-notification-delivery-production.sh", "utf8"),
  readFileSync("scripts/deploy-identity-production.sh", "utf8"),
]) {
  if (
    !telegramDeployScript.includes('--dump-header "$header_file"') ||
    !telegramDeployScript.includes(
      'tolower($1) == "x-winwidget-telegram-proxy:"',
    ) ||
    !telegramDeployScript.includes(
      '[[ "$http_status" =~ ^[234][0-9]{2}$ && "$marker" == \'active\' ]]',
    )
  ) {
    throw new Error(
      "Every Telegram deploy preflight must verify the unique reverse-proxy health marker",
    );
  }
}
const staticWorkflowLines = staticWorkflowCheckScript
  .split("\n")
  .map((line) => line.trim());
if (
  (platformMigration.match(
    /AND "source_high_watermark" > 0/g,
  ) ?? []).length !== 2 ||
  platformMigration.includes('AND "source_high_watermark" >= 0') ||
  !platformOwnershipService.includes(
    "identity.sourceHighWatermark > 0n",
  ) ||
  platformOwnershipService.includes(
    "identity.sourceHighWatermark >= 0n",
  ) ||
  !platformBackupRestoreRehearsal.includes(
    "platform_restore_assert_positive_high_watermark_constraint",
  ) ||
  !platformBackupRestoreRehearsal.includes(
    'service_identity_source_check',
  )
) {
  throw new Error(
    "Platform target ownership must reject a zero source high-watermark in SQL, runtime readiness, and restore rehearsal",
  );
}
const platformImportedVerifyStart = platformCutoverTarget.indexOf(
  "async function verifyImportedState(",
);
const platformActiveVerifyStart = platformCutoverTarget.indexOf(
  "async function verifyActiveState(",
  platformImportedVerifyStart,
);
const platformVerifyEnd = platformCutoverTarget.indexOf(
  "\nfunction exactSourceCounts(",
  platformActiveVerifyStart,
);
const platformImportedVerify = platformCutoverTarget.slice(
  platformImportedVerifyStart,
  platformActiveVerifyStart,
);
const platformActiveVerify = platformCutoverTarget.slice(
  platformActiveVerifyStart,
  platformVerifyEnd,
);
const platformSemanticGuardFunctionStart = platformMigration.indexOf(
  'CREATE FUNCTION "platform"."enforce_current_semantic_fingerprint"()',
);
const platformSemanticGuardFunctionEnd = platformMigration.indexOf(
  '\nREVOKE ALL ON FUNCTION "platform"."enforce_current_semantic_fingerprint"()',
  platformSemanticGuardFunctionStart,
);
const platformSemanticGuardFunction = platformMigration.slice(
  platformSemanticGuardFunctionStart,
  platformSemanticGuardFunctionEnd,
);
const platformSemanticGuardTriggers = [
  ["service_identity", "service_identity_semantic_fingerprint_guard"],
  ["source_sequences", "source_sequences_semantic_fingerprint_guard"],
  ["site_settings", "site_settings_semantic_fingerprint_guard"],
  ["legal_pages", "legal_pages_semantic_fingerprint_guard"],
  ["home_page_content", "home_page_content_semantic_fingerprint_guard"],
  [
    "billing_offer_producer_state",
    "billing_offer_producer_semantic_fingerprint_guard",
  ],
];
const platformWorkflowRestoreStart = workflow.indexOf(
  "- name: Verify Platform PostgreSQL isolation and restore rehearsal",
);
const platformWorkflowRestoreEnd = workflow.indexOf(
  "- name: Verify Notification Delivery PostgreSQL persistence and restore",
  platformWorkflowRestoreStart,
);
const platformWorkflowRestore = workflow.slice(
  platformWorkflowRestoreStart,
  platformWorkflowRestoreEnd,
);
if (
  !/currentSemanticFingerprint\s+String\s+@map\("current_semantic_fingerprint"\)/.test(
    platformSchema,
  ) ||
  !/sourceFingerprint\s+String\?\s+@map\("source_fingerprint"\)/.test(
    platformSchema,
  ) ||
  !platformMigration.includes(
    '"current_semantic_fingerprint" TEXT NOT NULL',
  ) ||
  !platformMigration.includes(
    'CREATE FUNCTION "platform"."current_semantic_fingerprint"()',
  ) ||
  platformMigration.includes('CREATE SCHEMA IF NOT EXISTS "platform"') ||
  !platformMigration.includes(
    "IF to_regnamespace('platform') IS NULL THEN",
  ) ||
  !platformMigration.includes('EXECUTE \'CREATE SCHEMA "platform"\'') ||
  !/CREATE FUNCTION "platform"\."refresh_current_semantic_fingerprint"\(\s*expected_post_fingerprint TEXT\s*\)/.test(
    platformMigration,
  ) ||
  !/CREATE OR REPLACE FUNCTION "platform"\."refresh_current_semantic_fingerprint"\(\s*expected_post_fingerprint TEXT\s*\)/.test(
    platformMonotonicTimestampMigration,
  ) ||
  !platformMonotonicTimestampMigration.includes("VOLATILE") ||
  !platformMonotonicTimestampMigration.includes("SECURITY INVOKER") ||
  platformMonotonicTimestampMigration.includes("SECURITY DEFINER") ||
  !platformMonotonicTimestampMigration.includes(
    "SET search_path = pg_catalog, platform",
  ) ||
  !platformMonotonicTimestampMigration.includes(
    '"updated_at" = GREATEST(',
  ) ||
  !platformMonotonicTimestampMigration.includes(
    "pg_catalog.clock_timestamp()::timestamp",
  ) ||
  platformMonotonicTimestampMigration.includes(
    '"updated_at" = CURRENT_TIMESTAMP',
  ) ||
  !platformMonotonicTimestampMigration.includes(
    "CONSTRAINT = 'platform_current_semantic_fingerprint_guard'",
  ) ||
  !platformMonotonicTimestampMigration.includes(
    "'winwidget.platform_expected_semantic_fingerprint'",
  ) ||
  !platformMonotonicTimestampMigration.includes(
    'REVOKE ALL ON FUNCTION "platform"."refresh_current_semantic_fingerprint"(TEXT) FROM PUBLIC;',
  ) ||
  !platformMonotonicTimestampMigration.includes(
    'GRANT EXECUTE ON FUNCTION "platform"."refresh_current_semantic_fingerprint"(TEXT)',
  ) ||
  !platformMonotonicTimestampMigration.includes(
    "GRANT UPDATE (current_semantic_fingerprint, updated_at)",
  ) ||
  !platformMigration.includes(
    'CREATE FUNCTION "platform"."enforce_current_semantic_fingerprint"()',
  ) ||
  !platformMigration.includes("SECURITY INVOKER") ||
  platformMigration.includes("SECURITY DEFINER") ||
  (platformMigration.match(/CREATE CONSTRAINT TRIGGER/g) ?? []).length !== 6 ||
  (platformMigration.match(/DEFERRABLE INITIALLY DEFERRED/g) ?? []).length !== 6 ||
  platformSemanticGuardFunctionStart < 0 ||
  platformSemanticGuardFunctionEnd <= platformSemanticGuardFunctionStart ||
  !platformSemanticGuardFunction.includes("ERRCODE = '23514'") ||
  !platformSemanticGuardFunction.includes(
    "CONSTRAINT = 'platform_current_semantic_fingerprint_guard'",
  ) ||
  platformSemanticGuardTriggers.some(
    ([table, trigger]) =>
      !platformMigration.includes(
        `CREATE CONSTRAINT TRIGGER "${trigger}"\nAFTER INSERT OR UPDATE OR DELETE ON "platform"."${table}"\nDEFERRABLE INITIALLY DEFERRED\nFOR EACH ROW\nEXECUTE FUNCTION "platform"."enforce_current_semantic_fingerprint"();`,
      ),
  ) ||
  !platformSequence.includes(
    "SELECT platform.current_semantic_fingerprint() AS fingerprint",
  ) ||
  !platformSequence.includes(
    "SELECT platform.refresh_current_semantic_fingerprint(",
  ) ||
  platformImportedVerifyStart < 0 ||
  platformActiveVerifyStart <= platformImportedVerifyStart ||
  platformVerifyEnd <= platformActiveVerifyStart ||
  !platformImportedVerify.includes("readPlatformSemanticFingerprint(client)") ||
  !platformImportedVerify.includes(
    "state.identity.currentSemanticFingerprint",
  ) ||
  !platformActiveVerify.includes("readPlatformSemanticFingerprint(client)") ||
  !platformActiveVerify.includes("state.identity.currentSemanticFingerprint") ||
  platformMutationServices.some(
    (source) => !source.includes("refreshPlatformSemanticFingerprint(transaction)"),
  ) ||
  (platformCutoverTarget.match(
    /await refreshPlatformSemanticFingerprint\(transaction\)/g,
  ) ?? []).length !== 3 ||
  !platformDatabaseLifecycle.includes(
    "GRANT EXECUTE ON FUNCTION platform.current_semantic_fingerprint() TO winwidget_platform_runtime;",
  ) ||
  !platformDatabaseLifecycle.includes(
    "GRANT EXECUTE ON FUNCTION platform.refresh_current_semantic_fingerprint(TEXT) TO winwidget_platform_runtime;",
  ) ||
  !platformDatabaseLifecycle.includes(
    "REVOKE ALL ON FUNCTION platform.enforce_current_semantic_fingerprint() FROM PUBLIC, winwidget_platform_runtime;",
  ) ||
  !platformDatabaseLifecycle.includes(
    "GRANT UPDATE (current_semantic_fingerprint, updated_at)",
  ) ||
  !platformDatabaseLifecycle.includes("trigger_entry.tgenabled <> 'O'") ||
  !platformDatabaseLifecycle.includes("trigger_entry.tgisinternal") ||
  !platformDatabaseLifecycle.includes("constraint_entry.oid IS NULL") ||
  !platformDatabaseLifecycle.includes("trigger_entry.tgconstraint = 0") ||
  !platformDatabaseLifecycle.includes("trigger_entry.tgdeferrable") ||
  !platformDatabaseLifecycle.includes("trigger_entry.tginitdeferred") ||
  !platformDatabaseLifecycle.includes("constraint_entry.contype <> 't'") ||
  !platformDatabaseLifecycle.includes(
    "platform.enforce_current_semantic_fingerprint()'::regprocedure",
  ) ||
  !platformDatabaseLifecycle.includes("export PLATFORM_PARSE_URL") ||
  !platformDatabaseLifecycle.includes("--env PLATFORM_PARSE_URL") ||
  /^\s*--env "PLATFORM_PARSE_URL=\$value"/m.test(platformDatabaseLifecycle) ||
  !platformBackupRestoreRehearsal.includes(
    "platform_restore_assert_current_semantic_fingerprint_contract",
  ) ||
  !platformBackupRestoreRehearsal.includes(
    "platform_restore_assert_semantic_guard_catalog",
  ) ||
  !platformBackupRestoreRehearsal.includes("SET CONSTRAINTS ALL IMMEDIATE") ||
  !platformBackupRestoreRehearsal.includes("RETURNED_SQLSTATE") ||
  !platformBackupRestoreRehearsal.includes("CONSTRAINT_NAME") ||
  !platformBackupRestoreRehearsal.includes("actual_state <> '23514'") ||
  !platformBackupRestoreRehearsal.includes(
    "actual_constraint <> 'platform_current_semantic_fingerprint_guard'",
  ) ||
  !platformBackupRestoreRehearsal.includes(
    "rejected % partial probe left database drift",
  ) ||
  !platformBackupRestoreRehearsal.includes(
    "coherent % probe rollback left database drift",
  ) ||
  !platformBackupRestoreRehearsal.includes(
    "monotonic_transaction_start + interval '1 second'",
  ) ||
  !platformBackupRestoreRehearsal.includes(
    "Platform fingerprint refresh moved service identity timestamp backwards",
  ) ||
  !platformBackupRestoreRehearsal.includes(
    "rollback monotonic timestamp probe",
  ) ||
  !platformBackupRestoreRehearsal.includes(
    '"$migration_count" == 2',
  ) ||
  !platformBackupRestoreRehearsal.includes(
    "20260823010000_fix_service_identity_timestamp_monotonicity",
  ) ||
  !platformCutoverScript.includes("value.counts.migrations !== 2") ||
  !platformCutoverScript.includes(
    "20260823010000_fix_service_identity_timestamp_monotonicity",
  ) ||
  platformWorkflowRestoreStart < 0 ||
  platformWorkflowRestoreEnd <= platformWorkflowRestoreStart ||
  !platformWorkflowRestore.includes(
    "GRANT EXECUTE ON FUNCTION platform.current_semantic_fingerprint()",
  ) ||
  !platformWorkflowRestore.includes(
    "GRANT EXECUTE ON FUNCTION platform.refresh_current_semantic_fingerprint(TEXT)",
  ) ||
  !platformWorkflowRestore.includes(
    "REVOKE ALL ON FUNCTION platform.enforce_current_semantic_fingerprint()",
  ) ||
  !platformWorkflowRestore.includes(
    "GRANT UPDATE ON TABLE platform.site_settings, platform.home_page_content",
  ) ||
  !platformWorkflowRestore.includes("GRANT INSERT, UPDATE ON TABLE") ||
  !platformWorkflowRestore.includes("platform.legal_pages,") ||
  !platformWorkflowRestore.includes("platform.source_sequences,") ||
  !platformWorkflowRestore.includes("platform.outbox_events") ||
  !platformWorkflowRestore.includes(
    "GRANT UPDATE (current_aggregate_version, current_source_sequence, updated_at)",
  ) ||
  !platformWorkflowRestore.includes(
    "GRANT UPDATE (current_semantic_fingerprint, updated_at)",
  ) ||
  platformWorkflowRestore.includes(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_platform_runtime",
  ) ||
  platformWorkflowRestore.includes(
    "GRANT SELECT, INSERT, UPDATE, DELETE\n            ON ALL TABLES IN SCHEMA platform TO winwidget_platform_runtime",
  ) ||
  !platformWorkflowRestore.includes("DO $acl_contract$") ||
  !platformWorkflowRestore.includes("DO $guard_catalog$") ||
  !platformWorkflowRestore.includes("constraint_entry.oid IS NULL") ||
  !platformWorkflowRestore.includes("trigger_entry.tgconstraint = 0") ||
  !platformWorkflowRestore.includes("trigger_entry.tgdeferrable") ||
  !platformWorkflowRestore.includes("trigger_entry.tginitdeferred") ||
  !platformWorkflowRestore.includes("DO $guard_probe$") ||
  !platformWorkflowRestore.includes("DO $monotonic_timestamp$") ||
  !platformWorkflowRestore.includes(
    "transaction_started + interval '1 second'",
  ) ||
  !platformWorkflowRestore.includes(
    "Platform CI fingerprint refresh moved service identity timestamp backwards",
  ) ||
  !platformWorkflowRestore.includes("SET CONSTRAINTS ALL IMMEDIATE") ||
  !platformWorkflowRestore.includes("actual_state <> '23514'") ||
  !platformWorkflowRestore.includes(
    "actual_constraint <> 'platform_current_semantic_fingerprint_guard'",
  ) ||
  !platformWorkflowRestore.includes("INSERT INTO platform.outbox_events") ||
  !platformWorkflowRestore.includes("DELETE FROM platform.outbox_events") ||
  platformWorkflowRestore.includes(
    "INSERT INTO platform.source_sequences (id, next_value, updated_at) VALUES ('$sentinel_id', 42",
  ) ||
  !workflow.includes(
    "apps/platform/prisma/migrations/20260823010000_fix_service_identity_timestamp_monotonicity/migration.sql",
  )
) {
  throw new Error(
    "Platform current semantic fingerprint must stay distinct from the import fingerprint, refresh atomically on every known mutation, and be recomputed by verify",
  );
}
const billingOfferApplyStart = billingProjection.indexOf("async applyOffer(");
const billingOfferApplyEnd = billingProjection.indexOf(
  "\n\tprivate assertIdentityState(",
  billingOfferApplyStart,
);
const billingOfferApply = billingProjection.slice(
  billingOfferApplyStart,
  billingOfferApplyEnd,
);
const platformTargetActiveSwitch = platformCutoverScript.indexOf(
  'if [[ "$phase" == target-active ]]',
);
const platformConsumerV2Phase = platformCutoverScript.indexOf(
  'if [[ "$phase" == consumer-v2 ]]',
  platformTargetActiveSwitch,
);
const platformConsumerV2AdvanceCall = platformCutoverScript.indexOf(
  "platform_cutover_advance_consumer_v2",
  platformConsumerV2Phase,
);
const platformConsumerV2AdvanceStart = platformCutoverScript.indexOf(
  "\nplatform_cutover_advance_consumer_v2() {\n",
);
const platformConsumerV2AdvanceEnd = platformCutoverScript.indexOf(
  "\n}\n\nplatform_cutover_continue() {\n",
  platformConsumerV2AdvanceStart,
);
const platformConsumerV2Advance = platformCutoverScript.slice(
  platformConsumerV2AdvanceStart,
  platformConsumerV2AdvanceEnd,
);
const platformConsumerV2Verify = platformConsumerV2Advance.indexOf(
  "platform_cutover_verify_billing_offer_v2_boundary",
);
const platformCoreActivate = platformConsumerV2Advance.indexOf(
  "platform_cutover_cli core activate",
  platformConsumerV2Verify,
);
if (
  !platformCoreOwnershipMigration.startsWith(
    "BEGIN;\nSET LOCAL lock_timeout = '30s';\nSET LOCAL statement_timeout = '5min';\n\n",
  ) ||
  !platformCoreOwnershipMigration.trimEnd().endsWith("COMMIT;") ||
  (platformCoreOwnershipMigration.match(/^BEGIN;$/gm) ?? []).length !== 1 ||
  (platformCoreOwnershipMigration.match(/^COMMIT;$/gm) ?? []).length !== 1 ||
  (platformCoreOwnershipMigration.match(
    /^SET LOCAL lock_timeout = '30s';$/gm,
  ) ?? []).length !== 1 ||
  (platformCoreOwnershipMigration.match(
    /^SET LOCAL statement_timeout = '5min';$/gm,
  ) ?? []).length !== 1 ||
  !platformCoreOwnershipMigration.includes('"source_revision" TEXT') ||
  !platformCoreOwnershipMigration.includes(
    'CONSTRAINT "platform_core_state_export_anchor_check"',
  ) ||
  !platformCoreOwnershipMigration.includes(
    'CONSTRAINT "platform_core_state_offer_fence_check"',
  ) ||
  !platformCoreOwnershipMigration.includes(
    '"billing_offer_sequence_scope" = \'billing.offer:offer\'',
  ) ||
  !platformCutoverCore.includes("await handle.sync()") ||
  !platformCutoverCore.includes("await directoryHandle.sync()") ||
  !platformCutoverCore.includes(
    "activation arguments differ from durable database anchors",
  ) ||
  !platformCutoverCore.includes('"source_revision" = ${args.revision}') ||
  !platformCutoverCore.includes('"source_revision" = NULL') ||
  (platformCutoverCore.match(
    /AND "billing_offer_fence_fingerprint" = \$\{current\.billingOfferFenceFingerprint\}/g,
  ) ?? []).length !== 1 ||
  !/producerContractVersion\s+Int\?\s+@map\("producer_contract_version"\)/.test(
    platformSchema,
  ) ||
  !/sourceSequenceScope\s+String\?\s+@map\("source_sequence_scope"\)/.test(
    platformSchema,
  ) ||
  platformSchema.includes("producerHighWater") ||
  platformSchema.includes("sourceOfferSequence") ||
  !platformMigration.includes("'contractVersion', offer.\"producer_contract_version\"") ||
  !platformMigration.includes("'sequenceScope', offer.\"source_sequence_scope\"") ||
  platformMigration.includes("producer_high_water") ||
  platformMigration.includes("source_offer_sequence") ||
  !platformOfferContinuity.includes("billing.offer.changed.v2") ||
  !platformOfferContinuity.includes("sourceSequenceContractVersion") ||
  !platformOfferContinuity.includes("billing.offer:offer") ||
  !billingMessagingConstants.includes("winwidget.billing.offer.v2") ||
  billingMessagingConstants.includes("winwidget.billing.offer.v1") ||
  billingOfferApplyStart < 0 ||
  billingOfferApplyEnd <= billingOfferApplyStart ||
  billingOfferApply.includes("billingSourceSequence") ||
  !platformCutoverScript.includes("target-active:consumer-v2") ||
  !platformCutoverScript.includes("consumer-v2:core-active") ||
  platformCutoverScript.includes("target-active:core-active |") ||
  !platformCutoverScript.includes("winwidget.billing.offer.v2") ||
  !platformCutoverScript.includes("billing.offer.changed.v2") ||
  !platformCutoverScript.includes(
    "platform_cutover_billing_offer_v2_listing_is_exact",
  ) ||
  !platformCutoverScript.includes(
    "platform_cutover_billing_offer_v2_bindings_are_exact",
  ) ||
  !platformCutoverScript.includes("--if-empty --if-unused") ||
  !platformCutoverScript.includes(
    "platform_cutover_assert_billing_worker_candidate",
  ) ||
  platformTargetActiveSwitch < 0 ||
  platformConsumerV2Phase <= platformTargetActiveSwitch ||
  platformConsumerV2AdvanceCall <= platformConsumerV2Phase ||
  platformConsumerV2AdvanceStart < 0 ||
  platformConsumerV2AdvanceEnd <= platformConsumerV2AdvanceStart ||
  !platformConsumerV2Advance.includes(
    "platform_cutover_revalidate_phase consumer-v2",
  ) ||
  platformConsumerV2Verify < 0 ||
  platformCoreActivate <= platformConsumerV2Verify ||
  !platformConsumerV2Advance
    .slice(platformCoreActivate, platformCoreActivate + 500)
    .includes("--file /evidence/platform-snapshot.json") ||
  !platformConsumerV2Advance.includes(
    "platform_cutover_rewrite_phase core-active",
  ) ||
  !platformCutoverScript.includes("const exactFrozenCore =") ||
  !platformCutoverScript.includes("const exactActiveCore =") ||
  !platformCutoverScript.includes(
    'core.sourceRevision === process.env.REVISION',
  ) ||
  !platformCutoverScript.includes(
    'phase === "consumer-v2" && !exactFrozenCore && !exactActiveCore',
  ) ||
  !platformCutoverScript.includes(
    "platform_cutover_self_test_consumer_v2_crash_resume",
  ) ||
  !platformCutoverScript.includes("mode=partial") ||
  !platformCutoverScript.includes("mode=tampered")
) {
  throw new Error(
    "Platform Billing offer v2 must use an exact producer-scoped cursor while Core export anchors remain durable and fail-closed",
  );
}
const platformSlice = (startToken, endToken) => {
  const start = platformCutoverScript.indexOf(startToken);
  const end = platformCutoverScript.indexOf(endToken, start);
  return start >= 0 && end > start ? platformCutoverScript.slice(start, end) : "";
};
const platformDatabaseSlice = (startToken, endToken) => {
  const start = platformDatabaseLifecycle.indexOf(startToken);
  const end = platformDatabaseLifecycle.indexOf(endToken, start);
  return start >= 0 && end > start
    ? platformDatabaseLifecycle.slice(start, end)
    : "";
};
const platformDatabaseRuntimeStop = platformDatabaseSlice(
  "\nplatform_database_assert_pre_cutover_runtime_stopped() {\n",
  "\nplatform_database_prepare() {\n",
);
const platformDatabasePrepare = platformDatabaseSlice(
  "\nplatform_database_prepare() {\n",
  "\nplatform_database_advance() {\n",
);
const platformDatabaseStopCall = platformDatabasePrepare.indexOf(
  "platform_database_stop_pre_cutover_runtime",
);
const platformDatabaseBuild = platformDatabasePrepare.indexOf(
  "build --pull platform-api",
);
const platformDatabaseShadowValidation = platformDatabasePrepare.indexOf(
  "platform_database_validate_clean_shadow",
);
const platformDatabaseFinalRuntimeAssertion =
  platformDatabasePrepare.lastIndexOf(
    "platform_database_assert_pre_cutover_runtime_stopped",
  );
const platformDatabasePreparedMarker = platformDatabasePrepare.indexOf(
  "platform_database_write_marker prepared",
);
const platformDatabasePrepareCommands = platformDatabasePrepare.replace(
  /\\\n\s*/g,
  " ",
);
if (
  !platformDatabaseRuntimeStop.includes(
    "stop -t 90 platform-api platform-outbox-publisher",
  ) ||
  !platformDatabaseRuntimeStop.includes(
    "ps --status running -q platform-api platform-outbox-publisher",
  ) ||
  !platformDatabaseRuntimeStop.includes(
    "Platform runtime must remain stopped until ownership cutover has a durable marker.",
  ) ||
  platformDatabaseStopCall < 0 ||
  platformDatabaseBuild <= platformDatabaseStopCall ||
  platformDatabaseShadowValidation <= platformDatabaseBuild ||
  platformDatabaseFinalRuntimeAssertion <= platformDatabaseShadowValidation ||
  platformDatabasePreparedMarker <= platformDatabaseFinalRuntimeAssertion ||
  /\bup\b[^\n]*\bplatform-(?:api|outbox-publisher)\b/.test(
    platformDatabasePrepareCommands,
  ) ||
  platformDatabasePrepare.includes("http://127.0.0.1:5000/health/ready")
) {
  throw new Error(
    "Platform database prepare must stop crash leftovers before release mutation and seal prepared only while the pre-cutover runtime remains stopped",
  );
}
const platformCompleteNoop = platformSlice(
  "\nplatform_cutover_verify_complete_noop() {\n",
  "\nplatform_cutover_prepare_billing_readiness() {\n",
);
const platformBillingReadiness = platformSlice(
  "\nplatform_cutover_prepare_billing_readiness() {\n",
  "\nplatform_cutover_validate_final_env_and_attestation() {\n",
);
const platformFinalIdentity = platformSlice(
  "\nplatform_cutover_validate_final_env_and_attestation() {\n",
  "\nplatform_cutover_preflight_final_env_and_phase_a() {\n",
);
const platformPhaseAPreflight = platformSlice(
  "\nplatform_cutover_preflight_final_env_and_phase_a() {\n",
  "\nplatform_cutover_run_core_migration() {\n",
);
const platformCoreMigration = platformSlice(
  "\nplatform_cutover_run_core_migration() {\n",
  "\nplatform_cutover_prepare() {\n",
);
const platformPrepare = platformSlice(
  "\nplatform_cutover_prepare() {\n",
  "\nplatform_cutover_validate_restore_evidence() {\n",
);
const platformRestoreEvidenceValidator = platformSlice(
  "\nplatform_cutover_validate_restore_evidence() {\n",
  "\nplatform_cutover_run_restore() {\n",
);
const platformRestorePhaseA = platformSlice(
  "\nplatform_cutover_restore_phase_a_runtime() {\n",
  "\nplatform_cutover_abort() {\n",
);
const platformAbort = platformSlice(
  "\nplatform_cutover_abort() {\n",
  "\nplatform_cutover_status() {\n",
);
const platformIntegrationTopology = platformSlice(
  "\nplatform_cutover_assert_platform_admin_audit_topology() {\n",
  "\nplatform_cutover_assert_integration_worker_permissions() {\n",
);
const platformQueueDeleteHelper = platformSlice(
  "\nplatform_cutover_queue_presence_is_exact() {\n",
  "\nplatform_cutover_billing_offer_v2_listing_is_exact() {\n",
);
const platformBillingQueueDetailsValidator = platformSlice(
  "\nplatform_cutover_billing_offer_v2_queue_details_are_exact() {\n",
  "\nplatform_cutover_platform_admin_audit_queue_listing_is_exact() {\n",
);
const platformAdminQueueDetailsValidator = platformSlice(
  "\nplatform_cutover_platform_admin_audit_queue_details_are_exact() {\n",
  "\nplatform_cutover_assert_billing_worker_image() {\n",
);
const platformRetireBillingOfferV1 = platformSlice(
  "\nplatform_cutover_retire_billing_offer_v1() {\n",
  "\nplatform_cutover_verify_billing_offer_v2_boundary() {\n",
);
const platformIntegrationCandidate = platformSlice(
  "\nplatform_cutover_assert_integration_worker_candidate() {\n",
  "\nplatform_cutover_core_route_status() {\n",
);
const platformRetireSettingsProjection = platformSlice(
  "\nplatform_cutover_retire_settings_projection() {\n",
  "\nplatform_cutover_billing_offer_projection_matches() {\n",
);
const platformTargetActiveAdvance = platformSlice(
  "\nplatform_cutover_advance_target_active() {\n",
  "\nplatform_cutover_advance_consumer_v2() {\n",
);
const platformExpectedReleaseImageId = platformSlice(
  "\nplatform_cutover_expected_release_image_id() {\n",
  "\nplatform_cutover_finalize_phase_a_artifacts() {\n",
);
const platformReceiptValidator = platformSlice(
  "\nplatform_cutover_validate_billing_readiness_receipt_file() {\n",
  "\nplatform_cutover_write_billing_readiness_receipt() {\n",
);
const platformReceiptWriter = platformSlice(
  "\nplatform_cutover_write_billing_readiness_receipt() {\n",
  "\nplatform_cutover_query() {\n",
);
const platformPrepareOrder = [
  '[[ "$phase" != aborted ]]',
  "platform_database_require_inputs",
  "platform_cutover_preflight_final_env_and_phase_a",
  "platform_cutover_run_core_migration",
  "platform_database_prepare",
].map((token) => platformPrepare.indexOf(token));
const platformEvidenceInputs = [
  "platform_backend_env_expected_sha256",
  "platform_frontend_revision",
  "platform_frontend_runtime_challenge",
  "platform_frontend_origin",
  "platform_frontend_attestation_sha256",
  "platform_frontend_signature_sha256",
  "platform_frontend_trusted_public_key_sha256",
];
const platformReceiptFields = [
  "version",
  "phase",
  "revision",
  "generation",
  "phase_a_env_sha256",
  "phase_a_env_artifact_sha256",
  "phase_a_env_non_route_sha256",
  "phase_a_routes_sha256",
  "core_api_container_id",
  "core_api_image_id",
  "core_api_env_sha256",
  "billing_api_container_id",
  "billing_api_image_id",
  "billing_api_env_sha256",
  "gateway_container_id",
  "gateway_image_id",
  "gateway_non_route_env_sha256",
  "frontend_revision",
  "frontend_challenge",
  "frontend_origin_sha256",
  "trusted_public_key_sha256",
  "created_at",
];
const platformReceiptFieldGuard =
  `$1 !~ /^(${platformReceiptFields.join("|")})$/ { exit 1 }`;
if (
  !platformReceiptValidator.includes(
    "platform_cutover_validate_private_file \"$1\"",
  ) ||
  !platformReceiptValidator.includes(platformReceiptFieldGuard) ||
  !platformReceiptValidator.includes(`NR != ${platformReceiptFields.length}`) ||
  platformReceiptFields.some(
    field => !platformReceiptValidator.includes(`seen["${field}"] != 1`),
  ) ||
  !platformReceiptValidator.includes('value["version"] != "1"') ||
  !platformReceiptValidator.includes('value["phase"] != "phase-a"') ||
  !platformReceiptValidator.includes(
    'value["phase_a_env_artifact_sha256"] != value["phase_a_env_sha256"]',
  )
) {
  throw new Error(
    "Platform phase-A receipt validator must enforce the exact private 22-field runtime identity contract",
  );
}
for (const requiredReleaseImageResolverToken of [
  '[[ $# -eq 1 && "$1" =~ ^(core|billing|gateway)$ ]]',
  "core) key=core_api_image_id ;;",
  "billing) key=billing_api_image_id ;;",
  "gateway) key=gateway_image_id ;;",
  "platform_cutover_validate_billing_readiness_receipt || return 1",
  '[[ "$receipt_revision" == "$EXPECTED_REVISION" ]]',
  "platform_cutover_validate_archived_readiness_receipt || return 1",
  'platform_cutover_receipt_value_from_file "$archive" "$key"',
  "Active Platform cutover lost its immutable phase-A receipt.",
  "platform_cutover_validate_phase_a_intent || return 1",
  "Phase-A preparing intent belongs to another revision.",
  "Orphan phase-A env artifact has no durable intent or final receipt.",
  "platform_database_docker image inspect --format '{{.Id}}' \"$image\"",
]) {
  if (!platformExpectedReleaseImageId.includes(requiredReleaseImageResolverToken)) {
    throw new Error(
      `Platform release-image resolver lost an immutable identity guard: ${requiredReleaseImageResolverToken}`,
    );
  }
}
if (
  !platformCutoverScript.includes("--prepare-billing-readiness") ||
  platformCutoverScript.split("[[ $# -eq 1 ]]").length - 1 < 7 ||
  !platformCompleteNoop.includes("platform_cutover_revalidate_phase complete") ||
  !platformCompleteNoop.includes("platform_cutover_verify_runtime_and_routes") ||
  ["platform_cutover_write_marker", "platform_database_advance", "platform_release_compose"].some(
    (token) => platformCompleteNoop.includes(token),
  ) ||
  !platformBillingReadiness.includes("build --pull --provenance=false api billing-api api-gateway") ||
  !platformBillingReadiness.includes("up -d --no-deps --force-recreate api billing-api api-gateway") ||
  !platformBillingReadiness.includes("platform_cutover_validate_frontend_attestation 1") ||
  !platformBillingReadiness.includes("platform_cutover_install_phase_a_env_artifact") ||
  !platformBillingReadiness.includes("platform_cutover_write_billing_readiness_receipt") ||
  platformBillingReadiness.includes("platform_database_prepare") ||
  !platformFinalIdentity.includes("platform_cutover_require_expected_env_sha") ||
  !platformFinalIdentity.includes("platform_cutover_canonical_env_without_routes_sha256") ||
  !platformFinalIdentity.includes("platform_cutover_validate_exact_route_delta") ||
  !platformFinalIdentity.includes("platform_cutover_validate_frontend_attestation") ||
  !platformPhaseAPreflight.includes("platform_cutover_assert_phase_a_runtime_from_receipt") ||
  !platformPhaseAPreflight.includes("platform_cutover_verify_phase_a_gateway_routes") ||
  !platformCoreMigration.includes("assert_core_database_production_boundary") ||
  !platformCoreMigration.includes(
    'core_image_id="$(platform_cutover_expected_release_image_id core)"',
  ) ||
  !platformCoreMigration.includes(
    'platform_cutover_assert_release_image_id core "$core_image_id"',
  ) ||
  platformCoreMigration.includes("build --pull --provenance=false") ||
  !platformCoreMigration.includes("--profile migration run --rm --no-deps migrate") ||
  platformPrepare.includes("build --pull --provenance=false") ||
  platformPrepareOrder.some((position) => position < 0) ||
  platformPrepareOrder.some((position, index) => index > 0 && position <= platformPrepareOrder[index - 1]) ||
  !/--user 0:0\s*\\\s+--mount "type=bind,source=\$evidence,target=\/evidence\.json,readonly"/.test(
    platformRestoreEvidenceValidator,
  ) ||
  !platformReceiptValidator.includes("NR != 22") ||
  !platformReceiptValidator.includes("core_api_container_id") ||
  !platformReceiptValidator.includes("core_api_image_id") ||
  !platformReceiptValidator.includes("core_api_env_sha256") ||
  !platformReceiptValidator.includes("phase_a_env_artifact_sha256") ||
  !platformReceiptValidator.includes("gateway_non_route_env_sha256") ||
  !platformReceiptValidator.includes("trusted_public_key_sha256") ||
  !platformReceiptWriter.includes('ln -- "$temporary" "$platform_billing_readiness_receipt"') ||
  !platformReceiptWriter.includes('sync -f "$platform_billing_readiness_receipt"') ||
  !platformRestorePhaseA.includes("platform_cutover_restore_phase_a_env") ||
  !platformRestorePhaseA.includes("platform_cutover_assert_phase_a_runtime_from_receipt") ||
  platformRestorePhaseA.includes("--force-recreate") ||
  !platformRestorePhaseA.includes("platform_cutover_verify_phase_a_gateway_routes") ||
  !platformAbort.includes("platform_cutover_require_abort_env_sha") ||
  platformAbort.includes("platform_cutover_require_expected_env_sha") ||
  !platformCutoverScript.includes('current_sha" == "$PLATFORM_ENV_EXPECTED_SHA256" || "$current_sha" == "$phase_a_sha') ||
  platformAbort.indexOf("platform_cutover_restore_phase_a_runtime") < 0 ||
  platformAbort.indexOf("platform_cutover_rewrite_phase aborted") <
    platformAbort.indexOf("platform_cutover_restore_phase_a_runtime") ||
  !platformCutoverScript.includes('require("/app/dist/src/config.js")') ||
  !platformCutoverScript.includes('require("/app/dist/src/server.js")') ||
  !platformCutoverScript.includes("Phase-A removed Core content route is not an exact 404") ||
  !platformCutoverScript.includes("platform_cutover_self_test_guard_checkout_revision") ||
  !platformCutoverScript.includes("platform_cutover_self_test_unbound_dump_resume") ||
  !platformCutoverScript.includes("platform_cutover_self_test_target_active_crash_resume") ||
  !platformCutoverScript.includes("const resumableFencedPreparedCore =") ||
  !platformCutoverScript.includes("restore-verified:active") ||
  !platformCutoverScript.includes('"$expected" == pending || "$existing" == "$expected"') ||
  platformCutoverScript.includes("core_backup_sha256") ||
  platformCutoverScript.includes("core-frozen.dump") ||
  !platformCutoverScript.includes("NR != 15") ||
  !platformIntegrationTopology.includes('require("amqplib")') ||
  !platformIntegrationTopology.includes('queue = "winwidget.admin.audit.platform.v1"') ||
  !platformIntegrationTopology.includes('await channel.assertQueue(`${queue}.dead-letter`') ||
  !platformIntegrationTopology.includes('`${queue}.retry-v2.${index + 1}`') ||
  !platformIntegrationTopology.includes('deadLetterExchange: "winwidget.manual-retry"') ||
  !platformIntegrationTopology.includes("RABBITMQ_MANAGEMENT_URL") ||
  !platformIntegrationTopology.includes("AbortSignal.timeout(10_000)") ||
  !platformIntegrationTopology.includes("platform_cutover_platform_admin_audit_queue_details_are_exact") ||
  !platformIntegrationTopology.includes("platform_cutover_platform_admin_audit_queue_listing_is_exact") ||
  !platformIntegrationTopology.includes("platform_cutover_platform_admin_audit_bindings_are_exact") ||
  !platformIntegrationTopology.includes('"x-queue-type": "classic"') ||
  platformIntegrationTopology.includes('--env "RABBITMQ_ADMIN_PASSWORD=') ||
  !platformQueueDeleteHelper.includes("list_queues -p \"$vhost\" name") ||
  !platformQueueDeleteHelper.includes("$0 == queue { found += 1 }") ||
  (platformQueueDeleteHelper.match(/platform_cutover_queue_presence_is_exact/g) || []).length < 3 ||
  !platformQueueDeleteHelper.includes("delete_queue") ||
  !platformQueueDeleteHelper.includes("--if-empty --if-unused") ||
  !platformRetireBillingOfferV1.includes("platform_cutover_delete_queue_if_present") ||
  !platformRetireSettingsProjection.includes("while IFS=$' \\t' read -r queue _") ||
  !platformRetireSettingsProjection.includes("platform_cutover_delete_queue_if_present") ||
  !platformCutoverScript.includes("platform_cutover_self_test_delete_queue_if_present") ||
  !platformCutoverScript.includes("legacy_listing=$'winwidget.core.billing.settings.v1\\ttrue") ||
  (platformCutoverScript.match(/rabbitmqctl --silent list_permissions -p "\$vhost" \|/g) || []).length !== 2 ||
  (platformCutoverScript.match(/rabbitmqctl --silent list_topic_permissions -p "\$vhost" \|/g) || []).length !== 2 ||
  /list_permissions -p "\$vhost"\s*\\\s*user configure write read/.test(platformCutoverScript) ||
  /list_topic_permissions -p "\$vhost"\s*\\\s*user exchange write read/.test(platformCutoverScript) ||
  !platformBillingQueueDetailsValidator.includes("platform_cutover_assert_release_image_id billing \"$image\"") ||
  !platformAdminQueueDetailsValidator.includes("platform_cutover_assert_release_image_id core \"$image\"") ||
  ![platformBillingQueueDetailsValidator, platformAdminQueueDetailsValidator].every(
    (validator) =>
      validator.includes("platform_database_docker run --rm --pull never --network none --read-only") &&
      validator.includes("--cap-drop ALL --security-opt no-new-privileges --pids-limit 64") &&
      validator.includes('const classic = { "x-queue-type": "classic" };') &&
      !/\snode -e '/.test(validator),
  ) ||
  (platformCutoverScript.match(/delete rows\[0\]\.arguments\["x-queue-type"\]/g) || []).length !== 2 ||
  (platformCutoverScript.match(/rows\[0\]\.arguments\["x-queue-type"\] = "quorum"/g) || []).length !== 2 ||
  (billingRabbitMqService.match(/arguments: \{ 'x-queue-type': 'classic' \}/g) || []).length !== 3 ||
  platformIntegrationCandidate.indexOf("platform_cutover_assert_integration_worker_permissions") < 0 ||
  platformIntegrationCandidate.indexOf("platform_cutover_assert_platform_admin_audit_topology") <=
    platformIntegrationCandidate.indexOf("platform_cutover_assert_integration_worker_permissions") ||
  platformRetireSettingsProjection.indexOf("platform_cutover_provision_platform_admin_audit_topology") < 0 ||
  platformRetireSettingsProjection.indexOf("platform_cutover_provision_integration_worker_permissions") <=
    platformRetireSettingsProjection.indexOf("platform_cutover_provision_platform_admin_audit_topology") ||
  platformRetireSettingsProjection.indexOf("up -d --no-deps --force-recreate integration-worker") <=
    platformRetireSettingsProjection.indexOf("platform_cutover_provision_integration_worker_permissions") ||
  platformTargetActiveAdvance.indexOf("platform_cutover_retire_settings_projection hold-billing") < 0 ||
  platformTargetActiveAdvance.indexOf("platform_cutover_switch_billing_offer_consumer_v2") <=
    platformTargetActiveAdvance.indexOf("platform_cutover_retire_settings_projection hold-billing") ||
  platformTargetActiveAdvance.indexOf("platform_cutover_rewrite_phase consumer-v2") <=
    platformTargetActiveAdvance.indexOf("platform_cutover_switch_billing_offer_consumer_v2") ||
  /(^|[^A-Za-z_])docker\s+(?:run|exec|inspect|image|volume|port|ps)\b/m.test(platformCutoverScript) ||
  stageOrDeployRemoteScript.includes("stage_platform_core_migration") ||
  !stageOrDeployRemoteScript.includes("bash scripts/platform-cutover-production.sh --prepare-billing-readiness") ||
  !stageOrDeployRemoteScript.includes("bash scripts/platform-cutover-production.sh --prepare") ||
  !stageOrDeployRemoteScript.includes("PLATFORM_ENV_EXPECTED_SHA256=\"$PLATFORM_ENV_EXPECTED_SHA256\"") ||
  !stageOrDeployScript.includes("PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256") ||
  !workflow.includes("- prepare-billing-readiness") ||
  platformEvidenceInputs.some((input) => !workflow.includes(`${input}:`)) ||
  !workflow.includes("scripts/platform-frontend-runtime-attestation.sh --self-test") ||
  !platformFrontendAttestationScript.includes("platform_frontend_attestation_validate") ||
  !platformFrontendAttestationScript.includes("localPaymentHtmlSha256") ||
  !platformFrontendAttestationScript.includes("publicPaymentHtmlSha256") ||
  !platformFrontendAttestationScript.includes("paymentExecutableGraphSha256") ||
  !stageOrDeployRemoteScript.includes(
    "Automatic/all deployment is blocked until Platform ownership is exactly complete.",
  ) ||
  stageOrDeployRemoteScript.includes('"$platform_phase" =~ ^(complete|aborted)$')
) {
  throw new Error(
    "Platform phase-A must be manual, attested, revision/env/runtime-bound, mutation-ordered, abort-restorable, and fail closed until ownership is complete",
  );
}
const deployProductionSlice = (startToken, endToken) => {
  const start = deployProductionScript.indexOf(startToken);
  const end = deployProductionScript.indexOf(endToken, start);
  return start >= 0 && end > start
    ? deployProductionScript.slice(start, end)
    : "";
};
const routineBillingTopicPermissions = deployProductionSlice(
  "\nprovision_billing_rabbitmq_topic_permissions() {\n",
  "\nprovision_identity_rabbitmq_topic_permissions() {\n",
);
const routineBillingQueueAcl = deployProductionSlice(
  '\nprovision_rabbitmq_user \\\n\t"$billing_worker_user" \\\n',
  "\nprovision_billing_rabbitmq_topic_permissions \\\n",
);
const routineBillingConsumers = deployProductionSlice(
  "\nverify_billing_rabbitmq_consumers() {\n",
  "\ncompose_target up -d --no-deps --force-recreate \\\n\tbilling-api",
);
const routineBillingConsumerSourcesStart = routineBillingConsumers.indexOf(
  "const source = [",
);
const routineBillingConsumerSourcesEnd = routineBillingConsumers.indexOf(
  "\n];",
  routineBillingConsumerSourcesStart,
);
const routineBillingConsumerSources = routineBillingConsumers.slice(
  routineBillingConsumerSourcesStart,
  routineBillingConsumerSourcesEnd,
);
if (
  !routineBillingTopicPermissions ||
  !routineBillingQueueAcl ||
  !routineBillingConsumers ||
  routineBillingTopicPermissions.includes(
    "billing\\.settings\\.source\\.changed\\.v1",
  ) ||
  routineBillingQueueAcl.includes("settings-source") ||
  workflow.includes("settings-source") ||
  workflow.includes("billing\\.settings\\.source\\.changed\\.v1") ||
  workflow.includes("billing\\.offer\\.changed\\.v1") ||
  !workflow.includes("billing\\.offer\\.v2") ||
  !workflow.includes("billing\\.offer\\.changed\\.v2") ||
  routineBillingConsumerSourcesStart < 0 ||
  routineBillingConsumerSourcesEnd <= routineBillingConsumerSourcesStart ||
  routineBillingConsumerSources.includes("settings-source") ||
  !routineBillingConsumers.includes(
    'const retired = "winwidget.billing.settings-source.v1";',
  ) ||
  !routineBillingConsumers.includes(
    'if (queues.has(`${retired}${suffix}`)) process.exit(1);',
  ) ||
  (routineBillingConsumers.match(/winwidget\.billing\.settings-source\.v1/g) ?? [])
    .length !== 1 ||
  (deployProductionScript.match(/winwidget\.billing\.settings-source\.v1/g) ?? [])
    .length !== 3 ||
  deployProductionScript.split("billing.settings.source.changed.v1").length - 1 !==
    1
) {
  throw new Error(
    "Routine Billing RabbitMQ ACL and consumer topology must reject the retired settings-source route and entire queue family",
  );
}
const platformRoutineLock = deployPlatformProductionScript.indexOf(
  "acquire_production_deploy_lock 'routine Platform deployment'",
);
const platformRoutineBuild = deployPlatformProductionScript.indexOf(
  "build --pull --provenance=false platform-api",
  platformRoutineLock,
);
const platformRequireActiveStart = deployPlatformProductionScript.indexOf(
  "\nplatform_deploy_require_active() {\n",
);
const platformRequireActiveEnd = deployPlatformProductionScript.indexOf(
  "\nplatform_deploy_validate_gateway_manifest() {\n",
  platformRequireActiveStart,
);
const platformRequireActive = deployPlatformProductionScript.slice(
  platformRequireActiveStart,
  platformRequireActiveEnd,
);
const platformInternalSmokeStart = deployPlatformProductionScript.indexOf(
  "\nplatform_deploy_assert_internal_overview() {\n",
);
const platformInternalSmokeEnd = deployPlatformProductionScript.indexOf(
  "\nplatform_deploy_verify_steady_boundaries() {\n",
  platformInternalSmokeStart,
);
const platformInternalSmoke = deployPlatformProductionScript.slice(
  platformInternalSmokeStart,
  platformInternalSmokeEnd,
);
const platformRoutineRecreate = deployPlatformProductionScript.indexOf(
  "up -d --no-deps --force-recreate platform-api platform-outbox-publisher",
  platformRoutineBuild,
);
const platformInternalSmokeCall = deployPlatformProductionScript.indexOf(
  "\n\tplatform_deploy_assert_internal_overview\n",
  platformRoutineRecreate,
);
if (
  platformRoutineLock < 0 ||
  platformRoutineBuild <= platformRoutineLock ||
  platformRequireActiveStart < 0 ||
  platformRequireActiveEnd <= platformRequireActiveStart ||
  !platformRequireActive.includes("platform_database_require_inputs || return 1") ||
  platformRequireActive.includes("core_backup_sha256") ||
  platformInternalSmokeStart < 0 ||
  platformInternalSmokeEnd <= platformInternalSmokeStart ||
  platformRoutineRecreate <= platformRoutineBuild ||
  platformInternalSmokeCall <= platformRoutineRecreate ||
  !platformInternalSmoke.includes(
    'platform_database_docker exec "$api_container" node -e',
  ) ||
  !platformInternalSmoke.includes("process.env.PLATFORM_CORE_TOKEN") ||
  !platformInternalSmoke.includes(
    "/internal/v1/platform/messaging/overview",
  ) ||
  !platformInternalSmoke.includes('"x-winwidget-service": "core"') ||
  !platformInternalSmoke.includes('"x-winwidget-internal-token": token') ||
  !platformInternalSmoke.includes("body?.schemaVersion !== 1") ||
  !platformInternalSmoke.includes("Math.abs(Date.now() - generatedAt) > 30000") ||
  !platformInternalSmoke.includes('item.status !== "ok"') ||
  !platformInternalSmoke.includes("item.revision !== expectedRevision") ||
  platformInternalSmoke.includes("platform_read_env_value") ||
  platformInternalSmoke.includes("console.log") ||
  !deployPlatformProductionScript.includes(
    "platform_database_assert_marker_identity",
  ) ||
  !deployPlatformProductionScript.includes(
    "Running Gateway route manifest differs from the reviewed production env.",
  ) ||
  !deployPlatformProductionScript.includes(
    "platform_deploy_assert_runtime platform-api",
  ) ||
  !deployPlatformProductionScript.includes(
    "platform_deploy_assert_runtime platform-outbox-publisher",
  ) ||
  !deployPlatformProductionScript.includes(
    "platform_cutover_assert_integration_worker_permissions",
  ) ||
  deployPlatformProductionScript.includes(
    "platform_cutover_validate_gateway_manifest",
  )
) {
  throw new Error(
    "Routine Platform deploy must validate the full env before mutation, bind current runtime, database, and Gateway identities, and prove the authenticated Core to Platform overview after recreate",
  );
}
for (const exactPlatformExampleLine of [
  "PLATFORM_CORE_TOKEN=change_me_platform_core_token_at_least_32_chars",
  "PLATFORM_OUTBOX_RETENTION_DAYS=7",
]) {
  if (platformEnvExample.split(exactPlatformExampleLine).length - 1 !== 1) {
    throw new Error(
      `Platform service env example is missing an exact safe placeholder: ${exactPlatformExampleLine}`,
    );
  }
}
if (
  !identityEnvControlScript.includes(
    "const optionalScopedKeys = ['PLATFORM_CORE_TOKEN'].filter(key => values.has(key));",
  ) ||
  !identityEnvControlScript.includes("...optionalScopedKeys") ||
  !identityEnvControlScript.includes("/^(change[_-]me|ci_)/") ||
  !identityCutoverScript.includes(
    'if [[ "$platform_core_token_count" != 0 ]]; then',
  ) ||
  !identityCutoverScript.includes(
    "Identity credential contract found duplicate PLATFORM_CORE_TOKEN keys",
  ) ||
  !identityCutoverScript.includes(
    "Identity credential contract failed for PLATFORM_CORE_TOKEN",
  )
) {
  throw new Error(
    "Standalone Identity token validators must accept pre-Platform envs but fail closed when PLATFORM_CORE_TOKEN is present",
  );
}
const allDeployStart = stageOrDeployRemoteScript.indexOf(
  '\n  all)\n',
);
const coordinatedCoreDeploy = stageOrDeployRemoteScript.indexOf(
  "bash scripts/deploy-production.sh",
  allDeployStart,
);
const coordinatedPlatformDeploy = stageOrDeployRemoteScript.indexOf(
  "bash scripts/deploy-platform-production.sh --deploy",
  coordinatedCoreDeploy,
);
const allDeployEnd = stageOrDeployRemoteScript.indexOf(
  "\n    exit 0",
  coordinatedPlatformDeploy,
);
if (
  allDeployStart < 0 ||
  coordinatedCoreDeploy <= allDeployStart ||
  coordinatedPlatformDeploy <= coordinatedCoreDeploy ||
  allDeployEnd <= coordinatedPlatformDeploy
) {
  throw new Error(
    "The coordinated all deploy must run the guarded Core deployment before the standalone routine Platform deployment",
  );
}
const platformFullGate = deployProductionScript.indexOf(
  "Full deployment is blocked until Platform routes and both lifecycles are exactly complete:",
);
const firstFullBuild = deployProductionScript.indexOf(
  "compose_target build --provenance=false",
  platformFullGate,
);
const platformFullEvidenceStart = deployProductionScript.indexOf(
  "for platform_evidence_key in snapshot_sha256 source_fingerprint",
  platformFullGate,
);
const platformFullEvidenceEnd = deployProductionScript.indexOf(
  '[[ "$(platform_cutover_marker_value source_high_watermark)"',
  platformFullEvidenceStart,
);
const platformFullEvidence = deployProductionScript.slice(
  platformFullEvidenceStart,
  platformFullEvidenceEnd,
);
if (
  platformFullGate < 0 ||
  firstFullBuild <= platformFullGate ||
  platformFullEvidenceStart <= platformFullGate ||
  platformFullEvidenceEnd <= platformFullEvidenceStart ||
  !deployProductionScript.includes(
    "platform_database_assert_marker_identity",
  ) ||
  platformFullEvidence.includes("core_backup_sha256") ||
  !/assert_database_restore_admin_secret_file\s+\\\s+PLATFORM_POSTGRES_ADMIN_PASSWORD_FILE\s+\\\s+"\$APP_ROOT\/deploy\/backend\/\.platform-postgres-admin-password"/.test(
    deployProductionScript,
  ) ||
  !deployProductionScript.includes("PLATFORM_GATEWAY_POLICY=platform")
) {
  throw new Error(
    "Full deployment must fail closed on Platform lifecycle and route state before its first build",
  );
}
const identityRecoveryPreflightStart = workflow.indexOf(
  "\n  lifecycle_checkout_preflight:\n",
);
const identityRecoveryVerifyStart = workflow.indexOf(
  "\n  verify:\n",
  identityRecoveryPreflightStart,
);
const identityRecoveryPreflight = workflow.slice(
  identityRecoveryPreflightStart,
  identityRecoveryVerifyStart,
);
if (
  identityRecoveryPreflightStart < 0 ||
  identityRecoveryVerifyStart <= identityRecoveryPreflightStart ||
  (workflow.match(/scripts\/test-identity-production-env-recovery\.sh/g) ?? [])
    .length !== 3 ||
  identityRecoveryPreflight
    .split("\n")
    .map((line) => line.trim())
    .filter(
    (line) => line === "bash scripts/test-identity-production-env-recovery.sh",
    ).length !== 1 ||
  workflow
    .slice(identityRecoveryVerifyStart)
    .split("\n")
    .map((line) => line.trim())
    .includes("bash scripts/test-identity-production-env-recovery.sh") ||
  staticWorkflowLines.filter(
    (line) => line === "scripts/test-identity-production-env-recovery.sh \\",
  ).length !== 1 ||
  !identityEnvRecoveryTest.startsWith(
    "#!/usr/bin/env bash\nset -Eeuo pipefail\numask 077\n",
  ) ||
  identityEnvRecoveryTest.includes("identity_env_assert_candidate() {")
) {
  throw new Error(
    "Identity env recovery behavior test must be required, syntax-checked, shellchecked, and run exactly once before verify",
  );
}
if (
  !deployProductionScript.includes(
    'source "$server_root/scripts/identity-production-env-control.sh"',
  ) ||
  !deployProductionScript.includes(
    'identity_env_node_validate "$ENV_FILE" <<\'NODE\'',
  ) ||
  /IDENTITY_JWKS_URL=.*\n[\s\S]{0,200}node -e/.test(deployProductionScript) ||
  /identity_read_env_value "\$ENV_FILE" GATEWAY_ROUTES_JSON \|/.test(
    deployProductionScript,
  )
) {
  throw new Error(
    "Full deployment must validate Identity routes with the pinned Docker-only Node runtime",
  );
}
for (const requiredIdentityRotationContract of [
  "readonly identity_rotation_confirmation='ROTATE IDENTITY JWT SIGNING KEY'",
  "identity_rotation_write_current_marker_phase forward-only",
  "identity_rotation_write_current_marker_phase complete",
  "generateKeyPairSync('rsa', { modulusLength: 3072",
  "JSON.stringify({ keys: [publicJwk] })",
  'mv -f -- "$identity_rotation_candidate" "$ENV_FILE"',
  "acquire_production_deploy_lock 'Identity JWT signing-key rotation'",
  "up -d --no-deps --no-build --force-recreate identity-api",
  "up -d --no-deps --no-build --force-recreate api-gateway",
  "--max-filesize 65536",
  "{{.Config.Image}}",
  '"winwidget-identity:git-$EXPECTED_REVISION" identity winwidget-identity',
  '"winwidget-api-gateway:git-$EXPECTED_REVISION" node',
  '-H "@$identity_rotation_new_header"',
  '-H "@$identity_rotation_old_header"',
  "identity_rotation_archive_complete_marker",
  "--rotate) identity_rotation_run",
  "--forward-recovery) identity_rotation_forward_recovery",
]) {
  if (!identityJwtRotationScript.includes(requiredIdentityRotationContract)) {
    throw new Error(
      `Identity JWT rotation contract is missing: ${requiredIdentityRotationContract}`,
    );
  }
}
for (const forbiddenIdentityRotationContract of [
  "set -x",
  "JWT_ACCESS_PRIVATE_KEY_BASE64=%s",
  "IDENTITY_JWT_ACCESS_PRIVATE_KEY_BASE64=%s",
  "--env-file \"$ENV_FILE\" --entrypoint node",
]) {
  if (identityJwtRotationScript.includes(forbiddenIdentityRotationContract)) {
    throw new Error(
      `Identity JWT rotation exposes or broadly injects signing material: ${forbiddenIdentityRotationContract}`,
    );
  }
}
for (const requiredIdentityRotationWorkflowContract of [
  "          - rotate-jwt\n",
  "          - rotate-jwt-forward-recovery\n",
  "rotate-jwt:'ROTATE IDENTITY JWT SIGNING KEY'|rotate-jwt-forward-recovery:'ROTATE IDENTITY JWT SIGNING KEY'",
  "bash scripts/rotate-identity-jwt-production.sh --rotate",
  "bash scripts/rotate-identity-jwt-production.sh --forward-recovery",
]) {
  if (!workflow.includes(requiredIdentityRotationWorkflowContract) &&
      !stageOrDeployScript.includes(requiredIdentityRotationWorkflowContract)) {
    throw new Error(
      `Identity JWT rotation workflow contract is missing: ${requiredIdentityRotationWorkflowContract}`,
    );
  }
}
const identityNodeRuntimeStart = identityEnvControlScript.indexOf(
  "\nidentity_env_host_node_available() {\n",
);
const identityNodeRuntimeEnd = identityEnvControlScript.indexOf(
  "\nidentity_env_sha256() {\n",
  identityNodeRuntimeStart,
);
const identityNodeRuntime = identityEnvControlScript.slice(
  identityNodeRuntimeStart,
  identityNodeRuntimeEnd,
);
const identityNodeForwardedEnvContract =
  "for env_name in IDENTITY_EXPECTED_REVISION IDENTITY_EXPECTED_POSTGRES_IMAGE \\\n" +
  "\t\tIDENTITY_EXPECTED_INTEGRATION_KINDS IDENTITY_EXPECTED_ADMIN_FILE; do";
for (const requiredIdentityNodeContract of [
  "com.docker.compose.project=winwidget",
  "com.docker.compose.service=maintenance-worker",
  "com.docker.compose.oneoff=False",
  "unix:///var/run/docker.sock",
  "git -C \"$2\" merge-base --is-ancestor \"$1\" \"$EXPECTED_REVISION\"",
  `"$status" == 'running'`,
  `"$running" == 'true'`,
  `"$health" == 'healthy'`,
  `"$restart_count" == '0'`,
  `"$image_id" == "$image"`,
  `"$app_revision" == "$image_revision"`,
  `"$image_user" == 'nestjs'`,
  'identity_env_node_revision_is_allowed "$image_revision" "$source_root" || return 1',
  "run --rm --interactive --pull never --network none --read-only",
  "--cap-drop ALL --pids-limit 64 --cpus 1 --memory 512m",
  "--memory-swap 512m --log-driver none --user 0:0",
  "--security-opt no-new-privileges --entrypoint node",
  "target=/tmp/identity-env-source,readonly",
  "target=/tmp/identity-env-candidate",
  identityNodeForwardedEnvContract,
]) {
  if (!identityNodeRuntime.includes(requiredIdentityNodeContract)) {
    throw new Error(
      `Identity env Docker-only Node runtime contract is missing: ${requiredIdentityNodeContract}`,
    );
  }
}
if (
  identityNodeRuntimeStart < 0 ||
  identityNodeRuntimeEnd <= identityNodeRuntimeStart ||
  (identityEnvControlScript.match(
    /identity_env_node_validate "\$ENV_FILE" <<'NODE'/g,
  ) ?? []).length !== 1 ||
  (identityEnvControlScript.match(
    /identity_env_node_generate "\$ENV_FILE" "\$identity_env_bootstrap_candidate_temporary" <<'NODE'/g,
  ) ?? []).length !== 1 ||
  (identityNodeRuntime.match(/--mount/g) ?? []).length !== 2 ||
  (identityNodeRuntime.match(/docker_args\+=\(--env "\$env_name"\)/g) ?? [])
    .length !== 1 ||
  (identityNodeRuntime.match(/run --rm/g) ?? []).length !== 1 ||
  /(^|\n)[\t ]*(command )?node - "\$ENV_FILE"/.test(
    identityEnvControlScript,
  ) ||
  !identityEnvControlScript.includes(
    "constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW",
  ) ||
  !identityEnvControlScript.includes(
    ': >"$identity_env_bootstrap_candidate_temporary"',
  ) ||
  identityNodeRuntime.includes("docker exec") ||
  identityNodeRuntime.includes("--env-file") ||
  identityNodeRuntime.includes("--volume") ||
  identityNodeRuntime.includes("--network host") ||
  identityNodeRuntime.includes("/var/run/docker.sock,target=") ||
  identityNodeRuntime.includes("source=$APP_ROOT/deploy/backend,target=") ||
  !identityEnvRecoveryTest.includes(
    "run_docker_node_fallback_contract() (",
  ) ||
  !identityEnvRecoveryTest.includes(
    "container-revision wrong-user image-revision image-id-mismatch",
  ) ||
  !identityEnvRecoveryTest.includes("untrusted-revision") ||
  !identityEnvRecoveryTest.includes(
    '[[ "$identity_revision_check_calls" == \'2\' ]]',
  ) ||
  !identityEnvRecoveryTest.includes("IDENTITY_NODE_FAKE_CASE='run-failure'")
) {
  throw new Error(
    "Identity env candidate validation and generation must use the isolated immutable maintenance-worker Node runtime",
  );
}
for (const requiredControllerContract of [
  'deploy_ssh_key_path="${DEPLOY_SSH_KEY_PATH:-$HOME/.ssh/deploy_key}"',
  'deploy_ssh_known_hosts_path="${DEPLOY_SSH_KNOWN_HOSTS_PATH:-$HOME/.ssh/known_hosts}"',
  'remote_controller_source=".github/scripts/stage-or-deploy-backend-remote.sh"',
  'git rev-parse --verify "$DEPLOY_REVISION:$remote_controller_source"',
  '[[ "$(git hash-object "$remote_controller_source")" == "$remote_controller_blob" ]]',
  'scp "${scp_options[@]}" \\',
  'remote_controller_sha256="$(',
  "Staged backend remote deployment controller failed verification.",
  'APP_ROOT=\'$APP_ROOT\' AUTOMATIC_PROD_PUSH=\'$AUTOMATIC_PROD_PUSH\'',
  '  -F /dev/null',
  '  -o BatchMode=yes',
  '  -o StrictHostKeyChecking=yes',
  '  -o GlobalKnownHostsFile=/dev/null',
  '  -o "UserKnownHostsFile=$deploy_ssh_known_hosts_path"',
  '  -o ConnectTimeout=15',
  '[[ "$IDENTITY_ENV_EXPORT_ID" =~ ^[0-9]{1,20}-[0-9]{1,10}$ ]]',
  '      recover-candidate-env)\n        APP_ROOT="$APP_ROOT" EXPECTED_REVISION="$EXPECTED_REVISION" \\',
  "rollback-env-bootstrap:'ROLLBACK INCOMPLETE IDENTITY ENV BOOTSTRAP'",
  'bash scripts/identity-production-env-control.sh --rollback-incomplete-bootstrap',
  'bash scripts/identity-production-env-control.sh --export-candidate-encrypted',
]) {
  if (!stageOrDeployScript.includes(requiredControllerContract)) {
    throw new Error(
      `Stage/deploy controller is missing resumable Identity env export contract: ${requiredControllerContract}`,
    );
  }
}
if (
  stageOrDeployScript.includes("ssh -i ~/.ssh/deploy_key") ||
  stageOrDeployLocalScript.includes("bash -s") ||
  stageOrDeployLocalScript.includes("<<'EOF'")
) {
  throw new Error("Stage/deploy controller bypasses the explicit SSH key path");
}
const identityControllerStart = stageOrDeployScript.indexOf("\n  identity)\n");
const identityControllerEnd = stageOrDeployScript.indexOf(
  "\n  identity-cleanup)\n",
  identityControllerStart,
);
const identityController = stageOrDeployScript.slice(
  identityControllerStart,
  identityControllerEnd,
);
const noCheckoutExportIndex = identityController.indexOf(
  'if [[ "$IDENTITY_ACTION" =~ ^(recover-candidate-env|rollback-env-bootstrap)$ ]]',
);
const noCheckoutElseIndex = identityController.indexOf(
  '\n    else\n      checkout_verified_prod_revision "$EXPECTED_REVISION"\n    fi',
  noCheckoutExportIndex,
);
const identityCheckoutIndex = identityController.indexOf(
  'checkout_verified_prod_revision "$EXPECTED_REVISION"',
);
const identityActionCaseIndex = identityController.indexOf(
  'case "$IDENTITY_ACTION" in',
);
if (
  identityControllerStart < 0 ||
  identityControllerEnd <= identityControllerStart ||
  noCheckoutExportIndex < 0 ||
  noCheckoutElseIndex <= noCheckoutExportIndex ||
  identityCheckoutIndex <= noCheckoutExportIndex ||
  identityCheckoutIndex <= noCheckoutElseIndex ||
  identityActionCaseIndex <= identityCheckoutIndex
) {
  throw new Error(
    "Identity env export recovery must verify the current checkout without moving it",
  );
}
const noCheckoutRecoveryArm = identityController.slice(
  noCheckoutExportIndex,
  noCheckoutElseIndex,
);
const allowedRecoveryGitContracts = [
  'git rev-parse HEAD',
  'git rev-parse --verify "HEAD:$env_control_script"',
  'git hash-object "$env_control_script"',
];
if (
  (noCheckoutRecoveryArm.match(/\bgit\s+/g) ?? []).length !==
    allowedRecoveryGitContracts.length ||
  allowedRecoveryGitContracts.some(
    (contract) => !noCheckoutRecoveryArm.includes(contract),
  )
) {
  throw new Error(
    "Identity env recovery may use only the exact read-only Git inspection commands",
  );
}
for (const forbiddenRecoveryMutation of [
  "checkout_verified_prod_revision",
  "git fetch",
  "git checkout",
  "git merge",
]) {
  if (noCheckoutRecoveryArm.includes(forbiddenRecoveryMutation)) {
    throw new Error(
      `Identity env recovery performs a checkout mutation: ${forbiddenRecoveryMutation}`,
    );
  }
}
for (const internalIdentityAction of [
  "recover-candidate-env",
  "rollback-env-bootstrap",
]) {
  if (workflow.includes(internalIdentityAction)) {
    throw new Error(
      `Internal Identity recovery action is exposed by workflow_dispatch: ${internalIdentityAction}`,
    );
  }
}
const productionEnvExample = readFileSync(".env.example", "utf8");
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
if (workflowDispatchInputNames.length > 25) {
  throw new Error(
    `workflow_dispatch exceeds GitHub's 25 top-level input limit: ${workflowDispatchInputNames.length}`,
  );
}
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
  "platform_action",
  "platform_confirmation",
  "platform_backend_env_expected_sha256",
  "platform_frontend_revision",
  "platform_frontend_runtime_challenge",
  "platform_frontend_origin",
  "platform_frontend_attestation_sha256",
  "platform_frontend_signature_sha256",
  "platform_frontend_trusted_public_key_sha256",
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
const expectedActionlintImage = [
  "rhysd/actionlint",
  "sha256:ef8299f97635c4c30e2298f48f30763ab782a4ad2c95b744649439a039421e36",
].join("@");
const pinnedActionlintImages =
  workflowContract.match(/rhysd\/actionlint@sha256:[0-9a-f]{64}/g) || [];
if (
  pinnedActionlintImages.length !== 3 ||
  pinnedActionlintImages.some(image => image !== expectedActionlintImage)
) {
  throw new Error(
    `Expected exactly three actionlint 1.7.10 image pins, got: ${pinnedActionlintImages.join(",")}`,
  );
}
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
requireCount("apps/identity/pnpm-lock.yaml", 2);
requireCount("pnpm --dir apps/identity install --frozen-lockfile", 1);
requireCount('process.stdout.write(`::add-mask::${value}\\n`);', 2);
requireCount(
  "'JWT_JWKS_URL=http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json\\n',",
  1,
);
requireCount(
  "'JWT_JWKS_URL=http://127.0.0.1:4200/api/v1/auth/.well-known/jwks.json\\n',",
  0,
);
const identityScopedTokenStep = workflow.indexOf(
  "      - name: Generate CI-only Identity scoped tokens\n",
);
const firstProductionRecoveryCheck = workflow.indexOf(
  "      - name: Fast-check Campaigns production recovery\n",
  identityScopedTokenStep,
);
if (
  identityScopedTokenStep < 0 ||
  firstProductionRecoveryCheck <= identityScopedTokenStep
) {
  throw new Error("CI-only Identity scoped token step is missing or misplaced");
}
const identityScopedTokenBlock = workflow.slice(
  identityScopedTokenStep,
  firstProductionRecoveryCheck,
);
const exactIdentityScopedTokenNames = `          identity_scoped_token_names=(
            IDENTITY_CORE_TOKEN
            CORE_IDENTITY_TOKEN
            IDENTITY_CAMPAIGNS_TOKEN
            IDENTITY_REPORTING_TOKEN
            IDENTITY_WIDGETS_TOKEN
            WIDGETS_IDENTITY_TOKEN
            IDENTITY_BILLING_TOKEN
            IDENTITY_PLATFORM_TOKEN
            BILLING_IDENTITY_TOKEN
          )`;
if (!identityScopedTokenBlock.includes(exactIdentityScopedTokenNames)) {
  throw new Error("CI-only Identity scoped token name set is not exact");
}
const identityScopedTokenOrder = [
  'declare -A identity_scoped_token_values=()',
  'for name in "${identity_scoped_token_names[@]}"; do',
  'value="$(openssl rand -hex 32)"',
  'if [[ -n "${identity_scoped_token_values[$value]:-}" ]]; then',
  'identity_scoped_token_values["$value"]=1',
  'echo "::add-mask::$value"',
  `printf '%s=%s\\n' "$name" "$value" >> "$GITHUB_ENV"`,
  "done",
];
let previousIdentityScopedTokenIndex = -1;
for (const sourceLine of identityScopedTokenOrder) {
  const sourceIndex = identityScopedTokenBlock.indexOf(sourceLine);
  if (sourceIndex <= previousIdentityScopedTokenIndex) {
    throw new Error(
      `Generated CI Identity scoped token boundary is missing or reordered: ${sourceLine}`,
    );
  }
  previousIdentityScopedTokenIndex = sourceIndex;
}
const platformCoreTokenStep = workflow.indexOf(
  "      - name: Generate CI-only Platform Core token\n",
  identityScopedTokenStep,
);
if (
  platformCoreTokenStep <= identityScopedTokenStep ||
  platformCoreTokenStep >= firstProductionRecoveryCheck
) {
  throw new Error(
    "CI-only Platform Core token step is missing or misplaced",
  );
}
const platformCoreTokenBlock = workflow.slice(
  platformCoreTokenStep,
  firstProductionRecoveryCheck,
);
for (const sourceLine of [
  'platform_core_token="$(openssl rand -hex 32)"',
  'echo "::add-mask::$platform_core_token"',
  `printf 'PLATFORM_CORE_TOKEN=%s\\n' \\`,
  '"$platform_core_token" >> "$GITHUB_ENV"',
]) {
  if (!platformCoreTokenBlock.includes(sourceLine)) {
    throw new Error(
      `Generated CI Platform Core token boundary is incomplete: ${sourceLine}`,
    );
  }
}
for (const [key, expected] of [
  ["PLATFORM_INTERNAL_BASE_URL", 2],
  ["PLATFORM_INTERNAL_TIMEOUT_MS", 2],
  ["PLATFORM_OUTBOX_RETENTION_DAYS", 2],
  ["PLATFORM_CORE_TOKEN", 3],
]) {
  const actual = substringCount(workflow, key);
  if (actual !== expected) {
    throw new Error(
      `Platform workflow environment key ${key} expected ${expected} occurrences, got ${actual}`,
    );
  }
}
if (
  (productionCompose.match(/^\s+PLATFORM_CORE_TOKEN:/gm) ?? []).length !== 2 ||
  !productionCompose.includes(
    "PLATFORM_INTERNAL_BASE_URL: ${PLATFORM_INTERNAL_BASE_URL:-http://127.0.0.1:5000}",
  ) ||
  !productionCompose.includes(
    "PLATFORM_INTERNAL_TIMEOUT_MS: ${PLATFORM_INTERNAL_TIMEOUT_MS:-5000}",
  ) ||
  !productionCompose.includes(
    "PLATFORM_OUTBOX_RETENTION_DAYS: ${PLATFORM_OUTBOX_RETENTION_DAYS:-7}",
  ) ||
  productionCompose
    .slice(
      productionCompose.indexOf("x-platform-env: &platform-env"),
      productionCompose.indexOf("x-maintenance-worker-env:"),
    )
    .includes("PLATFORM_CORE_TOKEN") ||
  !validateProductionComposeScript.includes(
    "requireMutualToken('Core to Platform', [",
  ) ||
  !validateProductionComposeScript.includes(
    "name === 'api' || name === 'platform-api'",
  ) ||
  !deployProductionScript.includes(
    'require_env_key "PLATFORM_INTERNAL_BASE_URL"',
  ) ||
  !deployProductionScript.includes(
    'require_env_key "PLATFORM_CORE_TOKEN"',
  ) ||
  !deployProductionScript.includes(
    'require_env_key "PLATFORM_INTERNAL_TIMEOUT_MS"',
  ) ||
  !deployProductionScript.includes(
    'require_env_key "PLATFORM_OUTBOX_RETENTION_DAYS"',
  ) ||
  !platformDatabaseLifecycle.includes(
    "PLATFORM_INTERNAL_BASE_URL PLATFORM_CORE_TOKEN PLATFORM_INTERNAL_TIMEOUT_MS",
  ) ||
  !platformDatabaseLifecycle.includes(
    "PLATFORM_OUTBOX_RETENTION_DAYS",
  )
) {
  throw new Error(
    "Platform Core monitoring credential and loopback boundary must remain exact and role-scoped",
  );
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
  10,
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
requireCount("guard_platform_checkout_before_pull() {", 2);
const workflowPlatformCheckoutGuardStart = workflow.indexOf(
  "          guard_platform_checkout_before_pull() {",
);
const workflowPlatformCheckoutGuardEnd = workflow.indexOf(
  "\n\n          current_revision=",
  workflowPlatformCheckoutGuardStart,
);
const workflowPlatformCheckoutGuard = workflow.slice(
  workflowPlatformCheckoutGuardStart,
  workflowPlatformCheckoutGuardEnd,
);
for (const requiredPhaseAIntentGuardToken of [
  'local phase_a_intent="$APP_ROOT/deploy/backend/.platform-phase-a-intent-v1"',
  '-e "$phase_a_intent" || -L "$phase_a_intent" ||',
  '! -e "$phase_a_intent" && ! -L "$phase_a_intent" &&',
]) {
  if (!workflowPlatformCheckoutGuard.includes(requiredPhaseAIntentGuardToken)) {
    throw new Error(
      `Platform checkout fallback does not fail closed for its phase-A intent: ${requiredPhaseAIntentGuardToken}`,
    );
  }
}
requireCount(
  'local lifecycle_script="scripts/widgets-database-lifecycle.sh"',
  2,
);
requireCount(
  'local guard_action="${2:---guard-before-fetch-revision}"',
  10,
);
requireCount('"$guard_action" "$expected_revision"', 2);
requireCount(
  '"$expected_revision" --guard-before-checkout-revision',
  10,
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
  "bash .github/scripts/stage-or-deploy-backend.sh",
);
if (
  deploymentControllerCheckoutIndex < 0 ||
  deploymentControllerRunIndex <= deploymentControllerCheckoutIndex
) {
  throw new Error(
    "The deploy job must check out the versioned controller before executing it",
  );
}
const platformStageStepStart = deployJobHeader.indexOf(
  "- name: Stage or deploy backend on VPS",
);
const platformTransportStepStart = deployJobHeader.indexOf(
  "- name: Generate, transport, and consume Platform frontend attestation",
);
const platformTransportStepEnd = deployJobHeader.indexOf(
  "- name: Download encrypted canonical Identity production env",
  platformTransportStepStart,
);
const platformStageStep = deployJobHeader.slice(
  platformStageStepStart,
  platformTransportStepStart,
);
const platformTransportStep = deployJobHeader.slice(
  platformTransportStepStart,
  platformTransportStepEnd,
);
if (
  platformStageStepStart < 0 ||
  platformTransportStepStart <= platformStageStepStart ||
  platformTransportStepEnd <= platformTransportStepStart
) {
  throw new Error(
    "Platform frontend attestation transport is missing or runs before the exact backend revision is staged",
  );
}
for (const requiredStageToken of [
  `if [[ "$DEPLOY_TARGET" == 'platform' && "$PLATFORM_ACTION" != 'status' ]]`,
  "export PLATFORM_ACTION=status",
  "export PLATFORM_CONFIRMATION=''",
  "export PLATFORM_FRONTEND_EXPECTED_ATTESTATION_SHA256=''",
  "export PLATFORM_FRONTEND_EXPECTED_SIGNATURE_SHA256=''",
  "bash .github/scripts/stage-or-deploy-backend.sh",
]) {
  if (!platformStageStep.includes(requiredStageToken)) {
    throw new Error(
      `Platform backend staging lost its no-mutation boundary: ${requiredStageToken}`,
    );
  }
}
for (const requiredTransportToken of [
  "secrets.FRONTEND_PRODUCTION_SSH_HOST",
  "secrets.FRONTEND_PRODUCTION_SSH_PORT",
  "secrets.FRONTEND_PRODUCTION_SSH_USER",
  "secrets.FRONTEND_PRODUCTION_SSH_PRIVATE_KEY",
  "git rev-parse --verify \"$GITHUB_SHA:$controller_source\"",
  "PLATFORM_CUTOVER_GENERATION=1",
  'bash \\"\\$controller\\" --generate',
  "platform-frontend-runtime-attestation-v2.public.pem",
  "platform-frontend-runtime-attestation-v2.json",
  "platform-frontend-runtime-attestation-v2.sig",
  'computed_public_sha="$(sha256sum "$local_root/$public_name"',
  'computed_attestation_sha="$(sha256sum "$local_root/$attestation_name"',
  'computed_signature_sha="$(sha256sum "$local_root/$signature_name"',
  '"$computed_public_sha" == "$PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256"',
  '"$PLATFORM_MANUAL_ATTESTATION_SHA256" == "$computed_attestation_sha"',
  '"$PLATFORM_MANUAL_SIGNATURE_SHA256" == "$computed_signature_sha"',
  "PLATFORM_COMPUTED_ATTESTATION_SHA256='$computed_attestation_sha'",
  "PLATFORM_COMPUTED_SIGNATURE_SHA256='$computed_signature_sha'",
  'PLATFORM_FRONTEND_EXPECTED_ATTESTATION_SHA256="$PLATFORM_COMPUTED_ATTESTATION_SHA256"',
  'PLATFORM_FRONTEND_EXPECTED_SIGNATURE_SHA256="$PLATFORM_COMPUTED_SIGNATURE_SHA256"',
  '(( (8#$artifact_root_mode & 0022) == 0 ))',
  'phase_a_intent="$artifact_root/.platform-phase-a-intent-v1"',
  '"$(stat -c \'%u:%g:%a\' "$phase_a_intent")" == \'0:0:600\'',
  'intent_frontend_identity="$(awk -F=',
  '$1 !~ /^(version|phase|revision|generation|phase_a_env_sha256|phase_a_routes_sha256|frontend_revision|frontend_challenge|frontend_origin_sha256|trusted_public_key_sha256|created_at)$/ { exit 1 }',
  '[[ "$intent_frontend_identity" == "$EXPECTED_REVISION|1|$PLATFORM_FRONTEND_REVISION|$PLATFORM_FRONTEND_RUNTIME_CHALLENGE|$expected_origin_sha|$PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" ]]',
  'receipt_frontend_identity="$(awk -F=',
  '[[ "$receipt_frontend_identity" == "$PLATFORM_FRONTEND_REVISION|$PLATFORM_FRONTEND_RUNTIME_CHALLENGE|$expected_origin_sha|$PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256" ]]',
  'for artifact in "$public_name" "$signature_name" "$attestation_name"; do',
  'mv -fT -- "$stage/$artifact" "$artifact_root/$artifact"',
  'bash scripts/platform-cutover-production.sh "$platform_command"',
  "cleanup_platform_attestation_transport() {",
  "cleanup_controller() { rm -f --",
  "cleanup_stage() {",
  "set -Eeuo pipefail; umask 077; set -o noclobber; cat > '$frontend_controller'",
  "artifact='$frontend_root/$artifact'",
  'cat -- \\"\\$artifact\\"',
  "set -Eeuo pipefail; umask 077; set -o noclobber; cat > '$backend_stage/$artifact'",
]) {
  if (!platformTransportStep.includes(requiredTransportToken)) {
    throw new Error(
      `Platform frontend attestation transport is incomplete: ${requiredTransportToken}`,
    );
  }
}
for (const forbiddenTransportToken of [
  "platform-frontend-runtime-attestation-v2.private.pem",
  "--bootstrap-key",
  '"$frontend_root/*"',
  '"$backend_stage/*"',
  "scripts/deploy-production.sh",
  ".github/scripts/stage-or-deploy-backend.sh",
  "PLATFORM_FRONTEND_EXPECTED_ATTESTATION_SHA256='$PLATFORM_MANUAL_ATTESTATION_SHA256'",
  "PLATFORM_FRONTEND_EXPECTED_SIGNATURE_SHA256='$PLATFORM_MANUAL_SIGNATURE_SHA256'",
  "scp ",
]) {
  if (platformTransportStep.includes(forbiddenTransportToken)) {
    throw new Error(
      `Platform frontend attestation transport contains a forbidden release operation: ${forbiddenTransportToken}`,
    );
  }
}
if (
  substringCount(
    platformTransportStep,
    "set -Eeuo pipefail; umask 077; set -o noclobber; cat > '$frontend_controller'",
  ) !== 1 ||
  substringCount(
    platformTransportStep,
    "artifact='$frontend_root/$artifact'",
  ) !== 1 ||
  substringCount(platformTransportStep, 'cat -- \\"\\$artifact\\"') !== 1 ||
  substringCount(
    platformTransportStep,
    "set -Eeuo pipefail; umask 077; set -o noclobber; cat > '$backend_stage/$artifact'",
  ) !== 1 ||
  !platformTransportStep.includes(
    '( -z "$PLATFORM_MANUAL_ATTESTATION_SHA256" ||',
  ) ||
  !platformTransportStep.includes(
    '( -z "$PLATFORM_MANUAL_SIGNATURE_SHA256" ||',
  )
) {
  throw new Error(
    "Platform frontend transport must stream one exact controller, download only the three public artifacts, upload only those artifacts, and treat manual hashes as optional extra pins",
  );
}
const platformControllerUpload = platformTransportStep.indexOf(
  "cat > '$frontend_controller'",
);
const platformGenerate = platformTransportStep.indexOf("--generate");
const platformPublicDownload = platformTransportStep.indexOf(
  "artifact='$frontend_root/$artifact'",
);
const platformComputedPins = platformTransportStep.indexOf(
  'computed_attestation_sha="$(sha256sum',
);
const platformBackendStage = platformTransportStep.indexOf(
  "mkdir -- '$backend_stage'",
);
const platformPhaseAIntentCheck = platformTransportStep.indexOf(
  '[[ "$intent_frontend_identity" ==',
);
const platformAttestationPublish = platformTransportStep.indexOf(
  'mv -fT -- "$stage/$artifact" "$artifact_root/$artifact"',
);
const platformDirectLifecycle = platformTransportStep.indexOf(
  'bash scripts/platform-cutover-production.sh "$platform_command"',
);
if (
  [
    platformControllerUpload,
    platformGenerate,
    platformPublicDownload,
    platformComputedPins,
    platformBackendStage,
    platformPhaseAIntentCheck,
    platformAttestationPublish,
    platformDirectLifecycle,
  ].some((position) => position < 0) ||
  !(
    platformControllerUpload < platformGenerate &&
    platformGenerate < platformPublicDownload &&
    platformPublicDownload < platformComputedPins &&
    platformComputedPins < platformBackendStage &&
    platformBackendStage < platformPhaseAIntentCheck &&
    platformPhaseAIntentCheck < platformAttestationPublish &&
    platformAttestationPublish < platformDirectLifecycle
  )
) {
  throw new Error(
    "Platform frontend attestation must be generated, verified, installed, and consumed in one mutation-ordered workflow step",
  );
}
const deployJob = [
  deployJobHeader,
  indentedStageOrDeployBody,
].join("\n");
if (
  !stageOrDeployScript.includes(
    'awk -v expected_revision="$DEPLOY_REVISION"',
  ) ||
  !stageOrDeployScript.includes(
    '-v automatic_prod_push="$AUTOMATIC_PROD_PUSH"',
  ) ||
  !stageOrDeployScript.includes(
    '-v deploy_target="$DEPLOY_TARGET"',
  ) ||
  !stageOrDeployScript.includes(
    '$0 == "Backend revision verified locally and publicly: " expected_revision',
  ) ||
  !stageOrDeployScript.includes(
    'automatic_prod_push == "true" && deploy_target == "all" && receipts != 1',
  ) ||
  !stageOrDeployScript.includes(
    "Automatic backend deploy did not produce its exact completion receipt.",
  ) ||
  !stageOrDeployScript.includes("require_completion_receipt() {") ||
  !stageOrDeployLocalScript.includes(
    "PLATFORM_ENV_EXPECTED_SHA256='$PLATFORM_ENV_EXPECTED_SHA256'",
  ) ||
  !stageOrDeployLocalScript.includes(
    "PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256='$PLATFORM_FRONTEND_TRUSTED_PUBLIC_KEY_SHA256'",
  ) ||
  !stageOrDeployLocalScript.includes(
    'bash \\"\\$controller\\"" |\n  require_completion_receipt\ntrap - EXIT',
  )
) {
  throw new Error(
    "Automatic backend deployment must require one exact post-readiness completion receipt",
  );
}
const localReceiptGate = stageOrDeployLocalScript.indexOf(
  'awk -v expected_revision="$DEPLOY_REVISION"',
);
const remoteScriptStart = stageOrDeployRemoteScript.indexOf("set -euo pipefail");
if (
  localReceiptGate < 0 ||
  remoteScriptStart < 0 ||
  stageOrDeployRemoteScript.includes("require_completion_receipt")
) {
  throw new Error(
    "Automatic completion receipt must be enforced by the GitHub runner outside the SSH script",
  );
}
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
  "exit 1",
  billingCandidateGuard,
);
if (
  automaticDeferStart < 0 ||
  automaticDeferEnd <= automaticDeferStart ||
  billingCandidateGuard < 0 ||
  billingDeferredExit <= billingCandidateGuard ||
  automaticDefer.includes("exit 0") ||
  (automaticDefer.match(/exit 1/g) || []).length !== 6 ||
  automaticDefer.includes("git fetch origin prod") ||
  automaticDefer.includes("git checkout prod") ||
  automaticDefer.includes("retarget_billing_cleanup_revision")
) {
  throw new Error(
    "Automatic SHA C push must fail when deferred before fetch, checkout, or Billing cleanup retarget",
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
  const platformPreFetchGuardIndex = checkoutFunction.lastIndexOf(
    'guard_platform_checkout_before_pull "$expected_revision"',
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
  const platformPostFetchGuardIndex = checkoutFunction.indexOf(
    "guard_platform_checkout_before_pull",
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
    platformPreFetchGuardIndex < 0 ||
    fetchIndex < 0 ||
    reportingPostFetchGuardIndex < 0 ||
    widgetsPostFetchGuardIndex < 0 ||
    billingPostFetchGuardIndex < 0 ||
    identityPostFetchGuardIndex < 0 ||
    platformPostFetchGuardIndex < 0 ||
    checkoutIndex < 0 ||
    lockIndex >= checkoutFunctionStart ||
    reportingPreFetchGuardIndex >= fetchIndex ||
    campaignsGuardIndex >= fetchIndex ||
    widgetsPreFetchGuardIndex >= fetchIndex ||
    billingPreFetchGuardIndex >= fetchIndex ||
    identityPreFetchGuardIndex >= fetchIndex ||
    platformPreFetchGuardIndex >= fetchIndex ||
    fetchIndex >= reportingPostFetchGuardIndex ||
    reportingPostFetchGuardIndex >= widgetsPostFetchGuardIndex ||
    widgetsPostFetchGuardIndex >= billingPostFetchGuardIndex ||
    billingPostFetchGuardIndex >= identityPostFetchGuardIndex ||
    identityPostFetchGuardIndex >= platformPostFetchGuardIndex ||
    platformPostFetchGuardIndex >= checkoutIndex
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
const deployStart = workflow.indexOf("\n  deploy:", verifyStart);
const verifyServicesStart = workflow.indexOf(
  "\n    services:",
  verifyStart,
);
const verifyStepsStart = workflow.indexOf("\n    steps:\n", verifyServicesStart);
if (
  lifecyclePreflightStart < 0 ||
  verifyStart <= lifecyclePreflightStart ||
  deployStart <= verifyStart ||
  verifyServicesStart <= verifyStart ||
  verifyStepsStart <= verifyServicesStart ||
  substringCount(workflow, "\n  lifecycle_checkout_preflight:") !== 1 ||
  substringCount(workflow, "\n  verify:") !== 1 ||
  substringCount(workflow, "\n  deploy:") !== 1
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
const buildImageStepStart = workflow.indexOf(
  "\n      - name: Build and verify production image\n",
  verifyStepsStart,
);
const buildImageStepEnd = workflow.indexOf(
  "\n      - name:",
  buildImageStepStart + 1,
);
if (
  buildImageStepStart < verifyStepsStart ||
  buildImageStepEnd <= buildImageStepStart ||
  buildImageStepEnd >= deployStart ||
  substringCount(
    workflow,
    "\n      - name: Build and verify production image\n",
  ) !== 1
) {
  throw new Error("Production image verification step is missing");
}
const buildImageStep = workflow.slice(buildImageStepStart, buildImageStepEnd);
const buildImageEnvStart = buildImageStep.indexOf("\n        env:\n");
const buildImageRunStart = buildImageStep.indexOf("\n        run: |\n");
if (
  buildImageEnvStart < 0 ||
  buildImageRunStart <= buildImageEnvStart ||
  substringCount(buildImageStep, "\n        env:\n") !== 1
) {
  throw new Error(
    "Production image verification must have one step-local CI fixture environment",
  );
}
const buildImageEnvLines = buildImageStep
  .slice(buildImageEnvStart + "\n        env:\n".length, buildImageRunStart)
  .split("\n")
  .filter(line => line.trim() !== "" && !line.trimStart().startsWith("#"));
const buildImageEnvEntries = buildImageEnvLines.map(line => {
  const match = line.match(/^          ([A-Z][A-Z0-9_]*): (\S.*)$/);
  if (!match) {
    throw new Error(
      "Production image verification CI fixture mapping contains a non-scalar or empty entry",
    );
  }
  return [match[1], match[2]];
});
const buildImageEnv = Object.fromEntries(buildImageEnvEntries);
if (Object.keys(buildImageEnv).length !== buildImageEnvEntries.length) {
  throw new Error("Production image verification has duplicate CI fixture keys");
}
const expectedBuildImageEnv = {
  PAYMENT_METHOD_ENCRYPTION_KEY:
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  YOOKASSA_PRODUCTION_SHOP_ID: "ci_billing_shop",
  YOOKASSA_PRODUCTION_SECRET_KEY:
    "ci_billing_secret_key_at_least_32_chars",
  S3_ACCESS_KEY_ID: "ci_widgets_s3_access_key",
  S3_SECRET_ACCESS_KEY: "ci_widgets_s3_secret_key_at_least_32_chars",
  IDENTITY_AVATAR_S3_ACCESS_KEY_ID: "ci_identity_avatar_s3_access_key",
  IDENTITY_AVATAR_S3_SECRET_ACCESS_KEY:
    "ci_identity_avatar_s3_secret_key_at_least_32_chars",
  GOOGLE_CLIENT_ID: "ci_identity_google_client_id",
  GOOGLE_CLIENT_SECRET: "ci_identity_google_client_secret",
  GITHUB_CLIENT_ID: "ci_identity_github_client_id",
  GITHUB_CLIENT_SECRET: "ci_identity_github_client_secret",
  YANDEX_CLIENT_ID: "ci_identity_yandex_client_id",
  YANDEX_CLIENT_SECRET: "ci_identity_yandex_client_secret",
  TELEGRAM_INFO_BOT_TOKEN: "ci_identity_info_bot_token",
  TELEGRAM_INFO_BOT_USERNAME: "ci_identity_info_bot",
  TELEGRAM_INFO_BOT_WEBHOOK_SECRET: "ci_identity_info_webhook_secret",
  TELEGRAM_AUTH_BOT_TOKEN: "ci_identity_auth_bot_token",
  TELEGRAM_AUTH_BOT_USERNAME: "ci_identity_auth_bot",
  TELEGRAM_AUTH_BOT_WEBHOOK_SECRET: "ci_identity_auth_webhook_secret",
  SMSAERO_EMAIL: "identity-ci@example.invalid",
  SMSAERO_API_KEY: "ci_identity_smsaero_api_key",
};
const productionEnvExampleValues = new Map(
  productionEnvExample
    .split("\n")
    .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const requiredBlankComposeVariables = [
  ...new Set(
    [...productionCompose.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?[^}]*\}/g)].map(
      match => match[1],
    ),
  ),
]
  .filter(name => productionEnvExampleValues.get(name) === "")
  .sort();
const expectedBuildImageEnvNames = Object.keys(expectedBuildImageEnv).sort();
if (
  JSON.stringify(requiredBlankComposeVariables) !==
    JSON.stringify(expectedBuildImageEnvNames) ||
  JSON.stringify(buildImageEnv) !== JSON.stringify(expectedBuildImageEnv)
) {
  throw new Error(
    "Production image verification CI fixtures do not exactly cover blank mandatory Compose variables",
  );
}
const deployWorkflow = workflow.slice(deployStart);
for (const [name, value] of Object.entries(expectedBuildImageEnv)) {
  if (deployWorkflow.includes(name) || deployWorkflow.includes(value)) {
    throw new Error(
      "Production image CI-only fixtures must not enter the deploy job",
    );
  }
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
