import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { MessagingAdminController } from '@/messaging/messaging-admin.controller';
import { MessagingAdminService } from '@/messaging/messaging-admin.service';
import { MessagingOperationalAlertService } from '@/messaging/messaging-operational-alert.service';
import { RabbitMqManagementModule } from '@/messaging/rabbitmq-management.module';
import { TelegramBotModule } from '@/telegram-bot/telegram-bot.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AdminEventLogModule,
		RabbitMqManagementModule,
		TelegramBotModule
	],
	controllers: [MessagingAdminController],
	providers: [MessagingAdminService, MessagingOperationalAlertService],
	exports: [MessagingAdminService]
})
export class MessagingAdminModule {}
