import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrmIntakeHealthController } from './health/crm-intake-health.controller';
import { CrmIntakeHealthService } from './health/crm-intake-health.service';
import { CrmIntakePrismaModule } from './prisma/crm-intake-prisma.module';
import { IntakeAuthorizationClient } from './access/intake-authorization.client';
import { IntakeController } from './intake/intake.controller';
import { IntakeService } from './intake/intake.service';
import { IntakeCsvImportController } from './intake/intake-csv-import.controller';
import { IntakeCsvImportService } from './intake/intake-csv-import.service';
import { IntakeIngestionController } from './intake/intake-ingestion.controller';
import {
	IntakeIngestionRateLimiter,
	IntakeIngestionService
} from './intake/intake-ingestion.service';
import { AcceptanceController } from './acceptance/acceptance.controller';
import { AcceptanceService } from './acceptance/acceptance.service';
import { AcceptanceOperationsClient } from './acceptance/acceptance-operations.client';
import { AcceptanceProcessor } from './acceptance/acceptance.processor';
import {
	AcceptanceRabbit,
	intakeProcessRole
} from './acceptance/acceptance.messaging';
import { AcceptancePublisher } from './acceptance/acceptance.publisher';
import { AcceptanceWorker } from './acceptance/acceptance.worker';

const config = ConfigModule.forRoot({ isGlobal: true });
const role = intakeProcessRole();
const api = role === 'api' || role === 'all';
const worker = role === 'worker' || role === 'all';
const publisher = role === 'publisher' || role === 'all';

@Module({
	imports: [config, CrmIntakePrismaModule],
	controllers: [
		CrmIntakeHealthController,
		...(api
			? [
					IntakeController,
					IntakeIngestionController,
					AcceptanceController,
					IntakeCsvImportController
				]
			: [])
	],
	providers: [
		CrmIntakeHealthService,
		...(api || worker ? [IntakeAuthorizationClient] : []),
		...(api
			? [
					IntakeService,
					IntakeCsvImportService,
					IntakeIngestionService,
					IntakeIngestionRateLimiter,
					AcceptanceService
				]
			: []),
		...(worker || publisher ? [AcceptanceRabbit] : []),
		...(worker
			? [AcceptanceOperationsClient, AcceptanceProcessor, AcceptanceWorker]
			: []),
		...(publisher ? [AcceptancePublisher] : [])
	]
})
export class CrmIntakeModule {}
