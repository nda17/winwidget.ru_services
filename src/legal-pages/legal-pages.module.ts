import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { LegalPagesController } from '@/legal-pages/legal-pages.controller';
import { LegalPagesService } from '@/legal-pages/legal-pages.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AdminEventLogModule],
	controllers: [LegalPagesController],
	providers: [LegalPagesService]
})
export class LegalPagesModule {}
