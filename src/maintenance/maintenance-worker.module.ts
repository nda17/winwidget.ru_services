import { DatabaseBackupService } from '@/maintenance/database-backup.service';
import { MaintenanceSchedulerService } from '@/maintenance/maintenance-scheduler.service';
import { ScheduledTasksModule } from '@/maintenance/scheduled-tasks.module';
import { MaintenanceWorkerService } from '@/maintenance/maintenance-worker.service';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { RabbitMqModule } from '@/messaging/rabbitmq.module';
import { TelegramInfoTransportModule } from '@/telegram-bot/telegram-info-transport.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		RabbitMqModule,
		ScheduledTasksModule,
		TelegramInfoTransportModule
	],
	providers: [
		MessagingHeartbeatService,
		DatabaseBackupService,
		MaintenanceSchedulerService,
		MaintenanceWorkerService
	]
})
export class MaintenanceWorkerModule {}
