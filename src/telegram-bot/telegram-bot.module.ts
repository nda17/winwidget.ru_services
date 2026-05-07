import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { PrismaService } from '@/prisma.service';
import { TelegramBotController } from '@/telegram-bot/telegram-bot.controller';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AdminEventLogModule],
	controllers: [TelegramBotController],
	providers: [TelegramBotService, PrismaService],
	exports: [TelegramBotService]
})
export class TelegramBotModule {}
