import { AdminEventLogController } from '@/admin-event-log/admin-event-log.controller';
import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { IdentityBoundaryModule } from '@/identity-boundary/identity-boundary.module';
import { forwardRef, Module } from '@nestjs/common';

@Module({
	imports: [forwardRef(() => IdentityBoundaryModule)],
	controllers: [AdminEventLogController],
	providers: [AdminEventLogService],
	exports: [AdminEventLogService]
})
export class AdminEventLogModule {}
