import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrmSalesHealthController } from './health/crm-sales-health.controller';
import { CrmSalesHealthService } from './health/crm-sales-health.service';
import { CrmSalesPrismaModule } from './prisma/crm-sales-prisma.module';
import { CrmSalesInternalGuard } from './internal/crm-sales-internal.guard';
import { PipelineTemplateInstallationController } from './pipelines/pipeline-template-installation.controller';
import { PipelineTemplateInstallationService } from './pipelines/pipeline-template-installation.service';
import { PipelineTemplateCatalogController } from './templates/pipeline-template-catalog.controller';
import { PipelineTemplateCatalogService } from './templates/pipeline-template-catalog.service';
import { SalesController } from './sales/sales.controller';
import { SalesService } from './sales/sales.service';
import { SalesAccessClient, SalesAccessGuard } from './sales/sales-access';
import { SalesContactClient } from './sales/sales-contact.client';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmSalesPrismaModule
	],
	controllers: [
		CrmSalesHealthController,
		PipelineTemplateCatalogController,
		PipelineTemplateInstallationController,
		SalesController
	],
	providers: [
		CrmSalesHealthService,
		CrmSalesInternalGuard,
		PipelineTemplateCatalogService,
		PipelineTemplateInstallationService,
		SalesService,
		SalesAccessClient,
		SalesAccessGuard,
		SalesContactClient
	]
})
export class CrmSalesModule {}
