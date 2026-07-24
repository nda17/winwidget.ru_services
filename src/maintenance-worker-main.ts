import { MaintenanceWorkerModule } from '@/maintenance/maintenance-worker.module';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

async function bootstrap() {
	const app = await NestFactory.createApplicationContext(
		MaintenanceWorkerModule
	);
	app.enableShutdownHooks();
	Logger.log('Maintenance worker started', 'Bootstrap');
}

void bootstrap();
