import { CampaignsRuntimeService } from './campaigns-runtime.service';
import { Global, Module } from '@nestjs/common';

@Global()
@Module({
	providers: [CampaignsRuntimeService],
	exports: [CampaignsRuntimeService]
})
export class CampaignsRuntimeModule {}
