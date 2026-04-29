import { AuthModule } from '@/auth/auth.module';
import { EmailModule } from '@/email/email.module';
import { MailingController } from '@/mailing/mailing.controller';
import { MailingService } from '@/mailing/mailing.service';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule, EmailModule],
	controllers: [MailingController],
	providers: [MailingService, PrismaService]
})
export class MailingModule {}
