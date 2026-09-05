#!/usr/bin/env bash

set -euo pipefail

bash -n .github/scripts/validate-production-compose.sh
node --check .github/scripts/validate-production-compose.cjs
node --check apps/operations/test/integration/database-restore-control-ledger-postgres18.integration.mjs
node --check apps/operations/test/integration/database-restore-postgres18.rehearsal.mjs
node --check apps/identity/test/integration/login-otp-postgres18.integration.mjs

env \
	GITHUB_CLIENT_ID=ci_identity_github_client_id \
	GITHUB_CLIENT_SECRET=ci_identity_github_client_secret_at_least_32_chars \
	GOOGLE_CLIENT_ID=ci_identity_google_client_id \
	GOOGLE_CLIENT_SECRET=ci_identity_google_client_secret_at_least_32_chars \
	IDENTITY_AVATAR_S3_ACCESS_KEY_ID=ci_identity_avatar_s3_access_key \
	IDENTITY_AVATAR_S3_SECRET_ACCESS_KEY=ci_identity_avatar_s3_secret_key_at_least_32_chars \
	PAYMENT_METHOD_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
	S3_ACCESS_KEY_ID=ci_widgets_s3_access_key \
	S3_SECRET_ACCESS_KEY=ci_widgets_s3_secret_key_at_least_32_chars \
	SMSAERO_API_KEY=ci_identity_smsaero_api_key \
	SMSAERO_EMAIL=identity-ci@example.invalid \
	TELEGRAM_AUTH_BOT_TOKEN=ci_identity_auth_bot_token_at_least_32_chars \
	TELEGRAM_AUTH_BOT_USERNAME=ci_identity_auth_bot \
	TELEGRAM_AUTH_BOT_WEBHOOK_SECRET=ci_identity_auth_webhook_secret_at_least_32_chars \
	TELEGRAM_INFO_BOT_TOKEN=ci_identity_info_bot_token_at_least_32_chars \
	TELEGRAM_INFO_BOT_USERNAME=ci_identity_info_bot \
	TELEGRAM_INFO_BOT_WEBHOOK_SECRET=ci_identity_info_webhook_secret_at_least_32_chars \
	TELEGRAM_SUPPORT_BOT_TOKEN=ci_support_bot_token_at_least_32_chars \
	TELEGRAM_SUPPORT_BOT_USERNAME=ci_support_bot \
	TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET=ci_support_webhook_secret_at_least_32_chars \
	YANDEX_CLIENT_ID=ci_identity_yandex_client_id \
	YANDEX_CLIENT_SECRET=ci_identity_yandex_client_secret_at_least_32_chars \
	YOOKASSA_PRODUCTION_SECRET_KEY=ci_billing_secret_key_at_least_32_chars \
	YOOKASSA_PRODUCTION_SHOP_ID=ci_billing_shop \
	bash .github/scripts/validate-production-compose.sh

if rg -n \
	'BILLING_INTERNAL_(TOKEN|TIMEOUT_MS)|BillingInternal(Controller|Guard)|internal/v1/billing/(users|trials|settings|directory|messaging|admin-alerts)|coreMutationApplied' \
	apps deploy .env.example \
	--glob '!**/dist/**' \
	--glob '!**/node_modules/**' \
	--glob '!**/pnpm-lock.yaml'; then
	echo 'A retired monolith or generic Billing contract remains.' >&2
	exit 1
fi

if rg -n \
	'paymentDetailsChanged|subscriptionDetailsChanged|billing\.payment\.details\.changed\.v1|billing\.subscription\.details\.changed\.v1' \
	apps/billing/src \
	--glob '!**/dist/**' \
	--glob '!**/node_modules/**'; then
	echo 'A retired Core-owned Billing detail projection remains.' >&2
	exit 1
fi

if git ls-files | rg '(^|/)\.env\.production$'; then
	echo 'A production env file is tracked by Git.' >&2
	exit 1
fi

if rg -n -i \
	'CREATE[[:space:]]+(LOCAL[[:space:]]+|GLOBAL[[:space:]]+)?TEMP(ORARY)?[[:space:]]+TABLE' \
	apps/*/prisma/migrations/*/migration.sql; then
	echo 'A Prisma migration requires the intentionally revoked database TEMP privilege.' >&2
	exit 1
fi

node - <<'NODE'
const {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync
} = require('node:fs');

