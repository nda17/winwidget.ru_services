import { TelegramInfoTransportService } from './telegram-info-transport.service';
import { Module } from '@nestjs/common';

@Module({
	providers: [TelegramInfoTransportService],
	exports: [TelegramInfoTransportService]
})
export class TelegramInfoTransportModule {}
