import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { TelegramBotModule } from '@/telegram-bot/telegram-bot.module';
import { Module } from '@nestjs/common';
import { DevToolsController } from './dev-tools.controller';

@Module({
	imports: [AdminEventLogModule, TelegramBotModule],
	controllers: [DevToolsController]
})
export class DevToolsModule {}
