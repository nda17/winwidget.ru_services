import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrmSalesHealthController } from './health/crm-sales-health.controller';
import { CrmSalesHealthService } from './health/crm-sales-health.service';
import { CrmSalesPrismaModule } from './prisma/crm-sales-prisma.module';
import { PipelineTemplateCatalogController } from './templates/pipeline-template-catalog.controller';
import { PipelineTemplateCatalogService } from './templates/pipeline-template-catalog.service';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmSalesPrismaModule
	],
	controllers: [
		CrmSalesHealthController,
		PipelineTemplateCatalogController
	],
	providers: [CrmSalesHealthService, PipelineTemplateCatalogService]
})
export class CrmSalesModule {}
