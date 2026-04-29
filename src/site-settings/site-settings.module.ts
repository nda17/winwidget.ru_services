import { PrismaService } from '@/prisma.service';
import { SiteSettingsController } from '@/site-settings/site-settings.controller';
import { SiteSettingsService } from '@/site-settings/site-settings.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [SiteSettingsController],
	providers: [SiteSettingsService, PrismaService],
	exports: [SiteSettingsService]
})
export class SiteSettingsModule {}
