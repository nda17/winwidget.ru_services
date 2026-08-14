import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { Module } from '@nestjs/common';
import { ReportingInternalController } from './reporting-internal.controller';
import { ReportingInternalTokenGuard } from './reporting-internal-token.guard';
import { ReportingProjectionSnapshotService } from './reporting-projection-snapshot.service';
import { ReportingSchedulePolicyService } from './reporting-schedule-authority.service';

@Module({
	imports: [AdminEventLogModule],
	controllers: [ReportingInternalController],
	providers: [
		ReportingInternalTokenGuard,
		ReportingProjectionSnapshotService,
		ReportingSchedulePolicyService
	]
})
export class ReportingInternalModule {}
