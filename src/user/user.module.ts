import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { EmailModule } from '@/email/email.module';
import { SmsModule } from '@/sms/sms.module';
import { TelegramBotModule } from '@/telegram-bot/telegram-bot.module';
import { UserController } from '@/user/user.controller';
import { UserIdentityBindingService } from '@/user/user-identity-binding.service';
import { UserService } from '@/user/user.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		EmailModule,
		SmsModule,
		AdminEventLogModule,
		TelegramBotModule
	],
	controllers: [UserController],
	providers: [UserService, UserIdentityBindingService],
	exports: [UserService]
})
export class UserModule {}
