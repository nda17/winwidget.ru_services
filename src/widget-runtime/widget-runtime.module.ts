import { SubscriptionModule } from '@/subscription/subscription.module';
import { WidgetRuntimeController } from '@/widget-runtime/widget-runtime.controller';
import { WidgetRuntimeService } from '@/widget-runtime/widget-runtime.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [SubscriptionModule],
	controllers: [WidgetRuntimeController],
	providers: [WidgetRuntimeService]
})
export class WidgetRuntimeModule {}
