import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { Module } from '@nestjs/common';
import { DatabaseRestoreQueueService } from './database-restore-queue.service';
import { DevToolsController } from './dev-tools.controller';

@Module({
	imports: [AdminEventLogModule],
	controllers: [DevToolsController],
	providers: [DatabaseRestoreQueueService]
})
export class DevToolsModule {}
