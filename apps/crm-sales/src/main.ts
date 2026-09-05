import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EXPORT_EXPOSE_HEADERS } from './exports/export-format';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseCrmSalesCorsAllowedOrigins } from './config/crm-sales-cors.config';
import { CrmSalesModule } from './crm-sales.module';
import {
	parseCrmSalesListenHost,
	parseCrmSalesPort
} from './runtime/crm-sales-runtime.config';

async function bootstrap(): Promise<void> {
	const host = parseCrmSalesListenHost(
		process.env.CRM_SALES_LISTEN_HOST,
		process.env.MODE
	);
	const port = parseCrmSalesPort(process.env.CRM_SALES_PORT);
	const origins = parseCrmSalesCorsAllowedOrigins(
		process.env.CORS_ALLOWED_ORIGINS
	);
	const app = await NestFactory.create<NestExpressApplication>(
		CrmSalesModule,
		{ forceCloseConnections: true }
	);

	app.setGlobalPrefix('api/v1', {
		exclude: [
			...['execute', 'read', 'close'].map(action => ({
				path: `internal/v1/crm-sales/intake-operations/${action}`,
				method: RequestMethod.POST
			})),
			{ path: 'health/live', method: RequestMethod.GET },
			{ path: 'health/ready', method: RequestMethod.GET },
			{ path: 'health/revision', method: RequestMethod.GET },
			{
				path: 'internal/v1/crm-access/pipelines/install-template',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/crm-access/pipelines/workspaces/:workspaceId/installation',
				method: RequestMethod.GET
			}
		]
	});
	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			forbidUnknownValues: true,
			transform: true
		})
	);
	app.enableCors({
		origin: origins,
		credentials: true,
		exposedHeaders:
			'set-cookie, x-request-id, x-correlation-id, ' +
			EXPORT_EXPOSE_HEADERS
	});
	app.enableShutdownHooks();
	await app.listen(port, host);
	Logger.log(`CRM Sales started host=${host} port=${port}`, 'Bootstrap');
}

void bootstrap().catch(error => {
	Logger.error(
		error instanceof Error ? error.message : 'CRM Sales bootstrap failed',
		undefined,
		'Bootstrap'
	);
	process.exitCode = 1;
});
