import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CrmAccessModule } from './crm-access.module';
import { CrmAccessHttpExceptionFilter } from './common/crm-access-http-exception.filter';
import { crmAccessRequestContextMiddleware } from './common/crm-access-request-context';
import {
	getCrmAccessCorsAllowedOrigins,
	getCrmAccessListenHost,
	getCrmAccessTrustProxyConfig
} from './runtime/crm-access-http.config';
import { CrmAccessRuntimeService } from './runtime/crm-access-runtime.service';

async function bootstrap(): Promise<void> {
	const app = await NestFactory.create(CrmAccessModule, {
		forceCloseConnections: true
	});
	const instance = app.getHttpAdapter().getInstance();
	if (typeof instance?.set === 'function') {
		instance.set(
			'trust proxy',
			getCrmAccessTrustProxyConfig(process.env.TRUST_PROXY)
		);
	}
	app.setGlobalPrefix('api/v1', {
		exclude: [
			{ path: 'health/live', method: RequestMethod.GET },
			{ path: 'health/ready', method: RequestMethod.GET },
			{
				path: 'internal/v1/crm-access/authorize',
				method: RequestMethod.POST
			},
			{
				path: 'internal/v1/crm-access/authorize-source',
				method: RequestMethod.POST
			}
		]
	});
	app.use(crmAccessRequestContextMiddleware);
	app.enableCors({
		origin: getCrmAccessCorsAllowedOrigins(
			process.env.MODE,
			process.env.CORS_ALLOWED_ORIGINS
		),
		credentials: true,
		exposedHeaders: 'x-correlation-id, x-winwidget-service'
	});
	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			forbidUnknownValues: true,
			transform: true
		})
	);
	app.useGlobalFilters(new CrmAccessHttpExceptionFilter());
	app.enableShutdownHooks();
	const runtime = app.get(CrmAccessRuntimeService);
	await app.listen(
		runtime.port,
		getCrmAccessListenHost(
			process.env.MODE,
			process.env.CRM_ACCESS_LISTEN_HOST
		)
	);
	Logger.log(
		`CRM Access service started port=${runtime.port}`,
		'Bootstrap'
	);
}

void bootstrap().catch(error => {
	Logger.error(
		error instanceof Error ? error.message : 'CRM Access bootstrap failed',
		undefined,
		'Bootstrap'
	);
	process.exitCode = 1;
});
