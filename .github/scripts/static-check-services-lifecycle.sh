#!/usr/bin/env bash

set -euo pipefail

bash -n .github/scripts/validate-production-compose.sh
node --check .github/scripts/validate-production-compose.cjs

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

if git ls-files | rg '(^|/)\.env\.production$'; then
	echo 'A production env file is tracked by Git.' >&2
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
	'apps/platform/src/cutover',
	'apps/support/src/cutover',
	'apps/widgets/src/cutover-main.ts'
]) {
	if (existsSync(path)) {
		throw new Error(`retired runtime artifact remains: ${path}`);
	}
}

exactFiles('scripts', ['generate-jwt-keyset.mjs']);
exactFiles('.github/workflows', ['ci.yml']);
exactFiles('.github/scripts', [
	'static-check-services-lifecycle.sh',
	'validate-production-compose.cjs',
	'validate-production-compose.sh'
]);
exactFiles('deploy', ['docker-compose.prod.yml']);

const rootReadme = readFileSync('README.md', 'utf8');
if (
	rootReadme.includes('Архив прежней документации') ||
	rootReadme.includes('Исторический WinWidget backend')
) {
	throw new Error('retired monolith README archive remains');
}

process.stdout.write('apps_only_static_contract=passed\n');
NODE
