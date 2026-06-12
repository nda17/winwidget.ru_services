import { AuthModule } from '@/auth/auth.module';
import { EmailModule } from '@/email/email.module';
import { FileModule } from '@/file/file.module';
import { PrismaService } from '@/prisma.service';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { OnlineConsultantApiController } from '@/online-consultant/online-consultant-api.controller';
import { OnlineConsultantPublicController } from '@/online-consultant/online-consultant-public.controller';
import { OnlineConsultantController } from '@/online-consultant/online-consultant.controller';
import { OnlineConsultantService } from '@/online-consultant/online-consultant.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule, SubscriptionModule, EmailModule, FileModule],
	controllers: [
		OnlineConsultantController,
		OnlineConsultantPublicController,
		OnlineConsultantApiController
	],
	providers: [OnlineConsultantService, PrismaService],
	exports: [OnlineConsultantService]
})
export class OnlineConsultantModule {}
