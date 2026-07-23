import { AuthModule } from '@/auth/auth.module';
import { AdminAlertsModule } from '@/admin-alerts/admin-alerts.module';
import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { AffiliateModule } from '@/affiliate/affiliate.module';
import { getGoogleRecaptchaConfig } from '@/config/google-recaptcha.config';
import { FileModule } from '@/file/file.module';
import { LegalPagesModule } from '@/legal-pages/legal-pages.module';
import { NotesModule } from '@/notes/notes.module';
import { PaymentModule } from '@/payment/payment.module';
import { SiteSettingsModule } from '@/site-settings/site-settings.module';
import { SiteSettingsService } from '@/site-settings/site-settings.service';
import { StatisticsModule } from '@/statistics/statistics.module';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { TariffPricesModule } from '@/tariff-prices/tariff-prices.module';
import { TelegramBotModule } from '@/telegram-bot/telegram-bot.module';
import { UserModule } from '@/user/user.module';
import { WidgetModule } from '@/widget/widget.module';
import { QuizModule } from '@/quiz/quiz.module';
import { CallbackModule } from '@/callback/callback.module';
import { CalculatorModule } from '@/calculator/calculator.module';
import { CountdownTimerModule } from '@/countdown-timer/countdown-timer.module';
import { StopOfferModule } from '@/stop-offer/stop-offer.module';
import { OnlineConsultantModule } from '@/online-consultant/online-consultant.module';
import { DevToolsModule } from '@/dev-tools/dev-tools.module';
import { HealthModule } from '@/health/health.module';
import { HomePageContentModule } from '@/home-page-content/home-page-content.module';
import { MailingModule } from '@/mailing/mailing.module';
import { MessagingAdminModule } from '@/messaging/messaging-admin.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GoogleRecaptchaModule } from '@nestlab/google-recaptcha';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true
		}),
		GoogleRecaptchaModule.forRootAsync({
			imports: [ConfigModule, SiteSettingsModule],
			useFactory: getGoogleRecaptchaConfig,
			inject: [ConfigService, SiteSettingsService]
		}),
		AuthModule,
		StatisticsModule,
		UserModule,
		FileModule,
		PaymentModule,
		SubscriptionModule,
		WidgetModule,
		QuizModule,
		CallbackModule,
		CalculatorModule,
		CountdownTimerModule,
		StopOfferModule,
		OnlineConsultantModule,
		SiteSettingsModule,
		TariffPricesModule,
		LegalPagesModule,
		HomePageContentModule,
		NotesModule,
		MailingModule,
		MessagingAdminModule,
		HealthModule,
		TelegramBotModule,
		DevToolsModule,
		AdminAlertsModule,
		AffiliateModule,
		AdminEventLogModule
	]
})
export class AppModule {}
