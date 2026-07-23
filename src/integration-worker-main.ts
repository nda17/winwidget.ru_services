import { IntegrationWorkerModule } from '@/messaging/integration-worker.module';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

async function bootstrap() {
	const app = await NestFactory.createApplicationContext(
		IntegrationWorkerModule
	);
	app.enableShutdownHooks();
	Logger.log('Integration worker started', 'Bootstrap');
}

void bootstrap();
