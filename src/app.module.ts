import { AdminAlertsModule } from '@/admin-alerts/admin-alerts.module';
import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { FileModule } from '@/file/file.module';
import { LegalPagesModule } from '@/legal-pages/legal-pages.module';
import { NotesModule } from '@/notes/notes.module';
import { PrismaModule } from '@/prisma.module';
import { PrismaService } from '@/prisma.service';
import { SiteSettingsModule } from '@/site-settings/site-settings.module';
import { TelegramBotModule } from '@/telegram-bot/telegram-bot.module';
import { ReportingInternalModule } from '@/reporting-internal/reporting-internal.module';
import { DevToolsModule } from '@/dev-tools/dev-tools.module';
import { HealthModule } from '@/health/health.module';
import { HomePageContentModule } from '@/home-page-content/home-page-content.module';
import { IdentityBoundaryModule } from '@/identity-boundary/identity-boundary.module';
import { MessagingAdminModule } from '@/messaging/messaging-admin.module';
import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true
		}),
		PrismaModule,
		IdentityBoundaryModule,
		FileModule,
		SiteSettingsModule,
		LegalPagesModule,
		HomePageContentModule,
		NotesModule,
		ReportingInternalModule,
		MessagingAdminModule,
		HealthModule,
		TelegramBotModule,
		DevToolsModule,
		AdminAlertsModule,
		AdminEventLogModule
	]
})
export class AppModule implements OnApplicationShutdown {
	constructor(private readonly prisma: PrismaService) {}

	onApplicationShutdown() {
		return this.prisma.disconnect();
	}
}
