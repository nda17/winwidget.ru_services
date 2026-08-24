import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { BillingBoundaryModule } from '@/billing-boundary/billing-boundary.module';
import { BillingMessagingClientService } from '@/messaging/billing-messaging-client.service';
import { IdentityMessagingClientService } from '@/messaging/identity-messaging-client.service';
import { MessagingAdminController } from '@/messaging/messaging-admin.controller';
import { MessagingAdminService } from '@/messaging/messaging-admin.service';
import { MessagingOperationalAlertService } from '@/messaging/messaging-operational-alert.service';
import { PlatformMessagingClientService } from '@/messaging/platform-messaging-client.service';
import { NotificationDeliveryClientModule } from '@/messaging/notification-delivery-client.module';
import { RabbitMqManagementModule } from '@/messaging/rabbitmq-management.module';
import { ServiceOwnedMessagingOverviewClientService } from '@/messaging/service-owned-messaging-overview-client.service';
import { TelegramBotModule } from '@/telegram-bot/telegram-bot.module';
import { WidgetsDeliveryFailuresClientService } from '@/messaging/widgets-delivery-failures-client.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AdminEventLogModule,
		BillingBoundaryModule,
		NotificationDeliveryClientModule,
		RabbitMqManagementModule,
		TelegramBotModule
	],
	controllers: [MessagingAdminController],
	providers: [
		BillingMessagingClientService,
		IdentityMessagingClientService,
		PlatformMessagingClientService,
		WidgetsDeliveryFailuresClientService,
		ServiceOwnedMessagingOverviewClientService,
		MessagingAdminService,
		MessagingOperationalAlertService
	],
	exports: [MessagingAdminService]
})
export class MessagingAdminModule {}
