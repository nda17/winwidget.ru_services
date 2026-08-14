import { ReportingJsonLogger } from './common/reporting-json.logger';
import {
	isReportingCorsOriginAllowed,
	parseReportingCorsAllowedOrigins
} from './config/reporting-cors.config';
import {
	parseReportingListenHost,
	parseReportingPort
} from './config/reporting-network.config';
import { ReportingModule } from './reporting.module';
import { parseReportingProcessRole } from './runtime/reporting-runtime.service';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

async function bootstrap(): Promise<void> {
	const role = parseReportingProcessRole(
		process.env.REPORTING_PROCESS_ROLE
	);
	const host = parseReportingListenHost(
		process.env.REPORTING_LISTEN_HOST,
		process.env.NODE_ENV
	);
	const port = parseReportingPort(process.env.REPORTING_PORT);
	const app = await NestFactory.create(ReportingModule, {
		logger: new ReportingJsonLogger(),
		forceCloseConnections: true
	});
	if (role === 'all' || role === 'api') {
		const allowedOrigins = parseReportingCorsAllowedOrigins(
			process.env.CORS_ALLOWED_ORIGINS
		);
		app.enableCors({
			origin: (origin, callback) =>
				callback(
					null,
					isReportingCorsOriginAllowed(origin, allowedOrigins)
				),
			credentials: true,
			exposedHeaders: 'set-cookie, x-request-id, x-correlation-id'
		});
	}
	app.useGlobalPipes(
		new ValidationPipe({
			transform: true,
			whitelist: true,
			forbidNonWhitelisted: true,
			stopAtFirstError: false
		})
	);
	app.enableShutdownHooks();
	await app.listen(port, host);
	Logger.log(
		`Reporting service started host=${host} port=${port} role=${role}`,
		'Bootstrap'
	);
}

void bootstrap().catch(error => {
	new ReportingJsonLogger().fatal(error, 'Bootstrap');
	process.exitCode = 1;
});
