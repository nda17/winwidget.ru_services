import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
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
	app.useBodyParser('json', { limit: '32kb' });
	app.useGlobalPipes(
		new ValidationPipe({
			transform: true,
			whitelist: true,
			forbidNonWhitelisted: true,
			validationError: { target: false, value: false }
		})
	);

	app.setGlobalPrefix('api/v1', {
		exclude: [
			{
				path: 'internal/v1/crm-customers/intake-operations/verify',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/crm-customers/intake-operations/execute',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/crm-customers/intake-operations/read',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/crm-customers/intake-operations/close',
				method: RequestMethod.POST
			},
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
