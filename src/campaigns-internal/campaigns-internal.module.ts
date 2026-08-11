import { AuthModule } from '@/auth/auth.module';
import { BillingBoundaryModule } from '@/billing-boundary/billing-boundary.module';
import { Module } from '@nestjs/common';
import { CampaignsAudienceExportService } from './campaigns-audience-export.service';
import { CampaignsAuthIntrospectionService } from './campaigns-auth-introspection.service';
import { CampaignsInternalController } from './campaigns-internal.controller';
import { CampaignsInternalTokenGuard } from './campaigns-internal-token.guard';

@Module({
	imports: [AuthModule, BillingBoundaryModule],
	controllers: [CampaignsInternalController],
	providers: [
		CampaignsInternalTokenGuard,
		CampaignsAuthIntrospectionService,
		CampaignsAudienceExportService
	]
})
export class CampaignsInternalModule {}