const exactFiles = (directory, expected) => {
	const actual = readdirSync(directory, { withFileTypes: true })
		.filter(entry => entry.isFile())
		.map(entry => entry.name)
		.sort();
	const wanted = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
		throw new Error(`${directory} file set drifted: ${actual.join(',')}`);
	}
};

const compose = readFileSync('deploy/docker-compose.prod.yml', 'utf8');
const serviceBlock = compose.slice(
	compose.indexOf('\nservices:\n') + '\nservices:\n'.length,
	compose.indexOf('\nvolumes:\n')
);
const services = [...serviceBlock.matchAll(/^  ([a-z0-9][a-z0-9-]*):$/gm)]
	.map(match => match[1]);
const retiredServices = [
	'api',
	'outbox-publisher',
	'integration-worker',
	'maintenance-worker',
	'database-restore-worker',
	'migrate'
];
for (const service of retiredServices) {
	if (services.includes(service)) {
		throw new Error(`retired Compose service remains: ${service}`);
	}
}
for (const service of [
	'api-gateway',
	'rabbitmq',
	'notification-delivery-worker',
	'campaigns-service',
	'reporting-service',
	'widgets-service',
	'billing-api',
	'billing-scheduler',
	'billing-worker',
	'billing-outbox-publisher',
	'identity-api',
	'identity-worker',
	'identity-outbox-publisher',
	'platform-api',
	'platform-outbox-publisher',
	'support-api',
	'support-worker',
	'support-outbox-publisher',
	'operations-api',
	'operations-worker',
	'operations-outbox-publisher',
	'operations-restore-worker'
]) {
	if (!services.includes(service)) {
		throw new Error(`persistent service is missing: ${service}`);
	}
}
if (
	/(?:^|\W):4200(?:\W|$)/.test(compose) ||
	/\b[A-Z0-9_]*CORE_[A-Z0-9_]*\b/.test(compose)
) {
	throw new Error('Compose contains a retired Core endpoint or env key');
}

const routeManifest = path => {
	const line = readFileSync(path, 'utf8')
		.split(/\r?\n/)
		.find(value => value.startsWith('GATEWAY_ROUTES_JSON='));
	if (!line) throw new Error(`${path} has no Gateway route manifest`);
	return JSON.parse(line.slice(line.indexOf('=') + 1));
};
const rootRoutes = routeManifest('.env.example');
const gatewayRoutes = routeManifest('apps/api-gateway/.env.example');
for (const routes of [rootRoutes, gatewayRoutes]) {
	if (routes.length !== 43) {
		throw new Error('Gateway route count must be 43');
	}
	if (
		routes.filter(
			route => route.upstreamUrl === 'http://127.0.0.1:5200'
		).length !== 8
	) {
		throw new Error('Operations route count must be 8');
	}
	if (
		routes.some(
			route =>
				route.upstreamUrl.includes(':4200') ||
				route.pathPrefix === '/api/v1'
		)
	) {
		throw new Error('retired Core/catch-all Gateway route remains');
	}
}
if (JSON.stringify(rootRoutes) !== JSON.stringify(gatewayRoutes)) {
	throw new Error('root and Gateway route examples drifted');
}

const apps = [
	'api-gateway',
	'notification-delivery',
	'campaigns',
	'reporting',
	'widgets',
	'billing',
	'identity',
	'platform',
	'support',
	'operations'
];
for (const app of apps) {
	for (const file of [
		'package.json',
		'pnpm-lock.yaml',
		'Dockerfile',
		'.env.example',
		'.gitignore',
		'README.md'
	]) {
		const path = `apps/${app}/${file}`;
		if (!existsSync(path) || !lstatSync(path).isFile()) {
			throw new Error(`missing app-owned file: ${path}`);
		}
	}
}

const operationsPackage = JSON.parse(
	readFileSync('apps/operations/package.json', 'utf8')
);
const operationsControlLedgerGate =
	'apps/operations/test/integration/database-restore-control-ledger-postgres18.integration.mjs';
const operationsRestoreRehearsal =
	'apps/operations/test/integration/database-restore-postgres18.rehearsal.mjs';
