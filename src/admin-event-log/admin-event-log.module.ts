import { AdminEventLogController } from '@/admin-event-log/admin-event-log.controller';
import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [AdminEventLogController],
	providers: [AdminEventLogService, PrismaService],
	exports: [AdminEventLogService]
})
export class AdminEventLogModule {}
