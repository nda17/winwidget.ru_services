import { Logger, RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BillingModule } from './billing.module';
import { BillingHttpExceptionFilter } from './common/billing-http-exception.filter';
import { billingRequestContextMiddleware } from './common/billing-request-context';
import { terminateFailedBootstrap } from './runtime/bootstrap-failure';
import {
	parseBillingPort,
	parseBillingProcessRole
} from './runtime/billing-runtime.service';
import {
	getBillingCorsAllowedOrigins,
	getBillingListenHost,
	getBillingTrustProxyConfig
} from './runtime/billing-http.config';

let application: INestApplication | undefined;

async function bootstrap(): Promise<void> {
	const role = parseBillingProcessRole(process.env.BILLING_PROCESS_ROLE);
	const port = parseBillingPort(role);
	const app = await NestFactory.create(BillingModule, {
		forceCloseConnections: true
	});
	application = app;
	const instance = app.getHttpAdapter().getInstance();
	if (typeof instance?.set === 'function') {
		instance.set(
			'trust proxy',
			getBillingTrustProxyConfig(process.env.TRUST_PROXY)
		);
	}
	app.setGlobalPrefix('api/v1', {
		exclude: [
			{ path: 'health/live', method: RequestMethod.GET },
			{ path: 'health/ready', method: RequestMethod.GET },
			{
				path: 'internal/v1/identity/billing/users/revoke-entitlements',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/identity/billing/trials/ensure',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/identity/billing/users/:userId/admin-overview',
				method: RequestMethod.GET
			},
			{
				path: 'internal/v1/identity/billing/directory/subscription-user-ids',
				method: RequestMethod.GET
			},
			{
				path: 'internal/v1/billing/campaigns/active-subscriber-ids',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/operations/billing/admin-alerts',
				method: RequestMethod.GET
			},
			{
				path: 'internal/v1/operations/billing/messaging/overview',
				method: RequestMethod.GET
			},
			{
				path: 'internal/v1/operations/billing/messaging/failures',
				method: RequestMethod.GET
			},
			{
				path: 'internal/v1/operations/billing/messaging/failures/:id/retry',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/operations/billing/messaging/failures/:id/close',
				method: RequestMethod.POST
			}
		]
	});
	app.use(billingRequestContextMiddleware);
	if (role === 'api') {
		app.enableCors({
			origin: getBillingCorsAllowedOrigins(
				process.env.MODE,
				process.env.CORS_ALLOWED_ORIGINS
			),
			credentials: true,
			exposedHeaders: 'set-cookie, x-request-id, x-correlation-id'
		});
	}
	app.useGlobalFilters(new BillingHttpExceptionFilter());
	app.enableShutdownHooks();
	const listenHost = getBillingListenHost(
		process.env.MODE,
		process.env.BILLING_LISTEN_HOST
	);
	await app.listen(port, listenHost);
	Logger.log(
		`Billing service started port=${port} role=${role}`,
		'Bootstrap'
	);
}

void bootstrap().catch(() => {
	Logger.error('Billing bootstrap failed', undefined, 'Bootstrap');
	return terminateFailedBootstrap(application);
});
