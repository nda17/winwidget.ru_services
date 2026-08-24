import { AdminAlertsModule } from '@/admin-alerts/admin-alerts.module';
import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { NotesModule } from '@/notes/notes.module';
import { PrismaModule } from '@/prisma.module';
import { PrismaService } from '@/prisma.service';
import { TelegramBotModule } from '@/telegram-bot/telegram-bot.module';
import { ReportingInternalModule } from '@/reporting-internal/reporting-internal.module';
import { DevToolsModule } from '@/dev-tools/dev-tools.module';
import { HealthModule } from '@/health/health.module';
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
