import { PrismaService } from '@/prisma.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import { Module } from '@nestjs/common';

@Module({
	providers: [PrismaService, ScheduledJobsService],
	exports: [ScheduledJobsService, PrismaService]
})
export class ScheduledJobsModule {}
