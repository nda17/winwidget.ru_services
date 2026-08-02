import { DatabaseRestoreWorkerModule } from '@/database-restore-worker/database-restore-worker.module';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

async function bootstrap(): Promise<void> {
	const app = await NestFactory.createApplicationContext(
		DatabaseRestoreWorkerModule
	);
	app.enableShutdownHooks();
	Logger.log('Standalone database restore worker started', 'Bootstrap');
}

void bootstrap().catch(error => {
	Logger.error(
		`Database restore worker failed to start: ${
			error instanceof Error ? error.message : String(error)
		}`,
		undefined,
		'Bootstrap'
	);
	process.exitCode = 1;
});
