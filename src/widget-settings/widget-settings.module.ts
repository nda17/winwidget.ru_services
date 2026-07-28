import { AuthModule } from '@/auth/auth.module';
import { FileModule } from '@/file/file.module';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { WidgetSettingsController } from '@/widget-settings/widget-settings.controller';
import { WidgetSettingsService } from '@/widget-settings/widget-settings.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule, FileModule, SubscriptionModule],
	controllers: [WidgetSettingsController],
	providers: [WidgetSettingsService],
	exports: [WidgetSettingsService]
})
export class WidgetSettingsModule {}
