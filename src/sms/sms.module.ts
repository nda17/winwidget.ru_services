import { SmsService } from '@/sms/sms.service';
import { ConfigModule } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { SmsAeroProvider } from '@/sms/providers/smsaero.provider';

@Module({
	imports: [ConfigModule],
	providers: [SmsAeroProvider, SmsService],
	exports: [SmsService]
})
export class SmsModule {}