if (
	!existsSync(operationsControlLedgerGate) ||
	!lstatSync(operationsControlLedgerGate).isFile() ||
	operationsPackage.scripts?.['test:integration:restore-control-ledger'] !==
		'node test/integration/database-restore-control-ledger-postgres18.integration.mjs'
) {
	throw new Error('Operations PostgreSQL 18 control-ledger gate is missing');
}
if (
	!existsSync(operationsRestoreRehearsal) ||
	!lstatSync(operationsRestoreRehearsal).isFile() ||
	operationsPackage.scripts?.['test:integration:restore-rehearsal'] !==
		'node test/integration/database-restore-postgres18.rehearsal.mjs'
) {
	throw new Error('Operations PostgreSQL 18 restore rehearsal is missing');
}
for (const script of [
	'cutover:status',
	'cutover:import',
	'cutover:activate',
	'control-plane:bootstrap'
]) {
	if (Object.hasOwn(operationsPackage.scripts ?? {}, script)) {
		throw new Error(`retired Operations package script remains: ${script}`);
	}
}

const operationsSchema = readFileSync(
	'apps/operations/prisma/schema.prisma',
	'utf8'
);
for (const retiredState of [
	'OperationsOwnershipState',
	'OperationsControlPlaneBootstrapState',
	'OperationsDatabasePhase'
]) {
	if (operationsSchema.includes(retiredState)) {
		throw new Error(`retired Operations state remains: ${retiredState}`);
	}
}
for (const currentIdentityField of [
	'model ServiceIdentity',
	'@map("service_name")',
	'@map("database_id")'
]) {
	if (!operationsSchema.includes(currentIdentityField)) {
		throw new Error(
			`Operations database identity is missing: ${currentIdentityField}`
		);
	}
}

for (const app of ['billing', 'identity']) {
	const schema = readFileSync(`apps/${app}/prisma/schema.prisma`, 'utf8');
	for (const retiredState of [
		'ServiceDatabasePhase',
		'ownershipGeneration',
		'sourceFingerprint',
		'importedAt',
		'activatedAt'
	]) {
		if (schema.includes(retiredState)) {
			throw new Error(
				`retired ${app} database activation state remains: ${retiredState}`
			);
		}
	}
	for (const currentIdentityField of [
		'model ServiceIdentity',
		'@map("service_name")',
		'@map("database_id")',
		'@unique(map: "service_identity_database_id_key")'
	]) {
		if (!schema.includes(currentIdentityField)) {
			throw new Error(
				`${app} database identity is missing: ${currentIdentityField}`
			);
		}
	}
}

const databaseActivationCleanupMigrations = {
	billing: readFileSync(
		'apps/billing/prisma/migrations/20260827020000_remove_legacy_ownership_state/migration.sql',
		'utf8'
	),
	identity: readFileSync(
		'apps/identity/prisma/migrations/20260827020000_remove_legacy_ownership_state/migration.sql',
		'utf8'
	)
};

const unroutableBillingEventCleanup = readFileSync(
	'apps/billing/prisma/migrations/20260827040000_remove_unroutable_billing_detail_events/migration.sql',
	'utf8'
);
for (const statement of [
	'DELETE FROM "billing"."outbox_events"',
	'"status" IN (',
	"'PENDING'::\"billing\".\"OutboxStatus\"",
	"'PROCESSING'::\"billing\".\"OutboxStatus\"",
	"\"event_type\" = 'billing.payment.details.changed.v1'",
	"\"routing_key\" = 'billing.payment.details.changed.v1'",
	"\"event_type\" = 'billing.subscription.details.changed.v1'",
	"\"routing_key\" = 'billing.subscription.details.changed.v1'"
]) {
	if (!unroutableBillingEventCleanup.includes(statement)) {
		throw new Error(`Billing unroutable event cleanup drifted: ${statement}`);
	}
}

for (const statement of [
	'DROP TABLE "billing"."billing_ownership_marker"',
	'DROP FUNCTION "billing"."enforce_ownership_forward_only"()',
	'DROP FUNCTION "billing"."enforce_service_identity"()',
	'DROP TYPE "billing"."BillingOwnershipPhase"',
	'DROP TYPE "billing"."ServiceDatabasePhase"',
	'CREATE UNIQUE INDEX "service_identity_database_id_key"'
]) {
	if (!databaseActivationCleanupMigrations.billing.includes(statement)) {
		throw new Error(`Billing database cleanup migration drifted: ${statement}`);
	}
}
for (const statement of [
	'DROP TYPE "identity"."ServiceDatabasePhase"',
	'ADD CONSTRAINT "service_identity_singleton_check"',
	'CREATE UNIQUE INDEX "service_identity_database_id_key"'
]) {
	if (!databaseActivationCleanupMigrations.identity.includes(statement)) {
		throw new Error(`Identity database cleanup migration drifted: ${statement}`);
	}
}

