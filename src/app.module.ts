import { AuthModule } from '@/auth/auth.module';
import { AdminAlertsModule } from '@/admin-alerts/admin-alerts.module';
import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { AffiliateModule } from '@/affiliate/affiliate.module';
import { getGoogleRecaptchaConfig } from '@/config/google-recaptcha.config';
import { FileModule } from '@/file/file.module';
import { LegalPagesModule } from '@/legal-pages/legal-pages.module';
import { NotesModule } from '@/notes/notes.module';
import { AutoRenewalSchedulerModule } from '@/payment/auto-renewal-scheduler.module';
import { PaymentModule } from '@/payment/payment.module';
import { PrismaModule } from '@/prisma.module';
import { PrismaService } from '@/prisma.service';
import { SiteSettingsModule } from '@/site-settings/site-settings.module';
import { SiteSettingsService } from '@/site-settings/site-settings.service';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { TariffPricesModule } from '@/tariff-prices/tariff-prices.module';
import { TelegramBotModule } from '@/telegram-bot/telegram-bot.module';
import { UserModule } from '@/user/user.module';
import { CampaignsInternalModule } from '@/campaigns-internal/campaigns-internal.module';
import { ReportingInternalModule } from '@/reporting-internal/reporting-internal.module';
import { WidgetsInternalModule } from '@/widgets-internal/widgets-internal.module';
import { DevToolsModule } from '@/dev-tools/dev-tools.module';
import { HealthModule } from '@/health/health.module';
import { HomePageContentModule } from '@/home-page-content/home-page-content.module';
import { MessagingAdminModule } from '@/messaging/messaging-admin.module';
import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GoogleRecaptchaModule } from '@nestlab/google-recaptcha';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true
		}),
		PrismaModule,
		GoogleRecaptchaModule.forRootAsync({
			imports: [ConfigModule, SiteSettingsModule],
			useFactory: getGoogleRecaptchaConfig,
			inject: [ConfigService, SiteSettingsService]
		}),
		AuthModule,
		UserModule,
		FileModule,
		PaymentModule,
		AutoRenewalSchedulerModule,
		SubscriptionModule,
		SiteSettingsModule,
		TariffPricesModule,
		LegalPagesModule,
		HomePageContentModule,
		NotesModule,
		CampaignsInternalModule,
		ReportingInternalModule,
		WidgetsInternalModule,
		MessagingAdminModule,
		HealthModule,
		TelegramBotModule,
		DevToolsModule,
		AdminAlertsModule,
		AffiliateModule,
		AdminEventLogModule
	]
})
export class AppModule implements OnApplicationShutdown {
	constructor(private readonly prisma: PrismaService) {}

	onApplicationShutdown() {
		return this.prisma.disconnect();
	}
}
