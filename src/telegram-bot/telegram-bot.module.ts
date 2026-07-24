import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { ScheduledTasksModule } from '@/maintenance/scheduled-tasks.module';
import { PrismaService } from '@/prisma.service';
import { TelegramBotController } from '@/telegram-bot/telegram-bot.controller';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AdminEventLogModule, ScheduledTasksModule],
	controllers: [TelegramBotController],
	providers: [TelegramBotService, PrismaService],
	exports: [TelegramBotService]
})
export class TelegramBotModule {}
