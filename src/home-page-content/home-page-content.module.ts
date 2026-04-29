import { HomePageContentController } from '@/home-page-content/home-page-content.controller';
import { HomePageContentService } from '@/home-page-content/home-page-content.service';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [HomePageContentController],
	providers: [HomePageContentService, PrismaService]
})
export class HomePageContentModule {}
