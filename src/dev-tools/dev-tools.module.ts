import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { Module } from '@nestjs/common';
import { DatabaseRestoreService } from './database-restore.service';
import { DevToolsController } from './dev-tools.controller';

@Module({
	imports: [AdminEventLogModule],
	controllers: [DevToolsController],
	providers: [DatabaseRestoreService]
})
export class DevToolsModule {}