const billingRuntime = [
	'apps/billing/src/messaging/billing-worker.service.ts',
	'apps/billing/src/provider/billing-provider-worker.service.ts',
	'apps/billing/src/scheduler/billing-scheduler.service.ts'
]
	.map(path => readFileSync(path, 'utf8'))
	.join('\n');
if (
	billingRuntime.includes('billingOwnershipMarker') ||
	billingRuntime.includes('ownershipActive')
) {
	throw new Error('retired Billing database activation gate remains');
}

const identityRuntime = [
	'apps/identity/src/avatar/avatar-cleanup.service.ts',
	'apps/identity/src/health/identity-health.service.ts',
	'apps/identity/src/messaging/destination-worker.service.ts',
	'apps/identity/src/messaging/outbox-publisher.service.ts',
	'apps/identity/src/runtime/identity-housekeeping.service.ts'
]
	.map(path => readFileSync(path, 'utf8'))
	.join('\n');
if (
	identityRuntime.includes('IdentityOwnership') ||
	identityRuntime.includes('health/ownership')
) {
	throw new Error('retired Identity database activation gate remains');
}

for (const app of apps) {
	const appPackage = JSON.parse(
		readFileSync(`apps/${app}/package.json`, 'utf8')
	);
	const localStart = appPackage.scripts?.['start:local'];
	if (typeof localStart === 'string' && localStart.includes('../../.env')) {
		throw new Error(`service reads the retired root env: ${app}`);
	}
}

for (const path of [
	'src',
	'prisma',
	'Dockerfile',
	'docker-entrypoint.sh',
	'database-restore-entrypoint.sh',
	'nest-cli.json',
	'tsconfig.json',
	'tsconfig.build.json',
	'deploy/nginx.conf',
	'deploy/telegram-bridge',
	'apps/billing/src/cutover',
	'apps/billing/src/cutover-main.ts',
	'apps/identity/src/cutover',
	'apps/identity/src/runtime/identity-ownership.service.ts',
	'apps/operations/src/cutover',
	'apps/platform/src/cutover',
	'apps/support/src/cutover',
	'apps/widgets/src/cutover-main.ts'
]) {
	if (existsSync(path)) {
		throw new Error(`retired runtime artifact remains: ${path}`);
	}
}

exactFiles('scripts', ['generate-jwt-keyset.mjs', 'test-workers-bootstrap-recovery.mjs']);
exactFiles('.github/workflows', ['ci.yml']);
exactFiles('.github/scripts', [
	'static-check-services-lifecycle.sh',
	'validate-production-compose.cjs',
	'validate-production-compose.sh',
	'verify-production-audit.cjs'
]);
exactFiles('deploy', ['docker-compose.prod.yml']);

const servicesWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const pinnedInfraRevision =
	'd3e8d5a6dc0cca058d1696b8718b2e839d029dde';
