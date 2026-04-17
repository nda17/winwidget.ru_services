import { AuthModule } from '@/auth/auth.module';
import { getGoogleRecaptchaConfig } from '@/config/google-recaptcha.config';
import { FileModule } from '@/file/file.module';
import { LegalPagesModule } from '@/legal-pages/legal-pages.module';
import { NotesModule } from '@/notes/notes.module';
import { PaymentModule } from '@/payment/payment.module';
import { SiteSettingsModule } from '@/site-settings/site-settings.module';
import { StatisticsModule } from '@/statistics/statistics.module';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { UserModule } from '@/user/user.module';
import { WidgetModule } from '@/widget/widget.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GoogleRecaptchaModule } from '@nestlab/google-recaptcha';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true
		}),
		GoogleRecaptchaModule.forRootAsync({
			imports: [ConfigModule],
			useFactory: getGoogleRecaptchaConfig,
			inject: [ConfigService]
		}),
		AuthModule,
		StatisticsModule,
		UserModule,
		FileModule,
		PaymentModule,
		SubscriptionModule,
		WidgetModule,
		SiteSettingsModule,
		LegalPagesModule,
		NotesModule
	]
})
export class AppModule {}
