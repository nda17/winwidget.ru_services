import { AuthModule } from '@/auth/auth.module';
import { FileModule } from '@/file/file.module';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpModule } from '@/safe-outbound-http/safe-outbound-http.module';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { WidgetApiController } from '@/widget/widget-api.controller';
import { WidgetPublicController } from '@/widget/widget-public.controller';
import { WidgetController } from '@/widget/widget.controller';
import { WidgetService } from '@/widget/widget.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AuthModule,
		SubscriptionModule,
		FileModule,
		SafeOutboundHttpModule
	],
	controllers: [
		WidgetController,
		WidgetPublicController,
		WidgetApiController
	],
	providers: [WidgetService, PrismaService],
	exports: [WidgetService]
})
export class WidgetModule {}
