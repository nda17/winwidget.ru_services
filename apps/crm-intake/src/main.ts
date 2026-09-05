import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseCrmIntakeCorsAllowedOrigins } from './config/crm-intake-cors.config';
import { CrmIntakeModule } from './crm-intake.module';
import { intakeProcessRole } from './acceptance/acceptance.messaging';
import { configureCrmIntakeBodyParser } from './config/crm-intake-body-parser';
import {
	parseCrmIntakeListenHost,
	parseCrmIntakePort
} from './runtime/crm-intake-runtime.config';

async function bootstrap(): Promise<void> {
	const host = parseCrmIntakeListenHost(
		process.env.CRM_INTAKE_LISTEN_HOST,
		process.env.MODE
	);
	const port = parseCrmIntakePort(
		process.env.CRM_INTAKE_PORT,
		intakeProcessRole()
	);
	const origins = parseCrmIntakeCorsAllowedOrigins(
		process.env.CORS_ALLOWED_ORIGINS
	);
	const app = await NestFactory.create<NestExpressApplication>(
		CrmIntakeModule,
		{ forceCloseConnections: true }
	);
	configureCrmIntakeBodyParser(app);
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
	Logger.log(`CRM Intake started host=${host} port=${port}`, 'Bootstrap');
}

void bootstrap().catch(error => {
	Logger.error(
		error instanceof Error ? error.message : 'CRM Intake bootstrap failed',
		undefined,
		'Bootstrap'
	);
	process.exitCode = 1;
});
