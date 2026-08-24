import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const requireText = (path, values) => {
	const source = read(path);
	for (const value of values) {
		if (!source.includes(value)) {
			throw new Error(`${path} is missing Support boundary: ${value}`);
		}
	}
	return source;
};
const forbidText = (path, values) => {
	const source = read(path);
	for (const value of values) {
		if (source.includes(value)) {
			throw new Error(
				`${path} retains forbidden Support fallback: ${value}`
			);
		}
	}
};

requireText('apps/support/src/main.ts', ['rawBody: true']);
requireText('apps/support/src/telegram/support-webhook.controller.ts', [
	"@Controller('telegram-bot')",
	"@Post('support-webhook')",
	"@Headers('x-telegram-bot-api-secret-token')",
	'rawBody'
]);
forbidText('apps/support/src/telegram/support-webhook.service.ts', [
	'setImmediate',
	'api.telegram.org'
]);
requireText('apps/support/src/config/support-config.service.ts', [
	'https://tg.winwidget.ru/telegram-api',
	'185.184.122.62',
	'Support Outbox publisher must not receive Telegram credentials'
]);
requireText('apps/support/prisma/schema.prisma', [
	'model TelegramWebhookInbox',
	'updateId',
	'bodyHash',
	'model TelegramOutboundDelivery',
	'model OutboxEvent',
	'model ConsumerReceipt',
	'model ConsumerFailure'
]);
requireText(
	'apps/support/prisma/migrations/20260824010000_init_support/migration.sql',
	[
		'CREATE UNIQUE INDEX "telegram_webhook_inbox_update_id_key"',
		'CREATE UNIQUE INDEX "telegram_outbound_deliveries_idempotency_key_key"',
		'CREATE TABLE "support"."outbox_events"',
		'CREATE TABLE "support"."consumer_receipts"',
		'CREATE TABLE "support"."consumer_failures"'
	]
);
requireText('apps/support/src/messaging/support-messaging.constants.ts', [
	'support.telegram.webhook-admitted.v1',
	'winwidget.support.telegram-webhook.v1',
	'`${SUPPORT_WEBHOOK_CONSUMER}.retry.${attempt}`',
	'`${SUPPORT_WEBHOOK_CONSUMER}.dead-letter`'
]);
requireText('apps/support/src/messaging/support-rabbitmq.service.ts', [
	'mandatory: true',
	'await this.channel.publish',
	'installReturnHandler',
	'Buffer.from'
]);
requireText(
	'apps/support/src/messaging/support-messaging-admin.controller.ts',
	[
		"@Controller('support/admin/messaging/failures')",
		"@Post(':id/retry')",
		"@Post(':id/close')"
	]
);
requireText('deploy/docker-compose.prod.yml', [
	"'tg.winwidget.ru:${TELEGRAM_API_PROXY_IP:?TELEGRAM_API_PROXY_IP is required}'",
	'SUPPORT_PROCESS_ROLE: api',
	'SUPPORT_PROCESS_ROLE: worker',
	'SUPPORT_PROCESS_ROLE: outbox-publisher',
	'support-migrate:',
	'support-postgres:'
]);
const compose = read('deploy/docker-compose.prod.yml');
const composeValidator = read(
	'.github/scripts/validate-production-compose.cjs'
);
const persistentServicesMatch = composeValidator.match(
	/const expectedPersistentServiceNames = \[([\s\S]*?)\n\];/
);
if (!persistentServicesMatch) {
	throw new Error(
		'Production Compose validator is missing its persistent service contract'
	);
}
const expectedPersistentServices = [
	...persistentServicesMatch[1].matchAll(/'([^']+)'/g)
].map(match => match[1]);
const sortedUniquePersistentServices = [
	...new Set(expectedPersistentServices)
].sort();
if (
	JSON.stringify(expectedPersistentServices) !==
	JSON.stringify(sortedUniquePersistentServices)
) {
	throw new Error(
		'Production Compose persistent service contract must be sorted and unique'
	);
}
if (
	expectedPersistentServices.filter(service => service === 'support-api')
		.length !== 1
) {
	throw new Error(
		'Production Compose persistent service contract must contain support-api exactly once'
	);
}
const publisher = compose.slice(
	compose.indexOf('  support-outbox-publisher:'),
	compose.indexOf('  maintenance-worker:')
);
for (const forbidden of [
	'TELEGRAM_SUPPORT_BOT_TOKEN',
	'TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET',
	'TELEGRAM_API_BASE_URL',
	'extra_hosts:'
]) {
	if (publisher.includes(forbidden)) {
		throw new Error(
			`Support publisher receives forbidden Telegram value: ${forbidden}`
		);
	}
}
const deployProduction = requireText('scripts/deploy-production.sh', [
	'$(get_env_value TELEGRAM_API_BASE_URL)" != "https://tg.winwidget.ru/telegram-api',
	'[[ "$telegram_api_proxy_ip" != \'185.184.122.62\' ]]',
	'verify_support_steady_ownership',
	'verify_core_support_runtime_artifact',
	'validate_support_database_urls',
	'SUPPORT_FIRST_CUTOVER_DEPLOY',
	'support_first_database_phase',
	'Support first-cutover found an unsafe stopped $service state',
	'.support-cutover-v1',
	'support_first_core_image_id',
	'if [[ "$support_first_cutover_deploy" == \'false\' ]]'
]);
const routineCapture = deployProduction.slice(
	deployProduction.indexOf('capture_routine_stop_containers() {'),
	deployProduction.indexOf(
		'capture_widgets_core_cleanup_precommit_containers() {'
	)
);
for (const required of [
	'if [[ -z "$container_id" && "$support_first_cutover_deploy" == \'true\' ]]; then',
	'"$service" == \'database-restore-worker\' ||',
	'"$service" =~ ^support-(api|worker|outbox-publisher)$',
	'"$identity" == "$target_project|$service"',
	'"$app_revision" == "$image_revision"',
	"'exited|143|false|'",
	'Support first-cutover lost the stopped $service container identity.'
]) {
	if (!routineCapture.includes(required)) {
		throw new Error(
			`Support first-cutover stopped-container guard drifted: ${required}`
		);
	}
}
if (
	routineCapture.includes(
		'^(api-gateway|api|support-api|support-worker|support-outbox-publisher)$'
	)
) {
	throw new Error(
		'Support first-cutover still narrows stopped-container adoption before exact identity validation'
	);
}
const mayBeMissingAtFirstCutover = service =>
	service === 'database-restore-worker' ||
	/^support-(api|worker|outbox-publisher)$/.test(service);
