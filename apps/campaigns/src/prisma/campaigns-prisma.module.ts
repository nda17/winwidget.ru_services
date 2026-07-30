import { CampaignsPrismaService } from './campaigns-prisma.service';
import { Global, Module } from '@nestjs/common';

@Global()
@Module({
	providers: [CampaignsPrismaService],
	exports: [CampaignsPrismaService]
})
export class CampaignsPrismaModule {}
