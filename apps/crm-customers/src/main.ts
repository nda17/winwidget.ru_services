import { Logger, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseCrmCustomersCorsAllowedOrigins } from './config/crm-customers-cors.config';
import { CrmCustomersModule } from './crm-customers.module';
import {
	parseCrmCustomersListenHost,
	parseCrmCustomersPort
} from './runtime/crm-customers-runtime.config';

async function bootstrap(): Promise<void> {
	const host = parseCrmCustomersListenHost(
		process.env.CRM_CUSTOMERS_LISTEN_HOST,
		process.env.MODE
	);
	const port = parseCrmCustomersPort(process.env.CRM_CUSTOMERS_PORT);
	const origins = parseCrmCustomersCorsAllowedOrigins(
		process.env.CORS_ALLOWED_ORIGINS
	);
	const app = await NestFactory.create<NestExpressApplication>(
		CrmCustomersModule,
		{ forceCloseConnections: true }
	);

	app.setGlobalPrefix('api/v1', {
		exclude: [
			{ path: 'health/live', method: RequestMethod.GET },
			{ path: 'health/ready', method: RequestMethod.GET },
			{ path: 'health/revision', method: RequestMethod.GET }
		]
	});
	app.enableCors({
		origin: origins,
		credentials: true,
		exposedHeaders: 'set-cookie, x-request-id, x-correlation-id'
	});
	app.enableShutdownHooks();
	await app.listen(port, host);
	Logger.log(
		`CRM Customers started host=${host} port=${port}`,
		'Bootstrap'
	);
}

void bootstrap().catch(error => {
	Logger.error(
		error instanceof Error
			? error.message
			: 'CRM Customers bootstrap failed',
		undefined,
		'Bootstrap'
	);
	process.exitCode = 1;
});
