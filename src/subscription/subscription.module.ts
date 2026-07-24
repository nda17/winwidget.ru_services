import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { AuthModule } from '@/auth/auth.module';
import { EmailModule } from '@/email/email.module';
import { SubscriptionExpiryService } from '@/subscription/subscription-expiry.service';
import { SubscriptionController } from '@/subscription/subscription.controller';
import { SubscriptionService } from '@/subscription/subscription.service';
import { TelegramBotModule } from '@/telegram-bot/telegram-bot.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AuthModule,
		AdminEventLogModule,
		EmailModule,
		TelegramBotModule
	],
	controllers: [SubscriptionController],
	providers: [SubscriptionService, SubscriptionExpiryService],
	exports: [SubscriptionService]
})
export class SubscriptionModule {}
