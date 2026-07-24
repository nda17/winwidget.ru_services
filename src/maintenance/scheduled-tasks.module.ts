import { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import { ScheduledJobsModule } from '@/scheduled-jobs/scheduled-jobs.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [ScheduledJobsModule],
	providers: [ScheduledTasksService],
	exports: [ScheduledTasksService, ScheduledJobsModule]
})
export class ScheduledTasksModule {}
