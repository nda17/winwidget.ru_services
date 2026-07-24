import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import { Module } from '@nestjs/common';

@Module({
	providers: [ScheduledJobsService],
	exports: [ScheduledJobsService]
})
export class ScheduledJobsModule {}
