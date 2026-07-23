import { OutboxPublisherModule } from '@/messaging/outbox-publisher.module';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

async function bootstrap() {
	const app = await NestFactory.createApplicationContext(
		OutboxPublisherModule
	);
	app.enableShutdownHooks();
	Logger.log('Outbox publisher started', 'Bootstrap');
}

void bootstrap();
