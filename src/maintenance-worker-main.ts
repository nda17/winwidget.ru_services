import { parseMaintenanceHealthPort } from '@/maintenance/maintenance-health.service';
import { MaintenanceWorkerModule } from '@/maintenance/maintenance-worker.module';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const MAINTENANCE_HEALTH_HOST = '127.0.0.1';

async function bootstrap() {
	const healthPort = parseMaintenanceHealthPort(
		process.env.MAINTENANCE_HEALTH_PORT
	);
	const app = await NestFactory.create(MaintenanceWorkerModule);
	app.enableShutdownHooks();
	await app.listen(healthPort, MAINTENANCE_HEALTH_HOST);
	Logger.log(
		`Maintenance worker started; health endpoint=http://${MAINTENANCE_HEALTH_HOST}:${healthPort}`,
		'Bootstrap'
	);
}

void bootstrap();
