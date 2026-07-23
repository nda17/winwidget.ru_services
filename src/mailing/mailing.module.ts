import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { AuthModule } from '@/auth/auth.module';
import { MailingController } from '@/mailing/mailing.controller';
import { MailingService } from '@/mailing/mailing.service';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule, AdminEventLogModule],
	controllers: [MailingController],
	providers: [MailingService, PrismaService]
})
export class MailingModule {}