for (const evidence of [
	"cancel-in-progress: ${{ github.ref != 'refs/heads/prod' }}",
	'operations-control-ledger:',
	'--label winwidget.operations-control-ledger=true',
	'      - name: Run control-ledger negative SQL matrix\n        env:\n          OPERATIONS_CONTROL_LEDGER_POSTGRES_CONTAINER_ID: ${{ job.services.postgres.id }}',
	'pnpm --dir apps/operations run test:integration:restore-control-ledger',
	'operations-restore-rehearsal:',
	'--label winwidget.operations-restore-rehearsal=true',
	'      - name: Run isolated restore rehearsal\n        env:\n          OPERATIONS_RESTORE_REHEARSAL_POSTGRES_CONTAINER_ID: ${{ job.services.postgres.id }}',
	'pnpm --dir apps/operations run test:integration:restore-rehearsal',
	'deploy-production:',
	'needs:',
	'- lifecycle-contract',
	'- operations-control-ledger',
	'- operations-restore-rehearsal',
	'- production-image',
	'- service',
	'- service-integration',
	'- widgets-integration',
	"if: github.event_name == 'push' && github.ref == 'refs/heads/prod'",
	`uses: nda17/winwidget.ru_infra/.github/workflows/deploy-production.yml@${pinnedInfraRevision}`,
	'services_revision: ${{ github.sha }}',
	'BACKEND_PRODUCTION_SSH_HOST: ${{ secrets.PRODUCTION_SSH_HOST }}',
	'BACKEND_PRODUCTION_SSH_PORT: ${{ secrets.PRODUCTION_SSH_PORT }}',
	'BACKEND_PRODUCTION_SSH_USER: ${{ secrets.PRODUCTION_SSH_USER }}',
	'BACKEND_PRODUCTION_SSH_PRIVATE_KEY: ${{ secrets.PRODUCTION_SSH_PRIVATE_KEY }}',
	'BACKEND_PRODUCTION_SSH_KNOWN_HOSTS: ${{ secrets.BACKEND_PRODUCTION_SSH_KNOWN_HOSTS }}',
	'BACKEND_PRODUCTION_ENV_SHA256: ${{ secrets.BACKEND_PRODUCTION_ENV_SHA256 }}'
]) {
	if (!servicesWorkflow.includes(evidence)) {
		throw new Error(`production release workflow drifted: ${evidence}`);
	}
}
if (
	servicesWorkflow.includes('workflow_dispatch:') ||
	servicesWorkflow.includes('secrets: inherit') ||
	servicesWorkflow.includes('FRONTEND_PRODUCTION_') ||
	servicesWorkflow.includes(
		'nda17/winwidget.ru_infra/.github/workflows/deploy-production.yml@master'
	) ||
	servicesWorkflow.includes(
		'nda17/winwidget.ru_infra/.github/workflows/deploy-production.yml@prod'
	)
) {
	throw new Error(
		'production release workflow exposes a mutable, manual, inherited-secret, or frontend path'
	);
}
const infraReleaseReferences = [
	...servicesWorkflow.matchAll(
		/uses: nda17\/winwidget\.ru_infra\/\.github\/workflows\/deploy-production\.yml@([0-9a-f]{40})/g
	)
];
if (
	infraReleaseReferences.length !== 1 ||
	infraReleaseReferences.some(reference => reference[1] !== pinnedInfraRevision)
) {
	throw new Error('the worker-only production job must use the exact reviewed infra SHA');
}
const workersJob = servicesWorkflow.split('  deploy-production:\n')[1];
if (!workersJob || (servicesWorkflow.match(/release_scope:/g) ?? []).length !== 1 || servicesWorkflow.includes('operations-federation-config') || servicesWorkflow.includes('deploy-worker-recovery:')) {
	throw new Error('production must contain only the reviewed worker scope; completed federation correction cannot repeat');
}
for (const [job, evidence] of [
	[workersJob, 'needs:\n      - lifecycle-contract\n      - operations-control-ledger\n      - operations-restore-rehearsal\n      - production-image\n      - service\n      - service-integration\n      - widgets-integration\n'],
	[workersJob, 'release_scope: workers-bootstrap-recovery'],
	[workersJob, "expected_service_env_sha256: '649c987a3c9ea2cba281f801482a5e98a73e53739885e4f9a7eaff17994bb6f7'"],
	[workersJob, "expected_operations_revision: '484e546451088671e23ae37ae4026b9b3fe500c5'"],
	[workersJob, "expected_operations_env_sha256: '06f1affe7b715a3c2d96d2a00975fab168e2060623a8af72d33c62bb4055799e'"],
	[workersJob, "expected_support_env_sha256: 'df539741905bc3c5dc925accce98334de37e33cde5c6021db98806c691ba678d'"]
]) {
	if (!job.includes(evidence)) throw new Error(`scoped release boundary drifted: ${evidence}`);
}
for (const job of [workersJob]) {
	for (const evidence of [
		"if: github.event_name == 'push' && github.ref == 'refs/heads/prod'",
		"expected_live_revision: '484e546451088671e23ae37ae4026b9b3fe500c5'",
		'services_revision: ${{ github.sha }}'
	]) if (!job.includes(evidence)) throw new Error(`scoped release identity drifted: ${evidence}`);
}

const rootReadme = readFileSync('README.md', 'utf8');
if (
	rootReadme.includes('Архив прежней документации') ||
	rootReadme.includes('Исторический WinWidget backend')
) {
	throw new Error('retired monolith README archive remains');
}

process.stdout.write('apps_only_static_contract=passed\n');
NODE
