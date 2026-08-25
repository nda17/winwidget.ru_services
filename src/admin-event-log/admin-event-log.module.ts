import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { IdentityBoundaryModule } from '@/identity-boundary/identity-boundary.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [IdentityBoundaryModule],
	providers: [AdminEventLogService],
	exports: [AdminEventLogService]
})
export class AdminEventLogModule {}
