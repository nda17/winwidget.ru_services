import { Logger, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SupportHttpExceptionFilter } from './common/support-http-exception.filter';
import { supportRequestContextMiddleware } from './common/support-request-context';
import {
	getSupportCorsAllowedOrigins,
	getSupportListenHost,
	getSupportTrustProxyConfig
} from './runtime/support-http.config';
import {
	parseSupportPort,
	parseSupportProcessRole
} from './runtime/support-runtime.service';
import { SupportModule } from './support.module';
import { SUPPORT_WEBHOOK_MAX_BYTES } from './telegram/support-telegram.types';

async function bootstrap(): Promise<void> {
	const role = parseSupportProcessRole(process.env.SUPPORT_PROCESS_ROLE);
	const app = await NestFactory.create<NestExpressApplication>(
		SupportModule,
		{
			forceCloseConnections: true,
			rawBody: true
		}
	);
	app.useBodyParser('json', { limit: SUPPORT_WEBHOOK_MAX_BYTES });
	const instance = app.getHttpAdapter().getInstance();
	if (typeof instance?.set === 'function') {
		instance.set(
			'trust proxy',
			getSupportTrustProxyConfig(process.env.TRUST_PROXY)
		);
	}
	app.setGlobalPrefix('api/v1', {
		exclude: [
			{ path: 'health/live', method: RequestMethod.GET },
			{ path: 'health/ready', method: RequestMethod.GET },
			{
				path: 'internal/v1/support/messaging/overview',
				method: RequestMethod.GET
			}
		]
	});
	app.use(supportRequestContextMiddleware);
	if (role === 'api') {
		app.enableCors({
			origin: getSupportCorsAllowedOrigins(
				process.env.MODE,
				process.env.CORS_ALLOWED_ORIGINS
			),
			credentials: true,
			exposedHeaders:
				'set-cookie, x-request-id, x-correlation-id, x-winwidget-service'
		});
	}
	app.useGlobalFilters(new SupportHttpExceptionFilter());
	app.enableShutdownHooks();
	await app.listen(
		parseSupportPort(role),
		getSupportListenHost(process.env.MODE, process.env.SUPPORT_LISTEN_HOST)
	);
	Logger.log(`Support service started role=${role}`, 'Bootstrap');
}

void bootstrap().catch(error => {
	Logger.error(
		error instanceof Error ? error.message : 'Support bootstrap failed',
		undefined,
		'Bootstrap'
	);
	process.exitCode = 1;
});