if (
	mayBeMissingAtFirstCutover('maintenance-worker') ||
	!mayBeMissingAtFirstCutover('support-api') ||
	!mayBeMissingAtFirstCutover('database-restore-worker')
) {
	throw new Error(
		'Support first-cutover missing-container policy drifted'
	);
}
const routineStop = deployProduction.slice(
	deployProduction.indexOf('stop_routine_topology_for_core_migration() {'),
	deployProduction.indexOf('recover_widgets_core_cleanup_stop_on_exit() {')
);
for (const required of [
	'"$service" == \'database-restore-worker\' ||',
	'"$support_first_cutover_deploy" == \'true\''
]) {
	if (!routineStop.includes(required)) {
		throw new Error(
			`Support first-cutover stop-loop guard drifted: ${required}`
		);
	}
}
if (
	routineStop.includes(
		'^(api-gateway|api|support-api|support-worker|support-outbox-publisher)$'
	)
) {
	throw new Error(
		'Support first-cutover stop loop still has a service allowlist'
	);
}
const steadyOwnership = deployProduction.slice(
	deployProduction.indexOf('verify_support_steady_ownership() {'),
	deployProduction.indexOf('validate_campaigns_database_urls() {')
);
for (const required of [
	'.support-database-lifecycle-v1',
	"'0:0:600'",
	'value["phase"] != "complete"',
	'EXPECTED_OWNERSHIP_REVISION',
	'process.env.EXPECTED_OWNERSHIP_REVISION'
]) {
	if (!steadyOwnership.includes(required)) {
		throw new Error(`Support steady ownership guard drifted: ${required}`);
	}
}
if (steadyOwnership.includes('process.env.EXPECTED_REVISION')) {
	throw new Error(
		'Support steady ownership is incorrectly rebound to the routine deploy revision'
	);
}
requireText('.env.example', [
	'TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api',
	'TELEGRAM_API_PROXY_IP=185.184.122.62',
	'IDENTITY_SUPPORT_TOKEN=',
	'SUPPORT_CORE_TOKEN=',
	'RABBITMQ_SUPPORT_WORKER_URL=',
	'RABBITMQ_SUPPORT_PUBLISHER_URL='
]);
requireText('src/messaging/messaging.constants.ts', [
	'support-admin-audit',
	'admin.audit.support.v1'
]);
requireText('src/messaging/messaging-event-contract.ts', [
	'SUPPORT_ROUTING_SETTINGS_UPDATE'
]);
requireText('src/maintenance/database-backup.types.ts', [
	"SUPPORT: 'support'",
	'SUPPORT_DATABASE_BACKUP_DELAY_MINUTES'
]);
requireText('src/dev-tools/database-restore-queue.contract.ts', [
	"'support'"
]);
for (const removed of [
	'src/dev-tools/database-restore.service.ts',
	'src/dev-tools/database-restore.service.spec.ts'
]) {
	if (existsSync(resolve(root, removed))) {
		throw new Error(
			`${removed} retains removed Core database restore runtime`
		);
	}
}
forbidText('src/dev-tools/database-restore-queue.contract.ts', ["'core'"]);
forbidText(
	'src/database-restore-worker/database-restore-worker.config.ts',
	['DATABASE_RESTORE_CORE']
);
forbidText('deploy/docker-compose.prod.yml', ['DATABASE_RESTORE_CORE']);
forbidText('deploy/docker-compose.prod.yml', ['DATABASE_BACKUP_URL']);
forbidText('.env.example', ['DATABASE_BACKUP_URL=']);
forbidText('src/maintenance/database-backup.service.ts', [
	"'DATABASE_BACKUP_URL'"
]);
requireText('README.md', [
	'Backup runtime не обслуживает монолитную основную БД.',
	'Target `core` отклоняется контрактом.',
	'Legacy Core restore endpoints удалены без fallback.'
]);
forbidText('README.md', [
	'backup target `core`',
	'ручной backup `core`',
	'Для четырёх targets (`core`',
	'для всех четырёх баз'
]);
forbidText('database-restore-entrypoint.sh', ['database-restore-core']);
forbidText('.github/workflows/database-restore-production.yml', [
	'- core'
]);
forbidText('src/dev-tools/dev-tools.controller.ts', [
	"@Get('database-backup/restore-settings')",
	"@Post('database-backup/restore')"
]);
forbidText('src/telegram-bot/telegram-bot.service.ts', [
	'handleSupportWebhook',
	'TELEGRAM_SUPPORT_BOT',
	'telegramSupportMessage',
	'setImmediate'
]);
forbidText('src/telegram-bot/telegram-bot.controller.ts', [
	"@Post('support-webhook')",
	"@Get('admin/webhooks/status')"
]);
forbidText('prisma/schema.prisma', [
	'model TelegramSupportMessage',
	'supportThreadId'
]);
requireText(
	'prisma/post-cutover/support/20260824030000_remove_legacy_support_core_source.sql',
	[
		'DROP LEGACY SUPPORT CORE SOURCE',
		'pg_advisory_xact_lock',
		'marker."ownership" <> \'SUPPORT\'',
		'marker."active_task_count" <> 0',
		'cleanup_revision IS NULL',
		'target_database_id IS NULL',
		'source_database_system_id IS NULL',
		'source_fingerprint IS NULL',
		'source_snapshot_sha256 IS NULL',
		'source_mapping_count IS NULL',
		'source_high_watermark IS NULL',
		'marker."exported_at" IS NULL',
		'marker."activated_at" IS NULL',
		'DROP TABLE "telegram_support_messages"',
		'DROP COLUMN "support_thread_id"',
		'CREATE TABLE "support_core_cleanup_state"'
	]
);
requireText('scripts/cleanup-support-core-source-production.sh', [
	'APP_ROOT="${APP_ROOT:-/opt/winwidget}"',
	'BACKEND_ENV_FILE:-$APP_ROOT/deploy/backend/.env.production',
	'production-deploy-lock.sh',
	'database-restore-production-guard.sh',
	'acquire_production_deploy_lock',
	'database_restore_guard_assert_before_mutation',
	'SUPPORT_CORE_SOURCE_CLEANUP_MIGRATION_SHA256',
	'SUPPORT_CORE_SOURCE_CLEANUP_SUPPORT_BACKUP_SHA256',
	'SUPPORT_CORE_SOURCE_CLEANUP_RESTORE_EVIDENCE_SHA256',
	'Core API must be stopped',
	'support_release_require_checkout "$server_root" "$revision"',
	'support_database_mark_cleanup "$revision"',
	'support_cleanup_write_marker complete',
	'support_cutover_validate_images',
	'support_cutover_marker_value phase',
	'core_image="$support_cutover_core_image_id"',
	'gateway_image="$support_cutover_gateway_image_id"'
]);
forbidText('scripts/cleanup-support-core-source-production.sh', [
	'SUPPORT_CORE_SOURCE_CLEANUP_CORE_BACKUP_FILE',
	'SUPPORT_CORE_SOURCE_CLEANUP_CORE_BACKUP_SHA256'
]);
requireText('scripts/support-release-identity.sh', [
	'winwidget-support:git-%s',
	'APP_VERSION="git-$revision"',
	'Ambient Docker endpoint overrides are forbidden.',
	'unix:///var/run/docker.sock',
	'--self-test'
]);
requireText('scripts/support-database-lifecycle.sh', [
	'postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296',
	'winwidget-support-postgres-data',
	'--profile support-migration run --rm --no-deps support-migrate',
	"SELECT database_id::text FROM support.service_identity WHERE service_name = 'support-service';",
	"acquire_production_deploy_lock 'Support database prepare'",
	'database_restore_guard_assert_before_mutation healthy-required',
	'support_database_validate_bound_identity',
	'Bound Support database identity changed.',
	'if [[ "$cleanup" == \'pending\' ]]',
	'--abort-prepare',
	'--self-test'
]);
const supportCutover = requireText(
	'scripts/support-cutover-production.sh',
	[
		"acquire_production_deploy_lock 'Support ownership prepare'",
		'database_restore_guard_assert_before_mutation healthy-required',
		'support_cutover_compose build --pull api',
		'org.opencontainers.image.revision',
		'support_cutover_validate_gateway_routes',
		'support_database_validate_bound_identity',
		'support_cutover_write_marker preflight-verified',
		'support_cutover_write_marker forward-only',
		'support_cutover_write_marker complete',
		'SUPPORT_EXPECTED_GATEWAY_ROUTES_JSON',
		'require("./dist/src/config.js")',
		'support_cutover_compose stop -t 90 api-gateway api',
		'.support-cutover-$EXPECTED_REVISION',
		'support-cutover-main.js export',
		'dist/src/cutover/main.js import',
		'support_database_advance forward-only',
		'support_database_advance active',
		'support_database_advance complete',
		'SUPPORT_FIRST_CUTOVER_DEPLOY="$first_cutover"',
		'scripts/deploy-production.sh',
		'--self-test'
	]
);
const supportPrepare = supportCutover.slice(
	supportCutover.indexOf('support_cutover_prepare() {'),
	supportCutover.indexOf('support_cutover_extract_export() {')
);
for (const required of [
	'if [[ -e "$support_cutover_marker" || -L "$support_cutover_marker" ]]; then',
	'support_cutover_validate_marker || return 1',
	'"$(support_cutover_marker_value phase)" == \'preflight-verified\'',
	'"$(support_cutover_marker_value revision)" == "$EXPECTED_REVISION"',
	'else\n\t\tsupport_cutover_compose build --pull api api-gateway',
	'Support prepared retry requires its exact preflight marker.'
]) {
	if (!supportPrepare.includes(required)) {
		throw new Error(
			`Support prepared retry image pin drifted: ${required}`
		);
	}
}
if (
	(
		supportPrepare.match(
			/support_cutover_compose build --pull api api-gateway/g
		) ?? []
	).length !== 1
) {
	throw new Error(
		'Support prepare must build Core and Gateway only in the marker-absent branch'
	);
}
forbidText('scripts/support-cutover-production.sh', [
	'mktemp -d "$APP_ROOT/deploy/backend/.support-cutover'
]);
requireText('src/support-cutover-main.ts', [
	'loadExistingSnapshot(',
	"action: 'fence'",
	"action: 'activate'",
	'resumed: true',
	'Support resume snapshot differs from the fenced Core source'
]);
requireText('apps/support/src/cutover/main.ts', [
	'const resumablePhase =',
	'state.phase === ServiceDatabasePhase.ACTIVE',
	'resumed: true'
]);
requireText('database-restore-entrypoint.sh', [
	'/run/secrets/database-restore-support-admin-password',
	'$secret_target_directory/support-admin-password'
]);
forbidText(
	'prisma/migrations/20260824020000_prepare_support_service_ownership/migration.sql',
	[
		'DROP TABLE "telegram_support_messages"',
		'DROP COLUMN "support_thread_id"'
	]
);
requireText('.github/workflows/database-restore-production.yml', [
	'- support'
]);
requireText('.github/workflows/deploy-production.yml', [
	'- support',
	'support_action:',
	"prepare:'PREPARE SUPPORT OWNERSHIP'",
	"cutover:'CUTOVER SUPPORT OWNERSHIP'",
	"cleanup:'DROP LEGACY SUPPORT CORE SOURCE'",
	'support_cleanup_migration_sha256:',
	'support_cleanup_backup_sha256:',
	'support_cleanup_restore_evidence_sha256:',
	'apps/support/pnpm-lock.yaml',
	'scripts/support-cutover-production.sh',
	'guard_support_checkout_before_pull',
	'cleanup-support-core-source-production.sh',
	'20260824030000_remove_legacy_support_core_source.sql',
	'Start isolated Support PostgreSQL 18',
	'SUPPORT_DATABASE_URL="$SUPPORT_CI_MIGRATION_DATABASE_URL"',
	'Verify Support PostgreSQL ACLs and clean restore',
	'Cleanup isolated Support PostgreSQL',
	'scripts/support-release-identity.sh --self-test',
	'scripts/support-database-lifecycle.sh --self-test',
	'scripts/support-cutover-production.sh --self-test'
]);
requireText('.github/scripts/stage-or-deploy-backend.sh', [
	'if [[ "$DEPLOY_TARGET" == \'support\' ]]',
	"prepare:'PREPARE SUPPORT OWNERSHIP'",
	"cutover:'CUTOVER SUPPORT OWNERSHIP'",
	"cleanup:'DROP LEGACY SUPPORT CORE SOURCE'",
	"SUPPORT_ACTION='$SUPPORT_ACTION'",
	"SUPPORT_CONFIRMATION='$SUPPORT_CONFIRMATION'",
	"SUPPORT_CLEANUP_MIGRATION_SHA256='$SUPPORT_CLEANUP_MIGRATION_SHA256'",
	"SUPPORT_CLEANUP_BACKUP_SHA256='$SUPPORT_CLEANUP_BACKUP_SHA256'",
	"SUPPORT_CLEANUP_RESTORE_EVIDENCE_SHA256='$SUPPORT_CLEANUP_RESTORE_EVIDENCE_SHA256'"
]);
requireText('.github/scripts/stage-or-deploy-backend-remote.sh', [
	'guard_support_checkout_before_pull()',
	'--guard-before-checkout-revision',
	"echo 'Support lifecycle actions are manual-only.'",
	'bash scripts/support-cutover-production.sh --prepare',
	'bash scripts/support-cutover-production.sh --cutover',
	'SUPPORT_CORE_SOURCE_CLEANUP_APPROVED=true',
	'bash scripts/cleanup-support-core-source-production.sh'
]);

process.stdout.write('Support runtime and cleanup boundaries verified\n');
