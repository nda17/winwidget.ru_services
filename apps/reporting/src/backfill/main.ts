import { ReportingBackfillService } from './reporting-backfill.service';
import { ReportingJsonLogger } from '../common/reporting-json.logger';
import { ReportingModule } from '../reporting.module';
import { NestFactory } from '@nestjs/core';

export async function bootstrapReportingBackfill(): Promise<void> {
	const app = await NestFactory.createApplicationContext(ReportingModule, {
		logger: new ReportingJsonLogger()
	});
	app.enableShutdownHooks();
	try {
		await app.get(ReportingBackfillService).run();
	} finally {
		await app.close();
	}
}

if (require.main === module) {
	void bootstrapReportingBackfill().catch(error => {
		new ReportingJsonLogger().fatal(error, 'BackfillBootstrap');
		process.exitCode = 1;
	});
}
