import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { AuthModule } from '@/auth/auth.module';
import { EmailModule } from '@/email/email.module';
import { MailingController } from '@/mailing/mailing.controller';
import { MailingService } from '@/mailing/mailing.service';
import { PrismaService } from '@/prisma.service';
import { TelegramBotModule } from '@/telegram-bot/telegram-bot.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AuthModule,
		EmailModule,
		AdminEventLogModule,
		TelegramBotModule
	],
	controllers: [MailingController],
	providers: [MailingService, PrismaService]
})
export class MailingModule {}
