import {
	DatabaseRestoreCommandRunner,
	DatabaseRestoreFileSystem
} from '@/database-restore-worker/database-restore-worker.adapters';
import { DatabaseRestoreWorkerConfig } from '@/database-restore-worker/database-restore-worker.config';
import { DatabaseRestoreWorkerService } from '@/database-restore-worker/database-restore-worker.service';
import { Module } from '@nestjs/common';

@Module({
	providers: [
		{
			provide: DatabaseRestoreWorkerConfig,
			useFactory: () => new DatabaseRestoreWorkerConfig()
		},
		DatabaseRestoreFileSystem,
		DatabaseRestoreCommandRunner,
		DatabaseRestoreWorkerService
	]
})
export class DatabaseRestoreWorkerModule {}
