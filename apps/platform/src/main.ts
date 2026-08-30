import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PlatformHttpExceptionFilter } from './common/platform-http-exception.filter';
import { platformRequestContextMiddleware } from './common/platform-request-context';
import { PlatformModule } from './platform.module';
import {
	getPlatformCorsAllowedOrigins,
	getPlatformListenHost,
	getPlatformTrustProxyConfig,
	PLATFORM_JSON_BODY_LIMIT_BYTES,
	PLATFORM_GLOBAL_PREFIX_EXCLUDES
} from './runtime/platform-http.config';
import {
	parsePlatformPort,
	parsePlatformProcessRole
} from './runtime/platform-runtime.service';

async function bootstrap(): Promise<void> {
	const role = parsePlatformProcessRole(process.env.PLATFORM_PROCESS_ROLE);
	const port = parsePlatformPort(role);
	const app = await NestFactory.create<NestExpressApplication>(
		PlatformModule,
		{
			forceCloseConnections: true
		}
	);
	app.useBodyParser('json', { limit: PLATFORM_JSON_BODY_LIMIT_BYTES });
	const instance = app.getHttpAdapter().getInstance();
	if (typeof instance?.set === 'function') {
		instance.set(
			'trust proxy',
			getPlatformTrustProxyConfig(process.env.TRUST_PROXY)
		);
	}
	app.setGlobalPrefix('api/v1', {
		exclude: [...PLATFORM_GLOBAL_PREFIX_EXCLUDES]
	});
	app.use(platformRequestContextMiddleware);
	if (role === 'api') {
		app.enableCors({
			origin: getPlatformCorsAllowedOrigins(
				process.env.MODE,
				process.env.CORS_ALLOWED_ORIGINS
			),
			credentials: true,
			exposedHeaders:
				'set-cookie, x-request-id, x-correlation-id, x-winwidget-service'
		});
	}
	app.useGlobalFilters(new PlatformHttpExceptionFilter());
	app.enableShutdownHooks();
	const listenHost = getPlatformListenHost(
		process.env.MODE,
		process.env.PLATFORM_LISTEN_HOST
	);
	await app.listen(port, listenHost);
	Logger.log(
		`Platform service started port=${port} role=${role}`,
		'Bootstrap'
	);
}

void bootstrap().catch(error => {
	Logger.error(
		error instanceof Error ? error.message : 'Platform bootstrap failed',
		undefined,
		'Bootstrap'
	);
	process.exitCode = 1;
});
