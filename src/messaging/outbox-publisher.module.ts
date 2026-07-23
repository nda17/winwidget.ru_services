import { OutboxPublisherService } from '@/messaging/outbox-publisher.service';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { RabbitMqModule } from '@/messaging/rabbitmq.module';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true
		}),
		RabbitMqModule
	],
	providers: [
		PrismaService,
		MessagingHeartbeatService,
		OutboxPublisherService
	]
})
export class OutboxPublisherModule {}
