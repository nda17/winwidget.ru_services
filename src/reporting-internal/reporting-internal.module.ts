import { AuthModule } from '@/auth/auth.module';
import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { Module } from '@nestjs/common';
import { ReportingAuthIntrospectionService } from './reporting-auth-introspection.service';
import { ReportingInternalController } from './reporting-internal.controller';
import { ReportingInternalTokenGuard } from './reporting-internal-token.guard';
import { ReportingProjectionSnapshotService } from './reporting-projection-snapshot.service';
import { ReportingSchedulePolicyService } from './reporting-schedule-authority.service';

@Module({
	imports: [AuthModule, AdminEventLogModule],
	controllers: [ReportingInternalController],
	providers: [
		ReportingInternalTokenGuard,
		ReportingAuthIntrospectionService,
		ReportingProjectionSnapshotService,
		ReportingSchedulePolicyService
	]
})
export class ReportingInternalModule {}
