import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OperationsHttpExceptionFilter } from './common/operations-http-exception.filter';
import { operationsRequestContextMiddleware } from './common/operations-request-context';
import { OperationsModule } from './operations.module';
import {
	getOperationsCorsAllowedOrigins,
	getOperationsListenHost,
	getOperationsTrustProxyConfig,
	OPERATIONS_GLOBAL_PREFIX_EXCLUDES
} from './runtime/operations-http.config';
import {
	parseOperationsPort,
	parseOperationsProcessRole
} from './runtime/operations-runtime.service';

async function bootstrap(): Promise<void> {
	const role = parseOperationsProcessRole(
		process.env.OPERATIONS_PROCESS_ROLE
	);
	const port = parseOperationsPort(role);
	const app = await NestFactory.create(OperationsModule, {
		forceCloseConnections: true
	});
	const instance = app.getHttpAdapter().getInstance();
	if (typeof instance?.set === 'function') {
		instance.set(
			'trust proxy',
			getOperationsTrustProxyConfig(process.env.TRUST_PROXY)
		);
	}
	app.setGlobalPrefix('api/v1', {
		exclude: [...OPERATIONS_GLOBAL_PREFIX_EXCLUDES]
	});
	app.use(operationsRequestContextMiddleware);
	if (role === 'api') {
		app.enableCors({
			origin: getOperationsCorsAllowedOrigins(
				process.env.MODE,
				process.env.CORS_ALLOWED_ORIGINS
			),
			credentials: true,
			exposedHeaders:
				'set-cookie, x-request-id, x-correlation-id, x-winwidget-service'
		});
	}
	app.useGlobalFilters(new OperationsHttpExceptionFilter());
	app.enableShutdownHooks();
	const listenHost = getOperationsListenHost(
		process.env.MODE,
		process.env.OPERATIONS_LISTEN_HOST
	);
	await app.listen(port, listenHost);
	Logger.log(
		`Operations service started port=${port} role=${role}`,
		'Bootstrap'
	);
}

void bootstrap().catch(error => {
	Logger.error('Operations bootstrap failed', undefined, 'Bootstrap');
	void error;
	process.exitCode = 1;
});
