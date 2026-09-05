import { Module } from '@nestjs/common';
import { IntakeExportController } from './exports/export.controller';
import { IntakeExportService } from './exports/export.service';
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
import {
	widgetControlEnabled,
	WidgetControlConfig
} from './widget-sources/widget-control.config';
import { WidgetSourceController } from './widget-sources/widget-source.controller';
import { WidgetSourceService } from './widget-sources/widget-source.service';
import { WidgetsControlClient } from './widget-sources/widgets-control.client';
import { WidgetControlProcessor } from './widget-sources/widget-control.processor';
import { WidgetControlRabbit } from './widget-sources/widget-control.messaging';
import { WidgetControlWorker } from './widget-sources/widget-control.worker';
import { WidgetControlPublisher } from './widget-sources/widget-control.publisher';

const config = ConfigModule.forRoot({ isGlobal: true });
const role = intakeProcessRole();
const api = role === 'api' || role === 'all';
const worker = role === 'worker' || role === 'all';
const publisher = role === 'publisher' || role === 'all';
const widgets = widgetControlEnabled();
const controlWorker =
	widgets && (role === 'widget-control-worker' || role === 'all');
const controlPublisher =
	widgets && (role === 'widget-control-publisher' || role === 'all');

@Module({
	imports: [config, CrmIntakePrismaModule],
	controllers: [
		CrmIntakeHealthController,
		...(api && widgets ? [WidgetSourceController] : []),
		...(api
			? [
					IntakeController,
					IntakeExportController,
					IntakeIngestionController,
					AcceptanceController,
					IntakeCsvImportController
				]
			: [])
	],
	providers: [
		CrmIntakeHealthService,
		...(api || worker || controlWorker ? [IntakeAuthorizationClient] : []),
		...(widgets && (api || controlWorker)
			? [WidgetControlConfig, WidgetsControlClient]
			: []),
		...(widgets && api ? [WidgetSourceService] : []),
		...(controlWorker || controlPublisher ? [WidgetControlRabbit] : []),
		...(controlWorker
			? [WidgetControlProcessor, WidgetControlWorker]
			: []),
		...(controlPublisher ? [WidgetControlPublisher] : []),
		...(api
			? [
					IntakeService,
					IntakeExportService,
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
