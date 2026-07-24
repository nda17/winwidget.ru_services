import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { CalculatorModule } from '@/calculator/calculator.module';
import { CallbackModule } from '@/callback/callback.module';
import { CountdownTimerModule } from '@/countdown-timer/countdown-timer.module';
import { OnlineConsultantModule } from '@/online-consultant/online-consultant.module';
import { QuizModule } from '@/quiz/quiz.module';
import { StopOfferModule } from '@/stop-offer/stop-offer.module';
import { WidgetAdminController } from '@/widget-admin/widget-admin.controller';
import { WidgetAdminService } from '@/widget-admin/widget-admin.service';
import { WidgetModule } from '@/widget/widget.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AdminEventLogModule,
		WidgetModule,
		QuizModule,
		CallbackModule,
		CountdownTimerModule,
		StopOfferModule,
		OnlineConsultantModule,
		CalculatorModule
	],
	controllers: [WidgetAdminController],
	providers: [WidgetAdminService]
})
export class WidgetAdminModule {}
