import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';
import { AffiliateController } from './affiliate.controller';
import { AffiliateService } from './affiliate.service';

@Module({
	imports: [AdminEventLogModule],
	controllers: [AffiliateController],
	providers: [AffiliateService, PrismaService],
	exports: [AffiliateService]
})
export class AffiliateModule {}
