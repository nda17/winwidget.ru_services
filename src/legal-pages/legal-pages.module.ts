import { LegalPagesController } from '@/legal-pages/legal-pages.controller';
import { LegalPagesService } from '@/legal-pages/legal-pages.service';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [LegalPagesController],
	providers: [LegalPagesService, PrismaService]
})
export class LegalPagesModule {}
