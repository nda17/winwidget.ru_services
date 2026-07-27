import { DatabaseBackupService } from '@/maintenance/database-backup.service';
import { MaintenanceHealthController } from '@/maintenance/maintenance-health.controller';
import { MaintenanceHealthService } from '@/maintenance/maintenance-health.service';
import { MaintenanceSchedulerService } from '@/maintenance/maintenance-scheduler.service';
import { ScheduledTasksModule } from '@/maintenance/scheduled-tasks.module';
import { MaintenanceWorkerService } from '@/maintenance/maintenance-worker.service';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { RabbitMqModule } from '@/messaging/rabbitmq.module';
import { PrismaModule } from '@/prisma.module';
import { PrismaService } from '@/prisma.service';
import { TelegramInfoTransportModule } from '@/telegram-bot/telegram-info-transport.module';
import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		PrismaModule,
		RabbitMqModule,
		ScheduledTasksModule,
		TelegramInfoTransportModule
	],
	controllers: [MaintenanceHealthController],
	providers: [
		MessagingHeartbeatService,
		DatabaseBackupService,
		MaintenanceHealthService,
		MaintenanceSchedulerService,
		MaintenanceWorkerService
	]
})
export class MaintenanceWorkerModule implements OnApplicationShutdown {
	constructor(private readonly prisma: PrismaService) {}

	onApplicationShutdown() {
		return this.prisma.disconnect();
	}
}
