import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrmIntakeHealthController } from './health/crm-intake-health.controller';
import { CrmIntakeHealthService } from './health/crm-intake-health.service';
import { CrmIntakePrismaModule } from './prisma/crm-intake-prisma.module';
import { IntakeAuthorizationClient } from './access/intake-authorization.client';
import { IntakeController } from './intake/intake.controller';
import { IntakeService } from './intake/intake.service';
import { IntakeIngestionController } from './intake/intake-ingestion.controller';
import {
	IntakeIngestionRateLimiter,
	IntakeIngestionService
} from './intake/intake-ingestion.service';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmIntakePrismaModule
	],
	controllers: [
		CrmIntakeHealthController,
		IntakeController,
		IntakeIngestionController
	],
	providers: [
		CrmIntakeHealthService,
		IntakeAuthorizationClient,
		IntakeService,
		IntakeIngestionService,
		IntakeIngestionRateLimiter
	]
})
export class CrmIntakeModule {}
